// ─── Straža ljuske razgovorne sesije (sigurnosni pregled TASK-5279) ──────────
// `--allowedTools` NIJE bijela lista za Bash: Claude Code sam propušta „read-only" naredbe
// (izmjereno 06.10.2026. na razini `citanje`: `ps aux` i `id` prošli bez ikakvog pravila, a
// `ps aux` ispisuje naredbene retke SVIH procesa). Zato se uz razine `citanje`/`rad` kroz
// `--settings` postavlja PreToolUse hook koji pokreće ovu skriptu: Bash prolazi SAMO ako je
// naredba doslovno jedna od naredbi ploče, sve ostalo se odbija (izlaz 2).
//
// Pokretanje: `bun BashStraza.ts <port>` — ulaz je JSON hooka na stdin.
//
// Autor: Malik (Security), TASK-5279.

import { naredbePloce } from './Ovlasti'

export function provjeriBash(ulaz: unknown, port: number): { ok: true } | { ok: false; razlog: string } {
  const u = ulaz as { tool_name?: unknown; tool_input?: { command?: unknown } } | null
  if (!u || typeof u !== 'object') return { ok: false, razlog: 'nečitljiv ulaz hooka' }
  if (u.tool_name !== 'Bash') return { ok: true }
  const naredba = typeof u.tool_input?.command === 'string' ? u.tool_input.command.trim() : ''
  if (naredbePloce(port).includes(naredba)) return { ok: true }
  return { ok: false, razlog: `razgovor smije pokrenuti samo naredbe ploče, doslovno: ${naredbePloce(port).join(' | ')}` }
}

if (import.meta.main) {
  const port = Number(process.argv[2])
  let ulaz: unknown = null
  try { ulaz = JSON.parse(await Bun.stdin.text()) } catch { /* ostaje null → odbij */ }
  const r = Number.isInteger(port) && port > 0 ? provjeriBash(ulaz, port) : { ok: false as const, razlog: 'straža bez porta' }
  if (r.ok) process.exit(0)
  process.stderr.write(r.razlog + '\n')
  process.exit(2)
}
