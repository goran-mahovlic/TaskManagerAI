// ─── Izvršitelj razgovora (ADR-0002 §6.1) ────────────────────────────────────
// Isti port i ista izvedba kao orkestrator (`CliExecutor`) — nema druge kopije koda za spawn.
// Ovdje je samo konfiguracija naredbe i pronalazak CLI-ja.
//
// Prompt ide kroz STDIN, ne kao argument: `--allowedTools <alati...>` je variadičan i
// progutao bi prompt koji stoji iza njega.
//
// Autorica: Jelena (Engineer), TASK-5277.

import { existsSync } from 'fs'
import { join } from 'path'
import { CliExecutor } from '../core/orchestrator/Executors'
import type { ExecutorConfigCli } from '../core/orchestrator/OrchestratorConfig'

/**
 * Putanja do `claude`: `TM_CLAUDE_BIN` → PATH → `~/.local/bin/claude` (zadano mjesto
 * instalacije CLI-ja). Usluga pod systemd-om često nema `~/.local/bin` u PATH-u.
 */
export function nadjiClaude(env: Record<string, string | undefined> = process.env): string {
  if (env.TM_CLAUDE_BIN) return env.TM_CLAUDE_BIN
  for (const mapa of (env.PATH || '').split(':').filter(Boolean)) {
    const p = join(mapa, 'claude')
    if (existsSync(p)) return p
  }
  if (env.HOME) {
    const p = join(env.HOME, '.local', 'bin', 'claude')
    if (existsSync(p)) return p
  }
  return 'claude'
}

export function izvrsiteljRazgovora(o: { bin?: string } = {}): CliExecutor & { cfg: ExecutorConfigCli } {
  const cfg: ExecutorConfigCli = {
    kind: 'cli',
    command: o.bin || nadjiClaude(),
    args: ['-p', '--output-format', 'json'],
    promptChannel: 'stdin',
    promptFlag: null,
    modelFlag: '--model',
    systemPromptFlag: '--append-system-prompt',
    sessionIdFlag: null,
    resumeFlag: '--resume',
  }
  const ex = new CliExecutor('razgovor', cfg) as CliExecutor & { cfg: ExecutorConfigCli }
  ex.cfg = cfg
  return ex
}
