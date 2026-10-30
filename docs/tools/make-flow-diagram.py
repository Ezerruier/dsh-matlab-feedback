"""Generate the sanitized architecture diagram used by README.md.

This script draws a schematic of the plugin pipeline with Pillow. It contains
no screenshots and no real data: every label is generic sample text, so the
result is safe to publish.

Usage (Windows, Pillow required):
    python docs/tools/make-flow-diagram.py
Output: docs/flow.png
"""

from __future__ import annotations

import pathlib

from PIL import Image, ImageDraw, ImageFont

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / "docs" / "flow.png"

W, H = 1440, 830
BG = "#F5F7FB"
PANEL = "#FFFFFF"
BORDER = "#D8E0EC"
INK = "#0F172A"
MUTED = "#64748B"
BLUE = "#2563EB"
TEAL = "#0D9488"
ORANGE = "#EA580C"
DARK = "#1E293B"
SOFT_BLUE = "#EAF1FF"
SOFT_TEAL = "#E7F7F4"
SOFT_ORANGE = "#FFF1E7"
CANVAS_DARK = "#0B1220"

FONT_REG = "C:/Windows/Fonts/msyh.ttc"
FONT_BOLD = "C:/Windows/Fonts/msyhbd.ttc"
FONT_MONO = "C:/Windows/Fonts/consola.ttf"


