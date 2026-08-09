"""
Animate the intro and outro as frame sequences.

A `zoompan` push-in was the wrong instinct: it is the move you make when you
have a still and want it to stop looking like one, and it reads as a slideshow
transition rather than a title. These are animated properly — the logo drops in
and settles with a slight overshoot, the tagline rises under it, the plate and
button follow, and the marks fade up last.

Rendering frames in PIL rather than composing filters keeps every element on its
own easing curve, which a filter graph makes painful.

Run: python3 make-intro.py <outdir> intro|outro
"""
import math
import sys
from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H, FPS = 1920, 1080, 30
ROOT = "/Volumes/Extreme SSD/Projects/mempire"
HERE = f"{ROOT}/videos/gameplay-demo"

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
DIM_ON_WOOD = (246, 230, 204)
TEAL = (20, 241, 149)
PURPLE = (153, 69, 255)

out_dir, which = sys.argv[1], sys.argv[2]
F = f"{HERE}/brand/fonts"
disp = lambda s: ImageFont.truetype(f"{F}/LilitaOne.ttf", s)      # noqa: E731
body = lambda s: ImageFont.truetype(f"{F}/HankenGrotesk.ttf", s)  # noqa: E731
mono = lambda s: ImageFont.truetype(f"{F}/MartianMono.ttf", s)    # noqa: E731


def ease_out(t):
    return 1 - pow(1 - min(max(t, 0), 1), 3)


def overshoot(t):
    """Settles past its mark and comes back — how a game UI lands a panel."""
    t = min(max(t, 0), 1)
    c1, c3 = 1.70158, 2.70158
    return 1 + c3 * pow(t - 1, 3) + c1 * pow(t - 1, 2)


def field():
    img = Image.new("RGB", (W, H), BLUE)
    d = ImageDraw.Draw(img)
    for i in range(120, 0, -1):
        k = i / 120
        t = min(1.0, k / 0.72)
        col = tuple(round(BLUE_LIT[c] + (BLUE_DEEP[c] - BLUE_LIT[c]) * t) for c in range(3))
        d.ellipse([W / 2 - W * 1.2 * k, -H * 1.6 * k, W / 2 + W * 1.2 * k, H * 1.6 * k], fill=col)
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
    return Image.alpha_composite(img.convert("RGBA"), q)


BASE = field()
LOGO = Image.open(f"{ROOT}/app/public/art/logo.png").convert("RGBA")
try:
    MB = Image.open(f"{HERE}/brand/magicblock.png").convert("RGBA")
except Exception:
    MB = None
try:
    SOL = Image.open(f"{HERE}/brand/solana.png").convert("RGBA")
except Exception:
    SOL = None


def alpha(img, a):
    if a >= 1:
        return img
    o = img.copy()
    o.putalpha(o.getchannel("A").point(lambda p: int(p * max(a, 0))))
    return o


def outlined(d, text, f, y, fill, stroke=5, alpha_=1.0):
    l, t, r, b = d.textbbox((0, 0), text, font=f)
    x = (W - (r - l)) / 2 - l
    col = (*fill, int(255 * alpha_))
    d.text((x, y - t), text, font=f, fill=col,
           stroke_width=stroke, stroke_fill=(*INK, int(255 * alpha_)))
    return b - t


def wood(d, box, radius=18):
    x0, y0, x1, y1 = box
    d.rounded_rectangle([x0 - 6, y0 - 6, x1 + 6, y1 + 8], radius + 6, fill=WOOD_EDGE)
    d.rounded_rectangle([x0, y0, x1, y1], radius, fill=WOOD)
    d.rounded_rectangle([x0, y0, x1, y0 + 10], radius, fill=WOOD_HI)
    d.rounded_rectangle([x0, y1 - 12, x1, y1], radius, fill=WOOD_DARK)


