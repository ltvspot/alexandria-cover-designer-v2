"""
Google Drive service — catalog listing + file download.
Uses the Drive v3 REST API with an API key (no service account required).
The source folder is PUBLIC.
"""
import logging
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx

from app.config import (
    COVERS_DIR,
    DRIVE_API_BASE,
    DRIVE_SOURCE_FOLDER_ID,
    GOOGLE_API_KEY,
    THUMBNAILS_DIR,
    THUMBNAIL_SIZE,
)

logger = logging.getLogger(__name__)

# Regex: "1. A Room with a View - E. M. Forster copy" → number=1, title=..., author=...
FOLDER_RE = re.compile(
    r"^(?P<num>\d+)\.\s+(?P<title>.+?)\s+-\s+(?P<author>.+?)(?:\s+copy)?$",
    re.IGNORECASE,
)


def _parse_folder_name(name: str) -> Dict[str, Any]:
    """Extract book number, title, and author from a Drive folder name."""
    m = FOLDER_RE.match(name.strip())
    if m:
        return {
            "number": int(m.group("num")),
            "title": m.group("title").strip(),
            "author": m.group("author").strip(),
        }
    # Fallback — just store the raw name as title
    return {"number": None, "title": name.strip(), "author": None}


async def list_drive_subfolders(folder_id: str = DRIVE_SOURCE_FOLDER_ID) -> List[Dict]:
    """
    List ALL subfolders inside the given Drive folder using nextPageToken pagination.
    Handles 999+ folders (10 pages at pageSize=100).
    Port of drive.js listDriveSubfolders().
    """
    url = f"{DRIVE_API_BASE}/files"
    all_files: List[Dict] = []
    page_token: Optional[str] = None

    async with httpx.AsyncClient(timeout=30) as client:
        while True:
            params: Dict[str, Any] = {
                "q": (
                    f"'{folder_id}' in parents "
                    "and mimeType = 'application/vnd.google-apps.folder' "
                    "and trashed = false"
                ),
                "fields": "nextPageToken,files(id,name)",
                "pageSize": 100,
                "key": GOOGLE_API_KEY,
            }
            if page_token:
                params["pageToken"] = page_token

            resp = await client.get(url, params=params)
            resp.raise_for_status()
            data = resp.json()

            all_files.extend(data.get("files", []))
            page_token = data.get("nextPageToken")
            if not page_token:
                break

    logger.info("list_drive_subfolders: %d folders found in %s", len(all_files), folder_id)
    return all_files


async def list_drive_files_in_folder(folder_id: str) -> List[Dict]:
    """List all files inside a Drive folder, return {id, name, mimeType}."""
    url = f"{DRIVE_API_BASE}/files"
    params = {
        "q": f"'{folder_id}' in parents and trashed = false",
        "fields": "files(id,name,mimeType,size)",
        "pageSize": 50,
        "key": GOOGLE_API_KEY,
    }
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(url, params=params)
        resp.raise_for_status()
        data = resp.json()
        return data.get("files", [])


async def download_drive_file(file_id: str, dest_path: Path) -> Path:
    """Download a file by Drive file ID to dest_path."""
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    url = f"{DRIVE_API_BASE}/files/{file_id}"
    params = {"alt": "media", "key": GOOGLE_API_KEY}
    async with httpx.AsyncClient(timeout=120, follow_redirects=True) as client:
        async with client.stream("GET", url, params=params) as resp:
            resp.raise_for_status()
            with open(dest_path, "wb") as f:
                async for chunk in resp.aiter_bytes(chunk_size=65536):
                    f.write(chunk)
    logger.info("Downloaded %s → %s (%d bytes)", file_id, dest_path, dest_path.stat().st_size)
    return dest_path


async def get_book_cover_jpg_id(folder_id: str) -> Optional[str]:
    """Find the .jpg file in a book subfolder (pick largest if multiple)."""
    files = await list_drive_files_in_folder(folder_id)
    jpgs = [f for f in files if f["name"].lower().endswith(".jpg")]
    if not jpgs:
        return None
    # Pick the one with the largest size
    jpgs.sort(key=lambda f: int(f.get("size", 0)), reverse=True)
    return jpgs[0]["id"]


async def ensure_cover_cached(book_id: str, cover_jpg_id: str) -> Optional[Path]:
    """Download the cover JPG if not already cached locally."""
    dest = COVERS_DIR / f"{book_id}.jpg"
    if dest.exists() and dest.stat().st_size > 10_000:
        return dest
    try:
        return await download_drive_file(cover_jpg_id, dest)
    except Exception as e:
        logger.error("Failed to download cover %s: %s", cover_jpg_id, e)
        return None


async def make_thumbnail(cover_path: Path, book_id: str) -> Optional[Path]:
    """Create a small JPEG thumbnail from the cached cover."""
    from PIL import Image

    dest = THUMBNAILS_DIR / f"{book_id}_thumb.jpg"
    THUMBNAILS_DIR.mkdir(parents=True, exist_ok=True)
    try:
        with Image.open(cover_path) as img:
            img.thumbnail(THUMBNAIL_SIZE, Image.LANCZOS)
            img.save(dest, "JPEG", quality=80)
        return dest
    except Exception as e:
        logger.error("Failed to create thumbnail for %s: %s", book_id, e)
        return None


async def sync_catalog() -> List[Dict]:
    """
    Fetch book list from Drive and upsert into the local DB.
    Returns list of book dicts.
    """
    from app.database import upsert_book

    logger.info("Syncing catalog from Drive folder %s", DRIVE_SOURCE_FOLDER_ID)
    try:
        subfolders = await list_drive_subfolders()
    except Exception as e:
        logger.warning("Drive unavailable during catalog sync: %s", e)
        return []

    books = []
    for folder in subfolders:
        parsed = _parse_folder_name(folder["name"])
        book = {
            "id": folder["id"],
            "folder_name": folder["name"],
            "cover_jpg_id": None,
            "cover_cached_path": None,
            "thumbnail_path": None,
            "synced_at": datetime.utcnow().isoformat(),
            **parsed,
        }
        # Try to find the jpg file id now (lightweight metadata call)
        try:
            jpg_id = await get_book_cover_jpg_id(folder["id"])
            book["cover_jpg_id"] = jpg_id
        except Exception as e:
            logger.warning("Could not list files in folder %s: %s", folder["id"], e)

        await upsert_book(book)
        books.append(book)
        logger.debug("Synced book: %s", book["title"])

    logger.info("Catalog sync complete: %d books", len(books))
    return books
