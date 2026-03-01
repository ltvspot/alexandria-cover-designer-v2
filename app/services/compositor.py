"""
Compositor v8 — source-template overlay pipeline.

Design goal:
Keep ornamental medallion frame 100% intact while replacing inner artwork.

Pipeline:
  1) Build or load a per-cover RGBA template with a transparent medallion center.
  2) Render generated illustration behind template on a navy background.
  3) Alpha-composite the template on top.

Because frame pixels are topmost opaque pixels from the source cover,
illustration bleed over scrollwork is prevented by construction.
"""

from __future__ import annotations

import logging
import math
from io import BytesIO
from pathlib import Path
from typing import Optional, Tuple

import numpy as np
from PIL import Image, ImageDraw

from app.config import (
    COVER_DPI,
    COVER_HEIGHT,
    COVER_WIDTH,
    MEDALLION_CENTER_X,
    MEDALLION_CENTER_Y,
    MEDALLION_ILLUSTRATION_OVERFILL_PX,
    MEDALLION_INNER_RADIUS,
    MEDALLION_RADIUS,
    MEDALLION_TEMPLATE_FEATHER_PX,
    OUTPUTS_DIR,
    TEMPLATES_DIR,
)

logger = logging.getLogger(__name__)

# Back-compat constants (legacy callers/tests reference these names)
ILLUSTRATION_RATIO = 1.24
PUNCH_RATIO = 1.26
RING_WIDTH = 14

# v8 constants
TEMPLATE_CACHE_VERSION = "v8"
INNER_RADIUS_FROM_OUTER_RATIO = 420.0 / 520.0
INNER_RADIUS_MIN = 280
INNER_RADIUS_MAX = 460
DEFAULT_INNER_RADIUS = MEDALLION_INNER_RADIUS
DEFAULT_TEMPLATE_FEATHER = MEDALLION_TEMPLATE_FEATHER_PX
DEFAULT_ILLUSTRATION_OVERFILL = MEDALLION_ILLUSTRATION_OVERFILL_PX


def _clamp(v: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, v))


def _derive_inner_radius(radius: int) -> int:
    """
    Backwards compatibility:
    - Historical pipeline passed outer medallion radius (~520)
    - Template pipeline needs inner opening radius (~350)
    """
    r = int(radius)
    if r <= INNER_RADIUS_MAX:
        return _clamp(r, INNER_RADIUS_MIN, INNER_RADIUS_MAX)
    derived = int(round(r * INNER_RADIUS_FROM_OUTER_RATIO))
    return _clamp(derived, INNER_RADIUS_MIN, INNER_RADIUS_MAX)


def _find_energy_center(img: Image.Image) -> Tuple[float, float]:
    """Compute detail center from gradient-energy center of mass (normalized 0..1)."""
    size = 150
    small = img.convert("RGB").resize((size, size), Image.LANCZOS)
    arr = np.array(small, dtype=np.float32)

    energy = np.zeros((size, size), dtype=np.float32)
    for y in range(1, size - 1):
        for x in range(1, size - 1):
            gx = (np.abs(arr[y, x] - arr[y, x + 1]) + np.abs(arr[y, x + 1] - arr[y, x - 1])).sum() / 6.0
            gy = (np.abs(arr[y, x] - arr[y + 1, x]) + np.abs(arr[y + 1, x] - arr[y - 1, x])).sum() / 6.0
            energy[y, x] = (gx + gy) / 2.0

    kernel = np.array([[1, 2, 1], [2, 4, 2], [1, 2, 1]], dtype=np.float32) / 16.0
    try:
        from scipy.ndimage import convolve

        blurred = convolve(energy, kernel, mode="reflect")
    except Exception:  # pragma: no cover
        padded = np.pad(energy, ((1, 1), (1, 1)), mode="reflect")
        blurred = (
            padded[:-2, :-2] * kernel[0, 0]
            + padded[:-2, 1:-1] * kernel[0, 1]
            + padded[:-2, 2:] * kernel[0, 2]
            + padded[1:-1, :-2] * kernel[1, 0]
            + padded[1:-1, 1:-1] * kernel[1, 1]
            + padded[1:-1, 2:] * kernel[1, 2]
            + padded[2:, :-2] * kernel[2, 0]
            + padded[2:, 1:-1] * kernel[2, 1]
            + padded[2:, 2:] * kernel[2, 2]
        )

    total_w = float(blurred.sum())
    if total_w == 0:
        return 0.5, 0.5

    ys, xs = np.mgrid[0:size, 0:size]
    cx = float((xs * blurred).sum() / total_w) / size
    cy = float((ys * blurred).sum() / total_w) / size
    return cx, cy


def _smart_square_crop(img: Image.Image, crop_center: Tuple[float, float], diameter: int) -> Image.Image:
    """Center on energy hotspot, crop to square, resize to diameter x diameter."""
    cx_norm, cy_norm = crop_center
    cx_norm = max(0.2, min(0.8, cx_norm))
    cy_norm = max(0.2, min(0.8, cy_norm))

    img_w, img_h = img.size
    src_side = min(img_w, img_h)

    src_x = int(cx_norm * img_w - src_side / 2)
    src_y = int(cy_norm * img_h - src_side / 2)
    src_x = max(0, min(img_w - src_side, src_x))
    src_y = max(0, min(img_h - src_side, src_y))

    cropped = img.crop((src_x, src_y, src_x + src_side, src_y + src_side))
    return cropped.resize((diameter, diameter), Image.LANCZOS)


