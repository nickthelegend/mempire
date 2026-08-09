"""
Render the intro and outro plates in the game's own visual language.

The first version was flat navy with Arial, which looked like a slide deck
bolted onto a game. These are built from `app/src/styles/tokens.css`: the
quilted blue field, carved wood panels, fat bevelled gold buttons and outlined
display lettering — the same chrome the app is wearing in every other shot, so
the cards read as part of the product rather than packaging around it.

The fonts are the app's own, converted from its bundled woff2 (Lilita One for
display, Hanken Grotesk for body, Martian Mono for addresses), so the type on
the cards is literally the type in the game.

Run: python3 make-cards.py <outdir>
"""
import sys
from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H = 1920, 1080
ROOT = "/Volumes/Extreme SSD/Projects/mempire"
HERE = f"{ROOT}/videos/gameplay-demo"

# tokens.css, verbatim
BLUE = (20, 65, 143)
BLUE_LIT = (33, 96, 196)
BLUE_DEEP = (13, 42, 92)
WOOD = (122, 74, 34)
WOOD_HI = (185, 121, 60)
WOOD_DARK = (74, 42, 17)
WOOD_EDGE = (46, 25, 8)
GOLD = (255, 196, 34)
GOLD_HI = (255, 227, 138)
BTN_GOLD = (245, 180, 35)
BTN_GOLD_HI = (255, 215, 102)
BTN_GOLD_DARK = (168, 110, 7)
INK = (16, 32, 63)
WHITE = (255, 255, 255)
DIM_ON_WOOD = (246, 230, 204)
TEAL = (20, 241, 149)
PURPLE = (153, 69, 255)

out = sys.argv[1] if len(sys.argv) > 1 else "."
F = f"{HERE}/brand/fonts"
disp = lambda s: ImageFont.truetype(f"{F}/LilitaOne.ttf", s)      # noqa: E731
body = lambda s: ImageFont.truetype(f"{F}/HankenGrotesk.ttf", s)  # noqa: E731
mono = lambda s: ImageFont.truetype(f"{F}/MartianMono.ttf", s)    # noqa: E731


def quilt():
    """The field the whole app sits on: 46px diamonds over a domed gradient."""
    img = Image.new("RGB", (W, H), BLUE)
    d = ImageDraw.Draw(img)

    # radial-gradient(120% 80% at 50% 0%, blue-lit, blue-deep 72%)
    cx, cy = W / 2, 0
    rx, ry = W * 1.2, H * 1.6
    for i in range(150, 0, -1):
        k = i / 150
        t = min(1.0, k / 0.72)
        col = tuple(round(BLUE_LIT[c] + (BLUE_DEEP[c] - BLUE_LIT[c]) * t) for c in range(3))
        d.ellipse([cx - rx * k, cy - ry * k, cx + rx * k, cy + ry * k], fill=col)

    # The quilt: two light diagonals and two dark ones on a 46px grid, which is
    # what the four stacked linear-gradients in `.quilt` add up to.
    tile = 46
    q = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    qd = ImageDraw.Draw(q)
    for y in range(-tile, H + tile, tile):
        for x in range(-tile, W + tile, tile):
            h = tile / 2
            qd.polygon([(x, y + h), (x + h, y), (x + h, y + h)], fill=(255, 255, 255, 14))
            qd.polygon([(x + h, y), (x + tile, y + h), (x + h, y + h)], fill=(255, 255, 255, 14))
            qd.polygon([(x, y + h), (x + h, y + tile), (x + h, y + h)], fill=(0, 0, 0, 36))
            qd.polygon([(x + h, y + tile), (x + tile, y + h), (x + h, y + h)], fill=(0, 0, 0, 36))
    img = Image.alpha_composite(img.convert("RGBA"), q)
    return img.convert("RGB")


def wood_panel(img, box, radius=18):
    """A carved wood plate: dark edge, warm face, lit top lip."""
    d = ImageDraw.Draw(img, "RGBA")
    x0, y0, x1, y1 = box
    d.rounded_rectangle([x0 - 6, y0 - 6, x1 + 6, y1 + 8], radius + 6, fill=WOOD_EDGE)
    d.rounded_rectangle([x0, y0, x1, y1], radius, fill=WOOD)
    d.rounded_rectangle([x0, y0, x1, y0 + 10], radius, fill=WOOD_HI)
    d.rounded_rectangle([x0, y1 - 12, x1, y1], radius, fill=WOOD_DARK)
    d.rounded_rectangle([x0, y0, x1, y1], radius, outline=(255, 220, 170, 40), width=2)


def gold_button(img, cx, y, text, f, padx=54, pady=22):
    """The app's primary control: bevelled gold with a hard ink outline."""
    d = ImageDraw.Draw(img, "RGBA")
    l, t, r, b = d.textbbox((0, 0), text, font=f)
    tw, th = r - l, b - t
    x0, x1 = cx - tw / 2 - padx, cx + tw / 2 + padx
    y0, y1 = y, y + th + pady * 2
    d.rounded_rectangle([x0, y0 + 8, x1, y1 + 8], 16, fill=(0, 0, 0, 90))
    d.rounded_rectangle([x0, y0, x1, y1], 16, fill=BTN_GOLD_DARK)
    d.rounded_rectangle([x0, y0, x1, y1 - 9], 16, fill=BTN_GOLD)
    d.rounded_rectangle([x0 + 6, y0 + 5, x1 - 6, y0 + (y1 - y0) * 0.45], 12, fill=BTN_GOLD_HI)
    d.rounded_rectangle([x0, y0, x1, y1], 16, outline=INK, width=4)
    outlined(img, cx, y0 + pady - t, text, f, WHITE, stroke=4)
    return y1


