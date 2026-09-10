# QA E2E test plan + regresija — TaskManagerAI samostalnost (TASK-4802)

> Nakon TASK-4800 (Jelena, orchestrator core + 4 integracije + Telegram poller) i
> TASK-4801/4807 (Malik, sigurnosna revizija + popravci B1–B4). Testirano na commitu
> `f040734`, 185 testova (`bun test`) u repozitoriju.

## Metoda

1. **Svježa instalacija** — `git clone` lokalnog repozitorija (izolirani `HOME` samo za tu
   naredbu, zbog "dubious ownership" u kontejneru) u `~/.tmp/qa-fresh-4802/TaskManagerAI`,
   potpuno prazan `TM_HOME`, bez `.env` dok se ne dođe do koraka koji ga traži, bez ijedne
   postojeće postavke — točno kako bi vidio korisnik koji tek skida paket. Svaki korak iz
   `docs/INSTALL.md` izveden doslovno, redom.
2. **Regresija node-A/node-B** — SSH na obje mašine, `bun test` u živoj instalaciji, provjera
   osnovnih API ruta na živom procesu.

## 1. Svježa instalacija prema INSTALL.md — po koracima

| # | Korak (INSTALL.md) | Naredba | Rezultat |
|---|---|---|---|
| §1 | preduvjeti | `bun --version` | `1.3.6` — OK |
| §2 | `git clone` + `bash scripts/install.sh` | — | bun instaliran, `bun install` 55 paketa (zod ✓, chromadb ✓), baza stvorena, rječnici OK, git kuke postavljene, poslužitelj se stvarno podigao na zadanim vratima i odjavio `healthy` |
| §3 | `install-agents.sh` | pročitan (nije pokrenut destruktivno — piše u `~/.claude/regoc/REGOC_AGENTS.json` na PRAVOM stroju čak i s izoliranim `TM_HOME`, v. **N3**) | vidi nalaz N3 |
| §4 | `bun run init` | — | **13 tablica, 5 okidača** — točno kako obećava dokument |
| §5 | `bun run start` + `/health` | — | `{"status":"healthy",...}` — OK |
| §5.1 | `cp env.example .env` | — | OK, poslužitelj se digao s njim |
| §6 | orkestrator `--stanje` | `bun scripts/orchestrator.ts --stanje` | `{"ukljucen":false,"greske":["registar agenata je prazan (config/agents.json)"]}` — jasna, provediva poruka na praznoj instalaciji |
| §7 | integracije, GET config za sve 4 + Telegram | `curl .../api/{nextcloud,email,gitlab,github,telegram}/config` | vidi tablicu niže i nalaze N4, N5 |
| §7 | Telegram poller `--proba` bez tokena | `bun scripts/telegram-poller.ts --proba` | `{"ok":false,"greska":"bot token nije postavljen"}` — jasno, ne ruši se |
| §9 | pričuve | `bun scripts/backup.ts` | preslika stvorena (`tasks-....db`, 188 kB) — OK |
| §11 | tablica grešaka | spot-check | poruke iz tablice odgovaraju stvarnom ponašanju (isprobano: prazan `assignee` s nepoznatim imenom → `Validation failed`, v. **N1**) |

### Zadano stanje 4 integracije + Telegram na praznoj instalaciji

| Modul | `ukljucen` | `dopustiPrivatneMreze` | tajna u odgovoru? |
|---|---|---|---|
| Nextcloud | false | **true** | ne |
| E-pošta | false | **false** | ne |
| GitLab | false | **true** | ne |
| GitHub | false | (nema polje — ide preko `gh` CLI) | ne |
| Telegram | false | — | ne (`botTokenEnv` samo, vrijednost nije u odgovoru — B2 potvrđen zatvoren) |

## 2. Nalazi (rangirano po ozbiljnosti)

### N1 — ~~BLOKIRAJUĆI~~ **RIJEŠENO 10.09.2026. (TASK-4808)**: "donesi svoj tim" (`TM_AGENTS`) je bio dokumentacijska fikcija

