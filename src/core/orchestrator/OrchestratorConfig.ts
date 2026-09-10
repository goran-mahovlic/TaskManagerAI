/**
 * OrchestratorConfig — postavke jezgre orkestratora (ADR-0001 §5.1).
 *
 * Isti obrazac kao `DezurniConfig.ts` / `IngestConfig.ts`: JSON bez ijedne tajne,
 * `load*` / `validate*Patch` / `save*` (atomski tmp + rename), bez keša — pa promjena s
 * ploče vrijedi bez ponovnog pokretanja.
 *
 * PRAVILO ZADANIH VRIJEDNOSTI (ADR-0001 §5.1, izvedeno iz nalaza S13/S14): polje čija bi
 * zadana vrijednost bila adresa, ime ili identitet MORA biti prazno/`null`, nikad naša
 * vrijednost. `null` znači „nije podešeno" i mehanizam se tada uredno ne uključi. To je
 * razlika između paketa koji ne radi dok ga se ne podesi (ispravno) i paketa koji radi
 * tako što zove tuđi poslužitelj (kvar).
 *
 * Autorica: Jelena (Engineer), TASK-4800.
 */

import { readFileSync, renameSync, writeFileSync } from 'fs'
import { konfigPutanja, osigurajMapu } from '../paths'

export const ORCHESTRATOR_CONFIG_PATH = konfigPutanja('orchestrator.json', 'TM_ORCHESTRATOR_CONFIG')

// ─── Oblik ───────────────────────────────────────────────────────────────────

export type LivenessMode = 'auto' | 'proc' | 'signal'
export type WatchdogMode = 'off' | 'shadow' | 'live'
export type PromptChannel = 'arg' | 'stdin' | 'file'

export interface ExecutorConfigCli {
  kind: 'cli'
  command: string
  args: string[]
  promptChannel: PromptChannel
  promptFlag?: string | null
  systemPromptFlag?: string | null
  sessionIdFlag?: string | null
  modelFlag?: string | null
}

export interface ExecutorConfigHttp {
  kind: 'http'
  baseUrl: string | null
  path: string
  apiKeyEnv: string | null
}

export type ExecutorConfig = ExecutorConfigCli | ExecutorConfigHttp

export interface OrchestratorPostavke {
  /** Svježa instalacija NE pokreće agente sama. */
  enabled: boolean
  pollIntervalMs: number
  autoExecIntervalMs: number
  api: {
    /** Adresa ploče koju vidi JEZGRA. */
    baseUrl: string
    /** Adresa koju vidi AGENT u promptu; `null` = ista (ADR-0001 L2/L3). */
    promptBaseUrl: string | null
  }
  spawn: {
    maxConcurrent: number
    hardCeilingHours: number
    livenessWindowHours: number
    backoff: { baseMs: number; maxMs: number; jitter: boolean }
  }
  liveness: { mode: LivenessMode; heartbeatDir: string | null }
  executors: Record<string, ExecutorConfig | string>
  agents: { registryPath: string | null }
  prompt: {
    templateDir: string | null
    /** Rečenice o VLASTITOJ infrastrukturi. Prazno je ispravno zatečeno stanje. */
    systemFacts: string[]
    includeTaskProtocol: boolean
    includeVerificationGate: boolean
  }
  git: { autoInitProjectRepo: boolean; identity: { name: string | null; email: string | null } }
  voice: { enabled: boolean; notifyUrl: string | null }
  watchdog: {
    stale: { mode: WatchdogMode; intervalMinutes: number; maxActionsPerRun: number }
    zombie: { mode: WatchdogMode; intervalMinutes: number; maxActionsPerRun: number }
    deadAgent: { mode: WatchdogMode; intervalMinutes: number; maxActionsPerRun: number }
  }
}

