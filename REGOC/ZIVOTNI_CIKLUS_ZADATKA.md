# Životni ciklus zadatka

[English](ZIVOTNI_CIKLUS_ZADATKA.en.md) · [Natrag na pregled](README.md)

Zadatak je konačni automat s pet stanja. Prijelazi su zapisani na **jednom** mjestu —
`ValidStatusTransitions` u `src/core/TaskManagerSQL.ts` — i ploča svaki zabranjeni prijelaz
odbija odgovorom `409` s popisom dopuštenih.

---

## Stanja i dopušteni prijelazi

| Iz stanja | Smije u |
|---|---|
| `pending` | `in_progress`, `blocked`, `cancelled` |
| `in_progress` | `completed`, `blocked`, `cancelled` |
| `blocked` | `pending`, `in_progress`, `cancelled` |
| `completed` | `pending` |
| `cancelled` | `pending` |

Nijedan zadatak ne preskače `in_progress` na putu do `completed`, a iz oba završna stanja
(`completed`, `cancelled`) vodi samo jedan put — natrag u `pending`.

### `pending → completed` je zabranjen

Zadatak mora proći kroz `in_progress`. Inače na ploči nikad ne piše tko je na čemu radio, a
zadatak koji stoji na „čeka" dok se na njemu radi laže o stanju sustava. To je namjerno
ograničenje, ne propust.

### Ponovno otvaranje

`completed → pending` i `cancelled → pending`. Zatvoren zadatak vraća se **u red**, nikad
ravno u rad: agent ga uzima kao i svaki drugi `pending`. Iz `completed` nema drugog izlaza —
ni u `blocked`. Posljedica je važna za sljedeći odjeljak.

### Pauza nije stanje

Privremeno zaustavljanje radi zastavica `paused` uz zadatak (`POST /api/tasks/:id/pause`,
`/resume`). Stanje se ne mijenja, pa se posao nastavi točno ondje gdje je stao. `cancelled` se
za to **ne koristi**.

---

## Tko postavlja stanje

**Pravilo iz izvornog sustava: stanje završetka postavlja samo orkestrator, i to nakon suda
kritičara.** Agent svoj ishod javlja tekstom (`REGOC-STATUS:`), a ne pozivom API-ja.

Zašto: kritičar se pokreće tek kad agentov proces izađe, a agent je zadatak zatvarao **dok je
proces još radio**. Mjereno: od šest zadataka kojima je kritičar presudio „pada", **svih šest**
stajalo je na ploči kao `completed` — zatvoreni 5 do 80 sekundi prije presude. Kasni sud nije
se mogao upisati jer iz `completed` ne vodi put u `blocked`, a pogreška zapisa bila je progutana
bez traga. Ploča je pokazivala ✅, korisnik je dobio poruku „nije izvršeno", a trošak jednog
takvog zadatka bio je 18 USD za rad koji nije prolazio vlastiti test.

Rješenje ima dva dijela:

1. **Uputa se mijenja** — agent više ne zove `PUT status`; zadnji redak odgovora mu je jedini
   kanal za ishod (v. [PRAVILA_ISPORUKE.md](PRAVILA_ISPORUKE.md)).
2. **Obrana u dubinu: najam spawna.** Dok proces agenta radi na zadatku, postoji biljeg
   „ovdje upravo radi spawn". Ploča tada odbija `completed` koji ne dolazi od orkestratora
   (`409 SPAWN_ACTIVE`). Pitanje nije „tko si" — agent radi pod istim korisnikom i svaki bi
   token mogao pročitati — nego „radi li upravo sada netko na ovom zadatku". Nečitljiv ili
   ustajao biljeg nikad ne zaključava.

**U paketu:** `src/core/TaskCloser.ts` (zatvaranje s ponavljanjem i zapisom neuspjeha, najam),
`src/core/SpawnFinalizer.ts`; prekidači `spawnCloseGuard` (sjena) i `spawnCloseGuardLive` u
`config/features.example.json`, oba zadano isključena. Čovjek s ploče može pregaziti odluku
izričitim zaglavljem.

---

## `blocked` nije brava

`blocked` je stanje, a stanja mijenja automatika. U izvornom sustavu korak koji je čovjek
ručno stavio u `blocked` automatsko je odblokiranje vratilo u `pending` čim su mu ovisnosti bile
gotove — i orkestrator ga je pokrenuo 30 sekundi kasnije. Blokada koju postavi čovjek nije
držala ni minutu.

