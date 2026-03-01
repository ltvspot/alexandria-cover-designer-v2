"""
OpenRouter provider — image generation via /api/v1/chat/completions.
Supports modality-aware payloads (image-only vs image+text models).
Includes 3-attempt retry loop for 429 rate-limit errors.
Includes multi-format response parsing (4 fallback strategies).
"""
import asyncio
import base64
import logging
import re
import time
from typing import Any, Dict, Optional

import httpx

from app.config import OPENROUTER_API_BASE, OPENROUTER_API_KEY, OPENROUTER_MODELS
from app.providers.base import BaseProvider, GenerationResult

logger = logging.getLogger(__name__)

_MODEL_IDS: Dict[str, str] = {
    key: v["openrouter_id"] for key, v in OPENROUTER_MODELS.items()
}
_MODEL_COSTS: Dict[str, float] = {
    key: v["cost_per_image"] for key, v in OPENROUTER_MODELS.items()
}
_MODEL_MODALITY: Dict[str, str] = {
    key: v.get("modality", "both") for key, v in OPENROUTER_MODELS.items()
}


def _decode_data_url(data_url: str) -> bytes:
    """Decode a data:image/...;base64,... URL to raw bytes."""
    if "," in data_url:
        _, b64 = data_url.split(",", 1)
        return base64.b64decode(b64)
    return base64.b64decode(data_url)


def _extract_image_from_response(data: Dict[str, Any]) -> Optional[str]:
    """
    Extract image data URL from OpenRouter response.
    Tries 4 formats in order (ported exactly from static client extractImageFromResponse):
      1. choices[0].message.images[0].image_url.url  (data URL)
      2. Content array with image_url type
      3. Content array with inline_data type
      4. String content with base64 regex match
    Returns a data URL string or None.
    """
    try:
        choice = (data.get("choices") or [None])[0]
        if not choice:
            logger.error("[extractImage] No choices in response")
            return None
        msg = choice.get("message")
        if not msg:
            logger.error("[extractImage] No message in choice")
            return None

        # Format 1: message.images array
        images = msg.get("images", [])
        if images:
            img = images[0]
            if isinstance(img, dict):
                url = (img.get("image_url") or {}).get("url", "")
                if url:
                    return url
                if img.get("url"):
                    return img["url"]
            if isinstance(img, str):
                return img

        # Format 2 & 3: content array
        content = msg.get("content", "")
        if isinstance(content, list):
            for part in content:
                if part.get("type") == "image_url" and part.get("image_url"):
                    return part["image_url"]["url"]
                if part.get("type") == "image" and part.get("image_url"):
                    return part["image_url"]["url"]
                if part.get("inline_data"):
                    idata = part["inline_data"]
                    return f"data:{idata['mime_type']};base64,{idata['data']}"

        # Format 4: string content with embedded base64
        if isinstance(content, str):
            match = re.search(r"(data:image/[^;]+;base64,[A-Za-z0-9+/=]+)", content)
            if match:
                return match.group(1)
            # Raw base64 string
            if re.match(r"^[A-Za-z0-9+/=]{100,}$", content):
                return f"data:image/png;base64,{content}"

        logger.error("[extractImage] Could not find image. msg keys: %s", list(msg.keys()))
        return None
    except Exception as e:
        logger.error("Failed to extract image: %s", e)
        return None


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
        if model_key in _MODEL_IDS:
            return _MODEL_IDS[model_key]
        return model_key

    def _get_cost(self, model_key: str) -> float:
        return _MODEL_COSTS.get(model_key, 0.01)

    def _get_modality(self, model_key: str) -> str:
        return _MODEL_MODALITY.get(model_key, "both")

    async def generate(
        self,
        prompt: str,
        model_id: str = "nano-banana",
        **kwargs,
    ) -> GenerationResult:
        if not self.is_available():
            return GenerationResult(success=False, error="OpenRouter provider not available")

        openrouter_model = self._get_model_id(model_id)
        cost_estimate = self._get_cost(model_id)
        modality = self._get_modality(model_id)
        modalities = ["image"] if modality == "image" else ["image", "text"]

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": "https://alexandria-cover-designer.up.railway.app",
            "X-Title": "Alexandria Cover Designer v2",
        }

        payload: Dict[str, Any] = {
            "model": openrouter_model,
            "modalities": modalities,
            "messages": [
                {
                    "role": "user",
                    "content": [{"type": "text", "text": prompt}],
                }
            ],
        }

        logger.info(
            "Generating image: model=%s modalities=%s",
            openrouter_model, modalities,
        )
        t0 = time.monotonic()

        # 3-attempt retry loop for 429 errors
        for attempt in range(3):
            try:
                async with httpx.AsyncClient(timeout=120) as client:
                    resp = await client.post(
                        f"{self.api_base}/chat/completions",
                        headers=headers,
                        json=payload,
                    )

                    if resp.status_code == 429:
                        retry_after = int(
                            resp.headers.get("Retry-After", 10 * (attempt + 1))
                        )
                        logger.warning(
                            "Rate limited (429); waiting %ds (attempt %d/3)",
                            retry_after, attempt + 1,
                        )
                        await asyncio.sleep(retry_after)
                        continue

                    resp.raise_for_status()
                    data = resp.json()
                    break  # Success — exit retry loop

            except httpx.HTTPStatusError as e:
                if e.response.status_code == 429 and attempt < 2:
                    await asyncio.sleep(10 * (attempt + 1))
                    continue
                logger.error(
                    "OpenRouter HTTP error %s: %s",
                    e.response.status_code, e.response.text[:500],
                )
                return GenerationResult(
                    success=False,
                    error=f"HTTP {e.response.status_code}: {e.response.text[:200]}",
                    model=model_id,
                )
            except Exception as e:
                logger.error("OpenRouter request failed: %s", e)
                return GenerationResult(success=False, error=str(e), model=model_id)
        else:
            return GenerationResult(
                success=False,
                error="Rate limited after 3 attempts",
                model=model_id,
            )

        duration_ms = int((time.monotonic() - t0) * 1000)

        # Parse response — try all 4 formats
        try:
            data_url = _extract_image_from_response(data)
            if not data_url:
                logger.warning(
                    "No image in response from %s. Raw: %s",
                    openrouter_model, str(data)[:500],
                )
                return GenerationResult(
                    success=False,
                    error="No image returned by model — response format unsupported",
                    model=model_id,
                    duration_ms=duration_ms,
                    raw_response=data,
                )

            image_bytes = _decode_data_url(data_url)
            img_format = "png"
            if data_url.startswith("data:image/jpeg") or data_url.startswith("data:image/jpg"):
                img_format = "jpeg"
            elif data_url.startswith("data:image/webp"):
                img_format = "webp"

            usage = data.get("usage", {})
            tokens_in = usage.get("prompt_tokens", 0)
            tokens_out = usage.get("completion_tokens", 0)

            logger.info(
                "Image generated: model=%s bytes=%d duration=%dms",
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

        except Exception as e:
            logger.error(
                "Failed to parse OpenRouter response: %s — %s",
                e, str(data)[:500],
            )
            return GenerationResult(
                success=False,
                error=f"Parse error: {e}",
                model=model_id,
                duration_ms=duration_ms,
                raw_response=data,
            )