export const ZADANE_POSTAVKE: OrchestratorPostavke = {
  enabled: false,
  pollIntervalMs: 1000,
  autoExecIntervalMs: 15000,
  api: {
    baseUrl: process.env.TM_API_BASE || 'http://localhost:17781',
    promptBaseUrl: null,
  },
  spawn: {
    maxConcurrent: Number(process.env.TM_MAX_CONCURRENT) || 3,
    hardCeilingHours: 24,
    livenessWindowHours: 2,
    backoff: { baseMs: 60000, maxMs: 900000, jitter: true },
  },
  liveness: { mode: 'auto', heartbeatDir: null },
  executors: {
    default: 'cli-claude',
    'cli-claude': {
      kind: 'cli',
      command: 'claude',
      args: ['--print', '--output-format', 'json'],
      promptChannel: 'arg',
      promptFlag: '-p',
      systemPromptFlag: '--append-system-prompt',
      sessionIdFlag: '--session-id',
      modelFlag: '--model',
    },
    'http-ollama': {
      kind: 'http',
      baseUrl: process.env.TM_OLLAMA_URL || null,   // BEZ zadane adrese (usp. nalaz S14)
      path: '/v1/chat/completions',
      apiKeyEnv: null,
    },
  },
  agents: { registryPath: null },
  prompt: {
    templateDir: null,
    systemFacts: [],
    includeTaskProtocol: true,
    includeVerificationGate: true,
  },
  git: {
    autoInitProjectRepo: false,
    identity: { name: process.env.TM_GIT_NAME || null, email: process.env.TM_GIT_EMAIL || null },
  },
  voice: { enabled: false, notifyUrl: null },
  watchdog: {
    stale: { mode: 'shadow', intervalMinutes: 30, maxActionsPerRun: 5 },
    zombie: { mode: 'shadow', intervalMinutes: 1, maxActionsPerRun: 5 },
    deadAgent: { mode: 'shadow', intervalMinutes: 30, maxActionsPerRun: 5 },
  },
}

export const GRANICE = {
  pollIntervalMs: { min: 200, max: 60000 },
  autoExecIntervalMs: { min: 1000, max: 600000 },
  maxConcurrent: { min: 1, max: 32 },
  hardCeilingHours: { min: 1, max: 168 },
  livenessWindowHours: { min: 1, max: 48 },
  intervalMinutes: { min: 1, max: 1440 },
  maxActionsPerRun: { min: 1, max: 100 },
  systemFacts: { maxStavki: 20, maxDuljina: 300 },
} as const

// ─── Čitanje ─────────────────────────────────────────────────────────────────

/** Spoji zadane i pročitane postavke po DUBINI (plitki spoj bi pobrisao pod-objekte). */
function spoji<T>(zadano: T, sirovo: unknown): T {
  if (!sirovo || typeof sirovo !== 'object' || Array.isArray(sirovo)) return zadano
  const izlaz: Record<string, unknown> = { ...(zadano as Record<string, unknown>) }
  for (const [k, v] of Object.entries(sirovo as Record<string, unknown>)) {
    const z = (zadano as Record<string, unknown>)[k]
    izlaz[k] = z && typeof z === 'object' && !Array.isArray(z) && v && typeof v === 'object' && !Array.isArray(v)
      ? spoji(z, v)
      : v
  }
  return izlaz as T
}

/** Uvijek svjež pročitaj s diska. Nepoznata polja se ČUVAJU. */
export function loadOrchestratorConfig(
  path: string = ORCHESTRATOR_CONFIG_PATH,
): OrchestratorPostavke & Record<string, unknown> {
  try {
    const sirovo = JSON.parse(readFileSync(path, 'utf-8'))
    return spoji(ZADANE_POSTAVKE, sirovo) as OrchestratorPostavke & Record<string, unknown>
  } catch {
    return { ...ZADANE_POSTAVKE }
  }
}

/** `TM_ORCHESTRATOR_ENABLED` nadjačava datoteku — sklopka za hitno gašenje bez uređivanja. */
export function orkestratorUkljucen(cfg: OrchestratorPostavke): boolean {
  const env = process.env.TM_ORCHESTRATOR_ENABLED
  if (env === '1' || env === 'true') return true
  if (env === '0' || env === 'false') return false
  return !!cfg.enabled
}

