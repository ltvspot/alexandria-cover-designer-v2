"""
SQLite database setup using aiosqlite + raw SQL.
Tables: books, jobs, cost_ledger, medallion_config,
        winner_selections, prompts, prompt_versions, batch_jobs, similarity_cache
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
    genre       TEXT,
    themes      TEXT,
    era         TEXT,
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
    batch_id    TEXT,
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

CREATE TABLE IF NOT EXISTS winner_selections (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id     TEXT NOT NULL,
    job_id      TEXT NOT NULL,
    variant_index INTEGER NOT NULL DEFAULT 1,
    quality_score REAL,
    selected_at TEXT NOT NULL DEFAULT (datetime('now')),
    auto_approved INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (book_id) REFERENCES books(id),
    FOREIGN KEY (job_id) REFERENCES jobs(id)
);

CREATE TABLE IF NOT EXISTS prompts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    category    TEXT NOT NULL DEFAULT 'general',
    template    TEXT NOT NULL,
    negative_prompt TEXT,
    style_profile TEXT,
    usage_count INTEGER NOT NULL DEFAULT 0,
    avg_quality REAL,
    win_rate    REAL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prompt_versions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    prompt_id   INTEGER NOT NULL,
    version     INTEGER NOT NULL DEFAULT 1,
    template    TEXT NOT NULL,
    negative_prompt TEXT,
    style_profile TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (prompt_id) REFERENCES prompts(id)
);

CREATE TABLE IF NOT EXISTS batch_jobs (
    id          TEXT PRIMARY KEY,
    name        TEXT,
    status      TEXT NOT NULL DEFAULT 'queued',   -- queued|running|paused|completed|failed|cancelled
    book_ids    TEXT NOT NULL,           -- JSON array
    model       TEXT NOT NULL,
    variant_count INTEGER NOT NULL DEFAULT 3,
    prompt_strategy TEXT NOT NULL DEFAULT 'auto',
    total_books INTEGER NOT NULL DEFAULT 0,
    completed_books INTEGER NOT NULL DEFAULT 0,
    failed_books INTEGER NOT NULL DEFAULT 0,
    total_cost  REAL NOT NULL DEFAULT 0.0,
    estimated_cost REAL,
    current_book_id TEXT,
    job_ids     TEXT,                   -- JSON array of generated job ids
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    started_at  TEXT,
    completed_at TEXT,
    paused_at   TEXT,
    error       TEXT
);

CREATE TABLE IF NOT EXISTS similarity_cache (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id_a    TEXT NOT NULL,
    job_id_b    TEXT NOT NULL,
    score       REAL NOT NULL,
    computed_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(job_id_a, job_id_b)
);

CREATE TABLE IF NOT EXISTS settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_jobs_book_id   ON jobs(book_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status    ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_created   ON jobs(created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_batch     ON jobs(batch_id);
CREATE INDEX IF NOT EXISTS idx_ledger_job     ON cost_ledger(job_id);
CREATE INDEX IF NOT EXISTS idx_ledger_date    ON cost_ledger(recorded_at);
CREATE INDEX IF NOT EXISTS idx_winner_book    ON winner_selections(book_id);
CREATE INDEX IF NOT EXISTS idx_prompt_cat     ON prompts(category);
CREATE INDEX IF NOT EXISTS idx_batch_status   ON batch_jobs(status);
"""

# Migration to add new columns if they don't exist
MIGRATIONS = [
    "ALTER TABLE books ADD COLUMN genre TEXT",
    "ALTER TABLE books ADD COLUMN themes TEXT",
    "ALTER TABLE books ADD COLUMN era TEXT",
    "ALTER TABLE jobs ADD COLUMN batch_id TEXT",
]


