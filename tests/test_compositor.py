"""
Tests for the compositing pipeline.
"""
import io
import pytest
import numpy as np
from pathlib import Path
from PIL import Image
from unittest.mock import patch

from app.services.compositor import (
    _make_circle_mask,
    _sample_surround,
    _color_match,
    composite,
)
from app.config import COVER_WIDTH, COVER_HEIGHT


def _make_fake_cover(width=COVER_WIDTH, height=COVER_HEIGHT) -> Path:
    """Create a temporary fake cover JPEG for testing."""
    import tempfile
    img = Image.new("RGB", (width, height), color=(26, 39, 68))
    # Add a golden rectangle to simulate the front panel
    pixels = np.array(img)
    pixels[:, width // 2:, :] = [188, 150, 90]
    img = Image.fromarray(pixels)
    tmp = tempfile.NamedTemporaryFile(suffix=".jpg", delete=False)
    img.save(tmp.name, "JPEG", quality=85)
    return Path(tmp.name)


def _make_fake_generated(size=(512, 512)) -> bytes:
    """Create a small PNG image."""
    img = Image.new("RGB", size, color=(122, 94, 62))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


# ─── Mask ─────────────────────────────────────────────────────────────────────

def test_circle_mask_size():
    mask = _make_circle_mask((100, 100), radius=40, feather=0)
    assert mask.size == (100, 100)
    # Center pixel should be white
    assert mask.getpixel((50, 50)) == 255


def test_circle_mask_feather():
    mask = _make_circle_mask((100, 100), radius=40, feather=5)
    # Corner pixel should be black (outside circle)
    assert mask.getpixel((0, 0)) < 10
    # Center should be near-white
    assert mask.getpixel((50, 50)) > 200


def test_circle_mask_corner_is_black():
    mask = _make_circle_mask((200, 200), radius=80, feather=0)
    assert mask.getpixel((0, 0)) == 0
    assert mask.getpixel((100, 100)) == 255


# ─── Color match ──────────────────────────────────────────────────────────────

def test_color_match_no_shift_needed():
    """If generated image already matches target, output should be very close."""
    generated = Image.new("RGB", (64, 64), color=(100, 100, 100))
    result = _color_match(generated, (100.0, 100.0, 100.0))
    arr = np.array(result)
    assert abs(int(arr[:, :, 0].mean()) - 100) < 5


def test_color_match_shift_clamped():
    """Shift should be limited to ±20% per channel."""
    generated = Image.new("RGB", (64, 64), color=(50, 50, 50))
    result = _color_match(generated, (200.0, 200.0, 200.0))  # big shift
    arr = np.array(result)
    # Should have moved toward target but not all the way (clamped)
    mean = arr[:, :, 0].mean()
    assert mean > 50  # shifted up
    assert mean < 200  # but not to target


# ─── sample_surround ──────────────────────────────────────────────────────────

def test_sample_surround_uniform():
    img = Image.new("RGB", (500, 500), color=(100, 150, 200))
    r, g, b = _sample_surround(img, 250, 250, 100)
    assert abs(r - 100) < 5
    assert abs(g - 150) < 5
    assert abs(b - 200) < 5


# ─── composite ────────────────────────────────────────────────────────────────

def test_composite_output_dimensions():
    cover_path = _make_fake_cover()
    generated_bytes = _make_fake_generated()

    try:
        out = composite(
            cover_path=cover_path,
            generated_image_bytes=generated_bytes,
            job_id="test-composite-001",
            center_x=2850,
            center_y=1350,
            radius=520,
            feather=15,
        )
        assert out.exists()
        with Image.open(out) as img:
            assert img.size == (COVER_WIDTH, COVER_HEIGHT)
    finally:
        cover_path.unlink(missing_ok=True)
        if 'out' in dir() and out.exists():
            out.unlink(missing_ok=True)


def test_composite_small_radius():
    """Compositing should work with a small radius too."""
    cover_path = _make_fake_cover()
    generated_bytes = _make_fake_generated((256, 256))

    try:
        out = composite(
            cover_path=cover_path,
            generated_image_bytes=generated_bytes,
            job_id="test-composite-small",
            center_x=2850,
            center_y=1350,
            radius=100,
            feather=5,
        )
        with Image.open(out) as img:
            assert img.size == (COVER_WIDTH, COVER_HEIGHT)
    finally:
        cover_path.unlink(missing_ok=True)
        if 'out' in dir() and out.exists():
            out.unlink(missing_ok=True)
