# Contributing

## Activate the git hooks (one line, do it right after cloning)

```bash
git config core.hooksPath .githooks
```

`.git/hooks` is not part of `git clone`, so a hook only takes effect once the clone is told
where the versioned hooks live. `scripts/install.sh` does this for you when it runs inside a
clone; if you set the repository up by hand, run the line above yourself.

## What the hooks enforce

`.githooks/commit-msg` refuses a commit when:

1. the message contains `Co-Authored-By: … Claude` or `noreply@anthropic.com` — no trace of the
   tool that helped write a change belongs in this history;
2. the author or committer address is not on the list in
   `git config taskmanagerai.dopusteniAutori` (comma-separated). A clone without that list skips
   this check — there is no built-in default identity:

   ```bash
   git config taskmanagerai.dopusteniAutori "you@example.com,second@example.com"
   ```

Both checks look at the commit that is about to be made, not at what is configured: the identity
is read through `git var GIT_AUTHOR_IDENT` / `GIT_COMMITTER_IDENT`, which also catches an address
injected through `GIT_AUTHOR_EMAIL` in the environment.

Why this exists: commit
[241aa89](https://github.com/goran-mahovlic/TaskManagerAI/commit/241aa8961fcc62ab5724325004452194bc84045f)
reached the public repository carrying the orchestrator's own identity and a
`Co-Authored-By: Claude` trailer, while every other commit of that day was clean. Commits here
are made by hand, so a single lapse is enough — a rule that lives only in a document is not a
mechanism. This one is: git rejects the commit before it exists.

## Committing under a different identity

If a different address is deliberate, open it explicitly — once, per clone:

```bash
git config taskmanagerai.dopusteniAutori "someone@example.com"     # comma-separated list
```

Anything not on that list is refused.

## Tests

```bash
bun test                              # everything
bun test tests/commit-msg-hook.test.ts   # the hook itself, in a throwaway repository
```

The hook test builds a real repository, points it at `.githooks`, and checks the exit status of
`git commit` for both the rejected and the accepted case. It tests the shipped file, so editing
the hook without keeping it honest breaks the suite.
