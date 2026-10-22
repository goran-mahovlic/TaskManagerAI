#!/usr/bin/env bun
/**
 * REGOČ Help Pipeline (F6.1)
 *
 * When an agent gets blocked, it can request help from another agent.
 * This module handles help_request and help_response routing,
 * circular prevention, and MessageQueue integration.
 *
 * Location: ~/.claude/regoc/HelpPipeline.ts
 *
 * Usage:
 *   import { getHelpPipeline } from '~/.claude/regoc/HelpPipeline'
 *   const hp = getHelpPipeline()
 *   const helper = hp.routeRequest(request)
 *   const msg = hp.createHelpMessage(request)
 */

// ============================================
// Types
// ============================================

export type HelpType = 'decision' | 'review' | 'expertise' | 'unblock'

export interface HelpRequest {
  type: 'help_request'
  fromAgent: string
  problem: string
  context: string          // max 2000 chars
  helpType: HelpType
  suggestedHelper?: string
  taskId?: string
}

export interface HelpResponse {
  type: 'help_response'
  fromAgent: string        // the helper
  toAgent: string          // the original requester
  decision: string
  confidence: number       // 0-1
  rationale: string
}

// ============================================
// Routing Tables
// ============================================

/** Which agents handle which help types by default */
const HELP_ROUTING: Record<HelpType, string[]> = {
  decision:  ['kosjenka', 'regoc'],
  review:    ['malik', 'potjeh'],
  expertise: [],  // determined by tag matching
  unblock:   ['regoc'],
}

/** Tag-based expertise routing for helpType === 'expertise' and fallback scanning */
const TAG_ROUTING: Record<string, string> = {
  '#fpga':           'emard',
  '#security':       'malik',
  '#architecture':   'kosjenka',
  '#implementation': 'jelena',
  '#research':       'manda',
  '#testing':        'potjeh',
  '#design':         'grga',
}

/** All known agent IDs (superset of MessageQueue VALID_AGENTS — includes emard) */
const ALL_AGENTS = new Set([
  'regoc', 'klaudio', 'stribor', 'kosjenka', 'jelena',
  'malik', 'manda', 'potjeh', 'dora', 'gita', 'grga',
  'emard',
])

const CONTEXT_MAX_LENGTH = 2000

// ============================================
// HelpPipeline Class
// ============================================

export class HelpPipeline {
  private static instance: HelpPipeline | null = null

  /**
   * Active help sessions: tracks "fromAgent -> toAgent" to prevent circular requests.
   * Key format: `${fromAgent}:${topicHash}` -> toAgent
   */
  private activeRequests: Map<string, string> = new Map()

  private constructor() {}

  static getInstance(): HelpPipeline {
    if (!HelpPipeline.instance) {
      HelpPipeline.instance = new HelpPipeline()
    }
    return HelpPipeline.instance
  }

  // ============================================
  // Core Routing
  // ============================================

  /**
   * Determine which agent should handle a help request.
   *
   * Priority:
   *   1. suggestedHelper (if valid and not self/circular)
   *   2. HELP_ROUTING table for the helpType
   *   3. Tag scanning in problem text
   *   4. Default: 'regoc'
   */
  routeRequest(request: HelpRequest): string {
    const from = request.fromAgent.toLowerCase()

    // 1. Try suggestedHelper
    if (request.suggestedHelper) {
      const suggested = request.suggestedHelper.toLowerCase()
      if (
        ALL_AGENTS.has(suggested) &&
        suggested !== from &&
        !this.isCircular(from, suggested)
      ) {
        return suggested
      }
    }

    // 2. Try HELP_ROUTING table
    const candidates = HELP_ROUTING[request.helpType] || []
    for (const candidate of candidates) {
      if (candidate !== from && !this.isCircular(from, candidate)) {
        return candidate
      }
    }

    // 3. Scan problem text for tags
    const tagMatch = this.findTagMatch(request.problem, from)
    if (tagMatch) {
      return tagMatch
    }

    // 4. Default to regoc (unless self)
    if (from !== 'regoc') {
      return 'regoc'
    }

    // Edge case: regoc asking for help and all routes exhausted — fall back to kosjenka
    return 'kosjenka'
  }

  /**
   * Scan text for known tags (#fpga, #security, etc.) and return matching agent.
   */
  private findTagMatch(text: string, fromAgent: string): string | null {
    const lowerText = text.toLowerCase()

    for (const [tag, agent] of Object.entries(TAG_ROUTING)) {
      if (lowerText.includes(tag) && agent !== fromAgent && !this.isCircular(fromAgent, agent)) {
        return agent
      }
    }

    return null
  }

  // ============================================
  // Circular Prevention
  // ============================================

