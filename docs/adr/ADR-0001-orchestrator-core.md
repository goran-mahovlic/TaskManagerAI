# ADR-0001 — Orchestrator core: što se iz `RegocDaemon.ts` seli u paket, a što ostaje instalaciji

| | |
|---|---|
| **Stanje** | Predloženo — čeka Goranovu potvrdu odluke O0 (v. §7) |
| **Datum** | 10.09.2026. |
| **Autorica** | Kosjenka (Architect) |
| **Zadatak** | TASK-4799 (PRJ-048), prema `docs/ROADMAP_SAMOSTALNOST.md` §1 i §6.1 |
| **Zamjenjuje** | prvi prolaz grepom u `ROADMAP_SAMOSTALNOST.md` §1 |
| **Prati** | `docs/DIZAJN-integracije.md`, `docs/DIZAJN-telegram-poller.md` |

---

## 1. Kontekst i način rada

Cilj koji je Goran postavio: *korisnik skine paket s GitHuba, upiše SVOJE podatke za
RAG / Telegram / Nextcloud / GitLab i radi jednako kako mi radimo — bez ijedne naše
vrijednosti u kodu.*

Paket danas ima „ploču i bazu" (`TaskWebUI` + vratari). Sloj koji sam pokreće agente
na zadatku živi isključivo u `~/.claude/regoc/RegocDaemon.ts` (7 340 redaka) i **nije**
dio paketa.

Ova je revizija napravljena čitanjem cijele datoteke, redak po redak (7 340/7 340), a ne
grepom. Grep je poslije korišten samo za brojanje već pronađenoga. Sve tvrdnje u ovom
dokumentu imaju broj retka ili izmjerenu brojku.

---

## 2. Nalaz koji mijenja redoslijed poslova: paket VEĆ nosi naše vrijednosti

Prije nego išta seli, valja reći ono što je revizija našla **u samom paketu**, na commitu
`f37d7b5`. Mjereno skenerom iz §8 nad **107 datoteka koje git prati** (dakle nad onim što
korisnik doista skine — bez `node_modules`, `__pycache__` i radnih datoteka):

| Nalaz | Mjera | Gdje (primjeri) |
|---|---|---|
| Naš raspored mapa `~/.claude/regoc` | **148 pojava / 47 datoteka** | `src/TelegramConfig.ts:23`, `src/DezurniConfig.ts:20/51/53`, `src/core/StepSchema.ts:422`, `src/SessionUsage.ts:17`, 17 alata u `tools/*.py` |
| Naš `HOME` kao zadana vrijednost | **73 pojave / 25 datoteka** | doslovni izraz `process.env.HOME \|\| '/home/klaudio'` |
| Naši IP-ovi | **24 pojave / 10 datoteka** | `src/RAGService.ts:52` (`chromaHost: '192.168.10.200'`), `:54` (`ollamaHost: 'http://192.168.10.4:11434'`), `src/DezurniConfig.ts:40`, `src/TaskWebUI.ts` (9×), 5 alata u `tools/` |
| Naš Telegram chat id | **11 pojava / 3 datoteke** | `src/core/IngestConfig.ts` (primjeri), `src/core/ReportBackTask.ts:18`, `tests/ingest.test.ts` (fixture) |
| Goranov osobni git identitet **kao konstanta u kodu** | 1 pojava | `src/core/WorkflowTemplate.ts:58` — `GIT_IDENTITY = { name: 'Goran Mahovlic', email: 'goran.mahovlic@gmail.com' }` |
| Naš interni alat u javnom indeksu | 2 datoteke | `scripts/uskladi_s_regocem.sh` i `scripts/zakrpe/u6-ingest.patch` **jesu** praćeni gitom — potvrđuje nalaz `ROADMAP` §5 |

Napomena o e-pošti: pojava u `README*.md`, `CONTRIBUTING.md` i `.githooks/commit-msg` je
**autorstvo** i tako i treba ostati. Sporna je samo ona u `src/` — ondje to nije potpis nego
identitet kojim se potpisuje **tuđi** rad.

Paket pritom **već ima ispravan obrazac** — `src/core/paths.ts` (`TM_HOME` → `TM_ROOT` /
`TM_DB` / `TM_DATA`) i `src/core/IngestConfig.ts` (`$TM_INGEST_GATE_CONFIG` →
`$TM_HOME/config/…` → `config/…` uz paket). Obrazac postoji i dokazan je; poštuju ga dva
modula, dok ostalih 25 gađa naš `$HOME`.

