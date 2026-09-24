# Architecture — the path of one message through the system

[Hrvatski](ARHITEKTURA.md) · [Back to overview](README.en.md)

This document follows a single message from the moment it arrives until the reply returns to
the same conversation. Each step has its place in the package; for each one we note where it
lives and why it exists.

---

## The flow in one picture

```
  CHANNEL              Telegram · board · POST /api/ingest · command line
    │
    ▼
  MESSAGE QUEUE        SQLite (messages.db) — the message is written before anyone reads it
    │                  merging of parts of the same message from the same sender
    ▼
  CLASSIFICATION       working mode (MINIMAL / STANDARD / COMPLEX) + weight class E1–E5
    │                  → score 1–100 → thresholds A / B / C → answer / task / chain / ask
    ▼
  TASK ON THE BOARD    the single entry point for creation: content gatekeepers, creation cap
    │                  priority 1 → a database trigger puts the task in the execution queue
    ▼
  AUTOMATIC            the orchestrator picks up a task if the gates allow: pause, quota, cap
  EXECUTION            on parallel agents, "waiting for a human" tags
    │
    ▼
  SPAWN                model CLI as a separate process + identity block from the registry
    │                  the task moves to in_progress before launch
    ▼
  RESULT               last line REGOC-STATUS + REGOC-IZLAZ block (evidence)
    │
    ▼
  CRITIC               a second process, no model: runs the checks against the disk itself
    │
    ▼
  CLOSING              completed or blocked — only after the verdict
    │
    ▼
  REPORT BACK          one message per chain of tasks, back into the same conversation
```

---

## Layer by layer

### 1. Channel

A message can come from a conversation (Telegram), from the board, from a script, or from any
other system that can send an HTTP request. The generic entry point is `POST /api/ingest` with
five channel-agnostic fields: `source`, `externalId`, `replyTo`, `text`, `senderName`. Telegram
is thus just one of the callers, not a special case in the code.

Each source has a position of `off` / `shadow` / `on` (`config/ingest-gate.example.json`).
The default is `off` everywhere: no message opens a task until the owner explicitly turns it on.

**In the package:** `src/core/Ingest.ts`, `src/core/IngestConfig.ts`, `src/TelegramPoller.ts`
(launcher `scripts/telegram-poller.ts`), setting `TM_INGEST_GATE_CONFIG`.

### 2. Message queue

A message is first **written** to the SQLite queue, and only then processed. If the process
dies between arrival and processing, the message is not lost. Along the way the queue merges
parts: channels chop long text into pieces, and without merging an agent answers one question
seven times.

**In the package:** `src/core/MessageQueue.ts`.

### 3. Classification and routing

Two decisions, both **without a model**:

- **working mode and weight** — `ModeClassifier` yields a class E1–E5, `WeightScore` derives a
  number 1–100 from it. The number never spills into the neighbouring class, so the display
  does not change the decision;
- **who it belongs to** — keywords from the agent registry; the longest match wins, `*` is the
  fallback route.

The thresholds `pragA`/`pragB`/`pragC` (default 16 / 36 / 81) determine the outcome: below A
the system only answers, above A a task is opened, above B the full role chain runs, above C
human approval of the plan is required.

Why no model: everything standing in the path of **every** message must be deterministic and
free. When a model was the gatekeeper in the system this package was extracted from, it
misrouted 92 % of traffic.

### 4. Task on the board

A task is created in **one single place** — the board's task-creation handler. The web form,
an agent's `curl`, the orchestrator and message ingest all pass through it. A second creator
would mean a branch that bypasses the gatekeepers. At that point sit:

- the echo guard (`DispatchGuard`) — an agent's report must not become a new task;
- the per-author creation cap (`TaskCreateBreaker`), see
  [VRATA_I_KOCNICE.en.md](VRATA_I_KOCNICE.en.md).

Priority 1 is not just ordering: a database trigger immediately puts the task into the
`execution_queue` table.

### 5. Automatic execution

The orchestrator is a loop that asks on every pass: may anything be launched? The answer
depends on the global pause, the cap on parallel agents (a board setting, default 3), the quota
state and the tags on the task. Every reason a pass did nothing is logged — silently standing
still is a fault.

**In the package:** `src/core/orchestrator/` (`Orchestrator.ts`, `SpawnQueue.ts`, `Watchdogs.ts`,
`Liveness.ts`), launcher `bun scripts/orchestrator.ts`, settings
`config/orchestrator.example.json` (`TM_ORCHESTRATOR_CONFIG`). The default is `enabled: false`:
a fresh install does not raise agents just because someone ran the script.

### 6. Spawn with identity

An agent is not a permanent process but **a model CLI launched for one task**. The command and
its arguments go to the operating system as a list, never through a shell — the task
description is user text and a quote in it must not become an executable character. The prompt
is assembled from a template (`templates/prompt/zadatak.md`, `TM_PROMPT_TEMPLATES`), and the
identity from the registry — see [IDENTITET.en.md](IDENTITET.en.md).

Which CLI is invoked is a matter of configuration (`executors` in `orchestrator.json`):
`claude`, another CLI, or any server with an OpenAI-compatible interface over HTTP.

**In the package:** `Executors.ts`, `PromptBuilder.ts`, `AgentRegistry.ts`.

### 7. Result, critic, closing

The agent reports its outcome with a final `REGOC-STATUS:` line and a structured `REGOC-IZLAZ`
(output) block with evidence (see [PRAVILA_ISPORUKE.en.md](PRAVILA_ISPORUKE.en.md)). Then an
independent critic, a second process without a model, runs the checks itself against what is
on disk. Only then is the task closed.

In the original system a task is closed **only by the orchestrator, after the critic's
verdict** (see [ZIVOTNI_CIKLUS_ZADATKA.en.md](ZIVOTNI_CIKLUS_ZADATKA.en.md)). In the package the
core does not yet close on the agent's behalf: the agent's `PUT status` passes through the
board's gatekeepers (`CompletionGuard`, `CriticGate`, `StepSchema`, `ResearchRagGate`,
`GitCommitGate`, `WorkflowGate`, all in `src/core/`).

### 8. Report back

A chain of tasks that arose from one message produces **one** message back, into the same
conversation the message came from (`replyTo`). Three messages about one job are noise; one
message about three tasks is news.

**In the package:** `src/core/ReportBackTask.ts`; the board address in the message comes from
`TM_BOARD_URL`, with no default value.

---

## Three rules that hold the whole flow together

1. **Every layer that does something writes it to the database.** The layer above does not
   trust the memory of the layer below. If any process dies, the state is on the board.
2. **No model on the hot path.** The model is spent on the work, not on deciding whom the work
   belongs to.
3. **The producer does not grade itself.** The executor reports the outcome; someone else
   passes judgment.

See also: [TIM.en.md](TIM.en.md) · [BAZE.en.md](BAZE.en.md) ·
[VRATA_I_KOCNICE.en.md](VRATA_I_KOCNICE.en.md)
