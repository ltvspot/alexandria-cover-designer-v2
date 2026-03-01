"""
Configuration — all env vars and constants.
Values are hardcoded as defaults, overridable by environment variables.
"""
import os
from collections import OrderedDict
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
OPENROUTER_MODELS = OrderedDict([
    ("gpt-5-image", {
        "id": "openai/gpt-5-image",
        "openrouter_id": "openai/gpt-5-image",
        "cost_per_image": 0.04,
        "label": "GPT-5 Image",
        "modality": "both",
        "default": False,
    }),
    ("riverflow-v2-pro", {
        "id": "sourceful/riverflow-v2-pro",
        "openrouter_id": "sourceful/riverflow-v2-pro",
        "cost_per_image": 0.15,
        "label": "Riverflow V2 Pro",
        "modality": "image",
        "default": False,
    }),
    ("riverflow-v2-max-preview", {
        "id": "sourceful/riverflow-v2-max-preview",
        "openrouter_id": "sourceful/riverflow-v2-max-preview",
        "cost_per_image": 0.075,
        "label": "Riverflow V2 Max Preview",
        "modality": "image",
        "default": False,
    }),
    ("flux-2-max", {
        "id": "black-forest-labs/flux.2-max",
        "openrouter_id": "black-forest-labs/flux.2-max",
        "cost_per_image": 0.07,
        "label": "FLUX.2 Max",
        "modality": "image",
        "default": False,
    }),
    ("flux-2-flex", {
        "id": "black-forest-labs/flux.2-flex",
        "openrouter_id": "black-forest-labs/flux.2-flex",
        "cost_per_image": 0.06,
        "label": "FLUX.2 Flex",
        "modality": "image",
        "default": False,
    }),
    ("seedream-4.5", {
        "id": "bytedance-seed/seedream-4.5",
        "openrouter_id": "bytedance-seed/seedream-4.5",
        "cost_per_image": 0.04,
        "label": "Seedream 4.5",
        "modality": "image",
        "default": False,
    }),
    ("riverflow-v2-standard-preview", {
        "id": "sourceful/riverflow-v2-standard-preview",
        "openrouter_id": "sourceful/riverflow-v2-standard-preview",
        "cost_per_image": 0.035,
        "label": "Riverflow V2 Standard Preview",
        "modality": "image",
        "default": False,
    }),
    ("flux-2-pro", {
        "id": "black-forest-labs/flux.2-pro",
        "openrouter_id": "black-forest-labs/flux.2-pro",
        "cost_per_image": 0.03,
        "label": "FLUX.2 Pro",
        "modality": "image",
        "default": True,
    }),
    ("riverflow-v2-fast-preview", {
        "id": "sourceful/riverflow-v2-fast-preview",
        "openrouter_id": "sourceful/riverflow-v2-fast-preview",
        "cost_per_image": 0.03,
        "label": "Riverflow V2 Fast Preview",
        "modality": "image",
        "default": False,
    }),
    ("nano-banana-pro", {
        "id": "google/gemini-3-pro-image-preview",
        "openrouter_id": "google/gemini-3-pro-image-preview",
        "cost_per_image": 0.01,
        "label": "Nano Banana Pro",
        "modality": "both",
        "default": True,
    }),
    ("flux-2-klein", {
        "id": "black-forest-labs/flux.2-klein-4b",
        "openrouter_id": "black-forest-labs/flux.2-klein-4b",
        "cost_per_image": 0.014,
        "label": "FLUX.2 Klein",
        "modality": "image",
        "default": False,
    }),
    ("gpt-5-image-mini", {
        "id": "openai/gpt-5-image-mini",
        "openrouter_id": "openai/gpt-5-image-mini",
        "cost_per_image": 0.012,
        "label": "GPT-5 Image Mini",
        "modality": "both",
        "default": True,
    }),
    ("nano-banana-2", {
        "id": "google/gemini-3.1-flash-image-preview",
        "openrouter_id": "google/gemini-3.1-flash-image-preview",
        "cost_per_image": 0.006,
        "label": "Nano Banana 2",
        "modality": "both",
        "default": True,
    }),
    ("riverflow-v2-fast", {
        "id": "sourceful/riverflow-v2-fast",
        "openrouter_id": "sourceful/riverflow-v2-fast",
        "cost_per_image": 0.04,
        "label": "Riverflow V2 Fast",
        "modality": "image",
        "default": False,
    }),
    ("nano-banana", {
        "id": "google/gemini-2.5-flash-image",
        "openrouter_id": "google/gemini-2.5-flash-image",
        "cost_per_image": 0.003,
        "label": "Nano Banana",
        "modality": "both",
        "default": True,
    }),
])

DEFAULT_MODEL = "nano-banana"

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
MAX_CONCURRENT_JOBS = 5
JOB_TIMEOUT_SECONDS = 300    # 5 min per job

# ─── SSE ──────────────────────────────────────────────────────────────────────
SSE_HEARTBEAT_INTERVAL = 15  # seconds

# ─── Server ───────────────────────────────────────────────────────────────────
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8080"))
DEBUG = os.environ.get("DEBUG", "false").lower() == "true"

# ─── Thumbnail ────────────────────────────────────────────────────────────────
THUMBNAIL_SIZE = (400, 293)  # ~10% of source for preview
