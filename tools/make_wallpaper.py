"""Generates public/img/chat-bg.jpg: an original stitched-embroidery scene (tree, heart patch, grass, flowers).
Re-run with:  python3 tools/make_wallpaper.py   (needs Pillow + numpy). Replace the JPEG with any picture you like."""
import math, random, sys
import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter

random.seed(11); np.random.seed(11)
S = 2                       # supersample
W, H = 900 * S, 1950 * S

def paste_layer(layer, mask):
    """Composite a transparent stitch layer through a shape mask (alpha-aware, so gaps stay transparent)."""
    img.paste(layer, (0, 0), ImageChops.multiply(mask, layer.getchannel('A')))

def lerp(a, b, t): return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))
def jitter(c, j=14): return tuple(max(0, min(255, v + random.randint(-j, j))) for v in c)

# ---- fabric base: pink cloth with a vertical tone shift, weave and grain
ys = np.linspace(0, 1, H)[:, None, None]
top, mid, bot = np.array([190, 128, 160]), np.array([176, 112, 146]), np.array([120, 120, 92])
base = np.where(ys < 0.7, top + (mid - top) * (ys / 0.7), mid + (bot - mid) * ((ys - 0.7) / 0.3))
img = Image.fromarray(np.broadcast_to(base, (H, W, 3)).astype('uint8'))
d = ImageDraw.Draw(img, 'RGBA')