def _sample_background_color(cover: Image.Image, cx: int, cy: int) -> Tuple[int, int, int]:
    """Sample a navy-like background color around medallion region."""
    size = 100
    W, H = cover.size
    small = cover.convert("RGB").resize((size, size), Image.LANCZOS)
    arr = np.array(small, dtype=np.uint8)

    s_cx = int(cx / W * size)
    s_cy = int(cy / H * size)
    points = [
        (s_cx, 5),
        (s_cx, size - 5),
        (min(size - 5, s_cx + 30), s_cy),
        (max(5, s_cx - 30), s_cy),
    ]

    samples = []
    for px, py in points:
        px = max(0, min(size - 1, px))
        py = max(0, min(size - 1, py))
        r, g, b = int(arr[py, px, 0]), int(arr[py, px, 1]), int(arr[py, px, 2])
        samples.append((r, g, b, r + g + b))

    samples.sort(key=lambda x: x[3])
    r, g, b, _ = samples[0]
    return (r, g, b)


def _build_template_alpha(
    canvas_size: Tuple[int, int],
    cx: int,
    cy: int,
    inner_radius: int,
    feather_px: int,
) -> np.ndarray:
    """
    Build template alpha where center is transparent and outside is opaque.

    Uses a narrow feather transition around inner radius to avoid hard seams.
    """
    W, H = canvas_size
    ys, xs = np.mgrid[0:H, 0:W]
    dists = np.sqrt((xs - cx) ** 2 + (ys - cy) ** 2)

    alpha = np.ones((H, W), dtype=np.float32)
    f = max(0, int(feather_px))
    inner = max(1, int(inner_radius))

    if f == 0:
        alpha[dists < inner] = 0.0
    else:
        alpha[dists < (inner - f)] = 0.0
        band = (dists >= (inner - f)) & (dists <= (inner + f))
        alpha[band] = np.clip((dists[band] - (inner - f)) / (2.0 * f), 0.0, 1.0)

    return (alpha * 255.0).astype(np.uint8)


def _create_cover_template(
    cover_rgba: Image.Image,
    cx: int,
    cy: int,
    inner_radius: int,
    feather_px: int,
) -> Image.Image:
    arr = np.array(cover_rgba.convert("RGBA"), dtype=np.uint8)
    arr[:, :, 3] = _build_template_alpha(cover_rgba.size, cx, cy, inner_radius, feather_px)
    return Image.fromarray(arr, mode="RGBA")


def _template_cache_path(
    cover_path: Path,
    center_x: int,
    center_y: int,
    inner_radius: int,
    feather_px: int,
) -> Path:
    return TEMPLATES_DIR / (
        f"{cover_path.stem}_cx{center_x}_cy{center_y}_"
        f"ir{inner_radius}_f{feather_px}_{TEMPLATE_CACHE_VERSION}.png"
    )


def _template_cache_looks_valid(template: Image.Image, cx: int, cy: int, inner_radius: int) -> bool:
    if template.mode != "RGBA":
        return False

    alpha = np.array(template.split()[-1], dtype=np.uint8)
    if not (0 <= cx < alpha.shape[1] and 0 <= cy < alpha.shape[0]):
        return False

    if alpha[cy, cx] > 16:
        return False
    if alpha[10, 10] < 240:
        return False

    transparent = alpha < 16
    area = int(transparent.sum())
    expected = math.pi * (inner_radius ** 2)
    if area < expected * 0.75 or area > expected * 1.35:
        return False
    return True


def _flatten_generated_alpha(generated_rgba: Image.Image, bg_color: Tuple[int, int, int]) -> Image.Image:
    """Flatten transparent provider outputs onto navy background color."""
    img = generated_rgba.convert("RGBA")
    alpha = img.split()[-1]
    mn, mx = alpha.getextrema()
    if mn == 255 and mx == 255:
        return img

    bg = Image.new("RGBA", img.size, bg_color + (255,))
    bg.alpha_composite(img)
    return bg


def _get_or_create_template(
    cover_rgba: Image.Image,
    cover_path: Optional[Path],
    center_x: int,
    center_y: int,
    inner_radius: int,
    feather_px: int,
) -> Image.Image:
    template = _create_cover_template(cover_rgba, center_x, center_y, inner_radius, feather_px)

    if not cover_path:
        return template

    try:
        TEMPLATES_DIR.mkdir(parents=True, exist_ok=True)
        cache_path = _template_cache_path(cover_path, center_x, center_y, inner_radius, feather_px)

        if cache_path.exists():
            cached = Image.open(cache_path).convert("RGBA")
            if cached.size == cover_rgba.size and _template_cache_looks_valid(cached, center_x, center_y, inner_radius):
                return cached
            logger.warning("Template cache invalid, regenerating: %s", cache_path)

        template.save(cache_path, "PNG", optimize=True)
    except Exception as e:  # pragma: no cover
        logger.warning("Template cache write/read failed for %s: %s", cover_path, e)

    return template


