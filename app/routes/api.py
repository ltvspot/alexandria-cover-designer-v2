"""
REST API routes.
"""
import csv
import io
import json
import logging
from datetime import datetime, timezone
UTC = timezone.utc
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from app.config import COVERS_DIR, OUTPUTS_DIR, THUMBNAILS_DIR, OPENROUTER_MODELS
from app.database import (
    get_all_books, get_book, get_jobs, get_job,
    get_all_winners, get_winner, save_winner,
    get_all_prompts, get_prompt, create_prompt, update_prompt, delete_prompt,
    get_batch_jobs, get_batch_job, create_batch_job, update_batch_job,
    get_cost_summary, get_all_settings, get_setting, set_setting,
    fetchall, fetchone, execute,
)
from app.services.catalog import list_books
from app.services.cost_tracker import get_budget_status
from app.services.jobs import cancel_job, queue_job

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api")


# ─── Health ───────────────────────────────────────────────────────────────────

@router.get("/health")
async def health():
    return {"status": "ok", "service": "alexandria-cover-designer-v2"}


# ─── Books ────────────────────────────────────────────────────────────────────

@router.get("/books")
async def books_list():
    books = await list_books()
    # Enrich with has_cover flag
    for b in books:
        cached = b.get("cover_cached_path")
        b["has_cover"] = bool(cached and Path(cached).exists())
        b["has_thumbnail"] = bool(b.get("thumbnail_path") and Path(b["thumbnail_path"]).exists())
    return books


@router.get("/books/{book_id}")
async def book_detail(book_id: str):
    book = await get_book(book_id)
    if not book:
        raise HTTPException(status_code=404, detail="Book not found")
    return book


@router.get("/books/{book_id}/cover-preview")
async def cover_preview(book_id: str):
    """Return the thumbnail of the source cover."""
    book = await get_book(book_id)
    if not book:
        raise HTTPException(status_code=404, detail="Book not found")

    thumb_path = book.get("thumbnail_path")
    if thumb_path and Path(thumb_path).exists():
        return FileResponse(thumb_path, media_type="image/jpeg")

    # Try generating thumbnail on the fly if cover is cached
    cached = book.get("cover_cached_path")
    if cached and Path(cached).exists():
        from app.services.drive import make_thumbnail
        thumb = await make_thumbnail(Path(cached), book_id)
        if thumb:
            await execute(
                "UPDATE books SET thumbnail_path = ? WHERE id = ?",
                (str(thumb), book_id),
            )
            return FileResponse(str(thumb), media_type="image/jpeg")

    raise HTTPException(status_code=404, detail="Cover preview not available")


class BookUpdateRequest(BaseModel):
    title: Optional[str] = None
    author: Optional[str] = None
    genre: Optional[str] = None
    themes: Optional[str] = None
    era: Optional[str] = None


@router.put("/books/{book_id}")
async def book_update(book_id: str, req: BookUpdateRequest):
    book = await get_book(book_id)
    if not book:
        raise HTTPException(status_code=404, detail="Book not found")
    updates = {k: v for k, v in req.dict().items() if v is not None}
    if updates:
        sets = ", ".join(f"{k} = ?" for k in updates)
        await execute(
            f"UPDATE books SET {sets} WHERE id = ?",
            tuple(updates.values()) + (book_id,)
        )
    return {"updated": True, "book_id": book_id}


# ─── Generation ───────────────────────────────────────────────────────────────

class GenerateRequest(BaseModel):
    book_id: str
    models: List[str] = Field(default_factory=lambda: ["gemini-2.5-flash-image"])
    variants: List[int] = Field(default_factory=lambda: [1])
    prompt: Optional[str] = None

    class Config:
        json_schema_extra = {
            "example": {
                "book_id": "some-drive-folder-id",
                "models": ["gemini-2.5-flash-image"],
                "variants": [1, 2, 3],
            }
        }


