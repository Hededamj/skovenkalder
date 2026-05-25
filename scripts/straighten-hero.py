"""
Retter hero-billedet op så søens vandlinje er horisontal.
Roterer billedet med uret med en justerbar vinkel, og beskærer
den størst-mulige inskriverede rektangel for at undgå sorte hjørner.

Brug:
    python scripts/straighten-hero.py [angle_degrees]

Standard: 1.5 grader. Positive værdier = drej med uret (retter en
venstre-hældning op).
"""
import sys
import math
from PIL import Image

ANGLE = float(sys.argv[1]) if len(sys.argv) > 1 else 1.5  # grader, clockwise
SRC = "img/.solnedgang-soe.original.jpg"
DST = "img/solnedgang-soe.jpg"

img = Image.open(SRC)
w, h = img.size

# PIL roterer mod uret ved positive vinkler. Vi vil drej med uret => negativ.
rotated = img.rotate(-ANGLE, resample=Image.BICUBIC, expand=True)
rw, rh = rotated.size

# Beregn størst inskriverede rektangel med samme aspect ratio som originalen.
# For et rektangel WxH roteret med vinkel θ, er den størst inskriverede
# rektangel med samme aspekt cropped med faktor:
#   k = 1 / (|cos θ| + (max(W, H) / min(W, H)) * |sin θ|)
# Vi tager den simpleste tilgang: beregn maksimal aspect-bevarende crop.
theta = math.radians(ANGLE)
cos_t = abs(math.cos(theta))
sin_t = abs(math.sin(theta))

# Aspect ratio (bredde / højde) for originalen
ar = w / h

# Den størst inskriverede aspect-bevarende rektangel har bredde:
#   crop_w = (w * cos_t - h * sin_t) if w >= h else ...
# men en god approximation:
if w >= h:
    crop_w = (w * cos_t - h * sin_t)
    crop_h = crop_w / ar
else:
    crop_h = (h * cos_t - w * sin_t)
    crop_w = crop_h * ar

crop_w = int(crop_w)
crop_h = int(crop_h)

# Centrér crop på det roterede billede
cx = rw // 2
cy = rh // 2
left = cx - crop_w // 2
top = cy - crop_h // 2
right = left + crop_w
bottom = top + crop_h

cropped = rotated.crop((left, top, right, bottom))

# Resize tilbage til original størrelse for at undgå at miste opløsning andre steder
final = cropped.resize((w, h), Image.LANCZOS)
final.save(DST, "JPEG", quality=92, optimize=True, progressive=True)

print(f"Roteret {ANGLE}° med uret. Beskåret til {crop_w}x{crop_h}, "
      f"opskaleret tilbage til {w}x{h}.")
print(f"Skrev: {DST}")
