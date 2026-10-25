/**
 * TASK-5792 — ostali pozivi `claude -p` iz ploče nose token pretplate iz spremišta.
 *
 * Na macOS-u ploča (hr.regoc.taskmanager) kreće bez `s-okolinom.sh --tajne`, a prijava je SAMO
 * u spremištu (`CLAUDE_CODE_OAUTH_TOKEN`). Razgovor to rješava od TASK-5786; isti uzrok vrijedi
 * za dežurnog (`Dezurni.ts` / `dezurni.py`, oblik claude-cli) i odlučitelja (`odlucitelj.py`).
 * Lažni `claude` na PATH-u ispisuje token koji je dobio — pravi CLI i pretplata se ne troše.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { sTokenomPretplate } from '../src/core/ClaudePrijava'
import { pitajModel } from '../src/Dezurni'

const TOOLS = join(import.meta.dir, '..', 'tools')
let mapa: string
let spremiste: string
let staziPATH: string | undefined

beforeEach(() => {
  mapa = mkdtempSync(join(tmpdir(), 'tm-5792-'))
  const bin = join(mapa, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\necho "tok=${CLAUDE_CODE_OAUTH_TOKEN:-nema}"\n')
  chmodSync(join(bin, 'claude'), 0o755)
  spremiste = join(mapa, 'credentials.env')
  writeFileSync(spremiste, "OPENROUTER_API_KEY='sk-or-ne-ide-claudeu'\nCLAUDE_CODE_OAUTH_TOKEN='sk-ant-oat01-iz-spremista'\n")
  staziPATH = process.env.PATH
})
afterEach(() => {
  process.env.PATH = staziPATH
  rmSync(mapa, { recursive: true, force: true })
})

describe('sTokenomPretplate — okolina poziva `claude`', () => {
  const izSpremista = (ime: string) => (ime === 'CLAUDE_CODE_OAUTH_TOKEN' ? 'iz-spremista' : 'TUĐA-TAJNA')

  test('okolina bez tokena → token iz spremišta, samo to ime', () => {
    const trazeno: string[] = []
    const o = sTokenomPretplate({ PATH: '/bin' }, ime => { trazeno.push(ime); return izSpremista(ime) })
    expect(o.CLAUDE_CODE_OAUTH_TOKEN).toBe('iz-spremista')
    expect(trazeno).toEqual(['CLAUDE_CODE_OAUTH_TOKEN'])
  })

  test('token u okolini ima prednost', () => {
    expect(sTokenomPretplate({ CLAUDE_CODE_OAUTH_TOKEN: 'okolina' }, izSpremista).CLAUDE_CODE_OAUTH_TOKEN).toBe('okolina')
  })

  test('ANTHROPIC_BASE_URL briše token (i onaj iz okoline)', () => {
    const o = sTokenomPretplate({ ANTHROPIC_BASE_URL: 'http://x', CLAUDE_CODE_OAUTH_TOKEN: 'okolina' }, izSpremista)
    expect(o.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
  })

  test('spremište bez tokena → okolina ostaje bez njega', () => {
    expect('CLAUDE_CODE_OAUTH_TOKEN' in sTokenomPretplate({ PATH: '/bin' }, () => null)).toBe(false)
  })
})

describe('Dezurni.ts — oblik claude-cli', () => {
  test('dežurni na Anthropicu dobiva token iz spremišta kad ga okolina nema', async () => {
    const dezPut = join(mapa, 'dezurni.json')
    writeFileSync(dezPut, JSON.stringify({ provider: 'anthropic', model: 'haiku' }))
    process.env.PATH = `${join(mapa, 'bin')}:${staziPATH}`
    const bezTokena = process.env.CLAUDE_CODE_OAUTH_TOKEN
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN
    try {
      const odg = await pitajModel('s', 'p', 50, {
        dezPut, mcPut: join(mapa, 'nema.json'),
        citajTajnu: ime => (ime === 'CLAUDE_CODE_OAUTH_TOKEN' ? 'sk-ant-oat01-iz-spremista' : null),
      })
      expect(odg).toBe('tok=sk-ant-oat01-iz-spremista')
    } finally {
      if (bezTokena !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = bezTokena
    }
  })
})

/** Python alat pozvan s lažnim `claude` na PATH-u, okolinom bez tokena i podmetnutim spremištem. */
function python(kod: string, dodatno: Record<string, string> = {}): string {
  const env: Record<string, string> = {
    PATH: `${join(mapa, 'bin')}:/usr/bin:/bin:/opt/homebrew/bin`, HOME: mapa,
    TM_CREDENTIALS: spremiste, REGOC_CREDENTIALS_PATH: spremiste, ...dodatno,
  }
  const r = Bun.spawnSync(['python3', '-c', `import sys; sys.path.insert(0, ${JSON.stringify(TOOLS)})\n${kod}`], { env })
  if (r.exitCode !== 0) throw new Error(r.stderr.toString())
  return r.stdout.toString().trim()
}

describe('Python alati — claude -p', () => {
  test('tajna_redak.okolina_claudea: spremište → token; ANTHROPIC_BASE_URL ga briše', () => {
    const k = `from tajna_redak import okolina_claudea as o
print(o(${JSON.stringify(spremiste)}, {"PATH": "/bin"}).get("CLAUDE_CODE_OAUTH_TOKEN"))
print(o(${JSON.stringify(spremiste)}, {"ANTHROPIC_BASE_URL": "http://x", "CLAUDE_CODE_OAUTH_TOKEN": "a"}).get("CLAUDE_CODE_OAUTH_TOKEN"))
print(sorted(set(o(${JSON.stringify(spremiste)}, {})) ))`
    expect(python(k).split('\n')).toEqual(['sk-ant-oat01-iz-spremista', 'None', "['CLAUDE_CODE_OAUTH_TOKEN']"])
  })

  test('dezurni.py probaj() — primarni model s tokenom iz spremišta', () => {
    expect(python('import dezurni; print(dezurni.probaj())')).toContain('tok=sk-ant-oat01-iz-spremista')
  })

  test('dezurni.py pitaj (claude-cli) — token iz spremišta', () => {
    const izlaz = python('import dezurni; print(dezurni.pitaj_model("s", "p", 50, {"provider": "anthropic", "model": "haiku"}))')
    expect(izlaz).toBe('tok=sk-ant-oat01-iz-spremista')
  })

  test('odlucitelj.py _pitaj_claude_cli — token iz spremišta', () => {
    expect(python('import odlucitelj; print(odlucitelj._pitaj_claude_cli("haiku", "p"))')).toBe('tok=sk-ant-oat01-iz-spremista')
  })
})
