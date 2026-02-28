"""
Compositing pipeline — places the AI-generated illustration into the
circular medallion on the source book cover.

Cover spec:
  - 3784 × 2777 JPEG, 300 DPI
  - Landscape wraparound: left=back, center=spine, right=front
  - Medallion default center: (2850, 1350), radius: 520 px
  - Feathered edge: 15 px Gaussian blur on alpha mask
  - Color-match: sample surrounding pixels, adjust ±20%
"""
import logging
from io import BytesIO
from pathlib import Path
from typing import Optional, Tuple

import numpy as np
from PIL import Image, ImageFilter

from app.config import (
    COVER_DPI,
    COVER_HEIGHT,
    COVER_WIDTH,
    MEDALLION_CENTER_X,
    MEDALLION_CENTER_Y,
    MEDALLION_FEATHER,
    MEDALLION_RADIUS,
    OUTPUTS_DIR,
)

logger = logging.getLogger(__name__)


# ─── Mask helpers ─────────────────────────────────────────────────────────────

def _make_circle_mask(size: Tuple[int, int], radius: int, feather: int) -> Image.Image:
    """
    Create a circular alpha mask (white circle on black) of the given size,
    with feathered edges produced by a Gaussian blur.
    size = (width, height) of the bounding box (typically 2*radius × 2*radius)
    """
    mask = Image.new("L", size, 0)
    # Draw filled white circle
    from PIL import ImageDraw
    draw = ImageDraw.Draw(mask)
    cx, cy = size[0] // 2, size[1] // 2
    draw.ellipse(
        [cx - radius, cy - radius, cx + radius, cy + radius],
        fill=255,
    )
    if feather > 0:
        mask = mask.filter(ImageFilter.GaussianBlur(radius=feather))
    return mask


# ─── Color matching ───────────────────────────────────────────────────────────

def _sample_surround(cover: Image.Image, cx: int, cy: int, radius: int) -> Tuple[float, float, float]:
    """
    Sample pixels in a ring around the medallion (radius to radius+40px)
    and return average (R, G, B).
    """
    arr = np.array(cover.convert("RGB"), dtype=np.float32)
    h, w = arr.shape[:2]

    # Build coordinate grids
    ys, xs = np.mgrid[0:h, 0:w]
    dist = np.sqrt((xs - cx) ** 2 + (ys - cy) ** 2)

    ring_mask = (dist >= radius) & (dist <= radius + 40)
    if ring_mask.sum() == 0:
        return 128.0, 128.0, 128.0

    pixels = arr[ring_mask]
    return float(pixels[:, 0].mean()), float(pixels[:, 1].mean()), float(pixels[:, 2].mean())


def _color_match(
    generated: Image.Image,
    target_rgb: Tuple[float, float, float],
    max_shift: float = 0.20,
) -> Image.Image:
    """
    Adjust the generated image's color balance so its average RGB approaches
    the target by up to max_shift (20%) per channel.
    """
    arr = np.array(generated.convert("RGB"), dtype=np.float32)
    gen_mean = arr.reshape(-1, 3).mean(axis=0)  # (R, G, B)
    target = np.array(target_rgb, dtype=np.float32)

    # Compute desired shift clamped to ±max_shift
    shift = target - gen_mean
    clamp = gen_mean * max_shift
    shift = np.clip(shift, -clamp, clamp)

    adjusted = np.clip(arr + shift, 0, 255).astype(np.uint8)
    return Image.fromarray(adjusted, "RGB")


# ─── Main compositing function ─────────────────────────────────────────────────

def composite(
    cover_path: Path,
    generated_image_bytes: bytes,
    job_id: str,
    center_x: int = MEDALLION_CENTER_X,
    center_y: int = MEDALLION_CENTER_Y,
    radius: int = MEDALLION_RADIUS,
    feather: int = MEDALLION_FEATHER,
) -> Path:
    """
    Composite the AI-generated illustration into the circular medallion.

    Returns the path to the composited output JPEG.
    Raises ValueError if the cover dimensions don't match expectations.
    """
    OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUTPUTS_DIR / f"{job_id}_composited.jpg"

    # ── Load source cover ──────────────────────────────────────────────────────
    cover = Image.open(cover_path).convert("RGBA")
    if cover.size != (COVER_WIDTH, COVER_HEIGHT):
        # Resize to expected dimensions if needed (shouldn't happen but safe)
        logger.warning(
            "Cover size %s differs from expected %sx%s; resizing",
            cover.size, COVER_WIDTH, COVER_HEIGHT,
        )
        cover = cover.resize((COVER_WIDTH, COVER_HEIGHT), Image.LANCZOS)

    # ── Load generated illustration ───────────────────────────────────────────
    generated = Image.open(BytesIO(generated_image_bytes)).convert("RGB")

    # ── Crop generated image to a square, then resize to circle bounding box ──
    diameter = radius * 2
    gen_w, gen_h = generated.size
    # Square-crop from center
    min_dim = min(gen_w, gen_h)
    left = (gen_w - min_dim) // 2
    top = (gen_h - min_dim) // 2
    generated = generated.crop((left, top, left + min_dim, top + min_dim))
    generated = generated.resize((diameter, diameter), Image.LANCZOS)

    # ── Color match ────────────────────────────────────────────────────────────
    target_rgb = _sample_surround(cover.convert("RGB"), center_x, center_y, radius)
    generated = _color_match(generated, target_rgb)

    # ── Create feathered circular mask ─────────────────────────────────────────
    mask = _make_circle_mask((diameter, diameter), radius, feather)

    # ── Convert generated to RGBA with mask ────────────────────────────────────
    gen_rgba = generated.convert("RGBA")
    gen_rgba.putalpha(mask)

    # ── Paste into cover ──────────────────────────────────────────────────────
    paste_x = center_x - radius
    paste_y = center_y - radius
    cover.alpha_composite(gen_rgba, dest=(paste_x, paste_y))

    # ── Validate output ───────────────────────────────────────────────────────
    assert cover.size == (COVER_WIDTH, COVER_HEIGHT), (
        f"Output size {cover.size} != expected ({COVER_WIDTH}, {COVER_HEIGHT})"
    )

    # ── Save at 300 DPI, quality 95 ──────────────────────────────────────────
    cover_rgb = cover.convert("RGB")
    cover_rgb.save(out_path, "JPEG", quality=95, dpi=(COVER_DPI, COVER_DPI))

    logger.info("Composited cover saved: %s (%d bytes)", out_path, out_path.stat().st_size)
    return out_path


def make_output_thumbnail(composited_path: Path, job_id: str) -> Optional[Path]:
    """Create a small preview thumbnail of the composited cover."""
    from app.config import THUMBNAILS_DIR, THUMBNAIL_SIZE
    THUMBNAILS_DIR.mkdir(parents=True, exist_ok=True)
    dest = THUMBNAILS_DIR / f"{job_id}_result_thumb.jpg"
    try:
        with Image.open(composited_path) as img:
            img.thumbnail(THUMBNAIL_SIZE, Image.LANCZOS)
            img.save(dest, "JPEG", quality=85)
        return dest
    except Exception as e:
        logger.error("Thumbnail creation failed: %s", e)
        return None
