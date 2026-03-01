"""
Quality scoring service — circular composition heuristics.
Exact port of static client quality.js.

7 sub-scores:
  Edge Content (0.25)         — outer-ring detail vs. center detail
  Center of Mass (0.20)       — bright+saturated pixel CoM distance from center
  Circular Composition (0.20) — inside-circle variance vs. outside-circle variance
  Color (0.12)                — total RGB channel variance
  Brightness (0.08)           — proximity to 45% brightness
  Contrast (0.08)             — brightness standard deviation
  Diversity (0.07)            — RGB channel spread
"""
import logging
from io import BytesIO
from pathlib import Path
from typing import Dict, Optional

try:
    import cv2  # noqa: F401
except Exception:  # pragma: no cover
    cv2 = None
import numpy as np
from PIL import Image
try:
    from scipy import ndimage
except Exception:  # pragma: no cover
    ndimage = None

logger = logging.getLogger(__name__)


def _matte_panel_penalty(arr_rgb: np.ndarray) -> float:
    """
    Penalize poster/sticker outputs with large uniform side mattes.
    Returns penalty in [0, 0.20].
    """
    h, w = arr_rgb.shape[:2]
    if h < 30 or w < 30:
        return 0.0

    bw = max(6, int(round(w * 0.10)))
    left = arr_rgb[:, :bw, :].astype(np.float32)
    right = arr_rgb[:, w - bw :, :].astype(np.float32)

    left_std = float(left.std())
    right_std = float(right.std())
    left_b = float((left[:, :, 0] * 0.299 + left[:, :, 1] * 0.587 + left[:, :, 2] * 0.114).mean())
    right_b = float((right[:, :, 0] * 0.299 + right[:, :, 1] * 0.587 + right[:, :, 2] * 0.114).mean())

    if left_std < 14.0 and right_std < 14.0 and left_b > 150.0 and right_b > 150.0:
        return 0.20
    if left_std < 20.0 and right_std < 20.0 and left_b > 130.0 and right_b > 130.0:
        return 0.10
    return 0.0


def _text_band_penalty(arr_rgb: np.ndarray) -> float:
    """
    Heuristic penalty for line-like typography clusters (e.g. title ribbons).
    Returns penalty in [0, 0.18].
    """
    if ndimage is None:
        return 0.0

    img = Image.fromarray(arr_rgb).resize((320, 320), Image.LANCZOS)
    arr = np.array(img, dtype=np.uint8)
    gray = (arr[:, :, 0] * 0.299 + arr[:, :, 1] * 0.587 + arr[:, :, 2] * 0.114).astype(np.float32)

    # Focus on lower 60% where text ribbons commonly appear.
    roi = gray[int(gray.shape[0] * 0.38) :, :]
    # Dark/ink-like strokes on lighter substrate
    dark = roi < 130
    if int(dark.sum()) < 120:
        dark_penalty = 0.0
    else:
        labels, n = ndimage.label(dark)
        if n <= 0:
            dark_penalty = 0.0
        else:
            text_like_rows = []
            text_like_count = 0
            for label_id in range(1, n + 1):
                ys, xs = np.where(labels == label_id)
                area = ys.size
                if area < 6 or area > 2000:
                    continue
                h = ys.max() - ys.min() + 1
                w = xs.max() - xs.min() + 1
                aspect = w / max(1, h)
                if 0.2 <= aspect <= 18.0:
                    text_like_count += 1
                    text_like_rows.append(int(ys.mean()))

            if text_like_count < 18:
                dark_penalty = 0.0
            else:
                # Text tends to align in relatively tight horizontal bands.
                row_span = max(text_like_rows) - min(text_like_rows) if text_like_rows else 999
                if row_span < 70:
                    dark_penalty = 0.18
                elif row_span < 105:
                    dark_penalty = 0.10
                else:
                    dark_penalty = 0.0

    # Edge-density band detector catches larger stylised lettering.
    gx = np.abs(np.diff(roi, axis=1))
    band = gx.mean(axis=1)
    if band.size == 0:
        edge_penalty = 0.0
    else:
        peak_rows = np.where(band > np.percentile(band, 92))[0]
        if peak_rows.size < 12:
            edge_penalty = 0.0
        else:
            span = int(peak_rows.max() - peak_rows.min() + 1)
            edge_penalty = 0.10 if span < 90 else 0.0

    return float(min(0.18, dark_penalty + edge_penalty))


