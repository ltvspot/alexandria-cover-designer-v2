"""
Tests for image generation providers.
"""
import asyncio
import base64
import json
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from app.providers.base import GenerationResult
from app.providers.openrouter import OpenRouterProvider, _decode_data_url
from app.providers.registry import CircuitBreaker, ProviderRegistry


# ─── _decode_data_url ─────────────────────────────────────────────────────────

def test_decode_data_url_with_prefix():
    raw = b"hello world"
    encoded = base64.b64encode(raw).decode()
    data_url = f"data:image/png;base64,{encoded}"
    assert _decode_data_url(data_url) == raw


def test_decode_data_url_plain_base64():
    raw = b"test bytes"
    encoded = base64.b64encode(raw).decode()
    assert _decode_data_url(encoded) == raw


# ─── CircuitBreaker ──────────────────────────────────────────────────────────

def test_circuit_breaker_opens_after_threshold():
    cb = CircuitBreaker(failure_threshold=3, reset_timeout=60)
    assert not cb.is_open
    cb.record_failure()
    cb.record_failure()
    assert not cb.is_open
    cb.record_failure()
    assert cb.is_open


def test_circuit_breaker_resets_on_success():
    cb = CircuitBreaker(failure_threshold=2, reset_timeout=60)
    cb.record_failure()
    cb.record_failure()
    assert cb.is_open
    # Simulate time passing by manually resetting
    cb._opened_at = 0  # forces reset_timeout to expire
    assert not cb.is_open  # auto-resets
    cb.record_success()
    assert cb._failures == 0


def test_circuit_breaker_auto_resets_after_timeout():
    import time
    cb = CircuitBreaker(failure_threshold=2, reset_timeout=0.01)
    cb.record_failure()
    cb.record_failure()
    assert cb.is_open
    time.sleep(0.05)
    assert not cb.is_open  # auto-reset after timeout


# ─── OpenRouterProvider ──────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_openrouter_success():
    """Test that a valid response is parsed correctly."""
    provider = OpenRouterProvider(api_key="test-key")

    # Build a minimal fake response
    fake_png = base64.b64encode(b"\x89PNG\r\n").decode()
    fake_resp = {
        "choices": [{
            "message": {
                "content": "Here is your image.",
                "images": [{
                    "type": "image_url",
                    "image_url": {"url": f"data:image/png;base64,{fake_png}"}
                }]
            }
        }],
        "usage": {"prompt_tokens": 50, "completion_tokens": 0},
    }

    with patch("httpx.AsyncClient") as mock_client_cls:
        mock_resp = MagicMock()
        mock_resp.raise_for_status = MagicMock()
        mock_resp.json = MagicMock(return_value=fake_resp)

        mock_client = AsyncMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client.post = AsyncMock(return_value=mock_resp)
        mock_client_cls.return_value = mock_client

        result = await provider.generate("Draw a cat", "gemini-2.5-flash-image")

    assert result.success is True
    assert result.image_bytes == base64.b64decode(fake_png)
    assert result.image_format == "png"
    assert result.model == "gemini-2.5-flash-image"


@pytest.mark.asyncio
async def test_openrouter_no_images_in_response():
    provider = OpenRouterProvider(api_key="test-key")
    fake_resp = {
        "choices": [{
            "message": {
                "content": "I cannot generate images.",
                "images": []
            }
        }]
    }

    with patch("httpx.AsyncClient") as mock_client_cls:
        mock_resp = MagicMock()
        mock_resp.raise_for_status = MagicMock()
        mock_resp.json = MagicMock(return_value=fake_resp)

        mock_client = AsyncMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client.post = AsyncMock(return_value=mock_resp)
        mock_client_cls.return_value = mock_client

        result = await provider.generate("Draw a cat", "gemini-2.5-flash-image")

    assert result.success is False
    assert "No images" in result.error


def test_provider_not_available_without_key():
    provider = OpenRouterProvider(api_key="")
    assert not provider.is_available()


# ─── ProviderRegistry ─────────────────────────────────────────────────────────

def test_registry_get_provider():
    reg = ProviderRegistry()
    p = reg.get_provider("openrouter")
    assert p is not None
    assert p.name == "openrouter"


def test_registry_unknown_provider():
    reg = ProviderRegistry()
    p = reg.get_provider("nonexistent")
    assert p is None
