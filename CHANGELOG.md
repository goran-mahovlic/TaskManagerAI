## 2026-09-24 — prijenos značajki iz živog sustava (GAP 24.09.)

Plan i odluke po značajki: [`docs/GAP_20260924.md`](docs/GAP_20260924.md). Prijenos je išao
**po značajkama, ne po datotekama** — svaki hunk iz žive instalacije dobio je paketne obrasce
(`paths.ts`, `konfigPutanja()`, `TM_*`), jer bi slijepa kopija vratila tuđe adrese i naš tim.

**Zadatak i zatvaranje**
- ID projekta nikad ne zaostaje za tablicom (`MAX(sekvenca, max(id)+1)`); ponovno otvaranje
  `completed → pending` i `cancelled → pending`; konzola ne nudi spremanje lozinke.
- Strukturirani izlaz koraka `REGOC-IZLAZ` (W3b): `schema_invalid` uživo uz `nacin: on`,
  `schema_missing` samo uz `provodiNedostajuci` i izvan izuzeća (zaglavlje `X-REGOC-Zatvara`).
- Completion-guard za nepovjerljivog izvršitelja (`localExecutorStrict`, u sjeni).
- Kritičar za dokumente (L0 oblik, L1 traženi odsjeci); L2 traži suca koji nije dio paketa i
  bez njega javlja „sudac nije instaliran". Dojava „neprovjereno" imenuje prošlu razinu.
- `TaskCloser` + `SpawnFinalizer` + `spawnCloseGuard` (`409 SPAWN_ACTIVE`) iza prekidača u
  `config/features.json`, zadano isključeno. **Ispravak uz prijenos:** terminalan skup je
  „stanja iz kojih vodi samo povratak u red" — stari sud „nema prijelaza" nakon uvođenja
  ponovnog otvaranja davao je prazan skup i guard je tiho utihnuo (isti kvar u živom sustavu
  prijavljen je zasebno).

**Ploča**
- `GET /api/tasks/:id` nosi `resultParsed`; kartica crta bedž, sklopive sekcije i „prikaži
  sirovo" isključivo kroz `textContent` (bez `innerHTML`).
- Straža jeke: dojava raspoređivača i obavijesti o životnom ciklusu agenta ne postaju zadatak.
- Procjena struje, CO₂ i vode uz trošak projekta, s rasponom i metodom; koeficijenti u
  `config/energija.json`.
- `model-config.json` se mijenja atomno (`tmp` + `rename`) uz revizijski trag; `[1m]` u popisu.
- RAG s dva pozadinska sustava (ChromaDB / pgvector / dual) + kartica „RAG Backend"; `pg` je
  opcijska ovisnost; lozinka samo iz `TM_PGVECTOR_PASSWORD`, nikad u JSON-u ni odgovoru.

**Bez naših vrijednosti**
- Rod agenta (završio/završila) više nije popis u kodu nego polje `rod` u `config/agents.json`.
- `CostTracker`, `CriticGate`, `UnverifiedReport`, `FeatureFlags`, `TaskCloser`: putanje kroz
  `konfigPutanja`/`stanjePutanja` umjesto tuđeg kućnog direktorija.
- Nove konfiguracije isporučuju se kao `config/*.example.json`; žive su u `.gitignore`.

**Dokumentacija**
- `REGOC/` razdijeljen po temama, svaka na hrvatskom i engleskom (`X.md` + `X.en.md`), uz
  `REGOC/README.en.md`. Brana imena izuzima mapu `REGOC/` jednim pravilom.
- INSTALL §5.2 (vratari i prekidači), §5.3 (RAG); API: prijelazi stanja, zaglavlja zatvaranja,
  `resultParsed`, `/api/critic`, `/api/rag/backend/*`; DATABASE: `v_projects_summary` i datoteke
  stanja; TOOLS; oba READMEa.

**Nije preneseno u ovom krugu** (GAP §3.2–§3.3): sudac L2 i registar imenovanih agenata,
izbor tima u lancu, ostatak demona, tier-klasifikator; sve vezano za naš stroj.

**Provjera prazne instalacije** (`tests/prazna-instalacija.test.ts`, i ručno s `curl`):
`init-db` na praznom `TM_HOME` → poslužitelj → `/` 200 → `POST /api/tasks` (prioritet 1) →
`GET /api/tasks/TASK-001` 200 → `execution_queue` sadrži `TASK-001` (okidač
`auto_queue_p1_tasks`), zadatak prioriteta 3 ne; `/api/rag/backend/status` 200 bez adrese.
Testovi: s ovim prijenosom `bun test` broji 800+ prolaza i 0 padova.

## 2026-09-24 — strop usporednih agenata je postavka, promjenjiva uživo

