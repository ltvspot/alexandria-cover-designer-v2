"""Tests for style diversifier and prompt building."""
import pytest
from app.services.prompts import (
    STYLE_POOL,
    STRICT_CONTENT_GUARDRAILS,
    VIVID_COLOR_DIRECTION,
    select_diverse_styles,
    build_diversified_prompt,
    build_prompt,
)


def test_style_pool_has_16_entries():
    assert len(STYLE_POOL) == 16


def test_style_pool_ids_unique():
    ids = [s["id"] for s in STYLE_POOL]
    assert len(ids) == len(set(ids))


def test_style_pool_has_required_keys():
    for style in STYLE_POOL:
        assert "id" in style
        assert "label" in style
        assert "modifier" in style
        assert len(style["modifier"]) > 50  # meaningful modifier text


def test_select_diverse_styles_count():
    styles = select_diverse_styles(5)
    assert len(styles) == 5


def test_select_diverse_styles_cycling():
    """Requesting more than 16 should cycle."""
    styles = select_diverse_styles(20)
    assert len(styles) == 20


def test_select_diverse_styles_all_from_pool():
    styles = select_diverse_styles(16)
    pool_ids = {s["id"] for s in STYLE_POOL}
    for style in styles:
        assert style["id"] in pool_ids


def test_build_diversified_prompt_contains_title():
    style = STYLE_POOL[0]
    prompt = build_diversified_prompt("Emma", "Jane Austen", style)
    assert "Emma" in prompt
    assert "Jane Austen" in prompt


def test_build_diversified_prompt_targets_crop_safe_centering():
    style = STYLE_POOL[0]
    prompt = build_diversified_prompt("Moby Dick", "Herman Melville", style)
    assert "centered" in prompt.lower()
    assert "circle-cropping" in prompt.lower()


def test_build_diversified_prompt_contains_strict_no_text_rules():
    style = STYLE_POOL[0]
    prompt = build_diversified_prompt("Moby Dick", "Herman Melville", style)
    assert STRICT_CONTENT_GUARDRAILS in prompt
    assert "no text" in prompt.lower()
    assert "frame" in prompt.lower()
    assert "no poster layout" in prompt.lower()


def test_build_diversified_prompt_contains_vivid_direction():
    style = STYLE_POOL[0]
    prompt = build_diversified_prompt("Moby Dick", "Herman Melville", style)
    assert VIVID_COLOR_DIRECTION in prompt
    assert "rich saturation" in prompt.lower()
    assert "full-bleed" in prompt.lower()


def test_build_diversified_prompt_contains_style_modifier():
    style = STYLE_POOL[0]  # classical-oil
    prompt = build_diversified_prompt("Pride and Prejudice", "Jane Austen", style)
    assert "Old Masters" in prompt  # from classical-oil modifier


def test_build_diversified_prompt_no_author():
    style = STYLE_POOL[0]
    prompt = build_diversified_prompt("Unknown Book", "", style)
    assert "Unknown Book" in prompt
    assert "Unknown Book by" not in prompt  # No author suffix after title


def test_build_prompt_backwards_compatibility():
    """build_prompt() should still work for old code."""
    prompt = build_prompt("Emma", "Jane Austen", variant=1)
    assert "Emma" in prompt
    assert len(prompt) > 100
