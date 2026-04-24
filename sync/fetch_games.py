# sync/fetch_games.py
import re
import sqlite3
import time
from datetime import datetime, timezone

import chess.pgn
import httpx
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from api.db import get_db

from config import CHESS_USERNAME, CHESS_BASE_URL

HEADERS = {"User-Agent": "chess-coach-personal/1.0 (tusharbiswas9038@gmail.com)"}
HTTP_TIMEOUT = httpx.Timeout(timeout=60.0, connect=15.0)
HTTP_LIMITS = httpx.Limits(max_keepalive_connections=10, max_connections=20)

RESULT_MAP = {
    "win": "win",
    "checkmated": "loss",
    "timeout": "loss",
    "resigned": "loss",
    "lose": "loss",
    "stalemate": "draw",
    "agreed": "draw",
    "repetition": "draw",
    "insufficient": "draw",
    "50move": "draw",
    "abandoned": "loss",
    "threecheck": "loss",
    "kingofthehill": "loss",
    "bughouse": "loss",
}

# Rapid time controls to include
RAPID_TCS = {"600", "900", "1800", "600+0", "900+0", "1800+0", "600+5", "900+10"}


def _get_json_with_retry(
    client: httpx.Client, url: str, *, attempts: int = 3
) -> dict:
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            r = client.get(url)
            r.raise_for_status()
            return r.json()
        except Exception as e:
            last_error = e
            if attempt < attempts:
                time.sleep(attempt)
    assert last_error is not None
    raise last_error


def get_monthly_archive_urls(client: httpx.Client, username: str) -> list[str]:
    url = f"{CHESS_BASE_URL}/player/{username.lower()}/games/archives"
    payload = _get_json_with_retry(client, url)
    return payload.get("archives", [])


def fetch_month(client: httpx.Client, url: str) -> list[dict]:
    payload = _get_json_with_retry(client, url)
    return payload.get("games", [])


def extract_opening_from_pgn(pgn_text: str) -> tuple[str | None, str | None]:
    """Extract ECO code and opening name from PGN headers."""
    eco, name = None, None
    for line in pgn_text.splitlines():
        if line.startswith('[ECOUrl'):
            # ECOUrl contains path like /openings/Sicilian-Defense
            m = re.search(r'\[ECOUrl\s+"[^"]+/([^"]+)"\]', line)
            if m:
                name = m.group(1).replace("-", " ")
        elif line.startswith('[ECO '):
            m = re.search(r'\[ECO\s+"([A-Z]\d+)"\]', line)
            if m:
                eco = m.group(1)
        if eco and name:
            break
    return eco, name


def extract_termination_from_pgn(pgn_text: str) -> str | None:
    """Extract Termination tag from PGN headers."""
    for line in pgn_text.splitlines():
        if line.startswith('[Termination'):
            m = re.search(r'\[Termination\s+"([^"]+)"\]', line)
            if m:
                return m.group(1)
    return None


def upsert_game(conn: sqlite3.Connection, g: dict) -> bool:
    """Insert game if not already present. Returns True if new game inserted."""
    username_lower = CHESS_USERNAME.lower()

    white = g.get("white", {})
    black = g.get("black", {})

    if white.get("username", "").lower() == username_lower:
        color = "white"
        raw_result = white.get("result", "")
        opp_rating = black.get("rating", 0)
    else:
        color = "black"
        raw_result = black.get("result", "")
        opp_rating = white.get("rating", 0)

    normalized = RESULT_MAP.get(raw_result, "loss")
    game_id = str(g.get("uuid") or g["url"].split("/")[-1])
    pgn_text = g.get("pgn", "")

    eco, opening_name = extract_opening_from_pgn(pgn_text)
    termination = extract_termination_from_pgn(pgn_text)

    cursor = conn.execute("""
        INSERT OR IGNORE INTO games (
            id, pgn, url, date, time_control, color, result,
            termination, white_username, black_username,
            white_rating, black_rating, opponent_rating,
            opening_eco, opening_name
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    """, (
        game_id,
        pgn_text,
        g.get("url", ""),
        datetime.fromtimestamp(g["end_time"], tz=timezone.utc).isoformat(),
        str(g.get("time_control", "")),
        color,
        normalized,
        termination,
        white.get("username", ""),
        black.get("username", ""),
        white.get("rating", 0),
        black.get("rating", 0),
        opp_rating,
        eco,
        opening_name,
    ))
    return cursor.rowcount > 0


def sync_all(full: bool = False) -> dict:
    """
    Sync games from Chess.com.
    full=True fetches entire history.
    full=False fetches last 2 months only.
    Returns summary dict.
    """
    conn = get_db()

    with httpx.Client(
        headers=HEADERS,
        follow_redirects=True,
        timeout=HTTP_TIMEOUT,
        limits=HTTP_LIMITS,
    ) as client:
        print(f"Fetching archive list for {CHESS_USERNAME}...")
        urls = get_monthly_archive_urls(client, CHESS_USERNAME)

        if not urls:
            print("No archives found.")
            conn.close()
            return {"inserted": 0, "skipped": 0, "months": 0}

        target_urls = urls if full else urls[-2:]
        print(f"Syncing {len(target_urls)} month(s)...")

        inserted = 0
        skipped = 0

        for url in target_urls:
            try:
                games = fetch_month(client, url)
            except Exception as e:
                print(f"  Failed to fetch {url}: {e}")
                continue

            month_inserted = 0
            for g in games:
                tc = str(g.get("time_control", ""))
                if tc not in RAPID_TCS:
                    continue
                try:
                    was_new = upsert_game(conn, g)
                    if was_new:
                        inserted += 1
                        month_inserted += 1
                    else:
                        skipped += 1
                except Exception as e:
                    print(f"  Error inserting game: {e}")

            conn.commit()
            print(f"  {url.split('/')[-2]}/{url.split('/')[-1]} → {month_inserted} new games")

    conn.close()
    print(f"\nSync complete: {inserted} new, {skipped} already existed")
    return {"inserted": inserted, "skipped": skipped, "months": len(target_urls)}


if __name__ == "__main__":
    sync_all(full=True)
