#!/usr/bin/env bun
/**
 * AgentDaemon.ts — Persistent agent process
 *
 * Runs as a long-lived Bun process for a specific agent.
 * Polls messages.db for incoming tasks, executes them via claude --print,
 * writes heartbeat, and checkpoints state.
 *
 * This is an OPT-IN ADDITION to spawn-on-demand, NOT a replacement.
 *
 * Usage: bun AgentDaemon.ts --agent jelena [--model opus]
 */

import { parseAgentOutput, renderMinimal, zavrsioZavrsila } from './AgentOutputParser'
import { Database } from 'bun:sqlite'
import { existsSync, readFileSync, writeFileSync, unlinkSync, appendFileSync } from 'fs'
import { join } from 'path'
import { isNonActionableMessage, isSchedulerNotification } from './DispatchGuard'
import { SendBreaker, formatAlarm } from './SendBreaker'
// DUR-5/TASK-3597: osigurač na vratima SPAWNOVA (SendBreaker stoji na vratima poruka)
// + jitter na odgodi, da radnici koji padnu na istom rate-limitu ne krenu natrag u koraku.
import { SpawnBreaker, classifySpawnFailure, formatSpawnAlarm } from './SpawnBreaker'
import { TokenBucket } from './TokenBucket'
import { jitteredDelay, formatDelay, formatRetryCheckpoint, DEFAULT_RETRY_BASE_MS } from './Backoff'
import { isEnabled } from './FeatureFlags'
import {
  watchEarlyWork, countModelSteps, transcriptPathForSession, recordEarlyWork,
} from './EarlyWorkGuard'
import { buildIdentityBlock, resolveKnowledgePaths } from './IdentityBlock'
// TASK-3669 (ADR-0004 O2 st. 6 i 9, O3): isti sastavljač verifikacijskih odsjeka kao u
// RegocDaemonu — trajni radnik dijeli isti manjak, pa mora dijeliti i isti izvor teksta.
import { buildLiveVerificationBlock } from './SpawnVerificationBlock'
// I6/TASK-3655: vlastita RAG kolekcija agenta (samo ako postoji u ChromaDB-u).
import { knownCollections } from './RagCollections'
import { ragEnvFromPrompt } from './SpawnRagEnv'
// P5c/TASK-2584: pravilo „samo nadolje" je jedno i dijeli se s planerom razlaganja.
import { clampModelDownward } from './TaskDecomposer'
import {
  buildHeartbeat,
  isStaleMessage,
  messageAgeHours,
  rollDailyCounter,
  localDayKey,
  STALE_INBOX_MAX_AGE_H
} from './AgentHeartbeat'
import { selectResumableCheckpoint } from './AgentResume'
// K7/TASK-2986: potrošnja po zadatku uživo (cost_log + data/run_log.jsonl).
import { parseSpawnOutput, readSessionPercent, recordSpawn } from './SpawnTelemetry'
// Z3/TASK-3013: projekt zadatka u promptu (uputa u zajedničkom dijelu, vrijednost NA KRAJU).
import { buildProjectTail, projectProtocolInstruction } from './PromptProjectBlock'
// P3/TASK-2569 (s5): recept po tieru za slabe modele — iza flaga `tierRecipesEnabled`.
import { getRecipe } from './TierRecipes'
// R2/TASK-4309: istraživački zadatak nosi obvezan izlaz koraka 2 — dokument u RAG-u.
import { buildResearchStepBlock, loadResearchGateConfig } from './ResearchRagGate'
import { getModeClassifier, type EffortTier } from './ModeClassifier'
import { blokShemeKoraka } from './StepSchema'
// ADR-0012 (TASK-4827): status zadatka na durabilnom putu vodi DAEMON, ne agent.
// `AgentDaemon` do 12.09.2026. nije imao NIJEDAN PUT — agentov vlastiti poziv bio je
// jedino što je pomicalo status. Uklanjanje te upute iz prompta bez ovog zatvarača
// ostavilo bi SVAKI zadatak durabilnog tima zauvijek u `in_progress` (ADR-0012 §3.1).
// Pipeline (kritičar → vratari → zapis) je zajednički s RegocDaemonom: SpawnFinalizer.
import { postaviUProgress, finalizirajSpawn } from './SpawnFinalizer'
import { uzmiNajam, pustiNajam } from './TaskCloser'
import { homedir } from 'os'

// ─── Configuration ──────────────────────────────────────────────────
const HOME = process.env.HOME || homedir()
const REGOC_DIR = join(HOME, '.claude/regoc')
const DB_PATH = join(REGOC_DIR, 'messages.db')
const AGENTS_JSON = join(REGOC_DIR, 'REGOC_AGENTS.json')
const TASK_MANAGER_API = 'http://localhost:17781/api/tasks'
const MODE_FILE = join(HOME, '.tmp/regoc_mode.json')

const POLL_INTERVAL_MS = 2000       // Check inbox every 2s
const HEARTBEAT_INTERVAL_MS = 30000 // Write heartbeat every 30s
// F3/TASK-2583: parkirane (prestare) poruke — revizijski trag, nikad tiho brisanje.
const PARKED_INBOX_LOG = join(HOME, '.tmp/regoc_parked_inbox.jsonl')
const IDLE_POLL_INTERVAL_MS = 5000  // Slower poll when idle
const SIGNAL_CHECK_MS = 5000        // Check for stop signal every 5s

// ─── Types ──────────────────────────────────────────────────────────

type SystemMode = 'PLAN' | 'WORK'

interface AgentDaemonState {
  agentId: string
  model: string
  status: 'idle' | 'executing' | 'stopping'
  currentTaskId: string | null
  tasksCompleted: number
  startedAt: string
  lastTaskAt: string | null
  pid: number
  retryCount: number
  // R4/TASK-2564: heartbeat koji ne laže
  /** Broj isporuka DANAS (reset u ponoć) — `tasksCompleted` je kumulativan i maskira 0 isporuka. */
  tasksCompletedToday: number
  /** Lokalni dan za koji vrijedi `tasksCompletedToday`. */
  dayKey: string
  /** Kad je agent zadnji put STVARNO nešto isporučio (poslao odgovor). */
  lastDeliveredAt: string | null
}

interface InboxMessage {
  id: string
  from_agent: string
  content: string
  message_type: string
  priority: number
  metadata: string | null
  created_at: string
}

// ─── Logging ────────────────────────────────────────────────────────

const agentIdForLog = (() => {
  const idx = process.argv.indexOf('--agent')
  return idx !== -1 ? process.argv[idx + 1] : 'unknown'
})()

const LOG_FILE = join(HOME, `.tmp/agent_daemon_${agentIdForLog}.log`)

function log(msg: string): void {
  const ts = new Date().toISOString().substring(11, 19)
  const line = `[${ts}] ${msg}`
  console.log(line)
  try {
    appendFileSync(LOG_FILE, line + '\n')
  } catch {}
}

// ─── System Mode ────────────────────────────────────────────────────

function getSystemMode(): SystemMode {
  try {
    if (!existsSync(MODE_FILE)) return 'WORK'
    const data = JSON.parse(readFileSync(MODE_FILE, 'utf-8'))
    return data.mode === 'PLAN' ? 'PLAN' : 'WORK'
  } catch {
    return 'WORK'
  }
}

// ─── Core Class ─────────────────────────────────────────────────────

class AgentDaemon {
  private agentId: string
  private model: string
  private state: AgentDaemonState
  private running = true
  private db: Database
  private agentConfig: any
  /** I3/TASK-3652: cijeli registar (ne samo vlastiti zapis) — `IdentityBlock` cita i `rag_collections`. */
  private registry: any
  /** R5/TASK-2565: self-circuit-breaker na strani pošiljatelja (SQL, preživi restart). */
  private breaker: SendBreaker
  /** DUR-5/TASK-3597: osigurač na `claude --print` — dijeli stanje sa svim ostalim procesima. */
  private spawnBreaker: SpawnBreaker

