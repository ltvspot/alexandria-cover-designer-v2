"""Tests for quality scoring — 7 sub-scores and circular composition."""
import pytest
import numpy as np
from PIL import Image
from io import BytesIO

from app.services.quality import (
    score_image, get_detailed_scores,
    _edge_content_score, _center_of_mass_score, _circular_composition_score,
    _legacy_color_scores, _artifact_penalty, _ornamental_frame_penalty,
)


def _solid_image_bytes(color=(128, 128, 128), size=(200, 200)):
    img = Image.new("RGB", size, color)
    buf = BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def _gradient_image_bytes(size=(200, 200)):
    arr = np.zeros((*size, 3), dtype=np.uint8)
    for y in range(size[0]):
        arr[y, :, 0] = int(255 * y / size[0])
        arr[y, :, 2] = 128
    img = Image.fromarray(arr)
    buf = BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def test_score_image_returns_float_in_range():
    score = score_image(_solid_image_bytes())
    assert 0.0 <= score <= 1.0


def test_score_image_neutral_fallback_on_bad_input():
    score = score_image(b"not an image")
    assert score == 0.5  # neutral fallback


def test_detailed_scores_has_all_7_components():
    scores = get_detailed_scores(_gradient_image_bytes())
    assert "overall" in scores
    assert "edge_content" in scores
    assert "center_of_mass" in scores
    assert "circular_composition" in scores
    assert "color" in scores
    assert "brightness" in scores
    assert "contrast" in scores
    assert "diversity" in scores


def test_detailed_scores_weights_sum_to_1():
    scores = get_detailed_scores(_gradient_image_bytes())
    total_weight = sum(
        v["weight"] for k, v in scores.items()
        if isinstance(v, dict) and "weight" in v
    )
    assert abs(total_weight - 1.0) < 0.001


def test_detailed_scores_components_in_range():
    scores = get_detailed_scores(_gradient_image_bytes())
    for key, val in scores.items():
        if isinstance(val, dict) and "score" in val:
            assert 0.0 <= val["score"] <= 1.0, f"{key} score out of range: {val['score']}"


def test_edge_content_score_range():
    arr = np.array(Image.new("RGB", (200, 200), (128, 128, 128)), dtype=np.uint8)
    score = _edge_content_score(arr)
    assert 0.0 <= score <= 1.0


def test_center_of_mass_score_centered_image():
    """A uniformly grey image should have CoM near center."""
    arr = np.full((150, 150, 3), 128, dtype=np.uint8)
    score = _center_of_mass_score(arr)
    # Uniform image: CoM is exactly at center → score should be close to 1
    assert score > 0.8


def test_center_of_mass_score_off_center():
    """Bright spot in corner → lower CoM score."""
    arr = np.zeros((150, 150, 3), dtype=np.uint8)
    arr[0:20, 0:20] = [255, 255, 0]  # Bright corner
    score = _center_of_mass_score(arr)
    # Should be significantly less than 1 due to off-center mass
    assert score < 0.8


def test_circular_composition_score_range():
    arr = np.random.randint(0, 255, (150, 150, 3), dtype=np.uint8)
    score = _circular_composition_score(arr)
    assert 0.0 <= score <= 1.0


def test_legacy_scores_keys():
    arr = np.random.randint(0, 255, (200, 200, 3), dtype=np.uint8)
    scores = _legacy_color_scores(arr)
    assert set(scores.keys()) == {"color_score", "brightness_score", "contrast_score", "diversity_score"}
    for v in scores.values():
        assert 0.0 <= v <= 1.0


def test_artifact_penalty_detects_matte_side_panels():
    arr = np.zeros((220, 220, 3), dtype=np.uint8)
    arr[:, :] = [230, 230, 230]  # light matte
    arr[20:200, 70:150] = [40, 90, 170]  # central panel
    penalty = _artifact_penalty(arr)
    assert penalty > 0.05


def test_ornamental_frame_penalty_detects_generated_border():
    arr = np.full((260, 260, 3), 180, dtype=np.uint8)
    arr[30:230, 30:230] = [90, 120, 160]  # inner scene
    # Ornate-like busy border strokes
    arr[:24, :] = [30, 30, 30]
    arr[-24:, :] = [30, 30, 30]
    arr[:, :24] = [30, 30, 30]
    arr[:, -24:] = [30, 30, 30]
    arr[8:22, 40:220:8] = [220, 180, 80]
    arr[238:252, 40:220:8] = [220, 180, 80]
    arr[40:220:8, 8:22] = [220, 180, 80]
    arr[40:220:8, 238:252] = [220, 180, 80]

    penalty = _ornamental_frame_penalty(arr)
    assert penalty > 0.05
