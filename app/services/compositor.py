"""
Compositor v7 — frame-first overlay pipeline (bleed-safe by construction).

Why this exists:
The ornamental medallion frame must remain intact. Prior geometric punch/clip
approaches can drift and let generated art bleed into scrollwork.

New pipeline:
  1) Render generated artwork on a background layer.
  2) Build an RGBA overlay from the original cover where the medallion opening is transparent.
  3) Composite overlay on top of generated layer.

Because frame pixels are literally drawn on top, artwork cannot overlap ornaments.
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
    MEDALLION_RADIUS,
    OVERLAYS_DIR,
    OUTPUTS_DIR,
)

logger = logging.getLogger(__name__)

# Back-compat constants (legacy compositor versions referenced these names)
ILLUSTRATION_RATIO = 1.24
PUNCH_RATIO = 1.26
RING_WIDTH = 14

# v7 constants
OVERLAY_BASE_OUTER_RADIUS = 520.0
OVERLAY_FILL_RATIO = 1.35
OPENING_MASK_SAMPLES = 1080
OPENING_MASK_SUPERSAMPLE = 4
OPENING_MASK_SAFETY_PX = 10.0
OVERLAY_CACHE_VERSION = "v7"

# cached overlay sanity guardrails (reject stale/broken overlays)
OVERLAY_MIN_AREA_FACTOR = 1.20
OVERLAY_MAX_AREA_FACTOR = 3.80
OVERLAY_CENTER_TOLERANCE_FACTOR = 0.18


def _build_opening_mask(canvas_size: Tuple[int, int], cx: int, cy: int, outer_radius: int) -> Image.Image:
    return _build_parametric_opening_mask(
        canvas_size,
        cx,
        cy,
        outer_radius,
        samples=OPENING_MASK_SAMPLES,
        supersample=OPENING_MASK_SUPERSAMPLE,
        safety_px=OPENING_MASK_SAFETY_PX,
    )


def _find_energy_center(img: Image.Image) -> Tuple[float, float]:
    """
    Compute detail center from gradient-energy center of mass (normalized 0..1).
    """
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
    """
    Center on energy hotspot, crop to square, resize to diameter×diameter.
    """
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
    """
    Sample a navy-like background color around the medallion region.
    """
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


def _make_circle_mask_full(canvas_size: Tuple[int, int], cx: int, cy: int, radius: int) -> Image.Image:
    mask = Image.new("L", canvas_size, 0)
    draw = ImageDraw.Draw(mask)
    draw.ellipse([cx - radius, cy - radius, cx + radius, cy + radius], fill=255)
    return mask


def _angle_delta(a: float, b: float) -> float:
    """Smallest signed angular difference a-b in [-pi, pi]."""
    return (a - b + math.pi) % (2 * math.pi) - math.pi


def _opening_radius(theta: float, outer_radius: float) -> float:
    """
    Parametric opening model from the bleeding report appendix.
    Scaled to the current detected medallion outer radius.
    """
    s = outer_radius / OVERLAY_BASE_OUTER_RADIUS

    d_top = _angle_delta(theta, 3 * math.pi / 2)
    d_bottom = _angle_delta(theta, math.pi / 2)
    d_right = _angle_delta(theta, 0.0)
    d_left = _angle_delta(theta, math.pi)

    r = (
        420.0
        - 70.0 * math.exp(-(d_top * d_top) / 0.09)
        + 30.0 * math.exp(-(d_bottom * d_bottom) / 0.16)
        - 15.0 * math.exp(-(d_right * d_right) / 0.04)
        - 15.0 * math.exp(-(d_left * d_left) / 0.04)
        - 15.0 * math.cos(2.0 * theta)
    )
    return max(220.0 * s, r * s)


def _build_parametric_opening_mask(
    canvas_size: Tuple[int, int],
    cx: int,
    cy: int,
    outer_radius: int,
    samples: int = OPENING_MASK_SAMPLES,
    supersample: int = OPENING_MASK_SUPERSAMPLE,
    safety_px: float = OPENING_MASK_SAFETY_PX,
) -> Image.Image:
    """
    Build an anti-aliased alpha mask for the medallion opening.
    White (255) = opening area where generated art should remain visible.
    """
    W, H = canvas_size
    ss = max(1, int(supersample))
    mask_hr = Image.new("L", (W * ss, H * ss), 0)
    draw_hr = ImageDraw.Draw(mask_hr)

    pts = []
    for i in range(samples):
        theta = (2.0 * math.pi * i) / samples
        r = max(1.0, _opening_radius(theta, float(outer_radius)) - float(safety_px))
        x = cx + r * math.cos(theta)
        y = cy + r * math.sin(theta)
        pts.append((x * ss, y * ss))

    draw_hr.polygon(pts, fill=255)

    if ss > 1:
        return mask_hr.resize((W, H), Image.LANCZOS)
    return mask_hr


def _build_cover_overlay(cover_rgba: Image.Image, opening_mask: Image.Image) -> Image.Image:
    """
    Return RGBA overlay where the opening is transparent and everything else is opaque cover pixels.
    """
    overlay = cover_rgba.copy().convert("RGBA")
    # opening_mask: 255 inside opening, 0 outside
    alpha = Image.eval(opening_mask, lambda p: 255 - p)
    overlay.putalpha(alpha)
    return overlay


def _overlay_cache_path(cover_path: Path, center_x: int, center_y: int, radius: int) -> Path:
    return OVERLAYS_DIR / f"{cover_path.stem}_cx{center_x}_cy{center_y}_r{radius}_{OVERLAY_CACHE_VERSION}.png"


def _overlay_cache_looks_valid(overlay: Image.Image, cx: int, cy: int, radius: int) -> bool:
    """Reject stale overlays with obviously broken transparent regions."""
    if overlay.mode != "RGBA":
        return False

    alpha = np.array(overlay.split()[-1], dtype=np.uint8)
    transparent = alpha < 16
    area = int(transparent.sum())
    if area <= 0:
        return False

    min_area = int(math.pi * (radius ** 2) * OVERLAY_MIN_AREA_FACTOR)
    max_area = int(math.pi * (radius ** 2) * OVERLAY_MAX_AREA_FACTOR)
    if area < min_area or area > max_area:
        return False

    ys, xs = np.where(transparent)
    if xs.size == 0:
        return False
    cx_t = float(xs.mean())
    cy_t = float(ys.mean())
    tol = max(20.0, radius * OVERLAY_CENTER_TOLERANCE_FACTOR)
    if abs(cx_t - cx) > tol or abs(cy_t - cy) > tol:
        return False
    return True


def _flatten_generated_alpha(generated_rgba: Image.Image, bg_color: Tuple[int, int, int]) -> Image.Image:
    """
    Some providers return transparent PNG cutouts. Flatten onto the sampled
    background color so the medallion area is always fully painted.
    """
    img = generated_rgba.convert("RGBA")
    alpha = img.split()[-1]
    mn, mx = alpha.getextrema()
    if mn == 255 and mx == 255:
        return img
    bg = Image.new("RGBA", img.size, bg_color + (255,))
    bg.alpha_composite(img)
    return bg


def _get_or_create_cover_overlay(
    cover_rgba: Image.Image,
    cover_path: Optional[Path],
    center_x: int,
    center_y: int,
    radius: int,
    opening_mask: Optional[Image.Image] = None,
) -> Image.Image:
    if opening_mask is None:
        opening_mask = _build_opening_mask(cover_rgba.size, center_x, center_y, radius)
    overlay = _build_cover_overlay(cover_rgba, opening_mask)

    if not cover_path:
        return overlay

    try:
        OVERLAYS_DIR.mkdir(parents=True, exist_ok=True)
        cache_path = _overlay_cache_path(cover_path, center_x, center_y, radius)
        if cache_path.exists():
            cached = Image.open(cache_path).convert("RGBA")
            if cached.size == cover_rgba.size and _overlay_cache_looks_valid(cached, center_x, center_y, radius):
                return cached
            logger.warning("Overlay cache invalid, regenerating: %s", cache_path)

        overlay.save(cache_path, "PNG", optimize=True)
    except Exception as e:  # pragma: no cover
        logger.warning("Overlay cache write/read failed for %s: %s", cover_path, e)

    return overlay


def _overlay_composite_image(
    cover_rgba: Image.Image,
    generated_rgba: Image.Image,
    center_x: int,
    center_y: int,
    radius: int,
    cover_path: Optional[Path] = None,
) -> Image.Image:
    """
    Core in-memory compositor for tests and runtime.
    """
    W, H = cover_rgba.size

    # Layer A: background + generated artwork
    bg_color = _sample_background_color(cover_rgba, center_x, center_y)
    result = Image.new("RGBA", (W, H), bg_color + (255,))

    # Conservative opening mask (slightly inset from inner frame edge)
    opening_mask = _build_opening_mask((W, H), center_x, center_y, radius)

    generated_prepped = _flatten_generated_alpha(generated_rgba, bg_color)
    fill_radius = round(radius * OVERLAY_FILL_RATIO)
    crop_center = _find_energy_center(generated_prepped)
    generated_cropped = _smart_square_crop(generated_prepped, crop_center, fill_radius * 2)

    gen_layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gen_layer.paste(generated_cropped, (center_x - fill_radius, center_y - fill_radius))

    # Clip generated layer exactly to opening mask.
    result = Image.composite(gen_layer, result, opening_mask)

    # Layer B: original cover overlay with transparent opening
    overlay = _get_or_create_cover_overlay(
        cover_rgba=cover_rgba,
        cover_path=cover_path,
        center_x=center_x,
        center_y=center_y,
        radius=radius,
        opening_mask=opening_mask,
    )
    result.alpha_composite(overlay)

    return result


def composite_v3(
    cover_path: Path,
    generated_image_bytes: bytes,
    job_id: str,
    center_x: int = MEDALLION_CENTER_X,
    center_y: int = MEDALLION_CENTER_Y,
    radius: int = MEDALLION_RADIUS,
) -> Path:
    """
    Composite generated art into cover while guaranteeing frame preservation.
    """
    OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUTPUTS_DIR / f"{job_id}_composited.jpg"

    cover = Image.open(cover_path).convert("RGBA")
    if cover.size != (COVER_WIDTH, COVER_HEIGHT):
        logger.warning("Cover size %s differs from expected; resizing", cover.size)
        cover = cover.resize((COVER_WIDTH, COVER_HEIGHT), Image.LANCZOS)

    generated = Image.open(BytesIO(generated_image_bytes)).convert("RGBA")
    result = _overlay_composite_image(
        cover,
        generated,
        center_x,
        center_y,
        radius,
        cover_path=cover_path,
    )

    result.convert("RGB").save(out_path, "JPEG", quality=95, dpi=(COVER_DPI, COVER_DPI))
    logger.info("Compositor v6 saved: %s (%d bytes)", out_path, out_path.stat().st_size)
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
