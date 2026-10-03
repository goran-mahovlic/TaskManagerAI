# API

Sve na istim vratima kao i ploča, zadano `http://localhost:17781`. Odgovori su JSON.
Nema prijave ni ključa — sustav je zamišljen za osobnu mrežu. **Ne izlaži ga na internet bez
posrednika s prijavom.**

## Zadatci

### Popis

```bash
curl "http://localhost:17781/api/tasks"
curl "http://localhost:17781/api/tasks?status=pending&assignee=ana&limit=20"
```

Filtri: `status`, `assignee`, `priority`, `projectId`, `search`, `limit`, `offset`,
`dateFrom`, `dateTo`, `id`.

### Otvaranje

```bash
curl -X POST http://localhost:17781/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
        "title": "Izmjeriti odziv antene",
        "description": "Pojas 30 MHz do 1 GHz, tri uzorka",
        "priority": 2,
        "assignee": "ana",
        "createdBy": "user",
        "tags": ["mjerenje"]
      }'
```

Obavezno je samo `title`. `assignee` mora biti s popisa dopuštenih nositelja
(`config/agents.json` + `TM_AGENTS`, v. INSTALL.md §5.1), inače stiže `Validation failed`
s porukom koja nabraja dopuštena imena. Ako popis nigdje nije zadan, provjerava se samo
oblik imena. **Prioritet 1 znači da zadatak odmah ulazi u red za izvršavanje** — to radi
okidač u bazi, ne API.

### Izmjena

```bash
curl -X PUT http://localhost:17781/api/tasks/TASK-001 \
  -H "Content-Type: application/json" \
  -d '{"status":"in_progress"}'
```

Zapamti: `pending → completed` izravno **ne prolazi**. Trebaju dva poziva, prvo `in_progress`,
pa `completed`.

**Dopušteni prijelazi** (izvor: `ValidStatusTransitions` u `src/core/TaskManagerSQL.ts`;
nedopušten prijelaz vraća `409`):

| Iz | U |
|---|---|
| `pending` | `in_progress`, `blocked`, `cancelled` |
| `in_progress` | `completed`, `blocked`, `cancelled` |
| `blocked` | `pending`, `in_progress`, `cancelled` |
| `completed` | `pending` (ponovno otvaranje) |
| `cancelled` | `pending` (ponovno otvaranje) |

Ponovno otvoren zadatak vraća se **u red**, nikad ravno u rad — agent ga uzima kao i svaki
drugi `pending`.

**Zatvaranje prolazi kroz vratare** (sve je zadano u sjeni — bilježi, ne blokira; v.
INSTALL.md §5.2):

| Vratar | Kada odbija | Odgovor |
|---|---|---|
| completion-guard | `completed` bez dokaza izvršenja, ili agentov vlastiti `REGOC-STATUS: BLOCKED` | `400` |
| shema izlaza koraka | neispravan blok `REGOC-IZLAZ` (uz `nacin: on`) | `400` |
| `spawnCloseGuard` | agent sam postavlja `completed`/`cancelled` dok na zadatku radi njegov spawn | `409 SPAWN_ACTIVE` |

Dva zaglavlja govore ploči tko zatvara:

| Zaglavlje | Vrijednost | Učinak |
|---|---|---|
| `X-REGOC-Zatvara` | `covjek`, `orkestrator`, `agent` | izuzeće od „nema bloka `REGOC-IZLAZ`" vrijedi samo za `covjek`/`orkestrator`; `agent` ga poništava |
| `X-REGOC-Force` | `1` | čovjek s ploče pregazi `spawnCloseGuard` (zapis ostaje u `spawn_close_guard.jsonl`) |

### Prikaz ploče (`GET /api/tasks?view=board`)

Bez parametra `view` `GET /api/tasks` vraća puni niz kao i prije. Ploča traži `view=board`
(`src/PlocaPromet.ts`) i dobiva objekt umjesto niza:

```json
{ "tasks": [ … ], "counts": { "pending": 3, "completed": 2264, … }, "ukupno": 2678,
  "serverTime": "2026-10-03T19:00:00.000Z", "inkrementalno": false, "offset": 0, "imaJos": false }
```

