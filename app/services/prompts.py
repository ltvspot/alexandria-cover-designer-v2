"""
Prompt generation service with 16-style diversifier.
Exact port of style-diversifier.js + static client prompt logic.
"""
import random
from typing import Dict, List

# Global art-direction guardrails to prevent text plaques, fake medallion rings,
# and decorative overlays inside model output.
STRICT_CONTENT_GUARDRAILS = (
    "IMPORTANT OUTPUT RULES: generate pure full-bleed scene artwork only. "
    "Absolutely no text, letters, words, numbers, logos, signatures, watermarks, "
    "book titles, author names, typographic labels, calligraphy, banners, ribbons, "
    "seals, plaques, crests, or cartouches. "
    "Do not add any border, frame, medallion ring, filigree, ornamental surround, "
    "or decorative edge treatment. "
    "No poster layout, no rectangular panel, no isolated sticker/icon, no empty background matte. "
    "Artwork should extend edge-to-edge with visual detail across the canvas. "
    "The compositor will handle all framing."
)

VIVID_COLOR_DIRECTION = (
    "Use an attention-grabbing, bestseller-grade palette with rich saturation, "
    "luminous highlights, strong color contrast, and cinematic depth, while staying "
    "tasteful and period-appropriate for a classic literary edition."
)

# ─── Style Pool — 16 entries, exact from style-diversifier.js ────────────────
STYLE_POOL: List[Dict] = [
    {
        "id": "classical-oil",
        "label": "Classical Oil",
        "modifier": (
            "Render as a rich classical oil painting in the tradition of the Old Masters — "
            "Rembrandt, Caravaggio, Vermeer. Deep chiaroscuro lighting with a warm amber-brown "
            "palette, thick visible brushstrokes, and dramatic interplay of light and shadow. "
            "Emphasise the emotional weight and gravitas of the scene."
        ),
    },
    {
        "id": "romantic-landscape",
        "label": "Romantic Landscape",
        "modifier": (
            "Paint in the style of Romantic landscape painters — Turner, Friedrich, Bierstadt. "
            "Luminous golden-hour atmosphere, vast sweeping vistas, dramatic skies with towering "
            "clouds. Soft diffused natural light in warm golds, greens, and hazy blues. Capture "
            "the sublime beauty and emotional power of the natural world as it relates to the story."
        ),
    },
    {
        "id": "dark-romantic",
        "label": "Dark Romantic",
        "modifier": (
            "Depict in the Dark Romantic tradition of Caspar David Friedrich and Gustave Doré. "
            "Moonlit or twilight scene with deep indigo, icy blue-white, and charcoal tones. "
            "Haunting, melancholic beauty. A solitary figure or scene that embodies isolation, "
            "mystery, or existential contemplation against a vast, brooding landscape."
        ),
    },
    {
        "id": "pre-raphaelite",
        "label": "Pre-Raphaelite",
        "modifier": (
            "Render in the lush, hyper-detailed Pre-Raphaelite style of Waterhouse, Rossetti, "
            "and Millais. Jewel-toned colours — deep ruby, emerald, sapphire — with meticulous "
            "botanical and textile detail. Ethereal figures with flowing hair and draped fabrics, "
            "surrounded by flowers, water, or mythical elements. Rich symbolism woven into every detail."
        ),
    },
    {
        "id": "art-nouveau",
        "label": "Art Nouveau",
        "modifier": (
            "Create in the style of Alphonse Mucha and Art Nouveau poster art. Flowing organic "
            "lines, sinuous botanical borders of vines and flowers. Muted jewel tones of sage "
            "green, dusty rose, antique gold, and deep teal. Elegant decorative composition with "
            "the subject framed by ornamental elements. Flat colour areas with fine linework."
        ),
    },
    {
        "id": "ukiyo-e",
        "label": "Ukiyo-e Woodblock",
        "modifier": (
            "Reimagine as a Japanese ukiyo-e woodblock print in the tradition of Hokusai and "
            "Hiroshige. Bold black outlines with flat areas of deep indigo, vermillion, pale ochre, "
            "and celadon green. Fine parallel hatching for sky and water. Dramatic spatial tension, "
            "stylised waves, clouds, and natural elements. A striking interplay of pattern and negative space."
        ),
    },
    {
        "id": "noir",
        "label": "Film Noir",
        "modifier": (
            "Depict as a high-contrast film noir composition. Dramatic black-and-white with a "
            "single deep amber or crimson accent. Hard-edged silhouettes, slashing shadows, extreme "
            "chiaroscuro. Evoke the tension and moral ambiguity of 1940s crime fiction posters. "
            "Sharp angular composition with figures partially obscured by darkness."
        ),
    },
    {
        "id": "botanical",
        "label": "Botanical Engraving",
        "modifier": (
            "Render as a vintage natural history or botanical engraving. Exquisitely detailed "
            "scientific illustration with fine intaglio linework, meticulous stipple shading, and "
            "hairline cross-hatching. Delicate hand-applied watercolour washes of soft green, rose, "
            "and golden yellow. In the style of Redouté and Audubon — precision meets artistic beauty."
        ),
    },
    {
        "id": "stained-glass",
        "label": "Gothic Stained Glass",
        "modifier": (
            "Create as a luminous stained glass rose window. Rich jewel-toned panels of ruby red, "
            "cobalt blue, emerald green, and amber gold, separated by bold dark leading lines. Light "
            "streams through the glass creating an ethereal, radiant glow. Medieval Gothic cathedral "
            "aesthetic with intricate tracery and symbolic religious art composition."
        ),
    },
    {
        "id": "impressionist",
        "label": "Impressionist",
        "modifier": (
            "Paint in the Impressionist style of Monet, Renoir, and Pissarro. Visible dappled "
            "brushstrokes capturing fleeting light and atmosphere. Soft pastel palette of lavender, "
            "rose, sky blue, and warm peach. Emphasis on the play of natural sunlight on water, "
            "foliage, or figures. A sense of movement and life frozen in a luminous moment."
        ),
    },
    {
        "id": "expressionist",
        "label": "Expressionist",
        "modifier": (
            "Render in the bold Expressionist style of Munch, Kirchner, and Emil Nolde. Vivid, "
            "distorted colours — acid yellow, blood orange, electric blue — applied in thick, "
            "agitated brushstrokes. Warped perspectives and exaggerated forms that convey raw "
            "emotional intensity. The scene should feel psychologically charged and unsettling."
        ),
    },
    {
        "id": "baroque",
        "label": "Baroque Drama",
        "modifier": (
            "Depict as a grand Baroque composition in the style of Rubens, Velázquez, and Caravaggio. "
            "Theatrical lighting with a single dramatic light source against deep darkness. Rich, "
            "saturated colours — crimson, gold, ivory — with dynamic diagonal composition and intense "
            "physicality. Figures caught mid-action in a moment of high drama."
        ),
    },
    {
        "id": "watercolour",
        "label": "Delicate Watercolour",
        "modifier": (
            "Paint as a refined watercolour illustration. Translucent washes of colour that let the "
            "white ground glow through. Soft, fluid edges with subtle gradations of tone. A restrained "
            "palette of muted blues, sage greens, warm greys, and accents of burnt sienna. Evokes "
            "intimacy and gentleness — like an illustration from a beloved vintage edition."
        ),
    },
    {
        "id": "symbolist",
        "label": "Symbolist Dream",
        "modifier": (
            "Create in the Symbolist tradition of Gustave Moreau, Odilon Redon, and Fernand Khnopff. "
            "A dreamlike, otherworldly scene with rich mystical symbolism. Muted, iridescent colours — "
            "deep purple, tarnished gold, midnight blue — with soft, hazy edges. Figures and elements "
            "that feel archetypal and mythic, hovering between reality and vision."
        ),
    },
    {
        "id": "renaissance",
        "label": "Renaissance Fresco",
        "modifier": (
            "Render as an Italian Renaissance fresco in the tradition of Botticelli, Raphael, and "
            "Michelangelo. Idealised figures with classical proportions, serene expressions, and draped "
            "robes. Warm, earthy fresco palette of terracotta, muted gold, soft blue, and ivory. "
            "Balanced, harmonious composition with architectural elements and celestial light."
        ),
    },
    {
        "id": "russian-realist",
        "label": "Russian Realist",
        "modifier": (
            "Paint in the tradition of 19th-century Russian realism — Ilya Repin, Ivan Kramskoi, "
            "Vasily Vereshchagin. Dense atmospheric detail, muted earth tones of ochre, raw umber, "
            "and slate grey with flashes of colour. Thick expressive brushwork capturing raw human "
            "emotion, social drama, or the vastness of the Russian landscape. Unflinching and deeply humane."
        ),
    },
]

