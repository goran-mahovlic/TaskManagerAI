/**
 * ClassifierModel — postavka „Klasifikacijski model" (TASK-2635, analiza 160_MODEL_SWITCHING dio C).
 *
 * REGOČ ima TRI dodirne točke modela; ovo je samo PRVA:
 *   1. rutirajući klasifikator  → `REGOC_INFERENCE_MODEL` / `componentOverrides.classifier`  ← ovaj modul
 *   2. sistemski odgovori       → statični predlošci, bez modela
 *   3. REGOČ izvršava zadatak   → `agentOverrides['regoc']` (Info tab, dropdown po agentu)
 *
 * Klasifikator se namjerno drži ODVOJENO od izvršnog modela: zove se na svaku poruku,
 * pa mora ostati brz i lokalan (Ollama). Zato ovaj modul odbija svaki cloud spec.
 *
 * DVA ZAPISA, JEDNA VRIJEDNOST — potrošač je `skills/CORE/Tools/Inference.ts`:
 *   `process.env.REGOC_INFERENCE_MODEL` → `componentOverrides.classifier` → 'qwen3:8b'
 * Env pobjeđuje config, ali env se čita SAMO pri pokretanju procesa (spremište vjerodajnica
 * nije izvor okoline demona u ovom kontejneru). Config se čita po pozivu, dakle vruće.
 * Zato upis ide u OBA mjesta s istom vrijednošću: GUI djeluje odmah (config), a appliance/VM
 * koji spremište učitava u okolinu dobiva istu vrijednost nakon restarta.
 */
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'fs'
import { join } from 'path'
import { konfigPutanja } from '../paths'

export const CLASSIFIER_DEFAULT_SPEC = 'ollama:qwen3:8b'
export const CLASSIFIER_ENV_KEY = 'REGOC_INFERENCE_MODEL'
export const CLASSIFIER_PROVIDER_ENV_KEY = 'REGOC_INFERENCE_PROVIDER'

/** Prefiksi koji NISU lokalni — klasifikator ih ne smije koristiti. */
const REMOTE_PROVIDERS = [
  'anthropic', 'geminicli', 'kimicli', 'openrouter', 'openai', 'google',
  'glm', 'kimi', 'minimax', 'qwen', 'deepseek', 'claude',
]

export type ParseResult =
  | { ok: true; spec: string; model: string }
  | { ok: false; error: string }

export type ClassifierSetting = {
  spec: string
  model: string
  /** Odakle vrijednost stvarno dolazi — 'process-env' znači da config nema učinka do restarta. */
  source: 'process-env' | 'config' | 'default'
  /** Vrijednost zapisana u spremištu vjerodajnica (postoji li redak) — bez ispisa vrijednosti drugdje. */
  storeValue: string | null
  configSpec: string | null
  baseUrl: string
}

// TASK-5108: ista spremišta kao ostatak paketa (ConfigModul / DezurniConfig), ne raspored
// orkestratora. Parametar `HOME` je ostao radi potpisa pozivatelja.
export function classifierStorePath(_HOME: string): string {
  return konfigPutanja('credentials.env', 'TM_CREDENTIALS')
}

function configPath(_HOME: string): string {
  return konfigPutanja('model-config.json', 'TM_MODEL_CONFIG')
}

/** Naziv modela → spec `ollama:<model>`; sve što nije lokalno se odbija. */
export function parseClassifierSpec(raw: string): ParseResult {
  const s = String(raw ?? '').trim()
  if (!s) return { ok: false, error: 'Prazan naziv modela.' }
  if (/[\s\r\n]/.test(s)) return { ok: false, error: 'Naziv modela ne smije sadržavati razmak ni novi red.' }
  if (s.includes('@')) return { ok: false, error: 'Mesh oblik (ollama@čvor:model) nije podržan za klasifikator — koristi lokalni Ollama server.' }

  const head = s.split(':')[0].toLowerCase()
  if (REMOTE_PROVIDERS.includes(head)) {
    return { ok: false, error: `Klasifikator mora ostati lokalan (ollama:…) — '${head}' je udaljeni provider i usporio bi rutiranje svake poruke.` }
  }

  const model = head === 'ollama' ? s.slice('ollama:'.length) : s
  if (!model) return { ok: false, error: 'Nedostaje naziv modela iza "ollama:".' }
  return { ok: true, spec: 'ollama:' + model, model }
}

