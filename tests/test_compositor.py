"""Tests for medallion template compositor."""

from io import BytesIO

import numpy as np
from PIL import Image, ImageDraw

from app.services.compositor import (
    DEFAULT_TEMPLATE_FEATHER,
    TEMPLATE_CACHE_VERSION,
    _create_cover_template,
    _detect_medallion_geometry,
    _derive_inner_radius,
    _find_content_bbox,
    _flatten_generated_alpha,
    _overlay_composite_image,
    _template_cache_looks_valid,
    _template_cache_path,
    composite_v3,
)


def _image_to_bytes(img: Image.Image) -> bytes:
    buf = BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def _make_cover(w=2200, h=1600, cx=1500, cy=800, r=350) -> Image.Image:
    """Synthetic cover with visible ornament-like structure around medallion."""
    cover = Image.new("RGB", (w, h), (26, 39, 68))
    d = ImageDraw.Draw(cover)

    # faux ornament ring
    d.ellipse((cx - r - 30, cy - r - 30, cx + r + 30, cy + r + 30), outline=(210, 180, 120), width=22)
    d.ellipse((cx - r - 8, cy - r - 8, cx + r + 8, cy + r + 8), outline=(245, 215, 160), width=9)

    # faux acanthus/crown protrusions
    d.polygon([(cx - 40, cy - r - 95), (cx, cy - r - 130), (cx + 40, cy - r - 95)], fill=(220, 190, 130))
    d.polygon([(cx - r - 105, cy + 20), (cx - r - 130, cy + 55), (cx - r - 85, cy + 78)], fill=(220, 190, 130))
    d.polygon([(cx + r + 105, cy + 20), (cx + r + 130, cy + 55), (cx + r + 85, cy + 78)], fill=(220, 190, 130))

    return cover


def test_derive_inner_radius_from_legacy_outer():
    assert _derive_inner_radius(520) == 420


def test_derive_inner_radius_passthrough_inner():
    assert _derive_inner_radius(350) == 350


def test_cover_template_center_transparent_and_outside_opaque():
    cx, cy, inner_r = 1500, 800, 350
    cover = _make_cover(cx=cx, cy=cy, r=inner_r).convert("RGBA")

    template = _create_cover_template(cover, cx, cy, inner_r, DEFAULT_TEMPLATE_FEATHER)
    alpha = np.array(template.split()[-1])

    assert alpha[cy, cx] < 10
    assert alpha[20, 20] > 245


def test_template_cache_path_is_versioned(tmp_path):
    p = _template_cache_path(tmp_path / "cover.jpg", 2850, 1350, 350, 8)
    assert p.name.endswith(f"_{TEMPLATE_CACHE_VERSION}.png")


def test_template_cache_validation_rejects_broken_alpha():
    w, h = 1200, 900
    bad = Image.new("RGBA", (w, h), (10, 10, 10, 255))
    d = ImageDraw.Draw(bad)
    d.rectangle((10, 10, 60, 60), fill=(10, 10, 10, 0))
    assert _template_cache_looks_valid(bad, 850, 450, 320) is False


def test_transparent_generated_image_is_flattened():
    gen = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
    d = ImageDraw.Draw(gen)
    d.ellipse((180, 180, 340, 340), fill=(240, 210, 120, 255))
    flat = _flatten_generated_alpha(gen, (26, 39, 68))

    alpha = np.array(flat.split()[-1])
    assert alpha.min() == 255


def test_template_composite_preserves_ornaments_outside_boundary():
    cx, cy, r = 1500, 800, 350
    cover = _make_cover(cx=cx, cy=cy, r=r).convert("RGBA")

    gen = Image.new("RGBA", (1024, 1024), (255, 20, 20, 255))
    gd = ImageDraw.Draw(gen)
    gd.rectangle((0, 0, 1023, 80), fill=(0, 255, 0, 255))
    gd.rectangle((0, 943, 1023, 1023), fill=(0, 0, 255, 255))

    result = _overlay_composite_image(cover, gen, cx, cy, r)

    src = np.array(cover.convert("RGB"), dtype=np.int16)
    out = np.array(result.convert("RGB"), dtype=np.int16)
    diff = np.abs(src - out).sum(axis=2)

    ys, xs = np.mgrid[0:cover.height, 0:cover.width]
    dists = np.sqrt((xs - cx) ** 2 + (ys - cy) ** 2)
    protected_outside = dists > (r + DEFAULT_TEMPLATE_FEATHER + 2)
    inner_core = dists < (r - DEFAULT_TEMPLATE_FEATHER - 2)

    assert diff[protected_outside].max() == 0
    assert diff[inner_core].mean() > 5


