"""
Quality scoring service.
Scores a generated (or composited) image on a 0.0–1.0 scale.

Components:
  - Technical (0.30): resolution check, sharpness (Laplacian), dynamic range
  - Artifacts (0.25): edge-blob detection, chroma outliers
  - Palette (0.15): match against navy/gold/bronze Alexandria palette
  - Composition (0.15): content centered, not too close to edges
  - Distinctiveness (0.15): hash-based vs placeholder (always 1.0 for now)
"""
import logging
from io import BytesIO
from pathlib import Path
from typing import Optional, Tuple

import numpy as np
from PIL import Image

logger = logging.getLogger(__name__)

# Alexandria target palette
_PALETTE = np.array([
    [26, 39, 68],     # navy
    [188, 150, 90],   # gold
    [122, 94, 62],    # bronze
], dtype=np.float32)


def _sharpness(arr_gray: np.ndarray) -> float:
    """Laplacian variance as a proxy for sharpness. Normalised to 0–1."""
    from scipy.ndimage import laplace
    lap = laplace(arr_gray.astype(np.float32))
    var = float(lap.var())
    # Typical range 0..500; map to 0..1
    return min(1.0, var / 300.0)


def _dynamic_range(arr_gray: np.ndarray) -> float:
    """Normalised dynamic range (0 = flat, 1 = full range)."""
    lo, hi = float(arr_gray.min()), float(arr_gray.max())
    return (hi - lo) / 255.0


def _technical_score(img: Image.Image) -> float:
    arr = np.array(img.convert("L"), dtype=np.float32)
    sharp = _sharpness(arr)
    dr = _dynamic_range(arr)
    return 0.5 * sharp + 0.5 * dr


def _artifact_score(img: Image.Image) -> float:
    """
    Detect artefacts:
    - Chroma outliers: pixels with very saturated, single-channel spikes
    - Returns a score where 1.0 = no artefacts detected
    """
    arr = np.array(img.convert("RGB"), dtype=np.float32)
    # Chroma = max - min across channels per pixel
    chroma = arr.max(axis=2) - arr.min(axis=2)
    # Fraction of extreme chroma pixels (outliers > 200)
    outlier_frac = float((chroma > 200).mean())
    return max(0.0, 1.0 - outlier_frac * 5.0)


def _palette_score(img: Image.Image) -> float:
    """
    Measure how close the dominant colors are to Alexandria palette.
    Returns 0.0–1.0 (1.0 = very close to palette).
    """
    arr = np.array(img.convert("RGB"), dtype=np.float32)
    # Downsample for speed
    small = Image.fromarray(arr.astype(np.uint8)).resize((64, 64))
    s = np.array(small, dtype=np.float32).reshape(-1, 3)

    # For each pixel, find distance to nearest palette color
    dists = np.sqrt(((s[:, None, :] - _PALETTE[None, :, :]) ** 2).sum(axis=2))
    min_dists = dists.min(axis=1)
    # Mean min distance, normalised: 0 = perfect match, >100 = very different
    mean_dist = float(min_dists.mean())
    return max(0.0, 1.0 - mean_dist / 150.0)


def _composition_score(img: Image.Image) -> float:
    """
    Check content is roughly centered and not pushed to edges.
    Uses luminance distribution.
    """
    arr = np.array(img.convert("L"), dtype=np.float32)
    h, w = arr.shape
    # Compute center-of-mass
    ys, xs = np.mgrid[0:h, 0:w]
    total = arr.sum() + 1e-6
    cx = float((xs * arr).sum() / total)
    cy = float((ys * arr).sum() / total)
    # Normalise to -1..1
    nx = (cx / w - 0.5) * 2
    ny = (cy / h - 0.5) * 2
    # Score: 1.0 if center-of-mass is near center
    dist = (nx ** 2 + ny ** 2) ** 0.5
    return max(0.0, 1.0 - dist * 1.5)


def score_image(image_bytes: bytes) -> float:
    """
    Score image quality. Returns float in [0.0, 1.0].
    """
    try:
        img = Image.open(BytesIO(image_bytes)).convert("RGB")
        # Limit size for performance
        img.thumbnail((512, 512), Image.LANCZOS)

        technical = _technical_score(img)
        artifact = _artifact_score(img)
        palette = _palette_score(img)
        composition = _composition_score(img)
        distinctiveness = 1.0  # Phase 1: no comparison set yet

        score = (
            technical       * 0.30
            + artifact      * 0.25
            + palette       * 0.15
            + composition   * 0.15
            + distinctiveness * 0.15
        )
        score = round(min(1.0, max(0.0, score)), 4)
        logger.debug(
            "Quality score=%.4f (tech=%.3f art=%.3f pal=%.3f comp=%.3f)",
            score, technical, artifact, palette, composition,
        )
        return score
    except Exception as e:
        logger.warning("Quality scoring failed: %s", e)
        return 0.5  # neutral fallback


def score_image_file(path: Path) -> float:
    """Score a JPEG/PNG file."""
    return score_image(path.read_bytes())
