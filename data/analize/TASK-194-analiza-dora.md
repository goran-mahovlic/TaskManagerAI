# Multi-perspektivna analiza — plan testa GLM-5.2 (TASK-206 · dora)

- **Analitičar:** Dora (multi-perspective analyst) · TASK-206
- **Predmet analize:** TASK-205 (kosjenka) — `data/arhitektura/TASK-194-plan-test-glm52.md`
- **Ulazni lanac:** TASK-194 jelena (istraživanje) → TASK-205 kosjenka (arhitektura) → TASK-206 dora (analiza)
- **Izvor zahtjeva:** Goran, telegram -5112799687:109, 2026-10-06T17:50:07Z
- **Datum:** 2026-10-06 · **Projekt (stvarni):** PRJ-001 (REGOČ), formalno u PRJ-033

> Metoda: ne ponavljam dizajn — provjeravam njegove nosive pretpostavke i gledam ga iz pet kutova
> (tehnika, sigurnost, pogon/rizik, korisnička namjera, proces/lanac). Svaka tvrdnja re-provjerena
> na stroju danas.

---

## A. Provjera nosivih pretpostavki (re-grounding, 2026-10-06)

| Tvrdnja iz plana | Neovisna provjera (danas) | Ishod |
|---|---|---|
| `providers.glm` postoji, enabled, anthropic-kompatibilan, baseUrl z.ai | `grep` u `model-config.json` r.51–55: `enabled:true, anthropicCompatible:true, baseUrl:https://api.z.ai/api/anthropic, apiKey:env:GLM_API_KEY` | ✅ potvrđeno |
| `GLM_API_KEY` nedostaje → živi test blokiran | `secret_probe.py --name GLM_API_KEY` → „nije nađena ni u jednom storeu" | ✅ potvrđeno (hard gate stoji) |
| R3: `allow_internet` možda isključen (fail-closed nakon reboota) | `cat /etc/regoc/capabilities.state` → `allow_internet: {on:true}` (updated 22:31Z) | ⚠️ **ZASTARJELO** — internet je trenutno UKLJUČEN |

**Ključni ispravak:** plan tretira R1 (ključ) **i** R3 (internet) kao otvorene preduvjete. Danas je
**samo R1 otvoren**; R3 je zatvoren (internet on). Dodatno: `allow_root:on`, `allow_fs_write:off`
(tier-1, samo zastavica). Dakle jedina tvrda prepreka Jeleninom testu je **unos `GLM_API_KEY`**.

---

## B. Nalazi po perspektivama

### 1. Tehnička / arhitektonska
- **F1 (potvrda):** Grounding plana je solidan — komponente K1–K8 odgovaraju stvarnim datotekama; put za anthropic-kompatibilne providere već postoji, pa je odluka „config-only, bez diranja koda daemona" (§6) ispravna i izbjegava restart živih agenata (R7).
- **F2 (najveći otvoreni rizik):** Model-id `glm-5.2` **nije potvrđen** kod Z.ai (config primjer je `glm-4.6`). To je najveća tehnička nepoznanica — mora se riješiti **prije** ikakve izmjene configa (T1 strogo ispred T2).
- **F3 (praznina u kriterijima):** §4.2 traži da rezolver vrati `provider=glm` a „ne fallback na anthropic", ali plan nema **negativni test**: ako je ključ nevaljan/prazan, ponašanje mora biti *blocked*, a ne tihi fallback na anthropic (koji bi lažno prošao kao „GLM radi").

### 2. Sigurnosna
- **F4 (dobro):** Granica povjerenja jasno označena — `GLM_API_KEY` ide u env djeteta prema vanjskom `api.z.ai`; pravilo „ključ se nikad ne ispisuje" + `secret_probe.py` umjesto `cat` credential-store (R8) je korektno.
- **F5 (kontrola konfiguracije):** R5 (trajni override zagadi produkciju) ispravno mitigiran dediciranim test-ciljem; dodajem: **T6 mora dokazati revert mjerljivo** (`git diff` prazan na `model-config.json`), ne samo tvrdnjom.

### 3. Pogonska / rizik
- **F6:** Internet je sada ON, ali je **fail-closed nakon reboota** — zato T0 mora **re-provjeriti** `capabilities.state` u trenutku izvođenja, ne osloniti se na ovu analizu.
- **F7:** Trošak/rate-limit (R6) uzet je u obzir (≤10 poziva), ali nema praga za „stani" ako latencija/greške eskaliraju — dodati jednostavan abort nakon npr. 3 uzastopne 5xx.

