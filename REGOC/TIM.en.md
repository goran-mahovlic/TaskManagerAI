# Team — roles, not people

[Hrvatski](TIM.md) · [Back to overview](README.en.md)

In the original system every role has a name from Croatian folklore. The names are handy in
conversation, but they are not the point: the point is **splitting the work into roles**, each
with its own permissions, skills and model. This document describes the roles so that you can
fill them with your own agents.

---

## The principle of model choice

No model is best at everything, and the price difference can be tenfold. Therefore:

- **judgment** (architecture, security, analysis) → the strongest model;
- **speed and conversation** → a mid-tier model;
- **classification, summarisation, embeddings** → a local model — cheap and private.

The model is **a field in the registry**, never a constant in the code. When a new model comes
out, one line changes. The direction of stepping down is only downward: a failed cheap attempt
costs one extra round, a failed expensive attempt costs without an upper limit.

---

## Roles

| Role | What it may do | Skills (example) | Model and why |
|---|---|---|---|
| **Orchestrator** | divides the work, assembles the result, closes tasks after the critic's verdict; **does not execute itself** | CORE, System, Agents | strongest — deciding who does what is the most expensive mistake |
| **Architect** | asks questions until the idea holds up; maintains the glossary and decisions (ADRs) | Development, GrillWithDocs | strongest — a plan that doesn't hold up is paid for in every later step |
| **Engineer** | writes and changes code, test first | Development, TDD, DiagnosingBugs, CreateCLI | strongest for a major change, mid-tier for a small one |
| **Security** | looks for how this can be abused; an attacker's view | Recon, RedTeam, OSINT | strongest — a miss is most expensive here |
| **Researcher** | reads sources, brings back facts with links, writes findings into RAG | Research, OSINT | strongest or mid-tier, depending on depth |
| **Analyst** | the same problem from several angles, looks for what everyone overlooks | Council, FirstPrinciples | strongest |
| **Designer** | interfaces and visual language; verification in a real browser | FrontendDesign, Browser | strongest |
| **Artist** | images, diagrams, illustrations | Art, Excalidraw, AlgorithmicArt | mid-tier — the output is judged by eye, not by evidence |
| **QA** | doubts other people's work, including the orchestrator's | CORE | mid-tier — verification is re-running commands, not judgment |
| **User interface (24/7)** | talks with the human through a channel, round the clock; takes orders and sends back reports | CORE | mid-tier — fast and cheap, because it runs constantly |
| **Voice** | speech to text and text to speech | — | local services; what doesn't have to be sent out, isn't |

The usual chain for a larger job: **architect → engineer → QA → security**. The idea is first
sharpened, then written, then verified, then attacked. Each step is a separate task, so
afterwards you can see where it got stuck — and it always gets stuck at the step someone
skipped.

The researcher and the analyst come in when something needs to be investigated or a decision
weighed; the designer and the artist when the job has a visual output.

### Why the orchestrator does not execute

For the orchestrator it is always faster to do it itself than to explain. Once it starts doing
that, the system turns into one long conversation without a trail, and we are back to the
problem the system was meant to solve. That is why in the original system the orchestrator is
excluded from automatic launching: a task assigned to the orchestrator means "the main session
does it", not "launch the agent with that name".

### Skills are named in the step

Measured in the original system: of 11 skill invocations across 124 sessions, **all** were
explicitly requested. An agent almost never chooses a skill on its own. That is why a work
step names the skill ("use DiagnosingBugs") rather than just offering a list.

---

## How to add your own agent

The registry is **a single JSON file** and the only source of truth about who exists. Start
from the example:

```bash
cp config/agents.example.json config/agents.json
```

One entry:

```json
{
  "id": "analiticar-podataka",
  "ime": "Data analyst",
  "uloga": "Data pipelines and reports. Brief, with numbers; every claim next to the command that produces it.",
  "model": "",
  "keywords": ["report", "pipeline", "csv"],
  "rag": ["agent_analiticar"],
  "executor": ""
}
```

| Field | Meaning |
|---|---|
| `id` | name of the task assignee: lowercase letters, digits, `-`, `_`; up to 32 characters |
| `uloga` | (role) text that goes into the identity block ("Who you are") |
| `model` | model name understood by the executor; empty = the executor's default |
| `keywords` | what routes a message to this agent; the longest match wins, `*` is the fallback route |
| `rag` | knowledge collections the agent reads from and writes to |
| `executor` | executor from `orchestrator.json`; empty = the default |

Registry path: `config/agents.json`, `$TM_HOME/config/agents.json` or your own path in
`TM_AGENTS_CONFIG`. The registry is read on every pass, so a new agent takes effect without a
restart.

**Board only, no orchestrator?** The list of allowed assignees can also be given as
`TM_AGENTS=ana,marko`. The sources are **combined**, not overridden: registry ∪ `TM_AGENTS` ∪
system assignees (`user`, `scheduler`). With no source at all, only the shape of the name is
checked (see `src/core/AgentIds.ts`).

A ready-made example team with nine roles and their skills is in `agents/regoc-tim.json`, and
`bash scripts/install-agents.sh` installs it and lists which skills are missing
(`docs/AGENTI.md`).

### Three things worth knowing before your first agent

1. **The assignee is an order, not a label.** As soon as a task gets an assignee and the state
   `pending`, and the orchestrator is enabled, the agent will be launched. Be careful whom you
   enter.
2. **The identity is sent on every launch.** An agent that does not receive its role and style
   in the first message behaves like a generic assistant, regardless of what the registry says.
3. **Two or three roles are enough to start.** A coordinator only makes sense once there are
   several executors — see [SLOZI_SVOJ.en.md](SLOZI_SVOJ.en.md).

See also: [IDENTITET.en.md](IDENTITET.en.md) · [ARHITEKTURA.en.md](ARHITEKTURA.en.md)
