"""
FastAPI application — startup, middleware, route mounting.
"""
import asyncio
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

from app.config import BASE_DIR, COVERS_DIR, DATA_DIR, OUTPUTS_DIR, THUMBNAILS_DIR, OVERLAYS_DIR, TEMPLATES_DIR, DEBUG
from app.database import init_db
from app.routes.pages import router as pages_router
from app.routes.api import router as api_router
from app.routes.events import router as events_router
from app.services.jobs import worker_loop
from app.services.drive import sync_catalog

logging.basicConfig(
    level=logging.DEBUG if DEBUG else logging.INFO,
    format="%(asctime)s %(levelname)-8s %(name)s — %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)


# ─── Ensure data directories exist ──────────────────────────────────────────
for _d in (DATA_DIR, COVERS_DIR, OUTPUTS_DIR, THUMBNAILS_DIR, OVERLAYS_DIR, TEMPLATES_DIR):
    _d.mkdir(parents=True, exist_ok=True)


# ─── Lifespan ────────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    # ── Startup ───────────────────────────────────────────────────────────────
    logger.info("Starting Alexandria Cover Designer v2")

    # Init database
    await init_db()
    logger.info("Database ready")

    # Background catalog sync (best-effort, non-blocking)
    async def _catalog_sync():
        try:
            books = await sync_catalog()
            logger.info("Catalog sync: %d books", len(books))
        except Exception as e:
            logger.warning("Catalog sync failed (Drive may be unavailable): %s", e)

    asyncio.ensure_future(_catalog_sync())

    # Start inline job worker
    worker_task = asyncio.ensure_future(worker_loop())
    logger.info("Worker started")

    yield

    # ── Shutdown ──────────────────────────────────────────────────────────────
    worker_task.cancel()
    try:
        await asyncio.wait_for(worker_task, timeout=5)
    except (asyncio.CancelledError, asyncio.TimeoutError):
        pass
    logger.info("Shutdown complete")


# ─── App ─────────────────────────────────────────────────────────────────────
app = FastAPI(
    title="Alexandria Cover Designer v2",
    description="AI-powered book cover illustration tool",
    version="2.0.0",
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url="/redoc",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Static files ─────────────────────────────────────────────────────────────
STATIC_DIR = BASE_DIR / "app" / "static"
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

# ─── Routes ───────────────────────────────────────────────────────────────────
app.include_router(pages_router)
app.include_router(api_router)
app.include_router(events_router)
