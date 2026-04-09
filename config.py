from pathlib import Path
import os
from dotenv import load_dotenv

load_dotenv()
CHESS_USERNAME = os.getenv("CHESS_USERNAME", "Tushar9038")

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