def test_template_composite_covers_transparent_cutout_content():
    cx, cy, r = 1500, 800, 350
    cover = _make_cover(cx=cx, cy=cy, r=r).convert("RGBA")
    # Simulate pre-baked legacy artwork in medallion center.
    d = ImageDraw.Draw(cover)
    d.ellipse((cx - r + 12, cy - r + 12, cx + r - 12, cy + r - 12), fill=(165, 95, 25, 255))
    d.rectangle((cx - 210, cy - 30, cx + 210, cy + 30), fill=(30, 20, 10, 255))

    # Transparent cutout-like provider output
    gen = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    gd = ImageDraw.Draw(gen)
    gd.rounded_rectangle((160, 130, 860, 980), radius=120, fill=(210, 200, 170, 255))

    result = _overlay_composite_image(cover, gen, cx, cy, r)

    src = np.array(cover.convert("RGB"), dtype=np.int16)
    out = np.array(result.convert("RGB"), dtype=np.int16)
    diff = np.abs(src - out)

    ys, xs = np.mgrid[0:cover.height, 0:cover.width]
    dists = np.sqrt((xs - cx) ** 2 + (ys - cy) ** 2)
    inner_core = dists < (r - DEFAULT_TEMPLATE_FEATHER - 2)

    unchanged_ratio = (diff[inner_core] <= 2).all(axis=1).sum() / inner_core.sum()
    assert unchanged_ratio < 0.15


def test_composite_v3_output_size(tmp_path):
    """File output remains full cover dimensions."""
    cover_path = tmp_path / "cover.jpg"
    cover = _make_cover(3784, 2777, 2850, 1350, 350)
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


def test_geometry_detector_tracks_shifted_medallion():
    cx, cy, r = 2920, 1650, 500
    cover = _make_cover(3784, 2777, cx=cx, cy=cy, r=r).convert("RGBA")
    d = ImageDraw.Draw(cover)
    d.ellipse((cx - r + 8, cy - r + 8, cx + r - 8, cy + r - 8), fill=(130, 90, 35, 255))

    detected_cx, detected_cy, detected_outer, detected_inner = _detect_medallion_geometry(
        cover_rgba=cover,
        expected_cx=2850,
        expected_cy=1350,
        expected_outer_radius=520,
    )

    assert abs(detected_cx - cx) <= 70
    assert abs(detected_cy - cy) <= 120
    assert abs(detected_outer - r) <= 70
    assert detected_inner > detected_outer * 0.90


def test_template_composite_autodetect_removes_old_art_when_center_is_shifted():
    actual_cx, actual_cy, actual_r = 2910, 1640, 500
    cover = _make_cover(3784, 2777, cx=actual_cx, cy=actual_cy, r=actual_r).convert("RGBA")
    d = ImageDraw.Draw(cover)
    d.ellipse((actual_cx - actual_r + 10, actual_cy - actual_r + 10, actual_cx + actual_r - 10, actual_cy + actual_r - 10), fill=(120, 80, 28, 255))
    d.rectangle((actual_cx - 190, actual_cy - 30, actual_cx + 190, actual_cy + 30), fill=(24, 18, 11, 255))

    gen = Image.new("RGBA", (1024, 1024), (220, 220, 220, 255))
    gd = ImageDraw.Draw(gen)
    gd.ellipse((220, 220, 804, 804), fill=(245, 245, 245, 255))
    gd.ellipse((330, 330, 694, 694), fill=(110, 145, 190, 255))

    # Feed wrong static defaults; compositor should auto-detect actual center/radius.
    result = _overlay_composite_image(cover, gen, 2850, 1350, 520)

    src = np.array(cover.convert("RGB"), dtype=np.int16)
    out = np.array(result.convert("RGB"), dtype=np.int16)
    diff = np.abs(src - out).sum(axis=2)

    ys, xs = np.mgrid[0:cover.height, 0:cover.width]
    dists = np.sqrt((xs - actual_cx) ** 2 + (ys - actual_cy) ** 2)
    inner_changed = dists < (actual_r - 30)
    unchanged_ratio = (diff[inner_changed] <= 2).sum() / inner_changed.sum()

    assert unchanged_ratio < 0.10


def test_content_bbox_detects_sparse_sticker_output():
    img = Image.new("RGBA", (1024, 1024), (230, 230, 230, 255))
    d = ImageDraw.Draw(img)
    d.ellipse((430, 430, 594, 594), fill=(30, 150, 230, 255))

    bbox = _find_content_bbox(img)
    assert bbox is not None

    x0, y0, x1, y1 = bbox
    bw = x1 - x0
    bh = y1 - y0
    assert bw < 450
    assert bh < 450
