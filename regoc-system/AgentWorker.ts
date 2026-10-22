#!/usr/bin/env bun
/**
 * REGOČ AgentWorker - Persistent daemon for specialist agents
 *
 * Polls the message queue for messages addressed to specialist agents
 * (kosjenka, jelena, malik, manda, dora, potjeh, gita, grga)
 * and spawns Claude Code sessions to process them.
 *
 * Usage:
 *   bun AgentWorker.ts              # Run in foreground
 *   bun AgentWorker.ts --stop       # Stop worker
 *   bun AgentWorker.ts --status     # Check status
 *
 * Managed by: regoc-services.sh
 */

import { MAX_MSG_LEN, parseAgentOutput, plainText, renderMinimal, zavrsioZavrsila } from './AgentOutputParser'
import { Database } from 'bun:sqlite'
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs'
import { join } from 'path'
import { requestVoice } from '../VoiceServer/voice-client'
import { SendBreaker, formatAlarm } from './SendBreaker'
import { isNonActionableMessage } from './DispatchGuard'
import { homedir } from 'os'

// ============================================
// Configuration
// ============================================

const HOME = process.env.HOME || homedir()
const REGOC_DIR = join(HOME, '.claude/regoc')
const DB_PATH = join(REGOC_DIR, 'messages.db')
const PID_FILE = '/tmp/regoc_pids/agentworker.pid'
const LOG_FILE = '/tmp/regoc_logs/agentworker.log'
const AGENTS_JSON = join(REGOC_DIR, 'REGOC_AGENTS.json')

const POLL_INTERVAL_MS = 5000      // Check every 5 seconds
const HEARTBEAT_INTERVAL = 30000   // Heartbeat every 30 seconds
const MAX_CONCURRENT = 3           // Max concurrent Claude Code sessions
const TASK_TIMEOUT_MS = 300000     // 5 minute timeout per task
const MAX_TASK_TIMEOUT_MS = 600000 // 10 minute hard timeout

// Specialist agents managed by this worker
const SPECIALIST_AGENTS = [
  'kosjenka', 'jelena', 'malik', 'manda',
  'dora', 'potjeh', 'gita', 'grga'
] as const

type SpecialistAgent = typeof SPECIALIST_AGENTS[number]

// ============================================
// Types
// ============================================

interface AgentConfig {
  id: string
  name: string
  full_name: string
  role: string
  model: string
  voice: { voice_id: string; voice_name: string }
  skills: string[]
  context_file: string | null
  required_knowledge: string[]
  communication_style: string
  description: string
  security_isolation?: boolean
}

interface Message {
  id: string
  from_agent: string
  to_agent: string
  content: string
  message_type: string
  priority: number
  status: string
  created_at: string
}

interface ActiveTask {
  messageId: string
  agent: SpecialistAgent
  proc: ReturnType<typeof Bun.spawn>
  startTime: number
  timeoutMs: number
}

// ============================================
// State
// ============================================

let running = true
let agentRegistry: Record<string, AgentConfig> = {}
const activeTasks = new Map<string, ActiveTask>()
let lastHeartbeat = 0

// ============================================
// Logging
// ============================================

function log(msg: string) {
  const ts = new Date().toISOString()
  const line = `[${ts}] ${msg}`
  console.log(line)
}

function logError(msg: string) {
  const ts = new Date().toISOString()
  const line = `[${ts}] ❌ ${msg}`
  console.error(line)
}

// ============================================
// Database
// ============================================

function getDb(): Database {
  return new Database(DB_PATH)
}

function getPendingMessages(db: Database, agent: string, limit = 1): Message[] {
  return db.query(
    `SELECT * FROM messages
     WHERE to_agent = ? AND status = 'pending'
     ORDER BY priority ASC, created_at ASC
     LIMIT ?`
  ).all(agent, limit) as Message[]
}

function claimMessage(db: Database, messageId: string): boolean {
  const result = db.query(
    `UPDATE messages SET status = 'processing', updated_at = datetime('now')
     WHERE id = ? AND status = 'pending'`
  ).run(messageId)
  return result.changes > 0
}

function completeMessage(db: Database, messageId: string, response: string) {
  db.query(
    `UPDATE messages SET status = 'completed', response = ?,
     processed_at = datetime('now'), updated_at = datetime('now')
     WHERE id = ?`
  ).run(response, messageId)
}

