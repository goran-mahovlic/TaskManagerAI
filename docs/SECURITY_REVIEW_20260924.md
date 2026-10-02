# Sigurnosna revizija prije pusha — TaskManagerAI

**Zadatak:** TASK-5010 (projekt PRJ-048) · **Revizor:** Malik (Security) · **Datum:** 02.10.2026.
**Opseg:** svi commitovi od `60dbd06` do lokalnog `HEAD`, plus cijelo stablo i povijest.

> Ovaj dokument namjerno NE citira pronađene vrijednosti (adrese, ID-jeve, putanje) —
> imenuje ih po vrsti i datoteci. Dokument je dio javnog repozitorija.

## Odluka

**PUSH: DA.**

Nepushani raspon ne donosi nijednu tajnu ni lokalnu vrijednost koja već nije javna. Nove pojave
iz raspona popravljene su u commitu ove revizije. Već objavljeni dug (odjeljak D) push ne
povećava. Njega čisti TASK-5108 (Jelena).

## A. Stanje repozitorija

| Činjenica | Mjerenje |
|---|---|
| Vidljivost | `api.github.com/repos/goran-mahovlic/TaskManagerAI` → HTTP 200, `"visibility": "public"` |
| Već objavljeno | `origin/main` = `6afd595`: `60dbd06..6afd595` (2 commita, TASK-5008) je javno od 24.09.2026. |
| Za push | `origin/main..HEAD` = **22 commita** (`ab14c05` … `3de05f8`) + commit ove revizije |
| Autor | svih 24 commita od `60dbd06`: Goran Mahovlic (autor i committer) |
| Radno stablo pri početku | **čisto** (`git status --short` prazan) |

**„Nespremljene izmjene“ iz opisa zadatka** (`db/schema.sql`, `src/zod/schemas/message|project|rag.ts`)
u radnom stablu više NE postoje. Ušle su u commitove `a90f7a2` (TASK-5008, Zod v4 `z.record`,
već javan) i `24cf6fa` (TASK-5015, `db/schema.sql` +22 retka, tablica postavki). Oba su
pregledana u ovom opsegu i čista su.

**Interni alat** `scripts/uskladi_s_regocem.sh`: nije praćen (`git ls-files` → 0), nijedan commit
u rasponu ga ne dira, a `.gitignore` ga izuzima.

## B. Metoda

1. `git grep` po `HEAD` i `origin/main` za: privatne IP opsege (192.168.x, 10.x, 100.64/10 tailnet),
   tailnet ime, `/home/<korisnik>`, naš raspored mapa, chat ID-jeve (`-100…`, `-5…`, poznati ID
   grupe i korisnika), e-poštu i domenu, imena internih projekata i kolekcija.
2. Svi DODANI retci iz `git log -p origin/main..HEAD` (15.538 redaka) kroz iste uzorke, plus
   imena ljudi, hostnameove i dodjele `password|token|secret|api_key = "…"`.
3. Uzorci tajni preko **cijele povijesti** (`git log -p --all`): Anthropic, GitHub, GitLab, Slack,
   AWS, Telegram bot token, privatni ključevi → **0 pogodaka**.
4. Brana `tests/bez-nasih-vrijednosti.test.ts` i cijeli test-skup.

## C. Nalazi u nepushanom rasponu i popravci