| Parametar | Značenje |
|---|---|
| `zatvorenih` | koliko zadnjih `completed`/`cancelled` (po aktivnosti) ide uz sve otvorene; zadano 150, najviše 2000 |
| `since` | samo zadaci promijenjeni od tog trenutka (klijent šalje prošli `serverTime`; poslužitelj preklapa 5 s jer baza dio vremena piše do sekunde) |
| `offset`, `limit` | straničenje nad poretkom najnovije prvo; `imaJos` kaže ima li još |
| `projectId`, `status`, `assignee`, … | isti filtri kao bez `view` |

`tasks[]` nosi samo polja kartice (`POLJA_PLOCE`: bez `description`, `resultSummary`,
`progressNotes`, `blockedReason` — detalj ih dohvaća s `GET /api/tasks/:id`). `counts` i
`ukupno` broje SVE zadatke (uz isti filtar), pa TOTAL/COMPLETED ostaju točni.

Svi tekstualni odgovori (JSON, HTML) idu komprimirani kad ih klijent traži
(`Accept-Encoding: br` ili `gzip`); bez tog zaglavlja (curl, urllib) odgovor je nepromijenjen.
Ploča svakih 25 s šalje WebSocketom `ping` i dobiva `{"type":"pong"}`; poruka `initial` pri
spajanju nosi samo `serverTime`.

### Rezultat zadatka (`resultParsed`)

`GET /api/tasks/:id` uz `resultSummary` vraća i `resultParsed` — agentov izvještaj
razložen na **poslužitelju** (`src/core/AgentOutputParser.ts`), istim parserom kojim ga
dobivaju kanali:

```json
{
  "resultSummary": "📋 REZULTAT: …\nREGOC-STATUS: DONE — …",
  "resultParsed": { "badge": "…", "badgeEmoji": "…", "badgeSource": "…", "sections": [ … ] }
}
```

Bedž slijedi **stanje zadatka na ploči**; tekst ga smije samo suziti (npr. izvještaj koji
tvrdi `BLOCKED` na zadatku koji je `completed`), nikad podići. Bez rezultata je
`resultParsed: null`. Ploča crta sve kroz `textContent`, pa agentov tekst nikad ne postaje HTML.

### Pauza

```bash
curl -X POST http://localhost:17781/api/tasks/TASK-001/pause
curl -X POST http://localhost:17781/api/tasks/TASK-001/resume
```

Pauza ne mijenja stanje zadatka, pa se posao nastavlja točno ondje gdje je stao. Za razliku od
`cancelled`, iz pauze se vraća.

### Globalna kočnica

```bash
curl -X POST http://localhost:17781/api/pause \
  -H "Content-Type: application/json" \
  -d '{"paused":true,"by":"ana","reason":"nadogradnja"}'

curl http://localhost:17781/api/pause          # stanje
```

Dok je uključena, sustav ne preuzima nove zadatke ni iz reda ni na zahtjev.

### Usporedni agenti (strop)

