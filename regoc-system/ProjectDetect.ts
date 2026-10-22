/**
 * ProjectDetect — prepoznavanje naredbe o projektu („raditi na X projektu").
 *
 * TASK-3601 (F2). ZAŠTO POSTOJI OVAJ MODUL:
 * `RegocDaemon.detectProjectCommandWithAI()` se izvodio za SVAKU dolaznu poruku i spawnao
 * `claude --print --model sonnet` (rok 3 s) — dakle Anthropic kvota po poruci, i tiho
 * pada kad API ode u rate-limit. MJERENO (TASK-2568, 02.09.2026., popis svih 19 poruka iz
 * messages.db koje spominju „projekt"):
 *
 *   regex   18/19 · 0 poziva  ·    0 ms
 *   Sonnet  17/19 · 19 spawna · p50 3194 ms
 *   Ollama  16/19 · 0 poziva  · p50 2214 ms  (3 lažne uzbune na vlastitoj potvrdi sustava)
 *
 * Plaćeni model radi VIŠE grešaka od pukog regexa. Zato je redoslijed obrnut: regex je
 * PRVI, a model se zove SAMO kad regex ništa ne nađe — i tada lokalno (flag
 * `ollamaProjectDetect`). Flag OFF ⇒ nijedan model se ne zove.
 *
 * Modul je zaseban (a ne funkcija u daemonu) da bi mjerilo
 * `tests/project_detect_accuracy.ts` mjerilo ISTI kod koji vrti pogon: import daemona bi
 * pokrenuo daemon, pa je mjerilo dosad logiku PORTALO — a portana kopija tiho odluta od
 * izvornika.
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { inference } from '../skills/CORE/Tools/Inference'
import { homedir } from 'os'

export interface ProjectCommandResult {
  isProjectCommand: boolean
  projectName: string | null
  action: 'create' | 'work_on' | 'start' | null
}

/** Kojim je putem donesena odluka — za log i za mjerilo (broj model-poziva). */
export type ProjectDetectVia = 'negative' | 'sender' | 'regex' | 'model' | 'none'

export interface ProjectDetectOutcome extends ProjectCommandResult {
  via: ProjectDetectVia
  /** true samo ako je STVARNO pozvan model (mjerilo ovim broji spawnove). */
  modelCalled: boolean
}

const NONE: ProjectCommandResult = { isProjectCommand: false, projectName: null, action: null }

// ─────────────────────────────────────────────────────────────────────────────
// 1. Negativni uzorci — tekst koji sadrži ime projekta, ali NIKAD nije naredba
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Vlastita potvrda sustava. `RegocDaemon` nakon uspješnog `createProjectWorkflow`
 * pošalje „✅ Kreiran projekt: X …" natrag pošiljatelju; Ollama je tu rečenicu u 3/3
 * slučaja pročitala kao naredbu → projekt bi se stvorio PONOVNO, na vlastitu potvrdu.
 */
export const PROJECT_COMMAND_NEGATIVE_PATTERNS: readonly RegExp[] = [
  /^\s*✅\s*Kreiran projekt:/,
  /^\s*❌\s*Greška pri kreiranju projekta/,
]