  constructor(agentId: string, model?: string) {
    this.agentId = agentId
    this.db = new Database(DB_PATH)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.breaker = new SendBreaker(this.db, agentId, { logger: log })
    // DUR-5/TASK-3597: kanta ide na ISTU messages.db (WAL) pa je strop brzine zajednički
    // RegocDaemonu i svakom AgentDaemonu — jedan račun, jedan limit.
    this.spawnBreaker = new SpawnBreaker(this.db, { logger: log, bucket: new TokenBucket(DB_PATH) })

    // Load agent config from REGOC_AGENTS.json
    const registry = JSON.parse(readFileSync(AGENTS_JSON, 'utf-8'))
    this.registry = registry
    this.agentConfig = registry.agents[agentId]
    if (!this.agentConfig) throw new Error(`Agent ${agentId} not found in registry`)

    this.model = model || this.agentConfig.model || 'sonnet'

    this.state = {
      agentId,
      model: this.model,
      status: 'idle',
      retryCount: 0,
      currentTaskId: null,
      tasksCompleted: 0,
      startedAt: new Date().toISOString(),
      lastTaskAt: null,
      pid: process.pid,
      tasksCompletedToday: 0,
      dayKey: localDayKey(),
      lastDeliveredAt: null
    }
  }

  // ─── Main Loop ──────────────────────────────────────────────────

  async run(): Promise<void> {
    log(`AgentDaemon starting: ${this.agentId} (${this.model})`)

    // Ensure tables exist
    this.ensureCheckpointTable()

    // Try resume from checkpoint
    await this.tryResume()

    // Register as online
    this.updateAgentStatus('online')

    // Start heartbeat interval
    const heartbeatTimer = setInterval(() => this.writeHeartbeat(), HEARTBEAT_INTERVAL_MS)

    // Start signal check interval
    const signalTimer = setInterval(() => this.checkStopSignal(), SIGNAL_CHECK_MS)

    // Handle graceful shutdown
    process.on('SIGTERM', () => this.shutdown('SIGTERM'))
    process.on('SIGINT', () => this.shutdown('SIGINT'))

    try {
      while (this.running) {
        // 1. Check inbox for new messages
        const messages = this.pollInbox()

        if (messages.length > 0) {
          // Process highest-priority message first
          const msg = messages[0]
          await this.processMessage(msg)
        }

        // 2. Adaptive sleep: faster when active, slower when idle
        const sleepMs = this.state.status === 'executing'
          ? POLL_INTERVAL_MS
          : IDLE_POLL_INTERVAL_MS
        await Bun.sleep(sleepMs)
      }
    } finally {
      clearInterval(heartbeatTimer)
      clearInterval(signalTimer)
      this.updateAgentStatus('offline')
      this.db.close()
      log(`AgentDaemon stopped: ${this.agentId}`)
    }
  }

  // ─── Inbox Polling ──────────────────────────────────────────────

  private pollInbox(): InboxMessage[] {
    try {
      const stmt = this.db.prepare(`
        SELECT id, from_agent, content, message_type, priority, metadata, created_at
        FROM messages
        WHERE to_agent = ?
          AND status = 'pending'
          AND (expires_at IS NULL OR expires_at > datetime('now'))
          AND message_type IN ('text', 'command', 'direct_ask', 'help_request', 'chain_next')
        ORDER BY priority ASC, created_at ASC
        LIMIT 5
      `)
      return stmt.all(this.agentId) as InboxMessage[]
    } catch (e) {
      log(`pollInbox error: ${e}`)
      return []
    }
  }

  // ─── Message Processing ─────────────────────────────────────────

  private async processMessage(msg: InboxMessage): Promise<void> {
    // GUARD: refuse to spend a `claude --print` run on a non-actionable message.
    // AgentDaemon is an INDEPENDENT consumer of messages.db — the DispatchGuard
    // wired into TaskWebUI/RegocDaemon does NOT cover this path, so a recycled
    // agent report OR a daemon lifecycle notice (agent-started / agent-finished /
    // delegation-blocked) inserted into the inbox as a 'text' message would
    // otherwise be executed as if it were a task — the documented echo loop.
    // Drop it here, at the point of resource spend, without executing or
    // propagating a response.
    // TASK-4752: isti sud i ovdje — AgentDaemon je drugi potrošač istog reda, a
    // scheduler šalje `AUTO-START: TASK-F8-…` RAVNO assigneeju kao 'command'
    // (33 poruke u messages.db, metadata.type='task_assignment'). Bez ovoga bi
    // radnik trošio Opus sesiju na zadatak koji u bazi ne postoji (TASK-F8-* živi
    // samo u IMPLEMENTATION-MASTER.md).
    const schedulerNotice = isSchedulerNotification(msg)
    if (schedulerNotice || isNonActionableMessage(msg.content)) {
      const razlog = schedulerNotice
        ? 'scheduler notice (task_completion / AUTO-START) — not a task spec'
        : 'non-actionable message (recycled report or lifecycle notice) — not a task spec'
      this.db.run(
        `UPDATE messages SET status = 'completed', response = ?, processed_at = datetime('now') WHERE id = ?`,
        [`skipped: ${razlog}`, msg.id]
      )
      log(`🛑 NOT executing message ${msg.id} from ${msg.from_agent}: ${razlog}`)
      return
    }

    // GUARD (F3/TASK-2583): prestara poruka se NE izvršava automatski.
    // Bez ovoga `start-team` na agentu sa zaostalim inboxom (jelena: 4 poruke
    // stare 9–14 dana) na prvom poll-u pretvara davno prevaziđene zahtjeve u
    // žive Opus sesije i odgovara korisniku na nešto što je odavno prošao.
    // Poruka se PARKIRA (status 'expired' + revizijski zapis), nikad ne briše.
    // Rollback: flag `staleInboxGuard` = false → stari put (izvrši sve).
    if (isEnabled('staleInboxGuard', true) && isStaleMessage(msg.created_at)) {
      this.parkStaleMessage(msg)
      return
    }

    // Mark message as processing
    this.db.run(
      `UPDATE messages SET status = 'processing', processed_at = datetime('now') WHERE id = ?`,
      [msg.id]
    )

    this.state.status = 'executing'
    const adrTaskId = this.extractTaskId(msg)
    this.state.currentTaskId = adrTaskId || msg.id
    // ADR-0012 §4.3: `in_progress` postavlja SUSTAV pri pokretanju, ne agent. Prije ove
    // izmjene durabilni put nije imao nijedan PUT — zadatak je stajao `pending` dok se na
    // njemu radilo (točno ono što CLAUDE.md 12 zabranjuje), osim ako ga agent sam pomakne.
    this.najamTaskId = adrTaskId
    if (adrTaskId) {
      const up = await postaviUProgress(TASK_MANAGER_API, adrTaskId, { log })
      if (!up.ok) log(`⚠️ ${adrTaskId}: in_progress nije zapisan (HTTP ${up.httpStatus ?? 'n/a'}) — nastavljam, status vodi zatvarač`)
    }
    // R4/TASK-2564: heartbeat na PRIJELAZU stanja, ne samo na 30s timeru.
    // Bez ovoga posao kraći od intervala (pilot 2026-07-28: 19s) nikad ne
    // upadne u uzorak — promatrač vidi „idle" i taskRef=null dok agent radi.
    this.writeHeartbeat()

    // Save checkpoint: STARTING task
    this.saveCheckpoint('STARTING', msg.content.substring(0, 500))

    log(`Processing message from ${msg.from_agent}: ${msg.content.substring(0, 100)}...`)

    try {
      // Build prompt with AgentFactory context + mode awareness
      // Z3/TASK-3013: projekt se dohvaća prije gradnje prompta (HTTP), pa ide kao gotov odjeljak.
      // P3/TASK-2569 (s5): tier se dohvaća SAMO iza flaga — kad je isključen, nema
      // dodatnog HTTP poziva i prompt je bajt-identičan starom ponašanju.
      const effortTier = isEnabled('tierRecipesEnabled')
        ? await this.resolveEffortTier(this.extractTaskId(msg))
        : null
      const prompt = this.buildPrompt(msg, (await this.resolveProjectTail(msg)) + (await this.researchStepTail(msg)), effortTier)

      // F2: Check if this is a resume message with session_id in metadata
      let resumeSessionId: string | undefined
      if (msg.metadata) {
        try {
          const meta = JSON.parse(msg.metadata)
          if (meta.sessionId) {
            resumeSessionId = meta.sessionId
            log(`📎 Resume message carries session_id: ${resumeSessionId}`)
          }
        } catch {}
      }
      // Also use in-memory lastSessionId if available (from tryResume)
      if (!resumeSessionId && this.lastSessionId) {
        resumeSessionId = this.lastSessionId
        this.lastSessionId = null  // Use only once
      }

      // Execute via claude --print (with --resume if session_id available)
      const runModel = this.resolveMessageModel(msg)
      if (runModel !== this.model) log(`⤵️ tier podzadatka iz poruke: ${this.model} → ${runModel} (samo nadolje)`)
      // ADR-0012: granica „što je ovaj spawn dirao" — ulaz kritičaru (`sinceMs`).
      const adrPocetakMs = Date.now()
      const result = await this.executeClaudeTask(prompt, resumeSessionId, runModel)

      // ADR-0012 §20 (mjera A): zatvaranje ide kroz ZAJEDNIČKI pipeline s RegocDaemonom —
      // sud CompletionGuarda, sud nezavisnog kritičara, pred-provjera vratara, pa zapis.
      // Zatvarač BEZ suca (§20 C) vratio bi rupu iz §1 s drugim potpisom, zato je kritičar
      // dio istog poziva, a ne nešto što bi se ovdje moglo zaboraviti.
      if (adrTaskId) {
        const ishod = await finalizirajSpawn({
          apiBase: TASK_MANAGER_API, taskId: adrTaskId, agentId: this.agentId,
          resultText: result, sinceMs: adrPocetakMs, log,
        })
        log(`📊 ${adrTaskId} → ${ishod.status}${ishod.razlog ? ` (${ishod.razlog.slice(0, 120)})` : ''}`)
      }

      // Mark message as completed
      this.db.run(
        `UPDATE messages SET status = 'completed', response = ? WHERE id = ?`,
        [result.substring(0, 4000), msg.id]
      )

      // Send result back to sender
      this.sendResponse(msg.from_agent, result, msg)

      // Save checkpoint: COMPLETED task
      this.saveCheckpoint('COMPLETED', result.substring(0, 2000))

      this.state.tasksCompleted++
      this.rollDay()
      this.state.tasksCompletedToday++
      this.state.lastTaskAt = new Date().toISOString()

      log(`Task completed (total: ${this.state.tasksCompleted})`)

      // Auto-report to Telegram after completing work
      // TASK-4815: `substring(0, 200)` je rezao nasred zaglavlja; sada isti parser i
      // isti prikaz kao na svim ostalim kanalima. Popis rodova preseljen u parser.
      const agentName = this.agentConfig?.name || this.agentId
      this.sendTelegramStatus(renderMinimal(parseAgentOutput(result), {
        heading: `${agentName} ${zavrsioZavrsila(this.agentId)} zadatak:`,
        maxLen: 600,
      }))

    } catch (error: any) {
      log(`Task failed: ${error.message}`)

      // Mark message as failed
      this.db.run(
        `UPDATE messages SET status = 'failed', error = ? WHERE id = ?`,
        [error.message, msg.id]
      )

      // Notify sender of failure — use agent_error type so daemon doesn't re-delegate
      this.sendResponse(
        msg.from_agent,
        `❌ Agent ${this.agentId} neuspješan: ${error.message}`,
        msg,
        'agent_error'
      )

      // Save checkpoint: FAILED
      this.saveCheckpoint('FAILED', error.message)

      // ADR-0012: pod (B) status vodi daemon — neuspjeh spawna koji se NE zapiše ostavlja
      // zadatak zauvijek u `in_progress` (baseline 12.09.2026: 0 zadataka > 6 h, mora ostati 0).
      if (adrTaskId) {
        try {
          const ishod = await finalizirajSpawn({
            apiBase: TASK_MANAGER_API, taskId: adrTaskId, agentId: this.agentId,
            resultText: `BLOCKED: spawn nije uspio — ${error.message}`,
            sinceMs: Date.now(), log,
          })
          log(`📊 ${adrTaskId} → ${ishod.status} (neuspjeh spawna)`)
        } catch (e) { log(`⚠️ ${adrTaskId}: ishod neuspjeha nije zapisan (${e})`) }
      }
    }

    // Najam vrijedi SAMO dok spawn traje; ostatak čisti `pocistiNajmove` po mrtvom pidu.
    if (this.najamTaskId) { pustiNajam(this.najamTaskId); this.najamTaskId = null }

    this.state.status = 'idle'
    this.state.currentTaskId = null
    // R4: odmah objavi povratak u idle (i osvježeni dnevni brojač).
    this.writeHeartbeat()
  }