function failMessage(db: Database, messageId: string, error: string) {
  db.query(
    `UPDATE messages SET status = 'failed', error = ?,
     updated_at = datetime('now')
     WHERE id = ?`
  ).run(error, messageId)
}

// ─── R5 Self-Circuit-Breaker (TASK-2565) ─────────────────────────
// Incident 02-23: agentworker→regoc 1042 identične poruke u 4h.
// Singleton čuva in-memory sloj između poziva; SQL sloj preživljava restart.
let sendBreaker: SendBreaker | null = null

/** true = smije se slati. Alarm ide točno jednom po haltu. Fail-open. */
function guardSend(db: Database, channel: string, content: string): boolean {
  try {
    if (!sendBreaker) sendBreaker = new SendBreaker(db, 'agentworker', { logger: log })
    else sendBreaker.setDb(db)
    const v = sendBreaker.check(channel, content)
    if (v.mode === 'off') return true
    if (v.alarm) {
      const txt = formatAlarm('agentworker', channel, v, content)
      log(txt.replace(/\n/g, ' | '))
      try {
        Bun.spawnSync(['python3', join(HOME, '.claude/regoc/tools/telegram_send_text.py'), '--group', 'regoc', '--max', '4000', txt],
          { cwd: HOME, timeout: 15000 })
      } catch {}
      try {
        db.run(`INSERT INTO event_log (event_type, agent_id, details) VALUES ('send_breaker_trip', 'agentworker', ?)`,
          [JSON.stringify({ channel, hash: v.hash, recentCount: v.recentCount, mode: v.mode })])
      } catch {}
    }
    if (!v.allowed) log(`🛑 BREAKER blokirao poruku prema ${channel} (#${v.blockedCount})`)
    return v.allowed
  } catch (e) {
    logError(`SendBreaker greška (propuštam poruku): ${e}`)
    return true
  }
}

function sendResponse(db: Database, toAgent: string, content: string, priority = 3, messageType = 'text') {
  if (!guardSend(db, `message:${toAgent}`, content)) return null

  const id = crypto.randomUUID()
  db.query(
    `INSERT INTO messages (id, from_agent, to_agent, content, message_type, priority, status)
     VALUES (?, 'agentworker', ?, ?, ?, ?, 'pending')`
  ).run(id, toAgent, content, messageType, priority)
  return id
}

function updateHeartbeat(db: Database, agent: string, status: string, task: string | null) {
  db.query(
    `UPDATE agent_status SET status = ?, last_heartbeat = datetime('now'),
     current_task = ?, updated_at = datetime('now')
     WHERE agent_id = ?`
  ).run(status, task, agent)
}

// ============================================
// Agent Registry
// ============================================

function loadAgentRegistry() {
  try {
    if (!existsSync(AGENTS_JSON)) {
      logError(`Agent registry not found: ${AGENTS_JSON}`)
      return
    }
    const data = JSON.parse(readFileSync(AGENTS_JSON, 'utf-8'))
    agentRegistry = data.agents || {}
    log(`Loaded ${Object.keys(agentRegistry).length} agents from registry`)
  } catch (e) {
    logError(`Failed to load agent registry: ${e}`)
  }
}

// ============================================
// Agent Prompt Builder
// ============================================

function buildAgentPrompt(agent: SpecialistAgent, message: Message): string {
  const config = agentRegistry[agent]
  if (!config) {
    return `Process this task:\n\n${message.content}`
  }

  // Build knowledge loading instructions
  let knowledgeInstructions = ''
  if (config.required_knowledge && config.required_knowledge.length > 0) {
    const knowledgePaths = config.required_knowledge
      .map(k => {
        // Resolve relative paths
        if (k.startsWith('skills/')) return join(HOME, '.claude', k)
        if (k.startsWith('regoc_system/')) return join(HOME, 'app', k)
        if (k.startsWith('HDL-GuideLines/')) return join(HOME, 'fpga-AI-projects/ulx3s', k)
        return k
      })
    knowledgeInstructions = `\n## Potrebno znanje\nUčitaj ove fajlove prije rada:\n${knowledgePaths.map(k => `- ${k}`).join('\n')}\n`
  }

  // Security isolation for Gita & Grga
  let securityNote = ''
  if (config.security_isolation) {
    securityNote = `\n## SIGURNOSNA IZOLACIJA\nNE SMIJEŠ znati niti pristupati: IP adresama, portovima, putanjama sustava, credentijalima.\nRadiš SAMO na svom output folderu.\n`
  }

  // Context file loading
  let contextLoad = ''
  if (config.context_file) {
    const ctxPath = config.context_file.replace('~', HOME)
    if (existsSync(ctxPath)) {
      contextLoad = `\n## Agent Context\nUčitaj kontekst: ${ctxPath}\n`
    }
  }

  return `# Ti si ${config.full_name} (${config.name})

**Uloga:** ${config.role}
**Opis:** ${config.description}
**Komunikacijski stil:** ${config.communication_style}

${knowledgeInstructions}${contextLoad}${securityNote}

## Zadatak

${message.content}

---

## Pravila
1. Obavi zadatak temeljito i precizno
2. Kada završiš, ispiši rezultat jasno i strukturirano
3. Ako trebaš dodatni kontekst, provjeri RAG:
   bun ~/.claude/skills/CORE/Tools/rag-query.ts -c pai_learning_system -q "[tema]" -n 5
4. Ne ostavljaj posao nedovršen - provjeri sve prije završetka
5. Koristi format:
   📋 REZULTAT: [Što si napravio]
   📊 STATUS: [Uspješno/Djelomično/Neuspješno]
   ➡️ SLJEDEĆI KORACI: [Ako ih ima]
`
}

