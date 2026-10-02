// src/core/ModeClassifier.ts
// Mode Classifier - classifies incoming tasks into effort tiers for routing
// FAZA 3.2 - F3.2 Mode Classification
// Autor: Jelena (Engineer Agent)
// Verzija: 1.0.0

// ============================================
// TYPES
// ============================================

export type TaskMode = 'MINIMAL' | 'STANDARD' | 'COMPLEX'
export type EffortTier = 'E1' | 'E2' | 'E3' | 'E4' | 'E5'

export interface ClassificationResult {
  mode: TaskMode
  effort: EffortTier
  suggestedAgents: string[]
  reasoning: string
  estimatedMinutes: number
}

export interface ClassificationInput {
  title: string
  description?: string
  tags?: string[]
}

// ============================================
// KEYWORD SETS
// ============================================

const E1_KEYWORDS = [
  'status', 'koliko', 'što je', 'sto je', 'hello', 'hvala', 'ok',
  'pozdrav', 'bok', 'hej', 'cao', 'zdravo', 'da', 'ne',
  'koji', 'koja', 'koje', 'kako si', 'what is', 'how are',
  'thanks', 'thank you', 'hi', 'hey', 'ping', 'ack'
]

const E2_ACTION_VERBS = [
  'napravi', 'popravi', 'dodaj', 'pronađi', 'pronadji',
  'obriši', 'obrisi', 'promijeni', 'promjeni', 'provjeri', 'provjera',
  'pokreni', 'zaustavi', 'restart', 'deploy',
  'fix', 'add', 'find', 'remove', 'change', 'check', 'run', 'stop',
  'update', 'create', 'delete', 'show', 'list', 'get', 'set'
]

const E3_KEYWORDS = [
  'implementiraj', 'kreiraj modul', 'napravi feature', 'kreiraj',
  'implement', 'create module', 'build feature', 'develop',
  'refaktoriraj', 'refactor', 'migrate', 'migriraj',
  'integriraj', 'integrate', 'connect', 'poveži', 'povezi'
]

const E4_KEYWORDS = [
  'arhitektura', 'dizajniraj sustav', 'security audit', 'full review',
  'architecture', 'design system', 'pentest', 'threat model',
  'kompletni pregled', 'full audit', 'system design',
  'dizajniraj', 'projektiraj', 'analiziraj sustav'
]

const E5_KEYWORDS = [
  'kompletna', 'cijeli sustav', 'od nule', 'full rewrite',
  'complete system', 'from scratch', 'rebuild', 'potpuni',
  'sve ispočetka', 'sve ispostecka', 'major overhaul',
  'full migration', 'kompletna migracija'
]

// ============================================
// TAG → AGENT MAPPING
// ============================================

const TAG_AGENT_MAP: Record<string, string> = {
  '#bug': 'jelena',
  '#fix': 'jelena',
  'implement': 'jelena',
  '#implement': 'jelena',
  '#security': 'malik',
  '#audit': 'malik',
  '#research': 'manda',
  '#investigate': 'manda',
  '#design': 'grga',
  '#ui': 'grga',
  '#ux': 'grga',
  '#test': 'potjeh',
  '#qa': 'potjeh',
  '#architecture': 'kosjenka',
  '#dizajn': 'kosjenka',
  '#art': 'gita',
  '#visual': 'gita',
  '#fpga': 'emard',
  '#verilog': 'emard',
  '#analyze': 'dora',
  '#report': 'dora',
}

const DEFAULT_AGENT = 'regoc'

// ============================================
// HELPERS
// ============================================

function normalizeText(text: string): string {
  return text.toLowerCase().trim()
}

/**
 * TASK-4673 — pogodak po CIJELOJ RIJEČI, ne po podnizu.
 *
 * Prije je ovdje stajao `normalized.includes(kw)`. Kako E1_KEYWORDS sadrži "da", "ne",
 * "ok" i "koji", podniz "ne" postoji u "nedostaje", "ključne", "lokalne" → gotovo svaka
 * hrvatska poruka pogađala je E1 ključnu riječ, pa je E1 grana u praksi značila samo
 * „nema glagola naloga s popisa E2_ACTION_VERBS". Mjereno (TASK-4262 / U2 sjena): od pet
 * promašaja na 20 poruka stvarnog prometa ČETIRI su bili PROPUŠTENI ZADATCI — zahtjev
 * sročen bez imperativa („treba ispraviti", „htio bi") padao je u E1 i nikad se ne bi otvorio.
 *
 * ZAMKA: JS \b se oslanja na \w = [A-Za-z0-9_], gdje „č" NIJE slovo. Zato /\bne\b/
 * i dalje pogađa „ključne". Granicu zato definiramo preko \p{L}\p{N} (Unicode), čime
 * su č/ć/ž/š/đ dio riječi. Popisi riječi i redoslijed grana ostaju netaknuti.
 */
