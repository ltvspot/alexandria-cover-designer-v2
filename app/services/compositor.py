"""
Compositor v3 — 4-layer clean medallion replacement.
Exact Python/Pillow port of static client compositor.js.

Algorithm (4 layers):
  0. Background fill — sampled from cover near medallion (darkest of 4 points)
  1. Generated illustration clipped to illustrationRadius = radius * 1.24
  2. Synthetic beveled gold ring at illustration edge (RING_WIDTH=14px wide)
  3. Original cover with circular punch at punchRadius = radius * 1.26
     (removes old medallion zone, reveals layers 0-2 underneath)

Constants match compositor.js exactly:
  ILLUSTRATION_RATIO = 1.24
  PUNCH_RATIO        = 1.26
  RING_WIDTH         = 14 (pixels)
"""
import logging
import math
from io import BytesIO
from pathlib import Path
from typing import Optional, Tuple

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

from app.config import (
    COVER_DPI,
    COVER_HEIGHT,
    COVER_WIDTH,
    MEDALLION_CENTER_X,
    MEDALLION_CENTER_Y,
    MEDALLION_RADIUS,
    OUTPUTS_DIR,
)

logger = logging.getLogger(__name__)

# Matches compositor.js constants exactly
ILLUSTRATION_RATIO = 1.24
PUNCH_RATIO = 1.26
RING_WIDTH = 14


# ─── Energy-based crop center ────────────────────────────────────────────────

def _find_energy_center(img: Image.Image) -> Tuple[float, float]:
    """
    Port of findBestCropCenter() from compositor.js.
    Compute gradient energy at 150×150, blur with 3×3 kernel,
    return luminance center-of-mass as normalized (x, y) in [0,1].
    """
    size = 150
    small = img.convert("RGB").resize((size, size), Image.LANCZOS)
    arr = np.array(small, dtype=np.float32)

    # Gradient energy (x-gradient + y-gradient per pixel)
    energy = np.zeros((size, size), dtype=np.float32)
    for y in range(1, size - 1):
        for x in range(1, size - 1):
            gx = (np.abs(arr[y, x] - arr[y, x + 1]) +
                  np.abs(arr[y, x + 1] - arr[y, x - 1])).sum() / 6.0
            gy = (np.abs(arr[y, x] - arr[y + 1, x]) +
                  np.abs(arr[y + 1, x] - arr[y - 1, x])).sum() / 6.0
            energy[y, x] = (gx + gy) / 2.0

    # Use scipy convolve when available; fallback to numpy-only blur when absent.
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


# ─── Smart square crop ────────────────────────────────────────────────────────

def _smart_square_crop(img: Image.Image, crop_center: Tuple[float, float], diameter: int) -> Image.Image:
    """
    Center on the energy hotspot, crop to square, resize to diameter×diameter.
    Clamps crop center to [0.2, 0.8] range (matches JS clampedX/clampedY).
    """
    cx_norm, cy_norm = crop_center
    cx_norm = max(0.2, min(0.8, cx_norm))
    cy_norm = max(0.2, min(0.8, cy_norm))

    img_w, img_h = img.size
    # Square crop: use the smaller dimension
    src_side = min(img_w, img_h)

    src_x = int(cx_norm * img_w - src_side / 2)
    src_y = int(cy_norm * img_h - src_side / 2)
    src_x = max(0, min(img_w - src_side, src_x))
    src_y = max(0, min(img_h - src_side, src_y))

    cropped = img.crop((src_x, src_y, src_x + src_side, src_y + src_side))
    return cropped.resize((diameter, diameter), Image.LANCZOS)


# ─── Background color sampling ────────────────────────────────────────────────

