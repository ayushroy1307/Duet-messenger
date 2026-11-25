"""Builds the wide (desktop) wallpaper from the same artwork as the portrait one.
Run: python3 tools/wall/build.py
The portrait source is tools/wall/wall.svg; this script only re-arranges its four
corner groups onto a 3840x2880 canvas with a rectangular doodle frame."""
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE / "wall.svg"
OUT = HERE / "wall-wide.svg"

s = SRC.read_text()
defs = re.search(r"<defs>.*?</defs>", s, re.S).group(0)

sections = {}
for key, label in (("TL", "TOP LEFT"), ("TR", "TOP RIGHT"), ("BL", "BOTTOM LEFT"), ("BR", "BOTTOM RIGHT")):
    m = re.search(
        r"<!-- =+ " + label + r"[^>]*-->\s*(.*?)(?=\n\s*<!-- =+|\n\s*<!-- a few|\n\s*<!-- gentle)",
        s, re.S)
    if not m:
        raise SystemExit("missing section " + label)
    sections[key] = m.group(1).strip()

W, H = 3840, 2880
# the portrait art is 2160x3840; the bottom groups are anchored to the bottom edge
DX = W - 2160
DY = H - 3600

def frame():
    return f"""
  <!-- dashed doodle frame -->
  <g fill="none" stroke="#6E6552" opacity="0.75">
    <rect x="250" y="260" width="3340" height="2360" rx="36" stroke-width="3.2" stroke-dasharray="30 24" stroke-linecap="round"/>
  </g>
  <g fill="none" stroke="#6E6552" stroke-width="3.2" opacity="0.75">
    <circle cx="250" cy="760" r="17"/><circle cx="250" cy="1360" r="17"/><circle cx="250" cy="1960" r="17"/><circle cx="250" cy="2440" r="17"/>
    <circle cx="3590" cy="760" r="17"/><circle cx="3590" cy="1360" r="17"/><circle cx="3590" cy="1960" r="17"/><circle cx="3590" cy="2440" r="17"/>
    <circle cx="1040" cy="260" r="17"/><circle cx="1920" cy="260" r="17"/><circle cx="2800" cy="260" r="17"/>
    <circle cx="1040" cy="2620" r="17"/><circle cx="1920" cy="2620" r="17"/><circle cx="2800" cy="2620" r="17"/>
  </g>
  <g fill="#6E6552" opacity="0.55">
    <circle cx="300" cy="1100" r="4"/><circle cx="300" cy="1700" r="4"/><circle cx="300" cy="2260" r="4"/>
    <circle cx="3540" cy="1100" r="4"/><circle cx="3540" cy="1700" r="4"/><circle cx="3540" cy="2260" r="4"/>
  </g>
  <g>
    <use href="#heart" x="286" y="930" width="60" height="60"/>
    <use href="#sparkle" x="288" y="1550" width="58" height="58"/>
    <use href="#daisy" x="280" y="2160" width="72" height="72"/>
    <use href="#sparkle" x="3492" y="930" width="58" height="58"/>
    <use href="#heart" x="3494" y="1550" width="60" height="60"/>
    <use href="#butterfly" x="3480" y="2150" width="78" height="78"/>
    <use href="#heart" x="1460" y="296" width="54" height="54"/>
    <use href="#sparkle" x="2320" y="296" width="50" height="50"/>
  </g>"""

divider = """
  <!-- centre divider -->
  <g>
    <path d="M1725,1440 L1870,1440" stroke="#6E6552" stroke-width="3.2" stroke-dasharray="18 14" stroke-linecap="round" fill="none" opacity="0.8"/>
    <path d="M1970,1440 L2115,1440" stroke="#6E6552" stroke-width="3.2" stroke-dasharray="18 14" stroke-linecap="round" fill="none" opacity="0.8"/>
    <use href="#heart" x="1888" y="1406" width="64" height="64"/>
    <path d="M1700,1440 C1688,1424 1672,1422 1660,1426 M1700,1440 C1690,1456 1674,1460 1662,1456" stroke="#6E6552" stroke-width="2.6" fill="none" stroke-linecap="round" opacity="0.7"/>
    <path d="M2140,1440 C2152,1424 2168,1422 2180,1426 M2140,1440 C2150,1456 2166,1460 2178,1456" stroke="#6E6552" stroke-width="2.6" fill="none" stroke-linecap="round" opacity="0.7"/>
  </g>"""

out = f"""<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">
  {defs}
  <rect width="{W}" height="{H}" fill="url(#paperGlow)"/>
  <rect width="{W}" height="{H}" filter="url(#grain)" opacity="0.9"/>
<g transform="translate(1920 1440) scale(0.9) translate(-1920 -1440)">{frame()}</g>
  <g transform="translate(0,0)">{sections['TL']}</g>
  <g transform="translate({DX},0)">{sections['TR']}</g>
  <g transform="translate(0,{DY})">{sections['BL']}</g>
  <g transform="translate({DX},{DY})">{sections['BR']}</g>
{divider}
  <g opacity="0.75">
    <use href="#leaf" x="520" y="2000" width="46" height="46" transform="rotate(28 543 2023)"/>
    <use href="#leaf" x="3270" y="2000" width="42" height="42" transform="rotate(-24 3291 2021)"/>
    <use href="#leaf" x="760" y="1000" width="40" height="40" transform="rotate(-32 780 1020)"/>
    <use href="#leaf" x="3040" y="1020" width="38" height="38" transform="rotate(22 3059 1039)"/>
  </g>
  <rect width="{W}" height="{H}" filter="url(#grain)" opacity="0.45" style="mix-blend-mode:multiply"/>
</svg>
"""
OUT.write_text(out)
print("wrote", OUT, len(out))
