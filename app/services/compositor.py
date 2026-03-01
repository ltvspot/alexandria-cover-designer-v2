"""
Compositor v9 — source-template overlay pipeline with auto-fit geometry.

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
from typing import Dict, Optional, Tuple

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

# v9 constants
TEMPLATE_CACHE_VERSION = "v9"
INNER_RADIUS_FROM_OUTER_RATIO = 420.0 / 520.0
INNER_RADIUS_MIN = 280
INNER_RADIUS_MAX = 460
DEFAULT_INNER_RADIUS = MEDALLION_INNER_RADIUS
DEFAULT_TEMPLATE_FEATHER = MEDALLION_TEMPLATE_FEATHER_PX
DEFAULT_ILLUSTRATION_OVERFILL = MEDALLION_ILLUSTRATION_OVERFILL_PX
CONTENT_MIN_SIDE_RATIO = 0.35
CONTENT_PADDING_RATIO = 0.12

# v9 geometry detector constants (per-cover medallion fitting)
DETECTOR_SCALE = 0.25
DETECTOR_X_WINDOW = 100
DETECTOR_Y_MIN_RATIO = 0.46
DETECTOR_Y_MAX_RATIO = 0.74
DETECTOR_R_MIN_RATIO = 0.78
DETECTOR_R_MAX_RATIO = 1.20
OPENING_RADIUS_RATIO = 0.965
OPENING_RADIUS_MIN = 360
OPENING_RADIUS_MAX = 530

_RING_OFFSET_CACHE: Dict[Tuple[int, int], Tuple[np.ndarray, np.ndarray]] = {}


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


def _ring_offsets(radius: int, samples: int) -> Tuple[np.ndarray, np.ndarray]:
    key = (int(radius), int(samples))
    cached = _RING_OFFSET_CACHE.get(key)
    if cached is not None:
        return cached

    angles = np.linspace(0.0, 2.0 * math.pi, samples, endpoint=False, dtype=np.float32)
    dx = np.rint(radius * np.cos(angles)).astype(np.int16)
    dy = np.rint(radius * np.sin(angles)).astype(np.int16)
    _RING_OFFSET_CACHE[key] = (dx, dy)
    return dx, dy


def _ring_mean(
    channel: np.ndarray,
    cx: int,
    cy: int,
    radius: int,
    samples: int = 220,
) -> Optional[float]:
    H, W = channel.shape
    dx, dy = _ring_offsets(radius, samples)
    xs = cx + dx
    ys = cy + dy
    valid = (xs >= 0) & (xs < W) & (ys >= 0) & (ys < H)
    if int(valid.sum()) < int(samples * 0.94):
        return None
    vals = channel[ys[valid], xs[valid]]
    return float(vals.mean())


def _detect_medallion_geometry(
    cover_rgba: Image.Image,
    expected_cx: int,
    expected_cy: int,
    expected_outer_radius: int,
) -> Tuple[int, int, int, int]:
    """
    Detect per-cover medallion center + radius from source ornament ring.

    This removes dependence on a fixed center (which varies across covers) and
    prevents legacy artwork bleed when the opening is misaligned.
    """
    try:
        W, H = cover_rgba.size
        sw = max(300, int(round(W * DETECTOR_SCALE)))
        sh = max(220, int(round(H * DETECTOR_SCALE)))

        small = cover_rgba.convert("RGB").resize((sw, sh), Image.LANCZOS)
        arr = np.asarray(small, dtype=np.float32)
        r = arr[:, :, 0]
        g = arr[:, :, 1]
        b = arr[:, :, 2]

        warm = (r - b) + 0.45 * (g - b)
        sat = np.maximum.reduce([r, g, b]) - np.minimum.reduce([r, g, b])

        ex = int(round(expected_cx * DETECTOR_SCALE))
        ey = int(round(expected_cy * DETECTOR_SCALE))
        er = int(round(expected_outer_radius * DETECTOR_SCALE))
        ex = _clamp(ex, 0, sw - 1)
        ey = _clamp(ey, 0, sh - 1)
        er = _clamp(er, 40, min(sw, sh) // 2 - 4)

        x0 = _clamp(ex - DETECTOR_X_WINDOW // 2, 0, sw - 1)
        x1 = _clamp(ex + DETECTOR_X_WINDOW // 2, 0, sw - 1)

        # The medallion sits on the lower half of front panel; keep a broad
        # vertical band so detector still adapts to per-book title height.
        y0 = int(sh * DETECTOR_Y_MIN_RATIO)
        y1 = int(sh * DETECTOR_Y_MAX_RATIO)
        if y0 > y1:
            y0, y1 = y1, y0
        y0 = _clamp(min(y0, ey - 60), 0, sh - 1)
        y1 = _clamp(max(y1, ey + 120), 0, sh - 1)

        r_min = _clamp(int(round(er * DETECTOR_R_MIN_RATIO)), 70, min(sw, sh) // 2 - 8)
        r_max = _clamp(int(round(er * DETECTOR_R_MAX_RATIO)), r_min + 8, min(sw, sh) // 2 - 4)

        best_score = -1e18
        best_cx, best_cy, best_r = ex, ey, er

        # Coarse scan
        for cy in range(y0, y1 + 1, 5):
            for cx in range(x0, x1 + 1, 5):
                for rr in range(r_min, r_max + 1, 5):
                    ring_w = _ring_mean(warm, cx, cy, rr, samples=180)
                    ring_s = _ring_mean(sat, cx, cy, rr, samples=180)
                    if ring_w is None or ring_s is None:
                        continue

                    inner_w = _ring_mean(warm, cx, cy, max(8, rr - 5), samples=120)
                    outer_w = _ring_mean(warm, cx, cy, rr + 5, samples=120)
                    if inner_w is None or outer_w is None:
                        continue

                    contrast = ring_w - 0.5 * (inner_w + outer_w)
                    score = ring_w + 0.24 * ring_s + 0.60 * contrast
                    if score > best_score:
                        best_score = score
                        best_cx, best_cy, best_r = cx, cy, rr

        # Fine scan around best candidate
        fine_r0 = max(r_min, best_r - 10)
        fine_r1 = min(r_max, best_r + 10)
        for cy in range(max(0, best_cy - 10), min(sh - 1, best_cy + 10) + 1, 1):
            for cx in range(max(0, best_cx - 10), min(sw - 1, best_cx + 10) + 1, 1):
                for rr in range(fine_r0, fine_r1 + 1, 1):
                    ring_w = _ring_mean(warm, cx, cy, rr, samples=320)
                    ring_s = _ring_mean(sat, cx, cy, rr, samples=320)
                    if ring_w is None or ring_s is None:
                        continue
                    score = ring_w + 0.26 * ring_s
                    if score > best_score:
                        best_score = score
                        best_cx, best_cy, best_r = cx, cy, rr

        detected_cx = int(round(best_cx / DETECTOR_SCALE))
        detected_cy = int(round(best_cy / DETECTOR_SCALE))
        detected_outer = int(round(best_r / DETECTOR_SCALE))

        # Opening must be large enough to remove legacy art but still leave
        # ornate frame/scrollwork untouched.
        opening = int(round(detected_outer * OPENING_RADIUS_RATIO))
        opening = _clamp(opening, OPENING_RADIUS_MIN, OPENING_RADIUS_MAX)
        opening = min(opening, detected_outer - 8)

        return detected_cx, detected_cy, detected_outer, opening
    except Exception as e:  # pragma: no cover
        logger.warning("Medallion auto-detect failed; falling back to defaults: %s", e)
        fallback_inner = _derive_inner_radius(expected_outer_radius)
        return expected_cx, expected_cy, expected_outer_radius, fallback_inner


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


def _mask_to_bbox(mask: np.ndarray) -> Optional[Tuple[int, int, int, int]]:
    ys, xs = np.where(mask)
    if ys.size == 0 or xs.size == 0:
        return None
    x0 = int(xs.min())
    x1 = int(xs.max()) + 1
    y0 = int(ys.min())
    y1 = int(ys.max()) + 1
    return x0, y0, x1, y1


def _find_content_bbox(img: Image.Image) -> Optional[Tuple[int, int, int, int]]:
    """
    Find a tight content box for sparse/sticker-like outputs.
    Returns None when content already fills most of the image.
    """
    arr = np.array(img.convert("RGBA"), dtype=np.uint8)
    h, w = arr.shape[:2]
    if h < 8 or w < 8:
        return None

    alpha = arr[:, :, 3]
    if int(alpha.min()) < 250:
        # Provider returned true transparency: use alpha silhouette.
        alpha_mask = alpha > 32
        bbox = _mask_to_bbox(alpha_mask)
        if bbox is not None:
            x0, y0, x1, y1 = bbox
            if (x1 - x0) * (y1 - y0) >= int(w * h * 0.01):
                return bbox

    rgb = arr[:, :, :3].astype(np.int16)
    border_w = max(2, int(min(h, w) * 0.04))
    border = np.concatenate(
        [
            rgb[:border_w, :, :].reshape(-1, 3),
            rgb[-border_w:, :, :].reshape(-1, 3),
            rgb[:, :border_w, :].reshape(-1, 3),
            rgb[:, -border_w:, :].reshape(-1, 3),
        ],
        axis=0,
    )
    bg = np.median(border, axis=0)
    diff = np.abs(rgb - bg).sum(axis=2)
    sat = rgb.max(axis=2) - rgb.min(axis=2)

    mask = (diff > 30) | (sat > 36)
    mask[:2, :] = False
    mask[-2:, :] = False
    mask[:, :2] = False
    mask[:, -2:] = False

    fill_ratio = float(mask.sum()) / float(w * h)
    if fill_ratio < 0.002 or fill_ratio > 0.78:
        return None

    return _mask_to_bbox(mask)


def _crop_with_content_bias(img: Image.Image, diameter: int) -> Image.Image:
    """
    Content-aware square crop:
      - tightens sparse/sticker outputs
      - falls back to energy center for full-scene outputs
    """
    bbox = _find_content_bbox(img)
    if bbox is None:
        return _smart_square_crop(img, _find_energy_center(img), diameter)

    x0, y0, x1, y1 = bbox
    img_w, img_h = img.size

    bw = max(1, x1 - x0)
    bh = max(1, y1 - y0)
    side = int(round(max(bw, bh) * (1.0 + 2.0 * CONTENT_PADDING_RATIO)))
    side = max(side, int(round(min(img_w, img_h) * CONTENT_MIN_SIDE_RATIO)))
    side = min(side, min(img_w, img_h))

    cx = (x0 + x1) / 2.0
    cy = (y0 + y1) / 2.0
    src_x = int(round(cx - side / 2.0))
    src_y = int(round(cy - side / 2.0))
    src_x = max(0, min(img_w - side, src_x))
    src_y = max(0, min(img_h - side, src_y))

    cropped = img.crop((src_x, src_y, src_x + side, src_y + side))
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
    cropped = _crop_with_content_bias(prepared, diameter)

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
    geometry: Optional[Tuple[int, int, int, int]] = None,
) -> Image.Image:
    """Core in-memory compositor for tests and runtime."""
    W, H = cover_rgba.size

    if geometry is None:
        geometry = _detect_medallion_geometry(
            cover_rgba=cover_rgba,
            expected_cx=center_x,
            expected_cy=center_y,
            expected_outer_radius=radius,
        )
    detected_cx, detected_cy, _, inner_radius = geometry

    feather_px = max(0, int(DEFAULT_TEMPLATE_FEATHER))
    draw_radius = inner_radius + max(0, int(DEFAULT_ILLUSTRATION_OVERFILL))

    bg_color = _sample_background_color(cover_rgba, detected_cx, detected_cy)
    result = Image.new("RGBA", (W, H), bg_color + (255,))

    illustration_layer = _build_circular_illustration_layer(
        generated_rgba=generated_rgba,
        canvas_size=(W, H),
        center_x=detected_cx,
        center_y=detected_cy,
        draw_radius=draw_radius,
        bg_color=bg_color,
    )
    result.alpha_composite(illustration_layer)

    template = _get_or_create_template(
        cover_rgba=cover_rgba,
        cover_path=cover_path,
        center_x=detected_cx,
        center_y=detected_cy,
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
    detected_geometry = _detect_medallion_geometry(
        cover_rgba=cover,
        expected_cx=center_x,
        expected_cy=center_y,
        expected_outer_radius=radius,
    )
    result = _template_composite_image(
        cover_rgba=cover,
        generated_rgba=generated,
        center_x=center_x,
        center_y=center_y,
        radius=radius,
        cover_path=cover_path,
        geometry=detected_geometry,
    )

    result.convert("RGB").save(out_path, "JPEG", quality=95, dpi=(COVER_DPI, COVER_DPI))
    detected_cx, detected_cy, detected_outer, detected_inner = detected_geometry

    logger.info(
        (
            "Compositor v9 saved: %s (%d bytes, "
            "detected=(cx=%d,cy=%d,outer=%d,inner=%d), "
            "feather=%d, overfill=%d, cache=%s)"
        ),
        out_path,
        out_path.stat().st_size,
        detected_cx,
        detected_cy,
        detected_outer,
        detected_inner,
        DEFAULT_TEMPLATE_FEATHER,
        DEFAULT_ILLUSTRATION_OVERFILL,
        f"{TEMPLATE_CACHE_VERSION}+geom",
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
