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

Obavezno je samo `title`. `assignee` mora biti s popisa (`TM_AGENTS`), inače stiže
`Validation failed`. **Prioritet 1 znači da zadatak odmah ulazi u red za izvršavanje** — to radi
okidač u bazi, ne API.

### Izmjena

```bash
curl -X PUT http://localhost:17781/api/tasks/TASK-001 \
  -H "Content-Type: application/json" \
  -d '{"status":"in_progress"}'
```

Zapamti: `pending → completed` izravno **ne prolazi**. Trebaju dva poziva, prvo `in_progress`,
pa `completed`.

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
| `assignee`, `tags` | ne | prosljeđuju se zadatku (`assignee` mora biti s popisa `TM_AGENTS`) |

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

## Projekti

```bash
curl http://localhost:17781/api/projects
curl -X POST http://localhost:17781/api/projects \
  -H "Content-Type: application/json" \
  -d '{"name":"Mjerni lanac","description":"...","lead_agent":"ana"}'
```

Filtri: `status`, `lead_agent`, `projectId`.

## Znanje (RAG)

Radi samo ako su postavljeni `TM_CHROMA_HOST` i `TM_OLLAMA_URL`. Bez njih ovi krajevi javljaju
da je značajka isključena, što nije pogreška.

| Kraj | Što radi |
|---|---|
| `GET /api/rag/health` | je li pretraživanje dostupno |
| `GET /api/rag/collections` | popis zbirki |
| `GET /api/rag/entries?collection=…&search=…` | pretraga zapisa |

## Konzola

| Kraj | Što radi |
|---|---|
| `GET /stream` | web utičnica sa živim tijekom događaja |
| `GET /api/konzola/status` | stanje konzole |
| `GET /api/konzola/logs?lines=200` | zadnji zapisi |
| `POST /api/konzola/message` | poruka agentu |
| `POST /api/konzola/exec` | pokretanje naredbe (vidi upozorenje niže) |

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