const _kwRegexCache = new Map<string, RegExp>()

function keywordRegex(kw: string): RegExp {
  const key = kw.toLowerCase()
  let re = _kwRegexCache.get(key)
  if (!re) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    re = new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'u')
    _kwRegexCache.set(key, re)
  }
  return re
}

export function containsKeyword(text: string, keywords: string[]): boolean {
  const normalized = normalizeText(text)
  if (!normalized) return false
  return keywords.some(kw => keywordRegex(kw).test(normalized))
}

function countActionVerbs(text: string): number {
  const normalized = normalizeText(text)
  return E2_ACTION_VERBS.filter(v => normalized.includes(v.toLowerCase())).length
}

function hasMultipleActions(text: string): boolean {
  const normalized = normalizeText(text)
  // Check for conjunctions connecting actions
  const hasConjunction = /\bi\b|\band\b|\bte\b|\bpa\b|\btakođer\b|\btakodjer\b|\balso\b|\bthen\b|\bonda\b|\bplus\b/.test(normalized)
  const actionCount = countActionVerbs(normalized)
  return (hasConjunction && actionCount >= 2) || actionCount >= 3
}

function isShortMessage(text: string): boolean {
  return text.trim().length < 50
}

function isVeryLongDescription(text: string): boolean {
  return text.trim().length > 500
}

function mentionsMultipleConcerns(text: string): boolean {
  const normalized = normalizeText(text)
  const concerns = [
    /design|dizajn|arhitektur/,
    /implement|implemen|develop|razvij|izrad/,
    /test|qa|provjer|verify/,   // T1: 'provjer' hvata i provjere/provjera, ne samo 'provjeri'
    /security|sigurnost|audit/,
    /review|pregled/,
    /deploy|production|produkcij/,
    // T1/TASK-3080: istraživanje je zaseban posao (Manda), a nedostajalo je u popisu —
    // zahtjev koji traži istraživanje PA izradu ispadao je jednodijelan.
    /istraz|istraž|research|analiz/,
  ]
  const matchCount = concerns.filter(c => c.test(normalized)).length
  return matchCount >= 3
}

// ============================================
// CLASSIFIER
// ============================================

export class ModeClassifier {

  /**
   * Classify a task based on its title, optional description, and tags.
   */
  classify(input: ClassificationInput): ClassificationResult {
    const { title, description, tags } = input
    const fullText = [title, description || ''].join(' ').trim()

    // --- Check tags first for agent assignment ---
    const tagAgent = tags && tags.length > 0 ? this.getAgentForTags(tags) : DEFAULT_AGENT

    // --- E5 check: major feature ---
    if (containsKeyword(fullText, E5_KEYWORDS) || (description && isVeryLongDescription(description) && hasMultipleActions(fullText))) {
      const agents = this._e5Agents(tagAgent)
      return {
        mode: 'COMPLEX',
        effort: 'E5',
        suggestedAgents: agents,
        reasoning: this._buildReasoning('E5', fullText, tags),
        estimatedMinutes: 120,
      }
    }

    // --- E4 check: full workflow ---
    if (containsKeyword(fullText, E4_KEYWORDS) || mentionsMultipleConcerns(fullText)) {
      // T1/TASK-3080: kad zahtjev traži istraživanje, ono je PRVI korak — bez toga bi
      // arhitekt i inženjer krenuli graditi prije nego itko provjeri činjenice.
      const _e4 = /istraz|istraž|research/.test(normalizeText(fullText))
        ? ['manda', 'kosjenka', 'jelena', 'potjeh']
        : ['kosjenka', 'jelena', 'potjeh', 'malik']
      return {
        mode: 'COMPLEX',
        effort: 'E4',
        suggestedAgents: _e4,
        reasoning: this._buildReasoning('E4', fullText, tags),
        estimatedMinutes: 90,
      }
    }

    // --- E3 check: multi-step tasks ---
    if (containsKeyword(fullText, E3_KEYWORDS) || hasMultipleActions(fullText)) {
      const primary = tagAgent !== DEFAULT_AGENT ? tagAgent : 'jelena'
      return {
        mode: 'STANDARD',
        effort: 'E3',
        suggestedAgents: [primary, 'potjeh'],
        reasoning: this._buildReasoning('E3', fullText, tags),
        estimatedMinutes: 45,
      }
    }

    // --- E1 check: simple/minimal ---
    // Must have no action verbs — if there's an action verb, it's at least E2
    const hasActionVerb = countActionVerbs(fullText) > 0
    if (!hasActionVerb && (containsKeyword(fullText, E1_KEYWORDS) || isShortMessage(fullText))) {
      return {
        mode: 'MINIMAL',
        effort: 'E1',
        suggestedAgents: [],
        reasoning: this._buildReasoning('E1', fullText, tags),
        estimatedMinutes: 2,
      }
    }

    // --- E2: default single-agent task ---
    const assignedAgent = tagAgent !== DEFAULT_AGENT ? tagAgent : this._inferAgentFromText(fullText)
    return {
      mode: 'STANDARD',
      effort: 'E2',
      suggestedAgents: assignedAgent !== DEFAULT_AGENT ? [assignedAgent] : [assignedAgent],
      reasoning: this._buildReasoning('E2', fullText, tags),
      estimatedMinutes: 15,
    }
  }

