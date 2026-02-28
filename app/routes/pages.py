"""
HTML page routes — serve the static HTML templates.
"""
from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import HTMLResponse, RedirectResponse

router = APIRouter()

PAGES_DIR = Path(__file__).parent.parent / "static" / "pages"


def _read_page(name: str) -> str:
    path = PAGES_DIR / name
    if path.exists():
        return path.read_text(encoding="utf-8")
    return f"<h1>Page not found: {name}</h1>"


@router.get("/", include_in_schema=False)
async def root():
    return RedirectResponse(url="/iterate")


@router.get("/iterate", response_class=HTMLResponse, include_in_schema=False)
async def iterate_page():
    return HTMLResponse(content=_read_page("iterate.html"))
