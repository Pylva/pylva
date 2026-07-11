#!/usr/bin/env python3
"""Generate the high-resolution README workflow diagram for Pylva.

Run from the repository root:

    python3 docs/assets/generate-pylva-flow-image.py
"""

from __future__ import annotations

import math
from pathlib import Path
from textwrap import wrap

from PIL import Image, ImageDraw, ImageFont


WIDTH = 1840
HEIGHT = 980
ROOT = Path(__file__).resolve().parent
OUTPUT = ROOT / "pylva-flow.png"

CREAM = "#f7f4ec"
PANEL = "#fbf8f0"
PAPER = "#fffdf7"
INK = "#14201d"
MUTED = "#66736f"
LINE = "#d9d4c8"
TEAL = "#008f7a"
TEAL_DARK = "#056756"
TEAL_SOFT = "#dff3ee"
MINT = "#edf8f4"
ALT_TEAL = "#004845"
ALT_TEAL_DARK = "#003330"
ALT_TEAL_SOFT = "#e8f4f1"
BLUE_SOFT = "#edf3fb"


def load_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    candidates = [
        "/System/Library/Fonts/SFNS.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Arial.ttf",
    ]
    for path in candidates:
        try:
            return ImageFont.truetype(path, size=size)
        except OSError:
            continue
    return ImageFont.load_default()


FONT_22 = load_font(22)
FONT_24 = load_font(24)
FONT_26 = load_font(26)
FONT_28 = load_font(28)
FONT_30_BOLD = load_font(30, bold=True)
FONT_32_BOLD = load_font(32, bold=True)
FONT_36_BOLD = load_font(36, bold=True)
FONT_44_BOLD = load_font(44, bold=True)
FONT_52_BOLD = load_font(52, bold=True)


def text_size(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.ImageFont) -> tuple[int, int]:
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


def rounded_rect(
    draw: ImageDraw.ImageDraw,
    box: tuple[int, int, int, int],
    radius: int,
    fill: str,
    outline: str | None = None,
    width: int = 2,
) -> None:
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def draw_card(
    image: Image.Image,
    box: tuple[int, int, int, int],
    radius: int = 18,
    fill: str = PAPER,
    outline: str = LINE,
) -> None:
    draw = ImageDraw.Draw(image)
    rounded_rect(draw, box, radius, fill, outline, 3)


def hex_to_rgb(value: str) -> tuple[int, int, int]:
    value = value.removeprefix("#")
    return int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16)


