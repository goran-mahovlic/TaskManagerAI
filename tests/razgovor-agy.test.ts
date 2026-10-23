/**
 * TASK-5738 — razgovor s modelom `antigravity:*` vozi `agy -p` (Google prijava), ne `claude`.
 * Okolina nosi SSH oznaku (datotečna pohrana tokena, src/core/Antigravity.ts), bez prijave u
 * Claude; potez je samo čitanje (`--mode plan`, bez preskakanja dozvola).
 *
 * Pravi proces, LAŽNI `agy`: skripta ljuske na PATH-u zapisuje argv i okolinu, a vraća tekst
 * kakav vraća `agy -p --output-format text`.
 *
 * Autorica: Jelena (Engineer), TASK-5738.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { ciljRazgovora } from '../src/core/models/PrebaciSve'
import { izvrsiteljRazgovora } from '../src/razgovor/Izvrsitelj'
import { stvoriRazgovor } from '../src/razgovor/Razgovor'
import { RAZGOVOR_ZADANO, type RazgovorPostavke } from '../src/razgovor/RazgovorPostavke'
import type { Kanal, UlaznaPoruka } from '../src/razgovor/Kanal'
import { OPIS_OVLASTI } from '../src/razgovor/Ovlasti'

let mapa: string
let bin: string
let zapis: string
beforeEach(() => {
  mapa = mkdtempSync(join(tmpdir(), 'tm-razg-agy-'))
  bin = join(mapa, 'bin')
  zapis = join(mapa, 'poziv.txt')
  mkdirSync(bin)
  writeFileSync(join(bin, 'agy'), `#!/bin/sh
for a in "$@"; do printf 'ARG:%s\\036' "$a"; done > '${zapis}'
printf 'SSH:%s\\036CLAUDE:%s\\036' "$SSH_CONNECTION" "$CLAUDE_CODE_OAUTH_TOKEN" >> '${zapis}'
printf 'zdravo iz agy-ja\\n'
`)
  chmodSync(join(bin, 'agy'), 0o755)
})
afterEach(() => { rmSync(mapa, { recursive: true, force: true }) })

const zapisi = () => readFileSync(zapis, 'utf-8').split('\x1e')
const argumenti = () => zapisi().filter(r => r.startsWith('ARG:')).map(r => r.slice(4))
const okolinaPoziva = (k: string) => (zapisi().find(r => r.startsWith(`${k}:`)) || '').slice(k.length + 1)

describe('ciljRazgovora — antigravity ide kroz agy', () => {
  test('antigravity:<model> → izvršitelj agy, bez ključa, nije Anthropic', () => {
    expect(ciljRazgovora('antigravity:zadano', {}, () => null)).toEqual({
      model: 'zadano', env: {}, anthropic: false, izvrsitelj: 'agy',
    })
  })
})

describe('izvrsiteljRazgovora — extra.izvrsitelj=agy', () => {
  test('lažni agy vraća tekst; -p, text izlaz, SSH oznaka u okolini, bez Claude prijave', async () => {
    const r = await izvrsiteljRazgovora({ bin: '/nema/claude' }).run({
      agentId: 'razgovor', model: 'gemini-3.8-flash', prompt: 'pitanje?', cwd: mapa,
      extra: { izvrsitelj: 'agy', args: ['--mode', 'plan'], env: { PATH: `${bin}:/usr/bin:/bin`, HOME: mapa, CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-x' } },
    })
    expect(r.exitCode).toBe(0)
    expect(r.resultText).toBe('zdravo iz agy-ja')
    const a = argumenti()
    expect(a.slice(a.indexOf('-p'), a.indexOf('-p') + 2)).toEqual(['-p', 'pitanje?'])
    expect(a.slice(a.indexOf('--output-format'), a.indexOf('--output-format') + 2)).toEqual(['--output-format', 'text'])
    expect(a.slice(a.indexOf('--model'), a.indexOf('--model') + 2)).toEqual(['--model', 'gemini-3.8-flash'])
    expect(a).not.toContain('--dangerously-skip-permissions')
    expect(okolinaPoziva('SSH')).toBeTruthy()
    expect(okolinaPoziva('CLAUDE')).toBe('')
  })
  test('zadani model → bez --model', async () => {
    await izvrsiteljRazgovora({ bin: '/nema/claude' }).run({
      agentId: 'razgovor', model: 'zadano', prompt: 'x', cwd: mapa,
      extra: { izvrsitelj: 'agy', env: { PATH: `${bin}:/usr/bin:/bin`, HOME: mapa } },
    })
    expect(argumenti()).not.toContain('--model')
  })
})

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

describe('razgovor s modelom antigravity — od poruke do odgovora', () => {
  test('odgovor iz agy-ja, identitet ispred prompta, potez samo čitanje (--mode plan), kvota Claudea se ne pita', async () => {
    const postavke: RazgovorPostavke = { ...RAZGOVOR_ZADANO, dopusteniKorisnici: ['42'], ukljucen: true, burstMs: 0, radniDir: join(mapa, 'radni'), model: 'antigravity:zadano', ovlasti: 'puno' }
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
      ciljModela: spec => ciljRazgovora(spec, {}, () => null),
      log: () => {},
    })
    r.primi(por(), kanal)
    await r.mirno()
    expect(kanal.tekstovi.at(-1)).toBe('zdravo iz agy-ja')
    expect(kvotaPitana).toBe(false)
    const a = argumenti()
    const prompt = a[a.indexOf('-p') + 1]!
    expect(prompt).toContain('koliko je sati?')
    expect(prompt).toContain('proba')
    expect(prompt).toContain(OPIS_OVLASTI.citanje.slice(0, 40))
    expect(a.slice(a.indexOf('--mode'), a.indexOf('--mode') + 2)).toEqual(['--mode', 'plan'])
    expect(a).not.toContain('--resume')
    expect(okolinaPoziva('CLAUDE')).toBe('')
  })
})
