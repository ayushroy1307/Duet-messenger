#!/bin/sh
# Re-renders both wallpaper JPEGs from the SVG sources.
# Needs Google Chrome and Python 3 + Pillow. Set CHROME=/path/to/chrome if Chrome
# is not in the default macOS location.
set -eu
cd "$(dirname "$0")"

CHROME="${CHROME:-}"
if [ -z "$CHROME" ]; then
  for c in \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "$(command -v google-chrome || true)" \
    "$(command -v chromium || true)" \
    "$(command -v chromium-browser || true)"
  do
    if [ -n "$c" ] && [ -x "$c" ]; then CHROME="$c"; break; fi
  done
fi
if [ -z "$CHROME" ]; then
  echo "Google Chrome not found. Set CHROME=/path/to/chrome and re-run." >&2
  exit 1
fi

python3 build.py

"$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --window-size=2160,3840 --screenshot=wall.png "file://$PWD/wall.svg" 2>/dev/null
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --window-size=3840,2880 --screenshot=wall-wide.png "file://$PWD/wall-wide.svg" 2>/dev/null

for f in wall.png wall-wide.png; do
  [ -s "$f" ] || { echo "Render failed: $f is missing or empty." >&2; exit 1; }
done

python3 - <<'PY'
from PIL import Image
for src, dst in (("wall.png", "../../public/img/chat-bg.jpg"), ("wall-wide.png", "../../public/img/chat-bg-wide.jpg")):
    im = Image.open(src).convert("RGB")
    im.save(dst, "JPEG", quality=86, optimize=True, progressive=True, subsampling=1)
    print(dst, im.size)
PY

rm -f wall.png wall-wide.png
