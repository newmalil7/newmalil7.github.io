#!/usr/bin/env python3
"""生成「AI 瞭望台」品牌 PWA 图标。

品牌：对角渐变圆角方（#4f46e5 靛蓝 → #0ea5e9 天蓝）+ 居中白色粗体 "AI"。
输出（默认写入 assets/icons/，路径相对于本文件）：
  icon-192.png            （any）
  icon-512.png            （any）
  icon-maskable-512.png   （maskable，满幅渐变 + 安全区内文字）
  apple-touch-icon.png    （180，iOS 主屏图标，满幅渐变）
  icon-1024.png           （母版，供生成 macOS .icns）
"""
import os
import sys
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "assets", "icons")

C0 = (79, 70, 229)    # #4f46e5
C1 = (14, 165, 233)   # #0ea5e9
FONT_PATH = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"


def gradient_square(size):
    """对角线性渐变方块（左上 C0 → 右下 C1）。"""
    denom = 2 * (size - 1)
    px = []
    for y in range(size):
        for x in range(size):
            t = (x + y) / denom
            r = round(C0[0] + (C1[0] - C0[0]) * t)
            g = round(C0[1] + (C1[1] - C0[1]) * t)
            b = round(C0[2] + (C1[2] - C0[2]) * t)
            px.append((r, g, b, 255))
    img = Image.new("RGBA", (size, size))
    img.putdata(px)
    return img


def make_icon(size, rounded, text_ratio):
    img = gradient_square(size)
    if rounded:
        radius = round(112 / 512 * size)  # 与 manifest SVG 的 rx=112/512 对齐
        mask = Image.new("L", (size, size), 0)
        ImageDraw.Draw(mask).rounded_rectangle(
            [0, 0, size - 1, size - 1], radius=radius, fill=255
        )
        img.putalpha(mask)
    font = ImageFont.truetype(FONT_PATH, round(text_ratio * size))
    d = ImageDraw.Draw(img)
    cx, cy = size / 2, size * (0.52 if rounded else 0.53)
    d.text((cx, cy), "AI", font=font, fill=(255, 255, 255, 255), anchor="mm")
    return img


def main():
    os.makedirs(OUT, exist_ok=True)
    jobs = [
        ("icon-192.png", 192, True, 0.46),
        ("icon-512.png", 512, True, 0.46),
        ("icon-maskable-512.png", 512, False, 0.40),
        ("apple-touch-icon.png", 180, False, 0.46),
        ("icon-1024.png", 1024, True, 0.46),
    ]
    for name, size, rounded, ratio in jobs:
        p = os.path.join(OUT, name)
        make_icon(size, rounded, ratio).save(p)
        print(f"  OK {os.path.relpath(p, ROOT)}  ({size}x{size})")
    print("done ->", OUT)


if __name__ == "__main__":
    sys.exit(main())
