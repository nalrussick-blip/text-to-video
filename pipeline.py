#!/usr/bin/env python3
"""
Free Text-to-Video Pipeline
============================
Turns a script (or topic) into a 2-5 minute video using:
  - Free stock footage/images (Pexels API - free key required)
  - Free TTS voiceover (edge-tts - no key needed)
  - Auto-generated burned-in captions
  - ffmpeg assembly with Ken Burns pans + background music

Deploy target: any environment with normal internet access
(a small VM, GitHub Actions runner, RunPod, etc). NOT Cloudflare
Workers itself (no ffmpeg/binary execution there) - Workers is the
front door (web/WhatsApp), this script is the render worker it
triggers.

Requirements:
    pip install edge-tts requests --break-system-packages
    ffmpeg must be installed on the host

Get a free Pexels API key: https://www.pexels.com/api/  (200 req/hour, unlimited monthly)
"""

import asyncio
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
import edge_tts
import requests
from PIL import Image, ImageDraw

HEADERS_DOWNLOAD = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
}


def download_file(url: str, out_path: Path):
    r = request_with_retry("get", url, headers=HEADERS_DOWNLOAD, stream=True, timeout=30)
    r.raise_for_status()
    with open(out_path, "wb") as f:
        for chunk in r.iter_content(chunk_size=8192):
            f.write(chunk)


def find_font_file() -> str:
    """ffmpeg's drawtext needs an explicit font file on Windows (no fontconfig there)."""
    candidates = [
        "C:/Windows/Fonts/arial.ttf",
        "C:/Windows/Fonts/segoeui.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
    ]
    for c in candidates:
        if Path(c).exists():
            return c
    raise RuntimeError(
        "No system font found for captions. Install a font or edit FONT_FILE in pipeline.py "
        "to point at a .ttf file on your system."
    )


FONT_FILE = find_font_file().replace(":", "\\:")  # escape colon for ffmpeg filter syntax (Windows paths)

AVATAR_SIZE = 220           # pixel diameter of the circular bubble
AVATAR_BORDER = 6           # ring thickness around the avatar
AVATAR_BORDER_COLOR = (226, 167, 59, 255)  # amber ring
AVATAR_MARGIN_X = 48
AVATAR_MARGIN_Y = 260       # keep clear of the caption box at the bottom


def prepare_avatar(avatar_path: Path) -> Path:
    """
    Takes any uploaded photo (or preset image) and produces a circular,
    bordered PNG with transparency, ready to overlay on every scene.
    Cached once per run (same file reused across all scenes).
    """
    img = Image.open(avatar_path).convert("RGBA")

    # center-crop to square
    w, h = img.size
    side = min(w, h)
    left, top = (w - side) // 2, (h - side) // 2
    img = img.crop((left, top, left + side, top + side))
    img = img.resize((AVATAR_SIZE, AVATAR_SIZE), Image.LANCZOS)

    # circular alpha mask
    mask = Image.new("L", (AVATAR_SIZE, AVATAR_SIZE), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, AVATAR_SIZE, AVATAR_SIZE), fill=255)
    img.putalpha(mask)

    # composite onto a slightly larger canvas so the border ring isn't clipped
    canvas_size = AVATAR_SIZE + AVATAR_BORDER * 2
    canvas = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)
    draw.ellipse((0, 0, canvas_size, canvas_size), fill=AVATAR_BORDER_COLOR)
    canvas.paste(img, (AVATAR_BORDER, AVATAR_BORDER), img)

    out_path = WORKDIR / "avatar_circular.png"
    canvas.save(out_path)
    return out_path

# ---------- CONFIG ----------
PEXELS_API_KEY = os.environ.get("PEXELS_API_KEY", "")  # set this env var
VOICE = "en-US-GuyNeural"      # free edge-tts voice; try en-US-AriaNeural, en-GB-RyanNeural etc.
WORKDIR = Path("./render")
FPS = 30
VIDEO_SIZE = "1080x1920"  # vertical; use "1920x1080" for landscape
SCENE_MIN_SEC = 6          # floor duration even if voiceover is shorter
BG_MUSIC_VOLUME = 0.08     # keep music quiet under voiceover