- Nova tablica `settings` (+ `settings_history` za audit) i modul `src/core/ConcurrencySetting.ts`.
  Ključ `agents.max_concurrent`, zadano **3**, seed pri `scripts/init-db.ts`.
- `GET/PUT /api/config/concurrency` (validacija 1–10, zapis tko/kada/staro → novo) i kartica
  „Usporedni agenti (1–10)" na Config stranici, uz prikaz zauzetih mjesta (npr. 2/3).
- Orkestrator (`SpawnQueue`) čita strop **uživo** (keš ≤5 s) — promjena ne traži restart;
  smanjenje ne prekida poslove koji teku. `SpawnQueue` i dalje prima i obični broj.
- `spawn.maxConcurrent` u `orchestrator.json` i `TM_MAX_CONCURRENT` više ne određuju strop;
  `REGOC_MAX_AGENT_CONCURRENT` je samo jednokratna početna vrijednost i javlja se kao zastarjela.
- Testovi: `tests/concurrency-setting.test.ts` (15 — seed, validacija, audit, keš, fail-safe,
  E2E 1 → 3 bez restarta, init-db na praznom `TM_HOME`).

## 2026-09-10 — tvoj tim, ne naš: popis nositelja zadatka je postao podatak

**`TM_AGENTS` sada doista radi (nalaz N1, `docs/QA_E2E_SAMOSTALNOST_2026-09-10.md`)**
- Popis dopuštenih nositelja više nije zatvoren `z.enum` s imenima naših jedanaest agenata.
  Razrješava ga `src/core/AgentIds.ts` iz dva izvora koja se **zbrajaju**: `id`-evi iz
  `config/agents.json` (putanja: `TM_AGENTS_CONFIG`) i `TM_AGENTS=ana,ivan,marko`. `user` i
  `scheduler` vrijede uvijek — njih upisuje sam sustav.
- **Bez ijednog od ta dva izvora popis nije zatvoren**: provjerava se samo oblik imena
  (`[a-z][a-z0-9_-]{0,31}`). Svježa instalacija radi s bilo čijim timom; čim popis izraziš,
  provjera se pooštri i tipfeler dobiva `400` s nabrojanim dopuštenim imenima.
- Registar se čita pri svakoj provjeri, pa agent dodan poslije pokretanja ploče vrijedi bez
  restarta. Zbrajanje izvora (umjesto prvenstva) uklanja najčešći kvar prve instalacije —
  agent iz `agents.json` koji nije prepisan u `TM_AGENTS`.
- Poruka o odbijenom nositelju odsad kaže i što je krivo i gdje se popis mijenja, umjesto
  `invalid_enum_value` s našim imenima u odgovoru.

**Jedno ime, jedno značenje**
- `scripts/install-agents.sh` i `docs/AGENTI.md` koriste `TM_AGENTS_REGISTRY` za PUTANJU do
  registra PAI agenata. Dotad su `TM_AGENTS` (popis nositelja iz INSTALL.md),
  `$TM_AGENTS` (putanja iz AGENTI.md) i `TM_AGENTS_CONFIG` (stvarni kod) bili tri značenja
  pod dva slična imena.
- Usklađeni `docs/INSTALL.md` §5.1/§6/§11, `docs/API.md`, oba READMEa, `env.example`,
  `config/agents.example.json` i `templates/koraci.json`.

**Brana**
- `tests/agent-ids.test.ts` (14 testova) drži lanac razrješavanja, sustavske nositelje,
  pooštravanje bez restarta i odbijanje neispravnog oblika.
- `tests/bez-nasih-vrijednosti.test.ts` dobio strukturno pravilo: pada na svakoj novoj
  datoteci koja nabraja tri ili više naših imena i na povratku doslovnog imena u shemu
  zadatka. Tekstualni uzorci ovakvo ugrađivanje tima nisu mogli vidjeti.
- `bun test`: 202 pass / 0 fail (bilo 185).

## 2026-09-05 — generički ulaz `POST /api/ingest`

**Ulaz koji ne zna ni za jedan kanal**
- `POST /api/ingest` prima `source`, `externalId`, `replyTo`, `text`, `senderName` (uz
  neobavezne `projectId`, `assignee`, `tags`) i vraća odluku: je li otvoren zadatak, s kojom
  težinom, u kojem projektu i zašto. Most za dopisivanje, pretinac e-pošte i konzola odsad su
  samo pozivatelji — ocjena, pragovi i izbor projekta više nisu u njima.
- Zadatak i dalje nastaje kroz `POST /api/tasks`, jedini ulaz ploče: odbijenice vratara
  (reciklirani izvještaj 422, prazan sadržaj 422, strop stvaranja 429) prolaze nepromijenjene.
- Ocjena je deterministična i besplatna (razred težine + bodovi po koracima, datotekama i
  ponovnom pokušaju) — nijedan model ne stoji na putu dolazne poruke.
