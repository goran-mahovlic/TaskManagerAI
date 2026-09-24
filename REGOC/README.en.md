# REGOČ — an agent system built around TaskManager

This document describes the system TaskManagerAI was extracted from. **It is not required to run
TaskManager** — it is here because it is the most useful explanation of what a task manager can
do once you put it at the center, instead of keeping it on the side as a to-do list.

Everything that follows describes how the system works, not how it is configured. Addresses,
keys, group names and passwords are deliberately left out.

[Hrvatski](README.md)

---

## Teme / Topics

This document is the entry point and overview. Each topic has its own file that goes deeper —
with the mechanism, the reason it exists and the measured failure that called for it.

| Topic | Contents |
|---|---|
| [Architecture](ARHITEKTURA.en.md) | a message's path from channel to notification; where each layer lives in the package |
| [Team](TIM.en.md) | roles, permissions, skills and models; how to add your own agent |
| [Identity](IDENTITET.en.md) | identity block from a single registry on every launch; why secrets never go into the prompt |
| [Task lifecycle](ZIVOTNI_CIKLUS_ZADATKA.en.md) | states and transitions, who closes, `blocked` is not a lock, decision questions, sweepers |
| [Delivery rules](PRAVILA_ISPORUKE.en.md) | verification gate, `REGOC-STATUS`, structured output `REGOC-IZLAZ` |
| [Gates and brakes](VRATA_I_KOCNICE.en.md) | pause, autonomy gates, ceilings, shadow mode before switching on, the oscillator trap |
| [Databases](BAZE.en.md) | three SQLite stores, WAL and `VACUUM INTO`, time ordering, the RAG write gatekeeper |
| [Cost and energy](TROSAK_I_ENERGIJA.en.md) | cost per project; electricity, CO₂ and water as an estimate with a range |
| [Lessons](LEKCIJE.en.md) | six expensive failures: symptom → cause → remedy → safeguard |
| [Build your own](SLOZI_SVOJ.en.md) | the minimal recipe and the order to switch things on |

---

## Contents

