"""Tests for job processing — two-pass retry and heartbeat."""
import asyncio
import pytest
from unittest.mock import AsyncMock, MagicMock, patch


@pytest.mark.asyncio
async def test_heartbeat_emits_events():
    """_heartbeat should emit events at the given interval."""
    from app.services.jobs import _heartbeat, _emit

    emitted = []
    with patch("app.services.jobs._emit", side_effect=lambda jid, ev: emitted.append(ev)):
        task = asyncio.ensure_future(_heartbeat("test-job-id", interval=0.05))
        await asyncio.sleep(0.18)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    # Should have emitted ~3 heartbeats in 0.18s with 0.05s interval
    heartbeats = [e for e in emitted if e.get("event") == "heartbeat"]
    assert len(heartbeats) >= 2


def test_retry_threshold():
    """RETRY_THRESHOLD must be 0.35 (matching static client)."""
    from app.services.jobs import RETRY_THRESHOLD
    assert RETRY_THRESHOLD == 0.35


def test_max_retries():
    """MAX_RETRIES must be 2 (matching static client JobQueue.MAX_RETRIES)."""
    from app.services.jobs import MAX_RETRIES
    assert MAX_RETRIES == 2
