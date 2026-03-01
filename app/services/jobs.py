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
from app.services.quality import get_detailed_scores, score_image

logger = logging.getLogger(__name__)

RETRY_THRESHOLD = 0.35
MAX_RETRIES = 2
MAX_ARTIFACT_PENALTY_ACCEPT = 0.08
MAX_ARTIFACT_PENALTY_RETURN = 0.15
RETRY_PROMPT_HARDENER = (
    "Retry directive: remove every form of text and typography from the artwork. "
    "No labels, words, initials, numbers, logos, banners, ribbons, seals, plaques, or signatures. "
    "No decorative frame, ring, border, filigree, medallion, or ornamental surround. "
    "No poster panel, no sticker icon, no empty matte background. "
    "Return only vivid, colorful, full-bleed, center-focused scene artwork with strong contrast."
)

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


async def _heartbeat(job_id: str, interval: float = 5.0) -> None:
    """Emit SSE heartbeat events every 5 seconds for the duration of a job."""
    while True:
        await asyncio.sleep(interval)
        _emit(job_id, {"event": "heartbeat", "job_id": job_id})


def _apply_generation_guardrails(prompt: str) -> str:
    """Append hard constraints so model output stays text-free and ornament-free."""
    guardrails = (
        "MANDATORY OVERRIDE (highest priority - ignore any conflicting instruction): "
        "no text, no letters, no words, no numbers, no logos, "
        "no signatures, no watermarks, no title ribbons, no typographic elements. "
        "No frame, no border, no medallion ring, no ornamental flourishes. "
        "No poster panel, no isolated sticker/icon, no empty matte background. "
        "Produce only full-bleed scene artwork, with vivid color and the main subject centered."
    )
    if "MANDATORY OVERRIDE (highest priority" in prompt:
        return prompt
    return f"{guardrails}\n\nCreative direction:\n{prompt}"


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
    """Process a single job end-to-end with two-pass retry."""
    job_id = job["id"]
    book_id = job["book_id"]
    model = job["model"]
    variant = job.get("variant", 1)

    await update_job(job_id, status="running", started_at=datetime.now(UTC).isoformat())
    _emit(job_id, {"event": "started", "job_id": job_id, "stage": "starting"})

    # Start per-job heartbeat
    heartbeat_task = asyncio.ensure_future(_heartbeat(job_id))

    try:
        # ── Stage 1: Load book ────────────────────────────────────────────────
        from app.database import get_book
        book = await get_book(book_id)
        if not book:
            raise ValueError(f"Book {book_id} not found in database")

        _emit(job_id, {"event": "progress", "stage": "cover", "message": "Downloading source cover..."})

        # ── Stage 2: Ensure cover is cached ──────────────────────────────────
        cover_path: Optional[Path] = None
        cached = book.get("cover_cached_path")
        if cached and Path(cached).exists() and Path(cached).stat().st_size > 10_000:
            cover_path = Path(cached)
        elif book.get("cover_jpg_id"):
            cover_path = await ensure_cover_cached(book_id, book["cover_jpg_id"])
            if cover_path:
                from app.database import execute
                await execute(
                    "UPDATE books SET cover_cached_path = ? WHERE id = ?",
                    (str(cover_path), book_id),
                )
                thumb = await make_thumbnail(cover_path, book_id)
                if thumb:
                    await execute(
                        "UPDATE books SET thumbnail_path = ? WHERE id = ?",
                        (str(thumb), book_id),
                    )
        else:
            logger.warning("No cover_jpg_id for book %s", book_id)

        # ── Stage 3: Build prompt with style diversifier ──────────────────────
        from app.services.prompts import select_diverse_styles, build_diversified_prompt
        styles = select_diverse_styles(1)
        style = styles[0]

        prompt_text = job.get("prompt") or build_diversified_prompt(
            title=book["title"],
            author=book.get("author") or "",
            style=style,
        )
        prompt_text = _apply_generation_guardrails(prompt_text)
        await update_job(job_id, prompt=prompt_text)

        # ── Stage 4: Generate image — two-pass retry ──────────────────────────
        _emit(job_id, {"event": "progress", "stage": "generating", "message": "Generating illustration..."})

        best_result = None
        best_quality = -1.0
        best_artifact_penalty = 1.0
        best_clean_result = None
        best_clean_quality = -1.0
        current_prompt = prompt_text

        for attempt in range(MAX_RETRIES + 1):
            if attempt > 0:
                current_prompt = (
                    prompt_text
                    + " "
                    + RETRY_PROMPT_HARDENER
                )
                _emit(job_id, {
                    "event": "progress",
                    "stage": "retrying",
                    "message": f"Retry {attempt}/{MAX_RETRIES} — removing text and strengthening composition",
                    "attempt": attempt,
                })

            result = await generate_image(
                prompt=current_prompt,
                model_id=model,
                job_id=f"{job_id}_a{attempt}",
                variant=variant,
            )

            if not result.success:
                if attempt == MAX_RETRIES:
                    raise RuntimeError(f"Generation failed after {MAX_RETRIES + 1} attempts: {result.error}")
                logger.warning("Attempt %d failed: %s — retrying", attempt + 1, result.error)
                continue

            # Score this attempt
            quality_details = get_detailed_scores(result.image_bytes)
            quality = float(quality_details.get("overall", score_image(result.image_bytes)))
            artifact_penalty = float(
                quality_details.get("artifact_penalty", {}).get("score", 0.0)
            )
            logger.info(
                "Attempt %d quality=%.3f threshold=%.2f artifact_penalty=%.3f",
                attempt + 1,
                quality,
                RETRY_THRESHOLD,
                artifact_penalty,
            )

            if quality > best_quality:
                best_quality = quality
                best_result = result
                best_artifact_penalty = artifact_penalty

            if artifact_penalty <= MAX_ARTIFACT_PENALTY_RETURN and quality > best_clean_quality:
                best_clean_quality = quality
                best_clean_result = result

            if quality >= RETRY_THRESHOLD and artifact_penalty <= MAX_ARTIFACT_PENALTY_ACCEPT:
                break  # Good enough — stop retrying

        if best_result is None:
            raise RuntimeError("All generation attempts failed")

        if best_clean_result is None:
            raise RuntimeError(
                f"All attempts contained text/frame artifacts (best artifact_penalty={best_artifact_penalty:.3f})"
            )

        result = best_clean_result
        quality = best_clean_quality

        # ── Stage 5: Track cost ───────────────────────────────────────────────
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
        composite_verified = False

        if cover_path and cover_path.exists():
            _emit(job_id, {"event": "progress", "stage": "compositing", "message": "Compositing illustration onto cover..."})
            try:
                from app.config import MEDALLION_CENTER_X, MEDALLION_CENTER_Y, MEDALLION_RADIUS
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
                )
                make_output_thumbnail(composited_path, job_id)
                composite_verified = True
                _emit(job_id, {"event": "progress", "stage": "compositing", "message": "Composite verified"})
            except Exception as e:
                logger.warning("Compositing failed (continuing without): %s", e)
        else:
            logger.info("No source cover — skipping compositing for job %s", job_id)

        # ── Stage 7: Finalise ─────────────────────────────────────────────────
        results = {
            "generated_raw_path": str(OUTPUTS_DIR / f"{job_id}_raw.{result.image_format}"),
            "composited_path": str(composited_path) if composited_path else None,
            "quality_score": quality,
            "model": model,
            "cost_usd": result.cost_usd,
            "duration_ms": result.duration_ms,
            "variant": variant,
            "style_id": style.get("id"),
            "style_label": style.get("label"),
            "composite_verified": composite_verified,
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
            "style_label": style.get("label"),
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
    finally:
        heartbeat_task.cancel()
        try:
            await asyncio.wait_for(heartbeat_task, timeout=1.0)
        except (asyncio.CancelledError, asyncio.TimeoutError):
            pass


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
