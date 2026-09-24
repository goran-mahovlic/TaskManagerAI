# Databases

[Hrvatski](BAZE.md) · [Back to overview](README.en.md)

The system has three SQLite stores with different lifetimes and one semantic knowledge base.
There is no database server, user or password for the SQLite part: copy the files and the
system has moved.

---

## Three SQLite stores

| Store | What it holds | Who writes | In the package |
|---|---|---|---|
| **Tasks and projects** | tasks, projects, history of every field change, specification history, execution queue, settings and their history | the board (single entry point for creation), orchestrator, tools | `$TM_HOME/data/tasks.db` (`TM_DB`), schema `db/schema.sql` |
| **Messages** | queue of incoming and inter-agent messages, fuse state | message ingest, orchestrator | `messages.db` (`src/core/MessageQueue.ts`) |
| **Cost** | one row per model call: agent, task, model, tokens per class, price | the runner after each spawn | table `cost_log` (`src/core/CostTracker.ts`) |

Why messages are separate: the message queue is traffic, not data about work. A fuse counter or
an unread message must not get mixed into the database from which the state of work is
computed. In the package, cost is a table in the main file (attribution to a project is done by
joining with the task, see [TROSAK_I_ENERGIJA.en.md](TROSAK_I_ENERGIJA.en.md)), but it is
logically a separate store: it is append-only, never modified.

`db/schema.sql` is the single source of truth for the schema — exported from a working
database, not written by hand. `bun run init` is safe to repeat (`docs/DATABASE.md`).

---

## WAL and why backups are made with `VACUUM INTO`

All databases run in **WAL** mode (*write-ahead log*): the board reads while agents write,
without waiting on each other. On top of that, `busy_timeout` is 5 s, so a brief lock does not
mean an error.

A consequence of WAL: part of the written data sits in the companion `-wal` file, not in the
main one. **A plain file copy while the server is running gives an incomplete state** — the
main file without the latest changes or, worse, a pair of files from two different moments.

SQLite has a command for this, `VACUUM INTO`: it works in the middle of writes, produces a
consistent snapshot of a single moment and compacts the file along the way.

```bash
bun scripts/backup.ts          # snapshot into $TM_HOME/backups/, with a timestamp
```

The last 14 snapshots are kept (`TM_BACKUP_KEEP`). Never `cp` while the server is running.

### Tests must not write to the live database

In the original system, tests without an explicit path wrote test tasks straight into the
production database. The orchestrator took a test task with an assignee as real work and
launched three expensive sessions on garbage (see [LEKCIJE.en.md](LEKCIJE.en.md)). Since then
there is a structural barrier (`src/core/LiveDbGuard.ts`): a process in a test environment
cannot open the live database for writing. The emergency exit is explicit:
`REGOC_ALLOW_LIVE_DB_IN_TEST`.

---

## Two timestamp formats, one ordering rule

The database contains **two forms** of timestamp, because they are written by different paths:

```
created_at    2026-08-28T11:07:02.561Z     (ISO, from the application)
updated_at    2026-08-28 11:07:02          (SQLite, from a trigger)
```

Both carry the same time — only the characters differ. But string comparison fails on this:
`T` (0x54) is greater than a space (0x20), so within the same day the ISO form would **always**
win regardless of the time. The "newest on top" ordering was silently lying.

The solution is one rule in one place (`src/core/ChronoOrder.ts`):

1. every timestamp is normalised to the same form before comparison;
2. a task's activity time is the completion time for closed tasks, the last-change time for the
   others, and the creation time as a fallback — a row is never left without a key;
3. ties are broken by the **numeric** part of the ID (as a string, `TASK-999` is "greater" than
   `TASK-1000`);
4. the same ordering applies to tasks, projects and drop-down menus.

Before this, the ordering was written in three places (database layer, projects, board
JavaScript) and they diverged. One ordering rule means one module, not three kept in sync.

---

## RAG — semantic knowledge base

Next to SQLite there is an embeddings database for search by meaning: **ChromaDB** in the
package (`src/rag/`, settings in `src/rag/memory-config.ts` or environment variables). In the
original system there is also **pgvector** (PostgreSQL) as a second backend, with the same
interface towards agents; embeddings are produced by a local model.

### Write gatekeeper: project and type are mandatory

A write without `project_id` and without a type (`tip`) is **rejected**. The reason was
measured: a corpus of almost 9,000 documents had **zero** such labels, so knowledge could not
be cross-referenced with the board — "what do we know about this project" had no answer.

A second lesson came right after the first. After the gatekeeper was introduced, coverage of new
writes was only 10 %, because **90 % of writes were made by automation** (a session summary at
the end of work) directly, bypassing the gatekeeper. The decision:

- coverage is measured **only for intentional writes** (by a human or an agent as a conscious
  decision);
- automatic writes are labelled as such and assign a project only when the environment knows
  it — they do not invent one. An invented project for 90 % of the corpus would poison exactly
  the cross-reference the gatekeeper was introduced for.

### Research must end up in RAG

A task tagged `istrazivanje` ("research") does not pass into `completed` without the ID of a
stored document in the result (`src/core/ResearchRagGate.ts`). The reason: transcripts are kept
for about 30 days, so paid research that lived only in a conversation was disappearing — and the
same work was being ordered again. This gatekeeper may go live immediately, because it is not a
heuristic: it checks the tag and a literal ID.

### Protected collections

Collections that are read at session start (summaries of previous sessions, learned lessons,
language reference) must not be excluded from search or deleted without an explicit decision.
`tools/rag_archive.py --drop` refuses to remove them, and an export is made before every
removal. Cleanup is run by a tool, and the tool does not know what is valuable.

See also: [ARHITEKTURA.en.md](ARHITEKTURA.en.md) · [TROSAK_I_ENERGIJA.en.md](TROSAK_I_ENERGIJA.en.md)
