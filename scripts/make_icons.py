# Rebuilds the app icon pack from the 2048px master (build/appicon.png).
#
# Why: the master is a blue "K" glyph on a LIGHT squircle background. On
# the dark Windows taskbar that light squircle reads as a white ring around
# the icon — the user-visible "白边" defect. Earlier threshold stripping
# passes cut the background but left a semi-transparent light halo (the
# anti-aliased edge band), which still read as a white outline at 16px.
#
# Method (flood-fill background removal, halo-free by construction):
#   1. Flood fill from every opaque pixel ADJACENT to full transparency —
#      this seeds exactly on the squircle outline — through "light"
#      pixels (min(r,g,b) >= 200). The fill eats the squircle, the soft
#      drop shadows and the glow trail, but can NEVER cross the saturated
#      glyph body (min-channel < 150), and enclosed highlights (the white
#      swoosh inside the K) are unreachable, so they survive untouched.
#   2. Feather pass: opaque pixels bordering the removed region with
#      min >= 180 are cut (AA residue), 130..180 keep alpha*0.4 (soft edge
#      without a light ring).
#   3. Crop to the glyph bbox, pad to a square with 10% margin, emit every
#      asset: build/appicon.png (1024 master), the multi-size .ico the exe
#      embeds (taskbar/titlebar icon), and the frontend titlebar PNGs.
#      Dark/light composites are written for human inspection.
#
# Usage: python scripts/make_icons.py
import os
import sys
from collections import deque

try:
    from PIL import Image
except ImportError:
    sys.exit("PIL required: pip install pillow")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MASTER = os.path.join(ROOT, "build", "appicon.png")

LIGHT = 200       # flood threshold: min(r,g,b) >= LIGHT is background-like
CUT = 180         # feather: bordering pixels >= CUT lose all alpha
SOFT = 130        # feather: bordering pixels in [SOFT, CUT) keep alpha*0.4
MARGIN = 0.10     # glyph margin inside the square canvas

DARK_BG = (18, 19, 24)   # ink-950 (styles.css)
LIGHT_BG = (250, 250, 252)


def flood_background(im):
    """Return a set of (x,y) forming the connected light background."""
    px = im.load()
    w, h = im.size
    seeds = deque()
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            if min(r, g, b) >= LIGHT:
                # seed only where background touches transparency (or the
                # canvas edge — transparent margins surround the squircle)
                if _near_transparent(px, x, y, w, h):
                    seeds.append((x, y))
    seen = set(seeds)
    while seeds:
        x, y = seeds.popleft()
        for nx, ny in ((x+1,y), (x-1,y), (x,y+1), (x,y-1)):
            if 0 <= nx < w and 0 <= ny < h and (nx, ny) not in seen:
                r, g, b, a = px[nx, ny]
                if a > 0 and min(r, g, b) >= LIGHT:
                    seen.add((nx, ny))
                    seeds.append((nx, ny))
    return seen


def _near_transparent(px, x, y, w, h):
    for nx, ny in ((x+1,y), (x-1,y), (x,y+1), (x,y-1)):
        if not (0 <= nx < w and 0 <= ny < h):
            return True  # canvas edge counts: margins are transparent
        if px[nx, ny][3] == 0:
            return True
    return False


def remove_background(im, bg):
    """Zero the alpha of every background pixel (and its RGB, so the later
    bbox crop ignores the holes)."""
    px = im.load()
    for x, y in bg:
        px[x, y] = (0, 0, 0, 0)


def drop_specks(im):
    """Remove small isolated alpha islands (stray highlight/shadow dots
    that read as dirt once the background is gone). Keeps the largest
    component (the K) and any component >= 0.3% of it (the flying
    squares); anything smaller disappears."""
    px = im.load()
    w, h = im.size
    seen = [[False] * h for _ in range(w)]
    comps = []
    for y0 in range(h):
        for x0 in range(w):
            if seen[x0][y0] or px[x0, y0][3] == 0:
                continue
            q = deque([(x0, y0)])
            seen[x0][y0] = True
            comp = []
            while q:
                x, y = q.popleft()
                comp.append((x, y))
                for nx, ny in ((x+1,y), (x-1,y), (x,y+1), (x,y-1)):
                    if 0 <= nx < w and 0 <= ny < h and not seen[nx][ny] and px[nx, ny][3] > 0:
                        seen[nx][ny] = True
                        q.append((nx, ny))
            comps.append(comp)
    if not comps:
        return
    biggest = max(len(c) for c in comps)
    for comp in comps:
        if len(comp) < biggest * 0.003:
            for x, y in comp:
                px[x, y] = (0, 0, 0, 0)


