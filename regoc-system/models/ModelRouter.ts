/**
 * REGOČ ModelRouter — Intelligent Model Selection
 *
 * Odabire AI provider i model na temelju:
 * 1. Agent identiteta (Jelena → frontier, Klaudio → good)
 * 2. Quality tiera (frontier/strong/good/basic/classifier)
 * 3. Komponente (orchestrator, classifier, embeddings)
 * 4. User overridea iz konfiguracije
 *
 * Fallback chain: agentOverride → componentOverride → defaults[tier] → first enabled provider
 */

import { existsSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import type {
  ModelProvider, ProviderId, QualityTier, ModelRoutingConfig,
  Message, ChatOptions, ChatResponse, ModelInfo, ProviderConfig
} from './ModelInterface'
import { parseModelSpec, resolveEnvValue } from './ModelInterface'
import { homedir } from 'os'

const HOME = process.env.HOME || homedir()
const DEFAULT_CONFIG_PATH = join(HOME, '.claude/regoc/models/model-config.json')

/**
 * REGOC_MODEL_CONFIG: preusmjeravanje konfiguracije (SAMO za testove/alat — produkcija
 * ga ne postavlja, pa je ponašanje nepromijenjeno). Čita se pri pozivu, ne pri importu
 * modula, da redoslijed test-datoteka ne zaključa krivu putanju. (TASK-2568)
 */
function configPathDefault(): string {
  return process.env.REGOC_MODEL_CONFIG || DEFAULT_CONFIG_PATH
}

export class ModelRouter {
  private providers: Map<ProviderId, ModelProvider> = new Map()
  private _config: ModelRoutingConfig
  private _configPath: string
  private _configMtimeMs: number
  private initialized = false

  constructor(configPath?: string) {
    this._configPath = configPath || configPathDefault()
    this._config = this.loadConfig(this._configPath)
    this._configMtimeMs = this.mtimeOf(this._configPath)
  }

  /**
   * TASK-4894 — vruće ponovno čitanje konfiguracije.
   *
   * Router je do 16.09.2026. čitao `model-config.json` SAMO u konstruktoru, a
   * `getModelRouter()` vraća isti primjerak za cijeli život procesa. Promjena modela s
   * ploče je tako mijenjala disk, ali ne i odluke RegocDaemona — vrijedila je tek nakon
   * restarta, što je izvana izgledalo kao da se „postavka ne primjenjuje" ili da su se
   * modeli „sami vratili". (Spawn agenta je i prije bio ispravan: `AgentModel.resolveAgentTarget`
   * čita datoteku pri svakom pozivu. Kvar je bio SAMO u routeru.)
   *
   * Okidač je mtime, ne sat: usporedba je jedan `statSync` po odluci — mjerljivo jeftinije
   * od parsiranja JSON-a, a `mtimeMs` se mijenja i kod `rename` iz ModelConfigWritera.
   * Kad se konfiguracija promijeni, registracija davatelja se poništava (`initialized`),
   * da uključivanje davatelja ne ostane zarobljeno u staroj mapi.
   */
  private mtimeOf(path: string): number {
    try { return statSync(path).mtimeMs } catch { return -1 }
  }

  private get config(): ModelRoutingConfig {
    const sada = this.mtimeOf(this._configPath)
    if (sada !== this._configMtimeMs) {
      // Nestala datoteka (mtime -1) → zadrži zadnju ispravnu konfiguraciju preko
      // loadConfig fail-opena; rutiranje se ne smije srušiti zbog izmjene na disku.
      this._config = this.loadConfig(this._configPath)
      this._configMtimeMs = sada
      this.initialized = false
    }
    return this._config
  }

  private loadConfig(path: string): ModelRoutingConfig {
    if (!existsSync(path)) {
      return this.getDefaultConfig()
    }
    try {
      const raw = readFileSync(path, 'utf-8')
      return JSON.parse(raw) as ModelRoutingConfig
    } catch {
      return this.getDefaultConfig()
    }
  }

  private getDefaultConfig(): ModelRoutingConfig {
    return {
      providers: {
        anthropic: { enabled: true, apiKey: 'env:ANTHROPIC_API_KEY' },
        openai: { enabled: false, apiKey: 'env:OPENAI_API_KEY' },
        google: { enabled: false, apiKey: 'env:GEMINI_API_KEY|GOOGLE_API_KEY' },
        ollama: { enabled: false, baseUrl: 'http://localhost:11434' },
        custom: { enabled: false },
      },
      defaults: {
        frontier: 'anthropic:claude-opus-4-7',
        strong: 'anthropic:claude-sonnet-4-6',
        good: 'anthropic:claude-sonnet-4-6',
        basic: 'anthropic:claude-haiku-4-5',
        classifier: 'anthropic:claude-haiku-4-5',
      },
    }
  }

  /**
   * Registriraj provider. Pozovi za svaki enabled provider pri startu.
   */
  registerProvider(provider: ModelProvider): void {
    this.providers.set(provider.id, provider)
  }

  /**
   * Inicijaliziraj sve enabled providere.
   */
  async init(): Promise<void> {
    if (this.initialized) return

    for (const [id, provConfig] of Object.entries(this.config.providers)) {
      if (!provConfig.enabled) continue

      const providerId = id as ProviderId
      if (this.providers.has(providerId)) continue

      try {
        const provider = await this.createProvider(providerId, provConfig)
        if (provider) {
          const ok = await provider.ping()
          if (ok) {
            this.providers.set(providerId, provider)
          }
        }
      } catch {
        // Provider unavailable — skip silently, will use fallback
      }
    }

    this.initialized = true
  }

  /**
   * Registriraj JEDAN provider na zahtjev (lijeno). Vraća `null` ako nije enabled,
   * ako se ne može stvoriti ili ako ne odgovara na ping. Nikad ne baca.
   */
  private async ensureProvider(id: ProviderId): Promise<ModelProvider | null> {
    const existing = this.providers.get(id)
    if (existing) return existing

    const cfg = this.config.providers?.[id]
    if (!cfg?.enabled) return null

    try {
      const provider = await this.createProvider(id, cfg)
      if (provider && (await provider.ping())) {
        this.providers.set(id, provider)
        return provider
      }
    } catch {
      // Nedostupan provider nije iznimka nego činjenica — pozivatelj dobiva null.
    }
    return null
  }

  private async createProvider(id: ProviderId, config: ProviderConfig): Promise<ModelProvider | null> {
    const apiKey = resolveEnvValue(config.apiKey)

    switch (id) {
      case 'anthropic': {
        const { AnthropicProvider } = await import('./providers/AnthropicProvider')
        return new AnthropicProvider(apiKey, config.baseUrl)
      }
      case 'openai': {
        const { OpenAIProvider } = await import('./providers/OpenAIProvider')
        return new OpenAIProvider(apiKey, config.baseUrl)
      }
      case 'google': {
        const { GoogleProvider } = await import('./providers/GoogleProvider')
        return new GoogleProvider(apiKey)
      }
      case 'ollama': {
        const { OllamaProvider } = await import('./providers/OllamaProvider')
        return new OllamaProvider(config.baseUrl || 'http://localhost:11434')
      }
      default:
        return null
    }
  }

  /**
   * Resolva model spec za dani quality tier, agenta, ili komponentu.
   * Priority: agentOverride → componentOverride → defaults[tier]
   */
  resolve(options: {
    tier?: QualityTier
    agentId?: string
    component?: string
  }): { provider: ProviderId; model: string } {
    const { tier, agentId, component } = options

    if (agentId && this.config.agentOverrides?.[agentId]) {
      return parseModelSpec(this.config.agentOverrides[agentId])
    }

    if (component && this.config.componentOverrides?.[component]) {
      return parseModelSpec(this.config.componentOverrides[component])
    }

    const qualityTier = tier || 'strong'
    const spec = this.config.defaults[qualityTier]
    if (spec) {
      return parseModelSpec(spec)
    }

    return parseModelSpec(this.config.defaults.strong || 'anthropic:claude-sonnet-4-6')
  }

  /**
   * Resolva model za REGOČ agenta iz REGOC_AGENTS.json.
   * Mapira agent model field (opus/sonnet/haiku) na quality tier.
   */
  resolveForAgent(agentId: string, agentModelField?: string): { provider: ProviderId; model: string } {
    if (this.config.agentOverrides?.[agentId]) {
      return parseModelSpec(this.config.agentOverrides[agentId])
    }

    const tier = this.modelFieldToTier(agentModelField || 'sonnet')
    return this.resolve({ tier, agentId })
  }

  private modelFieldToTier(modelField: string): QualityTier {
    switch (modelField.toLowerCase()) {
      case 'opus': return 'frontier'
      case 'sonnet': return 'strong'
      case 'haiku': return 'basic'
      default: return 'strong'
    }
  }

  /**
   * Dohvati provider instancu po ID-u. Null ako nije registriran/enabled.
   */
  getProvider(id: ProviderId): ModelProvider | undefined {
    return this.providers.get(id)
  }

  /**
   * Quick inference — resolva model po tieru i šalje chat request.
   */
  async infer(options: {
    tier?: QualityTier
    agentId?: string
    component?: string
    systemPrompt?: string
    userPrompt: string
    expectJson?: boolean
    timeout?: number
  }): Promise<ChatResponse> {
    const { provider: providerId, model } = this.resolve({
      tier: options.tier,
      agentId: options.agentId,
      component: options.component,
    })

    // TASK-2568: SAMO potrebni provider, ne svi. Prije je `init()` pingao svaki
    // enabled provider, pa je i čisto lokalna klasifikacija spawnala `claude --version`
    // (AnthropicProvider.ping) — jedan Anthropic poziv koji ondje nema što tražiti, a
    // kad je Anthropic spor, i zastoj na putu do lokalnog modela.
    const provider = await this.ensureProvider(providerId)
    if (!provider) {
      const enabled = Object.entries(this.config.providers || {}).filter(([, c]) => (c as ProviderConfig)?.enabled).map(([k]) => k)
      throw new Error(`Provider '${providerId}' not available. Enabled in config: ${enabled.join(', ')}`)
    }

    const messages: Message[] = []
    if (options.systemPrompt) {
      messages.push({ role: 'system', content: options.systemPrompt })
    }
    messages.push({ role: 'user', content: options.userPrompt })

    return provider.chat(messages, {
      model,
      temperature: options.expectJson ? 0 : 0.7,
      maxTokens: options.expectJson ? 2048 : 4096,
      timeout: options.timeout,
      jsonMode: options.expectJson,
    })
  }

  /**
   * Classifier shortcut — za haiku-class brzu klasifikaciju.
   */
  async classify<T>(systemPrompt: string, userPrompt: string, timeout?: number): Promise<T> {
    const response = await this.infer({
      tier: 'classifier',
      component: 'classifier',
      systemPrompt,
      userPrompt,
      expectJson: true,
      timeout,
    })

    try {
      return JSON.parse(extractJson(response.content)) as T
    } catch {
      throw new Error(`Classifier response not valid JSON: ${response.content.substring(0, 200)}`)
    }
  }

  /**
   * Dohvati CLI komandu za spawn agenta — backward compatible s `claude --print --model X`.
   * Ovo je bridge dok ne migriramo potpuno na API-based spawn.
   */
  getSpawnCommand(agentId: string, agentModelField?: string): { cmd: string; args: string[]; model: string } {
    const { provider, model } = this.resolveForAgent(agentId, agentModelField)

    if (provider === 'anthropic') {
      return {
        cmd: 'claude',
        args: ['--print', '--dangerously-skip-permissions', '--model', model],
        model,
      }
    }

    if (provider === 'openai') {
      return {
        cmd: 'codex',
        args: ['--print', '--model', model],
        model,
      }
    }

    // Fallback: claude CLI (works for most cases via Claude Code)
    return {
      cmd: 'claude',
      args: ['--print', '--dangerously-skip-permissions', '--model', model],
      model,
    }
  }

  /**
   * Lista svih dostupnih modela od svih enabled providera.
   */
  async listAllModels(): Promise<ModelInfo[]> {
    await this.init()
    const all: ModelInfo[] = []
    for (const provider of this.providers.values()) {
      try {
        const models = await provider.listModels()
        all.push(...models)
      } catch {
        // Skip unavailable providers
      }
    }
    return all
  }

  /**
   * Health check svih providera.
   */
  async healthCheck(): Promise<Record<ProviderId, boolean>> {
    const result: Record<string, boolean> = {}
    for (const [id, provider] of this.providers) {
      try {
        result[id] = await provider.ping()
      } catch {
        result[id] = false
      }
    }
    return result as Record<ProviderId, boolean>
  }

  /**
   * Dohvati trenutnu konfiguraciju (bez API keyeva!).
   */
  getSafeConfig(): Record<string, unknown> {
    const safe = JSON.parse(JSON.stringify(this.config))
    for (const prov of Object.values(safe.providers || {})) {
      const p = prov as Record<string, unknown>
      if (p.apiKey) p.apiKey = '***'
    }
    return safe
  }
}

/**
 * TASK-2568: modeli odgovaraju JSON-om, ali ga rado zamotaju. Mjereno 2026-09-02 na
 * `anthropic:haiku` (claude --print): odgovor je bio ```json\n{"tier":"E1"}\n``` i
 * `classify()` je BEZ IZNIMKE pucao — komponentni klasifikator dakle nikad nije radio.
 * Skida markdown ogradu i `<think>` blok, pa uzima prvi uravnotežen {...} ili [...].
 * Ako ništa ne nađe, vraća ulaz nepromijenjen (pozivatelj i dalje dobije svoju grešku).
 */
export function extractJson(raw: string): string {
  if (!raw) return raw
  let s = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) s = fence[1].trim()
  const start = s.search(/[{\[]/)
  if (start === -1) return s
  const open = s[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0, inStr = false, esc = false
  for (let i = start; i < s.length; i++) {
    const c = s[i]
    if (esc) { esc = false; continue }
    if (c === '\\') { esc = true; continue }
    if (c === '"') { inStr = !inStr; continue }
    if (inStr) continue
    if (c === open) depth++
    else if (c === close && --depth === 0) return s.slice(start, i + 1)
  }
  return s.slice(start)
}

let _routerInstance: ModelRouter | null = null
let _routerPath = ''

export function getModelRouter(configPath?: string): ModelRouter {
  const path = configPath || configPathDefault()
  // Promjena putanje (test fixture) poništava singleton — inače bi prvi test
  // zaključao konfiguraciju za sve ostale.
  if (!_routerInstance || _routerPath !== path) {
    _routerInstance = new ModelRouter(path)
    _routerPath = path
  }
  return _routerInstance
}

/** Odbaci keširani router (testovi/alat). */
export function resetModelRouter(): void {
  _routerInstance = null
  _routerPath = ''
}