def _sample_background_color(cover: Image.Image, cx: int, cy: int) -> Tuple[int, int, int]:
    """
    Port of sampleBackgroundColor() from compositor.js.
    Samples 4 points around the medallion area, returns the darkest (navy).
    Uses a 100×100 downscaled version for speed.
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

    # Return the darkest sample (smallest sum)
    samples.sort(key=lambda x: x[3])
    r, g, b, _ = samples[0]
    return (r, g, b)


# ─── Circle mask helper ───────────────────────────────────────────────────────

def _make_circle_mask_full(canvas_size: Tuple[int, int], cx: int, cy: int, radius: int) -> Image.Image:
    """
    White-filled circle on black background, full canvas size.
    No feathering (v3 uses hard edges for the punch).
    """
    mask = Image.new("L", canvas_size, 0)
    draw = ImageDraw.Draw(mask)
    draw.ellipse(
        [cx - radius, cy - radius, cx + radius, cy + radius],
        fill=255,
    )
    return mask


# ─── Gold ring drawing ────────────────────────────────────────────────────────

def _draw_gold_ring(img: Image.Image, cx: int, cy: int, radius: int, width: int = RING_WIDTH) -> Image.Image:
    """
    Port of _drawGoldRing() from compositor.js.
    Draws a beveled metallic gold ring using (width+1) concentric circles
    with a bevel brightness profile, plus 72 bead highlights.

    Bevel profile (t = 0..1 across ring width):
      t < 0.15  →  brightness = 0.3 + t * 2.5      (dark inner edge, ramping up)
      t < 0.45  →  brightness = 0.7 + (t-0.15)*1.0  (medium, rising to peak)
      t < 0.55  →  brightness = 1.0                  (peak highlight)
      t < 0.85  →  brightness = 1.0 - (t-0.55)*1.0  (falling from peak)
      else      →  brightness = 0.7 - (t-0.85)*2.5  (dark outer edge)

    Gold base color: R=210, G=170, B=70 at full brightness.
    """
    result = img.copy().convert("RGBA")
    ring_layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(ring_layer)

    half_w = width / 2.0
    inner_r = radius - half_w

    # Draw (width+1) concentric pixel-width arcs
    for i in range(width + 1):
        r = inner_r + i
        t = i / width

        if t < 0.15:
            brightness = 0.3 + t * 2.5
        elif t < 0.45:
            brightness = 0.7 + (t - 0.15) * 1.0
        elif t < 0.55:
            brightness = 1.0
        elif t < 0.85:
            brightness = 1.0 - (t - 0.55) * 1.0
        else:
            brightness = 0.7 - (t - 0.85) * 2.5

        gr = min(255, int(210 * brightness))
        gg = min(255, int(170 * brightness))
        gb = min(255, int(70 * brightness))

        # Draw circle outline at radius r with width ~1.5px (draw twice for anti-alias effect)
        bbox = [cx - r, cy - r, cx + r, cy + r]
        draw.ellipse(bbox, outline=(gr, gg, gb, 255), width=2)

    # 72 bead highlights
    num_beads = 72
    bead_radius = max(2, int(width * 0.25))
    for i in range(num_beads):
        angle = (2 * math.pi * i) / num_beads
        bx = cx + radius * math.cos(angle)
        by = cy + radius * math.sin(angle)

        # Radial gradient bead: bright center, transparent edge
        bead = Image.new("RGBA", (bead_radius * 4, bead_radius * 4), (0, 0, 0, 0))
        bead_draw = ImageDraw.Draw(bead)
        # Approximate radial gradient with concentric circles
        for step in range(bead_radius, 0, -1):
            frac = step / bead_radius
            alpha = int(204 * frac)  # 0.8 * 255 = 204 at center
            if frac > 0.5:
                color = (255, 235, 160, alpha)
            elif frac > 0.1:
                color = (210, 170, 70, int(153 * frac * 2))  # 0.6 * 255 = 153
            else:
                color = (150, 120, 40, 0)
            cx2 = bead_radius * 2
            cy2 = bead_radius * 2
            bead_draw.ellipse(
                [cx2 - step, cy2 - step, cx2 + step, cy2 + step],
                fill=color,
            )

        paste_x = int(bx) - bead_radius * 2
        paste_y = int(by) - bead_radius * 2
        ring_layer.alpha_composite(bead, dest=(paste_x, paste_y))

    result.alpha_composite(ring_layer)
    return result


# ─── Main v3 composite function ────────────────────────────────────────────────

def composite_v3(
    cover_path: Path,
    generated_image_bytes: bytes,
    job_id: str,
    center_x: int = MEDALLION_CENTER_X,
    center_y: int = MEDALLION_CENTER_Y,
    radius: int = MEDALLION_RADIUS,
) -> Path:
    """
    4-layer v3 compositor — exact port of compositor.js _cleanComposite().

    Layer 0: Solid fill with background color sampled from cover
    Layer 1: Generated illustration clipped to illustrationRadius (radius * 1.24)
    Layer 2: Synthetic beveled gold ring at illustration edge
    Layer 3: Cover with circular punch at punchRadius (radius * 1.26), removing old medallion
    """
    OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUTPUTS_DIR / f"{job_id}_composited.jpg"

    illustration_radius = round(radius * ILLUSTRATION_RATIO)
    punch_radius = round(radius * PUNCH_RATIO)

    logger.info(
        "Compositor v3: detected_r=%d illustration_r=%d punch_r=%d",
        radius, illustration_radius, punch_radius,
    )

    # Load images
    cover = Image.open(cover_path).convert("RGBA")
    if cover.size != (COVER_WIDTH, COVER_HEIGHT):
        logger.warning("Cover size %s differs from expected; resizing", cover.size)
        cover = cover.resize((COVER_WIDTH, COVER_HEIGHT), Image.LANCZOS)
    W, H = cover.size

    generated = Image.open(BytesIO(generated_image_bytes)).convert("RGBA")

    # Smart crop: find energy center, square-crop, resize to illustration diameter
    crop_center = _find_energy_center(generated)
    generated_cropped = _smart_square_crop(generated, crop_center, illustration_radius * 2)

    # ── Layer 0: Background fill ─────────────────────────────────────────────
    bg_color = _sample_background_color(cover, center_x, center_y)
    result = Image.new("RGBA", (W, H), bg_color + (255,))

    # ── Layer 1: Illustration clipped to illustrationRadius ──────────────────
    # Place generated_cropped centered at (center_x, center_y)
    paste_x = center_x - illustration_radius
    paste_y = center_y - illustration_radius

    # Create circular mask for illustration
    illus_mask = _make_circle_mask_full((W, H), center_x, center_y, illustration_radius)

    # Create a full-canvas layer with generated image placed at medallion location
    gen_layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gen_layer.paste(generated_cropped, (paste_x, paste_y))

    # Composite illustration over background using circle mask
    result = Image.composite(gen_layer, result, illus_mask)

    # ── Layer 2: Gold ring ────────────────────────────────────────────────────
    result = _draw_gold_ring(result, center_x, center_y, illustration_radius, RING_WIDTH)

    # ── Layer 3: Cover with circular punch ───────────────────────────────────
    # Punch = remove cover pixels inside punchRadius (reveals layers 0-2 underneath)
    cover_punched = cover.copy()
    punch_draw = ImageDraw.Draw(cover_punched)
    # Set alpha to 0 inside punch circle (destination-out equivalent)
    punch_mask = _make_circle_mask_full((W, H), center_x, center_y, punch_radius)
    # Make alpha channel: transparent inside circle, opaque outside
    r_ch, g_ch, b_ch, a_ch = cover_punched.split()
    # Invert punch mask: 255 outside circle, 0 inside
    from PIL import ImageChops
    inv_punch = ImageChops.invert(punch_mask)
    a_ch = ImageChops.multiply(a_ch, inv_punch)
    cover_punched = Image.merge("RGBA", (r_ch, g_ch, b_ch, a_ch))

    result.alpha_composite(cover_punched)

    # Save as JPEG 300 DPI quality 95
    result.convert("RGB").save(out_path, "JPEG", quality=95, dpi=(COVER_DPI, COVER_DPI))
    logger.info("Compositor v3 saved: %s (%d bytes)", out_path, out_path.stat().st_size)
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


# Keep old composite() as an alias pointing to v3 for backwards compatibility
def composite(
    cover_path: Path,
    generated_image_bytes: bytes,
    job_id: str,
    center_x: int = MEDALLION_CENTER_X,
    center_y: int = MEDALLION_CENTER_Y,
    radius: int = MEDALLION_RADIUS,
    feather: int = 0,  # ignored in v3
) -> Path:
    """Alias to composite_v3 — feather parameter is unused in v3."""
    return composite_v3(
        cover_path=cover_path,
        generated_image_bytes=generated_image_bytes,
        job_id=job_id,
        center_x=center_x,
        center_y=center_y,
        radius=radius,
    )