**Posljedica za ovaj ADR:** seljenje orkestratora u paket koji već curi naše vrijednosti
samo umnaža kvar. Zato odluka O1 (§4) ide **prije** O2, a brana iz §8 je uvjet, ne ukras.

---

## 3. Revizija `RegocDaemon.ts` — tri kategorije

### 3.1 S — strojno-specifično: NAŠE VRIJEDNOSTI U KODU (ne smiju u paket ni u kojem obliku)

| # | Redak(ci) | Što |
|---|---|---|
| S1 | 178 | `const HOME = process.env.HOME \|\| '/home/klaudio'` — naša rezerva |
| S2 | 341, 3114, 6011 | `USER: process.env.USER \|\| 'klaudio'` (3 mjesta, spawn okolina) |
| S3 | 593 | `REGOC_GROUP_FALLBACK = -5161938429` — naša Telegram grupa kao odredište svake dojave bez `chat_id` |
| S4 | 1641–1656 | `detectProjectId()` — tablica od 9 **naših** projekata (`FAST-TRACK-SIM`, `REGOC_EMC`, `CUBES_2026`, `MINIMAX`, `GATEMATE_ETH`, `ULX5M`, `EMC_WEBAPP`, `REGOC_SYSTEM`, `INTERGALAKTIK`) |
| S5 | 1744 | `GEMINI_PATH = $HOME/app/regoc_system/GEMINI.md` — naš privatni repozitorij pravila |
| S6 | 1745 | `AGENT_REGISTRY_PATH = $HOME/.claude/regoc/REGOC_AGENTS.json` |
| S7 | 1908–2089 | `classifyAndRoute()` — 9 grana hrvatskih ključnih riječi → **naši** `agentId`-evi (`kosjenka`, `jelena`, `malik`, `potjeh`, `emard`, `dora`, `manda`, `gita`, `grga`), catch-all `manda` |
| S8 | 2103–2147 | `generateSystemResponse()` — „23 pravila", `GEMINI.md`, naš popis agenata |
| S9 | 2175–2181 | `REGOC_BOILERPLATE_HEADINGS` — 19 naslova naših vlastitih odsjeka u opisu zadatka |
| S10 | 2294–2296 | prefiksi `required_knowledge`: `skills/`→`~/.claude`, `regoc_system/`→`~/app`, `HDL-GuideLines/`→`~/fpga-AI-projects/ulx3s` |
| S11 | 2464 | izuzeci po imenu: `agentId === 'potjeh' \|\| agentId === 'gita'` |
| S12 | 2466 | prompt upućuje na `~/.claude/regoc/tools/consult-potjeh.ts` |
| S13 | **2492 i 2535** | **dva mjesta gdje se u SVAKI prompt upisuje: „Infra: Ollama 192.168.10.4, ChromaDB/RAG 192.168.10.200" + popis naših 11 agenata s ulogama.** 2492 = laki prompt (ne-Anthropic), 2535 = puni prompt (Anthropic). Ovo je najskuplja pojava: nije samo u kodu, nego ide u svaki poziv modela — svaki tuđi stroj bi „vidio" naše IP-ove u vlastitom sistemskom kontekstu |
| S14 | 2565 | `resolveOllamaBaseUrl()` — `let baseUrl = 'http://192.168.10.4:11434'` kao zadano prije čitanja konfiguracije |
| S15 | 3983–3985 | `TEAM_ORDER` — prirodni redoslijed naših 8 agenata |
| S16 | **4062–4063** | `git config user.email goran.mahovlic@gmail.com` / `user.name 'Goran Mahovlic'` — svaki automatski otvoren projektni repozitorij potpisan Goranovim osobnim identitetom |
| S17 | 4098 | `NOT_A_PROJECT` — hrvatski stop-popis („projekt", „nešto", „hitno"…) |
| S18 | 4196–4205 | `TEAM_ROLE_BRIEF` — opis posla za naših 8 agenata |
| S19 | 450, 478 | izuzeti iz „full" perzistentnog načina: `regoc`, `klaudio`, `stribor`, `emard` |
| S20 | 2003–2016 | grana FPGA → `emard`, `ragHints: ['agent_emard']` |
| S21 | 6157 | SQL: `WHERE from_agent IN ('user','goran')` |
| S22 | 6404 | `applyDecision(…, 'goran (ploča)', …)` |
| S23 | 7085–7094 | startni ispis: popis naših agenata i njihovih zaduženja |
| S24 | 1210, 1226–1228 | `klaudio`/`stribor` tvrdo upisani kao „komunikacijski agenti" |

### 3.2 L — pretpostavke o stroju i rasporedu (smiju u paket, ali SAMO kroz konfiguraciju)

| # | Redak(ci) | Što | Napomena |
|---|---|---|---|
| L1 | 179–213 | 20 konstanti pod `~/.claude/regoc`, `~/.tmp`, `~/.claude/skills`, `~/.claude/projects`, `~/.claude/MEMORY`, `~/.claude/tools/Telegram` | nijedna nema env-rezervu osim L2 |
| L2 | 208 vs 209 | `TASK_MANAGER_API` **ima** override `REGOC_TASK_MANAGER_API`; `PROJECTS_API_BASE` (isti poslužitelj!) **nema** | dvije istine o istoj adresi — na drugom portu projekti se tiho ne otvaraju |
| L3 | 2355, 2358, 2361, 2364, 2396 | 5 `curl` primjera u promptu agenta tvrdo pišu `http://localhost:17781` | dok redak 2371 (`projectProtocolInstruction(TASK_MANAGER_API)`) poštuje varijablu → **na nestandardnom portu agent dobiva upute koje ne rade** |
| L4 | 2425–2428 | prompt upućuje na `~/.claude/regoc/StaleCodeCheck.ts` i `regoc-services.sh` | naša alatna oprema kao obveza za agenta |
| L5 | 2582, 2596, 2798, 6924 | izravno otvaranje `regoc.db` preko `new Database(TASKS_DB_PATH)` | **zaobilazi vlastiti REST API** — core u paketu to ne smije nasljediti |
| L6 | 3106, 3091, 3095 | pretpostavka postojanja `claude`, `kimi`, `gemini` CLI-ja | |
| L7 | 5929 | `/usr/bin/python3` — apsolutna putanja tumača | pada na svakom sustavu bez tog rasporeda |
| L8 | 4863–4878 | `/proc/<pid>/stat` — **Linux-only** liveness | macOS/BSD nemaju `/proc` |
| L9 | 5750–5759 | `readdirSync('/proc')` — **Linux-only** dokaz živog procesa | isto |
| L10 | 1093–1097 | spawn `~/.claude/tools/Telegram/telegram_agent.ts` (Klaudio watchdog) | |
| L11 | 3112, 6009 | `PATH` s `~/.local/node/bin`, `~/.local/bin` | |
| L12 | 3120 | `CLAUDE_CODE_TMPDIR` | Claude Code specifično |
| L13 | 213 | `VOICE_SERVER = 'http://localhost:8888/notify'` | v. D1 |

### 3.3 D — nalaz revizije: mrtav i nedostupan kod (ne seli se; briše se ili oživljava, ali ne u paketu)

| # | Redak(ci) | Nalaz |
|---|---|---|
| D1 | 213 | `VOICE_SERVER` je **deklariran i nijednom pročitan** — glas ide kroz `requestVoice()` iz `../VoiceServer/voice-client`. Mrtva konstanta |
| D2 | 1168–1248 | `checkStalePendingMessages()` (81 redak) — jedini poziv **zakomentiran** 7255–7257 (odluka korisnika 26.01.). Mrtav kod |
| D3 | 191, 1562–1581, 4447–4470 | `INFERENCE_TOOL`, `queryRAG()`, `processWithAI()` dostupni su samo kroz `default:` granu switcha (4790). Ta se grana odnosi na `decision.type === 'self_respond'`, a `self_respond` postoji **samo u deklaraciji tipa (1792)** — nijedan `return` u `classifyAndRoute()` ga ne proizvodi. **Grana je nedostupna**; s njom i `RAG_TOOL` (1562) |

### 3.4 G — generičko: jezgra orkestracije

Ovo je ono što doista radi posao i ne zna ništa o nama:

* **Petlja poruka** — `getPendingMessages` / `claimMessage` / `completeMessage` (1484–1521),
  `processMessage` (4553–4822) bez grana iz S.
* **Red spawnova** — `MAX_AGENT_CONCURRENT` (`AgentConcurrency`, već iz okoline),
  `activeAgentSpawns`, `agentFailureTracker` + `jitteredBackoff`, `SpawnBreaker` (cross-process,
  SQLite/WAL), `TokenBucket`.
* **Vratari** — `CompletionGuard`, `CriticGate` + `CriticRepairLoop`, `VerificationGate`,
  `DispatchGuard`, `FileScopeGate`, `MergeGate`, `ReviewCheckpoint`, `StepSchema`,
  `AdversarialVerify`, `ResearchRagGate`, `HookBlockGuard`.
* **Čistači** — `StaleWatchdog`, `ZombieRecovery`, `StaleReaper`, `DeadAgentReaper`
  (svi po istom obrascu: `flag` → `shadow` → `live` + JSONL + alarm).
* **Autonomija** — `AutonomyQueue`, `WorkStateJournal.autonomyTierFromUsage`, `QuotaWakeup`,
  `UsageMeter`, `PauseControl`.
* **Telemetrija i forenzika** — `SpawnTelemetry`, `SpawnExitDiagnostics`, `LogPaths`.
* **Životni ciklus** — `ShutdownResume`, `FailRequeue`, `EarlyWorkGuard`, `StaleCodeCheck`.

**Mjera pripremljenosti (izmjereno):** `RegocDaemon.ts` uvozi **61 različit lokalni modul**
(52 statički + 12 dinamički, 3 preklapanja). Od njih je **12 već u paketu**
(`QuotaWakeup`, `DispatchGuard`, `CompletionGuard`, `CriticGate`, `ModeClassifier`,
`FeatureFlags`, `PauseControl`, `AutonomyQueue`, `TaskDecomposer`, `StepSchema`,
`ResearchRagGate`, `TaskManagerSQL`), a **49 nije**. Posao nije „prepiši 7 340 redaka" nego
„prenesi 49 modula i napiši ~600 redaka ljepila koje ih veže, bez ijedne grane iz §3.1".

---

## 4. Odluka

### O0 — `RegocDaemon.ts` se NE prenosi kao datoteka

Ni cijeli, ni „očišćen". Datoteka je 7 340 redaka u kojima su S, L, G i D isprepleteni po
istim funkcijama (npr. `buildAgentPrompt` sadrži i S9, S10, S11, S12, S13, L3 i G u jednom
tijelu). Prenosi se **jezgra kao novi modul**, a naše se grane ostavljaju u živoj instalaciji.

### O1 — PRVO brana protiv naših vrijednosti, tek onda seljenje

Prije prvog retka orkestratora u paketu:

1. `src/core/paths.ts` postaje **jedini** izvor korijena (`TM_ROOT`); 64 pojave
   `process.env.HOME || '/home/klaudio'` u 22 datoteke zamjenjuju se njime.
2. `src/RAGService.ts` gubi naše IP-ove kao zadane (`chromaHost`/`ollamaHost` → `null` uz
   `TM_CHROMA_HOST` / `TM_OLLAMA_URL`, koje `env.example` već opisuje).
3. `src/core/WorkflowTemplate.ts:58` — `GIT_IDENTITY` postaje konfiguracija
   (`orchestrator.json → git.identity`), bez zadane vrijednosti; bez nje se `git config`
   jednostavno ne postavlja i nasljeđuje se korisnikov globalni.
4. `src/TelegramConfig.ts` i `src/DezurniConfig.ts` prelaze s `~/.claude/regoc/config/…`
   na obrazac iz `IngestConfig.ts` (env → `$TM_HOME/config/…` → `config/…` uz paket).
5. Brana `tests/bez-nasih-vrijednosti.test.ts` (§8) postaje dio `bun test`.

**Ovo je uvjet, ne preporuka.** Bez brane se cilj („bez ijedne naše vrijednosti") ne može
ni izmjeriti, a nemjereno se vraća.

### O2 — jezgra: `src/core/orchestrator/`

```
src/core/orchestrator/
  Orchestrator.ts        # petlja: poruke → odluka → spawn → ishod; sve nuspojave kroz portove
  SpawnQueue.ts          # red, strop, backoff, osigurač, token bucket
  Watchdogs.ts           # liveness, zombie, stale, dead-agent (flag→shadow→live, JSONL)
  Ports.ts               # SUČELJA koja jezgra traži od domaćina (§6)
  AgentRegistry.ts       # čitanje registra agenata iz konfiguracije (PRAZAN predložak)
  PromptBuilder.ts       # sastavljanje prompta iz PREDLOŽAKA, bez ijedne naše rečenice
```

Jezgra **ne uvozi ništa** iz `~/.claude`. Sve što joj treba izvana dolazi kroz `Ports.ts`.

### O3 — što ostaje isključivo u živoj instalaciji

`~/.claude/regoc/RegocDaemon.ts` postaje **tanak domaćin (adapter)**: uvozi jezgru iz paketa
i predaje joj naše implementacije portova — naš registar agenata, naše rutiranje po ključnim
riječima (S7), naš `detectProjectId` (S4), Klaudio watchdog (L10), `GEMINI.md` (S5),
`consult-potjeh` (S12), Mumble/glas. Ništa od toga ne ide u javni repozitorij.

### O4 — `claude --print` NIJE pretpostavka jezgre, nego jedan izvođač

Jezgra zna samo za `Executor` port (§6). Paket isporučuje **dvije** izvedbe:

* `CliExecutor` — bilo koji CLI opisan konfiguracijom (`command`, `args` predložak,
  `promptChannel: 'arg' | 'stdin' | 'file'`, `systemPromptFlag`); `claude`, `kimi`, `gemini`
  su tada tri **retka konfiguracije**, ne tri `if`-a u kodu (danas: 3089–3106).
* `HttpExecutor` — OpenAI/Ollama/Anthropic-kompatibilan endpoint (`baseUrl`, `apiKeyEnv`).

`DezurniConfig.nacinPoziva()` već rješava upravo to pitanje za dežurnog i pet oblika poziva;
`Executor` je isti pojam podignut na glavni put. Instalacija bez ijednog CLI-ja radi kroz
`HttpExecutor` — što je odgovor na otvoreno pitanje iz `ROADMAP` §1.

### O5 — registar agenata: PRAZAN predložak, ne naši agenti

`REGOC_AGENTS.json` (S6) se ne prenosi. Paket dobiva `config/agents.example.json` sa
**shemom** i jednim generičkim primjerom (`assistant`), te `docs/AGENTI.md` koji objašnjava
polja. Rutiranje po ključnim riječima (S7) prelazi iz koda u **konfiguraciju**:

```jsonc
{ "id": "assistant", "keywords": ["*"], "model": "…", "rag": [] }
```

Bez ijednog agenta u konfiguraciji jezgra radi, ali ništa ne spawna i to jasno kaže u
dnevniku — što je ispravno zatečeno stanje za svježu instalaciju.

### O6 — `/proc` je izbor, ne pretpostavka

`LivenessProbe` port (§6) ima dvije izvedbe: `ProcLiveness` (Linux, današnje ponašanje,
L8/L9) i `SignalLiveness` (prijenosno: `process.kill(pid, 0)` + starost heartbeat datoteke).
Izbor je automatski po `existsSync('/proc')`, uz izričit `orchestrator.json → liveness.mode`.

---

## 5. Konfiguracija i okolina

### 5.1 Datoteka `config/orchestrator.json`

Isti obrazac kao `DezurniConfig.ts` / `IngestConfig.ts`: **JSON bez ijedne tajne**,
`load*` / `validate*Patch` / `save*` (atomski `tmp` + `rename`), bez keša, čita se pri svakoj
odluci → promjena s ploče vrijedi bez restarta.

Redoslijed traženja datoteke (identičan `IngestConfig.zadanaPutanja()`):
`$TM_ORCHESTRATOR_CONFIG` → `$TM_HOME/config/orchestrator.json` → `config/orchestrator.json` uz paket.

```jsonc
{
  "enabled": false,                       // svježa instalacija NE pokreće agente sama
  "pollIntervalMs": 1000,
  "autoExecIntervalMs": 15000,

  "api": {                                // L2/L3: JEDNA istina o adresi ploče
    "baseUrl": "http://localhost:17781",  // iz njega se izvode /api/tasks i /api/projects
    "promptBaseUrl": null                 // adresa koju vidi AGENT; null = baseUrl
  },

  "spawn": {
    "maxConcurrent": 3,
    "hardCeilingHours": 24,
    "livenessWindowHours": 2,
    "backoff": { "baseMs": 60000, "maxMs": 900000, "jitter": true }
  },

  "liveness": { "mode": "auto" },         // auto | proc | signal   (O6)

  "executors": {                          // O4 — CLI/HTTP kao PODATAK
    "default": "cli-claude",
    "cli-claude": {
      "kind": "cli", "command": "claude",
      "args": ["--print", "--output-format", "json", "--model", "{model}"],
      "promptChannel": "arg", "promptFlag": "-p",
      "systemPromptFlag": "--append-system-prompt",
      "sessionIdFlag": "--session-id"
    },
    "http-ollama": {
      "kind": "http", "baseUrl": null,    // BEZ zadane vrijednosti (usp. S14)
      "apiKeyEnv": null, "path": "/v1/chat/completions"
    }
  },

  "agents": { "registryPath": null },     // null → config/agents.json ako postoji (O5)

  "prompt": {                             // S13 — NIJEDNA naša rečenica; sve iz predloška
    "templateDir": null,                  // null → templates/prompt/ uz paket
    "systemFacts": [],                    // korisnik ovdje upisuje SVOJU infrastrukturu
    "includeTaskProtocol": true,
    "includeVerificationGate": true
  },

  "git": {                                // O1.3 — S16
    "autoInitProjectRepo": false,
    "identity": { "name": null, "email": null }   // null → ne diramo git config
  },

  "voice":   { "enabled": false, "notifyUrl": null },   // L13/D1
  "watchdog": {
    "stale":     { "mode": "shadow", "intervalMinutes": 30, "maxActionsPerRun": 5 },
    "zombie":    { "mode": "shadow", "intervalMinutes": 1,  "maxActionsPerRun": 5 },
    "deadAgent": { "mode": "shadow", "intervalMinutes": 30 }
  }
}
```

Pravilo za zadane vrijednosti, izvedeno iz S13/S14: **polje čija bi zadana vrijednost bila
adresa, ime ili identitet MORA biti `null`, nikad naša vrijednost.** `null` znači „nije
konfigurirano" i mehanizam se tada uredno ne uključuje. To je razlika između paketa koji
ne radi dok ga se ne podesi (ispravno) i paketa koji radi tako što zove naš stroj (kvar).

### 5.2 Varijable okoline

Dodaju se u `env.example`, uz postojeći `TM_*` obrazac. Okolina **nadjačava** datoteku;
tajne idu **isključivo** kroz okolinu (ili `credentials.env`), nikad u JSON.

| Varijabla | Značenje | Zadano |
|---|---|---|
| `TM_ORCHESTRATOR_CONFIG` | puna putanja do `orchestrator.json` | traži se redom iz §5.1 |
| `TM_ORCHESTRATOR_ENABLED` | `1`/`0` — nadjačava `enabled` | iz datoteke |
| `TM_API_BASE` | adresa ploče (zamjenjuje L2 nedosljednost) | `http://localhost:17781` |
| `TM_MAX_CONCURRENT` | strop usporednih spawnova | `3` |
| `TM_AGENTS_CONFIG` | putanja do registra agenata | `$TM_HOME/config/agents.json` |
| `TM_PROMPT_TEMPLATES` | mapa s predlošcima prompta | `templates/prompt/` uz paket |
| `TM_PYTHON` | tumač za Python alate (L7) | `python3` s `PATH`-a |
| `TM_ORCHESTRATOR_LOG` | dnevnik jezgre | `$TM_HOME/data/orchestrator.log` |

Naslijeđeni `REGOC_*` nazivi ostaju **samo** u živom adapteru (O3); paket ih ne poznaje.

---

## 6. Portovi — sve što jezgra traži od domaćina

Ovo je stvarna granica podjele. Sve iz §3.1 i §3.2 pretvara se u jedan od ovih portova:

```ts
export interface Board {                       // ploča (jedini put do zadataka — usp. L5)
  get(id: string): Promise<Task | null>
  list(status: string): Promise<Task[]>
  update(id: string, patch: TaskPatch): Promise<boolean>
  create(input: CreateTaskInput): Promise<{ id: string } | null>
  reclaim(id: string, reason: string, by: string): Promise<boolean>   // in_progress→pending
}

export interface MessageBus {                  // red poruka (danas: messages.db)
  pending(limit: number): Promise<Message[]>
  claim(id: string): Promise<boolean>
  complete(id: string): Promise<void>
  send(to: string, content: string, priority: number, origin?: Origin): Promise<string>
}

export interface Executor {                    // O4 — kako se model uopće pokreće
  run(req: ExecRequest): Promise<ExecResult>   // { exitCode, resultText, usage, sessionId, numTurns }
}

export interface AgentDirectory {              // O5 — tko postoji i tko što radi
  list(): AgentInfo[]
  route(text: string): { agentId: string; reason: string } | null   // ← ovdje živi naš S7
}

export interface PromptComposer {              // S9–S13 — sastav prompta iz predložaka
  build(ctx: PromptContext): string
}

export interface LivenessProbe {               // O6 — L8/L9
  alive(pid: number): boolean
  progress(pid: number): number | null         // CPU jiffies ili null gdje ih nema
}

export interface Notifier {                    // kamo ide dojava čovjeku (S3, L13)
  notify(text: string, origin?: Origin): Promise<boolean>
}

export interface Clock  { now(): number }
export interface Logger { log(line: string): void }
```

Test ove granice: **jezgra se mora moći pokrenuti u testu s in-memory izvedbama svih
portova, bez ijedne datoteke iz `~/.claude` i bez ijednog mrežnog poziva.** Ako neka
funkcija to ne dopušta, ona po definiciji pripada adapteru (O3), ne jezgri.

---

## 7. Otvoreno pitanje za Gorana (odluka O0)

Roadmap §1 traži potvrdu za `claude --print`. Revizija je pokazala da to nije pitanje o
jednom CLI-ju nego o granici jezgre, pa ga preformuliram u jedno pitanje s dva puta:

* **A — jezgra bez izvođača.** Paket isporučuje `Orchestrator` + portove, ali **nijednu**
  izvedbu `Executor`-a; korisnik piše svoju (~50 redaka) ili koristi primjer iz `docs/`.
  *Za:* paket ne pretpostavlja baš ništa. *Protiv:* svježa instalacija ne radi „iz kutije",
  što je suprotno cilju.
* **B — jezgra + dvije izvedbe (`CliExecutor`, `HttpExecutor`), obje konfiguracijom.**
  *Za:* korisnik s Ollamom radi odmah, korisnik s Claude Code CLI-jem upiše jedan redak.
  *Protiv:* paket nosi ~250 redaka koda za pozivanje tuđih alata.

**Preporuka: B.** Razlog je mjeren, ne estetski: `DezurniConfig.nacinPoziva()` već danas
pokriva pet oblika poziva bez ijednog novog retka po davatelju, dakle obrazac je dokazan u
ovom paketu. A bi značio da „radi jednako kako mi radimo" traži programiranje prije prve
uporabe, a upravo to cilj isključuje.

---

## 8. Brana (kako se odluka provodi, a ne samo zapiše)

`tests/bez-nasih-vrijednosti.test.ts` — **ratchet**, ne alarm:

**Napisano i u pogonu:** `tests/bez-nasih-vrijednosti.test.ts`, `7 pass / 0 fail`.

Skenira **samo ono što git prati** (to je definicija paketa koji korisnik skine), preskače
`docs/` (ADR mora smjeti citirati kvar koji opisuje) i samu sebe. Pet pravila, svako sa
**zapisanom osnovicom** izmjerenom 10.09.2026.:

| Pravilo | Osnovica (pojava / datoteka) |
|---|---|
| `.claude/regoc` | 148 / 47 |
| `/home/klaudio` | 73 / 25 |
| `192.168.10.*` | 24 / 10 |
| naš chat id | 11 / 3 |
| naša e-pošta / domena | 8 / 6 |

Test pada ako broj **naraste** ili ako se pojava javi u **novoj** datoteci. Svako čišćenje
spušta osnovicu u istom commitu s popravkom, dok osnovica ne padne na nulu.

Zašto zapor a ne odmah tvrda nula: nula bi značila da test pada na `main` od prvog dana, a
test koji stalno pada biva isključen — točno kvar zbog kojeg je `SecurityValidator` hook bio
mrtav kod. Zapor pada **samo** kad netko doda novo curenje, pa preživi.

**Brana je provjerena da doista puca**, a ne samo da prolazi: privremeno dodana datoteka
`src/_probni_kvar.ts` s `process.env.HOME || '/home/klaudio'` i `192.168.10.4` oborila je
dva pravila (`5 pass / 2 fail`) s porukom koja imenuje datoteku i pravilo; nakon uklanjanja
opet `7 pass / 0 fail`. Brana koja nikad nije vidjela kvar nije brana nego ukras.

---

## 9. Posljedice

**Dobro:**
* Paket dobiva sloj 1 iz `docs/SUSTAV.md`, koji danas postoji samo kao opis.
* `docs/INSTALL.md` može dobiti korak „Pokreni orkestrator" koji danas ne postoji.
* Cilj „bez ijedne naše vrijednosti" postaje **mjerljiv** (§8), a ne izjava.
* Živi `RegocDaemon.ts` se s ~7 340 smanjuje na adapter (procjena: 800–1 200 redaka naših
  grana iz §3.1), a jezgra dobiva testove kakve danas nema.

**Loše / rizici:**
* **R1 — dvije preslike jezgre.** Dok adapter ne prijeđe na paket, ista logika živi na dva
  mjesta. *Mjera:* O2 i O3 idu u istom potezu; adapter se ne piše prije nego jezgra prođe test.
* **R2 — regresija u pogonu.** Jezgra vozi 11 agenata na živom sustavu.
  *Mjera:* jezgra ulazi iza `FeatureFlags` (`orchestratorCore` → shadow → live), isti obrazac
  kao svaki mehanizam u §3.4; rollback je zastavica bez restarta.
* **R3 — `paths.ts` migracija (O1.1) dira 22 datoteke.** *Mjera:* mehanička zamjena jednog
  doslovnog izraza + `bun test` prije i poslije; brana iz §8 mjeri ishod.
* **R4 — prijenosnost izvan Linuxa nije provjerena** (L8/L9). O6 je dizajn, ne dokaz.
  *Mjera:* Potjeh, prihvatni kriterij „svježa instalacija radi od nule prema `INSTALL.md`",
  po mogućnosti na čvoru koji nije naš glavni stroj.

**Ne mijenja se:** ploča, baza, REST API, `POST /api/ingest`, postojeći vratari. Jezgra je
dodatak; s `enabled: false` (zadano) paket se ponaša točno kao danas.

---

## 10. Redoslijed izvedbe

| Korak | Nositelj | Sadržaj | Uvjet gotovosti |
|---|---|---|---|
| O1 | Jelena | `paths.ts` SSOT, IP-ovi van, `GIT_IDENTITY` u konfiguraciju, config-putanje na obrazac `IngestConfig` | brana §8 zelena, `bun test` bez novih padova |
| O2a | Jelena | `Ports.ts` + `Orchestrator.ts` + `SpawnQueue.ts` (bez watchdoga) | test s in-memory portovima, bez `~/.claude` |
| O2b | Jelena | `Watchdogs.ts`, `AgentRegistry.ts`, `PromptBuilder.ts` + `config/agents.example.json` + `templates/prompt/` | isto |
| O3 | Jelena | živi `RegocDaemon.ts` → adapter nad jezgrom, iza `orchestratorCore` shadow | `StaleCodeCheck` čist, novi PID, 24 h u sjeni bez razlike u ishodima |
| — | Malik | revizija prije javnog pusha (tajne, SSRF na „Probaj", prava 0600, `.gitignore`) | — |
| — | Potjeh | svježa instalacija od nule po `INSTALL.md`, bez ijedne naše vrijednosti | — |
| — | Grga | pregled Config stranice kad narastu kartice | — |

---

## 11. Dodatak — brojke ove revizije

| Mjera | Vrijednost |
|---|---|
| Pročitano redaka `RegocDaemon.ts` | 7 340 / 7 340 |
| Različitih lokalnih modula koje uvozi | 61 (52 statički + 12 dinamički − 3 preklapanja) |
| Od toga već u paketu | 12 |
| Od toga treba prenijeti | 49 |
| Nalaza kategorije S (naše vrijednosti) | 24 |
| Nalaza kategorije L (pretpostavke o stroju) | 13 |
| Nalaza kategorije D (mrtav/nedostupan kod) | 3 |
| Datoteka paketa koje git prati (osnovica brane) | 107 |
| `.claude/regoc` u paketu | 148 pojava / 47 datoteka |
| `/home/klaudio` u paketu | 73 pojave / 25 datoteka |
| `192.168.10.*` u paketu | 24 pojave / 10 datoteka |
| naš Telegram chat id u paketu | 11 pojava / 3 datoteke |