def outlined(img, cx, y, text, f, fill, stroke=4, anchor_centre=True):
    """Display lettering: white face, heavy ink stroke, like `.display`."""
    d = ImageDraw.Draw(img)
    l, t, r, b = d.textbbox((0, 0), text, font=f)
    x = (W - (r - l)) / 2 - l if anchor_centre else cx
    d.text((x, y), text, font=f, fill=fill, stroke_width=stroke, stroke_fill=INK)
    return b - t


def glow(img, box, colour, blur=60, alpha=90):
    """A soft bloom, for the logo to sit in."""
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(layer).ellipse(box, fill=(*colour, alpha))
    return Image.alpha_composite(img.convert("RGBA"),
                                 layer.filter(ImageFilter.GaussianBlur(blur))).convert("RGB")


# ── intro ──────────────────────────────────────────────────────────────────
img = quilt()
img = glow(img, [W / 2 - 620, 120, W / 2 + 620, 640], PURPLE, 90, 60)
img = glow(img, [W / 2 - 460, 200, W / 2 + 460, 600], TEAL, 110, 34)

logo = Image.open(f"{ROOT}/app/public/art/logo.png").convert("RGBA")
lw = 820
logo = logo.resize((lw, round(logo.height * lw / logo.width)), Image.LANCZOS)
TOP = 150
img.paste(logo, ((W - lw) // 2, TOP), logo)

y = TOP + logo.height + 46
y += outlined(img, 0, y, "YOUR BAGS ARE YOUR ARMY", disp(82), GOLD, 5) + 54

panel_top = y
wood_panel(img, [W / 2 - 640, panel_top, W / 2 + 640, panel_top + 132])
d = ImageDraw.Draw(img)
for i, line in enumerate([
    "A real-time card battler on Solana, where every",
    "fighter is a meme coin you actually hold.",
]):
    f = body(38)
    l, t, r, b = d.textbbox((0, 0), line, font=f)
    d.text(((W - (r - l)) / 2 - l, panel_top + 26 + i * 52 - t), line, font=f, fill=DIM_ON_WOOD)

gold_button(img, W / 2, panel_top + 190, "PLAY.MEMPIRE.FUN", disp(44))
img.save(f"{out}/intro.png")

# ── outro ──────────────────────────────────────────────────────────────────
img = quilt()
img = glow(img, [W / 2 - 700, 40, W / 2 + 700, 420], PURPLE, 100, 46)

y = 66
y += outlined(img, 0, y, "BUILT ON SOLANA", disp(66), GOLD, 5) + 12
y += outlined(img, 0, y, "RUNNING ON MAGICBLOCK", disp(66), GOLD, 5) + 34

try:
    mb = Image.open(f"{HERE}/brand/magicblock.png").convert("RGBA")
    mw = 340
    mb = mb.resize((mw, round(mb.height * mw / mb.width)), Image.LANCZOS)
    img.paste(mb, ((W - mw) // 2, int(y)), mb)
    y += mb.height + 40
except Exception as e:  # noqa: BLE001 — a missing mark must not kill the render
    print("magicblock mark skipped:", e)

rows = [
    ("mempire", "BnLDCAREDpBGenqZr8BTyQu7BCoVewF9XEtMPFBqFxeP"),
    ("mempire_rollup", "3G4GidvjQd3yQK4bqZfem8Kkmcboygze42RcjrXg5g6N"),
    ("mempire_amm", "7tM95L7TooveTGAtmo6nRyJRQpSVADN3DPaagJmSp8CP"),
    ("$MEMPIRE mint", "AhF5trvRTrqRU3gdDGQKCX5H5zZh5WjSw4bmeCwYFpR8"),
]
panel_h = 58 * len(rows) + 76
wood_panel(img, [W / 2 - 760, y, W / 2 + 760, y + panel_h])
d = ImageDraw.Draw(img)
fh = body(28)
l, t, r, b = d.textbbox((0, 0), "DEPLOYED ON SOLANA DEVNET", font=fh)
d.text(((W - (r - l)) / 2 - l, y + 20 - t), "DEPLOYED ON SOLANA DEVNET", font=fh, fill=GOLD_HI)

fl, fm = body(28), mono(24)
gutter = W / 2 - 300
ry = y + 66
for name, addr in rows:
    l, t, r, b = d.textbbox((0, 0), name, font=fl)
    d.text((gutter - (r - l), ry), name, font=fl, fill=DIM_ON_WOOD)
    d.text((gutter + 44, ry + 2), addr, font=fm, fill=TEAL)
    ry += 58

y += panel_h + 54
gold_button(img, W / 2, y, "APP.MEMPIRE.FUN", disp(44))

d = ImageDraw.Draw(img)
for i, line in enumerate([
    "Match #61 and every transaction in this video are on devnet.",
    "Devnet build — no real funds move.",
]):
    f = body(26)
    l, t, r, b = d.textbbox((0, 0), line, font=f)
    d.text(((W - (r - l)) / 2 - l, H - 96 + i * 36 - t), line, font=f, fill=(200, 216, 245))

img.save(f"{out}/outro.png")
print(f"{out}/intro.png")
print(f"{out}/outro.png")