  /**
   * F3/TASK-2583: makni prestaru poruku iz reda BEZ izvršavanja i BEZ tihog
   * gubitka — 'expired' + razlog u `response` + redak u PARKED_INBOX_LOG, da
   * čovjek može odlučiti treba li išta od toga još.
   */
  private parkStaleMessage(msg: InboxMessage): void {
    const ageH = messageAgeHours(msg.created_at)
    const reason = `parked: poruka stara ${ageH.toFixed(1)}h (>${STALE_INBOX_MAX_AGE_H}h) — nije izvršena automatski (F3/TASK-2583). Za ponovno slanje: novi zahtjev.`
    try {
      this.db.run(
        `UPDATE messages SET status = 'expired', response = ?, processed_at = datetime('now') WHERE id = ?`,
        [reason, msg.id]
      )
    } catch (e) {
      log(`parkStaleMessage DB greška: ${e}`)
    }
    try {
      appendFileSync(PARKED_INBOX_LOG, JSON.stringify({
        ts: new Date().toISOString(),
        agent: this.agentId,
        messageId: msg.id,
        from: msg.from_agent,
        createdAt: msg.created_at,
        ageHours: Number(ageH.toFixed(1)),
        preview: msg.content.substring(0, 300)
      }) + '\n')
    } catch {}
    log(`🅿️ PARKIRANA prestara poruka ${msg.id} od ${msg.from_agent} (${ageH.toFixed(1)}h) — nije izvršena`)
  }

  // ─── Claude Execution ──────────────────────────────────────────

  // F2: Track session ID from last successful run for --resume on retry
  private lastSessionId: string | null = null
  /** ADR-0012: TASK-id na kojem trenutno radi spawn — najam se uzima tek kad je pid poznat. */
  private najamTaskId: string | null = null

  /**
   * P5c/TASK-2584: podzadatak razloženog posla nosi svoj tier u `metadata.model`.
   * Bez ovoga durabilni radnik vozi SVOJ model za svaki korak, pa razlaganje ne
   * bi ni smanjilo trošak — jelena bi i mehanički korak radila na opusu.
   *
   * Pravilo je isto kao u `TaskTier`: SAMO NADOLJE. Promašen downgrade košta jedan
   * ponovni pokušaj; promašen upgrade troši bez gornje granice. Nepoznata vrijednost
   * = agentov model (današnje ponašanje), nikad iznenađenje.
   */
  private resolveMessageModel(msg: InboxMessage): string {
    try {
      if (!msg.metadata) return this.model
      return clampModelDownward((JSON.parse(msg.metadata) || {}).model, this.model)
    } catch { return this.model }
  }

