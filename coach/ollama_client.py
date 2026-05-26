import json
from typing import Any, AsyncGenerator, Dict, List

import httpx
from config import OLLAMA_URL, OLLAMA_MODEL, OLLAMA_MODEL_FAST
from coach.prompt_builder import build_coach_system_prompt, coach_mode_num_predict

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
            "num_predict": 300,
        }
    }
    r = await _async_client.post(f"{OLLAMA_URL}/api/generate", json=payload)
    r.raise_for_status()
    return r.json()["response"].strip()


def _build_full_messages(
    messages: List[Dict[str, Any]],
    *,
    context: str,
    mode: str,
) -> List[Dict[str, Any]]:
    return [
        {
            "role": "system",
            "content": build_coach_system_prompt(context=context, mode=mode),
        }
    ] + messages


async def chat_stream(
    messages: List[Dict[str, Any]],
    *,
    context: str,
    mode: str = "quick_answer",
) -> AsyncGenerator[str, None]:
    """
    Multi-turn chat with retrieval-enhanced player context.
    Always uses OLLAMA_MODEL (14B) for best quality in interactive mode.
    """
    full_messages = _build_full_messages(messages, context=context, mode=mode)

    payload = {
        "model": OLLAMA_MODEL,
        "messages": full_messages,
        "stream": True,
        "options": {
            "temperature": 0.25,
            "top_p": 0.85,
            "num_predict": coach_mode_num_predict(mode),
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
                pass


async def chat(
    messages: List[Dict[str, Any]],
    *,
    context: str,
    mode: str = "quick_answer",
) -> str:
    """
    Multi-turn chat with full player context, non-streaming response.
    Collects all chunks from chat_stream and returns as a single string.
    """
    full_response = []
    async for chunk in chat_stream(messages, context=context, mode=mode):
        full_response.append(chunk)
    return "".join(full_response).strip()
