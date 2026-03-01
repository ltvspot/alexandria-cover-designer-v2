"""Tests for OpenRouter provider — modality payloads and 429 retry."""
import pytest
import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

from app.providers.openrouter import OpenRouterProvider, _extract_image_from_response


def test_image_only_model_sends_image_modality():
    """FLUX.2 Pro (image-only) must send modalities: ['image']."""
    p = OpenRouterProvider()
    assert p._get_modality("flux-2-pro") == "image"


def test_both_model_sends_image_text_modality():
    """Nano Banana (both) must send modalities: ['image', 'text']."""
    p = OpenRouterProvider()
    assert p._get_modality("nano-banana") == "both"


def test_nano_banana_pro_is_both():
    p = OpenRouterProvider()
    assert p._get_modality("nano-banana-pro") == "both"


def test_extract_image_format1():
    """Format 1: choices[0].message.images[0].image_url.url"""
    data = {
        "choices": [{
            "message": {
                "images": [{"image_url": {"url": "data:image/png;base64,abc123"}}]
            }
        }]
    }
    result = _extract_image_from_response(data)
    assert result == "data:image/png;base64,abc123"


def test_extract_image_format2():
    """Format 2: content array with image_url type."""
    data = {
        "choices": [{
            "message": {
                "content": [
                    {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,xyz"}}
                ]
            }
        }]
    }
    result = _extract_image_from_response(data)
    assert result == "data:image/jpeg;base64,xyz"


def test_extract_image_format3():
    """Format 3: inline_data type."""
    data = {
        "choices": [{
            "message": {
                "content": [
                    {"inline_data": {"mime_type": "image/png", "data": "base64data"}}
                ]
            }
        }]
    }
    result = _extract_image_from_response(data)
    assert result == "data:image/png;base64,base64data"


def test_extract_image_format4_string():
    """Format 4: string content with embedded data URL."""
    data = {
        "choices": [{
            "message": {
                "content": "Here is your image: data:image/png;base64,AAABBBCCC123="
            }
        }]
    }
    result = _extract_image_from_response(data)
    assert result == "data:image/png;base64,AAABBBCCC123="


def test_extract_image_returns_none_on_empty():
    """Returns None when no image found."""
    data = {"choices": [{"message": {"content": "No image here"}}]}
    result = _extract_image_from_response(data)
    assert result is None


@pytest.mark.asyncio
async def test_429_retry():
    """429 response triggers retry with Retry-After backoff."""
    p = OpenRouterProvider(api_key="test-key")

    call_count = 0

    class MockResponse:
        status_code = 429
        headers = {"Retry-After": "1"}
        def raise_for_status(self): pass
        def json(self): return {}

    class SuccessResponse:
        status_code = 200
        headers = {}
        def raise_for_status(self): pass
        def json(self):
            return {
                "choices": [{
                    "message": {
                        "images": [{"image_url": {"url": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="}}]
                    }
                }],
                "usage": {}
            }

    async def mock_post(*args, **kwargs):
        nonlocal call_count
        call_count += 1
        if call_count < 3:
            return MockResponse()
        return SuccessResponse()

    with patch("httpx.AsyncClient") as mock_client_cls:
        mock_client = AsyncMock()
        mock_client.post = mock_post
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client_cls.return_value = mock_client

        with patch("asyncio.sleep", new_callable=AsyncMock):
            result = await p.generate("test prompt", "nano-banana")

    assert call_count == 3  # Two 429s then success
