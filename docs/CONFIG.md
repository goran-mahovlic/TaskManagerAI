# Config stranica i prekidači

Kartica **Config** na ploči (`http://localhost:17781`, zadnja kartica) je mjesto na kojem se
sustav podešava bez uređivanja datoteka. Ovaj dokument opisuje što je na njoj, kako se uređuje
njezin raspored i koji prekidači postoje izvan nje. Rute su opisane u [API.md](API.md), a
instalacija u [INSTALL.md](INSTALL.md).

Što izvorni sustav ima, a ovaj paket nema (kartice za memoriju, obnovu popisa i drugo), popisano
je u [POGON_I_PAKET.md](POGON_I_PAKET.md).

---

## 1. Kako je stranica složena

Kartice su podijeljene u **pet skupina**. Traka na vrhu (01–05) skače na skupinu jednim klikom.
Kartice u skupini 01 vrijede **odmah, bez ponovnog pokretanja**.

| Skupina | Kartica | Što se ondje mijenja | Ruta / datoteka |
|---|---|---|---|
| **01 Strop i vrata autonomije** | Usporedni agenti (1–10) | koliko agenata smije raditi istodobno (zadano 3) | `GET/PUT /api/config/concurrency` |
| | Vrata autonomije | pragovi potrošnje sesije (70/85/95) i tjedna (90) s klizačima i trenutnom zonom | `GET/PUT /api/config/autonomy` |
| | Orkestrator | sloj koji sam pokreće agente: izvođači, `systemFacts`, čistači | `GET/PUT /api/orchestrator/config` → `config/orchestrator.json` |
| **02 Agenti i modeli** | Agents & Model Requirements | koji model pokreće kojeg agenta | `GET /api/agents`, `GET /api/info` |
| | Klasifikacijski model | model za rutiranje poruka, odvojen od izvršnog | `/api/models/classifier` |
| | Podržani modeli i postavke providera | davatelji iz `models/model-config.json` i njihovi modeli | `/api/models/available` |
| **03 Integracije** | Prijave (login preko linka) | prijava davatelja modela | `/api/providers/login/*` |
| | Dežurni | rezervni model kad primarni padne | `/api/dezurni/config` |
| | Telegram obavijesti | bot token (kao ime varijable) i chat id | `/api/telegram/config` |
| | Integracije | Nextcloud, e-pošta, GitLab, GitHub | `/api/integracije` |
| | Ulazna vrata | položaj ulaza po izvoru (`off`/`shadow`/`on`), zadani projekt, pragovi A/B/C | `GET/PUT /api/ingest-gate` → `config/ingest-gate.json` |
| **04 RAG** | RAG Backend | ChromaDB, pgvector ili oba; usporedba i migracija zbirki | `/api/rag/backend/*` |
| **05 Sustav i verzija** | System, AI Providers, Infrastructure, Databases, Metrics Summary, Modules, Core Components, Skills & Workflows, Critical Rules | samo za čitanje | `GET /api/info`, `/api/metrics`, `/api/modules` |

Ukupno 21 kartica. Provjera: `grep -o 'class="info-card[^"]*" id="info-[a-z-]*-card"' src/TaskWebUI.ts | wc -l` → 21.

## 2. Uređivač rasporeda

Raspored kartica (redoslijed, širina, visina) uređuje se izravno na stranici. Postoji **jedan
gumb**: **✎ Uredi raspored**. Kad ga pritisneš, postaje **💾 Spremi raspored**; drugi pritisak
sprema. Uz njega se samo za vrijeme uređivanja pojavljuju tri sporedna gumba, a nijedan od njih
ne sprema:

| Gumb | Što radi |
|---|---|
| ✕ **Odustani** (ili `Esc`) | vraća stanje s početka uređivanja, uz „Vrati" ako je to bila greška |
| ↺ **Zadano** | prikazuje zadani raspored; sprema se tek s 💾 |
| ▤ **Sažmi** | skuplja kartice na naslove, da se lakše premještaju (na zaslonu do 900 px uključuje se samo pri ulasku u uređivanje) |