WORKDIR.mkdir(exist_ok=True)


# ---------- 1. SCRIPT -> SCENES ----------
def split_script_into_scenes(script_text: str) -> list[str]:
    """
    Splits a script into scenes. Convention: blank line = new scene.
    If the user just pastes prose, falls back to splitting by sentence
    groups (~2 sentences per scene).
    """
    blocks = [b.strip() for b in re.split(r"\n\s*\n", script_text.strip()) if b.strip()]
    if len(blocks) > 1:
        return blocks

    # fallback: group sentences
    sentences = re.split(r"(?<=[.!?])\s+", script_text.strip())
    scenes, chunk = [], []
    for s in sentences:
        chunk.append(s)
        if len(chunk) == 2:
            scenes.append(" ".join(chunk))
            chunk = []
    if chunk:
        scenes.append(" ".join(chunk))
    return scenes


def expand_topic_to_script(topic: str) -> str:
    """
    Placeholder for topic->script expansion via an LLM.
    Wire this to Cloudflare Workers AI, Claude API, or any free-tier LLM.
    Returns a script with blank-line-separated scenes.
    """
    raise NotImplementedError(
        "Wire this to your LLM of choice (Workers AI free tier / Claude API). "
        "Prompt: 'Write a ~<N>-scene narration script about <topic>, one scene "
        "per paragraph, ~2 sentences each, conversational tone.'"
    )


# ---------- 2. TTS ----------
async def generate_voiceover(text: str, out_path: Path, voice: str = VOICE):
    communicate = edge_tts.Communicate(text, voice)
    await communicate.save(str(out_path))


def get_audio_duration(path: Path) -> float:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "json", str(path)],
        capture_output=True, text=True
    )
    return float(json.loads(result.stdout)["format"]["duration"])


# ---------- 3. STOCK FOOTAGE / IMAGES ----------
def request_with_retry(method: str, url: str, retries: int = 3, **kwargs):
    """
    Wraps requests.get/post with automatic retry on timeouts/transient
    network errors — Pexels occasionally times out under load, and with
    20-30+ network calls per video, an unhandled single timeout shouldn't
    fail the whole render.
    """
    last_exc = None
    for attempt in range(retries):
        try:
            return getattr(requests, method)(url, **kwargs)
        except (requests.exceptions.Timeout, requests.exceptions.ConnectionError) as e:
            last_exc = e
            if attempt < retries - 1:
                time.sleep(2 * (attempt + 1))  # 2s, 4s backoff
    raise last_exc


def fetch_pexels_video(query: str, out_path: Path) -> bool:
    """Try to fetch a short stock video clip matching the scene text."""
    if not PEXELS_API_KEY:
        return False
    headers = {"Authorization": PEXELS_API_KEY}
    r = request_with_retry(
        "get", "https://api.pexels.com/videos/search",
        params={"query": query, "per_page": 1, "orientation": "portrait"},
        headers=headers, timeout=20
    )
    if r.status_code != 200 or not r.json().get("videos"):
        return False
    video = r.json()["videos"][0]
    # pick a reasonably sized file
    files = sorted(video["video_files"], key=lambda f: f.get("width", 0))
    link = next((f["link"] for f in files if 720 <= f.get("width", 0) <= 1280), files[-1]["link"])
    download_file(link, out_path)
    return True


def fetch_pexels_image(query: str, out_path: Path) -> bool:
    """Fallback: fetch a still image (used with Ken Burns pan) if no video match."""
    if not PEXELS_API_KEY:
        return False
    headers = {"Authorization": PEXELS_API_KEY}
    r = request_with_retry(
        "get", "https://api.pexels.com/v1/search",
        params={"query": query, "per_page": 1, "orientation": "portrait"},
        headers=headers, timeout=20
    )
    if r.status_code != 200 or not r.json().get("photos"):
        return False
    url = r.json()["photos"][0]["src"]["large2x"]
    download_file(url, out_path)
    return True