@router.post("/generate")
async def generate(req: GenerateRequest):
    """Queue one job per (model, variant) combination."""
    book = await get_book(req.book_id)
    if not book:
        raise HTTPException(status_code=404, detail="Book not found")

    job_ids = []
    for model in req.models:
        for variant in req.variants:
            jid = await queue_job(
                book_id=req.book_id,
                model=model,
                variant=variant,
                prompt=req.prompt,
            )
            job_ids.append(jid)

    return {"job_ids": job_ids, "count": len(job_ids)}


# ─── Jobs ─────────────────────────────────────────────────────────────────────

@router.get("/jobs")
async def jobs_list(
    limit: int = Query(50, ge=1, le=500),
    status: Optional[str] = Query(None),
    book_id: Optional[str] = Query(None),
):
    if status or book_id:
        conditions = []
        params = []
        if status:
            conditions.append("status = ?")
            params.append(status)
        if book_id:
            conditions.append("book_id = ?")
            params.append(book_id)
        where = "WHERE " + " AND ".join(conditions)
        return await fetchall(
            f"SELECT * FROM jobs {where} ORDER BY created_at DESC LIMIT ?",
            tuple(params) + (limit,)
        )
    return await get_jobs(limit=limit)


@router.get("/jobs/{job_id}")
async def job_detail(job_id: str):
    job = await get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@router.post("/jobs/{job_id}/cancel")
async def job_cancel(job_id: str):
    ok = await cancel_job(job_id)
    if not ok:
        raise HTTPException(
            status_code=400,
            detail="Job cannot be cancelled (not in queued state or not found)",
        )
    return {"cancelled": True, "job_id": job_id}


@router.post("/jobs/{job_id}/retry")
async def job_retry(job_id: str):
    job = await get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job["status"] not in ("failed", "cancelled"):
        raise HTTPException(status_code=400, detail="Only failed/cancelled jobs can be retried")
    from datetime import datetime
    await execute(
        "UPDATE jobs SET status='queued', started_at=NULL, completed_at=NULL, error=NULL WHERE id=?",
        (job_id,)
    )
    return {"retried": True, "job_id": job_id}


@router.get("/jobs/{job_id}/result-image")
async def job_result_image(job_id: str):
    """Return the composited cover image for a completed job."""
    job = await get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job["status"] != "completed":
        raise HTTPException(status_code=400, detail="Job not completed")

    path = job.get("composited_image_path") or job.get("generated_image_path")
    # Try to derive path if not stored
    if not path:
        results = json.loads(job.get("results_json") or "{}")
        path = results.get("composited_path") or results.get("generated_raw_path")

    if path and Path(path).exists():
        return FileResponse(path, media_type="image/jpeg")

    # Fallback: find raw generated file
    for ext in ("jpg", "jpeg", "png", "webp"):
        p = OUTPUTS_DIR / f"{job_id}_raw.{ext}"
        if p.exists():
            return FileResponse(str(p), media_type="image/jpeg" if ext in ("jpg", "jpeg") else "image/png")

    raise HTTPException(status_code=404, detail="Result image not found")


@router.get("/jobs/{job_id}/result-thumbnail")
async def job_result_thumbnail(job_id: str):
    """Return the thumbnail of the composited cover."""
    thumb = THUMBNAILS_DIR / f"{job_id}_result_thumb.jpg"
    if thumb.exists():
        return FileResponse(str(thumb), media_type="image/jpeg")
    # Fall back to full result
    return await job_result_image(job_id)


# ─── Models ───────────────────────────────────────────────────────────────────

@router.get("/models")
async def models_list():
    return [
        {
            "id": key,
            "label": v["label"],
            "cost_per_image": v["cost_per_image"],
            "default": v.get("default", False),
        }
        for key, v in OPENROUTER_MODELS.items()
    ]


# ─── Analytics ────────────────────────────────────────────────────────────────

@router.get("/analytics/costs")
async def costs_summary():
    return await get_cost_summary()


@router.get("/analytics/budget")
async def budget_status():
    return await get_budget_status()