1. [Where it started — PAI](#1-where-it-started--pai)
2. [The name and the core idea](#2-the-name-and-the-core-idea)
3. [Layered architecture](#3-layered-architecture)
4. [The team](#4-the-team)
5. [The daemon — the part that works when nobody is watching](#5-the-daemon--the-part-that-works-when-nobody-is-watching)
6. [Message routing](#6-message-routing)
7. [Background sessions](#7-background-sessions)
8. [TaskManager at the center](#8-taskmanager-at-the-center)
9. [Model selection](#9-model-selection)
10. [Context, skills and hooks](#10-context-skills-and-hooks)
11. [Memory and knowledge](#11-memory-and-knowledge)
12. [Brakes and autonomy](#12-brakes-and-autonomy)
13. [Checks before anything is declared done](#13-checks-before-anything-is-declared-done)
14. [Services](#14-services)
15. [Node network](#15-node-network)
16. [Lessons learned](#16-lessons-learned)
17. [What you need from this](#17-what-you-need-from-this)
18. [Acknowledgements](#18-acknowledgements)

---

## 1. Where it started — PAI

REGOČ did not start from a blank page. Its foundation is **[PAI — Personal AI Infrastructure](https://github.com/danielmiessler/PAI)**
by Daniel Miessler (MIT license), and it is not a passing inspiration but the framework the
system still runs in today.

**What PAI provided:**

- **The idea of personal infrastructure.** The assistant is not a service you sign up for but a
  system you keep with you, configure yourself and understand. Your data stays yours.
- **Skills.** Knowledge packaged into folders of instructions that load when needed — for
  writing documents, for research, for working with PDFs, for fixing bugs. We have 45 of them
  today.
- **Hooks.** Points where the system inserts itself into the workflow: when a session starts,
  before a tool call, after a job finishes. We have 24 of them, and they hold everything that
  must be automatic — loading context, security checks, recording ratings, session summaries.
- **Context loading at startup.** Every session begins with the system loading on its own who
  it is, which rules apply and what it last worked on.
- **A voice layer.** A reply can be spoken, not just written.
- **A prescribed response format.** Summary, analysis, actions taken, result, status, next
  step — always in the same order, so a reply can be skimmed.

**What REGOČ added on top:**

| PAI provides | REGOČ adds |
|---|---|
| one assistant with skills | **a team of roles**, each with its own domain and its own model |
| conversation as the workspace | **the task database as the single source of truth** |
| work on request | **a daemon** that works even when nobody is watching |
| one model | **a model router** — from the strongest in the cloud to a local one |
| trust in the user | **brakes** the system sets for itself |
| one machine | **a network of nodes** that share the work |

If you are interested in the foundation, start with PAI. REGOČ is what happens when you push
that foundation to multi-agent work with accountability.

---

## 2. The name and the core idea

REGOČ is an acronym for *REsursni Gestor za Orkestraciju Članova* (roughly "Resource Manager for
Orchestrating Members"), but the name comes first of all from Croatian folklore — Regoč is a
giant from the stories of Ivana Brlić-Mažuranić, good-natured and slow, but once he gets going,
he moves mountains. The other agents carry names from the same world: Kosjenka, Jelena, Malik,
Potjeh, Stribor. This is not decoration. A name that means something is easier to remember and
easier to talk about — "ask Kosjenka" is shorter and clearer than "run an architecture analysis".

A classic assistant works inside a conversation: you ask, it answers, it forgets. That breaks
down on three things:

1. **work longer than a single reply** — if the session is interrupted, the work is lost;
2. **several jobs at once** — one conversation cannot hold five threads;
3. **accountability** — afterwards nobody knows who did what and why.

REGOČ answers all three with the same move: **work lives in the database, not in the
conversation.** The conversation is just a way to write something into the database or read it
back. If a session dies, the task is still there, with its history and notes, and someone else
can pick it up.

---

## 3. Layered architecture

```
┌─────────────────────────────────────────────────────────────┐
│  CHANNELS      messages · voice · web board · command line  │
├─────────────────────────────────────────────────────────────┤
│  DAEMON        reads messages · routes · launches agents    │
│                pulls work from the queue · meters usage     │
├─────────────────────────────────────────────────────────────┤
│  AGENTS        coordinator + specialists, each own model    │
├─────────────────────────────────────────────────────────────┤
│  KNOWLEDGE     skills · hooks · memory · semantic store     │
├─────────────────────────────────────────────────────────────┤
│  TASKMANAGER   tasks · queue · projects · change history    │  ← single source of truth
├─────────────────────────────────────────────────────────────┤
│  MODELS        cloud (stronger) · local (cheap and private) │
└─────────────────────────────────────────────────────────────┘
```

The arrows go both ways, but one rule is hard: **every layer that does something must record it
in TaskManager.** The layer above does not trust the memory of the layer below.

More detail: [ARHITEKTURA.en.md](ARHITEKTURA.en.md).

---

## 4. The team

Instead of one all-knowing assistant, the system has a role per job. Each has its own
personality, its own domain and **its own model** — a stronger one where judgment is needed, a
cheaper one where speed is needed.

| Agent | Role | What it actually does |
|---|---|---|
| **REGOČ** | coordinator | splits up the work, assembles the result, does not execute itself |
| **Kosjenka** | architect | asks questions until the idea holds up; keeps the glossary and decisions |
| **Jelena** | engineer | writes and changes code, works in a test-then-write cycle |
| **Malik** | security | looks for how this could be abused |
| **Manda** | researcher | reads sources, brings back facts with links |
| **Dora** | analyst | the same problem from several angles, looks for what everyone misses |
| **Potjeh** | quality assurance | doubts other people's work, including our own |
| **Grga** | designer | interfaces and visual language |
| **Gita** | visual content | images, diagrams, illustrations |
| **Klaudio** | messaging channel | the link to the human through chat, around the clock |
| **Stribor** | voice | speech to text and text to speech |

The usual flow of work goes **Kosjenka → Jelena → Potjeh → Malik**: first the idea is sharpened,
then written, then checked, then attacked. Each step is a task in the database, so afterwards
you can see exactly where something got stuck — and it always gets stuck in the same place, at
the step someone skipped.

The principle that holds it all together: **the coordinator does not execute.** When REGOČ
starts doing the work itself instead of assigning it, the system turns into one long
conversation and we are back to the original problem. This happens more easily than it
sounds — for the coordinator it is always faster to do it than to explain it.

There is also a mechanism that assembles the team on its own: from the job description the
system infers which chain of roles is needed and opens the tasks in order, instead of a human
naming every participant.

More detail: [TIM.en.md](TIM.en.md) and [IDENTITET.en.md](IDENTITET.en.md).

---

## 5. The daemon — the part that works when nobody is watching

One process runs constantly in the background. It is the reason the system answers at three in
the morning.

**The loop looks like this:**

1. **Reads incoming messages** from a separate message database. A message can come from a
   human or from an agent.
2. **Decides who it belongs to** (see the next chapter).
3. **Launches an agent on demand** — as a separate operating system process, with a deadline
   and a limit on how many may run at the same time.
4. **Pulls work from the queue.** If there are no messages, it looks at the execution queue,
   which a trigger in the database fills with priority 1 tasks on its own.
5. **Meters its own usage** and uses that to decide whether it may continue.
6. **Watches for stuck tasks** — one that sits in progress for too long is returned or flagged.

**Why agents are not permanent processes.** We tried that too. A permanent agent holds memory
while it waits, and when the main session is interrupted it dies along with it — silently, so
nobody knows the work has stopped. Over a period of a few weeks we recorded dozens of such
silent deaths. Launching on demand means every agent is a separate process with its own
lifetime; if it crashes, the task in the database stays "in progress" and the next pass can
pick it up.

Alongside the daemon there is also a **watchdog** that brings it back up if it crashes. Without
it, nobody notices the crash until the next time something is needed — and that can be the
next day.

---

## 6. Message routing

When a message arrives, someone has to decide whose it is. This is done by classification in a
few steps:

1. **Explicit naming.** "Kosjenka, do an analysis" — goes to Kosjenka.
2. **Command versus question.** "What does Kosjenka do?" does **not** go to Kosjenka but to the
   researcher, because it is a question *about* her, not a task *for* her. It is recognized by
   the question mark and by question words.
3. **By domain.** Without a name, the message goes to whoever's domain covers it — code to the
   engineer, a security question to security, research to the researcher.
4. **Fallback.** If nothing matches, the coordinator takes the message.

The difference between the second and first steps looks minor, but it is not: without it,
every mention of an agent launches that agent, so a conversation about the system launches half
the system.

**Message batching.** Channels like Telegram split long text into parts. Without protection,
the agent answers each part separately, so one question gets seven answers. The message queue
therefore collects everything from the same sender within a few seconds and merges it into one.

---

## 7. Background sessions

This is the part most often misunderstood, so it is worth separating the concepts.

**A session is a conversation thread tied to a channel.** When a message arrives, the daemon
does not start an empty conversation but **continues the existing one** for that channel. Each
channel has its own session identifier, so a conversation in one group knows nothing about a
conversation in another. That is why you can say a week later "continue that thing from
yesterday" and the system knows what you mean.

**A session outlives the process.** The process that answers a message lives for a few seconds
or minutes. The session lives for weeks. After the reply the process disappears, but the thread
stays recorded and the next message continues it.

**An interruption is not a loss — but only for what has been recorded.** The connection to the
model can break in the middle of a reply. The process then exits with an error, and the session
stays intact. What is lost is **work that was not recorded anywhere except in the
conversation**. Once, an eight-minute research job vanished with one such interruption, because
it had only been reading along the way and had not opened anything. Hence the most important
rule of the system:

> Progress must be durable: in the database, in a file and in git. Never only in the agent's head.

**Context is compacted, not discarded.** When a conversation grows, the older part is
summarized and the summary goes into the next pass. The consequence for how you work: whatever
must survive compaction must not stay only in the conversation — it has to go into a task, a
note or a file.

**A session is not the same as usage.** Alongside the conversation thread, the system
separately tracks how much quota has been used in the current period. The two concepts are
easily confused because both are called a "session" — the first is what is remembered, the
second is what is spent. The brakes in chapter 12 look at the second.

---

## 8. TaskManager at the center

This is the part that is the reason this document sits in this repository.

**Every job is a task.** Not "remember that I need to", but a record with an owner, a priority
and a state. If the job is not in the database, the job does not exist. It sounds rigid until
you lose your first larger piece of work.

**State changes immediately, not at the end.** As soon as an agent starts working, the task
goes to "in progress". A human looks at the board and sees who is on what — a task sitting in
"waiting" while it is being worked on lies about the state of the system. That is why going
straight from "waiting" to "done" is not allowed: it takes two steps.

**Priority 1 is an execution order.** You open a task with priority 1 and a trigger in the
database puts it into the queue on its own; the daemon picks it up without a single further
call. Priority is not just ordering but a switch.

**Assignment is launch.** A task with an owner means that agent will be launched. If a human is
doing the work themselves, they assign the task to the coordinator and flag it so supervision
leaves it alone.

**Closing requires evidence.** A task cannot be closed without a summary of the result. The
system rejects an empty close and suggests marking the task as blocked with a reason — this is
deliberate, because "done" without a trace is the same as "I don't know what happened".

**The trail remains.** Every field change is written to history. When three weeks later you ask
why something is the way it is, the answer is in the database, not in someone's memory.

**Projects bring things together.** A larger job is a project with a specification; tasks are
created from the specification, and the specification's history is kept alongside them, so
you can see how the intent changed.

More detail: [ZIVOTNI_CIKLUS_ZADATKA.en.md](ZIVOTNI_CIKLUS_ZADATKA.en.md) and [BAZE.en.md](BAZE.en.md).

---

## 9. Model selection

No model is best at everything, and the price difference between the strongest and a perfectly
decent one can be tenfold. That is why there is a layer that chooses a model for each job.

**The rule is that the model is never written in code.** The router chooses it, based on the
role and the difficulty of the job. It is also practical: when a new model comes out, one
setting changes, not twenty places.

| Kind of job | Where it goes |
|---|---|
| judgment, architecture, security | the strongest model in the cloud |
| conversation, short answers, channels | a mid-tier model, fast and cheap |
| classification, summarization, data extraction | **a local model** |
| embeddings for semantic search | **a local model** |

Local models are not there only because of cost but also because of privacy: what does not
have to be sent out is not sent out. Several providers are supported, so the same job can be
run through different servers without changing code.

On top of that, **usage per call** is measured — which agent, which task, how many tokens, how
much it cost. Without that measurement there are no brakes from chapter 12 either.

---

## 10. Context, skills and hooks

This is the layer inherited from PAI and the most heavily refined one.

**Context at startup.** Every session begins by loading what always applies: who the system
is, what the rules are, what the services are, what was worked on recently. This avoids
spending the first part of every conversation explaining the obvious.

**Skills.** Knowledge packaged into folders of instructions that load only when needed. We
have 45 of them — from writing documents and working with spreadsheets, through research and
security reviews, to narrowly technical ones like fixing firmware. A skill is invoked by name,
and the system recognizes on its own when a given one is appropriate.

**Hooks.** Programs that run at a precisely defined moment in the workflow. We have 24 of them,
and they hold everything that must be automatic:

- loading context and a greeting at the start of a session;
- **a security check before every tool call** — a command that would print a secret or touch a
  protected path is stopped before it runs;
- recording what the agent produced, for later review;
- recording ratings and satisfaction, both stated and inferred;
- a session summary at the end;
- checking that the daemon is running, on every startup.

Hooks are the quieter part of the system, but the one that prevents the most. The security
check has stopped us several times in the middle of a command that would have printed a secret
into the conversation log — and from there it can no longer be deleted.

---

## 11. Memory and knowledge

There are three levels, and they differ in how long they live.

**Session memory** lives as long as the conversation thread. It is compacted when it grows.

**Persistent memory** is short files, one fact per file, with an index at the entrance. It holds
things that will still be true in three months: how something is set up, what the user asked to
be done differently, where a given file is. It does not hold what can be seen from the code or
the history anyway.

**Knowledge graph and semantic search.** Notes, findings and lessons learned, with links
between them. Alongside them is an embedding store, so searches go by meaning, not by word.

The rule that turned out to be the most useful: **before you say "I don't know", search the
knowledge.** Most questions that look new already have an answer from a few months back.

The second rule is about mistakes: **don't delete, archive.** A failed attempt is renamed, not
removed. We lost a day of work because a "cleanup" took away the only evidence of what had gone
wrong.

---

## 12. Brakes and autonomy

A system that assigns work to itself must have a place where it stops. It has several, and
they deliberately overlap.

**Usage meter.** A dedicated routine tracks how much quota has been used in the current period
and in the week. The daemon refreshes it **itself**, independently of the agents. The reason
was learned the hard way: while metering depended on agents running, stopping the agents also
switched off the meter, the meter went stale, and the system read the stale value as "all
good" and started working at full speed. Exactly at the moment it was least allowed to.

**Autonomy levels.** Based on the percentage used, the system steps itself down:

| Used | Behavior |
|---|---|
| below the first threshold | autonomy runs, the system pulls work from the queue on its own |
| above the first | autonomy stops, work goes task by task, on command |
| above the second | no multiple agents at once, confirmation required before starting |
| above the third | it answers, but nothing is executed until the quota resets |

On top of that there is a weekly threshold: once it is crossed, autonomy stops pulling work on
its own. **A human's command passes through every level** — the brake switches off
self-direction, not responsiveness. This is an important difference: a system that stops
answering seems broken, while a system that stops giving itself work seems sensible.

**The closed-door principle.** If metering fails, the system assumes the worst and shuts
itself down. The only exception is a machine on which metering has never worked — there,
shutting down would mean the new system never starts.

**Concurrent agent ceiling.** How many agents may run at the same time is neither an
environment variable nor a number in code, but a setting in TaskManager itself, changeable live
on the Config page (default 3). The daemon reads it within five seconds at most, so going from
one to three needs no restart. Lowering it interrupts nobody — new ones are just not let in
until there are fewer. Autonomy levels still take precedence: above the second threshold at
most one runs, however high the ceiling. A lesson from production: while the ceiling came from
the container environment, a forgotten `=1` from an old configuration kept the system running
serially without anyone seeing it on the board.

**The handbrake.** There is also a button: pause globally or per task. Pausing does not change
the task's state, so work resumes exactly where it stopped. Cancelling is **not used** for
this — it is a final state with no way back.

**Scope limit.** An agent working on a task must not touch files along the way that have
nothing to do with that task. There is a check that stops this — because the most expensive
kind of mistake is the one nobody asked for.

**The on-call.** Everything described so far assumes the main model is working, just that it
must not work too much. When the main model **does not answer at all** — a provider outage, an
expired login, exhausted quota, our own service down — the brakes do not help, because there is
nobody to obey them. For that there is the on-call: a backup model that determines the cause
itself, reports it and, if configured to do so, temporarily takes over the conversation. The key
difference from the autonomy levels: the levels limit how much work the system gives itself,
while the on-call makes sure the system stays reachable at all until the main path comes back.

More detail: [VRATA_I_KOCNICE.en.md](VRATA_I_KOCNICE.en.md).

---

## 13. Checks before anything is declared done

The biggest problem in working with agents is not a wrong answer but **a confident wrong
answer**. That is why there are several checks.

**Five steps before saying "done":** establish exactly what is being claimed, run it, read the
outcome, compare it with what was expected, and only then make the claim. Skipping the third
step is the most common cause of a false "it works".

**A prescribed status instead of a free description.** The result is one of: done, done with
reservations, blocked, need context. A free description allows "it's mostly done", which means
nothing.

**The skeptic.** A separate pass that reads someone else's result and looks for holes. For
larger changes several are chosen with different viewpoints, because three identical views are
not a check but an echo.

**No hardware, no claim.** If the work is firmware for a device that is not connected, the
outcome is "needs verification on hardware", not "fixed". This rule came about after a series
of "fixes" that had never even been compiled.

More detail: [PRAVILA_ISPORUKE.en.md](PRAVILA_ISPORUKE.en.md).

---

## 14. Services

The system is a set of processes that a single script starts, stops and checks.

| Service | What it is for |
|---|---|
| **Daemon** | the heart of the system: messages, routing, launching agents, the queue |
| **Task board** | web interface and API — this is TaskManagerAI |
| **Messaging bridge** | the link to the chat channel, around the clock |
| **Voice server** | text-to-speech conversion |
| **Speech recognition** | speech-to-text conversion, entirely local |
| **Embedding store** | semantic knowledge search |
| **Local models** | cheap and private jobs |

The status check works by having each service answer its own health check, and the script
queries them in turn. **A running process does not yet mean a working service** — the proof is
the answer to the check, not the existence of the process. We learned this after the script
kept reporting "already running" for a process that was a leftover from testing, while the real
service was not listening at all.

The same goes for the network: an answer on the main address does not prove the socket for the
live stream is working too. For that you need to ask for its own answer.

---

## 15. Node network

The system does not have to live on a single machine. There is a variant in which the same
system runs on several smaller nodes — portably, in virtual machines — so work can be moved
closer to where it originates or be distributed.

This required two mechanisms:

- **A list of allowed capabilities per node.** A node does not get everything, only what it is
  allowed; extending permissions requires approval.
- **A shared view of the work.** Tasks are still in the database, so a node that takes over a
  job knows where the previous one left off.

The rule that applies here without exception: **a secret goes to a remote machine only with
explicit approval.** A virtual machine gets cloned, and everything inside it moves with the
clone.

---

## 16. Lessons learned

The list is short because every item on it was paid for dearly.

1. **Durability before speed.** Work that is not recorded is lost at the first interruption.
   Record first, work after.
2. **The meter must be independent of what it measures.** Otherwise it stops working exactly
   when you need it.
3. **A running process does not mean a working service.** The proof is the answer, not the
   existence of the process.
4. **Don't delete, archive.** Evidence of a mistake is worth more than a tidy folder.
5. **A signed document is not a verified document.** Numbers need to be recalculated before
   signing.
6. **Doubt your own summary.** When an agent says something is done, check the outcome, not the
   claim.
7. **Names are useful.** A role with a name and a personality is easier to call on and easier to
   talk about.
8. **Set up the brake before you need it.** Afterwards it is always more expensive.

The extended version with causes and safeguards: [LEKCIJE.en.md](LEKCIJE.en.md).

---

## 17. What you need from this

If you are building your own system, this is the order I would recommend:

1. **Set up TaskManager and nothing else.** Open tasks by hand for a week. You will see what
   workflow you actually need, instead of guessing it.
2. **Write one agent that pulls from the queue.** A loop of about ten lines: take a task, do
   it, close it. There is an example in [docs/API.md](../docs/API.md).
3. **Only then add a second one.** Once there are several, you will need routing — and that is
   the moment a coordinator makes sense, not before.
4. **Set up usage metering before you switch on autonomy.** Without a number you have no brake,
   and without a brake autonomy is a question of when, not if.
5. **Write down the rules you have learned.** A system without written rules repeats the same
   mistakes, only faster.

The order is not arbitrary. We did some of these steps the other way around, and each one sent
us back.

The minimal recipe with the order to switch things on: [SLOZI_SVOJ.en.md](SLOZI_SVOJ.en.md).

---

## 18. Acknowledgements

- **[PAI — Personal AI Infrastructure](https://github.com/danielmiessler/PAI)**, Daniel Miessler
  (MIT). The foundation all of this stands on: the idea of personal infrastructure, skills,
  hooks, context loading and the prescribed response format.
- **[Tasks.md](https://github.com/BaldissaraMatheus/Tasks.md)**, Matheus Baldissara (MIT).
  The starting point of the task manager and the idea of a board you keep with you.
- **Claude Code** as the environment the agents work in.

REGOČ is what came out of joining those two foundations and pushing them to multi-agent work
with accountability. If you are building something similar, start with them — the savings are
measured in months.