// ============================================
// Claude Code Spawner
// ============================================

async function spawnClaudeCode(
  agent: SpecialistAgent,
  prompt: string,
  timeoutMs: number = TASK_TIMEOUT_MS
): Promise<{ success: boolean; output: string; error?: string }> {
  const config = agentRegistry[agent]
  const model = config?.model || 'sonnet'

  // Build command
  const cmdArgs = ['claude', '--print', '--dangerously-skip-permissions', '--model', model, '-p', prompt]

  log(`Spawning ${agent} (${model}): ${prompt.substring(0, 80)}...`)

  try {
    const proc = Bun.spawn(cmdArgs, {
      cwd: HOME,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
        HOME,
        USER: process.env.USER || 'klaudio',
        SHELL: process.env.SHELL || '/bin/bash',
        TERM: 'xterm-256color',
        REGOC_AGENT_ID: agent,
        BUN_INSTALL: process.env.BUN_INSTALL || join(HOME, '.bun'),
      }
    })

    // Timeout handling
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        proc.kill('SIGTERM')
        setTimeout(() => {
          try { proc.kill('SIGKILL') } catch {}
        }, 5000)
        reject(new Error(`Timeout after ${timeoutMs}ms`))
      }, timeoutMs)
    })

    // Wait for process
    const outputPromise = (async () => {
      const stdout = await new Response(proc.stdout).text()
      const stderr = await new Response(proc.stderr).text()
      const exitCode = await proc.exited

      // TASK-2953: exit 0 uz hook-blokadu (npr. session_usage.py na UserPromptSubmit)
      // znaci da agent NIJE ni krenuo. Bez ove provjere poruka blokade prolazi kao
      // "uspjeh" — poruka se zatvara kao completed i posiljatelju se salje lazni
      // "zavrsio zadatak" s vracenim promptom u tijelu (vektor echo-petlje).
      const { detectHookBlock } = await import('./HookBlockGuard')
      const blk = detectHookBlock(stdout, stderr)
      if (blk.blocked) {
        return { success: false, output: '', error: `Hook '${blk.hookEvent}' blokirao ulaz (${blk.code}): ${blk.reason}` }
      }

      if (exitCode === 0) {
        return { success: true, output: stdout }
      } else {
        return { success: false, output: stdout, error: stderr || `Exit code: ${exitCode}` }
      }
    })()

    return await Promise.race([outputPromise, timeoutPromise])
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e)
    return { success: false, output: '', error: errMsg }
  }
}

// ============================================
// Task Processing
// ============================================