@router.get("/analytics/dashboard")
async def dashboard_stats():
    """Aggregated stats for the dashboard KPI cards."""
    cost_data = await get_cost_summary()
    budget = await get_budget_status()

    books = await fetchall("SELECT COUNT(*) as cnt FROM books")
    books_count = books[0]["cnt"] if books else 0

    completed = await fetchall(
        "SELECT COUNT(*) as cnt, AVG(quality_score) as avg_q FROM jobs WHERE status='completed'"
    )
    completed_count = completed[0]["cnt"] if completed else 0
    avg_quality = completed[0]["avg_q"] if completed else 0

    images = await fetchall("SELECT COUNT(*) as cnt FROM jobs WHERE status='completed'")
    total_images = images[0]["cnt"] if images else 0

    winners = await fetchall("SELECT COUNT(*) as cnt FROM winner_selections")
    approved = winners[0]["cnt"] if winners else 0

    return {
        "total_spent": cost_data.get("total_all_time") or 0.0,
        "today_spent": cost_data.get("today") or 0.0,
        "budget_remaining": budget.get("remaining", 0),
        "budget_limit": budget.get("limit", 0),
        "books_generated": completed_count,
        "total_books": books_count,
        "avg_quality": avg_quality or 0,
        "total_images": total_images,
        "approved_count": approved,
    }


@router.get("/analytics/costs/timeline")
async def costs_timeline(days: int = Query(30, ge=7, le=365)):
    """Cost over time data for line chart."""
    rows = await fetchall(
        """
        SELECT date(recorded_at) as day, SUM(cost_usd) as total_cost, COUNT(*) as count
        FROM cost_ledger
        WHERE recorded_at >= date('now', ?)
        GROUP BY date(recorded_at)
        ORDER BY day ASC
        """,
        (f"-{days} days",)
    )
    return rows


@router.get("/analytics/costs/by-model")
async def costs_by_model():
    """Cost by model for pie chart."""
    return await fetchall(
        """
        SELECT model, SUM(cost_usd) as total_cost, COUNT(*) as count,
               AVG(cost_usd) as avg_cost
        FROM cost_ledger
        GROUP BY model
        ORDER BY total_cost DESC
        """
    )


@router.get("/analytics/quality/distribution")
async def quality_distribution():
    """Quality histogram data."""
    rows = await fetchall(
        """
        SELECT
            CASE
                WHEN quality_score < 0.2 THEN '0-20%'
                WHEN quality_score < 0.4 THEN '20-40%'
                WHEN quality_score < 0.6 THEN '40-60%'
                WHEN quality_score < 0.8 THEN '60-80%'
                ELSE '80-100%'
            END as bucket,
            COUNT(*) as count
        FROM jobs
        WHERE status='completed' AND quality_score IS NOT NULL
        GROUP BY bucket
        ORDER BY bucket
        """
    )
    return rows


@router.get("/analytics/models/compare")
async def models_compare():
    """Model performance comparison."""
    return await fetchall(
        """
        SELECT
            j.model,
            COUNT(*) as total_jobs,
            SUM(CASE WHEN j.status='completed' THEN 1 ELSE 0 END) as completed,
            SUM(CASE WHEN j.status='failed' THEN 1 ELSE 0 END) as failed,
            AVG(CASE WHEN j.status='completed' THEN j.quality_score END) as avg_quality,
            AVG(j.cost_usd) as avg_cost,
            AVG(CASE WHEN j.started_at IS NOT NULL AND j.completed_at IS NOT NULL
                THEN (julianday(j.completed_at) - julianday(j.started_at)) * 86400000
                END) as avg_duration_ms,
            SUM(j.cost_usd) as total_cost
        FROM jobs j
        WHERE j.status IN ('completed', 'failed')
        GROUP BY j.model
        ORDER BY avg_quality DESC NULLS LAST
        """
    )


# ─── History ──────────────────────────────────────────────────────────────────

