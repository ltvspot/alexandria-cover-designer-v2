"""
REST API routes.
"""
import json
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

from app.config import COVERS_DIR, OUTPUTS_DIR, THUMBNAILS_DIR, OPENROUTER_MODELS
from app.database import get_all_books, get_book, get_jobs, get_job
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
            from app.database import execute
            await execute(
                "UPDATE books SET thumbnail_path = ? WHERE id = ?",
                (str(thumb), book_id),
            )
            return FileResponse(str(thumb), media_type="image/jpeg")

    raise HTTPException(status_code=404, detail="Cover preview not available")


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
async def jobs_list(limit: int = Query(50, ge=1, le=500)):
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
    from app.database import get_cost_summary
    return await get_cost_summary()


@router.get("/analytics/budget")
async def budget_status():
    return await get_budget_status()
