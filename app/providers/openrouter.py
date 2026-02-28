"""
OpenRouter provider — image generation via /api/v1/chat/completions
with modalities: ["image", "text"].

Response format:
{
  "choices": [{
    "message": {
      "images": [{"type": "image_url", "image_url": {"url": "data:image/png;base64,..."}}]
    }
  }]
}
"""
import base64
import logging
import time
from typing import Any, Dict, Optional

import httpx

from app.config import OPENROUTER_API_BASE, OPENROUTER_API_KEY, OPENROUTER_MODELS
from app.providers.base import BaseProvider, GenerationResult

logger = logging.getLogger(__name__)

# Map our short names to OpenRouter model IDs
_MODEL_IDS: Dict[str, str] = {
    key: v["openrouter_id"] for key, v in OPENROUTER_MODELS.items()
}
_MODEL_COSTS: Dict[str, float] = {
    key: v["cost_per_image"] for key, v in OPENROUTER_MODELS.items()
}


def _decode_data_url(data_url: str) -> bytes:
    """Decode a data:image/...;base64,... URL to raw bytes."""
    if "," in data_url:
        _, b64 = data_url.split(",", 1)
        return base64.b64decode(b64)
    return base64.b64decode(data_url)


class OpenRouterProvider(BaseProvider):
    name = "openrouter"

    def __init__(
        self,
        api_key: str = OPENROUTER_API_KEY,
        api_base: str = OPENROUTER_API_BASE,
    ):
        self.api_key = api_key
        self.api_base = api_base
        self._available = True

    def is_available(self) -> bool:
        return self._available and bool(self.api_key)

    def _get_model_id(self, model_key: str) -> str:
        """Resolve short key to full OpenRouter model ID."""
        # Accept either short key or full id
        if model_key in _MODEL_IDS:
            return _MODEL_IDS[model_key]
        # If it looks like a full OpenRouter model id, use it directly
        return model_key

    def _get_cost(self, model_key: str) -> float:
        if model_key in _MODEL_COSTS:
            return _MODEL_COSTS[model_key]
        # Default cost estimate
        return 0.01

    async def generate(
        self,
        prompt: str,
        model_id: str = "gemini-2.5-flash-image",
        **kwargs,
    ) -> GenerationResult:
        if not self.is_available():
            return GenerationResult(success=False, error="OpenRouter provider not available")

        openrouter_model = self._get_model_id(model_id)
        cost_estimate = self._get_cost(model_id)

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": "https://alexandria-cover-designer.app",
            "X-Title": "Alexandria Cover Designer",
        }

        payload: Dict[str, Any] = {
            "model": openrouter_model,
            "modalities": ["image", "text"],
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt}
                    ],
                }
            ],
        }

        logger.info("Generating image with OpenRouter model=%s", openrouter_model)
        t0 = time.monotonic()
        try:
            async with httpx.AsyncClient(timeout=120) as client:
                resp = await client.post(
                    f"{self.api_base}/chat/completions",
                    headers=headers,
                    json=payload,
                )
                resp.raise_for_status()
                data = resp.json()

        except httpx.HTTPStatusError as e:
            logger.error("OpenRouter HTTP error %s: %s", e.response.status_code, e.response.text[:500])
            return GenerationResult(
                success=False,
                error=f"HTTP {e.response.status_code}: {e.response.text[:200]}",
                model=model_id,
            )
        except Exception as e:
            logger.error("OpenRouter request failed: %s", e)
            return GenerationResult(success=False, error=str(e), model=model_id)

        duration_ms = int((time.monotonic() - t0) * 1000)

        # Parse response
        try:
            message = data["choices"][0]["message"]
            images = message.get("images", [])
            if not images:
                # Some models might put image in content array too
                content = message.get("content", "")
                logger.warning("No images in response. Content: %s", str(content)[:200])
                return GenerationResult(
                    success=False,
                    error="No images returned by model",
                    model=model_id,
                    duration_ms=duration_ms,
                    raw_response=data,
                )

            # Use first image
            img_obj = images[0]
            url = img_obj.get("image_url", {}).get("url", "")
            if not url:
                return GenerationResult(
                    success=False,
                    error="Empty image URL in response",
                    model=model_id,
                    duration_ms=duration_ms,
                )

            image_bytes = _decode_data_url(url)
            img_format = "png"
            if url.startswith("data:image/jpeg") or url.startswith("data:image/jpg"):
                img_format = "jpeg"
            elif url.startswith("data:image/webp"):
                img_format = "webp"

            # Try to get token usage for cost
            usage = data.get("usage", {})
            tokens_in = usage.get("prompt_tokens", 0)
            tokens_out = usage.get("completion_tokens", 0)

            logger.info(
                "Image generated: model=%s, bytes=%d, duration=%dms",
                openrouter_model, len(image_bytes), duration_ms,
            )
            return GenerationResult(
                success=True,
                image_bytes=image_bytes,
                image_format=img_format,
                model=model_id,
                cost_usd=cost_estimate,
                tokens_in=tokens_in,
                tokens_out=tokens_out,
                duration_ms=duration_ms,
                raw_response=data,
            )

        except (KeyError, IndexError) as e:
            logger.error("Failed to parse OpenRouter response: %s — %s", e, str(data)[:500])
            return GenerationResult(
                success=False,
                error=f"Parse error: {e}",
                model=model_id,
                duration_ms=duration_ms,
                raw_response=data,
            )
