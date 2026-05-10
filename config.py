from pathlib import Path
import os
from dotenv import load_dotenv
from urllib.parse import urlparse

load_dotenv()
CHESS_USERNAME = os.getenv("CHESS_USERNAME", "Tushar9038")
APP_SECRET_KEY = os.getenv("APP_SECRET_KEY", "super-secret-key") # TODO: Change this to a strong, random key in production!
APP_ENV = os.getenv("APP_ENV", "development") # 'development', 'production', 'testing'
ENABLE_DEBUG_ROUTES = os.getenv("ENABLE_DEBUG_ROUTES", "false").lower() == "true"
ADMIN_TOKEN = os.getenv("ADMIN_TOKEN", "")

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "data" / "chess.db"

CHESS_BASE_URL = "https://api.chess.com/pub"

STOCKFISH_PATH = "/usr/games/stockfish"
STOCKFISH_DEPTH = 18
STOCKFISH_THREADS = 3
STOCKFISH_HASH_MB = 256

OLLAMA_URL = "http://localhost:11434"
OLLAMA_MODEL = "chess-coach"   # 14B — used for interactive chat
OLLAMA_MODEL_FAST = "chess-coach-fast"   # 7B — used for batch reports

APP_HOST = "0.0.0.0"
APP_PORT = 8000
JOB_QUEUE_MAX_SIZE = int(os.getenv("JOB_QUEUE_MAX_SIZE", "100"))
MAX_REQUEST_BODY_BYTES = int(os.getenv("MAX_REQUEST_BODY_BYTES", str(1024 * 1024)))


def is_production() -> bool:
    return APP_ENV.lower() == "production"


def validate_startup_config() -> None:
    if is_production():
        if APP_SECRET_KEY == "super-secret-key" or len(APP_SECRET_KEY) < 24:
            raise RuntimeError("APP_SECRET_KEY is weak; set a strong secret for production.")

    parsed = urlparse(OLLAMA_URL)
    if parsed.scheme not in {"http", "https"}:
        raise RuntimeError("OLLAMA_URL must use http or https.")


def get_cors_origins() -> list[str]:
    if is_production():
        return [
            "https://personalvm.duckdns.org",
        ]
    return [
        "http://localhost:8000",
        "http://127.0.0.1:8000",
        "https://personalvm.duckdns.org",
    ]


def get_csp_header() -> str:
    return (
        "default-src 'self'; "
        "script-src 'self' https://cdn.jsdelivr.net https://personalvm.duckdns.org; "
        "style-src 'self' https://fonts.googleapis.com; "
        "font-src 'self' https://fonts.gstatic.com; "
        "img-src 'self' data:; "
        "connect-src 'self' https://personalvm.duckdns.org https://cdn.jsdelivr.net; "
        "frame-ancestors 'none';"
    )