def _ornamental_frame_penalty(arr_rgb: np.ndarray) -> float:
    """
    Penalize generated inner frames/ornate borders around the image.
    Returns penalty in [0, 0.22].
    """
    img = Image.fromarray(arr_rgb).resize((320, 320), Image.LANCZOS)
    arr = np.array(img, dtype=np.float32)
    gray = arr[:, :, 0] * 0.299 + arr[:, :, 1] * 0.587 + arr[:, :, 2] * 0.114

    gx = np.abs(np.diff(gray, axis=1))
    gy = np.abs(np.diff(gray, axis=0))
    edge = np.zeros_like(gray)
    edge[:, 1:] += gx
    edge[1:, :] += gy

    h, w = edge.shape
    bw = int(round(min(h, w) * 0.12))
    bw = max(8, min(50, bw))

    border_mask = np.zeros((h, w), dtype=bool)
    border_mask[:bw, :] = True
    border_mask[-bw:, :] = True
    border_mask[:, :bw] = True
    border_mask[:, -bw:] = True

    center_mask = np.zeros((h, w), dtype=bool)
    cx0 = int(w * 0.26)
    cx1 = int(w * 0.74)
    cy0 = int(h * 0.26)
    cy1 = int(h * 0.74)
    center_mask[cy0:cy1, cx0:cx1] = True

    border_energy = float(edge[border_mask].mean())
    center_energy = float(edge[center_mask].mean()) if center_mask.sum() else 1.0
    if center_energy <= 1e-6:
        center_energy = 1.0
    ratio = border_energy / center_energy

    # Require that all four sides are "busy", not just one side from normal composition.
    top_e = float(edge[:bw, :].mean())
    bot_e = float(edge[-bw:, :].mean())
    left_e = float(edge[:, :bw].mean())
    right_e = float(edge[:, -bw:].mean())
    side_min = min(top_e, bot_e, left_e, right_e)
    side_avg = (top_e + bot_e + left_e + right_e) / 4.0

    if ratio > 1.75 and side_min > center_energy * 1.30:
        return 0.22
    if ratio > 1.45 and side_avg > center_energy * 1.15:
        return 0.12
    if ratio > 1.30 and side_avg > center_energy * 1.05:
        return 0.06
    return 0.0


def _artifact_penalty(arr_rgb: np.ndarray) -> float:
    """Combined penalty for text/panel artifacts."""
    return float(
        min(
            0.45,
            _matte_panel_penalty(arr_rgb)
            + _text_band_penalty(arr_rgb)
            + _ornamental_frame_penalty(arr_rgb),
        )
    )


def _edge_content_score(arr_rgb: np.ndarray) -> float:
    """
    Port of edgeContentScore() from quality.js.
    size=200; measures outer-ring detail (dist > r*0.85) vs. center detail (dist < r*0.5).
    score = max(0, min(1, 1.5 - ratio))  where ratio = avgEdge / avgCenter
    """
    size = 200
    h, w = arr_rgb.shape[:2]
    if h != size or w != size:
        img = Image.fromarray(arr_rgb).resize((size, size), Image.LANCZOS)
        arr_rgb = np.array(img, dtype=np.float32)
    else:
        arr_rgb = arr_rgb.astype(np.float32)

    cx, cy, r = size / 2, size / 2, size / 2

    # Gradient magnitude (Sobel-like, matching JS gx+gy calculation)
    edge_detail_sum = 0.0
    edge_count = 0
    center_detail_sum = 0.0
    center_count = 0

    # Use vectorized operations for speed
    ys, xs = np.mgrid[1:size-1, 1:size-1]
    dists = np.sqrt((xs - cx) ** 2 + (ys - cy) ** 2)
    inside_mask = dists <= r

    # Gradient in x and y direction (per channel, sum across channels)
    grad_x = np.abs(arr_rgb[1:-1, 2:] - arr_rgb[1:-1, :-2]).sum(axis=2) / 3.0
    grad_y = np.abs(arr_rgb[2:, 1:-1] - arr_rgb[:-2, 1:-1]).sum(axis=2) / 3.0
    edge_mag = (grad_x + grad_y) / 6.0

    outer_mask = inside_mask & (dists > r * 0.85)
    center_mask_inner = inside_mask & (dists < r * 0.5)

    if outer_mask.sum() == 0 or center_mask_inner.sum() == 0:
        return 0.5

    avg_edge = float(edge_mag[outer_mask].mean())
    avg_center = float(edge_mag[center_mask_inner].mean())

    if avg_center <= 0:
        return 0.5

    ratio = avg_edge / avg_center
    return float(max(0.0, min(1.0, 1.5 - ratio)))


