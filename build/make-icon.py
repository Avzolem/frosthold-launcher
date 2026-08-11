#!/usr/bin/env python3
"""Genera build/icon.ico: un copo de seis brazos sobre fondo azul noche.

Se dibuja a 1024 px y se reduce con suavizado, porque un copo trazado
directamente a 16 px queda como una mancha.
"""

from PIL import Image, ImageDraw
import math
import os

SIZE = 1024
BG_OUTER = (5, 11, 20)
BG_INNER = (16, 34, 58)
ICE = (168, 224, 252)
ICE_SOFT = (125, 211, 252)

base = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
draw = ImageDraw.Draw(base)

# Fondo: cuadrado de esquinas redondeadas con un degradado radial pobre pero
# suficiente, hecho con círculos concéntricos.
radius = int(SIZE * 0.18)
draw.rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=radius, fill=BG_OUTER)

glow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
gdraw = ImageDraw.Draw(glow)
steps = 60
for i in range(steps, 0, -1):
    t = i / steps
    r = int(SIZE * 0.62 * t)
    a = int(70 * (1 - t) ** 1.6)
    color = (
        int(BG_INNER[0] + (BG_OUTER[0] - BG_INNER[0]) * t),
        int(BG_INNER[1] + (BG_OUTER[1] - BG_INNER[1]) * t),
        int(BG_INNER[2] + (BG_OUTER[2] - BG_INNER[2]) * t),
        a,
    )
    cx = SIZE * 0.42
    cy = SIZE * 0.34
    gdraw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=color)

mask = Image.new("L", (SIZE, SIZE), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=radius, fill=255)
base = Image.alpha_composite(base, Image.composite(glow, Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0)), mask))
draw = ImageDraw.Draw(base)

cx = cy = SIZE / 2
arm = SIZE * 0.36
main_w = int(SIZE * 0.030)
branch_w = int(SIZE * 0.020)


def line(x1, y1, x2, y2, width, color):
    draw.line([x1, y1, x2, y2], fill=color, width=width)
    # Las puntas redondeadas evitan el aspecto de cruz de farmacia.
    for x, y in ((x1, y1), (x2, y2)):
        r = width / 2
        draw.ellipse([x - r, y - r, x + r, y + r], fill=color)


for k in range(6):
    ang = math.radians(60 * k - 90)
    ex = cx + arm * math.cos(ang)
    ey = cy + arm * math.sin(ang)
    line(cx, cy, ex, ey, main_w, ICE)

    # Dos pares de ramas por brazo, a distinta altura y tamaño.
    for frac, length in ((0.45, 0.20), (0.72, 0.13)):
        bx = cx + arm * frac * math.cos(ang)
        by = cy + arm * frac * math.sin(ang)
        for side in (-1, 1):
            bang = ang + side * math.radians(58)
            line(
                bx,
                by,
                bx + arm * length * math.cos(bang),
                by + arm * length * math.sin(bang),
                branch_w,
                ICE_SOFT,
            )

# Núcleo hexagonal, para que a 16 px no desaparezca el centro.
hexr = SIZE * 0.055
draw.polygon(
    [
        (cx + hexr * math.cos(math.radians(60 * i - 90)), cy + hexr * math.sin(math.radians(60 * i - 90)))
        for i in range(6)
    ],
    fill=ICE,
)

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icon.ico")
sizes = [(s, s) for s in (16, 24, 32, 48, 64, 128, 256)]
base.save(out, format="ICO", sizes=sizes)

png = out.replace(".ico", ".png")
base.resize((256, 256), Image.LANCZOS).save(png)
print(f"icono: {out} ({os.path.getsize(out)} B) y {png}")
