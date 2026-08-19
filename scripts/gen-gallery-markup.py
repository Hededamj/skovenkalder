# -*- coding: utf-8 -*-
"""
gen-gallery-markup.py

Regenererer flise-listen i <div class="gallery-grid"> i index.html ud fra
manifestet i scripts/prep-gallery.mjs. Bruges når udvalget ændres:

    1. Ret GALLERY-tabellen i scripts/prep-gallery.mjs (hold båndmønstret!)
    2. node scripts/prep-gallery.mjs            # konverterer billederne
    3. python scripts/gen-gallery-markup.py     # opdaterer index.html

Rører KUN indholdet mellem <div class="gallery-grid"> og den matchende
</div>. CSS, lightbox-dialog og JS er uændrede. Idempotent.

Kræver at `sharp` kan findes af node (sæt NODE_PATH hvis ikke).
"""
import json, os, re, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INDEX = os.path.join(ROOT, "index.html")

env = dict(os.environ, GALLERY_MANIFEST_ONLY="1")
env.setdefault("NODE_PATH", "C:/Users/jacob.hummel/Claude/node_modules")
out = subprocess.run(["node", "scripts/prep-gallery.mjs"], cwd=ROOT, env=env,
                     capture_output=True, text=True, encoding="utf-8")
if out.returncode != 0:
    sys.stderr.write(out.stderr); sys.exit(1)
manifest = json.loads(out.stdout.split("--- manifest (JSON) ---", 1)[1])

def esc(t): return t.replace("&", "&amp;").replace('"', "&quot;")
items = []
for i, m in enumerate(manifest):
    cls = "gallery-item reveal" + (" tall" if m["tall"] else "")
    if i % 4: cls += f" reveal-delay-{i % 4}"
    th = round(800 * m["h"] / m["w"])
    items.append(
        f'        <a class="{cls}" href="{m["full"]}" data-w="{m["w"]}" data-h="{m["h"]}">\n'
        f'          <img src="{m["thumb"]}" alt="{esc(m["alt"])}" width="800" height="{th}" loading="lazy" decoding="async">\n'
        f'        </a>'
    )

s = open(INDEX, encoding="utf-8").read()
pat = re.compile(r'(<div class="gallery-grid">\n)(.*?)(\n      </div>)', re.S)
assert len(pat.findall(s)) == 1, "gallery-grid ikke fundet entydigt i index.html"
s = pat.sub(lambda mo: mo.group(1) + "\n".join(items) + mo.group(3), s)
open(INDEX, "w", encoding="utf-8", newline="\n").write(s)

pattern = "".join("T" if m["tall"] else "L" for m in manifest)
print(f"{len(manifest)} fliser skrevet. Mønster: {pattern}")
