/**
 * Anthropic Claude Provider — wrappa Claude CLI za REGOČ ModelInterface
 *
 * Koristi `claude --print --model X` jer REGOČ koristi Claude Code subscription,
 * ne direktni API key. Ovo je backward-compatible pristup.
 */

import { spawn } from 'child_process'
import type {
  ModelProvider, ProviderId, Message, ChatOptions, ChatResponse,
  ModelInfo, ModelCapabilities
} from '../ModelInterface'
import { homedir } from 'os'

const MODELS: Record<string, ModelCapabilities> = {
  'claude-opus-4-7': {
    maxContextTokens: 1000000,
    maxOutputTokens: 32768,
    supportsTools: true,
    supportsVision: true,
    supportsStreaming: true,
    thinkingCapable: true,
    codeCapable: true,
    costPerMInputTokens: 15,
    costPerMOutputTokens: 75,
    latencyClass: 'slow',
    qualityClass: 'frontier',
  },
  'claude-sonnet-4-6': {
    maxContextTokens: 200000,
    maxOutputTokens: 16384,
    supportsTools: true,
    supportsVision: true,
    supportsStreaming: true,
    thinkingCapable: true,
    codeCapable: true,
    costPerMInputTokens: 3,
    costPerMOutputTokens: 15,
    latencyClass: 'medium',
    qualityClass: 'strong',
  },
  'claude-haiku-4-5': {
    maxContextTokens: 200000,
    maxOutputTokens: 8192,
    supportsTools: true,
    supportsVision: true,
    supportsStreaming: true,
    thinkingCapable: false,
    codeCapable: true,
    costPerMInputTokens: 0.25,
    costPerMOutputTokens: 1.25,
    latencyClass: 'fast',
    qualityClass: 'basic',
  },
  // Aliasi za backward compatibility s REGOC_AGENTS.json
  'opus': {
    maxContextTokens: 1000000,
    maxOutputTokens: 32768,
    supportsTools: true,
    supportsVision: true,
    supportsStreaming: true,
    thinkingCapable: true,
    codeCapable: true,
    costPerMInputTokens: 15,
    costPerMOutputTokens: 75,
    latencyClass: 'slow',
    qualityClass: 'frontier',
  },
  'sonnet': {
    maxContextTokens: 200000,
    maxOutputTokens: 16384,
    supportsTools: true,
    supportsVision: true,
    supportsStreaming: true,
    thinkingCapable: true,
    codeCapable: true,
    costPerMInputTokens: 3,
    costPerMOutputTokens: 15,
    latencyClass: 'medium',
    qualityClass: 'strong',
  },
  'haiku': {
    maxContextTokens: 200000,
    maxOutputTokens: 8192,
    supportsTools: true,
    supportsVision: true,
    supportsStreaming: true,
    thinkingCapable: false,
    codeCapable: true,
    costPerMInputTokens: 0.25,
    costPerMOutputTokens: 1.25,
    latencyClass: 'fast',
    qualityClass: 'basic',
  },
}

/**
 * Dodatne postavke CLI poziva (TASK-4837). Zadana vrijednost je BAJT-IDENTIČNA ponašanju
 * prije ovog zadatka — bez njih se ne mijenja nijedan postojeći pozivatelj (ModelRouter).
 */
export interface AnthropicCliOpts {
  /** Dodatni argumenti za `claude --print` (npr. `--restricted` = sesija bez ugrađenih alata). */
  dodatniArgumenti?: string[]
  /** Traži `--output-format json` i popuni `usage`/`costUsd`. Bez toga cijena ostaje nepoznata. */
  mjeriTrosak?: boolean
}

export class AnthropicProvider implements ModelProvider {
  readonly id: ProviderId = 'anthropic'
  readonly name = 'Anthropic Claude'
  private apiKey?: string
  private baseUrl?: string
  private cli: AnthropicCliOpts

  constructor(apiKey?: string, baseUrl?: string, cli: AnthropicCliOpts = {}) {
    this.apiKey = apiKey
    this.baseUrl = baseUrl
    this.cli = cli
  }

