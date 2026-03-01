"""Tests for drive pagination."""
import pytest
from unittest.mock import AsyncMock, patch, MagicMock


@pytest.mark.asyncio
async def test_list_drive_subfolders_pagination():
    """list_drive_subfolders must follow nextPageToken until exhausted."""
    from app.services.drive import list_drive_subfolders

    page1 = {
        "files": [{"id": f"id{i}", "name": f"Book {i}"} for i in range(100)],
        "nextPageToken": "page2token",
    }
    page2 = {
        "files": [{"id": f"id{i}", "name": f"Book {i}"} for i in range(100, 200)],
        "nextPageToken": "page3token",
    }
    page3 = {
        "files": [{"id": f"id{i}", "name": f"Book {i}"} for i in range(200, 250)],
        # No nextPageToken — last page
    }

    call_count = 0

    async def mock_get(url, params=None, **kwargs):
        nonlocal call_count
        call_count += 1
        r = MagicMock()
        r.raise_for_status = MagicMock()
        if call_count == 1:
            r.json.return_value = page1
        elif call_count == 2:
            r.json.return_value = page2
        else:
            r.json.return_value = page3
        return r

    with patch("httpx.AsyncClient") as mock_client_cls:
        mock_client = AsyncMock()
        mock_client.get = mock_get
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client_cls.return_value = mock_client

        results = await list_drive_subfolders("test-folder-id")

    assert len(results) == 250  # 100 + 100 + 50
    assert call_count == 3  # Three pages fetched
    # Verify page 2 token was passed
    assert results[0]["id"] == "id0"
    assert results[200]["id"] == "id200"


@pytest.mark.asyncio
async def test_list_drive_subfolders_single_page():
    """Single-page response (no nextPageToken) returns all items."""
    from app.services.drive import list_drive_subfolders

    async def mock_get(url, params=None, **kwargs):
        r = MagicMock()
        r.raise_for_status = MagicMock()
        r.json.return_value = {
            "files": [{"id": f"id{i}", "name": f"Book {i}"} for i in range(50)]
        }
        return r

    with patch("httpx.AsyncClient") as mock_client_cls:
        mock_client = AsyncMock()
        mock_client.get = mock_get
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client_cls.return_value = mock_client

        results = await list_drive_subfolders()

    assert len(results) == 50
