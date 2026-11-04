#!/usr/bin/env python3
"""Draws docs/demo.gif: an illustration of the stream-list states (not a screen recording).
Needs Pillow:  python3 -m pip install pillow   and a TrueType font (set FONT=/path/to/font.ttf if needed)."""
import os
from PIL import Image, ImageDraw, ImageFont

W, H = 960, 400
BG, CARD, TEXT, MUTED, ACCENT, GREEN, DARK = "#12141a", "#1d2029", "#f2f4f8", "#98a2b3", "#7b5bff", "#2fbf71", "#0b0c10"
FONT = os.environ.get("FONT") or next(
    p for p in ["/System/Library/Fonts/Helvetica.ttc", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"] if os.path.exists(p)
)
f = lambda size: ImageFont.truetype(FONT, size)

TITLE = "Night of the Living Dead (1968)"


def base(step, caption):
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    d.text((32, 24), TITLE, font=f(26), fill=TEXT)
    d.text((32, 62), "Stremio stream list (illustration)", font=f(16), fill=MUTED)
    d.text((32, H - 44), f"{step}   {caption}", font=f(20), fill=ACCENT)
    return img, d


def card(d, y, left, status, detail, icon=None, pct=None, play=False, highlight=False):
    d.rounded_rectangle((32, y, W - 32, y + 120), 14, fill=CARD, outline=ACCENT if highlight else None, width=2)
    d.text((56, y + 20), left, font=f(20), fill=TEXT)
    d.text((56, y + 52), status, font=f(22), fill=TEXT)
    for i, line in enumerate(detail.split("\n")):
        d.text((260, y + 22 + i * 30), line, font=f(18), fill=MUTED if i else TEXT)
    if pct is not None:
        d.rounded_rectangle((260, y + 90, W - 120, y + 100), 5, fill="#2b2f3b")
        d.rounded_rectangle((260, y + 90, 260 + int((W - 380) * pct / 100), y + 100), 5, fill=ACCENT)
    if play:
        cx, cy = W - 80, y + 60
        d.ellipse((cx - 28, cy - 28, cx + 28, cy + 28), fill=GREEN)
        d.polygon([(cx - 8, cy - 14), (cx - 8, cy + 14), (cx + 14, cy)], fill="white")


def frame_request():
    img, d = base("1", "Open the title and pick the Request entry")
    card(d, 120, "Request", "Download", "Select to send this movie to your media server.\nIt downloads in the background.", highlight=True)
    return img


def frame_notice():
    img = Image.new("RGB", (W, H), DARK)
    d = ImageDraw.Draw(img)
    for text, size, color, y in [("Request sent", 40, TEXT, 150), ("It will download in the background", 26, MUTED, 210)]:
        w = d.textlength(text, font=f(size))
        d.text(((W - w) / 2, y), text, font=f(size), fill=color)
    d.text((32, H - 44), "2   A 4 second notice plays, and the request reaches Radarr", font=f(20), fill=ACCENT)
    return img


def frame_requested():
    img, d = base("3", "Same entry, now reporting status")
    card(d, 120, "Request", "Requested", "Request sent, looking for a release.\nWhen it finishes it will show up in your media server addon.")
    return img


def frame_progress(pct):
    img, d = base("4", "Progress is read from Radarr/Sonarr each time the list opens")
    card(d, 120, "Request", f"Downloading {pct}%", f"Downloading to your media server: {pct}% done.\nWhen it finishes it will show up in your media server addon.", pct=pct)
    return img


def frame_done():
    img, d = base("5", "Done: the file is in the library, so your media server addon offers it")
    card(d, 120, "Media server", "Play", f"{TITLE} Bluray-720p\nFrom your own library", play=True, highlight=True)
    return img


frames = [(frame_request(), 2200), (frame_notice(), 2200), (frame_requested(), 2200)]
frames += [(frame_progress(p), 1100) for p in (18, 41, 67, 93)]
frames += [(frame_done(), 3000)]

out = os.path.join(os.path.dirname(__file__), "..", "docs", "demo.gif")
images = [im.convert("P", palette=Image.ADAPTIVE, colors=64) for im, _ in frames]
images[0].save(out, save_all=True, append_images=images[1:], duration=[ms for _, ms in frames], loop=0, optimize=True)
print("wrote", os.path.abspath(out), os.path.getsize(out) // 1024, "KB")