@router.get("/history")
async def history(
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    book_id: Optional[str] = Query(None),
    model: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    q_min: Optional[float] = Query(None),
    q_max: Optional[float] = Query(None),
):
    conditions = []
    params: list = []

    if book_id:
        conditions.append("j.book_id = ?")
        params.append(book_id)
    if model:
        conditions.append("j.model = ?")
        params.append(model)
    if status:
        conditions.append("j.status = ?")
        params.append(status)
    if date_from:
        conditions.append("date(j.created_at) >= ?")
        params.append(date_from)
    if date_to:
        conditions.append("date(j.created_at) <= ?")
        params.append(date_to)
    if q_min is not None:
        conditions.append("j.quality_score >= ?")
        params.append(q_min)
    if q_max is not None:
        conditions.append("j.quality_score <= ?")
        params.append(q_max)

    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
    rows = await fetchall(
        f"""
        SELECT j.*, b.title as book_title, b.author as book_author
        FROM jobs j
        LEFT JOIN books b ON j.book_id = b.id
        {where}
        ORDER BY j.created_at DESC
        LIMIT ? OFFSET ?
        """,
        tuple(params) + (limit, offset)
    )

    # Count
    count_rows = await fetchall(
        f"SELECT COUNT(*) as cnt FROM jobs j LEFT JOIN books b ON j.book_id = b.id {where}",
        tuple(params)
    )
    total = count_rows[0]["cnt"] if count_rows else 0

    return {"items": rows, "total": total, "limit": limit, "offset": offset}


@router.get("/history/export")
async def history_export():
    """Export all job history as CSV."""
    rows = await fetchall(
        """
        SELECT j.id, b.title as book_title, b.author as book_author,
               j.model, j.variant, j.status, j.quality_score,
               j.cost_usd, j.created_at, j.started_at, j.completed_at, j.error
        FROM jobs j
        LEFT JOIN books b ON j.book_id = b.id
        ORDER BY j.created_at DESC
        """
    )
    output = io.StringIO()
    if rows:
        writer = csv.DictWriter(output, fieldnames=rows[0].keys())
        writer.writeheader()
        writer.writerows(rows)
    output.seek(0)
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=history.csv"}
    )


# ─── Review ───────────────────────────────────────────────────────────────────

@router.get("/review-data")
async def review_data(filter: str = Query("all")):
    """Books with their completed job variants for review."""
    books = await get_all_books()
    result = []
    for book in books:
        jobs = await fetchall(
            "SELECT * FROM jobs WHERE book_id=? AND status='completed' ORDER BY created_at DESC",
            (book["id"],)
        )
        winner = await get_winner(book["id"])
        book_data = dict(book)
        book_data["variants"] = jobs
        book_data["winner_job_id"] = winner["job_id"] if winner else None
        book_data["winner_quality"] = winner["quality_score"] if winner else None

        if filter == "has_variants" and not jobs:
            continue
        if filter == "needs_review" and (not jobs or winner):
            continue
        if filter == "approved" and not winner:
            continue

        result.append(book_data)
    return result


class SaveSelectionsRequest(BaseModel):
    selections: List[Dict[str, Any]]  # [{book_id, job_id, variant_index, quality_score}]


@router.post("/save-selections")
async def save_selections(req: SaveSelectionsRequest):
    saved = 0
    for sel in req.selections:
        await save_winner(
            book_id=sel["book_id"],
            job_id=sel["job_id"],
            variant_index=sel.get("variant_index", 1),
            quality_score=sel.get("quality_score"),
        )
        saved += 1
    return {"saved": saved}


class BatchApproveRequest(BaseModel):
    threshold: float = 0.6


@router.post("/batch-approve")
async def batch_approve(req: BatchApproveRequest):
    """Auto-approve all books with best variant above quality threshold."""
    books = await get_all_books()
    approved = 0
    for book in books:
        # Skip already-approved
        existing = await get_winner(book["id"])
        if existing:
            continue
        # Get best variant above threshold
        jobs = await fetchall(
            """SELECT * FROM jobs WHERE book_id=? AND status='completed' AND quality_score >= ?
               ORDER BY quality_score DESC LIMIT 1""",
            (book["id"], req.threshold)
        )
        if jobs:
            j = jobs[0]
            await save_winner(
                book_id=book["id"],
                job_id=j["id"],
                variant_index=j.get("variant", 1),
                quality_score=j.get("quality_score"),
                auto_approved=True,
            )
            approved += 1
    return {"approved": approved}


# ─── Batch generation ─────────────────────────────────────────────────────────

