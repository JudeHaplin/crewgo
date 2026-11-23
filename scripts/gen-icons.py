#!/usr/bin/env python3
"""生成应用图标（飞牛 fpk 需要 64/256 两档）。需要 Pillow。"""
import os
from PIL import Image, ImageDraw, ImageFont

BLUE = (43, 110, 246)
DARK = (28, 74, 178)
WHITE = (255, 255, 255)
OUT = os.path.join(os.path.dirname(__file__), '..', 'deploy', 'fnos')

FONT_CANDIDATES = [
    'C:/Windows/Fonts/msyhbd.ttc',
    'C:/Windows/Fonts/msyh.ttc',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
]


def font(size):
    for p in FONT_CANDIDATES:
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def make(size):
    scale = 4                      # 先画大图再缩小，边缘更干净
    S = size * scale
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # 圆角底：竖向渐变
    radius = int(S * 0.22)
    mask = Image.new('L', (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=radius, fill=255)
    grad = Image.new('RGB', (1, S))
    for y in range(S):
        t = y / max(1, S - 1)
        grad.putpixel((0, y), (
            int(BLUE[0] + (DARK[0] - BLUE[0]) * t),
            int(BLUE[1] + (DARK[1] - BLUE[1]) * t),
            int(BLUE[2] + (DARK[2] - BLUE[2]) * t),
        ))
    img.paste(grad.resize((S, S)), (0, 0), mask)

    # 白色「维」字
    f = font(int(S * 0.56))
    text = '维'
    box = d.textbbox((0, 0), text, font=f)
    d.text(((S - (box[2] - box[0])) / 2 - box[0],
            (S - (box[3] - box[1])) / 2 - box[1]), text, font=f, fill=WHITE)

    # 底部两条白色短线，暗示「排期表」
    bar_h = max(2, int(S * 0.028))
    for i, w in enumerate((0.30, 0.18)):
        bw = int(S * w)
        x0 = int(S * 0.5 - bw / 2)
        y0 = int(S * 0.845 + i * (bar_h * 2.2))
        d.rounded_rectangle([x0, y0, x0 + bw, y0 + bar_h], radius=bar_h // 2,
                            fill=(255, 255, 255, 235 if i == 0 else 150))

    return img.resize((size, size), Image.LANCZOS)


def main():
    imgs = {s: make(s) for s in (256, 64)}
    targets = [
        ('ICON_256.PNG', 256),
        ('ICON.PNG', 64),
        (os.path.join('app', 'ui', 'images', 'icon_256.png'), 256),
        (os.path.join('app', 'ui', 'images', 'icon_64.png'), 64),
    ]
    for rel, size in targets:
        p = os.path.join(OUT, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        imgs[size].save(p, 'PNG')
        print('写入', p)
    # 顺手给 Web 端一个 favicon
    fav = os.path.join(os.path.dirname(__file__), '..', 'assets', 'icon.png')
    imgs[256].save(fav, 'PNG')
    print('写入', fav)


if __name__ == '__main__':
    main()
