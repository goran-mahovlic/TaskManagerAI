// ─── Izvršitelj razgovora (ADR-0002 §6.1) ────────────────────────────────────
// Isti port i ista izvedba kao orkestrator (`CliExecutor`) — nema druge kopije koda za spawn.
// Ovdje je samo konfiguracija naredbe i pronalazak CLI-ja.
//
// Prompt ide kroz STDIN, ne kao argument: `--allowedTools <alati...>` je variadičan i
// progutao bi prompt koji stoji iza njega.
//
// Autorica: Jelena (Engineer), TASK-5277.

import { existsSync } from 'fs'
import { dirname, join } from 'path'
import { CliExecutor } from '../core/orchestrator/Executors'
import type { ExecutorConfigCli } from '../core/orchestrator/OrchestratorConfig'
import type { ExecRequest, ExecResult } from '../core/orchestrator/Ports'
import type { Ovlasti } from './Ovlasti'

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

/**
 * TASK-5733: putanja do `gemini`: `TM_GEMINI_BIN` → PATH → `~/.local/bin/gemini` →
 * `~/.local/node/bin/gemini` (tamo ga stavlja `install.sh --gemini-cli`).
 */
export function nadjiGemini(env: Record<string, string | undefined> = process.env): string {
  if (env.TM_GEMINI_BIN) return env.TM_GEMINI_BIN
  for (const mapa of (env.PATH || '').split(':').filter(Boolean)) {
    const p = join(mapa, 'gemini')
    if (existsSync(p)) return p
  }
  if (env.HOME) {
    for (const p of [join(env.HOME, '.local', 'bin', 'gemini'), join(env.HOME, '.local', 'node', 'bin', 'gemini')]) {
      if (existsSync(p)) return p
    }
  }
  return 'gemini'
}

/**
 * Ovlasti razgovora → način odobravanja Gemini CLI-ja. Bez terminala `default` odbija alate
 * koji traže potvrdu (ljuska, pisanje), pa `citanje` ostaje čitanje radne mape (gemini čita
 * samo unutar radne mape). `rad` smije uređivati, `puno` sve (`yolo`).
 */
export function argumentiGeminija(razina: Ovlasti): string[] {
  const nacin = razina === 'puno' ? 'yolo' : razina === 'rad' ? 'auto_edit' : 'default'
  return ['--approval-mode', nacin]
}

function geminiCfg(bin: string): ExecutorConfigCli {
  return {
    kind: 'cli',
    command: bin,
    // Isto kao daemon (RegocDaemon geminicli): `--skip-trust` jer nema terminala za potvrdu mape.
    args: ['--skip-trust', '--output-format', 'json'],
    // Kao u daemonu: prompt je argument `-p` (gemini stdin dodaje ISPRED `-p`, prazan `-p` ne prolazi).
    promptChannel: 'arg',
    promptFlag: '-p',
    modelFlag: '-m',
    // Gemini nema „dodaj sistemski prompt"; GEMINI_SYSTEM_MD bi zamijenio njegov (s uputama za
    // alate), pa identitet ide ispred prompta (Razgovor.ts).
    systemPromptFlag: null,
    sessionIdFlag: null,
    resumeFlag: null,
    projectCwdArgs: [],
  }
}

/** Okolina gemini poziva: `node` iz `~/.local/node/bin` (shebang CLI-ja) i povjerenje u radnu mapu. */
function okolinaGeminija(env: Record<string, string>, bin: string): Record<string, string> {
  const o = { ...env }
  const mape = [dirname(bin), o.HOME ? join(o.HOME, '.local', 'node', 'bin') : ''].filter(m => m && m !== '.')
  const put = (o.PATH || '').split(':').filter(Boolean)
  o.PATH = [...mape.filter(m => !put.includes(m)), ...put].join(':')
  o.GEMINI_CLI_TRUST_WORKSPACE = 'true'
  // Prijava u Claude ne ide tuđem modelu.
  delete o.CLAUDE_CODE_OAUTH_TOKEN
  delete o.ANTHROPIC_API_KEY
  return o
}

type IzvrsiteljRazgovora = { ime: string; cfg: ExecutorConfigCli; run(req: ExecRequest): Promise<ExecResult> }

/**
 * Izvršitelj razgovora: zadano `claude -p`; zahtjev s `extra.izvrsitelj === 'gemini'`
 * (model `geminicli:*` / `google:*`, TASK-5733) ide `gemini` CLI-jem. Gemini se traži pri
 * svakom pozivu — instalacija nakon pokretanja usluge vrijedi bez restarta.
 */
export function izvrsiteljRazgovora(o: { bin?: string; geminiBin?: string } = {}): IzvrsiteljRazgovora {
  const claude = claudeIzvrsitelj(o)
  return {
    ime: 'razgovor',
    cfg: claude.cfg,
    run(req: ExecRequest): Promise<ExecResult> {
      const extra = req.extra || {}
      if (extra.izvrsitelj !== 'gemini') return claude.run(req)
      const env = (extra.env && typeof extra.env === 'object' ? extra.env : process.env) as Record<string, string>
      const bin = o.geminiBin || nadjiGemini({ ...process.env, PATH: env.PATH, HOME: env.HOME || process.env.HOME })
      const ex = new CliExecutor('razgovor-gemini', geminiCfg(bin))
      return ex.run({ ...req, systemPrompt: undefined, extra: { ...extra, resume: undefined, env: okolinaGeminija(env, bin) } })
    },
  }
}

function claudeIzvrsitelj(o: { bin?: string }): CliExecutor & { cfg: ExecutorConfigCli } {
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