- Svaki poziv se zapisuje u `$TM_HOME/data/ingest.jsonl`, i u položaju `shadow` i u `on`.

**Postavke i predlošci**
- `config/ingest-gate.json` — položaj po izvoru (`off`/`shadow`/`on`), zadani projekt po
  izvoru i pragovi A/B/C. Ključ se traži od najužeg prema najširem
  (`source:externalId` → `externalId` → `source` → `*`); stari nazivi `perGroup` /
  `projectByGroup` i dalje rade. Čita se pri svakom pozivu — bez ponovnog pokretanja.
- `templates/koraci.json` i `templates/prvi-zadatak.md` — deset koraka tijeka rada i skelet
  opisa postali su PODATCI. Instalacija mijenja izvršitelje, alate i kanal dojave bez diranja
  koda; pravilo skaliranja po težini ostaje u kodu.

**Paket radi bez REGOČ instalacije**
- `TM_DB` / `TM_HOME` sada premještaju bazu zadataka, projekata, troška i reda poruka izvan
  `~/.claude/regoc`. Bez tih varijabli je putanja nepromijenjena.
- Red poruka stvara svoju mapu ako je nema — dotad poslužitelj na praznom `$HOME` uopće nije
  mogao krenuti (`unable to open database file`, izvan `try/catch`).
- Provjereno: `HOME` bez `~/.claude/regoc`, `bun src/TaskWebUI.ts`, `curl POST /api/ingest`
  → `TASK-001` u `$TM_HOME/data/tasks.db`.

## 2026-09-04 — potrošnja, vrijednost rada i RAG

**Potrošnja po projektu**
- `GET /api/projects/trosak` — ukupna potrošnja po projektu iz `cost_log` (SQL, bez pokretanja
  vanjskih alata), uz prozor od 30 dana te datume prvog i zadnjeg rada (iz zadataka, ne iz
  `projects.created_at` koji često nastane naknadno).
- Kartica projekta prikazuje UKUPNU potrošnju, ne prozor — projekt bez izvođenja u zadnjih
  30 dana više ne pokazuje „—".
- Automatsko osvježavanje: Potrošnja 120 s, Projects 60 s, samo dok je kartica otvorena i
  prozor preglednika vidljiv.
- Pregled uz brojku vraća `kontrola` — kontrolni zbroj iz `cost_log` za isto razdoblje; ploča
  ispisuje „✔ slaže se" ili razliku. Zadano razdoblje pregleda je „svo vrijeme".

**Vrijednost rada po cjeniku S1–S6**
- `tools/vrijednost_inputa.py` — segmentira transkripte (žive i arhivirane) po korisničkoj
  poruci, razvrstava upit u S1–S6 iz zabilježenog rada (koraci, broj i vrsta poziva alata) i
  zbraja po korisniku, projektu i razredu. Trošak modela NIJE mjerilo složenosti.
- `GET /api/vrijednost-inputa` (keš 10 min) i odjeljak u kartici Potrošnja: tablica po
  korisnicima i tablica po projektima s punim nazivom projekta.
- Kartica projekta ima drugi chip — vrijednost (zeleno) uz trošak (plavo); hover pokazuje tko
  je radio. Panel projekta ima odjeljak „Tko je radio" s udjelima po osobama.

**Popis projekata**
- Sortiranje po zadnjem radu, potrošnji, imenu, početku rada i broju zadataka, uz obrtanje smjera.

**RAG**
- `tools/rag_audit.py` (pregled + tagiranje `project_id`), `tools/rag_tipovi.py` (vrsta
  dokumenta `tip_regoc` + oznaka `zasticeno` za pravila, lekcije i pogreške),
  `tools/rag_archive.py` (izvoz/uklanjanje/vraćanje uz zaštitu), `tools/rag_izdvoji.py`
  (izdvajanje znanja iz naslijeđenih kolekcija).
- Filtar po vrsti dokumenta u kartici RAG (`?tip=`), uz postojeći filtar po projektu.
- Brisanje kolekcije odbija se ako sadrži zaštićene dokumente ili ako se kolekcija čita pri
  pokretanju sjednice.

**Uvoz i razvrstavanje**
- `tools/uvoz_telegram_zadataka.py` (zahtjevi iz transkripata u zadatke, segment kao jedinica),
  `tools/razvrstaj_prijave.py` (svaka prijava svoj projekt), `tools/razvrstaj_pretinac.py`
  (tema s tri ili više zadataka dobiva projekt).

**Održavanje paketa**
- `scripts/uskladi_s_regocem.sh` — prijenos izmjena iz žive instalacije uz prepisivanje putanja
  uvoza; dosad se radilo rukom, pa je paket zaostajao.
