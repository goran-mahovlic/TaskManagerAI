# Gates and brakes

[Hrvatski](VRATA_I_KOCNICE.md) · [Back to overview](README.en.md)

A system that assigns work to itself must have places where it stops. It has several, and they
deliberately overlap. This document describes each one, why it exists and — most important of
all — **the rule under which a new gate may be switched on at all**.

---

## The rule for every new gate: shadow → measurement → live

No gatekeeper goes straight into production. The order is always the same:

1. **`off`** — the code exists but does nothing.
2. **`shadow`** — the verdict is made and logged ("I WOULD have blocked"), nothing is stopped.
3. **measurement** — from the shadow log, count how many things the gate would have rejected,
   and **how many of those wrongly**.
4. **`on` / `live`** — only once the number of false rejections is known and acceptable.

Rolling back is always one word in the settings, without a restart
(`config/features.example.json`: switches are read with a 30 s TTL; an unknown key means off).

Why so strict: a gatekeeper that wrongly blocks normal work gets switched off, and a switched-off
gatekeeper protects no one. In the original system, a gatekeeper with an overly broad definition
would, because of a single word, have marked 14 % of work that had actually been done as blocked
(see [PRAVILA_ISPORUKE.en.md](PRAVILA_ISPORUKE.en.md)). Shadow mode showed this before it
happened.

---

## The handbrake — global pause

A button on the board, or `POST /api/pause`. Two levels:

- **global** — stops automatic execution as a whole and interrupts running spawns;
- **per task** — `POST /api/tasks/:id/pause`; the task keeps its state, the orchestrator simply
  skips it.

The global pause state lives in a file (`REGOC_PAUSE_STATE`), because several processes read it
and it must survive a restart of any of them.

Two design decisions:

- **Pause is not a new task state.** A task in progress must be able to return to work; through
  the state machine that return would be forbidden or would require new rules.
- **An unreadable file means "not paused".** A brake that jams itself because of broken JSON is
  worse than a brake that does not engage. Before the brake, the only way to stop was to kill
  the process — and that leaves tasks in a terminal state and kills healthy spawns as well.

**In the package:** `src/core/PauseControl.ts`.

---

## Autonomy gates that read consumption

Before **every** spawn, the orchestrator measures how much of the quota has been used and
throttles itself accordingly: above the first threshold it stops pulling work from the queue on
its own, above the second at most one agent runs, above the third it executes nothing until the
quota resets. **A human's order passes through all levels** — the brake switches off autonomy,
not responsiveness.

The hardest question is not the threshold but: **what if there is no measurement?** Three
states, three answers:

| State of the meter | Decision | Why |
|---|---|---|
| exists, but **has not produced a result yet** | fail-open | a fresh system must not lock itself before the first measurement |
| was working, then **went stale** | fail-closed | a meter outage is treated as the worst case |
| **not installed** | fail-closed | that is not a young system but permanent blindness |

The third row was added after a fault: on one node the measuring tool was not installed, so the
measurement log was never created, and the gates read this as a "fresh system" and allowed
**full autonomy with no upper bound** — for weeks, until the queue was empty, so nobody saw the
fault.

Quota reset comes with a trigger (`src/core/QuotaWakeup.ts`) that forces a fresh measurement at
the moment of reset, so the gates open immediately instead of waiting for the regular check. It
does not wake up if there is no work in the queue, and it is postponed if a human is currently
working.

**In the package:** the meter `tools/session_usage.py`, the board display
`src/SessionUsage.ts`, the autonomy queue `src/core/AutonomyQueue.ts`. The tiered gates in the
original system live in the host daemon.

---

## Concurrent agent cap

How many agents may work at the same time is **a board setting**, not an environment variable:
it changes live (Config → Concurrent agents, `PUT /api/config/concurrency`), default 3, always
in the range 1–10. The orchestrator reads it within five seconds at most. Lowering it interrupts
no one — new agents are simply not launched until there are fewer. Autonomy levels take
precedence over the cap.

`REGOC_MAX_AGENT_CONCURRENT` serves only as a one-time initial value while the setting does not
exist yet. A lesson from production: while the cap came from the environment, a forgotten `=1`
from an ancient configuration forced the system into serial operation, and this was not visible
on the board.

**In the package:** `src/core/ConcurrencySetting.ts` (changes go into `settings_history`).

---

## Task-creation cap per author

One day in the original system, **686 tasks were created in two hours** from a single source —
an echo of reports that became new tasks (see [LEKCIJE.en.md](LEKCIJE.en.md)). The fuse on agent
launching only saw the burst once every task was already in the database.

That is why the gate sits at **creation**, at the board's single entry point:

| Parameter | Value | Rationale |
|---|---|---|
| window | 60 min, sliding | verifiable against `tasks.created_at` |
| per author | 30 / h | normal traffic: median 2 / h, p99 24 / h |
| global | 90 / h | worst hour in history: 41 / h |
| over the threshold | **queued**, not rejected | nothing is lost; `429` + `Retry-After` |
| notification | one per episode | 686 messages is the same fault as 686 tasks |

Replayed against real history: the incident would have been stopped for 84 % of the tasks, and
normal traffic delayed in 1.6 %. On its own fault (database failure) the gate **lets through**
and logs it — a fuse that cuts off the inflow of work gets switched off.

**In the package:** `src/core/TaskCreateBreaker.ts`, switches `taskCreateBreaker` /
`taskCreateBreakerLive`.

---

## Message switch

Every message source has a position `off` / `shadow` / `on` (`config/ingest-gate.example.json`,
`perSource`). The default is `"*": "off"` — no message opens a task until the owner switches it
on. In shadow mode you can see how many tasks would have been created, before a single one is.
Weight thresholds (`pragA`/`pragB`/`pragC`) determine when a message only gets a reply and when
it becomes a task.

The reason from production: while the chat channel did not lead to tasks, 78 % of consumption
was invisible on the board for months. But a channel that turns **every** message into a task
is just as bad — hence the switch and the threshold.

---

## Trap: a meter fed by the work the gate forbids

In the original system, the consumption meter was refreshed **as a side effect of agent work**.
When the gates stopped the agents, the refreshing stopped too. The meter went stale, the gates
read the stale number as "all fine" and let work run at full steam — exactly at the moment when
it should least have done so. The work then refreshed the meter, the gates closed, and the cycle
started over: an **oscillator**.

The rule that follows:

> **A meter must be independent of what it measures.** It is refreshed by a separate process on
> its own schedule, and a stale value means "I don't know" — never "zero".

The same applies to every gate: before switching it on, ask **what feeds the number the gate
reads**, and whether that feeding stops when the gate closes.

See also: [ZIVOTNI_CIKLUS_ZADATKA.en.md](ZIVOTNI_CIKLUS_ZADATKA.en.md) · [SLOZI_SVOJ.en.md](SLOZI_SVOJ.en.md)
