# Delivery rules — when "done" is really done

[Hrvatski](PRAVILA_ISPORUKE.md) · [Back to overview](README.en.md)

The biggest problem in working with agents is not a wrong answer but a **confident wrong
answer**. An agent that says "done, tests pass" sounds the same whether it is true or not. This
document describes three mechanisms that turn a claim into something that can be checked.

---

## 1. The verification gate: five steps before a claim

```
IDENTIFY  →  RUN  →  READ  →  VERIFY  →  CLAIM
```

| Step | Question |
|---|---|
| **IDENTIFY** | What exactly am I claiming? Which command proves it? |
| **RUN** | Did I run it — now, against this code? |
| **READ** | Did I read the entire output, including the exit code? |
| **VERIFY** | Does the output agree with the claim? |
| **CLAIM** | Only now do I claim — and cite the evidence. |

Skipping the third step is the most common cause of a false "it works": the command was run,
but nobody read that it failed.

### RUN includes restarting a long-running process

**A saved file only changes the disk.** A server, daemon or worker started before the change
keeps running the old code — most environments do not reload code on their own.

An example from the original system: a daemon fix was saved some twenty minutes after the
process had been started. The fix task was closed as done, and a few minutes later two new
tasks were closed with exactly the fault the fix was supposed to prevent — because the fix was
not running. Since then the rule is: if you touched the code of a long-running process, restart
it and record the **new PID and start time** in the result. Without that, "done" is untrue.

In the package this block goes into every prompt (`prompt.includeVerificationGate` in
`orchestrator.json`, on by default).

---

## 2. Structured status: one channel for the outcome

The last line of the agent's reply **must** be one of three declarations:

```
REGOC-STATUS: DONE — <what was delivered>
REGOC-STATUS: BLOCKED — <which tool or access is missing>
REGOC-STATUS: NEEDS_CONTEXT — <which description or context is missing>
```

Why a closed set rather than free text: free text allows "it's mostly done", which means
nothing. The machine reads the three words literally (`CompletionGuard.parseDeclaredStatus`
tolerates markdown, dashes and underscores around them).

Why the **only** channel: when the agent reported the outcome both in text and through an API
call, the two channels competed — and the API won before the critic's verdict (see
[ZIVOTNI_CIKLUS_ZADATKA.en.md](ZIVOTNI_CIKLUS_ZADATKA.en.md)). One channel has no race.

**The agent's declaration takes precedence.** `BLOCKED` or `NEEDS_CONTEXT` beats even a
flawless evidence block: whoever says they are not done, is not done. Such a verdict may block
even while the rest of the gatekeeper is in shadow mode (`deterministicLive` in
`config/completion-gate.example.json`), because it is not a heuristic. Unfinished work reported
as `BLOCKED` is a proper outcome; a false `DONE` is a fault.

---

## 3. Structured step output: `REGOC-IZLAZ`

Alongside the status, the agent leaves a JSON block with five fields, announced by the line
`REGOC-IZLAZ` (Croatian for "output"):

```json
{
  "napravljeno": "Added a state-transition check to the PUT handler.",
  "dokaz": [
    {"vrsta": "test", "naredba": "bun test tests/prijelazi.test.ts", "izlaz": "24 pass, 0 fail"},
    {"vrsta": "http", "naredba": "curl -s -o /dev/null -w '%{http_code}' …", "izlaz": "409"}
  ],
  "datoteke": ["src/TaskWebUI.ts"],
  "sljedeci_korak": null,
  "nesigurnosti": ["not verified against the real message channel"]
}
```

The gatekeeper judges the **fields**, not the prose (`src/core/StepSchema.ts`).

### A closed vocabulary of evidence

Each kind carries what is needed to repeat it. An invented kind is an error, not a silent pass —
otherwise the vocabulary would be watered down by the first agent that comes up with
`{"vrsta": "osjećaj"}` (a "feeling").

| Kind | What it must have |
|---|---|
| `naredba` (command) | the command and its output |
| `test` (test) | the command and a **numeric** output (e.g. "24 pass, 0 fail") |
| `datoteka` (file) | a path that can be opened |
| `mjerenje` (measurement) | a number |
| `http` (HTTP) | a status **code** ("200", not "OK") |
| `commit` (commit) | a sha (7–40 hexadecimal characters) |
| `url` (URL) | an http(s) address |
| `rag` (RAG) | the ID of the stored document, not just the collection name |

The `rag` kind was added after measurement, not out of taste: a RAG write is repeatable, but
agents were reporting it as `datoteka`, and a document ID is not a path — so the gap was in the
vocabulary, not in the agent.

### Why the prose counter measured vocabulary

Before the schema, the gatekeeper counted "evidence words" in the summary: a mention of `bun`,
a path with an extension, a number next to the word "test", a status code. Over the last 50
completed tasks:

| Measure | Result |
|---|---|
| prose counter (≥ 2 kinds of words) | **42 / 50 = 84 %** |
| repeatable evidence (command + its output, verifiable path…) | **0 / 50 = 0 %** |

The first number looks like health, but it measures vocabulary. The sentence "I ran `bun test`
and everything passes in `X.ts`" has two kinds of words and passes, yet contains not a single
piece of data anyone could repeat. After the schema was introduced, the class "block exists,
but the evidence is bad" dropped from 7 of 50 to **0 in all 56** subsequent tasks.

### Modes and two branches

The setting `config/step-schema.json` (example: `config/step-schema.example.json`; a missing or
invalid file means `shadow`):

| `nacin` | Behaviour |
|---|---|
| `off` | no block is requested, no verdict is made; the prompt is byte-identical to the one without the schema |
| `shadow` | the verdict is made and logged, nothing is rejected |
| `on` | an **invalid** block (`schema_invalid`) rejects the closing |

A **missing** block (`schema_missing`) is rejected only with `on` **and**
`provodiNedostajuci: true`, and only outside the exemptions: a bookkeeping close shorter than
2 s, the tag `bez-bloka` ("no block") or the header `X-REGOC-Zatvara: covjek|orkestrator`. The
source `agent` may not write itself an exemption.

Why two branches rather than one switch: measurement showed that a global `on` would have
rejected 7 of 50 closings (14 %) in which the work **had actually been done** — and five of
those seven summaries were not written by an agent that had even seen the block, but by the
orchestrator or a human. Only a rule the executor has seen is enforced: whoever wrote a block
has seen the rule, so a false rejection of an invalid block is not possible. That is why
`schema_invalid` may go live, while `schema_missing` waits for measurement.

`provodiNedostajuci` ("enforce missing") is a **flag, not a fourth mode**: `nacin` ("mode")
stays `off`/`shadow`/`on`, so rolling back is still one word. The change takes effect without a
restart.

---

## How the three mechanisms fit together

```
agent works ──► verification gate (in prompt) ──► REGOC-IZLAZ + REGOC-STATUS
                                                   │
                         ┌─────────────────────────┴──────────────────────┐
                         ▼                                                ▼
          board gatekeeper judges the fields                critic runs the checks itself
                         └─────────────────────────┬──────────────────────┘
                                                   ▼
                                        completed  or  blocked
```

See also: [VRATA_I_KOCNICE.en.md](VRATA_I_KOCNICE.en.md) · [LEKCIJE.en.md](LEKCIJE.en.md)
