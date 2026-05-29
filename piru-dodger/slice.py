import sys, os, json
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

RAW = os.path.join(os.path.dirname(__file__), "assets", "raw")
OUT = os.path.join(os.path.dirname(__file__), "assets")

def _flood_bg(arr, bgmask):
    """Set alpha=0 on bgmask regions connected to the image border."""
    lbl, n = ndimage.label(bgmask)
    border_labels = set(np.unique(np.concatenate([
        lbl[0, :], lbl[-1, :], lbl[:, 0], lbl[:, -1]])))
    border_labels.discard(0)
    bg = np.isin(lbl, list(border_labels))
    arr[..., 3] = np.where(bg, 0, 255).astype(np.uint8)
    return arr

def load_clean(path, kind):
    """Return RGBA uint8 array with background flood-removed from borders.
    kind='black': dark background.  kind='light': light/white background."""
    img = Image.open(path).convert("RGBA")
    arr = np.array(img).astype(np.uint8)
    rgb = arr[..., :3].astype(int)
    if kind == "black":
        bgmask = rgb.max(2) < 30
    else:  # light/white background, character has dark outlines that block the flood
        bgmask = rgb.min(2) > 200
    return _flood_bg(arr, bgmask)

def content_mask(arr):
    return arr[..., 3] > 40

def find_frames(mask, min_h, min_w, min_area, dilate=6):
    if dilate:
        mask = ndimage.binary_dilation(mask, iterations=dilate)
    lbl, n = ndimage.label(mask)
    objs = ndimage.find_objects(lbl)
    boxes = []
    for i, sl in enumerate(objs):
        if sl is None:
            continue
        ys, xs = sl
        h = ys.stop - ys.start
        w = xs.stop - xs.start
        area = int((lbl[sl] == (i + 1)).sum())
        if h >= min_h and w >= min_w and area >= min_area:
            boxes.append([xs.start, ys.start, xs.stop, ys.stop, area])
    return boxes

def cluster_rows(boxes):
    rows = []
    for b in sorted(boxes, key=lambda b: b[1]):
        placed = False
        for row in rows:
            ry0 = min(x[1] for x in row); ry1 = max(x[3] for x in row)
            ov = min(b[3], ry1) - max(b[1], ry0)
            if ov > 0.4 * min(b[3] - b[1], ry1 - ry0):
                row.append(b); placed = True; break
        if not placed:
            rows.append([b])
    rows.sort(key=lambda row: min(x[1] for x in row))
    for row in rows:
        row.sort(key=lambda b: b[0])
    return rows

def process(name, path, kind, min_h, min_w, min_area):
    arr = load_clean(path, kind)
    mask = content_mask(arr)
    boxes = find_frames(mask, min_h, min_w, min_area)
    rows = cluster_rows(boxes)
    print(f"\n=== {name}  ({arr.shape[1]}x{arr.shape[0]}) ===")
    for ri, row in enumerate(rows):
        dims = ", ".join(f"{b[2]-b[0]}x{b[3]-b[1]}" for b in row)
        print(f" row {ri}: {len(row)} frames  | {dims}")
    # debug overlay
    dbg = Image.fromarray(arr).convert("RGBA")
    bg = Image.new("RGBA", dbg.size, (20, 20, 30, 255))
    bg.alpha_composite(dbg)
    d = ImageDraw.Draw(bg)
    for ri, row in enumerate(rows):
        for ci, b in enumerate(row):
            d.rectangle([b[0], b[1], b[2], b[3]], outline=(255, 0, 0, 255), width=4)
            d.text((b[0] + 4, b[1] + 4), f"{ri}.{ci}", fill=(0, 255, 0, 255))
    bg.convert("RGB").save(os.path.join(OUT, f"debug_{name}.png"))
    return arr, rows

def trim(sub):
    a = sub[..., 3] > 10
    ys, xs = np.where(a)
    if len(xs) == 0:
        return sub
    return sub[ys.min():ys.max() + 1, xs.min():xs.max() + 1]

# (row_index, start_col, end_col_exclusive)
SHEETS = {
    "player": dict(file="player_sheet.png", kind="light",
                   min_h=90, min_w=40, min_area=2500,
                   anims={"idle": (0, 0, 4), "run": (0, 4, 10), "dodge": (1, 0, 5),
                          "jump": (2, 0, 5), "hit": (3, 0, 4), "shoot": (3, 4, 8)}),
    "boss": dict(file="boss_sheet.png", kind="black",
                 min_h=90, min_w=60, min_area=4000,
                 anims={"idle": (0, 0, 4), "move": (0, 4, 8), "blast": (1, 0, 8),
                        "vinyl": (2, 0, 8), "recoil": (3, 0, 8), "damage": (4, 0, 8)}),
}

def export():
    manifest = {}
    for name, cfg in SHEETS.items():
        arr, rows = process(name, os.path.join(RAW, cfg["file"]), cfg["kind"],
                            cfg["min_h"], cfg["min_w"], cfg["min_area"])
        outdir = os.path.join(OUT, name)
        os.makedirs(outdir, exist_ok=True)
        for f in os.listdir(outdir):
            os.remove(os.path.join(outdir, f))
        manifest[name] = {}
        for anim, (ri, c0, c1) in cfg["anims"].items():
            frames = []
            for ci in range(c0, c1):
                b = rows[ri][ci]
                sub = trim(arr[b[1]:b[3], b[0]:b[2]].copy())
                fn = f"{anim}_{ci - c0}.png"
                Image.fromarray(sub).save(os.path.join(outdir, fn))
                frames.append({"file": f"assets/{name}/{fn}",
                               "w": int(sub.shape[1]), "h": int(sub.shape[0])})
            manifest[name][anim] = frames
            print(f"  exported {name}.{anim}: {len(frames)} frames")
    with open(os.path.join(os.path.dirname(__file__), "manifest.json"), "w") as fh:
        json.dump(manifest, fh, indent=1)
    print("Wrote manifest.json")

if __name__ == "__main__":
    export()
