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


@router.get("/review", response_class=HTMLResponse, include_in_schema=False)
async def review_page():
    return HTMLResponse(content=_read_page("review.html"))


@router.get("/batch", response_class=HTMLResponse, include_in_schema=False)
async def batch_page():
    return HTMLResponse(content=_read_page("batch.html"))


@router.get("/history", response_class=HTMLResponse, include_in_schema=False)
async def history_page():
    return HTMLResponse(content=_read_page("history.html"))


@router.get("/dashboard", response_class=HTMLResponse, include_in_schema=False)
async def dashboard_page():
    return HTMLResponse(content=_read_page("dashboard.html"))


@router.get("/prompts", response_class=HTMLResponse, include_in_schema=False)
async def prompts_page():
    return HTMLResponse(content=_read_page("prompts.html"))


@router.get("/jobs", response_class=HTMLResponse, include_in_schema=False)
async def jobs_page():
    return HTMLResponse(content=_read_page("jobs.html"))


@router.get("/compare", response_class=HTMLResponse, include_in_schema=False)
async def compare_page():
    return HTMLResponse(content=_read_page("compare.html"))


@router.get("/analytics", response_class=HTMLResponse, include_in_schema=False)
async def analytics_page():
    return HTMLResponse(content=_read_page("analytics.html"))


@router.get("/similarity", response_class=HTMLResponse, include_in_schema=False)
async def similarity_page():
    return HTMLResponse(content=_read_page("similarity.html"))


@router.get("/mockups", response_class=HTMLResponse, include_in_schema=False)
async def mockups_page():
    return HTMLResponse(content=_read_page("mockups.html"))


@router.get("/catalogs", response_class=HTMLResponse, include_in_schema=False)
async def catalogs_page():
    return HTMLResponse(content=_read_page("catalogs.html"))


@router.get("/settings", response_class=HTMLResponse, include_in_schema=False)
async def settings_page():
    return HTMLResponse(content=_read_page("settings.html"))


@router.get("/api-docs", response_class=HTMLResponse, include_in_schema=False)
async def api_docs_page():
    return HTMLResponse(content=_read_page("api-docs.html"))
