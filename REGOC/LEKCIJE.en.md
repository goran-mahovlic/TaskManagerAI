# Lessons — six expensive failures

[Hrvatski](LEKCIJE.md) · [Back to overview](README.en.md)

An extension of the "Lessons learned" section of [README.en.md](README.en.md). Every lesson has
the same shape: **symptom** (what was seen), **cause** (what actually happened), **remedy**
(what was changed) and **safeguard** (what prevents it from coming back). A remedy without a
safeguard lasts until the next code change.

---

## 1. The delegation echo — a report that becomes a new task

**Symptom.** In two hours, **686 tasks** were created from a single source. Each one got a
spawn that failed within four seconds without taking a single step. That one day accounted for
77 % of all failures in the entire log.

**Cause.** An agent's report — with the usual summary, analysis and results sections — came
back in through the intake as the description of a new task. The new task produced a new
report, that one a new task, and so on. The guard that was supposed to recognise a report
looked for section markers in plain form, but the agents wrote them in bold: the log had 16 in
bold versus 5 plain. The guard was missing the **majority** form.

**Remedy.** The echo guard (`src/core/DispatchGuard.ts`) recognises a report in both bold and
abbreviated form, and rejects the same content sent to two agents within a short interval.

**Safeguard.** A ceiling on task **creation**, not on launching: 30 per hour per author, 90
globally, the excess goes into a waiting queue, one alert per episode
(`src/core/TaskCreateBreaker.ts`, see [VRATA_I_KOCNICE.en.md](VRATA_I_KOCNICE.en.md)). The fuse
on agent launches only saw the burst once every task was already in the database — one step
too late.

---

## 2. The false ✅ — a race between agent and critic

**Symptom.** Tasks sit on the board as `completed`, while at the same time the user receives a
message that the work was **not** done. The critic's log dutifully says "blocking".

**Cause.** The critic only runs once the agent's process exits, yet the agent closed the task
with an API call **while the process was still running**. The agent does not win this race
sometimes, but **always**: **6 of 6** tasks the critic failed had been closed 5 to 80 seconds
before the verdict. The late verdict could not be recorded because there is no path from
`completed` to `blocked`, and the write error was wrapped in an empty `catch {}` — so the fault
was invisible as well.

**Remedy.** The completion state is set only by the orchestrator after the verdict; the agent
reports its outcome solely through a `REGOC-STATUS:` line (see
[ZIVOTNI_CIKLUS_ZADATKA.en.md](ZIVOTNI_CIKLUS_ZADATKA.en.md)).

**Safeguard.** The spawn lease: while the process is running, the board rejects `completed`
from outside (`409 SPAWN_ACTIVE`). Closing goes through a single function that checks the
response, retries network errors once and **loudly** logs every failure
(`src/core/TaskCloser.ts`). The single point of truth must not fail silently.

---

## 3. A test that writes to the live database

**Symptom.** Tasks called "Full Task", "Task 1", "Pending 2" appeared on the board. The
orchestrator launched **three expensive model sessions** on them, and the trigger pushed a
test task with priority 1 into the execution queue.

**Cause.** The tests created the database layer without an explicit path, and the default path
was — the production database. The existing protections were per caller and by convention, so
any new test could forget them.

**Remedy.** Every test creates its own temporary database.

**Safeguard.** A structural check inside the database layer itself (`src/core/LiveDbGuard.ts`):
it fails if **both** conditions are true — the process is running in a test environment
**and** the path is the live database. The real home directory is read from the system user
database, not from `$HOME`, because the e2e tests deliberately substitute it. The emergency
exit is explicit and visible (`REGOC_ALLOW_LIVE_DB_IN_TEST`).

---

## 4. A hook block with exit code 0

**Symptom.** Tasks closed as done, while the result literally contains a message about being
blocked due to consumption. The agent did not write a single token.

**Cause.** The hook guarding the quota rejected the prompt. The model CLI then **does not run
the model**: it prints the block message and exits with code **0**. The caller took exit code 0
as success and recorded the message as the result. An additional danger: at the end of its
output the CLI returns **the entire original prompt** — had it been forwarded to the channel,
it would also have been a new source of echo.

**Remedy.** The output is classified **before** the result is recorded: the block signature is
looked for at the start of a line (a report that merely *mentions* the phrase must not fall
under the filter), a block becomes `BLOCKED`, never `DONE`, and the trailing prompt is cut off.

**Safeguard.** An exit code is not proof. The outcome is read from the `REGOC-STATUS:` line and
from the evidence fields (see [PRAVILA_ISPORUKE.en.md](PRAVILA_ISPORUKE.en.md)); output without
a status is not success. The tests run against the literal, archived block output, not against
an invented example.

---

## 5. Stale code in a live process

**Symptom.** A fix task was closed as done — with its own note saying "not in production yet".
A few minutes later two new tasks were closed with exactly the fault the fix was supposed to
remove.

**Cause.** The file was saved about fifteen minutes after the process was started, and the
runtime does not reload code. The fix was on disk, not in production.

**Remedy.** After changing the code of a long-running process — restart, and put the new PID
and time in the result.

**Safeguard.** Two of them. Every prompt contains the verification gate with the rule "RUN
includes a restart" (`PromptBuilder.ts`, `prompt.includeVerificationGate`). In addition, the
original system has a tool that, for a given process, resolves the entry file and all of its
local imports and compares their modification times with the process start time; a newer file
means a loud alarm and a non-zero exit code.

---

## 6. Copies of rules in several places

**Symptom.** The rule "the agent does not set the state" was changed, but the agents'
behaviour was not. Elsewhere: the specification of what a prompt must contain had ten items,
and measurement showed that three were being met and three never were. Meanwhile the board
displayed two abandoned mechanisms as active.

**Cause.** The same text lived in **two** prompt builders and in **eight** frozen copies —
packages for other nodes, the mobile build, the test skeleton, documentation. Fixing one copy
did not bring the specification into line. The rules file that was believed to go into every
prompt was not being loaded at all: the agents were launched from a different working
directory.

**Remedy.** One source of truth per rule: the agent registry for identity, a template for the
prompt, one state transition table, one function for configuration paths (`konfigPutanja` in
`src/core/paths.ts`). Copies are generated from the source, not maintained by hand.

**Safeguard.** Before changing a rule, search for **all** of its copies and list them in the
decision record. A structural ratchet test counts occurrences and may only fail — an example
is `tests/bez-nasih-vrijednosti.test.ts`: a test with a hard zero would have failed from day
one and been switched off, whereas the ratchet fails only when the count **grows** or an
occurrence appears in a **new** file. An empirical check is stronger than reading code: look
at what the agent actually receives in its prompt.

---

## What they have in common

All six failures have the same shape: **the system trusted a signal that does not measure what
is being claimed** — an exit code, the existence of a file, an entry in one of several copies,
an API call instead of a verdict. The safeguard is the same kind of thing in every case: a
check done by someone else, against what is actually running in production.

See also: [VRATA_I_KOCNICE.en.md](VRATA_I_KOCNICE.en.md) · [SLOZI_SVOJ.en.md](SLOZI_SVOJ.en.md)
