# Strips the light squircle background from the app icon so the titlebar
# glyph blends into dark surfaces.
#
# Round 2 (halo fix): the previous pass left semi-transparent light pixels
# in the anti-aliased edge band (they read as a white outline at 16px).
# Now: whiteness >= 180 is cut hard, 120-180 fades, the result is cropped
# to the glyph bounding box (+2px) so no stray light pixels survive, and a
# dark composite is written for visual verification.
# Usage: python strip_icon_bg.py <in.png> <out.png> <dark_preview.png>
import sys

try:
    from PIL import Image
except ImportError:
    sys.exit("PIL required: pip install pillow")

DARK_BG = (15, 16, 24)  # ink-950


def whiteness(px):
    r, g, b = px[0], px[1], px[2]
    return min(r, g, b)


def strip(im):
    im = im.convert("RGBA")
    data = im.load()
    w, h = im.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = data[x, y]
            m = whiteness((r, g, b))
            if m >= 180:
                data[x, y] = (r, g, b, 0)
            elif m >= 120:
                # smooth falloff over the mid band so edges stay soft
                data[x, y] = (r, g, b, int(a * (180 - m) / 60))
    return im


def crop_bbox(im, pad=2):
    bbox = im.getbbox()  # non-zero-alpha extent
    if not bbox:
        return im
    x0, y0, x1, y1 = bbox
    return im.crop((max(0, x0 - pad), max(0, y0 - pad), min(im.width, x1 + pad), min(im.height, y1 + pad)))


def main():
    src, out, preview = sys.argv[1], sys.argv[2], sys.argv[3]
    im = Image.open(src)
    im = strip(im)
    im = crop_bbox(im)
    im.save(out)

    # dark composite for human inspection: pastes the result on ink-950
    canvas = Image.new("RGBA", (im.width + 40, im.height + 40), DARK_BG + (255,))
    canvas.alpha_composite(im, (20, 20))
    canvas.save(preview)
    print("written", out, preview)


main()