Koliko agenata smije raditi istodobno. Vrijednost je **postavka TaskManagera** (tablica
`settings`, ključ `agents.max_concurrent`), mijenja se na Config stranici (kartica „Usporedni
agenti") ili ovim krajem i **vrijedi odmah** — orkestrator je čita najkasnije za 5 s, bez
restarta. Nova instalacija počinje s 3.

```bash
curl http://localhost:17781/api/config/concurrency
# {"maxConcurrent":3,"min":1,"max":10,"active":1,"updatedBy":"seed:default",
#  "updatedAt":"…","history":[{"oldValue":null,"newValue":3,"changedBy":"seed:default","source":"seed",…}]}

curl -X PUT http://localhost:17781/api/config/concurrency \
  -H "Content-Type: application/json" \
  -d '{"maxConcurrent":3,"by":"ana"}'
```

- `maxConcurrent` mora biti cijeli broj **1–10**; sve drugo vraća `400` i ništa ne mijenja.
- `by` (tko) i `source` (odakle, zadano `config`) ulaze u povijest (`settings_history`) uz
  staru i novu vrijednost te vrijeme.
- Smanjenje ne prekida agente koji već rade — samo se novi ne puštaju dok ih ne bude manje od
  novog stropa. Pravila autonomije (kvota, tjedni prag) nadjačavaju strop.
- Varijabla okoline `REGOC_MAX_AGENT_CONCURRENT` je **zastarjela**: služi samo kao jednokratna
  početna vrijednost dok postavka još ne postoji. Ako je postavljena, odgovor to javlja u
  `envDeprecated`.

### Vrata autonomije (pragovi)

Postotci potrošnje na kojima autonomija usporava ili staje. **Postavka TaskManagera** (tablica
`settings`, ključevi `autonomy.session_autonomy`, `autonomy.session_caution`,
`autonomy.session_block`, `autonomy.weekly_block`), mijenja se uživo bez restarta. Zadano:
sesija **70 / 85 / 95 %**, tjedan **90 %**.

```bash
curl http://localhost:17781/api/config/autonomy
# {"sessionAutonomy":70,"sessionCaution":85,"sessionBlock":95,"weeklyBlock":90,"min":10,"max":100,
#  "source":"default","usage":{"sessionPercent":73,"weeklyPercent":40,…},
#  "zone":{"session":"task-by-task","weeklyBlocked":false},"history":[]}

curl -X PUT http://localhost:17781/api/config/autonomy \
  -H "Content-Type: application/json" \
  -d '{"sessionAutonomy":80,"by":"ana"}'
```

- Cijeli postotci **10–100**, strogo `sessionAutonomy < sessionCaution < sessionBlock`; tjedni je
  neovisan. Djelomičan PUT je dopušten; nepoznato polje ili nevaljan skup vraća `400`.
- Povijest promjena (staro → novo, tko, izvor) ide u `settings_history`, po ključu.
- `usage` je trenutačna potrošnja (isti izvor kao `/api/session-usage`), `zone` gdje je ona s
  obzirom na pragove — za prikaz na klizaču.
- Nevaljan zapis u bazi znači zadnji dobar skup, pa zadane vrijednosti — nikad „bez praga”.

### Odluka o pokretanju (`needs-decision`)

Zadatak s oznakom `needs-decision` (ili `no-autonomy`, `waiting-for-human`, `interactive`) čeka
dok ga netko — čovjek ili model kojem se to povjeri — ne otključa. Koncept, filtar rizika i
primjeri s ploče su u [ODLUCIVANJE.md](ODLUCIVANJE.md); ovdje su samo krajevi:

| Kraj | Metoda | Što radi |
|---|---|---|
| `/api/odluke` | GET | popis zadataka koji čekaju odluku |
| `/api/odlucitelj/config` | GET / PUT | postavke modela-odlučitelja (`config/odlucitelj.json`) |
| `/api/odlucitelj/pokreni` | POST | pokreni prolaz odlučivanja; s `{"suho": true}` samo pokaže što bi odlučio, ništa ne mijenja |

## Ulaz (`/api/ingest`)

Generički ulaz za poruke izvana. Umjesto da svaki kanal (most za dopisivanje, pretinac
e-pošte, konzola, web forma) sam odlučuje hoće li otvoriti zadatak, svi šalju istih pet polja
i dobivaju natrag odluku. **Ništa u ulazu ne zna ni za jedan konkretan kanal** — `source` je
obična oznaka koju ti biraš.

```bash
curl -X POST http://localhost:17781/api/ingest \
  -H "Content-Type: application/json" \
  -d '{
        "source": "email",
        "externalId": "inbox-42",
        "replyTo": "goran@example.com",
        "senderName": "Goran",
        "text": "Popravi izvoz tjednog pregleda u CSV — brojke po projektu ne odgovaraju kartici."
      }'
```

| Polje | Obavezno | Što je |
|---|---|---|
| `source` | da | odakle je poruka: `email`, `telegram`, `konzola`, `sms`… (slova, brojke, `.`, `-`, `_`; do 32 znaka). Ključ postavki i oznaka `izvor:<source>` na zadatku |
| `text` | da | sam zahtjev (do 20 000 znakova) |
| `externalId` | ne | oznaka razgovora ili pretinca unutar kanala; za sustav je neproziran niz |
| `replyTo` | ne | adresa na koju ide odgovor. Sustav je **ne tumači i ne šalje** — samo je zapiše u opis zadatka (korak 9) |
| `senderName` | ne | tko je poslao, za trag u opisu |
| `projectId` | ne | izričit projekt; ima prednost pred postavkama izvora |
| `assignee`, `tags` | ne | prosljeđuju se zadatku (`assignee` mora biti s popisa dopuštenih nositelja, v. INSTALL.md §5.1) |

Odgovor uvijek nosi ocjenu, i kad zadatak nije otvoren:

```json
{ "ok": true, "created": true, "taskId": "TASK-004",
  "action": "zadatak", "mode": "on", "postupak": "lanac",
  "effort": "E4", "weight": 79, "weightReason": "…",
  "projectId": "PRJ-001", "projectSource": "izvor",
  "needsApproval": false, "reason": "…", "replyTo": "goran@example.com" }
```

| `action` | HTTP | Značenje |
|---|---|---|
| `zadatak` | 201 | zadatak je otvoren; `taskId` je u odgovoru |
| `odgovor` | 200 | ispod praga A ili obično pitanje — ploča se ne dira, pozivatelj neka samo odgovori |
| `sjena` | 200 | izvor je u položaju `shadow`: ocjena se zapisuje, zadatak se ne otvara |
| `preskoceno` | 200 | izvor je u položaju `off` |
| — | 400 | tijelo nije ispravno (`greske` nabraja što) |
| — | 422 / 429 | odbio vratar ploče (reciklirani izvještaj, prazan sadržaj, strop stvaranja); razlog je u `taskManager` |

Zadatak nastaje kroz `POST /api/tasks`, isti ulaz kojim ide i web forma — ulaz ne zaobilazi
nijedan vratar. Otvoreni zadatak nosi oznake `ulaz`, `izvor:<source>`, `tezina:NN` i, iznad
praga B, `lanac`; opis mu je predložak koraka (v. niže).

### Postavke: `config/ingest-gate.json`

```bash
curl http://localhost:17781/api/ingest-gate                     # pročitaj
curl -X PUT http://localhost:17781/api/ingest-gate \
  -H "Content-Type: application/json" \
  -d '{"perSource": {"email": "on", "konzola": "shadow", "*": "off"},
       "projectBySource": {"email": "PRJ-001"}}'
```

```json
{
  "enabled": true,
  "perSource": { "*": "on" },
  "projectBySource": {},
  "defaultProject": "PRJ-033",
  "pragA": 16, "pragB": 36, "pragC": 81
}
```

* **položaji** — `off` (ulaz ne radi ništa), `shadow` (samo mjeri), `on` (otvara zadatke).
  `enabled: false` gasi sve odjednom.
* **ključ izvora** se traži od najužeg prema najširem: `source:externalId` → `externalId` →
  `source` → `*`. Nepoznat izvor je `off` — novi kanal ne kreće sam.
* **pragovi** (ljestvica težine 1–100, mora vrijediti A ≤ B ≤ C):
  ispod **A** se zadatak ne otvara; između **A** i **B** ide jedan izvršitelj; iznad **B**
  puni niz koraka; iznad **C** plan čeka ljudsku potvrdu.
* **projekt**: `projectId` iz zahtjeva → `projectBySource` → `defaultProject`. Nikad `null`.
* Datoteka se čita pri **svakom** pozivu — promjena praga ne traži ponovno pokretanje.
* Stari nazivi `perGroup` / `projectByGroup` i dalje se prihvaćaju i vraćaju.

Gdje datoteka živi, tim redom: `$TM_INGEST_GATE_CONFIG` → `$TM_HOME/config/ingest-gate.json`
(ako postoji) → `config/ingest-gate.json` uz paket. Svaki poziv se dopisuje u
`$TM_INGEST_LOG` (zadano `$TM_HOME/data/ingest.jsonl`), jedan JSON po retku.

Sama datoteka **nije u repozitoriju** i ne treba ju stvarati rukom: bez nje vrijede zadane
vrijednosti, a prvi pomak prekidača s ploče ju napiše. Paket isporučuje samo obrazac —
`config/ingest-gate.example.json`. Razlog je što je to *živa* konfiguracija: `projectBySource`
nosi ključeve izvora (za Telegram id-eve chatova), pa bi praćena datoteka svakom korisniku
u prvi commit unijela njegov popis (revizija TASK-4801, nalaz B4).

### Predložak koraka: `templates/`

Opis zadatka otvorenog kroz ulaz nije prepričana poruka nego popis koraka s izvršiteljem,
alatom, izlazom i dokazom gotovosti — plus git obveza i tko javlja korisniku.

| Datoteka | Što je |
|---|---|
| `templates/koraci.json` | deset koraka (0–9). **Podatci, ne kod**: promijeni imena izvršitelja, alate i kanal dojave bez diranja TypeScripta |
| `templates/prvi-zadatak.md` | skelet opisa; zamjene `{{izvor}}`, `{{poruka}}`, `{{tezina}}`, `{{grill}}`, `{{pragB}}`, `{{projekt}}`, `{{koraci}}`, `{{git}}`, `{{dojava}}`, `{{korak2}}` |

Mapu mijenja `$TM_TEMPLATES`. Nedostajuća ili pokvarena datoteka ne ruši ulaz — koristi se
ugrađeni popis. Koliko je koji korak obvezan **odlučuje težina**, ne predložak: puni grill od
61 naviše, skraćeni 36–60, ispod se preskače; istraživanje i razlaganje su neobvezni ispod
praga B. Koraci se nikad ne brišu iz opisa — korak s napomenom „preskače se (težina 12 < 36)"
nosi i odluku i njezin razlog.

## Kritičar (`/api/critic`)

| Ruta | Što vraća |
|---|---|
| `GET /api/critic/unverified` | zadatke koje je vratar danas pustio, a nije mogao pokrenuti nijednu provjeru; razlozi i razina doc-provjere (`L0`/`L1`) ako je prošla |

Trag svake kritike je `$TM_HOME/data/critic_gate.jsonl`; iz naredbenog retka:
`bun src/core/CriticGate.ts ledger --task TASK-001`.

## Pregled stanja

| Kraj | Što vraća |
|---|---|
| `GET /health` | živ ili nije; koristi se za nadzor |
| `GET /api/status/dashboard` | zbirni brojevi za ploču |
| `GET /api/metrics` | troškovi, brojevi zadataka, događaji |
| `GET /api/agents` | popis agenata i njihovo stanje |
| `GET /api/modules` | učitani moduli i njihovo stanje |
| `GET /api/session-usage` | potrošnja tekuće sjednice, ako je mjerenje uključeno |
| `GET /api/security` | zapisi revizije, ako je modul postavljen |
| `GET /api/info` | popis agenata, modula i pravila sustava na jednom mjestu |
| `GET /api/critic/unverified` | zadatci zatvoreni danas koje vratar dovršetka nije uspio provjeriti |
| `GET /api/pregled/tjedni` | kartica „Potrošnja" — pregled po tjednima |
| `GET /api/tecaj` | tečaj USD→EUR korišten za prikaz troška (mjerenje ostaje u dolarima) |
| `GET /api/vrijednost-inputa` | procijenjena vrijednost korisničkih upita po cjeniku, za usporedbu s troškom |
| `GET`/`PUT` `/api/system/mode` | globalni način rada `PLAN`/`WORK`; promjena se javlja timu porukom |
| `GET`/`PUT` `/api/system/persistent` | koji agenti smiju ostati dugotrajan proces umjesto pokretanja na zahtjev (vidi upozorenje u [REGOC/README.md](../REGOC/README.md#5-demon--dio-koji-radi-kad-nitko-ne-gleda)) |
| `PUT /api/agents/<id>/persistent` | uključi/isključi dugotrajni način za jednog agenta |
| `GET /api/jezici`, `GET /api/jezik/<kod>` | popis jezika sučelja i pojedini rječnik — vidi [JEZICI.md](JEZICI.md) |

## Projekti

```bash
curl http://localhost:17781/api/projects
curl -X POST http://localhost:17781/api/projects \
  -H "Content-Type: application/json" \
  -d '{"name":"Mjerni lanac","description":"...","lead_agent":"ana"}'
```

Filtri: `status`, `lead_agent`, `projectId`. `GET /api/projects/trosak` vraća ukupnu potrošnju
po projektu iz zapisa troška (mora se pitati prije `/api/projects/:id`, inače bi ga ta ruta
progutala).

## Znanje (RAG)

Radi samo ako su postavljeni `TM_CHROMA_HOST` i `TM_OLLAMA_URL`. Bez njih ovi krajevi javljaju
da je značajka isključena, što nije pogreška.

| Kraj | Što radi |
|---|---|
| `GET /api/rag/health` | je li pretraživanje dostupno |
| `GET /api/rag/collections` | popis zbirki |
| `GET /api/rag/entries?collection=…&search=…` | pretraga zapisa |
| `GET /api/rag/projects` | broj dokumenata po projektu |

### Pozadinski sustav (ChromaDB / pgvector / dual)

Postavke su u `config/rag-backend.json` (v. INSTALL.md §5.3). Lozinka nikad ne izlazi kroz API —
odgovori nose samo `passwordSet: true|false`.

| Kraj | Što radi |
|---|---|
| `GET /api/rag/backend/status` | aktivni sustav i stanje oba; bez adrese pgvectora `{configured:false}` i bez mrežnog poziva |
| `PUT /api/rag/backend` | `{"backend":"chromadb"\|"pgvector"\|"dual"}` |
| `GET /api/rag/backend/config` | postavke bez lozinke |
| `PUT /api/rag/backend/config` | `{"host","port","database","user"}`; ključ `password` → `400` |
| `POST /api/rag/backend/test` | proba konekcije (`ProbeGuard` + prigušenje); spremljena lozinka samo za spremljenu adresu |
| `GET /api/rag/backend/compare` | broj dokumenata po zbirci u oba sustava |
| `GET /api/rag/backend/migration` | stanje migracije (prekinuta se tako i prijavljuje) |
| `POST /api/rag/backend/migrate` | `{"collection":"…"}` → `{"started":true}`; serije od 100, ponovni pokušaj preskače već kopirano |

Kao i ostale Config rute, i ove štiti samo popis dopuštenih domaćina (`TM_ALLOWED_HOSTS`) —
prijave nema, pa ploču ne izlaži izvan svoje mreže.

## Modeli i davatelji

| Kraj | Metoda | Što radi |
|---|---|---|
| `/api/models/available` | GET | davatelji iz `models/model-config.json` + živi popis modela (za Ollamu čita `/api/tags`) |
| `/api/models/classifier` | GET / PUT | model koji razvrstava/usmjerava poruke — odvojen od modela koji posao izvršava |
| `/api/models/providers/<id>` | PUT | uključi/isključi davatelja, promijeni `baseUrl` ili ključ |
| `/api/providers/login/status` | GET | je li koji davatelj prijavljen preko linka (OAuth-nalik tijek), a ne samo ključem |
| `/api/providers/login/start` | POST | pokreni prijavu za davatelja; vraća poveznicu na koju treba otvoriti preglednik |
| `/api/providers/login/poll` | GET | provjeri je li prijava dovršena (klijent zove periodički) |
| `/api/providers/login/paste` | POST | dovrši prijavu kodom zalijepljenim iz preglednika, umjesto čekanja na `poll` |
| `/api/providers/login/apikey` | POST | postavi davatelja izravno API ključem, bez tijeka prijave |
| `/api/providers/login/logout` | POST | odjava davatelja |

## Dežurni (rezervni) model

> **Ovo je REGOČ-specifično, ne prenosivo bez izmjene.** Ploča i alat isporučuju se u paketu, ali
> putanje su tvrdo upisane na `~/.claude/regoc/config/dezurni.json`,
> `~/.claude/regoc/models/model-config.json` i `~/.claude/regoc/credentials.env` — ne poštuju
> `TM_HOME`. `POST /api/dezurni/proba` uz to poziva `~/.claude/tools/Telegram/dezurni.ts`, most
> koji **nije dio ovog paketa**; bez njega proba vraća čitljivu grešku, ne pad.

Zamisao: kad primarni davatelj (kod nas Anthropic/Claude) prestane odgovarati, dežurni je model
koji preuzme razgovor — javi razlog (kvar kod davatelja, istekla prijava, iscrpljena kvota, pao
naš servis) i, ako je `smije_podici` uključen, sam nastavi umjesto njega. Bez njega poruka u
kvaru ostane bez odgovora, a nitko to ne primijeti dok netko ne pita.

| Kraj | Metoda | Što radi |
|---|---|---|
| `/api/dezurni/config` | GET | postavke + živ popis modela odabranog davatelja |
| `/api/dezurni/config` | PUT | promjena davatelja, modela, praga i ostalog |
| `/api/dezurni/proba` | POST | probni poziv odabranog davatelja — jedini dokaz da izbor stvarno radi, ne samo da izgleda ispravno |

Postavke (`config/dezurni.json`):

```json
{
  "ukljucen": true,
  "provider": "ollama",
  "model": "qwen3:8b",
  "baseUrl": "http://192.168.10.4:11434",
  "okidac_uzastopnih_gresaka": 2,
  "smije_podici": true,
  "razmak_straze_min": 30
}
```

`okidac_uzastopnih_gresaka` (1–10) je koliko uzastopnih kvarova pokreće dežurnog;
`razmak_straze_min` (5–240) je koliko rijetko straža provjerava stanje. CLI inačica istoga:
`tools/dezurni.py` (vidi [TOOLS.md](TOOLS.md)).

## Gita (slike)

Prosljeđuje zahtjev na neovisan servis za generiranje slika na `localhost:8889`, ako postoji —
nije dio ovog paketa i nije obavezan.

| Kraj | Metoda | Što radi |
|---|---|---|
| `/api/gita/generate` | POST | proslijedi zahtjev za generiranje slike; `503` ako servis ne radi |
| `/api/gita/health` | GET | je li servis dostupan |

## Konzola

| Kraj | Što radi |
|---|---|
| `GET /stream` | web utičnica sa živim tijekom događaja |
| `GET /api/konzola/status` | stanje konzole |
| `GET /api/konzola/logs?lines=200` | zadnji zapisi |
| `POST /api/konzola/message` | poruka agentu |
| `POST /api/konzola/mode` | prebaci konzolu između `plan` (samo prijedlog) i `work` (izvršava) |
| `POST /api/konzola/exec` | pokretanje naredbe (vidi upozorenje niže) |
| `GET /api/files/download?path=…` | preuzimanje dokumenta na koji zadatak upućuje; ograničeno na `$HOME` |

> `POST /api/konzola/exec` izvršava naredbu na stroju. Nema prijave, pa vrata ne smiju biti
> dostupna izvan tvoje mreže. Ako ti ta mogućnost ne treba, najsigurnije je zatvoriti pristup
> vratima vatrozidom i ploču koristiti preko SSH tunela.

## Primjer: agent koji sam uzima posao

```bash
#!/usr/bin/env bash
# Uzmi prvi zadatak koji čeka, odradi ga, zatvori.
OSNOVA=http://localhost:17781

ZADATAK=$(curl -s "$OSNOVA/api/tasks?status=pending&limit=1" \
          | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
[ -z "$ZADATAK" ] && { echo "nema posla"; exit 0; }

curl -s -X PUT "$OSNOVA/api/tasks/$ZADATAK" \
  -H "Content-Type: application/json" -d '{"status":"in_progress"}' >/dev/null

# ... ovdje ide stvarni posao ...

curl -s -X PUT "$OSNOVA/api/tasks/$ZADATAK" \
  -H "Content-Type: application/json" \
  -d '{"status":"completed","progressNote":"gotovo"}' >/dev/null
echo "zatvoren $ZADATAK"
```
