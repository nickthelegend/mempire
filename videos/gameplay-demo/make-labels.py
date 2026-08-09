"""
Render the two-up overlay as a transparent PNG.

This ffmpeg is built without libfreetype, so `drawtext` does not exist and the
labels cannot be burned in by the filter graph. PIL is available and renders
better type anyway — real kerning, and a pill background sized to the text
rather than ffmpeg's `boxborderw` approximation.

One 1920x1080 RGBA layer holding every label, composited in a single `overlay`.

Run: python3 make-labels.py <out.png> <matchId>
"""
import sys
from PIL import Image, ImageDraw, ImageFont

W, H = 1920, 1080
COL_W = 498
GAP = 44
X1 = round((W - (COL_W * 2 + GAP)) / 2)
X2 = X1 + COL_W + GAP

out_path = sys.argv[1] if len(sys.argv) > 1 else "labels.png"
match_id = sys.argv[2] if len(sys.argv) > 2 else "61"

FONT = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
seat_font = ImageFont.truetype(FONT, 30)
foot_font = ImageFont.truetype(FONT, 32)

img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
d = ImageDraw.Draw(img)


def pill(x, y, text, font, anchor_centre=False):
    """A label on its own rounded plate, so it reads over any frame."""
    l, t, r, b = d.textbbox((0, 0), text, font=font)
    tw, th = r - l, b - t
    padx, pady = 18, 12
    if anchor_centre:
        x = (W - (tw + padx * 2)) // 2
    d.rounded_rectangle(
        [x, y, x + tw + padx * 2, y + th + pady * 2],
        radius=10,
        fill=(11, 27, 58, 200),
        outline=(255, 255, 255, 40),
        width=2,
    )
    d.text((x + padx - l, y + pady - t), text, font=font, fill=(255, 255, 255, 240))


pill(X1 + 14, 18, "SEAT A", seat_font)
pill(X2 + 14, 18, "SEAT B", seat_font)
# The claim, said plainly. Two top-down arenas drawn from opposite ends never
# announce themselves as one game, however well aligned they are.
pill(0, H - 78, f"ONE MATCH  ·  #{match_id} on Solana devnet  ·  two machines",
     foot_font, anchor_centre=True)

img.save(out_path)
print(out_path)