export function isProjectCommandNegative(message: string): boolean {
  return PROJECT_COMMAND_NEGATIVE_PATTERNS.some(re => re.test(message))
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Pošiljatelj — jedini razlučiv signal za agentsko čavrljanje
// ─────────────────────────────────────────────────────────────────────────────
//
// Promašaj koji dijele SVA tri detektora je REGOČ-eva vlastita rečenica
// „Trenutno radim na REGOČ projektu — imam uvid u sve završene faze…". Obrazac je
// doslovno isti kao u korisnikovoj naredbi „radim na Backend Refactoring projektu",
// pa iz samog TEKSTA nije razlučiv ni jednim klasifikatorom. Razlučiv je iz
// POŠILJATELJA: agent koji priča o projektu ne naređuje stvaranje projekta.

/** Kanali kojima stiže ČOVJEK (Telegram most `klaudio`, glas `stribor`) — nikad blokirani. */
const HUMAN_BRIDGE_SENDERS = new Set(['user', 'goran', 'klaudio', 'stribor', ''])

const AGENT_REGISTRY_PATH = join(process.env.HOME || homedir(), '.claude/regoc/REGOC_AGENTS.json')

/** Ako registar nije čitljiv, ne padamo — koristimo poznati popis (fail-open je gori: lažni projekt). */
const FALLBACK_WORKER_AGENTS = [
  'regoc', 'kosjenka', 'jelena', 'malik', 'manda', 'dora', 'gita', 'grga', 'potjeh', 'emard',
]

let workerCache: Set<string> | null = null

/** Registrirani agenti MINUS ljudski kanali. Čita se jednom po procesu. */
export function workerAgents(): Set<string> {
  if (workerCache) return workerCache
  let ids = FALLBACK_WORKER_AGENTS
  try {
    if (existsSync(AGENT_REGISTRY_PATH)) {
      const reg = JSON.parse(readFileSync(AGENT_REGISTRY_PATH, 'utf-8'))
      const keys = Object.keys(reg?.agents || {})
      if (keys.length > 0) ids = keys
    }
  } catch {
    // ostaje FALLBACK_WORKER_AGENTS
  }
  workerCache = new Set(ids.map(id => id.toLowerCase()).filter(id => !HUMAN_BRIDGE_SENDERS.has(id)))
  return workerCache
}

/**
 * LEGACY omotnica: starije delegacije nose „**Od:** klaudio" pa je pošiljatelj doduše
 * agent, ali je IZVOR poruke čovjek — takvu poruku i dalje gledamo kao naredbu.
 */
const HUMAN_ORIGIN_ENVELOPE = /^\s*\*\*Od:\*\*\s*(\S+)/m

/** true = poruka je agentsko čavrljanje/izvještaj, ne korisnikova naredba o projektu. */
export function isAgentChatter(fromAgent: string | null | undefined, content: string): boolean {
  const sender = (fromAgent || '').trim().toLowerCase()
  if (!workerAgents().has(sender)) return false  // čovjek ili nepoznat pošiljatelj → normalan put
  const env = content.match(HUMAN_ORIGIN_ENVELOPE)
  if (env && HUMAN_BRIDGE_SENDERS.has(env[1].toLowerCase())) return false
  return true
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Regex detektor (najtočniji izmjereni put: 18/19, 0 poziva, 0 ms)
// ─────────────────────────────────────────────────────────────────────────────

export function cleanProjectName(name: string | null): string | null {
  if (!name) return null
  return name
    .replace(/\s+projekt(?:u)?\s*$/i, '')
    .replace(/^projekt(?:u)?\s+/i, '')
    .replace(/['"]+/g, '')
    .replace(/\s+/g, ' ')
    .trim() || null
}

const REGEX_PATTERNS: Array<{ re: RegExp; action: 'create' | 'work_on' | 'start' }> = [
  { re: /radi(?:ti|m)?\s+na\s+(.+?)\s+projekt/i, action: 'work_on' },
  { re: /kreir(?:ati|aj)\s+projekt\s+(.+?)(?:\s*$|[,.])/i, action: 'create' },
  { re: /novi\s+projekt\s+(.+?)(?:\s*$|[,.])/i, action: 'create' },
  { re: /pokre(?:ni|ći)\s+projekt\s+(.+?)(?:\s*$|[,.])/i, action: 'start' },
]

export function detectProjectCommandWithRegex(message: string): ProjectCommandResult {
  if (isProjectCommandNegative(message)) return { ...NONE }
  for (const { re, action } of REGEX_PATTERNS) {
    const m = message.match(re)
    if (!m) continue
    const projectName = cleanProjectName(m[1])
    if (projectName) return { isProjectCommand: true, projectName, action }
  }
  return { ...NONE }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Model (samo kad regex ne nađe ništa, i samo lokalno)
// ─────────────────────────────────────────────────────────────────────────────

export const PROJECT_DETECT_SYSTEM_PROMPT = `You are a Croatian language analyzer specialized in project management commands.
Analyze the following message and determine if it's a project-related command.

Project commands include:
- "raditi na projektu X" (work on project X) - return just the project name X, not "X projektu"
- "kreirati projekt X" / "kreiraj projekt X" (create project X)
- "novi projekt X" (new project X)
- "pokreni projekt X" / "pokreći projekt X" (start project X)

IMPORTANT: Extract ONLY the project name, not including words like "projekt", "projektu", etc.

Return ONLY valid JSON (no markdown, no extra text):
{
  "isProjectCommand": boolean,
  "projectName": string or null (extract ONLY the project name, clean),
  "action": "create" | "work_on" | "start" | null
}

If not a project command, return:
{
  "isProjectCommand": false,
  "projectName": null,
  "action": null
}`

export interface ModelDetectOptions {
  /** 'local' = Ollama (besplatno). 'auto' = `claude --print` — koristi SAMO mjerilo. */
  backend?: 'auto' | 'local'
  timeout?: number
}

/** Model-put. Nikad se ne zove sam od sebe — samo iz `detectProjectCommand` kad regex šuti. */
export async function detectProjectCommandWithModel(
  message: string,
  opts: ModelDetectOptions = {},
): Promise<ProjectCommandResult> {
  const backend = opts.backend ?? 'local'
  try {
    const result = await inference({
      systemPrompt: PROJECT_DETECT_SYSTEM_PROMPT,
      userPrompt: `Message: "${message}"`,
      level: 'standard',
      expectJson: true,
      // Lokalni model se hladno učitava sporije od 3 s; timeout se diže samo za njega.
      timeout: opts.timeout ?? (backend === 'local' ? 8000 : 3000),
      backend,
    })

    if (result.success && result.parsed) {
      const parsed = result.parsed as ProjectCommandResult
      if (
        typeof parsed.isProjectCommand === 'boolean' &&
        (parsed.projectName === null || typeof parsed.projectName === 'string') &&
        (parsed.action === null || ['create', 'work_on', 'start'].includes(parsed.action as string))
      ) {
        if (!parsed.isProjectCommand) return { ...NONE }
        const projectName = cleanProjectName(parsed.projectName ?? null)
        if (!projectName) return { ...NONE }
        return { isProjectCommand: true, projectName, action: parsed.action ?? null }
      }
    }
    return { ...NONE }
  } catch {
    return { ...NONE }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Jedinstveni ulaz — REGEX PRVI, model tek ako regex šuti
// ─────────────────────────────────────────────────────────────────────────────

export interface DetectInput {
  content: string
  from_agent?: string | null
}

export interface DetectDeps {
  /** Smije li se uopće zvati model kad regex šuti (flag `ollamaProjectDetect`). */
  modelEnabled?: boolean
  backend?: 'auto' | 'local'
  timeout?: number
  /** Ubrizgavanje za test/mjerilo; default je `detectProjectCommandWithModel`. */
  model?: (message: string) => Promise<ProjectCommandResult>
  log?: (line: string) => void
}

export async function detectProjectCommand(
  msg: DetectInput,
  deps: DetectDeps = {},
): Promise<ProjectDetectOutcome> {
  const content = msg.content || ''
  const say = deps.log ?? (() => {})

  // (a) vlastita potvrda sustava — nikad naredba, ni za regex ni za model
  if (isProjectCommandNegative(content)) {
    say('  [project-detect] negativan uzorak (vlastita potvrda sustava) — nije naredba')
    return { ...NONE, via: 'negative', modelCalled: false }
  }

  // (b) agentsko čavrljanje — „radim na X projektu" iz agenta nije naredba
  if (isAgentChatter(msg.from_agent, content)) {
    say(`  [project-detect] pošiljatelj "${msg.from_agent}" je agent (bez ljudske omotnice) — nije naredba`)
    return { ...NONE, via: 'sender', modelCalled: false }
  }

  // (c) REGEX PRVI — 18/19, 0 poziva, 0 ms
  const byRegex = detectProjectCommandWithRegex(content)
  if (byRegex.isProjectCommand) {
    return { ...byRegex, via: 'regex', modelCalled: false }
  }

  // (d) model SAMO kad regex šuti — i samo ako je izričito uključen
  if (!deps.modelEnabled) {
    return { ...NONE, via: 'none', modelCalled: false }
  }

  const runModel = deps.model
    ?? ((m: string) => detectProjectCommandWithModel(m, { backend: deps.backend ?? 'local', timeout: deps.timeout }))
  const byModel = await runModel(content)
  if (byModel.isProjectCommand) {
    say(`  [project-detect] regex šuti → model (${deps.backend ?? 'local'}) prepoznao "${byModel.projectName}"`)
    return { ...byModel, via: 'model', modelCalled: true }
  }
  return { ...NONE, via: 'model', modelCalled: true }
}