for _style in STYLE_POOL:
    if "no typography" not in _style["modifier"].lower():
        _style["modifier"] += (
            " Keep the output purely pictorial: no typography, no labels, no banners, "
            "no medallion border, and no decorative frame elements."
        )


def select_diverse_styles(count: int) -> List[Dict]:
    """
    Fisher-Yates shuffle the style pool, return `count` items.
    Cycles if count > 16 (mirrors JS: shuffled[i % shuffled.length]).
    """
    pool = STYLE_POOL.copy()
    random.shuffle(pool)  # Python random.shuffle is Fisher-Yates
    selected = []
    for i in range(count):
        selected.append(pool[i % len(pool)])
    return selected


def build_diversified_prompt(title: str, author: str, style: Dict) -> str:
    """
    Port of buildDiversifiedPrompt() from style-diversifier.js.
    Exact same prompt structure.
    """
    author_part = f" by {author}" if author else ""
    return (
        f"Create a beautiful, highly detailed illustration inspired by the narrative of {title}{author_part}. "
        f"First, identify the most iconic scene, character, or symbolic element of this specific story. "
        f"Then depict that scene as a richly detailed full-bleed rectangular scene illustration for a "
        f"luxury classic book cover. The artwork should capture the essence of what makes this particular book "
        f"memorable — its setting, its emotional core, its most dramatic or beautiful moment. "
        f"{style['modifier']} "
        f"{VIVID_COLOR_DIRECTION} "
        f"The composition should keep the primary subject clearly centered with safe margins so circle-cropping "
        f"preserves key details. "
        f"{STRICT_CONTENT_GUARDRAILS}"
    )


# Keep old build_prompt for backwards compatibility
def build_prompt(title: str, author: str, variant: int = 1) -> str:
    """Legacy: picks a style deterministically by variant index."""
    style = STYLE_POOL[(variant - 1) % len(STYLE_POOL)]
    return build_diversified_prompt(title, author, style)


def get_all_prompts(title: str, author: str) -> Dict[int, str]:
    """Return 5 variant prompts for a book (one per style, sequentially)."""
    return {v: build_prompt(title, author, v) for v in range(1, 6)}
