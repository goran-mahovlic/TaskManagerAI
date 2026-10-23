/**
 * TASK-5730 — ploča nudi Gemini CLI model koji Google još poslužuje.
 *
 * macmini-pv, 23.10.2026.: s ključem GEMINI_API_KEY ploča je nudila samo geminicli:gemini-2.5-*,
 * a Google za nove korisnike na gemini-2.5-flash vraća 404 („no longer available to new users …
 * use models/gemini-3.8-flash"). Model sustava zato mora moći biti geminicli:gemini-3.8-flash.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { podigni, spusti, type Posluzitelj } from './helpers/posluzitelj'

let p: Posluzitelj | null = null
let mapa = ''

beforeAll(async () => {
  mapa = mkdtempSync(join(tmpdir(), 'tm-gemcli-'))
  mkdirSync(join(mapa, 'config'), { recursive: true })
  writeFileSync(join(mapa, 'config', 'credentials.env'), "GEMINI_API_KEY='AIza-test'\n", { mode: 0o600 })
  writeFileSync(join(mapa, 'model-config.json'), JSON.stringify({
    defaults: { frontier: 'anthropic:claude-opus-5', strong: 'anthropic:claude-sonnet-5', good: 'anthropic:claude-sonnet-5', basic: 'anthropic:claude-haiku-4-5' },
    agentOverrides: {}, providers: { anthropic: { enabled: true }, geminicli: { enabled: true, apiKey: 'env:GEMINI_API_KEY|GOOGLE_API_KEY' } },
  }))
  p = await podigni({}, {
    HOME: mapa,
    TM_CREDENTIALS: join(mapa, 'config', 'credentials.env'),
    TM_MODEL_CONFIG: join(mapa, 'model-config.json'),
  })
})

afterAll(() => {
  spusti(p)
  if (mapa) rmSync(mapa, { recursive: true, force: true })
})

describe('Model sustava — Gemini CLI uz GEMINI_API_KEY', () => {
  test('PUT /api/models/svi prihvaća geminicli:gemini-3.8-flash', async () => {
    const r = await fetch(`${p!.url}/api/models/svi`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'geminicli:gemini-3.8-flash', tko: 'test' }),
    })
    const d = await r.json() as any
    expect(r.status).toBe(200)
    expect(d.stanje?.cilj).toBe('geminicli:gemini-3.8-flash')
  })
})
