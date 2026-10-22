/**
 * AgentModel — JEDAN izvor istine za pitanje „koji model vozi ovaj agent".
 *
 * ZAŠTO POSTOJI (dizajn TASK-4838 §4.2, ADR-0004): razrješenje `agentOverrides` živjelo je
 * kao PRIVATNA funkcija `resolveSpawnModel` u `RegocDaemon.ts` (r. 934). Sudac (`Sudac.ts`)
 * treba isto razrješenje, a preslika pravila se razilazi — točno onaj kvar zbog kojeg je i
 * nastao `adversarial-pozivac.ts` (dva alata, dvije preslike dispatcha, jedan je bacao
 * grešku, drugi tiho rezao prefiks). Zato je razrješenje ovdje, a oba pozivatelja ga uvoze.
 *
 * PRIJENOS JE DOSLOVAN: ponašanje je bajt-za-bajt isto kao prije (uključujući fail-open
 * `catch {}` i preskakanje ključeva koji počinju s `_`, jer su u `model-config.json`
 * komentari i primjeri). Test `tests/agent-model.test.ts` to drži na mjestu.
 *
 * Autorica: Jelena (Engineer), TASK-4839.
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const HOME = process.env.HOME || homedir()

/** Zadana putanja konfiguracije modela. Testovi je preusmjeravaju u sandbox. */
export const MODEL_CONFIG_PATH = join(HOME, '.claude/regoc/models/model-config.json')

export interface SpawnTarget {
  provider: string
  model: string
  /** Imenovani mesh čvor (`providers.<provider>.nodes[node]`); bez njega zadani baseUrl. */
  node?: string
}

/**
 * Razriješi `agentOverrides[agentId]` u cilj spawna.
 *
 * Format je `provider[@node]:model`; model SMIJE sadržavati dvotočku (`qwen3:8b`), pa se
 * reže samo na PRVOJ. Sve što se ne da razriješiti → `{ provider: 'anthropic', model: fallback }`
 * — fail-open je namjeran: kriva postavka ne smije zaustaviti spawn, nego ga vratiti na
 * registarski alias.
 */
export function resolveAgentTarget(
  agentId: string,
  fallbackModel: string,
  opts: { configPath?: string; log?: (m: string) => void } = {},
): SpawnTarget {
  const zadano: SpawnTarget = { provider: 'anthropic', model: fallbackModel }
  try {
    const p = opts.configPath || MODEL_CONFIG_PATH
    if (!existsSync(p)) return zadano
    const mc = JSON.parse(readFileSync(p, 'utf-8'))
    const spec = mc?.agentOverrides?.[agentId]
    if (!spec || typeof spec !== 'string' || agentId.startsWith('_')) return zadano
    const idx = spec.indexOf(':')
    if (idx < 0) return zadano
    const head = spec.slice(0, idx)   // 'ollama' ili 'ollama@node-a'
    const model = spec.slice(idx + 1) // model smije sadržavati ':' (npr. 'qwen3:8b')
    const at = head.indexOf('@')
    const provider = at >= 0 ? head.slice(0, at) : head
    const node = at >= 0 ? head.slice(at + 1) : undefined
    if (provider && model) {
      opts.log?.(`[MODEL-OVERRIDE] ${agentId} → ${provider}${node ? '@' + node : ''}:${model}`)
      return { provider, model, node }
    }
  } catch { /* neispravna konfiguracija ne smije srušiti spawn */ }
  return zadano
}