| # | Težina | Gdje (uveo commit) | Što | Ishod |
|---|---|---|---|---|
| C1 | srednja | `src/TaskWebUI.ts` (`ca64357`) | ploča šalje uputu s tvrdo upisanim imenom osobe kao autorom | **popravljeno**: polje se ne šalje, poslužitelj stavlja zadano `user` (`TaskInstructions.parseInstructionInput`) |
| C2 | srednja | `src/TaskWebUI.ts` (`81b8512`) | pgvector obrazac: naše korisničko ime baze kao zadana vrijednost, naš port i naš raspored mapa u tekstu pomoći | **popravljeno**: korisnik iz spremljene konfiguracije (`pg.user`), port opisan općenito (5432), lozinka opisana kao `TM_PGVECTOR_PASSWORD` |
| C3 | niska | `src/core/CriticGate.ts` (`c2e3346`) | komentar s putanjom internog repozitorija i imenom interne memorije hardverskog projekta | **popravljeno**: opisno, bez putanje i imena |
| C4 | niska | `tests/critic-gate-doc.test.ts` (`c2e3346`) | ispitni uzorak = stvarni zapis interne memorije (naziv proizvoda, opis, commit) | **popravljeno**: izmišljen uzorak istog oblika |
| C5 | niska | `tests/report-back.test.ts` (`10428e0`), `tests/spawn-finalizer.test.ts` (`1ed9ad6`) | interni ID projekta u ispitnim podacima | **popravljeno**: `PRJ-001` |
| C6 | niska | `tests/dispatch-guard.test.ts` (`a3c0c9a`) | ime stvarne osobe u ispitnom nizu | **popravljeno**: neutralno ime |
| C7 | info (samo povijest) | `tests/report-back.test.ts` (`10428e0`, uklonio `5ef90db`) | stvarni chat ID grupe u jednom commitu povijesti | **prihvaćeno bez rewritea**: ista vrijednost već je na javnom `origin/main` (12 pojava u `IngestConfig.ts`, `ReportBackTask.ts`, `tests/ingest.test.ts`), pa rewrite 22 commita ne smanjuje izloženost. Briše se s D2. |
| C8 | info | `tools/dezurni.py` (`f30ed50`) | rezerva za alat slanja pod našim rasporedom mapa (iza `TM_TELEGRAM_SEND`) | **vraćeno Jeleni** (D3). Cijela datoteka je naš raspored, a pola popravka bi samo zamaglilo dug. |

Bez nalaza: `10.0.0.5` u `tests/rag-backend.test.ts` (izmišljena adresa za test odbijanja),
`192.168.1.5` u `tests/integracije.test.ts` (generički primjer), `-1001234567890` (izmišljen),
`KSZ9031` (javno ime čipa u ispitnom nizu), mapa `REGOC/` (opis uloga, bez adresa i putanja).
Tajne: **nema ih** ni u rasponu ni u cijeloj povijesti.

## D. Već objavljen dug (nije uveden ovim rasponom) → TASK-5108, Jelena

Broj pojava je isti na `origin/main` i lokalno (ili manji lokalno), pa push dug ne povećava:

| # | Vrsta | `origin/main` → lokalno | Gdje |
|---|---|---|---|
| D1 | naši LAN IP-ovi kao zadane vrijednosti | 23 → 23 (svih 7 izvan `docs/` u `tools/*.py`) | `tools/dezurni.py`, `odlucitelj.py`, `rag_archive.py`, `rag_audit.py`, `rag_izdvoji.py`, `rag_tipovi.py` |
| D2 | chat ID naše Telegram grupe | 12 → 12 | `src/core/IngestConfig.ts`, `src/core/ReportBackTask.ts`, `tests/ingest.test.ts` (+ `docs/`) |
| D3 | naš raspored mapa / HOME | raspored mapa 155 → 150 (brana: 120 izvan `docs/`); `/home/<korisnik>` 14 → 14 | 34 datoteke, `scripts/zakrpe/u6-ingest.patch` |
| D4 | nazivi internih projekata i RAG kolekcija | 34 → 34 | `tools/rag_audit.py`, `tools/razvrstaj_*.py`, `tools/uvoz_telegram_zadataka.py`, `src/core/TaskCreateBreaker.ts` |
| D5 | e-pošta autora | brana: 7 | README/CONTRIBUTING (autorstvo je u redu), `.githooks/commit-msg` + test |

**Upozorenje za Gorana:** sve iz D je u **javnoj povijesti** od 10. do 24.09.2026. Čišćenje vrha
ga ne briše iz klonova. Adrese su privatne (RFC1918), pa izvana nisu dohvatljive. Chat ID sam
po sebi ne daje pristup bez bot tokena. Rewrite povijesti (`git filter-repo` + force push) je
odluka vlasnika. Preporuka: ne raditi rewrite, nego očistiti vrh (TASK-5108).

## E. Dokaz

```
$ bun test
 815 pass
 0 fail
Ran 815 tests across 39 files.

$ bun test tests/bez-nasih-vrijednosti.test.ts      # osnovica rasporeda mapa spuštena 121 → 120
 14 pass
 0 fail

$ git log -p --all | grep -E '^\+' | grep -cE '<uzorci tajni>'
0
```

Pogon: paket ne vrti nijedan proces (`ps` → nema procesa iz paketa). Živa instalacija
izvan paketa nije dirana, pa restart nije potreban.