def step_pill(
    draw: ImageDraw.ImageDraw,
    box: tuple[int, int, int, int],
    number: int,
    label: str,
    fill: str,
    outline: str,
    text_fill: str,
    number_fill: str,
) -> None:
    height = box[3] - box[1]
    circle = height - 12
    circle_x = box[0] + 7
    circle_y = box[1] + 6

    rounded_rect(draw, box, radius=height // 2, fill=fill, outline=outline, width=3)
    draw.ellipse((circle_x, circle_y, circle_x + circle, circle_y + circle), fill=number_fill)
    draw_centered(draw, (circle_x + circle / 2, circle_y + circle / 2), str(number), FONT_22, PAPER)
    draw_centered(
        draw,
        ((circle_x + circle + 11 + box[2] - 8) / 2, (box[1] + box[3]) / 2),
        label,
        FONT_22,
        text_fill,
    )


def draw_wrapped(
    draw: ImageDraw.ImageDraw,
    xy: tuple[int, int],
    text: str,
    font: ImageFont.ImageFont,
    fill: str,
    chars: int,
    line_gap: int = 9,
) -> None:
    x, y = xy
    for line in wrap(text, chars):
        draw.text((x, y), line, font=font, fill=fill)
        y += text_size(draw, line, font)[1] + line_gap


def arrowhead(
    draw: ImageDraw.ImageDraw,
    start: tuple[int, int],
    end: tuple[int, int],
    fill: str,
    size: int = 22,
) -> None:
    angle = math.atan2(end[1] - start[1], end[0] - start[0])
    left = (
        end[0] - size * math.cos(angle - math.pi / 6),
        end[1] - size * math.sin(angle - math.pi / 6),
    )
    right = (
        end[0] - size * math.cos(angle + math.pi / 6),
        end[1] - size * math.sin(angle + math.pi / 6),
    )
    draw.polygon([end, left, right], fill=fill)


def trimmed_segment_end(start: tuple[int, int], end: tuple[int, int], trim: int) -> tuple[int, int]:
    dx = end[0] - start[0]
    dy = end[1] - start[1]
    length = math.hypot(dx, dy)
    if length == 0:
        return end
    ratio = max(0, (length - trim) / length)
    return round(start[0] + dx * ratio), round(start[1] + dy * ratio)


def polyline_arrow(
    draw: ImageDraw.ImageDraw,
    points: list[tuple[int, int]],
    color: str = TEAL,
    width: int = 8,
) -> None:
    segments = list(zip(points, points[1:]))
    for index, (start, end) in enumerate(segments):
        line_end = trimmed_segment_end(start, end, 22) if index == len(segments) - 1 else end
        draw.line((start, line_end), fill=color, width=width)
    arrowhead(draw, points[-2], points[-1], color, size=26)


def pill(
    draw: ImageDraw.ImageDraw,
    box: tuple[int, int, int, int],
    text: str,
    fill: str,
    outline: str,
    text_fill: str,
    font: ImageFont.ImageFont = FONT_24,
) -> None:
    rounded_rect(draw, box, radius=(box[3] - box[1]) // 2, fill=fill, outline=outline, width=3)
    draw_centered(draw, ((box[0] + box[2]) / 2, (box[1] + box[3]) / 2), text, font, text_fill)


def draw_customer(image: Image.Image) -> None:
    draw = ImageDraw.Draw(image)
    draw_card(image, (96, 350, 420, 610), radius=18)
    draw.text((130, 388), "Customer request", font=FONT_30_BOLD, fill=INK)
    draw.ellipse((232, 438, 280, 486), fill=TEAL_SOFT, outline=TEAL, width=5)
    draw.arc((205, 494, 307, 550), 202, -22, fill=TEAL, width=7)
    draw_centered(draw, (258, 562), "Customer", FONT_32_BOLD)
    draw_centered(draw, (258, 590), "uses your AI product", FONT_22, MUTED)


def draw_agent(image: Image.Image) -> None:
    draw = ImageDraw.Draw(image)
    draw_card(image, (590, 270, 1010, 700), radius=18)
    draw.text((644, 316), "Agent runtime", font=FONT_30_BOLD, fill=INK)
    rounded_rect(draw, (648, 390, 952, 486), radius=18, fill=INK)
    draw_centered(draw, (800, 438), "AI Agent / App", FONT_36_BOLD, PAPER)

    rounded_rect(draw, (646, 566, 954, 656), radius=18, fill=TEAL_SOFT, outline=TEAL, width=5)
    draw_centered(draw, (800, 604), "Pylva SDK", FONT_32_BOLD, TEAL_DARK)
    draw_centered(draw, (800, 633), "checks & meters usage", FONT_22, MUTED)


def draw_pylva(image: Image.Image) -> None:
    draw = ImageDraw.Draw(image)
    draw_card(image, (1160, 220, 1740, 650), radius=18)
    draw_centered(draw, (1450, 324), "Pylva Dashboard", FONT_44_BOLD)
    draw_centered(draw, (1450, 368), "control plane for usage and margin", FONT_24, MUTED)

    rows = [("Acme", "$18.42", 250), ("Nova", "$7.10", 132)]
    for index, (name, cost, width) in enumerate(rows):
        y = 432 + index * 68
        draw.text((1226, y - 14), name, font=FONT_26, fill=INK)
        rounded_rect(draw, (1324, y - 9, 1610, y + 13), radius=11, fill="#ece7dc")
        rounded_rect(draw, (1324, y - 9, 1324 + width, y + 13), radius=11, fill=TEAL)
        draw.text((1630, y - 16), cost, font=FONT_26, fill=INK)

    pill(draw, (1232, 560, 1668, 620), "Decision: proceed / limit / fallback", ALT_TEAL_SOFT, ALT_TEAL, ALT_TEAL_DARK)


def draw_billing(image: Image.Image) -> None:
    draw = ImageDraw.Draw(image)
    draw_card(image, (1160, 730, 1740, 890), radius=18)
    draw_centered(draw, (1450, 802), "Billing-ready records", FONT_32_BOLD)
    draw_centered(draw, (1450, 838), "Export to Stripe or your billing system", FONT_24, MUTED)


def draw_flow(image: Image.Image) -> None:
    draw = ImageDraw.Draw(image)
    flow_gap = 16
    flow_pill_height = 38
    dashboard_gap_label_x = 1020
    side_gap = 14

    polyline_arrow(draw, [(420, 475), (590, 475)], TEAL, 9)
    step_pill(
        draw,
        (436, 475 - flow_gap - flow_pill_height, 572, 475 - flow_gap),
        1,
        "request",
        MINT,
        TEAL,
        TEAL_DARK,
        TEAL,
    )

    polyline_arrow(draw, [(800, 486), (800, 566)], TEAL, 8)
    step_pill(
        draw,
        (800 + side_gap, 508, 800 + side_gap + 152, 546),
        2,
        "agent run",
        MINT,
        TEAL,
        TEAL_DARK,
        TEAL,
    )

    polyline_arrow(draw, [(954, 590), (1160, 590)], TEAL, 9)
    step_pill(
        draw,
        (
            dashboard_gap_label_x,
            590 - flow_gap - flow_pill_height,
            dashboard_gap_label_x + 124,
            590 - flow_gap,
        ),
        3,
        "meter",
        MINT,
        TEAL,
        TEAL_DARK,
        TEAL,
    )

    polyline_arrow(draw, [(1160, 640), (954, 640)], ALT_TEAL, 8)
    step_pill(
        draw,
        (
            dashboard_gap_label_x,
            640 + flow_gap,
            dashboard_gap_label_x + 130,
            640 + flow_gap + flow_pill_height,
        ),
        4,
        "decision",
        ALT_TEAL_SOFT,
        ALT_TEAL,
        ALT_TEAL_DARK,
        ALT_TEAL,
    )

    polyline_arrow(draw, [(690, 700), (690, 820), (258, 820), (258, 610)], ALT_TEAL, 8)
    step_pill(
        draw,
        (350, 820 - flow_gap - 40, 598, 820 - flow_gap),
        5,
        "agent responds",
        ALT_TEAL_SOFT,
        ALT_TEAL,
        ALT_TEAL_DARK,
        ALT_TEAL,
    )

    polyline_arrow(draw, [(1450, 650), (1450, 730)], TEAL, 9)
    step_pill(
        draw,
        (1450 + side_gap, 668, 1450 + side_gap + 248, 708),
        6,
        "billing record",
        MINT,
        TEAL,
        TEAL_DARK,
        TEAL,
    )


def draw_header(image: Image.Image) -> None:
    draw = ImageDraw.Draw(image)
    draw_centered(draw, (WIDTH / 2, 105), "From agent request to billing-ready usage", FONT_52_BOLD)
    draw_centered(
        draw,
        (WIDTH / 2, 162),
        "Pylva sits inside your agent runtime through the SDK, then controls, meters, and prepares usage for billing per customer.",
        FONT_28,
        MUTED,
    )


def main() -> None:
    image = Image.new("RGBA", (WIDTH, HEIGHT), CREAM)
    draw = ImageDraw.Draw(image)
    rounded_rect(draw, (54, 52, WIDTH - 54, HEIGHT - 52), radius=28, fill=PANEL, outline="#e4ded0", width=3)

    draw_header(image)
    draw_customer(image)
    draw_agent(image)
    draw_pylva(image)
    draw_billing(image)
    draw_flow(image)

    image.convert("RGB").save(OUTPUT, optimize=True, quality=95)
    print(f"Wrote {OUTPUT.relative_to(Path.cwd())} ({OUTPUT.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
