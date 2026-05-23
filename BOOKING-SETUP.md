# Booking-kalender — opsætning og daglig brug

Hjemmesiden viser status pr. måned (`Ledig`, `Få datoer tilbage`, `Fuldt booket`,
`Åbner snart`). Status hentes fra `booking-status.json`, som kan opdateres på
to måder:

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
   - For forhåndsreservationer (Option) — læg dem ind som normale events.
     Hjemmesiden viser KUN fri/optaget, så Option og bekræftet booking ser
     ens ud for besøgende. Du kan markere Option i selve event-titlen,
     så DU kan se forskellen i din egen kalender.

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
