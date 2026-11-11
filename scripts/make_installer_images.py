# Generates the installer wizard images from the app icon:
#   sidebar 328x628 (2x of Inno's 164x314 — Inno 6.3+ downscales on lower
#   DPI, so 150%-scaled displays render crisp instead of blurry)
#   small 116x116 (2x of 58x58)
# Rendered at 4x internal resolution and LANCZOS-downscaled: PIL's arc/line
# primitives are 1x-jagged, supersampling is what makes the curves smooth.
# No company name anywhere: the project is personal/open-source.
import sys

from PIL import Image, ImageDraw, ImageFont

ICON = "build/windows/kafka_icon.ico"
OUT_SIDEBAR = "build/installer/wizard_sidebar.png"
OUT_SMALL = "build/installer/wizard_small.png"
OUT_LOGO = "build/installer/uninstall_logo.bmp"

W, H = 328, 628  # 2x of 164x314
SS = 4  # internal supersampling factor

W_S, H_S = W * SS, H * SS


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def load_fonts(scale):
    # scale converts design-px (1x) to the supersampled canvas
    try:
        return {
            "zh": ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", int(17 * scale)),
            "en": ImageFont.truetype("C:/Windows/Fonts/segoeuib.ttf", int(11 * scale)),
            "beta": ImageFont.truetype("C:/Windows/Fonts/segoeuib.ttf", int(10 * scale)),
        }
    except OSError:
        default = ImageFont.load_default()
        return {k: default for k in ("zh", "en", "beta")}


def main():
    top = (18, 19, 24)      # ink-950
    bottom = (28, 34, 52)   # deep accent-tinted navy
    accent = (79, 140, 255)
    fonts = load_fonts(SS)

    # sidebar at supersampled resolution
    img = Image.new("RGB", (W_S, H_S))
    d = ImageDraw.Draw(img)
    for y in range(H_S):
        d.line([(0, y), (W_S, y)], fill=lerp(top, bottom, y / H_S))
    # subtle accent arcs, echoing the app logo's cable motif
    d.arc([-160, H_S * 2 - 480, 440, H_S * 2 + 160], 200, 340, fill=accent, width=int(3 * SS))
    d.arc([-120, H_S * 2 - 440, 480, H_S * 2 + 200], 200, 340, fill=(43, 61, 94), width=int(5 * SS))

    # icon: largest size stored in the ico
    icon = None
    try:
        ico = Image.open(ICON)
        sizes = sorted(ico.info.get("sizes") or [(256, 256)], reverse=True)
        ico.size = sizes[0]
        icon = ico.resize((144 * SS // 2, 144 * SS // 2), Image.LANCZOS)
        img.paste(icon, ((W_S - icon.width) // 2, int(46 * SS)), icon)
    except Exception as e:
        print(f"icon load failed ({e}) — drawing a plain ring instead")
        d.ellipse([(W_S - 144 * SS) // 2, 92 * SS, (W_S + 144 * SS) // 2, 236 * SS],
                  outline=accent, width=4 * SS)

    # text: design-px (1x) × 2 (hi-dpi canvas) × SS
    tx = W_S // 2
    d.text((tx, 296 * SS), "Kafka Explorer", font=fonts["en"], fill=(233, 236, 244), anchor="mm")
    d.text((tx, 348 * SS), "集群可视化管理", font=fonts["zh"], fill=(226, 232, 240), anchor="mm")
    d.text((tx, H_S - 176 * SS), "BETA", font=fonts["beta"], fill=accent, anchor="mm")

    sidebar = img.resize((W, H), Image.LANCZOS)
    sidebar.save(OUT_SIDEBAR)

    # small image: 116x116 (2x of Inno's 58x58), icon centered on WHITE
    SW, SH = 116, 116
    small = Image.new("RGB", (SW, SH), (255, 255, 255))
    if icon is not None:
        icon92 = icon.resize((92, 92), Image.LANCZOS)
        small.paste(icon92, ((SW - 92) // 2, (SH - 92) // 2), icon92)
    else:
        d2 = ImageDraw.Draw(small)
        d2.ellipse([8, 8, SW - 8, SH - 8], outline=accent, width=6)
    small.save(OUT_SMALL)

    # uninstaller logo: 300x300 white (matches the uninstall form's white
    # background — BMP has no alpha), icon pasted large so the form can
    # stretch it down and stay crisp on high-DPI displays
    LOGO = 300
    logo = Image.new("RGB", (LOGO, LOGO), (255, 255, 255))
    if icon is not None:
        icon256 = icon.resize((256, 256), Image.LANCZOS)
        logo.paste(icon256, ((LOGO - 256) // 2, (LOGO - 256) // 2), icon256)
    else:
        dl = ImageDraw.Draw(logo)
        dl.ellipse([22, 22, LOGO - 22, LOGO - 22], outline=accent, width=10)
    logo.save(OUT_LOGO)

    # wails uninstaller/setup page logo (cmd/*/assets/logo.png): the
    # same mark on white, PNG for the webview. Both front-ends share it.
    OUT_WAILS_LOGO = "cmd/uninstaller/assets/logo.png"
    logo.save(OUT_WAILS_LOGO)
    import shutil
    shutil.copyfile(OUT_WAILS_LOGO, "cmd/setup/assets/logo.png")
    print(f"saved {OUT_SIDEBAR} ({W}x{H}), {OUT_SMALL} ({SW}x{SH}), {OUT_LOGO} ({LOGO}x{LOGO}), {OUT_WAILS_LOGO} (+cmd/setup copy)")

if __name__ == "__main__":
    sys.exit(main())
