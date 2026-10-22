/**
 * Ollama Provider — Lokalni modeli via Ollama REST API
 *
 * Za: classifier, embeddings, i low-cost agent taskove.
 * REGOČ koristi Ollamu (adresa iz model-config / OLLAMA_HOST) za qwen3-embedding:8b.
 */

import type {
  ModelProvider, ProviderId, Message, ChatOptions, ChatResponse,
  ModelInfo, ModelCapabilities
} from '../ModelInterface'

const DEFAULT_CAPABILITIES: ModelCapabilities = {
  maxContextTokens: 32768,
  maxOutputTokens: 4096,
  supportsTools: false,
  supportsVision: false,
  supportsStreaming: true,
  thinkingCapable: false,
  codeCapable: true,
  costPerMInputTokens: 0,
  costPerMOutputTokens: 0,
  latencyClass: 'medium',
  qualityClass: 'basic',
}

const KNOWN_MODELS: Record<string, Partial<ModelCapabilities>> = {
  'qwen3:8b': { maxContextTokens: 32768, qualityClass: 'basic', codeCapable: true },
  'qwen3:32b': { maxContextTokens: 32768, qualityClass: 'good', codeCapable: true },
  'qwen3:72b': { maxContextTokens: 32768, qualityClass: 'strong', codeCapable: true },
  'qwen3-embedding:8b': { maxContextTokens: 8192, qualityClass: 'basic' },
  'llama3:8b': { maxContextTokens: 8192, qualityClass: 'basic', codeCapable: true },
  'llama3:70b': { maxContextTokens: 8192, qualityClass: 'strong', codeCapable: true },
  'deepseek-coder-v2:latest': { maxContextTokens: 32768, qualityClass: 'good', codeCapable: true },
  'mistral:latest': { maxContextTokens: 32768, qualityClass: 'good', codeCapable: true },
  'phi3:mini': { maxContextTokens: 4096, qualityClass: 'basic', codeCapable: true, latencyClass: 'fast' },
}

export class OllamaProvider implements ModelProvider {
  readonly id: ProviderId = 'ollama'
  readonly name = 'Ollama (Local)'
  private baseUrl: string

  constructor(baseUrl: string = 'http://localhost:11434') {
    this.baseUrl = baseUrl.replace(/\/$/, '')
  }

  /**
   * TASK-2568: qwen3 je "thinking" model. Bez `think:false` Ollama vraća
   * `message.content === ""` a cijeli odgovor stavi u `message.thinking`, pa
   * `ModelRouter.classify()` puca na praznom JSON-u. Mjereno 2026-09-02:
   * think:true → content "" | think:false → content '{"tier":"E1"}'.
   * Modeli bez te sposobnosti vrate HTTP 400 na `think`, pa se poziv u tom
   * slučaju JEDNOM ponavlja bez tog polja (stari put ostaje ispravan).
   */
  async chat(messages: Message[], options: ChatOptions): Promise<ChatResponse> {
    const startTime = Date.now()
    const model = options.model || 'qwen3:8b'

    const ollamaMessages = messages.map(m => ({
      role: m.role,
      content: m.content,
    }))

    if (options.systemPrompt) {
      ollamaMessages.unshift({ role: 'system', content: options.systemPrompt })
    }

    const controller = new AbortController()
    const timeout = options.timeout || 60000
    const timer = setTimeout(() => controller.abort(), timeout)

    const baseBody: Record<string, unknown> = {
      model,
      messages: ollamaMessages,
      stream: false,
      options: {
        temperature: options.temperature ?? 0.7,
        num_predict: options.maxTokens || 4096,
      },
    }
    if (options.jsonMode) baseBody.format = 'json'

    const post = (body: Record<string, unknown>) => fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    try {
      let response = await post({ ...baseBody, think: false })
      if (response.status === 400) {
        // Model ne poznaje `think` — vrati se na stari oblik zahtjeva.
        response = await post(baseBody)
      }

      clearTimeout(timer)

      if (!response.ok) {
        throw new Error(`Ollama API error: ${response.status} ${response.statusText}`)
      }

      const data = await response.json() as {
        message?: { content?: string; thinking?: string }
        eval_count?: number
        prompt_eval_count?: number
      }

      // Ako je model ipak mislio (starija verzija Ollame ignorira think:false),
      // sadržaj je u `thinking` — bolje išta nego prazan string.
      const content = data.message?.content || data.message?.thinking || ''

      return {
        content,
        model,
        provider: 'ollama',
        usage: {
          inputTokens: data.prompt_eval_count || 0,
          outputTokens: data.eval_count || 0,
        },
        latencyMs: Date.now() - startTime,
      }
    } catch (error) {
      clearTimeout(timer)
      throw error
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) })
      if (!response.ok) return []

      const data = await response.json() as { models?: Array<{ name: string; size: number }> }
      return (data.models || []).map(m => ({
        id: m.name,
        name: m.name,
        provider: 'ollama' as ProviderId,
        capabilities: this.getCapabilities(m.name) || { ...DEFAULT_CAPABILITIES },
      }))
    } catch {
      return []
    }
  }

  async ping(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) })
      return response.ok
    } catch {
      return false
    }
  }

  getCapabilities(modelId: string): ModelCapabilities | undefined {
    const known = KNOWN_MODELS[modelId]
    if (known) {
      return { ...DEFAULT_CAPABILITIES, ...known }
    }
    return { ...DEFAULT_CAPABILITIES }
  }
}