class BatchGenerateRequest(BaseModel):
    book_ids: List[str]
    model: str = "gemini-2.5-flash-image"
    variant_count: int = Field(default=3, ge=1, le=5)
    prompt_strategy: str = "auto"
    name: Optional[str] = None


@router.post("/batch-generate")
async def batch_generate(req: BatchGenerateRequest):
    # Estimate cost
    models_cfg = OPENROUTER_MODELS.get(req.model, {})
    cost_per = models_cfg.get("cost_per_image", 0.01)
    estimated = len(req.book_ids) * req.variant_count * cost_per

    batch_id = await create_batch_job({
        "book_ids": req.book_ids,
        "model": req.model,
        "variant_count": req.variant_count,
        "prompt_strategy": req.prompt_strategy,
        "name": req.name,
        "estimated_cost": estimated,
    })

    # Schedule async processing
    import asyncio
    asyncio.ensure_future(_process_batch(batch_id))

    return {
        "batch_id": batch_id,
        "estimated_cost": estimated,
        "total_books": len(req.book_ids),
        "total_jobs": len(req.book_ids) * req.variant_count,
    }


async def _process_batch(batch_id: str):
    """Process all books in a batch sequentially."""
    batch = await get_batch_job(batch_id)
    if not batch:
        return

    book_ids = json.loads(batch["book_ids"])
    model = batch["model"]
    variant_count = batch["variant_count"]

    await update_batch_job(
        batch_id,
        status="running",
        started_at=datetime.now(UTC).isoformat()
    )

    # Emit SSE event
    _emit_batch(batch_id, {"event": "started", "batch_id": batch_id, "total": len(book_ids)})

    all_job_ids = []
    completed = 0
    failed = 0

    for book_id in book_ids:
        # Check if paused/cancelled
        current = await get_batch_job(batch_id)
        if current and current["status"] in ("cancelled", "paused"):
            _emit_batch(batch_id, {"event": current["status"], "batch_id": batch_id})
            return

        await update_batch_job(batch_id, current_book_id=book_id)
        book = await get_book(book_id)
        book_title = book["title"] if book else book_id

        _emit_batch(batch_id, {
            "event": "progress",
            "batch_id": batch_id,
            "book_id": book_id,
            "book_title": book_title,
            "completed": completed,
            "failed": failed,
            "total": len(book_ids),
        })

        book_job_ids = []
        for variant in range(1, variant_count + 1):
            try:
                jid = await queue_job(
                    book_id=book_id,
                    model=model,
                    variant=variant,
                    prompt=None,
                )
                book_job_ids.append(jid)
                all_job_ids.append(jid)
            except Exception as e:
                logger.error("Batch %s: failed to queue job for book %s v%d: %s",
                             batch_id, book_id, variant, e)
                failed += 1

        completed += 1

    await update_batch_job(
        batch_id,
        status="completed",
        completed_at=datetime.now(UTC).isoformat(),
        completed_books=completed,
        failed_books=failed,
        job_ids=json.dumps(all_job_ids),
    )
    _emit_batch(batch_id, {
        "event": "completed",
        "batch_id": batch_id,
        "completed": completed,
        "failed": failed,
        "total_jobs": len(all_job_ids),
    })


# Batch SSE bus
_batch_subscribers: Dict[str, List] = {}


def _emit_batch(batch_id: str, event: Dict[str, Any]) -> None:
    import asyncio
    for q in _batch_subscribers.get(batch_id, []):
        try:
            q.put_nowait(event)
        except Exception:
            pass


def subscribe_batch(batch_id: str):
    import asyncio
    q = asyncio.Queue(maxsize=200)
    _batch_subscribers.setdefault(batch_id, []).append(q)
    return q


def unsubscribe_batch(batch_id: str, q) -> None:
    if batch_id in _batch_subscribers:
        try:
            _batch_subscribers[batch_id].remove(q)
        except ValueError:
            pass


@router.get("/batch/{batch_id}/status")
async def batch_status(batch_id: str):
    batch = await get_batch_job(batch_id)
    if not batch:
        raise HTTPException(status_code=404, detail="Batch not found")
    return batch


