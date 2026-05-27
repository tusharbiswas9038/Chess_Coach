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
ADMIN_USERNAME = os.getenv("ADMIN_USERNAME", "admin")
ADMIN_PASSWORD_HASH = os.getenv("ADMIN_PASSWORD_HASH", "")
SESSION_COOKIE_NAME = os.getenv("SESSION_COOKIE_NAME", "chess_coach_session")
SESSION_TTL_SECONDS = int(os.getenv("SESSION_TTL_SECONDS", str(12 * 60 * 60)))
ALLOWED_HOSTS_RAW = os.getenv("ALLOWED_HOSTS", "")
CORS_ORIGINS_RAW = os.getenv("CORS_ORIGINS", "")

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
RATE_LIMIT_BACKEND = os.getenv("RATE_LIMIT_BACKEND", "sqlite").lower()  # sqlite|memory


def is_production() -> bool:
    return APP_ENV.lower() == "production"


def _csv_env(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


def validate_startup_config() -> None:
    allowed_envs = {"development", "production", "testing"}
    if APP_ENV.lower() not in allowed_envs:
        raise RuntimeError(
            f"APP_ENV must be one of {sorted(allowed_envs)}; got '{APP_ENV}'."
        )

    if is_production():
        if APP_SECRET_KEY == "super-secret-key" or len(APP_SECRET_KEY) < 24:
            raise RuntimeError("APP_SECRET_KEY is weak; set a strong secret for production.")
        if not ADMIN_TOKEN or len(ADMIN_TOKEN) < 24:
            raise RuntimeError(
                "ADMIN_TOKEN is required and must be >=24 chars in production."
            )
        if not ADMIN_PASSWORD_HASH:
            raise RuntimeError(
                "ADMIN_PASSWORD_HASH is required in production. "
                "Generate with: python3 -c \"from api.auth_service import create_password_hash; "
                "import getpass; print(create_password_hash(getpass.getpass('Admin password: ')))\". "
                "The ADMIN_TOKEN-as-password fallback is no longer accepted in production."
            )

    parsed = urlparse(OLLAMA_URL)
    if parsed.scheme not in {"http", "https"}:
        raise RuntimeError("OLLAMA_URL must use http or https.")
    if RATE_LIMIT_BACKEND not in {"sqlite", "memory"}:
        raise RuntimeError("RATE_LIMIT_BACKEND must be 'sqlite' or 'memory'.")
    if SESSION_TTL_SECONDS < 300:
        raise RuntimeError("SESSION_TTL_SECONDS must be at least 300 seconds.")


def get_cors_origins() -> list[str]:
    configured = _csv_env(CORS_ORIGINS_RAW)
    if configured:
        return configured
    if is_production():
        return [
            "https://personalvm.duckdns.org",
        ]
    return [
        "http://localhost:8000",
        "http://127.0.0.1:8000",
        "https://personalvm.duckdns.org",
    ]


def get_allowed_hosts() -> list[str]:
    configured = _csv_env(ALLOWED_HOSTS_RAW)
    if configured:
        return configured
    if is_production():
        return [
            "personalvm.duckdns.org",
        ]
    return [
        "localhost",
        "127.0.0.1",
        "personalvm.duckdns.org",
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
