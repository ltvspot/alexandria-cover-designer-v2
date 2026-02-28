"""
Tests for job system and database interactions.
"""
import asyncio
import pytest
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, patch, MagicMock

# We need to point DB at a temp file before importing database module
import os
_tmpdir = tempfile.mkdtemp()
os.environ["DB_PATH_OVERRIDE"] = str(Path(_tmpdir) / "test.db")


from app.database import (
    init_db,
    create_job,
    get_job,
    get_jobs,
    update_job,
    recover_stale_jobs,
    get_queued_jobs,
    upsert_book,
    get_all_books,
    record_cost,
    get_cost_summary,
    get_monthly_cost,
)
from app.services.jobs import queue_job, cancel_job
from app.services.prompts import build_prompt, get_all_prompts


# ─── Database tests ───────────────────────────────────────────────────────────

# Override DB path for tests
import app.database as _db_module
_db_module.DB_PATH = Path(_tmpdir) / "test.db"


@pytest.fixture(autouse=True)
async def setup_db():
    """Ensure fresh DB for each test."""
    db_path = Path(_tmpdir) / "test.db"
    if db_path.exists():
        db_path.unlink()
    await init_db()
    yield


@pytest.mark.asyncio
async def test_create_and_get_job():
    await upsert_book({
        "id": "book1",
        "number": 1,
        "title": "Test Book",
        "author": "Test Author",
        "folder_name": "1. Test Book - Test Author",
        "cover_jpg_id": None,
        "cover_cached_path": None,
        "thumbnail_path": None,
    })
    jid = await create_job({
        "id": "job-001",
        "book_id": "book1",
        "model": "gemini-2.5-flash-image",
        "variant": 1,
    })
    assert jid == "job-001"

    job = await get_job("job-001")
    assert job is not None
    assert job["status"] == "queued"
    assert job["book_id"] == "book1"
    assert job["model"] == "gemini-2.5-flash-image"
    assert job["variant"] == 1


@pytest.mark.asyncio
async def test_update_job_status():
    await upsert_book({
        "id": "book2", "number": 2, "title": "Book Two", "author": "Author Two",
        "folder_name": "2. Book Two - Author Two",
        "cover_jpg_id": None, "cover_cached_path": None, "thumbnail_path": None,
    })
    await create_job({"id": "job-002", "book_id": "book2", "model": "gemini-2.5-flash-image", "variant": 1})
    await update_job("job-002", status="running")
    job = await get_job("job-002")
    assert job["status"] == "running"


@pytest.mark.asyncio
async def test_recover_stale_jobs():
    await upsert_book({
        "id": "book3", "number": 3, "title": "Book Three", "author": "Author Three",
        "folder_name": "3. Book Three - Author Three",
        "cover_jpg_id": None, "cover_cached_path": None, "thumbnail_path": None,
    })
    await create_job({"id": "job-003", "book_id": "book3", "model": "gemini-2.5-flash-image", "variant": 1})
    await update_job("job-003", status="running")

    n = await recover_stale_jobs()
    assert n >= 0  # At least nothing broke

    job = await get_job("job-003")
    assert job["status"] == "queued"


@pytest.mark.asyncio
async def test_get_queued_jobs():
    await upsert_book({
        "id": "book4", "number": 4, "title": "Book Four", "author": "Author Four",
        "folder_name": "4. Book Four - Author Four",
        "cover_jpg_id": None, "cover_cached_path": None, "thumbnail_path": None,
    })
    await create_job({"id": "job-010", "book_id": "book4", "model": "gemini-2.5-flash-image", "variant": 1})
    await create_job({"id": "job-011", "book_id": "book4", "model": "gemini-2.5-flash-image", "variant": 2})
    await update_job("job-010", status="completed")

    queued = await get_queued_jobs()
    ids = [j["id"] for j in queued]
    assert "job-010" not in ids
    assert "job-011" in ids


@pytest.mark.asyncio
async def test_cost_ledger():
    await record_cost(
        job_id="job-costs",
        book_id="book-costs",
        model="gemini-2.5-flash-image",
        cost_usd=0.003,
        tokens_in=100,
        tokens_out=0,
        duration_ms=2500,
    )
    summary = await get_cost_summary()
    assert summary["total_all_time"] >= 0.003

    monthly = await get_monthly_cost()
    assert monthly >= 0.003


@pytest.mark.asyncio
async def test_upsert_book_deduplication():
    book = {
        "id": "book-dup",
        "number": 99,
        "title": "Original Title",
        "author": "Original Author",
        "folder_name": "99. Original Title - Original Author",
        "cover_jpg_id": None,
        "cover_cached_path": None,
        "thumbnail_path": None,
    }
    await upsert_book(book)
    book["title"] = "Updated Title"
    await upsert_book(book)

    books = await get_all_books()
    matches = [b for b in books if b["id"] == "book-dup"]
    assert len(matches) == 1
    assert matches[0]["title"] == "Updated Title"


# ─── Job service tests ────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_queue_job_returns_id():
    await upsert_book({
        "id": "book5", "number": 5, "title": "Book Five", "author": "Author Five",
        "folder_name": "5. Book Five - Author Five",
        "cover_jpg_id": None, "cover_cached_path": None, "thumbnail_path": None,
    })
    jid = await queue_job("book5", "gemini-2.5-flash-image", variant=1)
    assert jid is not None
    assert len(jid) > 0


@pytest.mark.asyncio
async def test_cancel_queued_job():
    await upsert_book({
        "id": "book6", "number": 6, "title": "Book Six", "author": "Author Six",
        "folder_name": "6. Book Six - Author Six",
        "cover_jpg_id": None, "cover_cached_path": None, "thumbnail_path": None,
    })
    jid = await queue_job("book6", "gemini-2.5-flash-image", variant=1)
    ok = await cancel_job(jid)
    assert ok is True
    job = await get_job(jid)
    assert job["status"] == "cancelled"


@pytest.mark.asyncio
async def test_cancel_nonexistent_job():
    ok = await cancel_job("non-existent-id")
    assert ok is False


# ─── Prompt tests ────────────────────────────────────────────────────────────

def test_build_prompt_includes_title():
    p = build_prompt("A Room with a View", "E. M. Forster", variant=1)
    assert "A Room with a View" in p
    assert "E. M. Forster" in p


def test_build_prompt_all_variants():
    prompts = get_all_prompts("The Great Gatsby", "F. Scott Fitzgerald")
    assert len(prompts) == 5
    for v, p in prompts.items():
        assert "The Great Gatsby" in p
        assert isinstance(p, str)
        assert len(p) > 50


def test_build_prompt_no_author():
    p = build_prompt("Unknown Book", "", variant=3)
    assert "Unknown Book" in p
    assert len(p) > 20


def test_build_prompt_variant_clamping():
    p1 = build_prompt("Test", "Author", variant=0)   # clamp to 1
    p2 = build_prompt("Test", "Author", variant=1)
    assert p1 == p2

    p5 = build_prompt("Test", "Author", variant=99)  # clamp to 5
    p5ref = build_prompt("Test", "Author", variant=5)
    assert p5 == p5ref
