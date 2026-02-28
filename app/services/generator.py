"""
Image generation orchestration service.
"""
import logging
from io import BytesIO
from pathlib import Path
from typing import Optional

from PIL import Image

from app.config import OUTPUTS_DIR
from app.providers.registry import registry
from app.providers.base import GenerationResult

logger = logging.getLogger(__name__)


async def generate_image(
    prompt: str,
    model_id: str,
    job_id: str,
    variant: int = 1,
) -> GenerationResult:
    """
    Call the provider to generate an image.
    On success, saves the raw generated image to disk and returns the result.
    """
    result = await registry.generate(
        prompt=prompt,
        model_id=model_id,
        provider_name="openrouter",
    )

    if result.success and result.image_bytes:
        # Save raw generated image
        ext = result.image_format if result.image_format else "png"
        raw_path = OUTPUTS_DIR / f"{job_id}_raw.{ext}"
        OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)
        raw_path.write_bytes(result.image_bytes)
        logger.info("Saved raw generated image: %s", raw_path)

    return result


def load_image_from_bytes(data: bytes) -> Image.Image:
    """Load a PIL Image from raw bytes."""
    return Image.open(BytesIO(data)).convert("RGBA")
