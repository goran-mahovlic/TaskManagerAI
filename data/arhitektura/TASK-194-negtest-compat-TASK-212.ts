// Replicira TOČNU logiku getAnthropicCompatProvider (RegocDaemon.ts:1066-1078) + guard (3013-3018)
// protiv STVARNE produkcijske konfiguracije, pod tri scenarija ključa.
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
const HOME = process.env.HOME || '/home/regoc'

function getAnthropicCompatProvider(provider: string, env: Record<string,string|undefined>): { baseUrl: string, token: string } | null {
  try {
    const p = join(HOME, '.claude/regoc/models/model-config.json')
    if (!existsSync(p)) return null
    const mc = JSON.parse(readFileSync(p, 'utf-8'))
    const pc = mc?.providers?.[provider]
    if (!pc || !pc.anthropicCompatible || pc.enabled === false || !pc.baseUrl) return null
    const ak = pc.apiKey || ''
    const token = (typeof ak === 'string' && ak.startsWith('env:')) ? (env[ak.slice(4)] || '') : String(ak)
    if (!token) return null   // r.1075: nema tokena -> null (spawn se preskače)
    return { baseUrl: pc.baseUrl, token }
  } catch { return null }
}
// Guard iz r.3013-3018: provider=glm nije anthropic/openrouter/ollama/kimicli/geminicli
function spawnDecision(provider: string, env: Record<string,string|undefined>) {
  const special = ['anthropic','openrouter','ollama','kimicli','geminicli'].includes(provider)
  const compat = !special ? getAnthropicCompatProvider(provider, env) : null
  if (!special && !compat) return { action: 'ABORT_SPAWN', note: 'guard r.3017 return — poruka "nije konfiguriran kao anthropic-kompatibilan", agent se NE spawna' }
  if (compat) return { action: 'SPAWN_TO', baseUrl: compat.baseUrl, routesTo: compat.baseUrl.includes('z.ai') ? 'z.ai (NE anthropic)' : compat.baseUrl }
  return { action: 'SPAWN_ANTHROPIC', note: 'normalni claude CLI' }
}

let pass=0, fail=0
function check(name:string, cond:boolean, detail:string){ console.log(`${cond?'PASS':'FAIL'} ${name} — ${detail}`); cond?pass++:fail++ }

// Scenarij A: GLM_API_KEY nije postavljen (današnje stvarno stanje)
const envA = { ...process.env }; delete envA.GLM_API_KEY
const dA = spawnDecision('glm', envA)
check('A prazan/odsutan ključ -> ABORT (bez fallbacka na anthropic)', dA.action==='ABORT_SPAWN', JSON.stringify(dA))

// Scenarij B: GLM_API_KEY = "" (prazan string)
const dB = spawnDecision('glm', { ...process.env, GLM_API_KEY: '' })
check('B prazan string -> ABORT (bez fallbacka)', dB.action==='ABORT_SPAWN', JSON.stringify(dB))

// Scenarij C: GLM_API_KEY = nevaljan ne-prazan ključ
const dC = spawnDecision('glm', { ...process.env, GLM_API_KEY: 'INVALID_TEST_KEY_regoc' })
check('C nevaljan ključ -> SPAWN na z.ai (NE anthropic), endpoint vraća 401', dC.action==='SPAWN_TO' && dC.routesTo?.includes('z.ai'), JSON.stringify(dC))

// Kontrola: ni u jednom scenariju ne smije biti SPAWN_ANTHROPIC (tihi fallback)
check('NIKAD tihi fallback na anthropic', dA.action!=='SPAWN_ANTHROPIC'&&dB.action!=='SPAWN_ANTHROPIC'&&dC.action!=='SPAWN_ANTHROPIC', 'nema SPAWN_ANTHROPIC ni u A/B/C')

console.log(`\nRESULT: ${pass} pass, ${fail} fail`)
process.exit(fail>0?1:0)
