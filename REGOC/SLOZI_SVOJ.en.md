# Build your own — the minimal recipe

[Hrvatski](SLOZI_SVOJ.md) · [Back to overview](README.en.md)

You do not need eleven roles, three databases and a network of nodes to make the system work.
You need a board, one model, two or three roles and one intake. The rest is added once you have
measured that it is missing.

This recipe has one rule of order: **first everything that only watches, then everything that
acts.**

---

## Ingredients

| Ingredient | Minimal version | Where |
|---|---|---|
| **package** | board and database | `bash scripts/install.sh`, then `bun src/TaskWebUI.ts` |
| **one model CLI** | `claude` or any server with an OpenAI-compatible HTTP interface | `executors` in `config/orchestrator.json` |
| **registry with 2–3 roles** | executor + verifier (+ researcher) | `config/agents.json` |
| **one channel** | the board itself; then `POST /api/ingest` or Telegram | `config/ingest-gate.json` |

To check that the board works: `bash scripts/health.sh`. Data location: `$TM_HOME` (default
`~/.taskmanager`).

### A starter registry

```json
{
  "agents": [
    { "id": "izvrsitelj", "ime": "Executor",
      "uloga": "Writes and changes code. Test first. Every claim comes with the command that proves it.",
      "keywords": ["*"] },
    { "id": "provjeritelj", "ime": "Verifier",
      "uloga": "Doubts other people's work. Re-runs the commands from the evidence and reports any difference.",
      "keywords": ["check", "review", "test"] }
  ]
}
```

Two roles are enough so that the producer does not grade its own work. A coordinator only makes
sense once there are several executors and they need directing — not before (see
[TIM.en.md](TIM.en.md)).

---

## Phase 1 — only watch (the first week)

1. **The board and manual tasks.** Open tasks by hand and close them by hand. You will see what
   workflow you actually need, instead of guessing it.
2. **All gatekeepers in shadow mode.** This is the package's default state — just check that it
   is so:

| Gatekeeper | Setting | Default |
|---|---|---|
| completion gatekeeper | `config/completion-gate.json` → `live` | `false` (shadow) |
| structured output | `config/step-schema.json` → `nacin` | `shadow` |
| critic | `config/features.json` → `criticGate` / `criticGateLive` | off — switch on `criticGate` (shadow) |
| creation ceiling | `taskCreateBreaker` / `taskCreateBreakerLive` | off — switch on the first (shadow) |
| spawn lease | `spawnCloseGuard` / `spawnCloseGuardLive` | off — switch on the first (shadow) |
| cleaners | `watchdog.*.mode` in `orchestrator.json` | `shadow` |
| message intake | `perSource` in `ingest-gate.json` | `"*": "off"` — your source to `shadow` |

3. **A consumption meter before any autonomy.** Without a number you have no brake, and without
   a brake autonomy is a matter of time. `tools/session_usage.py` must work and return fresh
   numbers — otherwise the autonomy gates must stay closed (see
   [VRATA_I_KOCNICE.en.md](VRATA_I_KOCNICE.en.md)).

---

## Phase 2 — one agent, on command

4. **The orchestrator, one pass at a time.** `bun scripts/orchestrator.ts --stanje` shows what
   is configured; `--jednom` makes exactly one pass. Run it by hand on a single task and read
   the outcome on the board.
5. **Concurrent agent ceiling at 1** (Config → Usporedni agenti (concurrent agents)). Raise it
   when one agent is boring, not when it is exciting.

---

## Phase 3 — what gets switched on only after measurement

Each of these steps has the same condition: **the shadow log shows how many things the gate
would have rejected and how many of those wrongly** — and that second number is zero, or you
understand it.

| Step | Switched on with | What to measure first |
|---|---|---|
| **automatic execution** | `enabled: true` in `orchestrator.json` | the consumption meter works; no task in the queue is a test leftover; the pause has been tried |
| **live critic** | `criticGateLive` | in shadow mode there is no "fail" verdict on work that is actually good |
| **closing through the orchestrator** | `spawnCloseGuardLive` | shadow mode shows the agent closing while it is still working; no human PUT would have been rejected |
| **structured output** | `nacin: "on"`, later `provodiNedostajuci` | there are no invalid blocks; missing ones come only from paths that do not carry a block |
| **creation ceiling** | `taskCreateBreakerLive` | the threshold is above the worst hour in your history |
| **cleaners** | `watchdog.*.mode: "live"` | no "zombie" in shadow mode was a live agent |
| **message intake** | your source to `on` | how many tasks a week of messages would have created, and whether they should have been |

Rolling back any step is one word in the settings, without a restart.

---

## What to deliberately leave alone at the start

- **Tiered autonomy and waking up when the quota resets** — only once there is work waiting for
  quota.
- **Role chains** (architect → engineer → QA → security) — only once a single executor visibly
  cannot keep up; a four-step chain for ten minutes of work costs more than it brings.
- **RAG** — when it first hurts that the system does not remember last week; from the very
  first entry, with project and type (see [BAZE.en.md](BAZE.en.md)).
- **Energy estimate** — this is a conversion of cost, not a new metric
  (see [TROSAK_I_ENERGIJA.en.md](TROSAK_I_ENERGIJA.en.md)).

---

## Why exactly this order

The original system did some of these steps the other way round, and each one set it back:
autonomy before a consumption meter, a live gatekeeper before shadow mode, an orchestrator that
did the work instead of dividing it up. The expensive lessons are in
[LEKCIJE.en.md](LEKCIJE.en.md); this recipe is their order.

More on assembling the whole system: `docs/SUSTAV.md`, `docs/AGENTI.md`, `docs/INSTALL.md`.
