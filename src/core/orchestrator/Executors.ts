/**
 * Executors — kako se model uopće pokreće (ADR-0001 O4).
 *
 * ODLUKA KOJU OVO PROVODI: jezgra ne zna ni za jedan CLI. `claude`, `glab`, `kimi`,
 * `gemini`, Ollama iza HTTP-a — sve su to RETCI KONFIGURACIJE, ne grane u kodu. Živi
 * daemon ima tri `if`-a po davatelju (nalaz L6); ovdje su dvije izvedbe i jedna tablica.
 *
 * Zašto dvije, a ne nula (odluka O0, preporuka B iz ADR §7): paket bez ijedne izvedbe ne
 * radi „iz kutije", što je suprotno cilju. Instalacija bez ijednog CLI-ja radi kroz
 * `HttpExecutor` prema bilo kojem OpenAI-kompatibilnom poslužitelju.
 *
 * SIGURNOSNA CRTA: naredba i argumenti idu Bunu kao POPIS (`Bun.spawn([...])`), nikad kroz
 * ljusku. Prompt agenta je korisnički tekst; da ide kroz `sh -c`, svaki bi navodnik u
 * opisu zadatka bio izvršni znak.
 *
 * Autorica: Jelena (Engineer), TASK-4800.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ExecRequest, ExecResult, Executor } from './Ports'
import type { ExecutorConfig, ExecutorConfigCli, ExecutorConfigHttp } from './OrchestratorConfig'

const ZADANI_ROK_MS = 30 * 60_000

/** `{model}`, `{agentId}`, `{sessionId}` u argumentima — zamjena bez ljuske. */
function popuni(args: string[], req: ExecRequest): string[] {
  const mapa: Record<string, string> = {
    model: req.model || '',
    agentId: req.agentId,
    sessionId: req.sessionId || '',
  }
  return args
    .map(a => a.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (c, k) =>
      Object.prototype.hasOwnProperty.call(mapa, k) ? mapa[k]! : c))
    // Argument koji se sveo na prazno (npr. `{model}` bez modela) ne šalje se dalje —
    // inače CLI dobiva prazan niz i javlja grešku o „nepoznatom modelu ''".
    .filter(a => a !== '')
}

export class CliExecutor implements Executor {
  ime: string
  private cfg: ExecutorConfigCli

  constructor(ime: string, cfg: ExecutorConfigCli) {
    this.ime = ime
    this.cfg = cfg
  }

  async run(req: ExecRequest): Promise<ExecResult> {
    const c = this.cfg
    const argv: string[] = [c.command, ...popuni(c.args || [], req)]

    if (c.modelFlag && req.model && !argv.includes(c.modelFlag)) argv.push(c.modelFlag, req.model)
    if (c.systemPromptFlag && req.systemPrompt) argv.push(c.systemPromptFlag, req.systemPrompt)
    if (c.sessionIdFlag && req.sessionId) argv.push(c.sessionIdFlag, req.sessionId)

    let tmpMapa: string | null = null
    let stdinTekst: string | null = null
    if (c.promptChannel === 'arg') {
      if (c.promptFlag) argv.push(c.promptFlag, req.prompt)
      else argv.push(req.prompt)
    } else if (c.promptChannel === 'stdin') {
      stdinTekst = req.prompt
    } else {
      tmpMapa = mkdtempSync(join(tmpdir(), 'tm-prompt-'))
      const p = join(tmpMapa, 'prompt.txt')
      writeFileSync(p, req.prompt, 'utf-8')
      if (c.promptFlag) argv.push(c.promptFlag, p)
      else argv.push(p)
    }

    const rok = req.timeoutMs || ZADANI_ROK_MS
    try {
      const proc = Bun.spawn(argv, {
        cwd: req.cwd || process.cwd(),
        stdin: stdinTekst === null ? 'ignore' : new TextEncoder().encode(stdinTekst),
        stdout: 'pipe',
        stderr: 'pipe',
        // TASK-5013: hook `hooks/TaskInstructionsInject.hook.ts` po ovome zna za koji zadatak
        // preuzima dodatne upute. Bez ID-a zadatka okolina ostaje naslijeđena kao i prije.
        env: req.taskId ? { ...process.env, TM_TASK_ID: req.taskId } : undefined,
      })
      const prekid = setTimeout(() => { try { proc.kill() } catch { /* već je gotov */ } }, rok)
      const [izlaz, greska, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      clearTimeout(prekid)
      return this.protumaci(izlaz, greska, exitCode)
    } catch (e: any) {
      return { exitCode: 127, resultText: '', greska: `naredba se ne može pokrenuti: ${e?.message || e}` }
    } finally {
      if (tmpMapa) { try { rmSync(tmpMapa, { recursive: true, force: true }) } catch { /* nema veze */ } }
    }
  }

  /**
   * JSON izlaz (`--output-format json`) nosi `num_turns`. NULA POTEZA UZ EXIT 0 NIJE USPJEH
   * nego blokiran spawn — to je jedini pouzdan potpis te pojave (mjereno; v. memoriju
   * „claude --print hook-block potpis"). Jezgra ga zato prijavljuje kao kvar, ne kao rad.
   */
  private protumaci(izlaz: string, greska: string, exitCode: number): ExecResult {
    let resultText = izlaz.trim()
    let usage: ExecResult['usage']
    let sessionId: string | undefined
    let numTurns: number | undefined
    try {
      const j = JSON.parse(izlaz)
      if (j && typeof j === 'object') {
        resultText = String(j.result ?? j.text ?? resultText)
        sessionId = j.session_id || j.sessionId
        numTurns = typeof j.num_turns === 'number' ? j.num_turns : undefined
        if (j.usage) {
          usage = {
            inputTokens: j.usage.input_tokens,
            outputTokens: j.usage.output_tokens,
            costUsd: j.total_cost_usd ?? j.cost_usd,
          }
        }
      }
    } catch { /* nije JSON — vrijedi sirovi tekst */ }

    if (exitCode === 0 && numTurns === 0) {
      return {
        exitCode: 1, resultText, usage, sessionId, numTurns,
        greska: 'izvođač je vratio 0 poteza (spawn je blokiran prije rada) — ovo NIJE uspjeh',
      }
    }
    return {
      exitCode, resultText, usage, sessionId, numTurns,
      greska: exitCode === 0 ? undefined : (greska.trim().slice(0, 500) || `exit ${exitCode}`),
    }
  }
}

export class HttpExecutor implements Executor {
  ime: string
  private cfg: ExecutorConfigHttp

