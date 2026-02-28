"""
Job queue and inline asyncio worker.

Jobs flow: queued → running → completed | failed | cancelled

The worker runs as a background task in the same process.
SSE clients subscribe via job_id; events are pushed via asyncio.Queue.
"""
import asyncio
import json
import logging
import uuid
from datetime import datetime, timezone
UTC = timezone.utc
from pathlib import Path
from typing import Any, Dict, List, Optional

from app.config import (
    MAX_CONCURRENT_JOBS,
    OUTPUTS_DIR,
    WORKER_POLL_INTERVAL,
)
from app.database import (
    create_job,
    get_job,
    get_jobs,
    get_queued_jobs,
    recover_stale_jobs,
    update_job,
)
from app.services.cost_tracker import track_cost
from app.services.drive import ensure_cover_cached, make_thumbnail
from app.services.generator import generate_image
from app.services.compositor import composite, make_output_thumbnail
from app.services.prompts import build_prompt
from app.services.quality import score_image

logger = logging.getLogger(__name__)

# ─── SSE event bus ─────────────────────────────────────────────────────────────
# job_id → list of asyncio.Queue for SSE subscribers
_subscribers: Dict[str, List[asyncio.Queue]] = {}


def subscribe_job(job_id: str) -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue(maxsize=100)
    _subscribers.setdefault(job_id, []).append(q)
    return q


def unsubscribe_job(job_id: str, q: asyncio.Queue) -> None:
    if job_id in _subscribers:
        try:
            _subscribers[job_id].remove(q)
        except ValueError:
            pass
        if not _subscribers[job_id]:
            del _subscribers[job_id]


def _emit(job_id: str, event: Dict[str, Any]) -> None:
    """Send event to all SSE subscribers for this job (fire-and-forget)."""
    for q in _subscribers.get(job_id, []):
        try:
            q.put_nowait(event)
        except asyncio.QueueFull:
            pass


# ─── Job creation ─────────────────────────────────────────────────────────────

async def queue_job(
    book_id: str,
    model: str,
    variant: int = 1,
    prompt: Optional[str] = None,
) -> str:
    """Create and enqueue a new generation job. Returns job_id."""
    job_id = str(uuid.uuid4())
    await create_job({
        "id": job_id,
        "book_id": book_id,
        "model": model,
        "variant": variant,
        "prompt": prompt,
        "status": "queued",
    })
    logger.info("Job queued: %s (book=%s model=%s v=%d)", job_id, book_id, model, variant)
    return job_id


async def cancel_job(job_id: str) -> bool:
    job = await get_job(job_id)
    if not job:
        return False
    if job["status"] in ("queued",):
        await update_job(job_id, status="cancelled", completed_at=datetime.now(UTC).isoformat())
        _emit(job_id, {"event": "cancelled", "job_id": job_id})
        return True
    return False


# ─── Worker ───────────────────────────────────────────────────────────────────