  /**
   * Shortcut: classify a plain text message (no tags, no separate description).
   *
   * T1/TASK-3080: poruka ide I kao `description`. Prije je išla samo kao `title`, pa
   * E5 grana (`description && isVeryLongDescription(description) && hasMultipleActions`)
   * nikad nije mogla okinuti iz poruke — najsloženiji zahtjevi padali su u E2 i dobivali
   * jednog agenta. Dokaz 30.07.: Goranov zahtjev od ~430 znakova s pet odvojenih poslova
   * klasificiran kao E2/STANDARD, tim=[manda]; nakon ovoga dobiva puni tim.
   * Naslov ostaje skraćen jer duljina naslova nigdje nije mjerilo težine.
   */
  classifyMessage(message: string): ClassificationResult {
    const msg = message || ''
    return this.classify({ title: msg.slice(0, 160), description: msg })
  }

  /**
   * Determine the best agent for a set of tags.
   * Returns the first matching agent or 'regoc' as default.
   */
  getAgentForTags(tags: string[]): string {
    for (const tag of tags) {
      const normalized = tag.startsWith('#') ? tag.toLowerCase() : `#${tag.toLowerCase()}`
      if (TAG_AGENT_MAP[normalized]) {
        return TAG_AGENT_MAP[normalized]
      }
      // Also check without # prefix for keywords like 'implement'
      const bare = tag.toLowerCase().replace(/^#/, '')
      if (TAG_AGENT_MAP[bare]) {
        return TAG_AGENT_MAP[bare]
      }
    }
    return DEFAULT_AGENT
  }

  // ============================================
  // PRIVATE HELPERS
  // ============================================

  private _buildReasoning(tier: EffortTier, text: string, tags?: string[]): string {
    const textLen = text.length
    const tagInfo = tags && tags.length > 0 ? `, tags=[${tags.join(',')}]` : ''

    switch (tier) {
      case 'E1':
        return `Minimal effort: short message (${textLen} chars), matches greeting/status pattern${tagInfo}`
      case 'E2':
        return `Single-agent task: one clear action detected (${textLen} chars)${tagInfo}`
      case 'E3':
        return `Multi-step task: multiple actions or module-level keyword detected (${textLen} chars)${tagInfo}`
      case 'E4':
        return `Full workflow: architecture/system-level keywords or multiple concerns detected (${textLen} chars)${tagInfo}`
      case 'E5':
        return `Major feature: complete system rebuild/rewrite keyword or very long description (${textLen} chars)${tagInfo}`
    }
  }

  private _inferAgentFromText(text: string): string {
    const normalized = normalizeText(text)

    // Try to infer from content keywords
    if (/security|sigurnost|ranjivost|vulnerability|cve/.test(normalized)) return 'malik'
    if (/research|istraži|istrazi|papers?|literature/.test(normalized)) return 'manda'
    if (/test|qa|verif/.test(normalized)) return 'potjeh'
    if (/design|ui|ux|dizajn(?!iraj sustav)|mockup/.test(normalized)) return 'grga'
    if (/architect|arhitektur/.test(normalized)) return 'kosjenka'
    if (/art|ilustracij|visual|crtež|crtez/.test(normalized)) return 'gita'
    if (/fpga|verilog|hdl|gatemate|xilinx/.test(normalized)) return 'emard'
    if (/analy[sz]|report|izvješt|izvjest/.test(normalized)) return 'dora'
    if (/bug|fix|implement|deploy|kod|code|script|modul/.test(normalized)) return 'jelena'

    return DEFAULT_AGENT
  }

  private _e5Agents(primaryFromTag: string): string[] {
    const base = ['kosjenka', 'jelena', 'potjeh', 'malik', 'dora']
    if (primaryFromTag !== DEFAULT_AGENT && !base.includes(primaryFromTag)) {
      base.unshift(primaryFromTag)
    }
    return base
  }
}

// ============================================
// SINGLETON
// ============================================

let _instance: ModeClassifier | null = null

export function getModeClassifier(): ModeClassifier {
  if (!_instance) {
    _instance = new ModeClassifier()
  }
  return _instance
}
