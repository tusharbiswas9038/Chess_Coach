# coach/ollama_client.py
import httpx
from config import OLLAMA_URL, OLLAMA_MODEL, OLLAMA_MODEL_FAST

TIMEOUT = 180.0  # generous for ARM CPU inference

_async_client = httpx.AsyncClient(timeout=TIMEOUT)


async def generate(prompt: str, fast: bool = False) -> str:
    """
    Single-turn generation.
    fast=True → uses OLLAMA_MODEL_FAST (7B) for batch jobs.
    fast=False → uses OLLAMA_MODEL (14B) for interactive coaching.
    """
    model = OLLAMA_MODEL_FAST if fast else OLLAMA_MODEL
    payload = {
        "model": model,
        "prompt": prompt,
        "stream": False,
        "options": {
            "temperature": 0.25,
            "top_p": 0.85,
            "num_predict": 300,   # keep tight — faster, less hallucination
        }
    }
    r = await _async_client.post(f"{OLLAMA_URL}/api/generate", json=payload)
    r.raise_for_status()
    return r.json()["response"].strip()


async def chat(messages: list[dict]) -> str:
    """
    Multi-turn chat with full player context injected as system message.
    Always uses OLLAMA_MODEL (14B) for best quality in interactive mode.
    """
    from coach.prompt_builder import build_player_context
    context = build_player_context()

    full_messages = [
        {
            "role": "system",
            "content": (
                "You are a chess coach. Here is your student's current data:\n\n"
                + context
            )
        }
    ] + messages

    payload = {
        "model": OLLAMA_MODEL,
        "messages": full_messages,
        "stream": False,
        "options": {
            "temperature": 0.25,
            "num_predict": 500
        }
    }
    r = await _async_client.post(f"{OLLAMA_URL}/api/chat", json=payload)
    r.raise_for_status()
    return r.json()["message"]["content"].strip()