> **Ishod:** popravljeno po preporuci (a). `AgentIdSchema` više nije `z.enum`, nego provjera
> kroz `src/core/AgentIds.ts`, koja popis razrješava iz `config/agents.json`
> (`TM_AGENTS_CONFIG`) **plus** `TM_AGENTS` (CSV, kako INSTALL.md §5.1 i obećava), uz
> `user`/`scheduler` koje uvijek dodaje sustav. Izvori se ZBRAJAJU — da agent iz
> `agents.json` ne ispadne zato što nije prepisan i u `TM_AGENTS` (kvar „dvije istine" iz
> §6). Bez ijednog izvora popis nije zatvoren: provjerava se samo oblik imena
> (`[a-z][a-z0-9_-]{0,31}`), pa svježa instalacija radi s bilo čijim timom, a ugrađenog
> popisa NAŠIH imena u paketu više nema. Registar se čita pri svakoj provjeri, pa agent
> dodan nakon pokretanja vrijedi bez restarta.
>
> Sukob imena riješen: `scripts/install-agents.sh` i `docs/AGENTI.md` sada koriste
> `TM_AGENTS_REGISTRY` za PUTANJU do registra PAI agenata, pa `TM_AGENTS` znači točno
> jednu stvar.
>
> **Dokaz (živa sjena, tuđi tim `ana`/`ivan`/`marko` u `config/agents.json`):**
> ```
> POST /api/tasks {"assignee":"ana"}      → 201 TASK-001
> POST /api/tasks {"assignee":"kosjenka"} → 400 nositelj „kosjenka" nije na popisu agenata [ana, ivan, marko, scheduler, user]
> POST /api/tasks {"assignee":"anna"}     → 400 (tipfeler se hvata)
> svježa instalacija bez ikakve postavke: {"assignee":"nikola"} → 201
> TM_AGENTS=ana,ivan,marko:               {"assignee":"ivan"} → 201, {"assignee":"kosjenka"} → 400
> registar stvoren nakon pokretanja:      {"assignee":"petra"} → 201 bez restarta
> ```
> `bun test`: **202 pass / 0 fail** (bilo 185; +14 `tests/agent-ids.test.ts`, +3 strukturna
> brana u `tests/bez-nasih-vrijednosti.test.ts`). Nalaz niže ostaje kao zapis zatečenog stanja.

#### Zatečeno stanje (10.09.2026., prije popravka)

`docs/INSTALL.md §5.1` i `§11` tvrde da `TM_AGENTS=ana,ivan,marko` mijenja popis dopuštenih
nositelja zadatka. **Ne postoji nijedno mjesto u `src/` koje čita `process.env.TM_AGENTS`.**
Popis dopuštenih imena je **tvrdo upisan** enum u `src/zod/schemas/task.ts`:

```ts
export const AgentIdSchema = z.enum([
  'regoc', 'klaudio', 'stribor', 'kosjenka', 'jelena',
  'malik', 'manda', 'potjeh', 'dora', 'gita', 'grga',
  'pai', 'user', 'scheduler'
])
```

i koristi se posvuda (zadatak `assignee`, projekt `lead_agent`/`agent_id`, poruke
`from_agent`/`to_agent`, `verification`). Dokazano na živoj sjeni (prazan `TM_HOME`, `TM_AGENTS=ana,ivan,marko`):

```
POST /api/tasks {"assignee":"ana"}       → 400 invalid_enum_value, options=[...naših 11 imena...]
POST /api/tasks {"assignee":"kosjenka"}  → prihvaćeno (uz opis)
```

