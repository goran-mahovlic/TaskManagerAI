/**
 * TASK-5311 (prijenos s glavnog, TASK-5305): `claude` preusmjeren na drugog providera
 * (ANTHROPIC_BASE_URL → OpenRouter i sl.) ne troši Anthropic sesiju, pa ga kuka
 * `--hook prompt` ne smije zaustaviti ni kad je sesija iznad praga.
 */
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { join } from 'path'
import os from 'os'

const SKRIPTA = join(import.meta.dir, '..', 'tools', 'session_usage.py')

/** Instalacija s kešom potrošnje „sesija 99 %", svjež. */
function punaSesija(): string {
  const home = mkdtempSync(join(os.tmpdir(), 'tm-su-van-'))
  mkdirSync(join(home, 'data'), { recursive: true })
  writeFileSync(join(home, 'data', 'session_usage.cache.json'), JSON.stringify({
    cached_at: Date.now() / 1000,
    entry: { session_percent: 99, session_reset_at: new Date(Date.now() + 3600e3).toISOString() },
  }))
  return home
}

function kuka(env: Record<string, string>): string {
  const r = Bun.spawnSync(['python3', SKRIPTA, '--hook', 'prompt'], {
    env: { PATH: process.env.PATH ?? '', HOME: '/nepostojeci', ...env }, stdin: new TextEncoder().encode('{}'),
  })
  return r.stdout.toString()
}

const pozivVan = (env: Record<string, string>) => {
  const kod = [
    'import importlib.util, json',
    `spec = importlib.util.spec_from_file_location("su", ${JSON.stringify(SKRIPTA)})`,
    'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
    `print(json.dumps(m.poziv_van_anthropica(${JSON.stringify(env)})))`,
  ].join('\n')
  const r = Bun.spawnSync(['python3', '-c', kod], { env: { PATH: process.env.PATH ?? '', HOME: '/h' } })
  if (r.exitCode !== 0) throw new Error(r.stderr.toString())
  return JSON.parse(r.stdout.toString())
}

describe('session_usage — poziv mimo Anthropica se ne koči', () => {
  test('poziv_van_anthropica: OpenRouter da, anthropic.com i prazno ne', () => {
    expect(pozivVan({ ANTHROPIC_BASE_URL: 'https://openrouter.ai/api' })).toBe(true)
    expect(pozivVan({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com' })).toBe(false)
    expect(pozivVan({ ANTHROPIC_BASE_URL: '  ' })).toBe(false)
    expect(pozivVan({})).toBe(false)
  })

  test('sesija 99 % + Anthropic → kuka blokira', () => {
    const out = kuka({ TM_HOME: punaSesija() })
    expect(out).toContain('"decision": "block"')
  })

  test('sesija 99 % + ANTHROPIC_BASE_URL na OpenRouter → kuka propušta', () => {
    const out = kuka({ TM_HOME: punaSesija(), ANTHROPIC_BASE_URL: 'https://openrouter.ai/api' })
    expect(out).not.toContain('block')
    expect(out).toContain('suppressOutput')
  })
})