/** Adresa ploče koju treba UPISATI U PROMPT agenta (ADR-0001 L3). */
export function promptApiBase(cfg: OrchestratorPostavke): string {
  return cfg.api.promptBaseUrl || cfg.api.baseUrl
}

// ─── Provjera zakrpe ─────────────────────────────────────────────────────────

export interface Provjera {
  ok: boolean
  greske: string[]
  zakrpa: Record<string, unknown>
}

const DOPUSTENA_PRVA_RAZINA = Object.keys(ZADANE_POSTAVKE)

function brojUGranici(v: unknown, g: { min: number; max: number }, ime: string, greske: string[]): number | null {
  const n = Number(v)
  if (!Number.isFinite(n) || n < g.min || n > g.max) {
    greske.push(`${ime} mora biti broj između ${g.min} i ${g.max}`)
    return null
  }
  return n
}

/**
 * Provjera odbija nepoznato polje IMENOM, i to na svakoj razini. Tipfeler bi inače tiho
 * stvorio mrtvu postavku — točno kvar koji je u REGOČ-u gutao `progress_notes`.
 */
export function validateOrchestratorPatch(tijelo: unknown): Provjera {
  const greske: string[] = []
  const zakrpa: Record<string, any> = {}
  if (!tijelo || typeof tijelo !== 'object' || Array.isArray(tijelo)) {
    return { ok: false, greske: ['Očekivan je JSON objekt s postavkama'], zakrpa: {} }
  }
  const t = tijelo as Record<string, any>

  for (const k of Object.keys(t)) {
    if (!DOPUSTENA_PRVA_RAZINA.includes(k)) {
      greske.push(`Nepoznato polje: ${k} (dopušteno: ${DOPUSTENA_PRVA_RAZINA.join(', ')})`)
    }
  }

  if ('enabled' in t) {
    if (typeof t.enabled !== 'boolean') greske.push('enabled mora biti true ili false')
    else zakrpa.enabled = t.enabled
  }
  if ('pollIntervalMs' in t) {
    const n = brojUGranici(t.pollIntervalMs, GRANICE.pollIntervalMs, 'pollIntervalMs', greske)
    if (n !== null) zakrpa.pollIntervalMs = n
  }
  if ('autoExecIntervalMs' in t) {
    const n = brojUGranici(t.autoExecIntervalMs, GRANICE.autoExecIntervalMs, 'autoExecIntervalMs', greske)
    if (n !== null) zakrpa.autoExecIntervalMs = n
  }

  if ('api' in t) {
    const a = t.api
    if (!a || typeof a !== 'object') greske.push('api mora biti objekt')
    else {
      const izlaz: Record<string, unknown> = {}
      for (const k of Object.keys(a)) {
        if (!['baseUrl', 'promptBaseUrl'].includes(k)) greske.push(`Nepoznato polje: api.${k}`)
      }
      for (const k of ['baseUrl', 'promptBaseUrl'] as const) {
        if (!(k in a)) continue
        if (a[k] === null) { izlaz[k] = null; continue }
        const v = String(a[k] ?? '').trim().replace(/\/+$/, '')
        if (!/^https?:\/\/[^\s]+$/.test(v)) greske.push(`api.${k} mora biti oblika http://host:port`)
        else izlaz[k] = v
      }
      if (Object.keys(izlaz).length) zakrpa.api = izlaz
    }
  }

  if ('spawn' in t) {
    const s = t.spawn
    if (!s || typeof s !== 'object') greske.push('spawn mora biti objekt')
    else {
      const izlaz: Record<string, unknown> = {}
      for (const k of Object.keys(s)) {
        if (!['maxConcurrent', 'hardCeilingHours', 'livenessWindowHours', 'backoff'].includes(k)) {
          greske.push(`Nepoznato polje: spawn.${k}`)
        }
      }
      if ('maxConcurrent' in s) {
        const n = brojUGranici(s.maxConcurrent, GRANICE.maxConcurrent, 'spawn.maxConcurrent', greske)
        if (n !== null) izlaz.maxConcurrent = n
      }
      if ('hardCeilingHours' in s) {
        const n = brojUGranici(s.hardCeilingHours, GRANICE.hardCeilingHours, 'spawn.hardCeilingHours', greske)
        if (n !== null) izlaz.hardCeilingHours = n
      }
      if ('livenessWindowHours' in s) {
        const n = brojUGranici(s.livenessWindowHours, GRANICE.livenessWindowHours, 'spawn.livenessWindowHours', greske)
        if (n !== null) izlaz.livenessWindowHours = n
      }
      if ('backoff' in s) {
        if (!s.backoff || typeof s.backoff !== 'object') greske.push('spawn.backoff mora biti objekt')
        else izlaz.backoff = { ...ZADANE_POSTAVKE.spawn.backoff, ...s.backoff }
      }
      if (Object.keys(izlaz).length) zakrpa.spawn = izlaz
    }
  }

  if ('liveness' in t) {
    const l = t.liveness
    if (!l || typeof l !== 'object') greske.push('liveness mora biti objekt')
    else {
      const izlaz: Record<string, unknown> = {}
      if ('mode' in l) {
        if (!['auto', 'proc', 'signal'].includes(String(l.mode))) {
          greske.push('liveness.mode mora biti auto, proc ili signal')
        } else izlaz.mode = l.mode
      }
      if ('heartbeatDir' in l) izlaz.heartbeatDir = l.heartbeatDir === null ? null : String(l.heartbeatDir)
      if (Object.keys(izlaz).length) zakrpa.liveness = izlaz
    }
  }

  if ('prompt' in t) {
    const p = t.prompt
    if (!p || typeof p !== 'object') greske.push('prompt mora biti objekt')
    else {
      const izlaz: Record<string, unknown> = {}
      for (const k of Object.keys(p)) {
        if (!['templateDir', 'systemFacts', 'includeTaskProtocol', 'includeVerificationGate'].includes(k)) {
          greske.push(`Nepoznato polje: prompt.${k}`)
        }
      }
      if ('templateDir' in p) izlaz.templateDir = p.templateDir === null ? null : String(p.templateDir)
      if ('systemFacts' in p) {
        if (!Array.isArray(p.systemFacts)) greske.push('prompt.systemFacts mora biti popis rečenica')
        else if (p.systemFacts.length > GRANICE.systemFacts.maxStavki) {
          greske.push(`prompt.systemFacts smije imati najviše ${GRANICE.systemFacts.maxStavki} stavki`)
        } else if (p.systemFacts.some((r: unknown) => String(r).length > GRANICE.systemFacts.maxDuljina)) {
          greske.push(`svaka rečenica u prompt.systemFacts je najviše ${GRANICE.systemFacts.maxDuljina} znakova`)
        } else izlaz.systemFacts = p.systemFacts.map((r: unknown) => String(r))
      }
      for (const k of ['includeTaskProtocol', 'includeVerificationGate'] as const) {
        if (!(k in p)) continue
        if (typeof p[k] !== 'boolean') greske.push(`prompt.${k} mora biti true ili false`)
        else izlaz[k] = p[k]
      }
      if (Object.keys(izlaz).length) zakrpa.prompt = izlaz
    }
  }

  if ('git' in t) {
    const g = t.git
    if (!g || typeof g !== 'object') greske.push('git mora biti objekt')
    else {
      const izlaz: Record<string, unknown> = {}
      if ('autoInitProjectRepo' in g) {
        if (typeof g.autoInitProjectRepo !== 'boolean') greske.push('git.autoInitProjectRepo mora biti true ili false')
        else izlaz.autoInitProjectRepo = g.autoInitProjectRepo
      }
      if ('identity' in g) {
        const i = g.identity || {}
        izlaz.identity = {
          name: i.name === null || i.name === undefined ? null : String(i.name).trim(),
          email: i.email === null || i.email === undefined ? null : String(i.email).trim(),
        }
      }
      if (Object.keys(izlaz).length) zakrpa.git = izlaz
    }
  }

  if ('watchdog' in t) {
    const w = t.watchdog
    if (!w || typeof w !== 'object') greske.push('watchdog mora biti objekt')
    else {
      const izlaz: Record<string, unknown> = {}
      for (const ime of Object.keys(w)) {
        if (!['stale', 'zombie', 'deadAgent'].includes(ime)) {
          greske.push(`Nepoznato polje: watchdog.${ime}`)
          continue
        }
        const v = w[ime] || {}
        const dio: Record<string, unknown> = {}
        if ('mode' in v) {
          if (!['off', 'shadow', 'live'].includes(String(v.mode))) {
            greske.push(`watchdog.${ime}.mode mora biti off, shadow ili live`)
          } else dio.mode = v.mode
        }
        if ('intervalMinutes' in v) {
          const n = brojUGranici(v.intervalMinutes, GRANICE.intervalMinutes, `watchdog.${ime}.intervalMinutes`, greske)
          if (n !== null) dio.intervalMinutes = n
        }
        if ('maxActionsPerRun' in v) {
          const n = brojUGranici(v.maxActionsPerRun, GRANICE.maxActionsPerRun, `watchdog.${ime}.maxActionsPerRun`, greske)
          if (n !== null) dio.maxActionsPerRun = n
        }
        if (Object.keys(dio).length) izlaz[ime] = dio
      }
      if (Object.keys(izlaz).length) zakrpa.watchdog = izlaz
    }
  }

  for (const k of ['executors', 'agents', 'voice'] as const) {
    if (!(k in t)) continue
    if (!t[k] || typeof t[k] !== 'object' || Array.isArray(t[k])) greske.push(`${k} mora biti objekt`)
    else zakrpa[k] = t[k]
  }

  if (!greske.length && !Object.keys(zakrpa).length) greske.push('Nijedna postavka nije poslana')
  return { ok: greske.length === 0, greske, zakrpa }
}

