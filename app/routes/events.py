"""
SSE (Server-Sent Events) routes — stream job progress to the browser.
"""
import asyncio
import json
import logging
from typing import AsyncGenerator

from fastapi import APIRouter
from fastapi.responses import StreamingResponse

from app.config import SSE_HEARTBEAT_INTERVAL
from app.services.jobs import subscribe_job, unsubscribe_job
from app.database import get_job

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/events")


async def _event_generator(job_id: str) -> AsyncGenerator[str, None]:
    """Yield SSE-formatted events for a job until it completes or errors."""
    # Check if job already completed
    job = await get_job(job_id)
    if job and job["status"] in ("completed", "failed", "cancelled"):
        # Immediately send final state and close
        yield _format_sse({"event": job["status"], "job_id": job_id, "status": job["status"]})
        return

    q = subscribe_job(job_id)
    try:
        while True:
            try:
                event = await asyncio.wait_for(q.get(), timeout=SSE_HEARTBEAT_INTERVAL)
                yield _format_sse(event)
                # Close stream when job reaches terminal state
                if event.get("event") in ("completed", "failed", "cancelled"):
                    return
            except asyncio.TimeoutError:
                # Send heartbeat
                yield _format_sse({"event": "heartbeat", "job_id": job_id})
    except asyncio.CancelledError:
        pass
    finally:
        unsubscribe_job(job_id, q)


def _format_sse(data: dict) -> str:
    """Format a dict as an SSE message."""
    payload = json.dumps(data)
    return f"data: {payload}\n\n"


@router.get("/job/{job_id}")
async def job_events(job_id: str):
    """SSE stream for a specific job."""
    return StreamingResponse(
        _event_generator(job_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