  constructor(ime: string, cfg: ExecutorConfigHttp) {
    this.ime = ime
    this.cfg = cfg
  }

  async run(req: ExecRequest): Promise<ExecResult> {
    const base = this.cfg.baseUrl
    if (!base) {
      return { exitCode: 78, resultText: '', greska: `izvođač ${this.ime} nema baseUrl (nije podešen)` }
    }
    const kljuc = this.cfg.apiKeyEnv ? process.env[this.cfg.apiKeyEnv] : undefined
    if (this.cfg.apiKeyEnv && !kljuc) {
      return { exitCode: 78, resultText: '', greska: `varijabla ${this.cfg.apiKeyEnv} nije postavljena` }
    }
    const poruke: { role: string; content: string }[] = []
    if (req.systemPrompt) poruke.push({ role: 'system', content: req.systemPrompt })
    poruke.push({ role: 'user', content: req.prompt })

    const kontrola = new AbortController()
    const prekid = setTimeout(() => kontrola.abort(), req.timeoutMs || ZADANI_ROK_MS)
    try {
      const resp = await fetch(base.replace(/\/+$/, '') + this.cfg.path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(kljuc ? { Authorization: `Bearer ${kljuc}` } : {}),
        },
        body: JSON.stringify({ model: req.model, messages: poruke, stream: false }),
        signal: kontrola.signal,
      })
      if (!resp.ok) {
        const tijelo = await resp.text().catch(() => '')
        return { exitCode: 1, resultText: '', greska: `HTTP ${resp.status}: ${tijelo.slice(0, 300)}` }
      }
      const j: any = await resp.json()
      const tekst = j?.choices?.[0]?.message?.content ?? j?.message?.content ?? ''
      return {
        exitCode: 0,
        resultText: String(tekst),
        numTurns: 1,
        usage: j?.usage
          ? { inputTokens: j.usage.prompt_tokens, outputTokens: j.usage.completion_tokens }
          : undefined,
      }
    } catch (e: any) {
      const razlog = e?.name === 'AbortError' ? 'istekao rok' : String(e?.message || e)
      return { exitCode: 1, resultText: '', greska: `mrežna greška: ${razlog}` }
    } finally {
      clearTimeout(prekid)
    }
  }
}

/** Tablica izvođača iz konfiguracije → izvedba. `default` pokazuje na ime drugog zapisa. */
export function napraviIzvodace(
  tablica: Record<string, ExecutorConfig | string>,
): { zadani: Executor | null; svi: Map<string, Executor>; greske: string[] } {
  const svi = new Map<string, Executor>()
  const greske: string[] = []
  for (const [ime, cfg] of Object.entries(tablica || {})) {
    if (ime === 'default' || typeof cfg === 'string') continue
    if (cfg.kind === 'cli') svi.set(ime, new CliExecutor(ime, cfg))
    else if (cfg.kind === 'http') svi.set(ime, new HttpExecutor(ime, cfg))
    else greske.push(`izvođač ${ime}: nepoznat kind`)
  }
  const zadaniIme = typeof tablica?.default === 'string' ? tablica.default : ''
  const zadani = svi.get(zadaniIme) || null
  if (zadaniIme && !zadani) greske.push(`zadani izvođač „${zadaniIme}" ne postoji u tablici`)
  return { zadani, svi, greske }
}