/** Postavi `KEY=value` u .env tekst — zamijeni postojeći redak ili dopiši novi. */
export function upsertEnvLine(text: string, key: string, value: string): string {
  const re = new RegExp('^' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=.*$', 'm')
  const line = `${key}=${value}`
  if (re.test(text)) return text.replace(re, line)
  return (text.replace(/\s*$/, '') + '\n' + line + '\n').replace(/^\n/, '')
}

/** Ukloni redak `KEY=…` iz .env teksta (ostali ključevi ostaju netaknuti). */
export function removeEnvLine(text: string, key: string): string {
  const re = new RegExp('^' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=.*\\n?', 'm')
  return text.replace(re, '')
}

function readConfig(HOME: string): any | null {
  try { return JSON.parse(readFileSync(configPath(HOME), 'utf-8')) } catch { return null }
}

function readStoreValue(HOME: string): string | null {
  try {
    const p = classifierStorePath(HOME)
    if (!existsSync(p)) return null
    const m = readFileSync(p, 'utf-8').match(new RegExp('^' + CLASSIFIER_ENV_KEY + '=(.*)$', 'm'))
    return m ? m[1].trim() || null : null
  } catch { return null }
}

/** Trenutno DJELATNA postavka klasifikatora, s izvorom (isti redoslijed kao Inference.ts). */
export function readClassifier(HOME: string, env: Record<string, string | undefined> = process.env): ClassifierSetting {
  const mc = readConfig(HOME)
  const baseUrl = (typeof mc?.providers?.ollama?.baseUrl === 'string' && mc.providers.ollama.baseUrl)
    ? mc.providers.ollama.baseUrl : 'http://127.0.0.1:11434'

  const rawCfg = mc?.componentOverrides?.classifier
  const configSpec = (typeof rawCfg === 'string' && rawCfg.startsWith('ollama:')) ? rawCfg : null
  const storeValue = readStoreValue(HOME)

  const fromEnv = (env[CLASSIFIER_ENV_KEY] || '').trim()
  if (fromEnv) {
    return { spec: 'ollama:' + fromEnv, model: fromEnv, source: 'process-env', storeValue, configSpec, baseUrl }
  }
  if (configSpec) {
    return { spec: configSpec, model: configSpec.slice('ollama:'.length), source: 'config', storeValue, configSpec, baseUrl }
  }
  return {
    spec: CLASSIFIER_DEFAULT_SPEC,
    model: CLASSIFIER_DEFAULT_SPEC.slice('ollama:'.length),
    source: 'default', storeValue, configSpec, baseUrl,
  }
}

export type WriteResult =
  | { ok: true; spec: string; model: string }
  | { ok: false; error: string }

function writeConfigClassifier(HOME: string, spec: string | null): { ok: true } | { ok: false; error: string } {
  const p = configPath(HOME)
  if (!existsSync(p)) return { ok: false, error: 'model-config.json ne postoji — ne mogu spremiti klasifikator.' }
  let mc: any
  try { mc = JSON.parse(readFileSync(p, 'utf-8')) } catch (e) { return { ok: false, error: 'model-config.json nije ispravan JSON: ' + String(e) } }
  if (!mc.componentOverrides || typeof mc.componentOverrides !== 'object') mc.componentOverrides = {}
  if (spec === null) delete mc.componentOverrides.classifier
  else mc.componentOverrides.classifier = spec
  writeFileSync(p, JSON.stringify(mc, null, 2) + '\n')
  return { ok: true }
}

function writeStore(HOME: string, mutate: (txt: string) => string): void {
  const f = classifierStorePath(HOME)
  const txt = existsSync(f) ? readFileSync(f, 'utf-8') : ''
  writeFileSync(f, mutate(txt), { mode: 0o600 })
  try { chmodSync(f, 0o600) } catch {}   // postojeća datoteka zadržava stara prava bez ovoga
}

/** Postavi klasifikacijski model (config = odmah, spremište = za appliance/restart). */
export function writeClassifier(HOME: string, raw: string): WriteResult {
  const parsed = parseClassifierSpec(raw)
  if (!parsed.ok) return parsed
  const cfg = writeConfigClassifier(HOME, parsed.spec)   // prvo config: ako padne, spremište ostaje čisto
  if (!cfg.ok) return { ok: false, error: cfg.error }
  writeStore(HOME, txt => upsertEnvLine(txt, CLASSIFIER_ENV_KEY, parsed.model))
  return { ok: true, spec: parsed.spec, model: parsed.model }
}

/** Vrati klasifikator na ugrađeni default (miče oba zapisa). */
export function clearClassifier(HOME: string): { ok: true } | { ok: false; error: string } {
  const cfg = writeConfigClassifier(HOME, null)
  if (!cfg.ok) return cfg
  if (existsSync(classifierStorePath(HOME))) {
    writeStore(HOME, txt => removeEnvLine(txt, CLASSIFIER_ENV_KEY))
  }
  return { ok: true }
}