def _center_of_mass_score(arr_rgb: np.ndarray) -> float:
    """
    Port of centerOfMassScore() from quality.js.
    size=150; weight = brightness * (0.5 + saturation * 0.5)
    dist = sqrt((comX-cx)^2 + (comY-cy)^2) / (size/2)
    score = max(0, 1 - dist * 2)
    """
    size = 150
    img = Image.fromarray(arr_rgb).resize((size, size), Image.LANCZOS)
    arr = np.array(img, dtype=np.float32)

    r_ch = arr[:, :, 0]
    g_ch = arr[:, :, 1]
    b_ch = arr[:, :, 2]

    brightness = (r_ch + g_ch + b_ch) / 3.0
    max_c = arr.max(axis=2)
    min_c = arr.min(axis=2)
    # saturation = (max - min) / max, but avoid div by zero
    saturation = np.where(max_c > 0, (max_c - min_c) / np.maximum(max_c, 1e-6), 0.0)

    weight = brightness * (0.5 + saturation * 0.5)
    total_weight = float(weight.sum())

    if total_weight == 0:
        return 0.5

    ys, xs = np.mgrid[0:size, 0:size]
    com_x = float((xs * weight).sum() / total_weight)
    com_y = float((ys * weight).sum() / total_weight)

    cx, cy = size / 2, size / 2
    dist = ((com_x - cx) ** 2 + (com_y - cy) ** 2) ** 0.5 / (size / 2)
    return float(max(0.0, min(1.0, 1.0 - dist * 2.0)))


def _circular_composition_score(arr_rgb: np.ndarray) -> float:
    """
    Port of circularCompositionScore() from quality.js.
    size=150; inside = dist < r*0.7; outside = rest
    ratio = insideStd / (insideStd + outsideStd)
    score = max(0, (ratio - 0.3) * 3.33)
    """
    size = 150
    img = Image.fromarray(arr_rgb).resize((size, size), Image.LANCZOS)
    arr = np.array(img, dtype=np.float32)

    brightness = arr[:, :, 0] * 0.299 + arr[:, :, 1] * 0.587 + arr[:, :, 2] * 0.114

    cx, cy, r = size / 2, size / 2, size / 2
    ys, xs = np.mgrid[0:size, 0:size]
    dists = np.sqrt((xs - cx) ** 2 + (ys - cy) ** 2)

    inside_mask = dists < r * 0.7
    outside_mask = ~inside_mask

    inside_std = float(brightness[inside_mask].std()) if inside_mask.sum() > 0 else 0.0
    outside_std = float(brightness[outside_mask].std()) if outside_mask.sum() > 0 else 0.0

    if inside_std + outside_std == 0:
        return 0.5

    ratio = inside_std / (inside_std + outside_std)
    return float(max(0.0, min(1.0, (ratio - 0.3) * 3.33)))


def _legacy_color_scores(arr_rgb: np.ndarray) -> Dict[str, float]:
    """
    Port of _legacyColorScores() from quality.js.
    size=300; computes colorScore, brightnessScore, contrastScore, diversityScore.
    """
    size = 300
    img = Image.fromarray(arr_rgb).resize((size, size), Image.LANCZOS)
    arr = np.array(img, dtype=np.float32)

    r_ch = arr[:, :, 0].flatten()
    g_ch = arr[:, :, 1].flatten()
    b_ch = arr[:, :, 2].flatten()

    brightness = (r_ch * 0.299 + g_ch * 0.587 + b_ch * 0.114) / 255.0

    color_variance = (r_ch.var() + g_ch.var() + b_ch.var()) / 3.0
    color_score = float(min(1.0, color_variance / 2000.0))

    avg_brightness = float(brightness.mean())
    brightness_score = float(max(0.0, 1.0 - abs(avg_brightness - 0.45) * 2.0))

    contrast_score = float(min(1.0, brightness.std() / 0.25))

    avg_r = float(r_ch.mean())
    avg_g = float(g_ch.mean())
    avg_b = float(b_ch.mean())
    channel_spread = abs(avg_r - avg_g) + abs(avg_g - avg_b) + abs(avg_r - avg_b)
    diversity_score = float(min(1.0, channel_spread / 200.0))

    return {
        "color_score": color_score,
        "brightness_score": brightness_score,
        "contrast_score": contrast_score,
        "diversity_score": diversity_score,
    }


