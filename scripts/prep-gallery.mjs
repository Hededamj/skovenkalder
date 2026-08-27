#!/usr/bin/env node
/**
 * prep-gallery.mjs
 *
 * Web-optimerer de kuraterede galleri-fotos fra fotografens råmateriale
 * og skriver dem til img/galleri/. Kilden er billeder/galleri-raw/
 * (gitignored – originalerne er 10–20 MB hver og hører ikke hjemme i repo).
 *
 * Brug:  node scripts/prep-gallery.mjs
 *        (kræver `sharp` – ligger globalt/op ad mappetræet; sæt evt.
 *         NODE_PATH hvis den ikke findes)
 *
 * Output pr. billede:
 *   img/galleri/NN-slug.jpg        thumb, 800 px bred  (grid)
 *   img/galleri/NN-slug-full.jpg   full, maks 1800 px på længste led (lightbox)
 *
 * Bevidste valg:
 *  - EXIF strippes (sharp gør det som standard). Råfilerne indeholder
 *    GPS-koordinater, og kunden ønsker IKKE stedets præcise placering
 *    offentliggjort – så metadata må ikke slippe med ud.
 *  - .rotate() uden argument anvender EXIF-orientering FØR den strippes,
 *    så stående telefonfotos ikke ender liggende.
 *  - Progressive JPEG, q80 thumb / q82 full, mozjpeg. Ingen WebP/AVIF
 *    i første omgang – holder <picture>-markup ud af index.html.
 *  - Udvalget (GALLERY nedenfor) er kurateret manuelt. Rækkefølgen her
 *    ER rækkefølgen i grid'et. Nummeret i kommentaren refererer til
 *    kontaktarket sendt til Friederikke, så hun kan bytte ud pr. nummer.
 */