@router.post("/batch/{batch_id}/pause")
async def batch_pause(batch_id: str):
    batch = await get_batch_job(batch_id)
    if not batch or batch["status"] != "running":
        raise HTTPException(status_code=400, detail="Batch not running")
    await update_batch_job(batch_id, status="paused", paused_at=datetime.now(UTC).isoformat())
    return {"paused": True}


@router.post("/batch/{batch_id}/resume")
async def batch_resume(batch_id: str):
    batch = await get_batch_job(batch_id)
    if not batch or batch["status"] != "paused":
        raise HTTPException(status_code=400, detail="Batch not paused")
    await update_batch_job(batch_id, status="running", paused_at=None)
    import asyncio
    asyncio.ensure_future(_process_batch(batch_id))
    return {"resumed": True}


@router.post("/batch/{batch_id}/cancel")
async def batch_cancel(batch_id: str):
    await update_batch_job(batch_id, status="cancelled",
                            completed_at=datetime.now(UTC).isoformat())
    return {"cancelled": True}


@router.get("/batches")
async def batches_list():
    return await get_batch_jobs()


# ─── Prompts ──────────────────────────────────────────────────────────────────

BUILTIN_PROMPTS = [
    {"name": "Classic Engraving", "category": "style", "template": "Victorian steel engraving illustration, intricate crosshatching, dramatic chiaroscuro, historical scene depicting {title}, by {author}. Black and white etching style, fine line work.", "negative_prompt": "color, modern, photograph, blurry", "style_profile": "engraving"},
    {"name": "Oil Painting", "category": "style", "template": "Dramatic oil painting in the style of the Old Masters, rich impasto texture, dramatic lighting from a single source, depicting a scene from {title}. Deep shadows, luminous highlights, classical composition.", "negative_prompt": "digital, flat, modern, cartoon", "style_profile": "oil_painting"},
    {"name": "Watercolor Sketch", "category": "style", "template": "Delicate watercolor illustration with ink outlines, soft washes of color, loose expressive brushwork depicting themes from {title} by {author}. Impressionistic, ethereal quality.", "negative_prompt": "digital, sharp, photograph, 3d", "style_profile": "watercolor"},
    {"name": "Art Nouveau", "category": "style", "template": "Art Nouveau illustration in the style of Alphonse Mucha, flowing organic lines, ornate decorative borders, symbolist imagery representing {title}. Rich jewel tones, stylized natural forms.", "negative_prompt": "modern, realistic photograph, simple", "style_profile": "art_nouveau"},
    {"name": "Romantic Landscape", "category": "mood", "template": "Romantic landscape painting, sweeping vistas, dramatic clouds, sublime natural scenery evoking the themes of {title}. Painterly atmosphere, golden hour light, sense of wonder and solitude.", "negative_prompt": "portrait, close-up, modern, urban", "style_profile": "landscape"},
    {"name": "Dark Gothic", "category": "mood", "template": "Dark gothic illustration, haunting atmosphere, moonlit scenes, architectural grandeur, mysterious figures, shadows and candlelight. Inspired by {title} by {author}. Woodcut aesthetic.", "negative_prompt": "bright, cheerful, modern, colorful", "style_profile": "gothic"},
    {"name": "Historical Portrait", "category": "subject", "template": "Formal historical portrait in the style of 18th century academic painting, dignified composition, rich fabric textures, symbolic objects related to {title}. Museum quality finish.", "negative_prompt": "casual, modern clothing, photograph, anime", "style_profile": "portrait"},
    {"name": "Adventure Scene", "category": "mood", "template": "Dynamic adventure illustration, dramatic action composition, bold graphic style, sense of movement and excitement. Epic scene inspired by the themes of {title}. High contrast, strong silhouettes.", "negative_prompt": "static, boring, portrait, minimalist", "style_profile": "adventure"},
]


@router.get("/prompts")
async def prompts_list(category: Optional[str] = Query(None)):
    prompts = await get_all_prompts()
    if category:
        prompts = [p for p in prompts if p["category"] == category]
    return prompts


