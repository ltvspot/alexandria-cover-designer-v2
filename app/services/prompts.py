"""
Prompt system — generates 5 variants of illustration prompts per book.
"""
from typing import Dict

# Negative prompt applied to all variants
NEGATIVE_PROMPT = (
    "text, letters, words, watermark, signature, photorealistic, 3d render, "
    "cartoon, anime, comic, digital art, modern, neon, flat colors, low quality, "
    "blurry, deformed, ugly, disfigured, extra limbs, missing limbs, "
    "out of frame, duplicate, meme, brand logos"
)

VARIANT_TEMPLATES: Dict[int, str] = {
    1: (
        "Classical pen-and-ink sketch, detailed engraving illustration, sepia tones, "
        "hand-drawn crosshatching, 19th century book illustration style, fine linework, "
        "etching texture. Subject: {subject}. "
        "Negative: {negative}"
    ),
    2: (
        "Detailed engraving in the style of Gustave Doré, intricate crosshatching, "
        "dramatic black-and-white contrast, deep shadows, Victorian era book plate illustration. "
        "Subject: {subject}. "
        "Negative: {negative}"
    ),
    3: (
        "Antique lithograph illustration, hand-tinted, muted earthy palette, "
        "period-authentic engraving detail, aged paper texture feel, "
        "classical 18th-19th century scientific or literary illustration. "
        "Subject: {subject}. "
        "Negative: {negative}"
    ),
    4: (
        "Rich oil painting, dramatic chiaroscuro lighting, deep golden tones, "
        "renaissance quality brushwork, deep shadows and luminous highlights, "
        "masterwork composition, old masters style. "
        "Subject: {subject}. "
        "Negative: {negative}"
    ),
    5: (
        "Watercolor illustration with woodcut elements, period-specific art style, "
        "symbolic and allegorical composition, soft washes of color, "
        "fine ink outlines, evocative and atmospheric. "
        "Subject: {subject}. "
        "Negative: {negative}"
    ),
}


def build_prompt(title: str, author: str, variant: int = 1) -> str:
    """Build a generation prompt for a specific book and variant (1-5)."""
    variant = max(1, min(5, variant))
    subject = f'an illustration for the book "{title}" by {author}' if author else f'an illustration for the book "{title}"'
    template = VARIANT_TEMPLATES[variant]
    return template.format(subject=subject, negative=NEGATIVE_PROMPT)


def get_all_prompts(title: str, author: str) -> Dict[int, str]:
    """Return all 5 variant prompts for a book."""
    return {v: build_prompt(title, author, v) for v in range(1, 6)}
