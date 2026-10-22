#!/usr/bin/env bun
/**
 * REGOČ Agent Signals (A3: BTW/Interrupt System)
 *
 * File-based signaling for sending messages to running agents.
 * When an agent is running (via `claude --print`), we can't communicate
 * with it directly. This module provides a file-based signal mechanism
 * so that a user (or REGOČ) can send BTW/REDIRECT/STOP/CONTEXT/HELP_RESPONSE
 * signals that the agent checks periodically.
 *
 * Storage: ~/.tmp/agent_signals/{agentId}.jsonl
 * Each line is a JSON AgentSignal object.
 *
 * Location: ~/.claude/regoc/AgentSignals.ts
 *
 * Usage (library):
 *   import { getAgentSignals } from '~/.claude/regoc/AgentSignals'
 *   const signals = getAgentSignals()
 *   signals.writeSignal('jelena', 'BTW', 'Koristi TypeScript ne Python')
 *
 * Usage (CLI):
 *   bun ~/.claude/regoc/AgentSignals.ts send <agentId> <type> <message>
 *   bun ~/.claude/regoc/AgentSignals.ts list
 *   bun ~/.claude/regoc/AgentSignals.ts read <agentId>
 *   bun ~/.claude/regoc/AgentSignals.ts clear <agentId>
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'fs'
import { join, basename } from 'path'
import { randomUUID } from 'crypto'

// ============================================
// Types
// ============================================

export type SignalType = 'BTW' | 'REDIRECT' | 'STOP' | 'CONTEXT' | 'HELP_RESPONSE'

export const VALID_SIGNAL_TYPES: readonly SignalType[] = [
  'BTW', 'REDIRECT', 'STOP', 'CONTEXT', 'HELP_RESPONSE',
] as const

export interface AgentSignal {
  id: string
  type: SignalType
  from: string        // who sent (user, regoc, another agent)
  message: string
  timestamp: string
  read: boolean
}

// Imena agenata provjerava validateAgentId() po obliku; popis živi u REGOC_AGENTS.json (TASK-5547).

// ============================================
// AgentSignals Class
// ============================================

export class AgentSignals {
  private signalDir: string

  constructor(signalDir?: string) {
    this.signalDir = signalDir ?? join(process.env.HOME || '', '.tmp/agent_signals')
    this.ensureDir()
  }

  // ------------------------------------------
  // Public API
  // ------------------------------------------

  /**
   * Write a signal for an agent. Returns the signal ID.
   */
  writeSignal(agentId: string, type: SignalType, message: string, from?: string): string {
    this.validateAgentId(agentId)
    this.validateSignalType(type)

    if (!message || message.trim().length === 0) {
      throw new Error('Signal message cannot be empty')
    }

    const signal: AgentSignal = {
      id: randomUUID(),
      type,
      from: from ?? 'user',
      message: message.trim(),
      timestamp: new Date().toISOString(),
      read: false,
    }

    const filePath = this.signalFilePath(agentId)
    const line = JSON.stringify(signal) + '\n'

    // Append to JSONL file (create if not exists)
    if (existsSync(filePath)) {
      const existing = readFileSync(filePath, 'utf-8')
      writeFileSync(filePath, existing + line, 'utf-8')
    } else {
      writeFileSync(filePath, line, 'utf-8')
    }

    return signal.id
  }

  /**
   * Read all unread signals for an agent.
   */
  readSignals(agentId: string): AgentSignal[] {
    this.validateAgentId(agentId)
    const all = this.readAllSignals(agentId)
    return all.filter(s => !s.read)
  }

  /**
   * Read ALL signals for an agent (including already-read ones).
   */
  readAllSignals(agentId: string): AgentSignal[] {
    const filePath = this.signalFilePath(agentId)
    if (!existsSync(filePath)) return []

    const content = readFileSync(filePath, 'utf-8').trim()
    if (!content) return []

    const signals: AgentSignal[] = []
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        signals.push(JSON.parse(trimmed) as AgentSignal)
      } catch {
        // Skip malformed lines — defensive against file corruption
      }
    }
    return signals
  }

  /**
   * Mark a specific signal as read. Returns true if found and marked.
   */
  markRead(signalId: string, agentId: string): boolean {
    this.validateAgentId(agentId)
    const signals = this.readAllSignals(agentId)

    let found = false
    const updated = signals.map(s => {
      if (s.id === signalId) {
        found = true
        return { ...s, read: true }
      }
      return s
    })

    if (found) {
      this.writeSignalFile(agentId, updated)
    }
    return found
  }

  /**
   * Clear all signals for an agent (call on spawn cleanup).
   * Returns the number of signals that were cleared.
   */
  clearAll(agentId: string): number {
    this.validateAgentId(agentId)
    const filePath = this.signalFilePath(agentId)
    if (!existsSync(filePath)) return 0

    const signals = this.readAllSignals(agentId)
    const count = signals.length
    unlinkSync(filePath)
    return count
  }

  /**
   * List agents that currently have signal files (active signal targets).
   */
  listActive(): string[] {
    this.ensureDir()
    const files = readdirSync(this.signalDir)
    return files
      .filter(f => f.endsWith('.jsonl'))
      .map(f => basename(f, '.jsonl'))
      .sort()
  }

  /**
   * Generate the instruction block to inject into an agent's prompt.
   * This tells the agent how and when to check for signals.
   */
  generateCheckInstruction(agentId: string): string {
    this.validateAgentId(agentId)
    const filePath = this.signalFilePath(agentId)

    return `## SIGNAL CHECK (provjeravaj svakih 30s)
Prije svakog većeg koraka, provjeri signal fajl:
cat ${filePath} 2>/dev/null
Ako postoji signal s "read":false:
- BTW: Pročitaj i prilagodi rad. Nastavi s radom.
- REDIRECT: Promijeni smjer rada prema instrukciji. Stari smjer napusti.
- STOP: Zaustavi rad odmah i pošalji [TASK_BLOCKED:{taskId}] s razlogom.
- CONTEXT: Dodaj informaciju u svoj kontekst i nastavi s radom.
- HELP_RESPONSE: Odgovor na tvoj help_request — nastavi s tim znanjem.
Nakon obrade signala, označi ga pročitanim dodavanjem u output:
echo '[SIGNAL_ACK:${agentId}:{signalId}]'`
  }

  // ------------------------------------------
  // Internal helpers
  // ------------------------------------------

  private signalFilePath(agentId: string): string {
    return join(this.signalDir, `${agentId}.jsonl`)
  }

  private ensureDir(): void {
    if (!existsSync(this.signalDir)) {
      mkdirSync(this.signalDir, { recursive: true })
    }
  }

  private validateAgentId(agentId: string): void {
    if (!agentId || agentId.trim().length === 0) {
      throw new Error('Agent ID cannot be empty')
    }
    // Allow any lowercase alphanumeric + underscore agent id
    if (!/^[a-z][a-z0-9_]*$/.test(agentId)) {
      throw new Error(`Invalid agent ID: "${agentId}". Must be lowercase alphanumeric starting with a letter.`)
    }
  }

  private validateSignalType(type: string): asserts type is SignalType {
    if (!VALID_SIGNAL_TYPES.includes(type as SignalType)) {
      throw new Error(`Invalid signal type: "${type}". Valid types: ${VALID_SIGNAL_TYPES.join(', ')}`)
    }
  }

  private writeSignalFile(agentId: string, signals: AgentSignal[]): void {
    const filePath = this.signalFilePath(agentId)
    const content = signals.map(s => JSON.stringify(s)).join('\n') + '\n'
    writeFileSync(filePath, content, 'utf-8')
  }
}