  async chat(messages: Message[], options: ChatOptions): Promise<ChatResponse> {
    const startTime = Date.now()
    const model = options.model || 'sonnet'

    const systemPrompt = options.systemPrompt ||
      messages.find(m => m.role === 'system')?.content || ''
    const userPrompt = messages.filter(m => m.role === 'user').map(m => m.content).join('\n')

    const fullPrompt = systemPrompt
      ? `${systemPrompt}\n\n---\n\n${userPrompt}`
      : userPrompt

    const env: Record<string, string> = {
      PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
      HOME: process.env.HOME || homedir(),
      USER: process.env.USER || 'klaudio',
      SHELL: process.env.SHELL || '/bin/bash',
      TERM: 'xterm-256color',
      BUN_INSTALL: process.env.BUN_INSTALL || `${process.env.HOME}/.bun`,
    }
    // Don't pass CLAUDECODE env to prevent nested session errors

    const sirovo = await this.runClaude(model, fullPrompt, env, options.timeout || 60000)
    const { content, usage, costUsd } = this.cli.mjeriTrosak ? raspakirajJson(sirovo) : { content: sirovo, usage: undefined, costUsd: undefined }

    return {
      content,
      model,
      provider: 'anthropic',
      usage,
      costUsd,
      latencyMs: Date.now() - startTime,
    }
  }

  private runClaude(model: string, prompt: string, env: Record<string, string>, timeout: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = ['--print', '--model', model, ...(this.cli.dodatniArgumenti || []),
                    ...(this.cli.mjeriTrosak ? ['--output-format', 'json'] : []), '-p', prompt]
      const proc = spawn('claude', args, {
        env,
        cwd: env.HOME,
      })

      let stdout = ''
      let stderr = ''

      proc.stdout.on('data', (data: Buffer) => { stdout += data.toString() })
      proc.stderr.on('data', (data: Buffer) => { stderr += data.toString() })

      const timer = setTimeout(() => {
        proc.kill('SIGTERM')
        reject(new Error(`Anthropic inference timed out after ${timeout}ms`))
      }, timeout)

      proc.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0) {
          resolve(stdout.trim())
        } else {
          reject(new Error(`Claude CLI exited with code ${code}: ${stderr}`))
        }
      })

      proc.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })
  }

  async listModels(): Promise<ModelInfo[]> {
    return Object.entries(MODELS)
      .filter(([id]) => !['opus', 'sonnet', 'haiku'].includes(id)) // skip aliases
      .map(([id, caps]) => ({
        id,
        name: id.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
        provider: 'anthropic' as ProviderId,
        capabilities: caps,
      }))
  }

  async ping(): Promise<boolean> {
    try {
      // Check if claude CLI is available
      const proc = spawn('claude', ['--version'], {
        env: { PATH: process.env.PATH || '' },
        timeout: 5000,
      })
      return new Promise((resolve) => {
        proc.on('close', (code) => resolve(code === 0))
        proc.on('error', () => resolve(false))
      })
    } catch {
      return false
    }
  }

  getCapabilities(modelId: string): ModelCapabilities | undefined {
    return MODELS[modelId]
  }
}

/**
 * `--output-format json` vraća omotnicu s rezultatom I računom. Ako se ne raščlani, tekst
 * se vraća kakav jest — mjerenje koje ne zna cijenu mora to REĆI (costUsd izostaje), a ne
 * upisati nulu: nula bi u zbroju izgledala kao besplatan poziv.
 */
function raspakirajJson(sirovo: string): { content: string; usage?: { inputTokens: number; outputTokens: number }; costUsd?: number } {
  try {
    const o = JSON.parse(sirovo)
    const u = o?.usage || {}
    const ulaz = Number(u.input_tokens || 0) + Number(u.cache_creation_input_tokens || 0) + Number(u.cache_read_input_tokens || 0)
    return {
      content: String(o?.result ?? ''),
      usage: { inputTokens: ulaz, outputTokens: Number(u.output_tokens || 0) },
      costUsd: Number.isFinite(Number(o?.total_cost_usd)) ? Number(o.total_cost_usd) : undefined,
    }
  } catch {
    return { content: sirovo }
  }
}
