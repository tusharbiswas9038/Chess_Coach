# api/db.py
import sqlite3
import sys
from pathlib import Path
from contextlib import contextmanager
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from config import DB_PATH


def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH), timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


@contextmanager
def db_conn():
    conn = get_db()
    try:
        yield conn
    finally:
        conn.close()
