from pathlib import Path
import sys
import numpy as np
from PIL import Image

src = Path(sys.argv[1])
out = Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
im = Image.open(src).convert('L')
arr = np.asarray(im)
# Ignore the column borders and OCR specks outside the printed value.
mask = arr[:, 120:700] < 165
projection = mask.sum(axis=1)
clean = arr.copy()
table_rules = (arr[:, 120:700] < 165).sum(axis=1) > 300
clean[table_rules, :] = 255
Image.fromarray(clean).crop((120, 0, 700, im.height)).save(out / 'coefficients-clean.png')
print('percentiles', np.percentile(projection, [50, 90, 95, 98, 99, 99.5, 99.9, 100]).tolist())
print('rows>300', int((projection > 300).sum()), 'rows12-500', int(((projection >= 12) & (projection <= 500)).sum()))
active = (projection >= 12) & (projection <= 300)
groups = []
start = None
last = None
for y, yes in enumerate(active):
    if yes:
        if start is None:
            start = y
        last = y
    elif start is not None and y - last > 12:
        if 16 <= last - start + 1 <= 90:
            groups.append((start, last))
        start = last = None
if start is not None and 16 <= last - start + 1 <= 90:
    groups.append((start, last))
print('image', im.size, 'groups', len(groups))
for i, (a, b) in enumerate(groups, 1):
    top, bottom = max(0, a - 10), min(im.height, b + 11)
    crop = im.crop((120, top, 700, bottom)).resize((1160, (bottom-top)*2), Image.Resampling.LANCZOS)
    crop.save(out / f'coef-{i:03d}-y{a:04d}.png')
    print(i, a, b, int(projection[a:b+1].max()))
