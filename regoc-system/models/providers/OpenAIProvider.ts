/**
 * OpenAI Provider — GPT/o-series modeli via OpenAI API
 */

import type {
  ModelProvider, ProviderId, Message, ChatOptions, ChatResponse,
  ModelInfo, ModelCapabilities
} from '../ModelInterface'

const MODELS: Record<string, ModelCapabilities> = {
  'gpt-4o': {
    maxContextTokens: 128000, maxOutputTokens: 16384,
    supportsTools: true, supportsVision: true, supportsStreaming: true,
    thinkingCapable: false, codeCapable: true,
    costPerMInputTokens: 2.5, costPerMOutputTokens: 10,
    latencyClass: 'medium', qualityClass: 'strong',
  },
  'gpt-4o-mini': {
    maxContextTokens: 128000, maxOutputTokens: 16384,
    supportsTools: true, supportsVision: true, supportsStreaming: true,
    thinkingCapable: false, codeCapable: true,
    costPerMInputTokens: 0.15, costPerMOutputTokens: 0.6,
    latencyClass: 'fast', qualityClass: 'good',
  },
  'o4-mini': {
    maxContextTokens: 200000, maxOutputTokens: 100000,
    supportsTools: true, supportsVision: true, supportsStreaming: true,
    thinkingCapable: true, codeCapable: true,
    costPerMInputTokens: 1.1, costPerMOutputTokens: 4.4,
    latencyClass: 'medium', qualityClass: 'strong',
  },
}

export class OpenAIProvider implements ModelProvider {
  readonly id: ProviderId = 'openai'
  readonly name = 'OpenAI'
  private apiKey?: string
  private baseUrl: string

  constructor(apiKey?: string, baseUrl?: string) {
    this.apiKey = apiKey
    this.baseUrl = (baseUrl || 'https://api.openai.com').replace(/\/$/, '')
  }

  async chat(messages: Message[], options: ChatOptions): Promise<ChatResponse> {
    if (!this.apiKey) throw new Error('OpenAI API key not configured')
    const startTime = Date.now()
    const model = options.model || 'gpt-4o'

    const oaiMessages = messages.map(m => ({ role: m.role, content: m.content }))
    if (options.systemPrompt) {
      oaiMessages.unshift({ role: 'system' as const, content: options.systemPrompt })
    }

    const controller = new AbortController()
    const timeout = options.timeout || 60000
    const timer = setTimeout(() => controller.abort(), timeout)

    try {
      const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: oaiMessages,
          temperature: options.temperature ?? 0.7,
          max_tokens: options.maxTokens || 4096,
        }),
        signal: controller.signal,
      })

      clearTimeout(timer)
      if (!response.ok) {
        const errText = await response.text()
        throw new Error(`OpenAI API error ${response.status}: ${errText}`)
      }

      const data = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>
        usage?: { prompt_tokens?: number; completion_tokens?: number }
      }

      return {
        content: data.choices?.[0]?.message?.content || '',
        model,
        provider: 'openai',
        usage: {
          inputTokens: data.usage?.prompt_tokens || 0,
          outputTokens: data.usage?.completion_tokens || 0,
        },
        latencyMs: Date.now() - startTime,
      }
    } catch (error) {
      clearTimeout(timer)
      throw error
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    return Object.entries(MODELS).map(([id, caps]) => ({
      id, name: id, provider: 'openai' as ProviderId, capabilities: caps,
    }))
  }

  async ping(): Promise<boolean> {
    if (!this.apiKey) return false
    try {
      const resp = await fetch(`${this.baseUrl}/v1/models`, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(5000),
      })
      return resp.ok
    } catch {
      return false
    }
  }

  getCapabilities(modelId: string): ModelCapabilities | undefined {
    return MODELS[modelId]
  }
}