  private async executeClaudeTask(prompt: string, resumeSessionId?: string, modelOverride?: string): Promise<string> {
    const runModel = modelOverride || this.model
    const cmdArgs = [
      'claude', '--print',
      '--dangerously-skip-permissions',
      '--output-format', 'json',
      '--model', runModel,
    ]

    // F2: If we have a session ID from a previous attempt, use --resume
    // M6/TASK-4626: sonda „ima li posla" traži transkript koji KREĆE PRAZAN. Kod `--resume`
    // transkript već nosi korake prethodnog pokušaja, pa bi sonda odmah vidjela „radi" —
    // zato se na toj grani ne uključuje (fail-open, nikad lažni prekid).
    let ewSessionId: string | null = null
    if (resumeSessionId) {
      cmdArgs.push('--resume', resumeSessionId)
      log(`🔄 Using --resume ${resumeSessionId} for context continuity`)
    } else {
      ewSessionId = crypto.randomUUID()
      cmdArgs.push('--session-id', ewSessionId)
    }

    // I3/TASK-3652: isti blok identiteta kao u RegocDaemonu (I2), isti flagovi. Trajni
    // radnik vrti VISE zadataka po procesu, pa bi bez ovoga cijeli taj put ostao na
    // starome kanalu. Flag OFF → naredba bajt-identicna starome putu.
    if (isEnabled('agentIdentityBlock')) {
      try {
        // I6/TASK-3655: isti popis potvrđenih kolekcija kao u RegocDaemonu (I2).
        const blok = buildIdentityBlock(this.agentId, this.registry, { ragCollections: knownCollections() })
        if (!blok) {
          log(`👁️ [identitet] ${this.agentId}: nema zapisa u registru — blok se ne salje`)
        } else if (isEnabled('agentIdentityBlockLive')) {
          // I9/TASK-3658: ista zabrana kao u RegocDaemonu — PLAN mod mora stići kanalom
          // koji je barem jednako jak kao onaj kojim stižu naredbodavne rečenice bloka.
          const blokZaSlanje = getSystemMode() === 'PLAN'
            ? `${blok}\n\n### PLAN MOD JE AKTIVAN — NADREĐEN SVEMU GORE\nOvo je plan-only sesija. Gornje upute govore ČIME raspolažeš, NE da to sada pokreneš.\nNE izvršavaj, ne mijenjaj datoteke, ne pokreći alate koji mijenjaju stanje — samo planiraj.`
            : blok
          cmdArgs.push('--append-system-prompt', blokZaSlanje)
          log(`🪪 [identitet] ${this.agentId}: blok ${blok.length} zn. → sistemski kanal`)
        } else {
          log(`👁️ [identitet SHADOW] ${this.agentId}: blok ${blok.length} zn. spreman, NE salje se`)
        }
      } catch (e) { log(`⚠️ [identitet] ${this.agentId}: blok nije sastavljen (${e}) — spawn ide bez njega`) }
    }

    cmdArgs.push('-p', prompt)

    // CRITICAL: Remove CLAUDECODE env vars to prevent nested session error
    const execEnv: Record<string, string> = {
      PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
      HOME,
      USER: process.env.USER || 'klaudio',
      SHELL: process.env.SHELL || '/bin/bash',
      TERM: 'xterm-256color',
      REGOC_AGENT_ID: this.agentId,
      BUN_INSTALL: process.env.BUN_INSTALL || join(HOME, '.bun'),
      CLAUDE_SUBAGENT: '1',
      CLAUDE_CODE_TMPDIR: join(HOME, '.tmp/claude-tmp'),
      // R1b/TASK-4431: pripis RAG upisa (task/projekt) — `lib/rag-metadata.ts` ih čita kao
      // zamjenu za `--task`/`-p`. Durabilni put nema `taskId` u potpisu, pa se čita iz
      // prompta koji ga doslovno nosi (v. SpawnRagEnv.ts).
      ...ragEnvFromPrompt(prompt),
    }

    // DUR-5/TASK-3597: osigurač na SPAWNU. Rate-limit se događa točno ovdje, na
    // `claude --print`, pa se ovdje i provjerava — ne na kanalu poruka. Kad je otvoren,
    // spawn se NE pokreće; razlog ide u dnevnik i u iznimku (poziv se u catchu označava
    // 'failed' i NE re-delegira, pa nema echo-petlje).
    const gate = this.spawnBreaker.check(this.agentId)
    if (!gate.allowed) {
      if (gate.alarm) log(formatSpawnAlarm(this.agentId, gate))
      throw new Error(`SPAWN-BREAKER: spawn odbijen — ${gate.reason}`)
    }
    if (gate.wouldBlock) log(`👁️ [spawn-breaker SHADOW] ${this.agentId}: ${gate.reason}`)

    // K7/TASK-2986: potrošnja sesije prije spawna (keš hookova, bez mrežnog probea).
    const sessionPercentBefore = readSessionPercent()
    const startedAtMs = Date.now()

    const proc = Bun.spawn(cmdArgs, {
      cwd: HOME,
      stdout: 'pipe',
      stderr: 'pipe',
      env: execEnv
    })

    // ADR-0012 §14 (G3): najam se uzima TEK kad je pid poznat. `najamAktivan()` traži
    // živ PID (platforma.ziv), pa bi najam uzet prije spawna bio mrtav kod koji nikad ne okine.
    if (this.najamTaskId) {
      uzmiNajam({ taskId: this.najamTaskId, agent: this.agentId, pid: proc.pid, startedAt: new Date().toISOString() })
    }

    // M6/TASK-4626: rana provjera „ima li uopće posla" — 0 modelskih koraka nakon 30 s znači
    // da spawn nema što raditi, a `num_turns` bi to rekao tek na kraju (medijan neuspjeha
    // 402 s). Sonda je fire-and-forget i FAIL-OPEN: bez transkripta se ne prekida ništa.
    if (ewSessionId && isEnabled('earlyWorkGuard', false)) {
      const ewLive = isEnabled('earlyWorkGuardLive', false)
      const ewStartedAt = Date.now()
      const ewSid = ewSessionId
      const ewPath = () => transcriptPathForSession(HOME, ewSid)
      void watchEarlyWork({
        now: () => Date.now(),
        sleep: (ms) => new Promise(r => setTimeout(r, ms)),
        countSteps: () => countModelSteps(ewPath()),
        isAlive: () => { try { process.kill(proc.pid, 0); return true } catch { return false } },
      }, { startedAtMs: ewStartedAt }).then(verdict => {
        if (verdict.action !== 'abort') return
        const elapsedS = Math.round((Date.now() - ewStartedAt) / 1000)
        recordEarlyWork({
          ts: new Date().toISOString(), mode: ewLive ? 'live' : 'shadow', agent: this.agentId,
          task_id: this.state.currentTaskId || null, session_id: ewSid, pid: proc.pid,
          elapsed_s: elapsedS, model_steps: countModelSteps(ewPath()),
          action: 'abort', reason: verdict.reason, final_num_turns: null,
        })
        if (ewLive) {
          log(`⛔ [M6] ${this.agentId}: ${verdict.reason} — prekidam spawn pid=${proc.pid} nakon ${elapsedS}s`)
          try { proc.kill() } catch {}
        } else {
          log(`👁️ [M6 SHADOW] ${this.agentId}: ${verdict.reason} — spawn bi bio prekinut nakon ${elapsedS}s (earlyWorkGuardLive=false)`)
        }
      }).catch(e => log(`⚠️ [M6] ${this.agentId}: sonda pala (${e}) — spawn nastavlja nedirnut`))
    }

    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    const exitCode = await proc.exited

    // F2: Parse JSON output to extract session_id and result text
    // K7: isti parser kao RegocDaemon (SpawnTelemetry) — jedan izvor istine za omotnicu.
    const envelope = parseSpawnOutput(stdout)
    const resultText = envelope.resultText
    const sessionId: string | null = envelope.sessionId
    if (sessionId) {
      this.lastSessionId = sessionId
      log(`📎 Captured session_id: ${sessionId}`)
    }
    if (!envelope.parsed) {
      log(`⚠️ Could not parse JSON output, using raw stdout (${envelope.parseNote || 'nepoznato'})`)
    }

    // K7: jedan redak po POKUŠAJU — svaki `claude --print` troši tokene, pa i onaj koji
    // se kasnije ponovi s `--resume`. Telemetrija se piše prije retry grane da se ne izgubi.
    // `num_turns === 0` je jedini pouzdan potpis blokade uz `--output-format json`
    // (exit 0, is_error:false, subtype:"success"), pa ga klasifikator dobiva izričito.
    const { classifySpawnOutcome } = await import('./HookBlockGuard')
    const spawnOutcome = classifySpawnOutcome(exitCode, resultText, stderr, { numTurns: envelope.numTurns })
    try {
      const entry = recordSpawn({
        agentId: this.agentId,
        taskId: this.state.currentTaskId || null,
        requestedModel: runModel,
        provider: 'anthropic',
        exitCode,
        outcome: spawnOutcome.kind,
        startedAtMs,
        envelope,
        sessionPercentBefore,
        sessionPercentAfter: readSessionPercent(),
      })
      const t = entry.tokens
      log(`📊 ${this.agentId} ${entry.task_id || 'bez-zadatka'} ${entry.outcome} — izlaz ${t.out}, ulaz ${t.in}, cache R ${t.cache_r}/W ${t.cache_w}, ${entry.cost_usd.toFixed(4)} USD (${entry.cost_source}), ${entry.duration_s}s`)
    } catch (e) {
      log(`⚠️ Telemetrija spawna nije zapisana: ${e}`)
    }

    if (exitCode !== 0) {
      // DUR-5/TASK-3597: kvar spawna se knjiži u osigurač. ODBIJENICA (429/usage limit/
      // preopterećenje) se broji (fail-CLOSED); nepoznata greška ne (fail-OPEN) — ne
      // zatvaramo vrata na nagađanje.
      const fail = classifySpawnFailure(exitCode, stderr, resultText)
      this.spawnBreaker.recordFailure(this.agentId, fail.kind, fail.reason)

      // Retry with backoff: wait ~30min then try again (session limit may have reset).
      // DUR-5/TASK-3597: razmak više NIJE tvrdih 30 min. Tri radnika koja padnu na istom
      // rate-limitu su se dosad vraćala u ISTOJ sekundi i obarala ga ponovno; sada svaki
      // izvlači vlastiti razmak iz [15 min, 30 min] — gornja granica ostaje 30 min.
      const MAX_RETRIES = 2
      const RETRY_BASE_MS = DEFAULT_RETRY_BASE_MS   // 30 minutes (osnovica, ne fiksna odgoda)
      const retryCount = this.state.retryCount || 0

      if (retryCount < MAX_RETRIES) {
        this.state.retryCount = retryCount + 1
        const retryDelayMs = jitteredDelay(RETRY_BASE_MS)
        log(`⏳ claude --print exit ${exitCode} (attempt ${retryCount + 1}/${MAX_RETRIES + 1}). Čekam ${formatDelay(retryDelayMs)} (jitter, osnovica ${formatDelay(RETRY_BASE_MS)}) prije ponovnog pokušaja...`)
        // F2: Save session_id in checkpoint so retry can --resume
        // DUR-5: u checkpoint ide IZABRANI razmak (strojno čitljivo `jitter=<ms>ms`) —
        // bez toga se raspršenje ne može izmjeriti poslije.
        this.saveCheckpoint('WAITING_RETRY', formatRetryCheckpoint(exitCode, retryCount + 1, retryDelayMs, RETRY_BASE_MS), sessionId || this.lastSessionId || undefined)
        await new Promise(resolve => setTimeout(resolve, retryDelayMs))

        // F2: On retry, use --resume with session_id from failed attempt
        const retrySessionId = sessionId || this.lastSessionId || this.loadLastSessionId()
        log(`🔄 Retrying claude --print (attempt ${retryCount + 2}/${MAX_RETRIES + 1})${retrySessionId ? ` with --resume ${retrySessionId}` : ''}...`)
        return this.executeClaudeTask(prompt, retrySessionId || undefined, modelOverride)
      }

      this.state.retryCount = 0
      throw new Error(`claude --print exit ${exitCode} after ${MAX_RETRIES + 1} attempts: ${stderr.substring(0, 500)}`)
    }

    // F2: Save session_id in checkpoint on success
    if (sessionId) {
      this.saveCheckpoint('SESSION_CAPTURED', `session_id=${sessionId}`, sessionId)
    }

    // TASK-2953: exit 0 nije dokaz da je model odgovorio. Kad hook blokira ulaz
    // (session_usage.py na UserPromptSubmit), CLI ispise poruku blokade i izade s 0.
    // Bez ovog gatea poruka se oznacavala completed, slala se na Telegram kao
    // "<agent> zavrsio task: <poruka blokade>" i spremala kao COMPLETED checkpoint.
    if (spawnOutcome.kind === 'blocked') {
      const blk = spawnOutcome.block
      // DUR-5/TASK-3597: blokada ulaza je ODBIJENICA — CLI je izašao s 0, ali model nije
      // napravio ni jedan korak. Ponovni pokušaj s istim ulazom pada isto (budžet sesije
      // traje do resetiranja), pa se broji fail-CLOSED, isto kao 429.
      this.spawnBreaker.recordFailure(this.agentId, 'rejected', `hook ${blk.code}${blk.hookEvent ? `/${blk.hookEvent}` : ''}`)
      this.state.retryCount = 0
      // Baci → postojeci catch put oznacava poruku 'failed' i salje agent_error
      // (koji se ne re-delegira). Poruka NE nosi vraceni prompt.
      throw new Error(`${blk.hookEvent ? `Hook '${blk.hookEvent}'` : 'Ulaz'} blokirao spawn (${blk.code}) — agent nije zapoceo rad: ${blk.reason}`)
    }

    // DUR-5/TASK-3597: uspješan spawn dokazuje da račun radi → niz uzastopnih odbijenica
    // se briše (i agentov i globalni osigurač).
    this.spawnBreaker.recordSuccess(this.agentId)
    this.state.retryCount = 0
    return resultText
  }