async def _process_job(job: Dict[str, Any]) -> None:
    """Process a single job end-to-end."""
    job_id = job["id"]
    book_id = job["book_id"]
    model = job["model"]
    variant = job.get("variant", 1)

    await update_job(job_id, status="running", started_at=datetime.now(UTC).isoformat())
    _emit(job_id, {"event": "started", "job_id": job_id, "stage": "starting"})

    try:
        # ── Stage 1: Load book info ────────────────────────────────────────────
        from app.database import get_book
        book = await get_book(book_id)
        if not book:
            raise ValueError(f"Book {book_id} not found in database")

        _emit(job_id, {"event": "progress", "stage": "downloading", "message": "Downloading source cover..."})

        # ── Stage 2: Ensure cover is cached ───────────────────────────────────
        cover_path: Optional[Path] = None
        cached = book.get("cover_cached_path")
        if cached and Path(cached).exists() and Path(cached).stat().st_size > 10_000:
            cover_path = Path(cached)
        elif book.get("cover_jpg_id"):
            cover_path = await ensure_cover_cached(book_id, book["cover_jpg_id"])
            if cover_path:
                await update_job(job_id)  # no-op update just to refresh
                from app.database import execute
                await execute(
                    "UPDATE books SET cover_cached_path = ? WHERE id = ?",
                    (str(cover_path), book_id),
                )
                # Also make thumbnail
                thumb = await make_thumbnail(cover_path, book_id)
                if thumb:
                    await execute(
                        "UPDATE books SET thumbnail_path = ? WHERE id = ?",
                        (str(thumb), book_id),
                    )
        else:
            logger.warning("No cover_jpg_id for book %s — skipping Drive download", book_id)

        # ── Stage 3: Build prompt ─────────────────────────────────────────────
        _emit(job_id, {"event": "progress", "stage": "generating", "message": "Generating illustration..."})

        prompt_text = job.get("prompt") or build_prompt(
            title=book["title"],
            author=book.get("author") or "",
            variant=variant,
        )
        await update_job(job_id, prompt=prompt_text)

        # ── Stage 4: Generate image ────────────────────────────────────────────
        result = await generate_image(
            prompt=prompt_text,
            model_id=model,
            job_id=job_id,
            variant=variant,
        )

        if not result.success:
            raise RuntimeError(f"Generation failed: {result.error}")

        # ── Stage 5: Track cost ────────────────────────────────────────────────
        await track_cost(
            model=model,
            cost_usd=result.cost_usd,
            job_id=job_id,
            book_id=book_id,
            tokens_in=result.tokens_in,
            tokens_out=result.tokens_out,
            duration_ms=result.duration_ms,
        )
        await update_job(job_id, cost_usd=result.cost_usd)

        # ── Stage 6: Composite ────────────────────────────────────────────────
        composited_path: Optional[Path] = None
        if cover_path and cover_path.exists():
            _emit(job_id, {"event": "progress", "stage": "compositing", "message": "Compositing illustration onto cover..."})
            try:
                # Get medallion config (book-specific or defaults)
                from app.config import MEDALLION_CENTER_X, MEDALLION_CENTER_Y, MEDALLION_RADIUS, MEDALLION_FEATHER
                from app.database import fetchone
                med = await fetchone(
                    "SELECT * FROM medallion_config WHERE book_id = ?", (book_id,)
                )
                cx = med["center_x"] if med else MEDALLION_CENTER_X
                cy = med["center_y"] if med else MEDALLION_CENTER_Y
                r  = med["radius"]   if med else MEDALLION_RADIUS

                composited_path = composite(
                    cover_path=cover_path,
                    generated_image_bytes=result.image_bytes,
                    job_id=job_id,
                    center_x=cx,
                    center_y=cy,
                    radius=r,
                    feather=MEDALLION_FEATHER,
                )
                # Make thumbnail
                make_output_thumbnail(composited_path, job_id)
            except Exception as e:
                logger.warning("Compositing failed (continuing without): %s", e)
        else:
            logger.info("No source cover available — skipping compositing for job %s", job_id)

        # ── Stage 7: Quality score ────────────────────────────────────────────
        _emit(job_id, {"event": "progress", "stage": "scoring", "message": "Scoring quality..."})
        quality = score_image(result.image_bytes)

        # ── Stage 8: Finalise ─────────────────────────────────────────────────
        results = {
            "generated_raw_path": str(OUTPUTS_DIR / f"{job_id}_raw.{result.image_format}"),
            "composited_path": str(composited_path) if composited_path else None,
            "quality_score": quality,
            "model": model,
            "cost_usd": result.cost_usd,
            "duration_ms": result.duration_ms,
            "variant": variant,
        }
        await update_job(
            job_id,
            status="completed",
            completed_at=datetime.now(UTC).isoformat(),
            quality_score=quality,
            composited_image_path=str(composited_path) if composited_path else None,
            results_json=json.dumps(results),
        )
        _emit(job_id, {
            "event": "completed",
            "job_id": job_id,
            "quality_score": quality,
            "cost_usd": result.cost_usd,
            "composited": composited_path is not None,
        })
        logger.info("Job %s completed (quality=%.3f, cost=$%.4f)", job_id, quality, result.cost_usd)

    except Exception as e:
        logger.exception("Job %s failed: %s", job_id, e)
        await update_job(
            job_id,
            status="failed",
            error=str(e),
            completed_at=datetime.now(UTC).isoformat(),
        )
        _emit(job_id, {"event": "failed", "job_id": job_id, "error": str(e)})


# Semaphore to limit concurrency
_semaphore: Optional[asyncio.Semaphore] = None


async def worker_loop() -> None:
    """Infinite loop that picks up queued jobs and processes them."""
    global _semaphore
    _semaphore = asyncio.Semaphore(MAX_CONCURRENT_JOBS)

    # Recover stale jobs from previous crash
    recovered = await recover_stale_jobs()
    if recovered:
        logger.info("Recovered %d stale jobs", recovered)

    logger.info("Job worker started (max_concurrent=%d)", MAX_CONCURRENT_JOBS)

    while True:
        try:
            jobs = await get_queued_jobs()
            for job in jobs:
                # Check if we have capacity
                if _semaphore._value > 0:
                    asyncio.ensure_future(_run_with_semaphore(job))
                else:
                    break
        except Exception as e:
            logger.error("Worker loop error: %s", e)

        await asyncio.sleep(WORKER_POLL_INTERVAL)


async def _run_with_semaphore(job: Dict[str, Any]) -> None:
    async with _semaphore:
        await _process_job(job)
