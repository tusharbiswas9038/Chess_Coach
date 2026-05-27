import asyncio
import json
import logging
import time
from collections import deque
from typing import Any, AsyncGenerator, Deque, Dict, List

import httpx
from config import OLLAMA_URL, OLLAMA_MODEL, OLLAMA_MODEL_FAST
from coach.prompt_builder import build_coach_system_prompt, coach_mode_num_predict

log = logging.getLogger("chess_coach.coach.ollama")

# Per-call deadlines. The shared client carries a generous ceiling, but each
# call applies a tighter, mode-specific deadline so a hung Ollama can't tie
# up a request handler indefinitely.
TIMEOUT_CHAT_SEC = 60.0       # interactive chat (streaming or non-streaming)
TIMEOUT_BATCH_SEC = 30.0      # batch report generation (fast model)
TIMEOUT_GENERATE_SEC = 60.0   # one-shot generate against the full model
CLIENT_CEILING_SEC = 180.0    # generous outer bound for the shared httpx client

_async_client = httpx.AsyncClient(timeout=CLIENT_CEILING_SEC)


# ── Circuit breaker ───────────────────────────────────────────────────────────
# Counts recent failures. After OPEN_THRESHOLD failures inside FAILURE_WINDOW_SEC,
# the breaker opens for OPEN_COOLDOWN_SEC and short-circuits new calls with a
# graceful fallback instead of letting them queue against a dead model.

OPEN_THRESHOLD = 3
FAILURE_WINDOW_SEC = 60.0
OPEN_COOLDOWN_SEC = 30.0


class _Breaker:
    def __init__(self) -> None:
        self._failures: Deque[float] = deque(maxlen=20)
        self._open_until: float = 0.0

    def is_open(self) -> bool:
        return time.monotonic() < self._open_until

    def record_failure(self) -> None:
        now = time.monotonic()
        cutoff = now - FAILURE_WINDOW_SEC
        while self._failures and self._failures[0] < cutoff:
            self._failures.popleft()
        self._failures.append(now)
        if len(self._failures) >= OPEN_THRESHOLD:
            self._open_until = now + OPEN_COOLDOWN_SEC
            log.warning(
                "ollama circuit breaker OPEN for %.0fs after %d failures",
                OPEN_COOLDOWN_SEC,
                len(self._failures),
            )

    def record_success(self) -> None:
        # A clean call clears the failure window so we don't trip on stale errors.
        self._failures.clear()
        self._open_until = 0.0

    def state(self) -> Dict[str, Any]:
        return {
            "open": self.is_open(),
            "open_until": self._open_until,
            "recent_failures": len(self._failures),
        }


_breaker = _Breaker()


def get_breaker_state() -> Dict[str, Any]:
    """Exposed for /api/metrics or debug routes — read-only snapshot."""
    return _breaker.state()


FALLBACK_MESSAGE = (
    "The coach model didn't respond in time. Try again in a few seconds — "
    "if this keeps happening, check that Ollama is running and the model is loaded."
)
FALLBACK_BREAKER_MESSAGE = (
    "The coach model has been failing for a moment, so I'm pausing requests "
    "for a short cooldown. Try again in ~30 seconds."
)


def _is_transport_failure(exc: BaseException) -> bool:
    return isinstance(
        exc,
        (
            httpx.TimeoutException,
            httpx.ConnectError,
            httpx.ReadError,
            httpx.RemoteProtocolError,
            asyncio.TimeoutError,
        ),
    )


# ── Public API ────────────────────────────────────────────────────────────────


async def generate(prompt: str, fast: bool = False) -> str:
    """
    Single-turn generation. fast=True uses the 7B model for batch jobs.

    Falls back to a friendly string on timeout, transport failure, or while the
    circuit breaker is open. Other HTTP errors still raise — those signal a
    real bug, not a transient outage.
    """
    if _breaker.is_open():
        return FALLBACK_BREAKER_MESSAGE

    model = OLLAMA_MODEL_FAST if fast else OLLAMA_MODEL
    timeout = TIMEOUT_BATCH_SEC if fast else TIMEOUT_GENERATE_SEC
    payload = {
        "model": model,
        "prompt": prompt,
        "stream": False,
        "options": {
            "temperature": 0.25,
            "top_p": 0.85,
            "num_predict": 300,
        },
    }
    try:
        r = await _async_client.post(
            f"{OLLAMA_URL}/api/generate",
            json=payload,
            timeout=timeout,
        )
        r.raise_for_status()
        _breaker.record_success()
        return r.json()["response"].strip()
    except Exception as exc:
        if _is_transport_failure(exc):
            _breaker.record_failure()
            log.warning("ollama generate failed (%s): %s", type(exc).__name__, exc)
            return FALLBACK_MESSAGE
        raise


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
    Multi-turn chat. Yields response chunks; on timeout or transport failure,
    yields a friendly fallback chunk and returns. Always uses the full model.
    """
    if _breaker.is_open():
        yield FALLBACK_BREAKER_MESSAGE
        return

    full_messages = _build_full_messages(messages, context=context, mode=mode)
    payload = {
        "model": OLLAMA_MODEL,
        "messages": full_messages,
        "stream": True,
        "options": {
            "temperature": 0.25,
            "top_p": 0.85,
            "num_predict": coach_mode_num_predict(mode),
        },
    }
    yielded_anything = False
    try:
        async with _async_client.stream(
            "POST",
            f"{OLLAMA_URL}/api/chat",
            json=payload,
            timeout=TIMEOUT_CHAT_SEC,
        ) as response:
            response.raise_for_status()
            async for chunk in response.aiter_bytes():
                try:
                    decoded_chunk = chunk.decode("utf-8")
                    for line in decoded_chunk.splitlines():
                        if line.strip():
                            json_data = json.loads(line)
                            if "content" in json_data["message"]:
                                yielded_anything = True
                                yield json_data["message"]["content"]
                            if json_data.get("done"):
                                break
                except json.JSONDecodeError:
                    pass
        _breaker.record_success()
    except Exception as exc:
        if _is_transport_failure(exc):
            _breaker.record_failure()
            log.warning("ollama chat_stream failed (%s): %s", type(exc).__name__, exc)
            if yielded_anything:
                yield "\n\n[Coach response was cut off — please retry.]"
            else:
                yield FALLBACK_MESSAGE
            return
        raise


async def chat(
    messages: List[Dict[str, Any]],
    *,
    context: str,
    mode: str = "quick_answer",
) -> str:
    """
    Non-streaming variant: collects chunks from chat_stream into one string.
    Inherits the same timeout + circuit breaker behavior.
    """
    full_response = []
    async for chunk in chat_stream(messages, context=context, mode=mode):
        full_response.append(chunk)
    return "".join(full_response).strip()