@router.post("/prompts/seed-builtins")
async def seed_builtin_prompts():
    """Seed the 8 built-in style profiles."""
    existing = await get_all_prompts()
    existing_names = {p["name"] for p in existing}
    seeded = 0
    for p in BUILTIN_PROMPTS:
        if p["name"] not in existing_names:
            await create_prompt(p)
            seeded += 1
    return {"seeded": seeded}


@router.get("/prompts/{prompt_id}")
async def prompt_detail(prompt_id: int):
    p = await get_prompt(prompt_id)
    if not p:
        raise HTTPException(status_code=404, detail="Prompt not found")
    return p


class PromptCreateRequest(BaseModel):
    name: str
    category: str = "general"
    template: str
    negative_prompt: Optional[str] = None
    style_profile: Optional[str] = None


@router.post("/prompts")
async def prompt_create(req: PromptCreateRequest):
    pid = await create_prompt(req.dict())
    return {"id": pid, "created": True}


class PromptUpdateRequest(BaseModel):
    name: Optional[str] = None
    category: Optional[str] = None
    template: Optional[str] = None
    negative_prompt: Optional[str] = None
    style_profile: Optional[str] = None


@router.put("/prompts/{prompt_id}")
async def prompt_update(prompt_id: int, req: PromptUpdateRequest):
    p = await get_prompt(prompt_id)
    if not p:
        raise HTTPException(status_code=404, detail="Prompt not found")
    await update_prompt(prompt_id, {k: v for k, v in req.dict().items() if v is not None})
    return {"updated": True}


@router.delete("/prompts/{prompt_id}")
async def prompt_delete(prompt_id: int):
    await delete_prompt(prompt_id)
    return {"deleted": True}


@router.get("/prompts/{prompt_id}/versions")
async def prompt_versions(prompt_id: int):
    return await fetchall(
        "SELECT * FROM prompt_versions WHERE prompt_id=? ORDER BY version DESC",
        (prompt_id,)
    )


# ─── Compare ──────────────────────────────────────────────────────────────────

@router.get("/compare")
async def compare_books(book_ids: str = Query(..., description="Comma-separated book IDs")):
    """Return comparison data for 2-4 books."""
    ids = [b.strip() for b in book_ids.split(",") if b.strip()][:4]
    result = []
    for bid in ids:
        book = await get_book(bid)
        if not book:
            continue
        jobs = await fetchall(
            "SELECT * FROM jobs WHERE book_id=? AND status='completed' ORDER BY quality_score DESC NULLS LAST",
            (bid,)
        )
        winner = await get_winner(bid)
        total_cost = await fetchall(
            "SELECT SUM(cost_usd) as total FROM jobs WHERE book_id=? AND status='completed'",
            (bid,)
        )
        result.append({
            **book,
            "variants": jobs,
            "winner_job_id": winner["job_id"] if winner else None,
            "total_cost": total_cost[0]["total"] if total_cost else 0,
        })
    return result


# ─── Similarity ───────────────────────────────────────────────────────────────

@router.get("/similarity-matrix")
async def similarity_matrix():
    """Return cached similarity scores or compute them."""
    # Return cached pairs
    cached = await fetchall(
        "SELECT * FROM similarity_cache ORDER BY score ASC LIMIT 200"
    )
    # Get all completed jobs for the matrix
    jobs = await fetchall(
        "SELECT j.id, j.book_id, b.title, j.quality_score FROM jobs j "
        "LEFT JOIN books b ON j.book_id = b.id WHERE j.status='completed' ORDER BY j.created_at DESC"
    )
    return {
        "jobs": jobs,
        "pairs": cached,
        "alert_pairs": [p for p in cached if p["score"] < 0.25],
    }


@router.post("/similarity-compute")
async def similarity_compute():
    """Compute perceptual hash similarity for all completed jobs."""
    import asyncio
    asyncio.ensure_future(_compute_similarity())
    return {"status": "computing", "message": "Similarity computation started"}


