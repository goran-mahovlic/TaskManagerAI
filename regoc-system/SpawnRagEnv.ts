#!/usr/bin/env bun
/**
 * Pripis RAG upisa kroz okolinu spawna (R1b, TASK-4431)
 *
 * `skills/CORE/Tools/lib/rag-metadata.ts` čita `REGOC_TASK_ID` i `REGOC_PROJECT_ID` kao
 * zamjenu za `--task`/`-p`. RegocDaemon te vrijednosti ima izravno (`taskId` + ploča),
 * ali DURABILNI put (`AgentDaemon.executeClaudeTask`) ih nema u potpisu — dobiva samo
 * gotov prompt. Umjesto da se `taskId` provlači kroz pet slojeva poziva, čita se iz
 * prompta: oba podatka su u njemu doslovno i na stalnom mjestu jer ih piše isti sastavljač
 * (`buildAgentPrompt` → „Tvoj task ID: **TASK-…**" i `buildProjectTail` → „projectId: …").
 *
 * Ako obrazac ne postoji, vraća se prazan objekt — spawn ide dalje bez pripisa, kao dosad.
 */

/** „Tvoj task ID: **TASK-4431**" iz TASKMANAGER PROTOCOL odsjeka. */
const TASK_RE = /Tvoj task ID:\s*\*\*(TASK-\d+)\*\*/i
/** „projectId: REGOC_SYSTEM (REGOČ System)" iz odsjeka PROJEKT ZADATKA. */
const PROJECT_RE = /^\s*projectId:\s*([A-Za-z0-9_-]+)/m

export function ragEnvFromPrompt(prompt: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (!prompt) return out
  const t = TASK_RE.exec(prompt)
  if (t) out.REGOC_TASK_ID = t[1].toUpperCase()
  const p = PROJECT_RE.exec(prompt)
  if (p) out.REGOC_PROJECT_ID = p[1]
  return out
}
