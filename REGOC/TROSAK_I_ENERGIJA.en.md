# Cost and energy

[Hrvatski](TROSAK_I_ENERGIJA.md) · [Back to overview](README.en.md)

Without measuring consumption there are no brakes, and without attributing consumption to a
project there is no answer to the question "how much did this cost us". This document describes
both, as well as the estimate of electricity, CO₂ and water built on top of the cost — with an
honest explanation of why that estimate is a unit conversion, not a new measure.

---

## Cost per project

### Sources

| Source | What it provides | Note |
|---|---|---|
| **runner log** (`cost_log`) | one row per call: agent, task, model, tokens per class, price | when the model's CLI reports the price itself, that is a measurement and takes precedence over the tariff |
| **session transcripts** (`tools/run_tokens.py`) | tokens and price from each session's log | also covers work that did not go through the runner |
| **price list** (`src/core/CostTracker.ts`) | an estimate when there is no measurement | the same price list in both tools, so the same consumption does not have two prices |

Tokens are recorded **per class** (input, output, cache read, cache write), because the cache
accounts for about 96 % of traffic and class prices differ by up to 50 times.

### Task → project attribution

Cost rolls up to a project by **joining** `cost_log.task_id → tasks.project_id`, not by copying
the project into the cost row. A copy would be frozen at the moment of the spawn: when a task
later gets a project, the old rows would stay wrong forever. A join corrects itself.

Measured in the original system: **97 % of cost** reaches a project this way. The remainder is
sessions without a task ID (3 %) and tasks that do not exist in the database (0.004 %).

**Unattributed is a row of its own**, on equal footing with projects — never spread across
projects proportionally. Spreading invents cost: a project gets money that nobody spent on it,
and the figure changes every time a new project is created. A visible "unattributed" row is
also a measure of attribution quality: if it grows above ten percent or so, the prompt that
gives the agent the task ID has broken.

**In the package:** `GET /api/projects/trosak`, the project card on the board. Cost (what the
work cost) and list-price value (`tools/vrijednost_inputa.py`) are two figures in two columns —
never added together.

---

## Electricity, CO₂ and water — an estimate with a range

Model providers **do not publish** per-query consumption. There are only public estimates of
varying quality: one production measurement from one provider, models derived from hardware,
and derivations from public latency measurements. They all differ by up to an order of
magnitude.

### Formula per token class

```
E [Wh] = k(model) × ( input·c_in + output·c_out + cache_read·c_cr + cache_write·c_cw ) / 10⁶
```

The naive formula `(input + output) × factor` was rejected by measurement: it sees only
**13.7 %** of the energy, because it ignores the cache, which carries 96 % of traffic — it
**underestimates by a factor of 7.3**.

| Token class | Wh per million (central value) |
|---|---|
| input | 390 |
| output | 1,950 |
| cache read | 39 |
| cache write | 490 |

`k(model)` is the ratio of the model's input price to the mid-tier model (e.g. ≈ 1.67 for the
larger tier, 1.00 for the mid tier, ≈ 0.33 for the smallest). An unknown model gets `k = 1`
**and a flag**, never a silent zero.

### The range is always shown

| Quantity | Factor | Uncertainty band |
|---|---|---|
| energy | formula above | **÷3 … ×3** |
| CO₂e | 0.21 kg/kWh (EU-27 grid average) | **÷4 … ×4** |
| water | 1.1 L/kWh (on-site production measurement) | **÷10 … ×6** |

A narrower band would be a lie; a wider one would make the figure useless. An example from the
original system, one hundred days of work: **579 kWh (193 – 1,737)**, **122 kg CO₂e (30 – 487)**,
**637 L of water (64 – 3,823)**.

Water has the widest and an asymmetric band, and a stronger warning in the display: published
values differ by about 50 times, the accounting boundary is not agreed upon (data centre only,
or electricity generation too), and the region in which the query was served is not known.

### Why this is a unit conversion, not a new measure

The token-class coefficients are taken from the ratios in the **price list** (output 5× input,
cache read 0.1×…), and `k(model)` is the same price list along another axis. The consequence is
algebraic, not empirical:

```
390 / 3  =  1950 / 15  =  39 / 0.3  =  130 Wh per dollar of list-price cost
```

Energy is **cost multiplied by a constant**. The ranking of projects by energy is identical to
the ranking by cost (10 out of 10), and CO₂ and water are just a conversion of that conversion.
None of these figures carries **a single bit** of information that the cost in euros does not
already have.

So why are they shown: because "579 kWh ≈ two months of an average household" means something
to a person that an amount in euros does not. But the display must say so out loud:

- the `≈` sign next to every figure,
- a distinct colour that on the board means "not measured",
- the word "estimate" in visible text, not just in a hover tooltip,
- the method and range in the explanation.

A figure with content of its own requires a different physical basis — power × duration, or a
real measurement of a local model on your own hardware. No choice of coefficients derived from
a price list can achieve that; it is a property of the source, not of tuning.

**In the package:** cost per project exists; the energy estimate lives in the original system
and will come to the package as a separate module with coefficients in configuration, not in
code.

See also: [BAZE.en.md](BAZE.en.md) · [VRATA_I_KOCNICE.en.md](VRATA_I_KOCNICE.en.md)
