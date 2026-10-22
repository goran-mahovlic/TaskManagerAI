/**
 * Google Gemini Provider — via Google AI Studio REST API
 */

import type {
  ModelProvider, ProviderId, Message, ChatOptions, ChatResponse,
  ModelInfo, ModelCapabilities
} from '../ModelInterface'

const MODELS: Record<string, ModelCapabilities> = {
  'gemini-2.5-pro': {
    maxContextTokens: 1000000, maxOutputTokens: 65536,
    supportsTools: true, supportsVision: true, supportsStreaming: true,
    thinkingCapable: true, codeCapable: true,
    costPerMInputTokens: 1.25, costPerMOutputTokens: 10,
    latencyClass: 'medium', qualityClass: 'frontier',
  },
  'gemini-2.5-flash': {
    maxContextTokens: 1000000, maxOutputTokens: 65536,
    supportsTools: true, supportsVision: true, supportsStreaming: true,
    thinkingCapable: true, codeCapable: true,
    costPerMInputTokens: 0.15, costPerMOutputTokens: 0.6,
    latencyClass: 'fast', qualityClass: 'good',
  },
}

export class GoogleProvider implements ModelProvider {
  readonly id: ProviderId = 'google'
  readonly name = 'Google Gemini'
  private apiKey?: string

  constructor(apiKey?: string) {
    this.apiKey = apiKey
  }

  async chat(messages: Message[], options: ChatOptions): Promise<ChatResponse> {
    if (!this.apiKey) throw new Error('Google API key not configured')
    const startTime = Date.now()
    const model = options.model || 'gemini-2.5-flash'

    const systemPrompt = options.systemPrompt ||
      messages.find(m => m.role === 'system')?.content
    const userMessages = messages.filter(m => m.role !== 'system')

    const contents = userMessages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }))

    const body: Record<string, unknown> = { contents }
    if (systemPrompt) {
      body.systemInstruction = { parts: [{ text: systemPrompt }] }
    }
    body.generationConfig = {
      temperature: options.temperature ?? 0.7,
      maxOutputTokens: options.maxTokens || 4096,
    }

    const controller = new AbortController()
    const timeout = options.timeout || 60000
    const timer = setTimeout(() => controller.abort(), timeout)

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this.apiKey}`
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      clearTimeout(timer)
      if (!response.ok) {
        const errText = await response.text()
        throw new Error(`Google API error ${response.status}: ${errText}`)
      }

      const data = await response.json() as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
      }

      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || ''

      return {
        content: text,
        model,
        provider: 'google',
        usage: {
          inputTokens: data.usageMetadata?.promptTokenCount || 0,
          outputTokens: data.usageMetadata?.candidatesTokenCount || 0,
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
      id, name: id, provider: 'google' as ProviderId, capabilities: caps,
    }))
  }

  async ping(): Promise<boolean> {
    if (!this.apiKey) return false
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${this.apiKey}`
      const resp = await fetch(url, { signal: AbortSignal.timeout(5000) })
      return resp.ok
    } catch {
      return false
    }
  }

  getCapabilities(modelId: string): ModelCapabilities | undefined {
    return MODELS[modelId]
  }
}
