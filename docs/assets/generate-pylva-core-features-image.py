#!/usr/bin/env python3
"""Generate the high-resolution Pylva core-features illustration.

Run from the repository root:

    python3 docs/assets/generate-pylva-core-features-image.py
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


WIDTH = 1840
HEIGHT = 760
ROOT = Path(__file__).resolve().parent
OUTPUT = ROOT / "pylva-core-features.png"

# Keep this palette aligned with generate-pylva-flow-image.py.
CREAM = "#f7f4ec"
PANEL = "#fbf8f0"
PAPER = "#fffdf7"
INK = "#14201d"
MUTED = "#66736f"
SUBTLE = "#87918e"
LINE = "#d9d4c8"
TEAL = "#008f7a"
TEAL_DARK = "#056756"
TEAL_SOFT = "#dff3ee"
MINT = "#edf8f4"
ALT_TEAL = "#004845"
ALT_TEAL_DARK = "#003330"
ALT_TEAL_SOFT = "#e8f4f1"


def load_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    candidates = [
        "/System/Library/Fonts/SFNS.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        (
            "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
            if bold
            else "/System/Library/Fonts/Supplemental/Arial.ttf"
        ),
    ]
    for path in candidates:
        try:
            return ImageFont.truetype(path, size=size)
        except OSError:
            continue
    return ImageFont.load_default()


FONT_20 = load_font(20)
FONT_20_BOLD = load_font(20, bold=True)
FONT_22 = load_font(22)
FONT_22_BOLD = load_font(22, bold=True)
FONT_24 = load_font(24)
FONT_24_BOLD = load_font(24, bold=True)
FONT_26 = load_font(26)
FONT_26_BOLD = load_font(26, bold=True)
FONT_28 = load_font(28)
FONT_30_BOLD = load_font(30, bold=True)
FONT_34_BOLD = load_font(34, bold=True)
FONT_36_BOLD = load_font(36, bold=True)


def text_size(
    draw: ImageDraw.ImageDraw, text: str, font: ImageFont.ImageFont
) -> tuple[int, int]:
    box = draw.textbbox((0, 0), text, font=font)
    return box[2] - box[0], box[3] - box[1]


def draw_centered(
    draw: ImageDraw.ImageDraw,
    center: tuple[float, float],
    text: str,
    font: ImageFont.ImageFont,
    fill: str = INK,
) -> None:
    box = draw.textbbox((0, 0), text, font=font)
    x = center[0] - (box[0] + box[2]) / 2
    y = center[1] - (box[1] + box[3]) / 2
    draw.text((x, y), text, font=font, fill=fill)


def draw_tracking_text(
    draw: ImageDraw.ImageDraw,
    xy: tuple[int, int],
    text: str,
    font: ImageFont.ImageFont,
    fill: str,
    tracking: int = 4,
) -> None:
    x, y = xy
    for character in text:
        draw.text((x, y), character, font=font, fill=fill)
        x += text_size(draw, character, font)[0] + tracking


def draw_wrapped_pixels(
    draw: ImageDraw.ImageDraw,
    xy: tuple[int, int],
    text: str,
    font: ImageFont.ImageFont,
    fill: str,
    max_width: int,
    line_gap: int = 8,
) -> int:
    words = text.split()
    lines: list[str] = []
    current = ""
    for word in words:
        candidate = word if not current else f"{current} {word}"
        if current and text_size(draw, candidate, font)[0] > max_width:
            lines.append(current)
            current = word
        else:
            current = candidate
    if current:
        lines.append(current)

    x, y = xy
    for line in lines:
        draw.text((x, y), line, font=font, fill=fill)
        y += text_size(draw, line, font)[1] + line_gap
    return y


def rounded_rect(
    draw: ImageDraw.ImageDraw,
    box: tuple[int, int, int, int],
    radius: int,
    fill: str,
    outline: str | None = None,
    width: int = 2,
) -> None:
    draw.rounded_rectangle(
        box, radius=radius, fill=fill, outline=outline, width=width
    )


def draw_pill(
    draw: ImageDraw.ImageDraw,
    box: tuple[int, int, int, int],
    text: str,
    fill: str,
    outline: str,
    text_fill: str,
    font: ImageFont.ImageFont = FONT_20_BOLD,
) -> None:
    rounded_rect(draw, box, (box[3] - box[1]) // 2, fill, outline, 2)
    draw_centered(
        draw,
        ((box[0] + box[2]) / 2, (box[1] + box[3]) / 2),
        text,
        font,
        text_fill,
    )


def draw_track_icon(draw: ImageDraw.ImageDraw, box: tuple[int, int, int, int]) -> None:
    x1, y1, x2, y2 = box
    rounded_rect(draw, box, 15, TEAL_SOFT, TEAL, 3)
    cx = (x1 + x2) // 2
    draw.ellipse((cx - 23, y1 + 17, cx + 23, y1 + 33), outline=TEAL_DARK, width=4)
    draw.line((cx - 23, y1 + 25, cx - 23, y2 - 20), fill=TEAL_DARK, width=4)
    draw.line((cx + 23, y1 + 25, cx + 23, y2 - 20), fill=TEAL_DARK, width=4)
    draw.arc((cx - 23, y1 + 34, cx + 23, y1 + 53), 0, 180, fill=TEAL_DARK, width=4)
    draw.arc((cx - 23, y1 + 47, cx + 23, y1 + 66), 0, 180, fill=TEAL_DARK, width=4)
    draw.arc((cx - 23, y2 - 37, cx + 23, y2 - 18), 0, 180, fill=TEAL_DARK, width=4)


def draw_control_icon(draw: ImageDraw.ImageDraw, box: tuple[int, int, int, int]) -> None:
    x1, y1, x2, y2 = box
    rounded_rect(draw, box, 15, ALT_TEAL_SOFT, ALT_TEAL, 3)
    left = x1 + 18
    right = x2 - 18
    ys = [y1 + 23, y1 + 42, y1 + 61]
    knobs = [x1 + 43, x1 + 63, x1 + 34]
    for y, knob in zip(ys, knobs, strict=True):
        draw.line((left, y, right, y), fill=ALT_TEAL, width=4)
        draw.ellipse((knob - 6, y - 6, knob + 6, y + 6), fill=PAPER, outline=TEAL, width=4)


def draw_bill_icon(draw: ImageDraw.ImageDraw, box: tuple[int, int, int, int]) -> None:
    x1, y1, x2, y2 = box
    rounded_rect(draw, box, 15, TEAL_SOFT, TEAL, 3)
    left = x1 + 22
    top = y1 + 12
    right = x2 - 22
    bottom = y2 - 12
    fold = 10
    document = [
        (left, top),
        (right - fold, top),
        (right, top + fold),
        (right, bottom),
        (left, bottom),
        (left, top),
    ]
    draw.polygon(document[:-1], fill=PAPER)
    draw.line(document, fill=TEAL_DARK, width=3, joint="curve")
    draw.line(
        (right - fold, top, right - fold, top + fold, right, top + fold),
        fill=TEAL_DARK,
        width=3,
    )
    draw.line((left + 8, top + 21, right - 8, top + 21), fill=TEAL, width=3)
    draw.line((left + 8, top + 31, right - 15, top + 31), fill=TEAL, width=3)
    draw_centered(draw, ((left + right) / 2, top + 45), "$", FONT_20_BOLD, ALT_TEAL)


def draw_card_header(
    draw: ImageDraw.ImageDraw,
    box: tuple[int, int, int, int],
    label: str,
    title: str,
    description: str,
    icon_drawer,
) -> None:
    x1, y1, x2, _ = box
    icon_drawer(draw, (x1 + 30, y1 + 30, x1 + 108, y1 + 108))
    draw_tracking_text(draw, (x1 + 130, y1 + 51), label, FONT_22_BOLD, ALT_TEAL, 5)
    draw.text((x1 + 30, y1 + 140), title, font=FONT_34_BOLD, fill=INK)
    draw_wrapped_pixels(
        draw,
        (x1 + 30, y1 + 192),
        description,
        FONT_24,
        MUTED,
        max_width=x2 - x1 - 60,
        line_gap=8,
    )


def draw_track_visual(draw: ImageDraw.ImageDraw, box: tuple[int, int, int, int]) -> None:
    x1, y1, x2, y2 = box
    rounded_rect(draw, box, 14, PANEL, LINE, 2)
    draw_tracking_text(draw, (x1 + 22, y1 + 16), "API COSTS", FONT_20_BOLD, SUBTLE, 3)

    rows = [
        ("OpenAI", "LLM API", "$12.80"),
        ("ElevenLabs", "NON-LLM API", "$4.50"),
    ]
    for index, (provider, category, amount) in enumerate(rows):
        y = y1 + 58 + index * 58
        draw.text((x1 + 22, y), provider, font=FONT_24_BOLD, fill=INK)
        pill_width = 122 if category == "LLM API" else 158
        draw_pill(
            draw,
            (x1 + 184, y - 3, x1 + 184 + pill_width, y + 32),
            category,
            MINT if category == "LLM API" else ALT_TEAL_SOFT,
            TEAL if category == "LLM API" else ALT_TEAL,
            TEAL_DARK if category == "LLM API" else ALT_TEAL_DARK,
        )
        amount_width = text_size(draw, amount, FONT_24_BOLD)[0]
        draw.text((x2 - 22 - amount_width, y), amount, font=FONT_24_BOLD, fill=INK)
        if index == 0:
            draw.line((x1 + 22, y + 43, x2 - 22, y + 43), fill=LINE, width=2)

    summary = (x1 + 18, y2 - 56, x2 - 18, y2 - 16)
    rounded_rect(draw, summary, 12, PAPER, TEAL, 2)
    draw.text((summary[0] + 16, summary[1] + 8), "Acme  ·  Agent run #4821", font=FONT_20, fill=MUTED)
    draw.text((summary[2] - 104, summary[1] + 7), "$17.30", font=FONT_22_BOLD, fill=TEAL_DARK)


def draw_control_visual(draw: ImageDraw.ImageDraw, box: tuple[int, int, int, int]) -> None:
    x1, y1, x2, y2 = box
    rounded_rect(draw, box, 14, PANEL, LINE, 2)
    draw_tracking_text(draw, (x1 + 22, y1 + 16), "BEFORE NEXT CALL", FONT_20_BOLD, SUBTLE, 3)

    draw.text((x1 + 22, y1 + 62), "Customer budget", font=FONT_24_BOLD, fill=INK)
    draw.text((x1 + 22, y1 + 94), "$18.42 of $50", font=FONT_22, fill=MUTED)
    draw_pill(draw, (x2 - 120, y1 + 65, x2 - 22, y1 + 101), "ALLOW", MINT, TEAL, TEAL_DARK)

    draw.line((x1 + 22, y1 + 126, x2 - 22, y1 + 126), fill=LINE, width=2)
    draw.text((x1 + 22, y1 + 147), "Model routing", font=FONT_24_BOLD, fill=INK)
    draw.text((x1 + 22, y1 + 179), "Claude Fable 5 to GPT-4o mini", font=FONT_22, fill=MUTED)
    draw_pill(
        draw,
        (x2 - 120, y1 + 150, x2 - 22, y1 + 186),
        "ROUTE",
        ALT_TEAL_SOFT,
        ALT_TEAL,
        ALT_TEAL_DARK,
    )

    draw.text((x1 + 22, y2 - 37), "Protect customer limits and margin", font=FONT_20, fill=MUTED)


def draw_bill_visual(draw: ImageDraw.ImageDraw, box: tuple[int, int, int, int]) -> None:
    x1, y1, x2, y2 = box
    rounded_rect(draw, box, 14, PANEL, LINE, 2)
    draw_tracking_text(draw, (x1 + 22, y1 + 16), "CUSTOMER INVOICE", FONT_20_BOLD, SUBTLE, 3)

    rows = [("Measured usage", "$42.00"), ("Markup", "$6.20")]
    for index, (label, amount) in enumerate(rows):
        y = y1 + 63 + index * 50
        draw.text((x1 + 22, y), label, font=FONT_24, fill=INK)
        amount_width = text_size(draw, amount, FONT_24_BOLD)[0]
        draw.text((x2 - 22 - amount_width, y), amount, font=FONT_24_BOLD, fill=INK)

    draw.line((x1 + 22, y1 + 155, x2 - 22, y1 + 155), fill=LINE, width=2)
    draw.text((x1 + 22, y1 + 177), "Invoice draft", font=FONT_26_BOLD, fill=INK)
    total_width = text_size(draw, "$48.20", FONT_26_BOLD)[0]
    draw.text((x2 - 22 - total_width, y1 + 177), "$48.20", font=FONT_26_BOLD, fill=TEAL_DARK)

    status_y = y2 - 34
    draw.ellipse((x1 + 22, status_y - 12, x1 + 46, status_y + 12), fill=TEAL)
    draw.line(
        (x1 + 29, status_y, x1 + 34, status_y + 5, x1 + 41, status_y - 6),
        fill=PAPER,
        width=3,
    )
    draw.text((x1 + 58, status_y - 11), "Stripe draft created", font=FONT_20_BOLD, fill=TEAL_DARK)


def draw_feature_card(
    draw: ImageDraw.ImageDraw,
    box: tuple[int, int, int, int],
    label: str,
    title: str,
    description: str,
    icon_drawer,
    visual_drawer,
) -> None:
    x1, y1, x2, y2 = box
    rounded_rect(draw, box, 18, PAPER, LINE, 3)
    draw_card_header(draw, box, label, title, description, icon_drawer)
    visual_drawer(draw, (x1 + 30, y1 + 322, x2 - 30, y2 - 30))


def generate() -> None:
    image = Image.new("RGBA", (WIDTH, HEIGHT), CREAM)
    draw = ImageDraw.Draw(image)
    rounded_rect(
        draw,
        (54, 30, WIDTH - 54, HEIGHT - 30),
        28,
        PANEL,
        "#e4ded0",
        3,
    )

    cards = [
        (
            (94, 64, 626, 696),
            "TRACK",
            "Customer cost attribution",
            "Attribute LLM and non-LLM API costs to the customer and agent run that created them.",
            draw_track_icon,
            draw_track_visual,
        ),
        (
            (654, 64, 1186, 696),
            "CONTROL",
            "Usage controls",
            "Apply customer budgets and model-routing rules before the next call.",
            draw_control_icon,
            draw_control_visual,
        ),
        (
            (1214, 64, 1746, 696),
            "BILL",
            "Billing-ready metering",
            "Turn measured usage into per-customer invoice drafts and Stripe line items.",
            draw_bill_icon,
            draw_bill_visual,
        ),
    ]
    for card in cards:
        draw_feature_card(draw, *card)

    image.convert("RGB").save(OUTPUT, format="PNG", optimize=True)
    print(f"Wrote {OUTPUT.relative_to(Path.cwd())} ({OUTPUT.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    generate()
