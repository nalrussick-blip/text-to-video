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
const INDEX_HTML = `__INDEX_HTML_PLACEHOLDER__`;