  /**
   * F2: Load the most recent session_id from checkpoints for this agent+task.
   * Used as fallback when in-memory lastSessionId is lost (e.g. daemon restart).
   */
  private loadLastSessionId(): string | null {
    try {
      const row = this.db.query(`
        SELECT session_id
        FROM agent_checkpoints
        WHERE agent_id = ?
          AND task_id = ?
          AND session_id IS NOT NULL
        ORDER BY created_at DESC
        LIMIT 1
      `).get(this.agentId, this.state.currentTaskId) as any
      return row?.session_id || null
    } catch {
      return null
    }
  }

  // ─── Prompt Building ───────────────────────────────────────────

  /**
   * Z3/TASK-3013: projekt zadatka za završni odjeljak prompta.
   * Prvo metadata spawn-lanca (bez HTTP-a), pa TaskManager. Tiho vraća prazno —
   * prompt bez projekta je stari, već keširani oblik, ne kvar.
   */
  private async resolveProjectTail(msg: InboxMessage): Promise<string> {
    let projectId: string | null = null
    if (msg.metadata) {
      try {
        const meta = JSON.parse(msg.metadata)
        projectId = meta.projectId ?? meta.project_id ?? null
      } catch {}
    }
    const taskId = this.extractTaskId(msg)
    if (!projectId && taskId) {
      try {
        const res = await fetch(`${TASK_MANAGER_API}/${taskId}`)
        if (res.ok) {
          const t = await res.json() as any
          projectId = t?.projectId ?? t?.project_id ?? null
        }
      } catch {}
    }
    return buildProjectTail(projectId)
  }

  /**
   * R2/TASK-4309: obvezan izlaz koraka 2 (istraživanje → dokument u RAG-u) za zadatke
   * s oznakom `istrazivanje`. Neoznačen zadatak (i isključen flag) daje '' ⇒ prompt je
   * bajt-identičan starome putu. Ide u tail, iza projekta, isti obrazac kao prihvatni
   * kriteriji u `RegocDaemon` auto-execu — vratar u TaskWebUI-ju traži isto pravilo,
   * pa agent mora dobiti uputu PRIJE nego što na nju naleti pri zatvaranju.
   */
  private async researchStepTail(msg: InboxMessage): Promise<string> {
    try {
      const cfg = loadResearchGateConfig()
      if (!cfg.enabled || !cfg.promptStep) return ''
      const taskId = this.extractTaskId(msg)
      if (!taskId) return ''
      const res = await fetch(`${TASK_MANAGER_API}/${taskId}`)
      if (!res.ok) return ''
      const t = await res.json() as any
      return buildResearchStepBlock({
        id: taskId,
        tags: Array.isArray(t?.tags) ? t.tags : [],
        projectId: t?.projectId ?? t?.project_id ?? null,
      })
    } catch { return '' }
  }

