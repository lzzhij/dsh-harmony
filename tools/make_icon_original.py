# -*- coding: utf-8 -*-
"""程序化生成 DSH for HarmonyOS 的原创启动图标（分层图标：background + foreground）。
设计：深蓝渐变底 + 中央一个自创的"终端提示符 + 波浪"抽象标记（不复制任何他人图形）。
保留本脚本作为原创证据。"""
import os, math
from PIL import Image, ImageDraw

OUT = r"<REPO_ROOT>\harmony\entry\src\main\resources\base\media"
S = 1024

def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

# ---- background：竖直渐变 + 柔和光晕
bg = Image.new("RGB", (S, S), (0, 0, 0))
d = ImageDraw.Draw(bg)
top = (12, 34, 66)      # 深海军蓝
bot = (6, 16, 34)       # 近黑
for y in range(S):
    d.line([(0, y), (S, y)], fill=lerp(top, bot, y / S))
# 左上柔光
glow = Image.new("L", (S, S), 0)
gd = ImageDraw.Draw(glow)
for r in range(560, 0, -8):
    a = int(28 * (1 - r / 560))
    gd.ellipse([int(S*0.30)-r, int(S*0.26)-r, int(S*0.30)+r, int(S*0.26)+r], fill=a)
bg = Image.composite(Image.new("RGB", (S, S), (60, 130, 220)), bg, glow)

# ---- foreground：透明底 + 自创标记
fg = Image.new("RGBA", (S, S), (0, 0, 0, 0))
fd = ImageDraw.Draw(fg)
cx, cy = S // 2, S // 2
# 圆角方框（终端窗口意象）
m = 250
box = [m, m, S - m, S - m]
fd.rounded_rectangle(box, radius=110, outline=(120, 200, 255, 235), width=26)
# 顶部三个小圆点（窗口按钮意象，但用自创比例）
for i, x in enumerate([m + 78, m + 140, m + 202]):
    fd.ellipse([x - 13, m + 66 - 13, x + 13, m + 66 + 13], fill=(120, 200, 255, 200))
# 提示符 ">"（两段折线）
px, py = m + 96, cy - 96
fd.line([(px, py), (px + 96, py + 92)], fill=(150, 220, 255, 245), width=30)
fd.line([(px + 96, py + 92), (px, py + 184)], fill=(150, 220, 255, 245), width=30)
# 波浪（谐音"深海/探索"的抽象意象，自创曲线）
pts = []
for i in range(0, 181):
    t = i / 180.0
    x = m + 250 + t * 300
    y = cy + 78 + math.sin(t * math.pi * 2.0) * 44
    pts.append((x, y))
fd.line(pts, fill=(90, 190, 255, 240), width=26, joint="curve")
# 下划线（光标意象）
fd.rounded_rectangle([m + 250, cy + 168, m + 550, cy + 196], radius=13, fill=(90, 190, 255, 230))

bg.save(os.path.join(OUT, "background.png"))
fg.save(os.path.join(OUT, "foreground.png"))
print("  ✓ 已生成 background.png / foreground.png  %d x %d" % (S, S))