def score_image(image_bytes: bytes) -> float:
    """
    Score image quality for circular medallion suitability.
    Returns float in [0.0, 1.0].
    Exact port of quality.js scoreGeneratedImage().

    Weights:
      Edge Content (0.25), Center of Mass (0.20), Circular Composition (0.20),
      Color (0.12), Brightness (0.08), Contrast (0.08), Diversity (0.07)
    """
    try:
        img = Image.open(BytesIO(image_bytes)).convert("RGB")
        img.thumbnail((512, 512), Image.LANCZOS)
        arr = np.array(img, dtype=np.uint8)

        ec_score  = _edge_content_score(arr)
        com_score = _center_of_mass_score(arr)
        cc_score  = _circular_composition_score(arr)
        legacy    = _legacy_color_scores(arr)
        penalty = _artifact_penalty(arr)

        final_score = (
            ec_score                          * 0.25
            + com_score                       * 0.20
            + cc_score                        * 0.20
            + legacy["color_score"]           * 0.12
            + legacy["brightness_score"]      * 0.08
            + legacy["contrast_score"]        * 0.08
            + legacy["diversity_score"]       * 0.07
        )
        final_score *= (1.0 - penalty)
        final_score = round(min(1.0, max(0.0, final_score)), 4)
        logger.debug(
            "Quality score=%.4f (ec=%.3f com=%.3f cc=%.3f col=%.3f bri=%.3f con=%.3f div=%.3f penalty=%.3f)",
            final_score, ec_score, com_score, cc_score,
            legacy["color_score"], legacy["brightness_score"],
            legacy["contrast_score"], legacy["diversity_score"], penalty,
        )
        return final_score
    except Exception as e:
        logger.warning("Quality scoring failed: %s", e)
        return 0.5


def get_detailed_scores(image_bytes: bytes) -> Dict:
    """Return all 7 sub-scores plus overall for debugging."""
    try:
        img = Image.open(BytesIO(image_bytes)).convert("RGB")
        img.thumbnail((512, 512), Image.LANCZOS)
        arr = np.array(img, dtype=np.uint8)

        ec_score  = _edge_content_score(arr)
        com_score = _center_of_mass_score(arr)
        cc_score  = _circular_composition_score(arr)
        legacy    = _legacy_color_scores(arr)
        penalty = _artifact_penalty(arr)

        overall = round(min(1.0, max(0.0, (
            ec_score * 0.25 + com_score * 0.20 + cc_score * 0.20
            + legacy["color_score"] * 0.12 + legacy["brightness_score"] * 0.08
            + legacy["contrast_score"] * 0.08 + legacy["diversity_score"] * 0.07
        ) * (1.0 - penalty))), 4)

        return {
            "overall": overall,
            "edge_content":          {"score": ec_score,                    "weight": 0.25},
            "center_of_mass":        {"score": com_score,                   "weight": 0.20},
            "circular_composition":  {"score": cc_score,                    "weight": 0.20},
            "color":                 {"score": legacy["color_score"],       "weight": 0.12},
            "brightness":            {"score": legacy["brightness_score"],  "weight": 0.08},
            "contrast":              {"score": legacy["contrast_score"],    "weight": 0.08},
            "diversity":             {"score": legacy["diversity_score"],   "weight": 0.07},
            "artifact_penalty":      {"score": penalty,                     "weight": 0.00},
        }
    except Exception as e:
        logger.warning("Detailed scoring failed: %s", e)
        return {"overall": 0.5, "error": str(e)}


def score_image_file(path: Path) -> float:
    """Score a JPEG/PNG file by path."""
    return score_image(path.read_bytes())
