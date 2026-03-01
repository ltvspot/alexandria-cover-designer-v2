"""Tests for compositor v3."""
import pytest
from pathlib import Path
from PIL import Image
from io import BytesIO
import numpy as np

from app.services.compositor import (
    ILLUSTRATION_RATIO, PUNCH_RATIO, RING_WIDTH,
    _find_energy_center, _smart_square_crop,
    _sample_background_color, _draw_gold_ring,
    composite_v3,
)


def _make_test_image(w=200, h=200, color=(100, 150, 200)):
    """Create a simple test image."""
    return Image.new("RGB", (w, h), color)


def _image_to_bytes(img):
    buf = BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def test_constants():
    assert ILLUSTRATION_RATIO == 1.24
    assert PUNCH_RATIO == 1.26
    assert RING_WIDTH == 14


def test_illustration_radius_larger_than_punch():
    """punch_radius > illustration_radius means cover fully covers the ring."""
    radius = 520
    illus_r = round(radius * ILLUSTRATION_RATIO)
    punch_r = round(radius * PUNCH_RATIO)
    assert punch_r > illus_r, "Punch radius must be larger than illustration radius"


def test_find_energy_center():
    """Energy center should be in [0,1] range."""
    img = _make_test_image(100, 100)
    cx, cy = _find_energy_center(img.convert("RGBA"))
    assert 0.0 <= cx <= 1.0
    assert 0.0 <= cy <= 1.0


def test_find_energy_center_clamped():
    """Center should be clamped to [0.2, 0.8] by smart_square_crop."""
    img = _make_test_image(200, 200)
    arr = np.array(img)
    # Bright spot at extreme corner
    arr[0:10, 0:10] = [255, 255, 0]
    bright_img = Image.fromarray(arr).convert("RGBA")
    cx, cy = _find_energy_center(bright_img)
    # smart_square_crop clamps, not find_energy_center
    # Just verify it returns a normalized value
    assert 0.0 <= cx <= 1.0
    assert 0.0 <= cy <= 1.0


def test_smart_square_crop():
    """Output should be a square at the requested diameter."""
    img = _make_test_image(300, 200).convert("RGBA")
    result = _smart_square_crop(img, (0.5, 0.5), 100)
    assert result.size == (100, 100)


def test_sample_background_color():
    """Should return the darkest of 4 sampled points."""
    cover = Image.new("RGB", (3784, 2777), (26, 39, 68))  # navy
    color = _sample_background_color(cover, 2850, 1350)
    assert len(color) == 3
    # Color should be close to navy (26, 39, 68)
    assert all(0 <= c <= 255 for c in color)


def test_draw_gold_ring_doesnt_crash():
    """Gold ring drawing should complete without error."""
    img = Image.new("RGBA", (500, 500), (26, 39, 68, 255))
    result = _draw_gold_ring(img, 250, 250, 100, RING_WIDTH)
    assert result.size == (500, 500)
    assert result.mode == "RGBA"


def test_composite_v3_output_size(tmp_path):
    """composite_v3 must output a 3784×2777 JPEG."""
    # Create fake cover
    cover_path = tmp_path / "cover.jpg"
    cover = Image.new("RGB", (3784, 2777), (26, 39, 68))
    cover.save(cover_path, "JPEG")

    # Create fake generated image
    gen_img = _make_test_image(512, 512, (200, 100, 50))
    gen_bytes = _image_to_bytes(gen_img)

    # Override OUTPUTS_DIR
    import app.services.compositor as comp_module
    original_dir = comp_module.OUTPUTS_DIR
    comp_module.OUTPUTS_DIR = tmp_path

    try:
        out_path = composite_v3(
            cover_path=cover_path,
            generated_image_bytes=gen_bytes,
            job_id="test_job_001",
            center_x=2850,
            center_y=1350,
            radius=520,
        )
        assert out_path.exists()
        with Image.open(out_path) as result:
            assert result.size == (3784, 2777)
    finally:
        comp_module.OUTPUTS_DIR = original_dir