def font(path: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(path, size)


F_TITLE = font(FONT_BOLD, 38)
F_SUBTITLE = font(FONT_REG, 18)
F_H2 = font(FONT_BOLD, 21)
F_H3 = font(FONT_BOLD, 16)
F_BODY = font(FONT_REG, 15)
F_SMALL = font(FONT_REG, 13)
F_TINY = font(FONT_REG, 12)
F_MONO = font(FONT_MONO, 13)
F_MONO_SM = font(FONT_MONO, 12)


def text(dr: ImageDraw.ImageDraw, xy, s, f, fill=INK, anchor="la"):
    dr.text(xy, s, font=f, fill=fill, anchor=anchor)


def panel(dr: ImageDraw.ImageDraw, box, fill=PANEL, radius=18):
    dr.rounded_rectangle(box, radius=radius, fill=fill, outline=BORDER, width=2)


def chip(dr, box, label, f, fill, ink, radius=10):
    dr.rounded_rectangle(box, radius=radius, fill=fill, outline=None)
    text(dr, ((box[0] + box[2]) / 2, (box[1] + box[3]) / 2), label, f, ink, "mm")


def arrow(dr, x0, x1, y, label, color=MUTED):
    dr.line([(x0, y), (x1 - 12, y)], fill=color, width=3)
    dr.polygon([(x1, y), (x1 - 14, y - 8), (x1 - 14, y + 8)], fill=color)
    if label:
        text(dr, ((x0 + x1) / 2, y - 16), label, F_SMALL, MUTED, "ms")


def qc_panel(dr, x, y, w, h):
    """Mini MATLAB figure window: three orthogonal views + QC controls."""
    dr.rounded_rectangle([x, y, x + w, y + 26], radius=8, fill=DARK)
    dr.rectangle([x, y + 14, x + w, y + 26], fill=DARK)
    text(dr, (x + 10, y + 13), "SPM26 (00:00): Graphics", F_TINY, "#E2E8F0", "lm")
    for i in range(3):
        bx = x + w - 12 - (i * 12)
        dr.ellipse([bx, y + 8, bx + 7, y + 15], outline="#94A3B8", width=1)

    inner = (x, y + 26, x + w, y + h)
    dr.rectangle(inner, fill="#F8FAFC")

    views = [
        (x + 18, y + 40, 118, 110),
        (x + 152, y + 40, 118, 110),
        (x + 18, y + 162, 118, 110),
    ]
    for i, (vx, vy, vw, vh) in enumerate(views):
        dr.rectangle([vx, vy, vx + vw, vy + vh], fill=CANVAS_DARK)
        cx, cy = vx + vw // 2, vy + vh // 2
        dr.line([(vx + 8, cy), (vx + vw - 8, cy)], fill="#3B82F6", width=1)
        dr.line([(cx, vy + 8), (cx, vy + vh - 8)], fill="#3B82F6", width=1)
        dr.ellipse([cx - 26, cy - 34, cx + 26, cy + 34], outline="#475569", width=1)
        dr.ellipse([cx - 22, cy - 90 + 60, cx + 22, cy + 90 - 60], outline="#334155", width=1)
        text(dr, (cx, vy + vh - 12), "示意", F_TINY, "#94A3B8", "mm")

    # QC score list
    sx, sy = x + 292, y + 44
    text(dr, (sx, sy), "QC Score", F_H3, INK)
    for i, label in enumerate(["1 - Very Poor", "2 - Poor", "3 - Fair", "4 - Good", "5 - Very Good"]):
        ry = sy + 30 + i * 26
        selected = i == 4
        dr.ellipse([sx, ry, sx + 12, ry + 12], outline=BLUE if selected else "#94A3B8", width=2, fill=BLUE if selected else None)
        if selected:
            dr.ellipse([sx + 3, ry + 3, sx + 9, ry + 9], fill=BLUE)
        text(dr, (sx + 22, ry + 6), label, F_SMALL, INK if selected else MUTED, "lm")

    # comment box
    cy0 = y + 232
    dr.rounded_rectangle([x + 18, cy0, x + w - 18, cy0 + 74], radius=8, outline=BORDER, width=2)
    text(dr, (x + 28, cy0 + 12), "QC Comment", F_SMALL, MUTED)
    text(dr, (x + 28, cy0 + 36), "（示意文本，无真实数据）", F_TINY, "#94A3B8")


def console_strip(dr, x, y, w, h):
    dr.rounded_rectangle([x, y, x + w, y + h], radius=10, fill="#0B1220")
    dark = "#0B1220"
    text(dr, (x + 14, y + 14), "命令行窗口文本", F_SMALL, "#E2E8F0")
    lines = [
        "SPM26: spm_realign   ... Completed",
        "Moving Head Motion Corrected Files: sub-XXXX OK",
        "警告: （示例，真实内容以现场为准）",
        "> _",
    ]
    for i, line in enumerate(lines):
        # CJK lines cannot render with the monospace ASCII font; use the CJK face.
        line_font = F_SMALL if any(ord(ch) > 127 for ch in line) else F_MONO_SM
        line_ink = "#FCA5A5" if i == 2 else "#93C5FD"
        text(dr, (x + 14, y + 40 + i * 20), line, line_font, line_ink)


def tool_card(dr, x, y, w, name, desc):
    dr.rounded_rectangle([x, y, x + w, y + 74], radius=12, fill="#F8FAFC", outline=BORDER, width=2)
    text(dr, (x + 14, y + 12), name, F_MONO, TEAL)
    text(dr, (x + 14, y + 40), desc, F_SMALL, MUTED)


def main() -> None:
    img = Image.new("RGB", (W, H), BG)
    dr = ImageDraw.Draw(img)

    text(dr, (60, 34), "dsh-matlab-feedback", F_TITLE, INK)
    text(dr, (60, 84), "把 MATLAB 里正在显示的 QC 界面与命令行窗口，直接带进 Harness 对话", F_SUBTITLE, MUTED)
    text(dr, (W - 60, 46), "只读捕获 · 零依赖", F_H3, TEAL, "ra")
    text(dr, (W - 60, 74), "示意图（已脱敏）", F_SMALL, MUTED, "ra")

    px = [60, 515, 970]
    pw = 410
    py, ph = 130, 600

    # ---- Panel 1: MATLAB ----
    panel(dr, [px[0], py, px[0] + pw, py + ph])
    text(dr, (px[0] + 24, py + 22), "① MATLAB（R2025a+）", F_H2, BLUE)
    text(dr, (px[0] + 24, py + 52), "SPM / DPABI / DPARSF 的 QC 窗口", F_SMALL, MUTED)
    qc_panel(dr, px[0] + 20, py + 80, pw - 40, 330)
    console_strip(dr, px[0] + 20, py + 428, pw - 40, 122)
    text(dr, (px[0] + 24, py + 566), "只读：不点击、不抢焦点、不修改数据", F_SMALL, MUTED)

    # ---- Panel 2: plugin ----
    panel(dr, [px[1], py, px[1] + pw, py + ph], fill="#FCFDFF")
    text(dr, (px[1] + 24, py + 22), "② dsh-matlab-feedback", F_H2, TEAL)
    text(dr, (px[1] + 24, py + 52), "Host 工具 + Client 按钮", F_SMALL, MUTED)
    tool_card(dr, px[1] + 20, py + 82, pw - 40, "matlab_snapshot", "窗口截图（内嵌图片）+ 命令行文本 + warnings")
    tool_card(dr, px[1] + 20, py + 168, pw - 40, "matlab_console", "只取命令行文本，更快")
    text(dr, (px[1] + 24, py + 272), "捕获管线", F_H3, INK)
    steps = [
        ("PrintWindow", "窗口像素 → PNG（含 OpenGL 脑图）"),
        ("UI Automation", "窗口文本 / 命令行 · 选中态"),
        ("attachments", "PNG 持久化为图片附件"),
    ]
    for i, (name, desc) in enumerate(steps):
        y = py + 302 + i * 66
        chip(dr, [px[1] + 20, y, px[1] + 138, y + 40], name, F_MONO_SM, SOFT_TEAL, TEAL)
        text(dr, (px[1] + 150, y + 20), desc, F_SMALL, MUTED, "lm")
    text(dr, (px[1] + 24, py + 520), "零第三方依赖 · 不联网 · 单次捕获通常 < 1 秒", F_SMALL, MUTED)
    text(dr, (px[1] + 24, py + 548), "无 attachments 时降级为 PNG 路径 + read_image", F_SMALL, MUTED)
    text(dr, (px[1] + 24, py + 576), "matlab_stage_code：写入命令框但不按 Enter（可选）", F_SMALL, ORANGE)

    # ---- Panel 3: Harness chat ----
    panel(dr, [px[2], py, px[2] + pw, py + ph])
    text(dr, (px[2] + 24, py + 22), "③ Harness 对话", F_H2, ORANGE)
    text(dr, (px[2] + 24, py + 52), "Agent 基于真实截图与命令行回答", F_SMALL, MUTED)

    # user bubble
    dr.rounded_rectangle([px[2] + 20, py + 84, px[2] + pw - 20, py + 132], radius=14, fill=SOFT_BLUE)
    text(dr, (px[2] + 34, py + 108), "帮我看下现在 DPARSF 的 QC 界面？", F_BODY, INK, "lm")

    # tool result card
    cx = px[2] + 20
    cy = py + 152
    dr.rounded_rectangle([cx, cy, cx + pw - 40, cy + 214], radius=14, fill="#F8FAFC", outline=BORDER, width=2)
    text(dr, (cx + 16, cy + 14), "matlab_snapshot 返回", F_MONO_SM, TEAL)
    # thumbnail
    th = [cx + 16, cy + 42, cx + 132, cy + 158]
    dr.rectangle(th, fill=CANVAS_DARK)
    dr.line([(th[0] + 8, (th[1] + th[3]) // 2), (th[2] - 8, (th[1] + th[3]) // 2)], fill="#3B82F6", width=1)
    dr.line([((th[0] + th[2]) // 2, th[1] + 8), ((th[0] + th[2]) // 2, th[3] - 8)], fill="#3B82F6", width=1)
    text(dr, (cx + 148, cy + 50), "截图：2 张（内嵌图片）", F_SMALL, INK)
    text(dr, (cx + 148, cy + 76), "命令行：10,812 字符", F_SMALL, INK)
    text(dr, (cx + 148, cy + 102), "warnings：8 条", F_SMALL, INK)
    text(dr, (cx + 148, cy + 128), "只读捕获，0.89 s", F_SMALL, MUTED)
    text(dr, (cx + 148, cy + 154), "无真实数据（示意图）", F_TINY, "#94A3B8")

    # assistant bubble
    dr.rounded_rectangle([px[2] + 20, py + 388, px[2] + pw - 20, py + 500], radius=14, fill=SOFT_ORANGE)
    text(dr, (px[2] + 34, py + 414), "QC 界面：5 - Very Good；", F_BODY, INK, "lm")
    text(dr, (px[2] + 34, py + 440), "配准居中、灰白质边界清晰。", F_BODY, INK, "lm")
    text(dr, (px[2] + 34, py + 466), "命令行 8 条警告，主要来自 parfor 临时变量。", F_BODY, INK, "lm")

    text(dr, (px[2] + 24, py + 536), "Agent 不再凭记忆猜测 MATLAB 状态", F_H3, ORANGE)
    text(dr, (px[2] + 24, py + 566), "截图仅作定性观察；精确数值取命令行/控件文本", F_SMALL, MUTED)

    # arrows
    arrow(dr, px[0] + pw, px[1], py + 300, "截图 + 文本")
    arrow(dr, px[1] + pw, px[2], py + 300, "工具结果")

    # footer
    text(dr, (60, H - 34), "示意图（脱敏）：不含真实受试者数据、研究数据或本地路径 · MIT License", F_SMALL, MUTED)
    text(dr, (W - 60, H - 34), "github.com/Ezerruier/dsh-matlab-feedback", F_SMALL, MUTED, "ra")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    img.save(OUT, "PNG", optimize=True)
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes, {W}x{H})")


if __name__ == "__main__":
    main()
