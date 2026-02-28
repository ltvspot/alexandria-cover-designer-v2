"""
SQLite database setup using aiosqlite + raw SQL.
Tables: books, jobs, cost_ledger, medallion_config
"""
import json
import logging
from datetime import datetime, timezone
UTC = timezone.utc
from pathlib import Path
from typing import Any, Dict, List, Optional

import aiosqlite

from app.config import DB_PATH

logger = logging.getLogger(__name__)


# ─── Schema ───────────────────────────────────────────────────────────────────
SCHEMA = """
CREATE TABLE IF NOT EXISTS books (
    id          TEXT PRIMARY KEY,      -- drive folder id
    number      INTEGER,               -- parsed book number (1, 2, ...)
    title       TEXT NOT NULL,
    author      TEXT,
    folder_name TEXT,                  -- raw folder name from Drive
    cover_jpg_id TEXT,                 -- drive file id for the .jpg
    cover_cached_path TEXT,            -- local cache path
    thumbnail_path TEXT,               -- local thumbnail path
    synced_at   TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS medallion_config (
    book_id     TEXT PRIMARY KEY,
    center_x    INTEGER NOT NULL,
    center_y    INTEGER NOT NULL,
    radius      INTEGER NOT NULL,
    FOREIGN KEY (book_id) REFERENCES books(id)
);

CREATE TABLE IF NOT EXISTS jobs (
    id          TEXT PRIMARY KEY,
    book_id     TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'queued',   -- queued|running|completed|failed|cancelled
    model       TEXT NOT NULL,
    variant     INTEGER NOT NULL DEFAULT 1,
    prompt      TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    started_at  TEXT,
    completed_at TEXT,
    cost_usd    REAL DEFAULT 0.0,
    error       TEXT,
    generated_image_path TEXT,
    composited_image_path TEXT,
    quality_score REAL,
    results_json TEXT,
    FOREIGN KEY (book_id) REFERENCES books(id)
);

CREATE TABLE IF NOT EXISTS cost_ledger (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id      TEXT,
    book_id     TEXT,
    model       TEXT NOT NULL,
    cost_usd    REAL NOT NULL DEFAULT 0.0,
    tokens_in   INTEGER DEFAULT 0,
    tokens_out  INTEGER DEFAULT 0,
    duration_ms INTEGER DEFAULT 0,
    recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_jobs_book_id   ON jobs(book_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status    ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_created   ON jobs(created_at);
CREATE INDEX IF NOT EXISTS idx_ledger_job     ON cost_ledger(job_id);
CREATE INDEX IF NOT EXISTS idx_ledger_date    ON cost_ledger(recorded_at);
"""


# ─── Init ─────────────────────────────────────────────────────────────────────
async def init_db() -> None:
    """Create tables if they don't exist."""
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    async with aiosqlite.connect(DB_PATH) as db:
        await db.executescript(SCHEMA)
        await db.commit()
    logger.info("Database initialised at %s", DB_PATH)


