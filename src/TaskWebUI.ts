#!/usr/bin/env bun
/**
 * Regoč TaskManagerMD - Task Web UI Server
 *
 * Dedicated web server for task management visualization
 * Port: 17779
 *
 * Features:
 * - REST API for task CRUD
 * - WebSocket for real-time updates
 * - File watcher for markdown changes
 * - Health check endpoint
 *
 * Autor: Grga (Designer Agent), implementirala Kosjenka
 * Verzija: 1.0.0
 */

import { watch, existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, rmSync, renameSync, appendFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { hostname as osHostname, networkInterfaces as osNetworkInterfaces, homedir } from 'os'
// SQL-Only TaskManager (v2.0) - replaces MD+SQLite dual-write
import { getTaskManagerSQL, INBOX_PROJECT_ID } from './core/TaskManagerSQL'
import { konfigPutanja, osigurajMapu, stanjePutanja, TM_DB } from './core/paths'
// ADR-0012 (TASK-4827): `spawnCloseGuard` — dok na zadatku DOKAZIVO radi spawn, prijelaz u
// TERMINALNO stanje ne dolazi od sustava (orkestrator najam pušta prije svog zapisa) nego od
// agenta koji sam sebe zatvara prije suda kritičara. Zadano isključeno (features.json).
import { odlukaGuarda } from './core/SpawnFinalizer'
// TASK-4894: model-config.json se mijenja SAMO atomno i uz revizijski trag (GAP F14).
import { saveModelConfig } from './core/models/ModelConfigWriter'
// TASK-4967/4972: RAG s dva pozadinska sustava (ChromaDB / pgvector / dual), GAP F13.
import { getRAGBackendService } from './RAGBackendService'
// TASK-4815: jedan parser agentova izlaza za ploču i kanale (GAP F5).
import { parseAgentOutput, renderFull } from './core/AgentOutputParser'
import { najamAktivan } from './core/TaskCloser'
import { isEnabled as jeUkljuceno } from './core/FeatureFlags'
// Integracije (TASK-4800): četiri modula po istom obrascu + orkestrator + ulazni Telegram.
import {
  loadNextcloudConfig, validateNextcloudPatch, saveNextcloudConfig, stanjeNextcloud,
  probajNextcloud, NEXTCLOUD_CONFIG_PATH, nextcloudKonfigModul,
} from './NextcloudConfig'
import {
  loadEmailConfig, validateEmailPatch, saveEmailConfig, stanjeEmail, probajEmail, EMAIL_CONFIG_PATH,
  emailKonfigModul,
} from './EmailConfig'
import {
  loadGitLabConfig, validateGitLabPatch, saveGitLabConfig, stanjeGitLab, probajGitLab, GITLAB_CONFIG_PATH,
  gitlabKonfigModul,
} from './GitLabConfig'
import {
  loadGitHubConfig, validateGitHubPatch, saveGitHubConfig, stanjeGitHub, probajGitHub, GITHUB_CONFIG_PATH,
  githubKonfigModul,
} from './GitHubConfig'
import { probajUlaz, stanjeUlaza, pokreniTelegramPoller } from './TelegramPoller'
import {
  loadOrchestratorConfig, validateOrchestratorPatch, saveOrchestratorConfig, stanjeOrkestratora,
  orchestratorConfigPath,
} from './core/orchestrator/OrchestratorConfig'
import { KonfiguracijskiRegistar } from './core/orchestrator/AgentRegistry'
// TASK-3047: ručna kočnica — globalna pauza dijeljena s RegocDaemonom preko datoteke stanja.
import { readPauseState, writePauseState, describePause } from './core/PauseControl'
import { parseInstructionInput } from './core/TaskInstructions'
import { parseConcurrencyInput, formatConcurrencyChange, CONCURRENCY_ENV, CONCURRENCY_MIN, CONCURRENCY_MAX, CONCURRENCY_DEFAULT } from './core/ConcurrencySetting'
// TASK-3461: stanje MJERILA potrošnje (razlikuje „čekam kvotu" od „mjerilo ne radi").
import { readWaitingQueue } from './core/AutonomyQueue'
import { formatLocalTime } from './core/QuotaWakeup'
// T10/TASK-3575: ploča čita POSTOJEĆI trag vratara (data/critic_gate.jsonl) — druga bi
// baza značila da ploča i vrata mogu tvrditi suprotno o istom zadatku.
import { unverifiedBoardState } from './core/UnverifiedReport'
import { getProjectManager } from './core/ProjectManager'
import { getMessageQueue } from './core/MessageQueue'
import { getRAGService, ragPodesen } from './RAGService'
import { kljucPrisutanUDatoteci, ukloniKljucIzDatoteke } from './LoginCreds'
import { tecajOdgovor } from './Tecaj'
import type { Task, AgentId, TaskFilter } from './types/task-types'
import { CreateTaskInputSchema, UpdateTaskInputSchema, TaskFilterSchema } from './zod/schemas/task'
import { isNonActionableMessage, emptyOrFixtureReason, EMPTY_TASK_REASON_TEXT } from './core/DispatchGuard'
import { mozdaZapisiOdluku, formatOdlukaLog, loadWorkflowKatalog } from './core/WorkflowGate'
// W2/TASK-4616: odabrani tijek postaje LANAC ZADATAKA na ploči. Zaseban prekidač
// (`materijalizacija` u config/workflow-gate.json), zadano `shadow` — W1 način `on`
// (upis oznake) sam po sebi NE otvara lance.
import {
  materijalizirajTijek, loadMaterijalizacijaNacin, formatLanacLog, zapisiLanac,
} from './core/WorkflowMaterializer'
import {
  sastaviPitanje, rasclaniPitanje, provjeriPitanje, razrijesiOdgovor, ulogaZaModel, ukloniPitanje,
} from './core/OdlukaPitanje'
import { citajZadnjiProlaz, opisiProlaz, citajOdgode, ucitajConfig as odluciteljConfig }
  from './core/OdluciteljPogon'
import {
  OZNAKA_STROJNI_OKIDAC, OBLICI_CINJENICE, imaStrojniOkidac, provjeriCinjenicu,
} from './core/StrojniOkidac'
// TASK-2635 (160_MODEL_SWITCHING, dio C): klasifikacijski model je ODVOJENA postavka od
// izvršnog modela agenta — zove se na svaku poruku pa mora ostati brz i lokalan (Ollama).
import {
  readClassifier, writeClassifier, clearClassifier,
  CLASSIFIER_DEFAULT_SPEC, CLASSIFIER_ENV_KEY,
} from './core/models/ClassifierModel'
// M2/TASK-4628: strop stvaranja zadataka po izvoru (rafal 02.09. = 686 zadataka u 2 h).
import { TaskCreateBreaker, formatTaskCreateAlarm } from './core/TaskCreateBreaker'
// K7/TASK-2986: potrošnja na ploči dolazi iz cost_loga koji puni svaki spawn.
import { getCostTracker, TROSAK_PO_PROJEKTU_SQL, TROSAK_PO_PROJEKTU_PROZOR_SQL,
         ENERGIJA_PO_PROJEKTU_SQL, sazmiEnergiju, energijaSazetakOdWh,
         type EnergijaSazetak } from './core/CostTracker'
import {
  normalizeTaskFields,
  unknownFieldResponseBody,
  UPDATE_TASK_FIELDS,
  CREATE_TASK_FIELDS,
} from './core/TaskFieldAliases'
import {
  evaluateCompletion, formatVerdictLog, formatShadowLog, loadGateConfig, shouldEnforce,
} from './core/CompletionGuard'
import type { KontekstZatvaranja } from './core/StepSchema'
// R2/TASK-4309: istraživanje mora završiti u RAG-u — zadatak s oznakom `istrazivanje`
// ne prolazi u completed bez ID-a dokumenta u result_summary.
import {
  evaluateResearchClosure, formatResearchHint, formatResearchLog,
  loadResearchGateConfig, ragStoreCommand, shouldEnforceResearch,
} from './core/ResearchRagGate'
// U4/TASK-4264: zadatak otvoren po predlošku lanca (oznaka `lanac`) ne prolazi u completed
// bez ijednog commita — osim ako je u koraku 4 označen kao „samo-tekst".
import {
  evaluateCommitClosure, findTaskCommits, formatCommitHint, formatCommitLog,
  loadGitCommitGateConfig, shouldEnforceCommit,
} from './core/GitCommitGate'
// U4/TASK-4264: niz zadataka daje JEDNU poruku korisniku — pometnja zadataka dojave.
import { sweepReportBack } from './core/ReportBackSweepLive'
import {
  CreateProjectInputSchema,
  UpdateProjectInputSchema,
  ProjectFilterSchema,
  AddAgentInputSchema,
  LinkRAGInputSchema
} from './zod/schemas/project'
import { RAGFilterSchema, RAGDeleteRequestSchema } from './zod/schemas/rag'
import { resolveSessionUsage, createDefaultDeps, type UsageState } from './SessionUsage'
// D4/TASK-4633: postavke dežurnog (rezervnog modela) — izbor modela s ploče, bez restarta.
// TASK-4709: davatelji dežurnog više nisu tvrdi popis nego izvod iz `model-config.json`.
import {
  DEZURNI_CONFIG_PATH, GRANICE, POZNATI_MODELI_DEZURNI,
  davateljiDezurnog, loadDezurniConfig, podrzaniProvideri, saveDezurniConfig,
  upotrebljiviProvideri, validateDezurniPatch, zadaniModelZa,
} from './DezurniConfig'
// TELEGRAM integracija (Kosjenka, 09.09.2026.): minimalna, samostana Telegram sposobnost
// u paketu — bot token + chat id + slanje obavijesti o završenom zadatku. NE ovisi o
// ~/.claude/tools/Telegram/ (to je Klaudio agent, glavni stroj). Ovo je NOVI modul u paketu.
import {
  TELEGRAM_CONFIG_PATH,
  loadTelegramConfig, saveTelegramConfig, validateTelegramPatch,
  posaljiTelegramPoruku, obavijestiZadatak, odgovorTelegramPloci,
} from './TelegramConfig'
// Prigusenje proba (DIZAJN-integracije §1.4 t.3) — jedno mjesto za svih pet kartica.
import { prigusenje } from './core/ProbeGuard'
// U6/TASK-4266: generički ulaz `POST /api/ingest` — source/externalId/replyTo/text/senderName.
// Ništa u njemu ne zna za Telegram; most, pretinac e-pošte i konzola su obični pozivatelji.
import {
  procijeniIngest, validirajZahtjev, zapisiUlaz, INGEST_LOG_PATH,
} from './core/Ingest'
import { renderirajOpis } from './core/IngestTemplate'
import {
  INGEST_CONFIG_PATH, loadIngestConfig, saveIngestConfig, validateIngestPatch,
  NACINI as NACINI_ULAZ, GRANICE as GRANICE_ULAZA,
} from './core/IngestConfig'
// TASK-2989/2991: traka više ne vjeruje status datoteci na riječ — stanje se izvodi.
import { resolveDaemonLiveness, type LivenessDeps } from './DaemonLiveness'
// TASK-3568 (T4): „Potrošnja zadatka" na kartici — poziva agent_telemetry.py (T2/T3).
import { resolveTaskTelemetry, createTelemetryState, createTelemetryDeps } from './TaskTelemetry'
// TASK-3569 (T5): kartica „Potrošnja" — tjedni pregled po projektu i agentu (mjera 6).
// TASK-3572 (T8): „Potrošnja projekta" — isti pregled, filtriran na jedan projekt.
import {
  resolveTjedniPregled, createPregledState, createPregledDeps, parseBroj, parseProjekt,
  DANA_MIN, DANA_MAX, ZADANO_DANA, NAJSKUPLJIH_MIN, NAJSKUPLJIH_MAX, ZADANO_NAJSKUPLJIH,
} from './TjedniPregled'

// ============================================
// CONFIGURATION
// ============================================

// NOTE: Using reserved port 17781 which is mapped 1:1 in Docker
// docker-compose.yml has: "17781:17781" (host:container same)
// Old mapping 17779->3001 conflicts with Claude Code internal task server
// TM_PORT / TM_EXTERNAL_PORT / TM_TASKS_DIR: postavke portabilnog paketa (TaskManagerAI).
// Dokumentacija ih je obećavala, a kod ih nije čitao — svjeza instalacija je zato uvijek
// pokusavala 17781 i padala s EADDRINUSE (uhvaceno 02.09.2026. pri probnoj instalaciji).
// U REGOC instalaciji nijedna nije postavljena, pa je ponasanje nepromijenjeno.
const EXTERNAL_PORT = Number(process.env.TM_EXTERNAL_PORT) || Number(process.env.TM_PORT) || 17781
// REGOC_TASKWEBUI_PORT: override SAMO za testove/alat (produkcija ga ne postavlja, pa je
// ponašanje nepromijenjeno). Uz HOME override daje potpuno izoliranu instancu s vlastitom
// bazom — E2E se tako vozi bez ijednog fixture-zapisa u živoj regoc.db (usp. TASK-2701).
const PORT = Number(process.env.REGOC_TASKWEBUI_PORT) || Number(process.env.TM_PORT) || 17781
const HOST = '0.0.0.0'       // Bind to all interfaces for external access
/** Ime/adresa koja se ISPISUJE korisniku. Nikad tuđe ime stroja — env ili vlastiti hostname. */
const EXTERNAL_HOST = process.env.TM_EXTERNAL_HOST || osHostname()
const TASKS_DIR = process.env.TM_TASKS_DIR
  || join(process.env.HOME || homedir(), '.claude/tasks')
const AGENTS_DIR = join(TASKS_DIR, 'agents')

// Allowed hosts for external access (both internal and external ports)
// Also allow old port 17779 for backwards compatibility during migration
//
// TASK-3577: popis je bio tvrdo kodiran na dell-home adrese, a ISTU datoteku vrte i
// cvorovi u LAN-u ili iza NAT-a — pa je svaki dolazak na
// VLASTITU LAN adresu cvora zavrsavao s 403. Sada se popis slaze iz tri izvora:
//   1. zadane vrijednosti (dell-home / localhost) — ponasanje na dell-home nepromijenjeno,
//   2. TM_ALLOWED_HOSTS — zarezom odvojen popis (npr. "10.0.0.5,node-a"),
//   3. vlastito ime i IPv4 adrese sucelja OVOG stroja (os.hostname / networkInterfaces),
//      cime svaki cvor bez ikakve konfiguracije prihvaca vlastitu adresu.
// Uz TM_ALLOW_PRIVATE_HOSTS=1 dodatno prolazi bilo koja privatna IPv4 adresa
// (10./172.16-31./192.168.) — iskljucivo za zatvorene LAN-ove.
// ADR-0001 O1: popis više ne nosi imena i adrese jednog konkretnog stroja. Ostaje samo
// ono što vrijedi na svakoj instalaciji; vlastito ime i IPv4 adrese ovog stroja dodaju se
// automatski (izvor 3 gore), a sve ostalo ide kroz TM_ALLOWED_HOSTS.
const DEFAULT_ALLOWED_HOSTS = [
  'localhost',
  '127.0.0.1',
]

/** 'ime' -> ['ime', 'ime:PORT', 'ime:EXTERNAL_PORT']; unos koji vec nosi port ide kakav jest. */
function expandHostEntry(entry: string): string[] {
  const bare = entry.trim()
  if (!bare) return []
  if (bare.includes(':')) return [bare]
  return [bare, `${bare}:${PORT}`, `${bare}:${EXTERNAL_PORT}`]
}

/** Vlastito ime stroja + sve IPv4 adrese njegovih sucelja. */
function localHostIdentities(): string[] {
  const out: string[] = []
  try { out.push(osHostname()) } catch {}
  try {
    for (const addrs of Object.values(osNetworkInterfaces())) {
      for (const a of addrs || []) {
        if (a && (a.family === 'IPv4' || a.family === 4)) out.push(a.address)
      }
    }
  } catch {}
  return out
}

const ALLOWED_HOSTS = [...new Set([
  ...DEFAULT_ALLOWED_HOSTS.flatMap(expandHostEntry),
  ...(process.env.TM_ALLOWED_HOSTS || '').split(',').flatMap(expandHostEntry),
  ...localHostIdentities().flatMap(expandHostEntry),
  // Legacy port 17779 - will not work externally but allow for local testing
  'localhost:17779',
  '127.0.0.1:17779'
])]

const ALLOW_PRIVATE_HOSTS = process.env.TM_ALLOW_PRIVATE_HOSTS === '1'
const PRIVATE_IPV4_RE = /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/

function isHostAllowed(req: Request): boolean {
  const host = req.headers.get('host') || ''
  const hostWithoutPort = host.split(':')[0]
  if (ALLOWED_HOSTS.includes(host) || ALLOWED_HOSTS.includes(hostWithoutPort)) return true
  return ALLOW_PRIVATE_HOSTS && PRIVATE_IPV4_RE.test(hostWithoutPort)
}

// WebSocket clients
const wsClients = new Set<any>()

// Task Manager (SQL-Only v2.0)
const taskManager = getTaskManagerSQL()

// Project Manager
const projectManager = getProjectManager()

// RAG Service
const ragService = getRAGService()

// Message Queue
const messageQueue = getMessageQueue()

// Read-only DB for konzola streaming (MQ + event_log)
import { Database } from 'bun:sqlite'
// TASK-5011: ista mapa u kojoj ga stvara MessageQueue (uz bazu iz core/paths.ts).
const MESSAGES_DB_PATH = join(dirname(TM_DB), 'messages.db')
let konzolaDb: Database | null = null
try {
  konzolaDb = new Database(MESSAGES_DB_PATH, { readonly: true })
  konzolaDb.exec('PRAGMA journal_mode = WAL')
} catch { konzolaDb = null }

// ============================================
// M2 / TASK-4628 — OSIGURAČ NA STVARANJU ZADATAKA
// ============================================
// Ovo je JEDINI ingress zadataka (web forma, agentov curl, RegocDaemon, cron — svi
// prolaze kroz `handleCreateTask`), pa vrata stoje ovdje. Stanje ide u `messages.db`,
// NE u `regoc.db`: brojač osigurača nije podatak o poslu i ne smije se miješati u bazu
// koju čita ploča (isti razlog kao kod SpawnBreakera i SendBreakera).
let taskBreakerDb: Database | null = null
let taskCreateBreaker: TaskCreateBreaker | null = null
function getTaskCreateBreaker(): TaskCreateBreaker | null {
  if (taskCreateBreaker) return taskCreateBreaker
  try {
    taskBreakerDb = new Database(MESSAGES_DB_PATH, { create: true })
    taskBreakerDb.exec('PRAGMA journal_mode = WAL')
    taskCreateBreaker = new TaskCreateBreaker(taskBreakerDb, {
      logger: (m) => console.warn(`[TaskWebUI] ${m}`),
    })
  } catch (e) {
    // Osigurač koji ruši ingress bio bi gori od rafala — fail-open uz glasan zapis.
    console.warn(`[TaskWebUI] TASK-4628: osigurač stvaranja zadataka nedostupan (${String(e).slice(0, 120)}) — vrata propuštaju`)
    taskCreateBreaker = null
  }
  return taskCreateBreaker
}

/**
 * Dojava Goranu — JEDNA po epizodi rafala, ne po zadatku (686 poruka je isti kvar).
 * Redak u dnevniku ide UVIJEK i prvi: Telegram je najslabija karika (token, mreža,
 * skripta koje u izoliranom HOME-u nema), a zapis mora ostati i kad poruka ne prođe.
 */
function notifyGoranTaskBurst(text: string): void {
  console.warn(`[TaskWebUI] TASK-4628 DOJAVA:\n${text}`)
  try {
    // Bilo je ~/.tmp/agent_telegram_send.sh — skripta REGOČ stroja koje u paketu nema (a na
    // REGOČ-u je iz ~/.tmp nestala), pa je dojava šutke izostajala. Paket ima svoj Telegram
    // modul (Config → Telegram); isključen ili nepostavljen = nema poruke, zapis ostaje.
    const esc = text.slice(0, 4000).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    void posaljiTelegramPoruku(esc).then(r => {
      if (!r.ok) console.warn(`[TaskWebUI] TASK-4628 dojava nije poslana: ${r.greska}`)
    }).catch(() => {})
  } catch { /* dojava nije kritični put — zapis je već otišao */ }
}

// ============================================
// KONZOLA STATE
// ============================================

let konzolaMode: 'plan' | 'work' = 'plan'

const DAEMON_LOG_FILE = join(process.env.HOME || homedir(), '.tmp/regoc_daemon.log')
const STATUS_FILE = join(process.env.HOME || homedir(), '.tmp/regoc_status.json')
/** Zamrznut 23.02.2026. — od K7 samo fallback dok se `cost_log` ne napuni. */
const STATS_CACHE_FILE = join(process.env.HOME || homedir(), '.claude/stats-cache.json')
/** Prozor za prikaz potrošnje na ploči (dana). */
const TOKEN_WINDOW_DAYS = 30
const SCHEDULER_STATE_FILE = join(process.env.HOME || homedir(), '.tmp/regoc_scheduler_state.json')
const REGOC_SERVICES_SCRIPT = join(process.env.HOME || homedir(), 'app/regoc_system/regoc-services.sh')
/** PID koji piše RegocDaemon — tvrdi signal živosti uz (meku) starost status datoteke. */
const DAEMON_PID_FILE = join(process.env.HOME || homedir(), '.claude/regoc/daemon.pid')

/**
 * Produkcijske ovisnosti za DaemonLiveness (TASK-2991). Sama logika resolvera je bez I/O
 * (da se rubni slučajevi testiraju bez pravog daemona), pa čitanje datoteka i provjera
 * procesa žive ovdje — isti obrazac kao `createDefaultDeps` u SessionUsage.
 */
const daemonLivenessDeps: LivenessDeps = {
  readStatusFile: () => Bun.file(STATUS_FILE).text(),
  statusFileMtimeMs: async () => {
    try { return statSync(STATUS_FILE).mtimeMs } catch { return null }
  },
  readPidFile: () => Bun.file(DAEMON_PID_FILE).text(),
  processExists: (pid: number) => {
    // signal 0 ne šalje ništa, samo provjerava postoji li proces i smijemo li ga dirati
    try { process.kill(pid, 0); return true } catch { return false }
  },
  processCmdline: (pid: number) => {
    try { return readFileSync(`/proc/${pid}/cmdline`, 'utf-8').replace(/\0/g, ' ').trim() } catch { return null }
  },
  now: () => Date.now(),
}

/** Zadano stanje kad se o daemonu ne zna ništa — polja koja konzola oduvijek čita. */
const DAEMON_FALLBACK = {
  status: 'Unknown', currentTask: null, pendingMessages: 0, processedToday: 0, uptime: 0, contextPct: 0,
}

/**
 * Daemon blok za `/api/konzola/status` i `/api/status-dashboard`.
 *
 * Stara polja (status, currentTask, uptime, mode…) ostaju netaknuta radi kompatibilnosti
 * sa svime što ih već čita; izvedena istina dolazi u novim poljima
 * (`state`, `alive`, `ageS`, `statusAgeS`, `reason`, `display`, `pid`, `lastSeen`).
 *
 * Starost se računa OVDJE, na poslužitelju: preglednikov sat i vremenska zona nisu
 * pouzdani, pa bi pomak sata izgledao kao mrtav daemon. `serverTime` je uz to da klijent
 * može prikazati apsolutno vrijeme bez vlastite aritmetike.
 */
async function buildDaemonBlock(): Promise<Record<string, unknown>> {
  try {
    const live = await resolveDaemonLiveness(daemonLivenessDeps)
    return {
      ...DAEMON_FALLBACK,
      ...live.status,
      state: live.state,
      alive: live.alive,
      pid: live.pid,
      ageS: live.ageS,
      statusAgeS: live.statusAgeS,
      lastSeen: live.lastSeen,
      reason: live.reason,
      display: live.display,
      serverTime: new Date().toISOString(),
    }
  } catch (err) {
    // Resolver ne baca, ali ni ovdje ne smije pasti cijeli endpoint zbog statusne trake.
    return {
      ...DAEMON_FALLBACK,
      state: 'offline', alive: false, pid: null, ageS: null, statusAgeS: null, lastSeen: null,
      reason: `provjera živosti nije uspjela: ${err instanceof Error ? err.message : String(err)}`,
      display: 'OFFLINE',
      serverTime: new Date().toISOString(),
    }
  }
}

let logFilePosition = 0
let logStreamInterval: ReturnType<typeof setInterval> | null = null

// Command execution allowlist
const ALLOWED_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'find',
  'git', 'bun', 'node',
  'date', 'uptime', 'whoami', 'hostname', 'df', 'free',
  'ps', 'top',
])

// Commands allowed ONLY in work mode
const WORK_MODE_COMMANDS = new Set(['bun', 'node'])

// Blocked patterns (security)
const BLOCKED_PATTERNS = [
  /rm\s+-rf/i,
  /sudo/i,
  /chmod/i,
  /chown/i,
  /curl.*\|\s*(bash|sh)/i,
  /wget.*\|\s*(bash|sh)/i,
  />\s*\/etc\//i,
  /\.\.\/\.\.\//,
  /\$\(/,
  /`[^`]+`/,
  /[;&|]{2,}/,
]

// Command aliases
const COMMAND_ALIASES: Record<string, string[]> = {
  'services': [REGOC_SERVICES_SCRIPT, 'status'],
  'services status': [REGOC_SERVICES_SCRIPT, 'status'],
  'services health': [REGOC_SERVICES_SCRIPT, 'health'],
  'services start': [REGOC_SERVICES_SCRIPT, 'start'],
  'services stop': [REGOC_SERVICES_SCRIPT, 'stop'],
  'services restart': [REGOC_SERVICES_SCRIPT, 'restart'],
  'services logs daemon': [REGOC_SERVICES_SCRIPT, 'logs', 'daemon'],
  'services logs voiceserver': [REGOC_SERVICES_SCRIPT, 'logs', 'voiceserver'],
}

// Health cache
let cachedHealth: any = null
let cachedHealthTime = 0
const HEALTH_CACHE_TTL = 30000

async function getCachedHealthCheck(): Promise<any> {
  if (Date.now() - cachedHealthTime < HEALTH_CACHE_TTL && cachedHealth) {
    return cachedHealth
  }
  try {
    const proc = Bun.spawn([REGOC_SERVICES_SCRIPT, 'health'], {
      stdout: 'pipe', stderr: 'pipe',
      env: { HOME: process.env.HOME || homedir(), PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', USER: process.env.USER || 'klaudio' }
    })
    const output = await new Response(proc.stdout).text()
    cachedHealth = JSON.parse(output)
    cachedHealthTime = Date.now()
    return cachedHealth
  } catch {
    return cachedHealth || { services: {}, status: 'unknown' }
  }
}

// ============================================
// FILE WATCHER
// ============================================

let watcherReady = false

function startFileWatcher() {
  try {
    // Svjeza instalacija jos nema mapu agenata; to nije kvar nego pocetno stanje.
    // Prije je svaki start ispisivao ENOENT gomilu i ostavljao dojam pada posluzitelja.
    if (!existsSync(AGENTS_DIR)) {
      console.log(`[FileWatcher] ${AGENTS_DIR} ne postoji — zivo pracenje datoteka iskljuceno`)
      return null
    }
    // Watch agents directory for changes
    const watcher = watch(AGENTS_DIR, { recursive: true }, (eventType, filename) => {
      if (!filename?.endsWith('.md')) return

      console.log(`[FileWatcher] ${eventType}: ${filename}`)

      // Broadcast update to all WebSocket clients
      const message = JSON.stringify({
        type: 'file_changed',
        filename,
        timestamp: new Date().toISOString()
      })

      wsClients.forEach(client => {
        try {
          client.send(message)
        } catch (err) {
          wsClients.delete(client)
        }
      })
    })

    watcherReady = true
    console.log(`[FileWatcher] Watching ${AGENTS_DIR}`)

    return watcher
  } catch (error) {
    console.error('[FileWatcher] Failed to start:', error)
    return null
  }
}

// ============================================
// HTML TEMPLATE
// ============================================

const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="hr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title data-i18n="regoc_taskmanagermd">Regoč TaskManagerMD</title>
  <style>
    :root {
      --bg-primary: #0f172a;
      --bg-secondary: #1e293b;
      --bg-tertiary: #334155;
      --text-primary: #f1f5f9;
      --text-secondary: #94a3b8;
      --accent-blue: #3b82f6;
      --accent-green: #22c55e;
      --accent-yellow: #eab308;
      --accent-red: #ef4444;
      --accent-purple: #a855f7;
      /* TASK-4803: obrub i podloga kartice. Do sada su se rabile (38 mjesta), ali nikad
         nisu bile definirane — a nepoznata varijabla u kratici border ne pada natrag na
         zadanu boju: cijelo svojstvo postaje nevaljano i border-style ispadne none.
         Kartice Configa zato nisu imale ni obrub ni podlogu. Vrijednosti nisu nove boje
         nego postojeće vrijednosti ploče, da kartica izgleda kao .column na Tasks.
         (Bez obrnutih navodnika: ovaj je stil unutar predloška koji oni zatvaraju.) */
      --border-color: #334155;
      --card-bg: #1e293b;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg-primary);
      color: var(--text-primary);
      min-height: 100vh;
      padding: 1rem;
    }

    .container { max-width: 1400px; margin: 0 auto; }

    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 1rem;
      background: var(--bg-secondary);
      border-radius: 0.5rem;
      margin-bottom: 1rem;
    }

    h1 { font-size: 1.5rem; color: var(--accent-blue); }
    .status { display: flex; gap: 1rem; align-items: center; }
    .status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent-green); }
    .status-dot.disconnected { background: var(--accent-red); }

    .grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 1rem;
    }

    .column {
      background: var(--bg-secondary);
      border-radius: 0.5rem;
      padding: 1rem;
    }

    .column h2 {
      font-size: 1rem;
      margin-bottom: 1rem;
      padding-bottom: 0.5rem;
      border-bottom: 2px solid var(--bg-tertiary);
    }

    .column.in-progress h2 { border-color: var(--accent-blue); }
    .column.pending h2 { border-color: var(--accent-yellow); }
    .column.blocked h2 { border-color: var(--accent-red); }
    .column.completed h2 { border-color: var(--accent-green); }

    .task-card {
      background: var(--bg-tertiary);
      border-radius: 0.375rem;
      padding: 0.75rem;
      margin-bottom: 0.5rem;
      cursor: pointer;
      transition: transform 0.1s;
    }

    .task-card:hover { transform: translateY(-2px); }

    .task-id {
      font-size: 0.75rem;
      color: var(--text-secondary);
      font-family: monospace;
    }

    .task-title {
      font-weight: 500;
      margin: 0.25rem 0;
    }

    .task-meta {
      display: flex;
      justify-content: space-between;
      font-size: 0.75rem;
      color: var(--text-secondary);
    }

    .priority-1 { border-left: 3px solid var(--accent-red); }
    .priority-2 { border-left: 3px solid var(--accent-yellow); }
    .priority-3 { border-left: 3px solid var(--accent-blue); }
    .priority-4 { border-left: 3px solid var(--accent-purple); }
    .priority-5 { border-left: 3px solid var(--text-secondary); }

    .agent-filter {
      display: flex;
      gap: 0.5rem;
      flex-wrap: wrap;
      margin-bottom: 1rem;
    }

    .agent-btn {
      padding: 0.25rem 0.75rem;
      background: var(--bg-secondary);
      border: 1px solid var(--bg-tertiary);
      border-radius: 1rem;
      color: var(--text-secondary);
      cursor: pointer;
      font-size: 0.875rem;
    }

    .agent-btn.active {
      background: var(--accent-blue);
      color: white;
      border-color: var(--accent-blue);
    }

    .stats {
      display: flex;
      gap: 1rem;
      margin-bottom: 1rem;
    }

    .stat {
      background: var(--bg-secondary);
      padding: 0.75rem 1rem;
      border-radius: 0.5rem;
      text-align: center;
    }

    .stat-value { font-size: 1.5rem; font-weight: bold; }
    .stat-label { font-size: 0.75rem; color: var(--text-secondary); }

    .empty { color: var(--text-secondary); font-style: italic; text-align: center; padding: 2rem; }

    /* ============================================ */
    /* PROJECT FILTER & BADGE */
    /* ============================================ */
    .filter-row {
      display: flex;
      gap: 1rem;
      align-items: center;
      margin-bottom: 1rem;
      flex-wrap: wrap;
    }

    .filter-select {
      padding: 0.5rem 1rem;
      background: var(--bg-secondary);
      border: 1px solid var(--bg-tertiary);
      border-radius: 0.375rem;
      color: var(--text-primary);
      font-size: 0.875rem;
      cursor: pointer;
      min-width: 150px;
    }

    .filter-select:focus {
      outline: none;
      border-color: var(--accent-blue);
    }

    .project-badge {
      display: inline-block;
      padding: 2px 8px;
      background: rgba(100, 100, 100, 0.2);
      border-radius: 4px;
      font-size: 0.75rem;
      color: #888;
      cursor: pointer;
      margin-left: 8px;
    }

    .project-badge:hover {
      background: rgba(100, 100, 100, 0.3);
    }

    /* ============================================ */
    /* TAB NAVIGATION */
    /* ============================================ */
    .tab-nav {
      display: flex;
      gap: 0.5rem;
      background: var(--bg-secondary);
      padding: 0.5rem;
      border-radius: 0.5rem;
      margin-bottom: 1rem;
      justify-content: space-between;
      align-items: center;
    }

    .tab-nav-left {
      display: flex;
      gap: 0.5rem;
    }

    .tab-nav-right {
      display: flex;
      gap: 0.5rem;
      align-items: center;
    }

    .tab-nav-right .filter-select {
      padding: 0.5rem 1rem;
      background: var(--bg-primary);
      border: 1px solid var(--border-color);
      border-radius: 0.375rem;
      color: var(--text-primary);
      font-size: 0.875rem;
      cursor: pointer;
    }

    .tab-btn {
      padding: 0.75rem 1.5rem;
      background: transparent;
      border: none;
      border-radius: 0.375rem;
      color: var(--text-secondary);
      font-size: 0.875rem;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s;
    }

    .tab-btn:hover {
      background: var(--bg-tertiary);
      color: var(--text-primary);
    }

    .tab-btn.active {
      background: var(--accent-blue);
      color: white;
    }

    .tab-content {
      display: none;
    }

    .tab-content.active {
      display: block;
    }

    /* ============================================ */
    /* PROJECTS KANBAN */
    /* ============================================ */
    .projects-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1rem;
    }

    .projects-filter {
      display: flex;
      gap: 0.5rem;
      flex-wrap: wrap;
    }

    /* Projekti su plocice u cetiri stupca (TASK-3513): citaju se s lijeva na
       desno, pa je prva kucica (A1) projekt na kojemu se zadnje radilo.
       Statusni stupci su maknuti jer su projekt razbijali po statusu. */
    .projects-rows {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 0.75rem;
      align-items: stretch;
    }

    @media (max-width: 1200px) { .projects-rows { grid-template-columns: repeat(2, 1fr); } }
    @media (max-width: 700px)  { .projects-rows { grid-template-columns: 1fr; } }

    .project-card {
      background: var(--bg-tertiary);
      border-radius: 0.375rem;
      padding: 0.75rem;
      cursor: pointer;
      transition: transform 0.1s, box-shadow 0.1s;
      display: flex;
      flex-direction: column;
      gap: 0.4rem;
      /* Boja = STATUS projekta (nize .project-card.status-*), ne prioritet. */
      border-left: 4px solid var(--text-secondary);
    }

    .project-card:hover { transform: translateY(-2px); box-shadow: 0 2px 8px rgba(0,0,0,0.25); }

    /* STATUS BOJOM — iskljucivo postojeca paleta (TASK-3513) */
    .project-card.status-completed { border-left-color: var(--accent-green); }
    .project-card.status-archived  { border-left-color: var(--accent-blue); }
    .project-card.status-on_hold   { border-left-color: var(--accent-red); }
    .project-card.status-active    { border-left-color: var(--accent-yellow); }

    .project-card-top {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 0.5rem;
    }

    .project-id {
      font-size: 0.75rem;
      color: var(--text-secondary);
      font-family: monospace;
    }

    .project-status-badge {
      font-size: 0.625rem;
      text-transform: uppercase;
      letter-spacing: 0.03em;
      padding: 0.1rem 0.45rem;
      border-radius: 1rem;
      border: 1px solid currentColor;
      white-space: nowrap;
    }

    .project-status-badge.status-completed { color: var(--accent-green); }
    .project-status-badge.status-archived  { color: var(--accent-blue); }
    .project-status-badge.status-on_hold   { color: var(--accent-red); }
    .project-status-badge.status-active    { color: var(--accent-yellow); }

    .project-name {
      font-weight: 500;
      margin: 0;
      line-height: 1.25;
      overflow-wrap: anywhere;
    }

    .project-meta {
      display: flex;
      justify-content: space-between;
      gap: 0.5rem;
      font-size: 0.75rem;
      color: var(--text-secondary);
    }

    /* Brojke po statusu zadataka u kucici projekta */
    .project-counts {
      display: flex;
      flex-wrap: wrap;
      gap: 0.25rem;
      font-size: 0.625rem;
    }

    .project-count {
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      padding: 0.1rem 0.4rem;
      border-radius: 0.25rem;
      background: var(--bg-secondary);
      color: var(--text-secondary);
    }

    .project-count b { font-weight: 600; }
    .project-count.c-in_progress b { color: var(--accent-blue); }
    .project-count.c-pending b     { color: var(--accent-yellow); }
    .project-count.c-blocked b     { color: var(--accent-red); }
    .project-count.c-completed b   { color: var(--accent-green); }
    .project-count.is-zero { opacity: 0.45; }

    /* Trosak projekta u zadanom razdoblju (TASK-3572, T8). Namjerno u istom
       redu s brojkama po statusu: skupi projekt se vidi bez otvaranja panela.
       Nemjereno je "—" (klasa .is-prazna), nikad izmisljena nula. */
    /* R4/TASK-4311: broj RAG dokumenata projekta — znanje uz trošak */
    .project-count.c-rag { background: rgba(139,92,246,0.12); }
    .project-count.c-rag b { color: #8b5cf6; }
    .project-count.c-rag.is-zero b { color: var(--accent-red); }
    .project-count.c-rag.is-racuna b { color: var(--text-secondary); font-weight: 400; }
    .project-count.c-trosak { background: rgba(59,130,246,0.12); }
    .project-count.c-trosak b { color: var(--accent-blue); }
    .project-count.c-trosak.is-prazna { opacity: 0.45; }
    .project-count.c-trosak.is-racuna b { color: var(--text-secondary); font-weight: 400; }
    /* TASK-3691: vrijednost po cjeniku S1–S6 stoji uz trošak, ali drugom bojom —
       da se na prvi pogled vidi da su to dvije različite brojke, a ne zbroj. */
    .project-count.c-vrijednost { background: rgba(34,197,94,0.12); }
    .project-count.c-vrijednost b { color: #22c55e; }
    .project-count.c-vrijednost.is-prazna { opacity: 0.45; }
    .project-count.c-vrijednost.is-racuna b { color: var(--text-secondary); font-weight: 400; }
    /* ADR-0010/TASK-4820: procjena potrosnje struje. ZUTO je jedina boja koja na kartici
       znaci „ovo nije izmjereno": plavo = trosak (mjeren), zeleno = vrijednost po cjeniku,
       ljubicasto = RAG, zuto = energija (procjena, raspon ÷3…×3). Znak ≈ je obavezan. */
    .project-count.c-energija { background: rgba(234,179,8,0.12); }
    .project-count.c-energija b { color: #eab308; }
    .project-count.c-energija.is-prazna { opacity: 0.45; }
    .project-count.c-energija.is-racuna b { color: var(--text-secondary); font-weight: 400; }
    /* ADR-0011/TASK-4822: CO2 i voda su ISTA zuta — ne uvodi se nova boja, jer bi to
       razvodnilo jedino znacenje zutoga („nije izmjereno"). Razlikuju se znakom u cipu.
       VODA nosi iscrtkan obrub i znak ⚠: raspon objavljenih WUE je ~50× (0,12–5,3 L/kWh)
       prema ~4× za mreznu emisiju, pa se razlika mora vidjeti i bez citanja tooltipa
       i bez razlikovanja boja (daltonisti).
       ZAMKA (izmjereno u pregledniku 12.09.): 💧 U+1F4A7 je IZVAN BMP-a i u kontejnerskom
       fontu je tofu (sirina glifa == sirina referentnog „nedostaje glif"). Zato tekst H₂O.
       ⚠ U+26A0 JEST u BMP-u i renderira se (14,3 px) — on ostaje. */
    .project-count.c-co2 { background: rgba(234,179,8,0.12); }
    .project-count.c-co2 b { color: #eab308; }
    .project-count.c-co2.is-prazna { opacity: 0.45; }
    .project-count.c-co2.is-racuna b { color: var(--text-secondary); font-weight: 400; }
    .project-count.c-voda { background: rgba(234,179,8,0.08); border: 1px dashed rgba(234,179,8,0.55); }
    .project-count.c-voda b { color: #eab308; }
    .project-count.c-voda.is-prazna { opacity: 0.45; }
    .project-count.c-voda.is-racuna b { color: var(--text-secondary); font-weight: 400; }
    .osoba-znacka { display: inline-block; margin-left: 0.25rem; padding: 0 0.3rem; border-radius: 3px;
      background: rgba(148,163,184,0.18); color: var(--text-secondary); font-size: 0.66rem; }

    /* Postotak dovrsenosti: traka + brojka */
    .project-progress {
      margin-top: auto;
      display: flex;
      flex-direction: column;
      gap: 0.2rem;
    }

    .project-progress-track {
      height: 6px;
      border-radius: 3px;
      background: var(--bg-secondary);
      overflow: hidden;
    }

    .project-progress-fill {
      height: 100%;
      background: var(--accent-green);
      border-radius: 3px;
      transition: width 0.2s;
    }

    .project-progress-label {
      font-size: 0.625rem;
      color: var(--text-secondary);
      display: flex;
      justify-content: space-between;
    }

    .projects-legend {
      display: flex;
      flex-wrap: wrap;
      gap: 0.75rem;
      margin-bottom: 0.75rem;
      font-size: 0.6875rem;
      color: var(--text-secondary);
    }

    .projects-legend .legend-item {
      display: inline-flex;
      align-items: center;
      gap: 0.3rem;
    }

    .projects-legend .legend-dot {
      width: 10px;
      height: 3px;
      border-radius: 2px;
      display: inline-block;
    }

    .legend-dot.status-completed { background: var(--accent-green); }
    .legend-dot.status-archived  { background: var(--accent-blue); }
    .legend-dot.status-on_hold   { background: var(--accent-red); }
    .legend-dot.status-active    { background: var(--accent-yellow); }

    .project-agents {
      display: flex;
      gap: 0.25rem;
      flex-wrap: wrap;
      margin-top: 0.25rem;
    }

    .agent-chip {
      background: var(--bg-secondary);
      color: var(--text-secondary);
      padding: 0.125rem 0.5rem;
      border-radius: 1rem;
      font-size: 0.625rem;
    }


    /* ============================================ */
    /* RAG PAGE */
    /* ============================================ */
    .rag-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1rem;
      flex-wrap: wrap;
      gap: 1rem;
    }

    .rag-filters {
      display: flex;
      gap: 0.5rem;
      flex-wrap: wrap;
      align-items: center;
    }

    .rag-filters select {
      background: var(--bg-tertiary);
      border: 1px solid var(--bg-tertiary);
      border-radius: 0.375rem;
      padding: 0.5rem 1rem;
      color: var(--text-primary);
      font-size: 0.875rem;
      cursor: pointer;
    }

    .rag-filters select:focus {
      outline: none;
      border-color: var(--accent-blue);
    }

    .rag-filters input[type="text"] {
      background: var(--bg-tertiary);
      border: 1px solid var(--bg-tertiary);
      border-radius: 0.375rem;
      padding: 0.5rem 1rem;
      color: var(--text-primary);
      font-size: 0.875rem;
      transition: border-color 0.2s ease;
    }

    .rag-filters input[type="text"]:focus {
      outline: none;
      border-color: var(--accent-blue);
    }

    .rag-filters input[type="text"]::placeholder {
      color: var(--text-secondary);
    }

    .rag-list {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }

    .rag-entry {
      background: var(--bg-secondary);
      border-radius: 0.375rem;
      padding: 1rem;
      cursor: pointer;
      transition: background 0.2s;
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 1rem;
    }

    .rag-entry:hover {
      background: var(--bg-tertiary);
    }

    .rag-entry-main {
      flex: 1;
      min-width: 0;
    }

    .rag-entry-header {
      display: flex;
      gap: 0.5rem;
      align-items: center;
      flex-wrap: wrap;
      margin-bottom: 0.5rem;
    }

    .rag-entry-id {
      font-family: monospace;
      font-size: 0.75rem;
      color: var(--accent-blue);
      background: var(--bg-primary);
      padding: 0.125rem 0.375rem;
      border-radius: 0.25rem;
    }

    .rag-entry-collection {
      font-size: 0.75rem;
      color: var(--accent-purple);
      background: rgba(168, 85, 247, 0.1);
      padding: 0.125rem 0.375rem;
      border-radius: 0.25rem;
    }

    .rag-entry-type {
      font-size: 0.75rem;
      color: var(--text-secondary);
    }

    .rag-entry-date {
      font-size: 0.75rem;
      color: var(--text-secondary);
    }

    .rag-entry-preview {
      color: var(--text-secondary);
      font-size: 0.875rem;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 100%;
    }

    .rag-entry-actions {
      display: flex;
      gap: 0.5rem;
    }

    .rag-delete-btn {
      background: transparent;
      border: 1px solid var(--accent-red);
      color: var(--accent-red);
      padding: 0.25rem 0.5rem;
      border-radius: 0.25rem;
      font-size: 0.75rem;
      cursor: pointer;
      transition: all 0.2s;
    }

    .rag-delete-btn:hover {
      background: var(--accent-red);
      color: white;
    }

    .load-more-btn {
      display: block;
      width: 100%;
      padding: 0.75rem;
      background: var(--bg-secondary);
      border: 1px dashed var(--bg-tertiary);
      border-radius: 0.375rem;
      color: var(--text-secondary);
      font-size: 0.875rem;
      cursor: pointer;
      transition: all 0.2s;
      margin-top: 1rem;
    }

    .load-more-btn:hover {
      background: var(--bg-tertiary);
      color: var(--text-primary);
      border-style: solid;
    }

    /* RAG Detail Modal */
    .rag-modal {
      background: var(--bg-secondary);
      border-radius: 0.5rem;
      padding: 1.5rem;
      max-width: 800px;
      width: 90%;
      max-height: 90vh;
      overflow-y: auto;
      animation: slideUp 0.3s;
    }

    .rag-modal-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 1rem;
      padding-bottom: 1rem;
      border-bottom: 1px solid var(--bg-tertiary);
    }

    .rag-modal-meta {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }

    .rag-modal-content {
      background: var(--bg-primary);
      border-radius: 0.375rem;
      padding: 1rem;
      font-family: monospace;
      font-size: 0.875rem;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 400px;
      overflow-y: auto;
    }

    .rag-modal-footer {
      display: flex;
      justify-content: flex-end;
      gap: 0.5rem;
      margin-top: 1rem;
      padding-top: 1rem;
      border-top: 1px solid var(--bg-tertiary);
    }

    .btn-danger {
      background: var(--accent-red);
      color: white;
    }

    /* ============================================ */
    /* PROJECT DETAIL PANEL */
    /* ============================================ */
    .project-detail-panel {
      position: fixed;
      top: 0;
      right: -500px;
      width: 480px;
      height: 100vh;
      background: var(--bg-secondary);
      border-left: 1px solid var(--bg-tertiary);
      box-shadow: -4px 0 20px rgba(0,0,0,0.3);
      z-index: 1500;
      transition: right 0.3s ease;
      overflow-y: auto;
      overflow-x: hidden;   /* višak ide u klizni okvir tablice, ne izvan panela */
      display: flex;
      flex-direction: column;
    }

    .project-detail-panel.open {
      right: 0;
    }

    .project-section {
      margin-bottom: 1.5rem;
    }

    .project-section h4 {
      font-size: 0.75rem;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 0.5rem;
    }

    .agents-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
    }

    .agent-item {
      display: flex;
      align-items: center;
      gap: 0.25rem;
      background: var(--bg-tertiary);
      padding: 0.25rem 0.5rem;
      border-radius: 0.25rem;
      font-size: 0.75rem;
    }

    .agent-item .remove-agent {
      cursor: pointer;
      color: var(--accent-red);
      font-weight: bold;
    }

    .task-list-compact {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }

    .task-list-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0.5rem;
      background: var(--bg-tertiary);
      border-radius: 0.25rem;
      font-size: 0.75rem;
    }

    .task-list-item .task-status {
      padding: 0.125rem 0.375rem;
      border-radius: 0.125rem;
      font-size: 0.625rem;
      text-transform: uppercase;
    }

    .task-status.pending { background: var(--accent-yellow); color: var(--bg-primary); }
    .task-status.in_progress { background: var(--accent-blue); color: white; }
    .task-status.completed { background: var(--accent-green); color: white; }
    .task-status.blocked { background: var(--accent-red); color: white; }

    @media (max-width: 800px) {
      .project-detail-panel {
        width: 100%;
        right: -100%;
      }
    }

    /* Task Detail Panel */
    .detail-panel {
      position: fixed;
      top: 0;
      right: -420px;  /* Hidden by default */
      width: 400px;
      height: 100vh;
      background: var(--bg-secondary);
      border-left: 1px solid var(--bg-tertiary);
      box-shadow: -4px 0 20px rgba(0,0,0,0.3);
      z-index: 1500;
      transition: right 0.3s ease;
      overflow-y: auto;
      overflow-x: hidden;   /* višak ide u klizni okvir tablice, ne izvan panela */
      display: flex;
      flex-direction: column;
    }

    .detail-panel.open {
      right: 0;
    }

    .detail-panel-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 1rem;
      border-bottom: 1px solid var(--bg-tertiary);
      position: sticky;
      top: 0;
      background: var(--bg-secondary);
    }

    .detail-panel-body {
      padding: 1rem;
      flex: 1;
      min-width: 0;   /* flex-dijete se inače ne smije stisnuti ispod min-content */
    }

    .detail-panel-footer {
      padding: 1rem;
      border-top: 1px solid var(--bg-tertiary);
      display: flex;
      gap: 0.5rem;
      justify-content: flex-end;
      position: sticky;
      bottom: 0;
      background: var(--bg-secondary);
    }

    .detail-field {
      margin-bottom: 1rem;
    }

    .detail-field label {
      display: block;
      font-size: 0.75rem;
      color: var(--text-secondary);
      margin-bottom: 0.25rem;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .detail-field input,
    .detail-field textarea,
    .detail-field select {
      width: 100%;
      background: var(--bg-tertiary);
      border: 1px solid var(--bg-tertiary);
      border-radius: 0.375rem;
      padding: 0.5rem;
      color: var(--text-primary);
      font-family: inherit;
      font-size: 0.875rem;
    }

    .detail-field input:focus,
    .detail-field textarea:focus,
    .detail-field select:focus {
      outline: none;
      border-color: var(--accent-blue);
    }

    .detail-field textarea {
      min-height: 150px;
      resize: vertical;
    }

    /* Progress Notes */
    .progress-notes {
      margin-top: 0.5rem;
    }

    .progress-note {
      padding: 0.5rem;
      background: var(--bg-tertiary);
      border-radius: 0.375rem;
      margin-bottom: 0.5rem;
      font-size: 0.875rem;
    }

    .progress-note-meta {
      font-size: 0.75rem;
      color: var(--text-secondary);
      margin-bottom: 0.25rem;
    }

    /* Tags Input */
    .tags-container {
      display: flex;
      flex-wrap: wrap;
      gap: 0.25rem;
      padding: 0.25rem;
      background: var(--bg-tertiary);
      border-radius: 0.375rem;
      min-height: 36px;
    }

    .tag {
      background: var(--accent-blue);
      color: white;
      padding: 0.125rem 0.5rem;
      border-radius: 1rem;
      font-size: 0.75rem;
      display: flex;
      align-items: center;
      gap: 0.25rem;
    }

    .tag-remove {
      cursor: pointer;
      opacity: 0.7;
    }

    .tag-remove:hover {
      opacity: 1;
    }

    /* Blocked By selector */
    .blocked-by-list {
      margin-top: 0.5rem;
    }

    .blocked-by-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0.25rem 0.5rem;
      background: var(--accent-red);
      color: white;
      border-radius: 0.25rem;
      font-size: 0.75rem;
      margin-bottom: 0.25rem;
    }

    /* Close button */
    .close-btn {
      background: transparent;
      border: none;
      color: var(--text-secondary);
      font-size: 1.5rem;
      cursor: pointer;
      padding: 0.25rem;
      line-height: 1;
    }

    .close-btn:hover {
      color: var(--text-primary);
    }

    /* Timestamps display */
    .timestamps {
      font-size: 0.75rem;
      color: var(--text-secondary);
      padding: 0.5rem;
      background: var(--bg-primary);
      border-radius: 0.375rem;
      margin-top: 1rem;
    }

    /* TASK-3568 (T4): odjeljak „Potrošnja zadatka" na kartici zadatka. */
    .tel-box { font-size: 0.78rem; color: var(--text-primary); background: var(--bg-primary);
               border-radius: 0.375rem; padding: 0.6rem; }
    .tel-muted { color: var(--text-secondary); }
    .tel-head { display: flex; flex-wrap: wrap; gap: 0.4rem; align-items: baseline;
                color: var(--text-secondary); margin-bottom: 0.5rem; }
    .tel-sec { margin-top: 0.6rem; min-width: 0; }
    .tel-sec-title { font-weight: 600; color: var(--text-secondary); text-transform: uppercase;
                     letter-spacing: 0.03em; font-size: 0.68rem; margin-bottom: 0.25rem; }
    .tel-bar { display: flex; height: 10px; border-radius: 5px; overflow: hidden;
               background: var(--bg-secondary); margin: 0.3rem 0; }
    .tel-bar span { display: block; height: 100%; }
    .tel-seg-model { background: var(--accent-blue); }
    .tel-seg-alat { background: var(--accent-green); }
    .tel-seg-covjek { background: var(--accent-yellow); }
    .tel-seg-rezija { background: var(--text-secondary); }
    .tel-legend { display: flex; flex-wrap: wrap; gap: 0.75rem; color: var(--text-secondary); }
    .tel-legend i { display: inline-block; width: 8px; height: 8px; border-radius: 2px;
                    margin-right: 0.25rem; font-style: normal; }
    .tel-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(88px, 1fr)); gap: 0.4rem; }
    .tel-cell { background: var(--bg-secondary); border-radius: 0.25rem; padding: 0.35rem 0.45rem; }
    .tel-cell b { display: block; font-size: 0.9rem; font-weight: 600; }
    /* ADR-0010: procijenjena energija nosi istu zutu boju kao cip na kartici — jedna boja,
       jedno znacenje („procjena, ne mjerenje") gdje god se brojka pojavi. */
    .tel-energija { color: #eab308; }
    /* ADR-0011: voda je ista zuta, ali podvucena iscrtkano — jedini znak koji preživi
       i crno-bijeli ispis i daltonizam. */
    .tel-voda { color: #eab308; border-bottom: 1px dashed rgba(234,179,8,0.6); }
    .tel-cell span { color: var(--text-secondary); font-size: 0.68rem; }
    /* Osam stupaca s nowrap ima min-content sirinu vecu od panela (400/480 px). Dok je
       tablica bila display:table, width:100% je nije mogao stisnuti ispod te sirine, pa se
       prelijevala IZVAN panela — a kako je panel prilijepljen desno, visak je strsio ulijevo
       i bio odrezan (Goranova snimka 02.09.2026.). display:block pretvara samu tablicu u
       klizni okvir: redci ostaju poravnati (anonimna tablica unutra), a visak se pomice
       vodoravno umjesto da bjezi iz panela. */
    .tel-table { width: 100%; max-width: 100%; border-collapse: collapse;
                 display: block; overflow-x: auto; }
    .tel-table td, .tel-table th { padding: 0.15rem 0.35rem; text-align: right; white-space: nowrap; }
    .tel-table th { color: var(--text-secondary); font-weight: 500; font-size: 0.68rem; }
    .tel-table td:first-child, .tel-table th:first-child { text-align: left; }
    .tel-znacka { display: inline-block; padding: 0.05rem 0.4rem; border-radius: 0.75rem;
                  font-size: 0.68rem; font-weight: 600; }
    .tel-znacka.ok { background: rgba(34,197,94,0.15); color: var(--accent-green); }
    .tel-znacka.upoz { background: rgba(234,179,8,0.15); color: var(--accent-yellow); }
    .tel-znacka.loše { background: rgba(239,68,68,0.15); color: var(--accent-red); }
    /* M3/TASK-4625: tri ishoda izvođenja. Boja nosi značenje: zeleno = isporučeno,
       žuto = agent je UREDNO stao (nije kvar), crveno = pad. */
    .tel-ishod { display: inline-block; padding: 0.05rem 0.35rem; border-radius: 0.75rem;
                 font-size: 0.68rem; font-weight: 600; }
    .tel-ishod.ok { background: rgba(34,197,94,0.15); color: var(--accent-green); }
    .tel-ishod.zastoj { background: rgba(234,179,8,0.15); color: var(--accent-yellow); }
    .tel-ishod.pad { background: rgba(239,68,68,0.15); color: var(--accent-red); }
    .tel-primjer { font-family: ui-monospace, monospace; font-size: 0.7rem; color: var(--text-secondary);
                   word-break: break-all; }

    .timestamps div {
      margin-bottom: 0.25rem;
    }

    /* Responsive */
    @media (max-width: 800px) {
      .detail-panel {
        width: 100%;
        right: -100%;
      }
    }

    /* When panel is open, shrink grid */
    .container.panel-open {
      margin-right: 420px;
      transition: margin-right 0.3s ease;
    }

    @media (max-width: 800px) {
      .container.panel-open {
        margin-right: 0;
      }
    }

    /* Priority Dropdown */
    .priority-badge {
      display: inline-block;
      padding: 0.25rem 0.5rem;
      border-radius: 0.25rem;
      font-size: 0.75rem;
      font-weight: 600;
      cursor: pointer;
      position: relative;
      user-select: none;
    }

    .priority-badge.p1 { background: var(--accent-red); color: white; }
    .priority-badge.p2 { background: var(--accent-yellow); color: var(--bg-primary); }
    .priority-badge.p3 { background: var(--accent-blue); color: white; }

    .priority-dropdown {
      position: absolute;
      top: calc(100% + 0.25rem);
      right: 0;
      background: var(--bg-secondary);
      border: 1px solid var(--bg-tertiary);
      border-radius: 0.375rem;
      padding: 0.25rem;
      z-index: 1000;
      min-width: 100px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    }

    .priority-option {
      padding: 0.5rem 0.75rem;
      cursor: pointer;
      border-radius: 0.25rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
      transition: background 0.1s;
    }

    .priority-option:hover { background: var(--bg-tertiary); }

    .priority-option.delete { color: var(--accent-red); border-top: 1px solid var(--bg-tertiary); margin-top: 0.25rem; }

    .priority-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
    }

    .priority-dot.red { background: var(--accent-red); }
    .priority-dot.yellow { background: var(--accent-yellow); }
    .priority-dot.blue { background: var(--accent-blue); }

    /* TASK-3047: ručna kočnica (globalna + po zadatku) */
    .global-pause-btn {
      background: var(--accent-yellow, #eab308);
      color: #1a1a1a;
      border: none;
      border-radius: 6px;
      padding: 6px 12px;
      font-size: 0.82rem;
      font-weight: 600;
      cursor: pointer;
      margin-right: 0.75rem;
      transition: background 0.15s, transform 0.1s;
    }
    .global-pause-btn:hover { transform: translateY(-1px); }
    .global-pause-btn.paused {
      background: var(--accent-red, #ef4444);
      color: #fff;
      animation: pause-pulse 1.6s ease-in-out infinite;
    }
    @keyframes pause-pulse { 0%,100% { opacity: 1 } 50% { opacity: .6 } }
    .global-pause-info {
      font-size: 0.75rem;
      color: var(--accent-red, #ef4444);
      margin-right: 0.75rem;
    }

    /* Pauzirana kartica mora biti prepoznatljiva IZ DALJINE — pauza je iznimno stanje
       i ne smije se stopiti s ostalima na ploči. */
    .task-card.paused {
      opacity: 0.6;
      border-left: 4px solid var(--accent-yellow, #eab308);
    }
    .task-pause-btn {
      background: transparent;
      border: 1px solid var(--border-color, #333);
      color: var(--text-secondary, #999);
      border-radius: 4px;
      padding: 2px 7px;
      font-size: 0.72rem;
      cursor: pointer;
      margin-left: auto;
    }
    .task-pause-btn:hover { border-color: var(--accent-yellow, #eab308); color: var(--accent-yellow, #eab308); }
    .task-pause-btn.resume { border-color: var(--accent-green, #22c55e); color: var(--accent-green, #22c55e); }
    /* T10/TASK-3575: rezultat koji vratar NIJE mogao provjeriti. Nije greska (zato nije
       crveno) nego izostanak dokaza — vizualno se mora razlikovati i od jednog i od drugog. */
    .unverified-badge {
      font-size: 0.68rem;
      background: transparent;
      color: var(--accent-yellow, #eab308);
      border: 1px solid var(--accent-yellow, #eab308);
      border-radius: 3px;
      padding: 0 5px;
      margin-left: 6px;
      font-weight: 600;
      cursor: help;
    }

    /* TASK-5013: dodatne upute agentu dok radi */
    .task-uputa-btn {
      background: transparent; border: 1px solid var(--border-color, #444); color: var(--text-secondary, #aaa);
      border-radius: 4px; padding: 0 6px; font-size: 0.8rem; cursor: pointer; line-height: 1.4;
    }
    .task-uputa-btn:hover { border-color: var(--accent-blue, #3b82f6); color: var(--accent-blue, #3b82f6); }
    .uputa-badge {
      display: inline-block; margin-left: 6px; padding: 0 6px; border-radius: 4px; font-size: 0.7rem;
      background: rgba(59,130,246,.15); color: var(--accent-blue, #3b82f6); border: 1px solid rgba(59,130,246,.4);
    }
    .uputa-badge.ceka { background: rgba(234,179,8,.15); color: var(--accent-yellow, #eab308); border-color: rgba(234,179,8,.5); }
    .uputa-item { border-left: 3px solid var(--accent-green, #22c55e); padding: 4px 8px; margin-bottom: 6px; }
    .uputa-item.ceka { border-left-color: var(--accent-yellow, #eab308); }
    .uputa-item .uputa-meta { font-size: 0.75rem; opacity: .75; }
    .paused-badge {
      font-size: 0.68rem;
      background: var(--accent-yellow, #eab308);
      color: #1a1a1a;
      border-radius: 3px;
      padding: 1px 5px;
      margin-left: 6px;
      font-weight: 600;
    }

    /* Lanac zadataka (Goran, 05.09.2026.): „onim jednim koji blokira cijeli niz, to bi
       trebalo biti vidljivije oznaceno jer ovako ne vidim." Broj otkljucanih zadataka je
       jedino sto razlikuje korijen niza od obicne kartice — dosad se nije prikazivao. */
    .lanac-badge {
      font-size: 0.68rem; border-radius: 3px; padding: 1px 5px; margin-left: 6px;
      font-weight: 600; background: #3a2d13; color: #e8c65a; border: 1px solid #6b5b2a;
    }
    .lanac-badge.korijen { background: #8a5a12; color: #1a1a1a; border-color: #b8801f; }
    .lanac-badge.ceka { background: #2a2030; color: #c0a8d0; border-color: #4a3a58; font-weight: 500; }
    .task-card.korijen-niza { border-left: 3px solid #d4a017; }

    /* Add Task Button */
    .add-task-btn {
      position: fixed;
      bottom: 2rem;
      right: 2rem;
      width: 56px;
      height: 56px;
      border-radius: 50%;
      background: var(--accent-blue);
      color: white;
      border: none;
      font-size: 2rem;
      cursor: pointer;
      box-shadow: 0 4px 12px rgba(59, 130, 246, 0.4);
      transition: transform 0.2s, box-shadow 0.2s;
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }

    .add-task-btn:hover {
      transform: scale(1.1);
      box-shadow: 0 6px 16px rgba(59, 130, 246, 0.6);
    }

    .add-task-btn:active { transform: scale(0.95); }

    /* Modal */
    .modal-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.7);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 2000;
      animation: fadeIn 0.2s;
    }

    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    .modal {
      background: var(--bg-secondary);
      border-radius: 0.5rem;
      padding: 1.5rem;
      max-width: 500px;
      width: 90%;
      max-height: 90vh;
      overflow-y: auto;
      animation: slideUp 0.3s;
    }

    @keyframes slideUp {
      from { transform: translateY(20px); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }

    .modal h3 {
      font-size: 1.25rem;
      margin-bottom: 1rem;
      color: var(--text-primary);
    }

    .form-group {
      margin-bottom: 1rem;
    }

    .form-group label {
      display: block;
      font-size: 0.875rem;
      color: var(--text-secondary);
      margin-bottom: 0.25rem;
    }

    .form-group input,
    .form-group textarea,
    .form-group select {
      width: 100%;
      background: var(--bg-tertiary);
      border: 1px solid var(--bg-tertiary);
      border-radius: 0.375rem;
      padding: 0.5rem;
      color: var(--text-primary);
      font-family: inherit;
      font-size: 0.875rem;
    }

    .form-group textarea {
      min-height: 100px;
      resize: vertical;
    }

    .form-group input:focus,
    .form-group textarea:focus,
    .form-group select:focus {
      outline: none;
      border-color: var(--accent-blue);
    }

    .modal-actions {
      display: flex;
      gap: 0.5rem;
      justify-content: flex-end;
      margin-top: 1.5rem;
    }

    .btn {
      padding: 0.5rem 1rem;
      border-radius: 0.375rem;
      border: none;
      cursor: pointer;
      font-size: 0.875rem;
      font-weight: 500;
      transition: opacity 0.2s;
    }

    .btn:hover { opacity: 0.8; }

    .btn-primary {
      background: var(--accent-blue);
      color: white;
    }

    .btn-secondary {
      background: var(--bg-tertiary);
      color: var(--text-primary);
    }

    /* Progress Bar - Color-coded based on progress */
    .progress-bar-container {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-top: 0.5rem;
      margin-bottom: 0.25rem;
    }

    .progress-bar {
      flex: 1;
      height: 10px;
      background: var(--bg-primary);
      border-radius: 5px;
      overflow: hidden;
      position: relative;
    }

    .progress-bar-fill {
      height: 100%;
      border-radius: 5px;
      transition: width 0.3s ease, background-color 0.3s ease;
      position: relative;
      overflow: hidden;
    }

    /* Color coding: red < 30%, yellow 30-70%, green > 70% */
    .progress-bar-fill.progress-low {
      background: linear-gradient(90deg, var(--accent-red), #f87171);
    }

    .progress-bar-fill.progress-medium {
      background: linear-gradient(90deg, var(--accent-yellow), #fbbf24);
    }

    .progress-bar-fill.progress-high {
      background: linear-gradient(90deg, var(--accent-green), #4ade80);
    }

    .progress-bar-fill::after {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: linear-gradient(90deg, transparent, rgba(255,255,255,0.2), transparent);
      animation: shimmer 2s infinite;
    }

    @keyframes shimmer {
      0% { transform: translateX(-100%); }
      100% { transform: translateX(100%); }
    }

    .progress-text {
      font-size: 0.75rem;
      font-weight: 500;
      color: var(--text-secondary);
      min-width: 35px;
      text-align: right;
    }

    .progress-text.progress-low { color: var(--accent-red); }
    .progress-text.progress-medium { color: var(--accent-yellow); }
    .progress-text.progress-high { color: var(--accent-green); }

    /* ============================================ */
    /* KONZOLA TAB                                  */
    /* ============================================ */
    .konzola-status-bar {
      display: flex; flex-wrap: wrap; gap: 0.75rem; padding: 0.75rem 1rem;
      background: var(--bg-secondary); border-radius: 0.5rem; margin-bottom: 0.5rem;
      border: 1px solid var(--border-color);
      font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace; font-size: 0.8rem;
    }
    .konzola-status-item { display: flex; align-items: center; gap: 0.25rem; }
    .konzola-status-label { color: var(--text-secondary); }
    .konzola-status-value { color: var(--accent-green); font-weight: 600; }
    .konzola-status-value.s-error { color: var(--accent-red); }
    .konzola-status-value.s-warn { color: var(--accent-yellow); }
    .konzola-mode-toggle { margin-left: auto; }
    .konzola-mode-btn {
      padding: 0.25rem 0.75rem; border: 1px solid var(--accent-blue); border-radius: 0.25rem;
      background: transparent; color: var(--accent-blue); font-size: 0.75rem; font-weight: 700;
      font-family: monospace; cursor: pointer; letter-spacing: 0.05em; transition: all 0.2s;
    }
    .konzola-mode-btn.plan-mode { border-color: var(--accent-yellow); color: var(--accent-yellow); }
    .konzola-mode-btn.work-mode { border-color: var(--accent-green); color: var(--accent-green); background: rgba(34,197,94,0.1); }
    .konzola-output-wrapper {
      background: #0a0e17; border: 1px solid var(--border-color); border-radius: 0.5rem;
      height: calc(100vh - 320px); overflow-y: auto; margin-bottom: 0.5rem;
    }
    .konzola-output {
      padding: 0.75rem;
      font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace;
      font-size: 0.8rem; line-height: 1.5; white-space: pre-wrap; word-wrap: break-word; color: #c8d6e5;
    }
    .konzola-output .log-ts { color: var(--text-secondary); font-size: 0.75rem; }
    .konzola-output .log-info { color: #3b82f6; }
    .konzola-output .log-warn { color: #f59e0b; }
    .konzola-output .log-error { color: #ef4444; }
    .konzola-output .log-success { color: #22c55e; }
    .konzola-output .log-cmd { color: #a78bfa; }
    .konzola-output .log-thinking { color: #c084fc; font-style: italic; opacity: 0.9; }
    .konzola-output .log-text { color: #67e8f9; }
    .konzola-output .log-system { color: var(--text-secondary); font-style: italic; }
    .konzola-output .konzola-welcome { color: #3b82f6; padding-bottom: 0.5rem; border-bottom: 1px solid var(--border-color); margin-bottom: 0.5rem; }
    .konzola-input-wrapper {
      display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem 0.75rem;
      background: #0a0e17; border: 1px solid var(--border-color); border-radius: 0.5rem;
    }
    .konzola-prompt { color: var(--accent-green); font-family: 'JetBrains Mono', monospace; font-size: 0.8rem; font-weight: 700; white-space: nowrap; }
    .konzola-input { flex: 1; background: transparent; border: none; outline: none; color: var(--text-primary); font-family: 'JetBrains Mono', monospace; font-size: 0.8rem; caret-color: var(--accent-green); }

    /* ============================================ */
    /* STATUS TAB                                   */
    /* ============================================ */
    .status-header-bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem; }
    .status-section {
      background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 0.5rem;
      padding: 1rem; margin-bottom: 0.75rem;
    }
    .status-section-title {
      font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em;
      color: var(--text-secondary); border-bottom: 1px solid var(--border-color);
      padding-bottom: 0.5rem; margin-bottom: 0.75rem;
    }
    .service-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 0.5rem; }
    .service-badge {
      display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem 0.75rem;
      background: var(--bg-primary); border-radius: 0.375rem; border: 1px solid var(--border-color);
      font-size: 0.8rem; font-family: monospace;
    }
    .service-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
    .service-dot.running { background: #22c55e; box-shadow: 0 0 4px #22c55e; }
    .service-dot.stopped { background: #ef4444; box-shadow: 0 0 4px #ef4444; }
    .service-dot.disabled { background: #6b7280; }
    .service-dot.ok { background: #22c55e; box-shadow: 0 0 4px #22c55e; }
    .service-dot.down { background: #ef4444; box-shadow: 0 0 4px #ef4444; }
    .stat-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 0.75rem; }
    .stat-box {
      text-align: center; padding: 0.75rem; background: var(--bg-primary); border-radius: 0.375rem;
      border: 1px solid var(--border-color);
    }
    .stat-value { font-size: 1.5rem; font-weight: 700; color: var(--accent-blue); font-family: monospace; }
    .stat-label { font-size: 0.7rem; color: var(--text-secondary); margin-top: 0.25rem; text-transform: uppercase; letter-spacing: 0.05em; }
    .token-table { width: 100%; border-collapse: collapse; font-family: monospace; font-size: 0.8rem; }
    .token-table th { text-align: left; padding: 0.5rem; border-bottom: 1px solid var(--border-color); color: var(--text-secondary); font-size: 0.7rem; text-transform: uppercase; }
    .token-table td { padding: 0.5rem; border-bottom: 1px solid var(--border-color); }
    .token-table td:not(:first-child) { text-align: right; }
    .token-table .total-row { font-weight: 700; border-top: 2px solid var(--border-color); }
    .progress-bar-sm { height: 6px; background: var(--bg-primary); border-radius: 3px; overflow: hidden; margin-top: 0.5rem; }
    .progress-bar-sm-fill { height: 100%; border-radius: 3px; transition: width 0.3s; }
    .project-progress-item { display: flex; align-items: center; gap: 0.75rem; padding: 0.5rem 0; border-bottom: 1px solid var(--border-color); }
    .project-progress-item:last-child { border-bottom: none; }
    .project-progress-name { flex: 0 0 200px; font-size: 0.8rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .project-progress-bar { flex: 1; }
    .project-progress-pct { flex: 0 0 45px; text-align: right; font-family: monospace; font-size: 0.8rem; font-weight: 600; }

    /* Info Tab */
    /* align-items: start — kartica se ne rasteze na visinu susjede. Dok kartice nisu
       imale podlogu to se nije vidjelo; sada bi kraca kartica bila prazna ploha visine
       duze (System uz AI Providers: 320 px praznine). */
    .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; align-items: start; }
    @media (max-width: 900px) { .info-grid { grid-template-columns: 1fr; } }
    .info-card { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 8px; padding: 1rem; }
    .info-card-title { font-size: 0.85rem; font-weight: 700; color: var(--accent-blue); margin-bottom: 0.75rem; text-transform: uppercase; letter-spacing: 0.5px; display: flex; align-items: center; gap: 0.5rem; }
    .info-card-title .icon { font-size: 1rem; }

    /* Kontrole na Config stranici (TASK-4803).
       Prije ovoga je isti niz inline stilova stajao u 19 preslika, a gumbi nisu imali
       nikakav stil — preglednik ih je crtao svojim svijetlim kromom nasred tamne ploče.
       Klasa je jedno mjesto istine, pa nova kartica ne može odstupiti od obrasca. */
    .cfg-polje { font-size: 0.72rem; padding: 3px 6px; border-radius: 4px; background: var(--bg-primary); color: var(--text-primary); border: 1px solid var(--border-color); }
    .cfg-polje:focus { outline: none; border-color: var(--accent-blue); }
    .cfg-btn { font-size: 0.72rem; padding: 3px 10px; border-radius: 4px; background: var(--bg-tertiary); color: var(--text-primary); border: 1px solid var(--border-color); cursor: pointer; }
    .cfg-btn:hover:enabled { background: var(--accent-blue); border-color: var(--accent-blue); color: #fff; }
    .cfg-btn:disabled { opacity: 0.5; cursor: default; }
    /* Polje i njegov gumb Spremi ostaju u istom retku. Dok je ćelija bila tvrdih 290 px,
       polje od 260 px gurnulo bi gumb u sljedeći red i SVAKI redak bio bi dvostruko visok
       (kartica Integracije mjerila je 2565 px). */
    .info-table td.cfg-kontrola { white-space: nowrap; width: 1%; }
    .cfg-obavezno { color: var(--accent-yellow); font-weight: 700; margin-left: 0.15rem; }
    /* Podnaslov skupine unutar kartice: bez njega su se dva polja imena Host (SMTP i IMAP)
       nizala jedno ispod drugoga bez ičega što bi reklo koje je koje. */
    .info-table tr.cfg-skupina td { padding-top: 0.8rem; color: var(--accent-blue); font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 700; border-bottom-color: var(--border-color); }
    /* Odjeljak integracije unutar zajedničke kartice. */
    .cfg-odjeljak { margin: 0.7rem 0; padding: 0.6rem; border: 1px solid var(--border-color); border-radius: 6px; background: rgba(0,0,0,0.15); }
    .cfg-odjeljak-glava { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.35rem; }
    .cfg-legenda { font-size: 0.68rem; color: var(--text-secondary); margin-bottom: 0.6rem; }
    /* Naslov skupine kartica (TASK-4803). Osamnaest kartica bez ijedne podjele citalo se
       kao jedan zid: podesavanje i puki ispis stanja stajali su izmijesano, pa se nije
       vidjelo gdje se sto MIJENJA a gdje se samo CITA. */
    .info-skupina { grid-column: 1 / -1; margin: 0.5rem 0 0; border-top: 1px solid var(--border-color); padding-top: 0.9rem; }
    .info-skupina:first-child { border-top: none; margin-top: 0; padding-top: 0; }
    .info-skupina h3 { margin: 0; font-size: 0.9rem; color: var(--text-primary); letter-spacing: 0.3px; }
    .info-skupina p { margin: 0.2rem 0 0; font-size: 0.72rem; color: var(--text-secondary); }
    .info-table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
    .info-table th { text-align: left; padding: 0.4rem 0.5rem; color: var(--text-secondary); font-size: 0.7rem; text-transform: uppercase; border-bottom: 1px solid var(--border-color); }
    .info-table td { padding: 0.4rem 0.5rem; border-bottom: 1px solid rgba(255,255,255,0.04); vertical-align: top; }
    .info-table tr:last-child td { border-bottom: none; }
    .info-badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 4px; font-size: 0.7rem; font-weight: 600; }
    .info-badge.frontier { background: rgba(139,92,246,0.2); color: #a78bfa; }
    .info-badge.strong { background: rgba(59,130,246,0.2); color: #60a5fa; }
    .info-badge.good { background: rgba(34,197,94,0.2); color: #4ade80; }
    .info-badge.basic { background: rgba(250,204,21,0.2); color: #facc15; }
    .info-badge.classifier { background: rgba(148,163,184,0.2); color: #94a3b8; }
    .info-badge.enabled { background: rgba(34,197,94,0.2); color: #22c55e; }
    .info-badge.disabled { background: rgba(148,163,184,0.15); color: #64748b; }
    .info-badge.required { background: rgba(239,68,68,0.2); color: #f87171; }
    .info-version { font-size: 1.5rem; font-weight: 800; color: var(--text-primary); margin-bottom: 0.25rem; }
    .info-subtitle { color: var(--text-secondary); font-size: 0.8rem; margin-bottom: 1rem; }
    .info-kv { display: flex; justify-content: space-between; padding: 0.3rem 0; border-bottom: 1px solid rgba(255,255,255,0.04); font-size: 0.8rem; }
    .info-kv:last-child { border-bottom: none; }
    .info-kv-label { color: var(--text-secondary); }
    .info-kv-value { color: var(--text-primary); font-weight: 600; font-family: monospace; }
    .info-full { grid-column: 1 / -1; }
    .info-provider-row { display: flex; align-items: center; gap: 0.5rem; padding: 0.4rem 0; border-bottom: 1px solid rgba(255,255,255,0.04); }
    .info-provider-row:last-child { border-bottom: none; }
    .info-dot { width: 8px; height: 8px; border-radius: 50%; }
    .info-dot.online { background: #22c55e; }
    .info-dot.offline { background: #64748b; }
    .wf-step { background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 6px; padding: 0.75rem; margin-bottom: 0.5rem; }
    .wf-step-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem; }
    .wf-step-title { font-weight: 700; font-size: 0.85rem; color: var(--accent-blue); }
    .wf-step-actions { display: flex; gap: 0.25rem; }
    .wf-step-actions button { background: transparent; border: 1px solid var(--border-color); color: var(--text-secondary); padding: 2px 8px; border-radius: 4px; cursor: pointer; font-size: 0.7rem; }
    .wf-step-actions button:hover { color: var(--text-primary); border-color: var(--accent-blue); }
    .wf-step-actions button.btn-del:hover { border-color: var(--accent-red); color: var(--accent-red); }
    .wf-step textarea { width: 100%; min-height: 80px; background: var(--bg-primary); color: var(--text-primary); border: 1px solid var(--border-color); border-radius: 4px; padding: 0.5rem; font-family: 'JetBrains Mono', monospace; font-size: 0.75rem; resize: vertical; }
    .wf-toolbar { display: flex; gap: 0.5rem; margin-top: 0.75rem; padding-top: 0.75rem; border-top: 1px solid var(--border-color); }
    .wf-toolbar button { padding: 6px 14px; border-radius: 4px; font-size: 0.8rem; cursor: pointer; border: 1px solid var(--border-color); }
    .wf-toolbar .btn-save { background: var(--accent-green); color: #000; border-color: var(--accent-green); font-weight: 600; }
    .wf-toolbar .btn-add { background: transparent; color: var(--accent-blue); border-color: var(--accent-blue); }
    .wf-toolbar .btn-close { background: transparent; color: var(--text-secondary); }
    .wf-item { padding: 0.35rem 0.5rem; cursor: pointer; border-radius: 4px; font-size: 0.8rem; display: flex; justify-content: space-between; }
    .wf-item:hover { background: rgba(59,130,246,0.1); }
    .wf-item .wf-skill { color: var(--text-secondary); font-size: 0.7rem; }
  
    /* Ceka odluku */
    .odluke-traka { background:#2a2416; border:1px solid #6b5b2a; border-left:4px solid #d4a017;
      border-radius:6px; padding:10px 14px; margin-bottom:14px; }
    .odluke-glava { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
    .odluke-znak { background:#d4a017; color:#1a1608; font-size:10.5px; font-weight:700;
      padding:2px 7px; border-radius:3px; letter-spacing:0.5px; }
    .odluke-glava strong { color:#e8c65a; }
    .odluke-opis { color:#9a8c60; font-size:12px; }
    .odluke-toggle { margin-left:10px; background:#3d3419; color:#e8c65a; border:1px solid #6b5b2a;
      border-radius:4px; padding:3px 12px; cursor:pointer; font-size:12px; }
    .odluke-toggle:hover { background:#4d421f; }
    /* Zadnji prolaz odlucitelja — jedini dokaz da ukljuceni prekidac doista nesto radi. */
    .odluke-prolaz { margin-top:7px; font-size:11.5px; color:#9a8c60; }
    .odluke-prolaz.greska { color:#d98c6a; }
    .odluka-model-kaze { margin-top:7px; font-size:11.5px; color:#8fa8c0; background:#151b22;
      border:1px solid #2c3a48; border-left:3px solid #4a7fa8; border-radius:4px; padding:6px 9px; }
    .odluke-popis { margin-top:12px; display:flex; flex-direction:column; gap:10px; }
    .odluka-stavka { background:#1e1a10; border:1px solid #4a4020; border-radius:5px; padding:10px 12px; }
    .odluka-naslov { color:#e0d5b0; font-size:13px; margin-bottom:3px; }
    .odluka-meta { color:#8a7d55; font-size:11px; margin-bottom:8px; }
    .odluka-opis { color:#a89b70; font-size:11.5px; margin-bottom:8px; white-space:pre-wrap;
      max-height:150px; overflow:auto; }
    /* Goran, 05.09.2026.: „Prvo ne mogu unutra napisati dulji tekst, to mora biti omoguceno."
       Polje je bilo rows=1 / 36 px pa je izgledalo kao jednoredni unos — obrazlozenje odluke
       se u njemu nije dalo ni procitati. Sada je uspravno slozeno, puna sirina i raste. */
    .odluka-red { display:flex; flex-direction:column; gap:8px; align-items:stretch; }
    .odluka-unos { width:100%; box-sizing:border-box; background:#12100a; color:#e0d5b0;
      border:1px solid #5a4d28; border-radius:4px; padding:9px 11px; font-size:12.5px;
      font-family:inherit; resize:vertical; min-height:104px; line-height:1.5; }
    .odluka-unos:focus { outline:none; border-color:#d4a017; }
    .odluka-alat { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
    .odluka-savjet { color:#7d7047; font-size:11px; }

    /* Strukturirano pitanje: struka + opcije. Bez opcija odluka je bila slobodan sastavak,
       pa se u povijesti zadatka nije vidjelo IZMEDJU CEGA se biralo. */
    .pitanje-blok { background:#161b12; border:1px solid #3f5030; border-left:3px solid #7fae4f;
      border-radius:5px; padding:9px 11px; margin-bottom:9px; }
    .pitanje-struka { color:#a9d17a; font-size:11.5px; font-weight:600; margin-bottom:4px; }
    .pitanje-tekst { color:#cfe0b8; font-size:12.5px; white-space:pre-wrap; margin-bottom:8px; }
    .pitanje-opcije { display:flex; flex-direction:column; gap:5px; }
    .opcija-gumb { text-align:left; background:#1d2417; color:#d5e6c0; border:1px solid #46592f;
      border-radius:4px; padding:6px 9px; font-size:12px; font-family:inherit; cursor:pointer; }
    .opcija-gumb:hover { background:#27311e; border-color:#7fae4f; }
    .opcija-gumb.izabrana { background:#2d3d21; border-color:#9ccf62; color:#e8f5d8; }
    .opcija-slovo { display:inline-block; min-width:16px; font-weight:700; color:#9ccf62; }
    .pitanje-preporuka { color:#8fa872; font-size:11.5px; margin-top:7px; font-style:italic; }
    .pitanje-manjka { background:#2a1a12; border:1px solid #6b3a20; border-left:3px solid #d97a3a;
      border-radius:5px; padding:8px 11px; margin-bottom:9px; color:#e0b48c; font-size:11.5px; }
    .pitanje-manjka ul { margin:5px 0 0 16px; padding:0; }

    /* Koliko niza drzi jedan zadatak — dosad se nigdje nije vidjelo. */
    .odluka-lanac { display:inline-block; background:#3a2d13; color:#e8c65a; border:1px solid #6b5b2a;
      border-radius:3px; padding:1px 7px; font-size:10.5px; font-weight:700; margin-left:6px; }
    .odluka-lanac.korijen { background:#5a3a10; color:#ffd77a; border-color:#96631a; }
    .odluka-ceka-na { display:inline-block; background:#2a2030; color:#c0a8d0; border:1px solid #4a3a58;
      border-radius:3px; padding:1px 7px; font-size:10.5px; margin-left:6px; }
    .odluka-nastavi { background:#2d6a2d; color:#d8f0d8; border:1px solid #3f8f3f; border-radius:4px;
      padding:7px 18px; cursor:pointer; font-size:12.5px; white-space:nowrap; }
    .odluka-nastavi:hover { background:#377f37; }
    .odluka-nastavi:disabled { background:#3a3a3a; color:#777; border-color:#4a4a4a; cursor:default; }
    .odluka-poruka { font-size:11.5px; margin-top:6px; }
  
    .izbor-jezika { background:#1e2530; color:#9fb3c8; border:1px solid #33415c; border-radius:4px;
      padding:4px 8px; font-size:12px; margin-right:8px; cursor:pointer; }
    .izbor-jezika:hover { border-color:#4a5f80; color:#cfe0f0; }
  
    .odluc-broj { width:64px; background:#12100a; color:#e0d5b0; border:1px solid #5a4d28;
      border-radius:4px; padding:3px 6px; font-size:12px; font-family:inherit; }
    .odluke-odlucitelj { display:none; align-items:center; gap:10px; flex-wrap:wrap;
      margin-top:10px; padding-top:10px; border-top:1px solid #4a4020; }
    .odluc-prekidac { display:flex; align-items:center; gap:6px; color:#c9b87a; font-size:12px;
      cursor:pointer; }
    .odluc-model { background:#12100a; color:#e0d5b0; border:1px solid #5a4d28; border-radius:4px;
      padding:4px 8px; font-size:12px; }
    .odluc-gumb { background:#3d3419; color:#e8c65a; border:1px solid #6b5b2a; border-radius:4px;
      padding:4px 12px; cursor:pointer; font-size:12px; }
    .odluc-gumb:hover { background:#4d421f; }
    .odluc-gumb:disabled { background:#2a2a2a; color:#777; border-color:#444; cursor:default; }
    .odluc-glavni { background:#2d6a2d; color:#d8f0d8; border-color:#3f8f3f; }
    .odluc-glavni:hover { background:#377f37; }
    .odluc-poruka { font-size:11.5px; color:#9a8c60; }
  
    .odluke-tko { margin-left:auto; font-size:11.5px; padding:2px 9px; border-radius:3px;
      border:1px solid #5a4d28; color:#c9b87a; }
    .odluke-tko.aktivan { background:#2d4a2d; border-color:#3f8f3f; color:#a8e0a8; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1 data-i18n="regoc_taskmanagermd">Regoč TaskManagerMD</h1>
      <div class="status">
        <!-- TASK-3047: ručna kočnica. Stoji u zaglavlju jer mora biti dohvatljiva s bilo
             kojeg taba — kad nešto krene po zlu, ne traži se gumb po karticama. -->
        <select id="izbor-jezika" class="izbor-jezika" data-i18n-title="jezik_sucelja" title="Jezik sučelja"></select>
        <button id="global-pause-btn" class="global-pause-btn" title="Zaustavi sav automatski rad" data-i18n-title="zaustavi_sav_automatski_rad" data-i18n="pauza">&#9208; Pauza</button>
        <span id="global-pause-info" class="global-pause-info"></span>
        <span id="connection-status" class="status-dot"></span>
        <span id="status-text" data-i18n="connecting">Connecting...</span>
      </div>
    </header>

    <!-- Tab Navigation -->
    <nav class="tab-nav">
      <div class="tab-nav-left">
        <button class="tab-btn active" data-tab="tasks" data-i18n="tasks">Tasks</button>
        <button class="tab-btn" data-tab="projects" data-i18n="projects">Projects</button>
        <button class="tab-btn" data-tab="rag">RAG</button>
        <button class="tab-btn" data-tab="konzola" data-i18n="konzola">Konzola</button>
        <button class="tab-btn" data-tab="potrosnja" data-i18n="potro_nja">Potro&#353;nja</button>
        <button class="tab-btn" data-tab="status" data-i18n="status">Status</button>
        <button class="tab-btn" data-tab="info" data-i18n="config">Config</button>
      </div>
      <div class="tab-nav-right">
        <select id="tasks-project-filter" class="filter-select">
          <option value="" data-i18n="all_projects">All Projects</option>
        </select>
      </div>
    </nav>

    <!-- TASKS TAB -->
    <div id="tab-tasks" class="tab-content active">
      <!-- Ceka odluku: oznaka needs-decision je ispravan mehanizam, ali je do 04.09.2026.
           bila nevidljiva — devet zadataka stajalo je 1,5 h a nigdje se nije vidjelo da
           cekaju. Traka se prikazuje SAMO kad ima takvih zadataka. -->
      <div id="odluke-traka" class="odluke-traka" style="display:none">
        <div class="odluke-glava">
          <span class="odluke-znak" data-i18n="ceka">ČEKA</span>
          <strong id="odluke-naslov" data-i18n="ceka_tvoju_odluku">Čeka tvoju odluku</strong>
          <span class="odluke-opis" data-i18n="stroj_ih_namjerno_ne_dira_dok_ne_odlucis">stroj ih namjerno ne dira dok ne odlučiš</span>
          <span id="odluke-tko" class="odluke-tko"></span>
          <button id="odluke-toggle" class="odluke-toggle" data-i18n="prikazi">prikaži</button>
        </div>
        <div id="odluke-prolaz" class="odluke-prolaz" style="display:none"></div>
        <div id="odluke-odlucitelj" class="odluke-odlucitelj">
          <label class="odluc-prekidac">
            <input type="checkbox" id="odluc-ukljucen">
            <span data-i18n="neka_model_odluci">Neka model odluči umjesto mene</span>
          </label>
          <select id="odluc-provider" class="odluc-model"
                  data-i18n-title="davatelj_modela" title="Davatelj"></select>
          <select id="odluc-model" class="odluc-model" data-i18n-title="model_koji_odlucuje"
                  title="Model koji odlučuje"></select>
          <label class="odluc-prekidac" data-i18n-title="koliko_imas_vremena_za_odluku"
                 title="Koliko imaš vremena za odluku prije nego model odluči umjesto tebe">
            <span data-i18n="cekanje_h">čekanje (h)</span>
            <input type="number" id="odluc-cekanje" class="odluc-broj" min="0.25" max="72" step="0.25">
          </label>
          <button id="odluc-proba" class="odluc-gumb" data-i18n="probaj_bez_upisa">Probaj (bez upisa)</button>
          <button id="odluc-izvrsi" class="odluc-gumb odluc-glavni" data-i18n="odluci_sada">Odluči sada</button>
          <span id="odluc-poruka" class="odluc-poruka"></span>
        </div>
        <div id="odluke-popis" class="odluke-popis" style="display:none"></div>
      </div>

      <div class="stats" id="stats">
        <div class="stat"><div class="stat-value" id="total-count">-</div><div class="stat-label" data-i18n="total">Total</div></div>
        <div class="stat"><div class="stat-value" id="progress-count">-</div><div class="stat-label" data-i18n="in_progress">In Progress</div></div>
        <div class="stat"><div class="stat-value" id="pending-count">-</div><div class="stat-label" data-i18n="pending">Pending</div></div>
        <div class="stat"><div class="stat-value" id="blocked-count">-</div><div class="stat-label" data-i18n="blocked">Blocked</div></div>
        <div class="stat"><div class="stat-value" id="completed-count">-</div><div class="stat-label" data-i18n="completed">Completed</div></div>
        <div class="stat"><div class="stat-value" id="cancelled-count">-</div><div class="stat-label" data-i18n="cancelled">Cancelled</div></div>
        <div class="stat" title="Zadaci koje je vratar danas propustio, a nije mogao ni jednu provjeru pokrenuti (izvor: data/critic_gate.jsonl)" data-i18n-title="zadaci_koje_je_vratar_danas_propustio_a_nije"><div class="stat-value" id="unverified-count">-</div><div class="stat-label" data-i18n="danas_neprovjereno">Danas neprovjereno</div></div>
        <div class="stat"><div class="stat-value" id="overall-progress">-</div><div class="stat-label" data-i18n="overall_progress">Overall Progress</div></div>
      </div>

      <div class="agent-filter" id="agent-filter">
        <button class="agent-btn active" data-agent="all" data-i18n="all_agents">All Agents</button>
      </div>

      <div class="grid">
        <div class="column in-progress">
          <h2 data-i18n="in_progress">In Progress</h2>
          <div id="in-progress-tasks"></div>
        </div>
        <div class="column pending">
          <h2 data-i18n="pending">Pending</h2>
          <div id="pending-tasks"></div>
        </div>
        <div class="column blocked">
          <h2 data-i18n="blocked">Blocked</h2>
          <div id="blocked-tasks"></div>
        </div>
        <div class="column completed">
          <h2 data-i18n="completed_recent">Completed (Recent)</h2>
          <div id="completed-tasks"></div>
        </div>
      </div>
    </div>

    <!-- PROJECTS TAB -->
    <div id="tab-projects" class="tab-content">
      <div class="projects-header">
        <div class="projects-filter" id="projects-agent-filter">
          <button class="agent-btn active" data-agent="all" data-i18n="all_agents">All Agents</button>
        </div>
        <div style="display:flex;gap:0.35rem;align-items:center;margin-left:auto;">
          <label for="projects-sort" style="font-size:0.78rem;color:var(--text-secondary);" data-i18n="poredak">Poredak:</label>
          <select id="projects-sort" class="filter-select">
            <option value="aktivnost" selected data-i18n="zadnji_rad">zadnji rad</option>
            <option value="cijena" data-i18n="potro_nja_2">potro&#353;nja</option>
            <option value="ime" data-i18n="ime">ime</option>
            <option value="pocetak" data-i18n="po_etak_rada">po&#269;etak rada</option>
            <option value="zadataka" data-i18n="broj_zadataka">broj zadataka</option>
          </select>
          <button id="projects-sort-smjer" class="btn btn-secondary" style="padding:0.15rem 0.5rem;"
                  title="Obrni smjer" data-i18n-title="obrni_smjer">&#8595;</button>
        </div>
        <button class="btn btn-primary" id="add-project-btn" data-i18n="new_project">+ New Project</button>
      </div>

      <div class="projects-legend">
        <span class="legend-item"><i class="legend-dot status-active"></i><span data-i18n="prj_status_active">Aktivan</span></span>
        <span class="legend-item"><i class="legend-dot status-on_hold"></i><span data-i18n="prj_status_on_hold">Na čekanju</span></span>
        <span class="legend-item"><i class="legend-dot status-completed"></i><span data-i18n="prj_status_completed">Dovršen</span></span>
        <span class="legend-item"><i class="legend-dot status-archived"></i><span data-i18n="prj_status_archived">Arhiviran</span></span>
        <span class="legend-item" id="projects-sort-opis" data-i18n="poredak_zadnji_rad_na_projektu_najnoviji_prv">Poredak: zadnji rad na projektu — najnoviji prvi</span>
      </div>

      <div class="projects-rows" id="projects-rows"></div>
    </div>

    <!-- RAG TAB -->
    <div id="tab-rag" class="tab-content">
      <div class="rag-header">
        <h2 data-i18n="rag_entries">RAG Entries</h2>
        <div class="rag-filters">
          <input type="text" id="rag-search-input" placeholder="Pretraži RAG..." data-i18n-placeholder="pretrazi_rag" style="padding: 8px 12px; border: 1px solid var(--border-color); border-radius: 4px; font-size: 0.875rem; flex: 1; margin-right: 12px;">
          <select id="rag-collection-filter">
            <option value="" data-i18n="all_collections">All Collections</option>
          </select>
          <select id="rag-project-filter" title="Filtar po projektu (Chroma where project_id)" data-i18n-title="filtar_po_projektu_chroma_where_project_id">
            <option value="" data-i18n="svi_projekti">Svi projekti</option>
          </select>
          <select id="rag-tip-filter" title="Filtar po vrsti dokumenta (tip_regoc)" data-i18n-title="filtar_po_vrsti_dokumenta_tip_regoc">
            <option value="" data-i18n="sve_vrste">Sve vrste</option>
            <option value="pravilo" data-i18n="pravila_za_ti_eno">pravila (za&#353;ti&#263;eno)</option>
            <option value="lekcija" data-i18n="lekcije_za_ti_eno">lekcije (za&#353;ti&#263;eno)</option>
            <option value="pogreska" data-i18n="pogre_ke_za_ti_eno">pogre&#353;ke (za&#353;ti&#263;eno)</option>
            <option value="istrazivanje" data-i18n="istra_ivanja">istra&#382;ivanja</option>
            <option value="spec" data-i18n="specifikacije">specifikacije</option>
            <option value="referenca" data-i18n="reference">reference</option>
            <option value="sjednica" data-i18n="sjednice">sjednice</option>
            <option value="izlaz-agenta" data-i18n="izlazi_agenata">izlazi agenata</option>
            <option value="ocjena" data-i18n="ocjene">ocjene</option>
            <option value="ostalo" data-i18n="ostalo">ostalo</option>
          </select>
          <span id="rag-total-count" style="color: var(--text-secondary); font-size: 0.875rem;" data-i18n="loading">Loading...</span>
        </div>
      </div>

      <div class="rag-list" id="rag-list">
        <div class="empty" data-i18n="loading_rag_entries">Loading RAG entries...</div>
      </div>

      <button class="load-more-btn" id="rag-load-more" style="display: none;" data-i18n="load_more">Load More</button>
    </div>

    <!-- KONZOLA TAB -->
    <div id="tab-konzola" class="tab-content">
      <div class="konzola-status-bar" id="konzola-status-bar">
        <div class="konzola-status-item">
          <span class="konzola-status-label" data-i18n="daemon">Daemon:</span>
          <span id="konzola-daemon-status" class="konzola-status-value">--</span>
        </div>
        <div class="konzola-status-item">
          <span class="konzola-status-label" data-i18n="uptime">Uptime:</span>
          <span id="konzola-uptime" class="konzola-status-value">--</span>
        </div>
        <div class="konzola-status-item">
          <span class="konzola-status-label" data-i18n="task">Task:</span>
          <span id="konzola-current-task" class="konzola-status-value" style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">--</span>
        </div>
        <div class="konzola-status-item">
          <span class="konzola-status-label" data-i18n="pending_2">Pending:</span>
          <span id="konzola-pending" class="konzola-status-value">--</span>
        </div>
        <div class="konzola-status-item">
          <span class="konzola-status-label" data-i18n="processed">Processed:</span>
          <span id="konzola-processed" class="konzola-status-value">--</span>
        </div>
        <div class="konzola-status-item">
          <span class="konzola-status-label" data-i18n="context">Context:</span>
          <span id="konzola-context" class="konzola-status-value">--</span>
        </div>
        <div class="konzola-status-item">
          <span class="konzola-status-label" data-i18n="services">Services:</span>
          <span id="konzola-services" class="konzola-status-value">--</span>
        </div>
        <div class="konzola-status-item" title="Potrošnja trenutne Claude sesije (5h prozor) / tjedna (7d)" data-i18n-title="potrosnja_trenutne_claude_sesije_5h_prozor_t">
          <span class="konzola-status-label" data-i18n="sesija">Sesija:</span>
          <span id="konzola-session" class="konzola-status-value">--</span>
        </div>
        <div class="konzola-status-item konzola-mode-toggle">
          <button id="konzola-mode-btn" class="konzola-mode-btn plan-mode" data-i18n="plan">PLAN</button>
          <button id="persistent-btn" class="konzola-mode-btn" style="border-color:#6b7280;color:#6b7280;margin-left:4px" title="Persistent agents config" data-i18n-title="persistent_agents_config" data-i18n="agents">AGENTS</button>
        </div>
        <!-- Persistent agents panel (hidden by default) -->
        <div id="persistent-panel" style="display:none;background:#0d1117;border:1px solid #1e293b;border-radius:0.5rem;padding:0.75rem;margin:0.5rem 0;font-family:monospace;font-size:0.8rem">
          <div style="color:#93c5fd;margin-bottom:0.5rem;font-weight:700" data-i18n="persistent_agents">PERSISTENT AGENTS</div>
          <div id="persistent-agent-list" style="color:#c8d6e5"></div>
          <div style="margin-top:0.5rem;display:flex;gap:4px">
            <button id="persistent-all-btn" class="konzola-mode-btn" style="border-color:#22c55e;color:#22c55e;font-size:0.7rem" data-i18n="all_on">ALL ON</button>
            <button id="persistent-off-btn" class="konzola-mode-btn" style="border-color:#ef4444;color:#ef4444;font-size:0.7rem" data-i18n="all_off">ALL OFF</button>
          </div>
        </div>
      </div>
      <div class="konzola-output-wrapper">
        <div class="konzola-output" id="konzola-output">
          <div class="konzola-welcome" data-i18n="konzola_ready_type_help_for_commands">Konzola ready. Type 'help' for commands.</div>
        </div>
      </div>
      <!-- TASK-4722: OBAVEZNO <form>, ne <div>. Preglednik sve kontrole bez vlasnika obrasca
           slaže u JEDAN sintetski obrazac, pa je konzolni unos dijelio obrazac s poljima za
           lozinku iz kartice Config (login-key-*, prov-*-key) i upravitelj lozinkama ga je
           čitao kao korisničko ime. autocomplete=off i data-* to NE rješavaju. -->
      <form class="konzola-input-wrapper" autocomplete="off" onsubmit="return false;">
        <span class="konzola-prompt" id="konzola-prompt">regoc $</span>
        <input type="text" id="konzola-input" class="konzola-input" placeholder="Type a command..." data-i18n-placeholder="type_a_command"
               name="regoc-konzola" autocomplete="off" spellcheck="false"
               data-form-type="other" data-lpignore="true" data-1p-ignore data-bwignore>
      </form>
    </div>

    <!-- POTROŠNJA TAB — TASK-3569 (T5), mjera 6: tjedni pregled po projektu i agentu.
         Sve brojke dolaze s GET /api/pregled/tjedni, koji zove
         ~/app/regoc_system/tools/tjedni_pregled.py nad run_log.jsonl i NAŠIM
         transkriptima. Uz svaku agregaciju stoji IZ KOLIKO je izvođenja izračunata. -->
    <div id="tab-potrosnja" class="tab-content">
      <div class="status-header-bar">
        <h2 style="margin:0;font-size:1.1rem;" data-i18n="potro_nja_tjedni_pregled">Potro&#353;nja &mdash; tjedni pregled</h2>
        <div style="display:flex;align-items:center;gap:0.75rem;">
          <select id="potrosnja-dana" class="filter-select">
            <option value="3650" selected data-i18n="svo_vrijeme">svo vrijeme</option>
            <option value="7" data-i18n="zadnjih_7_dana">zadnjih 7 dana</option>
            <option value="14" data-i18n="zadnjih_14_dana">zadnjih 14 dana</option>
            <option value="30" data-i18n="zadnjih_30_dana">zadnjih 30 dana</option>
            <option value="90" data-i18n="zadnjih_90_dana">zadnjih 90 dana</option>
          </select>
          <span id="potrosnja-izvor" style="color:var(--text-secondary);font-size:0.72rem;" data-i18n="x">&mdash;</span>
          <button id="potrosnja-refresh-btn" class="konzola-mode-btn plan-mode"
                  style="border-color:var(--accent-blue);color:var(--accent-blue);" data-i18n="osvje_i">Osvje&#382;i</button>
        </div>
      </div>
      <div id="potrosnja-box" class="tel-box tel-muted" data-i18n="x_2">&hellip;</div>

      <!-- TASK-3691: vrijednost korisničkih upita po cjeniku S1-S6 (Goran, 04.09.2026.).
           Ovo NIJE trošak modela nego procjena vrijednosti isporučenog rada; dvije brojke
           stoje jedna uz drugu i namjerno se ne zbrajaju. -->
      <div class="projects-header" style="margin-top:1.25rem;">
        <h2 style="margin:0;font-size:1.05rem;" data-i18n="vrijednost_korisni_kih_upita_cjenik_s1_s6">Vrijednost korisni&#269;kih upita &mdash; cjenik S1&ndash;S6</h2>
        <button id="vrijednost-refresh-btn" class="konzola-mode-btn plan-mode"
                style="border-color:var(--accent-blue);color:var(--accent-blue);margin-left:auto;" data-i18n="osvje_i">Osvje&#382;i</button>
        <span id="vrijednost-izvor" style="color:var(--text-secondary);font-size:0.72rem;margin-left:0.5rem;" data-i18n="x">&mdash;</span>
      </div>
      <div id="vrijednost-box" class="tel-box tel-muted" data-i18n="x_2">&hellip;</div>
    </div>

    <!-- STATUS TAB -->
    <div id="tab-status" class="tab-content">
      <div class="status-header-bar">
        <h2 style="margin:0;font-size:1.1rem;" data-i18n="system_status">System Status</h2>
        <div style="display:flex;align-items:center;gap:0.75rem;">
          <span id="status-last-updated" style="color:var(--text-secondary);font-size:0.75rem;">--</span>
          <button id="status-refresh-btn" class="konzola-mode-btn plan-mode" style="border-color:var(--accent-blue);color:var(--accent-blue);" data-i18n="refresh">Refresh</button>
        </div>
      </div>

      <div class="status-section" id="status-services-section">
        <div class="status-section-title" data-i18n="service_health">Service Health</div>
        <div class="service-grid" id="status-service-grid">
          <div class="empty" data-i18n="loading">Loading...</div>
        </div>
      </div>

      <div class="status-section" id="status-overview-section">
        <div class="status-section-title" data-i18n="system_overview">System Overview</div>
        <div class="stat-grid" id="status-overview-grid"></div>
      </div>

      <div class="status-section" id="status-tokens-section">
        <div class="status-section-title" data-i18n="token_usage">Token Usage</div>
        <div id="status-token-content"></div>
      </div>

      <div class="status-section" id="status-projects-section">
        <div class="status-section-title" data-i18n="projects_tasks">Projects &amp; Tasks</div>
        <div id="status-projects-content"></div>
      </div>

      <div class="status-section" id="status-queue-section">
        <div class="status-section-title" data-i18n="scheduler_queue">Scheduler &amp; Queue</div>
        <div id="status-queue-content"></div>
      </div>
    </div>

    <!-- INFO TAB -->
    <div id="tab-info" class="tab-content">
      <div class="status-header-bar">
        <h2 style="margin:0;font-size:1.1rem;" data-i18n="rego_config">REGO&#268; Config</h2>
        <button id="info-refresh-btn" class="konzola-mode-btn plan-mode" style="border-color:var(--accent-blue);color:var(--accent-blue);" data-i18n="refresh">Refresh</button>
      </div>
      <div class="info-grid" id="info-grid">
        <div class="info-skupina info-full">
          <h3 data-i18n="cfg_skupina_podesavanje">Pode&#353;avanje &mdash; ovo mijenja&#353; ti</h3>
          <p data-i18n="cfg_skupina_podesavanje_opis">Kartice u kojima se ne&#353;to upisuje ili prebacuje. Promjena vrijedi odmah, bez ponovnog pokretanja.</p>
        </div>
        <div class="info-card info-full" id="info-login-card">
          <div class="info-card-title"><span class="icon">&#8599;</span> <span data-i18n="cfg_kartica_prijave">Prijave (login preko linka)</span></div>
          <div id="info-login-content"><div class="empty" data-i18n="loading">Loading...</div></div>
        </div>
        <div class="info-card info-full" id="info-modelsetup-card">
          <div class="info-card-title"><span class="icon">&#9881;</span> <span data-i18n="cfg_kartica_modeli">Podržani modeli &amp; postavke providera</span></div>
          <div id="info-modelsetup-content"><div class="empty" data-i18n="loading">Loading...</div></div>
        </div>
        <div class="info-card info-full" id="info-classifier-card">
          <div class="info-card-title"><span class="icon">&#8644;</span> <span data-i18n="cfg_kartica_klasifikator">Klasifikacijski model &mdash; rutiranje poruka (odvojeno od izvr&#353;nog)</span></div>
          <div id="info-classifier-content"><div class="empty" data-i18n="loading">Loading...</div></div>
        </div>
        <div class="info-card info-full" id="info-concurrency-card">
          <div class="info-card-title"><span class="icon">&#8793;</span> <span data-i18n="cfg_kartica_usporedni">Usporedni agenti (1&ndash;10)</span></div>
          <div id="info-concurrency-content"><div class="empty" data-i18n="loading">Loading...</div></div>
        </div>
        <div class="info-card info-full" id="info-dezurni-card">
          <div class="info-card-title"><span class="icon">&#9873;</span> <span data-i18n="cfg_kartica_dezurni">De&#382;urni &mdash; rezervni model kad primarni padne</span></div>
          <div id="info-dezurni-content"><div class="empty" data-i18n="loading">Loading...</div></div>
        </div>
        <div class="info-card info-full" id="info-telegram-card">
          <div class="info-card-title"><span class="icon">&#9993;</span> <span data-i18n="cfg_kartica_telegram">Telegram obavijesti &mdash; bot token + chat id (u paketu)</span></div>
          <div id="info-telegram-content"><div class="empty" data-i18n="loading">Loading...</div></div>
        </div>
        <div class="info-card info-full" id="info-ulaz-card">
          <div class="info-card-title"><span class="icon">&#8623;</span> <span data-i18n="cfg_kartica_ulaz">Ulazna vrata &mdash; kako telegramska poruka ulazi u plo&#269;u</span></div>
          <div id="info-ulaz-content"><div class="empty" data-i18n="loading">Loading...</div></div>
        </div>
        <div class="info-card info-full" id="info-integracije-card">
          <div class="info-card-title"><span class="icon">&#8853;</span> <span data-i18n="cfg_kartica_integracije">Integracije &mdash; Nextcloud, e-po&#353;ta, GitLab, GitHub</span></div>
          <div id="info-integracije-content"><div class="empty" data-i18n="loading">Loading...</div></div>
        </div>
        <div class="info-card info-full" id="info-orkestrator-card">
          <div class="info-card-title"><span class="icon">&#9881;</span> <span data-i18n="cfg_kartica_orkestrator">Orkestrator &mdash; sloj koji sam pokre&#263;e agente na zadatku</span></div>
          <div id="info-orkestrator-content"><div class="empty" data-i18n="loading">Loading...</div></div>
        </div>
        <div class="info-skupina info-full">
          <h3 data-i18n="cfg_skupina_stanje">Stanje sustava &mdash; ovo se samo &#269;ita</h3>
          <p data-i18n="cfg_skupina_stanje_opis">Ispis zate&#269;enog stanja: ina&#269;ice, moduli, baze, mjere. Ovdje se ni&#353;ta ne mijenja.</p>
        </div>
        <div class="info-card" id="info-system-card">
          <div class="info-card-title"><span class="icon">&#9646;</span> System</div>
          <div id="info-system-content"><div class="empty" data-i18n="loading">Loading...</div></div>
        </div>
        <div class="info-card" id="info-providers-card">
          <div class="info-card-title"><span class="icon">&#9881;</span> AI Providers</div>
          <div id="info-providers-content"><div class="empty" data-i18n="loading">Loading...</div></div>
        </div>
        <div class="info-card" id="info-infra-card">
          <div class="info-card-title"><span class="icon">&#9729;</span> Infrastructure</div>
          <div id="info-infra-content"><div class="empty" data-i18n="loading">Loading...</div></div>
        </div>
        <div class="info-card" id="info-databases-card">
          <div class="info-card-title"><span class="icon">&#9744;</span> Databases</div>
          <div id="info-databases-content"><div class="empty" data-i18n="loading">Loading...</div></div>
        </div>
        <div class="info-card info-full" id="info-agents-card">
          <div class="info-card-title"><span class="icon">&#9733;</span> Agents &amp; Model Requirements</div>
          <div id="info-agents-content"><div class="empty" data-i18n="loading">Loading...</div></div>
        </div>
        <div class="info-card info-full" id="info-modules-card">
          <div class="info-card-title"><span class="icon">&#9670;</span> Modules</div>
          <div id="info-modules-content"><div class="empty" data-i18n="loading">Loading...</div></div>
        </div>
        <div class="info-card" id="info-metrics-card">
          <div class="info-card-title"><span class="icon">&#9776;</span> Metrics Summary</div>
          <div id="info-metrics-content"><div class="empty" data-i18n="loading">Loading...</div></div>
        </div>
        <div class="info-card info-full" id="info-components-card">
          <div class="info-card-title"><span class="icon">&#9881;</span> Core Components (v4.4.0)</div>
          <div id="info-components-content"><div class="empty" data-i18n="loading">Loading...</div></div>
        </div>
        <div class="info-card info-full" id="info-skills-card">
          <div class="info-card-title"><span class="icon">&#9733;</span> Skills &amp; Workflows</div>
          <div id="info-skills-content"><div class="empty" data-i18n="loading">Loading...</div></div>
        </div>
        <div class="info-card info-full" id="info-rules-card">
          <div class="info-card-title"><span class="icon">&#9888;</span> Critical Rules (27)</div>
          <div id="info-rules-content"><div class="empty" data-i18n="loading">Loading...</div></div>
        </div>
        <!-- TASK-4972: RAG Backend upravljanje (ChromaDB/pgvector) -->
        <div class="info-card info-full" id="info-rag-card">
          <div class="info-card-title"><span class="icon">&#128451;</span> <span data-i18n="cfg_kartica_rag">RAG Backend</span></div>
          <div id="info-rag-content"><div class="empty" data-i18n="loading">Loading...</div></div>
        </div>
      </div>
    </div>

    <!-- Add Task Button -->
    <button class="add-task-btn" id="add-task-btn" title="Create New Task" data-i18n-title="create_new_task">+</button>

    <!-- Task Detail Panel -->
    <div id="detail-panel" class="detail-panel">
      <div class="detail-panel-header">
        <span id="detail-task-id" style="font-family: monospace; color: var(--text-secondary);"></span>
        <button class="close-btn" id="close-detail-btn" data-i18n="x_3">&times;</button>
      </div>

      <div class="detail-panel-body">
        <div class="detail-field">
          <label data-i18n="title">Title</label>
          <input type="text" id="detail-title" placeholder="Task title" data-i18n-placeholder="task_title">
        </div>

        <div class="detail-field">
          <label data-i18n="status">Status</label>
          <select id="detail-status">
            <option value="pending" data-i18n="pending">Pending</option>
            <option value="in_progress" data-i18n="in_progress">In Progress</option>
            <option value="blocked" data-i18n="blocked">Blocked</option>
            <option value="completed" data-i18n="completed">Completed</option>
            <option value="cancelled" data-i18n="cancelled">Cancelled</option>
          </select>
        </div>

        <div class="detail-field">
          <label data-i18n="priority">Priority</label>
          <select id="detail-priority">
            <option value="1" data-i18n="p1_critical">P1 - Critical</option>
            <option value="2" data-i18n="p2_high">P2 - High</option>
            <option value="3" data-i18n="p3_normal">P3 - Normal</option>
            <option value="4" data-i18n="p4_low">P4 - Low</option>
            <option value="5" data-i18n="p5_backlog">P5 - Backlog</option>
          </select>
        </div>

        <div class="detail-field">
          <label data-i18n="assignee">Assignee</label>
          <select id="detail-assignee">
            <option value="" data-i18n="unassigned">Unassigned</option>
            <option value="regoc">regoc</option>
            <option value="klaudio">klaudio</option>
            <option value="stribor">stribor</option>
            <option value="kosjenka">kosjenka</option>
            <option value="jelena">jelena</option>
            <option value="malik">malik</option>
            <option value="manda">manda</option>
            <option value="potjeh">potjeh</option>
            <option value="dora">dora</option>
            <option value="gita">gita</option>
            <option value="grga">grga</option>
          </select>
        </div>

        <!-- TASK-3512: projekt zadatka. Prije ovoga se projekt na ploči nije ni vidio ni
             mijenjao — jedini put bio je ručni PUT /api/tasks/<ID> s poljem projectId. -->
        <div class="detail-field">
          <label data-i18n="projekt">Projekt</label>
          <select id="detail-project">
            <option value="" data-i18n="bez_projekta">— bez projekta —</option>
          </select>
          <div id="detail-project-current" style="margin-top:0.25rem;font-size:0.8rem;color:var(--text-secondary);"></div>
        </div>

        <div class="detail-field">
          <label data-i18n="description">Description</label>
          <textarea id="detail-description" placeholder="Task description (markdown supported)" data-i18n-placeholder="task_description_markdown_supported"></textarea>
        </div>

        <div class="detail-field">
          <label data-i18n="blocked_by">Blocked By</label>
          <select id="detail-blocked-by-select">
            <option value="" data-i18n="add_blocking_task">+ Add blocking task...</option>
          </select>
          <div id="detail-blocked-by-list" class="blocked-by-list"></div>
        </div>

        <div class="detail-field">
          <label data-i18n="blocked_reason">Blocked Reason</label>
          <input type="text" id="detail-blocked-reason" placeholder="Why is this blocked?" data-i18n-placeholder="why_is_this_blocked">
        </div>

        <div class="detail-field">
          <label data-i18n="tags">Tags</label>
          <div id="detail-tags" class="tags-container"></div>
          <input type="text" id="detail-tag-input" placeholder="Add tag (press Enter)" data-i18n-placeholder="add_tag_press_enter" style="margin-top: 0.25rem;">
        </div>

        <!-- TASK-5013: uputa stiže agentu koji VEĆ radi (hook uz sljedeći alat), bez pauze i restarta. -->
        <div class="detail-field" id="detail-upute-field">
          <label data-i18n="upute_naslov">Dodatne upute agentu (dok radi)</label>
          <div id="detail-upute" class="progress-notes"></div>
          <div style="display: flex; gap: 0.5rem; margin-top: 0.5rem;">
            <textarea id="detail-nova-uputa" rows="2" placeholder="Uputa za agenta koji radi na zadatku…" data-i18n-placeholder="uputa_placeholder" style="flex: 1;"></textarea>
            <button class="btn btn-secondary" id="dodaj-uputu-btn" data-i18n="dodaj_uputu">Dodaj uputu</button>
          </div>
        </div>

        <div class="detail-field">
          <label data-i18n="progress_notes">Progress Notes</label>
          <div id="detail-progress-notes" class="progress-notes"></div>
          <div style="display: flex; gap: 0.5rem; margin-top: 0.5rem;">
            <input type="text" id="detail-new-note" placeholder="Add progress note..." data-i18n-placeholder="add_progress_note" style="flex: 1;">
            <button class="btn btn-secondary" id="add-note-btn" data-i18n="add">Add</button>
          </div>
        </div>

        <div class="detail-field" id="detail-result-field" style="display:none;">
          <label data-i18n="rezultat_odgovor_agenta">Rezultat / Odgovor agenta</label>
          <!-- TASK-4815: pre-wrap je preseljen na POJEDINE blokove (renderResultSummary),
               jer spremnik sada nosi i bedž i sklopive sekcije, ne samo goli tekst. -->
          <div id="detail-result-summary" class="progress-notes" style="word-break:break-word;"></div>
        </div>

        <!-- TASK-3568 (T4): potrošnja zadatka iz naših transkripata (agent_telemetry.py).
             Učitava se ASINKRONO, nakon što je kartica već iscrtana — ploča nikad ne
             čeka python. -->
        <div class="detail-field" id="detail-telemetry-field">
          <label style="display:flex;align-items:center;gap:0.5rem;">
            <span data-i18n="potrosnja_zadatka">Potrošnja zadatka</span>
            <button class="btn btn-secondary" id="telemetry-refresh-btn"
                    style="padding:0.1rem 0.5rem;font-size:0.7rem;" title="Ponovno izračunaj" data-i18n-title="ponovno_izracunaj" data-i18n="osvjezi">Osvježi</button>
          </label>
          <div id="detail-telemetry" class="tel-box tel-muted">…</div>
        </div>

        <div class="timestamps" id="detail-timestamps"></div>
      </div>

      <div class="detail-panel-footer">
        <button class="btn btn-secondary" id="delete-task-btn" style="margin-right: auto; background: var(--accent-red);" data-i18n="delete">Delete</button>
        <button class="btn btn-secondary" id="cancel-edit-btn" data-i18n="cancel">Cancel</button>
        <button class="btn btn-primary" id="save-task-btn" data-i18n="save_changes">Save Changes</button>
      </div>
    </div>

    <!-- Modal for Creating Task -->
    <div id="modal-overlay" class="modal-overlay" style="display: none;">
      <div class="modal">
        <h3 data-i18n="create_new_task">Create New Task</h3>
        <form id="task-form">
          <div class="form-group">
            <label for="task-title" data-i18n="title_2">Title *</label>
            <input type="text" id="task-title" required placeholder="Task title" data-i18n-placeholder="task_title">
          </div>
          <div class="form-group">
            <label for="task-description" data-i18n="description">Description</label>
            <textarea id="task-description" placeholder="Task description (optional)" data-i18n-placeholder="task_description_optional"></textarea>
          </div>
          <div class="form-group">
            <label for="task-priority" data-i18n="priority">Priority</label>
            <select id="task-priority">
              <option value="1" data-i18n="p1_high_red">P1 - High (Red)</option>
              <option value="2" selected data-i18n="p2_medium_yellow">P2 - Medium (Yellow)</option>
              <option value="3" data-i18n="p3_low_blue">P3 - Low (Blue)</option>
            </select>
          </div>
          <div class="form-group">
            <label for="task-assignee" data-i18n="assignee">Assignee</label>
            <select id="task-assignee">
              <option value="" data-i18n="unassigned">Unassigned</option>
              <option value="regoc">regoc</option>
              <option value="klaudio">klaudio</option>
              <option value="stribor">stribor</option>
              <option value="kosjenka">kosjenka</option>
              <option value="jelena">jelena</option>
              <option value="malik">malik</option>
              <option value="manda">manda</option>
              <option value="potjeh">potjeh</option>
              <option value="dora">dora</option>
              <option value="gita">gita</option>
              <option value="grga">grga</option>
            </select>
          </div>
          <div class="form-group">
            <label for="new-task-project" data-i18n="project_optional">Project (optional)</label>
            <select id="new-task-project" class="form-select">
              <option value="" data-i18n="no_project">No Project</option>
            </select>
          </div>
          <div class="modal-actions">
            <button type="button" class="btn btn-secondary" id="cancel-btn" data-i18n="cancel">Cancel</button>
            <button type="submit" class="btn btn-primary" data-i18n="create_task">Create Task</button>
          </div>
        </form>
      </div>
    </div>

    <!-- Modal for Creating Project -->
    <div id="project-modal-overlay" class="modal-overlay" style="display: none;">
      <div class="modal">
        <h3 id="project-modal-title" data-i18n="create_new_project">Create New Project</h3>
        <form id="project-form">
          <input type="hidden" id="project-edit-id">
          <div class="form-group">
            <label for="project-name" data-i18n="name">Name *</label>
            <input type="text" id="project-name" required placeholder="Project name" data-i18n-placeholder="project_name">
          </div>
          <div class="form-group">
            <label for="project-description" data-i18n="description">Description</label>
            <textarea id="project-description" placeholder="Project description (optional)" data-i18n-placeholder="project_description_optional"></textarea>
          </div>
          <div class="form-group">
            <label for="project-status" data-i18n="status">Status</label>
            <select id="project-status">
              <option value="active" data-i18n="active">Active</option>
              <option value="on_hold" data-i18n="on_hold">On Hold</option>
              <option value="completed" data-i18n="completed">Completed</option>
              <option value="archived" data-i18n="archived">Archived</option>
            </select>
          </div>
          <div class="form-group">
            <label for="project-priority" data-i18n="priority">Priority</label>
            <select id="project-priority">
              <option value="1" data-i18n="p1_critical">P1 - Critical</option>
              <option value="2" data-i18n="p2_high">P2 - High</option>
              <option value="3" selected data-i18n="p3_normal">P3 - Normal</option>
              <option value="4" data-i18n="p4_low">P4 - Low</option>
              <option value="5" data-i18n="p5_backlog">P5 - Backlog</option>
            </select>
          </div>
          <div class="form-group">
            <label for="project-lead" data-i18n="lead_agent">Lead Agent</label>
            <select id="project-lead">
              <option value="" data-i18n="no_lead">No Lead</option>
              <option value="regoc">regoc</option>
              <option value="klaudio">klaudio</option>
              <option value="stribor">stribor</option>
              <option value="kosjenka">kosjenka</option>
              <option value="jelena">jelena</option>
              <option value="malik">malik</option>
              <option value="manda">manda</option>
              <option value="potjeh">potjeh</option>
              <option value="dora">dora</option>
              <option value="gita">gita</option>
              <option value="grga">grga</option>
            </select>
          </div>
          <div class="modal-actions">
            <button type="button" class="btn btn-secondary" id="project-cancel-btn" data-i18n="cancel">Cancel</button>
            <button type="submit" class="btn btn-primary" id="project-submit-btn" data-i18n="create_project">Create Project</button>
          </div>
        </form>
      </div>
    </div>

    <!-- Project Detail Panel -->
    <div id="project-detail-panel" class="project-detail-panel">
      <div class="detail-panel-header">
        <span id="project-detail-id" style="font-family: monospace; color: var(--text-secondary);"></span>
        <button class="close-btn" id="close-project-detail-btn" data-i18n="x_3">&times;</button>
      </div>

      <div class="detail-panel-body">
        <div class="detail-field">
          <label data-i18n="name_2">Name</label>
          <input type="text" id="project-detail-name" placeholder="Project name" data-i18n-placeholder="project_name">
        </div>

        <div class="detail-field">
          <label data-i18n="status">Status</label>
          <select id="project-detail-status">
            <option value="active" data-i18n="active">Active</option>
            <option value="on_hold" data-i18n="on_hold">On Hold</option>
            <option value="completed" data-i18n="completed">Completed</option>
            <option value="archived" data-i18n="archived">Archived</option>
          </select>
        </div>

        <div class="detail-field">
          <label data-i18n="priority">Priority</label>
          <select id="project-detail-priority">
            <option value="1" data-i18n="p1_critical">P1 - Critical</option>
            <option value="2" data-i18n="p2_high">P2 - High</option>
            <option value="3" data-i18n="p3_normal">P3 - Normal</option>
            <option value="4" data-i18n="p4_low">P4 - Low</option>
            <option value="5" data-i18n="p5_backlog">P5 - Backlog</option>
          </select>
        </div>

        <div class="detail-field">
          <label data-i18n="lead_agent">Lead Agent</label>
          <select id="project-detail-lead">
            <option value="" data-i18n="no_lead">No Lead</option>
            <option value="regoc">regoc</option>
            <option value="klaudio">klaudio</option>
            <option value="stribor">stribor</option>
            <option value="kosjenka">kosjenka</option>
            <option value="jelena">jelena</option>
            <option value="malik">malik</option>
            <option value="manda">manda</option>
            <option value="potjeh">potjeh</option>
            <option value="dora">dora</option>
            <option value="gita">gita</option>
            <option value="grga">grga</option>
          </select>
        </div>

        <div class="detail-field">
          <label data-i18n="description">Description</label>
          <textarea id="project-detail-description" placeholder="Project description" data-i18n-placeholder="project_description"></textarea>
        </div>

        <!-- POTROSNJA PROJEKTA — TASK-3572 (T8), mjera 6 suzena na ovaj projekt.
             Brojke dolaze s GET /api/pregled/projekt/:id, koji zove
             tools/tjedni_pregled.py --projekt <id>. Isti alat kao kartica
             „Potrosnja" — drugog izracuna nema, pa se brojke ne mogu razici. -->
        <div class="project-section">
          <h4 style="display:flex;align-items:center;gap:0.5rem;">
            <span data-i18n="potro_nja_projekta">Potro&#353;nja projekta</span>
            <select id="projekt-potrosnja-dana" class="filter-select"
                    style="margin-left:auto;font-size:0.72rem;padding:0.1rem 0.3rem;">
              <option value="7" data-i18n="zadnjih_7_dana">zadnjih 7 dana</option>
              <option value="30" data-i18n="zadnjih_30_dana">zadnjih 30 dana</option>
              <option value="3650" selected data-i18n="svo_vrijeme">svo vrijeme</option>
            </select>
            <span id="projekt-potrosnja-izvor" style="color:var(--text-secondary);font-size:0.68rem;font-weight:400;" data-i18n="x">&mdash;</span>
            <button type="button" class="btn btn-secondary" id="projekt-potrosnja-refresh-btn"
                    style="font-size:0.7rem;padding:0.15rem 0.5rem;" data-i18n="osvje_i">Osvje&#382;i</button>
          </h4>
          <div id="projekt-potrosnja-box" class="tel-box tel-muted" data-i18n="x_2">&hellip;</div>
        </div>

        <!-- SPECIFIKACIJA + dispatch "Nadogradi po specifikacijama" -->
        <div class="project-section">
          <h4 data-i18n="specifikacija">Specifikacija</h4>
          <div class="detail-field">
            <textarea id="project-detail-spec" placeholder="Što treba isporučiti, zašto, koji fajlovi, kriterij za done..." data-i18n-placeholder="sto_treba_isporuciti_zasto_koji_fajlovi_krit" style="min-height: 180px; font-family: monospace; font-size: 0.85rem;"></textarea>
          </div>
          <div style="display: flex; gap: 0.5rem; align-items: center; margin-top: 0.5rem;">
            <select id="spec-upgrade-agent" style="flex: 1;">
              <option value="" data-i18n="odaberi_agenta">Odaberi agenta...</option>
            </select>
            <button class="btn btn-primary" id="spec-upgrade-btn" disabled title="Odaberi agenta i upiši specifikaciju" data-i18n-title="odaberi_agenta_i_upisi_specifikaciju" data-i18n="nadogradi_po_specifikacijama">⟳ Nadogradi po specifikacijama</button>
          </div>
          <div style="margin-top: 0.5rem;">
            <a href="#" id="spec-template-toggle" style="font-size: 0.8rem; color: var(--text-secondary);" data-i18n="template_poruke">▸ Template poruke</a>
            <div id="spec-template-editor" style="display: none; margin-top: 0.5rem;">
              <textarea id="spec-template-content" style="min-height: 140px; font-family: monospace; font-size: 0.8rem; width: 100%;"></textarea>
              <div style="font-size: 0.75rem; color: var(--text-secondary); margin: 0.25rem 0;" data-i18n="placeholderi">Placeholderi: <code>$agent</code> <code>$projekt</code> <code>$spec</code></div>
              <button class="btn btn-secondary" id="spec-template-save-btn" style="font-size: 0.8rem;" data-i18n="spremi_template">Spremi template</button>
            </div>
          </div>
        </div>

        <div class="project-section">
          <h4 data-i18n="team_agents">Team Agents</h4>
          <div id="project-detail-agents" class="agents-grid"></div>
          <select id="project-add-agent-select" style="margin-top: 0.5rem; width: 100%;">
            <option value="" data-i18n="add_agent_to_project">+ Add agent to project...</option>
            <option value="regoc">regoc</option>
            <option value="klaudio">klaudio</option>
            <option value="stribor">stribor</option>
            <option value="kosjenka">kosjenka</option>
            <option value="jelena">jelena</option>
            <option value="malik">malik</option>
            <option value="manda">manda</option>
            <option value="potjeh">potjeh</option>
            <option value="dora">dora</option>
            <option value="gita">gita</option>
            <option value="grga">grga</option>
          </select>
        </div>

        <div class="project-section">
          <h4 data-i18n="linked_tasks">Linked Tasks</h4>
          <div id="project-detail-tasks" class="task-list-compact">
            <div class="empty" data-i18n="no_tasks_linked">No tasks linked</div>
          </div>
        </div>

        <div class="timestamps" id="project-detail-timestamps"></div>
      </div>

      <div class="detail-panel-footer">
        <button class="btn btn-secondary" id="delete-project-btn" style="margin-right: auto; background: var(--accent-red);" data-i18n="delete">Delete</button>
        <button class="btn btn-secondary" id="cancel-project-edit-btn" data-i18n="cancel">Cancel</button>
        <button class="btn btn-primary" id="save-project-btn" data-i18n="save_changes">Save Changes</button>
      </div>
    </div>

    <!-- RAG Detail Modal -->
    <div id="rag-modal-overlay" class="modal-overlay" style="display: none;">
      <div class="rag-modal">
        <div class="rag-modal-header">
          <div class="rag-modal-meta">
            <span id="rag-modal-id" class="rag-entry-id"></span>
            <span id="rag-modal-collection" class="rag-entry-collection"></span>
            <span id="rag-modal-type" class="rag-entry-type"></span>
            <span id="rag-modal-date" class="rag-entry-date"></span>
          </div>
          <button class="close-btn" id="close-rag-modal-btn" data-i18n="x_3">&times;</button>
        </div>
        <div class="rag-modal-content" id="rag-modal-content">
          Loading...
        </div>
        <div class="rag-modal-footer">
          <button class="btn btn-danger" id="rag-modal-delete-btn" data-i18n="delete_entry">Delete Entry</button>
          <button class="btn btn-secondary" id="rag-modal-close-btn" data-i18n="close">Close</button>
        </div>
      </div>
    </div>
  </div>

  <script>
    let ws;
    let currentFilter = 'all';
    let currentProjectFilter = '';
    let tasks = [];
    let projectsCache = [];
    // T10/TASK-3575: zadnji sud vratara po zadatku + koliko ih je danas proslo neprovjereno.
    let unverifiedCache = { day: '', todayCount: 0, tasks: {} };
    let uputeCache = {};   // TASK-5013: {TASK-x: {total, undelivered}}

    // TASK-3516: NAJNOVIJE NA VRHU — isto pravilo kao na poslužitelju (ChronoOrder.ts).
    // Popisi i padajuće liste na ploči već stižu poredani iz /api/tasks i
    // /api/projects; ove dvije pomoćne funkcije služe mjestima koja skup
    // zadataka prvo profiltriraju pa poredak treba potvrditi izrijekom.
    function taskIdNumber(id) {
      const n = parseInt(String(id || '').split('-').pop(), 10);
      return isNaN(n) ? -1 : n;  // usporedba BROJA: 'TASK-999' < 'TASK-1000'
    }

    function taskActivityTs(t) {
      // Dovršen zadatak nosi vrijeme dovršenja, ostali vrijeme zadnje promjene.
      // Baza vraća dva zapisa vremena ('…T11:07:02.561Z' i '… 11:07:02') s istim
      // satom — svodimo ih na isti oblik jer je 'T' > ' ' po znakovima.
      const raw = (t.status === 'completed' || t.status === 'cancelled')
        ? (t.completedAt || t.completed_at || t.updatedAt || t.updated_at || t.createdAt || t.created_at)
        : (t.updatedAt || t.updated_at || t.createdAt || t.created_at);
      return String(raw || '').replace('T', ' ').replace('Z', '');
    }

    function byNewestFirst(a, b) {
      const ta = taskActivityTs(a), tb = taskActivityTs(b);
      if (ta !== tb) return ta < tb ? 1 : -1;
      return taskIdNumber(b.id) - taskIdNumber(a.id);
    }

    function connect() {
      // TASK-3053: shema se izvodi iz stranice. Tvrdo kodiran ws:// na HTTPS stranici je
      // mijesani sadrzaj — preglednik ga blokira tako da new WebSocket BACI iznimku.
      const wsScheme = location.protocol === 'https:' ? 'wss://' : 'ws://';
      ws = new WebSocket(wsScheme + location.host + '/stream');

      ws.onopen = () => {
        document.getElementById('connection-status').classList.remove('disconnected');
        document.getElementById('status-text').textContent = 'Connected';
        fetchProjectsForFilter();
        fetchTasks();
      };

      ws.onclose = () => {
        document.getElementById('connection-status').classList.add('disconnected');
        document.getElementById('status-text').textContent = 'Disconnected - Reconnecting...';
        // TASK-3053: i ponovni pokusaj ide u try — inace iznimka iz new WebSocket ubije
        // lanac ponovnog spajanja, pa traka zauvijek stoji na „Reconnecting...".
        setTimeout(() => { try { connect() } catch (e) { console.error('[WS] ponovno spajanje palo:', e) } }, 3000);
      };

      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === 'file_changed' || data.type === 'task_created' || data.type === 'task_updated') {
          fetchTasks();
        }
        if (data.type && data.type.startsWith('console_')) {
          handleKonzolaWSMessage(data);
        }
        // TASK-3047: kočnicu može pritisnuti drugi preglednik ili curl — svi ekrani
        // moraju istog trena pokazivati isto stanje.
        if (data.type === 'pause_changed') {
          renderGlobalPause(data.pause);
        }
        // TASK-5013: nova uputa ili dostava — osvježi oznaku i otvorene detalje.
        if (data.type === 'task_instructions') {
          fetchTasks();
          if (selectedTaskId === data.taskId) ucitajUpute(data.taskId);
        }
      };
    }

    // Send WebSocket message
    function sendWSMessage(message) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
      }
    }

    async function fetchTasks() {
      try {
        let url = '/api/tasks';
        if (currentProjectFilter) {
          url += '?projectId=' + encodeURIComponent(currentProjectFilter);
        }
        const response = await fetch(url);
        tasks = await response.json();
        // Oznaka „NIJE PROVJERENO" mora stici PRIJE iscrtavanja, inace kartica prvo
        // pokaze zadatak bez oznake pa je doda — a upravo taj trenutak je laz na ploci.
        await fetchUnverified();
        await fetchUputeStanje();
        renderTasks();
        updateStats();
        updateAgentFilter();
      } catch (err) {
        console.error('Failed to fetch tasks:', err);
      }
    }

    // escapeHtml ide preko innerHTML i NE bjezi navodnik ("), pa je za vrijednost
    // atributa nedovoljan — razlog vratara sadrzi navodnike i razbio bi title="...".
    function escapeAttr(t) {
      return String(t == null ? '' : t)
        .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
        .replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // TASK-5013: brojači uputa za cijelu ploču (jedan upit). Kvar ne smije isprazniti ploču.
    async function fetchUputeStanje() {
      try {
        const r = await fetch('/api/upute/stanje');
        if (r.ok) uputeCache = await r.json();
      } catch (err) { console.error('Failed to fetch upute:', err); }
    }

    async function posaljiUputu(taskId, tekst) {
      tekst = String(tekst || '').trim();
      if (!tekst) return false;
      try {
        const res = await fetch('/api/tasks/' + encodeURIComponent(taskId) + '/uputa', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: tekst })
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) { alert(_T('uputa_nije_spremljena', 'Uputa nije spremljena:') + ' ' + (d.error || ('HTTP ' + res.status))); return false; }
        fetchTasks();
        if (selectedTaskId === taskId) ucitajUpute(taskId);
        return true;
      } catch (err) {
        alert(_T('uputa_nije_spremljena', 'Uputa nije spremljena:') + ' ' + err);
        return false;
      }
    }

    async function ucitajUpute(taskId) {
      const el = document.getElementById('detail-upute');
      if (!el) return;
      try {
        const r = await fetch('/api/tasks/' + encodeURIComponent(taskId) + '/upute');
        const d = await r.json();
        const list = (d && d.instructions) || [];
        if (!list.length) { el.innerHTML = '<div class="empty">' + rsEscapeHtml(_T('nema_uputa', 'Nema uputa')) + '</div>'; return; }
        // Tekst upute je korisnički unos: samo kroz rsEscapeHtml (ugovor §G, TASK-4815).
        el.innerHTML = list.map(u => {
          const kad = new Date(u.created_at);
          const stanje = u.delivered_at
            ? '✅ ' + _T('uputa_dostavljeno', 'dostavljeno') + ' ' + new Date(u.delivered_at).toLocaleTimeString() + (u.delivered_session ? ' (' + _T('uputa_sesija', 'sesija') + ' ' + String(u.delivered_session).slice(0, 8) + ')' : '')
            : '⏳ ' + _T('uputa_ceka_dostavu', 'čeka dostavu (stiže uz sljedeći alat agenta ili pri sljedećem pokretanju)');
          return '<div class="uputa-item' + (u.delivered_at ? '' : ' ceka') + '">'
            + '<div class="uputa-meta">#' + rsEscapeHtml(u.id) + ' · ' + rsEscapeHtml(u.author) + ' · '
            + rsEscapeHtml(kad.toLocaleDateString()) + ' ' + rsEscapeHtml(kad.toLocaleTimeString()) + ' · ' + rsEscapeHtml(stanje) + '</div>'
            + '<div style="white-space:pre-wrap;word-break:break-word;">' + rsEscapeHtml(u.text) + '</div></div>';
        }).join('');
      } catch (err) {
        el.innerHTML = '<div class="empty">' + rsEscapeHtml(_T('upute_nedostupne', 'Upute nedostupne')) + '</div>';
      }
    }

    async function fetchUnverified() {
      try {
        const r = await fetch('/api/critic/unverified');
        if (!r.ok) return;
        const d = await r.json();
        if (d && d.tasks) unverifiedCache = d;
      } catch (err) {
        // Ploca ne smije ostati prazna zbog vratara — zadrzi zadnje poznato stanje.
        console.error('Failed to fetch unverified state:', err);
      }
    }

    // ─── Lanac zadataka (Goran, 05.09.2026.) ──────────────────────────────────
    // „Nakon njega mozes nastaviti sa onim jednim koji blokira cijeli niz, to bi trebalo biti
    // vidljivije oznaceno jer ovako ne vidim." Ploca je znala tko koga blokira (polja
    // blockedBy/blocks), ali to nigdje nije prikazivala — pa je zadatak koji drzi sest drugih
    // izgledao isto kao zadatak koji ne drzi nikoga.
    function zatvorenStatus(s) { return s === 'completed' || s === 'cancelled'; }

    function lanacInfo(task, poId) {
      const cekaNa = (task.blockedBy || []).filter(function (b) {
        const bl = poId.get(b);
        return bl && !zatvorenStatus(bl.status);
      });
      const vidjeni = new Set();
      const red = (task.blocks || []).slice();
      while (red.length) {
        const id = red.shift();
        if (vidjeni.has(id)) continue;                 // ciklus ne smije vrtjeti petlju
        const t = poId.get(id);
        if (!t || zatvorenStatus(t.status)) continue;
        vidjeni.add(id);
        (t.blocks || []).forEach(function (d) { red.push(d); });
      }
      return { cekaNa: cekaNa, otkljucava: vidjeni.size };
    }

    function renderTasks() {
      const filtered = currentFilter === 'all' ? tasks : tasks.filter(t => t.assignee === currentFilter);
      const poId = new Map(tasks.map(function (t) { return [t.id, t]; }));

      const containers = {
        'in_progress': document.getElementById('in-progress-tasks'),
        'pending': document.getElementById('pending-tasks'),
        'blocked': document.getElementById('blocked-tasks'),
        'completed': document.getElementById('completed-tasks')
      };

      Object.values(containers).forEach(c => c.innerHTML = '');

      filtered.forEach(task => {
        const container = containers[task.status];
        if (!container) return;

        const card = document.createElement('div');
        card.className = 'task-card priority-' + task.priority;

        // Calculate progress for all tasks
        // Priority: 1) Use progressPercent if set, 2) Calculate based on status/time
        let progress = 0;
        if (typeof task.progressPercent === 'number') {
          // Use explicitly set progressPercent (0-100)
          progress = Math.min(Math.max(task.progressPercent, 0), 100);
        } else if (task.status === 'in_progress') {
          if (task.estimatedMinutes && task.actualMinutes) {
            // Calculate based on estimated vs actual
            progress = Math.min(Math.round((task.actualMinutes / task.estimatedMinutes) * 100), 100);
          } else if (task.startedAt) {
            // Calculate based on time elapsed (demo: 1% per hour, max 90%)
            const hoursElapsed = (Date.now() - new Date(task.startedAt).getTime()) / (1000 * 60 * 60);
            progress = Math.min(Math.round(hoursElapsed * 10), 90);
          } else {
            // Default progress for new in_progress tasks
            progress = 25;
          }
        } else if (task.status === 'completed') {
          progress = 100;
        } else if (task.status === 'pending') {
          progress = 0;
        } else if (task.status === 'blocked') {
          progress = 0; // Blocked with no progressPercent
        }

        // Determine color class based on progress (red < 30%, yellow 30-70%, green > 70%)
        let progressClass = 'progress-low';
        if (progress > 70) {
          progressClass = 'progress-high';
        } else if (progress >= 30) {
          progressClass = 'progress-medium';
        }

        // Build progress bar HTML for all tasks with color coding
        const progressHTML = \`
          <div class="progress-bar-container">
            <div class="progress-bar">
              <div class="progress-bar-fill \${progressClass}" style="width: \${progress}%"></div>
            </div>
            <div class="progress-text \${progressClass}">\${progress}%</div>
          </div>
        \`;

        // Build priority badge with dropdown
        const priorityClass = task.priority === 1 ? 'p1' : task.priority === 2 ? 'p2' : 'p3';

        // Build project badge if task has projectId
        let projectBadgeHTML = '';
        if (task.projectId) {
          const project = projectsCache.find(p => p.id === task.projectId);
          const projectName = project ? project.name : task.projectId;
          projectBadgeHTML = \`<span class="project-badge" data-project-id="\${task.projectId}" title="Filter by project">\${projectName}</span>\`;
        }

        // TASK-3047: pauza je zastavica uz status, pa pauzirani zadatak ostaje u svom
        // stupcu (Pending/In Progress) — samo je vizualno prigušen i nosi gumb „Nastavi".
        if (task.paused) card.classList.add('paused');
        const pausedBadge = task.paused ? '<span class="paused-badge">&#9208; PAUZA</span>' : '';

        // T10/TASK-3575: rezultat koji vratar NIJE mogao provjeriti. Tiho propustanje je
        // upravo ono sto ova oznaka zatvara — na ploci se „proslo" i „nisam imao cime
        // provjeriti" vise ne smiju vidjeti jednako.
        const unv = unverifiedCache.tasks[task.id];
        const unverifiedBadge = unv
          ? '<span class="unverified-badge" title="' + escapeAttr(
              _Tv('tsk_neprovjereno_naslov', 'Vratar NIJE provjerio rezultat ({status}, {kada}).',
                  { status: unv.status, kada: unv.ts || '' }) + '\\n' +
              (unv.reasons && unv.reasons.length ? unv.reasons.map(r => '• ' + r).join('\\n')
                : _T('tsk_razlog_nije_zapisan', 'razlog nije zapisan'))
            ) + '">&#9888; ' + _T('tsk_nije_provjereno', 'NIJE PROVJERENO') + '</span>'
          : '';
        const pauseBtnHTML = task.paused
          ? \`<button class="task-pause-btn resume" data-pause-id="\${task.id}" data-pause-to="0" title="\${escapeAttr(_T('tsk_nastavi_naslov', 'Nastavi rad na zadatku'))}">&#9654; \${_T('nastavi', 'Nastavi')}</button>\`
          : \`<button class="task-pause-btn" data-pause-id="\${task.id}" data-pause-to="1" title="\${escapeAttr(_T('tsk_pauziraj_naslov', 'Pauziraj zadatak (prekida i agenta koji radi)'))}">&#9208;</button>\`;
        // TASK-5013: uputa agentu koji radi — bez pauze. Na završenom zadatku nema komu stići.
        const uputaBtnHTML = (task.status === 'completed' || task.status === 'cancelled') ? ''
          : \`<button class="task-uputa-btn" data-uputa-id="\${task.id}" title="\${escapeAttr(_T('uputa_gumb_naslov', 'Dodaj uputu agentu (stiže u tekuću sesiju, bez pauze)'))}">&#128232;</button>\`;
        const uc = uputeCache[task.id];
        const uputaBadge = uc && uc.total
          ? (uc.undelivered
              ? \`<span class="uputa-badge ceka" title="\${escapeAttr(_T('uputa_ceka_naslov', 'Upute koje agent još nije primio'))}">&#128232; \${uc.undelivered} \${_T('ceka_malo', 'čeka')}</span>\`
              : \`<span class="uputa-badge" title="\${escapeAttr(_T('uputa_sve_naslov', 'Sve upute dostavljene agentu'))}">&#128232; \${uc.total} &#10003;</span>\`)
          : '';

        // Lanac: korijen niza (nista ga ne drzi, a on drzi druge) dobiva punu oznaku i rub,
        // jer je to jedini zadatak cije rjesavanje odmah pusta posao dalje.
        const lanac = lanacInfo(task, poId);
        let lanacBadge = '';
        if (lanac.otkljucava > 0) {
          const korijen = lanac.cekaNa.length === 0 && task.status !== 'completed' && task.status !== 'cancelled';
          if (korijen) card.classList.add('korijen-niza');
          lanacBadge = \`<span class="lanac-badge\${korijen ? ' korijen' : ''}" title="\${escapeAttr(
            (korijen ? _T('lanac_korijen_naslov', 'KORIJEN NIZA — ništa ga ne drži.') + ' ' : '') +
            _Tv('lanac_otkljucava_naslov', 'Rješavanjem ovog zadatka otključava se {broj} zadataka: {popis}',
                { broj: lanac.otkljucava, popis: (task.blocks || []).join(', ') }))}">&#128279; \${korijen ? _T('korijen_kratko', 'KORIJEN') + ' · ' : ''}\${_Tv('otkljucava_n', 'otključava {broj}', { broj: lanac.otkljucava })}</span>\`;
        }
        if (lanac.cekaNa.length) {
          lanacBadge += \`<span class="lanac-badge ceka" title="\${escapeAttr(_Tv('lanac_ceka_naslov', 'Čeka da se dovrši: {popis}', { popis: lanac.cekaNa.join(', ') }))}">\${_T('ceka_malo', 'čeka')} \${lanac.cekaNa.join(', ')}</span>\`;
        }

        card.innerHTML = \`
          <div class="task-id">\${task.id}\${projectBadgeHTML}\${pausedBadge}\${unverifiedBadge}\${uputaBadge}\${lanacBadge}</div>
          <div class="task-title">\${task.title}</div>
          \${progressHTML}
          <div class="task-meta">
            <span>\${task.assignee || 'Unassigned'}</span>
            <span class="priority-badge \${priorityClass}" data-task-id="\${task.id}">P\${task.priority}</span>
            \${uputaBtnHTML}\${pauseBtnHTML}
          </div>
        \`;

        container.appendChild(card);

        const uputaBtn = card.querySelector('.task-uputa-btn');
        if (uputaBtn) {
          uputaBtn.addEventListener('click', (e) => {
            e.stopPropagation();   // klik na gumb ne smije otvoriti detalje
            const t = prompt(_Tv('uputa_prompt', 'Uputa za agenta na {id} (stiže u tekuću sesiju uz sljedeći alat):', { id: task.id }));
            if (t) posaljiUputu(task.id, t);
          });
        }

        const pauseBtn = card.querySelector('.task-pause-btn');
        if (pauseBtn) {
          pauseBtn.addEventListener('click', (e) => {
            e.stopPropagation();   // klik na gumb ne smije otvoriti detalje
            setTaskPaused(task.id, pauseBtn.dataset.pauseTo === '1');
          });
        }

        // Add click handler for task card (opens detail panel)
        card.addEventListener('click', (e) => {
          // If click was on priority badge or project badge, don't open detail panel
          if (e.target.closest('.priority-badge')) return;
          if (e.target.closest('.project-badge')) return;
          openTaskDetail(task.id);
        });

        // Add click handler for priority badge
        const badge = card.querySelector('.priority-badge');
        badge.addEventListener('click', (e) => {
          e.stopPropagation();
          showPriorityDropdown(badge, task.id);
        });

        // Add click handler for project badge
        const projectBadge = card.querySelector('.project-badge');
        if (projectBadge) {
          projectBadge.addEventListener('click', (e) => {
            e.stopPropagation();
            const projectId = projectBadge.dataset.projectId;
            filterByProject(projectId);
          });
        }
      });

      Object.entries(containers).forEach(([status, container]) => {
        if (container.children.length === 0) {
          container.innerHTML = '<div class="empty">No tasks</div>';
        }
      });
    }

    function updateStats() {
      // REGOC_STATS_FIX (TASK-3091): zbroj kategorija MORA dati Total. Prije se prikazivalo
      // samo in_progress+pending+blocked+completed, a cancelled nigdje — pa je na ploci
      // nedostajala razlika (npr. 129 total, a 0+0+18+97=115). Sada se cancelled prikazuje.
      document.getElementById('total-count').textContent = tasks.length;
      const cancelledTasks = tasks.filter(t => t.status === 'cancelled');
      const cc = document.getElementById('cancelled-count');
      if (cc) cc.textContent = cancelledTasks.length;
      const uc = document.getElementById('unverified-count');
      if (uc) uc.textContent = unverifiedCache.todayCount;
      document.getElementById('progress-count').textContent = tasks.filter(t => t.status === 'in_progress').length;
      document.getElementById('pending-count').textContent = tasks.filter(t => t.status === 'pending').length;
      document.getElementById('blocked-count').textContent = tasks.filter(t => t.status === 'blocked').length;
      document.getElementById('completed-count').textContent = tasks.filter(t => t.status === 'completed').length;

      // REGOC_STATS_FIX (TASK-3091): postotak se racuna nad RELEVANTNIM poslom — otkazani
      // zadaci se ne broje ni u brojnik ni u nazivnik. Prije su ulazili kao 0 % i vukli
      // ukupni napredak dolje, iako otkazan zadatak nije nezavrsen posao nego posao kojeg
      // vise nema. Primjer: 97 gotovih / 129 ukupno = 75 %, a posteno je 97 / 115 = 84 %.
      const relevantTasks = tasks.filter(t => t.status !== 'cancelled');
      if (relevantTasks.length === 0) {
        document.getElementById('overall-progress').textContent = '0%';
      } else {
        const totalProgress = relevantTasks.reduce((sum, task) => {
          // Priority: Use progressPercent if explicitly set
          if (typeof task.progressPercent === 'number') {
            return sum + Math.min(Math.max(task.progressPercent, 0), 100);
          }
          // Fallback: Calculate based on status
          if (task.status === 'completed') return sum + 100;
          if (task.status === 'in_progress') {
            if (task.estimatedMinutes && task.actualMinutes) {
              return sum + Math.min(Math.round((task.actualMinutes / task.estimatedMinutes) * 100), 100);
            } else if (task.startedAt) {
              const hoursElapsed = (Date.now() - new Date(task.startedAt).getTime()) / (1000 * 60 * 60);
              return sum + Math.min(Math.round(hoursElapsed * 10), 90);
            } else {
              return sum + 25;
            }
          }
          return sum; // pending and blocked tasks with no progressPercent = 0
        }, 0);
        const overallProgress = Math.round(totalProgress / relevantTasks.length);
        document.getElementById('overall-progress').textContent = overallProgress + '%';
      }
    }

    function updateAgentFilter() {
      const agents = [...new Set(tasks.map(t => t.assignee).filter(Boolean))];
      const container = document.getElementById('agent-filter');
      container.innerHTML = '<button class="agent-btn active" data-agent="all" data-i18n="all_agents">'
        + (RJECNIK['all_agents'] || 'All Agents') + '</button>';

      agents.forEach(agent => {
        const btn = document.createElement('button');
        btn.className = 'agent-btn' + (currentFilter === agent ? ' active' : '');
        btn.dataset.agent = agent;
        btn.textContent = agent;
        container.appendChild(btn);
      });

      container.querySelectorAll('.agent-btn').forEach(btn => {
        btn.onclick = () => {
          currentFilter = btn.dataset.agent;
          container.querySelectorAll('.agent-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          renderTasks();
        };
      });
    }

    // ============================================
    // PROJECT FILTER FUNCTIONS
    // ============================================

    async function fetchProjectsForFilter() {
      try {
        const response = await fetch('/api/projects');
        projectsCache = await response.json();
        updateProjectFilter();
        updateNewTaskProjectDropdown();
      } catch (err) {
        console.error('Failed to fetch projects for filter:', err);
      }
    }

    function updateProjectFilter() {
      const select = document.getElementById('tasks-project-filter');
      if (!select) return;

      // Preserve current selection
      const currentValue = select.value;

      select.innerHTML = '<option value="" data-i18n="all_projects">'
        + (RJECNIK['all_projects'] || 'All Projects') + '</option>';
      projectsCache.forEach(project => {
        const option = document.createElement('option');
        option.value = project.id;
        option.textContent = project.name;
        if (project.id === currentValue) {
          option.selected = true;
        }
        select.appendChild(option);
      });

      // Add change listener (only once)
      if (!select.dataset.listenerAdded) {
        select.addEventListener('change', () => {
          currentProjectFilter = select.value;
          fetchTasks();
        });
        select.dataset.listenerAdded = 'true';
      }
    }

    function updateNewTaskProjectDropdown() {
      const select = document.getElementById('new-task-project');
      if (!select) return;

      select.innerHTML = '<option value="">No Project</option>';
      projectsCache.forEach(project => {
        const option = document.createElement('option');
        option.value = project.id;
        option.textContent = project.name;
        select.appendChild(option);
      });
    }

    function filterByProject(projectId) {
      currentProjectFilter = projectId;
      const select = document.getElementById('tasks-project-filter');
      if (select) {
        select.value = projectId;
      }
      fetchTasks();
    }

    // Priority Dropdown
    let currentDropdown = null;

    function showPriorityDropdown(badge, taskId) {
      // Close existing dropdown
      if (currentDropdown) {
        currentDropdown.remove();
        currentDropdown = null;
      }

      const dropdown = document.createElement('div');
      dropdown.className = 'priority-dropdown';
      dropdown.innerHTML = \`
        <div class="priority-option" data-priority="1">
          <span class="priority-dot red"></span>
          <span>P1 - High</span>
        </div>
        <div class="priority-option" data-priority="2">
          <span class="priority-dot yellow"></span>
          <span>P2 - Medium</span>
        </div>
        <div class="priority-option" data-priority="3">
          <span class="priority-dot blue"></span>
          <span>P3 - Low</span>
        </div>
        <div class="priority-option delete" data-action="delete">
          <span>Delete Task</span>
        </div>
      \`;

      badge.style.position = 'relative';
      badge.appendChild(dropdown);
      currentDropdown = dropdown;

      // Handle priority change
      dropdown.querySelectorAll('.priority-option').forEach(option => {
        option.addEventListener('click', async (e) => {
          e.stopPropagation();
          const priority = option.dataset.priority;
          const action = option.dataset.action;

          if (action === 'delete') {
            if (confirm('Are you sure you want to delete this task?')) {
              await deleteTask(taskId);
            }
          } else if (priority) {
            await updateTaskPriority(taskId, parseInt(priority));
          }

          dropdown.remove();
          currentDropdown = null;
        });
      });

      // Close on click outside
      setTimeout(() => {
        document.addEventListener('click', function closeDropdown() {
          if (currentDropdown) {
            currentDropdown.remove();
            currentDropdown = null;
          }
          document.removeEventListener('click', closeDropdown);
        });
      }, 0);
    }

    async function updateTaskPriority(taskId, newPriority) {
      try {
        console.log(\`[Priority Update] Task: \${taskId}, New Priority: \${newPriority}\`);

        const response = await fetch(\`/api/tasks/\${taskId}\`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ priority: newPriority })
        });

        if (response.ok) {
          console.log(\`[Priority Update] Success for task \${taskId}\`);
          sendWSMessage({ action: 'update_priority', taskId, newPriority });
          fetchTasks();
        } else {
          console.error(\`[Priority Update] Failed with status: \${response.status}\`);
        }
      } catch (err) {
        console.error('[Priority Update] Error:', err);
      }
    }



    // ─── Jezik sučelja (Goran, 04.09.2026.) ───────────────────────────────────
    // Prevodi se SAMO sučelje. Naslovi, opisi i bilješke zadataka su podatci i kroz ovo
    // nikad ne prolaze — zamjenjuju se iskljucivo elementi koje je posluzitelj oznacio
    // atributom data-i18n, a njih ima samo u statickom okviru ploce.
    let RJECNIK = {};
    let JEZIK = localStorage.getItem('tm_jezik') || null;

    // ── Prijevod teksta koji ploca SASTAVLJA u JS-u ────────────────────────────────────
    // Staticki okvir se prevodi atributom data-i18n; sve sto render-funkcije slozi u
    // runtimeu mora proci kroz _T/_Tv, inace ostane na jeziku u kojem je napisano
    // (tako su TASK-4710 i TASK-4720 dvaput promasili dijelove ploce). Ovi helperi
    // vrijede za CIJELU plocu — ne za jednu karticu.
    //   _T(kljuc, podloga)         — podloga je zateceni hrvatski, sluzi i kad rjecnik zataji
    //   _Tv(kljuc, podloga, {a:1}) — {oznake} su PODATCI, ne prevode se
    //   _esc(v)                    — vrijednost u atribut (navodnik ne smije razvaliti oznake)
    function _T(k, zad) { return (RJECNIK && RJECNIK[k] != null) ? RJECNIK[k] : zad; }
    function _Tv(k, zad, v) {
      var s = _T(k, zad);
      for (var kk in v) s = s.split('{' + kk + '}').join(v[kk]);
      return s;
    }
    function _esc(v) {
      return String(v == null ? '' : v)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
        .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }

    function prevediElement(el) {
      const k = el.getAttribute('data-i18n');
      if (k && RJECNIK[k] != null) el.textContent = RJECNIK[k];
      const kp = el.getAttribute('data-i18n-placeholder');
      if (kp && RJECNIK[kp] != null) el.setAttribute('placeholder', RJECNIK[kp]);
      const kt = el.getAttribute('data-i18n-title');
      if (kt && RJECNIK[kt] != null) el.setAttribute('title', RJECNIK[kt]);
    }

    function primijeniJezik() {
      document.querySelectorAll('[data-i18n], [data-i18n-placeholder], [data-i18n-title]')
        .forEach(prevediElement);
      document.documentElement.lang = JEZIK || 'hr';
    }

    async function ucitajJezik(kod) {
      try {
        const r = await fetch('/api/jezik/' + kod);
        if (!r.ok) return false;
        RJECNIK = await r.json();
        JEZIK = kod;
        localStorage.setItem('tm_jezik', kod);
        primijeniJezik();
        // Sadrzaj SVIH kartica ploca sastavlja u JS-u, pa ga prolaz po data-i18n iznad
        // ne dira. Bez ovoga bi svaka kartica ostala na starom jeziku dok je korisnik
        // ne osvjezi rukom — tocno kvar iz TASK-4710 (Dezurni) i TASK-4720 (Config).
        osvjeziZaJezik();
        return true;
      } catch (e) { console.error('[jezik]', e); return false; }
    }

    /**
     * Ponovno iscrtavanje SVEGA sto se sastavlja u JS-u, nakon promjene jezika.
     * Popis je namjerno po karticama i pokriva svih 7 — provjerava ga PlocaJezik.test.ts,
     * jer je izostavljena kartica upravo nacin na koji je ovaj kvar tri puta prezivio.
     */
    function osvjeziZaJezik() {
      const zovi = (f, arg) => { try { f(arg); } catch (e) { console.error('[jezik]', e); } };
      // tasks — popis, traka odluka, prekidac odlucitelja, rucna kocnica, otvoren detalj
      zovi(fetchTasks);
      zovi(ucitajOdluke);
      zovi(ucitajOdlucitelja);
      zovi(renderGlobalPause);
      if (selectedTaskId) zovi(openTaskDetail, selectedTaskId);
      // projects — kartice, opis poretka, otvoren panel projekta
      zovi(renderProjects);
      zovi(osvjeziSortOpis);
      if (selectedProjectId) zovi(ucitajPotrosnjuProjekta, selectedProjectId);
      // potrosnja
      if (currentTab === 'potrosnja') { zovi(ucitajPotrosnju, {}); zovi(ucitajVrijednost, false); }
      // rag
      if (currentTab === 'rag') zovi(renderRAGEntries);
      // konzola
      if (currentTab === 'konzola') { zovi(fetchKonzolaStatus); zovi(fetchSessionUsage, false); }
      // status
      if (currentTab === 'status') zovi(fetchStatusDashboard);
      // config
      zovi(osvjeziDezurniJezik);
      if (document.getElementById('info-grid')) zovi(fetchInfoData);
    }

    async function postaviIzbornikJezika() {
      let podatci;
      try { podatci = await (await fetch('/api/jezici')).json(); }
      catch { return; }                       // bez popisa ploca radi na zatecenom jeziku
      const izbor = document.getElementById('izbor-jezika');
      if (!izbor) return;
      izbor.innerHTML = podatci.jezici
        .map(j => '<option value="' + j.kod + '">' + j.naziv + '</option>').join('');
      // Izbor korisnika ima prednost pred posluziteljevim zadanim; ako je jezik u
      // meduvremenu uklonjen iz mape locales, pada se na zadani.
      const kodovi = podatci.jezici.map(j => j.kod);
      const pocetni = (JEZIK && kodovi.includes(JEZIK)) ? JEZIK : podatci.zadani;
      izbor.value = pocetni;
      await ucitajJezik(pocetni);
      izbor.addEventListener('change', function () { ucitajJezik(this.value); });
    }


    // ─── Odlučitelj: model odlučuje umjesto korisnika ─────────────────────────
    // Goran, 04.09.2026. Prekidač stoji uz sam popis, a ne u Configu, jer se odluka donosi
    // ovdje — postavka koja se tiče ovog reda treba biti na dohvat ruke.
    async function ucitajOdlucitelja() {
      try {
        const d = await (await fetch('/api/odlucitelj/config')).json();
        const red = document.getElementById('odluke-odlucitelj');
        if (!red) return;
        red.style.display = odlukeOtvoreno ? 'flex' : 'none';
        document.getElementById('odluc-ukljucen').checked = !!d.postavke.ukljucen;
        const polje = document.getElementById('odluc-cekanje');
        // Ne prepisuj dok čovjek tipka — inače mu osvježavanje popisa pojede unos.
        if (polje && document.activeElement !== polje) {
          polje.value = d.postavke.cekanje_sati ?? d.postavke.odgoda_sati ?? 1;
        }

        // Davatelji se NE skrivaju kad nemaju ključ — pokazuju se s razlogom zašto ne rade.
        // Skriveni izbor bi izgledao kao da ih sustav nema, a ima ih; samo nisu spremni.
        const selP = document.getElementById('odluc-provider');
        const dav = d.davatelji || {};
        selP.innerHTML = Object.keys(dav).map(function (ime) {
          const v = dav[ime];
          // Razlog dolazi s posluzitelja, ali nosi kljuc rjecnika (TASK-4721) — inace bi
          // engleska ploca ovdje pisala hrvatski („nema Claude CLI na ovom stroju").
          const oznaka = v.spreman ? ime : ime + ' (' + _Tv(v.zastoKey || '', v.zasto || '', v.zastoVars || {}) + ')';
          return '<option value="' + ime + '"' + (v.spreman ? '' : ' disabled') + '>'
                 + oznaka + '</option>';
        }).join('');
        selP.value = d.postavke.provider;

        const sel = document.getElementById('odluc-model');
        sel.innerHTML = (d.modeli || []).map(function (m) {
          return '<option value="' + m + '">' + m + '</option>';
        }).join('');
        // Promjena davatelja obriše model (qwen3:8b ne postoji na Anthropicu). Sučelje tada
        // uzme prvi iz novog popisa i odmah ga spremi — inače bi ostalo prazno polje i
        // odlučitelj bi zvao davatelja bez imena modela.
        if (!d.postavke.model && (d.modeli || []).length) {
          sel.value = d.modeli[0];
          spremiOdlucitelja({ model: d.modeli[0] });
          return;
        }
        sel.value = d.postavke.model;
        const por = document.getElementById('odluc-poruka');
        if (!d.dostupno) {
          por.style.color = '#d98c3a';
          por.textContent = _Tv('odl_ollama_nedostupna', 'Ollama nije dostupna ({greska}) — model ne može odlučivati.',
                                { greska: d.greska || '' });
        } else if (!d.alat) {
          por.style.color = '#d98c3a';
          por.textContent = _T('odl_alat_nema', 'Alat odlucitelj.py nije nađen na ovom stroju.');
        } else {
          por.style.color = '#9a8c60';
          const koliko = (d.modeli || []).length;
          por.textContent = (d.postavke.ukljucen
              ? _T('odl_ukljucen', 'uključen')
              : _T('odl_iskljucen', 'isključen — odlučuješ ti'))
            + ' · ' + d.postavke.provider + ' · '
            + _Tv('odl_broj_modela', '{broj} modela', { broj: koliko });
        }
        // Tko odlučuje mora se vidjeti i kad je popis zatvoren — inače se stanje prekidača
        // sazna tek otvaranjem, a to je upravo pitanje koje korisnik postavlja izvana.
        const tko = document.getElementById('odluke-tko');
        if (tko) {
          const on = !!d.postavke.ukljucen;
          tko.className = 'odluke-tko' + (on ? ' aktivan' : '');
          tko.textContent = on
            ? _T('odlucuje_model', 'odlučuje model') + ': ' + d.postavke.model
            : _T('odlucujes_ti', 'odlučuješ ti');
        }
      } catch (e) { console.error('[odlucitelj]', e); }
    }

    async function spremiOdlucitelja(promjene) {
      try {
        const r = await fetch('/api/odlucitelj/config', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(promjene),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
        ucitajOdlucitelja();
      } catch (e) {
        const por = document.getElementById('odluc-poruka');
        por.style.color = '#d96a6a';
        por.textContent = _Tv('odl_nije_spremljeno', 'Nije spremljeno: {greska}', { greska: e.message });
      }
    }

    async function pokreniOdlucitelja(proba) {
      const por = document.getElementById('odluc-poruka');
      const gumbi = [document.getElementById('odluc-proba'), document.getElementById('odluc-izvrsi')];
      gumbi.forEach(function (g) { g.disabled = true; });
      por.style.color = '#9a8c60';
      por.textContent = proba ? _T('odl_pitam_model', 'pitam model…') : _T('odl_odlucujem', 'odlučujem…');
      try {
        const r = await fetch('/api/odlucitelj/pokreni', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ proba: proba }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
        const i = d.ishodi || [];
        const brojKreni = i.filter(function (x) { return x.rijec === 'kreni'; }).length;
        const brojCovjek = i.filter(function (x) { return x.rijec === 'covjek'; }).length;
        por.style.color = '#6fbf6f';
        por.textContent = (proba ? _T('odl_proba_prefiks', 'proba: ') : _T('odl_odluceno_prefiks', 'odlučeno: '))
          + _Tv('odl_ishod_sazetak', '{kreni} kreni, {odgodi} odgodi, {tebi} ostaje tebi',
                { kreni: brojKreni, odgodi: i.length - brojKreni - brojCovjek, tebi: brojCovjek });
        if (!proba) { setTimeout(function () { ucitajOdluke(); fetchTasks(); }, 1200); }
      } catch (e) {
        por.style.color = '#d96a6a';
        por.textContent = _Tv('odl_nije_proslo', 'Nije prošlo: {greska}', { greska: e.message });
      } finally {
        gumbi.forEach(function (g) { g.disabled = false; });
      }
    }

    // ─── Čeka odluku (Goran, 04.09.2026.) ─────────────────────────────────────
    // "taj needs-decision je ok, ali onda mi to napravi da je vidljivo i dodaj polje gdje ću
    // upisati odluku i stisnuti nastavi."
    // Traka je skrivena kad nema takvih zadataka — inače bi postala šum koji se prestane
    // gledati, a upravo je nevidljivost bila izvorni kvar.
    let odlukeOtvoreno = false;

    async function ucitajOdluke() {
      try {
        const r = await fetch('/api/odluke');
        if (!r.ok) return;
        const d = await r.json();
        const traka = document.getElementById('odluke-traka');
        if (!traka) return;
        if (!d.ukupno) { traka.style.display = 'none'; return; }
        traka.style.display = 'block';
        const sprem = d.spremni != null ? d.spremni : d.ukupno;
        const blok = d.blokirani || 0;
        // Naslov govori o onome što odluka doista pušta u rad; blokirani se navode odvojeno,
        // jer njih ni odluka ne pokreće dok se ne dovrši zadatak koji ih drži.
        // Goran, 05.09.2026.: „nista ne treba cekati mene ako sam odabrao da model odlucuje
        // za mene." Dok prekidač radi, naslov ne smije tvrditi da zadatci čekaju njega.
        const dodatakBlok = blok
          ? '  ·  ' + _Tv('blokirano_drugim_n', '{broj} blokirano drugim zadatkom', { broj: blok })
          : '';
        document.getElementById('odluke-naslov').textContent = (d.modelOdlucuje
          ? _Tv(sprem === 1 ? 'odl_naslov_model_1' : 'odl_naslov_model_n',
                sprem === 1
                  ? '{broj} zadatak u redu odlučitelja — odlučuje model, ne čeka tebe'
                  : '{broj} zadataka u redu odlučitelja — odlučuje model, ne čekaju tebe',
                { broj: sprem })
          : _Tv(sprem === 1 ? 'odl_naslov_covjek_1' : 'odl_naslov_covjek_n',
                sprem === 1 ? '{broj} zadatak čeka tvoju odluku' : '{broj} zadataka čeka tvoju odluku',
                { broj: sprem })) + dodatakBlok;
        // „Ne vidim da se nesto desava" (Goran, 05.09.2026.) — zato se zadnji prolaz vidi
        // UVIJEK, i kad je popis zatvoren, i kad model nije odlucio nista.
        const prolaz = document.getElementById('odluke-prolaz');
        if (prolaz) {
          const zp = d.odluciteljZadnji;
          if (zp) {
            const min = Math.max(0, Math.round((Date.now() - new Date(zp.ts).getTime()) / 60000));
            prolaz.style.display = 'block';
            prolaz.className = 'odluke-prolaz' + (zp.greska ? ' greska' : '');
            prolaz.textContent = '🤖 ' + zp.opis + ' · '
              + _Tv('prije_n_min', 'prije {broj} min', { broj: min < 1 ? '<1' : min });
          } else {
            prolaz.style.display = 'none';
          }
        }
        const popis = document.getElementById('odluke-popis');
        popis.style.display = odlukeOtvoreno ? 'flex' : 'none';
        const redOdl = document.getElementById('odluke-odlucitelj');
        if (redOdl) redOdl.style.display = odlukeOtvoreno ? 'flex' : 'none';
        document.getElementById('odluke-toggle').textContent =
          odlukeOtvoreno ? _T('sakrij', 'sakrij') : _T('prikazi', 'prikaži');
        popis.innerHTML = d.zadatci.map(function (t) {
          const ceka = t.cekaSati >= 24
            ? Math.floor(t.cekaSati / 24) + ' d'
            : (t.cekaSati > 0 ? t.cekaSati + ' h' : '<1 h');
          // Lanac: koliko zadataka ovaj otključava i čeka li još na nekoga. Bez ova dva
          // podatka se s ploče nije vidjelo koji zadatak drži cijeli niz.
          const lanac = (t.otkljucava
            ? '<span class="odluka-lanac' + (t.cekaNa && t.cekaNa.length ? '' : ' korijen') + '">'
              + (t.cekaNa && t.cekaNa.length ? '' : _T('korijen_niza', 'KORIJEN NIZA') + ' · ')
              + _Tv('otkljucava_n', 'otključava {broj}', { broj: t.otkljucava }) + '</span>'
            : '')
            + ((t.cekaNa && t.cekaNa.length)
              ? '<span class="odluka-ceka-na">' + _T('ceka_malo', 'čeka') + ' '
                + esc(t.cekaNa.join(', ')) + '</span>' : '');

          // Pitanje se prikazuje umjesto proze iz opisa; opis ostaje ispod, kao podloga.
          let pitanjeHtml = '';
          if (t.pitanje && (t.pitanje.opcije || []).length >= 2) {
            pitanjeHtml = '<div class="pitanje-blok">'
              + '<div class="pitanje-struka">' + _T('odl_trebam_eksperta', 'Trebam eksperta za:') + ' '
                + esc(t.pitanje.ekspert) + '</div>'
              + '<div class="pitanje-tekst">' + esc(t.pitanje.pitanje) + '</div>'
              + '<div class="pitanje-opcije">'
              + t.pitanje.opcije.map(function (o) {
                  return '<button class="opcija-gumb" data-oznaka="' + esc(o.oznaka) + '">'
                    + '<span class="opcija-slovo">' + esc(o.oznaka) + ')</span> ' + esc(o.tekst)
                    + '</button>';
                }).join('')
              + '</div>'
              + (t.pitanje.preporuka
                  ? '<div class="pitanje-preporuka">' + _T('odl_agent_preporuca', 'Agent preporuča:') + ' '
                    + esc(t.pitanje.preporuka) + '</div>' : '')
              + '</div>';
          } else if ((t.pitanjeGreske || []).length) {
            // Ne šutimo o manjkavom pitanju — inače se pravilo tiho izgubi, a upravo je
            // „blokada bez pitanja s opcijama" ono što je smetalo.
            pitanjeHtml = '<div class="pitanje-manjka"><strong>'
              + _T('odl_pitanje_manjka', 'Pitanje nije postavljeno po pravilu') + '</strong>'
              + '<ul>' + t.pitanjeGreske.map(function (g) { return '<li>' + esc(g) + '</li>'; }).join('') + '</ul>'
              + '</div>';
          }

          // Sto je model rekao o BAS OVOM zadatku — inace se ne zna je li ga presao ili
          // ga je namjerno ostavio covjeku.
          let modelKaze = '';
          if (t.odgoda) {
            const doKad = new Date(t.odgoda.do);
            const min = Math.round((doKad.getTime() - Date.now()) / 60000);
            const koliko = min >= 60 ? Math.round(min / 6) / 10 + ' h' : min + ' min';
            // Sat se ispisuje po jeziku sucelja; podatak (vrijeme) ostaje isti trenutak.
            const sat = doKad.toLocaleTimeString(JEZIK === 'en' ? 'en-GB' : 'hr-HR',
              { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Zagreb' });
            modelKaze = t.odgoda.najava
              // Najava: rok je TVOJ, i to se mora vidjeti kao poziv, ne kao obavijest o odgodi.
              ? '<div class="odluka-model-kaze">⏳ ' + (min > 0
                  ? _Tv('odl_rok_tece', 'imaš još {koliko} za odluku (do {sat}) — poslije odlučuje model',
                        { koliko: koliko, sat: sat })
                  : _T('odl_rok_istekao', 'rok je istekao — model odlučuje u sljedećem prolazu')) + '</div>'
              : '<div class="odluka-model-kaze">⏳ ' + _T('odl_odgodjen', 'odlučitelj ga je odgodio')
                + (t.odgoda.puta > 1 ? ' ' + _Tv('odl_n_put', '({broj}. put)', { broj: t.odgoda.puta }) : '')
                + ' — ' + (min > 0
                    ? _Tv('odl_vraca_se_za', 'vraća se za {koliko}, ne čeka tebe', { koliko: koliko })
                    : _T('odl_vraca_se_prolaz', 'vraća se u sljedećem prolazu, ne čeka tebe')) + '</div>';
          }
          // Najavu već ispisuje odbrojavanje iznad — drugi redak o istoj stvari je šum.
          if (t.odluciteljKaze && t.odluciteljKaze.rijec !== 'najava') {
            const k = t.odluciteljKaze;
            const sto = k.rijec === 'opcija'
              ? _Tv('odl_izabrao_opciju', 'izabrao opciju {opcija}', { opcija: k.opcija })
              : (k.ishod === 'upisano'
                  ? _Tv('odl_odlucio', 'odlučio: {rijec}', { rijec: k.rijec })
                  : _T('odl_ostavio_tebi', 'ostavio tebi') + (k.rijec ? ' (' + k.rijec + ')' : ''));
            modelKaze += '<div class="odluka-model-kaze">🤖 ' + esc(sto)
              + (k.razlog ? ' — ' + esc(String(k.razlog).slice(0, 220)) : '') + '</div>';
          }

          return '<div class="odluka-stavka" data-id="' + t.id + '">' +
            '<div class="odluka-naslov"><strong>' + t.id + '</strong> · ' + esc(t.title) + lanac + '</div>' +
            '<div class="odluka-meta">P' + (t.priority ?? '?') + ' · '
              + esc(t.assignee || _T('bez_izvrsitelja', 'bez izvršitelja')) +
              ' · ' + _T('ceka_malo', 'čeka') + ' ' + ceka + ' · '
              + esc((t.oznake || []).join(', ')) + '</div>' +
            pitanjeHtml + modelKaze +
            '<div class="odluka-opis">' + esc(String(t.description || '')) + '</div>' +
            '<div class="odluka-red">' +
              '<textarea class="odluka-unos" rows="5" placeholder="' + _esc(_T('odl_unos_placeholder',
                'Upiši odluku i obrazloženje — koliko treba, polje se rasteže. Klik na opciju gore je samo početak rečenice.')) + '"></textarea>' +
              '<div class="odluka-alat">' +
                '<button class="odluka-nastavi">' + _T('nastavi', 'Nastavi') + '</button>' +
                '<span class="odluka-savjet">' + _T('odl_savjet', 'Ctrl+Enter šalje · Enter je novi redak') + '</span>' +
              '</div>' +
            '</div><div class="odluka-poruka"></div></div>';
        }).join('');
        popis.querySelectorAll('.odluka-stavka').forEach(function (el) {
          const gumb = el.querySelector('.odluka-nastavi');
          const unos = el.querySelector('.odluka-unos');
          gumb.addEventListener('click', function () { posaljiOdluku(el); });
          // Ctrl+Enter šalje — polje je višeredno, pa sam Enter mora ostati novi redak.
          unos.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) posaljiOdluku(el);
          });
          // Klik na opciju SAMO upiše početak rečenice i vrati kursor u polje. Ne šalje —
          // odluka bez obrazloženja je za pola godine nečitljiva, a pogrešan klik nepovratan.
          el.querySelectorAll('.opcija-gumb').forEach(function (og) {
            og.addEventListener('click', function () {
              el.querySelectorAll('.opcija-gumb').forEach(function (d) { d.classList.remove('izabrana'); });
              og.classList.add('izabrana');
              const pocetak = og.textContent.trim();
              unos.value = pocetak + (unos.value.trim() ? '\\n' + unos.value.trim() : '\\n— ' + _T('odl_jer', 'jer') + ' ');
              unos.focus();
              unos.selectionStart = unos.selectionEnd = unos.value.length;
            });
          });
        });
      } catch (e) { console.error('[odluke]', e); }
    }

    async function posaljiOdluku(el) {
      const id = el.dataset.id;
      const unos = el.querySelector('.odluka-unos');
      const gumb = el.querySelector('.odluka-nastavi');
      const poruka = el.querySelector('.odluka-poruka');
      const odluka = (unos.value || '').trim();
      if (!odluka) {
        poruka.style.color = '#d98c3a';
        poruka.textContent = _T('odl_upisi_prvo', 'Upiši odluku prije nego nastaviš — ostaje zapisana uz zadatak.');
        unos.focus();
        return;
      }
      gumb.disabled = true; gumb.textContent = _T('saljem', 'šaljem…');
      try {
        const r = await fetch('/api/tasks/' + id + '/odluka', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ odluka: odluka, by: 'goran' }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
        poruka.style.color = '#6fbf6f';
        poruka.textContent = _T('odl_zapisana', 'Odluka zapisana, zadatak je vraćen u red.');
        gumb.textContent = _T('gotovo', 'gotovo');
        setTimeout(function () { ucitajOdluke(); fetchTasks(); }, 1200);
      } catch (e) {
        poruka.style.color = '#d96a6a';
        poruka.textContent = _Tv('odl_nije_proslo', 'Nije prošlo: {greska}', { greska: e.message });
        gumb.disabled = false; gumb.textContent = _T('nastavi', 'Nastavi');
      }
    }

    function esc(t) {
      return String(t == null ? '' : t).replace(/[&<>"]/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
      });
    }

    // ─── Ručna kočnica (TASK-3047) ────────────────────────────────────────────
    async function setTaskPaused(taskId, paused) {
      try {
        const res = await fetch(\`/api/tasks/\${taskId}/\${paused ? 'pause' : 'resume'}\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ by: 'goran' })
        });
        if (!res.ok) { console.error('[Pause] HTTP', res.status); return; }
        fetchTasks();
      } catch (err) {
        console.error('[Pause] error:', err);
      }
    }

    let globalPauseState = { paused: false };

    function renderGlobalPause(state) {
      globalPauseState = state || { paused: false };
      const btn = document.getElementById('global-pause-btn');
      const info = document.getElementById('global-pause-info');
      if (!btn) return;
      if (globalPauseState.paused) {
        btn.classList.add('paused');
        btn.innerHTML = '&#9654; ' + _T('nastavi', 'Nastavi');
        btn.title = _T('pauza_zaustavljeno_naslov', 'Rad je zaustavljen — klikni za nastavak');
        info.textContent = globalPauseState.description || _T('pauza_sve_pauzirano', 'SVE PAUZIRANO');
      } else {
        btn.classList.remove('paused');
        btn.innerHTML = '&#9208; ' + _T('pauza_gumb', 'Pauza');
        btn.title = _T('zaustavi_sav_automatski_rad', 'Zaustavi sav automatski rad');
        info.textContent = '';
      }
    }

    async function fetchGlobalPause() {
      try {
        const res = await fetch('/api/pause');
        if (res.ok) renderGlobalPause(await res.json());
      } catch { /* traka stanja nije kritična */ }
    }

    async function toggleGlobalPause() {
      const next = !globalPauseState.paused;
      // Potvrda samo za zaustavljanje — „Nastavi" je bezopasno i mora biti jedan klik.
      if (next && !confirm(_T('pauza_potvrda',
          'Zaustaviti SAV automatski rad?\\n\\nAuto-exec staje, a svi agenti koji trenutno rade bit će prekinuti. Zadaci ostaju gdje jesu i nastavljaju kad pritisneš „Nastavi".'))) return;
      const reason = next ? (prompt(_T('pauza_razlog_upit', 'Razlog (nije obavezno):')) || '') : '';
      try {
        const res = await fetch('/api/pause', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paused: next, by: 'goran', reason })
        });
        if (res.ok) renderGlobalPause(await res.json());
      } catch (err) {
        console.error('[Pause] global brake failed:', err);
      }
    }

    async function deleteTask(taskId) {
      try {
        const response = await fetch(\`/api/tasks/\${taskId}\`, {
          method: 'DELETE'
        });

        if (response.ok) {
          sendWSMessage({ action: 'delete_task', taskId });
          fetchTasks();
        }
      } catch (err) {
        console.error('Failed to delete task:', err);
      }
    }

    // TASK-3047: kočnica se veže i osvježava odmah pri učitavanju — stanje pauze mora biti
    // vidljivo prije nego korisnik bilo što klikne.
    document.getElementById('global-pause-btn').addEventListener('click', toggleGlobalPause);
    fetchGlobalPause();
    setInterval(fetchGlobalPause, 15000);   // zaštita ako WS padne

    // Modal for creating tasks
    const modal = document.getElementById('modal-overlay');
    const addTaskBtn = document.getElementById('add-task-btn');
    const cancelBtn = document.getElementById('cancel-btn');
    const taskForm = document.getElementById('task-form');

    addTaskBtn.addEventListener('click', () => {
      modal.style.display = 'flex';
      document.getElementById('task-title').focus();
    });

    cancelBtn.addEventListener('click', () => {
      modal.style.display = 'none';
      taskForm.reset();
    });

    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.style.display = 'none';
        taskForm.reset();
      }
    });

    taskForm.addEventListener('submit', async (e) => {
      e.preventDefault();

      const title = document.getElementById('task-title').value;
      const description = document.getElementById('task-description').value;
      const priority = parseInt(document.getElementById('task-priority').value);
      const assignee = document.getElementById('task-assignee').value;
      const projectId = document.getElementById('new-task-project').value;

      try {
        const response = await fetch('/api/tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title,
            description: description || undefined,
            priority,
            assignee: assignee || undefined,
            projectId: projectId || undefined
            // polje status je maknuto — POST ga ne poznaje (novi zadatak je ionako
            // pending), pa je samo punio log upozorenjem o ignoriranom polju (D6).
          })
        });

        if (response.ok) {
          const task = await response.json();
          sendWSMessage({ action: 'create_task', task });
          modal.style.display = 'none';
          taskForm.reset();
          fetchTasks();
        } else {
          // TASK-3627: ingress sada odbija zadatak bez opisa (422). Bez ove grane
          // forma bi na odbijenicu samo — nista: modal ostaje otvoren, korisnik
          // misli da je aplikacija zamrznula. Odbijenica nosi polje reason, pokazi ga.
          let msg = 'HTTP ' + response.status;
          try {
            const body = await response.json();
            if (body && (body.reason || body.error)) msg = body.reason || body.error;
          } catch (_) { /* tijelo nije JSON — ostaje status */ }
          alert(_Tv('tsk_nije_stvoren', 'Zadatak nije stvoren: {greska}', { greska: msg }));
        }
      } catch (err) {
        console.error('Failed to create task:', err);
        alert('Failed to create task. Please try again.');
      }
    });

    // ============================================
    // TASK DETAIL PANEL
    // ============================================

    let selectedTaskId = null;
    let selectedTaskData = null;
    let editedBlockedBy = [];
    let editedTags = [];

    // Panel elements
    const detailPanel = document.getElementById('detail-panel');
    const containerEl = document.querySelector('.container');

    // Open detail panel
    async function openTaskDetail(taskId) {
      try {
        const response = await fetch(\`/api/tasks/\${taskId}\`);
        if (!response.ok) throw new Error('Task not found');

        const task = await response.json();
        // TASK-3512: bez popisa projekata izbornik bi bio prazan (npr. kad WS veza
        // još nije stigla pozvati fetchProjectsForFilter). Dohvati ga na zahtjev.
        if (!projectsCache.length) {
          try { await fetchProjectsForFilter(); } catch (e) { console.error('projects unavailable:', e); }
        }
        selectedTaskId = taskId;
        selectedTaskData = task;
        editedBlockedBy = [...(task.blockedBy || [])];
        editedTags = [...(task.tags || [])];

        renderDetailPanel(task);
        detailPanel.classList.add('open');
        containerEl.classList.add('panel-open');
      } catch (err) {
        console.error('Failed to load task:', err);
        alert('Failed to load task details');
      }
    }

    // Close detail panel
    function closeDetailPanel() {
      detailPanel.classList.remove('open');
      containerEl.classList.remove('panel-open');
      selectedTaskId = null;
      selectedTaskData = null;
    }

    // Render task details in panel
    function renderDetailPanel(task) {
      document.getElementById('detail-task-id').textContent = task.id;
      document.getElementById('detail-title').value = task.title;
      document.getElementById('detail-status').value = task.status;
      document.getElementById('detail-priority').value = task.priority;
      document.getElementById('detail-assignee').value = task.assignee || '';
      document.getElementById('detail-description').value = task.description || '';
      document.getElementById('detail-blocked-reason').value = task.blockedReason || '';

      // TASK-3512: projekt — ime (ne šifra) + izbornik s trenutnim odabirom
      renderProjectField(task);

      // Render blocked by list
      renderBlockedByList();

      // Populate blocked by select with available tasks
      populateBlockedBySelect();

      // Render tags
      renderTagsList();

      // Render progress notes
      renderProgressNotes(task.progressNotes || []);

      // TASK-5013: upute agentu (dostavljeno / čeka)
      ucitajUpute(task.id);

      // TASK-4815: rezultat agenta — bedž (sud ploče) + sklopive sekcije + „prikaži sirovo".
      // Klijent NE parsira: sud stiže gotov s posluzitelja (task.resultParsed).
      renderResultSummary(task);

      // Render timestamps
      renderTimestamps(task);

      // TASK-3568 (T4): potrošnja se dohvaća TEK nakon što je kartica iscrtana,
      // pa otvaranje kartice nikad ne čeka izračun telemetrije.
      ucitajTelemetriju(task.id);
    }

    /* ─── TASK-4815: prikaz agentova rezultata ──────────────────────────────
     * SIGURNOSNI UGOVOR (§G revizije TASK-4814) — ovo NIJE stil, nego uvjet:
     *   1. sav agentov tekst ide kroz textContent, nikad kroz innerHTML;
     *   2. href se NIKAD ne sastavlja lijepljenjem — postavlja se kao svojstvo,
     *      uz provjeru sheme (http/https ili vlastiti /api/files/download);
     *   3. strukturu crta kod, sadržaj je uvijek podatak.
     * Prije ovoga je ulaz http://x"onmouseover="… postajao PRAVI atribut i JS iz
     * agentova teksta se izvršavao (dokazano u Chromiumu, Playwright).
     */
    function rsEscapeHtml(v) {
      return String(v == null ? '' : v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    /** Vrati SIGURAN href za token, ili null ako token nije poveznica. */
    function rsSafeHref(tok) {
      if (tok.indexOf('http') === 0) {
        try {
          var u = new URL(tok);
          if (u.protocol === 'http:' || u.protocol === 'https:') return encodeURI(tok);
        } catch (e) { /* neispravan URL nije poveznica */ }
        return null;
      }
      // Putanja mora imati bar jedan pravi znak iza kose crte; goli „/" (npr. u
      // „211 pass / 0 fail") inače postaje plava poveznica na ništa.
      // NAMJERNO BEZ OBRNUTE KOSE CRTE (ni u ovom komentaru): kod živi u predlošku,
      // koji pojede svaku obrnutu kosu crtu osim tri poznate. Uzorak s razredom znakova
      // stigao bi na stranicu bez nje, kao neispravan izraz koji obara CIJELU skriptu.
      // Brana: tests/unit/PlocaSkriptaParsira.test.ts (pouka TASK-4803, ponovljena ovdje).
      var pocetakPutanje = tok.charAt(0) === '/' ? 1 : (tok.substring(0, 2) === '~/' ? 2 : -1);
      if (pocetakPutanje > 0 && tok.length > pocetakPutanje
          && /[A-Za-z0-9_.@~+-]/.test(tok.charAt(pocetakPutanje))) {
        return '/api/files/download?path=' + encodeURIComponent(tok);
      }
      return null;
    }

    /** Tekst s klikabilnim poveznicama, izgrađen kao DOM (bez ijednog innerHTML). */
    function rsTextWithLinks(text) {
      var frag = document.createDocumentFragment();
      var toks = String(text == null ? '' : text).split(' ');
      for (var i = 0; i < toks.length; i++) {
        if (i > 0) frag.appendChild(document.createTextNode(' '));
        var href = rsSafeHref(toks[i]);
        if (href) {
          var a = document.createElement('a');
          a.href = href;                 // svojstvo, ne lijepljenje u atribut
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.textContent = toks[i];       // sadržaj nikad kao HTML
          frag.appendChild(a);
        } else {
          frag.appendChild(document.createTextNode(toks[i]));
        }
      }
      return frag;
    }

    function rsPreBlock(text) {
      var d = document.createElement('div');
      d.style.whiteSpace = 'pre-wrap';
      d.style.wordBreak = 'break-word';
      d.appendChild(rsTextWithLinks(text));
      return d;
    }

    /** Sklopiva sekcija — zatvorena, da kartica ostane pregledna. */
    function rsDetails(naslov, text, mono) {
      var det = document.createElement('details');
      det.style.marginTop = '0.4rem';
      var sum = document.createElement('summary');
      sum.textContent = naslov;
      sum.style.cursor = 'pointer';
      sum.style.opacity = '0.85';
      det.appendChild(sum);
      var body = rsPreBlock(text);
      body.style.marginTop = '0.3rem';
      if (mono) { body.style.fontFamily = 'monospace'; body.style.fontSize = '0.8rem'; }
      det.appendChild(body);
      return det;
    }

    var RS_BADGE_BOJA = {
      DONE: '#16a34a', DONE_WITH_CONCERNS: '#ca8a04', BLOCKED: '#dc2626',
      NEEDS_CONTEXT: '#ea580c', IN_PROGRESS: '#64748b', UNKNOWN: '#64748b'
    };
    // Natpisi se sastavljaju pri CRTANJU, ne pri učitavanju skripte: rječnik u trenutku
    // definicije još nije učitan, a ploča mora proći i na engleskom (PlocaJezik.test.ts).
    function rsSekcije() {
      return [
        ['results', _T('rez_sekcija_results', 'Rezultati')],
        ['analysis', _T('rez_sekcija_analysis', 'Analiza')],
        ['actions', _T('rez_sekcija_actions', 'Radnje')],
        ['next', _T('rez_sekcija_next', 'Sljedeći koraci')],
        ['capture', _T('rez_sekcija_capture', 'Zabilježeno')],
        ['story', _T('rez_sekcija_story', 'Objašnjenje')]
      ];
    }

    function renderResultSummary(task) {
      var rsField = document.getElementById('detail-result-field');
      var rsBox = document.getElementById('detail-result-summary');
      var rs = task.resultSummary || '';
      if (!rsBox || !rsField) return;
      if (!rs) { rsField.style.display = 'none'; return; }
      rsField.style.display = '';
      rsBox.textContent = '';                       // struktura se crta ispočetka

      var rp = task.resultParsed || null;

      // ── Bedž: sud dolazi s ploče, tekst ga je smio samo suziti ──────────────
      if (rp && rp.badge) {
        var red = document.createElement('div');
        red.style.cssText = 'display:flex;align-items:center;gap:0.4rem;flex-wrap:wrap;margin-bottom:0.4rem;';
        var bdz = document.createElement('span');
        bdz.textContent = (rp.badgeEmoji || '') + ' ' + rp.badge;
        bdz.title = _Tv('rez_izvor_suda', 'Izvor suda: {izvor}', { izvor: rp.badgeSource || '-' })
          + (rp.narrowed ? ' (' + _T('rez_sud_suzen', 'tekst je sud SUZIO') + ')' : '');
        bdz.style.cssText = 'font-size:0.72rem;font-weight:600;padding:0.1rem 0.45rem;border-radius:0.6rem;color:#fff;background:'
          + (RS_BADGE_BOJA[rp.badge] || '#64748b');
        red.appendChild(bdz);
        if (rp.mismatch) {
          var upoz = document.createElement('span');
          upoz.textContent = '\\u26A0\\uFE0F ' + _T('rez_neslaganje', 'tekst tvrdi da je gotovo, ploča kaže drugačije');
          upoz.style.cssText = 'font-size:0.72rem;color:#ea580c;';
          red.appendChild(upoz);
        }
        var raz = document.createElement('span');
        raz.textContent = rp.level + (rp.dialect && rp.dialect !== 'nijedan' ? ' · ' + rp.dialect : '');
        raz.title = _T('rez_razina_naslov', 'Razina prepoznatog formata (L0 pun do L3 sirovo)');
        raz.style.cssText = 'font-size:0.68rem;opacity:0.55;';
        red.appendChild(raz);
        rsBox.appendChild(red);
      }

      // ── L3 (79 % prometa): današnji prikaz, nepromijenjen ───────────────────
      var imaPolja = rp && rp.fields && Object.keys(rp.fields).length > 0;
      if (!imaPolja) {
        rsBox.appendChild(rsPreBlock(rs));
        return;
      }

      // ── L0/L1: sažetak otvoren, ostalo sklopivo ─────────────────────────────
      if (rp.fields.summary) {
        var sazetak = rsPreBlock(rp.fields.summary);
        sazetak.style.fontWeight = '500';
        rsBox.appendChild(sazetak);
      }
      if (rp.fields.statusText && rp.fields.statusText !== rp.fields.summary) {
        var st = rsPreBlock(rp.fields.statusText);
        st.style.opacity = '0.85';
        st.style.marginTop = '0.3rem';
        rsBox.appendChild(st);
      }
      var sekcije = rsSekcije();
      for (var i = 0; i < sekcije.length; i++) {
        var k = sekcije[i][0];
        if (rp.fields[k]) rsBox.appendChild(rsDetails(sekcije[i][1], rp.fields[k], false));
      }
      if (rp.verification) {
        rsBox.appendChild(rsDetails(_T('rez_sekcija_verifikacija', 'Verifikacija'), rp.verification, true));
      }
      if (rp.stepOutput) {
        rsBox.appendChild(rsDetails(_T('rez_sekcija_dokazi', 'Dokazi (REGOC-IZLAZ)'),
          typeof rp.stepOutput === 'string' ? rp.stepOutput : JSON.stringify(rp.stepOutput, null, 2), true));
      }
      if (rp.fields.spoken) {
        var sp = document.createElement('div');
        sp.textContent = '🗣️ ' + rp.fields.spoken;
        sp.style.cssText = 'margin-top:0.4rem;font-size:0.8rem;opacity:0.7;';
        rsBox.appendChild(sp);
      }
      // Prikazi sirovo je UVIJEK dostupno — parser ne smije nista sakriti.
      rsBox.appendChild(rsDetails(_Tv('rez_prikazi_sirovo', 'Prikaži sirovo ({n} zn)', { n: rs.length }), rs, true));
    }


    // TASK-3512: projekt zadatka — prikaz imena + izbornik za promjenu.
    // Aktivni projekti idu u prvu skupinu, arhivirani u drugu (na dno), prazna
    // vrijednost vraća zadatak u pretinac PRJ-033 (PUT šalje projectId:'' →
    // TaskManagerSQL.updateTask upisuje pretinac, NIKAD NULL — TASK-3514).
    function renderProjectField(task) {
      const select = document.getElementById('detail-project');
      const currentLabel = document.getElementById('detail-project-current');
      if (!select) return;

      const currentId = task.projectId || '';
      const known = projectsCache.filter(function (p) { return p.status !== 'archived'; });
      const archived = projectsCache.filter(function (p) { return p.status === 'archived'; });

      select.innerHTML = '';
      // TASK-3514: prazna vrijednost vise NE znaci NULL nego pretinac PRJ-033, pa i
      // natpis mora govoriti istinu o tome gdje ce zadatak zavrsiti.
      const none = document.createElement('option');
      none.value = '';
      none.textContent = '— ' + _T('prj_pretinac', 'Pretinac (bez projekta)') + ' —';
      select.appendChild(none);

      function addGroup(label, list) {
        if (!list.length) return;
        const group = document.createElement('optgroup');
        group.label = label;
        list.forEach(function (p) {
          const option = document.createElement('option');
          option.value = p.id;
          option.textContent = p.name + ' (' + p.id + ')';
          group.appendChild(option);
        });
        select.appendChild(group);
      }

      addGroup(_T('prj_aktivni_projekti', 'Aktivni projekti'), known);
      addGroup(_T('prj_arhivirani_projekti', 'Arhivirani projekti'), archived);

      // Projekt zadatka koji nije u popisu (obrisan ili popis nije stigao) ne smije
      // tiho nestati iz izbornika — inače bi ga prvo spremanje izbrisalo sa zadatka.
      const inList = projectsCache.some(function (p) { return p.id === currentId; });
      if (currentId && !inList) {
        const orphan = document.createElement('option');
        orphan.value = currentId;
        orphan.textContent = currentId + ' (' + _T('prj_nepoznat_projekt', 'nepoznat projekt') + ')';
        select.appendChild(orphan);
      }

      select.value = currentId;

      if (currentLabel) {
        const project = projectsCache.find(function (p) { return p.id === currentId; });
        if (!currentId) {
          currentLabel.textContent = _T('prj_trenutno', 'Trenutno:') + ' ' + _T('prj_bez_projekta', 'bez projekta');
        } else if (project) {
          currentLabel.textContent = _T('prj_trenutno', 'Trenutno:') + ' ' + project.name + ' (' + project.id + ')'
            + (project.status === 'archived' ? ' — ' + _T('prj_arhiviran', 'arhiviran') : '');
        } else {
          currentLabel.textContent = _T('prj_trenutno', 'Trenutno:') + ' ' + currentId
            + ' (' + _T('prj_nije_u_popisu', 'projekt nije u popisu') + ')';
        }
      }
    }

    // Render blocked by list
    function renderBlockedByList() {
      const list = document.getElementById('detail-blocked-by-list');
      list.innerHTML = editedBlockedBy.map(taskId => \`
        <div class="blocked-by-item">
          <span>\${taskId}</span>
          <span class="tag-remove" onclick="removeBlockedBy('\${taskId}')">&times;</span>
        </div>
      \`).join('');
    }

    // Populate blocked by select
    function populateBlockedBySelect() {
      const select = document.getElementById('detail-blocked-by-select');
      // TASK-3516: padajuća lista ide kronološki, najnovije na vrhu — inače bi
      // ostala u statusnim skupinama iz odgovora API-ja.
      const availableTasks = tasks.filter(t =>
        t.id !== selectedTaskId &&
        !editedBlockedBy.includes(t.id) &&
        t.status !== 'completed'
      ).sort(byNewestFirst);

      select.innerHTML = '<option value="">+ Add blocking task...</option>' +
        availableTasks.map(t => \`<option value="\${t.id}">\${t.id} - \${t.title.substring(0, 30)}</option>\`).join('');
    }

    // Add blocked by
    document.getElementById('detail-blocked-by-select').addEventListener('change', (e) => {
      if (e.target.value) {
        editedBlockedBy.push(e.target.value);
        renderBlockedByList();
        populateBlockedBySelect();
        e.target.value = '';
      }
    });

    // Remove blocked by
    function removeBlockedBy(taskId) {
      editedBlockedBy = editedBlockedBy.filter(id => id !== taskId);
      renderBlockedByList();
      populateBlockedBySelect();
    }

    // Render tags
    function renderTagsList() {
      const tagsContainer = document.getElementById('detail-tags');
      tagsContainer.innerHTML = editedTags.map(tag => \`
        <span class="tag">
          \${tag}
          <span class="tag-remove" onclick="removeTag('\${tag}')">&times;</span>
        </span>
      \`).join('');
    }

    // Add tag
    document.getElementById('detail-tag-input').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        let tag = e.target.value.trim();
        if (tag && !tag.startsWith('#')) tag = '#' + tag;
        if (tag && !editedTags.includes(tag)) {
          editedTags.push(tag);
          renderTagsList();
        }
        e.target.value = '';
      }
    });

    // Remove tag
    function removeTag(tag) {
      editedTags = editedTags.filter(t => t !== tag);
      renderTagsList();
    }

    // Render progress notes
    function renderProgressNotes(notes) {
      const notesContainer = document.getElementById('detail-progress-notes');
      if (!notes || notes.length === 0) {
        notesContainer.innerHTML = '<div class="empty">No progress notes</div>';
        return;
      }

      notesContainer.innerHTML = notes.map(note => {
        const date = new Date(note.timestamp);
        return \`
          <div class="progress-note">
            <div class="progress-note-meta">
              \${date.toLocaleDateString()} \${date.toLocaleTimeString()} - \${note.agent || 'unknown'}
            </div>
            <div>\${note.note}</div>
          </div>
        \`;
      }).join('');
    }

    // Render timestamps
    function renderTimestamps(task) {
      const timestampsContainer = document.getElementById('detail-timestamps');
      const format = (d) => d ? new Date(d).toLocaleString() : '-';

      timestampsContainer.innerHTML = \`
        <div><strong>Created:</strong> \${format(task.createdAt)} by \${task.createdBy || 'unknown'}</div>
        <div><strong>Updated:</strong> \${format(task.updatedAt)}</div>
        \${task.startedAt ? \`<div><strong>Started:</strong> \${format(task.startedAt)}</div>\` : ''}
        \${task.completedAt ? \`<div><strong>Completed:</strong> \${format(task.completedAt)}</div>\` : ''}
      \`;
    }

    // ========================================================================
    // TASK-3568 (T4) — odjeljak „Potrošnja zadatka"
    //
    // Podatci dolaze s GET /api/tasks/:id/telemetry, koji zove
    // tools/agent_telemetry.py nad NAŠIM transkriptima. Prikazuju se mjere iz
    // ISTRAZIVANJE_AGENTSIGHT §7: 1 razlaganje trajanja, 2 latencija modela,
    // 3 top 5 alata, 4 trenje, 5 udio keša.
    //
    // Tri pravila prikaza:
    //   • dohvat je asinkron i otkaziv (generacija + provjera selectedTaskId),
    //     pa brzo prebacivanje između kartica ne može prikazati tuđe brojke;
    //   • 202 „racuna" NIJE pogreška — pita se ponovno, ploča radi dalje;
    //   • nema telemetrije (stari zadatak bez transkripta) → mirna poruka,
    //     nikad crveni alert i nikad izmišljena nula.
    // ========================================================================
    var telemetrijaGen = 0;
    var telemetrijaTimer = null;

    function telEsc(t) {
      return String(t === null || t === undefined ? '' : t)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function telBroj(v, dec) {
      if (v === null || v === undefined || !isFinite(v)) return '—';
      var d = (dec === undefined) ? 1 : dec;
      try {
        return Number(v).toLocaleString(JEZIK === 'en' ? 'en-GB' : 'hr-HR', { minimumFractionDigits: d, maximumFractionDigits: d });
      } catch (e) {
        return Number(v).toFixed(d);
      }
    }

    function telTrajanje(sec) {
      if (sec === null || sec === undefined || !isFinite(sec)) return '—';
      if (sec >= 3600) {
        var h = Math.floor(sec / 3600);
        var m = Math.round((sec - h * 3600) / 60);
        return h + ' h ' + m + ' ' + _T('jed_min', 'min');
      }
      if (sec >= 60) {
        var mm = Math.floor(sec / 60);
        var ss = Math.round(sec - mm * 60);
        return mm + ' ' + _T('jed_min', 'min') + ' ' + ss + ' s';
      }
      return telBroj(sec, 1) + ' s';
    }

    function telPostotak(u, dec) {
      if (u === null || u === undefined || !isFinite(u)) return '—';
      return telBroj(u * 100, dec === undefined ? 1 : dec) + ' %';
    }

    /* ── Trosak u eurima (TASK-3609) ──────────────────────────────────────────
       Mjerenje ostaje u dolarima (run_log.jsonl.cost_usd — tako naplacuje dobavljac);
       euro je stvar prikaza. Pretvorba je NA JEDNOM mjestu, a tecaj i njegov datum idu
       u tooltip svakog iznosa, da se preracunata brojka moze provjeriti. */
    var TECAJ = { tecaj: null, datum: '', izvor: '' };

    function tecajOpis() {
      if (TECAJ.tecaj === null) return _T('tecaj_nije_ucitan', 'tečaj još nije učitan');
      var kako = TECAJ.izvor === 'ecb' ? 'ECB'
        : (TECAJ.izvor === 'kes' ? _T('tecaj_ecb_zadnji', 'ECB (zadnji poznati)') : _T('tecaj_pretpostavka', 'pretpostavka'));
      return '1 USD = ' + telBroj(TECAJ.tecaj, 5) + ' EUR · ' + kako + (TECAJ.datum ? ' · ' + TECAJ.datum : '');
    }

    /** USD → prikaz u eurima. Bez tecaja NE izmisljamo brojku — pise se crtica. */
    function eur(usd, dec) {
      if (usd === null || usd === undefined || !isFinite(usd)) return '—';
      if (TECAJ.tecaj === null) return '—';
      var d = (dec === undefined) ? 2 : dec;
      return '<span title="' + telEsc(telBroj(usd, 2) + ' USD · ' + tecajOpis()) + '">'
        + telBroj(usd * TECAJ.tecaj, d) + ' €</span>';
    }

    async function ucitajTecaj() {
      try {
        var r = await fetch('/api/tecaj');
        if (!r.ok) return;
        var d = await r.json();
        if (d && isFinite(d.tecaj) && d.tecaj > 0) TECAJ = d;
      } catch (e) { /* bez tecaja iznosi ostaju crtica, ne kriva brojka */ }
    }

    function telCelija(vrijednost, oznaka) {
      return '<div class="tel-cell"><b>' + vrijednost + '</b><span>' + telEsc(oznaka) + '</span></div>';
    }

    function telPostavi(html) {
      var box = document.getElementById('detail-telemetry');
      if (box) box.innerHTML = html;
    }

    function telHtml(data) {
      var t = data && data.telemetrija;
      if (!t) return '<span class="tel-muted">' + _T('tel_nema', 'Nema telemetrije za ovaj zadatak.') + '</span>';
      if (!t.imaPodatke) {
        return '<span class="tel-muted">' + telEsc(t.razlog || _T('tel_nema_izvodjenja', 'Za ovaj zadatak nema zabilježenog izvođenja agenta.')) + '</span>'
          + '<div class="tel-muted" style="margin-top:0.35rem;font-size:0.7rem;">'
          + _T('tel_nema_zapisa_opis', 'Potrošnja se računa iz transkripta sesije; zadatci nastali prije uvođenja telemetrije nemaju taj zapis.') + '</div>';
      }

      var h = [];

      // Zaglavlje: tko je izvodio, čime i s kojim ishodom.
      var glava = [];
      if (t.zadatak.agent) glava.push(telEsc(t.zadatak.agent));
      if (t.zadatak.model) glava.push(telEsc(t.zadatak.model));
      if (t.zadatak.outcome) glava.push(telEsc(t.zadatak.outcome));
      if (t.latencija.poziva !== null) glava.push(_Tv('tel_poziva_modela', '{broj} poziva modela', { broj: telBroj(t.latencija.poziva, 0) }));
      if (t.alati.poziva !== null) glava.push(_Tv('tel_poziva_alata', '{broj} poziva alata', { broj: telBroj(t.alati.poziva, 0) }));
      if (t.sesija.sessionId) glava.push(_T('tel_sesija', 'sesija') + ' ' + telEsc(t.sesija.sessionId.slice(0, 8)));
      var izvor = data.izvor === 'kes'
        ? _T('iz_kesa', 'iz keša') + (data.staroS !== null && data.staroS !== undefined ? ' (' + data.staroS + ' s)' : '')
        : _T('tel_svjeze_izracunato', 'svježe izračunato');
      h.push('<div class="tel-head"><span>' + glava.join(' · ') + '</span><span style="margin-left:auto;">' + izvor + '</span></div>');
      if (data.poruka) {
        h.push('<div class="tel-muted" style="margin-bottom:0.4rem;">' + telEsc(data.poruka) + '</div>');
      }

      // Mjera 1 — razlaganje trajanja.
      var tr = t.trajanje;
      var sirina = function (u) { return Math.max(0, Math.round((u || 0) * 1000) / 10); };
      h.push('<div class="tel-sec"><div class="tel-sec-title">'
        + _Tv('tel_razlaganje_trajanja', 'Razlaganje trajanja — ukupno {trajanje}', { trajanje: telTrajanje(tr.ukupnoS) }) + '</div>');
      h.push('<div class="tel-bar">'
        + '<span class="tel-seg-model" style="width:' + sirina(tr.udioModel) + '%"></span>'
        + '<span class="tel-seg-alat" style="width:' + sirina(tr.udioAlat) + '%"></span>'
        + '<span class="tel-seg-covjek" style="width:' + sirina(tr.udioCekanjeCovjeka) + '%"></span>'
        + '<span class="tel-seg-rezija" style="width:' + sirina(tr.udioRezija) + '%"></span>'
        + '</div>');
      h.push('<div class="tel-legend">'
        + '<span><i class="tel-seg-model"></i>' + _T('tel_model', 'model') + ' ' + telTrajanje(tr.modelS) + ' (' + telPostotak(tr.udioModel) + ')</span>'
        + '<span><i class="tel-seg-alat"></i>' + _T('tel_alati', 'alati') + ' ' + telTrajanje(tr.alatS) + ' (' + telPostotak(tr.udioAlat) + ')</span>'
        + '<span><i class="tel-seg-covjek"></i>' + _T('tel_cekanje_covjeka', 'čekanje čovjeka') + ' ' + telTrajanje(tr.cekanjeCovjekaS) + '</span>'
        + '<span><i class="tel-seg-rezija"></i>' + _T('tel_rezija', 'režija') + ' ' + telTrajanje(tr.rezijaS) + '</span>'
        + '</div></div>');

      // Mjera 2 — latencija modela.
      var l = t.latencija;
      h.push('<div class="tel-sec"><div class="tel-sec-title">' + _T('tel_latencija', 'Latencija modela') + '</div><div class="tel-grid">'
        + telCelija(telBroj(l.poziva, 0), _T('tel_poziva', 'poziva'))
        + telCelija(telBroj(l.prosjekS, 1) + ' s', _T('tel_prosjek', 'prosjek'))
        + telCelija(telBroj(l.medijanS, 1) + ' s', _T('tel_medijan', 'medijan'))
        + telCelija(telBroj(l.p95S, 1) + ' s', 'p95')
        + telCelija(telBroj(l.najvecaS, 1) + ' s', _T('tel_najveca', 'najveća'))
        + '</div></div>');

      // Mjera 3 — top 5 alata.
      var a = t.alati;
      h.push('<div class="tel-sec"><div class="tel-sec-title">'
        + _Tv('tel_alati_top5', 'Alati — top 5 od {poziva} poziva (neuspjelih {neuspjelih}, {udio})',
              { poziva: telBroj(a.poziva, 0), neuspjelih: telBroj(a.neuspjelih, 0), udio: telPostotak(a.udioNeuspjelih) })
        + '</div>');
      if (!a.top.length) {
        h.push('<div class="tel-muted">' + _T('tel_bez_alata', 'Zadatak nije zvao nijedan alat.') + '</div>');
      } else {
        var redci = ['<table class="tel-table"><tr><th>' + _T('tel_st_alat', 'alat') + '</th><th>' + _T('tel_poziva', 'poziva')
          + '</th><th>' + _T('tel_st_udio', 'udio') + '</th><th>' + _T('tel_st_neuspj', 'neuspj.')
          + '</th><th>' + _T('tel_st_trajanje', 'trajanje') + '</th></tr>'];
        a.top.forEach(function (x) {
          redci.push('<tr><td>' + telEsc(x.ime) + '</td><td>' + telBroj(x.poziva, 0) + '</td><td>'
            + telPostotak(x.udioPoziva, 0) + '</td><td>' + telBroj(x.neuspjelih, 0) + '</td><td>'
            + telTrajanje(x.trajanjeZbrojS) + '</td></tr>');
        });
        redci.push('</table>');
        h.push(redci.join(''));
        if (a.ostalihAlata > 0) {
          h.push('<div class="tel-muted" style="font-size:0.7rem;">+ '
            + _Tv('tel_jos_vrsta_alata', 'još {broj} vrsta alata', { broj: a.ostalihAlata }) + '</div>');
        }
      }
      h.push('</div>');

      // Mjera 5 — udio keša (+ trošak, koji dolazi iz run_log.jsonl).
      var k = t.tokeni;
      h.push('<div class="tel-sec"><div class="tel-sec-title">' + _T('tel_tokeni_kes', 'Tokeni i predmemorija') + '</div><div class="tel-grid">'
        + telCelija(telPostotak(k.udioKesa, 1), _T('udio_kesa', 'udio keša'))
        + telCelija(telBroj(k.ulazniKontekst, 0), _T('ulazni_kontekst', 'ulazni kontekst'))
        + telCelija(telBroj(k.izlaz, 0), _T('tel_izlaz', 'izlaz'))
        + telCelija(telBroj(k.kesPisanje, 0), _T('tel_pisanje_kesa', 'pisanje keša'))
        + telCelija(eur(t.trosak.usd), _T('trosak', 'trošak'))
        + '</div></div>');

      // Mjera 4 — trenje.
      var f = t.trenje;
      h.push('<div class="tel-sec"><div class="tel-sec-title">'
        + _T('tel_trenje_naslov', 'Trenje (ponovljena naredba / neuspjeli izlaz / petlja)') + '</div>');
      if (!f) {
        h.push('<div class="tel-muted">' + _T('nije_izmjereno', 'Nije izmjereno.') + '</div>');
      } else {
        var razina = (f.ocjena || 0) >= 1 ? 'lose' : ((f.upozorenja || 0) >= 1 ? 'upoz' : 'ok');
        var natpis = razina === 'ok' ? _T('tel_uredno', 'uredno')
          : (razina === 'upoz' ? _T('tel_upozorenje', 'upozorenje') : _T('tel_trenje', 'trenje'));
        h.push('<div><span class="tel-znacka ' + razina + '">' + natpis + '</span> '
          + '<span class="tel-muted">'
          + _Tv('tel_trenje_sazetak', 'ocjena {ocjena}/3 signala · upozorenja {upoz} · označenih raspona {raspona} · izgubljeno do {izgubljeno} ({udio})',
                { ocjena: telBroj(f.ocjena, 0), upoz: telBroj(f.upozorenja, 0), raspona: f.dogadjaja,
                  izgubljeno: telTrajanje(f.izgubljenoS), udio: telPostotak(f.udioIzgubljenog) })
          + '</span></div>');
        if (f.primjeri && f.primjeri.length) {
          var pl = ['<div style="margin-top:0.3rem;">'];
          f.primjeri.forEach(function (x) {
            pl.push('<div class="tel-primjer">• ' + telEsc(x.signal) + ' ×' + telBroj(x.puta, 0) + ' '
              + telEsc(x.razina) + (x.alat ? ' — ' + telEsc(x.alat) : '')
              + (x.argument ? ': ' + telEsc(x.argument) : '') + '</div>');
          });
          pl.push('</div>');
          h.push(pl.join(''));
        }
        h.push('<div class="tel-muted" style="font-size:0.68rem;margin-top:0.2rem;">'
          + _T('tel_trenje_napomena', 'Trenje je oznaka za pregled, ne presuda o zadatku (ADR §7.4).') + '</div>');
      }
      h.push('</div>');

      return h.join('');
    }

    async function ucitajTelemetriju(taskId, opts) {
      opts = opts || {};
      var gen = ++telemetrijaGen;
      if (telemetrijaTimer) { clearTimeout(telemetrijaTimer); telemetrijaTimer = null; }
      telPostavi('<span class="tel-muted">' + _T('ucitavam_potrosnju', 'Učitavam potrošnju…') + '</span>');
      var pokusaj = 0;

      async function korak() {
        if (gen !== telemetrijaGen || selectedTaskId !== taskId) return;
        try {
          var putanja = '/api/tasks/' + encodeURIComponent(taskId) + '/telemetry'
            + (opts.force && pokusaj === 0 ? '?force=1' : '');
          var res = await fetch(putanja);
          var data = null;
          try { data = await res.json(); } catch (e) { data = null; }
          if (gen !== telemetrijaGen || selectedTaskId !== taskId) return;

          if (res.status === 202) {
            pokusaj++;
            if (pokusaj > 6) {
              telPostavi('<span class="tel-muted">' + _T('izracun_dulje', 'Izračun traje dulje nego obično — pokušajte „Osvježi".') + '</span>');
              return;
            }
            telPostavi('<span class="tel-muted">' + _Tv('tel_racuna_se', 'Telemetrija se računa… ({pokusaj}/6)', { pokusaj: pokusaj }) + '</span>');
            telemetrijaTimer = setTimeout(korak, 1500);
            return;
          }
          if (!res.ok || !data || data.stanje === 'greska') {
            var zasto = data && data.poruka ? ': ' + telEsc(data.poruka) : '.';
            telPostavi('<span class="tel-muted">' + _T('tel_nedostupna', 'Telemetrija trenutačno nije dostupna') + zasto + '</span>');
            return;
          }
          telPostavi(telHtml(data));
        } catch (err) {
          if (gen !== telemetrijaGen) return;
          telPostavi('<span class="tel-muted">' + _T('tel_nedostupna', 'Telemetrija trenutačno nije dostupna') + '.</span>');
        }
      }

      korak();
    }

    var telemetrijaBtn = document.getElementById('telemetry-refresh-btn');
    if (telemetrijaBtn) {
      telemetrijaBtn.addEventListener('click', function () {
        if (selectedTaskId) ucitajTelemetriju(selectedTaskId, { force: true });
      });
    }

    // ========================================================================
    // TASK-3569 (T5) — kartica „Potrošnja": tjedni pregled (mjera 6)
    //
    // Podatci dolaze s GET /api/pregled/tjedni, koji zove
    // tools/tjedni_pregled.py nad run_log.jsonl i NAŠIM transkriptima.
    // Prikaz slijedi isto pravilo kao odjeljak na kartici zadatka:
    //   • 202 „racuna" NIJE pogreška — pita se ponovno;
    //   • uz SVAKU agregaciju piše iz koliko je izvođenja izračunata
    //     („iz N"), jer brojka bez nazivnika nije provjerljiva;
    //   • nedostajuća vrijednost je „—", nikad izmišljena nula.
    // Pomoćnici za oblikovanje (telEsc/telBroj/telTrajanje/telPostotak/telCelija)
    // su zajednički s T4 — namjerno se ne dupliciraju.
    // ========================================================================
    var potrosnjaGen = 0;
    var potrosnjaTimer = null;

    function potPostavi(html) {
      var box = document.getElementById('potrosnja-box');
      if (box) box.innerHTML = html;
    }

    function potIz(n) {
      return '<span class="tel-muted" style="font-size:0.68rem;">' + _Tv('pot_iz_n', 'iz {broj}', { broj: telBroj(n, 0) }) + '</span>';
    }

    /*
     * M3/TASK-4625 — tri ishoda izvođenja: completed / blocked_ok / failed.
     *
     * blocked_ok je agent koji je SAM deklarirao BLOCKED ili NEEDS_CONTEXT (čeka odluku,
     * nema mrežne rute, treba restart). To NIJE kvar i namjerno stoji odvojeno: dok se
     * brojalo zajedno s padovima, izmjerena „neuspješnost" bila je 81 %, a prava
     * tehnička 24/202 ≈ 12 % — pa se nije znalo što popravljati.
     * (docs/ISTRAZIVANJE-neuspjesi-i-greske.md §2 i §4/M3)
     */
    function potStupci(u) {
      var st = (u && u.ishodiStupci) || { completed: 0, blocked_ok: 0, failed: 0 };
      st.ukupno = st.completed + st.blocked_ok + st.failed;
      return st;
    }

    /** Tri značke u jednoj ćeliji tablice. */
    function potIshodi(st) {
      if (!st) return '—';
      return '<span class="tel-ishod ok" title="' + _esc(_T('pot_ishod_completed_naslov', 'completed — isporučeno i prihvaćeno')) + '">' + telBroj(st.completed, 0) + '</span>'
        + ' <span class="tel-ishod zastoj" title="' + _esc(_T('pot_ishod_blocked_naslov', 'blocked_ok — agent je sam stao pred preprekom, nije kvar')) + '">' + telBroj(st.blocked_ok, 0) + '</span>'
        + ' <span class="tel-ishod pad" title="' + _esc(_T('pot_ishod_failed_naslov', 'failed — spawn ili rezultat odbijen, ili je proces pao')) + '">' + telBroj(st.failed, 0) + '</span>';
    }

    /** Odjeljak „Ishodi izvođenja" — isti na kartici Potrošnja i na kartici projekta. */
    function potIshodiOdjeljak(u) {
      var st = potStupci(u);
      var udio = function (x) { return st.ukupno > 0 ? telPostotak(x / st.ukupno) : '—'; };
      var mali = function (x) { return ' <span class="tel-muted" style="font-size:0.7rem;">' + udio(x) + '</span>'; };
      var ishodi = u && u.ishodi ? u.ishodi : {};
      var razlomljeno = Object.keys(ishodi).map(function (k) { return k + ' ' + ishodi[k]; }).join(' · ') || '—';
      return '<div class="tel-sec"><div class="tel-sec-title">'
        + _Tv('pot_ishodi_naslov', 'Ishodi izvođenja — iz {broj} izvođenja', { broj: telBroj(st.ukupno, 0) })
        + '</div><div class="tel-grid">'
        + telCelija(telBroj(st.completed, 0) + mali(st.completed), _T('pot_celija_completed', 'completed · isporučeno'))
        + telCelija(telBroj(st.blocked_ok, 0) + mali(st.blocked_ok), _T('pot_celija_blocked', 'blocked_ok · agent uredno stao'))
        + telCelija(telBroj(st.failed, 0) + mali(st.failed), _T('pot_celija_failed', 'failed · spawn/rezultat pao'))
        + '</div>'
        + '<div class="tel-muted" style="margin-top:0.25rem;font-size:0.7rem;">'
        + _T('pot_blocked_opis', '<b>blocked_ok</b> = agent je SAM deklarirao BLOCKED/NEEDS_CONTEXT (čeka odluku, nema mrežne rute, treba restart). To nije kvar — većina tih zadataka poslije bude completed.')
        + ' ' + _T('pot_razlomljeno', 'Račlamba po sirovom ishodu:') + ' ' + telEsc(razlomljeno)
        + '</div></div>';
    }

    /** Redak tablice skupine (projekt ili agent) — dvije linije: brojke + nazivnici. */
    function potRedakSkupine(s, jeProjekt) {
      var ime = telEsc(s.kljuc) + (jeProjekt && s.naziv ? ' <span class="tel-muted">' + telEsc(s.naziv) + '</span>' : '');
      return '<tr>'
        + '<td>' + ime + '</td>'
        + '<td>' + telBroj(s.zadataka, 0) + '</td>'
        + '<td style="white-space:nowrap;">' + potIshodi(s.ishodiStupci) + '</td>'
        + '<td>' + eur(s.trosak.usd) + ' ' + potIz(s.trosak.izZadataka) + '</td>'
        + '<td>' + telBroj(s.tokeni.ulazniKontekst, 0) + ' ' + potIz(s.tokeni.izZadataka) + '</td>'
        + '<td>' + telPostotak(s.tokeni.udioKesa) + '</td>'
        + '<td>' + (s.latencija.prosjekS === null ? '—' : telBroj(s.latencija.prosjekS, 1) + ' s')
                 + ' ' + potIz(s.latencija.izZadataka) + '</td>'
        + '<td>' + telBroj(s.latencija.pozivaModela, 0) + '</td>'
        + '<td>' + telTrajanje(s.trajanje.ukupnoS) + ' ' + potIz(s.trajanje.izZadataka) + '</td>'
        + '</tr>';
    }

    function potTablica(naslov, redci, jeProjekt) {
      if (!redci || !redci.length) {
        return '<div class="tel-sec"><div class="tel-sec-title">' + telEsc(naslov) + '</div>'
          + '<span class="tel-muted">' + _T('pot_nema_izvodjenja', 'Nema izvođenja u razdoblju.') + '</span></div>';
      }
      var html = '<div class="tel-sec"><div class="tel-sec-title">' + telEsc(naslov)
        + ' &mdash; ' + _Tv('pot_n_skupina', '{broj} skupina', { broj: redci.length }) + '</div>'
        + '<table class="tel-table"><thead><tr>'
        + '<th>' + (jeProjekt ? _T('st_projekt', 'projekt') : _T('st_agent', 'agent')) + '</th>'
        + '<th>' + _T('st_izvodj', 'izvođ.') + '</th>'
        + '<th title="' + _esc(_T('pot_stupac_ishodi_naslov', 'completed · blocked_ok (uredan zastoj) · failed')) + '">'
        + _T('st_ishodi', 'ishodi') + '</th><th>' + _T('trosak', 'trošak') + '</th>'
        + '<th>' + _T('ulazni_kontekst', 'ulazni kontekst') + '</th><th>' + _T('st_kes', 'keš') + '</th>'
        + '<th>' + _T('st_latencija', 'latencija') + ' &empty;</th>'
        + '<th>' + _T('tel_poziva', 'poziva') + '</th><th>' + _T('tel_st_trajanje', 'trajanje') + '</th>'
        + '</tr></thead><tbody>';
      for (var i = 0; i < redci.length; i++) html += potRedakSkupine(redci[i], jeProjekt);
      return html + '</tbody></table></div>';
    }

    function potHtml(data) {
      var p = data && data.pregled;
      if (!p) return '<span class="tel-muted">' + _T('pot_nema_pregleda', 'Nema pregleda.') + '</span>';
      var u = p.ukupno;
      var izv = p.izvor;

      if (!u || !u.zadataka) {
        return '<span class="tel-muted">'
          + _Tv('pot_nema_u_razdoblju', 'U zadnjih {dana} dana nema nijednog zabilježenog izvođenja u run_log.jsonl.',
                { dana: telBroj(p.dana, 0) }) + '</span>';
      }

      var html = '<div class="tel-head">'
        + '<b>' + _Tv('pot_zadnjih_n_dana', 'zadnjih {dana} dana', { dana: telBroj(p.dana, 0) }) + '</b>'
        + '<span class="tel-muted">' + telEsc((p.od || '').slice(0, 10)) + ' &rarr; ' + telEsc((p.do || '').slice(0, 10)) + '</span>'
        + '<span class="tel-muted">&middot; '
        + _Tv('pot_n_izvodjenja_m_zadataka', '{izvodjenja} izvođenja ({zadataka} različitih zadataka)',
              { izvodjenja: telBroj(u.zadataka, 0), zadataka: telBroj(u.razlicitihZadataka, 0) })
        + '</span>'
        + '<span class="tel-muted">&middot; ' + _Tv('pot_s_transkriptom', 's transkriptom {broj}', { broj: telBroj(u.sTranskriptom, 0) }) + '</span>'
        + '</div>';
        + '</div>';

      // UKUPNO — svaka ćelija nosi svoj nazivnik u oznaci
      html += '<div class="tel-sec"><div class="tel-sec-title">' + _T('ukupno', 'Ukupno') + '</div><div class="tel-grid">'
        + telCelija(eur(u.trosak.usd), _T('trosak', 'trošak') + ' · ' + _Tv('iz_n', 'iz {broj}', { broj: u.trosak.izZadataka }))
        + telCelija(eur(u.trosak.usdPoZadatku), _T('po_izvodjenju', 'po izvođenju'))
        + telCelija(telBroj(u.tokeni.ulazniKontekst, 0), _T('ulazni_kontekst', 'ulazni kontekst') + ' · ' + _Tv('iz_n', 'iz {broj}', { broj: u.tokeni.izZadataka }))
        + telCelija(telBroj(u.tokeni.izlaz, 0), _T('izlazni_tokeni', 'izlazni tokeni') + ' · ' + _Tv('iz_n', 'iz {broj}', { broj: u.tokeni.izZadataka }))
        + telCelija(telPostotak(u.tokeni.udioKesa), _T('udio_kesa', 'udio keša') + ' · ' + _Tv('iz_n', 'iz {broj}', { broj: u.tokeni.izZadataka }))
        + telCelija(telTrajanje(u.trajanje.ukupnoS), _T('tel_st_trajanje', 'trajanje') + ' · ' + _Tv('iz_n', 'iz {broj}', { broj: u.trajanje.izZadataka }))
        + '</div></div>';

      html += potIshodiOdjeljak(u);

      html += '<div class="tel-sec"><div class="tel-sec-title">'
        + _Tv('pot_latencija_naslov', 'Latencija modela — iz {izvodjenja} izvođenja, {poziva} poziva',
              { izvodjenja: telBroj(u.latencija.izZadataka, 0), poziva: telBroj(u.latencija.izPoziva, 0) })
        + '</div><div class="tel-grid">'
        + telCelija((u.latencija.prosjekS === null ? '—' : telBroj(u.latencija.prosjekS, 1) + ' s'), _T('tel_prosjek', 'prosjek'))
        + telCelija((u.latencija.medijanS === null ? '—' : telBroj(u.latencija.medijanS, 1) + ' s'), _T('tel_medijan', 'medijan'))
        + telCelija((u.latencija.p95S === null ? '—' : telBroj(u.latencija.p95S, 1) + ' s'), 'p95')
        + telCelija((u.latencija.najvecaS === null ? '—' : telBroj(u.latencija.najvecaS, 1) + ' s'), _T('tel_najveca', 'najveća'))
      // Alati (mjera 3) i trenje (mjera 4) u razdoblju
      var vrh = (u.alati.vrh || []).map(function (t) {
        return telEsc(t.ime) + ' ' + telBroj(t.poziva, 0)
          + (t.neuspjelih ? ' <span class="tel-znacka upoz">' + telBroj(t.neuspjelih, 0) + ' ' + _T('tel_st_neuspj', 'neuspj.') + '</span>' : '');
      }).join(' &middot; ') || '—';
      html += '<div class="tel-sec"><div class="tel-sec-title">'
        + _Tv('pot_alati_trenje_naslov', 'Alati i trenje — iz {broj} izvođenja', { broj: telBroj(u.alati.izZadataka, 0) })
        + '</div>'
        + '<div>' + _Tv('pot_poziva_neuspjelih', '{poziva} poziva, neuspjelih {neuspjelih} ({udio})',
              { poziva: telBroj(u.alati.poziva, 0), neuspjelih: telBroj(u.alati.neuspjelih, 0), udio: telPostotak(u.alati.udioNeuspjelih) })
        + ' &middot; ' + vrh + '</div>'
        + '<div class="tel-muted" style="margin-top:0.2rem;">'
        + _Tv('pot_trenje_sazetak', 'trenje: {sTrenjem} izvođenja s trenjem (mjereno na {mjereno}) · izgubljeno do {izgubljeno}',
              { sTrenjem: telBroj(u.trenje.zadatakaSTrenjem, 0), mjereno: telBroj(u.trenje.izZadataka, 0),
                izgubljeno: telTrajanje(u.trenje.izgubljenoS) })
        + '</div></div>';

      html += potTablica(_T('pot_po_projektu', 'Po projektu'), p.poProjektu, true);
      html += potTablica(_T('pot_po_agentu', 'Po agentu'), p.poAgentu, false);

      // Pet najskupljih zadataka
      if (p.najskuplji && p.najskuplji.length) {
        html += '<div class="tel-sec"><div class="tel-sec-title">'
          + _Tv('pot_najskupljih', 'Najskupljih {broj}', { broj: p.najskuplji.length })
          + '</div><table class="tel-table"><thead><tr>'
          + '<th>' + _T('st_zadatak', 'zadatak') + '</th><th>' + _T('st_agent', 'agent') + '</th>'
          + '<th>' + _T('st_projekt', 'projekt') + '</th><th>' + _T('trosak', 'trošak') + '</th>'
          + '<th>' + _T('tel_st_trajanje', 'trajanje') + '</th><th>' + _T('tel_poziva', 'poziva') + '</th>'
          + '<th>' + _T('st_kes', 'keš') + '</th></tr></thead><tbody>';
        for (var j = 0; j < p.najskuplji.length; j++) {
          var z = p.najskuplji[j];
          html += '<tr><td><b>' + telEsc(z.taskId) + '</b>'
            + (z.naslov ? '<br><span class="tel-muted" style="font-size:0.68rem;">' + telEsc(z.naslov.slice(0, 70)) + '</span>' : '')
            + '</td><td>' + telEsc(z.agent) + '</td><td>' + telEsc(z.projectId || '—') + '</td>'
            + '<td>' + (z.trosakUsd === null ? '—' : telBroj(z.trosakUsd, 2) + ' $') + '</td>'
            + '<td>' + telTrajanje(z.trajanjeS) + '</td>'
            + '<td>' + telBroj(z.pozivaModela, 0) + '</td>'
            + '<td>' + telPostotak(z.udioKesa) + '</td></tr>';
        }
        html += '</tbody></table></div>';
      }

      // Izvor i upozorenja — bez ovoga se brojke ne mogu provjeriti
      html += '<div class="tel-sec"><div class="tel-sec-title">' + _T('pot_izvor', 'Izvor') + '</div>'
        + '<div class="tel-muted">' + telEsc(izv.runLog || 'run_log.jsonl') + ' &middot; '
        + _Tv('pot_izvor_opis', '{uRazdoblju} izvođenja u razdoblju (od {ukupno} ukupno) · s transkriptom {sTranskriptom} · iz keša {izKesa}, izračunato sada {sada}',
              { uRazdoblju: telBroj(izv.izvodjenjaURazdoblju, 0), ukupno: telBroj(izv.runLogRedakaUkupno, 0),
                sTranskriptom: telBroj(izv.sTranskriptom, 0), izKesa: telBroj(izv.izKesa, 0),
                sada: telBroj(izv.izracunatoSada, 0) })
        + '</div>';
      if (p.upozorenja && p.upozorenja.length) {
        html += '<ul class="tel-muted" style="margin:0.3rem 0 0 1rem;padding:0;">';
        for (var w = 0; w < p.upozorenja.length; w++) html += '<li>' + telEsc(p.upozorenja[w]) + '</li>';
        html += '</ul>';
      }
      html += '</div>';
      return html;
    }

    async function ucitajPotrosnju(opts) {
      opts = opts || {};
      var gen = ++potrosnjaGen;
      if (potrosnjaTimer) { clearTimeout(potrosnjaTimer); potrosnjaTimer = null; }
      var izbor = document.getElementById('potrosnja-dana');
      var dana = izbor ? izbor.value : '7';
      var info = document.getElementById('potrosnja-izvor');
      potPostavi('<span class="tel-muted">' + _T('pot_ucitavam_pregled', 'Učitavam pregled…') + '</span>');
      if (info) info.textContent = '—';
      var pokusaj = 0;

      async function korak() {
        if (gen !== potrosnjaGen) return;
        try {
          var putanja = '/api/pregled/tjedni?dana=' + encodeURIComponent(dana)
            + (opts.force && pokusaj === 0 ? '&force=1' : '');
          var res = await fetch(putanja);
          var data = null;
          try { data = await res.json(); } catch (e) { data = null; }
          if (gen !== potrosnjaGen) return;

          if (res.status === 202) {
            pokusaj++;
            if (pokusaj > 12) {
              potPostavi('<span class="tel-muted">' + _T('izracun_dulje', 'Izračun traje dulje nego obično — pokušajte „Osvježi".') + '</span>');
              return;
            }
            potPostavi('<span class="tel-muted">' + _Tv('pot_racuna_se', 'Pregled se računa… ({pokusaj}/12)', { pokusaj: pokusaj }) + '</span>');
            potrosnjaTimer = setTimeout(korak, 1500);
            return;
          }
          if (!res.ok || !data || data.stanje === 'greska') {
            var zasto = data && data.poruka ? ': ' + telEsc(data.poruka) : '.';
            potPostavi('<span class="tel-muted">' + _T('pot_nedostupan', 'Pregled trenutačno nije dostupan') + zasto + '</span>');
            return;
          }
          potPostavi(potHtml(data));
          if (info) {
            // TASK-3691: uz izvor ide i rezultat kontrole — pregled i kartica projekta
            // moraju pokazivati isti novac; razilaženje se KAŽE, ne prešućuje.
            var k = data.kontrola;
            var kTekst = '';
            if (k && k.slaze === true) {
              kTekst = ' · ✔ ' + _T('pot_kontrola_ok', 'slaže se s cost_logom');
            } else if (k && k.slaze === false) {
              kTekst = ' · ⚠ ' + _Tv('pot_kontrola_razlika', 'razlika prema cost_logu: {iznos} €',
                { iznos: telBroj((k.razlikaUsd || 0) * (TECAJ.tecaj || 0), 2) });
            }
            info.textContent = (data.izvor === 'kes' ? _T('iz_kesa', 'iz keša') : _T('svjez_izracun', 'svjež izračun'))
              + (data.staroS ? ' · ' + _Tv('star_n_s', 'star {broj} s', { broj: data.staroS }) : '') + kTekst;
          }
        } catch (err) {
          if (gen !== potrosnjaGen) return;
          potPostavi('<span class="tel-muted">' + _T('pot_nedostupan', 'Pregled trenutačno nije dostupan') + '.</span>');
        }
      }

      korak();
    }

    // ── TASK-3691: vrijednost korisničkih upita (cjenik S1–S6) ────────────────
    function vrijednostOpis(r) {
      return {
        S1: _T('vr_s1', 'jednostavno pitanje / naredba'),
        S2: _T('vr_s2', 'poslovni ili informativni upit'),
        S3: _T('vr_s3', 'tehnički problem koji traži razmišljanje'),
        S4: _T('vr_s4', 'analiza / debugging / odluka'),
        S5: _T('vr_s5', 'istraživanje i usporedba izvora'),
        S6: _T('vr_s6', 'višekoračni rad na projektu')
      }[r] || '';
    }

    /** „Goran 861,50 € (312) · Martina Sport 758,70 € (140)" — za hover i za popis. */
    function osobeOpis(poKorisniku) {
      if (!poKorisniku) return _T('prj_nema_osoba', 'nema podataka o osobama');
      var k = Object.keys(poKorisniku);
      if (!k.length) return _T('prj_nema_osoba', 'nema podataka o osobama');
      k.sort(function (a, b) { return poKorisniku[b].eur - poKorisniku[a].eur; });
      return _T('prj_tko_je_radio', 'Tko je radio') + ': ' + k.map(function (ime) {
        return ime + ' ' + telBroj(poKorisniku[ime].eur, 2) + ' € ('
          + _Tv('vr_n_upita', '{broj} upita', { broj: poKorisniku[ime].upita }) + ')';
      }).join(' · ');
    }

    /** Sitne značke uz naziv projekta — inicijal osobe i njezin udio. */
    function osobeZnacke(poKorisniku) {
      if (!poKorisniku) return '';
      var k = Object.keys(poKorisniku);
      if (!k.length) return '';
      k.sort(function (a, b) { return poKorisniku[b].eur - poKorisniku[a].eur; });
      return ' ' + k.slice(0, 3).map(function (ime) {
        return '<span class="osoba-znacka" title="' + telEsc(ime + ': ' + telBroj(poKorisniku[ime].eur, 2)
          + ' € ' + _Tv('iz_n_upita', 'iz {broj} upita', { broj: poKorisniku[ime].upita })) + '">'
          + telEsc(ime.split(' ')[0]) + '</span>';
      }).join('');
    }

    function vrijednostHtml(d) {
      var cj = d.cjenik || {};
      var razredi = Object.keys(cj);
      var korisnici = Object.keys(d.poKorisniku || {});
      korisnici.sort(function (a, b) { return (d.poKorisniku[b].eur || 0) - (d.poKorisniku[a].eur || 0); });
      var h = '<table class="tel-table"><thead><tr><th>' + _T('vr_st_korisnik', 'Korisnik') + '</th>';
      razredi.forEach(function (r) { h += '<th title="' + telEsc(vrijednostOpis(r) + ' · ' + cj[r] + ' €') + '">' + r + '</th>'; });
      h += '<th>' + _T('vr_st_upita', 'upita') + '</th><th>' + _T('vr_st_vrijednost', 'vrijednost') + '</th></tr></thead><tbody>';
      var zbroj = {}, ukupnoUpita = 0, ukupnoEur = 0;
      korisnici.forEach(function (k) {
        var v = d.poKorisniku[k];
        h += '<tr><td><strong>' + telEsc(k) + '</strong></td>';
        razredi.forEach(function (r) {
          var n = (v.razredi || {})[r] || 0;
          zbroj[r] = (zbroj[r] || 0) + n;
          h += '<td>' + telBroj(n, 0) + '</td>';
        });
        ukupnoUpita += v.upita || 0; ukupnoEur += v.eur || 0;
        h += '<td>' + telBroj(v.upita || 0, 0) + '</td><td><strong>' + telBroj(v.eur || 0, 2) + ' €</strong></td></tr>';
      });
      h += '<tr><td><strong>' + _T('ukupno_velika', 'UKUPNO') + '</strong></td>';
      razredi.forEach(function (r) { h += '<td><strong>' + telBroj(zbroj[r] || 0, 0) + '</strong></td>'; });
      h += '<td><strong>' + telBroj(ukupnoUpita, 0) + '</strong></td><td><strong>'
        + telBroj(ukupnoEur, 2) + ' €</strong></td></tr></tbody></table>';
      var pp = d.poProjektu || {};
      var pids = Object.keys(pp);
      if (pids.length) {
        pids.sort(function (a, b) { return pp[b].eur - pp[a].eur; });
        h += '<div class="tel-head" style="margin-top:0.8rem;">' + _T('pot_po_projektu', 'Po projektu') + '</div>';
        h += '<table class="tel-table"><thead><tr><th>' + _T('vr_st_projekt', 'Projekt') + '</th>';
        razredi.forEach(function (r) { h += '<th>' + r + '</th>'; });
        h += '<th>' + _T('vr_st_upita', 'upita') + '</th><th>' + _T('vr_st_vrijednost', 'vrijednost') + '</th></tr></thead><tbody>';
        pids.forEach(function (pid) {
          var v = pp[pid];
          // Ključ projekta sam po sebi ne kaže ništa (Goran): ide pun naziv, a ključ ostaje
          // sitno uz njega jer se po njemu traži drugdje. Tko je radio — na hover.
          var naziv = v.naziv && v.naziv !== pid ? v.naziv : pid;
          h += '<tr><td title="' + telEsc(osobeOpis(v.poKorisniku)) + '">' + telEsc(naziv)
            + ' <span class="tel-muted" style="font-size:0.7rem;">' + telEsc(pid) + '</span>'
            + osobeZnacke(v.poKorisniku) + '</td>';
          razredi.forEach(function (r) { h += '<td>' + telBroj((v.razredi || {})[r] || 0, 0) + '</td>'; });
          h += '<td>' + telBroj(v.upita, 0) + '</td><td><strong>' + telBroj(v.eur, 2) + ' €</strong></td></tr>';
        });
        h += '</tbody></table>';
      }
      h += '<div class="tel-muted" style="margin-top:0.4rem;font-size:0.75rem;">'
        + _T('vr_razred_opis', 'Razred se određuje iz zabilježenog rada po upitu (koraci, pozivi alata, vrsta alata), ne iz cijene modela.') + ' '
        + _T('vr_cjenik', 'Cjenik:') + ' ' + razredi.map(function (r) { return r + ' ' + cj[r] + ' €'; }).join(' · ')
        + (d.razdoblje ? ' · ' + _T('vr_razdoblje', 'razdoblje') + ' ' + d.razdoblje[0] + ' → ' + d.razdoblje[1] : '') + '</div>';
      return h;
    }

    async function ucitajVrijednost(force) {
      var box = document.getElementById('vrijednost-box');
      var info = document.getElementById('vrijednost-izvor');
      if (!box) return;
      box.className = 'tel-box tel-muted';
      box.innerHTML = _T('racunam', 'Računam…');
      try {
        var r = await fetch('/api/vrijednost-inputa' + (force ? '?force=1' : ''));
        var d = await r.json();
        if (!r.ok || d.error) {
          box.innerHTML = '<span class="tel-muted">' + _T('vr_nedostupan', 'Izračun nije dostupan') + (d.error ? ': ' + telEsc(d.error) : '.') + '</span>';
          return;
        }
        box.className = 'tel-box';
        box.innerHTML = vrijednostHtml(d);
        if (info) info.textContent = (d.izvor === 'kes' ? _T('iz_kesa', 'iz keša') : _T('svjez_izracun', 'svjež izračun'))
          + (d.staroS ? ' · ' + _Tv('star_n_s', 'star {broj} s', { broj: d.staroS }) : '')
          + ' · ' + _Tv('vr_n_upita', '{broj} upita', { broj: d.upita || 0 });
      } catch (e) {
        box.innerHTML = '<span class="tel-muted">' + _T('vr_nedostupan', 'Izračun nije dostupan') + '.</span>';
      }
    }

    (function initVrijednost() {
      var b = document.getElementById('vrijednost-refresh-btn');
      if (b) b.addEventListener('click', function () { ucitajVrijednost(true); });
    })();

    function initPotrosnja() { ucitajPotrosnju({}); ucitajVrijednost(false); pokreniAutoPotrosnju(); }

    /**
     * TASK-3691 (Goran): „potrošnja se automatski mora osvježavati".
     * Dosad se brojka računala samo pri otvaranju kartice i na klik „Osvježi", pa je
     * ploča znala satima pokazivati stanje od jutros. Sada se kartica sama osvježava
     * dok je otvorena; napuštena kartica gasi svoj interval (isti razlog kao potrosnjaGen —
     * pozadinska kartica ne smije trošiti ni poslužitelj ni kvotu).
     * Razmak je 120 s, a poslužiteljev keš je 300 s, pa većina prolaza ne pokreće python.
     */
    var AUTO_POTROSNJA_MS = 120000;
    var AUTO_PROJEKTI_MS = 60000;
    var autoPotrosnjaInterval = null;
    var autoProjektiInterval = null;

    function pokreniAutoPotrosnju() {
      if (autoPotrosnjaInterval) return;
      autoPotrosnjaInterval = setInterval(function () {
        if (currentTab !== 'potrosnja') return;
        if (document.hidden) return;   // skrivena kartica preglednika ne osvježava ništa
        ucitajPotrosnju({});
      }, AUTO_POTROSNJA_MS);
    }

    function pokreniAutoProjekte() {
      if (autoProjektiInterval) return;
      autoProjektiInterval = setInterval(function () {
        if (currentTab !== 'projects') return;
        if (document.hidden) return;
        ucitajTroskovePopisa(true);
      }, AUTO_PROJEKTI_MS);
    }

    var potrosnjaBtn = document.getElementById('potrosnja-refresh-btn');
    if (potrosnjaBtn) {
      potrosnjaBtn.addEventListener('click', function () { ucitajPotrosnju({ force: true }); });
    }
    var potrosnjaSelect = document.getElementById('potrosnja-dana');
    if (potrosnjaSelect) {
      potrosnjaSelect.addEventListener('change', function () { ucitajPotrosnju({}); });
    }

    // ========================================================================
    // TASK-3572 (T8) — „Potrošnja projekta": isti pregled, sužen na jedan projekt.
    //
    // Dva mjesta, jedan izvor: odjeljak u panelu detalja projekta
    // (GET /api/pregled/projekt/:id) i mala brojka troška na kartici u popisu
    // (GET /api/pregled/tjedni → poProjektu, jedan poziv za sve kartice).
    // Vrijede ista pravila kao T4/T5: 202 „racuna" nije pogreška, uz svaku
    // agregaciju piše iz koliko je izvođenja izračunata, nedostajuće je „—".
    // ========================================================================
    var POPIS_TROSAK_DANA = 30;          // prozor koji se prikazuje u opisu chipa
    var popisTrosakOsvjezen = null;      // TASK-3691: kad je brojka zadnji put stvarno stigla
    var popisVrijednost = null;          // TASK-3691: vrijednost upita (cjenik S1–S6) po projektu
    var POPIS_TROSAK_TTL_MS = 5 * 60000; // isto kao keš poslužitelja — bez bujice zahtjeva
    var projektPotrosnjaGen = 0;
    var projektPotrosnjaTimer = null;
    var popisTrosak = null;              // { PRJ-x: {usd, izZadataka, zadataka} }
    var popisTrosakTs = 0;
    var popisTrosakUTijeku = false;

    // R4/TASK-4311: broj RAG dokumenata po projektu (/api/rag/projects).
    // Znanje i trošak stoje na ISTOJ kartici — inače se ne vidi da projekt s
    // najvećim troškom (PRJ-041) nema nijedan dokument.
    var ragBrojDokumenata = null;        // { PRJ-x: broj }
    var ragBrojUkupno = null;            // { total, withProject }
    var ragBrojTs = 0;
    var ragBrojUTijeku = false;
    var RAG_BROJ_TTL_MS = 120000;

    function projPostavi(html) {
      var box = document.getElementById('projekt-potrosnja-box');
      if (box) box.innerHTML = html;
    }

    /** Popuni odjeljak „Tko je radio" u panelu projekta (vrijednost po cjeniku S1–S6). */
    async function projOsobe(projectId) {
      var el = document.getElementById('projekt-osobe');
      if (!el) return;
      try {
        var r = await fetch('/api/vrijednost-inputa');
        var d = await r.json();
        var v = d && d.poProjektu && d.poProjektu[projectId];
        if (!v || !v.poKorisniku || !Object.keys(v.poKorisniku).length) {
          el.innerHTML = '<div class="tel-sec-title">' + _T('prj_tko_je_radio', 'Tko je radio') + '</div>'
            + '<div class="tel-muted">' + _T('prj_nema_upita', 'Nema zabilježenih korisničkih upita za ovaj projekt.') + '</div>';
          return;
        }
        var k = Object.keys(v.poKorisniku);
        k.sort(function (a, b) { return v.poKorisniku[b].eur - v.poKorisniku[a].eur; });
        var html = '<div class="tel-sec-title">' + _T('prj_tko_je_radio', 'Tko je radio') + '</div><div class="tel-grid">';
        k.forEach(function (ime) {
          var o = v.poKorisniku[ime];
          var udio = v.eur ? Math.round(1000 * o.eur / v.eur) / 10 : 0;
          html += telCelija(telBroj(o.eur, 2) + ' €',
            telEsc(ime) + ' · ' + _Tv('vr_n_upita', '{broj} upita', { broj: o.upita })
            + ' · ' + String(udio).replace('.', ',') + ' %');
        });
        html += '</div><div class="tel-muted" style="font-size:0.72rem;margin-top:0.3rem;">'
          + _T('prj_vrijednost_opis', 'Vrijednost po cjeniku S1–S6 (procjena isporučenog rada), ne trošak modela.') + '</div>';
        el.innerHTML = html;
      } catch (e) {
        el.innerHTML = '<div class="tel-sec-title">' + _T('prj_tko_je_radio', 'Tko je radio') + '</div>'
          + '<div class="tel-muted">' + _T('podatak_nedostupan', 'Podatak trenutačno nije dostupan.') + '</div>';
      }
    }

    function projIznos(usd) {
      return eur(usd);
    }

    /** Odjeljak „Potrošnja projekta" — ukupno, latencija, trajanje, alati, najskuplji. */
    function projHtml(data) {
      var p = data && data.pregled;
      if (!p) return '<span class="tel-muted">' + _T('pot_nema_pregleda', 'Nema pregleda.') + '</span>';
      var u = p.ukupno, izv = p.izvor || {};
      var razdoblje = p.dana >= 3650
        ? _T('svo_vrijeme', 'svo vrijeme')
        : _Tv('pot_zadnjih_n_dana', 'zadnjih {dana} dana', { dana: telBroj(p.dana, 0) });

      if (!u || !u.zadataka) {
        return '<span class="tel-muted">'
          + _Tv('prj_nema_izvodjenja', 'Za {razdoblje} ovaj projekt nema nijedno zabilježeno izvođenje (razdoblje ih ukupno ima {ukupno}).',
                { razdoblje: telEsc(razdoblje), ukupno: telBroj(izv.izvodjenjaPrijeFiltra, 0) })
          + '</span>';
      }

      var html = '<div class="tel-head"><b>' + telEsc(razdoblje) + '</b>'
        + '<span class="tel-muted">' + telEsc((p.od || '').slice(0, 10)) + ' &rarr; '
        + telEsc((p.do || '').slice(0, 10)) + '</span>'
        + '<span class="tel-muted">&middot; '
        + _Tv('prj_n_izvodjenja', '{izvodjenja} izvođenja ({zadataka} različitih zadataka, od {uRazdoblju} u razdoblju)',
              { izvodjenja: telBroj(u.zadataka, 0), zadataka: telBroj(u.razlicitihZadataka, 0),
                uRazdoblju: telBroj(izv.izvodjenjaPrijeFiltra, 0) })
        + '</span>'
        + '<span class="tel-muted">&middot; ' + _Tv('pot_s_transkriptom', 's transkriptom {broj}', { broj: telBroj(u.sTranskriptom, 0) }) + '</span>'
        + '</div>';
      if (data.poruka) {
        html += '<div class="tel-muted" style="margin-bottom:0.4rem;">' + telEsc(data.poruka) + '</div>';
      }

      // Goran, 04.09.2026.: „kada otvorim projekt ne vidi se koliko je od ljudi tko radio …
      // kod pregleda projekta piše sada ukupno, ali trebalo bi dodati po osobama."
      // Vrijednost po osobama dolazi iz drugog izvora (cjenik S1–S6 nad transkriptima),
      // pa se puni asinkrono i ne zadržava crtanje ostatka panela.
      html += '<div class="tel-sec" id="projekt-osobe"><div class="tel-sec-title">' + _T('prj_tko_je_radio', 'Tko je radio') + '</div>'
        + '<div class="tel-muted">' + _T('ucitavam', 'učitavam…') + '</div></div>';

      // Ukupno — svaka ćelija nosi svoj nazivnik
      html += '<div class="tel-sec"><div class="tel-sec-title">' + _T('ukupno', 'Ukupno') + '</div><div class="tel-grid">'
        + telCelija(projIznos(u.trosak.usd), _T('trosak', 'trošak') + ' · ' + _Tv('iz_n', 'iz {broj}', { broj: u.trosak.izZadataka }))
        + telCelija(projIznos(u.trosak.usdPoZadatku), _T('po_izvodjenju', 'po izvođenju'))
        + telCelija(telBroj(u.tokeni.ulazniKontekst, 0), _T('ulazni_kontekst', 'ulazni kontekst') + ' · ' + _Tv('iz_n', 'iz {broj}', { broj: u.tokeni.izZadataka }))
        + telCelija(telBroj(u.tokeni.izlaz, 0), _T('izlazni_tokeni', 'izlazni tokeni') + ' · ' + _Tv('iz_n', 'iz {broj}', { broj: u.tokeni.izZadataka }))
        + telCelija(telPostotak(u.tokeni.udioKesa), _T('udio_kesa', 'udio keša') + ' · ' + _Tv('iz_n', 'iz {broj}', { broj: u.tokeni.izZadataka }))
        + telCelija(telBroj(u.zadataka, 0), _T('izvodjenja', 'izvođenja'))
        // ADR-0010 (P2): energija stoji UZ trošak, ali je procjena i dolazi iz drugog izvora
        // (cost_log, ne run_log) — zato vlastiti nazivnik i riječ „procjena" u vidljivoj oznaci.
        + (data.energija && data.energija.izTokena
            ? telCelija('<span class="tel-energija" title="' + telEsc(energijaOpis(data.energija)) + '">&asymp; '
                        + energijaTekst(data.energija.wh) + '</span>',
                        _T('energija_procjena_oznaka', 'procjena struje (nije mjereno)') + ' · '
                        + _T('energija_raspon', 'raspon') + ' ' + energijaTekst(data.energija.donja)
                        + '–' + energijaTekst(data.energija.gornja) + ' · '
                        + _Tv('iz_n', 'iz {broj}', { broj: data.energija.izTokena }))
            : telCelija('&mdash;', _T('energija_procjena_oznaka', 'procjena struje (nije mjereno)')))
        // ADR-0011 (P2): CO₂ i voda su ISTA energija × jedan množitelj — stoje uz nju, ali
        // svaka nosi vlastiti pojas u vidljivoj oznaci. Voda dodatno riječ „gruba" i znak ⚠.
        + (data.energija && data.energija.co2
            ? telCelija('<span class="tel-energija" title="' + telEsc(co2Opis(data.energija.co2)) + '">&asymp; '
                        + co2Tekst(data.energija.co2.kg) + '</span>',
                        _T('co2_procjena_oznaka', 'procjena CO₂ (nije mjereno)') + ' · '
                        + _T('energija_raspon', 'raspon') + ' ' + co2Tekst(data.energija.co2.donja)
                        + '–' + co2Tekst(data.energija.co2.gornja))
            : telCelija('&mdash;', _T('co2_procjena_oznaka', 'procjena CO₂ (nije mjereno)')))
        + (data.energija && data.energija.voda
            ? telCelija('<span class="tel-voda" title="' + telEsc(vodaOpis(data.energija.voda)) + '">&#9888; &asymp; '
                        + vodaTekst(data.energija.voda.l) + '</span>',
                        _T('voda_procjena_oznaka', 'GRUBA procjena vode (nije mjereno)') + ' · '
                        + _T('energija_raspon', 'raspon') + ' ' + vodaTekst(data.energija.voda.donja)
                        + '–' + vodaTekst(data.energija.voda.gornja))
            : telCelija('&mdash;', _T('voda_procjena_oznaka', 'GRUBA procjena vode (nije mjereno)')))
        + '</div></div>';

      // Latencija — prosjek i medijan traženi izrijekom
      html += potIshodiOdjeljak(u);

      html += '<div class="tel-sec"><div class="tel-sec-title">'
        + _Tv('pot_latencija_naslov', 'Latencija modela — iz {izvodjenja} izvođenja, {poziva} poziva',
              { izvodjenja: telBroj(u.latencija.izZadataka, 0), poziva: telBroj(u.latencija.izPoziva, 0) })
        + '</div><div class="tel-grid">'
        + telCelija((u.latencija.prosjekS === null ? '—' : telBroj(u.latencija.prosjekS, 1) + ' s'), _T('tel_prosjek', 'prosjek'))
        + telCelija((u.latencija.medijanS === null ? '—' : telBroj(u.latencija.medijanS, 1) + ' s'), _T('tel_medijan', 'medijan'))
        + telCelija((u.latencija.p95S === null ? '—' : telBroj(u.latencija.p95S, 1) + ' s'), 'p95')
        + telCelija((u.latencija.najvecaS === null ? '—' : telBroj(u.latencija.najvecaS, 1) + ' s'), _T('tel_najveca', 'najveća'))
        + '</div></div>';

      // Razlaganje trajanja (model / alati) — traka kao na kartici zadatka
      var tr = u.trajanje;
      var sirina = function (x) { return Math.max(0, Math.round((x || 0) * 1000) / 10); };
      html += '<div class="tel-sec"><div class="tel-sec-title">'
        + _Tv('prj_razlaganje_trajanja', 'Razlaganje trajanja — ukupno {trajanje} (iz {broj} izvođenja)',
              { trajanje: telTrajanje(tr.ukupnoS), broj: telBroj(tr.izZadataka, 0) })
        + '</div>'
        + '<div class="tel-bar">'
        + '<span class="tel-seg-model" style="width:' + sirina(tr.udioModel) + '%"></span>'
        + '<span class="tel-seg-alat" style="width:' + sirina(tr.udioAlat) + '%"></span>'
        + '</div>'
        + '<div class="tel-legend">'
        + '<span><i class="tel-seg-model"></i>' + _T('tel_model', 'model') + ' ' + telTrajanje(tr.modelS) + ' (' + telPostotak(tr.udioModel) + ')</span>'
        + '<span><i class="tel-seg-alat"></i>' + _T('tel_alati', 'alati') + ' ' + telTrajanje(tr.alatS) + ' (' + telPostotak(tr.udioAlat) + ')</span>'
        + '</div></div>';

      // Alati i trenje
      var vrh = (u.alati.vrh || []).map(function (t) {
        return telEsc(t.ime) + ' ' + telBroj(t.poziva, 0);
      }).join(' &middot; ') || '—';
      html += '<div class="tel-sec"><div class="tel-sec-title">'
        + _Tv('pot_alati_trenje_naslov', 'Alati i trenje — iz {broj} izvođenja', { broj: telBroj(u.alati.izZadataka, 0) })
        + '</div>'
        + '<div>' + _Tv('pot_poziva_neuspjelih', '{poziva} poziva, neuspjelih {neuspjelih} ({udio})',
              { poziva: telBroj(u.alati.poziva, 0), neuspjelih: telBroj(u.alati.neuspjelih, 0), udio: telPostotak(u.alati.udioNeuspjelih) })
        + ' &middot; ' + vrh + '</div>'
        + '<div class="tel-muted" style="margin-top:0.2rem;">'
        + _Tv('pot_trenje_sazetak', 'trenje: {sTrenjem} izvođenja s trenjem (mjereno na {mjereno}) · izgubljeno do {izgubljeno}',
              { sTrenjem: telBroj(u.trenje.zadatakaSTrenjem, 0), mjereno: telBroj(u.trenje.izZadataka, 0),
                izgubljeno: telTrajanje(u.trenje.izgubljenoS) })
        + '</div></div>';

      // Po agentu unutar projekta — tko je potrošio
      if (p.poAgentu && p.poAgentu.length) {
        html += potTablica(_T('prj_po_agentu', 'Po agentu u ovom projektu'), p.poAgentu, false);
      }

      // Pet najskupljih zadataka TOG projekta
      if (p.najskuplji && p.najskuplji.length) {
        html += '<div class="tel-sec"><div class="tel-sec-title">'
          + _Tv('prj_najskupljih', 'Najskupljih {broj} zadataka', { broj: p.najskuplji.length })
          + '</div><table class="tel-table"><thead><tr>'
          + '<th>' + _T('st_zadatak', 'zadatak') + '</th><th>' + _T('st_agent', 'agent') + '</th>'
          + '<th>' + _T('trosak', 'trošak') + '</th><th>' + _T('tel_st_trajanje', 'trajanje') + '</th>'
          + '<th>' + _T('tel_poziva', 'poziva') + '</th><th>' + _T('st_kes', 'keš') + '</th>'
          + '<th>' + _T('energija_stupac', '≈ struja (procjena)') + '</th></tr></thead><tbody>';
        var ePoZad = data.energijaPoZadatku || {};
        // ADR-0011 §4.1 (P3): CO₂ i voda NEMAJU vlastiti stupac — one su ista brojka × konstanta
        // (§1), pa bi tri stupca utrostručila vizualnu težinu jednog podatka. Idu u tooltip
        // stupca struje, a dijagnostička uloga stupca (razilaženje >1,5×) ostaje na struji.
        // Faktor i WUE dolaze s poslužitelja — klijent nema vlastitu kopiju konstanti.
        var co2Faktor = (data.energija && data.energija.co2) ? data.energija.co2.faktor : null;
        var vodaWue = (data.energija && data.energija.voda) ? data.energija.voda.wue : null;
        for (var j = 0; j < p.najskuplji.length; j++) {
          var z = p.najskuplji[j];
          // ADR §11.2: ova brojka NIJE drugo mjerilo skupoće — ona je 130 × cjenički trošak.
          // Korisna je dijagnostički: kad se razilazi od prikazanog troška više od 1,5 ×,
          // knjigovodstvo troška i knjigovodstvo tokena za taj redak ne govore istu priču.
          var eWh = ePoZad[z.taskId];
          var eCelija = '<span class="tel-muted">&mdash;</span>';
          if (eWh !== null && eWh !== undefined && isFinite(eWh)) {
            var ocekivano = 130 * (z.trosakUsd || 0);
            var razilazi = ocekivano > 0 && (eWh / ocekivano > 1.5 || ocekivano / eWh > 1.5);
            eCelija = '<span title="' + telEsc(_T('energija_naslov', 'procjena potrošnje struje iz tokena — NIJE izmjereno')
              + ' — ' + energijaTekst(eWh / 3) + ' – ' + energijaTekst(eWh * 3) + ' (÷3…×3)'
              + (co2Faktor !== null ? '; ≈ ' + co2Tekst(eWh / 1000 * co2Faktor) + ' (÷4…×4)' : '')
              + (vodaWue !== null ? '; ≈ ' + vodaTekst(eWh / 1000 * vodaWue) + ' '
                  + _T('voda_gruba_kratko', 'vode — GRUBA procjena (÷10…×6)') : '')
              + (razilazi ? '; ' + _T('energija_razilazi', 'zabilježeni trošak i tokeni ovog retka se razilaze više od 1,5× — provjeriti zapis') : '')) + '">'
              + '&asymp; ' + energijaTekst(eWh) + (razilazi ? ' &#9888;' : '') + '</span>';
          }
          html += '<tr><td><b>' + telEsc(z.taskId) + '</b>'
            + (z.naslov ? '<br><span class="tel-muted" style="font-size:0.68rem;">' + telEsc(z.naslov.slice(0, 60)) + '</span>' : '')
            + '</td><td>' + telEsc(z.agent) + '</td>'
            + '<td>' + projIznos(z.trosakUsd) + '</td>'
            + '<td>' + telTrajanje(z.trajanjeS) + '</td>'
            + '<td>' + telBroj(z.pozivaModela, 0) + '</td>'
            + '<td>' + telPostotak(z.udioKesa) + '</td>'
            + '<td>' + eCelija + '</td></tr>';
        }
        html += '</tbody></table></div>';
      }

      // Izvor i upozorenja — bez toga se brojke ne mogu provjeriti
      html += '<div class="tel-sec"><div class="tel-sec-title">' + _T('pot_izvor', 'Izvor') + '</div>'
        + '<div class="tel-muted">' + telEsc(izv.runLog || 'run_log.jsonl') + ' &middot; '
        + _Tv('prj_izvor_opis', '{uRazdoblju} izvođenja ovog projekta (od {prijeFiltra} u razdoblju, {ukupno} ukupno) · iz keša {izKesa}, izračunato sada {sada}',
              { uRazdoblju: telBroj(izv.izvodjenjaURazdoblju, 0), prijeFiltra: telBroj(izv.izvodjenjaPrijeFiltra, 0),
                ukupno: telBroj(izv.runLogRedakaUkupno, 0), izKesa: telBroj(izv.izKesa, 0),
                sada: telBroj(izv.izracunatoSada, 0) })
        + '</div>';
      if (p.upozorenja && p.upozorenja.length) {
        html += '<ul class="tel-muted" style="margin:0.3rem 0 0 1rem;padding:0;">';
        for (var w = 0; w < p.upozorenja.length; w++) html += '<li>' + telEsc(p.upozorenja[w]) + '</li>';
        html += '</ul>';
      }
      html += '</div>';
      return html;
    }

    async function ucitajPotrosnjuProjekta(projectId, opts) {
      opts = opts || {};
      var gen = ++projektPotrosnjaGen;
      if (projektPotrosnjaTimer) { clearTimeout(projektPotrosnjaTimer); projektPotrosnjaTimer = null; }
      if (!projectId) { projPostavi('<span class="tel-muted">&mdash;</span>'); return; }
      var izbor = document.getElementById('projekt-potrosnja-dana');
      var dana = izbor ? izbor.value : '30';
      var info = document.getElementById('projekt-potrosnja-izvor');
      projPostavi('<span class="tel-muted">' + _T('ucitavam_potrosnju', 'Učitavam potrošnju…') + '</span>');
      if (info) info.textContent = '—';
      var pokusaj = 0;

      async function korak() {
        // Panel je u međuvremenu zatvoren ili otvoren drugi projekt — odgovor se odbacuje.
        if (gen !== projektPotrosnjaGen || selectedProjectId !== projectId) return;
        try {
          var putanja = '/api/pregled/projekt/' + encodeURIComponent(projectId)
            + '?dana=' + encodeURIComponent(dana)
            + (opts.force && pokusaj === 0 ? '&force=1' : '');
          var res = await fetch(putanja);
          var data = null;
          try { data = await res.json(); } catch (e) { data = null; }
          if (gen !== projektPotrosnjaGen || selectedProjectId !== projectId) return;

          if (res.status === 202) {
            pokusaj++;
            if (pokusaj > 12) {
              projPostavi('<span class="tel-muted">' + _T('izracun_dulje', 'Izračun traje dulje nego obično — pokušajte „Osvježi".') + '</span>');
              return;
            }
            projPostavi('<span class="tel-muted">' + _Tv('prj_racuna_se', 'Potrošnja se računa… ({pokusaj}/12)', { pokusaj: pokusaj }) + '</span>');
            projektPotrosnjaTimer = setTimeout(korak, 1500);
            return;
          }
          if (!res.ok || !data || data.stanje === 'greska') {
            var zasto = data && data.poruka ? ': ' + telEsc(data.poruka) : '.';
            projPostavi('<span class="tel-muted">' + _T('prj_nedostupna', 'Potrošnja trenutačno nije dostupna') + zasto + '</span>');
            return;
          }
          projPostavi(projHtml(data));
          projOsobe(projectId);
          if (info) {
            info.textContent = (data.izvor === 'kes' ? _T('iz_kesa', 'iz keša') : _T('svjez_izracun', 'svjež izračun'))
              + (data.staroS ? ' · ' + _Tv('star_n_s', 'star {broj} s', { broj: data.staroS }) : '');
          }
        } catch (err) {
          if (gen !== projektPotrosnjaGen) return;
          projPostavi('<span class="tel-muted">' + _T('prj_nedostupna', 'Potrošnja trenutačno nije dostupna') + '.</span>');
        }
      }

      korak();
    }

    var projektPotrosnjaBtn = document.getElementById('projekt-potrosnja-refresh-btn');
    if (projektPotrosnjaBtn) {
      projektPotrosnjaBtn.addEventListener('click', function () {
        ucitajPotrosnjuProjekta(selectedProjectId, { force: true });
      });
    }
    var projektPotrosnjaSelect = document.getElementById('projekt-potrosnja-dana');
    if (projektPotrosnjaSelect) {
      projektPotrosnjaSelect.addEventListener('change', function () {
        ucitajPotrosnjuProjekta(selectedProjectId, {});
      });
    }

    /**
     * Trošak SVIH projekata u zadanom razdoblju, jednim pozivom tjednog pregleda.
     * Kartica projekta ne smije zvati svoj izračun — 30 kartica značilo bi 30
     * procesa. Dok brojka ne stigne, na kartici piše „…", a ne izmišljena nula.
     */
    async function ucitajTroskovePopisa(force) {
      var sad = Date.now();
      if (popisTrosakUTijeku) return;
      if (!force && popisTrosak && (sad - popisTrosakTs) < POPIS_TROSAK_TTL_MS) return;
      popisTrosakUTijeku = true;
      try {
        // TASK-3691: izvor je /api/projects/trosak (cost_log, UKUPNO po projektu), a ne
        // tjedni pregled u prozoru od 30 dana. Projekt na kojem se radilo prije prozora
        // više ne pokazuje „—", a upit je SQL pa nema 202 „računa se" ni pokretanja pythona.
        var res = await fetch('/api/projects/trosak');
        if (!res.ok) return;
        var data = await res.json();
        var po = data && data.poProjektu;
        if (!po) return;
        var mapa = {};
        for (var pid in po) {
          if (!Object.prototype.hasOwnProperty.call(po, pid)) continue;
          mapa[pid] = {
            usd: po[pid].usdUkupno,
            usd30: po[pid].usd30,
            izZadataka: po[pid].zapisaUkupno,
            zadataka: po[pid].zapisa30,
            zadnji: po[pid].zadnji,
            prviZadatak: po[pid].prviZadatak,
            zadnjiZadatak: po[pid].zadnjiZadatak,
            energija: po[pid].energija || null
          };
        }
        popisTrosak = mapa;
        popisTrosakTs = Date.now();
        popisTrosakOsvjezen = new Date();
        renderProjects();
        // Vrijednost po cjeniku S1–S6 dolazi iz drugog izvora (transkripti, ne cost_log),
        // pa se dohvaća zasebno i ne smije zadržati crtanje popisa ako izračun traje.
        fetch('/api/vrijednost-inputa').then(function (r) { return r.json(); }).then(function (d) {
          if (d && d.poProjektu) { popisVrijednost = d.poProjektu; renderProjects(); }
        }).catch(function () { /* vrijednost je dodatak; njezin izostanak ne ruši popis */ });
        return;
      } catch (err) {
        // Brojka troška je dodatak; njezin izostanak ne smije srušiti popis projekata.
      } finally {
        popisTrosakUTijeku = false;
      }
    }

    /** Kućica troška na kartici projekta: „…" dok se računa, „—" kad nema mjerenja. */
    function projectVrijednostChip(projectId) {
      // Vrijednost isporučenog rada po Goranovu cjeniku S1–S6 — NIJE trošak modela.
      // Dvije brojke stoje jedna uz drugu na kartici i namjerno se ne zbrajaju.
      var naslov = _T('chip_vrijednost_naslov', 'vrijednost korisničkih upita po cjeniku S1–S6 (procjena isporučenog rada, ne trošak modela)');
      if (!popisVrijednost) {
        return '<span class="project-count c-vrijednost is-racuna" title="' + _esc(naslov + ' — ' + _T('chip_racuna_se', 'računa se')) + '">&#8721; <b>&hellip;</b></span>';
      }
      var v = popisVrijednost[projectId];
      if (!v) {
        return '<span class="project-count c-vrijednost is-prazna" title="' + _esc(naslov + ' — ' + _T('chip_nema_upita', 'nema upita')) + '">&#8721; <b>&mdash;</b></span>';
      }
      var razredi = Object.keys(v.razredi || {}).sort().map(function (r) { return r + ':' + v.razredi[r]; }).join(' ');
      return '<span class="project-count c-vrijednost" title="'
        + telEsc(naslov + ' — ' + _Tv('vr_n_upita', '{broj} upita', { broj: v.upita })
                 + ' · ' + razredi + '; ' + osobeOpis(v.poKorisniku)) + '">'
        + '&#8721; ' + telBroj(v.eur, 2) + ' €</span>';
    }

    function projectTrosakChip(projectId) {
      var naslov = _T('chip_trosak_naslov', 'ukupna potrošnja projekta (cost_log: agentski spawnovi + uvezeni telegramski zahtjevi)');
      if (!popisTrosak) {
        return '<span class="project-count c-trosak is-racuna" title="' + _esc(naslov + ' — ' + _T('chip_ucitava_se', 'učitava se')) + '">&euro; <b>&hellip;</b></span>';
      }
      var z = popisTrosak[projectId];
      if (!z || z.usd === null || z.usd === undefined) {
        return '<span class="project-count c-trosak is-prazna" title="' + _esc(naslov + ' — ' + _T('chip_nema_izvodjenja', 'nema nijednog zabilježenog izvođenja')) + '">&euro; <b>&mdash;</b></span>';
      }
      var opis = naslov + ' — ' + _Tv('iz_n_izvodjenja', 'iz {broj} izvođenja', { broj: z.izZadataka })
        + (z.usd30 !== null && z.usd30 !== undefined
            ? '; ' + _Tv('chip_zadnjih_30', 'zadnjih 30 dana {iznos} € iz {broj} izvođenja',
                         { iznos: telBroj(z.usd30 * (TECAJ.tecaj || 0), 2), broj: z.zadataka })
            : '; ' + _T('chip_30_nista', 'u zadnjih 30 dana ništa'))
        + (z.zadnji ? '; ' + _Tv('chip_zadnje_izvodjenje', 'zadnje izvođenje {kada}', { kada: z.zadnji }) : '');
      return '<span class="project-count c-trosak" title="' + telEsc(opis) + '">' + eur(z.usd) + '</span>';
    }

    /**
     * Broj RAG dokumenata SVIH projekata jednim pozivom (R4, TASK-4311).
     * Poslužitelj vraća i nule za projekte s ploče kojih u Chromi nema — upravo
     * ta nula je nalaz (znanje ne postoji iako je trošak potrošen).
     */
    async function ucitajRagBrojeve(force) {
      var sad = Date.now();
      if (ragBrojUTijeku) return;
      if (!force && ragBrojDokumenata && (sad - ragBrojTs) < RAG_BROJ_TTL_MS) return;
      ragBrojUTijeku = true;
      try {
        var res = await fetch('/api/rag/projects' + (force ? '?refresh=1' : ''));
        if (!res.ok) return;
        var data = await res.json();
        if (!data || !data.counts) return;
        ragBrojDokumenata = data.counts;
        ragBrojUkupno = { total: data.total, withProject: data.withProject };
        ragBrojTs = Date.now();
        renderProjects();
        popuniRagProjectFilter();
      } catch (err) {
        // Brojka dokumenata je dodatak; njezin izostanak ne ruši popis projekata.
      } finally {
        ragBrojUTijeku = false;
      }
    }

    /** Kućica „dokumenata" na kartici projekta: „…" dok se učitava, 0 kad ih nema. */
    /**
     * Procjena potrosnje struje (ADR-0010). CETIRI obavezna znaka da je rijec o procjeni:
     * (1) znak ≈ ispred svake brojke, (2) vlastita zuta boja, (3) rijec „procjena" u
     * vidljivom tekstu panela, (4) tooltip s metodom, rasponom i nazivnikom.
     * Nemjereno je crtica, nikad 0 — redak bez tokena ne smije izgledati kao izmjerena nula.
     */
    function energijaTekst(wh) {
      if (wh === null || wh === undefined || !isFinite(wh)) return '&mdash;';
      if (wh >= 1000) return telBroj(wh / 1000, wh >= 100000 ? 0 : 1) + ' kWh';
      return telBroj(wh, 0) + ' Wh';
    }

    function energijaOpis(e) {
      if (!e) return '';
      return _T('energija_naslov', 'procjena potrošnje struje iz tokena — NIJE izmjereno')
        + ' — ' + _T('energija_raspon', 'raspon') + ' ' + energijaTekst(e.donja)
        + ' – ' + energijaTekst(e.gornja) + ' (÷3…×3); '
        + _T('energija_metoda', 'metoda Epoch AI + omjeri Anthropicova cjenika') + ' (' + e.metoda + '); '
        + _Tv('iz_n_izvodjenja', 'iz {broj} izvođenja', { broj: e.izTokena })
        + (e.modelNepoznat ? '; ' + _Tv('energija_nepoznat_model', '{broj} izvođenja nepoznatog razreda modela (množitelj 1)', { broj: e.modelNepoznat }) : '');
    }

    /**
     * ADR-0011: CO2 i voda su JEDAN mnozitelj nad istim Wh — nijedna od njih ne nosi ni jedan
     * bit koji energija (a preko nje i €) vec nema. Zato dijele zutu boju i znak ≈, a faktor
     * i WUE dolaze s posluzitelja (e.co2.faktor, e.voda.wue) — klijent NEMA vlastitu
     * kopiju konstanti, inace bi se dva popisa razisla.
     * ZAMKA: ovaj komentar zivi UNUTAR template literala s HTML-om ploce — obrnuta
     * kosa crta i backtick ovdje rusе CIJELU plocu, a build to prijavi tek kao
     * „Unexpected ." desetak redaka dalje.
     */
    /* ZAMKA (uhvacena na sjeni 17791): ove dvije funkcije pune I tijelo HTML-a I atribut
       title=. HTML entiteti (&#8322;, &sup3;, &mdash;) u atributu se NE razrjesuju — tooltip
       bi doslovno pisao „kg CO&#8322;e". Zato doslovni UTF-8 znakovi, koji rade u oba
       konteksta; stranica je UTF-8 i ostatak koda ih vec koristi. */
    function co2Tekst(kg) {
      if (kg === null || kg === undefined || !isFinite(kg)) return '—';
      if (kg >= 1000) return telBroj(kg / 1000, 1) + ' t CO₂e';
      if (kg < 1) return telBroj(kg * 1000, 0) + ' g CO₂e';
      return telBroj(kg, kg >= 100 ? 0 : 1) + ' kg CO₂e';
    }

    function vodaTekst(l) {
      if (l === null || l === undefined || !isFinite(l)) return '—';
      if (l >= 10000) return telBroj(l / 1000, 1) + ' m³';
      return telBroj(l, l >= 100 ? 0 : 1) + ' L';
    }

    function co2Opis(c) {
      if (!c) return '';
      return _T('co2_naslov', 'procjena CO₂ iz procijenjene struje — NIJE izmjereno')
        + ' — ' + _T('energija_raspon', 'raspon') + ' ' + co2Tekst(c.donja)
        + ' – ' + co2Tekst(c.gornja) + ' (÷4…×4); '
        + _Tv('co2_faktor', 'faktor mreže {faktor} kg CO₂e/kWh (EU-27, EEA)', { faktor: telBroj(c.faktor, 3) }) + '; '
        + _T('co2_ograda', 'modeli se NE vrte na EU mreži nego u SAD-u (~0,37 kg/kWh, do 1,8× više) — ovo je pretvorba u razumljivu jedinicu, ne obračun stvarnog pogona');
    }

    function vodaOpis(v) {
      if (!v) return '';
      return _T('voda_naslov', 'NAJNESIGURNIJA od tri procjene — gruba procjena vode iz procijenjene struje, NIJE izmjereno')
        + ' — ' + _T('energija_raspon', 'raspon') + ' ' + vodaTekst(v.donja)
        + ' – ' + vodaTekst(v.gornja) + ' (÷10…×6); '
        + _Tv('voda_wue', 'WUE {wue} L/kWh (Google, izmjereno u produkciji, arXiv 2508.15734)', { wue: telBroj(v.wue, 2) }) + '; '
        + _T('voda_ograda', 'objavljene vrijednosti idu 0,12–5,3 L/kWh (~50×): WUE broji SAMO vodu na licu mjesta, a proizvodnja te struje troši još 3–5 L/kWh; lokacija i način hlađenja mijenjaju brojku >10×');
    }

    function projectCo2Chip(projectId) {
      var naslov = _T('chip_co2_naslov', 'procjena CO₂ iz procijenjene struje — procjena, ne mjerenje');
      if (!popisTrosak) {
        return '<span class="project-count c-co2 is-racuna" title="' + _esc(naslov + ' — ' + _T('chip_ucitava_se', 'učitava se')) + '">CO&#8322; <b>&hellip;</b></span>';
      }
      var z = popisTrosak[projectId];
      var c = z && z.energija && z.energija.co2;
      if (!c) {
        return '<span class="project-count c-co2 is-prazna" title="' + _esc(naslov + ' — ' + _T('chip_energija_nemjereno', 'nijedno izvođenje ovog projekta nema zapisane tokene')) + '">CO&#8322; <b>&mdash;</b></span>';
      }
      return '<span class="project-count c-co2" title="' + telEsc(co2Opis(c)) + '">'
        + '&asymp; <b>' + co2Tekst(c.kg) + '</b></span>';
    }

    function projectVodaChip(projectId) {
      var naslov = _T('chip_voda_naslov', 'GRUBA procjena vode iz procijenjene struje — najnesigurnija od tri brojke');
      if (!popisTrosak) {
        return '<span class="project-count c-voda is-racuna" title="' + _esc(naslov + ' — ' + _T('chip_ucitava_se', 'učitava se')) + '">H&#8322;O <b>&hellip;</b></span>';
      }
      var z = popisTrosak[projectId];
      var v = z && z.energija && z.energija.voda;
      if (!v) {
        return '<span class="project-count c-voda is-prazna" title="' + _esc(naslov + ' — ' + _T('chip_energija_nemjereno', 'nijedno izvođenje ovog projekta nema zapisane tokene')) + '">H&#8322;O <b>&mdash;</b></span>';
      }
      // Znak ⚠ stoji U CIPU, ne samo u tooltipu: jaci raspon mora biti vidljiv bez hovera.
      return '<span class="project-count c-voda" title="' + telEsc(vodaOpis(v)) + '">'
        + 'H&#8322;O &#9888; &asymp; <b>' + vodaTekst(v.l) + '</b></span>';
    }

    function projectEnergijaChip(projectId) {
      var naslov = _T('chip_energija_naslov', 'procjena potrošnje struje iz tokena (cost_log) — procjena, ne mjerenje');
      if (!popisTrosak) {
        return '<span class="project-count c-energija is-racuna" title="' + _esc(naslov + ' — ' + _T('chip_ucitava_se', 'učitava se')) + '">&#9889; <b>&hellip;</b></span>';
      }
      var z = popisTrosak[projectId];
      var e = z && z.energija;
      if (!e || !e.izTokena) {
        return '<span class="project-count c-energija is-prazna" title="' + _esc(naslov + ' — ' + _T('chip_energija_nemjereno', 'nijedno izvođenje ovog projekta nema zapisane tokene')) + '">&#9889; <b>&mdash;</b></span>';
      }
      return '<span class="project-count c-energija" title="' + telEsc(energijaOpis(e)) + '">'
        + '&#9889; &asymp; <b>' + energijaTekst(e.wh) + '</b></span>';
    }

    function projectRagChip(projectId) {
      var naslov = _Tv('chip_rag_naslov', 'RAG dokumenata s project_id = {id}', { id: projectId });
      if (!ragBrojDokumenata) {
        return '<span class="project-count c-rag is-racuna" title="' + _esc(naslov + ' — ' + _T('chip_ucitava_se', 'učitava se')) + '">'
          + _T('chip_dokumenata', 'dokumenata') + ' <b>&hellip;</b></span>';
      }
      var n = Number(ragBrojDokumenata[projectId]) || 0;
      var opis = n === 0
        ? naslov + ' — ' + _T('chip_rag_nijedan', 'NIJEDAN dokument nije pripisan ovom projektu')
        : naslov;
      return '<span class="project-count c-rag' + (n === 0 ? ' is-zero' : '') + '" title="'
        + telEsc(opis) + '">' + _T('chip_dokumenata', 'dokumenata') + ' <b>' + n + '</b></span>';
    }

    // Add progress note
    // TASK-5013: uputa agentu iz detalja zadatka
    document.getElementById('dodaj-uputu-btn').addEventListener('click', async () => {
      if (!selectedTaskId) return;
      const polje = document.getElementById('detail-nova-uputa');
      if (await posaljiUputu(selectedTaskId, polje.value)) polje.value = '';
    });

    document.getElementById('add-note-btn').addEventListener('click', async () => {
      const input = document.getElementById('detail-new-note');
      const note = input.value.trim();
      if (!note || !selectedTaskId) return;

      try {
        const response = await fetch(\`/api/tasks/\${selectedTaskId}\`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            progressNotes: [note]
          })
        });

        if (response.ok) {
          input.value = '';
          // Refresh task
          openTaskDetail(selectedTaskId);
        }
      } catch (err) {
        console.error('Failed to add note:', err);
      }
    });

    // Save task changes
    document.getElementById('save-task-btn').addEventListener('click', async () => {
      if (!selectedTaskId) return;

      const updates = {
        title: document.getElementById('detail-title').value,
        status: document.getElementById('detail-status').value,
        priority: parseInt(document.getElementById('detail-priority').value),
        assignee: document.getElementById('detail-assignee').value || undefined,
        description: document.getElementById('detail-description').value,
        blockedBy: editedBlockedBy,
        blockedReason: document.getElementById('detail-blocked-reason').value || undefined,
        tags: editedTags,
        // TASK-3512: prazan izbor je VALJANA vrijednost (makni projekt), pa se šalje ''
        // a ne undefined — poslužitelj '' pretvara u pretinac PRJ-033 (TASK-3514).
        projectId: document.getElementById('detail-project').value,
        // CompletionGuard (TASK-2954): ovaj PUT dolazi od ČOVJEKA s ploče. Guard čuva
        // od agenata koji zatvaraju neizvršeno; ručna odluka je mjerodavna i loga se.
        force: true
      };

      try {
        const response = await fetch(\`/api/tasks/\${selectedTaskId}\`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updates)
        });

        if (response.ok) {
          sendWSMessage({ action: 'task_updated', taskId: selectedTaskId });
          fetchTasks();
          closeDetailPanel();
        } else {
          const error = await response.json();
          alert('Failed to save: ' + (error.error || 'Unknown error'));
        }
      } catch (err) {
        console.error('Failed to save task:', err);
        alert('Failed to save task');
      }
    });

    // Delete task from detail panel
    document.getElementById('delete-task-btn').addEventListener('click', async () => {
      if (!selectedTaskId) return;
      if (!confirm(\`Are you sure you want to delete \${selectedTaskId}?\`)) return;

      try {
        const response = await fetch(\`/api/tasks/\${selectedTaskId}\`, {
          method: 'DELETE'
        });

        if (response.ok) {
          sendWSMessage({ action: 'task_deleted', taskId: selectedTaskId });
          closeDetailPanel();
          fetchTasks();
        }
      } catch (err) {
        console.error('Failed to delete task:', err);
        alert('Failed to delete task');
      }
    });

    // Cancel edit
    document.getElementById('cancel-edit-btn').addEventListener('click', closeDetailPanel);

    // Close button
    document.getElementById('close-detail-btn').addEventListener('click', closeDetailPanel);

    // ESC key closes panel
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (detailPanel.classList.contains('open')) {
          closeDetailPanel();
        }
        if (projectDetailPanel.classList.contains('open')) {
          closeProjectDetailPanel();
        }
        if (ragModalOverlay.style.display !== 'none') {
          closeRAGModal();
        }
      }
    });

    // ============================================
    // TAB NAVIGATION
    // ============================================

    let currentTab = 'tasks';

    function initTabNavigation() {
      const tabBtns = document.querySelectorAll('.tab-btn');
      const tabContents = document.querySelectorAll('.tab-content');

      tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
          const tabId = btn.dataset.tab;
          switchTab(tabId);
        });
      });
    }

    function switchTab(tabId) {
      currentTab = tabId;

      // Update tab buttons
      document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tabId);
      });

      // Update tab content
      document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.toggle('active', content.id === 'tab-' + tabId);
      });

      // Load data for the tab
      if (tabId === 'projects') {
        fetchProjects();
        pokreniAutoProjekte();
      } else if (tabId === 'rag') {
        initRAGPage();
      } else if (tabId === 'konzola') {
        initKonzola();
      } else if (tabId === 'potrosnja') {
        initPotrosnja();
      } else if (tabId === 'status') {
        initStatus();
      } else if (tabId === 'info') {
        initInfo();
      }

      // Stop intervals for inactive tabs
      if (tabId !== 'konzola' && konzolaStatusInterval) { clearInterval(konzolaStatusInterval); konzolaStatusInterval = null; }
      if (tabId !== 'konzola' && sessionUsageInterval) { clearInterval(sessionUsageInterval); sessionUsageInterval = null; }
      if (tabId !== 'status' && statusRefreshInterval) { clearInterval(statusRefreshInterval); statusRefreshInterval = null; }
      // TASK-3569: napuštena kartica „Potrošnja" ne smije nastaviti pitati za 202.
      if (tabId !== 'potrosnja') {
        potrosnjaGen++;
        if (potrosnjaTimer) { clearTimeout(potrosnjaTimer); potrosnjaTimer = null; }
        if (autoPotrosnjaInterval) { clearInterval(autoPotrosnjaInterval); autoPotrosnjaInterval = null; }
      }
      // TASK-3691: isto vrijedi za automatsko osvježavanje troška na karticama projekata.
      if (tabId !== 'projects' && autoProjektiInterval) {
        clearInterval(autoProjektiInterval); autoProjektiInterval = null;
      }

      // Update add button visibility
      const addTaskBtn = document.getElementById('add-task-btn');
      addTaskBtn.style.display = tabId === 'tasks' ? 'flex' : 'none';
    }

    // ============================================
    // PROJECTS FUNCTIONALITY
    // ============================================

    let projects = [];
    let projectsFilter = 'all';
    let projectsSort = 'aktivnost';   // TASK-3691: ključ poretka na popisu projekata
    let projectsSortSmjer = 1;        // 1 = silazno (najnovije/najskuplje prvo), -1 = obrnuto
    let selectedProjectId = null;
    let selectedProjectData = null;
    let projectAgents = [];

    const projectDetailPanel = document.getElementById('project-detail-panel');
    const projectModal = document.getElementById('project-modal-overlay');
    const projectForm = document.getElementById('project-form');

    function sortOpis(kljuc, smjer) {
      return {
        aktivnost: [_T('sort_aktivnost_desc', 'zadnji rad na projektu — najnoviji prvi'), _T('sort_aktivnost_asc', 'zadnji rad na projektu — najstariji prvi')],
        cijena: [_T('sort_cijena_desc', 'potrošnja — najskuplji prvi'), _T('sort_cijena_asc', 'potrošnja — najjeftiniji prvi')],
        ime: [_T('sort_ime_desc', 'ime projekta — A→Ž'), _T('sort_ime_asc', 'ime projekta — Ž→A')],
        pocetak: [_T('sort_pocetak_desc', 'početak rada — najnoviji prvi'), _T('sort_pocetak_asc', 'početak rada — najstariji prvi')],
        zadataka: [_T('sort_zadataka_desc', 'broj zadataka — najviše prvo'), _T('sort_zadataka_asc', 'broj zadataka — najmanje prvo')],
      }[kljuc][smjer];
    }

    function osvjeziSortOpis() {
      const el = document.getElementById('projects-sort-opis');
      if (el) el.textContent = _T('poredak', 'Poredak:') + ' ' + sortOpis(projectsSort, projectsSortSmjer === 1 ? 0 : 1);
      const btn = document.getElementById('projects-sort-smjer');
      if (btn) btn.innerHTML = projectsSortSmjer === 1 ? '&#8595;' : '&#8593;';
    }

    (function initProjectsSort() {
      const sel = document.getElementById('projects-sort');
      if (sel) sel.addEventListener('change', function () {
        projectsSort = sel.value;
        // Poredak po cijeni treba brojke; ako još nisu stigle, dohvati ih odmah.
        if (projectsSort === 'cijena' && !popisTrosak) ucitajTroskovePopisa(true);
        osvjeziSortOpis();
        renderProjects();
      });
      const btn = document.getElementById('projects-sort-smjer');
      if (btn) btn.addEventListener('click', function () {
        projectsSortSmjer = -projectsSortSmjer;
        osvjeziSortOpis();
        renderProjects();
      });
      osvjeziSortOpis();
    })();

    async function fetchProjects() {
      try {
        const response = await fetch('/api/projects');
        projects = await response.json();
        renderProjects();
        updateProjectsAgentFilter();
        // Trošak po projektu (TASK-3572, T8) — jedan poziv za sve kartice, s
        // vlastitim kešem; ne blokira ispis popisa i ne ponavlja se u bujici.
        ucitajTroskovePopisa(false);
        // R4/TASK-4311: broj dokumenata po projektu — ne blokira ispis kartica,
        // kućice se dopune kad brojka stigne.
        ucitajRagBrojeve(false);
      } catch (err) {
        console.error('Failed to fetch projects:', err);
      }
    }

    // Nazivi statusa projekta na hrvatskom (TASK-3513)
    // Nazivi statusa projekta (TASK-3513) — prevode se kao i ostatak ploče (TASK-4721)
    function projectStatusLabel(status) {
      return {
        active: _T('prj_status_active', 'Aktivan'),
        on_hold: _T('prj_status_on_hold', 'Na čekanju'),
        completed: _T('prj_status_completed', 'Dovršen'),
        archived: _T('prj_status_archived', 'Arhiviran')
      }[status] || status;
    }

    /**
     * Vremenska oznaka iz baze u Date. Baza nosi dva zapisa ('2026-08-28 11:29:20'
     * i '2026-08-28T11:29:20.000Z') koji oba znače ISTI, LOKALNI sat (v. ChronoOrder.ts),
     * pa 'Z' odbacujemo — inače bi ISO zapis ispao pomaknut za razliku prema UTC-u.
     */
    function parseDbTs(ts) {
      if (!ts) return null;
      const norm = String(ts).replace('T', ' ').replace('Z', '').trim();
      const d = new Date(norm.replace(' ', 'T'));
      return isNaN(d.getTime()) ? null : d;
    }

    /** 'prije 5 min' / 'prije 3 h' / 'prije 2 d' — koliko je davno bio zadnji rad. */
    function projectAgeText(ts) {
      const d = parseDbTs(ts);
      if (!d) return _T('prj_bez_zapisa', 'bez zapisa');
      const min = Math.floor((Date.now() - d.getTime()) / 60000);
      if (min < 1) return _T('upravo_sad', 'upravo sad');
      if (min < 60) return _Tv('prije_n_min', 'prije {broj} min', { broj: min });
      const h = Math.floor(min / 60);
      if (h < 24) return _Tv('prije_n_h', 'prije {broj} h', { broj: h });
      const dani = Math.floor(h / 24);
      return _Tv('prije_n_d', 'prije {broj} d', { broj: dani });
    }

    function projectCountChip(cssKey, label, value) {
      const n = Number(value) || 0;
      return '<span class="project-count c-' + cssKey + (n === 0 ? ' is-zero' : '') +
             '" title="' + label + '">' + label + ' <b>' + n + '</b></span>';
    }

    /**
     * Projekti u četiri stupca, bez statusnih stupaca (TASK-3513). Poredak dolazi
     * s poslužitelja (ChronoOrder: zadnji rad silazno), ali ga ovdje potvrđujemo
     * i na klijentu da filtriranje ili drugi izvor ne pomute redoslijed —
     * prva kućica (A1) mora biti projekt na kojemu se zadnje radilo.
     */
    function renderProjects() {
      const container = document.getElementById('projects-rows');
      if (!container) return;

      // TASK-3691 (Goran): poredak po zadnjem radu, potrošnji, imenu, početku ili broju
      // zadataka. Potrošnja i datumi rada dolaze iz popisTrosak (/api/projects/trosak),
      // pa je poredak po cijeni moguć tek kad ta brojka stigne — do tada se pada natrag
      // na zadnji rad umjesto da se popis prikaže u nasumičnom redu.
      const filtered = (projectsFilter === 'all'
        ? projects.slice()
        : projects.filter(p => p.lead_agent === projectsFilter))
        .sort((a, b) => {
          const smjer = projectsSortSmjer;
          const ta = popisTrosak && popisTrosak[a.id];
          const tb = popisTrosak && popisTrosak[b.id];
          function vrijeme(v) { const d = parseDbTs(v); return d ? d.getTime() : 0; }
          if (projectsSort === 'ime') {
            return smjer * String(a.name || a.id).localeCompare(String(b.name || b.id), 'hr');
          }
          if (projectsSort === 'cijena' && popisTrosak) {
            return smjer * (((tb && tb.usd) || 0) - ((ta && ta.usd) || 0));
          }
          if (projectsSort === 'zadataka') {
            return smjer * ((Number(b.task_count) || 0) - (Number(a.task_count) || 0));
          }
          if (projectsSort === 'pocetak') {
            const pa = vrijeme((ta && ta.prviZadatak) || a.created_at);
            const pb = vrijeme((tb && tb.prviZadatak) || b.created_at);
            return smjer * (pb - pa);
          }
          const za = Math.max(vrijeme(a.last_activity_at || a.updated_at), vrijeme(ta && ta.zadnjiZadatak));
          const zb = Math.max(vrijeme(b.last_activity_at || b.updated_at), vrijeme(tb && tb.zadnjiZadatak));
          return smjer * (zb - za);
        });

      container.innerHTML = '';

      if (filtered.length === 0) {
        container.innerHTML = '<div class="empty">' + _T('prj_nema_projekata', 'Nema projekata') + '</div>';
        return;
      }

      filtered.forEach(project => {
        const status = project.status || 'active';
        const total = Number(project.task_count) || 0;
        const done = Number(project.completed_task_count) || 0;
        const pct = total > 0
          ? (project.calculated_progress != null ? Number(project.calculated_progress) : Math.round(done * 1000 / total) / 10)
          : 0;

        const card = document.createElement('div');
        card.className = 'project-card status-' + status;
        card.title = _T('prj_zadnji_rad', 'Zadnji rad:') + ' ' + (project.last_activity_at || project.updated_at || '—');

        card.innerHTML = \`
          <div class="project-card-top">
            <span class="project-id">\${project.id}</span>
            <span class="project-status-badge status-\${status}">\${projectStatusLabel(status)}</span>
          </div>
          <div class="project-name">\${project.name}</div>
          <div class="project-meta">
            <span>\${project.lead_agent || _T('prj_bez_vodstva', 'bez vodstva')} · P\${project.priority}</span>
            <span>\${projectAgeText(project.last_activity_at || project.updated_at)}</span>
          </div>
          <div class="project-counts">
            \${projectCountChip('in_progress', _T('chip_u_radu', 'u radu'), project.in_progress_task_count)}
            \${projectCountChip('pending', _T('chip_na_cekanju', 'na čekanju'), project.pending_task_count)}
            \${projectCountChip('blocked', _T('chip_blokirano', 'blokirano'), project.blocked_task_count)}
            \${projectCountChip('completed', _T('chip_gotovo', 'gotovo'), done)}
            \${projectTrosakChip(project.id)}
            \${projectEnergijaChip(project.id)}
            \${projectCo2Chip(project.id)}
            \${projectVodaChip(project.id)}
            \${projectVrijednostChip(project.id)}
            \${projectRagChip(project.id)}
          </div>
          <div class="project-progress">
            <div class="project-progress-track">
              <div class="project-progress-fill" style="width: \${Math.max(0, Math.min(100, pct))}%"></div>
            </div>
            <div class="project-progress-label">
              <span>\${_Tv('prj_postotak_dovrseno', '{pct} % dovršeno', { pct: String(pct).replace('.', ',') })}</span>
              <span>\${_Tv('prj_done_od_total', '{done}/{total} zadataka', { done: done, total: total })}</span>
            </div>
          </div>
        \`;

        container.appendChild(card);

        card.addEventListener('click', () => {
          openProjectDetail(project.id);
        });
      });
    }

    function updateProjectsAgentFilter() {
      const agents = [...new Set(projects.map(p => p.lead_agent).filter(Boolean))];
      const container = document.getElementById('projects-agent-filter');
      container.innerHTML = '<button class="agent-btn active" data-agent="all" data-i18n="all_agents">'
        + (RJECNIK['all_agents'] || 'All Agents') + '</button>';

      agents.forEach(agent => {
        const btn = document.createElement('button');
        btn.className = 'agent-btn' + (projectsFilter === agent ? ' active' : '');
        btn.dataset.agent = agent;
        btn.textContent = agent;
        container.appendChild(btn);
      });

      container.querySelectorAll('.agent-btn').forEach(btn => {
        btn.onclick = () => {
          projectsFilter = btn.dataset.agent;
          container.querySelectorAll('.agent-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          renderProjects();
        };
      });
    }

    // Project Create/Edit Modal
    document.getElementById('add-project-btn').addEventListener('click', () => {
      document.getElementById('project-modal-title').textContent = 'Create New Project';
      document.getElementById('project-submit-btn').textContent = 'Create Project';
      document.getElementById('project-edit-id').value = '';
      projectForm.reset();
      projectModal.style.display = 'flex';
      document.getElementById('project-name').focus();
    });

    document.getElementById('project-cancel-btn').addEventListener('click', () => {
      projectModal.style.display = 'none';
      projectForm.reset();
    });

    projectModal.addEventListener('click', (e) => {
      if (e.target === projectModal) {
        projectModal.style.display = 'none';
        projectForm.reset();
      }
    });

    projectForm.addEventListener('submit', async (e) => {
      e.preventDefault();

      const editId = document.getElementById('project-edit-id').value;
      const isEdit = !!editId;

      const data = {
        name: document.getElementById('project-name').value,
        description: document.getElementById('project-description').value || undefined,
        status: document.getElementById('project-status').value,
        priority: parseInt(document.getElementById('project-priority').value),
        lead_agent: document.getElementById('project-lead').value || undefined
      };

      try {
        const url = isEdit ? \`/api/projects/\${editId}\` : '/api/projects';
        const method = isEdit ? 'PUT' : 'POST';

        const response = await fetch(url, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        });

        if (response.ok) {
          projectModal.style.display = 'none';
          projectForm.reset();
          fetchProjects();
        } else {
          const error = await response.json();
          alert('Failed: ' + (error.error || 'Unknown error'));
        }
      } catch (err) {
        console.error('Failed to save project:', err);
        alert('Failed to save project');
      }
    });

    // Project Detail Panel
    async function openProjectDetail(projectId) {
      try {
        const response = await fetch(\`/api/projects/\${projectId}\`);
        if (!response.ok) throw new Error('Project not found');

        const project = await response.json();
        selectedProjectId = projectId;
        selectedProjectData = project;
        projectAgents = project.agents || [];

        renderProjectDetailPanel(project);
        projectDetailPanel.classList.add('open');
        ucitajPotrosnjuProjekta(projectId, {});
      } catch (err) {
        console.error('Failed to load project:', err);
        alert('Failed to load project details');
      }
    }

    function closeProjectDetailPanel() {
      projectDetailPanel.classList.remove('open');
      // Odgođeni pokušaj za zatvoreni panel nema kome pisati.
      projektPotrosnjaGen++;
      if (projektPotrosnjaTimer) { clearTimeout(projektPotrosnjaTimer); projektPotrosnjaTimer = null; }
      projPostavi('<span class="tel-muted">&hellip;</span>');
      selectedProjectId = null;
      selectedProjectData = null;
      projectAgents = [];
    }

    function renderProjectDetailPanel(project) {
      document.getElementById('project-detail-id').textContent = project.id;
      document.getElementById('project-detail-name').value = project.name;
      document.getElementById('project-detail-status').value = project.status;
      document.getElementById('project-detail-priority').value = project.priority;
      document.getElementById('project-detail-lead').value = project.lead_agent || '';
      document.getElementById('project-detail-description').value = project.description || '';
      // Spec u <textarea>.value (sigurno — bez innerHTML, nema XSS rizika)
      document.getElementById('project-detail-spec').value = project.specification || '';
      // Napuni dropdown agenata + osvježi disabled stanje dispatch gumba
      loadSpecUpgradeAgents();
      updateSpecUpgradeBtnState();

      // Render agents
      renderProjectAgents();

      // Render tasks
      renderProjectTasks(project.tasks || []);

      // Render timestamps
      const timestampsContainer = document.getElementById('project-detail-timestamps');
      const format = (d) => d ? new Date(d).toLocaleString() : '-';
      timestampsContainer.innerHTML = \`
        <div><strong>Created:</strong> \${format(project.created_at)}</div>
        <div><strong>Updated:</strong> \${format(project.updated_at)}</div>
        \${project.target_date ? \`<div><strong>Target:</strong> \${format(project.target_date)}</div>\` : ''}
      \`;
    }

    function renderProjectAgents() {
      const container = document.getElementById('project-detail-agents');
      if (!projectAgents || projectAgents.length === 0) {
        container.innerHTML = '<div class="empty" style="padding: 0.5rem;">No agents assigned</div>';
        return;
      }

      container.innerHTML = projectAgents.map(agent => \`
        <div class="agent-item">
          <span>\${agent.agent_id}</span>
          <span class="remove-agent" data-agent="\${agent.agent_id}">&times;</span>
        </div>
      \`).join('');

      container.querySelectorAll('.remove-agent').forEach(btn => {
        btn.addEventListener('click', () => removeProjectAgent(btn.dataset.agent));
      });
    }

    function renderProjectTasks(tasks) {
      const container = document.getElementById('project-detail-tasks');
      if (!tasks || tasks.length === 0) {
        container.innerHTML = '<div class="empty">No tasks linked</div>';
        return;
      }

      container.innerHTML = tasks.map(task => \`
        <div class="task-list-item">
          <span>\${task.id} - \${task.title}</span>
          <span class="task-status \${task.status}">\${task.status}</span>
        </div>
      \`).join('');
    }

    // Add agent to project
    document.getElementById('project-add-agent-select').addEventListener('change', async (e) => {
      if (!e.target.value || !selectedProjectId) return;

      const agentId = e.target.value;
      e.target.value = '';

      // Check if already added
      if (projectAgents.some(a => a.agent_id === agentId)) {
        alert('Agent already on project');
        return;
      }

      try {
        const response = await fetch(\`/api/projects/\${selectedProjectId}/agents\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent_id: agentId, role: 'member' })
        });

        if (response.ok) {
          projectAgents.push({ agent_id: agentId, role: 'member' });
          renderProjectAgents();
        } else {
          const error = await response.json();
          alert('Failed: ' + (error.error || 'Unknown error'));
        }
      } catch (err) {
        console.error('Failed to add agent:', err);
      }
    });

    async function removeProjectAgent(agentId) {
      if (!selectedProjectId) return;

      try {
        const response = await fetch(\`/api/projects/\${selectedProjectId}/agents/\${agentId}\`, {
          method: 'DELETE'
        });

        if (response.ok) {
          projectAgents = projectAgents.filter(a => a.agent_id !== agentId);
          renderProjectAgents();
        }
      } catch (err) {
        console.error('Failed to remove agent:', err);
      }
    }

    // Save project changes
    document.getElementById('save-project-btn').addEventListener('click', async () => {
      if (!selectedProjectId) return;

      const updates = {
        name: document.getElementById('project-detail-name').value,
        status: document.getElementById('project-detail-status').value,
        priority: parseInt(document.getElementById('project-detail-priority').value),
        lead_agent: document.getElementById('project-detail-lead').value || undefined,
        description: document.getElementById('project-detail-description').value,
        specification: document.getElementById('project-detail-spec').value
      };

      try {
        const response = await fetch(\`/api/projects/\${selectedProjectId}\`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updates)
        });

        if (response.ok) {
          fetchProjects();
          closeProjectDetailPanel();
        } else {
          const error = await response.json();
          alert('Failed to save: ' + (error.error || 'Unknown error'));
        }
      } catch (err) {
        console.error('Failed to save project:', err);
        alert('Failed to save project');
      }
    });

    // ============================================
    // SPEC DISPATCH-UPGRADE (frontend)
    // ============================================

    // Napuni dropdown agenata iz /api/agents s oznakom [PERMANENT]/[spawn] po persistent.
    // Prikazuje SVE agente koje API vrati (uklj. emard ako ga vrati). BEZ preselekcije.
    async function loadSpecUpgradeAgents() {
      const sel = document.getElementById('spec-upgrade-agent');
      if (!sel) return;
      try {
        const res = await fetch('/api/agents');
        const data = await res.json();
        const agents = (data.agents || []);
        sel.innerHTML = '<option value="">' + _T('odaberi_agenta', 'Odaberi agenta...') + '</option>';
        agents.forEach(a => {
          const opt = document.createElement('option');  // textContent → bez XSS
          opt.value = a.id;
          opt.textContent = \`\${a.name || a.id} — \${a.persistent ? '[PERMANENT]' : '[spawn]'}\`;
          sel.appendChild(opt);
        });
      } catch (err) {
        console.error('Failed to load agents for spec-upgrade:', err);
      }
    }

    // Gumb disabled dok je spec prazna ILI agent nije odabran (R1/R8 — dispatch-in-flight zasebno).
    function updateSpecUpgradeBtnState() {
      const btn = document.getElementById('spec-upgrade-btn');
      if (!btn || btn.dataset.busy === '1') return;
      const spec = (document.getElementById('project-detail-spec').value || '').trim();
      const agent = document.getElementById('spec-upgrade-agent').value;
      btn.disabled = !spec || !agent;
    }

    document.getElementById('project-detail-spec').addEventListener('input', updateSpecUpgradeBtnState);
    document.getElementById('spec-upgrade-agent').addEventListener('change', updateSpecUpgradeBtnState);

    // Dispatch: confirm → POST → toast → refresh. Gumb busy dok traje request (R8 double-dispatch).
    document.getElementById('spec-upgrade-btn').addEventListener('click', async () => {
      if (!selectedProjectId) return;
      const agent = document.getElementById('spec-upgrade-agent').value;
      const spec = (document.getElementById('project-detail-spec').value || '').trim();
      if (!agent || !spec) return;
      if (!confirm(\`Poslati projekt \${selectedProjectId} agentu "\${agent}" na nadogradnju po specifikacijama?\\n\\nSpec se snima i task se kreira (in_progress).\`)) return;

      const btn = document.getElementById('spec-upgrade-btn');
      btn.dataset.busy = '1';
      btn.disabled = true;
      const origLabel = btn.textContent;
      btn.textContent = '⟳ ' + _T('saljem_tocke', 'Šaljem...');
      try {
        // Prvo spremi aktualnu spec (da dispatch koristi zadnji upisani tekst)
        await fetch(\`/api/projects/\${selectedProjectId}\`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ specification: spec })
        });
        const res = await fetch(\`/api/projects/\${selectedProjectId}/dispatch-upgrade\`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent })
        });
        const data = await res.json();
        if (res.ok) {
          if (data.messageId === null) {
            alert(\`Task \${data.taskId} kreiran, ali poruka nije poslana: \${data.warning || ''}\`);
          } else {
            alert(\`✓ Dispatch poslan agentu \${agent}. Task: \${data.taskId}\`);
          }
          openProjectDetail(selectedProjectId);  // refresh
        } else {
          alert(_Tv('dispatch_nije_uspio', 'Dispatch nije uspio: {greska}', { greska: data.error || res.status }));
        }
      } catch (err) {
        console.error('dispatch-upgrade failed:', err);
        alert(_T('dispatch_mreza', 'Dispatch nije uspio (mreža).'));
      } finally {
        btn.dataset.busy = '';
        btn.textContent = origLabel;
        updateSpecUpgradeBtnState();
      }
    });

    // Template editor (toggle + load + save) — GET/PUT /api/templates/spec-upgrade
    document.getElementById('spec-template-toggle').addEventListener('click', async (e) => {
      e.preventDefault();
      const ed = document.getElementById('spec-template-editor');
      const toggle = document.getElementById('spec-template-toggle');
      if (ed.style.display === 'none') {
        ed.style.display = 'block';
        toggle.textContent = '▾ ' + _T('template_poruke', 'Template poruke');
        try {
          const res = await fetch('/api/templates/spec-upgrade');
          if (res.ok) {
            const data = await res.json();
            document.getElementById('spec-template-content').value = data.content || '';
          }
        } catch (err) { console.error('load template failed:', err); }
      } else {
        ed.style.display = 'none';
        toggle.textContent = '▸ ' + _T('template_poruke', 'Template poruke');
      }
    });

    document.getElementById('spec-template-save-btn').addEventListener('click', async () => {
      const content = document.getElementById('spec-template-content').value;
      try {
        const res = await fetch('/api/templates/spec-upgrade', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content })
        });
        alert(res.ok ? '✓ ' + _T('template_spremljen', 'Template spremljen.') : _T('template_nije_spremljen', 'Spremanje template-a nije uspjelo.'));
      } catch (err) {
        console.error('save template failed:', err);
        alert(_T('template_nije_spremljen', 'Spremanje template-a nije uspjelo.'));
      }
    });

    // Delete project
    document.getElementById('delete-project-btn').addEventListener('click', async () => {
      if (!selectedProjectId) return;
      if (!confirm(\`Are you sure you want to delete \${selectedProjectId}?\`)) return;

      try {
        const response = await fetch(\`/api/projects/\${selectedProjectId}\`, {
          method: 'DELETE'
        });

        if (response.ok) {
          closeProjectDetailPanel();
          fetchProjects();
        }
      } catch (err) {
        console.error('Failed to delete project:', err);
        alert('Failed to delete project');
      }
    });

    // Cancel and close buttons
    document.getElementById('cancel-project-edit-btn').addEventListener('click', closeProjectDetailPanel);
    document.getElementById('close-project-detail-btn').addEventListener('click', closeProjectDetailPanel);

    // ============================================
    // RAG FUNCTIONALITY
    // ============================================

    let ragEntries = [];
    let ragCollections = [];
    let ragFilter = '';
    // R4/TASK-4311: odabrani projekt ide na poslužitelj kao ?projectId= i tamo
    // postaje Chroma where-klauzula po project_id.
    let ragProjectFilter = '';
    let ragTipFilter = '';   // TASK-3691: filtar po vrsti dokumenta (tip_regoc)
    let ragOffset = 0;
    const RAG_LIMIT = 50;
    let ragTotal = 0;
    let currentRAGEntry = null;

    const ragModalOverlay = document.getElementById('rag-modal-overlay');

    async function initRAGPage() {
      await fetchRAGCollections();
      // Popis projekata s brojem dokumenata; ne čekamo ga da bi se popis otvorio.
      ucitajRagBrojeve(false).then(popuniRagProjectFilter);
      ragOffset = 0;
      ragEntries = [];
      await fetchRAGEntries();
    }

    async function fetchRAGCollections() {
      try {
        const response = await fetch('/api/rag/collections');
        ragCollections = await response.json();

        const select = document.getElementById('rag-collection-filter');
        select.innerHTML = '<option value="">All Collections</option>' +
          ragCollections.map(c => \`<option value="\${c.name}">\${c.name} (\${c.count})</option>\`).join('');
      } catch (err) {
        console.error('Failed to fetch RAG collections:', err);
      }
    }

    /**
     * Padajući izbornik projekata u kartici RAG. Uz svaki projekt stoji broj
     * dokumenata, pa se već iz izbornika vidi tko nema nijedan.
     */
    function popuniRagProjectFilter() {
      const select = document.getElementById('rag-project-filter');
      if (!select || !ragBrojDokumenata) return;
      const ids = Object.keys(ragBrojDokumenata).sort(function (a, b) {
        const d = (Number(ragBrojDokumenata[b]) || 0) - (Number(ragBrojDokumenata[a]) || 0);
        return d !== 0 ? d : String(a).localeCompare(String(b), 'hr');
      });
      select.innerHTML = '<option value="">' + _T('svi_projekti', 'Svi projekti') + '</option>' +
        ids.map(id => \`<option value="\${id}">\${id} (\${Number(ragBrojDokumenata[id]) || 0})</option>\`).join('');
      select.value = ragProjectFilter;
    }

    async function fetchRAGEntries(append = false) {
      try {
        const params = new URLSearchParams({
          limit: RAG_LIMIT.toString(),
          offset: ragOffset.toString()
        });

        if (ragProjectFilter) {
          params.append('projectId', ragProjectFilter);
        }

        if (ragTipFilter) {
          params.append('tip', ragTipFilter);
        }

        if (ragFilter) {
          params.append('collection', ragFilter);
        }

        // Add search parameter for server-side filtering
        if (ragSearchQuery) {
          params.append('search', ragSearchQuery);
        }

        const response = await fetch(\`/api/rag/entries?\${params}\`);
        const result = await response.json();

        if (append) {
          ragEntries = [...ragEntries, ...result.entries];
        } else {
          ragEntries = result.entries;
        }

        ragTotal = result.total;
        renderRAGEntries();
        updateRAGCount();
        updateLoadMoreButton();
      } catch (err) {
        console.error('Failed to fetch RAG entries:', err);
        document.getElementById('rag-list').innerHTML = '<div class="empty">Failed to load RAG entries</div>';
      }
    }

    function renderRAGEntries() {
      const container = document.getElementById('rag-list');

      if (ragEntries.length === 0) {
        container.innerHTML = '<div class="empty">No RAG entries found</div>';
        return;
      }

      container.innerHTML = ragEntries.map(entry => \`
        <div class="rag-entry" data-id="\${entry.id}" data-collection="\${entry.collection}">
          <div class="rag-entry-main">
            <div class="rag-entry-header">
              <span class="rag-entry-id">\${entry.id.substring(0, 12)}...</span>
              <span class="rag-entry-collection">\${entry.collection}</span>
              <span class="rag-entry-type">\${entry.type || 'unknown'}</span>
              <span class="rag-entry-date">\${new Date(entry.stored_at).toLocaleDateString()}</span>
            </div>
            <div class="rag-entry-preview">\${(entry.content || entry.document || '').substring(0, 150)}...</div>
          </div>
          <div class="rag-entry-actions">
            <button class="rag-delete-btn" data-id="\${entry.id}" data-collection="\${entry.collection}">Delete</button>
          </div>
        </div>
      \`).join('');

      // Add click handlers
      container.querySelectorAll('.rag-entry').forEach(el => {
        el.addEventListener('click', (e) => {
          if (e.target.closest('.rag-delete-btn')) return;
          openRAGModal(el.dataset.id, el.dataset.collection);
        });
      });

      container.querySelectorAll('.rag-delete-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          deleteRAGEntry(btn.dataset.id, btn.dataset.collection);
        });
      });

      // Apply search filter to newly rendered entries
      if (ragSearchQuery) {
        filterRAGEntries();
      }
    }

    function updateRAGCount() {
      document.getElementById('rag-total-count').textContent = \`\${ragEntries.length} of \${ragTotal} entries\`;
    }

    function updateLoadMoreButton() {
      const btn = document.getElementById('rag-load-more');
      btn.style.display = ragEntries.length < ragTotal ? 'block' : 'none';
      btn.textContent = \`Load More (\${ragTotal - ragEntries.length} remaining)\`;
    }

    // Collection filter
    document.getElementById('rag-project-filter').addEventListener('change', (e) => {
      ragProjectFilter = e.target.value;
      ragOffset = 0;
      ragEntries = [];
      fetchRAGEntries();
    });

    document.getElementById('rag-tip-filter').addEventListener('change', (e) => {
      ragTipFilter = e.target.value;
      ragOffset = 0;
      ragEntries = [];
      fetchRAGEntries();
    });

    document.getElementById('rag-collection-filter').addEventListener('change', (e) => {
      ragFilter = e.target.value;
      ragOffset = 0;
      ragEntries = [];
      fetchRAGEntries();
    });

    // RAG Search filter with debounce for server-side search
    let ragSearchQuery = '';
    let ragSearchDebounce = null;
    document.getElementById('rag-search-input').addEventListener('keyup', (e) => {
      ragSearchQuery = e.target.value;

      // Clear previous debounce
      if (ragSearchDebounce) clearTimeout(ragSearchDebounce);

      // Immediate client-side filter for responsiveness
      filterRAGEntries();

      // Debounced server-side search for full results
      ragSearchDebounce = setTimeout(() => {
        ragOffset = 0;
        ragEntries = [];
        fetchRAGEntries();
      }, 400);
    });

    function filterRAGEntries() {
      const container = document.getElementById('rag-list');
      const entries = container.querySelectorAll('.rag-entry');
      let visibleCount = 0;

      entries.forEach(entry => {
        const id = entry.querySelector('.rag-entry-id')?.textContent || '';
        const collection = entry.querySelector('.rag-entry-collection')?.textContent || '';
        const type = entry.querySelector('.rag-entry-type')?.textContent || '';
        const preview = entry.querySelector('.rag-entry-preview')?.textContent || '';

        const searchText = (id + ' ' + collection + ' ' + type + ' ' + preview).toLowerCase();
        const isMatch = !ragSearchQuery || searchText.includes(ragSearchQuery.toLowerCase());

        entry.style.display = isMatch ? '' : 'none';
        if (isMatch) visibleCount++;
      });

      if (visibleCount === 0 && ragEntries.length > 0) {
        container.innerHTML += '<div class="empty" style="grid-column: 1/-1;">No RAG entries match your search</div>';
      }
    }

    // Load more
    document.getElementById('rag-load-more').addEventListener('click', () => {
      ragOffset += RAG_LIMIT;
      fetchRAGEntries(true);
    });

    // RAG Modal
    async function openRAGModal(id, collection) {
      try {
        const response = await fetch(\`/api/rag/entries/\${encodeURIComponent(collection)}/\${encodeURIComponent(id)}\`);
        if (!response.ok) throw new Error('Entry not found');

        const entry = await response.json();
        currentRAGEntry = { id, collection };

        document.getElementById('rag-modal-id').textContent = entry.id;
        document.getElementById('rag-modal-collection').textContent = entry.collection;
        document.getElementById('rag-modal-type').textContent = entry.type || 'unknown';
        document.getElementById('rag-modal-date').textContent = new Date(entry.stored_at).toLocaleString();
        document.getElementById('rag-modal-content').textContent = entry.content || entry.document || JSON.stringify(entry.metadata, null, 2);

        ragModalOverlay.style.display = 'flex';
      } catch (err) {
        console.error('Failed to load RAG entry:', err);
        alert('Failed to load entry details');
      }
    }

    function closeRAGModal() {
      ragModalOverlay.style.display = 'none';
      currentRAGEntry = null;
    }

    document.getElementById('close-rag-modal-btn').addEventListener('click', closeRAGModal);
    document.getElementById('rag-modal-close-btn').addEventListener('click', closeRAGModal);

    ragModalOverlay.addEventListener('click', (e) => {
      if (e.target === ragModalOverlay) {
        closeRAGModal();
      }
    });

    // Delete from modal
    document.getElementById('rag-modal-delete-btn').addEventListener('click', async () => {
      if (!currentRAGEntry) return;
      if (!confirm('Are you sure you want to delete this entry? This is permanent!')) return;

      await deleteRAGEntry(currentRAGEntry.id, currentRAGEntry.collection);
      closeRAGModal();
    });

    async function deleteRAGEntry(id, collection) {
      if (!confirm('Are you sure you want to delete this RAG entry? This is permanent!')) return;

      try {
        const response = await fetch('/api/rag/entries', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            entries: [{ id, collection }]
          })
        });

        if (response.ok) {
          // Remove from local array and re-render
          ragEntries = ragEntries.filter(e => !(e.id === id && e.collection === collection));
          ragTotal--;
          renderRAGEntries();
          updateRAGCount();
          updateLoadMoreButton();
        } else {
          const error = await response.json();
          alert('Failed to delete: ' + (error.error || 'Unknown error'));
        }
      } catch (err) {
        console.error('Failed to delete RAG entry:', err);
        alert('Failed to delete entry');
      }
    }

    // ============================================
    // KONZOLA FUNCTIONALITY
    // ============================================

    let konzolaMode = 'plan';
    let konzolaStatusInterval = null;
    let konzolaCommandHistory = [];
    let konzolaHistoryIndex = -1;
    const KONZOLA_MAX_LINES = 5000;

    function escapeHtml(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }

    function formatUptime(s) {
      if (!s) return '--';
      const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
      return (h > 0 ? h + 'h ' : '') + m + 'm ' + sec + 's';
    }

    // ── Prikaz živosti daemona (TASK-2992) ───────────────────────────────────
    // Traka je do sada ispisivala sadržaj status datoteke doslovno, pa je mrtav daemon
    // satima izgledao kao da nešto radi. Stanje (online/stale/offline), starost zapisa,
    // PID i razlog računa POSLUŽITELJ (DaemonLiveness, TASK-2989/2991) — preglednikov sat
    // nije pouzdan pa se ovdje ništa ne izvodi iz vremena, samo prikazuje.
    // Odgovor bez polja 'state' (starije izdanje API-ja) prikazuje se kao i prije:
    // NB: ovaj blok živi unutar HTML template-literala — obrnuti navodnik ovdje
    // prekida string i ruši build (dogodilo se 28.07., TASK-2992).
    // radije ništa ne tvrdimo o živosti nego da izmislimo lažni OFFLINE.
    function fmtAgeShort(s) {
      if (s === null || s === undefined || !isFinite(s)) return '?';
      if (s < 60) return Math.round(s) + 's';
      const m = Math.floor(s / 60);
      if (m < 60) return m + 'm';
      return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
    }

    function fmtClock(iso) {
      if (!iso) return null;
      const dt = new Date(iso);
      return isNaN(dt.getTime()) ? null : dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function firstNum() {
      for (let i = 0; i < arguments.length; i++) {
        const v = arguments[i];
        if (typeof v === 'number' && isFinite(v)) return v;
      }
      return null;
    }

    // Vraća sve što traka i nadzorna ploča trebaju za prikaz daemona.
    // Čista funkcija (bez DOM-a) — pokriva je tests/unit/DaemonStatusBar.test.ts.
    function buildDaemonView(d) {
      const dm = (d && d.daemon) || {};
      const lv = (d && d.liveness) || dm.liveness || {};
      const state = dm.state || lv.state || (d && d.state) || null;
      const ageS = firstNum(dm.ageS, lv.ageS, d && d.ageS);
      const statusAgeS = firstNum(dm.statusAgeS, lv.statusAgeS, d && d.statusAgeS);
      const pid = firstNum(dm.pid, lv.pid);
      const reason = dm.reason || lv.reason || '';
      const lastSeen = dm.lastSeen || lv.lastSeen || dm.lastUpdate || null;
      // Status iz same datoteke — kad je daemon mrtav, poslužitelj u polju 'display'
      // šalje 'OFFLINE', pa bi „zadnje: OFFLINE" bilo besmisleno.
      const fileStatus = (lv.status && typeof lv.status.status === 'string') ? lv.status.status : null;
      const shown = dm.display || (typeof dm.status === 'string' ? dm.status : null) || fileStatus || '--';
      const lastKnown = fileStatus
        || (typeof dm.status === 'string' && dm.status !== 'OFFLINE' ? dm.status : null)
        || _T('nepoznato', 'nepoznato');
      const task = dm.currentTask || '--';

      const tip = [];
      if (reason) tip.push(reason);
      if (pid !== null) tip.push('PID ' + pid);
      if (ageS !== null) tip.push(_Tv('sta_zadnji_zapis_prije', 'zadnji zapis prije {koliko}', { koliko: fmtAgeShort(ageS) }));
      const title = tip.join(' · ');

      if (state === 'offline') {
        const clock = fmtClock(lastSeen);
        return {
          state: 'offline',
          statusText: 'OFFLINE',
          statusClass: ' s-error',
          uptimeText: '--',
          taskText: _T('sta_zadnje', 'zadnje:') + ' ' + lastKnown
            + (clock ? ' ' + _Tv('sta_u_sat', 'u {sat}', { sat: clock }) : ' (' + _T('sta_vrijeme_nepoznato', 'vrijeme nepoznato') + ')'),
          title: title || _T('sta_daemon_ne_odgovara', 'daemon ne odgovara')
        };
      }

      if (state === 'stale') {
        return {
          state: 'stale',
          statusText: shown + ' ⚠',
          statusClass: ' s-warn',
          uptimeText: formatUptime(dm.uptime),
          taskText: task + ' · ' + _Tv('sta_zapis_star', 'zapis star {koliko}', { koliko: fmtAgeShort(ageS) }),
          title: title || _T('sta_zapis_zastario', 'zapis je zastario — daemon je živ, ali ne piše status')
        };
      }

      // online + legacy: trajanje trenutnog stanja razlikuje dugu obradu od zaglavljene
      const dur = (state === 'online' && statusAgeS !== null && statusAgeS >= 60)
        ? ' (' + fmtAgeShort(statusAgeS) + ')' : '';
      return {
        state: state || 'unknown',
        statusText: shown,
        statusClass: shown === 'Idle' ? '' : shown === 'Stopping' ? ' s-error' : ' s-warn',
        uptimeText: formatUptime(dm.uptime),
        taskText: task + dur,
        title: title
      };
    }

    async function fetchKonzolaStatus() {
      try {
        const r = await fetch('/api/konzola/status');
        const d = await r.json();
        const dv = buildDaemonView(d);
        const de = document.getElementById('konzola-daemon-status');
        de.textContent = dv.statusText;
        de.className = 'konzola-status-value' + dv.statusClass;
        de.title = dv.title;
        const up = document.getElementById('konzola-uptime');
        up.textContent = dv.uptimeText;
        up.title = dv.title;
        const ct = document.getElementById('konzola-current-task');
        ct.textContent = dv.taskText;
        // Task je odrezan na 200px, pa puni tekst (i razlog) mora biti u tooltipu.
        ct.title = dv.taskText + (dv.title ? ' — ' + dv.title : '');
        document.getElementById('konzola-pending').textContent = d.daemon.pendingMessages ?? '--';
        document.getElementById('konzola-processed').textContent = d.daemon.processedToday ?? '--';
        const cx = document.getElementById('konzola-context');
        cx.textContent = (d.daemon.contextPct || 0) + '%';
        cx.className = 'konzola-status-value' + (d.daemon.contextPct > 75 ? ' s-error' : d.daemon.contextPct > 50 ? ' s-warn' : '');
        const sv = d.services || {};
        const running = Object.values(sv).filter(s => s && (s.status === 'running' || s.status === 'ok')).length;
        const total = Object.keys(sv).length;
        const se = document.getElementById('konzola-services');
        se.textContent = running + '/' + total;
        se.className = 'konzola-status-value' + (running === total ? '' : running > total/2 ? ' s-warn' : ' s-error');
        // Read system-wide mode (not just console mode)
        konzolaMode = (d.daemon?.mode || d.mode || 'WORK').toLowerCase();
        updateModeButton();
      } catch(e) { console.error('Konzola status fetch failed:', e); }
    }

    // Potrošnja trenutne Claude sesije (5h) / tjedna (7d) — izvor session_usage cache.
    let _sessionUsageLast = 0;
    let sessionUsageInterval = null;
    async function fetchSessionUsage(force) {
      try {
        const r = await fetch('/api/session-usage' + (force ? '?force=1' : ''));
        const d = await r.json();
        const el = document.getElementById('konzola-session');
        if (!el) return;
        // TASK-3461: kvar MJERILA ima prednost nad brojkom. Brojka od 87 % koja je stara
        // 139 min nije stanje sesije nego zamrznuta snimka, a razlika je odlučivala o tome
        // stoji li autonomija do jutra a da nitko ne zna zašto.
        const meterDown = d.meter_status === 'down';
        const meterInfo = meterDown
          ? _T('sta_mjerilo_ne_radi', 'MJERILO NE RADI') + (d.meter_down_min != null ? ' ' + d.meter_down_min + ' ' + _T('jed_min', 'min') : '')
            + (d.meter_error ? ' — ' + d.meter_error : '') + ' · ' + _T('sta_autonomija_stoji', 'autonomija stoji')
          : '';
        if (d.session_percent == null) {
          el.textContent = meterDown ? _T('sta_mjerilo', 'mjerilo') + ' ⛔' : 'n/a';
          el.className = 'konzola-status-value ' + (meterDown ? 's-error' : 's-warn');
          el.title = meterInfo || d.error || _T('nedostupno', 'nedostupno'); return;
        }
        const sp = Math.round(d.session_percent), wp = (d.weekly_percent == null ? null : Math.round(d.weekly_percent));
        el.textContent = sp + '%' + (wp != null ? ' · 7d ' + wp + '%' : '')
          + (meterDown ? ' ⛔ ' + _T('sta_mjerilo', 'mjerilo') : d.stale ? ' ⚠' : '');
        el.className = 'konzola-status-value' + (meterDown || sp >= 90 ? ' s-error' : sp >= 75 ? ' s-warn' : '');
        el.title = (meterDown ? meterInfo + ' · ' + _T('sta_zadnja_poznata', 'zadnja poznata brojka:') + ' ' : '')
          + _Tv('sta_sesija_tjedan', 'Sesija 5h: {sesija}% · Tjedan 7d: {tjedan}%',
                { sesija: sp, tjedan: (wp == null ? '?' : wp) })
          + (d.session_reset_local ? ' · reset ' + d.session_reset_local : '')
          + (d.age_s != null ? ' · ' + _Tv('sta_ocitano_prije', 'očitano prije {broj} s', { broj: d.age_s }) : '')
          + (!meterDown && d.stale ? ' · ' + _T('sta_zastarjelo', 'ZASTARJELO') + ': '
             + (d.error || _T('sta_osvjezavanje_ne_uspijeva', 'osvježavanje ne uspijeva')) : '');
      } catch(e) {}
    }
    // Na I/O u konzoli osvježi, ali najviše svakih 5 s (da ne spama pri brzom logu).
    // Server ima svoju branu (probe najviše jednom u 10 s), pa je force ovdje siguran.
    function fetchSessionUsageThrottled() {
      const now = Date.now();
      if (now - _sessionUsageLast < 5000) return;
      _sessionUsageLast = now; fetchSessionUsage(true);
    }

    function updateModeButton() {
      const btn = document.getElementById('konzola-mode-btn');
      const prompt = document.getElementById('konzola-prompt');
      if (konzolaMode === 'work') {
        btn.textContent = 'WORK'; btn.className = 'konzola-mode-btn work-mode';
        prompt.textContent = 'regoc #'; prompt.style.color = 'var(--accent-red)';
      } else {
        btn.textContent = 'PLAN'; btn.className = 'konzola-mode-btn plan-mode';
        prompt.textContent = 'regoc $'; prompt.style.color = 'var(--accent-green)';
      }
    }

    function appendToKonzolaLog(text, cssClass) {
      const output = document.getElementById('konzola-output');
      const line = document.createElement('div');
      const ts = new Date().toLocaleTimeString();
      line.innerHTML = '<span class="log-ts">[' + ts + ']</span> <span class="' + (cssClass || '') + '">' + escapeHtml(text) + '</span>';
      output.appendChild(line);
      while (output.children.length > KONZOLA_MAX_LINES) output.removeChild(output.firstChild);
      output.parentElement.scrollTop = output.parentElement.scrollHeight;
      fetchSessionUsageThrottled();  // osvježi potrošnju sesije na svaki I/O u konzoli
    }

    function handleBuiltinCommand(cmd) {
      if (cmd === 'help') {
        appendToKonzolaLog('Available commands:', 'log-info');
        appendToKonzolaLog('  help                    Show this help', 'log-system');
        appendToKonzolaLog('  status                  Refresh status line', 'log-system');
        appendToKonzolaLog('  verbose / info          Detailed system status', 'log-system');
        appendToKonzolaLog('  clear                   Clear console', 'log-system');
        appendToKonzolaLog('  mode [plan|work]        Switch mode', 'log-system');
        appendToKonzolaLog('  services [cmd]          Service management', 'log-system');
        appendToKonzolaLog('  logs [source] [lines]   Tail log (daemon|klaudio|voiceserver)', 'log-system');
        appendToKonzolaLog('  history                 Command history', 'log-system');
        appendToKonzolaLog('  ls, cat, head, tail     File reading', 'log-system');
        appendToKonzolaLog('  git status/log/diff     Git operations', 'log-system');
        appendToKonzolaLog('', '');
        appendToKonzolaLog('Live streams (auto):', 'log-info');
        appendToKonzolaLog('  🧠 Agent reasoning/thinking (session JSONL)', 'log-thinking');
        appendToKonzolaLog('  🔧 Tool calls (Read, Edit, Bash, Grep...)', 'log-info');
        appendToKonzolaLog('  💭 Agent text responses', 'log-text');
        appendToKonzolaLog('  📨 Message queue activity', 'log-info');
        appendToKonzolaLog('  📋 Event log audit trail', 'log-system');
        appendToKonzolaLog('  📊 Token usage per inference', 'log-system');
        appendToKonzolaLog('', '');
        appendToKonzolaLog('Natural language → REGOČ message queue:', 'log-info');
        appendToKonzolaLog('  ' + _T('knz_pomoc_prirodni_1', 'Sve što ne počinje poznatom naredbom šalje se'), 'log-system');
        appendToKonzolaLog('  ' + _T('knz_pomoc_prirodni_2', 'kao poruka REGOČ-u (kao Telegram/terminal).'), 'log-system');
        appendToKonzolaLog('  ' + _T('knz_pomoc_prirodni_3', 'Prefiks /cmd prisiljava tumačenje kao naredbu.'), 'log-system');
        return true;
      }
      if (cmd === 'clear') {
        document.getElementById('konzola-output').innerHTML = '<div class="konzola-welcome">Console cleared.</div>';
        return true;
      }
      if (cmd === 'status') { fetchKonzolaStatus(); appendToKonzolaLog('Status refreshed', 'log-info'); return true; }
      if (cmd === 'history') {
        konzolaCommandHistory.forEach((c, i) => appendToKonzolaLog('  ' + (i+1) + '  ' + c, 'log-system'));
        return true;
      }
      if (cmd.startsWith('mode ')) {
        const m = cmd.split(' ')[1];
        if (m === 'plan' || m === 'work') { toggleKonzolaMode(m); return true; }
      }
      if (cmd === 'logs' || cmd.startsWith('logs ')) {
        const parts = cmd.split(' ');
        const source = parts[1] || 'daemon';
        const n = parseInt(parts[2]) || 50;
        fetchLogs(source, n);
        return true;
      }
      if (cmd === 'verbose' || cmd === 'info') {
        fetchVerboseStatus();
        return true;
      }
      return false;
    }

    async function fetchLogs(source, lines) {
      try {
        appendToKonzolaLog('Fetching ' + lines + ' lines from ' + source + '...', 'log-info');
        const r = await fetch('/api/konzola/logs?source=' + source + '&lines=' + lines);
        const d = await r.json();
        if (d.error) { appendToKonzolaLog(d.error, 'log-error'); return; }
        (d.lines || []).forEach(l => appendToKonzolaLog(l, detectLogLevel(l)));
      } catch(e) { appendToKonzolaLog('Failed to fetch logs: ' + e.message, 'log-error'); }
    }

    function detectLogLevel(line) {
      if (!line) return '';
      if (line.includes('ERROR') || line.includes('FAILED')) return 'log-error';
      if (line.includes('WARN') || line.includes('⚠️')) return 'log-warn';
      if (line.includes('✅') || line.includes('success')) return 'log-success';
      if (line.includes('Processing') || line.includes('AI inference') || line.includes('📨')) return 'log-info';
      return '';
    }

    async function fetchVerboseStatus() {
      try {
        const r = await fetch('/api/konzola/status');
        const d = await r.json();
        appendToKonzolaLog('=== VERBOSE STATUS ===', 'log-info');
        appendToKonzolaLog('Daemon: ' + (d.daemon.status || '--') + ' | Uptime: ' + formatUptime(d.daemon.uptime), 'log-info');
        appendToKonzolaLog('Current Task: ' + (d.daemon.currentTask || 'None'), '');
        appendToKonzolaLog('Context: ' + (d.daemon.contextPct || 0) + '% | Pending: ' + (d.daemon.pendingMessages || 0) + ' | Processed: ' + (d.daemon.processedToday || 0), '');
        appendToKonzolaLog('RAG Saves: ' + (d.daemon.contextSavedToRAG || 0) + ' | Last: ' + (d.daemon.lastContextSave || 'Never'), '');
        appendToKonzolaLog('Last Activity: ' + (d.daemon.lastActivity || 'None'), '');
        appendToKonzolaLog('--- Services ---', 'log-info');
        const sv = d.services || {};
        Object.entries(sv).forEach(([name, s]) => {
          const st = s && s.status ? s.status : 'unknown';
          const cls = (st === 'running' || st === 'ok') ? 'log-success' : st === 'disabled' ? 'log-system' : 'log-error';
          const extra = s && s.pid ? ' (PID:' + s.pid + ')' : s && s.port ? ' (:' + s.port + ')' : '';
          appendToKonzolaLog('  ' + name + ': ' + st + extra, cls);
        });
        appendToKonzolaLog('WS Clients: ' + (d.wsClients || 0), '');
        appendToKonzolaLog('Mode: ' + (d.mode || '--').toUpperCase(), '');
        appendToKonzolaLog('=== END STATUS ===', 'log-info');
      } catch(e) { appendToKonzolaLog('Failed: ' + e.message, 'log-error'); }
    }

    async function toggleKonzolaMode(newMode) {
      try {
        const targetMode = (newMode || (konzolaMode === 'plan' ? 'work' : 'plan')).toUpperCase();
        // System-wide mode change — affects ALL agents, not just console
        const r = await fetch('/api/system/mode', {
          method: 'PUT', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ mode: targetMode, reason: 'UI toggle' })
        });
        const d = await r.json();
        konzolaMode = (d.mode || 'WORK').toLowerCase(); updateModeButton();
        appendToKonzolaLog('SYSTEM MODE switched to: ' + (d.mode || targetMode) + ' (system-wide — all agents)', 'log-info');
        // Also update old konzola mode for backward compat
        fetch('/api/konzola/mode', {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ mode: konzolaMode })
        }).catch(() => {});
      } catch(e) { appendToKonzolaLog('Mode switch failed: ' + e.message, 'log-error'); }
    }

    // Known command prefixes for smart routing
    const KNOWN_COMMANDS = ['ls','cat','head','tail','wc','grep','find','git','bun','node',
      'date','uptime','whoami','hostname','df','free','ps','top',
      'help','clear','status','verbose','info','mode','services','logs','history',
      'regoc-services','regoc-services.sh'];

    function isCommand(input) {
      // DVOSTRUKI backslash (v. gore): jednostruki bi dao /s+/, izraz koji dijeli po slovu
      // „s" — pa je „ls -la" davalo prvu rijec „l" i konzola bi ga poslala REGOCU kao
      // recenicu umjesto da ga izvede kao naredbu.
      const firstWord = input.split(/\\s+/)[0].toLowerCase();
      // Starts with / = explicit command prefix
      if (input.startsWith('/')) return true;
      // Starts with known command
      if (KNOWN_COMMANDS.includes(firstWord)) return true;
      // Starts with ./ or ~/ or / = path/command
      if (/^[.~\\/]/.test(input)) return true;
      // Otherwise it's natural language → message to REGOČ
      return false;
    }

    async function sendKonzolaMessage(text) {
      try {
        appendToKonzolaLog('📨 → REGOČ: ' + text, 'log-info');
        const r = await fetch('/api/konzola/message', {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ message: text })
        });
        const d = await r.json();
        if (d.error) { appendToKonzolaLog('❌ ' + d.error, 'log-error'); }
        else if (d.success) { appendToKonzolaLog('✅ ' + _Tv('knz_u_redu_cekanja', 'Queued ({id}). Daemon će obraditi poruku.', { id: d.messageId.substring(0,8) }), 'log-success'); }
      } catch(e) { appendToKonzolaLog('Error: ' + e.message, 'log-error'); }
    }

    function initKonzolaInput() {
      const input = document.getElementById('konzola-input');
      input.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter') {
          e.preventDefault(); // TASK-4722: unos je u <form> — bez ovoga Enter šalje obrazac
          const cmd = input.value.trim();
          if (!cmd) return;
          konzolaCommandHistory.push(cmd);
          konzolaHistoryIndex = konzolaCommandHistory.length;
          input.value = '';

          // Smart routing: command or message?
          if (isCommand(cmd)) {
            // Shell command path
            appendToKonzolaLog('$ ' + cmd, 'log-cmd');
            if (handleBuiltinCommand(cmd)) return;
            // Strip leading / for explicit command prefix
            const execCmd = cmd.startsWith('/') ? cmd.substring(1) : cmd;
            try {
              const r = await fetch('/api/konzola/exec', {
                method: 'POST', headers: {'Content-Type':'application/json'},
                body: JSON.stringify({ command: execCmd })
              });
              const d = await r.json();
              if (d.error) { appendToKonzolaLog(d.error, 'log-error'); }
              else {
                if (d.stdout) appendToKonzolaLog(d.stdout, '');
                if (d.stderr) appendToKonzolaLog(d.stderr, 'log-warn');
              }
            } catch(e) { appendToKonzolaLog('Error: ' + e.message, 'log-error'); }
          } else {
            // Natural language → send to REGOČ message queue
            await sendKonzolaMessage(cmd);
          }
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          if (konzolaHistoryIndex > 0) { konzolaHistoryIndex--; input.value = konzolaCommandHistory[konzolaHistoryIndex]; }
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          if (konzolaHistoryIndex < konzolaCommandHistory.length - 1) { konzolaHistoryIndex++; input.value = konzolaCommandHistory[konzolaHistoryIndex]; }
          else { konzolaHistoryIndex = konzolaCommandHistory.length; input.value = ''; }
        }
      });
    }

    function handleKonzolaWSMessage(data) {
      if (data.type === 'console_output') appendToKonzolaLog(data.text, data.level || '');
      if (data.type === 'console_mode_changed') { konzolaMode = data.mode; updateModeButton(); }
    }

    // ── Persistent agents panel ──
    async function loadPersistentPanel() {
      try {
        const [agentsRes, configRes] = await Promise.all([
          fetch('/api/agents').then(r => r.json()),
          fetch('/api/system/persistent').then(r => r.json())
        ]);
        const agents = agentsRes.agents || agentsRes.data || agentsRes;
        const config = configRes;
        const list = document.getElementById('persistent-agent-list');
        if (!list) return;
        const toggleable = agents.filter(a => !['klaudio','stribor','regoc'].includes(a.id));
        list.innerHTML = toggleable.map(a => {
          const isPersistent = a.persistent || (config.enabledAgents || []).includes(a.id);
          const color = isPersistent ? '#22c55e' : '#6b7280';
          const label = isPersistent ? 'PERSISTENT' : 'ON-DEMAND';
          const dot = a.alive ? '●' : '○';
          return '<div style="display:flex;justify-content:space-between;align-items:center;padding:2px 0;cursor:pointer" data-agent-id="' + a.id + '" onclick="toggleAgentPersistent(\\'' + a.id + '\\')">'
            + '<span>' + dot + ' ' + (a.name || a.id) + ' <span style="color:#475569;font-size:0.7rem">(' + (a.role || '') + ')</span></span>'
            + '<span style="color:' + color + ';font-size:0.7rem;font-weight:700">' + label + '</span>'
            + '</div>';
        }).join('');
        // Update button color
        const btn = document.getElementById('persistent-btn');
        if (config.persistentMode === 'off') { btn.style.borderColor = '#6b7280'; btn.style.color = '#6b7280'; btn.textContent = 'AGENTS'; }
        else if (config.persistentMode === 'selective') { btn.style.borderColor = '#f59e0b'; btn.style.color = '#f59e0b'; btn.textContent = 'AGENTS (' + (config.enabledAgents || []).length + ')'; }
        else { btn.style.borderColor = '#22c55e'; btn.style.color = '#22c55e'; btn.textContent = 'AGENTS (ALL)'; }
      } catch(e) { console.error('Persistent panel load failed:', e); }
    }

    window.toggleAgentPersistent = async function(agentId) {
      try {
        const configRes = await fetch('/api/system/persistent').then(r => r.json());
        const enabled = !(configRes.enabledAgents || []).includes(agentId);
        await fetch('/api/agents/' + agentId + '/persistent', {
          method: 'PUT', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ enabled })
        });
        appendToKonzolaLog(agentId + ' → ' + (enabled ? 'PERSISTENT' : 'ON-DEMAND'), 'log-info');
        loadPersistentPanel();
      } catch(e) { appendToKonzolaLog('Toggle failed: ' + e.message, 'log-error'); }
    };

    function initKonzola() {
      initKonzolaInput();
      fetchKonzolaStatus();
      if (konzolaStatusInterval) clearInterval(konzolaStatusInterval);
      konzolaStatusInterval = setInterval(fetchKonzolaStatus, 30000);
      fetchSessionUsage();                                 // potrošnja sesije: odmah…
      if (sessionUsageInterval) clearInterval(sessionUsageInterval);
      sessionUsageInterval = setInterval(fetchSessionUsage, 60000);  // …pa svake minute (+ na I/O u konzoli)
      document.getElementById('konzola-mode-btn').onclick = () => toggleKonzolaMode();
      document.getElementById('persistent-btn').onclick = () => {
        const panel = document.getElementById('persistent-panel');
        panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
        if (panel.style.display === 'block') loadPersistentPanel();
      };
      document.getElementById('persistent-all-btn').onclick = async () => {
        await fetch('/api/system/persistent', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({persistentMode:'full',enabledAgents:[]}) });
        appendToKonzolaLog('All agents → PERSISTENT', 'log-info');
        loadPersistentPanel();
      };
      document.getElementById('persistent-off-btn').onclick = async () => {
        await fetch('/api/system/persistent', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({persistentMode:'off',enabledAgents:[]}) });
        appendToKonzolaLog('All agents → ON-DEMAND', 'log-info');
        loadPersistentPanel();
      };
      document.getElementById('konzola-input').focus();
    }

    // ============================================
    // STATUS FUNCTIONALITY
    // ============================================

    let statusRefreshInterval = null;

    const MODEL_NAMES = {
      'claude-opus-4-5-20251101': 'Opus 4.5',
      'claude-opus-4-6-20250514': 'Opus 4.6',
      'claude-sonnet-4-5-20250929': 'Sonnet 4.5',
      'claude-sonnet-4-6-20250514': 'Sonnet 4.6',
      'claude-haiku-4-5-20251001': 'Haiku 4.5'
    };

    function fmtTokens(n) {
      if (!n) return '0';
      if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M';
      if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
      return String(n);
    }
    function fmtCost(usd) { return eur(usd || 0); }

    async function fetchStatusDashboard() {
      try {
        const r = await fetch('/api/status/dashboard');
        const d = await r.json();
        renderServiceHealth(d.services);
        renderSystemOverview(d.daemon, d);
        renderTokenUsage(d.tokens);
        renderProjectsAndTasks(d.tasks, d.projects);
        renderSchedulerQueue(d.scheduler);
        document.getElementById('status-last-updated').textContent = 'Updated: ' + new Date().toLocaleTimeString();
      } catch(e) { console.error('Status dashboard fetch failed:', e); }
    }

    function renderServiceHealth(services) {
      const grid = document.getElementById('status-service-grid');
      if (!services || Object.keys(services).length === 0) { grid.innerHTML = '<div class="empty">No service data</div>'; return; }
      grid.innerHTML = Object.entries(services).map(([name, s]) => {
        const st = (s && s.status) || 'unknown';
        return '<div class="service-badge"><span class="service-dot ' + st + '"></span><span>' + escapeHtml(name) + '</span><span style="margin-left:auto;font-size:0.7rem;color:var(--text-secondary)">' + st + '</span></div>';
      }).join('');
    }

    function renderSystemOverview(daemon, data) {
      const grid = document.getElementById('status-overview-grid');
      // Ista logika kao u konzolnoj traci — ploča i traka ne smiju tvrditi različito stanje.
      const dv = buildDaemonView(data && data.daemon ? data : { daemon: daemon || {} });
      const stateColor = dv.state === 'offline' ? 'var(--accent-red)' : dv.state === 'stale' ? 'var(--accent-yellow)' : null;
      const daemonTip = dv.taskText + (dv.title ? ' — ' + dv.title : '');
      const items = [
        { v: dv.uptimeText, l: 'Uptime', c: stateColor, t: daemonTip },
        { v: dv.statusText, l: 'Daemon', c: stateColor, t: daemonTip },
        { v: (daemon?.contextPct || 0) + '%', l: 'Context' },
        { v: String(daemon?.pendingMessages ?? 0), l: 'Pending' },
        { v: String(daemon?.processedToday ?? 0), l: 'Processed' },
        { v: String(data?.wsClients ?? 0), l: 'WS Clients' },
        { v: String(data?.tokens?.totalSessions ?? 0), l: 'Sessions' },
        { v: String(data?.tokens?.totalMessages ?? 0), l: 'Spawns' },
      ];
      grid.innerHTML = items.map(i => '<div class="stat-box"><div class="stat-value"' + (i.c ? ' style="color:' + i.c + '"' : '') + '>' + escapeHtml(String(i.v)) + '</div><div class="stat-label">' + i.l + '</div></div>').join('');
      // Tooltip se postavlja svojstvom, ne atributom: escapeHtml ne bježi navodnike,
      // pa bi razlog s navodnikom razbio atribut.
      const boxes = grid.querySelectorAll('.stat-box');
      items.forEach((i, ix) => { if (i.t && boxes[ix]) boxes[ix].title = i.t; });
    }

    function renderTokenUsage(tokens) {
      const el = document.getElementById('status-token-content');
      if (!tokens?.byModel || Object.keys(tokens.byModel).length === 0) { el.innerHTML = '<div class="empty">No token data</div>'; return; }
      // Izvor se ISPISUJE — ploča koja tiho servira mrtav keš je gora od prazne ploče.
      const src = tokens.source === 'cost_log'
        ? 'cost_log &middot; ' + _Tv('pot_zadnjih_n_dana', 'zadnjih {dana} dana', { dana: tokens.windowDays || 30 })
          + ' &middot; ' + _Tv('sta_n_zadataka', '{broj} zadataka', { broj: tokens.totalTasks ?? 0 })
        : tokens.source
          ? escapeHtml(String(tokens.source)) + (tokens.lastAt ? ' &middot; ' + _T('sta_zadnji_izracun', 'zadnji izračun') + ' ' + escapeHtml(String(tokens.lastAt)) : '')
          : _T('sta_nepoznat_izvor', 'nepoznat izvor');
      let totalIn = 0, totalOut = 0, totalCost = 0, totalCache = 0;
      let rows = '';
      for (const [model, d] of Object.entries(tokens.byModel)) {
        const name = MODEL_NAMES[model] || model.replace('claude-','').replace(/-\\d+$/,'');
        const inp = d.inputTokens || 0; const out = d.outputTokens || 0;
        const cost = d.costUSD || 0; const cache = d.cacheReadInputTokens || 0;
        totalIn += inp; totalOut += out; totalCost += cost; totalCache += cache;
        rows += '<tr><td>' + escapeHtml(name) + '</td><td>' + fmtTokens(inp) + '</td><td>' + fmtTokens(out) + '</td><td>' + fmtTokens(cache) + '</td><td>' + fmtCost(cost) + '</td></tr>';
      }
      rows += '<tr class="total-row"><td>TOTAL</td><td>' + fmtTokens(totalIn) + '</td><td>' + fmtTokens(totalOut) + '</td><td>' + fmtTokens(totalCache) + '</td><td>' + fmtCost(totalCost) + '</td></tr>';
      el.innerHTML = '<table class="token-table"><thead><tr><th>Model</th><th>Input</th><th>Output</th><th>Cache Read</th><th>Cost</th></tr></thead><tbody>' + rows + '</tbody></table>'
        + '<div style="margin-top:0.4rem;font-size:0.72rem;opacity:0.6;">' + _T('sta_izvor', 'izvor:') + ' ' + src + '</div>';
    }

    function renderProjectsAndTasks(tasks, projects) {
      const el = document.getElementById('status-projects-content');
      let html = '';

      // Task summary
      if (tasks && tasks.byStatus) {
        const bs = tasks.byStatus;
        html += '<div style="margin-bottom:0.75rem;font-size:0.85rem;">';
        html += '<strong>Tasks:</strong> ';
        const statuses = ['pending','in_progress','blocked','completed','cancelled'];
        const colors = {'pending':'#f59e0b','in_progress':'#3b82f6','blocked':'#ef4444','completed':'#22c55e','cancelled':'#6b7280'};
        html += statuses.filter(s => bs[s]).map(s => '<span style="color:' + colors[s] + '">' + (bs[s] || 0) + ' ' + s.replace('_',' ') + '</span>').join(' &middot; ');
        html += '</div>';
      }

      // Project summary
      if (projects?.stats?.byStatus) {
        const ps = projects.stats.byStatus;
        html += '<div style="margin-bottom:0.75rem;font-size:0.85rem;">';
        html += '<strong>Projects:</strong> ';
        html += Object.entries(ps).filter(([,v]) => v > 0).map(([k,v]) => v + ' ' + k).join(' &middot; ');
        html += '</div>';
      }

      // Active projects progress
      if (projects?.active?.length > 0) {
        html += '<div style="margin-top:0.5rem;">';
        for (const p of projects.active) {
          const pct = p.calculated_progress || 0;
          const color = pct >= 80 ? '#22c55e' : pct >= 40 ? '#f59e0b' : '#3b82f6';
          html += '<div class="project-progress-item">';
          html += '<div class="project-progress-name">' + escapeHtml(p.id + ' ' + (p.name || '')) + '</div>';
          html += '<div class="project-progress-bar"><div class="progress-bar-sm"><div class="progress-bar-sm-fill" style="width:' + pct + '%;background:' + color + '"></div></div></div>';
          html += '<div class="project-progress-pct" style="color:' + color + '">' + pct + '%</div>';
          html += '</div>';
        }
        html += '</div>';
      }

      el.innerHTML = html || '<div class="empty">No data</div>';
    }

    function renderSchedulerQueue(scheduler) {
      const el = document.getElementById('status-queue-content');
      if (!scheduler || Object.keys(scheduler).length === 0) { el.innerHTML = '<div class="empty">No scheduler data</div>'; return; }
      let html = '<div style="font-size:0.85rem;">';
      if (scheduler.activeTasks) html += '<div><strong>Active:</strong> ' + (scheduler.activeTasks?.length || 0) + ' &middot; <strong>Queued:</strong> ' + (scheduler.queuedTasks?.length || 0) + ' &middot; <strong>Completed:</strong> ' + (scheduler.completedTasks?.length || 0) + '</div>';
      if (scheduler.lastCheck) html += '<div style="color:var(--text-secondary);font-size:0.75rem;margin-top:0.25rem;">Last check: ' + new Date(scheduler.lastCheck).toLocaleTimeString() + '</div>';
      html += '</div>';
      el.innerHTML = html;
    }

    function initStatus() {
      fetchStatusDashboard();
      if (statusRefreshInterval) clearInterval(statusRefreshInterval);
      statusRefreshInterval = setInterval(fetchStatusDashboard, 30000);
      document.getElementById('status-refresh-btn').onclick = fetchStatusDashboard;
    }

    // ============================================
    // INFO TAB
    // ============================================

    function initInfo() {
      fetchInfoData();
      document.getElementById('info-refresh-btn').onclick = fetchInfoData;
    }

    async function fetchInfoData() {
      try {
        const [r, rAgents, rMetrics, rModels] = await Promise.all([
          fetch('/api/info'),
          fetch('/api/agents').catch(function() { return null; }),
          fetch('/api/metrics').catch(function() { return null; }),
          fetch('/api/models/available').catch(function() { return null; }),
        ]);
        if (!r.ok) throw new Error('API error');
        const d = await r.json();
        const agentsData = rAgents && rAgents.ok ? await rAgents.json() : null;
        const metricsData = rMetrics && rMetrics.ok ? await rMetrics.json() : null;
        const modelsData = rModels && rModels.ok ? await rModels.json() : null;
        renderInfoSystem(d);
        renderInfoProviders(d, agentsData);
        renderInfoAgents(d, modelsData);
        renderModelSetup(modelsData);
        loadClassifier();
        loadLoginProviders();
        loadDezurni();
        loadConcurrency();
        loadTelegram();
        loadUlaznaVrata();
        loadIntegracije();
        loadOrkestrator();
        renderInfoModules(d);
        renderInfoInfra(d);
        renderInfoDatabases(d);
        renderInfoComponents(d);
        renderInfoSkillsAndWorkflows(d);
        renderInfoRules(d);
        renderInfoMetrics(metricsData);
        loadRagBackend();
      } catch(e) {
        document.getElementById('info-system-content').innerHTML = '<div class="empty">Error loading info: ' + e.message + '</div>';
      }
    }

    function renderInfoSystem(d) {
      const s = d.system || {};
      document.getElementById('info-system-content').innerHTML =
        '<div class="info-version">REGOČ v' + (s.version||'?') + '</div>' +
        '<div class="info-subtitle">' + (s.fullName||'') + '</div>' +
        '<div class="info-kv"><span class="info-kv-label">' + _T('cfg_princip', 'Princip') + '</span><span class="info-kv-value">' + (s.principle||'') + '</span></div>' +
        '<div class="info-kv"><span class="info-kv-label">Orchestrator Model</span><span class="info-kv-value">' + (s.orchestratorModel||'') + '</span></div>' +
        '<div class="info-kv"><span class="info-kv-label">' + _T('cfg_agenti', 'Agenti') + '</span><span class="info-kv-value">' + (s.agentCount||0) + '</span></div>' +
        '<div class="info-kv"><span class="info-kv-label">' + _T('cfg_moduli', 'Moduli') + '</span><span class="info-kv-value">' + (s.moduleCount||0) + ' (' + (s.modulesEnabled||0) + ' enabled)</span></div>' +
        '<div class="info-kv"><span class="info-kv-label">' + _T('cfg_provideri', 'Provideri') + '</span><span class="info-kv-value">' + (s.providerCount||0) + ' active</span></div>' +
        '<div class="info-kv"><span class="info-kv-label">Platform</span><span class="info-kv-value">' + (s.platform||'') + '</span></div>';
    }

    function renderInfoProviders(d, agentsData) {
      const providers = d.providers || [];
      let h = '';
      providers.forEach(function(p) {
        const dot = p.online ? 'online' : 'offline';
        const badge = p.enabled ? (p.online ? 'enabled' : 'disabled') : 'disabled';
        const models = (p.models||[]).map(function(m){ return m.id + ' <span class="info-badge ' + m.tier + '">' + m.tier + '</span>'; }).join(', ');
        h += '<div class="info-provider-row">' +
          '<div class="info-dot ' + dot + '"></div>' +
          '<strong style="min-width:80px">' + p.name + '</strong>' +
          '<span class="info-badge ' + badge + '">' + (p.enabled ? (p.online ? 'online' : 'offline') : 'disabled') + '</span>' +
          '</div>';
        if (p.models && p.models.length > 0) {
          h += '<div style="padding-left:1.5rem;font-size:0.75rem;color:var(--text-secondary);margin-bottom:0.5rem">' + models + '</div>';
        }
      });
      if (agentsData && agentsData.agents) {
        var modelCounts = {};
        agentsData.agents.forEach(function(a) {
          var m = a.model || 'unknown';
          modelCounts[m] = (modelCounts[m] || 0) + 1;
        });
        h += '<div style="margin-top:0.75rem;padding-top:0.5rem;border-top:1px solid var(--border-color);font-size:0.75rem">' +
          '<strong style="color:var(--accent-blue)">Model Health</strong> &mdash; ' +
          agentsData.totalAgents + ' agents (' + agentsData.activeCount + ' active)';
        Object.keys(modelCounts).forEach(function(m) {
          h += ' &middot; <span style="font-family:monospace">' + m + '</span>: ' + modelCounts[m];
        });
        h += '</div>';
      }
      document.getElementById('info-providers-content').innerHTML = h || '<div class="empty">No providers</div>';
    }

    function modelSelectHTML(a, models) {
      if (a.fixed) {
        return '<span title="' + _esc(_T('cfg_fiksni_naslov', 'Trajni interface/glavna petlja (npr. Telegram servis, orkestrator) — model se ne bira ovdje; override se ne primjenjuje.')) + '" ' +
          'style="font-size:0.72rem;color:#8aa0b2;border:1px dashed #3a4a55;border-radius:4px;padding:2px 8px;background:#12283a;white-space:nowrap">' +
          '&#128274; ' + _T('cfg_fiksno', 'interface — fiksno') + ' <span style="color:#6b7d8c">(' + (a.currentModel||'?') + ')</span></span>';
      }
      var cur = a.override || '';
      var opts = '<option value="">⭐ ' + _T('cfg_zadano', 'zadano') + ' (' + (a.currentModel||'?') + ')</option>';
      (models||[]).forEach(function(m){
        var sel = (cur === m.spec) ? ' selected' : '';
        var tag = m.spawnable ? '' : ' · ' + _T('cfg_lokalno', 'lokalno');
        opts += '<option value="' + m.spec + '"' + sel + '>' + m.label + ' [' + m.tier + ']' + tag + '</option>';
      });
      var isLocal = cur && (models||[]).some(function(m){return m.spec===cur && !m.spawnable;});
      var ttl = isLocal ? ' title="' + _esc(_T('cfg_lokalni_model_naslov', 'Lokalni model (Ollama) preko API spawna — radi, ali tekstualno (bez alata: Bash/datoteke/MCP).')) + '"' : '';
      var style = 'font-size:0.72rem;padding:2px 4px;border-radius:4px;background:var(--bg-primary,#111);color:var(--text-primary,#ddd);border:1px solid var(--border-color,#333)';
      if (cur) style += ';border-color:' + (isLocal ? '#f59e0b' : 'var(--accent-blue,#3b82f6)');
      return '<select style="' + style + '"' + ttl + ' onchange="setAgentModel(\\'' + a.id + '\\', this.value, this)">' + opts + '</select>' +
        (cur ? ' <span style="font-size:0.65rem;color:' + (isLocal?'#f59e0b':'var(--accent-blue)') + '">' + _T('cfg_override', 'override') + (isLocal? ' (' + _T('cfg_lokalno', 'lokalno') + ')' : '') + '</span>' : '');
    }

    async function setAgentModel(agentId, spec, el) {
      try {
        if (el) el.disabled = true;
        var res = await fetch('/api/agents/' + encodeURIComponent(agentId) + '/model', {
          method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ model: spec })
        });
        var d = await res.json();
        if (!res.ok || d.error) throw new Error(d.error || 'save failed');
        fetchInfoData();
      } catch(e) {
        alert(_T('cfg_greska_spremanje_modela', 'Greška pri spremanju modela') + ': ' + e.message);
        if (el) el.disabled = false;
      }
    }

    // ── Dežurni (D4/TASK-4633) — model se bira ovdje, ne uređivanjem dezurni.json ────────
    var _dezurniGranice = null;
    // Zadnji odgovor /api/dezurni/config. Cuva se da promjena jezika ponovno iscrta panel
    // BEZ novog poziva: popis modela zna trajati sekundama, a jezik se mijenja u trenu.
    var _dezurniZadnji = null;

    // Promjena jezika ne smije ponovno zvati posluzitelja -- iscrtava se iz zadnjeg odgovora.
    function osvjeziDezurniJezik() {
      var el = document.getElementById('info-dezurni-content');
      if (!el || !_dezurniZadnji) return;   // panel jos nije ucitan -- nema sto prevesti
      el.innerHTML = renderDezurni(_dezurniZadnji);
    }

    async function loadDezurni() {
      var el = document.getElementById('info-dezurni-content');
      if (!el) return;
      try {
        var d = await (await fetch('/api/dezurni/config')).json();
        if (d.error) throw new Error(d.error);
        _dezurniGranice = d.granice || null;
        _dezurniZadnji = d;
        el.innerHTML = renderDezurni(d);
      } catch(e) {
        el.innerHTML = '<div class="empty">' +
          _Tv('dez_greska_citanja', 'Greška pri čitanju postavki dežurnog: {greska}',
                 { greska: _esc(e.message) }) + '</div>';
      }
    }

    function renderDezurni(d) {
      var p = d.postavke || {};
      var st = d.stanje || {};
      var g = d.granice || { okidac_uzastopnih_gresaka: { min:1, max:10 }, razmak_straze_min: { min:5, max:240 } };
      var znacka = st.dezurstvo
        ? '<span class="info-badge disabled" title="' + _esc(_T('dez_naslov_aktivno', 'Primarni model ne radi; dežurni odgovara na Telegramu.')) + '">' +
          _T('dez_dezurstvo_aktivno', 'dežurstvo AKTIVNO') +
          (st.od ? ' ' + _T('dez_od', 'od') + ' ' + String(st.od).replace('T',' ').slice(0,16) : '') + '</span>'
        : '<span class="info-badge enabled" title="' + _esc(_T('dez_naslov_pripravnost', 'Primarni put radi; dežurni čeka.')) + '">' +
          _T('dez_u_pripravnosti', 'u pripravnosti') + '</span>';
      var ukljucenZnacka = p.ukljucen
        ? '' : ' <span class="info-badge disabled" title="' + _esc(_T('dez_naslov_iskljucen', 'Okidač je isključen — dežurstvo se neće podići ni nakon praga grešaka.')) + '">' +
          _T('dez_iskljucen', 'isključen') + '</span>';

      var davatelj = String(p.provider || 'ollama').toLowerCase();
      var dav = d.davatelji || {};
      var opts = (d.modeli || []).map(function(m) {
        return '<option value="' + _esc(m) + '"' + (m === p.model ? ' selected' : '') + '>' + _esc(m) + '</option>';
      }).join('');
      var izvor = d.dostupno
        ? (davatelj === 'ollama'
            ? '<span style="color:var(--text-secondary)">' +
              _Tv('dez_izvor_ollama', 'živi popis s {url} ({broj} modela)',
                     { url: _esc(p.baseUrl), broj: (d.modeli||[]).length }) + '</span>'
            : '<span style="color:var(--text-secondary)">' +
              _Tv('dez_izvor_poznati', '{broj} poznatih modela — može se upisati i drugo ime',
                     { broj: (d.modeli||[]).length }) + '</span>')
        : '<span style="color:#f59e0b" title="' + _esc(d.greska) + '">' +
          _Tv('dez_izvor_greska', '{greska} — prikazan je samo trenutačno postavljen model',
                 { greska: _esc(d.greska || _T('dez_popis_nedostupan', 'popis nedostupan')) }) + '</span>';

      // Davatelji: uključeni u model-config.json I s oblikom poziva koji most zna. Nespremni
      // (nedostaje ključ) ostaju VIDLJIVI ali neizbirljivi — skriveni bi izgledali kao da ne
      // postoje, a izbirljivi bi značili dežurnog koji šuti baš u kvaru.
      var provOpts = (d.provideri || ['ollama']).map(function(id) {
        var info = dav[id] || {};
        var spreman = info.spreman !== false;
        var oznaka = id + (spreman ? '' : '  ⚠ '
          + (info.zasto ? _Tv(info.zastoKey || '', info.zasto, info.zastoVars || {})
                        : _T('dez_nije_spreman', 'nije spreman')));
        return '<option value="' + _esc(id) + '"' + (id === davatelj ? ' selected' : '') +
          (spreman ? '' : ' disabled') + '>' + _esc(oznaka) + '</option>';
      }).join('');
      var opisDavatelja = davatelj === 'anthropic'
        ? _T('dez_opis_anthropic', 'POZOR: Anthropic ide preko <code>claude -p</code> i troši ISTU kvotu koja je dežurnog i pozvala.')
        : (davatelj === 'ollama'
            ? _T('dez_opis_ollama', 'Lokalna Ollama — jedini davatelj koji radi bez ključa i bez interneta.')
            : _T('dez_opis_ostali', 'Izvor popisa: <code>models/model-config.json</code>. Ključ se čita iz <code>credentials.env</code>; vrijednost ploča nikad ne prikazuje.'));

      var h = '<div style="font-size:0.72rem;color:var(--text-secondary);margin-bottom:0.5rem">' +
        _Tv('dez_uvod',
          'Kad <code>claude -p</code> padne {n} puta zaredom, dežurni preuzima odgovaranje na Telegramu ' +
          'i javlja čim se primarni put vrati. Postavke se spremaju u <code>{putanja}</code> i ' +
          '<strong>vrijede odmah, bez ponovnog pokretanja</strong> — most i alat citaju datoteku pri svakom pozivu.',
          { n: (p.okidac_uzastopnih_gresaka||2), putanja: _esc(d.putanja) }) + ' ' +
        znacka + ukljucenZnacka + '</div>';

      h += '<table class="info-table"><tbody>';
      h += _red(_T('dez_davatelj', 'Davatelj'),
        '<select style="' + _stil() + ';min-width:220px" onchange="spremiDezurni({provider:this.value}, this)">' + provOpts + '</select>',
        opisDavatelja);
      h += _red(_T('dez_model', 'Model dežurnog'),
        '<select style="' + _stil() + ';min-width:220px" onchange="spremiDezurni({model:this.value}, this)">' + opts + '</select>' +
        ' <input id="dez-model-rucno" placeholder="' + _esc(_T('dez_upisi_ime_modela', 'ili upiši ime modela')) + '" style="' + _stil() + ';width:150px">' +
        ' <button class="cfg-btn" onclick="spremiDezurni({model:document.getElementById(\\'dez-model-rucno\\').value}, this)">' + _T('dez_spremi', 'Spremi') + '</button>',
        izvor);
      h += _red(_T('dez_provjera', 'Provjera'),
        '<button id="dez-proba" class="cfg-btn" onclick="probajDezurnog(this)">' + _T('dez_probni_poziv', 'Probni poziv') + '</button>' +
        ' <span id="dez-proba-ishod" style="font-size:.7rem"></span>',
        _T('dez_provjera_opis', 'Stvarno pozove odabranog davatelja preko istog mosta koji odgovara na Telegramu. Bez ovoga se pogrešan izbor otkrije tek u kvaru.'));
      h += _red(_T('dez_ollama_posluzitelj', 'Ollama poslužitelj'),
        '<input id="dez-baseurl" value="' + _esc(p.baseUrl) + '" style="' + _stil() + ';min-width:220px">' +
        ' <button class="cfg-btn" onclick="spremiDezurni({baseUrl:document.getElementById(\\'dez-baseurl\\').value}, this)">' + _T('dez_spremi', 'Spremi') + '</button>',
        _T('dez_ollama_posluzitelj_opis', 'Odakle se vuče popis modela i kamo idu pitanja dežurnog.'));
      h += _red(_T('dez_ukljuceno', 'Dežurstvo uključeno'),
        '<input type="checkbox"' + (p.ukljucen ? ' checked' : '') + ' onchange="spremiDezurni({ukljucen:this.checked}, this)">',
        _T('dez_ukljuceno_opis', 'Isključeno: greške se prijavljuju kao i prije, dežurni se ne javlja.'));
      if (davatelj !== 'ollama') {
        h += _red(_T('dez_napomena', 'Napomena'),
          '<span class="info-badge disabled">' + _esc(davatelj) + '</span>',
          _T('dez_napomena_opis',
            'Odabran je davatelj izvan lokalne mreže. Ako ne odgovori, dežurni šalje izmjerenu obavijest ' +
            '— nikad tiho ne prelazi na Ollamu, jer bi korisnik dobio tuđi odgovor pod tuđim potpisom.'));
      }
      h += _red(_T('dez_smije_podici', 'Smije podići servise'),
        '<input type="checkbox"' + (p.smije_podici ? ' checked' : '') + ' onchange="spremiDezurni({smije_podici:this.checked}, this)">',
        _T('dez_smije_podici_opis', 'Jedina radnja dežurnog s posljedicom. Isključeno: tipka <code>podigni</code> odbija restart i to kaže.'));
      h += _red(_T('dez_prag_gresaka', 'Prag uzastopnih grešaka'),
        '<input type="number" min="' + g.okidac_uzastopnih_gresaka.min + '" max="' + g.okidac_uzastopnih_gresaka.max + '" value="' + (p.okidac_uzastopnih_gresaka||2) + '" style="' + _stil() + ';width:70px" onchange="spremiDezurni({okidac_uzastopnih_gresaka:Number(this.value)}, this)">',
        _Tv('dez_prag_gresaka_opis', 'Jedna prolazna greška ne diže dežurstvo; {min}–{max}.',
               { min: g.okidac_uzastopnih_gresaka.min, max: g.okidac_uzastopnih_gresaka.max }));
      h += _red(_T('dez_razmak_straze', 'Razmak straže (min)'),
        '<input type="number" min="' + g.razmak_straze_min.min + '" max="' + g.razmak_straze_min.max + '" value="' + (p.razmak_straze_min||30) + '" style="' + _stil() + ';width:70px" onchange="spremiDezurni({razmak_straze_min:Number(this.value)}, this)">',
        _T('dez_razmak_straze_opis', 'Koliko često straža provjerava je li se primarni put vratio.'));
      h += '</tbody></table><div id="dez-poruka" style="font-size:.7rem;margin-top:.4rem;min-height:1em"></div>';
      return h;
    }

    function _stil() {
      return 'font-size:0.72rem;padding:2px 4px;border-radius:4px;background:var(--bg-primary,#111);color:var(--text-primary,#ddd);border:1px solid var(--border-color,#333)';
    }
    function _red(naziv, kontrola, opis) {
      return '<tr><td style="width:215px"><strong>' + naziv + '</strong></td>' +
        '<td class="cfg-kontrola">' + kontrola + '</td>' +
        '<td style="font-size:0.7rem;color:var(--text-secondary)">' + opis + '</td></tr>';
    }

    /** Podnaslov skupine unutar tablice kartice (npr. SMTP i IMAP unutar e-pošte). */
    function _redSkupina(naziv) {
      return '<tr class="cfg-skupina"><td colspan="3">' + naziv + '</td></tr>';
    }

    // Probni poziv: ishod se ispisuje doslovno, i kad je loš. Zeleno "spremljeno" bez ovoga
    // znači samo da je datoteka zapisana, a ne da davatelj odgovara.
    async function probajDezurnog(el) {
      var ishod = document.getElementById('dez-proba-ishod');
      if (el) { el.disabled = true; }
      if (ishod) ishod.innerHTML = '<span style="color:var(--text-secondary)">' + _T('dez_zovem', 'zovem…') + '</span>';
      try {
        var d = await (await fetch('/api/dezurni/proba', { method: 'POST' })).json();
        if (ishod) {
          ishod.innerHTML = d.ok
            ? '<span style="color:var(--accent-green,#22c55e)">' +
              _Tv('dez_radi', 'RADI — {model} za {ms} ms: {odgovor}', {
                model: _esc(d.provider + '/' + d.model), ms: d.ms,
                odgovor: _esc(String(d.odgovor||'').slice(0,120)),
              }) + '</span>'
            : '<span style="color:var(--accent-red,#ef4444)">' +
              _Tv('dez_ne_radi', 'NE RADI — {greska}',
                     { greska: _esc(d.greska || _T('dez_bez_odgovora', 'bez odgovora')) }) + '</span>';
        }
      } catch(e) {
        if (ishod) ishod.innerHTML = '<span style="color:var(--accent-red,#ef4444)">' +
          _Tv('dez_proba_nije_prosla', 'proba nije prošla: {greska}',
                 { greska: _esc(e.message) }) + '</span>';
      }
      if (el) el.disabled = false;
    }

    async function spremiDezurni(zakrpa, el) {
      var poruka = document.getElementById('dez-poruka');
      if (el) el.disabled = true;
      try {
        var res = await fetch('/api/dezurni/config', {
          method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(zakrpa)
        });
        var d = await res.json();
        if (!res.ok || d.error) throw new Error(d.error || _T('dez_spremanje_nije_uspjelo', 'spremanje nije uspjelo'));
        // Potvrda se pise TEK nakon ponovnog iscrtavanja: loadDezurni mijenja innerHTML
        // cijele kartice, pa bi poruka ispisana prije toga nestala u istom dahu.
        // (Backtick u komentaru ovdje zatvara predlozak u kojem cijela ploca zivi.)
        await loadDezurni();
        var svjeza = document.getElementById('dez-poruka');
        if (svjeza) svjeza.innerHTML = '<span style="color:var(--accent-green,#22c55e)">' +
          _Tv('dez_spremljeno', 'Spremljeno — vrijedi odmah, bez restarta ({vrijeme})',
                 { vrijeme: new Date().toLocaleTimeString() }) + '</span>';
      } catch(e) {
        if (poruka) poruka.innerHTML = '<span style="color:var(--accent-red,#ef4444)">' +
          _Tv('dez_nije_spremljeno', 'Nije spremljeno: {greska}',
                 { greska: _esc(e.message) }) + '</span>';
        if (el) el.disabled = false;
      }
    }


    // ── Telegram obavijesti (Kosjenka, 09.09.2026.) — bot token + chat id u paketu ──────
    var _telegramZadnji = null;

    function osvjeziTelegramJezik() {
      var el = document.getElementById('info-telegram-content');
      if (!el || !_telegramZadnji) return;
      el.innerHTML = renderTelegram(_telegramZadnji);
    }

    async function loadTelegram() {
      var el = document.getElementById('info-telegram-content');
      if (!el) return;
      try {
        var d = await (await fetch('/api/telegram/config')).json();
        if (d.error) throw new Error(d.error);
        // Stanje ulazne petlje je ZASEBAN izvor (data/telegram-poller.json), ne konfiguracija.
        try { d.ulazStanje = await (await fetch('/api/telegram/ulaz/stanje')).json(); } catch (e2) { d.ulazStanje = {}; }
        _telegramZadnji = d;
        el.innerHTML = renderTelegram(d);
      } catch(e) {
        el.innerHTML = '<div class="empty">' +
          _Tv('tel_greska_citanja', 'Greška pri čitanju Telegram postavki: {greska}',
                 { greska: _esc(e.message) }) + '</div>';
      }
    }

    function renderTelegram(d) {
      var p = d.postavke || {};
      var st = d.stanje || {};
      var znacka = p.ukljucen
        ? '<span class="info-badge enabled">' + _T('tel_aktivno', 'aktivno') + '</span>'
        : '<span class="info-badge disabled">' + _T('tel_iskljuceno', 'isključeno') + '</span>';

      // Kartica NE dobiva vrijednost tokena (revizija TASK-4801, B2) — samo stanje.
      // Zato prikaz zna reci JE LI postavljen, a polje za unos je uvijek prazno: ono sto
      // se ne posalje pregledniku ne moze ni procuriti iz njega.
      var tokenPrikaz = st.tokenPostavljen
        ? '<span style="color:var(--text-secondary)">' +
          _T('tel_token_postavljen', 'token je postavljen (vrijednost se ne prikazuje)') + '</span>'
        : '<span style="color:#f59e0b">' + _T('tel_token_nema', 'token NIJE postavljen') + '</span>';

      var h = '<div style="font-size:0.72rem;color:var(--text-secondary);margin-bottom:0.5rem">' +
        _Tv('tel_uvod',
          'Slanje obavijesti o završenim/neuspjelim zadacima na Telegram. Postavke se spremaju u ' +
          '<code>{putanja}</code> i vrijede odmah, bez ponovnog pokretanja.',
          { putanja: _esc(d.putanja || '') }) + ' ' + znacka + '</div>';

      h += '<table class="info-table"><tbody>';
      h += _red(_T('tel_ukljuceno', 'Telegram uključen'),
        '<input type="checkbox"' + (p.ukljucen ? ' checked' : '') + ' onchange="spremiTelegram({ukljucen:this.checked}, this)">',
        _T('tel_ukljuceno_opis', 'Isključeno: nikakve poruke se ne šalju.'));
      h += _red(_T('tel_bot_token', 'Bot token'),
        '<input id="tel-token" type="password" value="" style="' + _stil() + ';min-width:280px" placeholder="' +
          (st.tokenPostavljen ? _T('tel_token_zamjena', 'upisi novi token samo ako ga mijenjas') : '123456:ABC-DEF...') + '">' +
        ' <button class="cfg-btn" onclick="spremiTelegram({botToken:document.getElementById(\\'tel-token\\').value}, this)">' + _T('tel_spremi', 'Spremi') + '</button>',
        tokenPrikaz);
      h += _red(_T('tel_chat_id', 'Chat ID'),
        '<input id="tel-chatid" value="' + _esc(p.chatId || '') + '" style="' + _stil() + ';min-width:220px" placeholder="-1001234567890">' +
        ' <button class="cfg-btn" onclick="spremiTelegram({chatId:document.getElementById(\\'tel-chatid\\').value}, this)">' + _T('tel_spremi', 'Spremi') + '</button>',
        _T('tel_chat_id_opis', 'ID grupe ili kanala kojem se šalju obavijesti.'));
      h += _red(_T('tel_obavijest_zavrseno', 'Obavijest: završeno'),
        '<input type="checkbox"' + (p.obavijestZavrseno ? ' checked' : '') + ' onchange="spremiTelegram({obavijestZavrseno:this.checked}, this)">',
        _T('tel_obavijest_zavrseno_opis', 'Šalje poruku kad zadatak prijeđe u completed.'));
      h += _red(_T('tel_obavijest_greska', 'Obavijest: greška'),
        '<input type="checkbox"' + (p.obavijestGreska ? ' checked' : '') + ' onchange="spremiTelegram({obavijestGreska:this.checked}, this)">',
        _T('tel_obavijest_greska_opis', 'Šalje poruku kad zadatak prijeđe u failed/error.'));
      h += _red(_T('tel_prefix', 'Prefix poruke'),
        '<input id="tel-prefix" value="' + _esc(p.prefix || '') + '" style="' + _stil() + ';width:80px">' +
        ' <button class="cfg-btn" onclick="spremiTelegram({prefix:document.getElementById(\\'tel-prefix\\').value}, this)">' + _T('tel_spremi', 'Spremi') + '</button>',
        _T('tel_prefix_opis', 'Emoji ili kratki tekst koji prethodi poruci.'));
      h += _red(_T('tel_provjera', 'Provjera'),
        '<button id="tel-proba" class="cfg-btn" onclick="probajTelegram(this)">' + _T('tel_probni_slanje', 'Probno slanje') + '</button>' +
        ' <span id="tel-proba-ishod" style="font-size:.7rem"></span>',
        _T('tel_provjera_opis', 'Pošalje testnu poruku na postavljeni chat ID.'));
      h += '</tbody></table>';
      h += renderTelegramUlaz(d);
      return h;
    }

    // ── Telegram ULAZ (TASK-4800) — poruka → POST /api/ingest ──────────────────────────
    // Ulaz se pali ODVOJENO od izlaza: bot koji sam otvara zadatke iz svake poruke koju
    // vidi je iznenađenje, ne značajka.
    function renderTelegramUlaz(d) {
      var u = (d.postavke && d.postavke.ulaz) || {};
      var s = d.ulazStanje || {};
      var znacka = s.zaustavljen
        ? '<span class="info-badge" style="background:#ef444422;color:#ef4444">' + _T('tel_ulaz_stao', 'zaustavljen') + '</span>'
        : (s.radi
          ? '<span class="info-badge enabled">' + _T('tel_ulaz_radi', 'radi') + '</span>'
          : '<span class="info-badge disabled">' + _T('tel_ulaz_stoji', 'stoji') + '</span>');

      var h = '<div style="margin-top:0.8rem;padding-top:0.5rem;border-top:1px solid var(--border-color)">';
      h += '<div style="font-size:0.74rem;font-weight:600;margin-bottom:0.3rem">' +
        _T('tel_ulaz_naslov', 'Ulaz — poruka postaje zadatak') + ' ' + znacka + '</div>';
      h += '<div style="font-size:0.7rem;color:var(--text-secondary);margin-bottom:0.4rem">' +
        _T('tel_ulaz_uvod',
          'Poller čita poruke bota i šalje ih na POST /api/ingest. O tome hoće li poruka ' +
          'postati zadatak odlučuju Ulazna vrata (pragovi i položaj po izvoru), ne poller.') + '</div>';
      h += '<table class="info-table"><tbody>';
      h += _red(_T('tel_ulaz_ukljucen', 'Ulaz uključen'),
        '<input type="checkbox"' + (u.ukljucen ? ' checked' : '') +
        ' onchange="spremiTelegram({ulaz:{ukljucen:this.checked}}, this)">',
        _T('tel_ulaz_ukljucen_opis', 'Odvojeno od izlaznih obavijesti.'));
      h += _red(_T('tel_ulaz_interval', 'Razmak (s)'),
        '<input id="tel-ulaz-interval" type="number" value="' + (u.intervalSek || 3) + '" style="' + _stil() + ';width:80px">' +
        ' <button class="cfg-btn" onclick="spremiTelegram({ulaz:{intervalSek:Number(document.getElementById(\\'tel-ulaz-interval\\').value)}}, this)">' + _T('tel_spremi', 'Spremi') + '</button>',
        '1–60');
      h += _red(_T('tel_ulaz_okidac', 'Okidač'),
        '<input id="tel-ulaz-okidac" value="' + _esc(u.okidac || '') + '" style="' + _stil() + ';width:160px" placeholder="/zadatak">' +
        ' <button class="cfg-btn" onclick="spremiTelegram({ulaz:{okidac:document.getElementById(\\'tel-ulaz-okidac\\').value}}, this)">' + _T('tel_spremi', 'Spremi') + '</button>',
        _T('tel_ulaz_okidac_opis', 'Prazno = svaka poruka. Inače samo poruke koje počinju ovim nizom.'));
      h += _red(_T('tel_ulaz_chatovi', 'Dopušteni chatovi'),
        '<input id="tel-ulaz-chatovi" value="' + _esc((u.dopusteniChatovi || []).join(', ')) + '" style="' + _stil() + ';min-width:260px" placeholder="-1001234567890">' +
        ' <button class="cfg-btn" onclick="spremiTelegramChatovi(this)">' + _T('tel_spremi', 'Spremi') + '</button>',
        _T('tel_ulaz_chatovi_opis', 'Prazno = sve što bot vidi. Chat ID doznaješ gumbom „Probaj ulaz".'));
      h += _red(_T('tel_ulaz_potvrda', 'Potvrda u chat'),
        '<input type="checkbox"' + (u.potvrdaUChat ? ' checked' : '') +
        ' onchange="spremiTelegram({ulaz:{potvrdaUChat:this.checked}}, this)">',
        _T('tel_ulaz_potvrda_opis', 'Vrati broj otvorenog zadatka u isti razgovor.'));
      h += _red(_T('tel_ulaz_stanje', 'Stanje petlje'),
        '<span style="font-family:monospace;font-size:.7rem">offset ' + (s.offset || 0) +
        ' · ' + _T('tel_ulaz_obradeno', 'obrađeno') + ' ' + (s.obradeno || 0) +
        ' · ' + _T('tel_ulaz_preskoceno', 'preskočeno') + ' ' + (s.preskoceno || 0) + '</span>',
        s.zaustavljenRazlog ? '⛔ ' + _esc(s.zaustavljenRazlog)
          : (s.zadnjaGreska ? '⚠️ ' + _esc(s.zadnjaGreska) : ''));
      h += _red(_T('tel_ulaz_provjera', 'Provjera ulaza'),
        '<button class="cfg-btn" onclick="probajTelegramUlaz(this)">' + _T('tel_ulaz_probaj', 'Probaj ulaz') + '</button>' +
        ' <span id="tel-ulaz-ishod" style="font-size:.7rem"></span>',
        _T('tel_ulaz_probaj_opis', 'Pokaže koliko poruka čeka i iz kojih chatova — bez otvaranja zadatka.'));
      h += '</tbody></table></div>';
      return h;
    }

    function spremiTelegramChatovi(btn) {
      var el = document.getElementById('tel-ulaz-chatovi');
      var popis = el.value.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
      return spremiTelegram({ ulaz: { dopusteniChatovi: popis } }, btn);
    }

    async function probajTelegramUlaz(btn) {
      btn.disabled = true;
      var ishod = document.getElementById('tel-ulaz-ishod');
      if (ishod) { ishod.textContent = '...'; ishod.style.color = ''; }
      try {
        var d = await (await fetch('/api/telegram/ulaz/proba', { method: 'POST' })).json();
        if (ishod) {
          if (d.ok) {
            var opis = (d.chatovi || []).map(function (c) { return c.naziv + ' (' + c.id + ')'; }).join(', ');
            ishod.textContent = '✅ ' + (d.cekaPoruka || 0) + ' ' + _T('tel_ulaz_ceka', 'poruka čeka') +
              (opis ? ' — ' + opis : '');
            ishod.style.color = '#22c55e';
          } else {
            ishod.textContent = '❌ ' + (d.greska || 'greška');
            ishod.style.color = '#ef4444';
          }
        }
      } catch (e) {
        if (ishod) { ishod.textContent = '❌ ' + e.message; ishod.style.color = '#ef4444'; }
      }
      btn.disabled = false;
    }

    async function spremiTelegram(zakrpa, btn) {
      if (btn) btn.disabled = true;
      try {
        var res = await fetch('/api/telegram/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(zakrpa),
        });
        var d = await res.json();
        if (d.error) throw new Error(d.error);
        await loadTelegram();
      } catch(e) {
        alert('Telegram: ' + e.message);
      }
      if (btn) btn.disabled = false;
    }

    async function probajTelegram(btn) {
      btn.disabled = true;
      var ishod = document.getElementById('tel-proba-ishod');
      if (ishod) ishod.textContent = '...';
      try {
        var res = await fetch('/api/telegram/proba', { method: 'POST' });
        var d = await res.json();
        if (ishod) {
          ishod.textContent = d.ok ? '✅ ' + _T('tel_poslano', 'poslano') : '❌ ' + _esc(d.greska || 'greška');
          ishod.style.color = d.ok ? '#22c55e' : '#ef4444';
        }
      } catch(e) {
        if (ishod) { ishod.textContent = '❌ ' + e.message; ishod.style.color = '#ef4444'; }
      }
      btn.disabled = false;
    }

    // ── Integracije (TASK-4800) — Nextcloud, e-pošta, GitLab, GitHub ───────────────────
    // Jedna kartica, četiri odjeljka. Polja se crtaju IZ POSTAVKI (tip vrijednosti), pa
    // dodavanje polja u modul ne traži izmjenu ploče — i ne može se dogoditi da ploča
    // nudi polje koje provjera odbija, ili obrnuto.
    var _integracijeZadnje = null;

    var INT_IKONA = { nextcloud: '☁', email: '✉', gitlab: '◆', github: '●' };
    var INT_OPIS = {
      nextcloud: 'cfg_int_opis_nextcloud',
      email: 'cfg_int_opis_email',
      gitlab: 'cfg_int_opis_gitlab',
      github: 'cfg_int_opis_github'
    };

    async function loadIntegracije() {
      var el = document.getElementById('info-integracije-content');
      if (!el) return;
      try {
        var sazetak = await (await fetch('/api/integracije')).json();
        if (sazetak.error) throw new Error(sazetak.error);
        var puni = [];
        for (var i = 0; i < sazetak.integracije.length; i++) {
          var ime = sazetak.integracije[i].ime;
          var d = await (await fetch('/api/' + ime + '/config')).json();
          puni.push(d);
        }
        _integracijeZadnje = { sazetak: sazetak.integracije, puni: puni };
        el.innerHTML = renderIntegracije(_integracijeZadnje);
      } catch (e) {
        el.innerHTML = '<div class="empty">' + _esc(e.message) + '</div>';
      }
    }

    function _intZnacka(z) {
      if (z === 'radi') return '<span class="info-badge enabled">' + _T('int_znacka_radi', 'radi') + '</span>';
      if (z === 'nepotpuno') return '<span class="info-badge" style="background:#f59e0b22;color:#f59e0b">' + _T('int_znacka_nepotpuno', 'nepotpuno') + '</span>';
      return '<span class="info-badge disabled">' + _T('int_znacka_iskljuceno', 'isključeno') + '</span>';
    }

    function _intZasto(st) {
      var k = st && st.zastoKey ? st.zastoKey : '';
      var zadano = {
        int_zasto_spreman: 'sve je podešeno',
        int_zasto_iskljucen: 'isključeno',
        int_zasto_nema_adrese: 'nedostaje adresa poslužitelja',
        int_zasto_nema_korisnika: 'nedostaje korisničko ime',
        int_zasto_nema_repozitorija: 'nedostaje naziv repozitorija',
        int_zasto_nema_primatelja: 'nema nijednog primatelja',
        int_zasto_nepotpun_ulaz: 'ulazni (IMAP) dio nije potpun',
        int_zasto_treba_kljuc: 'tajna nije postavljena',
        int_zasto_treba_knjiznica: 'nedostaje neobavezna knjižnica',
        int_zasto_cli: 'koristi se tvoja vlastita prijava u CLI-ju',
        int_zasto_greska: 'postavke se ne mogu pročitati'
      };
      var t = _T(k, zadano[k] || k);
      if (st && st.zastoVars) {
        for (var v in st.zastoVars) t = t.replace('{' + v + '}', st.zastoVars[v]);
        if (k === 'int_zasto_treba_kljuc') t = t + ' (' + st.zastoVars.env + ')';
        if (k === 'int_zasto_treba_knjiznica') t = t + ' (bun add ' + st.zastoVars.paket + ')';
      }
      return t;
    }

    /**
     * Jedno polje → jedan redak. Tip dolazi IZ SHEME modula (/api/<ime>/config), ne iz
     * tipa zatečene vrijednosti (TASK-4803).
     *
     * Zašto: dok se čitao samo tip vrijednosti, polje „smjer" s tri dopuštene vrijednosti
     * (izlaz/ulaz/oba) izgledalo je kao slobodan tekst, pa je ploča nudila unos koji
     * provjera na poslužitelju odbija. Iz sheme se čita i je li polje obvezno — dosad se
     * to nije vidjelo nigdje, nego se otkrivalo tek po tome što proba ne prolazi.
     */
    function _intPolje(ime, kljuc, vrijednost, staza, shemaPolja) {
      var sp = shemaPolja || {};
      // DVOSTRUKI backslash: predlozak u kojem ova skripta zivi pojede jednostruki, pa
      // bi u stranicu otisao izraz /./g — koji pogada SVAKI znak. Mjereno prije ispravka:
      // sva su polja dobila id od samih crtica (int-nextcloud--------), pa su se poklopila
      // dva razlicita polja iste duljine imena i „Spremi" je citao TUDU vrijednost.
      var id = 'int-' + ime + '-' + staza.replace(/\\./g, '-');
      var naziv = _T('cfg_polje_' + kljuc, kljuc) + (sp.obavezno
        ? '<span class="cfg-obavezno" title="' + _esc(_T('cfg_obavezno_naslov', 'obavezno polje')) + '">*</span>'
        : '');
      var poziv = function (tip) {
        return 'spremiIntegracijuIzPolja(\\'' + ime + '\\', \\'' + staza + '\\', \\'' + id + '\\', \\'' + tip + '\\', this)';
      };
      var spremi = function (tip) {
        return ' <button class="cfg-btn" onclick="' + poziv(tip) + '">' + _T('tel_spremi', 'Spremi') + '</button>';
      };

      if (sp.tip === 'izbor' && sp.vrijednosti) {
        var opcije = sp.vrijednosti.map(function (v) {
          return '<option value="' + _esc(v) + '"' + (v === vrijednost ? ' selected' : '') + '>' +
            _esc(_T('cfg_vrijednost_' + v, v)) + '</option>';
        }).join('');
        return _red(naziv,
          '<select style="' + _stil() + ';min-width:150px" onchange="spremiIntegraciju(\\'' + ime + '\\', \\'' + staza + '\\', this.value, this)">' + opcije + '</select>',
          _T('cfg_polje_izbor_opis', 'Vrijednost iz zadanog popisa.'));
      }
      if (sp.tip === 'bool' || typeof vrijednost === 'boolean') {
        return _red(naziv,
          '<input type="checkbox"' + (vrijednost ? ' checked' : '') +
          ' onchange="spremiIntegraciju(\\'' + ime + '\\', \\'' + staza + '\\', this.checked, this)">', '');
      }
      if (sp.tip === 'broj' || typeof vrijednost === 'number') {
        var granice = (sp.min != null ? ' min="' + sp.min + '"' : '') + (sp.max != null ? ' max="' + sp.max + '"' : '');
        return _red(naziv,
          '<input id="' + id + '" type="number"' + granice + ' value="' + vrijednost + '" style="' + _stil() + ';width:110px">' + spremi('broj'),
          sp.min != null && sp.max != null ? sp.min + '–' + sp.max : '');
      }
      if (sp.tip === 'popis' || Object.prototype.toString.call(vrijednost) === '[object Array]') {
        return _red(naziv,
          '<input id="' + id + '" value="' + _esc((vrijednost || []).join(', ')) + '" style="' + _stil() + ';min-width:260px" placeholder="' + _T('cfg_zarezom', 'odvojeno zarezom') + '">' + spremi('popis'),
          _T('cfg_zarezom', 'odvojeno zarezom'));
      }
      var tajna = sp.tajnaEnv || /Env$/.test(kljuc);
      var opis = tajna ? _T('cfg_polje_env_opis', 'IME varijable okoline s tajnom — sama tajna NIKAD ne ide ovdje.') : '';
      return _red(naziv,
        '<input id="' + id + '" value="' + _esc(String(vrijednost == null ? '' : vrijednost)) + '" style="' + _stil() + ';min-width:260px">' + spremi('tekst'),
        opis);
    }

    function renderIntegracije(d) {
      var h = '<div style="font-size:0.72rem;color:var(--text-secondary);margin-bottom:0.6rem">' +
        _T('cfg_int_uvod',
          'Spajanje na TVOJE servise. Postavke nose adrese i IMENA varijabli okoline — ' +
          'lozinke i tokeni idu u config/credentials.env (prava 0600), nikad u JSON.') + '</div>' +
        '<div class="cfg-legenda">' +
        '<span class="cfg-obavezno">*</span> ' +
        _T('cfg_legenda_obavezno',
          'obavezno polje — bez njega integracija ne može raditi. Sve ostalo je neobavezno ' +
          'i ima zadanu vrijednost.') + '</div>';

      for (var i = 0; i < d.puni.length; i++) {
        var p = d.puni[i];
        var s = d.sazetak[i];
        var ime = p.ime;
        h += '<div class="cfg-odjeljak">';
        h += '<div class="cfg-odjeljak-glava">' +
          '<span>' + INT_IKONA[ime] + '</span><strong>' + _esc(p.naziv) + '</strong>' +
          _intZnacka(s.znacka) +
          '<span style="font-size:.7rem;color:var(--text-secondary)">' + _esc(_intZasto(p.stanje)) + '</span>' +
          '</div>';
        h += '<div style="font-size:.7rem;color:var(--text-secondary);margin-bottom:0.3rem">' +
          _T(INT_OPIS[ime], '') + '</div>';
        h += '<table class="info-table"><tbody>';
        var sh = p.shema || {};
        for (var k in p.postavke) {
          if (k.charAt(0) === '_') continue;
          var v = p.postavke[k];
          if (v && typeof v === 'object' && Object.prototype.toString.call(v) !== '[object Array]') {
            // Ugnijezdena skupina (npr. smtp i imap) dobiva podnaslov. Bez njega su se dva
            // polja imena Host nizala jedno ispod drugoga bez icega sto bi ih razlikovalo.
            h += _redSkupina(_T('cfg_skupina_' + k, k.toUpperCase()));
            for (var k2 in v) h += _intPolje(ime, k2, v[k2], k + '.' + k2, (sh[k] && sh[k].polja) ? sh[k].polja[k2] : null);
          } else {
            h += _intPolje(ime, k, v, k, sh[k]);
          }
        }
        var zadnja = p.zadnjaProba
          ? (p.zadnjaProba.ok ? '✅ ' : '❌ ') + _esc(p.zadnjaProba.ts.slice(0, 19).replace('T', ' ')) +
            (p.zadnjaProba.greska ? ' — ' + _esc(p.zadnjaProba.greska) : '')
          : _T('cfg_int_nema_probe', 'nije još probano');
        h += _red(_T('tel_provjera', 'Provjera'),
          '<button class="cfg-btn" onclick="probajIntegraciju(\\'' + ime + '\\', this)">' + _T('cfg_int_probaj', 'Probaj konekciju') + '</button>' +
          ' <span id="int-' + ime + '-ishod" style="font-size:.7rem"></span>',
          zadnja);
        h += '</tbody></table>';
        h += '<div style="font-size:.68rem;color:var(--text-secondary);margin-top:0.3rem">' +
          _T('cfg_datoteka', 'datoteka') + ': <code>' + _esc(p.putanja) + '</code></div>';
        h += '</div>';
      }
      return h;
    }

    function _zakrpaZaStazu(staza, vrijednost) {
      var dijelovi = staza.split('.');
      if (dijelovi.length === 1) { var o = {}; o[dijelovi[0]] = vrijednost; return o; }
      var vanjski = {}; var unutarnji = {};
      unutarnji[dijelovi[1]] = vrijednost;
      vanjski[dijelovi[0]] = unutarnji;
      return vanjski;
    }

    async function spremiIntegraciju(ime, staza, vrijednost, btn) {
      if (btn) btn.disabled = true;
      try {
        var res = await fetch('/api/' + ime + '/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(_zakrpaZaStazu(staza, vrijednost))
        });
        var d = await res.json();
        if (d.error) throw new Error(d.error);
        await loadIntegracije();
      } catch (e) {
        alert(ime + ': ' + e.message);
        if (btn) btn.disabled = false;
      }
    }

    function spremiIntegracijuIzPolja(ime, staza, id, tip, btn) {
      var el = document.getElementById(id);
      if (!el) return;
      var v = el.value;
      if (tip === 'broj') v = Number(v);
      if (tip === 'popis') v = v.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
      return spremiIntegraciju(ime, staza, v, btn);
    }

    async function probajIntegraciju(ime, btn) {
      btn.disabled = true;
      var ishod = document.getElementById('int-' + ime + '-ishod');
      if (ishod) { ishod.textContent = '...'; ishod.style.color = ''; }
      try {
        var d = await (await fetch('/api/' + ime + '/proba', { method: 'POST' })).json();
        if (ishod) {
          ishod.textContent = d.ok ? '✅ ' + _T('cfg_int_radi', 'veza radi') : '❌ ' + (d.greska || 'greška');
          ishod.style.color = d.ok ? '#22c55e' : '#ef4444';
        }
      } catch (e) {
        if (ishod) { ishod.textContent = '❌ ' + e.message; ishod.style.color = '#ef4444'; }
      }
      btn.disabled = false;
    }

    // ── Orkestrator (TASK-4800 / ADR-0001) — sloj 1 ─────────────────────────────────────
    async function loadOrkestrator() {
      var el = document.getElementById('info-orkestrator-content');
      if (!el) return;
      try {
        var d = await (await fetch('/api/orchestrator/config')).json();
        if (d.error) throw new Error(d.error);
        el.innerHTML = renderOrkestrator(d);
      } catch (e) {
        el.innerHTML = '<div class="empty">' + _esc(e.message) + '</div>';
      }
    }

    function renderOrkestrator(d) {
      var p = d.postavke || {};
      var st = d.stanje || {};
      var znacka = st.ukljucen
        ? '<span class="info-badge enabled">' + _T('orc_aktivno', 'uključen') + '</span>'
        : '<span class="info-badge disabled">' + _T('orc_iskljuceno', 'isključen') + '</span>';

      var h = '<div style="font-size:0.72rem;color:var(--text-secondary);margin-bottom:0.5rem">' +
        _T('orc_uvod',
          'Sloj koji sam uzima zadatke s ploče i pokreće agenta na njima. Svježa instalacija ' +
          'ga NE pali sama. Pokretanje: bun scripts/orchestrator.ts (v. docs/INSTALL.md).') +
        ' ' + znacka + '</div>';

      h += '<table class="info-table"><tbody>';
      h += _red(_T('orc_ukljucen', 'Orkestrator uključen'),
        '<input type="checkbox"' + (p.enabled ? ' checked' : '') +
        ' onchange="spremiOrkestrator({enabled:this.checked}, this)">',
        _T('orc_ukljucen_opis', 'Isključeno: nijedan agent se ne pokreće sam.'));
      h += _red(_T('orc_strop', 'Najviše usporednih agenata'),
        '<b>' + (d.strop != null ? d.strop : '') + '</b>',
        _T('cfg_usp_napomena', 'Promjena vrijedi odmah (daemon je čita najkasnije za 5 s). Smanjenje ne prekida agente koji rade — samo ne pušta nove. Vrata autonomije (70/85 %) i dalje nadjačavaju strop.') +
        ' → ' + _T('cfg_kartica_usporedni', 'Usporedni agenti (1–10)'));
      h += _red(_T('orc_ploca', 'Adresa ploče'),
        '<input id="orc-api" value="' + _esc(p.api ? p.api.baseUrl : '') + '" style="' + _stil() + ';min-width:240px">' +
        ' <button class="cfg-btn" onclick="spremiOrkestrator({api:{baseUrl:document.getElementById(\\'orc-api\\').value}}, this)">' + _T('tel_spremi', 'Spremi') + '</button>',
        _T('orc_ploca_opis', 'Adresa preko koje orkestrator i agenti pišu na ploču.'));
      h += _red(_T('orc_cinjenice', 'Činjenice o infrastrukturi'),
        '<input id="orc-facts" value="' + _esc((p.prompt && p.prompt.systemFacts ? p.prompt.systemFacts : []).join(' | ')) + '" style="' + _stil() + ';min-width:320px" placeholder="' + _T('orc_cinjenice_ph', 'npr. Ollama: http://…:11434 | RAG: http://…:8000') + '">' +
        ' <button class="cfg-btn" onclick="spremiOrkestratorCinjenice(this)">' + _T('tel_spremi', 'Spremi') + '</button>',
        _T('orc_cinjenice_opis', 'Rečenice koje ulaze u prompt agenta. Odvoji ih znakom |. Paket svoje nema.'));
      h += _red(_T('orc_agenti', 'Agenata u registru'),
        '<strong>' + (d.agenata || 0) + '</strong>',
        _T('orc_agenti_opis', 'config/agents.json — bez ijednog agenta orkestrator ne pokreće ništa.'));
      h += _red(_T('orc_izvodaci', 'Izvođača podešeno'),
        '<strong>' + (st.brojIzvodaca || 0) + '</strong>',
        _T('orc_izvodaci_opis', 'CLI ili HTTP; podešavaju se u orchestrator.json → executors.'));
      var w = p.watchdog || {};
      h += _red(_T('orc_cistaci', 'Čistači (zombi / stale)'),
        '<span style="font-family:monospace">' + _esc((w.zombie ? w.zombie.mode : '?') + ' / ' + (w.stale ? w.stale.mode : '?')) + '</span>',
        _T('orc_cistaci_opis', 'off → shadow → live. U sjeni se sud zapisuje, ali se ništa ne dira.'));
      h += '</tbody></table>';
      h += '<div style="font-size:.68rem;color:var(--text-secondary);margin-top:0.3rem">' +
        _T('cfg_datoteka', 'datoteka') + ': <code>' + _esc(d.putanja || '') + '</code></div>';
      return h;
    }

    async function spremiOrkestrator(zakrpa, btn) {
      if (btn) btn.disabled = true;
      try {
        var res = await fetch('/api/orchestrator/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(zakrpa)
        });
        var d = await res.json();
        if (d.error) throw new Error(d.error);
        await loadOrkestrator();
      } catch (e) {
        alert('Orkestrator: ' + e.message);
        if (btn) btn.disabled = false;
      }
    }

    function spremiOrkestratorCinjenice(btn) {
      var el = document.getElementById('orc-facts');
      var popis = el.value.split('|').map(function (x) { return x.trim(); }).filter(Boolean);
      return spremiOrkestrator({ prompt: { systemFacts: popis } }, btn);
    }

    // ── Usporedni agenti — strop spawnova, vrijedi uživo (orkestrator čita ≤5 s) ─────────
    async function loadConcurrency() {
      var el = document.getElementById('info-concurrency-content');
      if (!el) return;
      try {
        var d = await (await fetch('/api/config/concurrency')).json();
        if (d.error) throw new Error(d.error);
        el.innerHTML = renderConcurrency(d);
      } catch(e) {
        el.innerHTML = '<div class="empty">' + _T('cfg_usp_greska', 'Greška pri čitanju stropa') + ': ' + _esc(e.message) + '</div>';
      }
    }

    function renderConcurrency(d) {
      var h = (d.history || []).slice(0, 5).map(function(r) {
        return '<li>' + _esc(r.changedAt || '') + ' — ' + _esc(String(r.oldValue == null ? '—' : r.oldValue)) +
          ' → ' + _esc(String(r.newValue)) + ' (' + _esc(r.changedBy) + ', ' + _esc(r.source) + ')</li>';
      }).join('');
      return '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">' +
        '<label for="usp-strop">' + _T('cfg_usp_oznaka', 'Usporedni agenti') + '</label>' +
        '<input id="usp-strop" type="range" min="' + d.min + '" max="' + d.max + '" value="' + d.maxConcurrent + '" ' +
          'oninput="document.getElementById(&quot;usp-vrijednost&quot;).textContent=this.value">' +
        '<b id="usp-vrijednost">' + d.maxConcurrent + '</b>' +
        '<button class="cfg-btn" onclick="spremiConcurrency(this)">' + _T('tel_spremi', 'Spremi') + '</button>' +
        '<span id="usp-zauzeto" title="' + _T('cfg_usp_zauzeto_title', 'zauzeta mjesta / strop') + '">' +
          _T('cfg_usp_zauzeto', 'Zauzeto') + ': <b>' + d.active + '/' + d.maxConcurrent + '</b></span>' +
        '</div>' +
        '<div style="opacity:.75;font-size:12px;margin-top:6px">' +
          _T('cfg_usp_napomena', 'Promjena vrijedi odmah (daemon je čita najkasnije za 5 s). Smanjenje ne prekida agente koji rade — samo ne pušta nove. Vrata autonomije (70/85 %) i dalje nadjačavaju strop.') +
          (d.updatedBy ? '<br>' + _T('cfg_usp_zadnje', 'Zadnja promjena') + ': ' + _esc(d.updatedBy) + ', ' + _esc(d.updatedAt || '') : '') +
          (d.envDeprecated ? '<br>⚠️ ' + _esc(d.envDeprecated) : '') +
        '</div>' +
        (h ? '<ul style="font-size:12px;opacity:.75;margin:6px 0 0 16px">' + h + '</ul>' : '');
    }

    async function spremiConcurrency(btn) {
      var v = Number(document.getElementById('usp-strop').value);
      if (btn) btn.disabled = true;
      try {
        var res = await fetch('/api/config/concurrency', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ maxConcurrent: v, source: 'config' })
        });
        var d = await res.json();
        if (!res.ok || d.error) throw new Error(d.error || 'save failed');
        await loadConcurrency();
      } catch(e) {
        alert(_T('cfg_usp_greska_spremanje', 'Greška pri spremanju stropa') + ': ' + e.message);
        if (btn) btn.disabled = false;
      }
    }

    // ── Ulazna vrata (U1/TASK-4261) — prekidač po grupi s TRI položaja ──────────────────
    // Kvačica ne pokriva uvođenje: "sjena" znači da poruka ide kao danas, ali se zapisuje
    // što bi se otvorilo. Zato radio-skupina od tri, a ne checkbox.
    async function loadUlaznaVrata() {
      var el = document.getElementById('info-ulaz-content');
      if (!el) return;
      try {
        var d = await (await fetch('/api/ingest-gate')).json();
        if (d.error) throw new Error(d.error);
        el.innerHTML = renderUlaznaVrata(d);
      } catch(e) {
        el.innerHTML = '<div class="empty">' + _T('cfg_ulaz_greska_citanja', 'Greška pri čitanju ulaznih vrata') + ': ' + _esc(e.message) + '</div>';
      }
    }

    function _ulazOpisNacina(n) {
      if (n === 'off') return _T('cfg_ulaz_opis_off', 'kao danas — poruka ide izravno u claude -p, ploča se ne dira');
      if (n === 'shadow') return _T('cfg_ulaz_opis_shadow', 'sjena — poruka ide kao danas, ali se zapisuje što bi se otvorilo');
      return _T('cfg_ulaz_opis_on', 'uključeno — poruka ide kroz ploču: zadatak → projekt → izvršitelj → trošak');
    }

    function _ulazPrekidac(chat, trenutni, ugasen) {
      var nazivi = { off: _T('cfg_ulaz_off', 'isključeno'), shadow: _T('cfg_ulaz_shadow', 'sjena'), on: _T('cfg_ulaz_on', 'uključeno') };
      var h = '<span style="display:inline-flex;gap:2px;border:1px solid var(--border-color,#333);border-radius:6px;padding:2px">';
      ['off','shadow','on'].forEach(function(n) {
        var sel = (trenutni === n);
        var boja = sel ? (n === 'on' ? '#22c55e' : (n === 'shadow' ? '#f59e0b' : '#64748b')) : 'transparent';
        h += '<label title="' + _esc(_ulazOpisNacina(n)) + '" style="cursor:pointer;font-size:.68rem;padding:2px 8px;border-radius:4px;background:' + boja +
          ';color:' + (sel ? '#0b1720' : 'var(--text-secondary,#8aa0b2)') + (sel ? ';font-weight:700' : '') + (ugasen ? ';opacity:.55' : '') + '">' +
          '<input type="radio" style="display:none" name="ulaz-' + _esc(chat) + '" data-chat="' + _esc(chat) + '" value="' + n + '"' +
          (sel ? ' checked' : '') + ' onchange="spremiUlazNacin(this)">' + nazivi[n] + '</label>';
      });
      return h + '</span>';
    }

    function renderUlaznaVrata(d) {
      var p = d.postavke || {};
      var grupe = d.grupe || {};
      var perGroup = p.perGroup || {};
      var projPoGrupi = p.projectByGroup || {};
      var g = d.granice || { pragA:{min:1,max:100}, pragB:{min:1,max:100}, pragC:{min:1,max:100} };
      var ugasen = !p.enabled;

      var kljucevi = Object.keys(perGroup);
      Object.keys(projPoGrupi).forEach(function(k) { if (kljucevi.indexOf(k) < 0) kljucevi.push(k); });
      Object.keys(grupe).forEach(function(k) { if (kljucevi.indexOf(k) < 0) kljucevi.push(k); });

      var h = '<div style="font-size:0.72rem;color:var(--text-secondary);margin-bottom:0.5rem">' +
        _Tv('cfg_ulaz_uvod',
          'Kako telegramska poruka ulazi u ploču — <strong>po grupi, tri položaja</strong> (isključeno / sjena / uključeno). ' +
          'Postavke se spremaju u <code>{putanja}</code> i <strong>vrijede odmah, bez ponovnog pokretanja</strong> — ' +
          'i most i ploča čitaju datoteku pri svakom prolazu. Ručna kočnica (pravilo 17) i dalje zaustavlja sve. ',
          { putanja: _esc(d.putanja) }) +
        (ugasen
          ? '<span class="info-badge disabled" title="' + _esc(_T('cfg_ulaz_globalno_naslov', 'Globalna sklopka je isključena — sve grupe se ponašaju kao isključene.')) + '">' + _T('cfg_ulaz_globalno_off', 'globalno isključeno') + '</span>'
          : '<span class="info-badge enabled">' + _T('cfg_ulaz_globalno_on', 'globalno uključeno') + '</span>') +
        '</div>';

      h += '<table class="info-table"><tbody>';
      h += _red(_T('cfg_ulaz_ukljucena', 'Ulazna vrata uključena'),
        '<input type="checkbox"' + (p.enabled ? ' checked' : '') + ' onchange="spremiUlaz({enabled:this.checked}, this)">',
        _T('cfg_ulaz_ukljucena_opis', 'Isključeno: sve grupe rade kao danas, bez obzira na položaj prekidača ispod.'));
      h += '</tbody></table>';

      h += '<table class="info-table" style="margin-top:.4rem"><thead><tr>' +
        '<th style="text-align:left;font-size:.68rem;width:215px">' + _T('cfg_ulaz_stupac_grupa', 'Grupa') + '</th>' +
        '<th style="text-align:left;font-size:.68rem;width:290px">' + _T('cfg_ulaz_stupac_prekidac', 'Prekidač') + '</th>' +
        '<th style="text-align:left;font-size:.68rem">' + _T('cfg_ulaz_stupac_projekt', 'Zadani projekt grupe') + '</th></tr></thead><tbody>';
      kljucevi.forEach(function(chat) {
        var naziv = grupe[chat] ? grupe[chat] : _T('cfg_ulaz_grupa', 'grupa');
        var nacin = perGroup[chat] || 'off';
        h += '<tr><td><strong>' + _esc(naziv) + '</strong><br><span style="font-size:.66rem;color:var(--text-secondary)">' + _esc(chat) + '</span></td>' +
          '<td>' + _ulazPrekidac(chat, nacin, ugasen) + '</td>' +
          '<td>' + _ulazProjektIzbor(chat, projPoGrupi[chat] || '', d.projekti || []) + '</td></tr>';
      });
      h += '</tbody></table>';

      h += '<div style="margin-top:.5rem;display:flex;gap:6px;align-items:center;flex-wrap:wrap">' +
        '<input id="ulaz-nova-grupa" placeholder="' + _esc(_T('cfg_ulaz_nova_grupa_ph', 'chatId nove grupe (npr. -5245252755)')) + '" style="' + _stil() + ';width:230px">' +
        '<button class="cfg-btn" onclick="dodajUlazGrupu(this)">' + _T('cfg_ulaz_dodaj_grupu', 'Dodaj grupu') + '</button>' +
        '<span style="font-size:.66rem;color:var(--text-secondary)">' + _T('cfg_ulaz_nova_grupa_opis', 'Nova grupa kreće na <b>isključeno</b> — nikad sama.') + '</span></div>';

      h += '<table class="info-table" style="margin-top:.5rem"><tbody>';
      h += _red(_T('cfg_ulaz_prag_a', 'Prag A — otvara se zadatak'),
        '<input type="number" min="' + g.pragA.min + '" max="' + g.pragA.max + '" value="' + p.pragA + '" style="' + _stil() + ';width:70px" onchange="spremiUlaz({pragA:Number(this.value)}, this)">',
        _T('cfg_ulaz_prag_a_opis', 'Ispod praga (pozdrav, pitanje) odgovor ide odmah i ploča ostaje čista. Zadano 16 (E2).'));
      h += _red(_T('cfg_ulaz_prag_b', 'Prag B — puni lanac'),
        '<input type="number" min="' + g.pragB.min + '" max="' + g.pragB.max + '" value="' + p.pragB + '" style="' + _stil() + ';width:70px" onchange="spremiUlaz({pragB:Number(this.value)}, this)">',
        _T('cfg_ulaz_prag_b_opis', 'Ispod praga zadatak dobiva jednog izvršitelja; iznad ide istraživanje → plan → izvedba → provjera. Zadano 36 (E3).'));
      h += _red(_T('cfg_ulaz_prag_c', 'Prag C — potvrda plana'),
        '<input type="number" min="' + g.pragC.min + '" max="' + g.pragC.max + '" value="' + p.pragC + '" style="' + _stil() + ';width:70px" onchange="spremiUlaz({pragC:Number(this.value)}, this)">',
        _T('cfg_ulaz_prag_c_opis', 'Iznad praga plan se šalje na odobrenje, zadatci se otvaraju tek na approve. Zadano 81 (E5).'));
      h += '</tbody></table>';
      h += '<div style="font-size:.66rem;color:var(--text-secondary);margin-top:.3rem">' + _T('cfg_ulaz_pragovi_rastu', 'Pragovi moraju rasti: A ≤ B ≤ C.') + '</div>';
      h += '<div id="ulaz-poruka" style="font-size:.7rem;margin-top:.4rem;min-height:1em"></div>';
      return h;
    }

    function _ulazProjektIzbor(chat, trenutni, projekti) {
      var opts = '<option value=""' + (trenutni ? '' : ' selected') + '>&mdash; ' + _T('cfg_ulaz_bez_zadanog', 'bez zadanog (pretinac PRJ-033)') + '</option>';
      var popis = projekti.slice();
      if (trenutni && popis.indexOf(trenutni) < 0) popis.unshift(trenutni);
      popis.forEach(function(pid) {
        opts += '<option value="' + _esc(pid) + '"' + (pid === trenutni ? ' selected' : '') + '>' + _esc(pid) + '</option>';
      });
      return '<select data-chat="' + _esc(chat) + '" style="' + _stil() + ';min-width:220px" onchange="spremiUlazProjekt(this)">' + opts + '</select>';
    }

    // chatId ide kroz data-atribut, ne kroz onclick argument — tako u predlošku nema
    // ugniježđenih navodnika koje bi minus u chatId-u ionako preživio, ali čitatelj ne bi.
    function spremiUlazNacin(el) {
      var m = {}; m[el.getAttribute('data-chat')] = el.value;
      spremiUlaz({ perGroup: m }, el);
    }
    function spremiUlazProjekt(el) {
      var m = {}; m[el.getAttribute('data-chat')] = el.value === '' ? null : el.value;
      spremiUlaz({ projectByGroup: m }, el);
    }
    function dodajUlazGrupu(btn) {
      var polje = document.getElementById('ulaz-nova-grupa');
      var chat = polje ? String(polje.value || '').trim() : '';
      if (!/^-?[0-9]{5,20}$/.test(chat)) {
        var pk = document.getElementById('ulaz-poruka');
        if (pk) pk.innerHTML = '<span style="color:var(--accent-red,#ef4444)">' + _T('cfg_ulaz_chatid_broj', 'chatId mora biti broj (npr. -5245252755)') + '</span>';
        return;
      }
      var m = {}; m[chat] = 'off';
      spremiUlaz({ perGroup: m }, btn);
    }

    async function spremiUlaz(zakrpa, el) {
      var poruka = document.getElementById('ulaz-poruka');
      if (el) el.disabled = true;
      try {
        var res = await fetch('/api/ingest-gate', {
          method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(zakrpa)
        });
        var d = await res.json();
        if (!res.ok || d.error) throw new Error(d.error || _T('spremanje_nije_uspjelo', 'spremanje nije uspjelo'));
        // Potvrda se ispisuje TEK nakon ponovnog iscrtavanja — loadUlaznaVrata mijenja
        // innerHTML cijele kartice, pa bi ranija poruka nestala u istom dahu.
        await loadUlaznaVrata();
        var svjeza = document.getElementById('ulaz-poruka');
        if (svjeza) svjeza.innerHTML = '<span style="color:var(--accent-green,#22c55e)">' + _T('cfg_ulaz_spremljeno', 'Spremljeno — vrijedi odmah, bez restarta') + ' (' + new Date().toLocaleTimeString() + ')</span>';
      } catch(e) {
        if (poruka) poruka.innerHTML = '<span style="color:var(--accent-red,#ef4444)">' + _T('cfg_ulaz_nije_spremljeno', 'Nije spremljeno') + ': ' + _esc(e.message) + '</span>';
        if (el) el.disabled = false;
      }
    }

    async function loadLoginProviders() {
      var el = document.getElementById('info-login-content');
      if (!el) return;
      try {
        var d = await (await fetch('/api/providers/login/status')).json();
        el.innerHTML = '<div style="font-size:.7rem;color:var(--text-secondary);margin-bottom:.5rem">' + _T('cfg_login_uvod', 'Klikni <b>Login</b> → <b>Copy link</b> → otvori link na bilo kojem računalu i prijavi se. Ako login traži kod, zalijepi ga natrag. Nakon prijave provider se pojavi u listi modela agenata.') + '</div>'
          + (d.providers||[]).map(renderLoginRow).join('');
      } catch(e){ el.innerHTML = '<div class="empty">' + _T('cfg_greska', 'Greška') + ': '+e.message+'</div>'; }
    }
    function renderLoginRow(p) {
      var badge = p.loggedIn ? '<span class="info-badge enabled">' + _T('cfg_login_prijavljen', 'prijavljen') + '</span>'
        : (p.installed ? '<span class="info-badge disabled">' + _T('cfg_login_nije_prijavljen', 'nije prijavljen') + '</span>' : '<span class="info-badge disabled">' + _T('cfg_login_nije_instaliran', 'nije instaliran') + '</span>');
      var h = '<div style="border:1px solid var(--border-color);border-radius:6px;padding:0.6rem;margin-bottom:0.5rem">';
      h += '<div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap"><strong>'+p.name+'</strong>'+badge+'<span style="margin-left:auto;display:flex;gap:6px">';
      if (p.loggedIn) h += '<button class="cfg-btn" onclick="doLogout(\\''+p.id+'\\','+(p.apikey?1:0)+')">' + _T('cfg_login_odjava', 'Odjava') + '</button>';
      else if (p.kind==='oauth-cli' && p.installed) h += '<button class="cfg-btn" onclick="doLoginStart(\\''+p.id+'\\')">Login</button>';
      h += '</span></div><div id="login-body-'+p.id+'" style="margin-top:.4rem"></div>';
      if (p.id==='geminicli') h += '<div style="font-size:.66rem;color:#f59e0b;margin-top:.3rem">' + _T('cfg_login_gemini_oauth', 'Google je ukinuo besplatni OAuth (Code Assist) za CLI — koristi <b>API ključ</b> s aistudio.google.com/apikey (besplatan tier).') + '</div>';
      if (p.apikey && !p.loggedIn) {
        var _ph = p.id==='geminicli' ? 'GEMINI_API_KEY (AIza...)' : _T('cfg_api_kljuc', 'API ključ') + ' (sk-or-...)';
        h += '<div style="display:flex;gap:6px;margin-top:.4rem"><input id="login-key-'+p.id+'" type="password" autocomplete="new-password" data-form-type="other" data-lpignore="true" data-1p-ignore placeholder="'+_ph+'" class="cfg-polje" style="flex:1"><button class="cfg-btn" onclick="doApikey(\\''+p.id+'\\')">' + _T('cfg_login_spremi_kljuc', 'Spremi ključ') + '</button></div>';
      }
      if (!p.installed && p.installCmd) h += '<div style="font-size:.66rem;color:var(--text-secondary);margin-top:.3rem">' + _T('cfg_login_instaliraj', 'Nije instaliran. Instaliraj (Sigurnost→internet ON):') + ' <code>'+p.installCmd+'</code></div>';
      h += '</div>';
      return h;
    }
    async function doLoginStart(id) {
      var body = document.getElementById('login-body-'+id); if(!body) return;
      body.innerHTML = _T('cfg_login_pokrecem', 'Pokrećem prijavu…');
      try {
        var d = await (await fetch('/api/providers/login/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id})})).json();
        if (d.error){ body.innerHTML='<span style="color:var(--accent-red)">'+(d.error==='not-installed'? _T('cfg_login_nije_instaliran_tocka', 'Nije instaliran.') :d.error)+'</span>'; return; }
        renderLoginActive(id, d.url); pollLogin(id);
      } catch(e){ body.innerHTML='<span style="color:var(--accent-red)">'+e.message+'</span>'; }
    }
    function renderLoginActive(id, urlv) {
      var body = document.getElementById('login-body-'+id); if(!body) return;
      var h = '';
      if (urlv) {
        h += '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap"><input id="login-url-'+id+'" value="'+urlv+'" readonly style="flex:1;min-width:220px;font-size:.7rem;padding:3px 5px">';
        h += '<button class="cfg-btn" onclick="copyLoginLink(\\''+id+'\\')">📋 Copy link</button>';
        h += '<a href="'+urlv+'" target="_blank" rel="noopener" style="font-size:.72rem;padding:4px 8px">' + _T('cfg_login_otvori', 'Otvori') + '</a></div>';
        h += '<div style="font-size:.66rem;color:var(--text-secondary);margin-top:.3rem">' + _T('cfg_login_otvori_opis', 'Otvori link na bilo kojem računalu i odobri. Ako CLI traži kod, zalijepi ga ispod.') + '</div>';
      } else { h += '<div style="font-size:.7rem;color:var(--text-secondary)">' + _T('cfg_login_cekam_link', 'Čekam link…') + '</div>'; }
      h += '<div style="display:flex;gap:6px;margin-top:.4rem"><input id="login-paste-'+id+'" autocomplete="off" data-form-type="other" data-lpignore="true" data-1p-ignore placeholder="' + _esc(_T('cfg_login_zalijepi_kod', 'Zalijepi kod (ako login traži)')) + '" style="flex:1;font-size:.72rem;padding:3px 5px"><button onclick="doPaste(\\''+id+'\\')" style="font-size:.72rem;padding:4px 8px">' + _T('cfg_posalji', 'Pošalji') + '</button></div>';
      h += '<div id="login-status-'+id+'" style="font-size:.66rem;color:var(--text-secondary);margin-top:.3rem"></div>';
      body.innerHTML = h;
    }
    function copyLoginLink(id){ var el=document.getElementById('login-url-'+id); if(el){ el.select(); if(navigator.clipboard) navigator.clipboard.writeText(el.value); var s=document.getElementById('login-status-'+id); if(s)s.textContent=_T('cfg_login_link_kopiran', 'Link kopiran.'); } }
    async function doPaste(id){ var v=document.getElementById('login-paste-'+id); if(!v)return; try{ await fetch('/api/providers/login/paste',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id,code:v.value})}); var s=document.getElementById('login-status-'+id); if(s)s.textContent=_T('cfg_login_kod_poslan', 'Kod poslan, čekam potvrdu…'); }catch(e){} }
    var loginPollTimers = {};
    function pollLogin(id){
      clearInterval(loginPollTimers[id]); var tries=0;
      loginPollTimers[id]=setInterval(async function(){
        tries++;
        try {
          var d = await (await fetch('/api/providers/login/poll?id='+encodeURIComponent(id))).json();
          var s=document.getElementById('login-status-'+id);
          var u=document.getElementById('login-url-'+id);
          if (d.url && u && !u.value) u.value=d.url;
          if (d.loggedIn){ clearInterval(loginPollTimers[id]); if(s)s.textContent='✅ ' + _T('cfg_login_uspjesna', 'Prijava uspješna.'); setTimeout(fetchInfoData, 800); return; }
          if (d.done && !d.loggedIn){ clearInterval(loginPollTimers[id]); if(s)s.textContent=_T('cfg_login_prekinuta', 'Prijava prekinuta/neuspješna.'); return; }
        } catch(e){}
        if (tries>150){ clearInterval(loginPollTimers[id]); }
      }, 2000);
    }
    async function doApikey(id){ var k=document.getElementById('login-key-'+id); if(!k||!k.value.trim())return; try{ var d=await (await fetch('/api/providers/login/apikey',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id,key:k.value.trim()})})).json(); if(d.error)throw new Error(d.error); fetchInfoData(); }catch(e){ alert(_T('cfg_greska', 'Greška') + ': '+e.message); } }
    // Odjava davatelja s API ključem BRIŠE tajnu koju je korisnik ručno unio (nije isto što
    // i OAuth odjava, koja miče samo keširan token) — zato drukčije pitanje (TASK-4796).
    async function doLogout(id, imaKljuc){
      var pitanje = imaKljuc
        ? _Tv('cfg_login_odjava_kljuc_pitanje', 'Odjaviti {id}? Ovo BRIŠE spremljeni API ključ — za povratak ga moraš unijeti ponovno.', { id: id })
        : _Tv('cfg_login_odjaviti_pitanje', 'Odjaviti {id}?', { id: id });
      if(!confirm(pitanje))return;
      try{
        var d = await (await fetch('/api/providers/login/logout',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id})})).json();
        if(d && d.ok===false) alert(_T('cfg_login_odjava_neuspjela', 'Odjava nije uspjela — vjerodajnica je i dalje spremljena.'));
        fetchInfoData();
      }catch(e){}
    }

    // ── Klasifikacijski model (TASK-2635) ────────────────────────────────────────
    // ODVOJENO od dropdowna po agentu: taj bira model kojim agent RADI, a ovaj model
    // kojim REGOČ RUTIRA svaku dolaznu poruku. Rutiranje mora ostati brzo i lokalno,
    // pa su ponuđeni samo Ollama modeli.
    async function loadClassifier() {
      var el = document.getElementById('info-classifier-content');
      if (!el) return;
      try {
        var d = await (await fetch('/api/models/classifier')).json();
        if (d.error && !d.models) throw new Error(d.error);
        el.innerHTML = renderClassifier(d);
      } catch(e) {
        el.innerHTML = '<div class="empty">' + _T('cfg_klas_greska_citanje', 'Greška pri čitanju klasifikatora') + ': ' + _esc(e.message) + '</div>';
      }
    }

    function renderClassifier(d) {
      var izvor = { 'process-env': _Tv('cfg_klas_izvor_env', 'okolina procesa ({kljuc})', { kljuc: _esc(d.envKey) }), 'config': 'model-config.json → componentOverrides.classifier', 'default': _T('cfg_klas_izvor_zadani', 'ugrađeni zadani') }[d.source] || d.source;
      var h = '<div style="font-size:0.72rem;color:var(--text-secondary);margin-bottom:0.5rem">' +
        _Tv('cfg_klas_uvod',
          'REGOČ na <strong>svaku</strong> poruku pokreće klasifikaciju/rutiranje. To NIJE isto što i model kojim agent radi ' +
          '(to je dropdown u tablici agenata gore). Klasifikator mora ostati <strong>brz i lokalan</strong> pa su ponuđeni samo Ollama modeli. ' +
          'Sprema se u <code>{kljuc}</code> (spremište vjerodajnica) i u <code>componentOverrides.classifier</code>; ' +
          'config vrijedi odmah, okolina tek nakon restarta procesa.', { kljuc: _esc(d.envKey) }) + '</div>';
      h += '<div style="display:flex;gap:0.6rem;flex-wrap:wrap;align-items:center;font-size:0.72rem">';
      h += '<span class="info-dot ' + (d.reachable ? 'online' : 'offline') + '"></span>';
      h += '<span style="color:var(--text-secondary)">Ollama</span> <span style="font-family:monospace">' + _esc(d.baseUrl) + '</span>';
      var opts = '<option value="">⭐ ' + _T('cfg_zadano', 'zadano') + ' (' + _esc(String(d.defaultSpec || '').replace('ollama:','')) + ')</option>';
      (d.models || []).forEach(function(m) {
        opts += '<option value="' + _esc(m) + '"' + (m === d.model ? ' selected' : '') + '>' + _esc(m) + '</option>';
      });
      h += '<select id="classifier-select" style="font-size:0.72rem;padding:3px 5px;border-radius:4px;background:var(--bg-primary,#111);color:var(--text-primary,#ddd);border:1px solid var(--border-color,#333)" ' +
        'onchange="setClassifier(this.value, this)">' + opts + '</select>';
      h += '<span class="info-badge ' + (d.source === 'default' ? 'disabled' : 'enabled') + '" title="' + _esc(_T('cfg_klas_izvor_naslov', 'Odakle vrijednost stvarno dolazi')) + '">' + _esc(izvor) + '</span>';
      h += '</div>';
      if (!d.reachable) {
        h += '<div style="font-size:0.66rem;color:var(--accent-red);margin-top:0.35rem">' + _T('cfg_klas_ollama_nedostupna', 'Ollama nedostupna — popis modela je nepotpun') + (d.error ? (': ' + _esc(d.error)) : '') + '. ' + _T('cfg_klas_svejedno_spremi', 'Postavka se svejedno može spremiti.') + '</div>';
      }
      if (d.storeSet && d.storeMatchesConfig === false) {
        h += '<div style="font-size:0.66rem;color:#f59e0b;margin-top:0.35rem">' + _T('cfg_klas_spremiste_razlika', 'Spremište vjerodajnica ima drukčiju vrijednost od configa — na stroju koji spremište učitava u okolinu ona pobjeđuje nakon restarta.') + '</div>';
      }
      return h;
    }

    async function setClassifier(model, el) {
      try {
        if (el) el.disabled = true;
        var r = await fetch('/api/models/classifier', { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ model: model }) });
        var d = await r.json();
        if (!r.ok || d.error) throw new Error(d.error || 'save failed');
        loadClassifier();
      } catch(e) {
        alert(_T('cfg_klas_greska_spremanje', 'Greška pri spremanju klasifikatora') + ': ' + e.message);
        if (el) el.disabled = false;
        loadClassifier();
      }
    }

    function renderModelSetup(md) {
      var el = document.getElementById('info-modelsetup-content');
      if (!el) return;
      if (!md || !md.providers) { el.innerHTML = '<div class="empty">' + _T('cfg_prov_nema_podataka', 'Nema podataka o providerima') + '</div>'; return; }
      var h = '<div style="font-size:0.72rem;color:var(--text-secondary);margin-bottom:0.5rem">' +
        _T('cfg_prov_uvod', 'Pretplatnički provideri (Claude) nemaju dodatne postavke. Lokalni (Ollama) traži samo <strong>server IP:port</strong> — kao RAG; token je opcijski (samo iza reverse-proxyja).') + '</div>';
      md.providers.forEach(function(p) {
        var dot = p.enabled ? (p.reachable ? 'online' : 'offline') : 'offline';
        var statusTxt = !p.enabled ? _T('cfg_prov_iskljucen', 'isključen') : (p.kind === 'subscription' ? _T('cfg_prov_pretplata', 'pretplata') : (p.reachable ? _Tv('cfg_prov_broj_modela', '{broj} modela', { broj: p.models.length }) : _T('cfg_prov_nedostupan', 'nedostupan')));
        var statusBadge = (p.enabled && (p.reachable || p.kind === 'subscription')) ? 'enabled' : 'disabled';
        h += '<div style="border:1px solid var(--border-color);border-radius:6px;padding:0.6rem;margin-bottom:0.6rem">';
        h += '<div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.4rem;flex-wrap:wrap">' +
          '<span class="info-dot ' + dot + '"></span>' +
          '<strong>' + _T(p.nameKey, p.name) + '</strong>' +
          '<span class="info-badge ' + statusBadge + '">' + statusTxt + '</span>' +
          '<label style="margin-left:auto;font-size:0.72rem;cursor:pointer"><input type="checkbox" ' + (p.enabled ? 'checked' : '') + ' onchange="setProviderEnabled(\\'' + p.id + '\\', this.checked)"> ' + _T('cfg_prov_omogucen', 'omogućen') + '</label>' +
          '</div>';
        if (p.needsSetup) {
          var inpStyle = 'font-size:0.72rem;padding:3px 5px;background:var(--bg-primary,#111);color:var(--text-primary,#ddd);border:1px solid var(--border-color,#333);border-radius:4px';
          var isCloud = p.kind === 'cloud-key';
          var keyLabel = isCloud ? _T('cfg_api_kljuc', 'API ključ') : _T('cfg_prov_token_opcijski', 'Token (opcijski)');
          var keyPh = p.hasAuth ? '••• ' + _T('cfg_prov_spremljeno', 'spremljeno') : (isCloud ? 'sk-or-...' : _T('cfg_prov_nije_potrebno', 'nije potrebno'));
          h += '<div style="display:flex;gap:0.6rem;flex-wrap:wrap;align-items:flex-end;font-size:0.72rem">';
          // Server IP:port samo za lokalne (Ollama)
          if (p.kind === 'local') {
            h += '<div><div style="color:var(--text-secondary)">' + _T('cfg_prov_server', 'Server (IP:port)') + '</div><input id="prov-' + p.id + '-url" value="' + (p.baseUrl || '') + '" placeholder="http://127.0.0.1:11434" style="width:230px;' + inpStyle + '"></div>';
          }
          // Ključ + 👁 prikaži (maskiran dok se ne stisne)
          h += '<div><div style="color:var(--text-secondary)">' + keyLabel + '</div>' +
            '<div style="display:flex;align-items:center;gap:4px">' +
            '<input id="prov-' + p.id + '-key" type="password" autocomplete="new-password" data-form-type="other" data-lpignore="true" data-1p-ignore placeholder="' + keyPh + '" style="width:' + (isCloud ? '250' : '170') + 'px;' + inpStyle + '">' +
            '<button type="button" title="' + _esc(_T('cfg_prov_prikazi_sakrij', 'Prikaži/sakrij')) + '" class="cfg-btn" onclick="toggleKeyVis(\\'' + p.id + '\\', this)">&#9678;</button>' +
            '</div></div>';
          h += '<button class="cfg-btn" onclick="saveProvider(\\'' + p.id + '\\')">' + _T('cfg_spremi', 'Spremi') + (p.kind === 'local' ? ' + test' : '') + '</button>';
          h += '</div>';
          h += '<div style="font-size:0.66rem;color:var(--text-secondary);margin-top:0.3rem">' + _T(p.authNoteKey, p.authNote || '') + (p.error ? (' <span style="color:var(--accent-red)">— ' + p.error + '</span>') : '') + '</div>';
        } else {
          h += '<div style="font-size:0.66rem;color:var(--text-secondary)">' + _T(p.authNoteKey, p.authNote || '') + '</div>';
        }
        if (p.models && p.models.length) {
          h += '<div style="font-size:0.66rem;color:var(--text-secondary);margin-top:0.35rem;line-height:1.6">' + _T('cfg_prov_modeli', 'Modeli') + ': ' +
            p.models.map(function(m) { return '<span style="font-family:monospace">' + m.model + '</span> <span class="info-badge ' + m.tier + '">' + m.tier + '</span>' + (m.spawnable ? '' : ' <span style="color:#f59e0b">' + _T('cfg_lokalno', 'lokalno') + '</span>'); }).join(' · ') + '</div>';
        }
        h += '</div>';
      });
      el.innerHTML = h;
    }

    async function setProviderEnabled(id, enabled) {
      try {
        var r = await fetch('/api/models/providers/' + encodeURIComponent(id), { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ enabled: enabled }) });
        var d = await r.json();
        if (!r.ok || d.error) throw new Error(d.error || 'save failed');
        fetchInfoData();
      } catch(e) { alert(_T('cfg_greska', 'Greška') + ': ' + e.message); }
    }

    function toggleKeyVis(id, btn) {
      var el = document.getElementById('prov-' + id + '-key');
      if (!el) return;
      if (el.type === 'password') { el.type = 'text'; if (btn) btn.style.opacity = '1'; }
      else { el.type = 'password'; if (btn) btn.style.opacity = '0.55'; }
    }

    async function saveProvider(id) {
      var urlEl = document.getElementById('prov-' + id + '-url');
      var keyEl = document.getElementById('prov-' + id + '-key');
      var body = {};
      if (urlEl) body.baseUrl = urlEl.value;
      if (keyEl && keyEl.value !== '') body.apiKey = keyEl.value;
      try {
        var r = await fetch('/api/models/providers/' + encodeURIComponent(id), { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
        var d = await r.json();
        if (!r.ok || d.error) throw new Error(d.error || 'save failed');
        fetchInfoData();
      } catch(e) { alert(_T('cfg_prov_greska_spremanje', 'Greška pri spremanju providera') + ': ' + e.message); }
    }

    function renderInfoAgents(d, modelsData) {
      const agents = d.agents || [];
      // Merge: /api/models/available (živi Ollama + anthropic/openrouter) + d.availableModels
      // (getEffectiveModels — dodaje geminicli/kimicli kad su prijavljeni). Bez merge-a
      // CLI-login modeli (Google/Kimi) se nikad ne pojave u dropdownu.
      var _base = (modelsData && modelsData.models) || [];
      var _extra = (d.availableModels || []).filter(function(m){ return !_base.some(function(b){ return b.spec === m.spec; }); });
      const models = _base.concat(_extra);
      let h = '<div style="font-size:0.72rem;color:var(--text-secondary);margin-bottom:0.4rem">' +
        _T('cfg_agenti_uvod',
        'Model po agentu — “zadano” koristi tier iz registra. Override se sprema u <code>model-config.json → agentOverrides</code> i vrijedi odmah (bez restarta). ' +
        '<strong>lokalno</strong> = Ollama model preko API spawna — radi, ali tekstualno (bez alata: Bash/datoteke/MCP). Claude, Gemini, Kimi i OpenRouter modeli imaju PUNE alate. ' +
        // TASK-2635: REGOČ, Klaudio i Stribor su ODABIRLJIVI (nisu više „fiksni"): Klaudio poštuje
        // override po poruci (TASK-2634), REGOČ i Stribor preko resolveSpawnModel pri self/on-demand spawnu.
        '<strong>REGOČ, Klaudio i Stribor</strong> su ovdje odabirljivi kao i ostali: Klaudio čita override po poruci (bez restarta bota), ' +
        'a REGOČ-u i Striboru vrijedi kad sami izvršavaju zadatak. ' +
        '<strong>Rutiranje poruka</strong> (koji agent dobiva posao) NE ide preko ovog izbora — ono ostaje na lokalnom Ollama klasifikatoru, ' +
        'koji se mijenja u kartici „Klasifikacijski model" ispod.') + '</div>';
      h += '<table class="info-table"><thead><tr>' +
        '<th>' + _T('cfg_stupac_agent', 'Agent') + '</th><th>' + _T('cfg_stupac_uloga', 'Uloga') + '</th><th>' + _T('cfg_stupac_min_tier', 'Min Tier') + '</th><th>' + _T('cfg_stupac_model', 'Model (odabir)') + '</th>' +
        '<th>' + _T('cfg_stupac_context', 'Context') + '</th><th>' + _T('cfg_stupac_tools', 'Tools') + '</th><th>' + _T('cfg_stupac_notes', 'Notes') + '</th></tr></thead><tbody>';
      agents.forEach(function(a) {
        const tierBadge = '<span class="info-badge ' + a.minTier + '">' + a.minTier + '</span>';
        h += '<tr><td><strong>' + a.name + '</strong></td>' +
          '<td>' + _T(a.roleKey, a.role) + '</td>' +
          '<td>' + tierBadge + '</td>' +
          '<td>' + modelSelectHTML(a, models) + '</td>' +
          '<td>' + (a.minContext ? (a.minContext/1000) + 'K' : '-') + '</td>' +
          '<td title="' + _esc(_T(a.toolsNoteKey, a.toolsNote || '')) + '">' + (a.requiresTools ? '✅' : '➖') + '</td>' +
          '<td style="font-size:0.7rem;color:var(--text-secondary)">' + _T(a.notesKey, a.notes || '') + '</td></tr>';
      });
      h += '</tbody></table>';
      document.getElementById('info-agents-content').innerHTML = h;
    }

    function renderInfoModules(d) {
      const modules = d.modules || [];
      let h = '<table class="info-table"><thead><tr>' +
        '<th>Module</th><th>Status</th><th>Type</th><th>Provides</th><th>Degradation</th></tr></thead><tbody>';
      modules.forEach(function(m) {
        const badge = m.required ? 'required' : (m.enabled ? 'enabled' : 'disabled');
        const label = m.required ? 'required' : (m.enabled ? 'enabled' : 'disabled');
        h += '<tr><td><strong>' + m.name + '</strong></td>' +
          '<td><span class="info-badge ' + badge + '">' + label + '</span></td>' +
          '<td>' + (m.required ? 'Core' : 'Optional') + '</td>' +
          '<td style="font-size:0.7rem">' + (m.provides||[]).join(', ') + '</td>' +
          '<td style="font-size:0.7rem;color:var(--text-secondary)">' + (m.degradation||'-') + '</td></tr>';
      });
      h += '</tbody></table>';
      document.getElementById('info-modules-content').innerHTML = h;
    }

    function renderInfoInfra(d) {
      const infra = d.infrastructure || [];
      let h = '';
      infra.forEach(function(s) {
        h += '<div class="info-kv"><span class="info-kv-label">' + s.name + '</span><span class="info-kv-value">' + s.endpoint + '</span></div>';
      });
      document.getElementById('info-infra-content').innerHTML = h || '<div class="empty">No infrastructure</div>';
    }

    function renderInfoDatabases(d) {
      const dbs = d.databases || [];
      let h = '';
      dbs.forEach(function(db) {
        h += '<div class="info-kv"><span class="info-kv-label">' + db.name + '</span><span class="info-kv-value">' + db.purpose + '</span></div>';
      });
      document.getElementById('info-databases-content').innerHTML = h || '<div class="empty">No databases</div>';
    }

    function renderInfoComponents(d) {
      const comps = d.coreComponents || [];
      if (!comps.length) { document.getElementById('info-components-content').innerHTML = '<div class="empty">No components</div>'; return; }
      let h = '<table class="info-table"><thead><tr><th>Component</th><th>Status</th><th>Description</th></tr></thead><tbody>';
      comps.forEach(function(c) {
        var badge = c.status === 'active' ? 'enabled' : 'disabled';
        h += '<tr><td><strong>' + c.name + '</strong></td>' +
          '<td><span class="info-badge ' + badge + '">' + c.status + '</span></td>' +
          '<td style="font-size:0.75rem;color:var(--text-secondary)">' + _T(c.descriptionKey, c.description) + '</td></tr>';
      });
      h += '</tbody></table>';
      document.getElementById('info-components-content').innerHTML = h;
    }

    function renderInfoSkillsAndWorkflows(d) {
      var skills = d.skills || [];
      if (!skills.length) { document.getElementById('info-skills-content').innerHTML = '<div class="empty">No skills</div>'; return; }
      var totalWf = skills.reduce(function(s,sk){ return s + (sk.workflowCount||0); }, 0);
      var h = '<div style="margin-bottom:0.75rem;font-size:0.8rem;color:var(--text-secondary)">' + skills.length + ' skills, ' + totalWf + ' workflows</div>';
      skills.forEach(function(s, si) {
        var hasWf = s.workflows && s.workflows.length > 0;
        var chevron = hasWf ? '<span id="skill-chev-'+si+'" style="cursor:pointer;margin-right:0.4rem;font-size:0.7rem;color:var(--text-secondary)">&#9654;</span>' : '<span style="margin-right:0.4rem;font-size:0.7rem;color:var(--border-color)">&#9679;</span>';
        var onclick = hasWf ? ' onclick="toggleSkillWorkflows('+si+')" style="cursor:pointer"' : '';
        h += '<div class="info-kv"' + onclick + '>' + chevron + '<span class="info-kv-label" style="flex:0 0 180px">' + s.name + '</span>';
        h += '<span style="font-size:0.7rem;color:var(--text-secondary);flex:1">' + (s.description || '').substring(0,80) + '</span>';
        if (hasWf) h += '<span style="font-size:0.7rem;color:var(--accent-blue)">' + s.workflowCount + ' wf</span>';
        h += '</div>';
        if (hasWf) {
          h += '<div id="skill-wfs-'+si+'" style="display:none;padding-left:1.5rem;margin-bottom:0.5rem;border-left:2px solid var(--border-color)">';
          s.workflows.forEach(function(w) {
            h += '<div class="wf-item" onclick="event.stopPropagation();toggleWfEditor(\\''+s.name+'\\',\\''+w+'\\',this)">' +
              '<span>' + w + '</span></div>';
          });
          h += '</div>';
        }
      });
      document.getElementById('info-skills-content').innerHTML = h;
    }

    function toggleSkillWorkflows(idx) {
      var el = document.getElementById('skill-wfs-'+idx);
      var chev = document.getElementById('skill-chev-'+idx);
      if (!el) return;
      if (el.style.display === 'none') {
        el.style.display = 'block';
        if (chev) chev.innerHTML = '&#9660;';
      } else {
        el.style.display = 'none';
        if (chev) chev.innerHTML = '&#9654;';
      }
    }

    function toggleWfEditor(skill, name, clickedEl) {
      var existingEditor = clickedEl.nextElementSibling;
      if (existingEditor && existingEditor.classList.contains('wf-editor-inline')) {
        existingEditor.remove();
        return;
      }
      document.querySelectorAll('.wf-editor-inline').forEach(function(e){ e.remove(); });
      var editorDiv = document.createElement('div');
      editorDiv.className = 'wf-editor-inline';
      editorDiv.style.cssText = 'padding:0.75rem;margin:0.25rem 0;background:var(--bg-primary);border:1px solid var(--border-color);border-radius:6px';
      editorDiv.innerHTML = '<div class="empty">Loading...</div>';
      clickedEl.after(editorDiv);
      fetch('/api/workflow/' + encodeURIComponent(skill) + '/' + encodeURIComponent(name))
        .then(function(r){ return r.json(); })
        .then(function(data){
          if (data.error) { editorDiv.innerHTML = '<div class="empty">Error: '+data.error+'</div>'; return; }
          renderInlineEditor(editorDiv, data, skill, name);
        })
        .catch(function(e){ editorDiv.innerHTML = '<div class="empty">Error: '+e.message+'</div>'; });
    }

    function renderInlineEditor(container, data, skill, name) {
      var steps = data.steps || [];
      var fullContent = data.content || '';
      var editorId = 'wfe-' + skill + '-' + name;
      var h = '';
      if (steps.length > 0) {
        steps.forEach(function(step, i) {
          h += '<div class="wf-step" id="'+editorId+'-step-'+i+'">' +
            '<div class="wf-step-header"><span class="wf-step-title">'+step.title+'</span>' +
            '<div class="wf-step-actions">' +
            '<button onclick="wfMoveUp(\\''+editorId+'\\','+i+')">&#9650;</button>' +
            '<button onclick="wfMoveDown(\\''+editorId+'\\','+i+')">&#9660;</button>' +
            '<button class="btn-del" onclick="wfDelStep(\\''+editorId+'\\','+i+')">&#10005;</button>' +
            '</div></div>' +
            '<textarea id="'+editorId+'-text-'+i+'">'+step.content.replace(/</g,'&lt;')+'</textarea></div>';
        });
      } else {
        h += '<div class="wf-step"><div class="wf-step-header"><span class="wf-step-title">Full Content</span></div>' +
          '<textarea id="'+editorId+'-full" style="min-height:150px">'+fullContent.replace(/</g,'&lt;')+'</textarea></div>';
      }
      h += '<div class="wf-toolbar">' +
        '<button class="btn-save" onclick="wfSave(\\''+skill+'\\',\\''+name+'\\',\\''+editorId+'\\')">Save</button>' +
        '<button class="btn-add" onclick="wfAddStep(\\''+editorId+'\\')">+ Add Step</button>' +
        '<button class="btn-close" onclick="this.closest(\\'.wf-editor-inline\\').remove()">Close</button>' +
        '<span id="'+editorId+'-status" style="font-size:0.75rem;color:var(--text-secondary);margin-left:auto;align-self:center"></span></div>';
      container.innerHTML = h;
      container._wfData = data;
      container._stepCount = steps.length;
    }

    function wfMoveUp(eid, idx) {
      var el = document.getElementById(eid+'-step-'+idx);
      if (el && el.previousElementSibling && el.previousElementSibling.classList.contains('wf-step'))
        el.parentNode.insertBefore(el, el.previousElementSibling);
    }
    function wfMoveDown(eid, idx) {
      var el = document.getElementById(eid+'-step-'+idx);
      if (el && el.nextElementSibling && el.nextElementSibling.classList.contains('wf-step'))
        el.parentNode.insertBefore(el.nextElementSibling, el);
    }
    function wfDelStep(eid, idx) {
      if (confirm('Delete step?')) { var el = document.getElementById(eid+'-step-'+idx); if(el) el.remove(); }
    }
    function wfAddStep(eid) {
      var toolbar = document.querySelector('#'+eid+'-status').closest('.wf-toolbar');
      if (!toolbar) return;
      var n = toolbar.parentNode.querySelectorAll('.wf-step').length;
      var div = document.createElement('div');
      div.className = 'wf-step';
      div.innerHTML = '<div class="wf-step-header"><span class="wf-step-title">New Step</span>' +
        '<div class="wf-step-actions"><button class="btn-del" onclick="this.closest(\\'.wf-step\\').remove()">&#10005;</button></div></div>' +
        '<textarea placeholder="### Step: Title..."></textarea>';
      toolbar.parentNode.insertBefore(div, toolbar);
    }
    function wfSave(skill, name, eid) {
      var statusEl = document.getElementById(eid+'-status');
      statusEl.textContent = 'Saving...'; statusEl.style.color = 'var(--accent-yellow)';
      var container = statusEl.closest('.wf-editor-inline');
      var textareas = container.querySelectorAll('.wf-step textarea');
      var data = container._wfData || {};
      var orig = data.content || '';
      var headerEnd = orig.indexOf('### Step ');
      var header = headerEnd > 0 ? orig.substring(0, headerEnd) : orig.split('\\n').slice(0,10).join('\\n')+'\\n\\n';
      var parts = [header];
      textareas.forEach(function(ta){ parts.push(ta.value); });
      var body = textareas.length > 0 ? parts.join('\\n\\n') : (container.querySelector('#'+eid+'-full') || {value:orig}).value;
      fetch('/api/workflow/'+encodeURIComponent(skill)+'/'+encodeURIComponent(name),{
        method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({content:body})
      }).then(function(r){return r.json()}).then(function(d){
        statusEl.textContent = d.status==='saved' ? 'Saved!' : 'Error: '+(d.error||'?');
        statusEl.style.color = d.status==='saved' ? 'var(--accent-green)' : 'var(--accent-red)';
      }).catch(function(e){ statusEl.textContent='Error: '+e.message; statusEl.style.color='var(--accent-red)'; });
    }

    function renderInfoRules(d) {
      const rules = d.rules || [];
      let h = '<table class="info-table"><thead><tr><th>#</th><th>Rule</th><th>Summary</th></tr></thead><tbody>';
      rules.forEach(function(r, i) {
        h += '<tr><td style="font-weight:700;color:var(--accent-blue)">' + r.number + '</td>' +
          '<td><strong>' + r.name + '</strong></td>' +
          '<td style="font-size:0.75rem;color:var(--text-secondary)">' + r.summary + '</td></tr>';
      });
      h += '</tbody></table>';
      document.getElementById('info-rules-content').innerHTML = h;
    }

    function renderInfoMetrics(m) {
      var el = document.getElementById('info-metrics-content');
      if (!m) { el.innerHTML = '<div class="empty">No metrics data</div>'; return; }
      var h = '';
      var t = m.tasks || {};
      h += '<div class="info-kv"><span class="info-kv-label">Tasks Total</span><span class="info-kv-value">' + (t.total||0) + '</span></div>';
      h += '<div class="info-kv"><span class="info-kv-label">Completed</span><span class="info-kv-value">' + (t.completed||0) + '</span></div>';
      h += '<div class="info-kv"><span class="info-kv-label">In Progress</span><span class="info-kv-value">' + (t.inProgress||0) + '</span></div>';
      h += '<div class="info-kv"><span class="info-kv-label">Pending</span><span class="info-kv-value">' + (t.pending||0) + '</span></div>';
      var c = m.costs || {};
      h += '<div class="info-kv" style="margin-top:0.5rem;border-top:1px solid var(--border-color);padding-top:0.3rem"><span class="info-kv-label">' + _T('cfg_trosak_ukupno', 'Trošak ukupno') + '</span><span class="info-kv-value">' + eur(Number(c.total||0)) + '</span></div>';
      var o = m.observability || {};
      h += '<div class="info-kv"><span class="info-kv-label">Events Total</span><span class="info-kv-value">' + (o.totalEvents||0) + '</span></div>';
      h += '<div class="info-kv"><span class="info-kv-label">Events (24h)</span><span class="info-kv-value">' + (o.last24h||0) + '</span></div>';
      el.innerHTML = h;
    }

    // ============================================
    // TASK-4972: RAG Backend (ChromaDB/pgvector) upravljanje
    // ============================================

    var _ragZadnji = null;  // Zadnji odgovor za osvježavanje jezika
    var _ragUsporedba = null;  // Zadnja usporedba kolekcija
    var _ragMigracija = null;  // Status migracije

    function osvjeziRagJezik() {
      var el = document.getElementById('info-rag-content');
      if (!el || !_ragZadnji) return;
      el.innerHTML = renderRagBackend(_ragZadnji);
    }

    async function loadRagBackend() {
      var el = document.getElementById('info-rag-content');
      if (!el) return;
      try {
        var d = await (await fetch('/api/rag/backend/status')).json();
        if (d.error) throw new Error(d.error);
        _ragZadnji = d;
        el.innerHTML = renderRagBackend(d);
      } catch(e) {
        el.innerHTML = '<div class="empty">' +
          _Tv('rag_greska_citanja', 'Greška pri čitanju RAG statusa: {greska}',
                 { greska: _esc(e.message) }) + '</div>';
      }
    }

    function renderRagBackend(d) {
      var cur = d.currentBackend || 'chromadb';
      var chroma = d.chromadb || {};
      var pg = d.pgvector || {};

      // Status znački
      var chromaZnacka = chroma.connected
        ? '<span class="info-badge enabled">✓ ' + _T('rag_spojeno', 'spojeno') + '</span>'
        : '<span class="info-badge disabled">✗ ' + _T('rag_nije_spojeno', 'nije spojeno') + '</span>';
      var pgZnacka = pg.connected
        ? '<span class="info-badge enabled">✓ ' + _T('rag_spojeno', 'spojeno') + '</span>'
        : (pg.available
            ? '<span class="info-badge disabled">✗ ' + _T('rag_nije_spojeno', 'nije spojeno') + '</span>'
            : '<span class="info-badge disabled" title="' + _esc(pg.error || '') + '">⚠ ' + _T('rag_nedostupno', 'nedostupno') + '</span>');

      var aktivniBackend = cur === 'chromadb'
        ? '<span class="info-badge enabled">ChromaDB</span>'
        : (cur === 'pgvector'
            ? '<span class="info-badge enabled">pgvector</span>'
            : '<span class="info-badge enabled">dual (oba)</span>');

      var h = '<div style="font-size:0.72rem;color:var(--text-secondary);margin-bottom:0.5rem">' +
        _T('rag_uvod', 'RAG (Retrieval-Augmented Generation) backend za vektorsko pretraživanje. ' +
          'ChromaDB je zadani backend; pgvector omogućuje migraciju na PostgreSQL s boljim performansama.') +
        ' ' + _T('rag_aktivni', 'Aktivni backend:') + ' ' + aktivniBackend + '</div>';

      // Dvije kartice za status backenda
      h += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-bottom:1rem">';

      // ChromaDB status
      h += '<div style="background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:6px;padding:0.75rem">' +
        '<div style="font-weight:600;margin-bottom:0.5rem;display:flex;align-items:center;gap:0.5rem">' +
        '<span style="font-size:1.1rem">🗄️</span> ChromaDB ' + chromaZnacka + '</div>';
      h += '<div style="font-size:0.72rem">';
      h += '<div style="display:flex;justify-content:space-between;padding:2px 0"><span>Host:</span><span style="font-family:monospace">' + _esc(chroma.host) + ':' + chroma.port + '</span></div>';
      h += '<div style="display:flex;justify-content:space-between;padding:2px 0"><span>' + _T('rag_kolekcije', 'Kolekcije') + ':</span><span>' + (chroma.collections || 0) + '</span></div>';
      h += '<div style="display:flex;justify-content:space-between;padding:2px 0"><span>' + _T('rag_dokumenti', 'Dokumenti') + ':</span><span>~' + (chroma.documents || 0).toLocaleString() + '</span></div>';
      if (chroma.error && !chroma.connected) h += '<div style="color:var(--accent-red);margin-top:4px;font-size:0.68rem">⚠ ' + _esc(chroma.error) + '</div>';
      h += '</div></div>';

      // pgvector status
      h += '<div style="background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:6px;padding:0.75rem">' +
        '<div style="font-weight:600;margin-bottom:0.5rem;display:flex;align-items:center;gap:0.5rem">' +
        '<span style="font-size:1.1rem">🐘</span> pgvector ' + pgZnacka + '</div>';
      h += '<div style="font-size:0.72rem">';
      h += '<div style="display:flex;justify-content:space-between;padding:2px 0"><span>Host:</span><span style="font-family:monospace">' + _esc(pg.host) + ':' + pg.port + '</span></div>';
      h += '<div style="display:flex;justify-content:space-between;padding:2px 0"><span>Database:</span><span style="font-family:monospace">' + _esc(pg.database) + '</span></div>';
      h += '<div style="display:flex;justify-content:space-between;padding:2px 0"><span>' + _T('rag_kolekcije', 'Kolekcije') + ':</span><span>' + (pg.collections || 0) + '</span></div>';
      h += '<div style="display:flex;justify-content:space-between;padding:2px 0"><span>' + _T('rag_dokumenti', 'Dokumenti') + ':</span><span>' + (pg.documents || 0).toLocaleString() + '</span></div>';
      if (pg.version) h += '<div style="display:flex;justify-content:space-between;padding:2px 0"><span>Verzija:</span><span>' + _esc(pg.version) + '</span></div>';
      if (pg.error && !pg.connected) h += '<div style="color:var(--accent-red);margin-top:4px;font-size:0.68rem">⚠ ' + _esc(pg.error) + '</div>';
      h += '</div></div>';

      h += '</div>';

      // Kontrole
      h += '<table class="info-table" style="margin-bottom:1rem"><tbody>';

      // Backend prekidač
      var backendOpts = '<option value="chromadb"' + (cur === 'chromadb' ? ' selected' : '') + '>ChromaDB</option>' +
        '<option value="pgvector"' + (cur === 'pgvector' ? ' selected' : '') + (pg.connected ? '' : ' disabled') + '>pgvector</option>' +
        '<option value="dual"' + (cur === 'dual' ? ' selected' : '') + (pg.connected ? '' : ' disabled') + '>dual (oba)</option>';
      h += _red(_T('rag_backend', 'Aktivni backend'),
        '<select id="rag-backend-select" style="' + _stil() + ';min-width:150px" onchange="setRagBackend(this.value, this)">' + backendOpts + '</select>' +
        ' <span id="rag-backend-status" style="font-size:0.68rem;margin-left:0.5rem"></span>',
        _T('rag_backend_opis', 'ChromaDB = postojeći; pgvector = PostgreSQL (brži, HNSW indeksi); dual = oba paralelno (za migraciju).'));

      h += '</tbody></table>';

      // pgvector konfiguracija (sklopivo)
      h += '<details style="margin-bottom:1rem"><summary style="cursor:pointer;font-weight:600;font-size:0.8rem;color:var(--accent-blue)">' +
        _T('rag_pg_config', '🔧 pgvector konfiguracija') + '</summary>';
      h += '<div style="padding:0.75rem;background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:0 0 6px 6px;margin-top:-1px">';
      h += '<table class="info-table"><tbody>';
      h += _red('Host',
        '<input id="rag-pg-host" value="' + _esc(pg.host) + '" style="' + _stil() + ';width:150px">',
        'IP adresa ili hostname PostgreSQL poslužitelja');
      h += _red('Port',
        '<input id="rag-pg-port" type="number" value="' + _esc(pg.port == null ? '' : pg.port) + '" style="' + _stil() + ';width:80px">',
        'Port PostgreSQL poslužitelja (standardno 5432)');
      h += _red('Database',
        '<input id="rag-pg-database" value="' + _esc(pg.database) + '" style="' + _stil() + ';width:150px">',
        'Ime baze podataka');
      h += _red('User',
        '<input id="rag-pg-user" value="' + _esc(pg.user || '') + '" style="' + _stil() + ';width:100px">',
        'Korisničko ime');
      h += _red('Password',
        '<input id="rag-pg-password" type="password" placeholder="••••••••" style="' + _stil() + ';width:150px">' +
        ' <span style="font-size:0.68rem;color:var(--text-secondary)">' + _T('rag_pass_hint', '(iz TM_PGVECTOR_PASSWORD ili datoteke tajni)') + '</span>',
        'Lozinka se čita iz TM_PGVECTOR_PASSWORD (okolina ili datoteka tajni)');
      h += '</tbody></table>';
      h += '<div style="margin-top:0.75rem;display:flex;gap:0.5rem">' +
        '<button style="font-size:0.72rem;padding:4px 12px" onclick="testRagPgConnection(this)">' + _T('rag_test', 'Test konekcije') + '</button>' +
        '<button style="font-size:0.72rem;padding:4px 12px" onclick="saveRagPgConfig(this)">' + _T('rag_spremi', 'Spremi postavke') + '</button>' +
        '<span id="rag-pg-status" style="font-size:0.68rem;line-height:2"></span></div>';
      h += '</div></details>';

      // Migracija panel (sklopivo)
      h += '<details style="margin-bottom:0.5rem"><summary style="cursor:pointer;font-weight:600;font-size:0.8rem;color:var(--accent-blue)">' +
        _T('rag_migracija', '📦 Migracija ChromaDB → pgvector') + '</summary>';
      h += '<div style="padding:0.75rem;background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:0 0 6px 6px;margin-top:-1px">';
      h += '<div style="font-size:0.72rem;margin-bottom:0.75rem">' +
        _T('rag_mig_uvod', 'Usporedi kolekcije između backenda i pokreni migraciju jedne po jedne. ' +
          'Migracija se izvršava u pozadini; status možeš pratiti osvježavanjem.') + '</div>';
      h += '<div style="display:flex;gap:0.5rem;margin-bottom:0.75rem">' +
        '<button style="font-size:0.72rem;padding:4px 12px" onclick="compareRagCollections(this)">' + _T('rag_usporedi', 'Usporedi kolekcije') + '</button>' +
        '<button style="font-size:0.72rem;padding:4px 12px" onclick="refreshRagMigrationStatus()">' + _T('rag_osvjezi_status', 'Osvježi status') + '</button>' +
        '<span id="rag-mig-status" style="font-size:0.68rem;line-height:2"></span></div>';
      h += '<div id="rag-compare-result"></div>';
      h += '</div></details>';

      return h;
    }

    async function setRagBackend(backend, el) {
      var statusEl = document.getElementById('rag-backend-status');
      if (el) el.disabled = true;
      if (statusEl) statusEl.innerHTML = '<span style="color:var(--text-secondary)">' + _T('rag_spremam', 'spremam…') + '</span>';
      try {
        var res = await fetch('/api/rag/backend', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ backend: backend })
        });
        var d = await res.json();
        if (!res.ok || d.error) throw new Error(d.error || 'save failed');
        if (statusEl) statusEl.innerHTML = '<span style="color:var(--accent-green)">✓ ' + _T('rag_spremljeno', 'spremljeno') + '</span>';
        setTimeout(loadRagBackend, 800);
      } catch(e) {
        if (statusEl) statusEl.innerHTML = '<span style="color:var(--accent-red)">✗ ' + _esc(e.message) + '</span>';
        if (el) el.disabled = false;
      }
    }

    async function testRagPgConnection(el) {
      var statusEl = document.getElementById('rag-pg-status');
      if (el) el.disabled = true;
      if (statusEl) statusEl.innerHTML = '<span style="color:var(--text-secondary)">' + _T('rag_testiram', 'testiram…') + '</span>';
      try {
        var config = {
          host: document.getElementById('rag-pg-host').value,
          port: Number(document.getElementById('rag-pg-port').value),
          database: document.getElementById('rag-pg-database').value,
          user: document.getElementById('rag-pg-user').value,
          password: document.getElementById('rag-pg-password').value || ''
        };
        var res = await fetch('/api/rag/backend/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(config)
        });
        var d = await res.json();
        if (d.connected) {
          statusEl.innerHTML = '<span style="color:var(--accent-green)">✓ ' +
            _Tv('rag_test_ok', 'Spojeno! {verzija}', { verzija: d.version || '' }) + '</span>';
        } else {
          statusEl.innerHTML = '<span style="color:var(--accent-red)">✗ ' + _esc(d.error || 'Connection failed') + '</span>';
        }
      } catch(e) {
        statusEl.innerHTML = '<span style="color:var(--accent-red)">✗ ' + _esc(e.message) + '</span>';
      }
      if (el) el.disabled = false;
    }

    async function saveRagPgConfig(el) {
      var statusEl = document.getElementById('rag-pg-status');
      if (el) el.disabled = true;
      if (statusEl) statusEl.innerHTML = '<span style="color:var(--text-secondary)">' + _T('rag_spremam', 'spremam…') + '</span>';
      try {
        var config = {
          host: document.getElementById('rag-pg-host').value,
          port: Number(document.getElementById('rag-pg-port').value),
          database: document.getElementById('rag-pg-database').value,
          user: document.getElementById('rag-pg-user').value
        };
        var res = await fetch('/api/rag/backend/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(config)
        });
        var d = await res.json();
        if (!res.ok || d.error) throw new Error(d.error || 'save failed');
        statusEl.innerHTML = '<span style="color:var(--accent-green)">✓ ' + _T('rag_spremljeno', 'spremljeno') + '</span>';
        setTimeout(loadRagBackend, 500);
      } catch(e) {
        statusEl.innerHTML = '<span style="color:var(--accent-red)">✗ ' + _esc(e.message) + '</span>';
      }
      if (el) el.disabled = false;
    }

    async function compareRagCollections(el) {
      var statusEl = document.getElementById('rag-mig-status');
      var resultEl = document.getElementById('rag-compare-result');
      if (el) el.disabled = true;
      if (statusEl) statusEl.innerHTML = '<span style="color:var(--text-secondary)">' + _T('rag_usporedba', 'uspoređujem…') + '</span>';
      try {
        var res = await fetch('/api/rag/backend/compare');
        var d = await res.json();
        if (d.error) throw new Error(d.error);
        _ragUsporedba = d;
        statusEl.innerHTML = '';

        // Tablica usporedbe
        var h = '<table class="info-table" style="font-size:0.72rem"><thead><tr>' +
          '<th>' + _T('rag_kolekcija', 'Kolekcija') + '</th>' +
          '<th>ChromaDB</th><th>pgvector</th><th>' + _T('rag_razlika', 'Razlika') + '</th>' +
          '<th></th></tr></thead><tbody>';
        (d || []).forEach(function(c) {
          var diff = c.difference;
          var diffStyle = diff === 0 ? 'color:var(--accent-green)' : (diff > 0 ? 'color:var(--accent-yellow)' : 'color:var(--accent-blue)');
          var diffText = diff === 0 ? '✓' : (diff > 0 ? '+' + diff : String(diff));
          var btn = diff > 0
            ? '<button style="font-size:0.68rem;padding:2px 8px" onclick="migrateRagCollection(\\'' + _esc(c.collection) + '\\', this)">' + _T('rag_migriraj', 'Migriraj') + '</button>'
            : (diff === 0 ? '<span style="color:var(--accent-green);font-size:0.68rem">✓</span>' : '');
          h += '<tr><td style="font-family:monospace">' + _esc(c.collection) + '</td>' +
            '<td style="text-align:right">' + c.chromaCount.toLocaleString() + '</td>' +
            '<td style="text-align:right">' + c.pgvectorCount.toLocaleString() + '</td>' +
            '<td style="text-align:right;' + diffStyle + '">' + diffText + '</td>' +
            '<td>' + btn + '</td></tr>';
        });
        h += '</tbody></table>';
        resultEl.innerHTML = h;
      } catch(e) {
        statusEl.innerHTML = '<span style="color:var(--accent-red)">✗ ' + _esc(e.message) + '</span>';
      }
      if (el) el.disabled = false;
    }

    async function migrateRagCollection(collection, el) {
      var statusEl = document.getElementById('rag-mig-status');
      if (el) el.disabled = true;
      if (statusEl) statusEl.innerHTML = '<span style="color:var(--text-secondary)">' +
        _Tv('rag_migriram', 'migriram {kol}…', { kol: _esc(collection) }) + '</span>';
      try {
        var res = await fetch('/api/rag/backend/migrate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ collection: collection })
        });
        var d = await res.json();
        if (!d.started) throw new Error(d.error || 'Migration failed to start');
        statusEl.innerHTML = '<span style="color:var(--accent-green)">✓ ' +
          _Tv('rag_mig_pokrenuta', 'Migracija {kol} pokrenuta', { kol: _esc(collection) }) + '</span>';
        // Osvježi nakon kratke pauze
        setTimeout(loadRagBackend, 3000);
      } catch(e) {
        statusEl.innerHTML = '<span style="color:var(--accent-red)">✗ ' + _esc(e.message) + '</span>';
        if (el) el.disabled = false;
      }
    }

    async function refreshRagMigrationStatus() {
      var statusEl = document.getElementById('rag-mig-status');
      try {
        var res = await fetch('/api/rag/backend/migration');
        var d = await res.json();
        _ragMigracija = d;
        if (d.inProgress) {
          statusEl.innerHTML = '<span style="color:var(--accent-blue)">' +
            _Tv('rag_mig_u_tijeku', 'U tijeku: {kol} ({prog}%)', { kol: _esc(d.collection), prog: d.progress || 0 }) + '</span>';
        } else {
          var stats = d.totalMigrated > 0
            ? _Tv('rag_mig_gotovo', '{n} dokumenata migrirano, {f} neuspješno', { n: d.totalMigrated, f: d.totalFailed })
            : _T('rag_mig_nema', 'Nema migracije u tijeku');
          statusEl.innerHTML = '<span style="color:var(--text-secondary)">' + stats + '</span>';
        }
      } catch(e) {
        statusEl.innerHTML = '<span style="color:var(--accent-red)">✗ ' + _esc(e.message) + '</span>';
      }
    }

    // ============================================
    // INITIALIZATION
    // ============================================

    initTabNavigation();

    // TASK-3053: PLOCA SE PUNI NEOVISNO O WEBSOCKETU.
    //
    // Kvar (Goran, 29.07.2026: „ne vidim ni jedan task"): jedina dva puta do podataka bila su
    // ws.onopen -> fetchTasks() i setInterval ispod. Kako je connect() stajao IZNAD tog
    // setInterval-a, svaka iznimka iz new WebSocket(...) — a preglednik je baca kad je
    // veza blokirana (mijesani sadrzaj na HTTPS-u, posrednik, stroga polica) — prekidala je
    // izvodjenje prije nego se osvjezavanje uopce registrira. Rezultat: zaglavlje i stupci se
    // iscrtaju, zadataka nema NIKAD, a u konzoli stoji jedna jedina greska.
    //
    // Zato: prvo dohvat, pa tek onda veza, i to u try — WebSocket je ubrzanje (zivo
    // osvjezavanje), nikad preduvjet za prikaz.
    // TASK-3609: tečaj prije prvog iscrtavanja iznosa. Ne čekamo ga (ploča se ne smije
    // zaustaviti na tuđem poslužitelju) — do dolaska iznosi pišu crticu, nikad krivu brojku.
    ucitajTecaj();
    setInterval(ucitajTecaj, 6 * 60 * 60 * 1000);

    fetchProjectsForFilter();
    fetchTasks();
    setInterval(fetchTasks, 30000); // Refresh every 30s — radi i bez WebSocketa

    // Zadatci koji čekaju odluku: uz isti ritam kao ploča. Prekidač „prikaži" pamti stanje
    // unutar sjednice, pa se otvoreni popis ne zatvara sam pri osvježavanju.
    document.getElementById('odluke-toggle')?.addEventListener('click', function () {
      odlukeOtvoreno = !odlukeOtvoreno;
      document.getElementById('odluke-popis').style.display = odlukeOtvoreno ? 'flex' : 'none';
      document.getElementById('odluke-odlucitelj').style.display = odlukeOtvoreno ? 'flex' : 'none';
      this.textContent = odlukeOtvoreno ? _T('sakrij', 'sakrij') : _T('prikazi', 'prikaži');
    });
    ucitajOdluke();
    setInterval(ucitajOdluke, 30000);
    setInterval(ucitajOdlucitelja, 30000);

    postaviIzbornikJezika();

    document.getElementById('odluc-ukljucen')?.addEventListener('change', function () {
      spremiOdlucitelja({ ukljucen: this.checked });
    });
    document.getElementById('odluc-cekanje')?.addEventListener('change', function () {
      const v = Number(this.value);
      if (Number.isFinite(v) && v >= 0.08 && v <= 72) spremiOdlucitelja({ cekanje_sati: v });
    });
    document.getElementById('odluc-provider')?.addEventListener('change', function () {
      // Model prethodnog davatelja ne vrijedi kod novoga, pa se šalje samo davatelj;
      // poslužitelj vrati njegov popis, a prvi model postaje odabran.
      spremiOdlucitelja({ provider: this.value });
    });
    document.getElementById('odluc-model')?.addEventListener('change', function () {
      spremiOdlucitelja({ model: this.value });
    });
    document.getElementById('odluc-proba')?.addEventListener('click', function () { pokreniOdlucitelja(true); });
    document.getElementById('odluc-izvrsi')?.addEventListener('click', function () { pokreniOdlucitelja(false); });
    ucitajOdlucitelja();

    try {
      connect();
    } catch (e) {
      console.error('[WS] live refresh unavailable, board falls back to 30 s polling:', e);
      const st = document.getElementById('status-text');
      if (st) st.textContent = _T('bez_zive_veze', 'Bez žive veze — osvježavam svakih 30 s');
      document.getElementById('connection-status')?.classList.add('disconnected');
    }
  </script>
</body>
</html>`

// ============================================
// ============================================
// INFO PAYLOAD BUILDER
// ============================================

// ── Model catalog (SSoT za dropdown na Info tabu) ──────────────────────────
// spawnable=true → agent se MOŽE pokrenuti danas preko `claude --print --model`.
// spawnable=false → kandidat (Ollama itd.), treba API spawn path (F2 / TASK-2588).
// Ako Goran odabere override, sprema se u model-config.json → agentOverrides[id].
// Interface/glavna-petlja agenti — trajni procesi koji NE idu kroz resolveSpawnModel,
// pa im model-override nema efekta. Dropdown se zaključava, PUT ih odbija.
// Prazno: glavni agenti (REGOČ/Klaudio/Stribor) su ODKLJUČANI — model im se može mijenjati.
// REGOČ i Stribor override djeluje preko resolveSpawnModel (self/on-demand spawn);
// Klaudio override zahtijeva da telegram_agent poštuje agentOverrides[klaudio] (workstream B).
const FIXED_INTERFACE_AGENTS = new Set<string>([]);

const AVAILABLE_MODELS: Array<{ spec: string; provider: string; model: string; tier: string; label: string; spawnable: boolean }> = [
  { spec: 'anthropic:opus',   provider: 'anthropic', model: 'opus',   tier: 'frontier', label: 'Claude Opus',   spawnable: true },
  { spec: 'anthropic:sonnet', provider: 'anthropic', model: 'sonnet', tier: 'strong',   label: 'Claude Sonnet', spawnable: true },
  { spec: 'anthropic:haiku',  provider: 'anthropic', model: 'haiku',  tier: 'basic',    label: 'Claude Haiku',  spawnable: true },
  { spec: 'anthropic:fable',  provider: 'anthropic', model: 'fable',  tier: 'strong',   label: 'Claude Fable',  spawnable: true },
  // Pinirane generacije. TASK-4894: `[1m]` (kontekst 1M) mora biti u ovom popisu, jer
  // validacija spremanja prima SAMO ono što je ovdje — bez njega je svako spremanje s
  // ploče tiho vraćalo `…[1m]` na model bez proširenog konteksta.
  { spec: 'anthropic:claude-opus-4-6',       provider: 'anthropic', model: 'claude-opus-4-6',       tier: 'frontier', label: 'Claude Opus 4.6',               spawnable: true },
  { spec: 'anthropic:claude-sonnet-4-6',     provider: 'anthropic', model: 'claude-sonnet-4-6',     tier: 'strong',   label: 'Claude Sonnet 4.6',             spawnable: true },
  { spec: 'anthropic:claude-opus-4-6[1m]',   provider: 'anthropic', model: 'claude-opus-4-6[1m]',   tier: 'frontier', label: 'Claude Opus 4.6 (kontekst 1M)',   spawnable: true },
  { spec: 'anthropic:claude-sonnet-4-6[1m]', provider: 'anthropic', model: 'claude-sonnet-4-6[1m]', tier: 'strong',   label: 'Claude Sonnet 4.6 (kontekst 1M)', spawnable: true },
  { spec: 'anthropic:claude-haiku-4-5',      provider: 'anthropic', model: 'claude-haiku-4-5',      tier: 'basic',    label: 'Claude Haiku 4.5',              spawnable: true },
  { spec: 'ollama:qwen3:8b',                  provider: 'ollama', model: 'qwen3:8b',                  tier: 'basic',  label: 'Ollama qwen3:8b',              spawnable: false },
  { spec: 'ollama:qwen2.5-coder:7b-instruct', provider: 'ollama', model: 'qwen2.5-coder:7b-instruct', tier: 'good',   label: 'Ollama qwen2.5-coder:7b',      spawnable: false },
  { spec: 'ollama:qwen3-coder:30b',           provider: 'ollama', model: 'qwen3-coder:30b',           tier: 'strong', label: 'Ollama qwen3-coder:30b',       spawnable: false },
  { spec: 'ollama:mistral:instruct',          provider: 'ollama', model: 'mistral:instruct',          tier: 'good',   label: 'Ollama mistral:instruct',      spawnable: false },
  { spec: 'ollama:devstral:latest',           provider: 'ollama', model: 'devstral:latest',           tier: 'strong', label: 'Ollama devstral:latest',       spawnable: false },
]

// Katalog + modeli CLI-login providera (geminicli/kimicli) koji se pojave TEK kad je prijava odrađena.
function getEffectiveModels(): typeof AVAILABLE_MODELS {
  const extra: typeof AVAILABLE_MODELS = []
  try {
    const H = process.env.HOME || ''
    const _cf = join(H, '.claude/regoc/credentials.env')
    const _geminiKey = existsSync(_cf) && /^GEMINI_API_KEY=.+/m.test(readFileSync(_cf, 'utf-8'))
    if (existsSync(join(H, '.gemini/oauth_creds.json')) || _geminiKey) {
      extra.push(
        { spec: 'geminicli:gemini-2.5-pro',   provider: 'geminicli', model: 'gemini-2.5-pro',   tier: 'frontier', label: 'Gemini 2.5 Pro (Google API key)',   spawnable: true },
        { spec: 'geminicli:gemini-2.5-flash', provider: 'geminicli', model: 'gemini-2.5-flash', tier: 'good',     label: 'Gemini 2.5 Flash (Google API key)', spawnable: true },
      )
    }
    const kd = join(H, '.kimi-code/oauth')
    if (existsSync(kd)) { try { if (readdirSync(kd).length > 0) extra.push({ spec: 'kimicli:kimi-k2', provider: 'kimicli', model: 'kimi-k2', tier: 'strong', label: 'Kimi K2 (login)', spawnable: true }) } catch {} }
  } catch {}
  return [...AVAILABLE_MODELS, ...extra]
}

// Učitaj trenutne per-agent override-e iz model-config.json (model-agnostic SSoT).
function loadAgentOverrides(HOME: string): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    const p = join(HOME, '.claude/regoc/models/model-config.json')
    if (existsSync(p)) {
      const mc = JSON.parse(readFileSync(p, 'utf-8'))
      const ov = mc.agentOverrides || {}
      for (const [k, v] of Object.entries(ov)) {
        if (!k.startsWith('_') && typeof v === 'string') out[k] = v as string
      }
    }
  } catch {}
  return out
}

// Heuristika: mapiraj Ollama ime modela na quality tier (samo za prikaz).
function ollamaTierGuess(name: string): string {
  const n = name.toLowerCase()
  if (/embed/.test(n)) return 'classifier'
  if (/(30b|70b|large|coder:30)/.test(n)) return 'strong'
  if (/(1b|3b|mini|tiny|ministral-3|llama3\.2:3b)/.test(n)) return 'classifier'
  if (/coder|devstral|mistral/.test(n)) return 'good'
  return 'basic'
}

// Živi dohvat lokalnih Ollama modela s konfiguriranog servera (kao RAG).
async function fetchOllamaModels(baseUrl: string, apiKey?: string): Promise<string[]> {
  const url = baseUrl.replace(/\/+$/, '') + '/api/tags'
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 4000)
  try {
    const headers: Record<string, string> = {}
    if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey
    const r = await fetch(url, { signal: ctrl.signal, headers })
    if (!r.ok) throw new Error('HTTP ' + r.status)
    const d = await r.json() as { models?: Array<{ name?: string }> }
    return (d.models || []).map(m => m.name || '').filter(Boolean)
  } finally {
    clearTimeout(t)
  }
}

// Providers + živi popis modela — hrani i dropdown po agentu i setup panel.
async function buildModelsAvailable(): Promise<{ providers: any[]; models: any[] }> {
  const HOME = process.env.HOME || homedir()
  let provCfg: Record<string, any> = {}
  try {
    const mc = JSON.parse(readFileSync(join(HOME, '.claude/regoc/models/model-config.json'), 'utf-8'))
    provCfg = mc.providers || {}
  } catch {}

  const providers: any[] = []
  const models: any[] = []

  // Anthropic — pretplata, bez dodatnog setupa
  const anthEnabled = provCfg.anthropic?.enabled !== false
  const anthModels = AVAILABLE_MODELS.filter(m => m.provider === 'anthropic')
  providers.push({
    id: 'anthropic', name: 'Anthropic (Claude)', nameKey: 'cfg_prov_ime_anthropic', kind: 'subscription',
    needsSetup: false, enabled: anthEnabled, reachable: anthEnabled,
    baseUrl: null, hasAuth: true,
    authNoteKey: 'cfg_auth_anthropic',
    authNote: 'Pretplata / ANTHROPIC_API_KEY — bez dodatnih postavki.',
    models: anthModels,
  })
  if (anthEnabled) models.push(...anthModels)

  // Ollama — lokalno, treba IP:port (token opcijski, samo iza proxyja)
  const oCfg = provCfg.ollama || {}
  const oEnabled = oCfg.enabled !== false
  // ADR-0001 §5.1: bez postavke i bez `TM_OLLAMA_URL` Ollama jednostavno nije podešena —
  // ne pokušavamo pogoditi tuđu adresu (prije je ovdje stajao IP našeg poslužitelja).
  const baseUrl = oCfg.baseUrl || process.env.TM_OLLAMA_URL || ''
  const apiKey = typeof oCfg.apiKey === 'string' && oCfg.apiKey && !oCfg.apiKey.startsWith('env:') ? oCfg.apiKey : undefined
  const hasAuth = !!(oCfg.apiKey && oCfg.apiKey !== '')
  let oModels: any[] = []
  let reachable = false
  let error: string | null = null
  if (oEnabled && baseUrl) {
    try {
      const names = await fetchOllamaModels(baseUrl, apiKey)
      reachable = true
      oModels = names.map(n => ({
        spec: 'ollama:' + n, provider: 'ollama', model: n,
        tier: ollamaTierGuess(n), label: 'Ollama ' + n, spawnable: false,
      }))
    } catch (e: any) {
      error = String(e && e.message ? e.message : e)
    }
  }
  providers.push({
    id: 'ollama', name: 'Ollama (lokalno)', nameKey: 'cfg_prov_ime_ollama', kind: 'local',
    needsSetup: true, enabled: oEnabled, reachable, baseUrl, hasAuth, error,
    authNoteKey: 'cfg_auth_ollama',
    authNote: 'Standardni Ollama nema lozinku — dovoljan je IP:port (kao RAG). Token samo ako je iza reverse-proxyja.',
    models: oModels,
  })
  models.push(...oModels)

  // OpenRouter — cloud, treba API ključ. Agentski tool-loop → spawnable (puni alati).
  const orCfg = provCfg.openrouter || {}
  const orEnabled = orCfg.enabled === true  // opt-in (default off)
  const orHasAuth = !!(orCfg.apiKey && orCfg.apiKey !== '')
  const OR_CURATED = [
    { spec: 'openrouter:z-ai/glm-5.2', provider: 'openrouter', model: 'z-ai/glm-5.2', tier: 'strong', label: 'GLM-5.2 (OpenRouter)', spawnable: true },
    { spec: 'openrouter:z-ai/glm-5',   provider: 'openrouter', model: 'z-ai/glm-5',   tier: 'strong', label: 'GLM-5 (OpenRouter)',   spawnable: true },
    { spec: 'openrouter:google/gemini-2.5-flash', provider: 'openrouter', model: 'google/gemini-2.5-flash', tier: 'good', label: 'Gemini 2.5 Flash — alati (OpenRouter)', spawnable: true },
    { spec: 'openrouter:google/gemini-2.5-pro', provider: 'openrouter', model: 'google/gemini-2.5-pro', tier: 'frontier', label: 'Gemini 2.5 Pro — alati (OpenRouter)', spawnable: true },
  ]
  providers.push({
    id: 'openrouter', name: 'OpenRouter (cloud)', nameKey: 'cfg_prov_ime_openrouter', kind: 'cloud-key',
    needsSetup: true, enabled: orEnabled, reachable: orEnabled && orHasAuth, baseUrl: 'https://openrouter.ai/api/v1', hasAuth: orHasAuth,
    authNoteKey: 'cfg_auth_openrouter',
    authNote: 'Treba API ključ (sk-or-...). Agenti dobivaju PUNE alate (bash/read/write) preko agentic tool-loopa. Trošak se naplaćuje po pozivu.',
    models: orEnabled ? OR_CURATED : [],
  })
  if (orEnabled) models.push(...OR_CURATED)

  return { providers, models }
}

// ── Dežurni (rezervni model) — D4 / TASK-4633 ─────────────────────────────────────────────
// Model se dosad mijenjao ručnim uređivanjem `config/dezurni.json`. Ploča sada nudi izbor iz
// ŽIVOG popisa modela s Ollame koju dežurni doista zove (njegov `baseUrl`, ne onaj iz
// model-config.json) — popis koji laže gori je od nikakvog popisa.
// Bez restarta: i `dezurni.py` i `dezurni.ts` čitaju datoteku pri svakom pozivu.

async function handleDezurniConfigGet(): Promise<Response> {
  const json = (o: unknown, s = 200) =>
    new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } })
  try {
    const postavke = loadDezurniConfig()
    const davatelj = String(postavke.provider || 'ollama').toLowerCase()
    let modeli: string[] = []
    let dostupno = false
    let greska: string | null = null

    if (davatelj === 'ollama') {
      // Ollamin popis je ŽIV (s njezina `/api/tags`) — popis koji laže gori je od nikakvog.
      try {
        modeli = await fetchOllamaModels(String(postavke.baseUrl))
        dostupno = true
      } catch (e: any) {
        greska = String(e && e.message ? e.message : e)
      }
    } else if (davatelj === 'openrouter') {
      modeli = (await openrouterModeli()).slice(0, 60)
      dostupno = modeli.length > 0
      if (!dostupno) greska = 'katalog OpenRoutera nije dostupan'
    } else {
      // Ostali davatelji nemaju javni katalog: nudi se poznat popis, a ploča dopušta i
      // ručno upisano ime modela — polazište, ne ograda.
      modeli = POZNATI_MODELI_DEZURNI[davatelj] || []
      const d = davateljiDezurnog()[davatelj]
      dostupno = !!d?.spreman
      if (!dostupno) greska = d?.zasto || 'davatelj nije spreman'
    }
    // Trenutačni model mora ostati u popisu i kad je poslužitelj nedostupan — inače bi
    // dropdown pri prvom otvaranju tiho pokazao tuđu vrijednost.
    if (postavke.model && !modeli.includes(String(postavke.model))) modeli.unshift(String(postavke.model))
    return json({
      postavke, modeli, dostupno, greska,
      putanja: DEZURNI_CONFIG_PATH,
      provideri: podrzaniProvideri(),
      upotrebljivi: upotrebljiviProvideri(),
      davatelji: davateljiDezurnog(),
      poznatiModeli: POZNATI_MODELI_DEZURNI,
      granice: GRANICE,
      stanje: citajDezurniStanje(),
    })
  } catch (err) {
    return json({ error: String(err) }, 500)
  }
}

/**
 * Probni poziv dežurnog — jedini dokaz da odabrani davatelj STVARNO odgovara.
 * Zove se sam most (`tools/Telegram/dezurni.ts`), ne preslika njegove logike: preslika bi
 * mogla proći dok pravi put ne radi, a to je točno kvar koji ovo treba otkriti.
 */
async function handleDezurniProba(): Promise<Response> {
  const json = (o: unknown, s = 200) =>
    new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } })
  const put = join(process.env.HOME || homedir(), '.claude/tools/Telegram/dezurni.ts')
  if (!existsSync(put)) {
    return json({ ok: false, greska: `most dežurnog nije na ovom stroju (${put})` }, 200)
  }
  try {
    const most = await import(put)
    if (typeof most.probaModela !== 'function') {
      return json({ ok: false, greska: 'most nema probaModela() — stara inačica datoteke' }, 200)
    }
    const r = await most.probaModela()
    console.log(`[DEZURNI] proba: ${r.ok ? 'RADI' : 'NE RADI'} ${r.provider}/${r.model} (${r.ms} ms)`)
    return json(r)
  } catch (e: any) {
    return json({ ok: false, greska: String(e && e.message ? e.message : e) }, 200)
  }
}

/** Radi li dežurstvo upravo sada — isti zapis koji piše `dezurni.ts` (data/dezurni.stanje.json). */
function citajDezurniStanje(): { dezurstvo: boolean; uzastopnihGresaka: number; od?: string } {
  try {
    const p = join(process.env.HOME || homedir(), '.claude/regoc/data/dezurni.stanje.json')
    const s = JSON.parse(readFileSync(p, 'utf-8'))
    return {
      dezurstvo: !!s.dezurstvo,
      uzastopnihGresaka: Number(s.uzastopnihGresaka) || 0,
      od: s.od,
    }
  } catch {
    return { dezurstvo: false, uzastopnihGresaka: 0 }
  }
}

async function handleDezurniConfigPut(req: Request): Promise<Response> {
  const json = (o: unknown, s = 200) =>
    new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } })
  let tijelo: unknown
  try {
    tijelo = await req.json()
  } catch {
    return json({ error: 'Neispravan JSON' }, 400)
  }
  const provjera = validateDezurniPatch(tijelo)
  if (!provjera.ok) return json({ error: provjera.greske.join('; '), greske: provjera.greske }, 400)
  try {
    const zakrpa = { ...provjera.zakrpa }
    // Model prethodnog davatelja kod novoga ne postoji (`qwen3:8b` nije model na Anthropicu).
    // Bez ovoga bi promjena davatelja ostavila postavku koja izgleda ispravno, a u kvaru bi
    // dala 404 s druge strane — tiha smrt dežurnog točno kad treba raditi.
    const staro = loadDezurniConfig()
    if (zakrpa.provider && zakrpa.provider !== staro.provider && !zakrpa.model) {
      zakrpa.model = zadaniModelZa(zakrpa.provider) || String(staro.model || '')
    }
    const postavke = saveDezurniConfig(zakrpa)
    console.log(`[DEZURNI] postavke promijenjene s ploče: ${JSON.stringify(zakrpa)}`)
    return json({ ok: true, postavke })
  } catch (err) {
    return json({ error: String(err) }, 500)
  }
}

// Bot token + chat id + slanje obavijesti. NE ovisi o ~/.claude/tools/Telegram/ (Klaudio).
// Koristi izravni fetch prema https://api.telegram.org/bot<token>/sendMessage.

function handleTelegramConfigGet(): Response {
  const json = (o: unknown, s = 200) =>
    new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } })
  try {
    // Tijelo slaze `odgovorTelegramPloci` — ondje je i jedino mjesto koje odlucuje sto
    // NE izlazi. Prije je ovdje stajao komentar „NE otkrivaj vrijednost", a `postavke` su
    // se vracale cijele, s tokenom (revizija TASK-4801, nalaz B2).
    return json(odgovorTelegramPloci(loadTelegramConfig(), TELEGRAM_CONFIG_PATH))
  } catch (err) {
    return json({ error: String(err) }, 500)
  }
}

async function handleTelegramConfigPut(req: Request): Promise<Response> {
  const json = (o: unknown, s = 200) =>
    new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } })
  let tijelo: unknown
  try {
    tijelo = await req.json()
  } catch {
    return json({ error: 'Neispravan JSON' }, 400)
  }
  const provjera = validateTelegramPatch(tijelo)
  if (!provjera.ok) return json({ error: provjera.greske.join('; '), greske: provjera.greske }, 400)
  try {
    const postavke = saveTelegramConfig(provjera.zakrpa)
    // Ni odgovor ni dnevnik ne nose vrijednost tajne — dnevnik zna SAMO koja su se polja
    // promijenila. `JSON.stringify(zakrpa)` je ispisivao token u cistom tekstu.
    console.log(`[TELEGRAM] postavke promijenjene s ploce: ${Object.keys(provjera.zakrpa).join(', ')}`)
    const odgovor = odgovorTelegramPloci(postavke, TELEGRAM_CONFIG_PATH)
    return json({ ok: true, postavke: odgovor.postavke, stanje: odgovor.stanje })
  } catch (err) {
    return json({ error: String(err) }, 500)
  }
}

async function handleTelegramProba(): Promise<Response> {
  const json = (o: unknown, s = 200) =>
    new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } })
  try {
    // Peta proba dobiva prigusenje (revizija TASK-4801, S3). Ovdje nema SSRF-a — odrediste
    // je uvijek `api.telegram.org` — ali gumb bez ogranicenja jest slanje poruka u nizu na
    // tudji chat, dakle nas bot kao posrednik.
    const p = prigusenje('telegram')
    if (!p.ok) return json({ ok: false, greska: `pricekaj jos ${Math.ceil(p.cekajMs / 1000)} s prije nove probe` })
    const r = await posaljiTelegramPoruku('🧪 Testna poruka iz TaskManagerAI — Telegram integracija radi!')
    console.log(`[TELEGRAM] probno slanje: ${r.ok ? 'RADI' : 'NE RADI'} — ${r.greska || ''}`)
    return json(r)
  } catch (e: any) {
    return json({ ok: false, greska: String(e && e.message ? e.message : e) }, 200)
  }
}

// ── Ulazni kanal Telegrama (poller) — TASK-4800 ───────────────────────────────
// Stanje petlje NE živi u konfiguraciji: konfiguracija je ono što je korisnik izabrao,
// stanje je ono što je stroj zatekao. Da su zajedno, svaki PUT s ploče pregazio bi
// `offset` i vratio već obrađene poruke natrag u obradu.

function handleTelegramUlazStanje(): Response {
  const json = (o: unknown, s = 200) =>
    new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } })
  try {
    return json(stanjeUlaza())
  } catch (err) {
    return json({ error: String(err) }, 500)
  }
}

/** Jedan `getUpdates` s `timeout=0`: koliko poruka čeka i iz kojih chatova — bez otvaranja
 *  ijednog zadatka. Bez toga korisnik ne može doznati `chat.id` svoje grupe. */
async function handleTelegramUlazProba(): Promise<Response> {
  const json = (o: unknown, s = 200) =>
    new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } })
  try {
    return json(await probajUlaz())
  } catch (e: any) {
    return json({ ok: false, greska: String(e && e.message ? e.message : e) }, 200)
  }
}

// ── Integracije: Nextcloud, e-pošta, GitLab, GitHub (TASK-4800) ───────────────
// Četiri modula, JEDAN skup ruta. Tablica umjesto četiri gotovo jednaka para funkcija —
// inače bi pravilo „tajna se nikad ne vraća" postojalo u četiri preslike, od kojih bi se
// jedna prije ili poslije razišla s ostalima.

interface IntegracijaZapis {
  naziv: string
  load: () => any
  validate: (t: unknown) => { ok: boolean; greske: string[]; zakrpa: any }
  save: (z: any) => any
  stanje: (cfg?: any) => any
  proba: () => Promise<{ ok: boolean; greska?: string; detalj?: unknown }>
  /** Putanja se razrjesava pri svakom pozivu (v. ConfigModul.putanja). */
  putanja: () => string
  /**
   * Opis sheme za ploču (TASK-4803). Bez njega je ploča crtala polja po TIPU VRIJEDNOSTI,
   * pa je `smjer` s tri dopuštene vrijednosti izgledao kao slobodan tekst, a nijedno polje
   * nije znalo reći je li obvezno.
   */
  shema: () => Record<string, unknown>
}

const INTEGRACIJE: Record<string, IntegracijaZapis> = {
  nextcloud: {
    naziv: 'Nextcloud', load: loadNextcloudConfig, validate: validateNextcloudPatch,
    save: saveNextcloudConfig, stanje: stanjeNextcloud, proba: probajNextcloud,
    putanja: NEXTCLOUD_CONFIG_PATH, shema: () => nextcloudKonfigModul.opisSheme(),
  },
  email: {
    naziv: 'E-pošta', load: loadEmailConfig, validate: validateEmailPatch,
    save: saveEmailConfig, stanje: stanjeEmail, proba: probajEmail,
    putanja: EMAIL_CONFIG_PATH, shema: () => emailKonfigModul.opisSheme(),
  },
  gitlab: {
    naziv: 'GitLab', load: loadGitLabConfig, validate: validateGitLabPatch,
    save: saveGitLabConfig, stanje: stanjeGitLab, proba: probajGitLab,
    putanja: GITLAB_CONFIG_PATH, shema: () => gitlabKonfigModul.opisSheme(),
  },
  github: {
    naziv: 'GitHub', load: loadGitHubConfig, validate: validateGitHubPatch,
    save: saveGitHubConfig, stanje: stanjeGitHub, proba: probajGitHub,
    putanja: GITHUB_CONFIG_PATH, shema: () => githubKonfigModul.opisSheme(),
  },
}

/** Zadnji ishod probe po integraciji. Bez toga značka nakon osvježavanja stranice laže:
 *  „podešeno" nije isto što i „provjereno". */
const INTEGRACIJE_STANJE_PATH = stanjePutanja('integracije.json')

function citajIshodeProba(): Record<string, { ts: string; ok: boolean; greska?: string }> {
  try {
    return JSON.parse(readFileSync(INTEGRACIJE_STANJE_PATH, 'utf-8')) || {}
  } catch {
    return {}
  }
}

function zapisiIshodProbe(ime: string, ok: boolean, greska?: string): void {
  try {
    const svi = citajIshodeProba()
    svi[ime] = { ts: new Date().toISOString(), ok, greska }
    osigurajMapu(INTEGRACIJE_STANJE_PATH)
    const tmp = `${INTEGRACIJE_STANJE_PATH}.tmp-${process.pid}`
    writeFileSync(tmp, JSON.stringify(svi, null, 2) + '\n', 'utf-8')
    renameSync(tmp, INTEGRACIJE_STANJE_PATH)
  } catch { /* ishod probe nije vrijedan rušenja odgovora */ }
}

function handleIntegracijaGet(ime: string): Response {
  const json = (o: unknown, s = 200) =>
    new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } })
  const zapis = INTEGRACIJE[ime]
  if (!zapis) return json({ error: `nepoznata integracija: ${ime}` }, 404)
  try {
    const postavke = zapis.load()
    return json({
      ime, naziv: zapis.naziv, postavke, stanje: zapis.stanje(postavke),
      shema: zapis.shema(),
      putanja: zapis.putanja(), zadnjaProba: citajIshodeProba()[ime] || null,
    })
  } catch (err) {
    return json({ error: String(err) }, 500)
  }
}

async function handleIntegracijaPut(ime: string, req: Request): Promise<Response> {
  const json = (o: unknown, s = 200) =>
    new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } })
  const zapis = INTEGRACIJE[ime]
  if (!zapis) return json({ error: `nepoznata integracija: ${ime}` }, 404)
  let tijelo: unknown
  try { tijelo = await req.json() } catch { return json({ error: 'Neispravan JSON' }, 400) }
  const provjera = zapis.validate(tijelo)
  if (!provjera.ok) return json({ error: provjera.greske.join('; '), greske: provjera.greske }, 400)
  try {
    const postavke = zapis.save(provjera.zakrpa)
    // U dnevnik idu IMENA polja, ne vrijednosti — zakrpa može nositi korisničko ime.
    console.log(`[${ime.toUpperCase()}] postavke promijenjene s ploče: ${Object.keys(provjera.zakrpa).join(', ')}`)
    return json({ ok: true, postavke, stanje: zapis.stanje(postavke) })
  } catch (err) {
    return json({ error: String(err) }, 500)
  }
}

async function handleIntegracijaProba(ime: string): Promise<Response> {
  const json = (o: unknown, s = 200) =>
    new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } })
  const zapis = INTEGRACIJE[ime]
  if (!zapis) return json({ error: `nepoznata integracija: ${ime}` }, 404)
  try {
    // Ishod probe je PODATAK, ne kvar poslužitelja → uvijek HTTP 200.
    const r = await zapis.proba()
    zapisiIshodProbe(ime, r.ok, r.greska)
    console.log(`[${ime.toUpperCase()}] proba: ${r.ok ? 'RADI' : 'NE RADI'} — ${r.greska || ''}`)
    return json(r)
  } catch (e: any) {
    const greska = String(e && e.message ? e.message : e)
    zapisiIshodProbe(ime, false, greska)
    return json({ ok: false, greska }, 200)
  }
}

/** Sažetak za skupinu „Integracije" na Config stranici (ikona · naziv · značka). */
function handleIntegracijeSazetak(): Response {
  const json = (o: unknown, s = 200) =>
    new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } })
  const probe = citajIshodeProba()
  const popis = Object.entries(INTEGRACIJE).map(([ime, z]) => {
    let stanje: any = {}
    try { stanje = z.stanje(z.load()) } catch { stanje = { spreman: false, zastoKey: 'int_zasto_greska' } }
    const zadnja = probe[ime] || null
    const znacka = !stanje.ukljucen ? 'iskljuceno' : (stanje.spreman && zadnja?.ok ? 'radi' : 'nepotpuno')
    return { ime, naziv: z.naziv, stanje, zadnjaProba: zadnja, znacka }
  })
  return json({ integracije: popis })
}

// ── Orkestrator (sloj 1) — TASK-4800 / ADR-0001 ───────────────────────────────

function handleOrchestratorGet(): Response {
  const json = (o: unknown, s = 200) =>
    new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } })
  try {
    const postavke = loadOrchestratorConfig()
    return json({
      postavke,
      stanje: stanjeOrkestratora(postavke),
      putanja: orchestratorConfigPath(),
      // Strop NIJE polje orchestrator.json nego postavka (kartica „Usporedni agenti").
      strop: taskManager.getConcurrencySetting().value,
      agenata: KonfiguracijskiRegistar.izDatoteke(postavke.agents.registryPath || undefined).list().length,
    })
  } catch (err) {
    return json({ error: String(err) }, 500)
  }
}

async function handleOrchestratorPut(req: Request): Promise<Response> {
  const json = (o: unknown, s = 200) =>
    new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } })
  let tijelo: unknown
  try { tijelo = await req.json() } catch { return json({ error: 'Neispravan JSON' }, 400) }
  const provjera = validateOrchestratorPatch(tijelo)
  if (!provjera.ok) return json({ error: provjera.greske.join('; '), greske: provjera.greske }, 400)
  try {
    const postavke = saveOrchestratorConfig(provjera.zakrpa)
    console.log(`[ORCHESTRATOR] postavke promijenjene s ploče: ${Object.keys(provjera.zakrpa).join(', ')}`)
    return json({ ok: true, postavke, stanje: stanjeOrkestratora(postavke) })
  } catch (err) {
    return json({ error: String(err) }, 500)
  }
}

// ── Ulazna vrata — U1 / TASK-4261, poopćena u U6 / TASK-4266 ──────────────────────────────
// Prekidač po IZVORU s TRI položaja (off/shadow/on) + zadani projekt po izvoru + pragovi A/B/C.
// Razrada §1: kvačica ne pokriva uvođenje u sjeni, pa je ovo prekidač, ne boolean.
// Bez restarta: i pozivatelji i ploča čitaju datoteku pri svakom prolazu.
// Ključ više nije `chatId` nego izvor (`email`, `telegram:-123`, `*`); stari nazivi polja
// (`perGroup`, `projectByGroup`) ostaju u odgovoru i u zakrpi da sučelje ne pukne.

function handleIngestGateGet(): Response {
  const json = (o: unknown, s = 200) =>
    new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } })
  try {
    const postavke = loadIngestConfig()
    // Popis projekata služi padajućem izborniku „zadani projekt grupe" — ploča ne smije
    // nuditi projekt koji u bazi ne postoji, jer bi zadatci padali u pretinac PRJ-033.
    let projekti: string[] = []
    try {
      projekti = projectManager.getProjects({}).map((p: any) => String(p.id)).filter(Boolean)
    } catch { /* popis je pomoć, ne uvjet — ploča radi i bez njega */ }
    for (const p of Object.values(postavke.projectByGroup)) {
      if (p && !projekti.includes(p)) projekti.unshift(p)
    }
    // „grupe" su ostale ime polja zbog sučelja; sadržaj su ključevi izvora koje
    // postavke poznaju (`email`, `telegram:-123`, `*`) — natpis je sam ključ.
    const grupe: Record<string, string> = {}
    for (const k of Object.keys(postavke.perSource)) grupe[k] = k
    return json({
      postavke, projekti, grupe,
      nacini: NACINI_ULAZ,
      granice: GRANICE_ULAZA,
      putanja: INGEST_CONFIG_PATH,
    })
  } catch (err) {
    return json({ error: String(err) }, 500)
  }
}

async function handleIngestGatePut(req: Request): Promise<Response> {
  const json = (o: unknown, s = 200) =>
    new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } })
  let tijelo: unknown
  try {
    tijelo = await req.json()
  } catch {
    return json({ error: 'Neispravan JSON' }, 400)
  }
  // Poredak pragova se provjerava prema onome što JE na disku — ploča šalje jedno polje.
  const provjera = validateIngestPatch(tijelo, loadIngestConfig())
  if (!provjera.ok) return json({ error: provjera.greske.join('; '), greske: provjera.greske }, 400)
  try {
    const postavke = saveIngestConfig(provjera.zakrpa)
    console.log(`[ULAZNA-VRATA] postavke promijenjene s ploče: ${JSON.stringify(provjera.zakrpa)}`)
    return json({ ok: true, postavke })
  } catch (err) {
    return json({ error: String(err) }, 500)
  }
}

// ── POST /api/ingest — generički ulaz (U6 / TASK-4266) ────────────────────────────────────
//
// Pet polja koja ne znaju za kanal: source, externalId, replyTo, text, senderName.
// Telegram, e-pošta i konzola su odsad SAMO pozivatelji ovog ulaza — sve što je dosad
// radio most (ocjena težine, prag A/B/C, izbor projekta, opis s koracima) živi ovdje.
//
// ZAŠTO ULAZ NE STVARA ZADATAK SAM. Zadatak i dalje nastaje kroz `handleCreateTask` —
// jedini ingress ploče. Drugi stvaratelj značio bi granu koja zaobilazi vratare
// (anti-echo, prazan opis, strop stvaranja) i dvije istine o tome tko je zadatak otvorio.
// Zato ovdje stoji unutarnji `POST /api/tasks`: odgovor tih vratara (422, 429) prolazi
// nepromijenjen do pozivatelja.
async function handleIngest(req: Request): Promise<Response> {
  const json = (o: unknown, s = 200) =>
    new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } })

  let tijelo: unknown
  try {
    tijelo = await req.json()
  } catch {
    return json({ ok: false, error: 'Neispravan JSON' }, 400)
  }

  const provjera = validirajZahtjev(tijelo)
  if (!provjera.ok) {
    return json({ ok: false, error: provjera.greske.join('; '), greske: provjera.greske }, 400)
  }
  const zahtjev = provjera.zahtjev!

  let odluka
  try {
    odluka = procijeniIngest(zahtjev, loadIngestConfig())
  } catch (err) {
    console.error(`[ULAZ] ocjena pukla (${String(err)}) — zahtjev odbijen, ništa nije otvoreno`)
    return json({ ok: false, error: `Ocjena ulaza nije uspjela: ${String(err)}` }, 500)
  }
  // Mjerenje teče u SVA TRI položaja — inače bi se točno pri paljenju izgubila usporedba
  // „što bi ulaz napravio" ↔ „što je napravio".
  zapisiUlaz(odluka.zapis)

  const sazetak = {
    action: odluka.akcija,
    mode: odluka.nacin,
    postupak: odluka.postupak,
    effort: odluka.effort,
    weight: odluka.tezina,
    weightReason: odluka.tezinaRazlog,
    projectId: odluka.projectId,
    projectSource: odluka.projectSource,
    needsApproval: odluka.trebaPotvrdu,
    reason: odluka.razlog,
    replyTo: zahtjev.replyTo ?? null,
    log: INGEST_LOG_PATH,
  }

  if (odluka.akcija !== 'zadatak') {
    console.log(`[ULAZ] ${zahtjev.source}${zahtjev.externalId ? ':' + zahtjev.externalId : ''} — `
      + `${odluka.akcija} (${odluka.effort}/${odluka.tezina}): ${odluka.razlog}`)
    return json({ ok: true, created: false, ...sazetak })
  }

  const stvaranje = await handleCreateTask(new Request('http://localhost/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(odluka.zadatak),
  }))
  let stvoreno: any = null
  try { stvoreno = await stvaranje.clone().json() } catch { /* odgovor bez tijela */ }

  if (!stvaranje.ok) {
    // Odbijenica vratara ide van doslovno (isti kôd i razlog), uz ocjenu ulaza uz nju.
    console.warn(`[ULAZ] ${zahtjev.source}: zadatak NIJE otvoren (HTTP ${stvaranje.status})`)
    return json({ ok: false, created: false, ...sazetak, taskManager: stvoreno }, stvaranje.status)
  }

  const taskId = stvoreno?.id || stvoreno?.task?.id || null

  // Broj zadatka postoji tek POSLIJE stvaranja, a koraci 5 i 6 ga trebaju doslovno
  // (`git checkout -b zadatak/TASK-####` nije naredba nego rebus). Zato se opis
  // jednom prepiše s pravim brojem. Ide kroz `updateTask`, isti put kojim ide i
  // PUT s ploče — vratari zatvaranja se ne dotiču, mijenja se samo opis.
  if (taskId) {
    try {
      const sKonacnimId = renderirajOpis({
        message: zahtjev.text,
        weight: odluka.tezina,
        source: zahtjev.source,
        externalId: zahtjev.externalId,
        replyTo: zahtjev.replyTo,
        senderName: zahtjev.senderName,
        projectId: odluka.projectId,
        taskId,
        pragB: odluka.zapis.pragovi.B,
        textOnly: odluka.zadatak!.tags.includes('samo-tekst'),
        receivedAt: odluka.zapis.ts,
      })
      taskManager.updateTask(taskId, { description: sKonacnimId })
    } catch (err) {
      console.warn(`[ULAZ] opis ${taskId} ostao s oznakom TASK-#### (${String(err)})`)
    }
  }

  console.log(`[ULAZ] ${zahtjev.source}${zahtjev.externalId ? ':' + zahtjev.externalId : ''} → `
    + `${taskId} (${odluka.effort}/${odluka.tezina}, projekt ${odluka.projectId})`)
  return json({
    ok: true, created: true, taskId,
    title: odluka.zadatak!.title,
    tags: odluka.zadatak!.tags,
    ...sazetak,
    task: stvoreno,
  }, 201)
}

// PUT /api/models/providers/:id — postavke providera (enabled, baseUrl, token).
async function handleSetProvider(providerId: string, req: Request): Promise<Response> {
  const json = (o: unknown, s = 200) =>
    new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } })
  if (!['anthropic', 'ollama', 'openai', 'google', 'openrouter'].includes(providerId)) {
    return json({ error: 'Unknown provider' }, 400)
  }
  try {
    const body = (await req.json()) as { enabled?: boolean; baseUrl?: string; apiKey?: string }
    const HOME = process.env.HOME || homedir()
    const mcPath = join(HOME, '.claude/regoc/models/model-config.json')
    if (!existsSync(mcPath)) return json({ error: 'model-config.json not found' }, 500)
    const mc = JSON.parse(readFileSync(mcPath, 'utf-8'))
    if (!mc.providers) mc.providers = {}
    if (!mc.providers[providerId]) mc.providers[providerId] = {}
    const p = mc.providers[providerId]

    if (typeof body.enabled === 'boolean') p.enabled = body.enabled
    if (typeof body.baseUrl === 'string') {
      const u = body.baseUrl.trim()
      if (u && !/^https?:\/\/[^\s]+$/.test(u)) return json({ error: 'Invalid baseUrl (očekivano http://host:port)' }, 400)
      if (u) p.baseUrl = u
    }
    if (typeof body.apiKey === 'string') {
      if (body.apiKey === '') delete p.apiKey
      else p.apiKey = body.apiKey
    }

    // TASK-4894: atomno + revizijski trag (v. ModelConfigWriter.ts). Prije je ovo bio
    // gol writeFileSync preko žive datoteke — pad usred upisa daje krnji JSON, koji
    // resolveAgentTarget tiho proguta i vrati SVE agente na plivajući alias.
    saveModelConfig(mcPath, _mc => { Object.assign(_mc, mc) }, 'ploca')
    return json({ status: 'saved', providerId, enabled: p.enabled !== false, baseUrl: p.baseUrl || null, hasAuth: !!p.apiKey })
  } catch (err) {
    return json({ error: String(err) }, 400)
  }
}

function buildInfoPayload(): Record<string, unknown> {
  const HOME = process.env.HOME || homedir()
  const agentOverrides = loadAgentOverrides(HOME)

  // Load agent registry
  let agents: Record<string, unknown>[] = []
  let agentCount = 0
  try {
    const regPath = join(HOME, '.claude/regoc/REGOC_AGENTS.json')
    if (existsSync(regPath)) {
      const reg = JSON.parse(readFileSync(regPath, 'utf-8'))
      const agentMap = reg.agents || {}
      agentCount = Object.keys(agentMap).length

      const tierMap: Record<string, string> = { opus: 'frontier', sonnet: 'strong', haiku: 'basic' }
      const reqMap: Record<string, { minContext: number; tools: boolean; notes: string }> = {
        regoc: { minContext: 128000, tools: true, notes: 'Orchestrator — frontier required' },
        kosjenka: { minContext: 128000, tools: true, notes: 'Architect — strategic planning' },
        jelena: { minContext: 128000, tools: true, notes: 'Engineer — code generation' },
        malik: { minContext: 128000, tools: true, notes: 'Security — OWASP, CVE awareness' },
        manda: { minContext: 128000, tools: false, notes: 'Researcher — deep analysis' },
        dora: { minContext: 128000, tools: false, notes: 'Analyst — multi-perspective' },
        potjeh: { minContext: 64000, tools: true, notes: 'QA — testing, verification' },
        gita: { minContext: 64000, tools: false, notes: 'Artist — HTML/SVG/Canvas' },
        grga: { minContext: 64000, tools: true, notes: 'Designer — UI/UX, vision preferred' },
        klaudio: { minContext: 32000, tools: false, notes: 'Telegram 24/7 — low cost, fast' },
        stribor: { minContext: 64000, tools: true, notes: 'Analiza glasa i govora — transkripcija, prozodija, dijarizacija' },
        emard: { minContext: 128000, tools: true, notes: 'FPGA Expert — Verilog, CDC, timing' },
      }

      agents = Object.entries(agentMap).map(([id, a]: [string, any]) => {
        const req = reqMap[id] || { minContext: 64000, tools: false, notes: '' }
        // Alati NE ovise o statičkoj reqMap zastavici nego o STVARNOM modelu:
        // svi Claude-spawnani agenti (claude --print / claude -p) imaju PUNE alate;
        // agent na lokalnom Ollama modelu (API spawn, text-only) NEMA alate.
        const ovSpec = agentOverrides[id]
        const effProvider = ovSpec ? String(ovSpec).split(':')[0] : 'anthropic'
        // Agentski CLI-jevi/tool-loop imaju PUNE alate: Claude (claude --print), Gemini (gemini --yolo),
        // Kimi (kimi CLI), OpenRouter (openrouter-agent tool-loop). Samo Ollama je tekstualno (bez alata).
        const hasTools = ['anthropic', 'geminicli', 'kimicli', 'openrouter'].includes(effProvider)
        return {
          id,
          name: a.name || id,
          role: a.role || '',
          roleKey: 'cfg_agent_role_' + id,
          minTier: tierMap[a.model] || 'strong',
          currentModel: a.model || 'unknown',
          override: agentOverrides[id] || null,
          fixed: FIXED_INTERFACE_AGENTS.has(id),
          minContext: req.minContext,
          requiresTools: hasTools,
          toolsNote: hasTools ? 'Puni alati (Bash, datoteke, RAG, web…)' : 'lokalno (Ollama) — tekstualno, bez alata',
          toolsNoteKey: hasTools ? 'cfg_alati_puni' : 'cfg_alati_lokalno',
          notes: req.notes,
          notesKey: 'cfg_agent_notes_' + id,
        }
      })
    }
  } catch {}

  // Load model config
  let providers: Record<string, unknown>[] = []
  let providerCount = 0
  try {
    const mcPath = join(HOME, '.claude/regoc/models/model-config.json')
    if (existsSync(mcPath)) {
      const mc = JSON.parse(readFileSync(mcPath, 'utf-8'))
      const provs = mc.providers || {}
      const defaults = mc.defaults || {}

      const providerModels: Record<string, Array<{ id: string; tier: string }>> = {
        anthropic: [
          { id: 'claude-opus-4-7', tier: 'frontier' },
          { id: 'claude-sonnet-4-6', tier: 'strong' },
          { id: 'claude-haiku-4-5', tier: 'basic' },
        ],
        openai: [
          { id: 'gpt-4o', tier: 'strong' },
          { id: 'gpt-4o-mini', tier: 'good' },
          { id: 'o4-mini', tier: 'strong' },
        ],
        google: [
          { id: 'gemini-2.5-pro', tier: 'frontier' },
          { id: 'gemini-2.5-flash', tier: 'good' },
        ],
        ollama: [
          { id: 'qwen3:8b', tier: 'basic' },
          { id: 'llama3.2:3b', tier: 'classifier' },
          { id: 'qwen3-embedding:8b', tier: 'classifier' },
        ],
      }

      providers = Object.entries(provs)
        .filter(([k]) => k !== 'custom')
        .map(([id, p]: [string, any]) => ({
          id,
          name: id.charAt(0).toUpperCase() + id.slice(1),
          enabled: p.enabled || false,
          online: p.enabled || false,
          models: providerModels[id] || [],
        }))

      providerCount = providers.filter((p: any) => p.enabled).length
    }
  } catch {}

  // Load module config
  let modules: Record<string, unknown>[] = []
  let modulesEnabled = 0
  try {
    const modPath = join(HOME, '.claude/regoc/modules/module-config.json')
    if (existsSync(modPath)) {
      const mc = JSON.parse(readFileSync(modPath, 'utf-8'))
      const mods = mc.modules || {}

      const degradationMap: Record<string, string> = {
        'mod-rag': 'Keyword search (ripgrep)',
        'mod-telegram': 'Console notifications',
        'mod-teamspeak': 'No voice chat',
        'mod-voice': 'Text-only notifications',
        'mod-dashboard': 'CLI-only task management',
        'mod-email': 'No email',
        'mod-gitlab': 'No GitLab',
        'mod-github': 'No GitHub',
        'mod-nextcloud': 'No file sharing',
        'mod-security': 'No tool inspection',
        'mod-knowledge': 'No knowledge graph',
      }

      const providesMap: Record<string, string[]> = {
        'core-daemon': ['messaging', 'orchestration', 'agent-spawn'],
        'core-models': ['model-routing', 'multi-provider'],
        'core-taskmanager': ['task-crud', 'task-api'],
        'mod-rag': ['semantic-search', 'embeddings'],
        'mod-telegram': ['telegram-messaging', 'notifications'],
        'mod-teamspeak': ['voice-chat'],
        'mod-voice': ['tts', 'voice-notifications'],
        'mod-dashboard': ['web-dashboard', 'task-api'],
        'mod-email': ['email-send', 'email-receive'],
        'mod-gitlab': ['git-hosting', 'ci-cd'],
        'mod-github': ['git-hosting-public'],
        'mod-nextcloud': ['file-sharing', 'deck-tasks'],
        'mod-security': ['tool-inspection', 'prompt-guard', 'audit-log'],
        'mod-knowledge': ['knowledge-graph', 'wikilinks'],
      }

      modules = Object.entries(mods).map(([id, m]: [string, any]) => {
        const req = id.startsWith('core-')
        const en = m.enabled !== false
        if (en) modulesEnabled++
        return {
          id,
          name: id.replace('core-', 'Core: ').replace('mod-', ''),
          enabled: en,
          required: req,
          provides: providesMap[id] || [],
          degradation: degradationMap[id] || '-',
        }
      })
    }
  } catch {}

  const rules = [
    { number: 1, name: 'WRITE PERMISSIONS', summary: 'Only ./  and ~/app/regoc_system/ — rest is read-only' },
    { number: 2, name: 'RAG-FIRST', summary: 'Search RAG before saying "I don\'t know"' },
    { number: 3, name: 'SAMO REGOČ AGENTI', summary: '12 named agents only — never PAI generic (Serena, Marcus...)' },
    { number: 4, name: 'PUNI IDENTITET PRI SPAWNU', summary: 'Full identity pre-loaded at spawn — IdentityBlock.ts builds it from REGOC_AGENTS.json (AgentFactory + UnifiedSpawnPipeline deprecated, ADR-0004)' },
    { number: 5, name: 'ERROR TRACKING', summary: 'Investigate → fix root cause → document in LESSONS/ → RAG' },
    { number: 6, name: 'ZOD VALIDATION', summary: 'Runtime type safety for all agents' },
    { number: 7, name: 'SERENA MCP', summary: 'Use for files >1000 lines (70-90% token savings)' },
    { number: 8, name: 'SECURITY ISOLATION', summary: 'Gita & Grga: no IPs, ports, paths, credentials' },
    { number: 9, name: 'INFRASTRUCTURE', summary: 'TaskWebUI:17781 | Voice:8888 | ChromaDB:18765 | Ollama:11434' },
    { number: 10, name: 'CONTEXT 75%', summary: 'Auto-save to RAG when context exceeds 75%' },
    { number: 11, name: 'CHECKPOINT FIRST', summary: 'CHECKPOINT block BEFORE task, not after' },
    { number: 12, name: 'PROGRESS NOTES', summary: 'Agents update TaskManager every 5 min' },
    { number: 13, name: '/tmp PROHIBITION', summary: 'Use ~/.tmp/ not /tmp/ (tmpfs too small)' },
    { number: 14, name: 'DOCKER PERSISTENCE', summary: 'Everything in volume mounts' },
    { number: 15, name: 'AUTO RAG SAVE', summary: 'Save to RAG immediately after every research' },
    { number: 16, name: 'MULTI-AGENT', summary: 'Kosjenka→design, Jelena→impl, Potjeh→test, Malik→security' },
    { number: 17, name: 'MONITORMODELOOP', summary: 'Continuous monitoring — check queue, spawn agents' },
    { number: 18, name: 'run_in_background=BROKEN', summary: 'Never use! Output is lost. BUG in Task tool.' },
    { number: 19, name: 'DELEGATE ALL TASKS', summary: 'Don\'t work alone — spawn agents for everything' },
    { number: 20, name: 'NEVER GENERIC FOR NAMED', summary: 'Always full identity — IdentityBlock.ts builds it from REGOC_AGENTS.json (AgentFactory deprecated, ADR-0004)' },
    { number: 21, name: 'KLAUDIO MEMORY', summary: '5 sessions, 30 min = new session, SQLite' },
    { number: 22, name: 'MESSAGE QUEUE', summary: 'SELECT/INSERT/UPDATE messages in messages.db' },
    { number: 23, name: 'ALWAYS TEST BEFORE DONE', summary: 'Never assume it works — VERIFY!' },
  ]

  return {
    system: {
      version: '5.0.0',
      fullName: 'REsursni Gestor za Orkestraciju Članova',
      principle: 'Orchestrate, don\'t execute',
      orchestratorModel: 'opus (frontier tier)',
      agentCount,
      moduleCount: modules.length,
      modulesEnabled,
      providerCount,
      platform: process.platform + ' ' + process.arch,
    },
    providers,
    agents,
    modules,
    infrastructure: [
      { name: 'TaskWebUI', endpoint: 'localhost:17781' },
      { name: 'VoiceServer', endpoint: 'localhost:8888' },
      { name: 'RegocPulse', endpoint: 'localhost:17780 (planned)' },
      // ADR-0001 §5.1: adresa se ČITA iz okoline, ne piše u kodu. Bez postavke se
      // pošteno kaže da servis nije podešen, umjesto da se prikaže tuđi poslužitelj.
      { name: 'ChromaDB', endpoint: process.env.TM_CHROMA_HOST
          ? `${process.env.TM_CHROMA_HOST}:${process.env.TM_CHROMA_PORT || '8000'}`
          : 'nije podešeno (TM_CHROMA_HOST)' },
      { name: 'Ollama', endpoint: process.env.TM_OLLAMA_URL || 'nije podešeno (TM_OLLAMA_URL)' },
      { name: 'STT Server', endpoint: 'localhost:8787 (disabled)' },
    ],
    databases: [
      { name: 'messages.db', purpose: 'Inter-agent communication (MessageQueue)' },
      { name: 'regoc.db', purpose: 'Task management (tasks, projects, queue, knowledge graph)' },
      { name: 'audit.db', purpose: 'Security audit log' },
    ],
    rules,
    availableModels: getEffectiveModels(),
    coreComponents: [
      // TASK-3670 (ADR-0004 O3): status je PROVJEREN, ne deklariran. Mjerilo je
      // dosežnost iz živih ulaznih točaka (RegocDaemon.ts, AgentDaemon.ts, TaskWebUI.ts)
      // po tranzitivnom grafu uvoza + provjera pokretača (shell/cron/hook/systemd).
      //   active     = dosežan iz žive ulazne točke (naveden dokaz uvoza)
      //   deprecated = napušten propisom, kod ostaje samo kao izvor teksta
      //   inactive   = kod postoji, 0 živih pozivatelja i nema procesa
      //   ondemand   = CLI koji se pokreće ručno, nije stalni servis
      //   planned    = nije napisano
      { name: 'RegocDaemon', status: 'active', descriptionKey: 'cfg_komp_regocdaemon', description: 'Main orchestration daemon — polls MessageQueue, spawns agents, watchdog' },
      { name: 'UnifiedSpawnPipeline', status: 'deprecated', descriptionKey: 'cfg_komp_unifiedspawnpipeline', description: 'NAPUŠTEN (ADR-0004 §5, odluka O3) — 0 pozivatelja iz daemona. Sastavljač verifikacijskog bloka prenesen u SpawnVerificationBlock.ts, koji vozi živi put (RegocDaemon.buildAgentPrompt + AgentDaemon.buildPrompt)' },
      { name: 'SystemAwarenessBlock', status: 'inactive', descriptionKey: 'cfg_komp_systemawarenessblock', description: '0 uvoznika — nijedan daemon ne ubacuje taj blok u prompt (grep "SystemAwarenessBlock" po .ts: samo vlastita datoteka i testovi)' },
      { name: 'ModelRouter', status: 'active', descriptionKey: 'cfg_komp_modelrouter', description: 'AI model-agnostic routing — 4 providera (Anthropic, OpenAI, Google, Ollama). Dosežan: RegocDaemon.ts:22 → LocalOffload.ts:50' },
      { name: 'ModuleRegistry', status: 'inactive', descriptionKey: 'cfg_komp_moduleregistry', description: 'Sama klasa ima 0 uvoznika; modules/module-config.json čita izravno TaskWebUI (linije 6601 i 9253), pa registar nije u pogonu' },
      { name: 'ModeClassifier', status: 'active', descriptionKey: 'cfg_komp_modeclassifier', description: 'Effort tier routing (E1-E5) — rule-based, bez AI poziva. Dosežan: RegocDaemon.ts:55, AgentDaemon.ts:48' },
      { name: 'MonitorLoop v4.0', status: 'inactive', descriptionKey: 'cfg_komp_monitorloop_v4_0', description: '7-fazni loop (OBSERVE→…→LEARN) — 0 uvoznika, nije uvezen ni u RegocDaemon ni u AgentDaemon i nema živog procesa (pgrep -af MonitorLoop prazan)' },
      { name: 'HelpPipeline', status: 'inactive', descriptionKey: 'cfg_komp_helppipeline', description: 'Agent-to-agent help requests — jedini uvoznik je MonitorLoop.ts:16, koji je i sam bez pozivatelja. Živa zamjena je tools/consult-potjeh.ts (upućuje se agentima iz RegocDaemon.ts:2344)' },
      { name: 'AgentSignals (BTW)', status: 'inactive', descriptionKey: 'cfg_komp_agentsignals_btw', description: 'File-based signaling — uvoznici su AgentCommunicationBridge.ts:23 i AgentMonitor.ts:39, oba bez pozivatelja; ~/.tmp/agent_signals je prazan od 19.05.2026.' },
      { name: 'AgentCommunicationBridge', status: 'inactive', descriptionKey: 'cfg_komp_agentcommunicationbridge', description: 'Most HelpPipeline → AgentSignals — 0 uvoznika; oba kraja mosta su također neaktivna' },
      { name: 'AgentPool', status: 'inactive', descriptionKey: 'cfg_komp_agentpool', description: 'Warm agent pool — 0 uvoznika; u daemonima nema koda za pool (grep "agentPool|warm.?pool" po RegocDaemon.ts i AgentDaemon.ts: 0 pogodaka)' },
      { name: 'AgentCheckpoint', status: 'inactive', descriptionKey: 'cfg_komp_agentcheckpoint', description: 'CHECKPOINT blok s peer porukama — 0 uvoznika. AgentDaemon ima VLASTITI, drugi mehanizam (SQLite checkpoint tablica + AgentResume.ts:41), to nije ovaj modul' },
      { name: 'AgentLogger', status: 'inactive', descriptionKey: 'cfg_komp_agentlogger', description: 'Unified JSONL logging — jedini uvoznik je AgentMonitor.ts:37, koji je bez pozivatelja' },
      { name: 'SecurityPipeline', status: 'inactive', descriptionKey: 'cfg_komp_securitypipeline', description: '3 inspektora na tool poziv — 0 uvoznika iz koda i iz hookova. Živi L1 je ~/.claude/hooks/SecurityValidator.hook.ts (settings.json: PreToolUse + UserPromptSubmit), koji NE koristi ovaj modul' },
      { name: 'PromptGuard', status: 'inactive', descriptionKey: 'cfg_komp_promptguard', description: 'Prompt injection detekcija (13 pravila) — 0 uvoznika izvan vlastite datoteke i testova' },
      { name: 'AuditLogger', status: 'active', descriptionKey: 'cfg_komp_auditlogger', description: 'Centralizirani security audit log (SQLite, 90-day retention). Dosežan: TaskWebUI.ts:9363 (dinamički import)' },
      { name: 'ISAGenerator', status: 'inactive', descriptionKey: 'cfg_komp_isagenerator', description: 'Ideal State Artifact — 0 pozivatelja; jedina pojava izvan testova je komentar u CriticGate.ts:302' },
      { name: 'KnowledgeGraph', status: 'inactive', descriptionKey: 'cfg_komp_knowledgegraph', description: 'SQLite relacijski graf znanja — jedini uvoznik je KnowledgeHarvester.ts:8, koji je i sam bez pozivatelja' },
      { name: 'WikilinkParser', status: 'inactive', descriptionKey: 'cfg_komp_wikilinkparser', description: '[[link]] resolution — 0 uvoznika; setup/regoc-setup.ts:83 ga samo spominje u komentaru' },
      { name: 'KnowledgeHarvester', status: 'inactive', descriptionKey: 'cfg_komp_knowledgeharvester', description: 'Ekstrakcija znanja iz sesija — 0 pozivatelja izvan vlastite datoteke i testova' },
      { name: 'ObservabilityLogger', status: 'active', descriptionKey: 'cfg_komp_observabilitylogger', description: 'JSONL structured logging — tool calls, agent spawns, task updates. Dosežan: TaskWebUI.ts:9330 (dinamički import)' },
      { name: 'CostTracker', status: 'active', descriptionKey: 'cfg_komp_costtracker', description: 'API token usage i cost tracking per agent/task/model. Dosežan: TaskWebUI.ts:39' },
      { name: 'HealthSnapshot', status: 'inactive', descriptionKey: 'cfg_komp_healthsnapshot', description: '0 pozivatelja — obećanog "5min intervala" nema; nitko ne zove takeSnapshot() (jedina druga pojava imena bio je ovaj redak)' },
      { name: 'RegocPulse', status: 'planned', descriptionKey: 'cfg_komp_regocpulse', description: 'Unified service manager — health check, auto-restart, circuit breaker (port 17780)' },
      { name: 'Installer Wizard', status: 'ondemand', descriptionKey: 'cfg_komp_installer_wizard', description: '10-step interactive CLI setup wizard (setup/regoc-setup.ts, 497 redaka) — pokreće se ručno, nije stalni servis' },
    ],
    skills: (() => {
      const skillsDir = join(HOME, '.claude/skills')
      try {
        // TASK-3516: ovdje kronologija NEMA smisla — popis vještina je imenik, ne
        // dnevnik, pa ostaje abecedno. `.sort()` bez usporedbe je ovdje ispravan
        // jer se uspoređuju imena mapa; zamka „TASK-999 > TASK-1000" vrijedi samo
        // gdje se sortira po ID-u zadatka.
        const dirs = readdirSync(skillsDir).filter(d => {
          try { return statSync(join(skillsDir, d)).isDirectory() && !d.startsWith('_') && !d.startsWith('.') } catch { return false }
        }).sort()
        return dirs.map(name => {
          const skillFile = join(skillsDir, name, 'SKILL.md')
          let description = ''
          if (existsSync(skillFile)) {
            const content = readFileSync(skillFile, 'utf-8')
            const descMatch = content.match(/description:\s*(.+)/i)
            if (descMatch) description = descMatch[1].trim().substring(0, 120)
          }
          const wfDir = join(skillsDir, name, 'Workflows')
          let workflows: string[] = []
          try { if (existsSync(wfDir)) workflows = readdirSync(wfDir).filter(f => f.endsWith('.md')).map(f => f.replace('.md','')) } catch {}
          return { name, description, workflowCount: workflows.length, workflows }
        })
      } catch { return [] }
    })(),
  }
}

// API HANDLERS
// ============================================

// PUT /api/agents/:id/model — postavi ili obriši per-agent model override.
// Body: { model: string }  — "" ili "default" briše override (agent koristi zadani tier model).
// Whitelist: samo spec-ovi iz AVAILABLE_MODELS. Sprema u model-config.json → agentOverrides[id].
async function handleSetAgentModel(agentId: string, req: Request): Promise<Response> {
  const json = (o: unknown, status = 200) =>
    new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } })

  if (!/^[a-z0-9_-]+$/.test(agentId)) {
    return json({ error: 'Invalid agent id' }, 400)
  }
  try {
    const body = (await req.json()) as { model?: string | null }
    const raw = (body.model ?? '').toString().trim()
    const clearing = raw === '' || raw === 'default' || raw === 'zadano'

    // Interface/glavna-petlja agenti ne troše override — odbij postavljanje (clear je OK, no-op).
    if (FIXED_INTERFACE_AGENTS.has(agentId) && !clearing) {
      return json({ error: `Agent '${agentId}' je interface/glavna petlja — model override se ne primjenjuje.` }, 400)
    }

    if (!clearing) {
      // Validiraj protiv statičkih (Anthropic) + ŽIVIH modela (Ollama /api/tags),
      // jer dropdown nudi žive modele — inače bi ih PUT odbio.
      let known = getEffectiveModels().some(m => m.spec === raw)
      if (!known) {
        try {
          const av = await buildModelsAvailable()
          known = av.models.some((m: any) => m.spec === raw)
        } catch {}
      }
      if (!known) return json({ error: `Unknown model spec '${raw}'` }, 400)
    }

    const HOME = process.env.HOME || homedir()
    const mcPath = join(HOME, '.claude/regoc/models/model-config.json')
    if (!existsSync(mcPath)) return json({ error: 'model-config.json not found' }, 500)

    const mc = JSON.parse(readFileSync(mcPath, 'utf-8'))
    if (!mc.agentOverrides || typeof mc.agentOverrides !== 'object') mc.agentOverrides = {}

    if (clearing) {
      delete mc.agentOverrides[agentId]
    } else {
      mc.agentOverrides[agentId] = raw
    }

    // TASK-4894: atomno + revizijski trag (v. ModelConfigWriter.ts). Prije je ovo bio
    // gol writeFileSync preko žive datoteke — pad usred upisa daje krnji JSON, koji
    // resolveAgentTarget tiho proguta i vrati SVE agente na plivajući alias.
    saveModelConfig(mcPath, _mc => { Object.assign(_mc, mc) }, 'ploca')

    const spawnable = clearing ? null : (getEffectiveModels().find(m => m.spec === raw)?.spawnable ?? false)
    return json({ status: 'saved', agentId, model: clearing ? null : raw, spawnable })
  } catch (err) {
    return json({ error: String(err) }, 400)
  }
}

// ── Klasifikacijski model (TASK-2635) ─────────────────────────────────────────
// GET  /api/models/classifier — trenutna postavka + živi popis lokalnih modela.
// PUT  /api/models/classifier — { model: "qwen3:8b" } postavi, "" ili "default" vrati na zadano.
// Odvojeno od `agentOverrides` NAMJERNO: ovo je *rutiranje* (svaka poruka), ne „glas" REGOČ-a.
async function handleGetClassifier(): Promise<Response> {
  const json = (o: unknown, status = 200) =>
    new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } })
  const HOME = process.env.HOME || homedir()
  try {
    const cur = readClassifier(HOME)
    let models: string[] = []
    let reachable = false
    let error: string | null = null
    try {
      let apiKey: string | undefined
      try {
        const mc = JSON.parse(readFileSync(join(HOME, '.claude/regoc/models/model-config.json'), 'utf-8'))
        if (typeof mc?.providers?.ollama?.apiKey === 'string') apiKey = mc.providers.ollama.apiKey
      } catch {}
      models = await fetchOllamaModels(cur.baseUrl, apiKey)
      reachable = true
    } catch (e: any) { error = String(e?.message || e) }
    // Trenutni model uvijek u popisu — inače bi ga dropdown "izgubio" kad je Ollama nedostupna.
    if (!models.includes(cur.model)) models = [cur.model, ...models]
    return json({
      spec: cur.spec, model: cur.model, source: cur.source,
      defaultSpec: CLASSIFIER_DEFAULT_SPEC, envKey: CLASSIFIER_ENV_KEY,
      // Vrijednost tajne se NE vraća — samo je li redak zapisan u spremištu.
      storeSet: cur.storeValue !== null,
      storeMatchesConfig: cur.storeValue === null ? null : ('ollama:' + cur.storeValue) === cur.spec,
      baseUrl: cur.baseUrl, reachable, models, error,
    })
  } catch (err) { return json({ error: String(err) }, 500) }
}

async function handleSetClassifier(req: Request): Promise<Response> {
  const json = (o: unknown, status = 200) =>
    new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } })
  const HOME = process.env.HOME || homedir()
  try {
    const body = (await req.json()) as { model?: string | null }
    const raw = (body.model ?? '').toString().trim()
    if (raw === '' || raw === 'default' || raw === 'zadano') {
      const r = clearClassifier(HOME)
      if (!r.ok) return json({ error: r.error }, 500)
      return json({ status: 'cleared', spec: CLASSIFIER_DEFAULT_SPEC })
    }
    const r = writeClassifier(HOME, raw)
    if (!r.ok) return json({ error: r.error }, 400)
    return json({ status: 'saved', spec: r.spec, model: r.model })
  } catch (err) { return json({ error: String(err) }, 400) }
}

function handleGetTasks(url: URL): Response {
  // Build filter object from query params
  const rawFilter: Record<string, unknown> = {}

  const status = url.searchParams.get('status')
  const assignee = url.searchParams.get('assignee')
  const priority = url.searchParams.get('priority')
  const tag = url.searchParams.get('tag')
  const search = url.searchParams.get('search')
  const projectId = url.searchParams.get('projectId')

  if (status) rawFilter.status = status
  if (assignee) rawFilter.assignee = assignee
  if (priority) rawFilter.priority = parseInt(priority)
  if (tag) rawFilter.tag = tag
  if (search) rawFilter.search = search
  if (projectId) rawFilter.projectId = projectId
  const tip = url.searchParams.get('tip')
  if (tip) rawFilter.tip = tip

  // Validate with Zod
  const parseResult = TaskFilterSchema.safeParse(rawFilter)
  if (!parseResult.success) {
    return new Response(JSON.stringify({
      error: 'Validation failed',
      details: parseResult.error.issues
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  const validatedFilter = parseResult.data

  // SQL-Only: Build filter for TaskManagerSQL (no MD merge needed)
  const filter: any = {}
  if (validatedFilter.status) filter.status = validatedFilter.status
  if (validatedFilter.assignee) filter.assignee = validatedFilter.assignee
  if (validatedFilter.priority) filter.priority = validatedFilter.priority
  if (validatedFilter.projectId) filter.projectId = validatedFilter.projectId
  if (validatedFilter.search) filter.search = validatedFilter.search

  const tasks = taskManager.getTasks(filter)

  return new Response(JSON.stringify(tasks), {
    headers: { 'Content-Type': 'application/json' }
  })
}

function handleGetTask(taskId: string): Response {
  const task = taskManager.getTask(taskId)

  if (!task) {
    return new Response(JSON.stringify({ error: 'Task not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  // TASK-4815: PARSIRANJE JE NA POSLUŽITELJU, ne u pregledniku. To je jedina izvedba
  // u kojoj ploča i kanali dijele ISTI kod, a ne dvije preslike iste gramatike.
  // Klijent dobiva gotov sud i samo ga CRTA; `resultSummary` ostaje netaknut uz njega,
  // pa „prikaži sirovo" uvijek ima puni izvor.
  return new Response(JSON.stringify({ ...task, resultParsed: parsiraniRezultat(task) }), {
    headers: { 'Content-Type': 'application/json' }
  })
}

/**
 * Sud o agentovom izlazu za prikaz na kartici. Ploča je MJERODAVNA za bedž
 * (`task.status`), parsirani tekst ga smije samo suziti — nikad podići
 * (§3 dizajna TASK-4813). Fail-soft: bez rezultata nema ni suda, ne izmišlja se.
 */
function parsiraniRezultat(task: any): unknown {
  const rs = task?.resultSummary
  if (!rs || !String(rs).trim()) return null
  try {
    return renderFull(parseAgentOutput(String(rs)), task.status, { blockedReason: task.blockedReason })
  } catch {
    return null   // prikaz nikad ne smije pasti zbog suda o tekstu
  }
}

/**
 * WARN o progutanim poljima na POST /api/tasks — ODGOĐEN do ishoda zahtjeva (Z4/TASK-3010).
 *
 * KVAR: 28.07. je REGOČ poslao `project` umjesto `projectId` na 7 zadataka. API je vratio
 * 201, polje je nestalo, zadatci su ostali bez projekta. Upozorenje je POSTOJALO, ali je
 * ispisano PRIJE nego zadatak dobije ID, pa se nije imalo s čime povezati — sedam sirotih
 * redaka "nepoznata polja ignorirana: project" i nijedna žrtva.
 *
 * ZAŠTO ODGODA, A NE DVA POVEZANA RETKA: ID je jedino što retku daje vrijednost; redak bez
 * njega je točno ono što se pokazalo neupotrebljivim. Dva retka traže korelacijski ključ,
 * udvostručuju obujam i od čitatelja traže spajanje — a i dalje je jedan od njih šum.
 * Zato: TOČNO JEDAN WARN po zahtjevu koji nešto proguta, ispisan kad se ishod zna.
 *
 * CIJENA ODGODE koju ovo mora platiti: ako zahtjev nikad ne stigne do stvaranja (Zod 400,
 * anti-echo 422, iznimka), odgođeni ispis bi se izgubio — gore nego danas. Zato se poziva
 * na SVIM izlazima iz handlera, a umjesto ID-a nosi razlog odbijanja.
 */
function warnCreateSwallowedFields(
  fields: { unknown: string[]; conflicts: string[] } | null,
  outcome: string,
): void {
  if (!fields) return
  if (fields.unknown.length === 0 && fields.conflicts.length === 0) return
  const parts: string[] = []
  if (fields.unknown.length > 0) parts.push(`nepoznata polja ignorirana: ${fields.unknown.join(', ')}`)
  // conflicts = poslana OBA naziva istog polja; camelCase pobjeđuje, alias se guta.
  // Isti razred tihog gubitka, pa ide u isti redak (odgovor se NE mijenja — v. dolje).
  if (fields.conflicts.length > 0) parts.push(`dvostruki naziv, alias ignoriran: ${fields.conflicts.join(', ')}`)
  console.warn(`[API] ${outcome} POST /api/tasks — ${parts.join('; ')}`)
}

/**
 * Vrata projekta na ulazu (TASK-3514).
 *
 * NALAZ (Goran, 28. i 29.08.2026.): „zadaci ne mogu biti bez projekta", a zadatci bez
 * projekta su i dalje bili vidljivi na ploči. Pretinac PRJ-033 je bio zamišljen da
 * propust učini VIDLJIVIM, ali dosad je propust bio vidljiv samo u bazi — POST je
 * vraćao uredan 201 i nitko nije imao razloga išta ispraviti, pa je pretinac postao
 * trajno odlagalište (96 zadataka).
 *
 * ZAŠTO PRESMJEROM, A NE ODBIJANJEM: stvaranje zadatka je životna funkcija ploče
 * (daemon, UI, agenti, skripte, cron). Tvrdi 400 bi zaustavio dotok posla zbog polja
 * koje većina pozivatelja nikad nije ni slala — isti razlog zbog kojeg ni nepoznata
 * polja ne ruše POST. Zato: zadatak nastaje, ali u pretincu, a upozorenje putuje NAZAD
 * pozivatelju u tijelu odgovora (`warnings.project`), ne samo u log koji nitko ne čita.
 *
 * Nepoznat `projectId` (tipfeler, obrisan projekt) tretira se isto: prije je takav
 * zahtjev prolazio do FK greške i završavao s `project_id = NULL` — dakle nevidljiv.
 */
function resolveProjectForCreate(requested: string | undefined): { projectId: string; warning?: string } {
  const wanted = (requested ?? '').trim()

  if (!wanted) {
    return {
      projectId: INBOX_PROJECT_ID,
      warning: `projectId nije poslan — zadatak je smješten u pretinac ${INBOX_PROJECT_ID} (zadatci bez projekta). ` +
        `Pošalji projectId da zadatak dođe na svoj projekt.`,
    }
  }

  if (!projectManager.getProject(wanted)) {
    return {
      projectId: INBOX_PROJECT_ID,
      warning: `projectId='${wanted}' ne postoji u katalogu projekata — zadatak je smješten u pretinac ${INBOX_PROJECT_ID}. ` +
        `Provjeri ID na GET /api/projects.`,
    }
  }

  return { projectId: wanted }
}


/**
 * Upute koje se same dopisuju u opis zadatka pri otvaranju (Goran, 04.09.2026.).
 *
 * Zapisana lekcija pomaže samo onome tko je potraži; izvršitelj koji dobije zadatak čita opis,
 * a ne RAG. Zato se poznati obrasci — oni koji su već jednom prošli krivo — dopisuju u sam
 * opis, pa dolaze u prompt bez ičije dobre volje.
 *
 * Pravila su u `config/upute-po-tipu.json` i čitaju se pri svakom otvaranju, pa novo pravilo
 * vrijedi odmah, bez izmjene koda i bez restarta.
 */
const UPUTE_PATH = `${process.env.HOME}/.claude/regoc/config/upute-po-tipu.json`

function upozorenjaZaZadatak(zadatak: {
  title?: unknown; description?: unknown; assignee?: unknown; tags?: unknown
}): string[] {
  let pravila: any[] = []
  try {
    pravila = JSON.parse(require('fs').readFileSync(UPUTE_PATH, 'utf-8')).pravila || []
  } catch { return [] }          // nema datoteke ili je pokvarena → zadatak se otvara kao i prije

  const naslov = String(zadatak.title ?? '')
  const opis = String(zadatak.description ?? '')
  const izvrsitelj = String(zadatak.assignee ?? '').toLowerCase()
  const oznake = (Array.isArray(zadatak.tags) ? zadatak.tags : []).map(g => String(g).toLowerCase())

  const out: string[] = []
  for (const pr of pravila) {
    const kad = pr?.kad || {}
    let vrijedi = true
    if (Array.isArray(kad.oznake) && kad.oznake.length) {
      vrijedi = kad.oznake.every((g: string) => oznake.includes(String(g).toLowerCase()))
    }
    if (vrijedi && Array.isArray(kad.assignee) && kad.assignee.length) {
      vrijedi = kad.assignee.map((a: string) => String(a).toLowerCase()).includes(izvrsitelj)
    }
    if (vrijedi && kad.naslovSadrzi) {
      try { vrijedi = new RegExp(String(kad.naslovSadrzi), 'i').test(naslov) } catch { vrijedi = false }
    }
    if (vrijedi && kad.opisSadrzi) {
      try { vrijedi = new RegExp(String(kad.opisSadrzi), 'i').test(`${naslov}\n${opis}`) }
      catch { vrijedi = false }
    }
    // Prazan uvjet ne smije pogoditi svaki zadatak — pravilo bez ijednog uvjeta se preskače.
    const imaUvjet = !!(kad.oznake?.length || kad.assignee?.length || kad.naslovSadrzi || kad.opisSadrzi)
    if (vrijedi && imaUvjet && pr?.uputa && !opis.includes(String(pr.uputa).slice(0, 40))) {
      out.push(String(pr.uputa))
    }
  }
  return out
}

async function handleCreateTask(req: Request): Promise<Response> {
  // Izvan try-a: catch mora znati što je progutano da se trag ne izgubi na iznimci.
  let createFields: { normalized: Record<string, unknown>; unknown: string[]; conflicts: string[] } | null = null
  try {
    const body = await req.json()

    // Nazivi polja (D6 / TASK-2976) — isti prijevod kao na PUT-u, ali BEZ tvrdog 400:
    // stvaranje zadatka je životna funkcija ploče (daemon, UI, agenti, skripte, cron) i
    // odbijanje zbog bezopasnog viška polja srušilo bi dotok posla. Kompromis: zadatak se
    // stvori, ali odgovor NOSI popis progutanih polja i log ih zapiše upozorenjem —
    // ključno je da gutanje više nije nevidljivo. Ispis je odgođen do ID-a zadatka
    // (v. warnCreateSwallowedFields); ovdje se samo prikupi.
    createFields = normalizeTaskFields(body, CREATE_TASK_FIELDS)

    // Validate with Zod
    const parseResult = CreateTaskInputSchema.safeParse(createFields.normalized)
    if (!parseResult.success) {
      warnCreateSwallowedFields(createFields, 'ODBIJEN(400 validation)')
      return new Response(JSON.stringify({
        error: 'Validation failed',
        details: parseResult.error.issues
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    const validatedData = parseResult.data

    // Dopiši upute za prepoznate obrasce. Ide poslije validacije da se ne petlja u shemu, a
    // prije spremanja da uputa doista završi u opisu — ondje je izvršitelj i vidi.
    const upute = upozorenjaZaZadatak(validatedData as any)
    if (upute.length) {
      const stari = String((validatedData as any).description ?? '')
      ;(validatedData as any).description = (stari ? stari + '\n\n' : '') + upute.join('\n\n')
      console.log(`[API] uputa dopisana (${upute.length}) pri otvaranju zadatka`)
    }

    // Anti-echo guard: reject tasks whose "spec" is itself a recycled REGOČ agent
    // report (📋 SUMMARY / 🔍 ANALYSIS / ⚡ ACTIONS ... ≥3 markers) rather than an
    // actionable specification. This is the structural source of the stand-down
    // loop (TASK-2422→2423→2424): a stand-down report becomes a new task, which
    // produces another stand-down report. See DispatchGuard.ts + memory
    // [[regoc-claude-print-delegation-loop]]. Single ingress chokepoint — every
    // creator (HTTP UI, RegocDaemon, agents) POSTs through here.
    // TASK-3589: ista vrata, ali ŠIRI test. Dosad se zvao samo `isRecycledAgentReport`,
    // pa su kroz ingress prolazili (a) lifecycle-obavijesti kao "spec" (TASK-2428
    // „✅ Kosjenka završio zadatak") i (b) obični završni izvještaji bez emojija
    // (TASK-3605 „Done. Summary of TASK-3587"). Opis se provjerava i SAM za sebe jer
    // su LIFECYCLE/COMPLETION uzorci sidreni na početak stringa — prefiks naslova bi
    // im razbio sidro. Mjereno nad 1349 zadataka u živoj regoc.db: 13 pogodaka,
    // svih 13 su poznati echo-artefakti, nula pravih zadataka.
    const echoProbeDesc = validatedData.description ?? ''
    const echoProbeFull = `${validatedData.title ?? ''}\n${echoProbeDesc}`
    if (isNonActionableMessage(echoProbeDesc) || isNonActionableMessage(echoProbeFull)) {
      console.warn(`[TaskWebUI] BLOCKED recycled-report task creation (anti-echo guard): "${(validatedData.title ?? '').slice(0, 80)}"`)
      warnCreateSwallowedFields(createFields, 'ODBIJEN(422 recycled_report)')
      return new Response(JSON.stringify({
        error: 'Recycled agent report rejected',
        code: 'recycled_report',
        reason: 'Sadržaj zadatka je agentov izvještaj ili sistemska obavijest (CORE format-markeri, „📋 SUMMARY + 🗣️ Ime:", „Done./REGOC-STATUS" ili lifecycle-poruka), ne specifikacija. Pošalji pravu spec: ŠTO / ZAŠTO / KOJI fajlovi / KRITERIJ za done.',
      }), {
        status: 422,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    // TASK-3627: druga polovica istih vrata — zadatak BEZ IZVRSIVOG SADRZAJA.
    // `isEmptyOrFixtureTask` je od TASK-2701 stajao samo na DISPATCHU (RegocDaemon),
    // pa je ingress i dalje primao `description: ""` s HTTP 201 (mjereno 02.09.2026.
    // 19:06 — probni TASK-3620/3621). Posljedica je ista kao kod fixtura: prazan
    // zapis dobije assignee-a i kasnije spawna pravu Opus sesiju nad nicim.
    // Vrata su ovdje, a ne (samo) na dispatchu, jer je ovo JEDINI ingress —
    // web forma, agentov curl i RegocDaemon svi prolaze kroz `handleCreateTask`.
    // Mjereno nad zivom regoc.db (1357 zadataka, mjerenje u
    // regoc/CHECKPOINT_TASK-3627_ingress.md): 92 pogotka; 37 doslovnih test-fixtura
    // (svi `cancelled`) i 55 s praznim opisom, od kojih su 3 fixture, a 52 povijesni
    // zadaci u kojima je specifikaciju nosio samo NASLOV — tocno ono sto pravilo
    // „task description OBAVEZAN" zabranjuje. Zadnji takav je 2026-08-23; nijedan
    // aktivni put ih vise ne stvara (RegocDaemon uvijek salje `fullDescription`).
    // Odbijenica NOSI razlog da posiljatelj zna sto da popravi i ponovi POST.
    const emptyReason = emptyOrFixtureReason(validatedData.title, validatedData.description)
    if (emptyReason) {
      console.warn(`[TaskWebUI] BLOCKED empty/fixture task creation (${emptyReason}): "${(validatedData.title ?? '').slice(0, 80)}"`)
      warnCreateSwallowedFields(createFields, `ODBIJEN(422 ${emptyReason})`)
      return new Response(JSON.stringify({
        error: 'Task without actionable content rejected',
        code: 'empty_or_fixture_task',
        reason: EMPTY_TASK_REASON_TEXT[emptyReason],
        detail: emptyReason,
      }), {
        status: 422,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    // ── M2/TASK-4628: STROP STVARANJA ZADATAKA PO IZVORU ──────────────────────
    // Stoji TU, iza sadržajnih vrata (anti-echo, prazan opis) i ispred `createTask`:
    // rafal smeća je već odbijen besplatno, pa kvotu troše samo zadatci koji bi stvarno
    // nastali. Preko praga zadatak NE nestaje — cijelo tijelo zahtjeva ide u
    // `task_create_queue` i vraća se odgovorom (HTTP 429 + `queueId`), a Goran dobije
    // JEDNU dojavu po epizodi. Ovo su vrata koja M1 (osigurač spawnova) ne može
    // zamijeniti: on rafal vidi tek kad su zadatci već u bazi i već zovu `claude --print`.
    const createdBy = typeof createFields.normalized.createdBy === 'string' && createFields.normalized.createdBy
      ? String(createFields.normalized.createdBy).slice(0, 64)
      : 'user'
    const breaker = getTaskCreateBreaker()
    const rateVerdict = breaker?.check(createdBy)
    if (rateVerdict && (rateVerdict.wouldQueue || rateVerdict.alarm)) {
      const queuedNow = breaker!.queuedList({ source: createdBy }).length + (rateVerdict.allowed ? 0 : 1)
      if (rateVerdict.alarm) notifyGoranTaskBurst(formatTaskCreateAlarm(createdBy, rateVerdict, queuedNow))
    }
    if (rateVerdict && !rateVerdict.allowed) {
      const q = breaker!.enqueue(createdBy, createFields.normalized, rateVerdict.reason)
      console.warn(`[TaskWebUI] QUEUED task creation (task rate breaker, ${rateVerdict.scope}): `
        + `"${(validatedData.title ?? '').slice(0, 80)}" → red #${q.id}`)
      warnCreateSwallowedFields(createFields, `ODGOĐEN(429 task_rate_limited, red #${q.id})`)
      return new Response(JSON.stringify({
        error: 'Task creation rate limit — zadatak je u redu čekanja',
        code: 'task_rate_limited',
        queued: true,
        queueId: q.id,
        position: q.position,
        source: createdBy,
        scope: rateVerdict.scope,
        count: rateVerdict.count,
        limit: rateVerdict.limit,
        retryAfterMs: rateVerdict.retryAfterMs,
        reason: rateVerdict.reason + '. Zadatak NIJE izgubljen: čeka u redu i pušta se s '
          + 'bun ~/.claude/regoc/tools/task-create-queue.ts --release',
      }), {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': String(Math.max(1, Math.ceil(rateVerdict.retryAfterMs / 1000))),
        },
      })
    }

    // Vrata projekta: nikad NULL, i nikad tiho (v. resolveProjectForCreate).
    const projectGate = resolveProjectForCreate(validatedData.projectId)
    if (projectGate.warning) {
      console.warn(`[TaskWebUI] TASK-3514 POST /api/tasks — ${projectGate.warning} (naslov: "${(validatedData.title ?? '').slice(0, 80)}")`)
    }

    // Map validated data to TaskManagerSQL input format
    const input = {
      title: validatedData.title,
      description: validatedData.description,
      priority: validatedData.priority,
      assignee: validatedData.assignee,
      blockedBy: validatedData.blockedBy,
      tags: validatedData.tags,
      projectId: projectGate.projectId,
      // Stvaratelj se dosad tvrdo upisivao kao 'user' i tko god ga je poslao — nestao je.
      // Sad se poštuje ako je poslan (createdBy ili created_by), uz isti default.
      // Izračunat je iznad, jer strop stvaranja zadataka mora znati IZVOR prije upisa.
      createdBy,
    }

    const task = taskManager.createTask(input)

    // Mjesto u pomičnom prozoru troši SAMO zadatak koji je stvarno nastao (TASK-4628):
    // odbijenica drugih vrata ne smije pojesti kvotu poštenom pošiljatelju.
    breaker?.recordCreated(createdBy, task.id)

    // TU je ID konačno poznat — jedini trenutak u kojem se gutanje može povezati sa žrtvom.
    warnCreateSwallowedFields(createFields, task.id)

    // ── W0/TASK-4620: PREKIDAČ ZA TIJEKOVE RADA (tri razine) ──────────────────
    // Zadano je `shadow`: odluka „ide li ovaj zadatak po tijeku i po kojem" se IZRAČUNA i
    // zapiše u `data/workflow_odluke.jsonl`, a ništa se ne materijalizira — nula spawnova,
    // nula izmjena na zadatku. Tako se novi put uspoređuje sa starim na ISTOM prometu.
    // Stoji tu, iza `createTask`, iz dva razloga: (a) zapis nosi pravi `task.id`, pa se
    // odluka može vezati uz ishod, i (b) zadatci koje su vrata iznad odbila (echo, prazan
    // opis, strop) uopće ne postoje — mjerilo ne smije brojati posao koji nikad nije nastao.
    // `mozdaZapisiOdluku` NIKAD ne baca i povratna se vrijednost smije zanemariti;
    // prekidač u sjeni ne smije moći srušiti jedini ingress ploče. Gašenje: nacin='off'
    // u config/workflow-gate.json (djeluje bez ponovnog pokretanja).
    //
    // W1/TASK-4614 — MATERIJALIZACIJA ODLUKE KAO OZNAKE. `primijeniOznaku` se poziva SAMO
    // u načinu `on`, samo kad oznake još nema i samo za zadatak koji je stvarno nastao;
    // sva tri uvjeta provjeravaju vrata, pa ovdje ostaje čist upis. U sjeni se ovaj
    // zatvarač NIKAD ne izvrši — to je prihvatni kriterij naloga („oznaka se ne upisuje"),
    // a ne stvar dobre namjere: drži ga `tests/workflow-w1.test.ts`.
    //
    // Redoslijed upisa je namjeran: prvo oznaka, pa bilješka. Oznaka je ono što mijenja
    // ponašanje sustava, bilješka je objašnjenje; ako upis oznake padne, ne smije ostati
    // bilješka koja tvrdi da je tijek izabran. Povratna vrijednost je ono što završi u
    // `oznakaUpisana`, pa zapis ne može tvrditi učinak kojeg nema.
    const wfOdluka = mozdaZapisiOdluku({
      taskId: task.id,
      naslov: validatedData.title ?? '',
      opis: validatedData.description ?? '',
      oznake: validatedData.tags ?? null,
      projectId: projectGate.projectId ?? null,
      assignee: validatedData.assignee ?? null,
      izvor: 'create',
    }, {
      log: (m) => console.warn(`[TaskWebUI] ${m}`),
      primijeniOznaku: (nalog) => {
        const azuriran = taskManager.updateTask(nalog.taskId, { tags: nalog.noveOznake })
        if (!azuriran) return false
        taskManager.addProgressNote(nalog.taskId, 'workflow-gate', nalog.biljeska)
        return true
      },
      // W2/TASK-4616 — MATERIJALIZACIJA TIJEKA U LANAC ZADATAKA.
      //
      // Ide kroz `taskManager` (SQL), NIKAD kroz vlastiti HTTP ulaz: koraci nose oznaku
      // `workflow:<id>`, pa bi ih ovaj isti handler ponovno provukao kroz vrata, odlučio
      // „ide po tijeku" (kod `oznaka`) i granao lanac iz lanca. Uz to i `materijalizirajTijek`
      // ima vlastiti guard (`jeKorakTijeka`) — dvije brave, jer je ova greška tiha i skupa.
      //
      // Drugi prekidač je namjeran: `nacin: 'on'` znači „smije se upisati oznaka", a
      // `materijalizacija: 'on'` znači „smiju nastati zadatci". Prvo je bezopasno, drugo
      // troši spawnove; jedan prekidač za oba rizika značio bi da se W1 ne može pustiti
      // uživo bez da istog trena počnu nastajati lanci.
      materijaliziraj: (nalog) => {
        const mat = loadMaterijalizacijaNacin()
        if (mat.nacin !== 'on') return null
        const tijekId = nalog.oznaka.startsWith('workflow:') ? nalog.oznaka.slice('workflow:'.length) : ''
        if (!tijekId) return null
        const katalog = loadWorkflowKatalog()
        const tijek = (katalog.workflows || {})[tijekId]
        if (!tijek) return null
        const ishod = materijalizirajTijek({
          tijekId, tijek,
          task: {
            id: nalog.taskId,
            title: validatedData.title ?? '',
            description: validatedData.description ?? '',
            projectId: projectGate.projectId ?? null,
            oznake: nalog.noveOznake,
            priority: validatedData.priority ?? null,
          },
          ploca: {
            createTask: (input) => taskManager.createTask(input as any),
            getTask: (id) => taskManager.getTask(id) as any,
            updateTask: (id, u) => taskManager.updateTask(id, u as any) as any,
            addProgressNote: (id, agent, note) => taskManager.addProgressNote(id, agent, note),
          },
          nacin: 'on',
          createdBy: 'workflow-materializer',
        })
        console.log(`[TaskWebUI] ${formatLanacLog(ishod)}`)
        try { zapisiLanac(ishod) } catch (e: any) { console.warn(`[TaskWebUI] dnevnik lanaca: ${e?.message || e}`) }
        return { ok: ishod.ok, taskIds: ishod.taskIds }
      },
    })
    if (wfOdluka) console.log(`[TaskWebUI] ${formatOdlukaLog(wfOdluka)}`)

    // Broadcast to WebSocket clients
    const message = JSON.stringify({ type: 'task_created', task })
    wsClients.forEach(client => {
      try { client.send(message) } catch { wsClients.delete(client) }
    })

    // Upozorenja u tijelu: `ignoredFields` (progutana polja) i `project` (presmjeren
    // projekt). Oba su tihi gubitci koje pozivatelj inace ne bi imao odakle vidjeti.
    const warnings: Record<string, unknown> = {}
    if (createFields.unknown.length > 0) warnings.ignoredFields = createFields.unknown
    if (projectGate.warning) warnings.project = projectGate.warning

    return new Response(JSON.stringify(
      Object.keys(warnings).length > 0 ? { ...task, warnings } : task
    ), {
      status: 201,
      headers: { 'Content-Type': 'application/json' }
    })
  } catch (error) {
    // Iznimka nakon normalizacije (npr. pad INSERT-a): zadatka nema, ali trag ostaje.
    warnCreateSwallowedFields(createFields, `ODBIJEN(500/iznimka: ${String(error).slice(0, 80)})`)
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    })
  }
}

// Globalni JSON-response helper (lokalni `const json` u drugim funkcijama ga zasjenjuju).
function json(o: unknown, s = 200): Response {
  return new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } })
}

// ============================================================================
// LOGIN PROVIDERS — prijava preko linka (copy-link + paste) iz TaskManagera.
// CLI-jevi (kimi/gemini/claude) traže PTY → koristimo `script -qfec` (bez node-pty).
// Uspjeh = pojava creds-datoteke → providers.<id>.enabled=true (ulazi u listu modela).
// ============================================================================
interface LoginProviderDef { id: string; name: string; kind: 'oauth-cli' | 'apikey'; cmd?: string; bin?: string; creds: string; envKey?: string; install?: string }
const LOGIN_PROVIDERS: LoginProviderDef[] = [
  { id: 'kimicli',    name: 'Kimi',                kind: 'oauth-cli', cmd: 'kimi login',        bin: 'kimi',   creds: '~/.kimi-code/oauth' },
  { id: 'geminicli',  name: 'Gemini (Google)',     kind: 'oauth-cli', cmd: 'gemini',            bin: 'gemini', creds: '~/.gemini/oauth_creds.json', envKey: 'GEMINI_API_KEY' },
  { id: 'claude',     name: 'Claude (Anthropic)',  kind: 'oauth-cli', cmd: 'claude setup-token', bin: 'claude', creds: '~/.claude/.credentials.json', install: 'curl -fsSL https://claude.ai/install.sh | bash' },
  { id: 'openrouter', name: 'OpenRouter (cloud)',  kind: 'apikey',    creds: '', envKey: 'OPENROUTER_API_KEY' },
]
interface LoginSess { proc: any; url: string; buf: string; ok: boolean; done: boolean; err: string; started: number }
const loginSessions = new Map<string, LoginSess>()

function loginHomeExpand(p: string): string { const H = process.env.HOME || ''; return p.startsWith('~/') ? join(H, p.slice(2)) : p }
function loginBinPath(bin?: string): string | null {
  if (!bin) return null
  const H = process.env.HOME || ''
  for (const d of [join(H, '.local/node/bin'), join(H, '.local/bin'), '/usr/local/bin', '/usr/bin']) {
    const f = join(d, bin); if (existsSync(f)) return f
  }
  return null
}
// Mjerilo prijavljenosti i odjava dijele `src/LoginCreds.ts` — dok su bila dva prepisana
// izraza, odjava je brisala OAuth datoteku a mjerilo gledalo ključ, pa je gumb zauvijek
// ostajao „prijavljen" (TASK-4796).
function loginStorePath(): string { return loginHomeExpand('~/.claude/regoc/credentials.env') }
function loginCredsPresent(def: LoginProviderDef): boolean {
  try {
    if (def.kind === 'apikey') return kljucPrisutanUDatoteci(loginStorePath(), def.envKey || '')
    // oauth-cli s envKey (npr. Gemini): smatra se konfiguriranim i ako je API ključ u spremištu
    if (def.envKey && kljucPrisutanUDatoteci(loginStorePath(), def.envKey)) return true
    const p = loginHomeExpand(def.creds)
    if (!existsSync(p)) return false
    const st = statSync(p)
    return st.isDirectory() ? readdirSync(p).length > 0 : st.size > 0
  } catch { return false }
}
function loginSetProviderEnabled(id: string, enabled: boolean): void {
  try {
    const mcPath = loginHomeExpand('~/.claude/regoc/models/model-config.json')
    const mc = existsSync(mcPath) ? JSON.parse(readFileSync(mcPath, 'utf-8')) : {}
    mc.providers = mc.providers || {}
    mc.providers[id] = { ...(mc.providers[id] || {}), enabled }
    saveModelConfig(mcPath, _mc => { Object.assign(_mc, mc) }, 'prijava:davatelj')
  } catch {}
}
function loginSpawnEnv(): Record<string, string> {
  const H = process.env.HOME || ''
  return {
    PATH: `${join(H, '.local/node/bin')}:${join(H, '.local/bin')}:${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}`,
    HOME: H, USER: process.env.USER || 'regoc', TERM: 'xterm-256color',
    GOOGLE_GENAI_USE_GCA: 'true',  // Gemini → OAuth Login-with-Google put
  }
}
// Potrošnja trenutne Claude sesije za statusnu traku (TASK-2694).
// Logika je u src/SessionUsage.ts (jedinično testirana): prvo keš u memoriji,
// pa keš koji pišu session_usage.py hookovi, i tek ako je oboje starije od praga
// → svjež probe. Bez toga bi prikaz "svake minute" znao satima visjeti na istoj
// brojci kad hookovi ne pišu (mirna sesija, drugi agenti troše kvotu).
const sessionUsageState: UsageState = {}
const sessionUsageDeps = createDefaultDeps(sessionUsageState)

/**
 * T10/TASK-3575: stanje „neprovjereno" za plocu. Izvor je POSTOJECI trag vratara
 * (data/critic_gate.jsonl) — nova baza bi znacila da ploca i vrata mogu tvrditi suprotno
 * o istom zadatku. Keš je kratak jer se trag mijenja samo kad spawn zavrsi.
 */
let _unverifiedCache: { at: number; body: any } | null = null
const UNVERIFIED_TTL_MS = 15_000

function handleUnverified(): Response {
  try {
    const now = Date.now()
    if (_unverifiedCache && now - _unverifiedCache.at < UNVERIFIED_TTL_MS) return json(_unverifiedCache.body)
    const st = unverifiedBoardState(undefined, now)
    const body = { day: st.day, todayCount: st.todayCount, tasks: st.tasks }
    _unverifiedCache = { at: now, body }
    return json(body)
  } catch (e) {
    // Vratar nikad ne smije srusiti plocu: prazno stanje = nijedna oznaka, ne greska.
    return json({ day: '', todayCount: 0, tasks: {}, error: String(e) })
  }
}

async function handleSessionUsage(req?: Request): Promise<Response> {
  // ?force=1 → I/O u konzoli; skraćuje prag svježine, ali probe i dalje ima donju branu.
  const force = req ? new URL(req.url).searchParams.get('force') === '1' : false
  const u = await resolveSessionUsage({ force }, sessionUsageDeps)
  // A7/TASK-3006: zona se MORA navesti izrijekom. Kontejner nema `TZ` (radi u UTC-u), a
  // `TIME_ZONE=Europe/Zagreb` runtime ne gleda — pa je traka za reset u 02:40 UTC pisala
  // „02:40" iako je stvarno 04:40 po Zagrebu. Formatiranje je na jednom mjestu
  // (`QuotaWakeup.formatLocalTime`) da prikaz i okidač ne mogu razići brojke.
  let resetLocal: string | null = null
  try {
    if (u.sessionResetAt) resetLocal = formatLocalTime(u.sessionResetAt)
  } catch {}
  // TASK-3461: presudu o mjerilu donosi daemon (on ga i pokreće) i zapisuje je u
  // `data/autonomy_queue.json`. Ploča je ovdje samo čita — dvije neovisne procjene istog
  // stanja značile bi da traka i dnevnik mogu tvrditi suprotno.
  const q = readWaitingQueue()
  return json({
    session_percent: u.sessionPercent,
    weekly_percent: u.weeklyPercent,
    session_reset_at: u.sessionResetAt,
    session_reset_local: resetLocal,
    weekly_reset_at: u.weeklyResetAt,
    status: u.status,
    age_s: Math.round(u.ageMs / 1000),
    source: u.source,
    stale: u.stale,
    error: u.error,
    meter_status: q?.meter_status ?? 'ok',
    meter_down_min: q?.meter_down_min ?? null,
    meter_error: q?.meter_error ?? null,
    waiting_for: q?.waiting_for ?? null,
  })
}

// ============================================================================
// TASK-3568 (T4): GET /api/tasks/:id/telemetry — „Potrošnja zadatka".
// Izračun je u `~/app/regoc_system/tools/agent_telemetry.py` (kriške T2/T3) i čita
// NAŠE transkripte; ploča ga samo poziva i keširaj. Zahtjev čeka najviše
// TELEMETRY_WAIT_MS pa vraća 202 „racuna" — kartica se ne smije zaglaviti na
// pythonu. Stari zadatci bez transkripta vraćaju 200 uz `imaPodatke:false`
// (prazno stanje), jer nedostatak podataka nije pogreška.
// ============================================================================
const telemetryState = createTelemetryState()
const telemetryDeps = createTelemetryDeps(telemetryState)

async function handleTaskTelemetry(taskId: string, url: URL): Promise<Response> {
  const force = url.searchParams.get('force') === '1'
  try {
    const r = await resolveTaskTelemetry(decodeURIComponent(taskId), { force }, telemetryDeps)
    return json({
      stanje: r.stanje,
      taskId: r.taskId,
      izvor: r.izvor,
      staroS: r.staroMs === null ? null : Math.round(r.staroMs / 1000),
      poruka: r.poruka,
      telemetrija: r.telemetrija,
    }, r.http)
  } catch (err) {
    // Nijedan kvar telemetrije ne smije srušiti karticu zadatka.
    const poruka = err instanceof Error ? err.message : String(err)
    return json({ stanje: 'greska', taskId, izvor: null, staroS: null, poruka, telemetrija: null }, 503)
  }
}

// ============================================================================
// TASK-3569 (T5): GET /api/pregled/tjedni — kartica „Potrošnja" (mjera 6).
// Agregacija `run_log.jsonl` + telemetrije NAŠIH transkripata po projektu
// (`tasks.project_id`) i po agentu za zadnjih N dana. Izračun je u
// `~/app/regoc_system/tools/tjedni_pregled.py`; ploča ga samo poziva i keširaj.
// Neispravan `dana`/`najskupljih` je 400 — python se ne pokreće s tuđim nizom.
// ============================================================================
const pregledState = createPregledState()
const pregledDeps = createPregledDeps(pregledState)

/**
 * TASK-3691: kontrolni zbroj troška iz `cost_log` za isto razdoblje (i isti projekt).
 *
 * Goran, 04.09.2026.: „to se mora vući iz istog izvora! Ne smije biti razlike."
 * Pregled zbraja `cost_usd` iz `run_log.jsonl`, kartica projekta iz `cost_log`. Oba zapisa
 * piše isti `SpawnTelemetry.recordSpawn()`, pa se moraju poklapati — izmjereno 04.09.:
 * 3 539,93 vs 3 540,00 USD, i tih 0,07 dolazi od 48 redaka bez `task_id`. Umjesto da se
 * na to oslanjamo, svaka odgovor nosi kontrolu: ako se izvori raziđu za više od 1 %,
 * ploča to KAŽE umjesto da tiho prikaže jedan od dva broja.
 */
function kontrolaTroska(dana: number, projekt: string | null): {
  costLogUsd: number | null; razlikaUsd: number | null; slaze: boolean | null
} {
  const db = getTrosakDb()
  if (!db) return { costLogUsd: null, razlikaUsd: null, slaze: null }
  try {
    const uvjetProjekt = projekt ? " AND COALESCE(project_id, '(bez projekta)') = ?" : ''
    const sql = `SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM cost_log
                  WHERE timestamp > datetime('now', ?)${uvjetProjekt}`
    const args: any[] = [`-${dana} days`]
    if (projekt) args.push(projekt)
    const r = db.query(sql).get(...args) as any
    return { costLogUsd: Math.round((r?.usd || 0) * 10000) / 10000, razlikaUsd: null, slaze: null }
  } catch {
    return { costLogUsd: null, razlikaUsd: null, slaze: null }
  }
}

/** Usporedi brojku pregleda s kontrolnim zbrojem; prag razilaženja je 1 %. */
function dopuniKontrolu(pregled: any, dana: number, projekt: string | null) {
  const k = kontrolaTroska(dana, projekt)
  if (k.costLogUsd === null) return k
  const izPregleda = pregled?.ukupno?.trosak?.usd
  if (typeof izPregleda !== 'number') return k
  const razlika = Math.round((izPregleda - k.costLogUsd) * 10000) / 10000
  const nazivnik = Math.max(Math.abs(k.costLogUsd), 0.01)
  return { ...k, razlikaUsd: razlika, slaze: Math.abs(razlika) / nazivnik <= 0.01 }
}

async function handleTjedniPregled(url: URL): Promise<Response> {
  const dana = parseBroj(url.searchParams.get('dana'), ZADANO_DANA, DANA_MIN, DANA_MAX)
  const najskupljih = parseBroj(
    url.searchParams.get('najskupljih'), ZADANO_NAJSKUPLJIH, NAJSKUPLJIH_MIN, NAJSKUPLJIH_MAX)
  if (dana === null || najskupljih === null) {
    return json({
      stanje: 'greska', izvor: null, staroS: null, pregled: null,
      poruka: `Neispravni parametri: dana ${DANA_MIN}–${DANA_MAX}, ` +
              `najskupljih ${NAJSKUPLJIH_MIN}–${NAJSKUPLJIH_MAX}.`,
    }, 400)
  }
  const force = url.searchParams.get('force') === '1'
  try {
    const r = await resolveTjedniPregled({ dana, najskupljih, force }, pregledDeps)
    return json({
      stanje: r.stanje,
      izvor: r.izvor,
      staroS: r.staroMs === null ? null : Math.round(r.staroMs / 1000),
      poruka: r.poruka,
      pregled: r.pregled,
      kontrola: r.pregled ? dopuniKontrolu(r.pregled, dana, null) : null,
    }, r.http)
  } catch (err) {
    // Nijedan kvar pregleda ne smije srušiti ploču.
    const poruka = err instanceof Error ? err.message : String(err)
    return json({ stanje: 'greska', izvor: null, staroS: null, poruka, pregled: null }, 503)
  }
}

// ============================================================================
// TASK-3572 (T8): GET /api/pregled/projekt/:id — „Potrošnja projekta" u panelu
// detalja projekta i brojka na kartici u popisu.
//
// NAMJERNO ISTI ALAT: `tjedni_pregled.py --projekt <id>`. Trećeg izračuna nema,
// pa se brojka pod projektom i brojka u tjednom pregledu ne mogu razići. Vrijede
// ista tri pravila kao za T4/T5: izračun je asinkron i keširan, 202 „racuna" NIJE
// pogreška, a uz svaku agregaciju ide nazivnik („iz N izvođenja").
//
// Nepoznat projekt je 404 PRIJE pokretanja pythona — inače bismo na svaku tipfelu
// platili puni prolaz nad transkriptima da bismo dobili prazan pregled.
// ============================================================================
/**
 * Energija JEDNOG projekta u istom prozoru koji panel prikazuje (ADR-0010 §8.1, P2 i P3).
 *
 * Izvor je `cost_log`, a ne `tjedni_pregled.py` koji puni ostatak panela — zato brojka nosi
 * vlastiti nazivnik („iz N izvođenja") i zato se ne smije zbrajati s ostalim ćelijama.
 * `poZadatku` služi P3: u tablici najskupljih zadataka energija nije drugo mjerilo skupoće
 * (ona JE 130 × cjenički trošak, ADR §11.1), nego dijagnostika — gdje se razilazi od
 * prikazanog troška više od 1,5 ×, knjigovodstvo troška i knjigovodstvo tokena za taj redak
 * ne govore istu priču (8,6 % redaka, ADR §11.2).
 */
function energijaJednogProjekta(projekt: string, dana: number): {
  sazetak: EnergijaSazetak | null; poZadatku: Record<string, number>
} {
  const prazno = { sazetak: null, poZadatku: {} as Record<string, number> }
  const db = getTrosakDb()
  if (!db) return prazno
  try {
    const prozor = `-${Math.max(1, Math.round(dana))} days`
    const redci = db.query(`
      SELECT c.task_id AS tid, c.model AS model,
             SUM(c.input_tokens) AS input_tokens, SUM(c.output_tokens) AS output_tokens,
             SUM(c.cache_read_tokens) AS cache_read_tokens, SUM(c.cache_write_tokens) AS cache_write_tokens,
             SUM(CASE WHEN COALESCE(c.input_tokens,0) + COALESCE(c.output_tokens,0)
                         + COALESCE(c.cache_read_tokens,0) + COALESCE(c.cache_write_tokens,0) > 0
                      THEN 1 ELSE 0 END) AS zapisa_s_tokenima
        FROM cost_log c
        LEFT JOIN tasks t ON t.id = c.task_id
       WHERE COALESCE(t.project_id, c.project_id) = ?
         AND c.timestamp > datetime('now', ?)
       GROUP BY c.task_id, c.model`).all(projekt, prozor) as any[]
    const svi = redci.map(r => ({
      model: r.model || '',
      inputTokens: r.input_tokens || 0, outputTokens: r.output_tokens || 0,
      cacheReadTokens: r.cache_read_tokens || 0, cacheWriteTokens: r.cache_write_tokens || 0,
      zapisaSTokenima: r.zapisa_s_tokenima || 0,
      tid: r.tid as string | null,
    }))
    const poZadatku: Record<string, number> = {}
    for (const r of svi) {
      if (!r.tid) continue
      const e = sazmiEnergiju([r])
      if (e) poZadatku[r.tid] = Math.round(((poZadatku[r.tid] || 0) + e.wh) * 1e4) / 1e4
    }
    return { sazetak: sazmiEnergiju(svi), poZadatku }
  } catch {
    // Procjena je dodatak; njezin izostanak ne ruši panel potrošnje.
    return prazno
  }
}

async function handleProjektPregled(projectIdSirovo: string, url: URL): Promise<Response> {
  const dekodiran = (() => {
    try { return decodeURIComponent(projectIdSirovo) } catch { return projectIdSirovo }
  })()
  const projekt = parseProjekt(dekodiran)
  if (!projekt) {
    return json({
      stanje: 'greska', projekt: null, izvor: null, staroS: null, pregled: null,
      poruka: 'Neispravan ključ projekta.',
    }, 400)
  }
  if (!projectManager.getProject(projekt)) {
    return json({
      stanje: 'greska', projekt, izvor: null, staroS: null, pregled: null,
      poruka: `Projekt ${projekt} ne postoji.`,
    }, 404)
  }

  const dana = parseBroj(url.searchParams.get('dana'), ZADANO_DANA, DANA_MIN, DANA_MAX)
  const najskupljih = parseBroj(
    url.searchParams.get('najskupljih'), ZADANO_NAJSKUPLJIH, NAJSKUPLJIH_MIN, NAJSKUPLJIH_MAX)
  if (dana === null || najskupljih === null) {
    return json({
      stanje: 'greska', projekt, izvor: null, staroS: null, pregled: null,
      poruka: `Neispravni parametri: dana ${DANA_MIN}–${DANA_MAX}, ` +
              `najskupljih ${NAJSKUPLJIH_MIN}–${NAJSKUPLJIH_MAX}.`,
    }, 400)
  }
  const force = url.searchParams.get('force') === '1'
  try {
    const r = await resolveTjedniPregled({ dana, najskupljih, projekt, force }, pregledDeps)
    const e = energijaJednogProjekta(projekt, dana)
    return json({
      stanje: r.stanje,
      projekt,
      izvor: r.izvor,
      staroS: r.staroMs === null ? null : Math.round(r.staroMs / 1000),
      poruka: r.poruka,
      pregled: r.pregled,
      // ADR-0010: PROCJENA iz cost_loga, vlastiti izvor i vlastiti nazivnik — ne zbraja se
      // s ćelijama koje dolaze iz `tjedni_pregled.py`.
      energija: e.sazetak ? { ...e.sazetak, dana } : null,
      energijaPoZadatku: e.poZadatku,
    }, r.http)
  } catch (err) {
    // Nijedan kvar potrošnje ne smije srušiti panel projekta.
    const poruka = err instanceof Error ? err.message : String(err)
    return json({ stanje: 'greska', projekt, izvor: null, staroS: null, poruka, pregled: null }, 503)
  }
}

function handleLoginStatus(): Response {
  const list = LOGIN_PROVIDERS.map(def => {
    const s = loginSessions.get(def.id)
    return {
      id: def.id, name: def.name, kind: def.kind,
      installed: def.kind === 'apikey' ? true : !!loginBinPath(def.bin),
      loggedIn: loginCredsPresent(def),
      apikey: !!def.envKey,
      active: !!s && !s.done,
      url: s?.url || '',
      installCmd: def.install || '',
    }
  })
  return json({ providers: list })
}
async function handleLoginStart(req: Request): Promise<Response> {
  try {
    const { id } = await req.json() as { id: string }
    const def = LOGIN_PROVIDERS.find(d => d.id === id)
    if (!def || def.kind !== 'oauth-cli') return json({ error: 'Nepoznat OAuth provider' }, 400)
    if (!loginBinPath(def.bin)) return json({ error: 'not-installed', installCmd: def.install || '' }, 409)
    const prev = loginSessions.get(id); if (prev && !prev.done) { try { prev.proc.kill() } catch {} }
    // Gemini: seed OAuth (Login-with-Google) auth-tip da preskoči interaktivni izbornik i ispiše
    // Google URL (redirect na codeassist.google.com/authcode → korisnik dobije KOD za paste).
    if (id === 'geminicli') {
      try {
        const gdir = loginHomeExpand('~/.gemini'); if (!existsSync(gdir)) mkdirSync(gdir, { recursive: true })
        const gset = join(gdir, 'settings.json')
        let cfg: any = {}; try { if (existsSync(gset)) cfg = JSON.parse(readFileSync(gset, 'utf-8')) } catch {}
        cfg.selectedAuthType = 'oauth-personal'
        cfg.security = { ...(cfg.security || {}), auth: { ...((cfg.security || {}).auth || {}), selectedType: 'oauth-personal' } }
        writeFileSync(gset, JSON.stringify(cfg, null, 2))
      } catch {}
    }
    // `script -qfec "<cmd>" /dev/null` alocira PTY; -f flush odmah.
    const proc = Bun.spawn(['script', '-qfec', def.cmd!, '/dev/null'], {
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: loginSpawnEnv(), cwd: process.env.HOME,
    })
    const sess: LoginSess = { proc, url: '', buf: '', ok: false, done: false, err: '', started: Date.now() }
    loginSessions.set(id, sess)
    ;(async () => {
      try {
        const reader = proc.stdout.getReader(); const dec = new TextDecoder()
        while (true) {
          const { done, value } = await reader.read(); if (done) break
          sess.buf += dec.decode(value, { stream: true })
          if (!sess.url) { const m = sess.buf.replace(/\r/g, '').match(/https?:\/\/[^\s"'<>]+/); if (m) sess.url = m[0] }
          if (loginCredsPresent(def)) break
        }
      } catch {}
      sess.ok = loginCredsPresent(def); sess.done = true
      if (sess.ok) loginSetProviderEnabled(id, true)
      try { proc.kill() } catch {}
    })()
    // Kratko pričekaj da URL stigne (device/oauth flow ispisuje ga u 1-2s)
    for (let i = 0; i < 30 && !sess.url && !sess.done; i++) await new Promise(r => setTimeout(r, 200))
    return json({ ok: true, url: sess.url, active: !sess.done })
  } catch (e: any) { return json({ error: String(e?.message || e) }, 500) }
}
function handleLoginPoll(url: URL): Response {
  const id = url.searchParams.get('id') || ''
  const def = LOGIN_PROVIDERS.find(d => d.id === id)
  if (!def) return json({ error: 'unknown' }, 404)
  const s = loginSessions.get(id)
  const loggedIn = loginCredsPresent(def)
  if (loggedIn && s && !s.done) { s.done = true; s.ok = true; loginSetProviderEnabled(id, true) }
  return json({ id, url: s?.url || '', loggedIn, done: s?.done ?? !s, active: !!s && !s.done, tail: (s?.buf || '').replace(/\r/g, '').slice(-400) })
}
async function handleLoginPaste(req: Request): Promise<Response> {
  try {
    const { id, code } = await req.json() as { id: string; code: string }
    const s = loginSessions.get(id)
    if (!s || s.done) return json({ error: 'Nema aktivne sesije' }, 409)
    s.proc.stdin.write((code || '') + '\n'); s.proc.stdin.flush?.()
    return json({ ok: true })
  } catch (e: any) { return json({ error: String(e?.message || e) }, 500) }
}
async function handleLoginApikey(req: Request): Promise<Response> {
  try {
    const { id, key } = await req.json() as { id: string; key: string }
    const def = LOGIN_PROVIDERS.find(d => d.id === id)
    if (!def || !def.envKey) return json({ error: 'Provider ne podržava API ključ' }, 400)
    if (!key || !key.trim()) return json({ error: 'Prazan ključ' }, 400)
    const f = loginHomeExpand('~/.claude/regoc/credentials.env')
    let txt = existsSync(f) ? readFileSync(f, 'utf-8') : ''
    const line = `${def.envKey}=${key.trim()}`
    txt = new RegExp('^' + def.envKey + '=.*$', 'm').test(txt) ? txt.replace(new RegExp('^' + def.envKey + '=.*$', 'm'), line) : (txt.replace(/\s*$/, '') + '\n' + line + '\n')
    writeFileSync(f, txt, { mode: 0o600 })
    // Gemini: prebaci auth na API-key (OAuth Code Assist je Google ukinuo) + trust workspace.
    if (id === 'geminicli') {
      try {
        const gdir = loginHomeExpand('~/.gemini'); if (!existsSync(gdir)) mkdirSync(gdir, { recursive: true })
        const gset = join(gdir, 'settings.json')
        let cfg: any = {}; try { if (existsSync(gset)) cfg = JSON.parse(readFileSync(gset, 'utf-8')) } catch {}
        cfg.selectedAuthType = 'gemini-api-key'
        cfg.security = { ...(cfg.security || {}), auth: { ...((cfg.security || {}).auth || {}), selectedType: 'gemini-api-key' } }
        writeFileSync(gset, JSON.stringify(cfg, null, 2))
      } catch {}
    }
    loginSetProviderEnabled(id, true)
    return json({ ok: true })
  } catch (e: any) { return json({ error: String(e?.message || e) }, 500) }
}
async function handleLoginLogout(req: Request): Promise<Response> {
  try {
    const { id } = await req.json() as { id: string }
    const def = LOGIN_PROVIDERS.find(d => d.id === id)
    if (!def) return json({ error: 'unknown' }, 404)
    const s = loginSessions.get(id); if (s && !s.done) { try { s.proc.kill() } catch {} ; s.done = true }
    if (def.kind === 'oauth-cli' && def.creds) { try { rmSync(loginHomeExpand(def.creds), { recursive: true, force: true }) } catch {} }
    // Odjava mora maknuti ONO ŠTO MJERILO GLEDA. Za davatelje s `envKey` (Gemini, OpenRouter)
    // to je ključ u spremištu: bez ovoga je odjava kozmetička — gumb ostane „prijavljen" i
    // tajna ostaje na disku iako korisnik misli da je odjavljen (TASK-4796).
    let kljucUklonjen = false
    if (def.envKey) { try { kljucUklonjen = ukloniKljucIzDatoteke(loginStorePath(), def.envKey) } catch {} }
    loginSetProviderEnabled(id, false)
    const loggedIn = loginCredsPresent(def)
    return json({ ok: !loggedIn, kljucUklonjen, loggedIn })
  } catch (e: any) { return json({ error: String(e?.message || e) }, 500) }
}

// Sigurno preuzimanje datoteke na koju task linka (resultSummary). Dozvoljeno SAMO unutar
// HOME-a; blokira path-traversal (resolve + prefix provjera), služi samo obične datoteke.
function handleFileDownload(url: URL): Response {
  try {
    const raw = (url.searchParams.get('path') || '').trim()
    if (!raw) return new Response('Missing path', { status: 400 })
    const HOME = process.env.HOME || ''
    const expanded = raw.startsWith('~/') ? join(HOME, raw.slice(2)) : raw
    const abs = resolve(expanded)
    const homeAbs = resolve(HOME)
    if (abs !== homeAbs && !abs.startsWith(homeAbs + '/')) {
      return new Response('Forbidden path (izvan HOME-a)', { status: 403 })
    }
    if (!existsSync(abs) || !statSync(abs).isFile()) return new Response('Not found', { status: 404 })
    const name = (abs.split('/').pop() || 'file').replace(/["\r\n]/g, '')
    return new Response(Bun.file(abs), {
      headers: { 'Content-Disposition': `attachment; filename="${name}"` }
    })
  } catch (e: any) {
    return new Response('Error: ' + (e?.message || e), { status: 500 })
  }
}

async function handleUpdateTask(taskId: string, req: Request): Promise<Response> {
  try {
    const body = await req.json()
    console.log(`[API] Updating task ${taskId} with:`, JSON.stringify(body))

    // ─── Nazivi polja (D6 / TASK-2976) ─────────────────────────────────────
    // Prompt-predložak koji daemon šalje SVAKOM agentu piše snake_case, shema je
    // camelCase, a Zod `.strip()` je razliku bacao bez ijedne greške: agent pošalje
    // sažetak, dobije 200, sažetak nestane (449/509 završenih bez rezultata).
    // Zato se nazivi prvo prevedu, a ono što ostane nepoznato ODBIJA se glasno —
    // tiho 200 je gore od 400 jer ploča izgleda uredno dok dokaza o radu nema.
    const fields = normalizeTaskFields(body, UPDATE_TASK_FIELDS)
    if (fields.unknown.length > 0) {
      console.error(`[API] ${taskId} PUT s nepoznatim poljem: ${fields.unknown.join(', ')}`)
      return new Response(JSON.stringify(unknownFieldResponseBody(fields.unknown, UPDATE_TASK_FIELDS)), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      })
    }
    if (fields.aliased.length > 0) {
      console.log(`[API] ${taskId} snake_case alias preslikan: ${fields.aliased.join(', ')}`)
    }
    if (fields.conflicts.length > 0) {
      console.warn(`[API] ${taskId} poslana OBA naziva, camelCase je mjerodavan; ignorirano: ${fields.conflicts.join(', ')}`)
    }

    // Validate with Zod
    const parseResult = UpdateTaskInputSchema.safeParse(fields.normalized)
    if (!parseResult.success) {
      console.error(`[API] Validation failed for task ${taskId}:`, parseResult.error.issues)
      return new Response(JSON.stringify({
        error: 'Validation failed',
        details: parseResult.error.issues
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    const validatedData = parseResult.data

    // Map validated data to TaskManagerSQL update format
    const updates: Record<string, unknown> = {}
    if (validatedData.title !== undefined) updates.title = validatedData.title
    if (validatedData.description !== undefined) updates.description = validatedData.description
    if (validatedData.status !== undefined) updates.status = validatedData.status
    if (validatedData.priority !== undefined) updates.priority = validatedData.priority
    if (validatedData.assignee !== undefined) updates.assignee = validatedData.assignee
    if (validatedData.blockedBy !== undefined) updates.blockedBy = validatedData.blockedBy
    if (validatedData.tags !== undefined) updates.tags = validatedData.tags
    if (validatedData.projectId !== undefined) updates.projectId = validatedData.projectId

    // Handle progressNotes via SQL update (TaskManagerSQL handles them internally)
    if (validatedData.progressNotes !== undefined && validatedData.progressNotes.length > 0) {
      updates.progressNotes = validatedData.progressNotes
    }

    // resultSummary (agentov odgovor apendan prije zatvaranja) i blockedReason (strojni razlog
    // blokade, TASK-2953). snake_case je već preveden gore u normalizeTaskFields — ovdje se
    // čita SAMO kanonski naziv, da alias-logika ne postoji na dva mjesta.
    const rs = validatedData.resultSummary
    if (rs !== undefined) updates.resultSummary = rs

    const br = validatedData.blockedReason
    if (br !== undefined) updates.blockedReason = br

    // ─── spawnCloseGuard (ADR-0012 §6.2, GAP_20260924 F4) ───────────────────
    // Rupa koju zatvara (izmjereno u živoj instalaciji): 6 od 6 zadataka kojima je kritičar
    // presudio FAIL stajalo je kao `completed`, jer ih je agent zatvorio 5–80 s PRIJE suda.
    // Guard ne pita TKO zove nego RADI LI SADA spawn na zadatku (najam + živ pid).
    // FAIL-OPEN: bez najma, s mrtvim pidom ili ustajalim zapisom PUT prolazi.
    // Prekidači (config/features.json): `spawnCloseGuard` = sud i zapis (sjena),
    // `spawnCloseGuardLive` = odbijanje 409. Oba zadano isključena dok orkestrator ne radi.
    if (updates.status && jeUkljuceno('spawnCloseGuard')) {
      try {
        const prisilno = req.headers.get('X-REGOC-Force') === '1'
        const bilo = odlukaGuarda({
          status: String(updates.status),
          prijelazi: (st: string) => taskManager.getAllowedTransitions(st),
          najamAktivan: najamAktivan(taskId),
          force: false,
        })
        if (bilo.odbij) {
          const zivi = jeUkljuceno('spawnCloseGuardLive')
          console.warn(`[API] spawn-close-guard: ${taskId} → ${updates.status} ` +
            `${zivi && !prisilno ? 'BLOKIRAM' : 'SJENA'}${prisilno ? ' (FORCE — čovjek je pregazio)' : ''} — ${bilo.razlog}`)
          try {
            appendFileSync(osigurajMapu(stanjePutanja('spawn_close_guard.jsonl')),
              JSON.stringify({ ts: new Date().toISOString(), taskId, status: updates.status,
                mode: zivi ? 'live' : 'shadow', forced: prisilno, assignee: taskManager.getTask(taskId)?.assignee ?? null }) + '\n')
          } catch { /* mjerenje ne smije oboriti API */ }
          if (zivi && !prisilno) {
            return new Response(JSON.stringify({
              error: 'Spawn active', code: bilo.code, details: bilo.razlog, hint: bilo.hint,
            }), { status: 409, headers: { 'Content-Type': 'application/json' } })
          }
        }
      } catch (e) {
        // Guard koji obori normalan rad biva isključen — svaka greška je fail-open.
        console.warn(`[API] spawn-close-guard: sud nije donesen (${e}) — PUT prolazi`)
      }
    }

    // ─── CompletionGuard (TASK-2954 / nalaz D2) ────────────────────────────
    // Zatvaranje u `completed` traži DOKAZ izvršenja. Ovo je jedini HTTP ulaz za
    // status zadatka, pa je i jedino mjesto gdje se pravilo može provesti za SVE
    // pozivatelje (agent curl, RegocDaemon auto-exec, UI, skripte).
    // Dokazani obrazac koji ovo zaustavlja: agent doslovno napiše "ne mogu / nemam
    // pristup alatima / zadatak je gotov." i svejedno postavi completed ⇒ ploča laže.
    // ROLLOUT (dorada TASK-2959): prvih 24 h SHADOW — sud se logira, status se piše
    // po starom. Iznimka su NE-heuristički sudovi (prazan rezultat, agentova vlastita
    // REGOC-STATUS deklaracija) koji se provode odmah jer ne mogu dati lažni pozitiv.
    // Konfiguracija: config/completion-gate.json { enabled, live, deterministicLive }.
    const gateCfg = loadGateConfig()
    if (updates.status === 'completed' && gateCfg.enabled) {
      const existingTask = taskManager.getTask(taskId)
      // Mjerodavan je tekst koji će ZAVRŠITI na zadatku: novi ako je poslan, inače postojeći.
      const effectiveSummary = rs !== undefined ? String(rs) : (existingTask?.resultSummary || '')
      // W3b/TASK-4879: grana `schema_missing` se ne provodi nad zatvaranjima koja blok nikad
      // nisu nosila u promptu. Ovo je jedino mjesto koje TO ZNA — redak zadatka ima
      // `started_at` (je li uopće bilo spawna) i oznake. `X-REGOC-Zatvara` daje pozivatelju
      // da se izjasni (`covjek` s ploče, `orkestrator` koji sažetak piše umjesto agenta);
      // bez zaglavlja se ništa ne izuzima — nepoznato nije izuzeto.
      const zaglavljeIzvor = req.headers.get('X-REGOC-Zatvara')
      const izvorZatvaranja = (['agent', 'orkestrator', 'covjek'] as const)
        .find((x) => x === zaglavljeIzvor)
      const kontekstZatvaranja: KontekstZatvaranja = {
        pocetoU: existingTask?.startedAt ?? null,
        // Zatvaranje se događa SADA — `completed_at` još nije zapisan.
        zavrsenoU: new Date().toISOString(),
        izvor: izvorZatvaranja ?? null,
        oznake: validatedData.tags !== undefined ? validatedData.tags : (existingTask?.tags || []),
      }
      const verdict = evaluateCompletion(effectiveSummary, kontekstZatvaranja)
      const forced = (validatedData as any).force === true
      const enforce = shouldEnforce(verdict, gateCfg) && !forced

      if (!verdict.accept) {
        console.warn(
          `[API] ${taskId} ${formatVerdictLog(verdict)} — ${enforce ? 'BLOKIRAM' : 'SHADOW'}` +
          `${forced ? ' (FORCED — čovjek je pregazio sud)' : ''}`,
        )
        // Shadow zapis u točno onom obliku koji rollout-provjera grepa.
        if (!enforce && !forced) console.warn(`[API] ${formatShadowLog(taskId, verdict)}`)
        if (enforce) {
          return new Response(JSON.stringify({
            error: 'Completion rejected',
            code: verdict.code,
            label: verdict.label,
            details: verdict.reason,
            suggestedStatus: verdict.suggestedStatus,
            suggestedBody: {
              status: 'blocked',
              blocked_reason: verdict.blockedReason.slice(0, 500),
              result_summary: effectiveSummary.slice(0, 20000),
            },
            hint: 'Zadatak koji NIJE izvršen zatvori kao blocked s razlogom (NEEDS_CONTEXT: fali opis / BLOCKED: fali alat). ' +
                  'Ako je posao stvarno napravljen, dopiši u result_summary ŠTO je pokrenuto i ŠTO je vraćeno (naredba, datoteka, mjerenje, status). ' +
                  'Ručno pregaziti sud: dodaj "force": true.',
          }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          })
        }
      }
    }

    // ─── ResearchRagGate (R2 / TASK-4309) ──────────────────────────────────
    // Istraživački zadatak (oznaka `istrazivanje`) ne smije u `completed` bez ID-a
    // dokumenta u result_summary. Razlog: nalaz koji živi samo u transkriptu nestane
    // za ~30 dana — PRJ-041 (najskuplji projekt) tako nema nijedan dokument u RAG-u.
    // Doseg je namjerno uzak (samo označeni zadaci) i sud je deterministički (postoji
    // li ID), pa smije biti live odmah, za razliku od CompletionGuarda koji sudi prozu.
    // Rollback bez restarta: config/research-rag-gate.json → live/enabled false.
    if (updates.status === 'completed') {
      const rcfg = loadResearchGateConfig()
      if (rcfg.enabled) {
        const rt = taskManager.getTask(taskId)
        const effTags = validatedData.tags !== undefined ? validatedData.tags : (rt?.tags || [])
        const effSummary = rs !== undefined ? String(rs) : (rt?.resultSummary || '')
        const effProject = (updates as any).projectId || rt?.projectId || null
        const rv = evaluateResearchClosure({ tags: effTags, resultSummary: effSummary, taskId, projectId: effProject })
        const rForced = (validatedData as any).force === true
        const rEnforce = shouldEnforceResearch(rv, rcfg) && !rForced
        if (rv.research) {
          console.warn(`[API] ${formatResearchLog(taskId, rv)}` +
            (rv.accept ? '' : (rEnforce ? ' — BLOKIRAM' : ' — SHADOW')) + (rForced ? ' (FORCED)' : ''))
        }
        if (!rv.accept && rEnforce) {
          return new Response(JSON.stringify({
            error: 'Research not stored in RAG',
            code: rv.code,
            details: rv.reason,
            command: ragStoreCommand(taskId, effProject),
            hint: formatResearchHint({ taskId, projectId: effProject }),
          }), { status: 400, headers: { 'Content-Type': 'application/json' } })
        }
      }
    }

    // ─── GitCommitGate (U4 / TASK-4264) ────────────────────────────────────
    // Zadatak otvoren po predlošku lanca (oznaka `lanac`) mora ostaviti trag u gitu:
    // rad koji nije commitan nestaje s radnim stablom, a ploča i dalje pokazuje ✅.
    // Doseg je namjerno uzak — samo zadaci kojima git obveza PIŠE u opisu (kažnjava se
    // pravilo koje je izvršitelj vidio). Izuzeće: oznaka `samo-tekst` iz koraka 4.
    // Rollback bez restarta: config/git-commit-gate.json → live/enabled false.
    if (updates.status === 'completed') {
      const gcfg = loadGitCommitGateConfig()
      if (gcfg.enabled) {
        const gt = taskManager.getTask(taskId)
        const gTags = validatedData.tags !== undefined ? validatedData.tags : (gt?.tags || [])
        const gSummary = rs !== undefined ? String(rs) : (gt?.resultSummary || '')
        const gUlaz = { taskId, tags: gTags, resultSummary: gSummary, scopeTags: gcfg.scopeTags }
        // `git log` po repozitoriju je jedini skup dio ovog vratara, pa se pokreće TEK
        // kad je zadatak u dosegu i nema dokaza u tekstu — inače bi svaki PUT plaćao
        // proces po repozitoriju.
        const gBezGita = evaluateCommitClosure(gUlaz)
        const gv = gBezGita.code === 'no_commit'
          ? evaluateCommitClosure({ ...gUlaz, gitProof: findTaskCommits(taskId, gcfg) })
          : gBezGita
        const gForced = (validatedData as any).force === true
        const gEnforce = shouldEnforceCommit(gv, gcfg) && !gForced
        if (gv.inScope) {
          console.warn(`[API] ${formatCommitLog(taskId, gv)}` +
            (gv.accept ? '' : (gEnforce ? ' — BLOKIRAM' : ' — SHADOW')) + (gForced ? ' (FORCED)' : ''))
        }
        if (!gv.accept && gEnforce) {
          return new Response(JSON.stringify({
            error: 'No commit for chain task',
            code: gv.code,
            details: gv.reason,
            hint: formatCommitHint(taskId),
          }), { status: 400, headers: { 'Content-Type': 'application/json' } })
        }
      }
    }

    const task = taskManager.updateTask(taskId, updates as any)

    if (!task) {
      // updateTask returns null for two distinct reasons: the task genuinely
      // does not exist, OR a forbidden status transition was requested on an
      // existing task (e.g. completed -> in_progress). Collapsing both into a
      // 404 "Task not found" is misleading and has repeatedly tripped agents
      // that blindly follow the in_progress->completed protocol. Disambiguate
      // by re-fetching: if the task exists, it was a forbidden transition (409).
      const existing = taskManager.getTask(taskId)
      if (existing) {
        const allowed = taskManager.getAllowedTransitions(existing.status)
        const requested = (updates as any).status
        console.error(`[API] Forbidden status transition for ${taskId}: ${existing.status} -> ${requested}`)
        return new Response(JSON.stringify({
          error: 'Forbidden status transition',
          details: `Task ${taskId} is '${existing.status}' and cannot transition to '${requested}'.`,
          currentStatus: existing.status,
          requestedStatus: requested,
          allowedTransitions: allowed
        }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      console.error(`[API] Task ${taskId} not found`)
      return new Response(JSON.stringify({ error: 'Task not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    console.log(`[API] Task ${taskId} updated successfully. New priority: ${task.priority}`)

    // ─── Pometnja dojava (U4 / TASK-4264) ──────────────────────────────────
    // Okidač je zatvaranje ZADATKA NIZA, ne mjerač vremena: dojava ide u istoj sekundi
    // u kojoj je pao zadnji zadatak. Zadatak dojave šalje JEDNU poruku za cijeli niz —
    // dok je i jedan zadatak otvoren, ne šalje se ništa.
    // Pometnja nikad ne ruši PUT (vlastiti try/catch u `sweepReportBack`), a zaostatak
    // (zadatak zatvoren mimo ovog puta) pokupi `tools/lanac-otvori.ts --provjeri`.
    if (task.status === 'completed' || task.status === 'cancelled') {
      const rez = sweepReportBack(taskManager as any, { log: m => console.warn(`[API] report-back: ${m}`) })
      for (const f of rez.fired) console.warn(`[API] report-back: SENT ${f.id} → ${f.code} (${f.reason})`)
      // I zadržane dojave idu u dnevnik: „zašto korisnik nije ništa dobio" mora imati
      // odgovor na jednom mjestu, inače se šutnja sustava ne da razlikovati od kvara.
      for (const h of rez.held) console.warn(`[API] report-back: HELD ${h.id} ${h.code} — ${h.reason}`)
    }

    // ─── Telegram obavijest (Kosjenka, 09.09.2026.) ──────────────────────
    // Kad zadatak prijeđe u completed/failed, pošalji obavijest na Telegram.
    // Nikad ne ruši PUT — neuspjeh slanja se samo logira.
    if (task.status === 'completed' || task.status === 'failed') {
      try {
        const tgRez = await obavijestiZadatak(taskId, String(task.title || ''), task.status)
        if (tgRez.ok) {
          console.log(`[TELEGRAM] obavijest poslana: ${taskId} → ${task.status}`)
        } else {
          console.log(`[TELEGRAM] obavijest nije poslana: ${tgRez.greska}`)
        }
      } catch (e: any) {
        console.warn(`[TELEGRAM] greška pri slanju obavijesti: ${String(e && e.message ? e.message : e)}`)
      }
    }

    // Broadcast to WebSocket clients
    const message = JSON.stringify({ type: 'task_updated', task })
    wsClients.forEach(client => {
      try { client.send(message) } catch { wsClients.delete(client) }
    })

    return new Response(JSON.stringify(task), {
      headers: { 'Content-Type': 'application/json' }
    })
  } catch (error) {
    console.error(`[API] Error updating task ${taskId}:`, error)
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    })
  }
}

/**
 * POST /api/tasks/:id/reclaim — R2 stale-watchdog (TASK-2560).
 *
 * Odvojena ruta jer `in_progress -> pending` NAMJERNO nije u ValidStatusTransitions
 * (agent ne smije vraćati vlastiti task unatrag kroz obični PUT). Watchdog je jedina
 * legitimna iznimka, pa ide kroz vlastiti, auditirani ulaz.
 *
 * Body: { reason: string }  → 200 task | 400 bez razloga | 404 nema taska | 409 nije in_progress
 */
async function handleReclaimTask(taskId: string, req: Request): Promise<Response> {
  const json = (body: unknown, status: number) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

  try {
    const body = await req.json().catch(() => ({} as any))
    const reason = typeof body?.reason === 'string' ? body.reason.trim() : ''
    const by = typeof body?.by === 'string' && body.by.trim() ? body.by.trim() : 'stale-watchdog'

    if (!reason) {
      return json({ error: 'Missing reason', details: 'Reclaim zahtijeva tekstualni "reason" (ide u audit trail).' }, 400)
    }

    const existing = taskManager.getTask(taskId)
    if (!existing) {
      console.error(`[API] Reclaim: task ${taskId} not found`)
      return json({ error: 'Task not found' }, 404)
    }
    if (existing.status !== 'in_progress') {
      return json({
        error: 'Not reclaimable',
        details: `Task ${taskId} je '${existing.status}' — reclaim je dopušten samo iz 'in_progress'.`,
        currentStatus: existing.status,
      }, 409)
    }

    const task = taskManager.reclaimStaleTask(taskId, reason, by)
    if (!task) return json({ error: 'Reclaim failed' }, 500)

    console.log(`[API] Task ${taskId} reclaimed by ${by}: ${reason}`)

    const message = JSON.stringify({ type: 'task_updated', task })
    wsClients.forEach(client => {
      try { client.send(message) } catch { wsClients.delete(client) }
    })

    return json(task, 200)
  } catch (error) {
    console.error(`[API] Error reclaiming task ${taskId}:`, error)
    return json({ error: 'Invalid JSON body' }, 400)
  }
}

async function handleUpdateTaskProgress(taskId: string, req: Request): Promise<Response> {
  try {
    const body = await req.json()
    console.log(`[API] Updating task ${taskId} progress with:`, JSON.stringify(body))

    // Validate progressPercent
    if (typeof body.progressPercent !== 'number' || body.progressPercent < 0 || body.progressPercent > 100) {
      console.error(`[API] Invalid progressPercent for task ${taskId}:`, body.progressPercent)
      return new Response(JSON.stringify({
        error: 'Validation failed',
        details: [{ message: 'progressPercent must be a number between 0 and 100' }]
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    // Update task with new progressPercent
    const updates: Record<string, unknown> = {
      progressPercent: body.progressPercent
    }

    // Add progress note if provided
    if (body.note) {
      const agent = 'regoc'
      taskManager.addProgressNote(taskId, agent, body.note)
    }

    const task = taskManager.updateTask(taskId, updates as any)

    if (!task) {
      console.error(`[API] Task ${taskId} not found`)
      return new Response(JSON.stringify({ error: 'Task not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    console.log(`[API] Task ${taskId} progress updated to ${task.progressPercent}%`)

    // Broadcast to WebSocket clients
    const message = JSON.stringify({ type: 'task_updated', task })
    wsClients.forEach(client => {
      try { client.send(message) } catch { wsClients.delete(client) }
    })

    return new Response(JSON.stringify(task), {
      headers: { 'Content-Type': 'application/json' }
    })
  } catch (error) {
    console.error(`[API] Error updating task progress ${taskId}:`, error)
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    })
  }
}

// ============================================
// RUČNA KOČNICA (TASK-3047)
// ============================================

/**
 * POST /api/tasks/:id/pause  · POST /api/tasks/:id/resume
 *
 * Pauza NE mijenja status zadatka. Namjerno: `cancelled` i `completed` su terminalni, a
 * `in_progress→pending` je zabranjen prijelaz — pauza kroz status bi zadatak ili zaključala
 * ili bi tražila rupu u automatu. Zastavica `paused` čuva status netaknutim, pa „Nastavi"
 * doslovno vraća zadatak tamo gdje je stao.
 */
function handleTaskPause(taskId: string, paused: boolean, req: Request): Promise<Response> {
  return (async () => {
    let by = 'user'
    let reason = ''
    try {
      const body = await req.json() as any
      if (typeof body?.by === 'string' && body.by) by = body.by
      if (typeof body?.reason === 'string') reason = body.reason
    } catch { /* tijelo nije obavezno */ }

    const task = taskManager.setTaskPaused(taskId, paused, by, reason)
    if (!task) {
      return new Response(JSON.stringify({ error: 'Task not found' }), {
        status: 404, headers: { 'Content-Type': 'application/json' },
      })
    }
    console.log(`[API] Task ${taskId} ${paused ? 'PAUZIRAN' : 'NASTAVLJEN'} (${by})${reason ? ` — ${reason}` : ''}`)

    const message = JSON.stringify({ type: 'task_updated', task })
    wsClients.forEach(client => { try { client.send(message) } catch { wsClients.delete(client) } })

    return new Response(JSON.stringify(task), { headers: { 'Content-Type': 'application/json' } })
  })()
}


// ============================================
// DODATNE UPUTE AGENTU DOK RADI (TASK-5013)
// ============================================

/**
 * POST /api/tasks/:id/uputa `{text, author?}` — nova uputa za agenta koji radi (ili sljedeći spawn).
 * GET  /api/tasks/:id/upute[?nedostavljene=1] — popis za ploču (dostavljeno / nije).
 * POST /api/tasks/:id/upute/preuzmi `{session}` — SAMO za hook TaskInstructionsInject: atomično
 *      vrati nedostavljene i označi ih `delivered_at` + sesija.
 *
 * Upute NISU progressNotes: njih piše i sam agent, pa bi se uputa izgubila među njegovim
 * bilješkama, a agent ih ionako ne čita (TASK-4999). Dostavu radi hook u spawnanoj sesiji.
 */
const UPUTA_TERMINALNI = new Set(['completed', 'cancelled'])

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function broadcastInstructions(taskId: string): void {
  const message = JSON.stringify({ type: 'task_instructions', taskId, counts: taskManager.taskInstructionCounts(taskId) })
  wsClients.forEach(client => { try { client.send(message) } catch { wsClients.delete(client) } })
}

async function handleAddInstruction(taskId: string, req: Request): Promise<Response> {
  const task = taskManager.getTask(taskId)
  if (!task) return jsonResp({ error: 'Task not found' }, 404)
  if (UPUTA_TERMINALNI.has(String(task.status))) {
    return jsonResp({ error: `Zadatak je '${task.status}' — nijedan agent ga više neće pokrenuti, uputa ne bi stigla nikome. Otvori novi zadatak.` }, 409)
  }
  let body: unknown = null
  try { body = await req.json() } catch { /* validacija ispod javlja grešku */ }
  const p = parseInstructionInput(body)
  if (!p.ok) return jsonResp({ error: p.error }, 400)
  const row = taskManager.addTaskInstruction(taskId, p.author, p.text)
  console.log(`[API] 📨 uputa #${row.id} za ${taskId} (${p.author}, ${p.text.length} zn.)`)
  broadcastInstructions(taskId)
  return jsonResp({ ok: true, instruction: row, counts: taskManager.taskInstructionCounts(taskId), taskStatus: task.status }, 201)
}

function handleListInstructions(taskId: string, url: URL): Response {
  const samoNove = ['1', 'true', 'da'].includes(String(url.searchParams.get('nedostavljene') || '').toLowerCase())
  return jsonResp({
    taskId,
    instructions: taskManager.listTaskInstructions(taskId, samoNove),
    counts: taskManager.taskInstructionCounts(taskId),
  })
}

async function handleClaimInstructions(taskId: string, req: Request): Promise<Response> {
  let session: string | null = null
  try {
    const b = await req.json() as any
    if (typeof b?.session === 'string' && b.session) session = b.session.slice(0, 64)
  } catch { /* sesija nije obavezna */ }
  const rows = taskManager.claimTaskInstructions(taskId, session)
  if (rows.length) {
    console.log(`[API] 📬 ${taskId}: dostavljeno ${rows.map(r => '#' + r.id).join(', ')} → sesija ${session || '?'}`)
    broadcastInstructions(taskId)
  }
  return jsonResp({ taskId, instructions: rows })
}




/**
 * GET/PUT /api/odlucitelj/config  ·  POST /api/odlucitelj/pokreni
 *
 * Goran, 04.09.2026.: „dodao bi switch i odabir modela koji se moze koristiti umjesto odluke
 * korisnika."
 *
 * Odluka modela ide ISTIM putem kao ljudska (`/api/tasks/<ID>/odluka`), pa je trag jednak i
 * uvijek se vidi tko je potpisan. Rizične zadatke model uopće ne vidi — deterministički
 * filtar u `tools/odlucitelj.py` ih zadrži prije njega (mjereno: bez filtra qwen3:8b kaže
 * „kreni" na 6 od 7 rizičnih, s filtrom 7/7 točno).
 */
const ODLUCITELJ_CONFIG_PATH = konfigPutanja('odlucitelj.json', 'TM_ODLUCITELJ_CONFIG')
const ODLUCITELJ_ZADANE = {
  ukljucen: false, provider: 'ollama', model: 'qwen3:8b',
  baseUrl: process.env.TM_OLLAMA_URL || '', najvise_po_prolazu: 3, smije_kreni: true,
  // Koliko čovjek ima vremena prije nego model odluči (i koliko traje odgoda). Stari naziv
  // `odgoda_sati` se i dalje čita u `tools/odlucitelj.py`.
  cekanje_sati: 1,
}

function ucitajOdluciteljConfig(): Record<string, any> {
  try {
    return { ...ODLUCITELJ_ZADANE,
             ...JSON.parse(require('fs').readFileSync(ODLUCITELJ_CONFIG_PATH, 'utf-8')) }
  } catch { return { ...ODLUCITELJ_ZADANE } }
}

function putanjaOdlucitelja(): string | null {
  const fs = require('fs')
  for (const put of [`${process.env.HOME}/app/regoc_system/tools/odlucitelj.py`,
                     `${import.meta.dir}/../tools/odlucitelj.py`,
                     `${process.env.HOME}/.claude/regoc/tools/odlucitelj.py`]) {
    if (fs.existsSync(put)) return put
  }
  return null
}

/** Poznati modeli za davatelje bez javnog kataloga. Polazište, ne ograda — sučelje dopušta
 *  i vlastito ime modela. */
const POZNATI_MODELI: Record<string, string[]> = {
  anthropic: ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-5'],
  google: ['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-2.5-pro'],
  glm: ['glm-4.6', 'glm-4.7-flash'],
  kimi: ['kimi-k2-0905-preview'],
  minimax: ['MiniMax-M2'],
  qwen: ['qwen3-coder-plus'],
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
}

/** Katalog OpenRoutera je javan i ima 400+ modela; besplatni idu naprijed jer odluka o
 *  zadatku ne smije koštati više od samog zadatka. */
async function openrouterModeli(): Promise<string[]> {
  try {
    const r = await fetch('https://openrouter.ai/api/v1/models',
                          { signal: AbortSignal.timeout(15000) })
    if (!r.ok) return []
    const d = await r.json() as any
    const svi = (d.data || []) as any[]
    const cijena = (m: any) => Number(m?.pricing?.prompt ?? 9) || 0
    // Auto-ruteri (`openrouter/auto` i srodni) sami biraju model po zadatku, pa idu na vrh:
    // to je izbor kod kojeg se ne mora pogoditi ime modela. Ispadali su iz popisa jer im
    // cijena nije obična brojka — filtar po cijeni ih je tiho izbacivao.
    const auto = svi.filter(m => String(m.id).startsWith('openrouter/')).map(m => m.id)
    const jeAuto = new Set(auto)
    const besplatni = svi.filter(m => !jeAuto.has(m.id) && cijena(m) === 0).map(m => m.id)
    const ostali = svi.filter(m => !jeAuto.has(m.id) && cijena(m) > 0)
      .sort((a, b) => cijena(a) - cijena(b)).map(m => m.id)
    return [...auto, ...besplatni, ...ostali]
  } catch { return [] }
}

/** Davatelji iz `models/model-config.json` + je li svaki stvarno upotrebljiv.
 *  Davatelj bez ključa se NE skriva nego pošteno prijavi — inače bi izbor bio lažan. */
function odluciteljDavatelji(): Record<string, any> {
  const fs = require('fs')
  let konf: Record<string, any> = {}
  try {
    konf = JSON.parse(fs.readFileSync(
      `${process.env.HOME}/.claude/regoc/models/model-config.json`, 'utf-8')).providers || {}
  } catch { /* bez konfiguracije ostaje samo lokalni put */ }
  let spremiste = ''
  try {
    spremiste = fs.readFileSync(`${process.env.HOME}/.claude/regoc/credentials.env`, 'utf-8')
  } catch { /* nema spremišta — tada odlučuje samo okolina */ }
  // Provjerava se SAMO postoji li redak s tim imenom; vrijednost se nikad ne čita ni ne šalje.
  const imaKljuc = (ime: string) =>
    !!process.env[ime] || new RegExp('^' + ime + '=\\S', 'm').test(spremiste)

  const out: Record<string, any> = {}
  for (const [ime, v] of Object.entries(konf)) {
    if (!v || typeof v !== 'object') continue
    const sirovi = String((v as any).apiKey || '')
    const env = sirovi.startsWith('env:') ? sirovi.slice(4) : ''
    let spreman = env ? imaKljuc(env) : true
    let zasto = spreman ? 'spreman' : 'treba ' + env
    if (ime === 'ollama') { spreman = true; zasto = 'lokalno' }
    if (ime === 'anthropic') {
      spreman = !!Bun.which('claude')
      zasto = spreman ? 'Claude CLI — troši istu kvotu kao rad' : 'nema Claude CLI'
    }
    out[ime] = { ukljucen: !!(v as any).enabled, spreman, zasto,
                 baseUrl: (v as any).baseUrl || null }
  }
  return out
}

async function handleOdluciteljConfigGet(): Promise<Response> {
  const postavke = ucitajOdluciteljConfig()
  const dav = odluciteljDavatelji()
  const odabrani = String(postavke.provider || 'ollama')

  let modeli: string[] = []
  let dostupno = false
  let greska: string | null = null
  if (odabrani === 'ollama') {
    try {
      // Modeli za ugrađivanje (`*-embedding*`) vraćaju vektore, ne tekst — kao izbor
      // odlučitelja bili bi tiha slijepa ulica. Ollama ih vraća u istom popisu, pa se
      // ovdje izbacuju; automatski odabir prvog inače uzme baš njih.
      const svi = await fetchOllamaModels(String(postavke.baseUrl))
      modeli = svi.filter(m => !/embed/i.test(String(m)))
      dostupno = true
    }
    catch (e: any) { greska = String(e?.message ?? e) }
  } else if (odabrani === 'openrouter') {
    modeli = await openrouterModeli()
    dostupno = modeli.length > 0
    if (!dostupno) greska = 'katalog OpenRoutera nije dostupan'
  } else {
    modeli = POZNATI_MODELI[odabrani] || []
    dostupno = !!dav[odabrani]?.spreman
    if (!dostupno) greska = dav[odabrani]?.zasto || 'davatelj nije spreman'
  }
  if (postavke.model && !modeli.includes(String(postavke.model))) {
    modeli.unshift(String(postavke.model))
  }

  return new Response(JSON.stringify({
    postavke, modeli, dostupno, greska,
    davatelji: dav,
    putanja: ODLUCITELJ_CONFIG_PATH,
    alat: putanjaOdlucitelja(),
  }), { headers: { 'Content-Type': 'application/json' } })
}

async function handleOdluciteljConfigPut(req: Request): Promise<Response> {
  const json = (o: unknown, st = 200) =>
    new Response(JSON.stringify(o), { status: st, headers: { 'Content-Type': 'application/json' } })
  let telo: any
  try { telo = await req.json() } catch { return json({ error: 'neispravan JSON' }, 400) }
  const stare = ucitajOdluciteljConfig()
  const nove: Record<string, any> = { ...stare }
  if (typeof telo.ukljucen === 'boolean') nove.ukljucen = telo.ukljucen
  if (typeof telo.smije_kreni === 'boolean') nove.smije_kreni = telo.smije_kreni
  if (typeof telo.model === 'string' && telo.model.trim()) nove.model = telo.model.trim()
  if (typeof telo.provider === 'string' && telo.provider.trim()) {
    // Model prethodnog davatelja kod novoga ne postoji (qwen3:8b nije model na Anthropicu),
    // pa se pri promjeni davatelja model briše i sučelje uzme prvi iz njegova popisa.
    if (telo.provider.trim() !== nove.provider) nove.model = ''
    nove.provider = telo.provider.trim()
  }
  if (typeof telo.baseUrl === 'string' && telo.baseUrl.trim()) nove.baseUrl = telo.baseUrl.trim()
  const n = Number(telo.najvise_po_prolazu)
  if (Number.isFinite(n) && n >= 1 && n <= 20) nove.najvise_po_prolazu = Math.round(n)
  // Goran, 05.09.2026.: „dodati opcije za namjestiti koliko je to cekanje." Isti broj vrijedi
  // za rok koji čovjek dobije prije nego model odluči i za trajanje odgode. Raspon: 5 min do
  // 3 dana — ispod toga najava nema smisla, iznad toga to više nije odgoda nego zaborav.
  const c = Number(telo.cekanje_sati)
  if (Number.isFinite(c) && c >= 0.08 && c <= 72) nove.cekanje_sati = Math.round(c * 100) / 100
  try {
    const fs = require('fs')
    fs.mkdirSync(require('path').dirname(ODLUCITELJ_CONFIG_PATH), { recursive: true })
    fs.writeFileSync(ODLUCITELJ_CONFIG_PATH, JSON.stringify(nove, null, 1))
  } catch (e: any) { return json({ error: `zapis nije uspio: ${e?.message ?? e}` }, 500) }
  console.log(`[API] odlucitelj: ukljucen=${nove.ukljucen} model=${nove.provider}/${nove.model}`)
  return json({ ok: true, postavke: nove })
}

/** Jedan prolaz odlučitelja. `proba=true` ništa ne mijenja — samo pokaže što bi odlučio. */
async function handleOdluciteljPokreni(req: Request): Promise<Response> {
  const json = (o: unknown, st = 200) =>
    new Response(JSON.stringify(o), { status: st, headers: { 'Content-Type': 'application/json' } })
  let proba = true
  try { const b = await req.json() as any; if (b?.proba === false) proba = false } catch { }
  const alat = putanjaOdlucitelja()
  if (!alat) return json({ error: 'alat odlucitelj.py nije pronađen na ovom stroju' }, 500)
  if (!proba && !ucitajOdluciteljConfig().ukljucen) {
    return json({ error: 'odlučitelj je isključen — uključi ga prije izvršavanja' }, 409)
  }
  try {
    const pr = Bun.spawn(['python3', alat, proba ? '--proba' : '--izvrsi', '--json'],
                         { stdout: 'pipe', stderr: 'pipe' })
    const izlaz = await new Response(pr.stdout).text()
    const greske = await new Response(pr.stderr).text()
    await pr.exited
    let ishodi: any[] = []
    try { ishodi = JSON.parse(izlaz.trim() || '[]') } catch { /* alat je javio tekstom */ }
    return json({ ok: true, proba, ishodi, poruka: izlaz.trim().slice(0, 400),
                  greska: greske.trim().slice(0, 300) || null })
  } catch (e: any) { return json({ error: String(e?.message ?? e) }, 500) }
}

/**
 * GET /api/jezici        — koji jezici postoje i koji je zadani
 * GET /api/jezik/<kod>   — rječnik jednog jezika
 *
 * Goran, 04.09.2026.: „ako se to moze odraditi tako da taj vizualni dio ima mogucnost odabira
 * vise jezika … naknadno mozda samo ako netko zeli doda jezik u nekom fajlu i odabere ga kao
 * default."
 *
 * Zato se popis NE drži u kodu nego se čita iz mape `locales/`: nova datoteka `<kod>.json`
 * pojavi se u izborniku bez ijedne izmjene koda. Zadani jezik je `TM_LANG` ili
 * `config/jezik.json`; ako ni toga nema, hrvatski.
 *
 * Prevodi se SAMO sučelje. Naslovi, opisi i bilješke zadataka su podatci korisnika i kroz
 * ovaj put nikad ne prolaze.
 */
const LOCALES_DIR = `${import.meta.dir}/../locales`

const IMENA_JEZIKA: Record<string, string> = {
  hr: 'Hrvatski', en: 'English', de: 'Deutsch', it: 'Italiano', fr: 'Français',
  es: 'Español', sl: 'Slovenščina', sr: 'Srpski',
}

function zadaniJezik(): string {
  if (process.env.TM_LANG) return String(process.env.TM_LANG).toLowerCase()
  try {
    const c = JSON.parse(require('fs').readFileSync(`${import.meta.dir}/../config/jezik.json`, 'utf-8'))
    if (c?.zadani) return String(c.zadani).toLowerCase()
  } catch { /* nema datoteke — vrijedi ugrađeni zadani */ }
  return 'hr'
}

function dostupniJezici(): string[] {
  try {
    return require('fs').readdirSync(LOCALES_DIR)
      .filter((f: string) => f.endsWith('.json'))
      .map((f: string) => f.replace(/\.json$/, ''))
      .sort()
  } catch { return ['hr'] }
}

function handleGetJezici(): Response {
  const kodovi = dostupniJezici()
  return new Response(JSON.stringify({
    zadani: kodovi.includes(zadaniJezik()) ? zadaniJezik() : (kodovi[0] || 'hr'),
    jezici: kodovi.map(k => ({ kod: k, naziv: IMENA_JEZIKA[k] || k.toUpperCase() })),
  }), { headers: { 'Content-Type': 'application/json' } })
}

function handleGetJezik(kod: string): Response {
  // Samo slova i crtica — putanja se sastavlja od korisnikova unosa, pa nema izlaska iz mape.
  if (!/^[a-z]{2}(-[a-z]{2})?$/i.test(kod)) {
    return new Response(JSON.stringify({ error: 'neispravan kod jezika' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    })
  }
  try {
    // Engleski je podloga: ključ bez prijevoda pada na njega umjesto da ostane prazan ili u
    // zatečenom jeziku. Tako je i djelomičan prijevod upotrebljiv — što je uvjet da netko
    // uopće doda jezik postupno, jednu datoteku po jednu.
    const fs = require('fs')
    let podloga: Record<string, string> = {}
    try { podloga = JSON.parse(fs.readFileSync(`${LOCALES_DIR}/en.json`, 'utf-8')) } catch { }
    const trazeni = JSON.parse(fs.readFileSync(`${LOCALES_DIR}/${kod.toLowerCase()}.json`, 'utf-8'))
    return new Response(JSON.stringify({ ...podloga, ...trazeni }),
      { headers: { 'Content-Type': 'application/json' } })
  } catch {
    return new Response(JSON.stringify({ error: `nema rječnika za „${kod}"` }), {
      status: 404, headers: { 'Content-Type': 'application/json' },
    })
  }
}

/**
 * GET  /api/odluke — zadatci koji čekaju ljudsku odluku (oznaka needs-decision i srodne).
 * POST /api/tasks/:id/odluka `{odluka, by?}` — upiši odluku i vrati zadatak u red.
 *
 * Goran, 04.09.2026.: "taj needs-decision je ok, ali onda mi to napravi da je vidljivo i
 * dodaj polje gdje ću upisati odluku i stisnuti nastavi."
 *
 * Povod: devet zadataka stajalo je 1,5 h s tom oznakom, a nigdje se nije vidjelo da čekaju
 * — ni na ploči ni u dnevniku. Oznaka je ispravan mehanizam; nedostajalo je mjesto na kojem
 * se odluka donosi.
 *
 * Odluka se NE briše nego ostaje u `progress_notes` — inače bi se poslije znalo samo da je
 * zadatak krenuo, a ne zašto i tko ga je pustio.
 */
const OZNAKE_ODLUKE = ['needs-decision', 'no-autonomy', 'waiting-for-human', 'interactive']

/** Zadatak je „gotov" za potrebe lanca kad je zatvoren — dovršen ili otkazan. */
const ZATVOREN = (s: any) => ['completed', 'cancelled'].includes(String(s))

/**
 * Koliko zadataka (izravno i posredno) čeka na ovaj — mjera „koliko niza drži".
 *
 * Goran, 05.09.2026.: „onim jednim koji blokira cijeli niz, to bi trebalo biti vidljivije
 * označeno jer ovako ne vidim." Broj otključanih je jedini podatak koji razlikuje korijen
 * niza od lista, a do sada se nigdje nije računao.
 */
function brojOtkljucanih(id: string, po: Map<string, any>): number {
  const vidjeni = new Set<string>()
  const red = [...(po.get(id)?.blocks || [])]
  while (red.length) {
    const sljedeci = String(red.shift())
    if (vidjeni.has(sljedeci)) continue          // ciklus u lancu ne smije vrtjeti petlju
    const t = po.get(sljedeci)
    if (!t || ZATVOREN(t.status)) continue
    vidjeni.add(sljedeci)
    for (const d of (t.blocks || [])) red.push(String(d))
  }
  return vidjeni.size
}

function handleGetOdluke(): Response {
  const svi = taskManager.getTasks() as any[]
  const po = new Map<string, any>(svi.map(t => [String(t.id), t]))
  // Zadnji prolaz odlucitelja. Bez ovoga se s ploce ne vidi RADI LI uopce — Goran je
  // 05.09.2026. ukljucio prekidac i cekao pola sata pred zelenom oznakom koja nista ne znaci.
  const zadnjiProlaz = citajZadnjiProlaz()
  const kazePoZadatku = new Map<string, any>(
    (zadnjiProlaz?.ishodi || []).map(i => [String(i.id), i]))
  // Odgode i stanje prekidača: kad model odlučuje, zadatak koji „stoji" najčešće ne čeka
  // čovjeka nego istek odgode — a to se s ploče nije vidjelo.
  const odgode = citajOdgode()
  const modelOdlucuje = odluciteljConfig().ukljucen
  const cekaju = svi
    .filter(t => ['pending', 'blocked'].includes(String(t.status)))
    .filter(t => (t.tags || []).some((g: string) => OZNAKE_ODLUKE.includes(String(g).toLowerCase())))
    .map(t => {
      // Pitanje se traži u opisu, pa u bilješkama (agent ga zna dopisati naknadno, kad tek
      // usred rada naiđe na razdvojnicu).
      const izvor = [String(t.description || ''),
                     ...(t.progressNotes || []).map((b: any) => String(b?.note ?? b ?? ''))]
      let pitanje = null
      for (let i = izvor.length - 1; i >= 0 && !pitanje; i--) pitanje = rasclaniPitanje(izvor[i])
      const provjera = provjeriPitanje(pitanje)
      // „Čeka na" su SAMO nezatvorene ovisnosti. Do 05.09. se čitao status `blocked`, pa je
      // zadatak čiji je blokator odavno dovršen i dalje pisao „blokirano drugim zadatkom" —
      // sedam takvih stajalo je na ploči, a nijedan zapravo nije čekao ništa osim odluke.
      const cekaNa = (t.blockedBy || []).map(String).filter((b: string) => {
        const bl = po.get(b)
        return bl ? !ZATVOREN(bl.status) : false
      })
      return {
        id: t.id, title: t.title, assignee: t.assignee,
        // Opis BEZ bloka pitanja — pitanje se iscrtava zasebno, pa bi ga proza ponovila.
        description: pitanje ? ukloniPitanje(t.description) : String(t.description || ''),
        priority: t.priority, projectId: t.projectId ?? t.project_id, status: t.status,
        createdAt: t.createdAt ?? t.created_at,
        oznake: (t.tags || []).filter((g: string) => OZNAKE_ODLUKE.includes(String(g).toLowerCase())),
        cekaSati: Math.round((Date.now() - new Date(t.createdAt ?? t.created_at ?? Date.now()).getTime()) / 36e5),
        pitanje, pitanjeGreske: provjera.ok ? [] : provjera.greske,
        ulogaModela: ulogaZaModel(pitanje),
        // Okidač je stroj, ne prosudba: odlučitelj takav zadatak preskače (nema pristup
        // stanju okidača), a puštanje traži provjerenu činjenicu. Vidi StrojniOkidac.ts.
        okidacStrojni: imaStrojniOkidac(t.tags),
        cekaNa,
        blokiraniRazlog: cekaNa.length ? String(t.blockedReason || '') : '',
        otkljucava: brojOtkljucanih(String(t.id), po),
        odluciteljKaze: kazePoZadatku.get(String(t.id)) ?? null,
        odgoda: odgode[String(t.id)] ?? null,
      }
    })
    // Prvo ono što odluka doista pušta u rad, pa unutar toga ono što otključava najviše
    // posla — to je „onaj jedan koji drži cijeli niz".
    .sort((a, b) => (a.cekaNa.length - b.cekaNa.length)
      || (b.otkljucava - a.otkljucava)
      || (a.priority ?? 9) - (b.priority ?? 9)
      || b.cekaSati - a.cekaSati)
  const spremni = cekaju.filter(t => t.cekaNa.length === 0).length
  return new Response(JSON.stringify({
    ukupno: cekaju.length, spremni, blokirani: cekaju.length - spremni, zadatci: cekaju,
    modelOdlucuje,
    odluciteljZadnji: zadnjiProlaz
      ? { ts: zadnjiProlaz.ts, opis: opisiProlaz(zadnjiProlaz), upisano: zadnjiProlaz.upisano,
          pregledano: zadnjiProlaz.pregledano, greska: zadnjiProlaz.greska ?? null }
      : null,
  }), { headers: { 'Content-Type': 'application/json' } })
}

/**
 * POST /api/tasks/:id/pitanje `{ekspert, pitanje, opcije[], preporuka?, by?}`
 *
 * Jedini ispravan način da agent zatraži odluku. Dopisuje blok u opis, stavlja oznaku
 * `needs-decision` i vraća zadatak u `blocked` — pa je „pitao sam" i „stao sam" jedan potez,
 * a ne dva koja se mogu razići.
 *
 * Odbija (HTTP 400) pitanje bez struke ili s manje od dvije opcije: to onda nije dilema nego
 * posao koji treba obaviti, a upravo su takva „pitanja" pretvorila blokadu u smetlište.
 */
function handleTaskPitanje(taskId: string, req: Request): Promise<Response> {
  return (async () => {
    const json = (o: any, status = 200) => new Response(JSON.stringify(o),
      { status, headers: { 'Content-Type': 'application/json' } })
    let body: any = {}
    try { body = await req.json() } catch { /* provjera slijedi */ }

    const nacrt = {
      ekspert: String(body?.ekspert || '').trim(),
      pitanje: String(body?.pitanje || '').trim(),
      opcije: Array.isArray(body?.opcije) ? body.opcije : [],
      preporuka: body?.preporuka ? String(body.preporuka) : undefined,
    }
    const blok = sastaviPitanje(nacrt)
    const provjera = provjeriPitanje(rasclaniPitanje(blok))
    if (!provjera.ok) {
      return json({ error: 'Pitanje nije po pravilu.', greske: provjera.greske,
        primjer: sastaviPitanje({
          ekspert: '<struka koja zna odgovoriti>',
          pitanje: 'Objasni mi sa svog stručnog stajališta <predmet> i pomozi mi da donesem odluku o <odluci>.',
          opcije: ['<prva mogućnost> — <posljedica>', '<druga mogućnost> — <posljedica>'],
          preporuka: '<slovo> — <zašto>',
        }) }, 400)
    }

    const task = taskManager.getTask(taskId) as any
    if (!task) return json({ error: 'Task not found' }, 404)

    const by = String(body?.by || task.assignee || 'agent')
    const oznake = [...(task.tags || [])]
    if (!oznake.some((g: string) => String(g).toLowerCase() === 'needs-decision')) oznake.push('needs-decision')
    const opis = String(task.description || '').trimEnd()
    const azurirano = taskManager.updateTask(taskId, {
      description: `${opis}\n\n${blok}`,
      tags: oznake,
      progressNotes: [`PITANJE (${by}): ${nacrt.pitanje} — ${nacrt.opcije.length} opcije, struka: ${nacrt.ekspert}`],
      ...(String(task.status) === 'in_progress' || String(task.status) === 'pending'
        ? { status: 'blocked', blockedReason: `Čeka odluku: ${nacrt.pitanje.slice(0, 200)}` } : {}),
    } as any)

    console.log(`[API] PITANJE ${taskId} (${by}): ${nacrt.opcije.length} opcije · struka ${nacrt.ekspert}`)
    const message = JSON.stringify({ type: 'task_updated', task: azurirano })
    wsClients.forEach(client => { try { client.send(message) } catch { wsClients.delete(client) } })
    return json({ ok: true, task: azurirano, blok })
  })()
}

function handleTaskOdluka(taskId: string, req: Request): Promise<Response> {
  return (async () => {
    let odluka = ''
    let by = 'goran'
    // Činjenica koju poslužitelj sam provjeri — jedini ključ za zadatak sa strojnim okidačem.
    let cinjenica = ''
    try {
      const body = await req.json() as any
      if (typeof body?.odluka === 'string') odluka = body.odluka.trim()
      if (typeof body?.by === 'string' && body.by) by = body.by
      if (typeof body?.cinjenica === 'string') cinjenica = body.cinjenica.trim()
    } catch { /* tijelo je obavezno — provjera slijedi */ }

    if (!odluka) {
      return new Response(JSON.stringify({ error: 'Odluka je obavezna — upiši što je odlučeno.' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      })
    }

    const task = taskManager.getTask(taskId) as any
    if (!task) {
      return new Response(JSON.stringify({ error: 'Task not found' }), {
        status: 404, headers: { 'Content-Type': 'application/json' },
      })
    }

    // Odgovor „B" razriješi u punu rečenicu prije zapisa — inače u povijesti zadatka ostane
    // samo slovo, a značenje nestane s prvom izmjenom opisa.
    const izvorPitanja = [String(task.description || ''),
                          ...(task.progressNotes || []).map((b: any) => String(b?.note ?? b ?? ''))]
    let pitanjeTaska = null
    for (let i = izvorPitanja.length - 1; i >= 0 && !pitanjeTaska; i--) {
      pitanjeTaska = rasclaniPitanje(izvorPitanja[i])
    }
    odluka = razrijesiOdgovor(odluka, pitanjeTaska)

    // ODGODA NIJE PUŠTANJE (05.09.2026.). Do danas je svaka odluka — pa i „odgodi, treba mi
    // još podataka", koju sam placeholder polja predlaže — skidala oznaku, dopisivala `nalog`
    // i gurala zadatak u red. Model koji kaže ODGODI time je pokretao posao koji je htio
    // odgoditi. Odgoda zato mijenja SAMO povijest: zadatak ostaje točno gdje jest.
    const odgoda = /^\s*(odgodi|odgoda|odgadjam|odgađam|čekaj|cekaj|pričekaj|pricekaj|ne\s+sada|ne\s+još|ne\s+jos)\b/i
      .test(odluka)
    const kad = new Date().toLocaleString('hr-HR', { timeZone: 'Europe/Zagreb' })
    if (odgoda) {
      const odgodjen = taskManager.updateTask(taskId, {
        progressNotes: [`ODLUKA — ODGODA (${by}, ${kad} Europe/Zagreb): ${odluka}`],
      } as any)
      console.log(`[API] ODGODA ${taskId} (${by}): ${odluka.slice(0, 90)}`)
      const poruka = JSON.stringify({ type: 'task_updated', task: odgodjen })
      wsClients.forEach(c => { try { c.send(poruka) } catch { wsClients.delete(c) } })
      return new Response(JSON.stringify({ ok: true, task: odgodjen, kreceOdmah: false,
        odgodjeno: true, skinuteOznake: [] }), { headers: { 'Content-Type': 'application/json' } })
    }

    // Zadatak koji JOŠ ČEKA nedovršenu ovisnost ne smije u `pending` ni s odlukom — inače
    // krene prije svog preduvjeta. Izmjereno 05.09.2026.: odlučitelj je pustio TASK-4616 (W2)
    // dok je TASK-4614 (W1) još stajao.
    const svi = taskManager.getTasks() as any[]
    const statusPo = new Map<string, string>(svi.map(t => [String(t.id), String(t.status)]))

    // STROJNI OKIDAČ (05.09.2026., ADR-0010). Zadatak označen `okidac-strojni` čeka stanje
    // koje odlučitelj NE VIDI (nastala datoteka, prošao trenutak, dovršen preduvjet), pa je
    // svaki sud iz naslova i opisa nagađanje. Puštanje zato traži činjenicu koju poslužitelj
    // sam provjeri — tvrdnja se ne uzima na riječ. Mjereno na TASK-4651: dva suprotna suda
    // istog modela u 7 minuta, a pobjednički je digao zadatak 2,2 dana prerano.
    if (imaStrojniOkidac(task.tags)) {
      const sud = provjeriCinjenicu(cinjenica, {
        status: (id: string) => statusPo.get(id),
      })
      if (!sud.ok) {
        // Odbijenica se ZAPISUJE, ali samo kad je nova — inače bi prolaz svakih 5 min
        // pretvorio povijest zadatka u dnevnik odbijanja.
        const zadnja = (task.progressNotes || []).map((b: any) => String(b?.note ?? b ?? '')).pop() || ''
        const biljeska = `PUŠTANJE ODBIJENO (${by}, ${kad} Europe/Zagreb): okidač je strojno provjerljiv — ${sud.opis}`
        if (!zadnja.startsWith('PUŠTANJE ODBIJENO') || !zadnja.endsWith(sud.opis)) {
          taskManager.updateTask(taskId, { progressNotes: [biljeska] } as any)
        }
        console.log(`[API] ODBIJENO PUŠTANJE ${taskId} (${by}): ${sud.opis}`)
        return new Response(JSON.stringify({
          error: 'Zadatak ima strojno provjerljiv okidač — puštanje traži provjerenu činjenicu.',
          razlog: sud.opis, oznaka: OZNAKA_STROJNI_OKIDAC, polje: 'cinjenica',
          oblici: OBLICI_CINJENICE,
          savjet: `Ako okidač više ne vrijedi, skini oznaku ${OZNAKA_STROJNI_OKIDAC} `
            + 'zasebnim potezom (PUT /api/tasks/<ID> {tags}) pa odluči normalno.',
          kreceOdmah: false, skinuteOznake: [],
        }), { status: 409, headers: { 'Content-Type': 'application/json' } })
      }
      // Dokaz ide u istu rečenicu kao odluka — za pola godine se mora vidjeti ŠTO je bilo
      // istina u trenutku puštanja, ne samo da je netko rekao „kreni".
      odluka = `${odluka} [činjenica: ${cinjenica} → ${sud.opis}]`
    }
    const josCeka = (task.blockedBy || []).map(String)
      .filter((b: string) => !['completed', 'cancelled'].includes(statusPo.get(b) || ''))

    const preostale = (task.tags || []).filter(
      (g: string) => !OZNAKE_ODLUKE.includes(String(g).toLowerCase()))
    // Oznaka `nalog`: odluka nije autonomni rad nego izričito puštanje, pa u daemonu prolazi
    // kroz `spawnOnRequest` i ne čeka obnovu kvote. Bez nje se odluka uredno zapiše, a zadatak
    // svejedno stoji — izmjereno 04.09.2026. na dvije odluke pri 82 % sjednice.
    const azurirano = taskManager.updateTask(taskId, {
      tags: [...preostale, 'nalog'],
      progressNotes: [`ODLUKA (${by}, ${kad} Europe/Zagreb): ${odluka}`],
      // Zadatak koji je bio `blocked` mora natrag u `pending`, inače ga red i dalje ne vidi —
      // ali samo ako ga više ne drži nijedna nedovršena ovisnost.
      ...(String(task.status) === 'blocked' && josCeka.length === 0 ? { status: 'pending' } : {}),
      ...(josCeka.length ? { blockedReason: `Odluka je zapisana — čeka još: ${josCeka.join(', ')}` } : {}),
    } as any)

    console.log(`[API] ODLUKA ${taskId} (${by}): ${odluka.slice(0, 90)}`)
    const message = JSON.stringify({ type: 'task_updated', task: azurirano })
    wsClients.forEach(client => { try { client.send(message) } catch { wsClients.delete(client) } })

    return new Response(JSON.stringify({ ok: true, task: azurirano, kreceOdmah: josCeka.length === 0,
      cekaJos: josCeka, skinuteOznake:
      (task.tags || []).filter((g: string) => OZNAKE_ODLUKE.includes(String(g).toLowerCase())) }), {
      headers: { 'Content-Type': 'application/json' },
    })
  })()
}

/**
 * GET /api/pause — stanje globalne kočnice.
 * POST /api/pause `{paused: bool, by?, reason?}` — pritisni/otpusti.
 *
 * Globalna pauza zaustavlja auto-exec I prekida tekuće spawnove (RegocDaemon.enforcePauses).
 * Stanje je u datoteci jer ga čitaju tri procesa i mora preživjeti restart bilo kojeg.
 */
function handleGetPause(): Response {
  const state = readPauseState()
  return new Response(JSON.stringify({ ...state, description: describePause(state) }), {
    headers: { 'Content-Type': 'application/json' },
  })
}

// ─── Strop usporednih agenata ────────────────────────────────────────────────
// Izvor istine: tablica `settings` (core/ConcurrencySetting.ts). Orkestrator ga čita uživo
// (keš ≤5 s), pa PUT ne traži restart. `active` = broj zadataka `in_progress`.
function concurrencyPayload() {
  const cur = taskManager.getConcurrencySetting()
  const inProgress = taskManager.getTasks({ status: 'in_progress' } as any).length
  const env = process.env[CONCURRENCY_ENV]
  return {
    maxConcurrent: cur.value, min: CONCURRENCY_MIN, max: CONCURRENCY_MAX, default: CONCURRENCY_DEFAULT,
    updatedBy: cur.updatedBy, updatedAt: cur.updatedAt, source: cur.source,
    active: inProgress, activeSource: 'in_progress', inProgress,
    history: taskManager.getConcurrencyHistory(10),
    envDeprecated: env ? `${CONCURRENCY_ENV}=${env} u okolini se ignorira (zastarjelo) — vrijedi postavka` : null,
  }
}

function handleConcurrencyGet(): Response {
  try {
    return new Response(JSON.stringify(concurrencyPayload()), { headers: { 'Content-Type': 'application/json' } })
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
}

async function handleConcurrencyPut(req: Request): Promise<Response> {
  let body: any
  try { body = await req.json() } catch {
    return new Response(JSON.stringify({ error: 'Neispravno JSON tijelo' }), { status: 400, headers: { 'Content-Type': 'application/json' } })
  }
  const p = parseConcurrencyInput(body?.maxConcurrent)
  if (!p.ok) return new Response(JSON.stringify({ error: p.error }), { status: 400, headers: { 'Content-Type': 'application/json' } })
  const by = typeof body.by === 'string' && body.by.trim() ? body.by.trim() : 'config'
  const source = typeof body.source === 'string' && body.source.trim() ? body.source.trim().slice(0, 32) : 'config'
  const ch = taskManager.setConcurrencySetting(p.value, by, source)
  console.log(`[API] ${formatConcurrencyChange({ oldValue: ch.oldValue, newValue: ch.newValue, changedBy: ch.changedBy, source })}`)
  const message = JSON.stringify({ type: 'concurrency_changed', concurrency: { maxConcurrent: ch.newValue, by: ch.changedBy } })
  wsClients.forEach(client => { try { client.send(message) } catch { wsClients.delete(client) } })
  return new Response(JSON.stringify({ ...concurrencyPayload(), change: ch }), { headers: { 'Content-Type': 'application/json' } })
}

async function handleSetPause(req: Request): Promise<Response> {
  try {
    const body = await req.json() as any
    if (typeof body?.paused !== 'boolean') {
      return new Response(JSON.stringify({ error: 'Polje `paused` (boolean) je obavezno' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      })
    }
    const state = writePauseState({
      paused: body.paused,
      by: typeof body.by === 'string' && body.by ? body.by : 'user',
      reason: typeof body.reason === 'string' ? body.reason : '',
    })
    console.log(`[API] Globalna kočnica: ${describePause(state)}`)

    const message = JSON.stringify({ type: 'pause_changed', pause: state })
    wsClients.forEach(client => { try { client.send(message) } catch { wsClients.delete(client) } })

    return new Response(JSON.stringify({ ...state, description: describePause(state) }), {
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (error) {
    return new Response(JSON.stringify({ error: `Neispravno tijelo zahtjeva: ${error}` }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    })
  }
}

function handleDeleteTask(taskId: string): Response {
  const success = taskManager.deleteTask(taskId)

  if (!success) {
    return new Response(JSON.stringify({ error: 'Task not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  // Broadcast to WebSocket clients
  const message = JSON.stringify({ type: 'task_deleted', taskId })
  wsClients.forEach(client => {
    try { client.send(message) } catch { wsClients.delete(client) }
  })

  return new Response(JSON.stringify({ success: true }), {
    headers: { 'Content-Type': 'application/json' }
  })
}

function handleHealthCheck(): Response {
  return new Response(JSON.stringify({
    status: 'healthy',
    watcher: watcherReady,
    clients: wsClients.size,
    timestamp: new Date().toISOString()
  }), {
    headers: { 'Content-Type': 'application/json' }
  })
}

// ============================================
// PROJECT API HANDLERS
// ============================================

/**
 * TASK-3691 (Goran, 04.09.2026.): „pod projects moraju biti izlistani svi projekti i mora se
 * vidjeti potrošnja po projektu".
 *
 * Zašto zaseban izvor, a ne tjedni pregled: kartica projekta je dosad brojku vukla iz
 * `tools/tjedni_pregled.py` za prozor od 30 dana, pa je projekt bez izvođenja u tom prozoru
 * pokazivao „—" iako je na njemu potrošeno stotine eura. `cost_log` nosi SVE — i agentske
 * spawnove (SpawnTelemetry) i naknadno uvezene telegramske zahtjeve — pa daje UKUPNO po
 * projektu bez pokretanja pythona (upit traje milisekunde, kartica se smije osvježavati sama).
 *
 * Prozor od 30 dana ostaje uz ukupno, da se vidi je li projekt živ ili samo skup.
 */
let trosakDb: Database | null = null
function getTrosakDb(): Database | null {
  if (trosakDb) return trosakDb
  try {
    trosakDb = new Database(TM_DB, { readonly: true })
  } catch {
    trosakDb = null
  }
  return trosakDb
}

/**
 * TASK-3691 (Goran, 04.09.2026.): „napravi izračun koliko se novaca potrošilo na user input …
 * podijeljeno po korisnicima."
 *
 * VRIJEDNOST rada po cjeniku S1–S6, ne trošak modela — te dvije brojke stoje jedna uz drugu
 * i namjerno se ne zbrajaju. Izračun radi `tools/vrijednost_inputa.py` nad transkriptima
 * (živi + arhiv); traje ~6 s, pa se drži u kešu 10 minuta i ploča ga ne čeka pri svakom crtanju.
 */
const VRIJEDNOST_TTL_MS = 10 * 60_000
let vrijednostKes: { u: number; podatci: any } | null = null

async function handleVrijednostInputa(url: URL): Promise<Response> {
  const force = url.searchParams.get('force') === '1'
  if (!force && vrijednostKes && Date.now() - vrijednostKes.u < VRIJEDNOST_TTL_MS) {
    return json({ ...vrijednostKes.podatci, izvor: 'kes',
                  staroS: Math.round((Date.now() - vrijednostKes.u) / 1000) })
  }
  // Alat se traži prvo UZ PAKET (samostalna instalacija na nodu), pa u REGOČ instalaciji —
  // isti redoslijed kao TjedniPregled.prviPostojeci. Bez toga je ruta na nodovima vraćala
  // 503 jer ondje `~/app/regoc_system` ne postoji.
  const kandidati = [
    join(import.meta.dir, '..', 'tools', 'vrijednost_inputa.py'),
    join(process.env.HOME || homedir(), 'app/regoc_system/tools/vrijednost_inputa.py'),
  ]
  const alat = kandidati.find(p => existsSync(p))
  if (!alat) return json({ error: 'alat nije pronađen', trazeno: kandidati }, 503)
  try {
    const proc = Bun.spawn(['python3', alat, '--json'], { stdout: 'pipe', stderr: 'pipe' })
    const izlaz = await new Response(proc.stdout).text()
    const kod = await proc.exited
    if (kod !== 0) {
      const greska = await new Response(proc.stderr).text()
      return json({ error: 'izračun nije uspio', detalj: greska.slice(-400) }, 500)
    }
    const podatci = JSON.parse(izlaz)
    vrijednostKes = { u: Date.now(), podatci }
    return json({ ...podatci, izvor: 'izracun', staroS: 0 })
  } catch (e) {
    return json({ error: String(e) }, 500)
  }
}

/**
 * Procjena potrošnje struje po projektu (ADR-0010, TASK-4820) — IZVEDENA pri čitanju,
 * nigdje se ne sprema (§7: koeficijenti će se mijenjati, upisana brojka bi zamrznula
 * procjenu iz 2026. u retke zauvijek).
 *
 * Dva upita umjesto jednoga (§11.3): trošak i energija dijele pripis projekta
 * (`LEFT JOIN tasks`), ali energija MORA grupirati i po modelu — inače `k = 1` svima i
 * podcjena 1,584 ×. Kvar upita ne smije srušiti karticu, pa je sve u `try`: bez energije
 * ploča i dalje pokazuje trošak.
 */
function energijaPoProjektu(db: Database): Record<string, EnergijaSazetak> {
  const po: Record<string, EnergijaSazetak> = {}
  try {
    const redci = db.query(ENERGIJA_PO_PROJEKTU_SQL).all() as any[]
    const grupe: Record<string, any[]> = {}
    for (const r of redci) {
      (grupe[r.pid] ||= []).push({
        model: r.model || '',
        inputTokens: r.input_tokens || 0,
        outputTokens: r.output_tokens || 0,
        cacheReadTokens: r.cache_read_tokens || 0,
        cacheWriteTokens: r.cache_write_tokens || 0,
        zapisaSTokenima: r.zapisa_s_tokenima || 0,
      })
    }
    for (const pid of Object.keys(grupe)) {
      const e = sazmiEnergiju(grupe[pid])
      if (e) po[pid] = e   // `null` = nijedan redak s tokenima → kartica pokazuje „—", ne 0
    }
  } catch {
    // Energija je dodatak trošku; njezin izostanak ne smije oboriti /api/projects/trosak.
  }
  return po
}


function handleGetProjectsTrosak(): Response {
  const db = getTrosakDb()
  if (!db) {
    return new Response(JSON.stringify({ error: 'baza nedostupna' }), {
      status: 503, headers: { 'Content-Type': 'application/json' },
    })
  }
  try {
    // U3/TASK-4263: projekt se čita JOIN-om na zadatak, ne samo iz `cost_log.project_id`.
    // Zašto — v. `TROSAK_PO_PROJEKTU_SQL` u `CostTracker.ts`; SQL stoji ondje, uz
    // `logUsage` čiji ugovor provodi, da ploča i pisac ne mogu razviti dvije istine.
    const ukupno = db.query(TROSAK_PO_PROJEKTU_SQL).all() as any[]
    // TASK-3691 (sort na popisu projekata): „datum početka" NIJE `projects.created_at` —
    // projekt se često otvori naknadno (PRJ-041 otvoren 25.08., a rad počeo ranije). Zato
    // se početak čita iz PRVOG zadatka, a zadnji rad iz najnovijeg traga na zadatku.
    const razdoblje = db.query(`
      SELECT project_id AS pid,
             MIN(created_at) AS prvi,
             MAX(COALESCE(completed_at, updated_at, created_at)) AS zadnji
        FROM tasks WHERE project_id IS NOT NULL
       GROUP BY project_id
    `).all() as any[]
    const zadnjih30 = db.query(TROSAK_PO_PROJEKTU_PROZOR_SQL).all('-30 days') as any[]
    const energija = energijaPoProjektu(db)

    const po: Record<string, any> = {}
    for (const r of ukupno) {
      po[r.pid] = { usdUkupno: r.usd ?? 0, zapisaUkupno: r.zapisa ?? 0, zadnji: r.zadnji ?? null, usd30: null, zapisa30: 0 }
    }
    for (const r of zadnjih30) {
      if (!po[r.pid]) po[r.pid] = { usdUkupno: 0, zapisaUkupno: 0, zadnji: null, usd30: null, zapisa30: 0 }
      po[r.pid].usd30 = r.usd ?? 0
      po[r.pid].zapisa30 = r.zapisa ?? 0
    }
    for (const r of razdoblje) {
      if (!po[r.pid]) po[r.pid] = { usdUkupno: 0, zapisaUkupno: 0, zadnji: null, usd30: null, zapisa30: 0 }
      po[r.pid].prviZadatak = r.prvi ?? null
      po[r.pid].zadnjiZadatak = r.zadnji ?? null
    }
    for (const pid of Object.keys(energija)) {
      if (!po[pid]) po[pid] = { usdUkupno: 0, zapisaUkupno: 0, zadnji: null, usd30: null, zapisa30: 0 }
      po[pid].energija = energija[pid]
    }
    const zbroj = ukupno.reduce((a, r) => a + (r.usd || 0), 0)
    // Ukupna energija je zbroj projekata, a ne zaseban upit — da se zbroj kartica i brojka
    // u zaglavlju ne mogu razići (ista zamka koju je TASK-4263 otkrio kod troška).
    const energijaWh = Object.values(energija).reduce((a, e) => a + e.wh, 0)
    const energijaIzTokena = Object.values(energija).reduce((a, e) => a + e.izTokena, 0)
    return new Response(JSON.stringify({
      izracunatoU: new Date().toISOString(),
      izvor: 'cost_log',
      ukupnoUsd: Math.round(zbroj * 10000) / 10000,
      projekata: Object.keys(po).length,
      // PROCJENA, ne mjerenje (ADR-0010 §8.2) — `procjena: true` je ugovor prema sučelju.
      // Objekt slaže ISTA funkcija koja ga slaže po projektu (ADR-0011): dvije ruke koje
      // neovisno grade isti oblik su isti raskorak koji je TASK-4263 otkrio kod troška.
      energija: energijaSazetakOdWh(
        energijaWh, energijaIzTokena,
        Object.values(energija).reduce((a, e) => a + e.modelNepoznat, 0)),
      poProjektu: po,
    }), { headers: { 'Content-Type': 'application/json' } })
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }
}

function handleGetProjects(url: URL): Response {
  const rawFilter: Record<string, unknown> = {}

  const status = url.searchParams.get('status')
  const priority = url.searchParams.get('priority')
  const lead_agent = url.searchParams.get('lead_agent')
  const agent = url.searchParams.get('agent')
  const tag = url.searchParams.get('tag')
  const search = url.searchParams.get('search')

  if (status) rawFilter.status = status
  if (priority) rawFilter.priority = parseInt(priority)
  if (lead_agent) rawFilter.lead_agent = lead_agent
  if (agent) rawFilter.agent = agent
  if (tag) rawFilter.tag = tag
  if (search) rawFilter.search = search

  const parseResult = ProjectFilterSchema.safeParse(rawFilter)
  if (!parseResult.success) {
    return new Response(JSON.stringify({
      error: 'Validation failed',
      details: parseResult.error.issues
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  const projects = projectManager.getProjects(parseResult.data)

  return new Response(JSON.stringify(projects), {
    headers: { 'Content-Type': 'application/json' }
  })
}

function handleGetProject(projectId: string): Response {
  const project = projectManager.getProject(projectId)

  if (!project) {
    return new Response(JSON.stringify({ error: 'Project not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  // Include agents and RAG links
  const agents = projectManager.getProjectAgents(projectId)
  const ragLinks = projectManager.getProjectRAGLinks(projectId)
  const tasks = projectManager.getProjectTasks(projectId)

  return new Response(JSON.stringify({
    ...project,
    agents,
    ragLinks,
    tasks
  }), {
    headers: { 'Content-Type': 'application/json' }
  })
}

async function handleCreateProject(req: Request): Promise<Response> {
  try {
    const body = await req.json()

    const parseResult = CreateProjectInputSchema.safeParse(body)
    if (!parseResult.success) {
      return new Response(JSON.stringify({
        error: 'Validation failed',
        details: parseResult.error.issues
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    const project = projectManager.createProject(parseResult.data)

    // Broadcast to WebSocket clients
    const message = JSON.stringify({ type: 'project_created', project })
    wsClients.forEach(client => {
      try { client.send(message) } catch { wsClients.delete(client) }
    })

    return new Response(JSON.stringify(project), {
      status: 201,
      headers: { 'Content-Type': 'application/json' }
    })
  } catch (error) {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    })
  }
}

async function handleUpdateProject(projectId: string, req: Request): Promise<Response> {
  try {
    const body = await req.json()

    const parseResult = UpdateProjectInputSchema.safeParse(body)
    if (!parseResult.success) {
      return new Response(JSON.stringify({
        error: 'Validation failed',
        details: parseResult.error.issues
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    const project = projectManager.updateProject(projectId, parseResult.data)

    if (!project) {
      return new Response(JSON.stringify({ error: 'Project not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    // Broadcast to WebSocket clients
    const message = JSON.stringify({ type: 'project_updated', project })
    wsClients.forEach(client => {
      try { client.send(message) } catch { wsClients.delete(client) }
    })

    return new Response(JSON.stringify(project), {
      headers: { 'Content-Type': 'application/json' }
    })
  } catch (error) {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    })
  }
}

// ============================================
// SPEC DISPATCH-UPGRADE + TEMPLATES
// ============================================

const TEMPLATES_DIR = join(process.env.HOME || homedir(), '.claude/regoc/templates')

// Hardcoded fallback ako spec-upgrade.md fizički nestane (dispatch mora preživjeti).
const FALLBACK_SPEC_TEMPLATE = '[[AGENT:$agent]]\nNadogradi projekt $projekt po specifikaciji:\n\n$spec'

/**
 * Skup poznatih agent id-eva iz REGOC_AGENTS.json (autoritet — uključuje emard,
 * za razliku od MessageQueue.VALID_AGENTS). Učitava se svjež na svaki dispatch
 * (registry je malen, izbjegava stale cache nakon dodavanja agenta).
 */
function loadKnownAgentIds(): Set<string> {
  try {
    const regPath = join(process.env.HOME || homedir(), '.claude/regoc/REGOC_AGENTS.json')
    const reg = JSON.parse(readFileSync(regPath, 'utf-8'))
    return new Set(Object.keys(reg.agents || {}))
  } catch {
    return new Set()
  }
}

/** Renderira template zamjenom $agent/$projekt/$spec (split+join — bez regex escape briga). */
function renderSpecTemplate(tpl: string, agent: string, projekt: string, spec: string): string {
  return tpl
    .split('$agent').join(agent)
    .split('$projekt').join(projekt)
    .split('$spec').join(spec)
}

/**
 * POST /api/projects/:id/dispatch-upgrade
 * Body: { agent: string, template?: string }
 * Redoslijed (ADR-2): task → history → message. Task je source-of-truth statusa;
 * poruka je trigger. sendMessage fail → NE rollback (vrati warning, task ostaje vidljiv).
 */
async function handleDispatchUpgrade(projectId: string, req: Request): Promise<Response> {
  const json = (data: any, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
  try {
    const body = await req.json().catch(() => ({})) as { agent?: string; template?: string }

    // 1) projekt + spec
    const project = projectManager.getProject(projectId)
    if (!project) return json({ error: 'Project not found' }, 404)
    const spec = ((project as any).specification || '').trim()

    // 2) guard: prazna spec (R1) — prazni loop nema smisla
    if (!spec) return json({ error: 'Specifikacija je prazna', code: 'empty_spec' }, 422)

    // 3) validacija agenta protiv REGOC_AGENTS.json (autoritet, ne VALID_AGENTS — R9)
    const agent = (body.agent || '').toLowerCase().trim()
    if (!agent) return json({ error: 'Nedostaje agent', code: 'missing_agent' }, 400)
    if (!loadKnownAgentIds().has(agent)) {
      return json({ error: `Nepoznat agent: ${agent}`, code: 'unknown_agent' }, 400)
    }

    // 4) kreiraj task IZRAVNO (zaobiđi HTTP anti-echo guard) → odmah in_progress (pravilo #12).
    //    Spec NE ide u description (drži task lagan + izbjegava guard) — samo naslov+referenca.
    const task = taskManager.createTask({
      title: `Nadogradnja po specifikacijama: ${project.name}`,
      description: `Dispatch-upgrade za projekt ${project.id} (${project.name}). Specifikacija je u poruci agentu ${agent}.`,
      priority: 2,
      assignee: agent,
      tags: ['spec-upgrade'],
      projectId: project.id,
      createdBy: 'webui',
    } as any)
    const taskId = task.id
    // pending → in_progress (dva koraka; API ne dozvoljava pending→completed izravno)
    taskManager.updateTask(taskId, { status: 'in_progress' } as any)

    // 5) snapshot spec u history
    projectManager.addSpecHistory(project.id, spec, agent, taskId)

    // 6) render template (param template > spec-upgrade.md > hardcoded fallback)
    let tpl = FALLBACK_SPEC_TEMPLATE
    if (body.template && body.template.trim()) {
      tpl = body.template
    } else {
      const tplPath = join(TEMPLATES_DIR, 'spec-upgrade.md')
      if (existsSync(tplPath)) tpl = readFileSync(tplPath, 'utf-8')
    }
    const rendered = renderSpecTemplate(tpl, agent, project.name, spec)
    // SECURITY (Malik M1): template i spec su user-controlled. Ukloni BILO KAKAV vodeći
    // [[AGENT:..]] (iz templatea ili spec teksta) pa nametni VALIDIRANI agent kao prvi redak —
    // inače user može preusmjeriti dispatch na drugog agenta preko prvog retka.
    const stripped = rendered.replace(/^\s*\[\[AGENT:[^\]]*\]\]\s*\n?/i, '')
    const content = `[[AGENT:${agent}]]\n${stripped}`

    // 7) pošalji poruku u REGOČ queue
    const messageId = messageQueue.sendMessage('user', 'regoc', content, {
      messageType: 'text',
      priority: 2,
      metadata: { source: 'spec-upgrade', forceAgent: agent, taskId, projectId: project.id }
    })

    if (!messageId) {
      // sendMessage fail → NE rollback; task ostaje in_progress i vidljiv (ADR-2)
      return json({ taskId, messageId: null, warning: 'Task kreiran, ali dispatch poruka nije poslana — pokušaj ponovno.' }, 200)
    }

    return json({ taskId, messageId, agent, projectId: project.id })
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 500)
  }
}

/**
 * GET/PUT /api/templates/:name — editabilni .md template (uzor: workflow editor).
 * Path-traversal guard identičan workflow ruti: `^[A-Za-z0-9_-]+$` (zabranjuje '.', pa i '..').
 */
async function handleTemplate(name: string, req: Request): Promise<Response> {
  const json = (data: any, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    return json({ error: 'Invalid template name' }, 400)
  }
  const tplPath = join(TEMPLATES_DIR, name + '.md')

  if (req.method === 'GET') {
    if (!existsSync(tplPath)) return json({ error: 'Template not found' }, 404)
    return json({ name, path: tplPath, content: readFileSync(tplPath, 'utf-8') })
  }

  // PUT
  try {
    const body = await req.json() as { content?: string }
    if (typeof body.content !== 'string' || !body.content) throw new Error('Missing content')
    mkdirSync(TEMPLATES_DIR, { recursive: true })  // seedan migracijom, ali siguran za svaki slučaj
    writeFileSync(tplPath, body.content)
    return json({ status: 'saved', path: tplPath })
  } catch (err) {
    return json({ error: String(err) }, 400)
  }
}

function handleDeleteProject(projectId: string): Response {
  const success = projectManager.deleteProject(projectId)

  if (!success) {
    return new Response(JSON.stringify({ error: 'Project not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  // Broadcast to WebSocket clients
  const message = JSON.stringify({ type: 'project_deleted', projectId })
  wsClients.forEach(client => {
    try { client.send(message) } catch { wsClients.delete(client) }
  })

  return new Response(JSON.stringify({ success: true }), {
    headers: { 'Content-Type': 'application/json' }
  })
}

async function handleAddProjectAgent(projectId: string, req: Request): Promise<Response> {
  try {
    const body = await req.json()

    const parseResult = AddAgentInputSchema.safeParse(body)
    if (!parseResult.success) {
      return new Response(JSON.stringify({
        error: 'Validation failed',
        details: parseResult.error.issues
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    const agent = projectManager.addAgent(projectId, parseResult.data)

    if (!agent) {
      return new Response(JSON.stringify({ error: 'Project not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    return new Response(JSON.stringify(agent), {
      status: 201,
      headers: { 'Content-Type': 'application/json' }
    })
  } catch (error) {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    })
  }
}

function handleRemoveProjectAgent(projectId: string, agentId: string): Response {
  const success = projectManager.removeAgent(projectId, agentId)

  if (!success) {
    return new Response(JSON.stringify({ error: 'Agent not found on project' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  return new Response(JSON.stringify({ success: true }), {
    headers: { 'Content-Type': 'application/json' }
  })
}

async function handleLinkProjectRAG(projectId: string, req: Request): Promise<Response> {
  try {
    const body = await req.json()

    const parseResult = LinkRAGInputSchema.safeParse(body)
    if (!parseResult.success) {
      return new Response(JSON.stringify({
        error: 'Validation failed',
        details: parseResult.error.issues
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    const link = projectManager.linkRAG(projectId, parseResult.data)

    if (!link) {
      return new Response(JSON.stringify({ error: 'Project not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    return new Response(JSON.stringify(link), {
      status: 201,
      headers: { 'Content-Type': 'application/json' }
    })
  } catch (error) {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    })
  }
}

function handleUnlinkProjectRAG(projectId: string, collection: string, docId: string): Response {
  const success = projectManager.unlinkRAG(projectId, collection, docId)

  if (!success) {
    return new Response(JSON.stringify({ error: 'RAG link not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  return new Response(JSON.stringify({ success: true }), {
    headers: { 'Content-Type': 'application/json' }
  })
}

// ============================================
// RAG API HANDLERS
// ============================================

async function handleGetRAGCollections(): Promise<Response> {
  try {
    const collections = await ragService.listCollections()
    return new Response(JSON.stringify(collections), {
      headers: { 'Content-Type': 'application/json' }
    })
  } catch (error) {
    return new Response(JSON.stringify({
      error: 'Failed to fetch collections',
      details: error instanceof Error ? error.message : String(error)
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    })
  }
}

/**
 * GET /api/rag/projects — broj RAG dokumenata po projektu (R4, TASK-4311).
 *
 * Popis projekata dolazi s ploče da bi projekt BEZ ijednog dokumenta dobio
 * izričitu 0: PRJ-041 je imao 1613 USD troška i nijedan zapis, a to se dotad
 * nigdje nije vidjelo jer ga Chroma jednostavno nije spominjala.
 */
async function handleGetRAGProjectCounts(url: URL): Promise<Response> {
  try {
    let projectIds: string[] = []
    try {
      projectIds = projectManager.getProjects({}).map((p: any) => String(p.id))
    } catch (error) {
      console.error('[RAG] popis projekata s ploče nije dostupan:', error)
    }

    const result = await ragService.getProjectDocCounts({
      projectIds,
      refresh: url.searchParams.get('refresh') === '1'
    })

    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' }
    })
  } catch (error) {
    return new Response(JSON.stringify({
      error: 'Failed to count project documents',
      details: error instanceof Error ? error.message : String(error)
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    })
  }
}

async function handleGetRAGEntries(url: URL): Promise<Response> {
  try {
    const rawFilter: Record<string, unknown> = {}

    const collection = url.searchParams.get('collection')
    const type = url.searchParams.get('type')
    const agent = url.searchParams.get('agent')
    const projectId = url.searchParams.get('projectId')
    const dateFrom = url.searchParams.get('dateFrom')
    const dateTo = url.searchParams.get('dateTo')
    const search = url.searchParams.get('search')
    const limit = url.searchParams.get('limit')
    const offset = url.searchParams.get('offset')

    if (collection) rawFilter.collection = collection
    if (type) rawFilter.type = type
    if (agent) rawFilter.agent = agent
    if (projectId) rawFilter.projectId = projectId
    const tip = url.searchParams.get('tip')
    if (tip) rawFilter.tip = tip
    if (dateFrom) rawFilter.dateFrom = dateFrom
    if (dateTo) rawFilter.dateTo = dateTo
    if (search) rawFilter.search = search
    if (limit) rawFilter.limit = parseInt(limit)
    if (offset) rawFilter.offset = parseInt(offset)

    const parseResult = RAGFilterSchema.safeParse(rawFilter)
    if (!parseResult.success) {
      return new Response(JSON.stringify({
        error: 'Validation failed',
        details: parseResult.error.issues
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    const result = await ragService.getEntries(parseResult.data)
    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' }
    })
  } catch (error) {
    return new Response(JSON.stringify({
      error: 'Failed to fetch entries',
      details: error instanceof Error ? error.message : String(error)
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    })
  }
}

async function handleGetRAGEntry(collection: string, id: string): Promise<Response> {
  try {
    const entry = await ragService.getEntry(collection, id)

    if (!entry) {
      return new Response(JSON.stringify({ error: 'Entry not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    return new Response(JSON.stringify(entry), {
      headers: { 'Content-Type': 'application/json' }
    })
  } catch (error) {
    return new Response(JSON.stringify({
      error: 'Failed to fetch entry',
      details: error instanceof Error ? error.message : String(error)
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    })
  }
}

async function handleDeleteRAGEntries(req: Request): Promise<Response> {
  try {
    const body = await req.json()

    const parseResult = RAGDeleteRequestSchema.safeParse(body)
    if (!parseResult.success) {
      return new Response(JSON.stringify({
        error: 'Validation failed',
        details: parseResult.error.issues
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    const result = await ragService.deleteEntries(parseResult.data)
    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' }
    })
  } catch (error) {
    return new Response(JSON.stringify({
      error: 'Failed to delete entries',
      details: error instanceof Error ? error.message : String(error)
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    })
  }
}

async function handleRAGHealth(): Promise<Response> {
  try {
    // ADR-0001 O1.2: bez adresa RAG jednostavno NIJE podešen. Prije bi se ovdje pokušao
    // mrežni poziv na zadanu adresu i korisnik bi dobio istek veze umjesto rečenice
    // „nisi to postavio" — a to je razlika između kvara i zatečenog stanja.
    if (!ragPodesen()) {
      return new Response(JSON.stringify({
        status: 'nije podešeno',
        healthy: false,
        detalj: 'postavi TM_CHROMA_HOST i TM_OLLAMA_URL (v. env.example); bez njih RAG je isključen',
      }), { headers: { 'Content-Type': 'application/json' } })
    }
    const health = await ragService.healthCheck()
    return new Response(JSON.stringify(health), {
      headers: { 'Content-Type': 'application/json' }
    })
  } catch (error) {
    return new Response(JSON.stringify({
      error: 'Health check failed',
      details: error instanceof Error ? error.message : String(error)
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    })
  }
}

// ============================================
// KONZOLA HANDLERS
// ============================================

async function handleKonzolaStatus(): Promise<Response> {
  // Ne čitamo status datoteku doslovno: mrtav daemon ostavlja zamrznut zapis koji je
  // traka satima prikazivala kao trenutno stanje (TASK-2991).
  const daemonData = await buildDaemonBlock()

  let services: any = {}
  try {
    const health = await getCachedHealthCheck()
    services = health?.services || {}
  } catch {}

  return new Response(JSON.stringify({
    daemon: daemonData,
    services,
    mode: konzolaMode,
    wsClients: wsClients.size,
    timestamp: new Date().toISOString()
  }), { headers: { 'Content-Type': 'application/json' } })
}

async function handleKonzolaExec(req: Request): Promise<Response> {
  try {
    const body = await req.json()
    const rawCommand = body.command?.trim()

    if (!rawCommand) {
      return new Response(JSON.stringify({ error: 'No command provided' }), {
        status: 400, headers: { 'Content-Type': 'application/json' }
      })
    }

    // Check blocked patterns
    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(rawCommand)) {
        return new Response(JSON.stringify({ error: `Command blocked by security policy` }), {
          status: 403, headers: { 'Content-Type': 'application/json' }
        })
      }
    }

    // Check command aliases
    const alias = COMMAND_ALIASES[rawCommand]
    if (alias) {
      return executeKonzolaCommand(alias)
    }

    // Parse command
    const parts = rawCommand.split(/\s+/)
    const executable = parts[0]
    const args = parts.slice(1)

    // Validate allowlist
    if (!ALLOWED_COMMANDS.has(executable) && !rawCommand.startsWith('regoc-services')) {
      return new Response(JSON.stringify({ error: `Command not allowed: "${executable}". Type 'help' for allowed commands.` }), {
        status: 403, headers: { 'Content-Type': 'application/json' }
      })
    }

    // Plan mode: block mutating commands
    if (konzolaMode === 'plan' && WORK_MODE_COMMANDS.has(executable)) {
      return new Response(JSON.stringify({ error: `Command "${executable}" requires WORK mode. Switch with: mode work` }), {
        status: 403, headers: { 'Content-Type': 'application/json' }
      })
    }

    // Git: only read-only in plan mode
    if (executable === 'git' && konzolaMode === 'plan') {
      const gitSubCmd = args[0]
      const readOnlyGitCmds = ['status', 'log', 'diff', 'show', 'branch', 'remote', 'tag']
      if (gitSubCmd && !readOnlyGitCmds.includes(gitSubCmd)) {
        return new Response(JSON.stringify({ error: `Git "${gitSubCmd}" requires WORK mode.` }), {
          status: 403, headers: { 'Content-Type': 'application/json' }
        })
      }
    }

    return executeKonzolaCommand([executable, ...args])
  } catch (error) {
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    })
  }
}

async function executeKonzolaCommand(cmdArgs: string[]): Promise<Response> {
  try {
    const proc = Bun.spawn(cmdArgs, {
      cwd: process.env.TM_SERVICES_DIR || process.cwd(),
      stdout: 'pipe', stderr: 'pipe',
      env: { HOME: process.env.HOME || homedir(), PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', USER: process.env.USER || 'klaudio', LANG: 'en_US.UTF-8' }
    })

    const timeout = setTimeout(() => { try { proc.kill() } catch {} }, 30000)
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    const exitCode = await proc.exited
    clearTimeout(timeout)

    return new Response(JSON.stringify({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode }), {
      headers: { 'Content-Type': 'application/json' }
    })
  } catch (error) {
    return new Response(JSON.stringify({ error: `Execution failed: ${error instanceof Error ? error.message : String(error)}` }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    })
  }
}

async function handleKonzolaMode(req: Request): Promise<Response> {
  try {
    const body = await req.json()
    const newMode = body.mode
    if (newMode !== 'plan' && newMode !== 'work') {
      return new Response(JSON.stringify({ error: 'Invalid mode. Use "plan" or "work".' }), {
        status: 400, headers: { 'Content-Type': 'application/json' }
      })
    }
    konzolaMode = newMode
    const message = JSON.stringify({ type: 'console_mode_changed', mode: konzolaMode })
    wsClients.forEach(client => { try { client.send(message) } catch { wsClients.delete(client) } })
    return new Response(JSON.stringify({ mode: konzolaMode }), { headers: { 'Content-Type': 'application/json' } })
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid request body' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    })
  }
}

async function handleKonzolaLogs(url: URL): Promise<Response> {
  const source = url.searchParams.get('source') || 'daemon'
  const lines = parseInt(url.searchParams.get('lines') || '50')
  let logFile: string
  switch (source) {
    case 'voiceserver': logFile = join(process.env.HOME || homedir(), '.tmp/regoc_logs/voiceserver.log'); break
    case 'taskwebui': logFile = join(process.env.HOME || homedir(), '.tmp/regoc_logs/taskwebui.log'); break
    case 'klaudio': logFile = join(process.env.HOME || homedir(), '.tmp/regoc_logs/klaudio.log'); break
    default: logFile = DAEMON_LOG_FILE
  }
  try {
    const proc = Bun.spawn(['tail', '-n', String(Math.min(lines, 200)), logFile], { stdout: 'pipe', stderr: 'pipe' })
    const output = await new Response(proc.stdout).text()
    return new Response(JSON.stringify({ source, lines: output.trim().split('\n'), timestamp: new Date().toISOString() }), {
      headers: { 'Content-Type': 'application/json' }
    })
  } catch {
    return new Response(JSON.stringify({ error: 'Failed to read log' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    })
  }
}

// ============================================
// KONZOLA MESSAGE HANDLER (Natural Language → REGOČ Queue)
// ============================================

async function handleKonzolaMessage(req: Request): Promise<Response> {
  try {
    const body = await req.json()
    const text = body.message?.trim()

    if (!text) {
      return new Response(JSON.stringify({ error: 'No message provided' }), {
        status: 400, headers: { 'Content-Type': 'application/json' }
      })
    }

    // Send message to REGOČ via message queue
    const msgId = messageQueue.sendMessage('user', 'regoc', text, {
      messageType: 'text',
      priority: 3,
      metadata: { source: 'konzola', timestamp: new Date().toISOString() }
    })

    if (!msgId) {
      return new Response(JSON.stringify({ error: 'Failed to queue message' }), {
        status: 500, headers: { 'Content-Type': 'application/json' }
      })
    }

    // Broadcast to WS clients
    const wsMsg = JSON.stringify({
      type: 'console_output',
      text: `📨 Poruka poslana REGOČ-u (${msgId.substring(0, 8)}): "${text.substring(0, 80)}${text.length > 80 ? '...' : ''}"`,
      level: 'log-info',
      source: 'konzola'
    })
    wsClients.forEach(client => { try { client.send(wsMsg) } catch { wsClients.delete(client) } })

    return new Response(JSON.stringify({
      success: true,
      messageId: msgId,
      to: 'regoc',
      queued: true
    }), { headers: { 'Content-Type': 'application/json' } })
  } catch (error) {
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    })
  }
}

// ============================================
// KONZOLA LOG STREAMER (VERBOSE)
// ============================================

// Track file positions per source
const logSources: Record<string, { file: string, position: number }> = {
  daemon: { file: DAEMON_LOG_FILE, position: 0 },
  klaudio: { file: join(process.env.HOME || homedir(), '.tmp/regoc_logs/klaudio.log'), position: 0 },
  // TASK-3095: rad GLAVNE REGOC sesije (Claude Code) — dosad se u konzoli nije vidjelo
  // NISTA od onoga sto REGOC radi izmedju dvije poruke, jer on ne prolazi kroz daemon.
  // Puni ga hooks/RegocConsoleLog.hook.ts (PostToolUse).
  regoc: { file: join(process.env.HOME || homedir(), '.tmp/regoc_logs/regoc.log'), position: 0 },
  voiceserver: { file: join(process.env.HOME || homedir(), '.tmp/regoc_logs/voiceserver.log'), position: 0 },
}

// Dedup: track last N messages to suppress scheduler spam
let lastLogLines: string[] = []
const DEDUP_WINDOW = 10

// Message queue tracking — last seen message timestamp
let lastSeenMsgTimestamp = new Date().toISOString()
let lastSeenEventId = 0

function isDuplicateLogLine(line: string): boolean {
  const content = line.replace(/^\[[\dT:.Z-]+\]\s*/, '')
  if (lastLogLines.includes(content)) return true
  lastLogLines.push(content)
  if (lastLogLines.length > DEDUP_WINDOW) lastLogLines.shift()
  return false
}

function detectLogLevel(line: string): string {
  if (line.includes('ERROR') || line.includes('FAILED') || line.includes('❌')) return 'log-error'
  if (line.includes('WARN') || line.includes('⚠️')) return 'log-warn'
  if (line.includes('✅') || line.includes('[OK]') || line.includes('success')) return 'log-success'
  if (line.includes('📨') || line.includes('Processing') || line.includes('AI inference')) return 'log-info'
  if (line.includes('[WATCHDOG]') || line.includes('[Context')) return 'log-info'
  if (line.includes('CLAUDE CODE') || line.includes('Received') || line.includes('Response sent')) return 'log-info'
  if (line.includes('HEARTBEAT')) return 'log-system'
  if (line.includes('Queued') || line.includes('completed task')) return 'log-system'
  return ''
}

function broadcastKonzola(text: string, level: string, source: string) {
  const msg = JSON.stringify({ type: 'console_output', text, level, source })
  wsClients.forEach(client => { try { client.send(msg) } catch { wsClients.delete(client) } })
}

// --- Stream 1: Log file tailing ---
function streamLogFiles() {
  const { existsSync, statSync, openSync, readSync, closeSync } = require('fs')

  for (const [name, src] of Object.entries(logSources)) {
    try {
      if (!existsSync(src.file)) continue
      const stat = statSync(src.file)
      if (stat.size <= src.position) {
        if (stat.size < src.position) src.position = 0
        continue
      }
      const readSize = Math.min(stat.size - src.position, 65536)
      const fd = openSync(src.file, 'r')
      const buf = Buffer.alloc(readSize)
      readSync(fd, buf, 0, readSize, src.position)
      closeSync(fd)
      src.position = src.position + readSize
      const newContent = buf.toString('utf-8')
      if (!newContent.trim()) continue

      const lines = newContent.trim().split('\n')
      for (const line of lines) {
        if (!line.trim()) continue
        if (isDuplicateLogLine(line)) continue
        const level = detectLogLevel(line)
        const prefix = name !== 'daemon' ? `[${name}] ` : ''
        broadcastKonzola(prefix + line, level, name)
      }
    } catch {}
  }
}

// --- Stream 2: Message Queue activity ---
function streamMessageQueue() {
  try {
    const db = konzolaDb
    if (!db) return

    // Get new messages since last check
    // TASK-3516: ASC je ovdje NAMJERAN i mora ostati — konzola je živi dnevnik
    // koji se dopisuje na dno (appendToKonzolaLog), a `lastSeenMsgTimestamp` je
    // pomični kursor. Silazni poredak bi ispreturao redoslijed događaja.
    const newMsgs = db.prepare(`
      SELECT id, from_agent, to_agent, substr(content, 1, 120) as content,
             message_type, priority, status, created_at, processed_at,
             substr(response, 1, 120) as response
      FROM messages
      WHERE created_at > ? OR (processed_at IS NOT NULL AND processed_at > ?)
      ORDER BY created_at ASC
      LIMIT 20
    `).all(lastSeenMsgTimestamp, lastSeenMsgTimestamp) as any[]

    for (const m of newMsgs) {
      if (m.status === 'pending' || m.status === 'processing') {
        broadcastKonzola(
          `📨 [MQ] ${m.from_agent} → ${m.to_agent}: "${m.content}"${m.priority <= 2 ? ' ⚡P' + m.priority : ''}`,
          'log-info', 'mq'
        )
      }
      if (m.status === 'completed' && m.response) {
        broadcastKonzola(
          `✅ [MQ] ${m.to_agent} → ${m.from_agent}: "${m.response}"`,
          'log-success', 'mq'
        )
      }
      if (m.status === 'failed') {
        broadcastKonzola(
          `❌ [MQ] FAILED ${m.from_agent} → ${m.to_agent}: "${m.content}"`,
          'log-error', 'mq'
        )
      }
    }

    lastSeenMsgTimestamp = new Date().toISOString()
  } catch {}
}

// --- Stream 3: Event Log (audit trail) ---
function streamEventLog() {
  try {
    const db = konzolaDb
    if (!db) return

    // Check if event_log table exists
    const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='event_log'").get()
    if (!tableExists) return

    // TASK-3516: isto kao gore — dnevnik događaja se čita uzlazno preko kursora
    // `lastSeenEventId` i dopisuje na dno konzole. ASC ostaje.
    const events = db.prepare(`
      SELECT id, event_type, agent_id, substr(details, 1, 150) as details, created_at
      FROM event_log
      WHERE id > ?
      ORDER BY id ASC
      LIMIT 20
    `).all(lastSeenEventId) as any[]

    for (const ev of events) {
      lastSeenEventId = ev.id
      const icon = ev.event_type.includes('completed') ? '✅' :
                   ev.event_type.includes('failed') ? '❌' :
                   ev.event_type.includes('processing') ? '⚙️' :
                   ev.event_type.includes('claimed') ? '🔄' :
                   ev.event_type.includes('progress') ? '📊' :
                   ev.event_type.includes('project') ? '📁' : '📋'
      const level = ev.event_type.includes('failed') ? 'log-error' :
                    ev.event_type.includes('completed') ? 'log-success' : 'log-info'
      broadcastKonzola(
        `${icon} [EVENT] ${ev.event_type} | ${ev.agent_id || '--'} | ${ev.details || ''}`,
        level, 'event'
      )
    }
  } catch {}
}

// --- Stream 4: Observability proxy (agent tool use from port 4000) ---
let obsWs: any = null
let obsReconnectTimer: any = null

function connectObservabilityStream() {
  try {
    obsWs = new WebSocket('ws://localhost:4000/stream')

    obsWs.onmessage = (event: any) => {
      try {
        const data = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString())
        if (data.type === 'event') {
          formatObsEvent(data.data)
        } else if (data.type === 'initial' && Array.isArray(data.data)) {
          // Skip initial batch to avoid flooding — only show last 3
          data.data.slice(-3).forEach((ev: any) => formatObsEvent(ev))
        }
      } catch {}
    }

    obsWs.onclose = () => {
      obsWs = null
      // Reconnect after 10 seconds
      if (!obsReconnectTimer) {
        obsReconnectTimer = setTimeout(() => { obsReconnectTimer = null; connectObservabilityStream() }, 10000)
      }
    }

    obsWs.onerror = () => { try { obsWs?.close() } catch {} }
  } catch {
    // Observability server not available — silent fail
  }
}

function formatObsEvent(ev: any) {
  if (!ev || !ev.hook_event_type) return
  const agent = ev.agent_name || ev.source_app || '??'
  const type = ev.hook_event_type

  if (type === 'PreToolUse' && ev.payload?.tool_name) {
    const tool = ev.payload.tool_name
    const input = ev.payload.tool_input
    let detail = ''
    if (tool === 'Read' && input?.file_path) detail = ` → ${input.file_path}`
    else if (tool === 'Edit' && input?.file_path) detail = ` → ${input.file_path}`
    else if (tool === 'Write' && input?.file_path) detail = ` → ${input.file_path}`
    else if (tool === 'Bash' && input?.command) detail = ` → ${String(input.command).substring(0, 60)}`
    else if (tool === 'Grep' && input?.pattern) detail = ` → "${input.pattern}"`
    else if (tool === 'Glob' && input?.pattern) detail = ` → ${input.pattern}`
    else if (tool === 'Task') detail = ` → ${input?.description || ''}`
    broadcastKonzola(`🔧 [${agent}] ${tool}${detail}`, 'log-info', 'obs')
  }
  else if (type === 'UserPromptSubmit') {
    const prompt = ev.payload?.prompt || ev.summary || ''
    if (prompt) broadcastKonzola(`💬 [${agent}] Prompt: "${String(prompt).substring(0, 80)}"`, 'log-cmd', 'obs')
  }
  else if (type === 'Stop') {
    const summary = ev.summary || ''
    if (summary) broadcastKonzola(`🏁 [${agent}] Done: ${String(summary).substring(0, 80)}`, 'log-success', 'obs')
  }
}

// --- Stream 5: Session JSONL watcher (agent reasoning/thinking) ---
const CLAUDE_PROJECTS_DIR = join(process.env.HOME || homedir(), '.claude/projects')
const sessionFilePositions: Record<string, number> = {}
let activeSessionFiles: string[] = []
let lastSessionScan = 0
const SESSION_SCAN_INTERVAL = 5000 // 5s — catch short-lived subagents quickly

function scanActiveSessions() {
  const now = Date.now()
  if (now - lastSessionScan < SESSION_SCAN_INTERVAL && activeSessionFiles.length > 0) return
  lastSessionScan = now

  const { readdirSync, statSync, existsSync } = require('fs')
  const results: { path: string; mtime: number }[] = []

  try {
    const projectDirs = readdirSync(CLAUDE_PROJECTS_DIR)
    for (const dir of projectDirs) {
      const projectPath = join(CLAUDE_PROJECTS_DIR, dir)
      try {
        if (!statSync(projectPath).isDirectory()) continue
        const files = readdirSync(projectPath)

        // Main session files — only from non-regoc-system projects (skip our own huge session)
        const isRegocProject = dir.includes('regoc-system')
        for (const file of files) {
          if (!file.endsWith('.jsonl')) continue
          const filePath = join(projectPath, file)
          try {
            const fstat = statSync(filePath)
            // Skip our own main session (>500KB) in regoc-system project
            if (isRegocProject && fstat.size > 512000) continue
            if (now - fstat.mtimeMs < 300000) {
              results.push({ path: filePath, mtime: fstat.mtimeMs })
            }
          } catch {}
        }

        // Subagent directories — ALWAYS watch these (they are spawned agents)
        for (const file of files) {
          if (file.endsWith('.jsonl')) continue // Skip files, only process directories
          if (!file.includes('-')) continue // Session dirs have UUIDs with dashes
          const subagentsDir = join(projectPath, file, 'subagents')
          try {
            if (!existsSync(subagentsDir) || !statSync(subagentsDir).isDirectory()) continue
            const subFiles = readdirSync(subagentsDir)
            for (const sf of subFiles) {
              if (!sf.endsWith('.jsonl')) continue
              const sfPath = join(subagentsDir, sf)
              try {
                const sfStat = statSync(sfPath)
                if (now - sfStat.mtimeMs < 300000) {
                  results.push({ path: sfPath, mtime: sfStat.mtimeMs })
                }
              } catch {}
            }
          } catch {}
        }
      } catch {}
    }
  } catch {}

  results.sort((a, b) => b.mtime - a.mtime)
  activeSessionFiles = results.slice(0, 15).map(r => r.path)

  // Initialize positions for new files
  // Small files (<100KB, likely subagent sessions): read from beginning to catch all reasoning
  // Large files: start from end (only show new live content)
  for (const f of activeSessionFiles) {
    if (!(f in sessionFilePositions)) {
      try {
        const fsize = require('fs').statSync(f).size
        sessionFilePositions[f] = fsize < 102400 ? 0 : fsize
      } catch { sessionFilePositions[f] = 0 }
    }
  }

  // Cleanup stale entries
  for (const key of Object.keys(sessionFilePositions)) {
    if (!activeSessionFiles.includes(key)) delete sessionFilePositions[key]
  }
}

function streamSessionJSONL() {
  scanActiveSessions()
  if (activeSessionFiles.length === 0) return

  const { existsSync, statSync, openSync, readSync, closeSync } = require('fs')

  for (const filePath of activeSessionFiles) {
    try {
      if (!existsSync(filePath)) continue
      const stat = statSync(filePath)
      const pos = sessionFilePositions[filePath] || 0

      if (stat.size <= pos) {
        if (stat.size < pos) sessionFilePositions[filePath] = 0
        continue
      }

      const readSize = Math.min(stat.size - pos, 131072) // Max 128KB per tick
      const fd = openSync(filePath, 'r')
      const buf = Buffer.alloc(readSize)
      readSync(fd, buf, 0, readSize, pos)
      closeSync(fd)
      sessionFilePositions[filePath] = pos + readSize

      const content = buf.toString('utf-8')
      const lines = content.split('\n')

      for (const line of lines) {
        if (!line.trim() || line.length < 20) continue
        try {
          const entry = JSON.parse(line)
          formatSessionEntry(entry, filePath)
        } catch {} // Partial writes — skip
      }
    } catch {}
  }
}

function formatSessionEntry(entry: any, filePath: string) {
  if (!entry?.type) return

  // Determine source label from file path
  const source = filePath.includes('subagents/') ? 'agent' :
                 filePath.includes('-app-klaudio') ? 'klaudio' :
                 filePath.includes('-home-klaudio/') ? 'daemon' : 'session'

  if (entry.type === 'assistant' && entry.message?.content && Array.isArray(entry.message.content)) {
    const model = entry.message.model || ''
    const ms = model.includes('opus') ? 'opus' :
               model.includes('sonnet') ? 'sonnet' :
               model.includes('haiku') ? 'haiku' : model.split('-').pop()?.substring(0, 8) || '??'

    for (const block of entry.message.content) {
      if (block.type === 'thinking' && block.thinking) {
        const thought = String(block.thinking).replace(/\s+/g, ' ').trim().substring(0, 250)
        broadcastKonzola(
          `🧠 [${ms}] ${thought}${block.thinking.length > 250 ? '...' : ''}`,
          'log-thinking', source
        )
      }
      else if (block.type === 'tool_use' && block.name) {
        const tool = block.name
        const input = block.input || {}
        let detail = ''
        if (tool === 'Read' && input.file_path) detail = ` → ${input.file_path}`
        else if (tool === 'Edit' && input.file_path) detail = ` → ${input.file_path}`
        else if (tool === 'Write' && input.file_path) detail = ` → ${input.file_path}`
        else if (tool === 'Bash' && input.command) detail = ` → ${String(input.command).substring(0, 80)}`
        else if (tool === 'Grep' && input.pattern) detail = ` → "${input.pattern}"`
        else if (tool === 'Glob' && input.pattern) detail = ` → ${input.pattern}`
        else if (tool === 'Task') detail = ` → ${input.description || ''} [${input.subagent_type || ''}]`
        else if (tool === 'TodoWrite') detail = ' → update tasks'
        else if (tool === 'WebSearch' && input.query) detail = ` → "${input.query}"`
        else if (tool === 'WebFetch' && input.url) detail = ` → ${input.url}`
        broadcastKonzola(`🔧 [${ms}] ${tool}${detail}`, 'log-info', source)
      }
      else if (block.type === 'text' && block.text) {
        const text = String(block.text).replace(/\s+/g, ' ').trim().substring(0, 250)
        if (text.length > 5) { // Skip trivial empty responses
          broadcastKonzola(
            `💭 [${ms}] ${text}${block.text.length > 250 ? '...' : ''}`,
            'log-text', source
          )
        }
      }
    }

    // Show token usage if available (indicates processing completed)
    const usage = entry.message?.usage
    if (usage && (usage.input_tokens || usage.output_tokens)) {
      const inp = usage.input_tokens || 0
      const out = usage.output_tokens || 0
      const cache = usage.cache_read_input_tokens || 0
      broadcastKonzola(
        `📊 [${ms}] tokens: in=${inp} out=${out}${cache ? ' cache=' + cache : ''}`,
        'log-system', source
      )
    }
  }
  else if (entry.type === 'progress' && entry.data) {
    const hookName = entry.data.hookName || entry.data.type || ''
    // Skip noisy SessionStart hooks
    if (hookName && !hookName.includes('SessionStart') && !hookName.includes('compact')) {
      broadcastKonzola(`⚙️ [hook] ${hookName}`, 'log-system', source)
    }
  }
  // 'user' and 'queue-operation' types are skipped (too noisy)
}

// --- Main streamer: all 5 streams ---
function startKonzolaLogStreamer() {
  const { existsSync, statSync } = require('fs')

  // Initialize log file positions from end
  for (const [, src] of Object.entries(logSources)) {
    try { if (existsSync(src.file)) src.position = statSync(src.file).size } catch {}
  }

  // Initialize event log cursor
  try {
    const db = konzolaDb
    if (db) {
      const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='event_log'").get()
      if (tableExists) {
        const last = db.prepare('SELECT MAX(id) as maxid FROM event_log').get() as any
        lastSeenEventId = last?.maxid || 0
      }
    }
  } catch {}

  // Stream 1+2+3: Log files + MQ + Events (every 2 seconds)
  logStreamInterval = setInterval(() => {
    if (wsClients.size === 0) return
    streamLogFiles()
    streamMessageQueue()
    streamEventLog()
    streamSessionJSONL()
  }, 2000)

  // Stream 4: Observability WebSocket (real-time agent tool use)
  connectObservabilityStream()
}

// ============================================
// STATUS DASHBOARD HANDLER
// ============================================

async function handleStatusDashboard(): Promise<Response> {
  // 1. Daemon status — izvedeno stanje (živ PID + starost zapisa), ne goli sadržaj datoteke
  const daemonData = await buildDaemonBlock()

  // 2. Service health (cached)
  let services: any = {}
  try {
    const health = await getCachedHealthCheck()
    services = health?.services || {}
  } catch {}

  // 3. Token usage — K7/TASK-2986.
  // Izvor je `cost_log` koji od sada puni svaki spawn (SpawnTelemetry). Prije je ovdje
  // stajao `~/.claude/stats-cache.json`, zamrznut 23.02. — ploča je pet mjeseci pokazivala
  // mrtve brojke. Stari keš ostaje SAMO kao fallback dok se cost_log ne napuni, i tada je
  // izričito označen kao zastario.
  let tokens: any = { byModel: {}, daily: [], totalSessions: 0, totalMessages: 0, source: 'none', windowDays: TOKEN_WINDOW_DAYS }
  try {
    const ct = getCostTracker()
    const byModel = ct.getUsageByModel(TOKEN_WINDOW_DAYS)
    if (Object.keys(byModel).length > 0) {
      const counts = ct.getSpawnCounts(TOKEN_WINDOW_DAYS)
      tokens = {
        byModel,
        daily: ct.getDailyTokens(TOKEN_WINDOW_DAYS),
        totalSessions: counts.sessions,
        totalMessages: counts.spawns,
        totalTasks: counts.tasks,
        lastAt: counts.lastAt,
        source: 'cost_log',
        windowDays: TOKEN_WINDOW_DAYS,
      }
    } else {
      const statsCache = JSON.parse(await Bun.file(STATS_CACHE_FILE).text())
      tokens = {
        byModel: statsCache.modelUsage || {},
        daily: statsCache.dailyModelTokens || [],
        totalSessions: statsCache.totalSessions || 0,
        totalMessages: statsCache.totalMessages || 0,
        source: 'stats-cache (zastarjelo)',
        lastAt: statsCache.lastComputedDate || null,
        windowDays: null,
      }
    }
  } catch {}

  // 4. Task stats
  let taskStats: any = {}
  try { taskStats = taskManager.getStats() } catch {}

  // 5. Project stats + active projects
  let projectStats: any = {}
  let activeProjects: any[] = []
  try {
    projectStats = projectManager.getStats()
    activeProjects = projectManager.getProjects({ status: 'active' as any })
  } catch {}

  // 6. Scheduler state
  let scheduler: any = {}
  try {
    scheduler = JSON.parse(await Bun.file(SCHEDULER_STATE_FILE).text())
  } catch {}

  // TASK-623: Read system mode
  let modeData: any = { mode: 'WORK', since: null, setBy: 'default' }
  try {
    if (existsSync(SYSTEM_MODE_FILE)) {
      modeData = JSON.parse(readFileSync(SYSTEM_MODE_FILE, 'utf-8'))
    }
  } catch {}

  return new Response(JSON.stringify({
    daemon: daemonData,
    services,
    tokens,
    tasks: taskStats,
    projects: { stats: projectStats, active: activeProjects },
    scheduler,
    mode: modeData,
    wsClients: wsClients.size,
    timestamp: new Date().toISOString()
  }), { headers: { 'Content-Type': 'application/json' } })
}

// ============================================
// AGENT STATUS API HANDLER
// ============================================

function handleGetAgents(): Response {
  const HOME = process.env.HOME || homedir()
  try {
    const regPath = join(HOME, '.claude/regoc/REGOC_AGENTS.json')
    const tierMap: Record<string, string> = { opus: 'frontier', sonnet: 'strong', haiku: 'basic' }
    if (!existsSync(regPath)) {
      return new Response(JSON.stringify({ agents: [], totalAgents: 0, activeCount: 0 }), { headers: { 'Content-Type': 'application/json' } })
    }
    const reg = JSON.parse(readFileSync(regPath, 'utf-8'))
    const agentMap = reg.agents || {}

    // TASK-624: Load persistent config for per-agent status
    let persistConfig: any = { persistentMode: 'off', enabledAgents: [] }
    try {
      if (existsSync(PERSISTENT_CONFIG_FILE)) {
        persistConfig = JSON.parse(readFileSync(PERSISTENT_CONFIG_FILE, 'utf-8'))
      }
    } catch {}

    function getAgentMode(id: string): string {
      if (id === 'klaudio' || id === 'stribor') return 'standalone'
      if (id === 'emard') return 'disabled'
      if (persistConfig.persistentMode === 'off') return 'on-demand'
      if (persistConfig.persistentMode === 'full') return 'persistent'
      if (persistConfig.persistentMode === 'selective') {
        return persistConfig.enabledAgents?.includes(id) ? 'persistent' : 'on-demand'
      }
      return 'on-demand'
    }

    function isAgentAlive(id: string): boolean {
      try {
        const hbFile = join(HOME, `.tmp/agent_heartbeat_${id}.json`)
        if (!existsSync(hbFile)) return false
        const hb = JSON.parse(readFileSync(hbFile, 'utf-8'))
        const age = Date.now() - new Date(hb.ts).getTime()
        return age < 120000 // alive if heartbeat < 2 minutes
      } catch {
        return false
      }
    }

    const agents = Object.entries(agentMap).map(([id, a]: [string, any]) => ({
      id,
      name: a.name || id,
      role: a.role || '',
      model: a.model || 'unknown',
      tier: tierMap[a.model] || 'strong',
      status: isAgentAlive(id) ? 'alive' : 'idle',
      // TASK-3671 (ADR-0004 O4): `tools` je od registra v1.8.0 ravan niz za svih 12 agenata.
      // Stari oblik (`regoc.tools.core_skills`) ostaje pokriven da ploca ne oslijepi na starom registru.
      tools: Array.isArray(a.tools) ? a.tools : (a.tools?.core_skills || []),
      skills: a.skills || [],
      // TASK-624: persistent status
      persistent: getAgentMode(id) === 'persistent',
      alive: isAgentAlive(id),
      mode: getAgentMode(id),
    }))

    return new Response(JSON.stringify({
      agents,
      totalAgents: agents.length,
      activeCount: agents.filter(a => a.alive).length,
      persistentMode: persistConfig.persistentMode,
    }), { headers: { 'Content-Type': 'application/json' } })
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err), agents: [], totalAgents: 0, activeCount: 0 }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
}

// ============================================
// MODULE STATUS API HANDLER
// ============================================

function handleGetModules(): Response {
  const HOME = process.env.HOME || homedir()
  try {
    const modPath = join(HOME, '.claude/regoc/modules/module-config.json')
    if (!existsSync(modPath)) {
      return new Response(JSON.stringify({ modules: [] }), { headers: { 'Content-Type': 'application/json' } })
    }
    const mc = JSON.parse(readFileSync(modPath, 'utf-8'))
    const mods = mc.modules || {}

    const degradationMap: Record<string, string> = {
      'mod-rag': 'Keyword search (ripgrep)',
      'mod-telegram': 'Console notifications',
      'mod-teamspeak': 'No voice chat',
      'mod-voice': 'Text-only notifications',
      'mod-dashboard': 'CLI-only task management',
      'mod-email': 'No email',
      'mod-gitlab': 'No GitLab',
      'mod-github': 'No GitHub',
      'mod-nextcloud': 'No file sharing',
      'mod-security': 'No tool inspection',
      'mod-knowledge': 'No knowledge graph',
    }

    const providesMap: Record<string, string[]> = {
      'core-daemon': ['messaging', 'orchestration'],
      'core-models': ['model-routing', 'multi-provider'],
      'core-taskmanager': ['task-crud', 'task-api'],
      'mod-rag': ['semantic-search', 'embeddings'],
      'mod-telegram': ['telegram-messaging', 'notifications'],
      'mod-teamspeak': ['voice-chat'],
      'mod-voice': ['tts', 'voice-notifications'],
      'mod-dashboard': ['web-dashboard', 'task-api'],
      'mod-email': ['email-send', 'email-receive'],
      'mod-gitlab': ['git-hosting', 'ci-cd'],
      'mod-github': ['git-hosting-public'],
      'mod-nextcloud': ['file-sharing', 'deck-tasks'],
      'mod-security': ['tool-inspection', 'prompt-guard', 'audit-log'],
      'mod-knowledge': ['knowledge-graph', 'wikilinks'],
    }

    const modules = Object.entries(mods).map(([id, m]: [string, any]) => {
      const req = id.startsWith('core-')
      const en = m.enabled !== false
      return {
        id,
        name: id.replace('core-', 'Core: ').replace('mod-', ''),
        enabled: en,
        required: req,
        provides: providesMap[id] || [],
        degradation: degradationMap[id] || '-',
      }
    })
    return new Response(JSON.stringify({ modules }), { headers: { 'Content-Type': 'application/json' } })
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err), modules: [] }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
}

// ============================================
// METRICS API HANDLER
// ============================================

async function handleGetMetrics(): Promise<Response> {
  // Cost data
  let costs: any = { total: 0, byAgent: {}, byDay: [] }
  try {
    const { getCostTracker } = await import('./core/CostTracker')
    const ct = getCostTracker()
    const stats = ct.getStats()
    costs = {
      total: stats.totalCostUsd || 0,
      byAgent: stats.byAgent || {},
      byDay: ct.getCostByDay(7),
    }
  } catch {}

  // Observability data
  let observability: any = { totalEvents: 0, byEvent: {}, last24h: 0 }
  try {
    const { getObservabilityLogger } = await import('./core/ObservabilityLogger')
    const logger = getObservabilityLogger()
    observability = logger.getStats()
  } catch {}

  // Task stats
  let tasks: any = { total: 0, completed: 0, pending: 0, inProgress: 0 }
  try {
    const stats = taskManager.getStats()
    tasks = {
      total: stats.total || 0,
      completed: stats.byStatus?.completed || 0,
      pending: stats.byStatus?.pending || 0,
      inProgress: stats.byStatus?.in_progress || 0,
    }
  } catch {}

  return new Response(JSON.stringify({
    costs,
    observability,
    tasks,
    timestamp: new Date().toISOString(),
  }), { headers: { 'Content-Type': 'application/json' } })
}

// ============================================
// SECURITY DASHBOARD API HANDLER
// ============================================

async function handleGetSecurity(): Promise<Response> {
  // Audit log data
  let auditLog: any = { total: 0, bySeverity: {}, last24h: 0, recent: [] }
  try {
    const { getAuditLogger } = await import('./core/AuditLogger')
    const audit = getAuditLogger()
    const stats = audit.getStats()
    auditLog = {
      total: stats.total || 0,
      bySeverity: stats.bySeverity || {},
      last24h: stats.last24h || 0,
      recent: audit.query({ limit: 10 }),
    }
  } catch {}

  // PromptGuard availability
  let promptGuard = { available: false }
  try {
    const pgPath = join(process.env.HOME || homedir(), '.claude/regoc/security/PromptGuard.ts')
    promptGuard = { available: existsSync(pgPath) }
  } catch {}

  // SecurityPipeline availability
  let securityPipeline: any = { available: false, mode: 'unknown' }
  try {
    const spPath = join(process.env.HOME || homedir(), '.claude/regoc/security/SecurityPipeline.ts')
    securityPipeline = { available: existsSync(spPath), mode: 'localSafe' }
  } catch {}

  return new Response(JSON.stringify({
    auditLog,
    promptGuard,
    securityPipeline,
    timestamp: new Date().toISOString(),
  }), { headers: { 'Content-Type': 'application/json' } })
}

// ============================================
// TASK-623/624: SYSTEM MODE & PERSISTENT AGENTS API HANDLERS
// ============================================

const SYSTEM_MODE_FILE = join(process.env.HOME || homedir(), '.tmp/regoc_mode.json')
const PERSISTENT_CONFIG_FILE = join(process.env.HOME || homedir(), '.tmp/regoc_persistent_config.json')
const AGENTS_REGISTRY_FILE = join(process.env.HOME || homedir(), '.claude/regoc/REGOC_AGENTS.json')

function handleGetSystemMode(): Response {
  try {
    if (existsSync(SYSTEM_MODE_FILE)) {
      const data = JSON.parse(readFileSync(SYSTEM_MODE_FILE, 'utf-8'))
      return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })
    }
    return new Response(JSON.stringify({ mode: 'WORK', since: null, setBy: 'default' }), { headers: { 'Content-Type': 'application/json' } })
  } catch {
    return new Response(JSON.stringify({ mode: 'WORK', since: null, setBy: 'default' }), { headers: { 'Content-Type': 'application/json' } })
  }
}

async function handleSetSystemMode(req: Request): Promise<Response> {
  try {
    const body = await req.json() as { mode?: string, reason?: string }
    const { mode, reason } = body

    if (mode !== 'PLAN' && mode !== 'WORK') {
      return new Response(JSON.stringify({ error: 'mode must be PLAN or WORK' }), {
        status: 400, headers: { 'Content-Type': 'application/json' }
      })
    }

    const data = {
      mode,
      since: new Date().toISOString(),
      setBy: 'api',
      reason: reason || null
    }
    const { writeFileSync: wfs } = require('fs')
    wfs(SYSTEM_MODE_FILE, JSON.stringify(data, null, 2))

    // Broadcast mode change to message queue
    try {
      const mq = getMessageQueue()
      mq.sendMessage('regoc', 'klaudio', `[SYSTEM] Mode changed to ${mode}${reason ? `: ${reason}` : ''}`, {
        messageType: 'broadcast',
        priority: 1
      })
    } catch {}

    return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid request body' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    })
  }
}

function handleGetPersistentConfig(): Response {
  try {
    if (existsSync(PERSISTENT_CONFIG_FILE)) {
      const data = JSON.parse(readFileSync(PERSISTENT_CONFIG_FILE, 'utf-8'))
      return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })
    }
    return new Response(JSON.stringify({ persistentMode: 'off', enabledAgents: [], since: null }), { headers: { 'Content-Type': 'application/json' } })
  } catch {
    return new Response(JSON.stringify({ persistentMode: 'off', enabledAgents: [], since: null }), { headers: { 'Content-Type': 'application/json' } })
  }
}

async function handleSetPersistentConfig(req: Request): Promise<Response> {
  try {
    const body = await req.json() as { persistentMode?: string, enabledAgents?: string[], reason?: string }
    const { persistentMode, enabledAgents, reason } = body

    if (!['off', 'selective', 'full'].includes(persistentMode || '')) {
      return new Response(JSON.stringify({ error: 'persistentMode must be off/selective/full' }), {
        status: 400, headers: { 'Content-Type': 'application/json' }
      })
    }

    const config = {
      persistentMode,
      enabledAgents: enabledAgents || [],
      since: new Date().toISOString(),
      setBy: 'api'
    }
    const { writeFileSync: wfs } = require('fs')
    wfs(PERSISTENT_CONFIG_FILE, JSON.stringify(config, null, 2))

    return new Response(JSON.stringify(config), { headers: { 'Content-Type': 'application/json' } })
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid request body' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    })
  }
}

async function handleToggleAgentPersistent(agentId: string, req: Request): Promise<Response> {
  try {
    const body = await req.json() as { enabled?: boolean }
    const { enabled } = body

    let config: any
    try {
      config = existsSync(PERSISTENT_CONFIG_FILE)
        ? JSON.parse(readFileSync(PERSISTENT_CONFIG_FILE, 'utf-8'))
        : { persistentMode: 'off', enabledAgents: [] }
    } catch {
      config = { persistentMode: 'off', enabledAgents: [] }
    }

    // Auto-switch to selective on per-agent toggle
    if (config.persistentMode !== 'selective') {
      config.persistentMode = 'selective'
    }

    if (enabled && !config.enabledAgents.includes(agentId)) {
      config.enabledAgents.push(agentId)
    } else if (!enabled) {
      config.enabledAgents = config.enabledAgents.filter((a: string) => a !== agentId)
    }

    config.since = new Date().toISOString()
    config.setBy = 'api'

    const { writeFileSync: wfs } = require('fs')
    wfs(PERSISTENT_CONFIG_FILE, JSON.stringify(config, null, 2))

    return new Response(JSON.stringify({ id: agentId, persistent: enabled, config }), { headers: { 'Content-Type': 'application/json' } })
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid request body' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    })
  }
}

function handleStopAgent(agentId: string): Response {
  const signalFile = join(process.env.HOME || homedir(), `.tmp/agent_stop_${agentId}`)
  try {
    const { writeFileSync: wfs } = require('fs')
    wfs(signalFile, '')
    return new Response(JSON.stringify({ status: 'stop_signal_sent', agent: agentId }), { headers: { 'Content-Type': 'application/json' } })
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
}

// ============================================
// SERVER
// ============================================

// Start file watcher
startFileWatcher()

// Start konzola log streamer
startKonzolaLogStreamer()


// ============================================
// RAG BACKEND HANDLERS (TASK-4967)
// ============================================

const ragBackendService = getRAGBackendService()

/**
 * GET /api/rag/backend/status — Status svih backenda
 */
async function handleGetRAGBackendStatus(): Promise<Response> {
  try {
    const status = await ragBackendService.getStatus()
    return new Response(JSON.stringify(status), {
      headers: { 'Content-Type': 'application/json' }
    })
  } catch (error) {
    return new Response(JSON.stringify({
      error: 'Failed to get backend status',
      details: error instanceof Error ? error.message : String(error)
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    })
  }
}

/**
 * PUT /api/rag/backend — Promjena aktivnog backenda
 */
async function handleSetRAGBackend(req: Request): Promise<Response> {
  try {
    const body = await req.json()
    const backend = body.backend

    if (!backend) {
      return new Response(JSON.stringify({ error: 'Backend not specified' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    const result = await ragBackendService.setBackend(backend)

    if (!result.success) {
      return new Response(JSON.stringify({ error: result.error }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    return new Response(JSON.stringify({ success: true, backend }), {
      headers: { 'Content-Type': 'application/json' }
    })
  } catch (error) {
    return new Response(JSON.stringify({
      error: 'Failed to set backend',
      details: error instanceof Error ? error.message : String(error)
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    })
  }
}

/**
 * GET /api/rag/backend/compare — Usporedi kolekcije između backenda
 */
async function handleCompareRAGBackends(): Promise<Response> {
  try {
    const comparisons = await ragBackendService.compareCollections()
    return new Response(JSON.stringify({ comparisons }), {
      headers: { 'Content-Type': 'application/json' }
    })
  } catch (error) {
    return new Response(JSON.stringify({
      error: 'Failed to compare backends',
      details: error instanceof Error ? error.message : String(error)
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    })
  }
}

/**
 * GET /api/rag/backend/migration — Status migracije
 */
async function handleGetRAGMigrationStatus(): Promise<Response> {
  try {
    const status = ragBackendService.getMigrationStatus()
    return new Response(JSON.stringify(status), {
      headers: { 'Content-Type': 'application/json' }
    })
  } catch (error) {
    return new Response(JSON.stringify({
      error: 'Failed to get migration status',
      details: error instanceof Error ? error.message : String(error)
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    })
  }
}

/**
 * POST /api/rag/backend/migrate — Pokreni migraciju kolekcije
 */
async function handleStartRAGMigration(req: Request): Promise<Response> {
  try {
    const body = await req.json()
    const collection = body.collection

    if (!collection) {
      return new Response(JSON.stringify({ error: 'Collection not specified' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    const result = await ragBackendService.startMigration(collection)

    if (!result.started) {
      return new Response(JSON.stringify({ error: result.error }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    return new Response(JSON.stringify({ success: true, started: true, collection }), {
      headers: { 'Content-Type': 'application/json' }
    })
  } catch (error) {
    return new Response(JSON.stringify({
      error: 'Failed to start migration',
      details: error instanceof Error ? error.message : String(error)
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    })
  }
}

/**
 * PUT /api/rag/backend/config — Spremi pgvector konfiguraciju
 */
async function handleSetRAGBackendConfig(req: Request): Promise<Response> {
  try {
    const body = await req.json()
    const { host, port, database, user } = body

    // Lozinka se NIKAD ne sprema u JSON konfiguraciju: ide u TM_PGVECTOR_PASSWORD ili u
    // datoteku tajni. Tiho ignoriranje bi korisniku reklo „spremljeno", a nije.
    if (body && Object.prototype.hasOwnProperty.call(body, 'password')) {
      return new Response(JSON.stringify({
        error: 'Lozinka se ne sprema u konfiguraciju — postavi TM_PGVECTOR_PASSWORD (okolina ili datoteka tajni).'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } })
    }

    if (!host || !port || !database || !user) {
      return new Response(JSON.stringify({
        error: 'Missing required fields: host, port, database, user'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    const result = await ragBackendService.savePgVectorConfig({
      host, port, database, user
    })

    if (!result.success) {
      return new Response(JSON.stringify({ error: result.error }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' }
    })
  } catch (error) {
    return new Response(JSON.stringify({
      error: 'Failed to save config',
      details: error instanceof Error ? error.message : String(error)
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    })
  }
}

/**
 * POST /api/rag/backend/test — Test pgvector konekcije
 */
async function handleTestRAGBackendConnection(req: Request): Promise<Response> {
  try {
    const body = await req.json()
    const { host, port, database, user, password } = body

    if (!host || !port || !database || !user) {
      return new Response(JSON.stringify({
        error: 'Missing required fields: host, port, database, user'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    // Lozinka: poslana u tijelu ILI (samo za SPREMLJENU adresu) iz TM_PGVECTOR_PASSWORD /
    // datoteke tajni — to razrješava sama usluga. Na upisanu tuđu adresu spremljena se
    // lozinka nikad ne šalje (SSRF / curenje tajne, GAP F13 uvjet d).
    const result = await ragBackendService.testPgVectorConnection({
      host, port, database, user, password: password || undefined
    })

    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' }
    })
  } catch (error) {
    return new Response(JSON.stringify({
      connected: false,
      error: error instanceof Error ? error.message : String(error)
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    })
  }
}


/** GET /api/rag/backend/config — postavke BEZ lozinke (samo `passwordSet`). */
function handleGetRAGBackendConfig(): Response {
  try {
    return new Response(JSON.stringify(ragBackendService.getConfig()), { headers: { 'Content-Type': 'application/json' } })
  } catch (error) {
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
  }
}


const server = Bun.serve({
  port: PORT,
  hostname: HOST,  // Bind to 0.0.0.0 for external access

  async fetch(req: Request) {
    const url = new URL(req.url)

    // Host validation for security
    if (!isHostAllowed(req)) {
      console.warn(`[Security] Blocked request from unauthorized host: ${req.headers.get('host')}`)
      return new Response('Forbidden - Host not allowed', { status: 403 })
    }

    // CORS headers - allow specific origins
    const origin = req.headers.get('origin') || '*'
    const headers = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Credentials': 'true'
    }

    // Preflight
    if (req.method === 'OPTIONS') {
      return new Response(null, { headers })
    }

    // WebSocket upgrade
    if (url.pathname === '/stream') {
      const success = server.upgrade(req)
      if (success) return undefined
    }

    // TASK-3096: proxy za aplikacije koje slusaju samo lokalno na nodu.
    // node-B je iza VirtualBox NAT-a i prosljedjuju se SAMO 2222 i 17781, pa aplikacija na
    // 17789 (MelodyFinder) nije dostupna izvana. Umjesto diranja VirtualBox konfiguracije
    // (koja je na Windows hostu i nije nam dostupna), promet ide kroz vec proslijedjeni
    // 17781: /app/<port>/<putanja> -> http://127.0.0.1:<port>/<putanja>.
    // Dopusten je uzak raspon portova, da ovo ne postane otvoreni proxy prema cijelom stroju.
    const APP_PROXY_PORTS = new Set([17783, 17784, 17785, 17786, 17787, 17788, 17789])
    if (url.pathname.startsWith('/app/')) {
      const seg = url.pathname.slice('/app/'.length)
      const slash = seg.indexOf('/')
      const portStr = slash < 0 ? seg : seg.slice(0, slash)
      const rest = slash < 0 ? '/' : seg.slice(slash)
      const port = Number(portStr)
      if (!APP_PROXY_PORTS.has(port)) {
        return new Response(`Proxy nije dopusten za port ${portStr}. Dopusteni: ${[...APP_PROXY_PORTS].join(', ')}`, { status: 403 })
      }
      const target = `http://127.0.0.1:${port}${rest}${url.search}`
      try {
        const upstream = await fetch(target, {
          method: req.method,
          headers: req.headers,
          body: (req.method === 'GET' || req.method === 'HEAD') ? undefined : await req.arrayBuffer(),
        })
        return new Response(upstream.body, { status: upstream.status, headers: upstream.headers })
      } catch (e: any) {
        return new Response(`Aplikacija na portu ${port} ne odgovara (${e?.message || e}). Je li pokrenuta na 127.0.0.1:${port}?`, { status: 502 })
      }
    }

    // Health check
    if (url.pathname === '/health') {
      return handleHealthCheck()
    }

    // Gita Image Service Proxy
    if (url.pathname === '/api/gita/generate' && req.method === 'POST') {
      try {
        const gitaResponse = await fetch('http://localhost:8889/generate', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: await req.text()
        })
        return new Response(await gitaResponse.arrayBuffer(), {
          status: gitaResponse.status,
          headers: {
            'Content-Type': gitaResponse.headers.get('Content-Type') || 'application/json',
            ...headers
          }
        })
      } catch (error) {
        return new Response(JSON.stringify({
          error: 'Gita Image Service unavailable',
          details: error instanceof Error ? error.message : String(error)
        }), {
          status: 503,
          headers: { 'Content-Type': 'application/json', ...headers }
        })
      }
    }

    if (url.pathname === '/api/gita/health' && req.method === 'GET') {
      try {
        const gitaResponse = await fetch('http://localhost:8889/health')
        return new Response(await gitaResponse.text(), {
          status: gitaResponse.status,
          headers: { 'Content-Type': 'application/json', ...headers }
        })
      } catch (error) {
        return new Response(JSON.stringify({
          error: 'Gita Image Service unavailable'
        }), {
          status: 503,
          headers: { 'Content-Type': 'application/json', ...headers }
        })
      }
    }

    // Preuzimanje dokumenta na koji task (resultSummary) linka — sigurno, samo unutar HOME-a.
    if (url.pathname === '/api/files/download' && req.method === 'GET') {
      return handleFileDownload(url)
    }

    // Login providers (prijava preko linka)
    // TASK-3609: tečaj USD→EUR za prikaz troška (mjerenje ostaje u dolarima).
    if (url.pathname === '/api/tecaj' && req.method === 'GET') return tecajOdgovor()
    if (url.pathname === '/api/session-usage' && req.method === 'GET') return handleSessionUsage(req)
    // T10/TASK-3575: sto je vratar danas propustio, a nije mogao provjeriti.
    if (url.pathname === '/api/critic/unverified' && req.method === 'GET') return handleUnverified()
    if (url.pathname === '/api/providers/login/status' && req.method === 'GET') return handleLoginStatus()
    if (url.pathname === '/api/providers/login/start' && req.method === 'POST') return handleLoginStart(req)
    if (url.pathname === '/api/providers/login/poll' && req.method === 'GET') return handleLoginPoll(url)
    if (url.pathname === '/api/providers/login/paste' && req.method === 'POST') return handleLoginPaste(req)
    if (url.pathname === '/api/providers/login/apikey' && req.method === 'POST') return handleLoginApikey(req)
    if (url.pathname === '/api/providers/login/logout' && req.method === 'POST') return handleLoginLogout(req)

    // API Routes
    if (url.pathname === '/api/tasks' && req.method === 'GET') {
      return handleGetTasks(url)
    }

    if (url.pathname === '/api/tasks' && req.method === 'POST') {
      return handleCreateTask(req)
    }

    if (url.pathname.match(/^\/api\/tasks\/[^\/]+$/) && req.method === 'GET') {
      const taskId = url.pathname.split('/')[3]
      return handleGetTask(taskId)
    }

    // GET /api/tasks/:id/telemetry — „Potrošnja zadatka" (TASK-3568, T4)
    if (url.pathname.match(/^\/api\/tasks\/[^\/]+\/telemetry$/) && req.method === 'GET') {
      const taskId = url.pathname.split('/')[3]
      return handleTaskTelemetry(taskId, url)
    }

    // GET /api/pregled/tjedni — kartica „Potrošnja", mjera 6 (TASK-3569, T5)
    if (url.pathname === '/api/pregled/tjedni' && req.method === 'GET') {
      return handleTjedniPregled(url)
    }

    // GET /api/pregled/projekt/:id — „Potrošnja projekta" (TASK-3572, T8)
    if (url.pathname.match(/^\/api\/pregled\/projekt\/[^\/]+$/) && req.method === 'GET') {
      return handleProjektPregled(url.pathname.split('/')[4], url)
    }

    // PUT /api/tasks/:id/progress - Update task progress
    if (url.pathname.match(/^\/api\/tasks\/[^\/]+\/progress$/) && req.method === 'PUT') {
      const taskId = url.pathname.split('/')[3]
      return handleUpdateTaskProgress(taskId, req)
    }

    if (url.pathname.match(/^\/api\/tasks\/[^\/]+$/) && req.method === 'PUT') {
      const taskId = url.pathname.split('/')[3]
      return handleUpdateTask(taskId, req)
    }

    // TASK-3047: ručna kočnica — globalna i po zadatku.
    if (url.pathname === '/api/odlucitelj/config' && req.method === 'GET') return handleOdluciteljConfigGet()
    if (url.pathname === '/api/odlucitelj/config' && req.method === 'PUT') return handleOdluciteljConfigPut(req)
    if (url.pathname === '/api/odlucitelj/pokreni' && req.method === 'POST') return handleOdluciteljPokreni(req)
    if (url.pathname === '/api/jezici' && req.method === 'GET') return handleGetJezici()
    if (url.pathname.startsWith('/api/jezik/') && req.method === 'GET') {
      return handleGetJezik(url.pathname.slice('/api/jezik/'.length))
    }
    if (url.pathname === '/api/odluke' && req.method === 'GET') return handleGetOdluke()
    if (url.pathname.match(/^\/api\/tasks\/[^\/]+\/odluka$/) && req.method === 'POST') {
      return handleTaskOdluka(url.pathname.split('/')[3], req)
    }
    if (url.pathname.match(/^\/api\/tasks\/[^\/]+\/pitanje$/) && req.method === 'POST') {
      return handleTaskPitanje(url.pathname.split('/')[3], req)
    }
    if (url.pathname === '/api/upute/stanje' && req.method === 'GET') return jsonResp(taskManager.taskInstructionSummary())
    if (url.pathname.match(/^\/api\/tasks\/[^\/]+\/uputa$/) && req.method === 'POST') {
      return handleAddInstruction(url.pathname.split('/')[3], req)
    }
    if (url.pathname.match(/^\/api\/tasks\/[^\/]+\/upute$/) && req.method === 'GET') {
      return handleListInstructions(url.pathname.split('/')[3], url)
    }
    if (url.pathname.match(/^\/api\/tasks\/[^\/]+\/upute\/preuzmi$/) && req.method === 'POST') {
      return handleClaimInstructions(url.pathname.split('/')[3], req)
    }
    if (url.pathname === '/api/pause' && req.method === 'GET') return handleGetPause()
    if (url.pathname === '/api/config/concurrency' && req.method === 'GET') return handleConcurrencyGet()
    if (url.pathname === '/api/config/concurrency' && req.method === 'PUT') return handleConcurrencyPut(req)
    if (url.pathname === '/api/pause' && req.method === 'POST') return handleSetPause(req)
    if (url.pathname.match(/^\/api\/tasks\/[^\/]+\/pause$/) && req.method === 'POST') {
      return handleTaskPause(url.pathname.split('/')[3], true, req)
    }
    if (url.pathname.match(/^\/api\/tasks\/[^\/]+\/resume$/) && req.method === 'POST') {
      return handleTaskPause(url.pathname.split('/')[3], false, req)
    }

    // POST /api/tasks/:id/reclaim - R2 stale-watchdog: in_progress -> pending
    if (url.pathname.match(/^\/api\/tasks\/[^\/]+\/reclaim$/) && req.method === 'POST') {
      const taskId = url.pathname.split('/')[3]
      return handleReclaimTask(taskId, req)
    }

    if (url.pathname.match(/^\/api\/tasks\/[^\/]+$/) && req.method === 'DELETE') {
      const taskId = url.pathname.split('/')[3]
      return handleDeleteTask(taskId)
    }

    // ============================================
    // PROJECT API ROUTES
    // ============================================

    // GET /api/projects - List projects
    if (url.pathname === '/api/projects' && req.method === 'GET') {
      return handleGetProjects(url)
    }

    // POST /api/projects - Create project
    if (url.pathname === '/api/projects' && req.method === 'POST') {
      return handleCreateProject(req)
    }

    // TASK-3691: GET /api/vrijednost-inputa — vrijednost korisničkih upita po cjeniku S1–S6.
    if (url.pathname === '/api/vrijednost-inputa' && req.method === 'GET') {
      return handleVrijednostInputa(url)
    }

    // TASK-3691: GET /api/projects/trosak — ukupna potrošnja po projektu iz cost_loga.
    // MORA stajati prije /api/projects/:id, inače bi ga ruta za pojedini projekt progutala.
    if (url.pathname === '/api/projects/trosak' && req.method === 'GET') {
      return handleGetProjectsTrosak()
    }

    // GET /api/projects/:id - Get project
    if (url.pathname.match(/^\/api\/projects\/[^\/]+$/) && req.method === 'GET') {
      const projectId = decodeURIComponent(url.pathname.split('/')[3])
      return handleGetProject(projectId)
    }

    // PUT /api/projects/:id - Update project
    if (url.pathname.match(/^\/api\/projects\/[^\/]+$/) && req.method === 'PUT') {
      const projectId = decodeURIComponent(url.pathname.split('/')[3])
      return handleUpdateProject(projectId, req)
    }

    // DELETE /api/projects/:id - Delete project
    if (url.pathname.match(/^\/api\/projects\/[^\/]+$/) && req.method === 'DELETE') {
      const projectId = decodeURIComponent(url.pathname.split('/')[3])
      return handleDeleteProject(projectId)
    }

    // POST /api/projects/:id/dispatch-upgrade - Dispatch "Nadogradi po specifikacijama"
    if (url.pathname.match(/^\/api\/projects\/[^\/]+\/dispatch-upgrade$/) && req.method === 'POST') {
      const projectId = decodeURIComponent(url.pathname.split('/')[3])
      return handleDispatchUpgrade(projectId, req)
    }

    // GET|PUT /api/templates/:name - Editabilni .md template (spec-upgrade itd.)
    const tplMatch = url.pathname.match(/^\/api\/templates\/([^/]+)$/)
    if (tplMatch && (req.method === 'GET' || req.method === 'PUT')) {
      return handleTemplate(decodeURIComponent(tplMatch[1]), req)
    }

    // POST /api/projects/:id/agents - Add agent to project
    if (url.pathname.match(/^\/api\/projects\/[^\/]+\/agents$/) && req.method === 'POST') {
      const projectId = decodeURIComponent(url.pathname.split('/')[3])
      return handleAddProjectAgent(projectId, req)
    }

    // DELETE /api/projects/:id/agents/:agentId - Remove agent from project
    if (url.pathname.match(/^\/api\/projects\/[^\/]+\/agents\/[^\/]+$/) && req.method === 'DELETE') {
      const parts = url.pathname.split('/')
      const projectId = decodeURIComponent(parts[3])
      const agentId = decodeURIComponent(parts[5])
      return handleRemoveProjectAgent(projectId, agentId)
    }

    // POST /api/projects/:id/rag - Link RAG to project
    if (url.pathname.match(/^\/api\/projects\/[^\/]+\/rag$/) && req.method === 'POST') {
      const projectId = decodeURIComponent(url.pathname.split('/')[3])
      return handleLinkProjectRAG(projectId, req)
    }

    // DELETE /api/projects/:id/rag/:collection/:docId - Unlink RAG from project
    if (url.pathname.match(/^\/api\/projects\/[^\/]+\/rag\/[^\/]+\/[^\/]+$/) && req.method === 'DELETE') {
      const parts = url.pathname.split('/')
      const projectId = decodeURIComponent(parts[3])
      const collection = decodeURIComponent(parts[5])
      const docId = decodeURIComponent(parts[6])
      return handleUnlinkProjectRAG(projectId, collection, docId)
    }

    // ============================================
    // RAG API ROUTES
    // ============================================

    // GET /api/rag/collections - List collections
    if (url.pathname === '/api/rag/collections' && req.method === 'GET') {
      return handleGetRAGCollections()
    }

    // GET /api/rag/projects - Broj dokumenata po projektu (R4, TASK-4311)
    if (url.pathname === '/api/rag/projects' && req.method === 'GET') {
      return handleGetRAGProjectCounts(url)
    }

    // GET /api/rag/entries - List entries with filters
    if (url.pathname === '/api/rag/entries' && req.method === 'GET') {
      return handleGetRAGEntries(url)
    }

    // GET /api/rag/entries/:collection/:id - Get single entry
    if (url.pathname.match(/^\/api\/rag\/entries\/[^\/]+\/[^\/]+$/) && req.method === 'GET') {
      const parts = url.pathname.split('/')
      const collection = decodeURIComponent(parts[4])
      const id = decodeURIComponent(parts[5])
      return handleGetRAGEntry(collection, id)
    }

    // DELETE /api/rag/entries - Bulk delete entries
    if (url.pathname === '/api/rag/entries' && req.method === 'DELETE') {
      return handleDeleteRAGEntries(req)
    }

    // GET /api/rag/health - RAG health check
    if (url.pathname === '/api/rag/health' && req.method === 'GET') {
      return handleRAGHealth()
    }

    // ============================================
    // KONZOLA API ROUTES
    // ============================================

    // GET /api/konzola/status - Aggregated status
    if (url.pathname === '/api/konzola/status' && req.method === 'GET') {
      return handleKonzolaStatus()
    }

    // POST /api/konzola/exec - Execute command
    if (url.pathname === '/api/konzola/exec' && req.method === 'POST') {
      return handleKonzolaExec(req)
    }

    // POST /api/konzola/mode - Switch plan/work mode
    if (url.pathname === '/api/konzola/mode' && req.method === 'POST') {
      return handleKonzolaMode(req)
    }

    // GET /api/konzola/logs - Tail log file
    if (url.pathname === '/api/konzola/logs' && req.method === 'GET') {
      return handleKonzolaLogs(url)
    }

    // POST /api/konzola/message - Send natural language message to REGOČ queue
    if (url.pathname === '/api/konzola/message' && req.method === 'POST') {
      return handleKonzolaMessage(req)
    }

    // ============================================
    // SYSTEM MODE API ROUTES (TASK-623)
    // ============================================

    // GET /api/system/mode — current system mode
    if (url.pathname === '/api/system/mode' && req.method === 'GET') {
      return handleGetSystemMode()
    }

    // PUT /api/system/mode — change system mode
    if (url.pathname === '/api/system/mode' && req.method === 'PUT') {
      return handleSetSystemMode(req)
    }

    // GET /api/system/persistent — persistent agents config
    if (url.pathname === '/api/system/persistent' && req.method === 'GET') {
      return handleGetPersistentConfig()
    }

    // PUT /api/system/persistent — update persistent config
    if (url.pathname === '/api/system/persistent' && req.method === 'PUT') {
      return handleSetPersistentConfig(req)
    }

    // PUT /api/agents/:id/persistent — toggle one agent persistent mode
    if (url.pathname.match(/^\/api\/agents\/[^\/]+\/persistent$/) && req.method === 'PUT') {
      const agentId = decodeURIComponent(url.pathname.split('/')[3])
      return handleToggleAgentPersistent(agentId, req)
    }

    // POST /api/agents/:id/stop — stop a persistent agent
    if (url.pathname.match(/^\/api\/agents\/[^\/]+\/stop$/) && req.method === 'POST') {
      const agentId = decodeURIComponent(url.pathname.split('/')[3])
      return handleStopAgent(agentId)
    }

    // PUT /api/agents/:id/model — set/clear per-agent model override (model-config.json)
    if (url.pathname.match(/^\/api\/agents\/[^\/]+\/model$/) && req.method === 'PUT') {
      const agentId = decodeURIComponent(url.pathname.split('/')[3])
      return handleSetAgentModel(agentId, req)
    }

    // GET /api/models/available — providers + live models (Ollama /api/tags)
    if (url.pathname === '/api/models/available' && req.method === 'GET') {
      try {
        return new Response(JSON.stringify(await buildModelsAvailable()), { headers: { 'Content-Type': 'application/json' } })
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { 'Content-Type': 'application/json' } })
      }
    }

    // GET/PUT /api/models/classifier — rutirajući (klasifikacijski) model, odvojen od izvršnog
    if (url.pathname === '/api/models/classifier' && req.method === 'GET') {
      return handleGetClassifier()
    }
    if (url.pathname === '/api/models/classifier' && req.method === 'PUT') {
      return handleSetClassifier(req)
    }

    // PUT /api/models/providers/:id — provider setup (enabled, baseUrl, token)
    if (url.pathname.match(/^\/api\/models\/providers\/[^\/]+$/) && req.method === 'PUT') {
      const providerId = decodeURIComponent(url.pathname.split('/')[4])
      return handleSetProvider(providerId, req)
    }

    // GET /api/dezurni/config — postavke dežurnog + živi popis modela s njegove Ollame
    if (url.pathname === '/api/dezurni/config' && req.method === 'GET') {
      return handleDezurniConfigGet()
    }

    // PUT /api/dezurni/config — izbor modela i ostale postavke dežurnog (D4)
    if (url.pathname === '/api/dezurni/config' && req.method === 'PUT') {
      return handleDezurniConfigPut(req)
    }

    // POST /api/dezurni/proba — probni poziv odabranog davatelja (TASK-4709). Izbor koji se
    // ne može isprobati nije izbor nego obećanje koje se provjerava tek u kvaru.
    if (url.pathname === '/api/dezurni/proba' && req.method === 'POST') {
      return handleDezurniProba()
    }

    // GET /api/telegram/config — postavke Telegram integracije (Kosjenka, 09.09.2026.)
    if (url.pathname === '/api/telegram/config' && req.method === 'GET') {
      return handleTelegramConfigGet()
    }

    // PUT /api/telegram/config — spremanje bot tokena, chat id, prekidača
    if (url.pathname === '/api/telegram/config' && req.method === 'PUT') {
      return handleTelegramConfigPut(req)
    }

    // POST /api/telegram/proba — probno slanje testne poruke na Telegram
    if (url.pathname === '/api/telegram/proba' && req.method === 'POST') {
      return handleTelegramProba()
    }

    // GET /api/telegram/ulaz/stanje — stanje ulazne petlje (offset, brojači, greška)
    if (url.pathname === '/api/telegram/ulaz/stanje' && req.method === 'GET') {
      return handleTelegramUlazStanje()
    }

    // POST /api/telegram/ulaz/proba — koliko poruka čeka i iz kojih chatova (bez zadataka)
    if (url.pathname === '/api/telegram/ulaz/proba' && req.method === 'POST') {
      return handleTelegramUlazProba()
    }

    // GET /api/integracije — sažetak četiriju integracija za skupinu na Config stranici
    if (url.pathname === '/api/integracije' && req.method === 'GET') {
      return handleIntegracijeSazetak()
    }

    // GET|PUT /api/<nextcloud|email|gitlab|github>/config, POST /api/<ime>/proba
    {
      const m = url.pathname.match(/^\/api\/(nextcloud|email|gitlab|github)\/(config|proba)$/)
      if (m) {
        const [, ime, sto] = m as unknown as [string, string, string]
        if (sto === 'config' && req.method === 'GET') return handleIntegracijaGet(ime)
        if (sto === 'config' && req.method === 'PUT') return handleIntegracijaPut(ime, req)
        if (sto === 'proba' && req.method === 'POST') return handleIntegracijaProba(ime)
      }
    }

    // ============================================
    // RAG BACKEND API ROUTES (TASK-4967)
    // ============================================

    // GET /api/rag/backend/status - Backend status
    if (url.pathname === '/api/rag/backend/status' && req.method === 'GET') {
      return handleGetRAGBackendStatus()
    }

    // PUT /api/rag/backend - Set backend
    if (url.pathname === '/api/rag/backend' && req.method === 'PUT') {
      return handleSetRAGBackend(req)
    }

    // GET /api/rag/backend/compare - Compare collections
    if (url.pathname === '/api/rag/backend/compare' && req.method === 'GET') {
      return handleCompareRAGBackends()
    }

    // GET /api/rag/backend/migration - Migration status
    if (url.pathname === '/api/rag/backend/migration' && req.method === 'GET') {
      return handleGetRAGMigrationStatus()
    }

    // POST /api/rag/backend/migrate - Start migration
    if (url.pathname === '/api/rag/backend/migrate' && req.method === 'POST') {
      return handleStartRAGMigration(req)
    }

    // GET /api/rag/backend/config - postavke bez lozinke
    if (url.pathname === '/api/rag/backend/config' && req.method === 'GET') {
      return handleGetRAGBackendConfig()
    }

    // PUT /api/rag/backend/config - Save pgvector config
    if (url.pathname === '/api/rag/backend/config' && req.method === 'PUT') {
      return handleSetRAGBackendConfig(req)
    }

    // POST /api/rag/backend/test - Test pgvector connection
    if (url.pathname === '/api/rag/backend/test' && req.method === 'POST') {
      return handleTestRAGBackendConnection(req)
    }


    // GET|PUT /api/orchestrator/config — postavke jezgre orkestratora (ADR-0001)
    if (url.pathname === '/api/orchestrator/config' && req.method === 'GET') {
      return handleOrchestratorGet()
    }
    if (url.pathname === '/api/orchestrator/config' && req.method === 'PUT') {
      return handleOrchestratorPut(req)
    }

    // GET /api/ingest-gate — ulazna vrata za Telegram: prekidač po grupi + pragovi (U1)
    if (url.pathname === '/api/ingest-gate' && req.method === 'GET') {
      return handleIngestGateGet()
    }

    // PUT /api/ingest-gate — promjena položaja prekidača, zadanog projekta ili praga (U1)
    if (url.pathname === '/api/ingest-gate' && req.method === 'PUT') {
      return handleIngestGatePut(req)
    }

    // POST /api/ingest — generički ulaz: source, externalId, replyTo, text, senderName (U6)
    if (url.pathname === '/api/ingest' && req.method === 'POST') {
      return handleIngest(req)
    }

    // ============================================
    // INFO API ROUTE
    // ============================================

    // GET /api/info - REGOČ System Info (model requirements, agents, modules, rules)
    if (url.pathname === '/api/info' && req.method === 'GET') {
      try {
        const info = buildInfoPayload()
        return new Response(JSON.stringify(info), { headers: { 'Content-Type': 'application/json' } })
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { 'Content-Type': 'application/json' } })
      }
    }

    // WORKFLOW API ROUTES
    // ============================================

    // GET /api/workflow/:skill/:name — Read workflow markdown
    const wfGetMatch = url.pathname.match(/^\/api\/workflow\/([^/]+)\/([^/]+)$/)
    // Path-traversal guard: skill/name are interpolated into a filesystem path
    // (read on GET, WRITE on PUT). `[^/]+` permits `..`, so reject anything that
    // isn't a strict identifier. Disallowing '.' makes '..' impossible — airtight,
    // no canonicalization needed. Applies to every method on this route.
    if (wfGetMatch) {
      const [, _wfSkill, _wfName] = wfGetMatch
      if (!/^[A-Za-z0-9_-]+$/.test(_wfSkill) || !/^[A-Za-z0-9_-]+$/.test(_wfName)) {
        return new Response(JSON.stringify({ error: 'Invalid skill or workflow name' }), { status: 400, headers: { 'Content-Type': 'application/json' } })
      }
    }
    if (wfGetMatch && req.method === 'GET') {
      const [, skill, name] = wfGetMatch
      const _home = process.env.HOME || homedir()
      const wfPath = join(_home, '.claude/skills', skill, 'Workflows', name + '.md')
      if (!existsSync(wfPath)) {
        return new Response(JSON.stringify({ error: 'Workflow not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } })
      }
      const content = readFileSync(wfPath, 'utf-8')
      const steps = content.split(/\n(?=### Step )/i).filter(s => s.match(/^### Step /i))
      return new Response(JSON.stringify({
        skill, name, path: wfPath,
        content,
        steps: steps.map((s, i) => {
          const titleMatch = s.match(/^### (.+)/m)
          return { index: i, title: titleMatch ? titleMatch[1].trim() : `Step ${i+1}`, content: s.trim() }
        }),
      }), { headers: { 'Content-Type': 'application/json' } })
    }

    // PUT /api/workflow/:skill/:name — Save workflow markdown
    if (wfGetMatch && req.method === 'PUT') {
      const [, skill, name] = wfGetMatch
      const _home2 = process.env.HOME || homedir()
      const wfPath = join(_home2, '.claude/skills', skill, 'Workflows', name + '.md')
      const wfDir = join(_home2, '.claude/skills', skill, 'Workflows')
      if (!existsSync(wfDir)) {
        return new Response(JSON.stringify({ error: 'Skill workflows dir not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } })
      }
      try {
        const body = await req.json() as { content: string }
        if (!body.content) throw new Error('Missing content')
        const { writeFileSync: _wfs } = require('fs')
        _wfs(wfPath, body.content)
        return new Response(JSON.stringify({ status: 'saved', path: wfPath }), { headers: { 'Content-Type': 'application/json' } })
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 400, headers: { 'Content-Type': 'application/json' } })
      }
    }

    // STATUS API ROUTES
    // ============================================

    // GET /api/status/dashboard - Aggregated dashboard data
    if (url.pathname === '/api/status/dashboard' && req.method === 'GET') {
      return handleStatusDashboard()
    }

    // GET /api/agents - Agent Status Panel
    if (url.pathname === '/api/agents' && req.method === 'GET') {
      return handleGetAgents()
    }

    // GET /api/modules - Module Status
    if (url.pathname === '/api/modules' && req.method === 'GET') {
      return handleGetModules()
    }

    // GET /api/metrics - Performance Metrics
    if (url.pathname === '/api/metrics' && req.method === 'GET') {
      return handleGetMetrics()
    }

    // GET /api/security - Security Dashboard Data
    if (url.pathname === '/api/security' && req.method === 'GET') {
      return handleGetSecurity()
    }

    // Serve HTML UI
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(HTML_TEMPLATE, {
        headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' }
      })
    }

    // 404
    return new Response('Not Found', { status: 404 })
  },

  websocket: {
    open(ws) {
      console.log('[WebSocket] Client connected')
      wsClients.add(ws)

      // Send initial data
      const tasks = taskManager.getTasks()
      ws.send(JSON.stringify({ type: 'initial', tasks }))
    },

    message(ws, message) {
      console.log('[WebSocket] Message:', message)
    },

    close(ws) {
      console.log('[WebSocket] Client disconnected')
      wsClients.delete(ws)
    },

    error(ws, error) {
      console.error('[WebSocket] Error:', error)
      wsClients.delete(ws)
    }
  }
})

console.log(`
╔═══════════════════════════════════════════════════════════════════════════╗
║                     Regoc TaskManagerMD - Web UI Server                   ║
╠═══════════════════════════════════════════════════════════════════════════╣
║  Internal:  ${HOST}:${PORT} (inside Docker)                                  ║
║  External:  :${EXTERNAL_PORT} (mapped by Docker)                               ║
╠───────────────────────────────────────────────────────────────────────────╣
║  Local:     http://localhost:${EXTERNAL_PORT}                                   ║
║  Mreža:     http://${EXTERNAL_HOST}:${EXTERNAL_PORT}

╠───────────────────────────────────────────────────────────────────────────╣
║  Tasks API:    /api/tasks                                                 ║
║  Projects API: /api/projects                                              ║
║  RAG API:      /api/rag/collections, /api/rag/entries                     ║
║  Health:       /health, /api/rag/health                                   ║
║  WebSocket:    /stream                                                    ║
║  Gita:         /api/gita/generate, /api/gita/health                       ║
║  Konzola:      /api/konzola/status, /exec, /mode, /logs                  ║
║  Status:       /api/status/dashboard                                     ║
║  Agents:       /api/agents                                               ║
║  Modules:      /api/modules                                              ║
║  Metrics:      /api/metrics                                              ║
║  Security:     /api/security                                             ║
╠═══════════════════════════════════════════════════════════════════════════╣
║  Tasks Dir: ${TASKS_DIR}
║  Watching:  ${watcherReady ? 'Active' : 'Inactive'}
╚═══════════════════════════════════════════════════════════════════════════╝
`)

// ── Telegram ULAZ, način A: poller u procesu ploče (DIZAJN-telegram-poller §2) ────────
// Pokreće se SAMO ako je `ulaz.ukljucen` i ako postoji bot token; inače tiho ne radi ništa
// (svježa instalacija je normalno stanje, ne kvar). Datoteka-brava sprječava da se uz ovaj
// poller pokrene i onaj iz `scripts/telegram-poller.ts` — dva pollera s istim tokenom si
// međusobno kradu poruke i gubitak je nevidljiv.
{
  const p = pokreniTelegramPoller({
    plocaBase: `http://localhost:${PORT}`,
    log: (r: string) => console.log(r),
  })
  if (!p.pokrenut && p.razlog && !/isključen|nije postavljen/.test(p.razlog)) {
    console.log(`[telegram-poller] ${p.razlog}`)
  }
}