def scene_keywords(scene_text: str, topic: str | None = None) -> str:
    """
    Keyword extraction for stock footage search. Anchors every scene's
    search to the overall topic (when known) so footage stays on-theme
    even when an individual scene's sentence is abstract (e.g. "the crowd
    cheered" alone would match generic crowd footage, not horse racing).
    """
    stop = {"this", "that", "with", "from", "have", "will", "your", "about", "which", "there"}

    topic_words = []
    if topic:
        topic_words = [w for w in re.findall(r"[A-Za-z]{4,}", topic) if w.lower() not in stop][:2]

    scene_words = re.findall(r"[A-Za-z]{4,}", scene_text)
    scene_words = [w for w in scene_words if w.lower() not in stop]
    # drop scene words that just repeat a topic word already included
    scene_words = [w for w in scene_words if w.lower() not in {t.lower() for t in topic_words}]

    remaining_slots = max(4 - len(topic_words), 2)
    keywords = topic_words + scene_words[:remaining_slots]
    return " ".join(keywords) or (topic or "abstract background")


# ---------- 4. ASSEMBLE ONE SCENE ----------
def build_scene_clip(scene_idx: int, scene_text: str, media_path: Path,
                      audio_path: Path, is_image: bool, duration: float,
                      avatar_path: Path | None = None) -> Path:
    out = WORKDIR / f"scene_{scene_idx:03d}.mp4"
    caption = scene_text.replace("'", "\u2019").replace(":", "\u2236").replace("%", "\uff05")
    # wrap caption every ~40 chars for readability
    wrapped = "\n".join(re.findall(r".{1,40}(?:\s+|$)", caption))[:400]

    drawtext = (
        f"drawtext=fontfile='{FONT_FILE}':text='{wrapped}':fontcolor=white:fontsize=48:"
        f"box=1:boxcolor=black@0.5:boxborderw=20:"
        f"x=(w-text_w)/2:y=h-th-120:line_spacing=10"
    )
    overlay_pos = f"x=W-w-{AVATAR_MARGIN_X}:y=H-h-{AVATAR_MARGIN_Y}"

    if is_image:
        base_chain = (
            f"[0:v]scale=8000:-1,zoompan=z='min(zoom+0.0007,1.3)':d={int(duration*FPS)}:"
            f"s={VIDEO_SIZE}:fps={FPS},{drawtext}[base]"
        )
        inputs = ["-loop", "1", "-i", str(media_path), "-i", str(audio_path)]
    else:
        base_chain = (
            f"[0:v]scale={VIDEO_SIZE.replace('x', ':')}:force_original_aspect_ratio=increase,"
            f"crop={VIDEO_SIZE.replace('x', ':')},{drawtext}[base]"
        )
        inputs = ["-stream_loop", "-1", "-i", str(media_path), "-i", str(audio_path)]

    if avatar_path:
        inputs += ["-i", str(avatar_path)]
        filter_complex = f"{base_chain};[base][2:v]overlay={overlay_pos}[outv]"
        map_args = ["-map", "[outv]", "-map", "1:a"]
        filter_args = ["-filter_complex", filter_complex]
    else:
        map_args = ["-map", "0:v", "-map", "1:a"] if not is_image else []
        filter_args = ["-vf", base_chain.replace("[0:v]", "").replace("[base]", "")]

    cmd = ["ffmpeg", "-y", *inputs, *filter_args,
           "-t", str(duration), *map_args,
           "-c:v", "libx264", "-pix_fmt", "yuv420p",
           "-c:a", "aac", "-shortest", str(out), "-loglevel", "error"]
    subprocess.run(cmd, check=True)
    return out


# ---------- 5. CONCATENATE + MUSIC ----------
def concatenate_scenes(scene_paths: list[Path], music_path: Path | None, final_out: Path):
    list_file = WORKDIR / "concat_list.txt"
    list_file.write_text("\n".join(f"file '{p.resolve()}'" for p in scene_paths))

    concat_out = WORKDIR / "concatenated.mp4"
    subprocess.run(
        ["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(list_file),
         "-c", "copy", str(concat_out), "-loglevel", "error"],
        check=True
    )

    if music_path and music_path.exists():
        subprocess.run([
            "ffmpeg", "-y", "-i", str(concat_out), "-stream_loop", "-1", "-i", str(music_path),
            "-filter_complex",
            f"[0:a]aformat=sample_rates=44100:channel_layouts=stereo[voice];"
            f"[1:a]aformat=sample_rates=44100:channel_layouts=stereo,volume={BG_MUSIC_VOLUME}[music];"
            f"[voice][music]amix=inputs=2:duration=first:dropout_transition=0[aout]",
            "-map", "0:v", "-map", "[aout]",
            "-c:v", "copy", "-c:a", "aac", "-shortest", str(final_out), "-loglevel", "error"
        ], check=True)
    else:
        concat_out.rename(final_out)


