/**
 * REGOČ KnowledgeHarvester — Automatic Knowledge Capture
 *
 * Extracts knowledge from session transcripts and stores in KnowledgeGraph + RAG.
 * Designed to be called from SessionEnd hook or manually.
 */

import { getKnowledgeGraph } from './KnowledgeGraph'

export type KnowledgeCategory = 'lesson' | 'decision' | 'pattern' | 'error' | 'insight'

export interface HarvestCandidate {
  category: KnowledgeCategory
  title: string
  content: string
  tags: string[]
  confidence: number // 0-1
}

export interface HarvestResult {
  candidates: HarvestCandidate[]
  saved: number
  skipped: number
  reason?: string
}

const CATEGORY_KEYWORDS: Record<KnowledgeCategory, string[]> = {
  lesson: ['naučili', 'lekcija', 'lesson', 'learned', 'greška', 'error', 'fix', 'bug', 'popravak', 'ne ponavljaj'],
  decision: ['odluka', 'decision', 'odabrali', 'chose', 'decided', 'arhitektura', 'pristup', 'approach'],
  pattern: ['pattern', 'obrazac', 'uvijek', 'always', 'nikad', 'never', 'pravilo', 'rule', 'best practice'],
  error: ['crash', 'fail', 'broken', 'ne radi', 'greška', 'error', 'bug', 'regression', 'pokvarili'],
  insight: ['zanimljivo', 'insight', 'otkrili', 'discovered', 'neočekivano', 'unexpected', 'bitno', 'important'],
}

export class KnowledgeHarvester {
  private maxCandidatesPerSession = 3
  private minConfidence = 0.5
  private minSessionLengthChars = 500

  /**
   * Extract knowledge candidates from session text.
   * Rule-based (no AI call) — looks for keyword patterns and structures.
   */
  extract(sessionText: string): HarvestCandidate[] {
    if (sessionText.length < this.minSessionLengthChars) return []

    const candidates: HarvestCandidate[] = []
    const paragraphs = sessionText.split(/\n(?=##\s)|(?:\n{2,})/).filter(p => p.trim())

    for (const para of paragraphs) {
      if (para.length < 50) continue

      const candidate = this.analyzeParagraph(para)
      if (candidate && candidate.confidence >= this.minConfidence) {
        // Deduplicate by title similarity
        const isDupe = candidates.some(c =>
          c.title.toLowerCase() === candidate.title.toLowerCase() ||
          c.content === candidate.content
        )
        if (!isDupe) candidates.push(candidate)
      }

      if (candidates.length >= this.maxCandidatesPerSession) break
    }

    return candidates
  }

  private analyzeParagraph(text: string): HarvestCandidate | null {
    const lower = text.toLowerCase()
    let bestCategory: KnowledgeCategory | null = null
    let bestScore = 0

    for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
      let score = 0
      for (const kw of keywords) {
        if (lower.includes(kw)) score += 1
      }
      if (score > bestScore) {
        bestScore = score
        bestCategory = category as KnowledgeCategory
      }
    }

    if (!bestCategory || bestScore === 0) return null

    const confidence = Math.min(bestScore / 3, 1)
    const title = this.extractTitle(text, bestCategory)
    const tags = this.extractTags(text)

    return {
      category: bestCategory,
      title,
      content: text.substring(0, 1000),
      tags,
      confidence,
    }
  }

  private extractTitle(text: string, category: KnowledgeCategory): string {
    // Try to extract a title from the first line or heading
    const firstLine = text.split('\n')[0].replace(/^#+\s*/, '').trim()
    if (firstLine.length > 10 && firstLine.length < 100) {
      return firstLine
    }
    return `${category}: ${text.substring(0, 60).replace(/\n/g, ' ').trim()}...`
  }

  private extractTags(text: string): string[] {
    const tags: string[] = []
    const lower = text.toLowerCase()

    const tagMap: Record<string, string> = {
      security: '#security', fpga: '#fpga', telegram: '#telegram',
      typescript: '#typescript', docker: '#docker', agent: '#agent',
      rag: '#rag', database: '#database', test: '#testing',
      api: '#api', bug: '#bug', performance: '#performance',
    }

    for (const [keyword, tag] of Object.entries(tagMap)) {
      if (lower.includes(keyword) && !tags.includes(tag)) {
        tags.push(tag)
      }
    }

    return tags.slice(0, 5)
  }

  /**
   * Harvest knowledge from session and save to KnowledgeGraph.
   */
  harvest(sessionText: string): HarvestResult {
    const candidates = this.extract(sessionText)
    if (candidates.length === 0) {
      return { candidates: [], saved: 0, skipped: 0, reason: 'No knowledge candidates found' }
    }

    let saved = 0
    let skipped = 0

    try {
      const kg = getKnowledgeGraph()
      for (const c of candidates) {
        if (c.confidence < this.minConfidence) {
          skipped++
          continue
        }

        kg.addNode({
          title: c.title,
          type: c.category,
          content: c.content,
          tags: c.tags,
          source: 'auto-harvest',
        })
        saved++
      }
    } catch {
      return { candidates, saved, skipped, reason: 'KnowledgeGraph unavailable' }
    }

    return { candidates, saved, skipped }
  }
}

let _instance: KnowledgeHarvester | null = null

export function getKnowledgeHarvester(): KnowledgeHarvester {
  if (!_instance) _instance = new KnowledgeHarvester()
  return _instance
}