def button(img, cx, y, text, f, padx=54, pady=22, a=1.0):
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    l, t, r, b = d.textbbox((0, 0), text, font=f)
    tw, th = r - l, b - t
    x0, x1 = cx - tw / 2 - padx, cx + tw / 2 + padx
    y0, y1 = y, y + th + pady * 2
    d.rounded_rectangle([x0, y0 + 8, x1, y1 + 8], 16, fill=(0, 0, 0, 90))
    d.rounded_rectangle([x0, y0, x1, y1], 16, fill=BTN_GOLD_DARK)
    d.rounded_rectangle([x0, y0, x1, y1 - 9], 16, fill=BTN_GOLD)
    d.rounded_rectangle([x0 + 6, y0 + 5, x1 - 6, y0 + (y1 - y0) * 0.45], 12, fill=BTN_GOLD_HI)
    d.rounded_rectangle([x0, y0, x1, y1], 16, outline=INK, width=4)
    d.text((cx - tw / 2 - l, y0 + pady - t), text, font=f, fill=(255, 255, 255),
           stroke_width=4, stroke_fill=INK)
    return Image.alpha_composite(img, alpha(layer, a))


def intro_frame(i, n):
    t = i / FPS
    img = BASE.copy()

    # A bloom that breathes, so the field is never completely still.
    pulse = 0.5 + 0.5 * math.sin(t * 1.5)
    bl = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(bl).ellipse([W / 2 - 640, 100, W / 2 + 640, 660],
                               fill=(*PURPLE, int(40 + 26 * pulse)))
    img = Image.alpha_composite(img, bl.filter(ImageFilter.GaussianBlur(95)))

    # The logo drops in and overshoots, then floats.
    k = overshoot(t / 0.85) if t < 0.85 else 1.0
    lw = 820
    lg = LOGO.resize((lw, round(LOGO.height * lw / LOGO.width)), Image.LANCZOS)
    float_y = math.sin(max(t - 0.85, 0) * 1.9) * 7
    ly = 150 - (1 - k) * 190 + float_y
    img.alpha_composite(alpha(lg, min(t / 0.35, 1)), ((W - lw) // 2, int(ly)))

    d = ImageDraw.Draw(img)
    base_y = 150 + lg.height + 46

    # Tagline rises.
    a1 = ease_out((t - 0.75) / 0.5)
    if a1 > 0:
        outlined(d, "YOUR BAGS ARE YOUR ARMY", disp(82),
                 base_y + (1 - a1) * 34, GOLD, 5, a1)

    # Plate, then copy.
    a2 = ease_out((t - 1.15) / 0.5)
    if a2 > 0:
        py = base_y + 118 + (1 - a2) * 26
        plate = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        wood(ImageDraw.Draw(plate), [W / 2 - 640, py, W / 2 + 640, py + 132])
        pd = ImageDraw.Draw(plate)
        for j, line in enumerate([
            "Turn any meme coin into a battle-ready fighter.",
            "Mint it, stake into it, and fight for a SOL pot.",
        ]):
            f = body(38)
            l, tt, r, b = pd.textbbox((0, 0), line, font=f)
            pd.text(((W - (r - l)) / 2 - l, py + 26 + j * 52 - tt), line, font=f, fill=DIM_ON_WOOD)
        img = Image.alpha_composite(img, alpha(plate, a2))

    a3 = ease_out((t - 1.6) / 0.45)
    if a3 > 0:
        img = button(img, W / 2, base_y + 300, "PLAY.MEMPIRE.FUN", disp(44), a=a3)

    return img.convert("RGB")


def outro_frame(i, n):
    t = i / FPS
    img = BASE.copy()
    bl = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(bl).ellipse([W / 2 - 720, 20, W / 2 + 720, 440], fill=(*PURPLE, 54))
    img = Image.alpha_composite(img, bl.filter(ImageFilter.GaussianBlur(100)))
    d = ImageDraw.Draw(img)

    y = 60
    a0 = ease_out(t / 0.5)
    y += outlined(d, "BUILT ON SOLANA", disp(64), y + (1 - a0) * 22, GOLD, 5, a0) + 10
    a1 = ease_out((t - 0.2) / 0.5)
    y += outlined(d, "RUNNING ON MAGICBLOCK", disp(64), y + (1 - a1) * 22, GOLD, 5, a1) + 30

    # The two marks, side by side, fading up together.
    a2 = ease_out((t - 0.55) / 0.6)
    if a2 > 0 and (MB or SOL):
        marks, gap = [], 70
        if SOL:
            s = SOL.resize((88, round(SOL.height * 88 / SOL.width)), Image.LANCZOS)
            marks.append(s)
        if MB:
            m = MB.resize((300, round(MB.height * 300 / MB.width)), Image.LANCZOS)
            marks.append(m)
        total = sum(m.width for m in marks) + gap * (len(marks) - 1)
        x = (W - total) // 2
        tallest = max(m.height for m in marks)
        for m in marks:
            img.alpha_composite(alpha(m, a2), (x, int(y + (tallest - m.height) / 2)))
            x += m.width + gap
        y += tallest + 34

    rows = [
        ("mempire", "BnLDCAREDpBGenqZr8BTyQu7BCoVewF9XEtMPFBqFxeP"),
        ("mempire_rollup", "3G4GidvjQd3yQK4bqZfem8Kkmcboygze42RcjrXg5g6N"),
        ("mempire_amm", "7tM95L7TooveTGAtmo6nRyJRQpSVADN3DPaagJmSp8CP"),
        ("$MEMPIRE mint", "AhF5trvRTrqRU3gdDGQKCX5H5zZh5WjSw4bmeCwYFpR8"),
    ]
    a3 = ease_out((t - 0.95) / 0.6)
    if a3 > 0:
        ph = 58 * len(rows) + 76
        plate = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        pd = ImageDraw.Draw(plate)
        wood(pd, [W / 2 - 760, y, W / 2 + 760, y + ph])
        f = body(28)
        l, tt, r, b = pd.textbbox((0, 0), "DEPLOYED ON SOLANA DEVNET", font=f)
        pd.text(((W - (r - l)) / 2 - l, y + 20 - tt), "DEPLOYED ON SOLANA DEVNET", font=f, fill=GOLD_HI)
        fm = mono(24)
        gutter = W / 2 - 300
        ry = y + 66
        for name, addr in rows:
            l, tt, r, b = pd.textbbox((0, 0), name, font=f)
            pd.text((gutter - (r - l), ry), name, font=f, fill=DIM_ON_WOOD)
            pd.text((gutter + 44, ry + 2), addr, font=fm, fill=TEAL)
            ry += 58
        img = Image.alpha_composite(img, alpha(plate, a3))
        y += ph + 50

    a4 = ease_out((t - 1.45) / 0.5)
    if a4 > 0:
        img = button(img, W / 2, y, "APP.MEMPIRE.FUN", disp(44), a=a4)

    a5 = ease_out((t - 1.9) / 0.6)
    if a5 > 0:
        d2 = ImageDraw.Draw(img)
        for j, line in enumerate([
            "Match #61 and every transaction in this video are on devnet.",
            "Devnet build — no real funds move.",
        ]):
            f = body(26)
            l, tt, r, b = d2.textbbox((0, 0), line, font=f)
            d2.text(((W - (r - l)) / 2 - l, H - 92 + j * 36 - tt), line, font=f,
                    fill=(200, 216, 245, int(255 * a5)))
    return img.convert("RGB")


SECONDS = 9 if which == "intro" else 18
n = SECONDS * FPS
maker = intro_frame if which == "intro" else outro_frame
for i in range(n):
    maker(i, n).save(f"{out_dir}/{which}_{i:04d}.png")
print(f"{which}: {n} frames")
