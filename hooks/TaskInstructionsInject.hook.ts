#!/usr/bin/env bun
// TaskInstructionsInject — dostava dodatnih uputa agentu DOK RADI (TASK-5013).
//
// Claude Code hook za PostToolUse i SessionStart. Izvođač (src/core/orchestrator/Executors.ts)
// agentu u okolinu stavlja TM_TASK_ID; bez njega hook odmah izlazi. Adresa ploče:
// TM_URL ili http://localhost:${TM_PORT:-17781}. Registracija: docs/UPUTE-AGENTU.md.
// FAIL-OPEN: svaki kvar (ploča ugašena, rok 300 ms, smeće) → izlaz 0 bez ispisa.
if (!process.env.TM_TASK_ID && !process.env.REGOC_TASK_ID) process.exit(0)

try {
  const { runInstructionHook } = await import(`${import.meta.dir}/../src/core/TaskInstructions.ts`)
  const stdin = await Bun.stdin.text()
  const out = await runInstructionHook({ env: process.env as Record<string, string | undefined>, stdin })
  if (out) process.stdout.write(out)
} catch { /* fail-open */ }
process.exit(0)