import { mkdir, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SRC = join(ROOT, "billeder", "galleri-raw");
const OUT = join(ROOT, "img", "galleri");

const THUMB_W = 800;
const FULL_MAX = 1800;

/**
 * Kurateret udvalg. Felter:
 *   src   – filnavn i billeder/galleri-raw/
 *   slug  – url-venligt navn (bliver NN-slug.jpg)
 *   alt   – dansk alt-tekst (bruges også som caption i lightbox)
 *   tall  – true = stående, får span 2 rækker i grid
 */
const GALLERY = [
  // Rækkefølgen er lagt i "bånd" af 2 rækker, der pakker rent i både 4 og
  // 2 kolonner: [T L L T L L] (2 stående + 4 liggende) eller [T T T T].
  // Afvig ikke fra mønstret uden at tjekke grid'ets bund i browseren.

  // ── Bånd 1: søen + husene ──
  { src: "Billede 14.11.2020, 15.23.25.jpg",     slug: "soe-dis",          alt: "Morgendis over den stille sø med skovbryn i det fjerne", tall: true },          // #26
  { src: "AP8A5084 (1).jpg",                     slug: "hytte-lille",      alt: "Den lille sorte hytte med hvid dør og en stol på trappen i skovskyggen" },        // #5  (F: "mindre hytte #84")
  { src: "Billede 19.08.2026, 08.32.10 (14).jpg", slug: "hovedhus-stengaerde", alt: "Hovedhuset bag det gamle stengærde en solrig forårsdag" },                  // #36 (F: "#14 hovedhus med stengærde")
  { src: "Billede 15.08.2026, 13.05.04.jpg",     slug: "bro-lanterner",    alt: "Badebroen med tændte lanterner i skumringen", tall: true },                     // #28
  { src: "AP8A4989 (1).jpg",                     slug: "sauna-skov",       alt: "Saunahuset i sort træ med panoramavindue mellem træerne" },                       // #4
  { src: "AP8A5196 (1).jpg",                     slug: "vinduesfacade",    alt: "Hovedhusets vinduesrække over en kampestensmur, set gennem løvet" },              // #7

  // ── Bånd 2: jurten ──
  { src: "Billede 14.02.2026, 09.52.03.jpg",     slug: "vaerelse-lyst",    alt: "Lyst værelse med seng, spejl og fletlampe", tall: true },                       // #22
  { src: "AP8A5278 (1).jpg",                     slug: "jurte-lysning",    alt: "Den hvide jurte i en solbeskinnet skovlysning" },                                 // #8
  { src: "DSC00189.jpg",                         slug: "jurte-trappe",     alt: "Jurten med trappe og terrasse i den grønne skov" },                               // #64
  { src: "Billede 12.09.2020, 09.09.42.jpg",     slug: "braendeovn",       alt: "Brændeovnen i stenvæggen med lys og kurve foran", tall: true },                 // #19
  { src: "DSC00162.jpg",                         slug: "jurte-indre",      alt: "Jurtens indre med yogamåtter i cirkel og papirlamper under det ribbede loft" },   // #59
  { src: "DSC00126.jpg",                         slug: "jurte-sal",        alt: "Jurtens sal med yogamåtter, bolstre og papirlamper under det hvide tag" },       // #54 (F: "#26")

  // ── Bånd 3: indenfor ──
  { src: "Billede 14.02.2026, 09.57.14.jpg",     slug: "stue-sofa",        alt: "Stuen med fersken-farvet sofa, rattanbord og brændeovn", tall: true },          // #23
  { src: "DSC00135.jpg",                         slug: "jurte-vindue",     alt: "Jurtens vinduesparti med hvide gardiner og udsigt til skoven" },                  // #56
  { src: "AP8A4822 (1).jpg",                     slug: "sauna-indre",      alt: "Saunaens indre i lyst træ med stort vindue ud mod skoven" },                      // #1
  { src: "Billede 05.09.2025, 08.32.11.jpg",     slug: "jurte-plads",      alt: "Pladsen foran jurten med bænke og grus under træerne", tall: true },             // #12
  { src: "Billede 05.06.2023, 20.30.06 (1).jpg", slug: "sal-cirkel",       alt: "Yogasalen med stole i cirkel og frugt på gulvet foran panoramavinduet" },        // #11
  { src: "Billede 19.08.2026, 08.32.10 (6).jpg", slug: "sal-lys",          alt: "Yogasalen med tændte stearinlys, lupiner og morgenlys" },                        // #40

  // ── Bånd 4: efterår + detaljer ──
  { src: "Billede 23.10.2021, 16.42.46 (1).jpg", slug: "efteraarsskov",    alt: "Efterårsskov i gult og orange med lavt sollys mellem stammerne", tall: true },  // #49
  { src: "Billede 19.08.2026, 08.32.10 (8) (1).jpg", slug: "solopgang-soe", alt: "Solopgang i guld over den spejlblanke sø" },                                 // #42 (F: reserve "nr. 8"; 960 px)
  { src: "Billede 19.08.2026, 08.32.10 (7).jpg", slug: "stue-laeder",      alt: "Stuen med lædersofa, brændeovn og varme lamper" },                              // #41
  { src: "Billede 14.02.2021, 08.26.44.jpg",     slug: "hjerte-doer",      alt: "Gammel afskallet trædør med et udskåret hjerte", tall: true },                  // #21
  { src: "Billede 31.01.2021, 16.07.13.jpg",     slug: "taage-solopgang",  alt: "Solopgang gennem morgentåge over den frosne sø" },                              // #52
  { src: "Billede 28.01.2026, 14.48.21.jpg",     slug: "braende",          alt: "Stablet brænde i nichen over kampestensmuren" },                                // #50

  // ── Bånd 5: vinter (4 stående) ──
  { src: "Billede 04.01.2026, 16.58.37.jpg",     slug: "vinternat",        alt: "Hovedhuset med lys i vinduerne en blå vinteraften i sneen", tall: true },       // #10
  { src: "Billede 05.12.2021, 15.27.35.jpg",     slug: "isbad",            alt: "Badestigen ned i det åbne vand i den frosne sø", tall: true },                  // #14
  { src: "Billede 19.08.2026, 08.32.10 (9).jpg", slug: "snesti",           alt: "Snedækket sti langs hytten under vintertræer", tall: true },                    // #43
  { src: "Billede 31.01.2021, 16.03.00.jpg",     slug: "pavillon-vinter",  alt: "Lav vintersol bag pavillonen ved den sneklædte sti", tall: true },              // #51
];

const fmtKB = (b) => `${(b / 1024).toFixed(0).padStart(4)} KB`;

async function main() {
  const available = new Set(await readdir(SRC));

  const missing = GALLERY.filter((g) => !available.has(g.src));
  if (missing.length) {
    console.error("Mangler i billeder/galleri-raw/:");
    missing.forEach((m) => console.error("  " + m.src));
    process.exit(1);
  }

  const manifest = [];
  let totalBytes = 0;

  // GALLERY_MANIFEST_ONLY=1: læs dimensioner fra allerede genererede
  // full-filer og udskriv kun manifestet – ingen konvertering. Bruges når
  // markup skal (re)genereres uden at røre billederne.
  if (process.env.GALLERY_MANIFEST_ONLY) {
    for (let i = 0; i < GALLERY.length; i++) {
      const g = GALLERY[i];
      const base = `${String(i + 1).padStart(2, "0")}-${g.slug}`;
      const meta = await sharp(join(OUT, `${base}-full.jpg`)).metadata();
      manifest.push({
        thumb: `img/galleri/${base}.jpg`,
        full: `img/galleri/${base}-full.jpg`,
        w: meta.width, h: meta.height, tall: meta.height > meta.width, alt: g.alt,
      });
    }
    console.log("--- manifest (JSON) ---");
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }

  // Start fra tom mappe, så fjernede/omnummererede billeder ikke bliver liggende.
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  for (let i = 0; i < GALLERY.length; i++) {
    const g = GALLERY[i];
    const nn = String(i + 1).padStart(2, "0");
    const base = `${nn}-${g.slug}`;
    const input = join(SRC, g.src);

    const thumbPath = join(OUT, `${base}.jpg`);
    const fullPath = join(OUT, `${base}-full.jpg`);

    // rotate() uden arg = auto-orient fra EXIF, og EXIF skrives ikke ud igen.
    const thumbInfo = await sharp(input)
      .rotate()
      .resize({ width: THUMB_W, withoutEnlargement: true })
      .jpeg({ quality: 80, progressive: true, mozjpeg: true })
      .toFile(thumbPath);

    const fullInfo = await sharp(input)
      .rotate()
      .resize({ width: FULL_MAX, height: FULL_MAX, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 82, progressive: true, mozjpeg: true })
      .toFile(fullPath);

    const tall = fullInfo.height > fullInfo.width;
    if (Boolean(g.tall) !== tall) {
      console.warn(`  ! ${base}: 'tall' i manifest er ${Boolean(g.tall)}, men billedet er ${tall ? "stående" : "liggende"} – retter til ${tall}`);
    }

    totalBytes += thumbInfo.size + fullInfo.size;
    manifest.push({
      thumb: `img/galleri/${base}.jpg`,
      full: `img/galleri/${base}-full.jpg`,
      w: fullInfo.width,
      h: fullInfo.height,
      tall,
      alt: g.alt,
    });

    console.log(
      `${nn}  ${fmtKB(thumbInfo.size)} thumb  ${fmtKB(fullInfo.size)} full  ${fullInfo.width}x${fullInfo.height}  ${tall ? "↕" : "↔"}  ${base}`
    );
  }

  console.log(`\n${manifest.length} billeder, ${(totalBytes / 1048576).toFixed(1)} MB i alt → ${OUT}`);

  // Manifest skrives til stdout som JSON bagefter, så markup kan genereres
  // (eller sammenlignes) uden at gætte. Ikke en fil – index.html er kilden.
  console.log("\n--- manifest (JSON) ---");
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