// ============================================
// Singleton
// ============================================

let _instance: AgentSignals | null = null

export function getAgentSignals(signalDir?: string): AgentSignals {
  if (!_instance || signalDir) {
    _instance = new AgentSignals(signalDir)
  }
  return _instance
}

// ============================================
// CLI Interface
// ============================================

function printUsage(): void {
  console.log(`REGOČ Agent Signals — BTW/Interrupt System

Usage:
  bun AgentSignals.ts send <agentId> <type> <message>   Send a signal to an agent
  bun AgentSignals.ts read <agentId>                     Read unread signals for an agent
  bun AgentSignals.ts list                               List agents with active signal files
  bun AgentSignals.ts clear <agentId>                    Clear all signals for an agent

Signal Types:
  BTW            — Advisory message, agent adapts but continues
  REDIRECT       — Change direction of work
  STOP           — Stop immediately
  CONTEXT        — Additional context information
  HELP_RESPONSE  — Response to a help request

Examples:
  bun AgentSignals.ts send jelena BTW "Koristi TypeScript ne Python"
  bun AgentSignals.ts send jelena REDIRECT "Fokusiraj se na testove"
  bun AgentSignals.ts send kosjenka STOP "Kriva arhitektura, stani"
  bun AgentSignals.ts list
  bun AgentSignals.ts read jelena`)
}

export function parseCli(args: string[]): { command: string; agentId?: string; type?: SignalType; message?: string } | null {
  // args = process.argv minus 'bun' and script path
  if (args.length === 0) return null

  const command = args[0]

  switch (command) {
    case 'send': {
      if (args.length < 4) return null
      const agentId = args[1]
      const type = args[2] as SignalType
      const message = args.slice(3).join(' ')
      return { command, agentId, type, message }
    }
    case 'read': {
      if (args.length < 2) return null
      return { command, agentId: args[1] }
    }
    case 'list':
      return { command }
    case 'clear': {
      if (args.length < 2) return null
      return { command, agentId: args[1] }
    }
    default:
      return null
  }
}

// Only run CLI when executed directly (not imported)
if (import.meta.main) {
  const args = process.argv.slice(2)

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printUsage()
    process.exit(0)
  }

  const parsed = parseCli(args)
  if (!parsed) {
    printUsage()
    process.exit(1)
  }

  const signals = getAgentSignals()

  try {
    switch (parsed.command) {
      case 'send': {
        const id = signals.writeSignal(parsed.agentId!, parsed.type!, parsed.message!)
        console.log(`✓ Signal sent to ${parsed.agentId} [${parsed.type}] id=${id}`)
        break
      }
      case 'read': {
        const unread = signals.readSignals(parsed.agentId!)
        if (unread.length === 0) {
          console.log(`No unread signals for ${parsed.agentId}`)
        } else {
          console.log(`${unread.length} unread signal(s) for ${parsed.agentId}:`)
          for (const s of unread) {
            console.log(`  [${s.type}] from=${s.from} @ ${s.timestamp}`)
            console.log(`    ${s.message}`)
          }
        }
        break
      }
      case 'list': {
        const active = signals.listActive()
        if (active.length === 0) {
          console.log('No active signal files.')
        } else {
          console.log(`Active signal files (${active.length}):`)
          for (const a of active) {
            const unread = signals.readSignals(a)
            const all = signals.readAllSignals(a)
            console.log(`  ${a}: ${unread.length} unread / ${all.length} total`)
          }
        }
        break
      }
      case 'clear': {
        const count = signals.clearAll(parsed.agentId!)
        console.log(`✓ Cleared ${count} signal(s) for ${parsed.agentId}`)
        break
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`Error: ${msg}`)
    process.exit(1)
  }
}
