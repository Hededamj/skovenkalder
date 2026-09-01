# Booking-kalender — opsætning og daglig brug

Hjemmesiden viser status pr. måned (`Ledig`, `Få datoer tilbage`, `Fuldt booket`,
`Åbner snart`) — og når auto-sync kører, også de konkrete ledige perioder og
antal ledige weekender pr. måned (fx "Ledigt 4.–9. og 20.–31. · 2 af 4
weekender"). Status hentes fra `booking-status.json`, som kan opdateres på
to måder:

**Status-regler** (konstanter øverst i `scripts/sync-calendar.mjs`; aftalt
med Friederikke, sep. 2026):

- Hver booking blokerer **1 skiftedag** på hver side (rengøring/skift) —
  rejser en gruppe fredag morgen, viser siden først ledigt fra lørdag.
- En ledig periode tæller kun, hvis den kan rumme **mindst 2 nætter**.
- `Fuldt booket` = ingen brugbar ledig periode tilbage.
- `Få datoer tilbage` = mindst **70 %** af månedens nætter er booket.
- `Ledig` = alt andet. En weekend tælles som ledig, når både fredags- og
  lørdagsnatten er fri (inkl. skiftedage).

Logikken er testet: `node --test scripts/sync-calendar.test.mjs` (kører også
i GitHub Action før hver sync).

> **Princip:** Friederikke vedligeholder kun sin Google-kalender. Siden holder
> sig selv ajour: måneder før dags dato skjules automatisk ved visning (så
> ingen skal rydde op i JSON'en), og overskriften "Kalender 2026 – 2027"
> følger de viste år. Ingen måneder er låst manuelt: Friederikke har bekræftet
> (26. aug. 2026), at alle bookinger ligger i Google-kalenderen, så den styrer
> hele kalenderen, så snart den er koblet på. Indtil da er værdierne i JSON'en
> sat i hånden (2026 fuldt booket, dec 2026 "Få datoer tilbage", 2027 ledig).

1. **Manuelt** — rediger `booking-status.json` direkte og push. Entries med
   `"manual": true` ændres ALDRIG af automatik.
2. **Auto-sync fra Google Calendar** — en GitHub Action læser en hemmelig
   ICS-feed-URL fra Friederikkes Skoven Kalder-kalender og opdaterer JSON'en.

---

## Til Friederikke — sådan kommer auto-sync i gang

1. **Opret en dedikeret kalender** i Google Calendar (på den konto der hører
   til `info@skovenkalder.se` — den nye mail vi netop har oprettet).
   - I Google Calendar venstre side → `+ Andre kalendere` → `Opret ny kalender`
   - Navn: `Skoven Kalder bookings`
   - Beskrivelse: noget i stil med "Bookinger og forhåndsreservationer"

2. **Læg alle bookinger ind som events** med konkret start- og slutdato.
   - Eksempel: en booking 15.–17. marts laves som en heldagsbegivenhed
     fra 15. marts til 18. marts (Google's slutdato er checkout-dag,
     altså dagen efter sidste overnatning)
   - **Optioner (forhåndsreservationer): én kalender, én regel.** Ligger
     noget i "Skoven Kalder bookings", viser siden optaget — ellers ledigt.
     Friederikke bestemmer selv pr. option: læg den ind for at holde
     datoerne (vises optaget), eller lad være for at kunne sælge dem
     (vises ledigt; kommer en anden forespørgsel, kører hun sin
     "betal nu eller giv slip"-runde manuelt). Ingen separat
     option-kalender, ingen særlig visning.

3. **Hent kalenderens hemmelige ICS-link:**
   - Klik på de tre prikker ud for kalenderens navn → `Indstillinger og deling`
   - Scroll ned til `Integrér kalender`
   - Kopiér linket under **"Hemmelig adresse i iCal-format"**
   - **Dette link skal holdes hemmeligt** — det giver fuld læseadgang til
     din kalender.

4. **Send linket til Jacob** — fx krypteret via Bitwarden, eller direkte
   i Simply hvis du har 2FA på.

Når Jacob har lagt linket ind som GitHub Secret, opdaterer siden sig selv
hver time. Du skal ikke gøre andet end at vedligeholde din kalender som
normalt.

---

## Til Jacob — opsætning af GitHub Secret

1. Gå til repo'et på GitHub → `Settings` → `Secrets and variables` →
   `Actions` → `New repository secret`.
2. **Name:** `GOOGLE_CALENDAR_ICS_URL`
3. **Value:** den hemmelige ICS-URL fra Friederikke.
4. Klik `Add secret`.
5. Trigger en kørsel manuelt: `Actions` → `Sync booking calendar` →
   `Run workflow`. Verificer at den committer en opdateret
   `booking-status.json`.
6. **Tjek første kørsel mod virkeligheden:** Der er ingen `"manual"`-låse
   tilbage, så første sync overskriver alle måneder i 12-måneders-vinduet
   med kalender-data – også resten af 2026. Viser en måned pludselig "Ledig",
   som du ved er booket, mangler der events i Friederikkes kalender (spørg
   hende), ikke i koden.

Når secret'en er sat, kører Action'en automatisk hver hel time.

---

## Manuel opdatering uden sync

Skal du tvinge en bestemt måned til en bestemt status (fx "Åbner snart"
for en kommende sæson hvor kalenderen endnu er tom), åbn
`booking-status.json` og tilføj/rediger en entry:

```json
{ "name": "Marts", "year": 2028, "status": "open", "manual": true }
```

- `"manual": true` betyder Action'en aldrig overskriver den
- Mulige statusser: `"available"`, `"partial"`, `"booked"`, `"open"`
- Auto-synkede entries har desuden `"free"` (ledige perioder som
  `[{ "from": 4, "to": 9 }]` = ankomst-/afrejsedag) og `"weekends"`
  (`{ "free": 2, "total": 4 }`). Manuelle entries behøver ikke felterne —
  uden dem viser kortet kun status-badgen, som hidtil
- Push ændringen, og siden viser den nye status med det samme

---

## Hvis noget går galt

- **Siden viser tom kalender / falsk venteliste-tekst:** Check at
  `booking-status.json` er gyldig JSON. Browserens console viser
  fallback-data hvis fetch fejler.
- **Action committer ikke:** Tjek `Actions`-fanen for fejl. Mest sandsynligt
  er secret'en utilgængelig eller ICS-URL'en ikke længere gyldig.
- **Forkert status pr. måned:** Tjek events i Google Calendar — de skal
  have konkrete start- og slutdatoer, ikke gentagelser (RRULE understøttes
  ikke i scriptet).

---

## Hosting: Simply-webhotellet (skovenkalder.se)

Siden ligger på Simplys webhotel i `public_html/` og uploades automatisk via
FTPS af `.github/workflows/deploy-simply.yml`:

- **Ved push til `main`** (kun hvis site-filer er ændret: index.html,
  booking-status.json, sitemap, robots, ikoner, `.htaccess`, `img/`).
- **Efter kalender-sync** – `sync-calendar.yml` kalder deploy-workflowet,
  når den har committet en ny `booking-status.json`. (Et push med
  GITHUB_TOKEN udløser ikke andre workflows af sig selv.)
- **Manuelt:** Actions → "Deploy to Simply" → Run workflow.

Kun filerne i `dist/`-listen uploades (scripts, docs og noter bliver hjemme).
`.ftp-deploy-sync-state.json` på serveren husker, hvad der er uploadet; slet
den, hvis alt skal uploades forfra.

**Secrets (GitHub → Settings → Secrets and variables → Actions):**
`SIMPLY_FTP_SERVER` (ftp.simply.com), `SIMPLY_FTP_USERNAME`,
`SIMPLY_FTP_PASSWORD`. FTP-brugeren oprettes/ændres i Simplys kontrolpanel.

**`.htaccess`** erstatter `vercel.json` på Simply: headers, cache, www→apex.
SSL (Let's Encrypt) og "Tvunget HTTPS" er slået til i Simply-panelet
(Website → HTTPS Beskyttelse), så http→https håndteres af Simply; reglen i
`.htaccess` er derfor udkommenteret og skal ikke aktiveres.

**Gammel side:** `public_html` indeholdt en Drupal 7-installation fra 2014
(slået fra; index.php omdøbt). Fuld kopi ligger lokalt i
`billeder/simply-backup-drupal-2026-08-26/` (gitignored). På serveren er
den flyttet til `/old_drupal_2014/` uden for docroot.
