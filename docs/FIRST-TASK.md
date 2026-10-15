# Your first task in fifteen minutes

*Hrvatska inačica: [PRVI-ZADATAK.md](PRVI-ZADATAK.md).*

This is the shortest path from a fresh clone to one task that an agent picks up, works on
inside your repository, and closes with evidence. Seven steps. Each one ends with a check that
tells you it worked, and names the mistake people make at that step.

It is not the install guide. For running the board as a service, backups, upgrades and every
setting, see [INSTALL.md](INSTALL.md). For what to add after the first task (knowledge base,
input channels, oversight), see [SUSTAV.md](SUSTAV.md).

**You need:** macOS or Linux, [Bun](https://bun.sh) 1.1 or newer, the Claude Code CLI signed
in (`claude --version` prints a version), and a git repository you want the agent to work in.
The board also works with other CLIs and with Ollama; this walkthrough uses Claude because it is
the default executor.

---

## 1. Start the board

```bash
git clone https://github.com/goran-mahovlic/TaskManagerAI.git
cd TaskManagerAI
bun install
bun run init          # creates ~/.taskmanager/data/tasks.db from db/schema.sql
bun run start         # board + API on http://localhost:17781
```

**Check:** in a second terminal, `bash scripts/health.sh` prints `U redu.` (OK), and
http://localhost:17781 shows the board.

**Pitfall:** port 17781 already in use. Set `TM_PORT` in `.env` (copy `env.example`) and
restart. Nothing else in `.env` is needed for this walkthrough.

## 2. Create a project and give it a root folder

On the board: **Projects → + New project**. Fill in the name and, in **Root folder**, the
absolute path of the repository the agent should work in. Save.

Or through the API:

```bash
curl -X POST http://localhost:17781/api/projects \
  -H "Content-Type: application/json" \
  -d '{"name":"My app","root_path":"/absolute/path/to/my-app"}'
```

**Check:** the project appears in the list with a `PRJ-…` id, and `GET /api/projects` shows
your path under `root_path`.

**Pitfall:** the path must be absolute and must exist. The board rejects a missing folder with
`root_path_missing`. Without a root folder the agent runs in whatever directory the
orchestrator was started from, which is rarely what you want.

## 3. Add a task

On the board: **Tasks**, then the **+** button (Create New Task), or:

```bash
curl -X POST http://localhost:17781/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Add a CHANGELOG entry for the last release",
    "description": "WHAT: add a section for the latest tag to CHANGELOG.md. WHY: the release went out without notes. FILES: CHANGELOG.md, git log. DONE WHEN: the section lists every commit since the previous tag and the file is committed.",
    "priority": 2,
    "assignee": "regoc",
    "projectId": "PRJ-001",
    "createdBy": "user"
  }'
```

Write the description for someone who has never seen the repo: what, why, which files, and
what counts as done. The assignee is the name you will register in step 4. Any
`[a-z][a-z0-9_-]{0,31}` name works.

**Check:** the task shows in the **pending** column under your project.

**Pitfall:** a title with no description is rejected with `empty_or_fixture_task`. The
board's rule is that a task without content would send an agent to work with nothing in
hand, so it refuses to store one.

## 4. Register the agent

```bash
cp config/agents.example.json config/agents.json
```

Open `config/agents.json` and set `id` to the assignee from step 3. Leave `model` empty to
use the CLI's default model, and keep `"keywords": ["*"]` so the agent takes anything.

**Check:**

```bash
bun scripts/orchestrator.ts --stanje
```

`greske` (errors) must be an empty list.

**Pitfall:** an assignee that is not in the registry is the silent failure of this whole
setup. The board accepts the task, the orchestrator skips it every pass, and the only trace
is a line in the log saying `nema agenta` (no agent). The ids in `config/agents.json` are
the list of allowed assignees.

## 5. Enable the orchestrator and let the agent edit files

```bash
cp config/orchestrator.example.json config/orchestrator.json
```

Set `"enabled": true`. Then extend the Claude executor's arguments so a non-interactive
session can edit files and report back to the board:

```json
"args": ["--print", "--output-format", "json",
         "--permission-mode", "acceptEdits",
         "--allowedTools", "Bash(curl:*),Bash(git:*)"]
```

**Check:** `bun scripts/orchestrator.ts --stanje` says `"ukljucen": true` and
`"spreman": true`.

**Pitfall:** print mode cannot ask you for permission, so anything not allowed in advance is
denied. The flags above cover file edits, calling the board and committing. Because the agent
runs inside your repository, that repository's own `.claude/settings.json` allowlist applies
too. If your repo's skills run scripts (Python, a test runner), allow those there, or the
agent will tell you it was denied and work around it by hand.

## 6. Run one pass

```bash
bun scripts/orchestrator.ts --jednom     # exactly one pass
```

The task flips to **in progress**, and a `claude` process starts in your repository with the
task text as its prompt. For continuous operation run the loop instead, in its own terminal,
with the board still running:

```bash
bun scripts/orchestrator.ts
```

**Not from the board's Console.** The Console tab can run `bun` in WORK mode, but it kills
any command after 30 seconds, and a pass waits for the agent to finish. Start the loop once
as a service instead, after which everything else happens on the board
([INSTALL.md §6](INSTALL.md#6-sloj-1--pokreni-orkestrator-neobavezno)).

**Check:** on the board, **Status** shows a live spawn. `ps -ef | grep "claude --print"`
shows the process, and its working directory is your root folder.

**Pitfall:** print mode is silent until the end. Nothing streams to the board while the agent
works. To watch it think, open the newest transcript under `~/.claude/projects/` in the folder
named after your repository path. A second pitfall: if you press Ctrl+Z in the orchestrator's
terminal, both the orchestrator and the agent stop and the task sits in progress forever.
Type `fg` to resume.

## 7. Let it finish

The agent is expected to close the task itself through the API, with a result summary that
contains evidence: the commands it ran and their output, the files it changed, a commit. A
summary that just says "done" is refused by the board's completion gate.

**Check:** the task moves to **completed** and its result summary reads like a report you
could verify. If the agent could not finish, the task is **blocked** with a reason instead.

**Pitfall:** if the agent's process ends without updating the task, the orchestrator records
the outcome but leaves the task open, because only the worker may claim completion. Reclaim
the task from the board to send it back to pending, fix whatever the log shows, and run
another pass.

---

## What you have now

A board, one project tied to a repository, one agent, and an orchestrator that turns pending
tasks into work inside that repository. From here:

- More projects in different folders: one orchestrator serves all of them. Do not run one
  orchestrator per folder; they would compete for the same tasks.
- Watchdogs for stuck tasks start in shadow mode. [INSTALL.md §6](INSTALL.md#6-sloj-1--pokreni-orkestrator-neobavezno)
  explains when to switch them live.
- Every endpoint used above, with examples: [API.md](API.md).
- Growing this into a self-running system, layer by layer: [SUSTAV.md](SUSTAV.md).

---

## For the agent

If you are an agent reading this because your prompt pointed here, this is what the board
expects of you. Your prompt already contains the protocol; this is the context behind it.

- **You work in the project's root folder.** Your process was started there, and the prompt
  names it. Do not look for the repository elsewhere.
- **Mark in progress first, close with evidence last.** The board accepts `completed` only
  with a result summary someone can verify: commands and output, files changed, a commit
  hash. "Done" on its own is refused.
- **Blocked is a valid outcome.** If a tool, a permission or a piece of context is missing,
  set the task to `blocked` with the reason. Do not close it as done, and do not work
  around a denied command by faking its result.
- **Permissions are decided in advance.** You cannot prompt the user. If a command is denied,
  say so in the result and continue with what is allowed.
- **Your memory ends with this run.** The next task starts a fresh session. Anything the next
  agent needs must be in the task result, the repository, or a commit, not in your head.
- **End with the status line** your prompt asks for. The orchestrator reads the outcome from
  it.