**Posljedica:** korisnik koji slijedi INSTALL.md doslovce NE MOŽE koristiti vlastiti tim —
paket i dalje nosi NAŠIH 11 imena kao jedini dopušteni popis, suprotno cilju iz
`docs/ROADMAP_SAMOSTALNOST.md` §0 ("korisnik... radi jednako kako mi sada radimo... bez
ijednog retka tuđeg koda"). Brana `tests/bez-nasih-vrijednosti.test.ts` ovo ne hvata jer
traži tekstualne uzorke (`/home/klaudio`, naše IP adrese, `.claude/regoc`), ne strukturne
pretpostavke poput zatvorenog enuma imena.

> Zatvoreno 10.09.2026.: brana je dobila strukturno pravilo — pada na svakoj NOVOJ
> datoteci koja nabraja tri ili više naših imena (osnovica: 21 datoteka; `src/zod/schemas/task.ts`
> ispao s popisa) i na povratku doslovnog imena u shemu zadatka.
>
> **Nastavak, TASK-4809 (10.09.2026.):** runtime su vrata bila zatvorena, ali su naša imena
> ostala u JOŠ TRI datoteke — kao TIP i kao PRIKAZ. Maknuto:
> `src/types/task-types.ts` (`AgentId` unija naših imena → `string`; `ALL_AGENTS`,
> `AGENT_NAMES` i `AGENT_CAPABILITIES` s našim ulogama → `allAgents()`/`agentNames()`/
> `agentName()` iz registra, matrica sposobnosti obrisana kao politika instalacije),
> `src/core/TaskManagerSQL.ts` (`AgentId`, `AGENT_IDS` → `agentIds()`; zadani autor bilješke
> napretka bio `'regoc'` → `changedBy`, tj. `'system'`) i `src/core/MessageQueue.ts`
> (`VALID_AGENTS` — mrtav popis, jer `isValidAgent()` odavno ide kroz `AgentIdSchema` →
> `validAgents()`; primjeri u CLI-ju s našim imenima → `scheduler`/`assistant`).
> Osnovica strukturne brane: **21 → 18 datoteka**; dodan test koji za te četiri datoteke pada
> već na PRVOM našem imenu u kodu (zapor s pragom 3 ne bi vidio povratak jednog imena).
> `bun test`: **211 pass / 0 fail** (bilo 208).
>
> **Dokaz (živa sjena, port 17795, tuđi tim `ana`/`bruno` u `config/agents.json`):**
> ```
> POST /api/tasks {"assignee":"ana"}    → 201 TASK-001
> POST /api/tasks {"assignee":"jelena"} → 400 nositelj „jelena" nije na popisu [ana, bruno, scheduler, user]
> PUT  /api/tasks/TASK-002 {"progressNotes":[...]} bez nositelja → agent: "system" (prije: "regoc")
> allAgents() = [ana, bruno, scheduler, user]; agentNames() = {ana: "Ana Anić", bruno: "Bruno Brnić"}
> ```

Dodatna zabuna: **tri različita značenja pod istim/sličnim imenom**:
- `docs/INSTALL.md` — `TM_AGENTS` = CSV popis dopuštenih imena (ne postoji u kodu).
- `docs/AGENTI.md:49,63` — `$TM_AGENTS` = putanja do registra (`~/.claude/regoc/REGOC_AGENTS.json`).
- `scripts/install-agents.sh:23` — čita env `TM_AGENTS` kao putanju odredišta (poklapa se s AGENTI.md, ne s INSTALL.md).
- `src/core/orchestrator/AgentRegistry.ts:26` — stvarni kod čita **`TM_AGENTS_CONFIG`** (drugo ime!) za putanju do `agents.json` orkestratora.

Četiri mjesta, tri različita ponašanja, isto ime. Ovo nije objašnjeno redoslijedom pa
korisnik nema način razlikovati "assignee dopušteni popis" (ne postoji), "gdje je REGOC
registar" (`TM_AGENTS`) i "gdje je registar orkestratora" (`TM_AGENTS_CONFIG`).

**Preporuka:** ili (a) učiniti `AgentIdSchema` config-driven (čitati stvarni popis iz
`config/agents.json`/`TM_AGENTS_CONFIG` pri pokretanju, kako orkestrator već očekuje — vidi
INSTALL.md §6 "imena agenata moraju se poklapati s TM_AGENTS"), ili (b) ako je zatvoren enum
namjeran za MVP, ispraviti dokumentaciju da to jasno kaže i preimenovati `install-agents.sh`
promjenjivu da se ne kosi s (nepostojećim) `TM_AGENTS` iz INSTALL.md. Trenutno stanje je
nalaz, ne pretpostavka — prihvatni kriterij "svježa instalacija radi točno prema INSTALL.md"
**pada** na ovoj stavci.

### N2 — Ploča prazna re-test drugim redom (kontrolni test, OK)
Kad `assignee` NIJE zadan, `POST /api/tasks` radi normalno i sprema u `PRJ-033` (pretinac)
uz `warnings.project` — ovo je dokumentirano ponašanje (v. TaskFieldAliases/ProjectManager),
netaknuto ovim ciklusom, samo potvrđeno da i dalje radi.

### N3 — `install-agents.sh` piše izvan izoliranog `TM_HOME` po zadanom

`ODREDISTE="${TM_AGENTS:-$HOME/.claude/regoc/REGOC_AGENTS.json}"` — zadano odredište je
`$HOME/.claude/regoc/...`, **NE** `$TM_HOME/...`. Na stroju koji već ima `~/.claude/regoc`
(kao ovaj), pokretanje skripte bez `--u` ili bez postavljenog `TM_AGENTS` (što je, po N1,
jedini način da ta varijabla uopće nešto znači) piše/pravi pričuvu u PRAVI korisnički
direktorij, čak i kad je sve ostalo (`TM_HOME`) izolirano. Zbog ovoga skripta namjerno NIJE
pokrenuta u ovom testu (samo pročitana) — svaka izvedba na dijeljenom stroju bi dirala pravi
`~/.claude/regoc/REGOC_AGENTS.json`. Za pravog korisnika bez postojećeg `~/.claude/regoc`
ovo je bezopasno (stvara novu datoteku), ali dokument to ne kaže eksplicitno, niti nudi
`TM_HOME`-relativan zadani put.

### N4 — Nedosljedan zadani `dopustiPrivatneMreze` između 3 integracije koje ga imaju

E-pošta: `false` (zatvoreno, u skladu s B1 popravkom iz TASK-4807). Nextcloud i GitLab:
**`true`** (otvoreno prema privatnim mrežama po zadanome, bez i jedne postavke). Nextcloud i
GitLab "Probaj konekciju" prolaze kroz isti `ProbeGuard` kao e-pošta (dizajn:
`docs/DIZAJN-integracije.md`), pa je ista SSRF-klasa rizika prisutna kod oba, samo s
druknijim zadanim stanjem "otvoreno" umjesto "zatvoreno". Moguće je da je ovo namjerno
(Nextcloud/GitLab su tipično self-hosted na LAN-u, SMTP relej tipično nije), ali to nigdje
nije obrazloženo — vrijedi da to Malik/Kosjenka eksplicitno potvrde kao namjeru, ne
propust, prije javnog pusha.

### N5 — node-A i node-B rade STARU inačicu; "regresija nakon deploya" nije izvediva još

Ni `192.168.10.20` (node-A) ni `192.168.10.11` (node-B) **nemaju** ništa od TASK-4800/4807:
nema `src/core/orchestrator/`, nema `NextcloudConfig.ts`/`EmailConfig.ts`/`GitLabConfig.ts`/
`GitHubConfig.ts`/`TelegramPoller.ts`. `package.json` na oba čvora i dalje `1.3.0`
(vrijednost se poklapa s repozitorijem, ali sadržaj je stariji — verzija nije bila alat za
otkrivanje ovoga). Ovo je očekivano — TASK-4800 je izričito zabilježio da isporuka na node-A
nije u opsegu tog zadatka — ali znači da **prihvatni kriterij 4 ("regresija na node-A/B
nakon deploya") formalno nije izvediv dok deploy ne postoji**. Umjesto toga izvedena je
osnovna (pred-deploy) regresija na ŽIVIM instalacijama, da se ima poredbena točka nakon što
deploy stigne:

| Čvor | `bun test` | `/health` | `/api/tasks` | napomena |
|---|---|---|---|---|
| node-A (192.168.10.20, PID 7428) | **56 pass / 0 fail** (3 datoteke) | 200 healthy | 200 | `GET /api/telegram/config` i dalje vraća polje `"botToken":""` u tijelu odgovora — **oblik prije B2 popravka** (danas prazan jer token nije postavljen, ali čim se postavi, curi kroz API dok se ne deploya popravak) |
| node-B (192.168.10.11:2222, PID 623728) | **32 pass / 0 fail** (1 datoteka) | 200 healthy, `clients:2` (aktivni korisnici — servis NIJE restartan da ih se ne prekine) | 200 | isti stariji oblik odgovora |

Servisi na oba čvora nisu restartani niti ponovno deployani — nema novog koda za restartati
(restart bi samo digao isti stari proces), a node-B ima 2 aktivna WebSocket klijenta.
Restart tek ima smisla kao dio stvarnog deploy koraka, koji izlazi iz opsega ovog QA
zadatka (potvrđeno i u ROADMAP §6: "isporuka na node-A je zaseban korak").

## 3. Regresija — postojeće (bun test, glavni repozitorij)

```
=== VERIFIKACIJA ===
naredba: bun test   (u /home/klaudio/app/TaskManager/TaskManagerAI, commit f040734)
izlaz:
 185 pass
 0 fail
 438 expect() calls
Ran 185 tests across 8 files. [6.35s]
=== KRAJ VERIFIKACIJE ===
```

## 4. Zaključak

Novi kod (orchestrator core, 4 integracije, Telegram poller) je **funkcionalno ispravan** i
**samostalan testni paket zeleno prolazi** (185/185). Sigurnosni popravci B1–B4 iz TASK-4807
su **potvrđeni live** (email SSRF zatvoren, telegram token više ne curi kroz novi kod,
`ingest-gate.json` izvan gita). Ono što **ne prolazi** je sama srž "samostalnosti" iz
naslova epika: N1 pokazuje da korisnik s vlastitim timom agenata NE MOŽE koristiti paket
prema uputama — to je jezgra ROADMAP_SAMOSTALNOST.md cilja, pa se tretira kao blokirajući
nalaz, ne kozmetički detalj.

**Deploy na node-A/node-B nije napravljen** (izvan opsega ovog QA zadatka) — kada se izvede,
regresijske brojke iz odjeljka 2/N5 (56 i 32 testa, stari API oblici) služe kao "prije"
poredbena točka.
