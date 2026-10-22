/**
 * REGOČ Model Abstraction Layer — Core Interfaces
 *
 * Unified interface za sve AI providere (Anthropic, OpenAI, Google, Ollama, Custom).
 * Sustav MORA biti model-agnostik: bilo koji kvalitetniji model može pokretati REGOČ.
 */

import { procitajTajnuSpremista, putSpremistaTajni } from '../lib/spremiste-tajni'

// Quality tiers — apstrahiraju specifične model nazive
export type QualityTier = 'frontier' | 'strong' | 'good' | 'basic' | 'classifier'

// Provider identifiers
export type ProviderId = 'anthropic' | 'openai' | 'google' | 'ollama' | 'custom'

export interface Message {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ToolDefinition {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

export interface ChatOptions {
  model: string
  temperature?: number
  maxTokens?: number
  tools?: ToolDefinition[]
  systemPrompt?: string
  stream?: boolean
  timeout?: number
  /** TASK-2568: traži strogi JSON izlaz (Ollama `format:"json"`). Provideri koji to ne
   *  podržavaju smiju polje ignorirati — semantika ostaje ista, samo bez jamstva. */
  jsonMode?: boolean
}

export interface ChatResponse {
  content: string
  model: string
  provider: ProviderId
  usage?: {
    inputTokens: number
    outputTokens: number
  }
  /** Cijena poziva u USD kad je provider zna (Claude CLI ju vraća uz `--output-format json`).
   *  Provideri koji cijenu ne znaju polje izostavljaju — mjerenje tada zna da ne zna. */
  costUsd?: number
  latencyMs: number
  stopReason?: string
  toolCalls?: Array<{
    name: string
    input: Record<string, unknown>
  }>
}

export interface ModelCapabilities {
  maxContextTokens: number
  maxOutputTokens: number
  supportsTools: boolean
  supportsVision: boolean
  supportsStreaming: boolean
  thinkingCapable: boolean
  codeCapable: boolean
  costPerMInputTokens: number
  costPerMOutputTokens: number
  latencyClass: 'fast' | 'medium' | 'slow'
  qualityClass: QualityTier
}

export interface ModelInfo {
  id: string
  name: string
  provider: ProviderId
  capabilities: ModelCapabilities
}

export interface ProviderConfig {
  enabled: boolean
  apiKey?: string
  baseUrl?: string
  orgId?: string
  extraHeaders?: Record<string, string>
}

/**
 * Base interface za sve AI providere.
 * Svaki provider (Anthropic, OpenAI, Google, Ollama) implementira ovo.
 */
export interface ModelProvider {
  readonly id: ProviderId
  readonly name: string

  chat(messages: Message[], options: ChatOptions): Promise<ChatResponse>
  listModels(): Promise<ModelInfo[]>
  ping(): Promise<boolean>
  getCapabilities(modelId: string): ModelCapabilities | undefined
}

/**
 * Konfiguracija za ModelRouter — mapira quality tiers na specifične modele.
 */
export interface ModelRoutingConfig {
  providers: Record<ProviderId, ProviderConfig>
  defaults: Record<QualityTier, string>  // tier → "provider:model"
  agentOverrides?: Record<string, string>  // agentId → "provider:model"
  componentOverrides?: Record<string, string>  // componentName → "provider:model"
}

/**
 * Parsira "provider:model" string u dijelove.
 * Primjeri: "anthropic:claude-opus-4-7" → { provider: "anthropic", model: "claude-opus-4-7" }
 *           "ollama:qwen3:8b" → { provider: "ollama", model: "qwen3:8b" }
 */
export function parseModelSpec(spec: string): { provider: ProviderId; model: string } {
  const colonIdx = spec.indexOf(':')
  if (colonIdx === -1) {
    return { provider: 'anthropic', model: spec }
  }
  const provider = spec.substring(0, colonIdx) as ProviderId
  const model = spec.substring(colonIdx + 1)
  return { provider, model }
}

/**
 * Pročitaj JEDNU imenovanu varijablu iz spremišta vjerodajnica.
 *
 * Namjerno čita samo traženo ime i vrijednost VRAĆA (ne izvozi u `process.env`) — spremište
 * ima i tajne koje ovaj proces ne treba, a sve u `process.env` vidljivo je kroz okolinu procesa (procfs environ, `ps e`).
 * Isti obrazac već koriste `tools/openrouter-agent.ts` i `ClassifierModel.ts`.
 */
function readFromCredentialStore(name: string, HOME: string): string | undefined {
  // TASK-5705: zajednički čitač razumije i zapis ploče paketa (`IME='…'`, ADR-0007 §5.2)
  return procitajTajnuSpremista(name, putSpremistaTajni({ REGOC_CREDENTIALS: process.env.REGOC_CREDENTIALS, HOME })) ?? undefined
}

/**
 * Resolva environment variable reference.
 * "env:ANTHROPIC_API_KEY" → process.env.ANTHROPIC_API_KEY
 * "env:GEMINI_API_KEY|GOOGLE_API_KEY" → prvo ime koje je postavljeno (lanac zamjena)
 * "literal-value" → "literal-value"
 *
 * ZAŠTO LANAC (TASK-4786, 09.09.2026.): isti ključ različiti izdavatelji zovu različito —
 * Google AI Studio i `gemini` CLI koriste `GEMINI_API_KEY`, a naša je konfiguracija tražila
 * `GOOGLE_API_KEY`. Ključ postavljen pod „krivim" imenom izgledao je kao da ga nema.
 *
 * ZAŠTO SPREMIŠTE: vjerodajnice žive u `~/.claude/regoc/credentials.env`, a taj se datotečni
 * spremnik NE učitava u `process.env` daemona (provjereno: `regoc-services.sh` ga ne source-a).
 * Bez ovog koraka `apiKey: "env:X"` je bio mrtvo slovo za svakog in-process providera —
 * preimenovanje varijable to samo po sebi ne bi popravilo.
 */
export function resolveEnvValue(
  value: string | undefined,
  env: Record<string, string | undefined> = process.env,
  HOME: string = env.HOME || process.env.HOME || '',
): string | undefined {
  if (!value) return undefined
  if (!value.startsWith('env:')) return value

  const names = value.substring(4).split('|').map(n => n.trim()).filter(Boolean)
  for (const name of names) {
    const fromEnv = env[name]
    if (fromEnv) return fromEnv
  }
  for (const name of names) {
    const fromStore = readFromCredentialStore(name, HOME)
    if (fromStore) return fromStore
  }
  return undefined
}