def feather_edge(im, bg, passes=3):
    """Erode the light AA/shadow band around the glyph. `passes` layers
    deep: each pass recomputes which pixels touch the transparent region,
    so multi-pixel shadow residue is eaten too."""
    px = im.load()
    w, h = im.size
    for _ in range(passes):
        edge = []
        for y in range(h):
            for x in range(w):
                r, g, b, a = px[x, y]
                if a == 0 or min(r, g, b) < SOFT:
                    continue
                if any(
                    not (0 <= nx < w and 0 <= ny < h) or px[nx, ny][3] == 0
                    for nx, ny in ((x+1,y), (x-1,y), (x,y+1), (x,y-1))
                ):
                    edge.append((x, y, r, g, b, a))
        if not edge:
            return
        for x, y, r, g, b, a in edge:
            m = min(r, g, b)
            if m >= CUT:
                px[x, y] = (r, g, b, 0)
            else:
                px[x, y] = (r, g, b, int(a * 0.4))


def glyph_body(im):
    """Crop to the K's main body rows (largest contiguous run of non-empty
    alpha rows). The flying squares sit in an isolated run above the K and
    would otherwise stretch the bbox, making the K itself tiny at 16-32px —
    small sizes crop them away and center the letter instead."""
    alpha = im.getchannel("A")
    w, h = im.size
    ap = alpha.load()
    rows = [any(ap[x, y] > 8 for x in range(w)) for y in range(h)]
    best_start, best_len, run_start = 0, 0, None
    for y in range(h + 1):
        filled = y < h and rows[y]
        if filled and run_start is None:
            run_start = y
        elif not filled and run_start is not None:
            if y - run_start > best_len:
                best_start, best_len = run_start, y - run_start
            run_start = None
    return im.crop((0, best_start, w, best_start + best_len))


def square_pad(im, canvas_px=1024, margin=MARGIN):
    bbox = im.getbbox()
    if bbox:
        im = im.crop(bbox)
    side = max(im.size)
    pad = int(side * MARGIN)
    canvas = Image.new("RGBA", (side + pad * 2, side + pad * 2), (0, 0, 0, 0))
    canvas.alpha_composite(im, (pad, pad))
    return canvas.resize((canvas_px, canvas_px), Image.LANCZOS)


def preview(im, bg):
    canvas = Image.new("RGBA", (im.width + 64, im.height + 64), bg + (255,))
    canvas.alpha_composite(im, (32, 32))
    return canvas


def write_ico(frames, path):
    """Assemble an ICO container manually: PNG-compressed entries (Vista+
    format). Pillow's save(append_images=...) silently dropped the large
    sizes, so we write the bytes ourselves — fully deterministic."""
    import io
    import struct
    pngs = []
    for size, img in frames:
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        pngs.append((size, buf.getvalue()))
    out = bytearray()
    out += struct.pack("<HHH", 0, 1, len(pngs))  # reserved, type=icon, count
    offset = 6 + 16 * len(pngs)
    for size, data in pngs:
        # width/height byte (0 means 256), colorcount 0, reserved 0,
        # planes 1, bpp 32, data length, data offset
        out += struct.pack("<BBBBHHII", size % 256, size % 256, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    for _, data in pngs:
        out += data
    with open(path, "wb") as f:
        f.write(out)


def main():
    im = Image.open(MASTER).convert("RGBA")
    if im.width > 1024:
        im.thumbnail((1024, 1024), Image.LANCZOS)  # pixel loops stay fast

    bg = flood_background(im)
    remove_background(im, bg)
    feather_edge(im, bg)
    drop_specks(im)
    glyph = square_pad(im)

    # master + exe-embedded icon + frontend titlebar assets. Small ICO
    # sizes use the K-body crop (the flying squares would shrink the K
    # into a speck at 16-48px); large sizes keep the full artwork.
    glyph.save(MASTER)
    body = square_pad(glyph_body(glyph), 256, margin=0.06)
    frames = [(s, body.resize((s, s), Image.LANCZOS)) for s in (16, 24, 32, 48)]
    frames += [(s, glyph.resize((s, s), Image.LANCZOS)) for s in (64, 128, 256)]
    write_ico(frames, os.path.join(ROOT, "build", "windows", "kafka_icon.ico"))
    glyph.resize((64, 64), Image.LANCZOS).save(os.path.join(ROOT, "frontend", "public", "appicon.png"))
    glyph.resize((32, 32), Image.LANCZOS).save(os.path.join(ROOT, "frontend", "public", "appicon-32.png"))

    os.makedirs(os.path.join(ROOT, "build", "preview"), exist_ok=True)
    preview(glyph, DARK_BG).save(os.path.join(ROOT, "build", "preview", "icon-on-dark.png"))
    preview(glyph, LIGHT_BG).save(os.path.join(ROOT, "build", "preview", "icon-on-light.png"))
    for size in (16, 32):
        # previews show the SAME art the taskbar shows: K-body frames
        small = body.resize((size, size), Image.LANCZOS)
        canvas = Image.new("RGBA", (size + 32, size + 32), DARK_BG + (255,))
        canvas.alpha_composite(small, (16, 16))
        canvas.save(os.path.join(ROOT, "build", "preview", f"icon-{size}-on-dark.png"))

    print("written build/appicon.png, build/windows/kafka_icon.ico, frontend/public/appicon*.png, build/preview/*")


main()