async function processMessage(agent: SpecialistAgent, message: Message) {
  const db = getDb()

  try {
    // Claim the message
    if (!claimMessage(db, message.id)) {
      log(`Message ${message.id.substring(0, 8)} already claimed`)
      db.close()
      return
    }

    // GUARD (TASK-2971): AgentWorker je DRUGI, neovisan potrošač messages.db koji
    // spawna `claude --print`. Guard u AgentDaemon.ts:232 ne pokriva ovaj put —
    // kad bi se worker ponovno pokrenuo, ista daemonova statusna poruka
    // ("🤖 **REGOČ Daemon Status**") opet bi postala prava Opus sesija.
    // Poruka je već claimana, pa je zatvaramo kao completed sa zapisom razloga.
    if (isNonActionableMessage(message.content)) {
      completeMessage(
        db,
        message.id,
        'skipped: non-actionable message (recycled report or lifecycle notice) — not a task spec'
      )
      log(`🛑 NOT executing message ${message.id.substring(0, 8)} from ${message.from_agent}: non-actionable, not a task spec`)
      db.close()
      return
    }

    // Update agent status
    updateHeartbeat(db, agent, 'busy', `Processing: ${message.content.substring(0, 50)}`)

    // Build prompt
    const prompt = buildAgentPrompt(agent, message)

    // Determine timeout based on priority
    const timeoutMs = message.priority <= 2 ? MAX_TASK_TIMEOUT_MS : TASK_TIMEOUT_MS

    db.close()

    // Spawn Claude Code
    const result = await spawnClaudeCode(agent, prompt, timeoutMs)

    // Record result
    const db2 = getDb()

    if (result.success) {
      completeMessage(db2, message.id, result.output)

      // TASK-4815: isti parser i isto pravilo rezanja kao na ostalim kanalima —
      // prije su ovdje stajala dva slijepa reza (2000 i 500) nad sirovim stdoutom.
      const parsirano = parseAgentOutput(result.output)
      const ime = agentRegistry[agent]?.name || agent

      // Send result back to sender
      if (message.from_agent !== 'regoc') {
        sendResponse(db2, message.from_agent,
          renderMinimal(parsirano, { heading: `✅ ${ime} je ${zavrsioZavrsila(agent)} zadatak:`, maxLen: MAX_MSG_LEN }))
      }

      // Always notify regoc (message_type='agent_result' prevents re-delegation)
      sendResponse(db2, 'regoc',
        renderMinimal(parsirano, {
          heading: `📋 Agent ${ime} ${zavrsioZavrsila(agent)}: ${plainText(message.content).replace(/\s+/g, ' ').slice(0, 100)}`,
          maxLen: 700,
        }),
        3, 'agent_result')

      // Voice notification disabled - voice only on explicit user request (Telegram/TeamSpeak)
      // notify(`${agentRegistry[agent]?.name || agent} je završio zadatak`)

      log(`✅ ${agent} completed message ${message.id.substring(0, 8)}`)
    } else {
      failMessage(db2, message.id, result.error || 'Unknown error')
      logError(`${agent} failed on ${message.id.substring(0, 8)}: ${result.error}`)

      // Notify regoc about failure (message_type='agent_result' prevents re-delegation)
      sendResponse(db2, 'regoc',
        `❌ Agent **${agentRegistry[agent]?.name || agent}** neuspješan: ${result.error?.substring(0, 200)}`,
        3, 'agent_result')
    }

    // Update agent status back to available
    updateHeartbeat(db2, agent, 'online', `${agentRegistry[agent]?.role || 'Specialist'} - awaiting tasks`)
    db2.close()

  } catch (e) {
    logError(`Error processing message for ${agent}: ${e}`)
    try {
      const db3 = getDb()
      failMessage(db3, message.id, String(e))
      updateHeartbeat(db3, agent, 'online', `${agentRegistry[agent]?.role || 'Specialist'} - awaiting tasks`)
      db3.close()
    } catch {}
  }
}

// ============================================
// Voice Notification
// ============================================

/**
 * Glasovna notifikacija — prolazi kroz allowlist/gate (voice-client).
 * Agenti bez glasa u REGOC_AGENTS.json ne proizvode nikakav zvuk.
 */
async function notify(message: string, agent?: string, event = 'agent_task_completed') {
  await requestVoice({ agent, event, message })
}

// ============================================
// Heartbeat
// ============================================

function heartbeatAll() {
  const now = Date.now()
  if (now - lastHeartbeat < HEARTBEAT_INTERVAL) return
  lastHeartbeat = now

  try {
    const db = getDb()
    for (const agent of SPECIALIST_AGENTS) {
      const isActive = [...activeTasks.values()].some(t => t.agent === agent)
      updateHeartbeat(
        db,
        agent,
        isActive ? 'busy' : 'online',
        isActive ? 'Processing task' : `${agentRegistry[agent]?.role || 'Specialist'} - awaiting tasks`
      )
    }
    db.close()
  } catch (e) {
    logError(`Heartbeat failed: ${e}`)
  }
}

// ============================================
// Main Loop
// ============================================