def stitch(dr, x, y, ang, ln, wd, col, sheen=True):
    dx, dy = math.cos(ang) * ln / 2, math.sin(ang) * ln / 2
    dr.line([(x - dx, y - dy), (x + dx, y + dy)], fill=col, width=wd)
    r = wd / 2
    for ex, ey in ((x - dx, y - dy), (x + dx, y + dy)): dr.ellipse([ex - r, ey - r, ex + r, ey + r], fill=col)
    if sheen:
        nx, ny = -math.sin(ang) * wd * 0.22, math.cos(ang) * wd * 0.22
        lighter = tuple(min(255, v + 38) for v in col[:3]) + (150,)
        dr.line([(x - dx + nx, y - dy + ny), (x + dx + nx, y + dy + ny)], fill=lighter, width=max(1, wd // 4))

# ---- trunk (satin stitches clipped to a tapering shape)
tx = lambda y: 0.44 * W + 0.05 * W * math.sin(y / H * 5) - 0.04 * W * (y / H)
half = lambda y: 0.085 * W + 0.12 * W * max(0, (y - 0.3 * H) / (0.7 * H)) ** 1.2
left = [(tx(y) - half(y), y) for y in range(int(0.22 * H), H, 10)]
right = [(tx(y) + half(y), y) for y in range(H, int(0.22 * H), -10)]
tm = Image.new('L', (W, H), 0); ImageDraw.Draw(tm).polygon(left + right, fill=255)
trunk = Image.new('RGBA', (W, H)); td = ImageDraw.Draw(trunk)
pal = [(126, 78, 48), (146, 92, 58), (108, 64, 42), (160, 106, 70), (94, 56, 40)]
for _ in range(16000):
    y = random.randint(int(0.2 * H), H); x = tx(y) + random.uniform(-1, 1) * (half(y) + 20)
    shade = 0.0 if abs(x - tx(y)) < half(y) * 0.35 else 0.25      # darker toward the edges
    c = lerp(random.choice(pal), (70, 42, 32), shade)
    stitch(td, x, y, math.pi / 2 + random.uniform(-0.22, 0.22), random.randint(40, 80), 16 * S // 2 + 2, c + (255,))
paste_layer(trunk, tm)

# ---- dark canopy with a ragged lower edge
canopy_bottom = lambda x: 0.30 * H + 0.035 * H * math.sin(x / W * 9 + 1) + 0.02 * H * math.sin(x / W * 23) + 0.05 * H * max(0, math.sin(x / W * 5.5 - 0.6)) ** 3
pts = [(0, 0), (W, 0)] + [(x, canopy_bottom(x)) for x in range(W, -1, -6)]
cm = Image.new('L', (W, H), 0); ImageDraw.Draw(cm).polygon(pts, fill=255)
canopy = Image.new('RGBA', (W, H)); cd = ImageDraw.Draw(canopy)
for _ in range(9000):
    x, y = random.randint(0, W), random.randint(0, int(0.42 * H))
    c = jitter((62, 40, 52), 12); stitch(cd, x, y, random.uniform(-0.5, 0.5) + math.pi / 2, random.randint(34, 70), 15 * S // 2 + 3, c + (255,), sheen=False)
img.paste((56, 36, 50), (0, 0), cm)   # solid base so no fabric shows through
paste_layer(canopy, cm)
# stitched edge along the canopy
for x in range(0, W, 26 * S // 2):
    y = canopy_bottom(x) + random.randint(-6, 8)
    stitch(d, x, y, math.pi / 2 + random.uniform(-0.4, 0.4), random.randint(40, 70), 14, jitter((82, 52, 60), 10) + (255,))

# ---- heart patch on the trunk
hx, hy = tx(0.42 * H) + 8, 0.42 * H
patch = Image.new('RGBA', (W, H)); pd = ImageDraw.Draw(patch)
for _ in range(1400):
    a = random.uniform(0, math.tau); r = random.uniform(0, 1) ** 0.6 * 150 * S / 2
    stitch(pd, hx + math.cos(a) * r, hy + math.sin(a) * r * 1.15, random.uniform(-0.3, 0.3) + math.pi / 2, random.randint(22, 36), 11, jitter((198, 150, 108), 10) + (255,))
img.paste(patch, (0, 0), patch.getchannel('A'))
def heart(cx, cy, size, col, wd, fill=False):
    pts = [(cx + size * 16 * math.sin(t) ** 3 / 16, cy - size * (13 * math.cos(t) - 5 * math.cos(2 * t) - 2 * math.cos(3 * t) - math.cos(4 * t)) / 16) for t in np.linspace(0, math.tau, 90)]
    if fill:
        for _ in range(900):
            px_, py_ = random.choice(pts); k = random.uniform(0, 0.9)
            stitch(d, cx + (px_ - cx) * k, cy + (py_ - cy) * k, random.uniform(-0.6, 0.6) + math.pi / 2, random.randint(18, 28), wd, jitter(col, 14) + (255,))
    for i in range(0, len(pts) - 1, 2):
        (x1, y1), (x2, y2) = pts[i], pts[i + 1]
        stitch(d, (x1 + x2) / 2, (y1 + y2) / 2, math.atan2(y2 - y1, x2 - x1), math.hypot(x2 - x1, y2 - y1) + 8, wd, col + (255,))
heart(hx, hy + 6, 62 * S / 2, (150, 52, 70), 9, fill=True)

# ---- hot-pink running stitches hugging the trunk edges and canopy (a few, not sprinkles)
for _ in range(34):
    y = random.uniform(0.34 * H, 0.80 * H); side = random.choice([-1, 1])
    x = tx(y) + side * (half(y) + random.uniform(18, 120))
    stitch(d, x, y, math.pi / 2 + side * random.uniform(0.15, 0.55), random.randint(54, 96), 15, jitter((226, 86, 150), 12) + (255,))
for _ in range(14):  # a few along the canopy edge
    x = random.uniform(0.05 * W, 0.95 * W); y = canopy_bottom(x) + random.uniform(28, 70)
    stitch(d, x, y, random.uniform(-0.5, 0.5), random.randint(54, 90), 15, jitter((226, 86, 150), 12) + (255,))

# ---- grass: dense short satin blades, darker toward the bottom (also gives the composer a calm backdrop)
grass = Image.new('RGBA', (W, H)); gd = ImageDraw.Draw(grass)
for _ in range(26000):
    y = H * (0.66 + 0.34 * random.random() ** 0.7); x = random.randint(0, W)
    t = (y / H - 0.66) / 0.34
    col = jitter(lerp((126, 150, 84), (58, 82, 48), t), 14)
    stitch(gd, x, y, math.pi / 2 + random.uniform(-0.28, 0.28), random.randint(34, 80), 14 * S // 2 + 2, col + (255,))
gm = Image.new('L', (W, H), 0); gmd = ImageDraw.Draw(gm)
for y in range(int(0.64 * H), H):
    gmd.line([(0, y), (W, y)], fill=int(255 * min(1, ((y - 0.64 * H) / (0.07 * H)) ** 1.5)))
paste_layer(grass, gm)

# ---- flowers (blue, five round petals + yellow centre) and a heart-flower on a stem
def flower(cx, cy, r, col, centre=(236, 196, 64)):
    for i in range(5):
        a = i * math.tau / 5 - math.pi / 2; px_, py_ = cx + math.cos(a) * r * 0.62, cy + math.sin(a) * r * 0.62
        for _ in range(110):
            q = random.uniform(0, math.tau); rr = random.uniform(0, 1) ** 0.6 * r * 0.52
            stitch(d, px_ + math.cos(q) * rr, py_ + math.sin(q) * rr, random.uniform(0, math.pi), random.randint(16, 26), 9, jitter(col, 14) + (255,))
    for _ in range(120):
        q = random.uniform(0, math.tau); rr = random.uniform(0, 1) ** 0.6 * r * 0.26
        stitch(d, cx + math.cos(q) * rr, cy + math.sin(q) * rr, random.uniform(0, math.pi), 14, 8, jitter(centre, 10) + (255,))
flower(0.06 * W, 0.80 * H, 70 * S, (112, 128, 206)); flower(0.72 * W, 0.795 * H, 62 * S, (126, 140, 214)); flower(0.30 * W, 0.865 * H, 40 * S, (150, 160, 224))
sx, sy = 0.9 * W, 0.70 * H
for k in range(40):  # stem
    stitch(d, sx + math.sin(k / 6) * 10, sy + 70 + k * 12, math.pi / 2, 30, 10, jitter((74, 108, 60), 10) + (255,))
heart(sx, sy, 78 * S / 2, (222, 78, 120), 10, fill=True)

# ---- weave, grain, soften, vignette
arr = np.asarray(img.convert('RGB')).astype('float32')
yy, xx = np.mgrid[0:H, 0:W]
weave = ((np.sin(xx * math.pi / (2.2 * S)) + np.sin(yy * math.pi / (2.2 * S))) * 3.2)[:, :, None]
grain = np.random.normal(0, 4.5, (H, W, 1))
vig = 1 - 0.30 * (((xx - W / 2) / (W / 2)) ** 2 + ((yy - H / 2) / (H / 2)) ** 2) / 2
arr = np.clip((arr + weave + grain) * vig[:, :, None], 0, 255).astype('uint8')
out = Image.fromarray(arr).filter(ImageFilter.GaussianBlur(0.8)).resize((W // S, H // S), Image.LANCZOS)
out.save(sys.argv[1] if len(sys.argv) > 1 else 'public/img/chat-bg.jpg', quality=80, optimize=True, progressive=True)
print('saved', out.size)