  /**
   * P3/TASK-2569 (s5): AgentDaemon ne prati EffortTier (E1-E5) nigdje u poruci —
   * `resolveMessageModel` zna samo ModelTier (`--model`, npr. "sonnet"), koji je
   * druga ljestvica. Jedini izvor je zapis zadatka preko TaskManager API-ja:
   * eksplicitna oznaka `tier:E1..E5` na zadatku ima prednost; bez nje se tier
   * IZVODI istim `ModeClassifier`-om kao RegocDaemon (čista funkcija, bez spawn-a).
   * NIKAD ne baca — nepostojeći taskId, pao fetch ili zadatak bez naslova/opisa
   * vraćaju `null`, a pozivatelj tada preskače ubacivanje recepta bez pada.
   */
  private async resolveEffortTier(taskId: string | null): Promise<EffortTier | null> {
    if (!taskId) return null
    try {
      const res = await fetch(`${TASK_MANAGER_API}/${taskId}`)
      if (!res.ok) return null
      const t = await res.json() as any
      const tags: string[] = Array.isArray(t?.tags) ? t.tags.map(String) : []
      for (const tag of tags) {
        const m = tag.match(/^tier:(E[1-5])$/i)
        if (m) return m[1].toUpperCase() as EffortTier
      }
      // Bez oznake se tier IZVODI iz teksta zadatka — ali samo ako teksta STVARNO ima.
      // ModeClassifier za prazan naslov+opis vraca E1 ("Minimal effort: 0 chars"), a
      // recept E1 agentu kaze "odgovori izravno, BEZ izvodenja akcija". Degradiran
      // odgovor API-ja (stub zapis, promijenjena shema, ne-objekt) tako bi tiho
      // pretvorio pravi zadatak u "ne radi nista" — sto je gore od preskakanja.
      // Zato: nema upotrebljivog teksta ⇒ tier je NEPOZNAT ⇒ null ⇒ pozivatelj
      // preskace ubacivanje recepta (ugovor iz opisa koraka: "ako ga nema — preskoci").
      const title = typeof t?.title === 'string' ? t.title : ''
      const description = typeof t?.description === 'string' ? t.description : ''
      if (!title.trim() && !description.trim()) return null
      const cls = getModeClassifier().classify({ title, description, tags })
      return cls?.effort ?? null
    } catch {
      return null
    }
  }

  private buildPrompt(msg: InboxMessage, projectTail: string = '', effortTier: EffortTier | null = null): string {
    const name = this.agentConfig.name || this.agentId
    const role = this.agentConfig.role || 'Agent'
    const style = this.agentConfig.communication_style || ''
    const taskId = this.extractTaskId(msg)
    const mode = getSystemMode()

    let prompt = `# Ti si ${name} - ${role}\n`
    prompt += `**Komunikacijski stil:** ${style}\n\n`

    // ─── Mode Section (BEFORE task) ───
    prompt += `## SYSTEM MODE: ${mode}\n`
    if (mode === 'PLAN') {
      prompt += `**PLAN MOD JE AKTIVAN. STROGU ZABRANU POSTUJ:**\n\n`
      prompt += `NE SMIJES:\n`
      prompt += `- Pisati/mijenjati/kreirati fajlove (Edit, Write, Bash write operacije)\n`
      prompt += `- Deployati, restartati, pokretati servise\n`
      prompt += `- Slati poruke van sustava (Telegram, email, Git push)\n`
      prompt += `- Pokretati komande koje mijenjaju stanje sustava\n`
      prompt += `- Kreirati git commitove ili pushati\n\n`
      prompt += `SMIJES:\n`
      prompt += `- Citati fajlove (Read, Bash cat/head/less)\n`
      prompt += `- Pretrazivati (grep, find, RAG query)\n`
      prompt += `- Analizirati i planirati\n`
      prompt += `- Davati preporuke i prijedloge\n\n`
      prompt += `Tvoj output mora biti PLAN (sto bi napravio), NE implementacija.\n\n`
    } else {
      prompt += `Normalan rad. Izvrsi zadatak do kraja.\n\n`
    }

    // Include knowledge paths from agent config
    // I3/TASK-3652: putanje su se ispisivale SIROVO (`skills/CORE/CoreStack.md`), a spawn
    // ide s `cwd: HOME` — razrjesavale su se u `~/skills/...` i NIJEDNA nije
    // postojala. Sada ide isti resolver kao u RegocDaemonu (IdentityBlock.resolveKnowledgePaths),
    // i to samo putanje koje stvarno postoje: uputa koja ne moze uspjeti trosi povjerenje
    // u ostale upute istog prompta.
    if (this.agentConfig.required_knowledge && this.agentConfig.required_knowledge.length > 0) {
      const znanje = resolveKnowledgePaths(this.agentConfig.required_knowledge, HOME)
      const postoji = znanje.filter(z => z.exists)
      if (postoji.length > 0) {
        prompt += `## Znanje\nProcitaj ove fajlove ako su relevantni:\n`
        for (const z of postoji) prompt += `- ${z.path}\n`
        const nedostaje = znanje.length - postoji.length
        if (nedostaje > 0) prompt += `(${nedostaje} putanja iz registra ne postoji na disku i izostavljeno je.)\n`
        prompt += '\n'
      }
    }

    prompt += `## Zadatak\n`
    prompt += `Od: ${msg.from_agent}\n`
    prompt += msg.content + '\n\n'

    // TaskManager protocol
    if (taskId) {
      // ADR-0012 (TASK-4827): uputa „zovi PUT completed" je OVDJE bila jedini zivi izvor
      // te navike na durabilnom putu (GEMINI.md je nema, `grep -c completed` = 0). Agent je
      // zatvarao 5-80 s PRIJE suda kriticara, a `completed` je terminalno stanje pa daemonov
      // naknadni `blocked` vise nije prolazio: 6 od 6 zadataka s presudom FAIL stoji kao ✅.
      // Sada status vodi daemon (postaviUProgress + finalizirajSpawn), agent samo deklarira.
      prompt += `## TASKMANAGER PROTOCOL\n`
      prompt += `Tvoj task ID: ${taskId}\n`
      prompt += `Pri pocetku rada NE TREBA nista: sustav je zadatak stavio u in_progress kad te pokrenuo.\n\n`
      prompt += `Napredak (JEDINI PUT koji smijes zvati):\n`
      prompt += `curl -s -X PUT ${TASK_MANAGER_API}/${taskId} `
      prompt += `-H 'Content-Type: application/json' `
      prompt += `-d '{"progressNotes":["Opis napretka..."]}'\n\n`
      prompt += `## STATUS ZADATKA NE POSTAVLJAS TI\n`
      prompt += `NE zovi PUT sa status (completed, blocked, cancelled) - takav poziv sustav odbija.\n`
      prompt += `Status zatvara REGOC nakon sto nezavisni kriticar pokrene provjere nad onim sto si\n`
      prompt += `ostavio na disku. Tvoja presuda ide TEKSTOM, zadnjim retkom odgovora.\n`
      // TASK-2954 (D2): agenti su zatvarali nerjesive zadatke kao completed uz
      // result_summary koji doslovno kaze da posao nije napravljen. Pravilo je sada
      // i strojno provedeno (CompletionGuard -> HTTP 400), ali mora stajati i u promptu.
      prompt += `Ako NE mozes izvrsiti zadatak, NE deklariraj DONE (lazni check na ploci):\n`
      prompt += `- fali opis/kontekst: REGOC-STATUS: NEEDS_CONTEXT - <sto nedostaje>\n`
      prompt += `- fali alat/pristup:  REGOC-STATUS: BLOCKED - <sto nedostaje>\n`
      prompt += `DONE bez dokaza izvrsenja (naredba/datoteka/mjerenje/status) kriticar obara -> blocked.\n\n`
      // D6/TASK-2976: nazivi su camelCase; snake_case alias i dalje prolazi, ali izmisljeno
      // ime polja API sada odbija s HTTP 400 umjesto tihog 200 (sazetak vise ne nestaje).
      prompt += `Polja su camelCase (snake_case alias prolazi); nepoznato ime polja vraca HTTP 400.\n\n`
      // Z3/TASK-3013: uputa BEZ konkretne vrijednosti — ista za svaki spawn, pa keš-prefiks drži.
      // Sam projekt je na KRAJU prompta (v. PromptProjectBlock.ts).
      prompt += projectProtocolInstruction(TASK_MANAGER_API) + '\n\n'
      prompt += `## OBVEZAN ZADNJI REDAK ODGOVORA\n`
      prompt += `REGOC-STATUS: DONE|BLOCKED|NEEDS_CONTEXT - <razlog>\n`
      prompt += `Daemon cita tocno taj redak. Bez njega rad pada u "no-evidence" i zadatak se NE zatvara.\n\n`
    }

    // Heartbeat instruction
    const heartbeatFile = join(HOME, `.tmp/agent_heartbeat_${this.agentId}.json`)
    prompt += `## HEARTBEAT (svakih 60 min)\n`
    prompt += `echo '{"agent":"${this.agentId}","task":"${taskId || 'N/A'}",`
    prompt += `"ts":"'$(date -Iseconds)'","status":"working","brief":"<max 100 chars>"}' `
    prompt += `> ${heartbeatFile}\n\n`

    // Standard REGOC rules
    prompt += `## PRAVILA\n`
    prompt += `- VERIFICATION GATE: IDENTIFY -> RUN -> READ -> VERIFY -> CLAIM\n`
    // TASK-2987: bez ovoga se "spremio sam fajl" prijavljuje kao DONE dok proces vrti stari kod.
    prompt += `- RUN ukljucuje DEPLOY: popravak u kodu NIJE done dok proces koji ga vrti nije restartan\n`
    prompt += `  i provjeren (bun/node ne ucitavaju kod ponovno). Provjera stanja u pogonu:\n`
    prompt += `  bun ~/.claude/regoc/StaleCodeCheck.ts --entry <fajl.ts> --pid <pid>  (exit 3 = stari kod)\n`
    prompt += `  Restart: ~/.claude/regoc/regoc-services.sh restart-service <regoc|team|AGENT>\n`
    prompt += `  Ako ne smijes restartati -> status blocked, NE completed.\n`
    prompt += `- Structured status: DONE/DONE_WITH_CONCERNS/BLOCKED/NEEDS_CONTEXT\n`
    prompt += `- RAG-first: provjeri RAG prije "ne znam"\n`
    prompt += `- Testiraj prije DONE\n`

    // TASK-3669 (ADR-0004, O2 stavke 6 i 9): anti-racionalizacija BEZUVJETNO (protuotrov
    // lažnom „✅" — TASK-2953/2974/2983), ZOD UVJETNO (samo zadaci usporedbe iz
    // `zod_verification.required_for`; bezuvjetno = boilerplate-inflacija iz ADR-0003).
    // `verification_gate` i `structured_status` NE idu odavde — gore su u PRAVILIMA i uz
    // taskId. Flag OFF → prompt bajt-identičan starome putu.
    if (isEnabled('spawnVerificationBlock')) {
      try {
        const v = buildLiveVerificationBlock(this.registry?.spawn_template, msg.content)
        if (!v.block) {
          log(`⚠️ [verifikacijski blok] ${this.agentId}: spawn_template nema tekstova — prompt ide bez bloka`)
        } else if (isEnabled('spawnVerificationBlockLive')) {
          prompt += `\n${v.block}\n`
          log(`🧪 [verifikacijski blok] ${this.agentId}: ${v.opis} → u prompt`)
        } else {
          log(`👁️ [verifikacijski blok SHADOW] ${this.agentId}: ${v.opis} — NE šalje se (spawnVerificationBlockLive=false)`)
        }
      } catch (e) { log(`⚠️ [verifikacijski blok] ${this.agentId}: nije sastavljen (${e}) — prompt ide bez njega`) }
    }

    // P3/TASK-2569 (s5): recept po tieru za slabe modele — SAMO iza flaga i SAMO
    // kad je tier stvarno poznat. Flag OFF (ili tier null/nepoznat → getRecipe
    // vraća '') => prompt ostaje bajt-identičan dosadašnjem ponašanju.
    // TASK-3637: recept MORA ići PRIJE projectTaila (isto kao RegocDaemon.buildAgentPrompt),
    // inace projectTail vise nije zadnji u promptu i krsi Z3/TASK-3013 invarijantu.
    if (isEnabled('tierRecipesEnabled') && effortTier) {
      const recipe = getRecipe(effortTier)
      if (recipe) {
        prompt += `\n\n── RECEPT (tier ${effortTier}) ──\n${recipe}\n`
      }
    }

    // W3/TASK-4615, premješteno u TASK-4810: strukturirani izlaz koraka ide IZA recepta,
    // a ispred projectTaila (Z3). Dok je stajao uz TASKMANAGER PROTOCOL, gutala ga je zadnja
    // suprotstavljena uputa o obliku izlaza („=== VERIFIKACIJA ===" iz recepta) — mjereno
    // 11.09.2026.: 18/50 zadataka bez bloka. Način `off` → prazan niz, prompt nepromijenjen.
    prompt += blokShemeKoraka()

    // Z3/TASK-3013: konkretan projekt je ZADNJI u promptu — iza svega zajedničkog,
    // da spawnovi različitih projekata i dalje dijele keširani prefiks.
    prompt += projectTail

    return prompt
  }

