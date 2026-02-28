"""
Book catalog service — loads books from DB (populated by drive.sync_catalog).
"""
import logging
from typing import Any, Dict, List, Optional

from app.database import get_all_books, get_book

logger = logging.getLogger(__name__)


async def list_books() -> List[Dict[str, Any]]:
    """Return all books sorted by number."""
    return await get_all_books()


async def get_book_by_id(book_id: str) -> Optional[Dict[str, Any]]:
    return await get_book(book_id)