**Premještanje:** povuci ručku ⠿ na kartici. Kartica se premješta samo **unutar svoje skupine**,
pa navigacija 01–05 ostaje točna.
**Veličina:** povuci kut ◢. Širina je 1–4 stupca mreže, a visina je automatska ili 160–1200 px u
koracima od 40. Dvoklik na kut vraća prirodnu visinu.
**Tipkovnica:** strelice premještaju karticu, `Shift` + strelice mijenjaju veličinu, `A` vraća
automatsku visinu, a `Esc` odustaje.

Tri pravila koja uređivač drži:

1. **Raspored nikad ne mijenja postavku.** Dok traje uređivanje, sadržaj kartica je `inert`:
   klizač ili polje ne može se ni dotaknuti. Vrijednosti se mijenjaju samo vlastitim gumbom
   kartice i svojom rutom.
2. **Raspored je jedan za cijeli sustav.** Sprema se u tablicu `settings` pod ključem
   `config.raspored`, a svaka promjena dobiva redak u `settings_history` u istoj transakciji.
   Druga otvorena ploča dobije poruku `raspored_changed` preko WebSocketa.
3. **Zastarjeli raspored se ne prepisuje.** Ako je netko drugi spremio raspored dok si uređivao,
   spremanje vraća `409` i ništa se ne prepisuje.

Kartica koje na stranici nema (spremljeni ID iz druge inačice) se tiho preskače, pa isti raspored
ne ruši ni ploču s drukčijim skupom kartica. Validacija, ograničenja i primjeri `curl` poziva:
[API.md](API.md), odjeljak „Raspored Config stranice". Dizajn i mjerenja:
[DIZAJN-config-uredivac-rasporeda.md](DIZAJN-config-uredivac-rasporeda.md).

Provjera: `bun test tests/config-raspored-logika.test.ts tests/config-raspored-postavka.test.ts tests/config-raspored-api.test.ts`.

## 3. Prekidači

Svi prekidači paketa slijede isto pravilo: **isključeno → sjena → uživo**. U sjeni se sud
donese i zapiše, ali ništa ne mijenja. Za vratare i tijekove nedostajuća ili neispravna
datoteka nikad ne znači tiho `on`. **Jedina iznimka je `ingest-gate`**: bez datoteke ulaz je
`on`, jer iza njega u paketu stoji samo zapis zadatka na ploči, a ne pokretanje agenta. Ako to ne
želiš, kopiraj primjer (`"*": "off"`). Datoteke se čitaju uživo (najviše 30 s kašnjenja), pa
restart nije potreban.

### 3.1. U paketu

| Prekidač | Datoteka (primjer za kopiranje) | Vrijednosti | Bez datoteke | Gdje se mijenja |
|---|---|---|---|---|
| **workflow-gate** — biraju li se tijekovi rada | `config/workflow-gate.json` (`workflow-gate.example.json`), ili `REGOC_WORKFLOW_GATE_CONFIG` | `nacin`: `off` / `shadow` / `on` | `shadow` | datoteka |
| **materijalizacija** — smiju li iz tijeka nastati zadatci koraka | isto, polje `materijalizacija` | `off` / `shadow` / `on`; vrijedi samo uz `nacin: on` | `shadow` | datoteka |
| tijek pojedinačno | `agents/workflows.json`, polje `enabled` na tijeku | `true` / `false` | uključen | datoteka |
| zadatak pojedinačno | oznaka `bez-workflowa` na zadatku | — | — | ploča / API |
| **ingest-gate** — otvara li poruka zadatak | `config/ingest-gate.json` (`ingest-gate.example.json`), ili `TM_INGEST_GATE_CONFIG` | `enabled`; `perSource`: `off` / `shadow` / `on` po izvoru; `pragA/B/C` | `enabled: true`, `"*": "on"` | Config → Ulazna vrata, `PUT /api/ingest-gate` |
| completion-guard, `REGOC-IZLAZ`, kritičar, `spawnCloseGuard`, strop stvaranja | `config/completion-gate.json`, `step-schema.json`, `critic-gate.json`, `features.json` | v. [INSTALL.md](INSTALL.md) §5.2 | sjena / isključeno | datoteka |

