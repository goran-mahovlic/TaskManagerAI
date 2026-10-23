/**
 * TASK-5733 — razgovor bez Claudea: spec `geminicli:*` ili `google:*` vozi `gemini` CLI
 * (`-p`, `-m`, `--output-format json`, GEMINI_API_KEY u okolini), ne `claude` CLI koji bez
 * prijave pada („Not logged in") pa odgovor stiže tek preko dežurnog, bez alata.
 *
 * Pravi proces, LAŽNI `gemini`: skripta ljuske na PATH-u zapisuje argv i okolinu, a vraća
 * JSON kakav vraća `gemini --output-format json` (`{"response": …, "stats": …}`).
 *
 * Autorica: Jelena (Engineer), TASK-5733.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { ciljRazgovora } from '../src/core/models/PrebaciSve'
import { argumentiGeminija, izvrsiteljRazgovora, nadjiGemini } from '../src/razgovor/Izvrsitelj'
import { stvoriRazgovor } from '../src/razgovor/Razgovor'
import { RAZGOVOR_ZADANO, type RazgovorPostavke } from '../src/razgovor/RazgovorPostavke'
import type { Kanal, UlaznaPoruka } from '../src/razgovor/Kanal'
import { OPIS_OVLASTI } from '../src/razgovor/Ovlasti'

let mapa: string
let bin: string
let zapis: string
beforeEach(() => {
  mapa = mkdtempSync(join(tmpdir(), 'tm-razg-gem-'))
  bin = join(mapa, 'bin')
  zapis = join(mapa, 'poziv.txt')
  mkdirSync(bin)
  // Lažni gemini: svaki argument pa okolina, odvojeni znakom RS (\x1e) — prompt ima više redaka.
  writeFileSync(join(bin, 'gemini'), `#!/bin/sh
for a in "$@"; do printf 'ARG:%s\\036' "$a"; done > '${zapis}'
printf 'KEY:%s\\036TRUST:%s\\036CLAUDE:%s\\036PWD:%s\\036' "$GEMINI_API_KEY" "$GEMINI_CLI_TRUST_WORKSPACE" "$CLAUDE_CODE_OAUTH_TOKEN" "$(pwd)" >> '${zapis}'
printf '%s' '{"response":"zdravo iz geminija","stats":{"models":{"gemini-3.8-flash":{"tokens":{"prompt":12,"candidates":5}}}}}'
`)
  chmodSync(join(bin, 'gemini'), 0o755)
})
afterEach(() => { rmSync(mapa, { recursive: true, force: true }) })

const zapisi = () => readFileSync(zapis, 'utf-8').split('\x1e')
const argumenti = () => zapisi().filter(r => r.startsWith('ARG:')).map(r => r.slice(4))
const okolinaPoziva = (k: string) => (zapisi().find(r => r.startsWith(`${k}:`)) || '').slice(k.length + 1)

describe('ciljRazgovora — geminicli/google idu kroz gemini CLI', () => {
  const tajne: Record<string, string> = { GEMINI_API_KEY: 'AIza-test' }
  const citaj = (ime: string) => tajne[ime] ?? null

  test('geminicli:<model> → izvršitelj gemini, GEMINI_API_KEY u okolini, nije Anthropic', () => {
    expect(ciljRazgovora('geminicli:gemini-3.8-flash', {}, citaj)).toEqual({
      model: 'gemini-3.8-flash', env: { GEMINI_API_KEY: 'AIza-test' }, anthropic: false, izvrsitelj: 'gemini',
    })
  })
  test('google:<model> (izravni API ključ) → isti gemini CLI', () => {
    const c = ciljRazgovora('google:gemini-3.8-flash', { google: { apiKey: 'env:GEMINI_API_KEY' } }, citaj)
    expect(c.izvrsitelj).toBe('gemini')
    expect(c.env.GEMINI_API_KEY).toBe('AIza-test')
    expect(c.greska).toBeUndefined()
  })
  test('bez ključa → greška s imenom ključa, nema tihog pada na Claude', () => {
    const c = ciljRazgovora('geminicli:gemini-3.8-flash', {}, () => null)
    expect(c.anthropic).toBe(false)
    expect(c.greska).toMatch(/GEMINI_API_KEY/)
  })
})

describe('argumentiGeminija — ovlasti razgovora', () => {
  // Sigurnosni pregled TASK-5733: gemini nema popis zabrana (tajne) ni stražu ljuske kao claude
  // put, a pisanje u radnu mapu (.gemini/settings.json) bi idući potez pretvorilo u izvršavanje.
  test('svaka razina → default (bez ljuske i pisanja); rad/puno se NE prevode u auto_edit/yolo', () => {
    for (const r of ['citanje', 'rad', 'puno'] as const) expect(argumentiGeminija(r)).toEqual(['--approval-mode', 'default'])
  })
})

describe('nadjiGemini', () => {
  test('TM_GEMINI_BIN → PATH → ~/.local/bin → ~/.local/node/bin', () => {
    expect(nadjiGemini({ TM_GEMINI_BIN: '/x/gemini' })).toBe('/x/gemini')
    expect(nadjiGemini({ PATH: `/nema:${bin}` })).toBe(join(bin, 'gemini'))
    const home = join(mapa, 'h')
    mkdirSync(join(home, '.local', 'node', 'bin'), { recursive: true })
    writeFileSync(join(home, '.local', 'node', 'bin', 'gemini'), '')
    expect(nadjiGemini({ PATH: '/nema', HOME: home })).toBe(join(home, '.local', 'node', 'bin', 'gemini'))
  })
})

describe('izvrsiteljRazgovora — extra.izvrsitelj=gemini', () => {
  test('lažni gemini na PATH-u vraća odgovor; -m, --output-format json, -p, ključ i povjerenje u okolini', async () => {
    const radni = join(mapa, 'radni')
    mkdirSync(radni)
    const ex = izvrsiteljRazgovora({ bin: '/nema/claude' })
    const r = await ex.run({
      agentId: 'razgovor', model: 'gemini-3.8-flash', prompt: 'pitanje?', cwd: radni,
      extra: {
        izvrsitelj: 'gemini', args: ['--approval-mode', 'default'],
        env: { PATH: `${bin}:/usr/bin:/bin`, HOME: mapa, GEMINI_API_KEY: 'AIza-test' },
      },
    })
    expect(r.exitCode).toBe(0)
    expect(r.resultText).toBe('zdravo iz geminija')
    expect(r.usage?.inputTokens).toBe(12)
    expect(r.usage?.outputTokens).toBe(5)
    const a = argumenti()
    expect(a).toContain('--skip-trust')
    expect(a.slice(a.indexOf('--output-format'), a.indexOf('--output-format') + 2)).toEqual(['--output-format', 'json'])
    expect(a.slice(a.indexOf('-m'), a.indexOf('-m') + 2)).toEqual(['-m', 'gemini-3.8-flash'])
    expect(a.slice(a.indexOf('-p'), a.indexOf('-p') + 2)).toEqual(['-p', 'pitanje?'])
    expect(a).not.toContain('--setting-sources')
    expect(okolinaPoziva('KEY')).toBe('AIza-test')
    expect(okolinaPoziva('TRUST')).toBe('true')
  })

  test('radna mapa s .gemini/ (projektne postavke, MCP) → odbijeno, gemini se ne pokreće', async () => {
    const radni = join(mapa, 'radni')
    mkdirSync(join(radni, '.gemini'), { recursive: true })
    const r = await izvrsiteljRazgovora({ bin: '/nema/claude' }).run({
      agentId: 'razgovor', model: 'gemini-3.8-flash', prompt: 'x', cwd: radni,
      extra: { izvrsitelj: 'gemini', env: { PATH: `${bin}:/usr/bin:/bin`, HOME: mapa } },
    })
    expect(r.exitCode).not.toBe(0)
    expect(r.greska).toMatch(/\.gemini/)
    expect(existsSync(zapis)).toBe(false)
  })

  test('bez extra.izvrsitelj ostaje claude (nepostojeći bin → 127, gemini se ne zove)', async () => {
    const r = await izvrsiteljRazgovora({ bin: join(mapa, 'nema-claude') }).run({ agentId: 'razgovor', prompt: 'x' })
    expect(r.exitCode).toBe(127)
  })
})

// ─── Jezgra razgovora od kraja do kraja: poruka → lažni gemini → odgovor u kanalu ──

class Kanalcic implements Kanal {
  ime = 'signal' as const
  maxDuljinaPoruke = 4000
  maxDokumentBajta = 1024
  tekstovi: string[] = []
  async posaljiTekst(_c: string, tekst: string) { this.tekstovi.push(tekst); return true }
  async posaljiDokument() { return true }
}

const por = (): UlaznaPoruka => ({
  kanal: 'signal', chatId: 'c1', porukaId: '1', posiljateljId: '42', posiljateljIme: 'Ivan',
  posiljateljJeBot: false, tekst: 'koliko je sati?', ts: '2026-10-23T10:00:00Z', privatno: true, obracanjeBotu: false,
})

describe('razgovor s modelom geminicli — od poruke do odgovora', () => {
  test('odgovor stiže iz geminija (ne preko dežurnog), identitet je ispred prompta, bez claude zastavica i OAuth tokena', async () => {
    const postavke: RazgovorPostavke = { ...RAZGOVOR_ZADANO, dopusteniKorisnici: ['42'], ukljucen: true, burstMs: 0, radniDir: join(mapa, 'radni'), model: 'geminicli:gemini-3.8-flash', ovlasti: 'puno' }
    const kanal = new Kanalcic()
    let kvotaPitana = false
    const r = stvoriRazgovor({
      postavke: () => postavke,
      izvrsitelj: izvrsiteljRazgovora({ bin: join(mapa, 'nema-claude') }),
      jePauza: () => false,
      kvotaPuna: async () => { kvotaPitana = true; return true },
      korijen: join(mapa, 'razgovor'),
      tmHome: join(mapa, 'tm'),
      home: mapa,
      port: 17781,
      plocaUrl: 'http://127.0.0.1:17781',
      instalacija: 'proba',
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: mapa, CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-tajna' },
      ciljModela: spec => ciljRazgovora(spec, {}, ime => ime === 'GEMINI_API_KEY' ? 'AIza-test' : null),
      log: () => {},
    })
    r.primi(por(), kanal)
    await r.mirno()
    expect(kanal.tekstovi.at(-1)).toBe('zdravo iz geminija')
    // Vrata kvote pitaju samo Anthropic sesiju — gemini ih ne koči.
    expect(kvotaPitana).toBe(false)
    const a = argumenti()
    const prompt = a[a.indexOf('-p') + 1]!
    expect(prompt).toContain('koliko je sati?')
    expect(prompt).toContain('proba') // identitet (instalacija) ide ispred prompta
    // Postavka je `puno`, ali gemini potez ide na `citanje` — i model to zna iz identiteta.
    expect(prompt).toContain(OPIS_OVLASTI.citanje.slice(0, 40))
    expect(prompt).not.toContain(OPIS_OVLASTI.puno.slice(0, 40))
    expect(a).not.toContain('--allowedTools')
    expect(a).not.toContain('--resume')
    expect(a.slice(a.indexOf('--approval-mode'), a.indexOf('--approval-mode') + 2)).toEqual(['--approval-mode', 'default'])
    expect(okolinaPoziva('KEY')).toBe('AIza-test')
    expect(okolinaPoziva('CLAUDE')).toBe('')
  })
})
