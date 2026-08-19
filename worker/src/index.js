/**
 * Cloudflare Worker — front door for the text-to-video tool.
 *
 * STORAGE: uses GitHub instead of Cloudflare R2 — no payment card
 * required anywhere in this stack.
 *   - Finished videos are published as GitHub Release assets (public,
 *     directly downloadable, created by the render workflow itself
 *     using the Actions run's built-in token — no extra secret needed).
 *   - Uploaded avatar photos are committed to the repo via GitHub's
 *     Contents API, served publicly from raw.githubusercontent.com.
 *
 * Responsibilities (things Workers CAN do on the free tier):
 *   - Serve the web page (GET /)
 *   - Accept requests from web form or WhatsApp webhook
 *   - Store the job (script/topic/avatar) in KV
 *   - Enforce a daily render limit so free-tier quotas (GitHub Actions
 *     minutes, Pexels rate limit, Workers AI neurons) don't get exhausted
 *   - Trigger the render (a GitHub Actions workflow_dispatch, since
 *     Workers cannot run ffmpeg itself)
 *   - Commit any uploaded avatar photo to the repo, pass its raw URL
 *     to the renderer
 *   - Serve status checks
 *   - Once the render workflow publishes the finished video, receive
 *     its callback and notify the user (WhatsApp message / poll endpoint)
 *
 * Free tier notes:
 *   - Workers: 100k requests/day free
 *   - KV: 100k reads/day, 1k writes/day free
 *   - GitHub: unlimited public repo storage/bandwidth for Releases;
 *     Actions free tier: 2,000 min/month private repos, UNLIMITED on
 *     public repos — each render takes a few minutes, so free tier
 *     comfortably covers dozens-hundreds of videos/month
 *
 * DAILY_LIMIT below protects those free quotas from being exhausted by
 * one burst of traffic. Adjust to taste in wrangler.toml [vars].
 */