/** Spoji zakrpu s onim što je na disku i zapiši (atomski tmp + rename). */
export function saveOrchestratorConfig(
  zakrpa: Record<string, unknown>,
  path: string = ORCHESTRATOR_CONFIG_PATH,
): OrchestratorPostavke & Record<string, unknown> {
  const trenutno = loadOrchestratorConfig(path)
  const novo = spoji(trenutno, zakrpa)
  osigurajMapu(path)
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(novo, null, 2) + '\n', 'utf-8')
  renameSync(tmp, path)
  return novo as OrchestratorPostavke & Record<string, unknown>
}

/** Stanje za ploču: što je podešeno, a što ne. Nikad vrijednost ijedne tajne. */
export function stanjeOrkestratora(cfg: OrchestratorPostavke): {
  ukljucen: boolean
  spreman: boolean
  zastoKey: string
  brojIzvodaca: number
  registarPodesen: boolean
} {
  const izvodaci = Object.keys(cfg.executors || {}).filter(k => k !== 'default')
  const ukljucen = orkestratorUkljucen(cfg)
  let zastoKey = 'orc_zasto_spreman'
  let spreman = true
  if (!ukljucen) { spreman = false; zastoKey = 'orc_zasto_iskljucen' }
  else if (!izvodaci.length) { spreman = false; zastoKey = 'orc_zasto_nema_izvodaca' }
  else if (!cfg.api.baseUrl) { spreman = false; zastoKey = 'orc_zasto_nema_ploce' }
  return {
    ukljucen,
    spreman,
    zastoKey,
    brojIzvodaca: izvodaci.length,
    registarPodesen: !!cfg.agents.registryPath,
  }
}
