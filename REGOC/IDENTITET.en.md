# Agent identity at launch

[Hrvatski](IDENTITET.md) · [Back to overview](README.en.md)

An agent is a model CLI launched for one task. On its own it knows neither who it is nor what
it may do. Everything that makes it an architect rather than a generic assistant must be given
to it **on every launch** — and from a single source.

---

## One rule: identity is built from one registry, every time

On every spawn the orchestrator assembles an **identity block** from the agent registry and
hands it to the model together with the task. There is no other place from which an agent may
learn who it is:

- not from a previous session (it may have belonged to a different agent),
- not from a rules file in the working directory (the CLI may not load it — that depends on the
  directory the process was launched from),
- not from a hand-maintained copy of the text in the code.

Why exactly one source: in the original system the same rule about what a prompt must contain
was written down in the registry, in two prompt builders and in several frozen copies for other
nodes. Measurement showed that of ten prescribed items **three were met unconditionally, two
conditionally, two partially and three not at all**. A rule kept in several places is not a
rule but several versions drifting apart (see [LEKCIJE.en.md](LEKCIJE.en.md), "copies of
rules").

A second, technical reason: the identity block of the same agent is **byte-identical** from
launch to launch. That keeps the model provider's prompt prefix cache valid, and that is
directly money.

---

## What the block must contain

| Part | Content | Note |
|---|---|---|
| **Who you are** | name and role, in one sentence | without this the agent is a generic assistant |
| **Style** | how it communicates: brief, with numbers, no embellishment… | goes into every report |
| **Skills** | **its own** skills, with a short summary of each | with an explicit caveat that the others in the catalogue are not its own |
| **Own tools** | tools it may call, and how | only those that exist on that machine |
| **RAG collection** | where it reads before working and where it writes findings after working | only collections whose existence has been confirmed |
| **Knowledge to load** | a **list of paths** to read, not their content | see below |

**Knowledge as a list, not as inserted text.** Literal insertion was rejected on the basis of
measurement: one role's knowledge came to about 34 KB (≈ 8,400 tokens) per launch, and every
change to those files would break the block's byte-identity and with it the cache. A list of
existing paths with the instruction "read before starting" has the same effect for a fraction
of the cost. Paths that do not exist are omitted and counted, so you can see what is missing.

In the package the block is assembled by `src/core/orchestrator/PromptBuilder.ts` from the
template `templates/prompt/zadatak.md` (section "Tko si", i.e. "Who you are") and the registry
fields in `config/agents.json` (see [TIM.en.md](TIM.en.md)). Your own template:
`prompt.templateDir` in `orchestrator.json` or `TM_PROMPT_TEMPLATES`. An unknown placeholder
`{ime}` stays in the text literally — a typo in the template must be visible, not silently
disappear.

Facts about your infrastructure (where the board is, which services exist) are **not** part of
the code: you enter them yourself in `prompt.systemFacts`. An empty list is the correct initial
state.

---

## Why the anonymous agent generator was abandoned

The underlying framework (PAI) offers a tool that assembles a **nameless** agent for one job
from a list of traits (expertise, personality, approach). In the original system that tool was
declared abandoned, for four reasons:

1. **It enforces the opposite policy.** The template literally says the agent has no lasting
   identity, while the system's rule is that only named roles do the work. It is not a broken
   tool but a tool for a different policy.
2. **The need was measured and is zero.** Of 940 runs over five weeks, all 940 were performed
   by a named role from the registry; nameless ones: 0.
3. **The "no role for this job" case has a cheaper answer:** a new registry entry. The block
   builder picks it up without a single code change.
4. **A nameless agent breaks the bookkeeping.** Cost per project, run telemetry and the agent's
   own RAG collection are tied to the agent ID. An agent without a name is a hole in those
   records, not a row.

The tool was not deleted (it comes from the upstream project and costs nothing while nobody
calls it), but its abandonment is **visibly** marked. Invisible abandonment — dead code that
the board shows as active — is exactly the fault that prompted the decision.

If it is ever measured that a significant share of jobs has no suitable role, the decision will
be revisited — with a number from the run log, not with an assumption.

---

## Pitfall: the system channel leaks

A model CLI usually receives its identity via a system-prompt flag (e.g.
`--append-system-prompt`, `systemPromptFlag` in the executor). Everything passed as
command-line arguments:

- is visible to **every user on the machine** in the process list while the agent runs;
- ends up in process-monitoring logs, in error output and in crash reports;
- can linger in shell history if someone repeats the command by hand.

Hence a rule without exception:

> **Secrets never go into the identity or the prompt.** No keys, no passwords, no tokens, no
> addresses that are not meant to be public.

An agent that needs access gets the **name of an environment variable** or a path to a file
with restricted permissions — never the value. That is why for the HTTP executor
`orchestrator.json` holds `apiKeyEnv` (the variable name), not the key. The task text itself
can be handed to the model via standard input (`promptChannel: "stdin"`) instead of as an
argument, so it does not end up in the process list.

See also: [TIM.en.md](TIM.en.md) · [PRAVILA_ISPORUKE.en.md](PRAVILA_ISPORUKE.en.md)
