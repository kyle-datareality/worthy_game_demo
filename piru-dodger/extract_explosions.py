import numpy as np, os
from PIL import Image, ImageDraw
from scipy import ndimage

RAW = "assets/raw"; OUT = "assets/boss"
arr = np.array(Image.open(os.path.join(RAW, "boss_sheet.png")).convert("RGBA")).astype(np.uint8)
H, W = arr.shape[:2]
rgb = arr[..., :3].astype(int)

# flood-remove the black background from the borders
black = rgb.max(2) < 30
lbl, _ = ndimage.label(black)
border = set(np.unique(np.concatenate([lbl[0, :], lbl[-1, :], lbl[:, 0], lbl[:, -1]]))); border.discard(0)
arr[..., 3] = np.where(np.isin(lbl, list(border)), 0, 255).astype(np.uint8)

# explosion reference lives in the bottom-right of the sheet
mask = arr[..., 3] > 40
reg = np.zeros_like(mask)
reg[int(H * 0.80):, int(W * 0.52):] = True
mask &= reg
mask = ndimage.binary_dilation(mask, iterations=4)

lbl2, n2 = ndimage.label(mask)
boxes = []
for i, sl in enumerate(ndimage.find_objects(lbl2)):
    if sl is None: continue
    ys, xs = sl
    h, w = ys.stop - ys.start, xs.stop - xs.start
    area = int((lbl2[sl] == i + 1).sum())
    # explosions are bright orange & roughly square; UFO bottoms are wide (~2:1), label is thin
    if h > 45 and w > 45 and area > 1200 and 0.6 < w / h < 1.55:
        boxes.append([xs.start, ys.start, xs.stop, ys.stop])
boxes.sort(key=lambda b: b[0])

for j, b in enumerate(boxes):
    sub = arr[b[1]:b[3], b[0]:b[2]]
    a = sub[..., 3] > 10
    ys, xs = np.where(a)
    sub = sub[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    Image.fromarray(sub).save(os.path.join(OUT, f"explode_{j}.png"))

print("explosion frames:", len(boxes), "sizes:", [(b[2]-b[0], b[3]-b[1]) for b in boxes])

# montage to verify
pad = 8; cell = 150
mw = pad + len(boxes) * (cell + pad)
m = Image.new("RGBA", (mw, cell + 2 * pad), (30, 30, 40, 255))
for j in range(len(boxes)):
    im = Image.open(os.path.join(OUT, f"explode_{j}.png")).convert("RGBA")
    s = min(cell / im.width, cell / im.height)
    im = im.resize((max(1, int(im.width * s)), max(1, int(im.height * s))))
    m.alpha_composite(im, (pad + j * (cell + pad), pad))
m.convert("RGB").save("assets/montage_explode.png")
print("wrote montage_explode.png")