### 4. Korisnička namjera (izvorni zahtjev)
- **F8 (dvodijelni zahtjev — rizik ispuštanja):** Goranova poruka ima **dva** dijela: (a) „otvori zadatak za Jelenu testirati GLM5.2" i (b) „pošalji mi na telegram sve o sustavu regoč + imaš li pristup memoriji i kojem tipu". Dizajn pokriva (a); dio (b) je odrađen u istraživanju (TASK-194), ali **mora stvarno stići Goranu** kroz report-back — inače je polovica zahtjeva nevidljiva korisniku.
- **F9 (doslovni „otvori zadatak"):** Korisnik je tražio da se **otvori izvedbeni zadatak za Jelenu**. Plan opisuje T0–T7, ali konkretan TaskManager-zadatak dodijeljen `jelena` (s `projectId`) još nije vidljiv kao isporuka lanca. To treba napraviti orkestrator/dojava — vrijedi izrijekom osigurati.

### 5. Proces / lanac
- **F10 (metapodatak lanca netočan):** Moj prompt kaže „prethodni korak je radio: jelena", a stvarni prethodni korak je **kosjenka** (TASK-205); jelena je bila dva koraka ranije (TASK-194). Pogreška u atribuciji lanca — bezopasna za ishod, ali je treba ispraviti u orkestraciji.
- **F11 (projekt):** Slažem se s kosjenkom — tematski je **PRJ-001 (REGOČ)** (provider/model jezgre), a ne PRJ-033. Preporuka: preklasificirati.

---

## C. Preporuke (prioritizirano)

1. **[P1] Jedina tvrda prepreka = `GLM_API_KEY`.** Zatražiti od vlasnika unos ključa (Setup GUI / tab Sigurnost). Internet je već ON — ne treba ga tražiti, ali T0 ga re-provjeri (fail-closed).
2. **[P1] T1 prije T2:** potvrditi točan Z.ai model-id (`glm-5.2` vs varijanta) iz službenog izvora; zadržati `glm-4.6` kao kontrolu.
3. **[P2] Dodati negativni test** uz §4.2: nevaljan/prazan ključ → `blocked`, nikad tihi fallback na anthropic.
4. **[P2] Osigurati isporuku OBA dijela Goranovog zahtjeva** u report-back poruci: (a) potvrda da je Jelenin zadatak otvoren + (b) sažetak o sustavu REGOČ i tipovima memorije (iz TASK-194).
5. **[P2] Eksplicitno otvoriti izvedbeni zadatak za `jelena`** (assignee=jelena, projectId=PRJ-001) s koracima T0–T7 — to je doslovni „otvori zadatak" iz zahtjeva.
6. **[P3] T6 revert dokazati mjerljivo** (`git diff` prazan) i dodati abort-prag na stabilnost (3× 5xx → stani).
7. **[P3] Preklasificirati lanac u PRJ-001** i ispraviti atribuciju prethodnog koraka (kosjenka, ne jelena).

---

## D. Presuda
Plan je **tehnički zdrav i spreman za izvedbu** čim vlasnik unese `GLM_API_KEY`. Dizajn precjenjuje
broj preduvjeta (R3/internet je već zatvoren); podcjenjuje dvije stvari: **negativni test** (ključ
nevaljan ≠ fallback) i **drugi dio korisnikova zahtjeva** (odgovor o sustavu/memoriji mora stići
Goranu). Uz preporuke P1–P2 lanac je potpun.

## E. Izvori (grounding)
- `data/arhitektura/TASK-194-plan-test-glm52.md` (TASK-205, kosjenka) — predmet analize
- `data/istrazivanja/TASK-194-istrazivanje.md` (TASK-194, jelena) — kontekst sustava/memorije
- `~/.claude/regoc/models/model-config.json` r.51–55 — `providers.glm` (provjereno)
- `/etc/regoc/capabilities.state` — `allow_internet:on`, `allow_root:on`, `allow_fs_write:off` (2026-10-06 22:31Z)
- `secret_probe.py --name GLM_API_KEY` → „nije nađena" (2026-10-06)
