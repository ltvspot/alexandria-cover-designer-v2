"""Tests for bleed-safe compositor (overlay pipeline)."""

from io import BytesIO

import numpy as np
from PIL import Image, ImageDraw

from app.services.compositor import (
    OVERLAY_CACHE_VERSION,
    OVERLAY_FILL_RATIO,
    _build_cover_overlay,
    _build_parametric_opening_mask,
    _flatten_generated_alpha,
    _opening_radius,
    _overlay_cache_looks_valid,
    _overlay_cache_path,
    _overlay_composite_image,
    composite_v3,
)


def _image_to_bytes(img: Image.Image) -> bytes:
    buf = BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def _make_cover(w=1200, h=900, cx=850, cy=450, r=220) -> Image.Image:
    """Synthetic cover with visible ornament-like structure around medallion."""
    cover = Image.new("RGB", (w, h), (26, 39, 68))
    d = ImageDraw.Draw(cover)

    # faux ornament ring
    d.ellipse((cx - r - 28, cy - r - 28, cx + r + 28, cy + r + 28), outline=(210, 180, 120), width=18)
    d.ellipse((cx - r - 8, cy - r - 8, cx + r + 8, cy + r + 8), outline=(245, 215, 160), width=10)

    # faux acanthus/crown protrusions
    d.polygon([(cx - 30, cy - r - 85), (cx, cy - r - 120), (cx + 30, cy - r - 85)], fill=(220, 190, 130))
    d.polygon([(cx - r - 95, cy + 20), (cx - r - 125, cy + 50), (cx - r - 80, cy + 70)], fill=(220, 190, 130))
    d.polygon([(cx + r + 95, cy + 20), (cx + r + 125, cy + 50), (cx + r + 80, cy + 70)], fill=(220, 190, 130))

    return cover


def test_parametric_opening_has_angle_variation():
    """Top opening should be tighter than bottom opening."""
    r = 520
    top = _opening_radius(3 * np.pi / 2, r)
    bottom = _opening_radius(np.pi / 2, r)
    assert bottom > top


def test_opening_mask_non_empty_and_centered():
    mask = _build_parametric_opening_mask((1200, 900), 850, 450, 220)
    arr = np.array(mask)
    assert arr.max() > 200
    assert arr[450, 850] > 200  # center is inside opening


def test_cover_overlay_is_transparent_inside_opening():
    cover = _make_cover().convert("RGBA")
    mask = _build_parametric_opening_mask(cover.size, 850, 450, 220)
    overlay = _build_cover_overlay(cover, mask)

    alpha = np.array(overlay.split()[-1])
    assert alpha[450, 850] < 10  # opening center transparent
    assert alpha[40, 40] > 245   # outer area opaque


def test_overlay_composite_preserves_cover_outside_opening_exactly():
    """No bleed guarantee: outside opening must remain pixel-identical to source cover."""
    cx, cy, r = 850, 450, 220
    cover = _make_cover(cx=cx, cy=cy, r=r).convert("RGBA")

    # extreme generated art to expose bleeding if any
    gen = Image.new("RGBA", (1024, 1024), (255, 20, 20, 255))
    gdraw = ImageDraw.Draw(gen)
    gdraw.rectangle((0, 0, 1023, 80), fill=(0, 255, 0, 255))
    gdraw.rectangle((0, 943, 1023, 1023), fill=(0, 0, 255, 255))

    result = _overlay_composite_image(cover, gen, cx, cy, r)

    opening = np.array(_build_parametric_opening_mask(cover.size, cx, cy, r))
    outside = opening == 0

    src = np.array(cover.convert("RGB"), dtype=np.int16)
    out = np.array(result.convert("RGB"), dtype=np.int16)

    diff = np.abs(src - out).sum(axis=2)
    assert diff[outside].max() == 0, "Pixels outside medallion opening changed (bleed)"

    # and inside should actually change
    inside = opening >= 254
    assert diff[inside].mean() > 5


def test_fill_ratio_is_generous():
    assert OVERLAY_FILL_RATIO >= 1.2


def test_overlay_cache_path_is_versioned(tmp_path):
    p = _overlay_cache_path(tmp_path / "cover.jpg", 2850, 1350, 520)
    assert p.name.endswith(f"_{OVERLAY_CACHE_VERSION}.png")


def test_overlay_cache_validation_rejects_broken_alpha():
    w, h = 1200, 900
    # broken/stale overlay: tiny transparent patch far from medallion center
    bad = Image.new("RGBA", (w, h), (10, 10, 10, 255))
    d = ImageDraw.Draw(bad)
    d.rectangle((10, 10, 60, 60), fill=(10, 10, 10, 0))
    assert _overlay_cache_looks_valid(bad, 850, 450, 220) is False


def test_transparent_generated_image_is_flattened():
    gen = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
    d = ImageDraw.Draw(gen)
    d.ellipse((180, 180, 340, 340), fill=(240, 210, 120, 255))
    flat = _flatten_generated_alpha(gen, (26, 39, 68))

    alpha = np.array(flat.split()[-1])
    assert alpha.min() == 255


def test_composite_v3_output_size(tmp_path):
    """File output remains full cover dimensions."""
    cover_path = tmp_path / "cover.jpg"
    cover = _make_cover(3784, 2777, 2850, 1350, 520)
    cover.save(cover_path, "JPEG")

    gen = Image.new("RGB", (768, 768), (200, 100, 50))
    gen_bytes = _image_to_bytes(gen)

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