const PRESET_AVATARS = {
  preset1: "presets/preset1.png",
  preset2: "presets/preset2.png",
  preset3: "presets/preset3.png",
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // --- 0. Serve the web page ---
    if (url.pathname === "/" && request.method === "GET") {
      return new Response(INDEX_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // --- Current usage / limits (shown on the page) ---
    if (url.pathname === "/api/limits" && request.method === "GET") {
      const usedToday = await getTodayCount(env);
      const dailyLimit = parseInt(env.DAILY_LIMIT || "20", 10);
      return json({ usedToday, dailyLimit });
    }

    // --- 1. Submit a new video job ---
    if (url.pathname === "/api/generate" && request.method === "POST") {
      const dailyLimit = parseInt(env.DAILY_LIMIT || "20", 10);
      const usedToday = await getTodayCount(env);
      if (usedToday >= dailyLimit) {
        return json(
          { error: `Daily free limit reached (${dailyLimit}/day). Try again tomorrow.` },
          429
        );
      }

      const body = await request.json();
      const { script, topic, phone, avatarData, avatarPreset } = body;

      if (!script && !topic) {
        return json({ error: "Provide either 'script' or 'topic'" }, 400);
      }
      if (script && script.length > 8000) {
        return json({ error: "Script too long (max 8000 characters)." }, 400);
      }
      if (topic && topic.length > 300) {
        return json({ error: "Topic too long (max 300 characters)." }, 400);
      }

      const jobId = crypto.randomUUID();

      // Resolve avatar to a public URL, if any was provided
      let avatarUrl = null;
      if (avatarData) {
        avatarUrl = await commitAvatarToGitHub(env, jobId, avatarData);
      } else if (avatarPreset && PRESET_AVATARS[avatarPreset]) {
        avatarUrl = `https://raw.githubusercontent.com/${env.GITHUB_REPO}/main/${PRESET_AVATARS[avatarPreset]}`;
      }

      const job = {
        id: jobId,
        script: script || null,
        topic: topic || null,
        phone: phone || null,
        avatarUrl,
        status: "queued",
        createdAt: Date.now(),
      };

      await env.JOBS_KV.put(jobId, JSON.stringify(job), { expirationTtl: 60 * 60 * 24 * 7 });
      await incrementTodayCount(env);
      await triggerRender(env, jobId, job);

      return json({ jobId, status: "queued" });
    }

    // --- 2. Check job status ---
    if (url.pathname.startsWith("/api/status/") && request.method === "GET") {
      const jobId = url.pathname.split("/").pop();
      const jobData = await env.JOBS_KV.get(jobId);
      if (!jobData) return json({ error: "not found" }, 404);
      return json(JSON.parse(jobData));
    }

    // --- 3. Callback from the render workflow when done (auth via shared secret) ---
    if (url.pathname === "/api/render-complete" && request.method === "POST") {
      const auth = request.headers.get("X-Render-Secret");
      if (auth !== env.RENDER_SECRET) return json({ error: "unauthorized" }, 401);

      const { jobId, videoUrl, error } = await request.json();
      const jobData = await env.JOBS_KV.get(jobId);
      if (!jobData) return json({ error: "job not found" }, 404);

      const job = JSON.parse(jobData);
      job.status = error ? "failed" : "done";
      job.error = error || null;
      job.videoUrl = videoUrl || null;
      await env.JOBS_KV.put(jobId, JSON.stringify(job), { expirationTtl: 60 * 60 * 24 * 7 });

      if (job.phone && job.videoUrl) {
        await sendWhatsAppMessage(env, job.phone, `Your video is ready: ${job.videoUrl}`);
      }

      return json({ ok: true });
    }

    // --- 4. WhatsApp webhook (incoming messages) ---
    if (url.pathname === "/webhook/whatsapp" && request.method === "POST") {
      return handleWhatsAppWebhook(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// --- Daily counter (protects free-tier quotas) ---
function todayKey() {
  return `count:${new Date().toISOString().slice(0, 10)}`; // count:2026-08-18
}

async function getTodayCount(env) {
  const val = await env.JOBS_KV.get(todayKey());
  return val ? parseInt(val, 10) : 0;
}

async function incrementTodayCount(env) {
  const current = await getTodayCount(env);
  // expire the counter after 2 days so KV doesn't accumulate stale keys
  await env.JOBS_KV.put(todayKey(), String(current + 1), { expirationTtl: 60 * 60 * 48 });
}

// --- Avatar upload -> committed to the GitHub repo (no R2/card needed) ---
async function commitAvatarToGitHub(env, jobId, dataUrl) {
  // dataUrl looks like "data:image/png;base64,AAAA..."
  const match = dataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
  if (!match) return null;
  const [, mimeType, base64] = match;
  const ext = mimeType.split("/")[1] || "jpg";
  const path = `avatars/${jobId}.${ext}`;

  const res = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "t2v-worker",
      },
      body: JSON.stringify({
        message: `Add avatar for job ${jobId}`,
        content: base64,
      }),
    }
  );

  if (!res.ok) {
    console.error("Failed to commit avatar:", await res.text());
    return null;
  }

  return `https://raw.githubusercontent.com/${env.GITHUB_REPO}/main/${path}`;
}

async function triggerRender(env, jobId, job) {
  const res = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/render.yml/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "t2v-worker",
      },
      body: JSON.stringify({
        ref: "main",
        inputs: {
          job_id: jobId,
          script: job.script || "",
          topic: job.topic || "",
          avatar_url: job.avatarUrl || "",
        },
      }),
    }
  );
  if (!res.ok) {
    console.error("Failed to trigger render:", await res.text());
  }
}

