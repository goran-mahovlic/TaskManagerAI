# Tasks waiting for a decision

Some tasks should not start on their own. Tagging one `needs-decision` (or `no-autonomy`,
`waiting-for-human`, `interactive`) keeps every automation away from it until a person decides.

The board shows those tasks in a bar above the columns, with a field for the decision and a
**Continue** button. The decision is stored with the task — later you can see not only that it
started, but why and who released it.

## Letting a model decide instead

Switch on **"Let a model decide for me"** in that same bar and pick a provider and model. The
model then chooses one of three words:

| Word | Meaning |
|---|---|
| `KRENI` (go) | the task is clear and safe to start |
| `ODGODI` (postpone) | not now; it keeps waiting |
| `COVJEK` (human) | needs a person's judgement |

Its decision is written through the same API a person uses, so the audit trail is identical —
only the signature differs: `ODLUKA (odlucitelj (ollama/qwen3:8b), …)`.

Use **Dry run** first: it shows what the model would decide and changes nothing.

## The risk filter, and why it exists

A deterministic filter runs **before** the model. Anything matching money, deletion, external
effect, secrets, irreversible change — or a description too vague to judge — goes straight to
the human. The model never sees it and can never overrule the filter.

This is not caution for its own sake. Measured on `qwen3:8b`, without the filter the model
answered "go" to **6 of 7** risky tasks: a 500 EUR purchase, deleting RAG collections, sending
a quote to a client, switching a live input on for a real chat group, and the description
"fix whatever is broken". Its reasoning read convincingly every time — *"the task is clear and
harmless"* — which is precisely the problem: how convincing an answer sounds is not a measure
of how sound the judgement is.

With the filter in place: **7 of 7** correct. On a real queue the split was 5 to the human,
7 to the model — strict enough to be safe, loose enough to be useful.

The filter behaves the same whichever model decides. Verified through OpenRouter as well: a
task with external effect and one touching secrets both went to the human, while the harmless
one went through.

## Providers

Every provider in `models/model-config.json` appears in the selector. Those without a key are
shown with the reason (`needs GLM_API_KEY`) and cannot be selected — hidden entries would look
like the system lacks them, when it merely lacks the key. Add the key and the provider becomes
selectable, no code change.

| Provider | How it is called | Note |
|---|---|---|
| `ollama` | local HTTP | default; costs nothing |
| `openrouter` | OpenAI-shaped | 400+ models; free ones and auto-routers listed first |
| `anthropic` | Claude CLI | uses your subscription — **the same quota that runs your work** |
| `google` | Gemini REST | needs `GOOGLE_API_KEY` |
| `glm`, `kimi`, `minimax`, `qwen`, `deepseek` | Anthropic-shaped `/v1/messages` | need their own key |

**`openrouter/auto`** is worth knowing about: the router picks a model per request, so you do
not have to guess a model name. Verified — it selected `deepseek-v4-flash` on its own and
answered correctly.

Prefer a local model as the default. Deciding about a task should not cost more than the task,
and the Anthropic path spends the very quota your agents need to do the work.

## Settings

`config/odlucitelj.json`:

```json
{
  "ukljucen": false,
  "provider": "ollama",
  "model": "qwen3:8b",
  "baseUrl": "http://192.168.10.4:11434",
  "najvise_po_prolazu": 3,
  "smije_kreni": true
}
```

`ukljucen: false` is the default on purpose — nothing decides on your behalf until you say so.
Setting `smije_kreni: false` lets the model only postpone or escalate, never start work: a
useful middle step while you build trust in it.

## What a decision does

Beyond writing the answer, a decision tags the task `nalog` ("order"). In REGOČ that tag lets
the task through the autonomy gate even when the quota threshold has stopped self-directed
work — an explicit release is not autonomous work. Weekly caps and the manual pause still
apply; they stop orders too.
