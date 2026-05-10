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


import httpx
import json # New: Import json
from typing import Any, AsyncGenerator, List, Dict

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


async def _build_full_messages(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Helper to build full messages including player context."""
    from coach.prompt_builder import build_player_context
    context = build_player_context()

    return [
        {
            "role": "system",
            "content": (
                "You are a chess coach. Here is your student's current data:\n\n"
                + context
            )
        }
    ] + messages


async def chat_stream(messages: List[Dict[str, Any]]) -> AsyncGenerator[str, None]:
    """
    Multi-turn chat with full player context, streaming response.
    Always uses OLLAMA_MODEL (14B) for best quality in interactive mode.
    """
    full_messages = await _build_full_messages(messages)

    payload = {
        "model": OLLAMA_MODEL,
        "messages": full_messages,
        "stream": True, # Always stream
        "options": {
            "temperature": 0.25,
            "num_predict": 500
        }
    }
    async with _async_client.stream("POST", f"{OLLAMA_URL}/api/chat", json=payload) as response:
        response.raise_for_status()
        async for chunk in response.aiter_bytes():
            try:
                decoded_chunk = chunk.decode("utf-8")
                for line in decoded_chunk.splitlines():
                    if line.strip():
                        json_data = json.loads(line)
                        if "content" in json_data["message"]:
                            yield json_data["message"]["content"]
                        if json_data.get("done"):
                            break
            except json.JSONDecodeError:
                # Handle incomplete JSON chunks if necessary
                pass

async def chat(messages: List[Dict[str, Any]]) -> str:
    """
    Multi-turn chat with full player context, non-streaming response.
    Collects all chunks from chat_stream and returns as a single string.
    """
    full_response = []
    async for chunk in chat_stream(messages):
        full_response.append(chunk)
    return "".join(full_response).strip()