Razine prekidača tijeka, od najjače: oznaka `bez-workflowa` na zadatku → `enabled` na tijeku →
`nacin` u `workflow-gate.json`. Uključivanje koje se pokazalo sigurnim ide redom: prvo `nacin:
shadow` i čitanje `$TM_HOME/data/workflow_odluke.jsonl`, pa `nacin: on` (na zadatak se upisuje samo
oznaka, ne nastaje nijedan zadatak), a tek na kraju `materijalizacija: on`.

### 3.2. Samo u izvornom sustavu

Ovi prekidači postoje u izvornom sustavu, ali **ne u ovom paketu**. Navedeni su da ih ne tražiš
ovdje.

| Prekidač | Što ondje radi |
|---|---|
| **popis-obnova** | petlja svakih 10 min obnavlja kartu sustava i njezinu RAG zbirku (`ukljuceno`, `dopunaHindsighta`) |
| **memorija** | kartica „Memorija (test)": Hindsight memorija po potrošaču (globalno, Telegram sesija, agenti); `on` traži odobrenje vlasnika |
| **tijekPosla** | dojava o završetku nosi odjeljak „🧭 Tijek posla" |
| **zatvaranjeKrozDaemon** | agentov `completed` postaje zahtjev koji daemon provodi kroz kritičara |
| **rad-bez-zadatka** | kuka odbija pisanje Telegram sesije bez otvorenog zadatka |
| **revizijaBlokiranih** | naknadna revizija blokiranih zadataka |

## 4. Tijekovi rada

Katalog tijekova je `agents/workflows.json` (inačica 1.3.0, 11 tijekova). Odluka se donosi
pri otvaranju zadatka, deterministički i bez modela. Popis tijekova, koraci, okidači i pravilo
odabira opisani su u [AGENTI.md](AGENTI.md#tijekovi-rada-workflow).

```bash
python3 tools/odaberi_workflow.py --popis
```

## 5. Ulazna vrata

Generički ulaz `POST /api/ingest` (e-pošta, Telegram, konzola…) svaku poruku boduje težinom i
prema pragovima A/B/C odlučuje otvara li zadatak, ide li u puni lanac i traži li ljudsku potvrdu
plana. Položaj se postavlja po izvoru. Pojedinosti: [API.md](API.md), odjeljak „Ulaz".

U paketu se težina računa formulom v1. Novija ocjena v2 iz izvornog sustava (prepoznaje nalog i
broji struke) u paket nije prenesena; v. [POGON_I_PAKET.md](POGON_I_PAKET.md).

## 6. Dojava pri završetku

Paket nosi **zadatak dojave** (`src/core/ReportBackTask.ts`, oznaka `report-back`): kad se svi
zadatci niza zatvore, korisnik dobije **jednu** poruku sastavljenu iz njihovih rezultata, bez
modela. Postavke su u `config/report-back.json` (ili `REGOC_REPORT_BACK_CONFIG`). Polje
`enabled: false` gasi pometnju, a `live: false` samo zapisuje „BIH POSLALA". Dnevnik poslanih je
`data/report_back_sent.jsonl`, pa pad između slanja i zatvaranja ne šalje drugu poruku.

Odjeljak „🧭 Tijek posla" (koji tijek, koji koraci, tko je radio, koje su vještine i alati
stvarno korišteni) postoji **samo u izvornom sustavu**, jer se mjeri iz transkripata agenata.
