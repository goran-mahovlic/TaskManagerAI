/**
 * Mjerilo potrošnje (`tools/session_usage.py`) i čitač na ploči (`src/SessionUsage.ts`)
 * moraju gledati ISTU datoteku keša, i to ispod korijena instalacije (`TM_HOME`), a ne
 * ispod tuđeg rasporeda mapa (ADR-0001 O1.1 / O1.4).
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'fs'
import { join } from 'path'
import os from 'os'

const PAKET = join(import.meta.dir, '..')
const SKRIPTA = join(PAKET, 'tools', 'session_usage.py')

/** Putanje kako ih vidi Python skripta pod zadanom okolinom. */
function putanjePythona(env: Record<string, string>): Record<string, string> {
  const kod = [
    'import importlib.util, json, sys',
    `spec = importlib.util.spec_from_file_location("su", ${JSON.stringify(SKRIPTA)})`,
    'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
    'print(json.dumps({k: str(getattr(m, k)) for k in ("LOG_FILE","CACHE_FILE","TG_LOG","SESSIONS_PATH","REGOC_SEND")}))',
  ].join('\n')
  const r = Bun.spawnSync(['python3', '-c', kod], { env: { PATH: process.env.PATH ?? '', ...env } })
  if (r.exitCode !== 0) throw new Error(r.stderr.toString())
  return JSON.parse(r.stdout.toString())
}

describe('session_usage — putanje iz okoline', () => {
  test('s TM_HOME sve radne datoteke idu u $TM_HOME/data', () => {
    const home = mkdtempSync(join(os.tmpdir(), 'tm-su-'))
    const p = putanjePythona({ HOME: '/nepostojeci', TM_HOME: home })
    expect(p.LOG_FILE).toBe(join(home, 'data', 'session_usage.jsonl'))
    expect(p.CACHE_FILE).toBe(join(home, 'data', 'session_usage.cache.json'))
    expect(p.TG_LOG).toBe(join(home, 'data', 'session_usage.telegram.log'))
    expect(p.SESSIONS_PATH).toBe(join(home, 'data', 'chat_sessions.json'))
  })

  test('bez TM_HOME zadano je ~/.taskmanager/data, bez ičijeg drugog rasporeda', () => {
    const p = putanjePythona({ HOME: '/h' })
    expect(p.CACHE_FILE).toBe('/h/.taskmanager/data/session_usage.cache.json')
    for (const k of ['LOG_FILE', 'CACHE_FILE', 'TG_LOG', 'SESSIONS_PATH'])
      expect(p[k].startsWith('/h/.taskmanager/data/')).toBe(true)
    expect(p.REGOC_SEND).toBe('None') // bez TM_TELEGRAM_SEND nema pošiljatelja
  })

  test('pošiljatelj i sesije se zadaju okolinom', () => {
    const p = putanjePythona({
      HOME: '/h',
      TM_TELEGRAM_SEND: '/x/posalji.py',
      TM_TELEGRAM_SESSIONS: '/x/sesije.json',
    })
    expect(p.REGOC_SEND).toBe('/x/posalji.py')
    expect(p.SESSIONS_PATH).toBe('/x/sesije.json')
  })

  test('ploča čita keš koji skripta piše, i zove skriptu iz paketa', async () => {
    const home = mkdtempSync(join(os.tmpdir(), 'tm-su-'))
    const r = Bun.spawnSync(
      ['bun', '-e', `const m = await import(${JSON.stringify(join(PAKET, 'src', 'SessionUsage.ts'))});
        console.log(JSON.stringify({c: m.SESSION_USAGE_CACHE_FILE, s: m.SESSION_USAGE_SCRIPT}))`],
      { env: { PATH: process.env.PATH ?? '', HOME: '/nepostojeci', TM_HOME: home } },
    )
    expect(r.exitCode).toBe(0)
    const ts = JSON.parse(r.stdout.toString())
    expect(ts.c).toBe(putanjePythona({ HOME: '/nepostojeci', TM_HOME: home }).CACHE_FILE)
    expect(ts.s).toBe(SKRIPTA)
  })
})
