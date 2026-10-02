# QA svježe instalacije i regresija nakon prijenosa — 02.10.2026.

> Zadatak TASK-5011 (GAP 24.09., korak nakon J12 i sigurnosne revizije TASK-5010).
> Metoda: svježi klon u privremenu mapu, **prazan `HOME`**, `env -i` (nijedna `TM_*` varijabla),
> zatim točno koraci iz `docs/INSTALL.md` kako bi ih napravio novi korisnik. Klon je uzet iz
> lokalnog `main` (git bundle), jer GitHub u tom trenutku još nema 23 commita iz prijenosa.

## 1. Nespremljene izmjene iz opisa zadatka

Opis zadatka spominje nespremljene `db/schema.sql` i `src/zod/schemas/{message,project,rag}.ts`.
Stanje 02.10.: radno stablo **čisto**; izmjene su uključene commitom `a90f7a2` (TASK-5008,
F1 iz GAP-a). Nema ničega za uključiti.

## 2. Nalazi

| # | Težina | Nalaz | Ishod |
|---|---|---|---|
| Q1 | **blokira** | `bash scripts/install.sh` po §2 završava s „NIJE SE PODIGLO — `SQLITE_CANTOPEN`". `init` stvara bazu u `$HOME/.taskmanager/data/tasks.db`, a ploča, projekti i red poruka bez `TM_HOME`/`TM_DB` otvaraju naslijeđenu putanju izvornog sustava. Postoji od prvog izdanja; nijedan e2e test ga nije vidio jer svi postavljaju `TM_HOME`. | **popravljeno** — sve kroz `src/core/paths.ts`; novi `tests/svjeza-instalacija.test.ts` |
| Q2 | visoka | `bun run init` nad postojećom bazom pada (`table cost_log already exists`), a §4 i §10 („Nadogradnja") ga opisuju kao bezopasan. | **popravljeno** — shema idempotentna; test init ×2 čuva podatke i P1 okidač |
| Q3 | srednja | `LiveDbGuard` je čuvao samo naslijeđenu bazu; nakon Q1 zadana baza paketa je živa baza korisnika. | **popravljeno** — čuva obje |
| Q4 | srednja | U svježem klonu `bun test` → 44 pada: testovi pretpostavljaju da `~/.tmp` postoji (ingest, commit-msg) i čitaju interni alat prijenosa koji namjerno nije u gitu. | **popravljeno** — mapa se stvara, provjera alata se preskače |
| Q5 | srednja | Pretinac `PRJ-033` je u kodu tvrdi ID izvornog sustava. Na svježoj bazi ne postoji (`GET /api/projects/PRJ-033` → 404), zadatak bez `projectId` dobiva `NULL`, a odgovor `POST` svejedno javlja „smješten u pretinac PRJ-033". Iz koda slijedi (nije izmjereno): 33. projekt korisnika dobit će ID `PRJ-033`, pa će zadatci bez `projectId` tiho pasti u njega. | **otvoreno** — preporuka: `init` stvara pretinac s fiksnim ID-em (npr. `PRJ-INBOX`) ili se ID čita iz postavke |
| Q6 | niska | `scripts/install.sh` uključuje `core.hooksPath .githooks` u svakom klonu. Kuka vlasnikovog identiteta odbija commit svakog drugog korisnika i u poruci mu predlaže `git config user.name 'Goran Mahovlic'`. Izlaz postoji (`taskmanagerai.dopusteniAutori`, CONTRIBUTING.md). | **otvoreno, odluka vlasnika** — preporuka: provjera identiteta samo kad je `dopusteniAutori` postavljen; pravilo o tragu alata ostaje za sve |
| Q7 | info | U `docs/`, `tools/` i komentarima i dalje stoje adrese i putanje izvornog sustava — to je dug D1–D5 iz `docs/SECURITY_REVIEW_20260924.md` (TASK-5108), push ga ne povećava. ~50 rezervi naslijeđene mape (`Tecaj`, `PauseControl`, `WorkflowGate`, model-config…) pripada D3; ploča radi i bez njih. | prepušteno TASK-5108 |

## 3. Provjereno i ispravno

| Što | Rezultat |
|---|---|
| `install.sh` (nakon popravka) | `U REDU: {"status":"healthy",…}`; baza u `$HOME/.taskmanager/data`; ništa ne nastaje pod `$HOME/.claude` |
| `bun run init` drugi put | izlaz 0; 15 tablica, 32 kazala, 5 okidača |
| `bun test` u svježem klonu | **818 pass / 1 skip / 0 fail** (819 testova, 40 datoteka) |
| ploča `/`, `/health` | 200, 200 |
| `POST /api/tasks` (prioritet 1) | 201, zadatak u `execution_queue` — **P1 okidač radi**; `cancelled` ga skida |
| F2 ID projekta | `PRJ-001`, `PRJ-002` redom |
| F3 prijelazi | `pending→completed` = 409 s popisom dopuštenih; `completed→pending` = 200 |
| F5 parser izlaza | `GET /api/tasks/:id` nosi `resultParsed` (razina, bedž) |
| F11 straža jeke | dojava „Task X COMPLETED … No more unblocked tasks" → 422 `recycled_report` |
| F13 RAG backend | `/api/rag/backend/status` bez konfiguracije → 200, `pgvector.configured: false` |
| strop agenata (TASK-5015) | `/api/config/concurrency` → 200, zadano 3, upis `seed:default` |

## 4. `REGOC/` čitan izvana

Deset tema × HR/EN, svaka poveznica vodi na postojeću datoteku, putanje u kodu postoje (ili
imaju `*.example.json`), bez adresa, putanja korisnika i ID-eva razgovora. Tekst opisuje
**uloge i mehanizme** s izmjerenim razlogom, pa se može slijediti bez izvornog sustava.
`SLOZI_SVOJ.md` je dobar ulaz za novog čitatelja. Jedina prepreka bila je Q1: prvi korak
recepta (`install.sh`, zatim `bun src/TaskWebUI.ts`) nije radio bez `TM_HOME`.

## 5. Spremnost za push

Nakon commita s popravcima Q1–Q4: **da**, uz otvorene Q5 i Q6 (ne blokiraju instalaciju) i
poznati dug Q7. Push radi vlasnik repozitorija.