def _build_circular_illustration_layer(
    generated_rgba: Image.Image,
    canvas_size: Tuple[int, int],
    center_x: int,
    center_y: int,
    draw_radius: int,
    bg_color: Tuple[int, int, int],
) -> Image.Image:
    W, H = canvas_size
    prepared = _flatten_generated_alpha(generated_rgba, bg_color)

    diameter = max(2, draw_radius * 2)
    crop_center = _find_energy_center(prepared)
    cropped = _smart_square_crop(prepared, crop_center, diameter)

    raw_layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    raw_layer.paste(cropped, (center_x - draw_radius, center_y - draw_radius))

    circle_mask = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(circle_mask)
    d.ellipse(
        [
            center_x - draw_radius,
            center_y - draw_radius,
            center_x + draw_radius,
            center_y + draw_radius,
        ],
        fill=255,
    )

    clipped = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    return Image.composite(raw_layer, clipped, circle_mask)


def _template_composite_image(
    cover_rgba: Image.Image,
    generated_rgba: Image.Image,
    center_x: int,
    center_y: int,
    radius: int,
    cover_path: Optional[Path] = None,
) -> Image.Image:
    """Core in-memory compositor for tests and runtime."""
    W, H = cover_rgba.size

    inner_radius = _derive_inner_radius(radius)
    feather_px = max(0, int(DEFAULT_TEMPLATE_FEATHER))
    draw_radius = inner_radius + max(0, int(DEFAULT_ILLUSTRATION_OVERFILL))

    bg_color = _sample_background_color(cover_rgba, center_x, center_y)
    result = Image.new("RGBA", (W, H), bg_color + (255,))

    illustration_layer = _build_circular_illustration_layer(
        generated_rgba=generated_rgba,
        canvas_size=(W, H),
        center_x=center_x,
        center_y=center_y,
        draw_radius=draw_radius,
        bg_color=bg_color,
    )
    result.alpha_composite(illustration_layer)

    template = _get_or_create_template(
        cover_rgba=cover_rgba,
        cover_path=cover_path,
        center_x=center_x,
        center_y=center_y,
        inner_radius=inner_radius,
        feather_px=feather_px,
    )
    result.alpha_composite(template)

    return result


# Backwards-compatible alias retained for test/tooling imports.
def _overlay_composite_image(
    cover_rgba: Image.Image,
    generated_rgba: Image.Image,
    center_x: int,
    center_y: int,
    radius: int,
    cover_path: Optional[Path] = None,
) -> Image.Image:
    return _template_composite_image(
        cover_rgba=cover_rgba,
        generated_rgba=generated_rgba,
        center_x=center_x,
        center_y=center_y,
        radius=radius,
        cover_path=cover_path,
    )


def composite_v3(
    cover_path: Path,
    generated_image_bytes: bytes,
    job_id: str,
    center_x: int = MEDALLION_CENTER_X,
    center_y: int = MEDALLION_CENTER_Y,
    radius: int = MEDALLION_RADIUS,
) -> Path:
    """Composite generated art into cover while preserving ornamental frame."""
    cover_path = Path(cover_path)
    OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUTPUTS_DIR / f"{job_id}_composited.jpg"

    cover = Image.open(cover_path).convert("RGBA")
    if cover.size != (COVER_WIDTH, COVER_HEIGHT):
        logger.warning("Cover size %s differs from expected; resizing", cover.size)
        cover = cover.resize((COVER_WIDTH, COVER_HEIGHT), Image.LANCZOS)

    generated = Image.open(BytesIO(generated_image_bytes)).convert("RGBA")
    result = _template_composite_image(
        cover_rgba=cover,
        generated_rgba=generated,
        center_x=center_x,
        center_y=center_y,
        radius=radius,
        cover_path=cover_path,
    )

    result.convert("RGB").save(out_path, "JPEG", quality=95, dpi=(COVER_DPI, COVER_DPI))

    logger.info(
        "Compositor v8 saved: %s (%d bytes, inner_r=%d, feather=%d, overfill=%d, cache=%s)",
        out_path,
        out_path.stat().st_size,
        _derive_inner_radius(radius),
        DEFAULT_TEMPLATE_FEATHER,
        DEFAULT_ILLUSTRATION_OVERFILL,
        TEMPLATE_CACHE_VERSION,
    )
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


def composite(
    cover_path: Path,
    generated_image_bytes: bytes,
    job_id: str,
    center_x: int = MEDALLION_CENTER_X,
    center_y: int = MEDALLION_CENTER_Y,
    radius: int = MEDALLION_RADIUS,
    feather: int = 0,
) -> Path:
    """Backwards-compatible alias."""
    return composite_v3(
        cover_path=cover_path,
        generated_image_bytes=generated_image_bytes,
        job_id=job_id,
        center_x=center_x,
        center_y=center_y,
        radius=radius,
    )