  // ─── Checkpoint System ──────────────────────────────────────────

  private ensureCheckpointTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_checkpoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        task_id TEXT,
        phase TEXT NOT NULL,
        state_json TEXT NOT NULL,
        context_summary TEXT,
        session_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_checkpoints_agent
        ON agent_checkpoints(agent_id, created_at DESC)
    `)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_checkpoints_task
        ON agent_checkpoints(agent_id, task_id, created_at DESC)
    `)
    // F2: Migrate existing table — add session_id column if missing
    try {
      this.db.exec(`ALTER TABLE agent_checkpoints ADD COLUMN session_id TEXT`)
    } catch {
      // Column already exists — safe to ignore
    }
  }

  private saveCheckpoint(phase: string, contextSummary: string, sessionId?: string): void {
    try {
      this.db.run(`
        INSERT INTO agent_checkpoints (agent_id, task_id, phase, state_json, context_summary, session_id)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [
        this.agentId,
        this.state.currentTaskId,
        phase,
        JSON.stringify(this.state),
        contextSummary.substring(0, 2000),
        sessionId || null
      ])
    } catch (e) {
      log(`saveCheckpoint error: ${e}`)
    }
  }

  private async tryResume(): Promise<void> {
    try {
      // F2: Also look for WAITING_RETRY and SESSION_CAPTURED phases which have session_id.
      // TASK-2583: povijest se čita CIJELA (i terminalne faze) i sortira po `id`,
      // pa `selectResumableCheckpoint` vidi da je zadatak već dovršen. Prije se
      // filtriralo samo na nedovršene faze + `created_at DESC`; kako COMPLETED i
      // SESSION_CAPTURED padnu u istu sekundu, svaki je restart uskrsnuo već
      // isporučen posao (pilot 2026-07-28: potjeh 1 → 6 `claude --print` runova).
      const rows = this.db.query(`
        SELECT id, task_id, phase, state_json, context_summary, session_id, created_at
        FROM agent_checkpoints
        WHERE agent_id = ?
        ORDER BY id DESC
        LIMIT 50
      `).all(this.agentId) as any[]

      const row = selectResumableCheckpoint(rows)
      if (!row) return

      log(`Found unfinished checkpoint: task=${row.task_id}, phase=${row.phase}, session_id=${row.session_id || 'none'}`)

      // Check if the task is still valid
      try {
        const resp = await fetch(`${TASK_MANAGER_API}/${row.task_id}`)
        if (resp.ok) {
          const task = await resp.json() as any
          if (task.status === 'in_progress' || task.status === 'pending') {
            log(`Resuming task ${row.task_id} from checkpoint...`)

            // F2: If we have a session_id, note it so executeClaudeTask can use --resume
            if (row.session_id) {
              this.lastSessionId = row.session_id
              log(`📎 Restored session_id from checkpoint: ${row.session_id}`)
            }

            const resumeContent = `[RESUME] Nastavi zadatak ${row.task_id}. `
              + `Prethodni kontekst: ${row.context_summary}`
              + (row.session_id ? ` [SESSION_ID: ${row.session_id}]` : '')

            // R5: crash-loop bi inače proizveo bujicu identičnih [RESUME] poruka.
            if (!this.guardSend('resume', resumeContent)) {
              log(`🛑 BREAKER: resume-petlja zaustavljena za ${row.task_id}`)
              this.saveCheckpoint('ABANDONED', 'Resume blocked by send breaker (petlja)')
              return
            }

            this.db.run(`
              INSERT INTO messages (id, from_agent, to_agent, content, message_type, priority, status, metadata)
              VALUES (?, 'regoc', ?, ?, 'command', 1, 'pending', ?)
            `, [
              `resume-${row.task_id}-${Date.now()}`,
              this.agentId,
              resumeContent,
              row.session_id ? JSON.stringify({ sessionId: row.session_id, taskId: row.task_id }) : null
            ])

            this.saveCheckpoint('RESUMED', `Resumed from crash. Original: ${row.phase}`, row.session_id || undefined)
            return
          }
        }
      } catch {}

      log(`Checkpoint task ${row.task_id} no longer active. Skipping resume.`)
      this.saveCheckpoint('ABANDONED', 'Task no longer active at resume time')
    } catch (e) {
      log(`tryResume error: ${e}`)
    }
  }

  // ─── Heartbeat ──────────────────────────────────────────────────

  private writeHeartbeat(): void {
    // 1. Update agent_status table — ovo je izvor koji čita R3 reaper
    //    (RegocDaemon.watchdogDeadAgentsDryRun gleda agent_status.last_heartbeat).
    //    Dok daemon živi, heartbeat je star ≤30s → reaper ga vidi kao živog radnika.
    this.updateAgentStatus(this.state.status === 'executing' ? 'busy' : 'online')

    // 2. Write filesystem heartbeat (for RegocDaemon watchdog)
    // R4/TASK-2564: polja su ADITIVNA (stari ključevi ostaju) + taskRef/lastDeliveredAt.
    const heartbeatFile = join(HOME, `.tmp/agent_heartbeat_${this.agentId}.json`)
    this.rollDay()
    const hb = buildHeartbeat({
      agentId: this.agentId,
      model: this.model,
      status: this.state.status,
      currentTaskId: this.state.currentTaskId,
      tasksCompleted: this.state.tasksCompleted,
      tasksCompletedToday: this.state.tasksCompletedToday,
      startedAt: this.state.startedAt,
      lastDeliveredAt: this.state.lastDeliveredAt,
      pid: process.pid
    })
    try {
      writeFileSync(heartbeatFile, JSON.stringify(hb))
    } catch {}
  }

  /** R4: dnevni brojač se resetira u ponoć. */
  private rollDay(): void {
    const rolled = rollDailyCounter(
      { dayKey: this.state.dayKey, tasksCompletedToday: this.state.tasksCompletedToday }
    )
    this.state.dayKey = rolled.dayKey
    this.state.tasksCompletedToday = rolled.tasksCompletedToday
  }

  private updateAgentStatus(status: string): void {
    try {
      this.db.run(`
        INSERT OR REPLACE INTO agent_status (agent_id, status, last_heartbeat, current_task, pid)
        VALUES (?, ?, datetime('now'), ?, ?)
      `, [this.agentId, status, this.state.currentTaskId, process.pid])
    } catch (e) {
      log(`updateAgentStatus error: ${e}`)
    }
  }

  // ─── Graceful Shutdown ──────────────────────────────────────────

  private checkStopSignal(): void {
    const signalFile = join(HOME, `.tmp/agent_stop_${this.agentId}`)
    if (existsSync(signalFile)) {
      log(`Stop signal received via file`)
      try { unlinkSync(signalFile) } catch {}
      this.shutdown('signal-file')
    }
  }

  private shutdown(reason: string): void {
    log(`Shutting down: ${reason}`)
    this.state.status = 'stopping'
    this.running = false

    // Save final checkpoint
    this.saveCheckpoint('STOPPED', `Graceful shutdown: ${reason}`)
  }

  // ─── Telegram Integration ──────────────────────────────────────

  private sendTelegramStatus(text: string): void {
    // R5: breaker PRIJE slanja. Alarm sam ide raw kanalom (nikad kroz breaker).
    if (!this.guardSend('telegram', text)) return
    this.rawTelegram(`[${this.agentId.toUpperCase()}] ${text}`)
  }

  /** Slanje na Telegram BEZ breakera — samo za alarme breakera. */
  private rawTelegram(text: string): void {
    try {
      // bilo ~/.tmp/agent_telegram_send.sh — nestao iz ~/.tmp, alarm je šutke padao (27.09.2026.)
      Bun.spawnSync(['python3', join(HOME, '.claude/regoc/tools/telegram_send_text.py'), '--group', 'regoc', '--max', '4000', text], {
        cwd: HOME, timeout: 15000
      })
    } catch (e) {
      log(`Telegram send failed: ${e}`)
    }
  }

  // ─── R5 Self-Circuit-Breaker (TASK-2565) ───────────────────────

  /**
   * Vraća true ako se poruka smije poslati. Kad breaker prvi put pukne,
   * šalje TOČNO JEDAN alarm (raw kanalom, izvan breakera) i zapisuje event.
   * Fail-open: greška u breakeru nikad ne zaustavlja legitimno slanje.
   */
  private guardSend(channel: string, content: string): boolean {
    let v
    try {
      v = this.breaker.check(channel, content)
    } catch (e) {
      log(`SendBreaker greška (propuštam poruku): ${e}`)
      return true
    }
    if (v.mode === 'off') return true

    if (v.alarm) {
      const alarmText = formatAlarm(this.agentId, channel, v, content)
      log(alarmText.replace(/\n/g, ' | '))
      this.rawTelegram(alarmText)
      try {
        this.db.run(
          `INSERT INTO event_log (event_type, agent_id, details) VALUES ('send_breaker_trip', ?, ?)`,
          [this.agentId, JSON.stringify({ channel, hash: v.hash, recentCount: v.recentCount, mode: v.mode })]
        )
      } catch {}
    }
    if (!v.allowed) {
      log(`🛑 BREAKER blokirao ${channel} poruku (#${v.blockedCount} pod ovim haltom)`)
    }
    return v.allowed
  }

  // ─── Helpers ────────────────────────────────────────────────────

  private sendResponse(
    toAgent: string,
    content: string,
    originalMsg: InboxMessage,
    msgType: string = 'direct_response'
  ): void {
    try {
      // R5: identičan odgovor >5x u 10 min → HALT (incident 06-19: 1894 poruke).
      if (!this.guardSend(`message:${toAgent}`, content)) return

      const id = `resp-${this.agentId}-${Date.now()}`
      this.db.run(`
        INSERT INTO messages (id, from_agent, to_agent, content, message_type, priority, status, metadata)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
      `, [
        id,
        this.agentId,
        toAgent,
        content.substring(0, 4000),
        msgType,
        originalMsg.priority,
        // Z2/TASK-3012: `parentTaskId` nosi lanac pokretanja dalje — kad REGOČ iz ovog
        // odgovora delegira novi posao, dijete zna od kojeg zadatka nasljeđuje projekt.
        // Bez toga je lanac pucao ovdje i svako sljedeće dijete ostajalo bez projekta.
        // Upisuje se samo pravi TASK-ID (currentTaskId zna biti i ID poruke, v. redak 261).
        JSON.stringify({
          originalMessageId: originalMsg.id,
          ...(this.state.currentTaskId && /^TASK-\d+$/.test(this.state.currentTaskId)
            ? { parentTaskId: this.state.currentTaskId }
            : {}),
        })
      ])
      // R4/TASK-2564: „zadnje isporučeno" se broji SAMO kad odgovor stvarno uđe
      // u red — status 'executing' inače maskira 0 isporuka.
      this.state.lastDeliveredAt = new Date().toISOString()
    } catch (e) {
      log(`sendResponse error: ${e}`)
    }
  }

  private extractTaskId(msg: InboxMessage): string | null {
    // Try metadata first
    if (msg.metadata) {
      try {
        const meta = JSON.parse(msg.metadata)
        if (meta.taskId) return meta.taskId
      } catch {}
    }
    // Try content pattern
    const match = msg.content.match(/TASK-\d+/)
    return match ? match[0] : null
  }
}

// ─── Entry Point ────────────────────────────────────────────────────

const agentIdx = process.argv.indexOf('--agent')
const modelIdx = process.argv.indexOf('--model')

if (agentIdx === -1) {
  console.error('Usage: bun AgentDaemon.ts --agent <agentId> [--model <model>]')
  process.exit(1)
}

const entryAgentId = process.argv[agentIdx + 1]
const entryModel = modelIdx !== -1 ? process.argv[modelIdx + 1] : undefined

const daemon = new AgentDaemon(entryAgentId, entryModel)
daemon.run().catch(e => {
  console.error(`AgentDaemon fatal: ${e}`)
  process.exit(1)
})
