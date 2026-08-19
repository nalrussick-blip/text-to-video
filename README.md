# Free Text-to-Video Tool — Setup Guide

Fully tested render pipeline (Ken Burns pans, burned-in captions, voiceover,
music mixing, avatar bubble overlay all confirmed working). Here's how to
wire it up end to end.

## Architecture — no payment card required anywhere
```
User (web form / WhatsApp)
        |
        v
Cloudflare Worker  --triggers-->  GitHub Actions (free runner)
   (KV job store)                     |
        ^                             v  runs pipeline.py
        |                        (edge-tts + Pexels + ffmpeg)
        |                             |
        +------ callback ------  GitHub Release (video storage, free,
                                  no card — public download link)
                                       |
                                       v
                              WhatsApp message w/ video link
```
Uploaded avatar photos are committed straight to the GitHub repo (via
GitHub's Contents API) and served from `raw.githubusercontent.com` — same
"no card" approach, no separate storage service needed.

## Cost: $0/month at moderate volume
- Cloudflare Workers/KV: free tier, no card required
- GitHub Releases + Actions: free (public repo = unlimited Actions minutes
  and unlimited Release storage/bandwidth; private = 2,000 min/month)
- edge-tts: free, no key needed
- Pexels API: free, 200 req/hour

## Setup steps

### 1. Pexels API key (stock footage/images)
Sign up free at https://www.pexels.com/api/ — instant approval, no cost ever.
✅ Already done if you followed along locally.

### 2. Create a GitHub repo
Push this folder's contents (`pipeline.py`, `expand_topic.py`,
`.github/workflows/render.yml`) to a repo. **Public repo strongly
recommended** — unlimited free Actions minutes and unlimited Release
storage, vs. 2,000 min/month on private.

Add these repo secrets (Settings → Secrets and variables → Actions):
- `PEXELS_API_KEY`
- `WORKER_URL` (your deployed Worker's URL — fill in after step 3)
- `RENDER_SECRET` (any random string you make up — shared secret between Worker and Actions)

Note: the video-publishing step uses the workflow run's own automatic
token, not a separate secret — one less thing to manage.

### 3. Cloudflare Worker
The worker serves the web page itself (`worker/public/index.html`), so it
needs a build step to inline the page into the JS bundle before each deploy:
```
cd worker
wrangler kv namespace create JOBS_KV     # copy the returned id into wrangler.toml
wrangler secret put GITHUB_TOKEN         # a GitHub PAT — scopes below
wrangler secret put RENDER_SECRET        # same value as the GitHub secret above
wrangler secret put WHATSAPP_TOKEN       # from Meta for Developers (optional)

node build.js && wrangler deploy         # always run build.js before deploy
```

**`GITHUB_TOKEN` scopes needed** (fine-grained PAT, scoped to your repo):
- `Actions: Read and write` (to trigger the render workflow)
- `Contents: Read and write` (to commit uploaded avatar photos)

Edit `wrangler.toml`'s `GITHUB_REPO` (format: `yourusername/yourrepo`) and
`DAILY_LIMIT` (protects your free-tier quotas — GitHub Actions minutes,
Pexels rate limit, Workers AI neurons — from a burst of traffic). The web
page shows this limit and today's usage live.

**Avatar bubble presets**: if you want the 3 preset avatar options on the
page to work, commit 3 images to your repo at `presets/preset1.png`,
`presets/preset2.png`, `presets/preset3.png`. Users can also upload their
own photo instead — it's committed to the repo under `avatars/<jobId>.<ext>`
and passed to the renderer, which crops it into a circular bubble shown in
the corner of the video (not an animated/talking face — just a static
photo, like a creator's profile picture).

### 4. WhatsApp (optional)
Set up a free WhatsApp Cloud API app at https://developers.facebook.com/ —
free tier gives 1,000 conversations/month. Point the webhook at
`https://your-worker.workers.dev/webhook/whatsapp`.

### 5. LLM for topic expansion (optional — only needed for "topic" mode)
`expand_topic.py` uses Cloudflare Workers AI (10,000 free neurons/day).
✅ Already set up locally with `CF_ACCOUNT_ID` / `CF_API_TOKEN`. For the
deployed version, add these as GitHub secrets too so the Actions workflow
can call it.

## Testing locally before deploying
```bash
pip install edge-tts requests pillow --break-system-packages
export PEXELS_API_KEY=your_key_here
python3 pipeline.py your_script.txt output.mp4

# with background music:
python3 pipeline.py your_script.txt output.mp4 music.mp3

# with a topic instead of a script (needs CF_ACCOUNT_ID / CF_API_TOKEN set):
python3 pipeline.py --topic "the benefits of drinking water" output.mp4

# with an avatar bubble in the corner:
python3 pipeline.py your_script.txt output.mp4 music.mp3 --avatar photo.jpg
```

Script format: separate scenes with a blank line. Example:
```
Welcome to this video about the ocean.
It covers over seventy percent of our planet.

Coral reefs support a quarter of all marine species.
Yet they cover less than one percent of the ocean floor.
```

## What was tested and confirmed working (locally, end to end)
- Scene splitting logic (both blank-line-separated and sentence-grouped fallback)
- ffmpeg Ken Burns pan (zoompan) on still images
- Caption burn-in with text wrapping and readable box overlay
- Multi-scene concatenation
- Background music mixing under voiceover audio
- Topic → script expansion via Cloudflare Workers AI
- Circular avatar bubble overlay (uploaded photo, cropped + bordered + composited)
- Full pipeline run end to end on Windows (script mode, topic mode, with music, with avatar)
- Worker build script (inlines the HTML page into the JS bundle) and syntax-validated worker output
- `render.yml` validated as well-formed YAML

## Not yet tested live (needs real deployment to verify)
- Worker's GitHub-based avatar commit / preset avatar resolution
- Worker's daily-limit enforcement and `/api/limits` endpoint
- WhatsApp send/receive flow
- GitHub Actions workflow end to end (avatar download step, Release
  publishing, failure callback)
These use standard, well-documented APIs and follow the same patterns
already confirmed working locally — but deploy and test with real traffic
before relying on them.

## Next steps to make it production-ready
- Add rate limiting per phone number/IP to avoid abuse of your free-tier quotas
- Consider caching stock footage searches to reduce Pexels API calls
- Swap `en-US-GuyNeural` for other edge-tts voices as needed (100+ free voices available)
- If videos get long-lived/high-traffic, revisit R2 later (it's a fine
  upgrade path once you're ready to add a card — GitHub Releases work
  great at moderate volume in the meantime)