# ─── Init ─────────────────────────────────────────────────────────────────────
async def init_db() -> None:
    """Create tables if they don't exist, run migrations."""
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    async with aiosqlite.connect(DB_PATH) as db:
        # Run migrations first (add new columns to existing tables)
        for migration in MIGRATIONS:
            try:
                await db.execute(migration)
                await db.commit()
            except Exception:
                pass  # Column already exists or table doesn't exist yet

        # Run each DDL statement individually so errors don't block others
        for stmt in SCHEMA.split(";"):
            stmt = stmt.strip()
            if stmt:
                try:
                    await db.execute(stmt)
                    await db.commit()
                except Exception as e:
                    # Log but continue — table/index may already exist with right schema
                    pass
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
        INSERT INTO jobs (id, book_id, status, model, variant, prompt, created_at, batch_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            job_id,
            job["book_id"],
            job.get("status", "queued"),
            job["model"],
            job.get("variant", 1),
            job.get("prompt"),
            datetime.now(UTC).isoformat(),
            job.get("batch_id"),
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


# ─── Winner selections ────────────────────────────────────────────────────────
async def save_winner(book_id: str, job_id: str, variant_index: int = 1,
                       quality_score: float = None, auto_approved: bool = False) -> None:
    # Remove any existing selection for this book
    await execute("DELETE FROM winner_selections WHERE book_id = ?", (book_id,))
    await execute(
        """
        INSERT INTO winner_selections (book_id, job_id, variant_index, quality_score,
                                       selected_at, auto_approved)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (book_id, job_id, variant_index, quality_score,
         datetime.now(UTC).isoformat(), 1 if auto_approved else 0),
    )


async def get_winner(book_id: str) -> Optional[Dict]:
    return await fetchone(
        "SELECT * FROM winner_selections WHERE book_id = ?", (book_id,)
    )


async def get_all_winners() -> List[Dict]:
    return await fetchall(
        "SELECT ws.*, b.title, b.author FROM winner_selections ws "
        "JOIN books b ON ws.book_id = b.id ORDER BY ws.selected_at DESC"
    )


# ─── Prompts ──────────────────────────────────────────────────────────────────
async def get_all_prompts() -> List[Dict]:
    return await fetchall("SELECT * FROM prompts ORDER BY category, name")


async def get_prompt(prompt_id: int) -> Optional[Dict]:
    return await fetchone("SELECT * FROM prompts WHERE id = ?", (prompt_id,))


async def create_prompt(data: Dict[str, Any]) -> int:
    return await execute(
        """
        INSERT INTO prompts (name, category, template, negative_prompt, style_profile,
                              created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            data["name"], data.get("category", "general"), data["template"],
            data.get("negative_prompt"), data.get("style_profile"),
            datetime.now(UTC).isoformat(), datetime.now(UTC).isoformat(),
        ),
    )


async def update_prompt(prompt_id: int, data: Dict[str, Any]) -> None:
    # Save version first
    existing = await get_prompt(prompt_id)
    if existing:
        versions = await fetchall(
            "SELECT MAX(version) as v FROM prompt_versions WHERE prompt_id = ?",
            (prompt_id,)
        )
        next_v = (versions[0]["v"] or 0) + 1 if versions else 1
        await execute(
            """INSERT INTO prompt_versions (prompt_id, version, template, negative_prompt, style_profile, created_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (prompt_id, next_v, existing["template"], existing.get("negative_prompt"),
             existing.get("style_profile"), datetime.now(UTC).isoformat())
        )
    sets = []
    vals = []
    for k in ("name", "category", "template", "negative_prompt", "style_profile"):
        if k in data:
            sets.append(f"{k} = ?")
            vals.append(data[k])
    sets.append("updated_at = ?")
    vals.append(datetime.now(UTC).isoformat())
    vals.append(prompt_id)
    await execute(f"UPDATE prompts SET {', '.join(sets)} WHERE id = ?", tuple(vals))


async def delete_prompt(prompt_id: int) -> None:
    await execute("DELETE FROM prompt_versions WHERE prompt_id = ?", (prompt_id,))
    await execute("DELETE FROM prompts WHERE id = ?", (prompt_id,))


# ─── Batch jobs ───────────────────────────────────────────────────────────────
async def create_batch_job(data: Dict[str, Any]) -> str:
    import uuid
    batch_id = str(uuid.uuid4())
    await execute(
        """
        INSERT INTO batch_jobs (id, name, status, book_ids, model, variant_count,
                                 prompt_strategy, total_books, estimated_cost, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            batch_id, data.get("name", f"Batch {batch_id[:8]}"),
            "queued",
            json.dumps(data["book_ids"]),
            data["model"],
            data.get("variant_count", 3),
            data.get("prompt_strategy", "auto"),
            len(data["book_ids"]),
            data.get("estimated_cost"),
            datetime.now(UTC).isoformat(),
        ),
    )
    return batch_id


async def get_batch_job(batch_id: str) -> Optional[Dict]:
    return await fetchone("SELECT * FROM batch_jobs WHERE id = ?", (batch_id,))


async def get_batch_jobs(limit: int = 50) -> List[Dict]:
    return await fetchall(
        "SELECT * FROM batch_jobs ORDER BY created_at DESC LIMIT ?", (limit,)
    )


async def update_batch_job(batch_id: str, **kwargs) -> None:
    if not kwargs:
        return
    sets = ", ".join(f"{k} = ?" for k in kwargs)
    values = tuple(kwargs.values()) + (batch_id,)
    await execute(f"UPDATE batch_jobs SET {sets} WHERE id = ?", values)


# ─── Settings ─────────────────────────────────────────────────────────────────
async def get_setting(key: str, default: Any = None) -> Any:
    row = await fetchone("SELECT value FROM settings WHERE key = ?", (key,))
    if row:
        try:
            return json.loads(row["value"])
        except Exception:
            return row["value"]
    return default


async def set_setting(key: str, value: Any) -> None:
    val = json.dumps(value)
    await execute(
        """INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at""",
        (key, val, datetime.now(UTC).isoformat()),
    )


async def get_all_settings() -> Dict[str, Any]:
    rows = await fetchall("SELECT key, value FROM settings")
    result = {}
    for r in rows:
        try:
            result[r["key"]] = json.loads(r["value"])
        except Exception:
            result[r["key"]] = r["value"]
    return result