# ---------- MAIN ----------
def run(script_text: str, output_path: str = "final_video.mp4", music_path: str | None = None,
        avatar_path: str | None = None, topic: str | None = None):
    scenes = split_script_into_scenes(script_text)
    print(f"[1/4] Split into {len(scenes)} scenes")

    prepared_avatar = prepare_avatar(Path(avatar_path)) if avatar_path else None
    if prepared_avatar:
        print(f"      Avatar ready: {prepared_avatar}")

    scene_clips = []
    for i, scene_text in enumerate(scenes):
        audio_path = WORKDIR / f"audio_{i:03d}.mp3"
        asyncio.run(generate_voiceover(scene_text, audio_path))
        duration = max(get_audio_duration(audio_path), SCENE_MIN_SEC)
        print(f"  scene {i}: {duration:.1f}s voiceover")

        query = scene_keywords(scene_text, topic)
        video_path = WORKDIR / f"media_{i:03d}.mp4"
        image_path = WORKDIR / f"media_{i:03d}.jpg"

        if fetch_pexels_video(query, video_path):
            clip = build_scene_clip(i, scene_text, video_path, audio_path, is_image=False,
                                     duration=duration, avatar_path=prepared_avatar)
        elif fetch_pexels_image(query, image_path):
            clip = build_scene_clip(i, scene_text, image_path, audio_path, is_image=True,
                                     duration=duration, avatar_path=prepared_avatar)
        else:
            raise RuntimeError(
                f"No PEXELS_API_KEY set or no stock match for scene {i} ('{query}'). "
                "Get a free key at https://www.pexels.com/api/"
            )
        scene_clips.append(clip)

    print("[2/4] All scenes rendered")
    print("[3/4] Concatenating + adding music")
    concatenate_scenes(scene_clips, Path(music_path) if music_path else None, Path(output_path))
    print(f"[4/4] Done -> {output_path}")


if __name__ == "__main__":
    # pull out --avatar PATH and --topic-anchor TEXT from anywhere in the args
    # before positional parsing. --topic-anchor lets script-file mode (used by
    # the deployed Worker/Actions pipeline, which pre-expands topics into a
    # script file) still anchor stock-footage search to the original topic.
    avatar_path = None
    topic_anchor = None
    args = sys.argv[1:]
    if "--avatar" in args:
        idx = args.index("--avatar")
        avatar_path = args[idx + 1]
        args = args[:idx] + args[idx + 2:]
    if "--topic-anchor" in args:
        idx = args.index("--topic-anchor")
        topic_anchor = args[idx + 1]
        args = args[:idx] + args[idx + 2:]

    if len(args) < 1:
        print("Usage:")
        print("  python pipeline.py <script.txt> [output.mp4] [music.mp3] [--avatar photo.jpg]")
        print('  python pipeline.py --topic "your topic here" [output.mp4] [music.mp3] [--avatar photo.jpg]')
        sys.exit(1)

    if args[0] == "--topic":
        topic = args[1]
        output_path = args[2] if len(args) > 2 else "final_video.mp4"
        music_path = args[3] if len(args) > 3 else None
        from expand_topic import expand_with_workers_ai
        print(f"[0/4] Expanding topic into script: {topic}")
        script_text = expand_with_workers_ai(topic)
        print(script_text)
        print("---")
    else:
        topic = topic_anchor
        script_text = Path(args[0]).read_text(encoding="utf-8-sig")
        output_path = args[1] if len(args) > 1 else "final_video.mp4"
        music_path = args[2] if len(args) > 2 else None

    run(script_text, output_path, music_path, avatar_path, topic)
