"""
Configuration — all env vars and constants.
Values are hardcoded as defaults, overridable by environment variables.
"""
import os
from pathlib import Path

# ─── Paths ───────────────────────────────────────────────────────────────────
BASE_DIR = Path(__file__).parent.parent
DATA_DIR = BASE_DIR / "data"
COVERS_DIR = DATA_DIR / "covers"
OUTPUTS_DIR = DATA_DIR / "outputs"
THUMBNAILS_DIR = DATA_DIR / "thumbnails"
DB_PATH = DATA_DIR / "app.db"

# ─── Google Drive ─────────────────────────────────────────────────────────────
GOOGLE_API_KEY = os.environ.get(
    "GOOGLE_API_KEY",
    "AIzaSyAY6XvPxrdS_fMNMZEUkJd7UW9b9yuJDgI",
)
DRIVE_SOURCE_FOLDER_ID = os.environ.get(
    "DRIVE_SOURCE_FOLDER_ID",
    "1ybFYDJk7Y3VlbsEjRAh1LOfdyVsHM_cS",
)
DRIVE_OUTPUT_FOLDER_ID = os.environ.get(
    "DRIVE_OUTPUT_FOLDER_ID",
    "1Vr184ZsX3k38xpmZkd8g2vwB5y9LYMRC",
)
DRIVE_API_BASE = "https://www.googleapis.com/drive/v3"

# ─── OpenRouter ───────────────────────────────────────────────────────────────
OPENROUTER_API_KEY = os.environ.get(
    "OPENROUTER_API_KEY",
    "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",
)
OPENROUTER_API_BASE = "https://openrouter.ai/api/v1"

# ─── Models + Costs ──────────────────────────────────────────────────────────
OPENROUTER_MODELS = {
    "gemini-2.5-flash-image": {
        "id": "google/gemini-2.5-flash-preview-05-20",
        "openrouter_id": "google/gemini-2.5-flash-preview-05-20",
        "cost_per_image": 0.003,
        "label": "Gemini 2.5 Flash Image",
        "best_for": "Cheap smoke tests",
        "default": True,
    },
    "gemini-3-pro-image-preview": {
        "id": "google/gemini-3-pro-image-preview",
        "openrouter_id": "google/gemini-3-pro-image-preview",
        "cost_per_image": 0.01,
        "label": "Gemini 3 Pro Image Preview",
        "best_for": "Good balance",
        "default": True,
    },
    "gpt-5-image-mini": {
        "id": "openai/gpt-5-image-mini",
        "openrouter_id": "openai/gpt-5-image-mini",
        "cost_per_image": 0.012,
        "label": "GPT-5 Image Mini",
        "best_for": "Conceptual compositions",
        "default": True,
    },
    "gpt-5-image": {
        "id": "openai/gpt-5-image",
        "openrouter_id": "openai/gpt-5-image",
        "cost_per_image": 0.04,
        "label": "GPT-5 Image",
        "best_for": "Premium quality",
        "default": False,
    },
}

DEFAULT_MODEL = "gemini-2.5-flash-image"

# ─── Budget ───────────────────────────────────────────────────────────────────
BUDGET_LIMIT_USD = float(os.environ.get("BUDGET_LIMIT_USD", "200.0"))

# ─── Compositing ─────────────────────────────────────────────────────────────
# Source covers are landscape wraparound (3784×2777):
#   left = back cover, center = spine, right = front cover
# Medallion: approximately centered on the front panel
COVER_WIDTH = 3784
COVER_HEIGHT = 2777
COVER_DPI = 300

MEDALLION_CENTER_X = int(os.environ.get("MEDALLION_CENTER_X", "2850"))
MEDALLION_CENTER_Y = int(os.environ.get("MEDALLION_CENTER_Y", "1350"))
MEDALLION_RADIUS = int(os.environ.get("MEDALLION_RADIUS", "520"))
MEDALLION_FEATHER = 15  # px Gaussian blur on mask edge

# ─── Job Worker ───────────────────────────────────────────────────────────────
WORKER_POLL_INTERVAL = 1.0   # seconds between queue polls
MAX_CONCURRENT_JOBS = 2
JOB_TIMEOUT_SECONDS = 300    # 5 min per job

# ─── SSE ──────────────────────────────────────────────────────────────────────
SSE_HEARTBEAT_INTERVAL = 15  # seconds

# ─── Server ───────────────────────────────────────────────────────────────────
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8080"))
DEBUG = os.environ.get("DEBUG", "false").lower() == "true"

# ─── Thumbnail ────────────────────────────────────────────────────────────────
THUMBNAIL_SIZE = (400, 293)  # ~10% of source for preview