async function mainLoop() {
  while (running) {
    try {
      // Skip if at capacity
      if (activeTasks.size >= MAX_CONCURRENT) {
        await Bun.sleep(POLL_INTERVAL_MS)
        continue
      }

      const db = getDb()

      // Check each specialist agent for pending messages
      for (const agent of SPECIALIST_AGENTS) {
        // Skip if this agent already has an active task
        if ([...activeTasks.values()].some(t => t.agent === agent)) continue

        // Skip if at capacity
        if (activeTasks.size >= MAX_CONCURRENT) break

        const messages = getPendingMessages(db, agent, 1)
        if (messages.length > 0) {
          const msg = messages[0]
          log(`📨 Found pending message for ${agent}: ${msg.content.substring(0, 60)}...`)

          // Process asynchronously
          const taskKey = `${agent}-${msg.id}`
          const processPromise = processMessage(agent, msg)
            .finally(() => {
              activeTasks.delete(taskKey)
            })

          activeTasks.set(taskKey, {
            messageId: msg.id,
            agent,
            proc: null as any, // Tracked internally by processMessage
            startTime: Date.now(),
            timeoutMs: TASK_TIMEOUT_MS
          })
        }
      }

      db.close()

      // Heartbeat
      heartbeatAll()

    } catch (e) {
      logError(`Main loop error: ${e}`)
    }

    await Bun.sleep(POLL_INTERVAL_MS)
  }
}

// ============================================
// Process Management
// ============================================

function writePid() {
  const pidDir = '/tmp/regoc_pids'
  if (!existsSync(pidDir)) mkdirSync(pidDir, { recursive: true })
  writeFileSync(PID_FILE, String(process.pid))
}

function handleShutdown(signal: string) {
  log(`Shutting down AgentWorker... (signal: ${signal})`)
  running = false

  // Kill all active tasks
  for (const [key, task] of activeTasks) {
    try {
      if (task.proc) task.proc.kill('SIGTERM')
    } catch {}
  }

  // Cleanup PID
  try { unlinkSync(PID_FILE) } catch {}

  // Mark all agents as offline
  try {
    const db = getDb()
    for (const agent of SPECIALIST_AGENTS) {
      updateHeartbeat(db, agent, 'offline', null)
    }
    db.close()
  } catch {}

  log('AgentWorker stopped')
  process.exit(0)
}

// ============================================
// CLI Commands
// ============================================

const args = process.argv.slice(2)

if (args.includes('--stop')) {
  try {
    const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim())
    process.kill(pid, 'SIGTERM')
    console.log(`Stopped AgentWorker (PID: ${pid})`)
  } catch {
    console.log('AgentWorker is not running')
  }
  process.exit(0)
}

if (args.includes('--status')) {
  try {
    const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim())
    process.kill(pid, 0) // Check if alive
    console.log(`AgentWorker is running (PID: ${pid})`)

    // Show active tasks
    const db = getDb()
    for (const agent of SPECIALIST_AGENTS) {
      const pending = db.query(
        "SELECT COUNT(*) as cnt FROM messages WHERE to_agent = ? AND status = 'pending'"
      ).get(agent) as any
      const status = db.query(
        "SELECT status, current_task FROM agent_status WHERE agent_id = ?"
      ).get(agent) as any
      console.log(`  ${agent}: ${status?.status || 'unknown'} | ${pending?.cnt || 0} pending`)
    }
    db.close()
  } catch {
    console.log('AgentWorker is not running')
  }
  process.exit(0)
}

// ============================================
// Start
// ============================================

process.on('SIGINT', () => handleShutdown('SIGINT'))
process.on('SIGTERM', () => handleShutdown('SIGTERM'))

log('Starting REGOČ AgentWorker...')
log(`Managing agents: ${SPECIALIST_AGENTS.join(', ')}`)
log(`Max concurrent: ${MAX_CONCURRENT}`)
log(`Poll interval: ${POLL_INTERVAL_MS}ms`)

// Load agent registry
loadAgentRegistry()

// Write PID
writePid()

// Initial heartbeat
const db = getDb()
for (const agent of SPECIALIST_AGENTS) {
  updateHeartbeat(db, agent, 'online', `${agentRegistry[agent]?.role || 'Specialist'} - awaiting tasks`)
}
db.close()
log(`✅ All ${SPECIALIST_AGENTS.length} agents online and listening`)

// Voice notification disabled - voice only on explicit user request (Telegram/TeamSpeak)
// notify('AgentWorker pokrenut, svi agenti su online')

// Start main loop
mainLoop().catch(e => {
  logError(`Fatal error: ${e}`)
  process.exit(1)
})