**Brava je oznaka.** Zadatak s jednom od oznaka `needs-decision`, `waiting-for-human`,
`no-autonomy` ili `interactive` automatika ne dira — ni odblokiranje ni automatsko
izvršavanje. Popis je u `HUMAN_GATED_UNBLOCK_TAGS` (`TaskManagerSQL.ts`) i
`DEFAULT_HUMAN_GATED_TAGS` (`AutonomyQueue.ts`), a test pazi da ostanu isti.

Druga strana iste pouke: `blocked` bez oznake i bez pitanja postaje **groblje**. U izvornom
sustavu u jednom je trenutku u `blocked` stajalo 87 zadataka, s medijanom od 8,3 dana.

---

## Pitanje za odluku

Kad agent stvarno ne može dalje bez odluke, ne piše prozu u opis nego postavlja **pitanje**:

```
POST /api/tasks/:id/pitanje
{ "ekspert": "…", "pitanje": "…", "opcije": ["…", "…"], "preporuka": "…" }
```

Jedan poziv radi tri stvari odjednom: dopisuje strukturirani blok u opis, dodaje oznaku
`needs-decision` i prebacuje zadatak u `blocked`. „Pitao sam" i „stao sam" su jedan potez, a
ne dva koja se mogu razići.

Pravila (`src/core/OdlukaPitanje.ts`):

- **struka je obavezna** — tko treba odgovoriti; ulazi u ulogu modela ako odgovara stroj;
- **najmanje dvije, najviše šest opcija** — bez izbora to nije dilema nego posao koji treba
  obaviti; iznad šest to je istraživanje;
- **najviše jedno pitanje po zadatku** — pitanje je rijetka iznimka, a ne način rada; zadatak
  koji traži niz odluka nije spreman i treba ga razložiti ili doraditi mu opis.

Odgovor daje čovjek na ploči ili, ako je tako podešeno, lokalni model uz filtar rizika
(`docs/ODLUCIVANJE.md`). Odluka se zapisuje uz zadatak, s potpisom tko ju je donio.

---

## Čistači zaglavljenog posla

Tri kvara koja se u pogonu doista događaju, i tri čistača (`src/core/orchestrator/Watchdogs.ts`):

| Čistač | Kvar kojeg hvata |
|---|---|
| **zombi** | zadatak je `in_progress`, a proces koji ga je uzeo više ne postoji |
| **straža napretka** | proces postoji, ali mjera napretka stoji dulje od `livenessWindowHours` |
| **tvrdi strop** | spawn traje dulje od `hardCeilingHours`, bez obzira na sve ostalo |

U načinu `live` sva tri zadatak **vraćaju u red** (`in_progress → pending`). Taj prijelaz
namjerno nije u tablici gore: ide isključivo posebnim putem za povrat zadatka, jer bi ga
običan `PUT` odbio s `409`, a zadatak bi ostao zaglavljen uz lažan zapis da je vraćen.

Tri pravila ugrađena u sve čistače:

1. **Prvo sjena.** Načini su `off` / `shadow` / `live`; u sjeni čistač zapisuje što bi
   napravio, a ne radi to. Čistač koji pogriješi ubija tuđi rad, a to se vidi tek poslije.
2. **Strop poteza po prolazu** (`maxActionsPerRun`, zadano 5). Bez njega prva ispravna primjena
   na starom sustavu dira stotine zadataka odjednom.
3. **Milost nakon restarta.** Nova generacija orkestratora ne zna za spawnove prethodne, pa bi
   svaki živi agent izgledao kao zombi. Zadatak bez poznatog PID-a pada tek nakon razdoblja
   milosti.

**Zaštitna oznaka.** U izvornom sustavu čistač zaglavljenih zadataka preskače zadatke s
oznakom `no-watchdog` (popis iznimaka je u njegovoj postavci). Ona znači „ne resetiraj me" —
nosi je zadatak koji dugo i ispravno radi. Ona **ne** znači „ne pokreći me": nije ljudska
brava i `AutonomyQueue` je izrijekom izbacuje iz popisa ljudskih oznaka, pa zadatak s njom
smije biti automatski pokrenut. Za „ne pokreći" služe oznake iz odjeljka o `blocked`.

Vidi i: [VRATA_I_KOCNICE.md](VRATA_I_KOCNICE.md) · [LEKCIJE.md](LEKCIJE.md)
