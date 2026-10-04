# TaskManagerAI

A task manager built for working with AI agents: SQLite database, web board and REST API on a
single port. It is written for the case where tasks are not opened and closed by a person alone
but also by programs — agents pick tasks up, change their state and leave notes, while a person
watches it happen on the board.

*Croatian version: [README.hr.md](./README.hr.md)*

It began as a fork of [Tasks.md](https://github.com/BaldissaraMatheus/Tasks.md) by Matheus
Baldissara — that is where the idea comes from: a board whose tasks are plain files you edit
however you like. Over time it moved from files to SQL, because programs, not just people, had
started opening and closing tasks.

---

## What you get

| | |
|---|---|
| **Board** | Kanban view by state, priority, assignee and project |
| **REST API** | create, edit, search and close tasks |
| **SQLite + WAL** | the board reads while agents write, without locking |
| **Automatic execution** | a priority-1 task is queued by a trigger on its own |
| **Projects** | tasks are grouped; each project has its own specification |
| **Manual brake** | pause globally or per task, without losing state |
| **Live console** | work streams over a WebSocket, no page refresh |
| **Knowledge graph** | notes and the links between them, optionally with semantic search |
| **Interface languages** | English and Croatian; further languages are one JSON file away |
| **Decision gate** | tasks tagged `needs-decision` wait for a person — or for a model you choose |
| **Closing gates** | a task is closed on evidence: completion guard, structured step output (`REGOC-IZLAZ`), a critic that runs its own checks — all start in shadow mode |
| **Parsed results** | the agent's report is parsed on the server: verdict badge, collapsible sections, "show raw" — never rendered as HTML |
| **Energy estimate** | electricity, CO₂ and water next to project cost, always shown as an estimate with a range; coefficients are configuration |
| **Two RAG backends** | ChromaDB, pgvector or both (for migration), managed from the Config page; `pg` is optional |
| **Workflows** | work for several roles follows a workflow from the catalogue (11 workflows), chosen without a model, starting in shadow mode |
| **Config page** | five groups of settings; the card layout is edited with a single button (✎ Edit ↔ 💾 Save) |

Everything runs without a single external service. RAG (semantic search) is an optional extra.

---

## Features

One sentence per feature, with the document that explains it in full.

**Running agents**

- **Manual brake — global and per task.** `POST /api/pause` stops the system from taking on new work, and `POST /api/tasks/<ID>/pause` / `resume` holds a single task without changing its state, so it continues exactly where it stopped — [docs/API.md](docs/API.md) (“Pauza”, “Globalna kočnica”), [docs/SUSTAV.md](docs/SUSTAV.md).
- **Concurrent-agent ceiling.** How many agents may work at once (1–10, default 3) is a setting on the Config page or `PUT /api/config/concurrency`; it applies within 5 s, without a restart, and every change is kept in `settings_history` — [docs/API.md](docs/API.md) (“Usporedni agenti”).
- **Instruction to a running agent.** `POST /api/tasks/<ID>/uputa` (or 📨 on the card) delivers a message into the session that is already working, through a hook, so the agent neither stops nor loses context — [docs/UPUTE-AGENTU.md](docs/UPUTE-AGENTU.md).
- **Autonomy gate.** The session (70/85/95 %) and weekly (90 %) usage thresholds at which autonomy slows down or stops are a setting with sliders on the Config page or `PUT /api/config/autonomy`; they apply live, with history in `settings_history` — [docs/API.md](docs/API.md) (“Vrata autonomije”).
- **Decision gate.** A task tagged `needs-decision` waits for a person, or for a model you choose behind a deterministic risk filter. The “Awaiting decision” bar splits them into three groups (decided by the model · waiting for a machine trigger · waiting for you) using the same filter the decider uses — [docs/ODLUCIVANJE.md](docs/ODLUCIVANJE.md).
- **Workflows.** A task for several roles follows a workflow from `agents/workflows.json` (11 workflows, including `dorada-isporuke` and `izrada-dokumenta`); the choice is deterministic, a step of a chain never gets a workflow of its own, and the `workflow-gate` switch has three levels and starts in shadow mode — [docs/AGENTI.md](docs/AGENTI.md) (“Tijekovi rada”), [docs/CONFIG.md](docs/CONFIG.md) §3.
- **Input gate.** `POST /api/ingest` scores every message by weight and, using thresholds 16/36/81, decides whether it opens a task, goes into a full chain or needs the plan confirmed; `off`/`shadow`/`on` per source — [docs/API.md](docs/API.md) (“Ulaz”), [docs/CONFIG.md](docs/CONFIG.md) §5.
- **Closing through the orchestrator.** `TaskCloser`, `SpawnFinalizer` and the `spawnCloseGuard` switch (off by default) keep an agent from closing its own task while its run still holds the lease; a person on the board can always override — [docs/INSTALL.md](docs/INSTALL.md) §5.2, [docs/API.md](docs/API.md).
- **Echo guard and inbox.** `DispatchGuard` keeps scheduler notices and agent life-cycle messages from becoming new tasks, and a task left without a project lands in the inbox project instead of `NULL` — [CHANGELOG.md](CHANGELOG.md), [docs/SUSTAV.md](docs/SUSTAV.md).

**Closing on evidence**

- **Independent critic (`CriticGate`).** Before a task is closed, a critic runs its own checks over what the agent left on disk (L0/L1 for documents); every verdict lands in `critic_gate.jsonl` and `GET /api/critic/unverified` lists what could not be checked — [docs/API.md](docs/API.md) (“Kritičar”), [docs/INSTALL.md](docs/INSTALL.md) §5.2.
- **Completion guard and structured step output.** `completed` without proof of execution is caught, and the `REGOC-IZLAZ` block gives each report a closed vocabulary of evidence; both start in shadow mode — [docs/INSTALL.md](docs/INSTALL.md) §5.2.
- **Parsed results.** The agent's report is parsed on the server into a verdict badge and sections (`resultParsed`) and drawn with `textContent`, never as HTML — [docs/API.md](docs/API.md).
- **Allowed state transitions.** `pending→completed` is refused with 409, and a closed or cancelled task can be reopened to `pending` — [docs/API.md](docs/API.md).

**Knowledge, cost and models**

- **RAG with two backends.** ChromaDB, pgvector or both (`dual`, for migration), switched and migrated collection by collection from **Config → RAG Backend**; `pg` is an optional dependency and the password never leaves through the API — [docs/INSTALL.md](docs/INSTALL.md) §5.3, [docs/API.md](docs/API.md).
- **Energy estimate.** Electricity, CO₂ and water next to project cost, always as an estimate with a range; coefficients live in `config/energija.json` — [docs/INSTALL.md](docs/INSTALL.md) §5.2, [docs/DATABASE.md](docs/DATABASE.md).
- **Model configuration.** `models/model-config.json` is written atomically with an audit trail, and the long-context `[1m]` label is accepted — [docs/API.md](docs/API.md) (“Modeli i davatelji”).
- **Console.** Live event stream over a WebSocket and, optionally, running a command — [docs/TOOLS.md](docs/TOOLS.md).
- **Config page and layout editor.** Five groups (ceiling and autonomy gate, agents and models, integrations, RAG, system); cards are moved within their group and resized with one button, ✎ Edit layout ↔ 💾 Save layout, while setting values stay locked — [docs/CONFIG.md](docs/CONFIG.md), [docs/API.md](docs/API.md) (“Raspored Config stranice”).
- **Board on a phone.** `GET /api/tasks?view=board` sends only the card fields and server-side counts, responses are compressed, and the live connection recovers on its own — [docs/API.md](docs/API.md) (“Prikaz ploče”).
- **A clean install, checked.** init → server → board 200 → `POST`/`GET` task → priority-1 trigger, recorded in [docs/QA_SVJEZA_INSTALACIJA_2026-10-02.md](docs/QA_SVJEZA_INSTALACIJA_2026-10-02.md).
- **How a full agent system is built around it.** Agents, knowledge, input channel and supervision, layer by layer — [docs/SUSTAV.md](docs/SUSTAV.md), [docs/AGENTI.md](docs/AGENTI.md), [docs/INTEGRACIJE.md](docs/INTEGRACIJE.md), [REGOC/README.en.md](REGOC/README.en.md).

---

## Quick start

You need [Bun](https://bun.sh) 1.1 or newer. Nothing else.

```bash
git clone https://github.com/goran-mahovlic/TaskManagerAI.git
cd TaskManagerAI

bun install          # dependencies
bun run init         # creates the database from db/schema.sql
bun run start        # starts the board and the API
```

Open `http://localhost:17781`. The board has seven tabs:

| Tab | What is on it |
|---|---|
| **Tasks** | the kanban board — by state, priority, assignee, project |
| **Projects** | project list, each with its own specification |
| **RAG** | search over the knowledge base, if it is turned on |
| **Console** | live stream of events, a place to message an agent, and (optional) run a command |
| **Spending** | cost per task and project, weekly review, value of requests vs. cost |
| **Status** | service health, token usage, the execution queue, the manual pause |
| **Config** | five groups: concurrent-agent ceiling and autonomy gate, agents and models, integrations and the input gate, RAG, system; the card layout is edited with ✎ Edit layout ([docs/CONFIG.md](docs/CONFIG.md)) |

Your first task through the API:

```bash
curl -X POST http://localhost:17781/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"title":"First task","priority":2,"assignee":"user","createdBy":"user"}'
```

---

## Settings

Everything is optional; with no settings at all it runs on defaults. Copy `env.example` to
`.env` and change what you need.

| Variable | Default | What it does |
|---|---|---|
| `TM_PORT` | `17781` | server port |
| `TM_HOME` | `$HOME/.taskmanager` | folder holding the database and working files |
| `TM_DB` | `$TM_HOME/data/tasks.db` | path to the database, if you keep it elsewhere |
| `TM_AGENTS` | — | comma-separated names allowed as assignees |
| `TM_AGENTS_CONFIG` | `config/agents.json` | agent registry; its `id`s are valid assignees too |
| `TM_EXTERNAL_HOST` | `localhost` | host name shown in the interface |
| `TM_LANG` | `hr` | default interface language (`en`, `hr`, or any file in `locales/`) |
| `TM_CHROMA_HOST`, `TM_OLLAMA_URL` | — | enable RAG; without them it is off |
| `TM_PGVECTOR_HOST`, `_PORT`, `_DATABASE`, `_USER` | — | pgvector backend (all four, or `config/rag-backend.json`) |
| `TM_PGVECTOR_PASSWORD` | — | pgvector password — only here or in the secrets file, never in JSON |
| `TM_BOARD_URL` | — | board link in reports; without it the link line is left out |
| `TM_FEATURES_FILE`, `TM_CRITIC_CONFIG`, `TM_ENERGIJA_CONFIG` | `config/*.json` | switches, critic and energy coefficients (see INSTALL.md §5.2) |

**Your own team** is set like this — `user` and `scheduler` are always added automatically:

```bash
TM_AGENTS=ana,ivan,marko bun run start
```

The `id`s from `config/agents.json` (the orchestrator registry) count as well: the two sources
are merged, so you never write the same team twice. With neither of them set the list is not
closed — any well-formed name passes (`[a-z][a-z0-9_-]{0,31}`). There is no built-in list of
names.

---

## Interface language

The board ships with English and Croatian. Pick one from the selector in the header; the choice
is remembered in the browser. To set what everyone sees before they choose anything, use
`TM_LANG` or `config/jezik.json`.

Adding a language needs no code. Copy an existing file in `locales/`, translate the values —
never the keys — and the language appears in the selector on the next restart:

```bash
cp locales/en.json locales/de.json
$EDITOR locales/de.json          # translate the values only
TM_LANG=de bun run start
```

A key with no translation falls back to English, so a partial translation is still usable.
Task titles, descriptions and notes are **never** translated: they are your data, not interface.

---

## Deciding what may start

A task tagged `needs-decision` is left alone by every automation until a person releases it.
The board collects those in a bar above the columns, with a field for the decision and a
**Continue** button; what you write stays with the task.

You can also hand that judgement to a model — any provider configured in
`models/model-config.json`, from a local Ollama model to OpenRouter or Anthropic. A
deterministic filter runs first and sends anything touching money, deletion, secrets, external
effects or a vague description straight back to you; the model only sees the rest and cannot
overrule the filter.

That split is deliberate. Measured on a small local model, judging risk on its own it answered
"go" to 6 of 7 risky tasks — convincingly worded every time. With the filter: 7 of 7 correct.

Details, providers and settings: [docs/ODLUCIVANJE.md](docs/ODLUCIVANJE.md).

---

## Documentation

| Document | About |
|---|---|
| [docs/INSTALL.md](docs/INSTALL.md) | step-by-step install, service, backups, upgrades |
| [docs/DATABASE.md](docs/DATABASE.md) | tables, triggers, how the database is created and changed |
| [docs/API.md](docs/API.md) | every API endpoint with examples |
| [docs/TOOLS.md](docs/TOOLS.md) | scripts, console, periodic jobs |
| [CHANGELOG.md](CHANGELOG.md) | what changed and why, newest first |
| [docs/JEZICI.md](docs/JEZICI.md) | interface languages: choosing one, adding one |
| [docs/ODLUCIVANJE.md](docs/ODLUCIVANJE.md) | tasks that wait for a decision; letting a model decide, and the risk filter |
| [docs/UPUTE-AGENTU.md](docs/UPUTE-AGENTU.md) | sending an instruction to an agent that is already working (API, hook, fail-open) |
| [docs/SUSTAV.md](docs/SUSTAV.md) | growing the board into a self-running system, layer by layer: agents, RAG, skills, input, brakes |
| [docs/AGENTI.md](docs/AGENTI.md) | agent registry, skills and tools — what the package carries and what it fetches |
| [docs/INTEGRACIJE.md](docs/INTEGRACIJE.md) | Nextcloud, e-mail, GitLab and GitHub integrations |
| [docs/CONFIG.md](docs/CONFIG.md) | the Config page: groups and cards, the layout editor, switches (workflow-gate, ingest-gate…), workflows, input gate, completion report (Croatian) |
| [docs/POGON_I_PAKET.md](docs/POGON_I_PAKET.md) | which features of the source system made it into the package and which did not — with a command to check each one (Croatian) |
| [docs/adr/](docs/adr/) | architecture decisions of the package |
| [CONTRIBUTING.md](CONTRIBUTING.md) | git hooks, commit rules, running the tests |
| [REGOC/README.en.md](REGOC/README.en.md) | what a real agent system built around this looks like — split into topics (architecture, roles, task life cycle, delivery rules, gates and brakes, databases, cost and energy, lessons, build your own) |

The `REGOC` folder describes the system TaskManagerAI was extracted from: a team of agents with
their own roles and models, a daemon running in the background, sessions that survive an
interruption, autonomy brakes, message routing, voice and local models. It is not needed to run
TaskManager; it shows how far this tool can be taken and what was learned along the way. REGOČ
itself rests on [PAI — Personal AI Infrastructure](https://github.com/danielmiessler/PAI).

---

## Contributing

After cloning, point git at the versioned hooks — `.git/hooks` does not travel with a clone:

```bash
git config core.hooksPath .githooks
```

`.githooks/commit-msg` then refuses any commit whose message carries a `Co-Authored-By: … Claude`
trailer or `noreply@anthropic.com`, and — once you list the allowed identities with
`git config taskmanagerai.dopusteniAutori "you@example.com"` — any commit whose author or
committer is not on that list. Details, and how to run the tests, in
[CONTRIBUTING.md](CONTRIBUTING.md).

---

## Credit and origin

The task manager starts from **[Tasks.md](https://github.com/BaldissaraMatheus/Tasks.md)** (by
[Matheus Baldissara](https://github.com/BaldissaraMatheus), MIT). That is where the basic idea
comes from: a task board you can keep to yourself, with no account and no cloud service.

The system that grew around it starts from
**[PAI — Personal AI Infrastructure](https://github.com/danielmiessler/PAI)** (by
[Daniel Miessler](https://github.com/danielmiessler), MIT) — that is where the skills, hooks,
context loading at startup and the idea of an assistant as infrastructure you host yourself,
rather than a service you log into, come from. It is described in [REGOC/README.md](REGOC/README.md).

Once agents, and not only people, began opening tasks, files no longer sufficed: concurrent
writes without collisions, an execution queue, a history of every change, and a query returning
every task of one assignee. Storage moved to SQLite, and most of the code moved with it. The
idea stayed the same.

## Licence

MIT, the same as the original project. Copyright is held by both Matheus Baldissara (Tasks.md,
2023) and Goran Mahovlić (TaskManagerAI, 2026). Full text in [LICENSE](LICENSE).

## Agents and skills

The package deliberately **ships no skills or tools** — those live in
[PAI](https://github.com/danielmiessler/PAI) and other repositories that maintain them. What is
here is only the list of who the agents are and what they need:

```bash
bash scripts/install-agents.sh --vjestine   # default team + fetch skills from PAI
```

Default team: REGOČ, Kosjenka, Jelena, Malik, Manda, Dora, Gita, Grga, Potjeh (`docs/AGENTI.md`).

## Beyond the board

`docs/SUSTAV.md` describes how this package grows into a system where tasks get done on their
own: the agents and their registry, knowledge (RAG) and how it is protected, installing extra
skills, input channels, and the brakes and completion gate — in order, with what may be skipped
and why.
