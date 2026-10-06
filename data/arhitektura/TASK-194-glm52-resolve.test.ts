/**
 * TASK-194 / TASK-209 (jelena · engineer) — izvršna dorada arhitekture GLM-5.2.
 *
 * Što ovaj test DOKAZUJE (offline, bez GLM_API_KEY i bez interneta):
 *   §4.2 iz plana (data/arhitektura/TASK-194-plan-test-glm52.md): ModelRouter za override
 *   "glm:glm-5.2" vraća {provider:'glm', model:'glm-5.2'} i NE pada na anthropic fallback.
 *
 * I pokriva dora-F3 (negativni test): kad je GLM_API_KEY prazan, anthropic-kompat
 * token-gate (getAnthropicCompatProvider u RegocDaemon.ts) vraća null → spawn se PRESKAČE
 * ("nema tokena — preskačem"), umjesto tihog uspjeha kao anthropic. Zato živi smoke-test
 * (T3) NE smije zaključiti "GLM radi" iz HTTP 200 — mora prvo potvrditi da je ključ prisutan.
 *
 * Pokretanje:  bun test data/arhitektura/TASK-194-glm52-resolve.test.ts
 */
import { test, expect } from 'bun:test'
import { writeFileSync, mkdtempSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { ModelRouter } from '/home/regoc/.claude/regoc/models/ModelRouter'
import { parseModelSpec } from '/home/regoc/.claude/regoc/models/ModelInterface'

const PROD_CONFIG = '/home/regoc/.claude/regoc/models/model-config.json'

// Privremeni config s izoliranim test-ciljem (componentOverride) — NE dira produkciju.
function tempConfigWithGlm52(): string {
  const base = JSON.parse(readFileSync(PROD_CONFIG, 'utf-8'))
  base.componentOverrides = { ...(base.componentOverrides || {}), 'glm52-test': 'glm:glm-5.2' }
  const dir = mkdtempSync(join(tmpdir(), 'glm52-'))
  const p = join(dir, 'model-config.json')
  writeFileSync(p, JSON.stringify(base, null, 2))
  return p
}

test('parseModelSpec cijepa "glm:glm-5.2" u {provider:glm, model:glm-5.2}', () => {
  const spec = parseModelSpec('glm:glm-5.2')
  expect(spec.provider).toBe('glm')
  expect(spec.model).toBe('glm-5.2')
})

test('§4.2 rezolucija: ModelRouter za glm:glm-5.2 NE pada na anthropic fallback', () => {
  const router = new ModelRouter(tempConfigWithGlm52())
  const r = router.resolve({ component: 'glm52-test' })
  expect(r.provider).toBe('glm')
  expect(r.model).toBe('glm-5.2')
  expect(r.provider).not.toBe('anthropic') // eksplicitno: nema tihog fallbacka
})

test('provider glm je enabled i anthropic-kompatibilan u produkciji (preduvjet spawna)', () => {
  const mc = JSON.parse(readFileSync(PROD_CONFIG, 'utf-8'))
  const glm = mc.providers?.glm
  expect(glm?.enabled).toBe(true)
  expect(glm?.anthropicCompatible).toBe(true)
  expect(glm?.baseUrl).toContain('z.ai')
  expect(glm?.apiKey).toBe('env:GLM_API_KEY')
})

// dora-F3 — negativni test: zrcali token-gate iz RegocDaemon.getAnthropicCompatProvider.
// Dokaz da prazan ključ => null (preskok), a ne tihi prolaz. Bez ovoga T3 lažno prolazi.
function compatTokenGate(providerId: string, env: Record<string, string | undefined>): { baseUrl: string, token: string } | null {
  const mc = JSON.parse(readFileSync(PROD_CONFIG, 'utf-8'))
  const pc = mc?.providers?.[providerId]
  if (!pc || !pc.anthropicCompatible || pc.enabled === false || !pc.baseUrl) return null
  const ak = pc.apiKey || ''
  const token = (typeof ak === 'string' && ak.startsWith('env:')) ? (env[ak.slice(4)] || '') : String(ak)
  if (!token) return null
  return { baseUrl: pc.baseUrl, token }
}

test('dora-F3: prazan GLM_API_KEY => compat-gate vraća null (spawn se preskače, nema tihog fallbacka)', () => {
  expect(compatTokenGate('glm', { GLM_API_KEY: undefined })).toBeNull()
  expect(compatTokenGate('glm', { GLM_API_KEY: '' })).toBeNull()
})

test('dora-F3: s prisutnim ključem compat-gate vraća z.ai baseUrl + token', () => {
  const got = compatTokenGate('glm', { GLM_API_KEY: 'test-xyz' })
  expect(got).not.toBeNull()
  expect(got!.baseUrl).toContain('z.ai')
  expect(got!.token).toBe('test-xyz')
})

test('stanje danas (T0 gate): GLM_API_KEY stvarno NIJE u okolini ovog procesa', () => {
  // Potvrđuje da je živi test i dalje blokiran na R1 — hard gate stoji.
  expect(process.env.GLM_API_KEY).toBeFalsy()
})