async def _compute_similarity():
    """Compute pHash similarity between all completed job images."""
    try:
        import hashlib

        jobs = await fetchall(
            "SELECT id, composited_image_path, generated_image_path, results_json FROM jobs WHERE status='completed'"
        )

        def get_image_path(job):
            p = job.get("composited_image_path") or job.get("generated_image_path")
            if p and Path(p).exists():
                return Path(p)
            if job.get("results_json"):
                r = json.loads(job["results_json"])
                cp = r.get("composited_path") or r.get("generated_raw_path")
                if cp and Path(cp).exists():
                    return Path(cp)
            return None

        job_hashes = {}
        for job in jobs:
            path = get_image_path(job)
            if path:
                # Simple file hash as proxy for similarity
                h = hashlib.md5(path.read_bytes()).hexdigest()
                job_hashes[job["id"]] = h

        # For now store placeholder scores (real pHash would need imagehash library)
        job_ids = list(job_hashes.keys())
        pairs_inserted = 0
        for i in range(min(len(job_ids), 50)):
            for j in range(i + 1, min(len(job_ids), 50)):
                a, b = job_ids[i], job_ids[j]
                # Compute simple similarity from hash distance as proxy
                ha, hb = job_hashes[a], job_hashes[b]
                # Hamming distance on first 8 hex chars
                score = sum(c1 == c2 for c1, c2 in zip(ha[:8], hb[:8])) / 8.0
                try:
                    await execute(
                        "INSERT OR REPLACE INTO similarity_cache (job_id_a, job_id_b, score, computed_at) VALUES (?,?,?,?)",
                        (a, b, score, datetime.now(UTC).isoformat())
                    )
                    pairs_inserted += 1
                except Exception:
                    pass
        logger.info("Similarity computed: %d pairs", pairs_inserted)
    except Exception as e:
        logger.error("Similarity computation error: %s", e)


# ─── Settings ─────────────────────────────────────────────────────────────────

@router.get("/settings")
async def settings_get():
    settings = await get_all_settings()
    # Merge with defaults
    defaults = {
        "budget_limit": 50.0,
        "default_model": "gemini-2.5-flash-image",
        "default_variants": 3,
        "quality_threshold": 0.6,
        "drive_folder_id": "",
        "medallion_center_x": 400,
        "medallion_center_y": 400,
        "medallion_radius": 200,
        "drive_connected": False,
        "auto_approve_threshold": 0.75,
    }
    return {**defaults, **settings}


class SettingsUpdateRequest(BaseModel):
    settings: Dict[str, Any]


@router.put("/settings")
async def settings_update(req: SettingsUpdateRequest):
    for key, value in req.settings.items():
        await set_setting(key, value)
    return {"updated": True, "count": len(req.settings)}


# ─── Catalogs ─────────────────────────────────────────────────────────────────

@router.get("/catalogs")
async def catalogs_list():
    books = await get_all_books()
    total_cost = await fetchall("SELECT SUM(cost_usd) as total FROM jobs WHERE status='completed'")
    total_generated = await fetchall("SELECT COUNT(DISTINCT book_id) as cnt FROM jobs WHERE status='completed'")
    return {
        "books": books,
        "stats": {
            "total_books": len(books),
            "total_cost": total_cost[0]["total"] or 0 if total_cost else 0,
            "books_generated": total_generated[0]["cnt"] if total_generated else 0,
        }
    }


@router.post("/catalogs/sync")
async def catalogs_sync():
    """Trigger a catalog sync from Drive."""
    from app.services.drive import sync_catalog
    try:
        books = await sync_catalog()
        return {"synced": len(books), "status": "ok"}
    except Exception as e:
        return {"synced": 0, "status": "error", "error": str(e)}


# ─── API Docs endpoint ────────────────────────────────────────────────────────

@router.get("/endpoints")
async def endpoints_list():
    """Return all registered API endpoints."""
    from app.main import app
    routes = []
    for route in app.routes:
        if hasattr(route, "methods") and hasattr(route, "path"):
            if route.path.startswith("/api/"):
                routes.append({
                    "path": route.path,
                    "methods": list(route.methods),
                    "name": getattr(route, "name", ""),
                    "summary": getattr(route, "summary", "") or getattr(route, "description", ""),
                })
    return sorted(routes, key=lambda r: r["path"])
