#!/usr/bin/env python3
"""
Expands a one-line topic into a full scene-broken script using an LLM.
Prints the script to stdout (used by the GitHub Actions workflow).

Swap the call below for whichever free-tier LLM you prefer:
  - Cloudflare Workers AI (free tier, e.g. @cf/meta/llama-3-8b-instruct)
  - Anthropic API (has some free credits for new accounts)
  - Any other free-tier LLM API

This uses a plain HTTP call so it has no hard dependency on one vendor's SDK.
"""
import os
import sys
import requests

PROMPT_TEMPLATE = """Write a narration script for a short video about: {topic}

Rules:
- Write 8-10 scenes (keep it tight — each scene takes real time to render).
- Each scene is 1-2 short, spoken-style sentences (this will be read aloud by TTS).
- Separate each scene with a blank line.
- No scene numbers, no stage directions, no markdown — just the narration text.
- Conversational, engaging tone suitable for a general audience.
"""

def expand_with_workers_ai(topic: str) -> str:
    """Cloudflare Workers AI free tier (10,000 neurons/day free)."""
    account_id = os.environ["CF_ACCOUNT_ID"]
    api_token = os.environ["CF_API_TOKEN"]
    model = "@cf/meta/llama-3.1-8b-instruct"

    r = requests.post(
        f"https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/{model}",
        headers={"Authorization": f"Bearer {api_token}"},
        json={
            "messages": [{"role": "user", "content": PROMPT_TEMPLATE.format(topic=topic)}],
            "max_tokens": 1024,
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["result"]["response"]


if __name__ == "__main__":
    topic = sys.argv[1] if len(sys.argv) > 1 else "the topic provided"
    script = expand_with_workers_ai(topic)
    print(script.strip())