async function sendWhatsAppMessage(env, phone, message) {
  await fetch(`https://graph.facebook.com/v19.0/${env.WHATSAPP_PHONE_ID}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: phone,
      type: "text",
      text: { body: message },
    }),
  });
}

async function handleWhatsAppWebhook(request, env) {
  const payload = await request.json();
  try {
    const entry = payload.entry?.[0]?.changes?.[0]?.value;
    const message = entry?.messages?.[0];
    if (!message) return json({ ok: true });

    const from = message.from;
    const text = message.text?.body?.trim();
    if (!text) return json({ ok: true });

    const dailyLimit = parseInt(env.DAILY_LIMIT || "20", 10);
    const usedToday = await getTodayCount(env);
    if (usedToday >= dailyLimit) {
      await sendWhatsAppMessage(env, from, `Daily free limit reached (${dailyLimit}/day) — try again tomorrow.`);
      return json({ ok: true });
    }

    const jobId = crypto.randomUUID();
    const job = {
      id: jobId,
      topic: text,
      phone: from,
      avatarUrl: null,
      status: "queued",
      createdAt: Date.now(),
    };
    await env.JOBS_KV.put(jobId, JSON.stringify(job), { expirationTtl: 60 * 60 * 24 * 7 });
    await incrementTodayCount(env);
    await triggerRender(env, jobId, job);
    await sendWhatsAppMessage(env, from, "Got it — building your video now. I'll send the link when it's ready (usually a few minutes).");

    return json({ ok: true });
  } catch (e) {
    console.error(e);
    return json({ ok: true });
  }
}

// The web page HTML is injected here at deploy time — see README for the
// build step that inlines worker/public/index.html into this constant.
const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Reel — turn words into video</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #14120F;
    --bg-elevated: #1D1A15;
    --bg-input: #201C16;
    --accent: #E2A73B;
    --accent-dim: #8C6A2E;
    --text: #F2EDE4;
    --text-muted: #9A9184;
    --teal: #4C9A94;
    --error: #C4573B;
    --border: #2C2820;
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: 'Inter', sans-serif;
    min-height: 100vh;
    line-height: 1.5;
  }

  /* subtle film-grain texture */
  body::before {
    content: "";
    position: fixed;
    inset: 0;
    pointer-events: none;
    opacity: 0.035;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='100'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
    z-index: 1;
  }

  .wrap {
    max-width: 720px;
    margin: 0 auto;
    padding: 64px 24px 120px;
    position: relative;
    z-index: 2;
  }

  /* ---- Hero ---- */
  .eyebrow {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 12px;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: var(--teal);
    margin-bottom: 16px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .eyebrow::before {
    content: "";
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--teal);
    box-shadow: 0 0 8px var(--teal);
  }

  h1 {
    font-family: 'Bebas Neue', sans-serif;
    font-size: clamp(48px, 9vw, 84px);
    line-height: 0.92;
    letter-spacing: 0.01em;
    color: var(--text);
    margin-bottom: 8px;
  }
  h1 .accent { color: var(--accent); }

  .subhead {
    font-size: 16px;
    color: var(--text-muted);
    max-width: 46ch;
    margin-bottom: 40px;
  }

  /* ---- Limits ticker ---- */
  .limits {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 12.5px;
    color: var(--text-muted);
    border-top: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
    padding: 14px 0;
    margin-bottom: 40px;
    display: flex;
    flex-wrap: wrap;
    gap: 4px 28px;
  }
  .limits span.val { color: var(--accent); }
  .limits .item { white-space: nowrap; }

  /* ---- Mode toggle ---- */
  .mode-toggle {
    display: inline-flex;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 4px;
    margin-bottom: 20px;
  }
  .mode-toggle button {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 12px;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    background: none;
    border: none;
    color: var(--text-muted);
    padding: 8px 18px;
    border-radius: 999px;
    cursor: pointer;
    transition: all 0.2s ease;
  }
  .mode-toggle button.active {
    background: var(--accent);
    color: #14120F;
    font-weight: 600;
  }

  /* ---- Form ---- */
  textarea, input[type="tel"] {
    width: 100%;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text);
    font-family: 'Inter', sans-serif;
    font-size: 15px;
    padding: 16px;
    resize: vertical;
    transition: border-color 0.2s ease;
  }
  textarea { min-height: 140px; }
  textarea:focus, input[type="tel"]:focus {
    outline: none;
    border-color: var(--accent-dim);
  }
  textarea::placeholder, input::placeholder { color: #5A544A; }

  .field-label {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 11px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--text-muted);
    margin-bottom: 8px;
    margin-top: 20px;
    display: block;
  }

  .char-count {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 11px;
    color: var(--text-muted);
    text-align: right;
    margin-top: 6px;
  }

  /* ---- Avatar picker ---- */
  .avatar-picker {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
  }
  .avatar-option {
    width: 64px;
    height: 64px;
    border-radius: 50%;
    border: 2px solid var(--border);
    background: var(--bg-input);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
    transition: border-color 0.15s ease, transform 0.15s ease;
    padding: 0;
    overflow: hidden;
  }
  .avatar-option:hover { transform: translateY(-2px); }
  .avatar-option.selected,
  .avatar-option[data-selected="true"] {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px rgba(226, 167, 59, 0.18);
  }

  .avatar-option.upload-slot {
    flex-direction: column;
    gap: 2px;
  }
  .avatar-option.upload-slot .plus {
    font-family: 'Bebas Neue', sans-serif;
    font-size: 20px;
    color: var(--text-muted);
    line-height: 1;
  }
  .avatar-option.upload-slot .avatar-label,
  .avatar-option.none-slot .avatar-label {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 8.5px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.02em;
  }
  .avatar-option.upload-slot img {
    width: 100%; height: 100%;
    object-fit: cover;
    border-radius: 50%;
  }

  .avatar-option.preset { background: var(--preset-bg, var(--bg-input)); }
  .avatar-option.preset .preset-glyph {
    font-family: 'Bebas Neue', sans-serif;
    font-size: 22px;
    color: rgba(0,0,0,0.55);
  }

  .avatar-option.none-slot { flex-direction: column; gap: 2px; }

  .avatar-hint {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 11px;
    color: var(--text-muted);
    margin-top: 8px;
  }

  button.submit {
    margin-top: 28px;
    width: 100%;
    background: var(--accent);
    color: #14120F;
    border: none;
    border-radius: 8px;
    font-family: 'Bebas Neue', sans-serif;
    font-size: 22px;
    letter-spacing: 0.03em;
    padding: 16px;
    cursor: pointer;
    transition: transform 0.12s ease, background 0.2s ease;
  }
  button.submit:hover:not(:disabled) { background: #EFB853; transform: translateY(-1px); }
  button.submit:disabled { background: var(--bg-elevated); color: var(--text-muted); cursor: not-allowed; }

  /* ---- Sprocket / render progress (signature element) ---- */
  .render-panel {
    display: none;
    margin-top: 48px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 28px;
  }
  .render-panel.visible { display: block; }

  .render-header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: 20px;
  }
  .render-status {
    font-family: 'Bebas Neue', sans-serif;
    font-size: 22px;
    letter-spacing: 0.02em;
  }
  .render-status.rendering { color: var(--accent); }
  .render-status.done { color: var(--teal); }
  .render-status.failed { color: var(--error); }

  .timecode {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 13px;
    color: var(--text-muted);
  }

  .filmstrip {
    display: flex;
    height: 44px;
    border-radius: 4px;
    overflow: hidden;
    background: #0D0B08;
    position: relative;
    border: 1px solid var(--border);
  }
  .filmstrip .sprocket-row {
    position: absolute;
    top: 0; left: 0; right: 0; bottom: 0;
    display: flex;
    align-items: center;
    justify-content: space-around;
    padding: 0 8px;
    z-index: 2;
  }
  .filmstrip .sprocket-row span {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--bg);
  }
  .filmstrip .fill {
    position: absolute;
    top: 0; left: 0; bottom: 0;
    width: 0%;
    background: linear-gradient(90deg, var(--accent-dim), var(--accent));
    transition: width 0.6s ease;
    z-index: 1;
  }

  .render-note {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 12px;
    color: var(--text-muted);
    margin-top: 14px;
  }

  video.result {
    width: 100%;
    border-radius: 8px;
    margin-top: 20px;
    display: none;
    background: #000;
  }
  video.result.visible { display: block; }

  a.download {
    display: inline-block;
    margin-top: 14px;
    font-family: 'IBM Plex Mono', monospace;
    font-size: 13px;
    color: var(--accent);
    text-decoration: none;
    border-bottom: 1px solid var(--accent-dim);
    display: none;
  }
  a.download.visible { display: inline-block; }

  .error-msg {
    display: none;
    background: rgba(196, 87, 59, 0.12);
    border: 1px solid var(--error);
    color: #E8A088;
    font-size: 13.5px;
    padding: 12px 16px;
    border-radius: 8px;
    margin-top: 20px;
  }
  .error-msg.visible { display: block; }

  footer {
    margin-top: 64px;
    font-family: 'IBM Plex Mono', monospace;
    font-size: 11.5px;
    color: #5A544A;
    border-top: 1px solid var(--border);
    padding-top: 20px;
  }
</style>
</head>
<body>
<div class="wrap">

  <div class="eyebrow">Free-tier video generation</div>
  <h1>Say the words.<br>Get the <span class="accent">reel.</span></h1>
  <p class="subhead">Type a topic or paste a script. Voiceover, footage, captions, and music get stitched together automatically — no editing required.</p>

  <div class="limits" id="limits">
    <span class="item">Renders today: <span class="val" id="usedToday">—</span> / <span class="val" id="dailyLimit">—</span></span>
    <span class="item">Max length: <span class="val">~5 min</span></span>
    <span class="item">Cost: <span class="val">$0.00</span></span>
  </div>

  <div class="mode-toggle" role="tablist">
    <button type="button" class="active" data-mode="topic">Topic</button>
    <button type="button" data-mode="script">Full script</button>
  </div>

  <form id="genForm">
    <label class="field-label" id="inputLabel">What's the video about?</label>
    <textarea id="promptInput" placeholder="e.g. the benefits of drinking water" maxlength="4000"></textarea>
    <div class="char-count"><span id="charCount">0</span> / 4000</div>

    <label class="field-label">WhatsApp number (optional — get notified when it's ready)</label>
    <input type="tel" id="phoneInput" placeholder="+230 5xxx xxxx">

    <label class="field-label">Narrator avatar (optional — shown as a corner bubble)</label>
    <div class="avatar-picker" id="avatarPicker">
      <button type="button" class="avatar-option upload-slot" id="avatarUploadBtn" data-selected="false">
        <span class="plus">+</span>
        <span class="avatar-label">Upload photo</span>
      </button>
      <button type="button" class="avatar-option preset" data-preset="preset1" style="--preset-bg:#4C9A94;">
        <span class="preset-glyph">A</span>
      </button>
      <button type="button" class="avatar-option preset" data-preset="preset2" style="--preset-bg:#E2A73B;">
        <span class="preset-glyph">B</span>
      </button>
      <button type="button" class="avatar-option preset" data-preset="preset3" style="--preset-bg:#C4573B;">
        <span class="preset-glyph">C</span>
      </button>
      <button type="button" class="avatar-option none-slot selected" data-preset="none">
        <span class="avatar-label">None</span>
      </button>
    </div>
    <input type="file" id="avatarFileInput" accept="image/*" style="display:none;">
    <div class="avatar-hint">Photo shown as a small circular bubble in the corner — not an animated talking face.</div>

    <button type="submit" class="submit" id="submitBtn">Generate video</button>
  </form>

  <div class="error-msg" id="errorMsg"></div>

  <div class="render-panel" id="renderPanel">
    <div class="render-header">
      <div class="render-status rendering" id="renderStatus">Rendering…</div>
      <div class="timecode" id="renderTimecode">00:00</div>
    </div>
    <div class="filmstrip">
      <div class="fill" id="filmstripFill"></div>
      <div class="sprocket-row">
        <span></span><span></span><span></span><span></span><span></span>
        <span></span><span></span><span></span><span></span><span></span>
      </div>
    </div>
    <div class="render-note" id="renderNote">Queued — this usually takes a few minutes.</div>
    <video class="result" id="resultVideo" controls></video>
    <a class="download" id="downloadLink" download>↓ Download MP4</a>
  </div>

  <footer>
    Built on Cloudflare Workers + free-tier rendering. Videos expire after 7 days.
  </footer>
</div>

<script>
  const API_BASE = ""; // same-origin; Worker serves both this page and the API

  const form = document.getElementById('genForm');
  const promptInput = document.getElementById('promptInput');
  const charCount = document.getElementById('charCount');
  const inputLabel = document.getElementById('inputLabel');
  const modeButtons = document.querySelectorAll('.mode-toggle button');
  const submitBtn = document.getElementById('submitBtn');
  const renderPanel = document.getElementById('renderPanel');
  const renderStatus = document.getElementById('renderStatus');
  const renderNote = document.getElementById('renderNote');
  const renderTimecode = document.getElementById('renderTimecode');
  const filmstripFill = document.getElementById('filmstripFill');
  const resultVideo = document.getElementById('resultVideo');
  const downloadLink = document.getElementById('downloadLink');
  const errorMsg = document.getElementById('errorMsg');
  const phoneInput = document.getElementById('phoneInput');
  const avatarUploadBtn = document.getElementById('avatarUploadBtn');
  const avatarFileInput = document.getElementById('avatarFileInput');
  const avatarOptions = document.querySelectorAll('.avatar-option');

  let selectedAvatar = { type: 'none' }; // { type: 'none' } | { type: 'preset', id } | { type: 'upload', dataUrl }

  function selectAvatarOption(el) {
    avatarOptions.forEach(o => { o.classList.remove('selected'); o.dataset.selected = 'false'; });
    el.classList.add('selected');
    el.dataset.selected = 'true';
  }

  avatarUploadBtn.addEventListener('click', () => avatarFileInput.click());

  avatarFileInput.addEventListener('change', () => {
    const file = avatarFileInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      selectedAvatar = { type: 'upload', dataUrl: reader.result };
      avatarUploadBtn.innerHTML = \`<img src="\${reader.result}" alt="Your photo">\`;
      selectAvatarOption(avatarUploadBtn);
    };
    reader.readAsDataURL(file);
  });

  document.querySelectorAll('.avatar-option.preset').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedAvatar = { type: 'preset', id: btn.dataset.preset };
      selectAvatarOption(btn);
    });
  });

  document.querySelector('.avatar-option.none-slot').addEventListener('click', (e) => {
    selectedAvatar = { type: 'none' };
    selectAvatarOption(e.currentTarget);
  });

  let mode = 'topic';
  let pollTimer = null;
  let elapsedTimer = null;
  let elapsedSeconds = 0;

  modeButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      modeButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      mode = btn.dataset.mode;
      inputLabel.textContent = mode === 'topic'
        ? "What's the video about?"
        : "Paste your script (blank line between scenes)";
      promptInput.placeholder = mode === 'topic'
        ? "e.g. the benefits of drinking water"
        : "Welcome to this video about...\\n\\nNext scene starts here...";
    });
  });

  promptInput.addEventListener('input', () => {
    charCount.textContent = promptInput.value.length;
  });

  async function loadLimits() {
    try {
      const res = await fetch(\`\${API_BASE}/api/limits\`);
      const data = await res.json();
      document.getElementById('usedToday').textContent = data.usedToday;
      document.getElementById('dailyLimit').textContent = data.dailyLimit;
    } catch (e) {
      document.getElementById('usedToday').textContent = '—';
      document.getElementById('dailyLimit').textContent = '—';
    }
  }
  loadLimits();

  function formatTime(s) {
    const m = Math.floor(s / 60).toString().padStart(2, '0');
    const sec = (s % 60).toString().padStart(2, '0');
    return \`\${m}:\${sec}\`;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = promptInput.value.trim();
    if (!text) return;

    errorMsg.classList.remove('visible');
    resultVideo.classList.remove('visible');
    downloadLink.classList.remove('visible');
    renderPanel.classList.add('visible');
    renderStatus.textContent = 'Queued…';
    renderStatus.className = 'render-status rendering';
    renderNote.textContent = 'Sending your request…';
    filmstripFill.style.width = '4%';
    submitBtn.disabled = true;
    submitBtn.textContent = 'Generating…';

    elapsedSeconds = 0;
    renderTimecode.textContent = '00:00';
    clearInterval(elapsedTimer);
    elapsedTimer = setInterval(() => {
      elapsedSeconds++;
      renderTimecode.textContent = formatTime(elapsedSeconds);
    }, 1000);

    const body = mode === 'topic' ? { topic: text } : { script: text };
    if (phoneInput.value.trim()) body.phone = phoneInput.value.trim();
    if (selectedAvatar.type === 'upload') body.avatarData = selectedAvatar.dataUrl;
    if (selectedAvatar.type === 'preset') body.avatarPreset = selectedAvatar.id;

    try {
      const res = await fetch(\`\${API_BASE}/api/generate\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Something went wrong starting the render.');
      }

      renderStatus.textContent = 'Rendering…';
      renderNote.textContent = 'Writing the script, generating voiceover and footage…';
      filmstripFill.style.width = '15%';
      pollStatus(data.jobId);
    } catch (err) {
      showError(err.message);
      resetForm();
    }
  });

  function pollStatus(jobId) {
    let progress = 15;
    clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      try {
        const res = await fetch(\`\${API_BASE}/api/status/\${jobId}\`);
        const data = await res.json();

        if (data.status === 'done') {
          clearInterval(pollTimer);
          clearInterval(elapsedTimer);
          filmstripFill.style.width = '100%';
          renderStatus.textContent = 'Ready';
          renderStatus.className = 'render-status done';
          renderNote.textContent = \`Finished in \${formatTime(elapsedSeconds)}.\`;
          resultVideo.src = data.videoUrl;
          resultVideo.classList.add('visible');
          downloadLink.href = data.videoUrl;
          downloadLink.classList.add('visible');
          resetForm();
          loadLimits();
        } else if (data.status === 'failed') {
          clearInterval(pollTimer);
          clearInterval(elapsedTimer);
          renderStatus.textContent = 'Failed';
          renderStatus.className = 'render-status failed';
          showError(data.error || 'The render failed. Please try again.');
          resetForm();
        } else {
          // still rendering — creep the bar so it feels alive without knowing exact progress
          progress = Math.min(progress + 4, 92);
          filmstripFill.style.width = progress + '%';
        }
      } catch (e) {
        // transient network hiccup — keep polling silently
      }
    }, 4000);
  }

  function showError(message) {
    errorMsg.textContent = message;
    errorMsg.classList.add('visible');
  }

  function resetForm() {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Generate video';
  }
</script>
</body>
</html>
`;
