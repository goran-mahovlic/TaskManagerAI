# Task lifecycle

[Hrvatski](ZIVOTNI_CIKLUS_ZADATKA.md) · [Back to overview](README.en.md)

A task is a finite-state machine with five states. The transitions are defined in **one**
place — `ValidStatusTransitions` in `src/core/TaskManagerSQL.ts` — and the board rejects every
forbidden transition with a `409` response listing the allowed ones.

---

## States and allowed transitions

| From state | May go to |
|---|---|
| `pending` | `in_progress`, `blocked`, `cancelled` |
| `in_progress` | `completed`, `blocked`, `cancelled` |
| `blocked` | `pending`, `in_progress`, `cancelled` |
| `completed` | `pending` |
| `cancelled` | `pending` |

No task skips `in_progress` on its way to `completed`, and from both terminal states
(`completed`, `cancelled`) there is only one way out — back to `pending`.

### `pending → completed` is forbidden

A task must pass through `in_progress`. Otherwise the board never shows who worked on what, and
a task that sits at "waiting" while it is being worked on lies about the state of the system.
This is a deliberate restriction, not an oversight.

### Reopening

`completed → pending` and `cancelled → pending`. A closed task returns **to the queue**, never
straight into work: an agent picks it up like any other `pending` task. There is no other exit
from `completed` — not even to `blocked`. The consequence matters for the next section.

### Pause is not a state

A temporary stop is done with a `paused` flag on the task (`POST /api/tasks/:id/pause`,
`/resume`). The state does not change, so the work resumes exactly where it stopped.
`cancelled` is **not** used for this.

---

## Who sets the state

**Rule from the original system: the completion state is set only by the orchestrator, and
only after the critic's verdict.** The agent reports its outcome in text (`REGOC-STATUS:`), not
through an API call.

Why: the critic only runs once the agent's process exits, yet the agent used to close the task
**while its process was still running**. Measured: of six tasks the critic judged as "fail",
**all six** stood on the board as `completed` — closed 5 to 80 seconds before the verdict. The
late verdict could not be recorded because there is no path from `completed` to `blocked`, and
the write error was swallowed without a trace. The board showed ✅, the user got a "not done"
message, and the cost of one such task was 18 USD for work that did not pass its own test.

The fix has two parts:

1. **The instruction changes** — the agent no longer calls `PUT status`; the last line of its
   reply is its only channel for the outcome (see [PRAVILA_ISPORUKE.en.md](PRAVILA_ISPORUKE.en.md)).
2. **Defence in depth: the spawn lease.** While an agent process is working on a task, there is
   a marker saying "a spawn is working here right now". The board then rejects a `completed`
   that does not come from the orchestrator (`409 SPAWN_ACTIVE`). The question is not "who are
   you" — the agent runs as the same user and could read any token — but "is someone working
   on this task right now". An unreadable or stale marker never locks.

**In the package:** `src/core/TaskCloser.ts` (closing with retries and failure logging, the
lease), `src/core/SpawnFinalizer.ts`; switches `spawnCloseGuard` (shadow) and
`spawnCloseGuardLive` in `config/features.example.json`, both off by default. A human on the
board can override the decision with an explicit header.

---

## `blocked` is not a lock

`blocked` is a state, and states are changed by automation. In the original system a step that
a human had manually put into `blocked` was returned to `pending` by automatic unblocking as
soon as its dependencies were done — and the orchestrator launched it 30 seconds later. A block
set by a human did not hold for even a minute.

**The lock is a tag.** A task with one of the tags `needs-decision`, `waiting-for-human`,
`no-autonomy` or `interactive` is left alone by automation — neither unblocking nor automatic
execution. The list is in `HUMAN_GATED_UNBLOCK_TAGS` (`TaskManagerSQL.ts`) and
`DEFAULT_HUMAN_GATED_TAGS` (`AutonomyQueue.ts`), and a test ensures they stay identical.

The other side of the same lesson: `blocked` without a tag and without a question becomes a
**graveyard**. In the original system, at one point 87 tasks were sitting in `blocked`, with a
median of 8.3 days.

---

## A question for a decision

When an agent truly cannot proceed without a decision, it does not write prose into the
description but asks a **question** (`pitanje`):

```
POST /api/tasks/:id/pitanje
{ "ekspert": "…", "pitanje": "…", "opcije": ["…", "…"], "preporuka": "…" }
```

One call does three things at once: it appends a structured block to the description, adds the
`needs-decision` tag and moves the task to `blocked`. "I asked" and "I stopped" are one move,
not two that can diverge.

Rules (`src/core/OdlukaPitanje.ts`):

- **the expertise (`ekspert`) is mandatory** — who needs to answer; it goes into the model's
  role if a machine answers;
- **at least two, at most six options (`opcije`)** — without a choice it is not a dilemma but
  work to be done; above six it is research;
- **at most one question per task** — a question is a rare exception, not a way of working; a
  task that needs a series of decisions is not ready and should be broken down or have its
  description improved.

The answer is given by a human on the board or, if so configured, by a local model with a risk
filter (`docs/ODLUCIVANJE.md`). The decision is recorded with the task, signed by whoever made
it.

---

## Cleaners for stuck work

Three faults that really do happen in production, and three cleaners
(`src/core/orchestrator/Watchdogs.ts`):

| Cleaner | Fault it catches |
|---|---|
| **zombie** | the task is `in_progress`, but the process that took it no longer exists |
| **progress watch** | the process exists, but the progress measure has stalled for longer than `livenessWindowHours` |
| **hard ceiling** | the spawn has been running longer than `hardCeilingHours`, regardless of anything else |

In `live` mode all three **return the task to the queue** (`in_progress → pending`). That
transition is deliberately not in the table above: it goes exclusively through a dedicated
task-return path, because an ordinary `PUT` would reject it with `409`, and the task would stay
stuck with a false record that it had been returned.

Three rules built into all cleaners:

1. **Shadow first.** The modes are `off` / `shadow` / `live`; in shadow mode the cleaner logs
   what it would do instead of doing it. A cleaner that gets it wrong kills someone else's
   work, and that only becomes visible afterwards.
2. **A cap on actions per pass** (`maxActionsPerRun`, default 5). Without it, the first correct
   run on an old system touches hundreds of tasks at once.
3. **Grace after restart.** A new generation of the orchestrator does not know about the
   previous one's spawns, so every live agent would look like a zombie. A task without a known
   PID is only failed after a grace period.

**The protective tag.** In the original system the stuck-task cleaner skips tasks tagged
`no-watchdog` (the list of exceptions is in its settings). It means "don't reset me" — it is
carried by a task that runs long and correctly. It does **not** mean "don't launch me": it is
not a human lock, and `AutonomyQueue` explicitly excludes it from the list of human tags, so a
task carrying it may be launched automatically. For "don't launch", use the tags from the
section on `blocked`.

See also: [VRATA_I_KOCNICE.en.md](VRATA_I_KOCNICE.en.md) · [LEKCIJE.en.md](LEKCIJE.en.md)