  /**
   * Check if routing fromAgent -> toAgent would create a circular help loop.
   * Circular = toAgent already has an active request TO fromAgent.
   */
  isCircular(fromAgent: string, toAgent: string): boolean {
    // Check if toAgent has already asked fromAgent for help (reverse direction exists)
    for (const [key, helper] of this.activeRequests.entries()) {
      const requester = key.split(':')[0]
      if (requester === toAgent && helper === fromAgent) {
        return true
      }
    }
    return false
  }

  /**
   * Register an active help request (for circular detection).
   */
  registerRequest(fromAgent: string, toAgent: string, topicKey?: string): void {
    const key = `${fromAgent}:${topicKey || 'default'}`
    this.activeRequests.set(key, toAgent)
  }

  /**
   * Clear an active help request (when resolved).
   */
  clearRequest(fromAgent: string, topicKey?: string): void {
    const key = `${fromAgent}:${topicKey || 'default'}`
    this.activeRequests.delete(key)
  }

  /**
   * Clear all active requests (for testing / reset).
   */
  clearAllRequests(): void {
    this.activeRequests.clear()
  }

  // ============================================
  // Message Integration
  // ============================================

  /**
   * Create a MessageQueue-compatible message from a HelpRequest.
   * Returns { to, content, messageType } ready for mq.sendMessage().
   */
  createHelpMessage(request: HelpRequest): { to: string; content: string; messageType: string } {
    const helper = this.routeRequest(request)

    // Truncate context to max length
    const context = request.context.length > CONTEXT_MAX_LENGTH
      ? request.context.slice(0, CONTEXT_MAX_LENGTH)
      : request.context

    // Build structured content
    const lines: string[] = [
      `[HELP_REQUEST:${request.helpType.toUpperCase()}]`,
      `From: ${request.fromAgent}`,
    ]

    if (request.taskId) {
      lines.push(`Task: ${request.taskId}`)
    }

    lines.push(
      `Problem: ${request.problem}`,
      `---`,
      `Context: ${context}`,
    )

    if (request.suggestedHelper && request.suggestedHelper !== helper) {
      lines.push(`(Suggested: ${request.suggestedHelper}, routed to: ${helper})`)
    }

    // Register the active request for circular prevention
    this.registerRequest(request.fromAgent, helper, request.taskId || request.problem.slice(0, 50))

    return {
      to: helper,
      content: lines.join('\n'),
      messageType: 'help_request',
    }
  }

  // ============================================
  // Response Parsing
  // ============================================

  /**
   * Parse a free-text agent response into a structured HelpResponse.
   *
   * Expected format (flexible):
   *   [HELP_RESPONSE]
   *   To: <agent>
   *   Decision: <text>
   *   Confidence: <0-1>
   *   Rationale: <text>
   *
   * Also accepts inline format:
   *   Decision: ... | Confidence: 0.8 | Rationale: ...
   */
  parseHelpResponse(content: string, fromAgent?: string): HelpResponse | null {
    if (!content) return null

    // Try structured format first
    const toMatch = content.match(/To:\s*(\S+)/i)
    const decisionMatch = content.match(/Decision:\s*(.+?)(?:\n|$)/i)
    const confidenceMatch = content.match(/Confidence:\s*([\d.]+)/i)
    const rationaleMatch = content.match(/Rationale:\s*(.+?)(?:\n\[|$)/is)

    if (!decisionMatch) return null

    const confidence = confidenceMatch
      ? Math.min(1, Math.max(0, parseFloat(confidenceMatch[1])))
      : 0.5

    return {
      type: 'help_response',
      fromAgent: fromAgent || 'unknown',
      toAgent: toMatch ? toMatch[1] : 'unknown',
      decision: decisionMatch[1].trim(),
      confidence: isNaN(confidence) ? 0.5 : confidence,
      rationale: rationaleMatch ? rationaleMatch[1].trim() : '',
    }
  }
}

// ============================================
// Singleton Export
// ============================================

export function getHelpPipeline(): HelpPipeline {
  return HelpPipeline.getInstance()
}

// ============================================
// Convenience: Validate a HelpRequest before routing
// ============================================

export function validateHelpRequest(request: Partial<HelpRequest>): { valid: boolean; error?: string } {
  if (!request.fromAgent) return { valid: false, error: 'fromAgent is required' }
  if (!request.problem) return { valid: false, error: 'problem is required' }
  if (!request.context && request.context !== '') return { valid: false, error: 'context is required' }
  if (!request.helpType) return { valid: false, error: 'helpType is required' }

  const validTypes: HelpType[] = ['decision', 'review', 'expertise', 'unblock']
  if (!validTypes.includes(request.helpType)) {
    return { valid: false, error: `helpType must be one of: ${validTypes.join(', ')}` }
  }

  if (request.context && request.context.length > CONTEXT_MAX_LENGTH) {
    return { valid: false, error: `context exceeds ${CONTEXT_MAX_LENGTH} chars` }
  }

  return { valid: true }
}
