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
