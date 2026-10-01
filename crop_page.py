from pathlib import Path
import sys
from PIL import Image, ImageOps, ImageEnhance, ImageFilter

source = Path(sys.argv[1])
out = Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
im = Image.open(source).convert('L')
regions = {
    'table': (250, 0, 2060, 2890),
    'units': (260, 0, 980, 2890),
    'coefficients': (1570, 0, 2050, 2890),
}
for name, box in regions.items():
    crop = im.crop(box)
    crop = ImageOps.autocontrast(crop, cutoff=1)
    crop = ImageEnhance.Contrast(crop).enhance(1.3)
    crop = crop.resize((crop.width * 2, crop.height * 2), Image.Resampling.LANCZOS)
    crop.save(out / f'{name}-gray.png')
    crop.point(lambda p: 255 if p > 175 else 0).save(out / f'{name}-bw.png')