# ─── Generic helpers ─────────────────────────────────────────────────────────
async def fetchall(query: str, params: tuple = ()) -> List[Dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(query, params) as cur:
            rows = await cur.fetchall()
            return [dict(r) for r in rows]


async def fetchone(query: str, params: tuple = ()) -> Optional[Dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(query, params) as cur:
            row = await cur.fetchone()
            return dict(row) if row else None


async def execute(query: str, params: tuple = ()) -> int:
    """Execute and return lastrowid."""
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(query, params) as cur:
            await db.commit()
            return cur.lastrowid


async def executemany(query: str, params_list: List[tuple]) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.executemany(query, params_list)
        await db.commit()


# ─── Book helpers ─────────────────────────────────────────────────────────────
async def upsert_book(book: Dict[str, Any]) -> None:
    await execute(
        """
        INSERT INTO books (id, number, title, author, folder_name, cover_jpg_id,
                           cover_cached_path, thumbnail_path, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            number            = excluded.number,
            title             = excluded.title,
            author            = excluded.author,
            folder_name       = excluded.folder_name,
            cover_jpg_id      = excluded.cover_jpg_id,
            cover_cached_path = excluded.cover_cached_path,
            thumbnail_path    = excluded.thumbnail_path,
            synced_at         = excluded.synced_at
        """,
        (
            book.get("id"), book.get("number"), book.get("title"),
            book.get("author"), book.get("folder_name"), book.get("cover_jpg_id"),
            book.get("cover_cached_path"), book.get("thumbnail_path"),
            book.get("synced_at") or datetime.now(UTC).isoformat(),
        ),
    )


async def get_all_books() -> List[Dict]:
    return await fetchall("SELECT * FROM books ORDER BY number ASC, title ASC")


async def get_book(book_id: str) -> Optional[Dict]:
    return await fetchone("SELECT * FROM books WHERE id = ?", (book_id,))


# ─── Job helpers ──────────────────────────────────────────────────────────────
async def create_job(job: Dict[str, Any]) -> str:
    import uuid
    job_id = job.get("id") or str(uuid.uuid4())
    await execute(
        """
        INSERT INTO jobs (id, book_id, status, model, variant, prompt, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            job_id,
            job["book_id"],
            job.get("status", "queued"),
            job["model"],
            job.get("variant", 1),
            job.get("prompt"),
            datetime.now(UTC).isoformat(),
        ),
    )
    return job_id


async def get_job(job_id: str) -> Optional[Dict]:
    return await fetchone("SELECT * FROM jobs WHERE id = ?", (job_id,))


async def get_jobs(limit: int = 100, offset: int = 0) -> List[Dict]:
    return await fetchall(
        "SELECT * FROM jobs ORDER BY created_at DESC LIMIT ? OFFSET ?",
        (limit, offset),
    )


async def update_job(job_id: str, **kwargs) -> None:
    if not kwargs:
        return
    sets = ", ".join(f"{k} = ?" for k in kwargs)
    values = tuple(kwargs.values()) + (job_id,)
    await execute(f"UPDATE jobs SET {sets} WHERE id = ?", values)


async def recover_stale_jobs() -> int:
    """Set jobs that were stuck in 'running' back to 'queued' on startup."""
    result = await execute(
        "UPDATE jobs SET status = 'queued', started_at = NULL WHERE status = 'running'",
    )
    return result


async def get_queued_jobs() -> List[Dict]:
    return await fetchall(
        "SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at ASC"
    )


# ─── Cost ledger helpers ───────────────────────────────────────────────────────
async def record_cost(
    job_id: Optional[str],
    book_id: Optional[str],
    model: str,
    cost_usd: float,
    tokens_in: int = 0,
    tokens_out: int = 0,
    duration_ms: int = 0,
) -> None:
    await execute(
        """
        INSERT INTO cost_ledger (job_id, book_id, model, cost_usd, tokens_in, tokens_out,
                                  duration_ms, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            job_id, book_id, model, cost_usd, tokens_in, tokens_out,
            duration_ms, datetime.now(UTC).isoformat(),
        ),
    )


async def get_cost_summary() -> Dict[str, Any]:
    today = datetime.now(UTC).date().isoformat()
    rows = await fetchall(
        """
        SELECT
            SUM(cost_usd)                                    AS total_all_time,
            SUM(CASE WHEN date(recorded_at) = ? THEN cost_usd ELSE 0 END) AS today,
            COUNT(*)                                         AS total_records
        FROM cost_ledger
        """,
        (today,),
    )
    return rows[0] if rows else {"total_all_time": 0.0, "today": 0.0, "total_records": 0}


async def get_monthly_cost() -> float:
    month = datetime.now(UTC).strftime("%Y-%m")
    rows = await fetchall(
        "SELECT SUM(cost_usd) AS total FROM cost_ledger WHERE strftime('%Y-%m', recorded_at) = ?",
        (month,),
    )
    return rows[0]["total"] or 0.0 if rows else 0.0
