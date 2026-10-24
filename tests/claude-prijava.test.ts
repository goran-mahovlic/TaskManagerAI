/**
 * TASK-5754 — Claude pretplata na macOS-u kroz ploču (Config → Prijava → Claude), bez Terminala.
 *
 * Na macOS-u `claude auth login` sprema prijavu u Keychain, koji usluga pod launchd ne vidi
 * (plan Mac v3 P12.2). Zato ploča na Macu vozi `claude setup-token` u PTY-u: korisnica otvori
 * poveznicu, zalijepi kod, a dugotrajni token koji CLI ispiše ide RAVNO u spremište kao
 * CLAUDE_CODE_OAUTH_TOKEN. Token se ne smije pojaviti u `buf`/`tail` (odgovor API-ja) ni u dnevniku.
 *
 * Testovi su bez mreže: lažni `claude` u privremenoj mapi glumi setup-token kroz pravi PTY.
 */
import { afterAll, describe, expect, spyOn, test } from 'bun:test'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CLAUDE_TOKEN_IME, CitacSetupTokena, izvuciClaudeToken, prijavaClaudea, skrijClaudeToken } from '../src/core/ClaudePrijava'
import { kljucPrisutanUDatoteci, postaviTajnu, procitajIzTeksta } from '../src/LoginCreds'
import { izvuciLoginUrl, maskirajLoginTail, LOGIN_POTVRDA } from '../src/LoginUnos'
import { ptyNaredba } from '../src/core/platforma'

// Izmišljen token istog oblika kao izlaz `claude setup-token`; slaže se u hodu da ga brane tajni ne hvataju.
const TOKEN = ['sk', 'ant', 'oat01', 'Ab9_' + 'x'.repeat(40) + '-Zq' + '7'.repeat(40) + 'endTAIL'].join('-')
const REP = TOKEN.slice(-24)
const ESC = '\x1b'

const MAPA = mkdtempSync(join(tmpdir(), 'claude-prijava-'))
afterAll(() => { rmSync(MAPA, { recursive: true, force: true }) })

describe('prijavaClaudea — naredba po OS-u', () => {
  test('macOS: setup-token u širokom PTY-u, token ide u spremište', () => {
    const p = prijavaClaudea({ os: 'darwin' })
    expect(p.cmd).toContain('claude setup-token')
    expect(p.cmd).toMatch(/stty cols \d{3}/)
    expect(p.tokenKey).toBe(CLAUDE_TOKEN_IME)
    expect(CLAUDE_TOKEN_IME).toBe('CLAUDE_CODE_OAUTH_TOKEN')
  })
  test('Linux ostaje `claude auth login --claudeai` (datoteka prijave u ~/.claude)', () => {
    const p = prijavaClaudea({ os: 'linux' })
    expect(p.cmd).toBe('claude auth login --claudeai')
    expect(p.tokenKey).toBeUndefined()
  })
})

describe('izvuciClaudeToken / skrijClaudeToken', () => {
  test('token iz Ink izlaza (ANSI oko njega, \\r\\n iza)', () => {
    const izlaz = `Your OAuth token (valid for 1 year):\r\n\r\n${ESC}[2G${TOKEN}${ESC}[39m\r\n\r\nStore this token securely.`
    expect(izvuciClaudeToken(izlaz)).toBe(TOKEN)
  })
  test('nedovršen token (bez znaka iza) se ne uzima — sljedeći komad ga može produžiti', () => {
    expect(izvuciClaudeToken('token:\r\n' + TOKEN.slice(0, 60))).toBeNull()
    expect(izvuciClaudeToken('token:\r\n' + TOKEN)).toBeNull()
  })
  test('skrivanje ne ostavlja nijedan dio tokena, ni djelomičnog', () => {
    expect(skrijClaudeToken(`a ${TOKEN}\r\n`)).not.toContain(REP)
    expect(skrijClaudeToken(`a ${TOKEN.slice(0, 50)}`)).not.toContain(TOKEN.slice(14, 50))
  })
})

describe('CitacSetupTokena', () => {
  test('token razlomljen preko komada: spremi se jednom, cijeli; buf nikad ne nosi dio tokena', () => {
    const spremljeno: string[] = []
    const c = new CitacSetupTokena(t => { spremljeno.push(t); return { ok: true } })
    const izlaz = `Paste code here if prompted >\r\n${ESC}[32m✓${ESC}[39m Long-lived authentication token created successfully!\r\n\r\nYour OAuth token (valid for 1 year):\r\n\r\n${TOKEN}\r\n\r\nStore this token securely.\r\n`
    const bufovi: string[] = []
    for (let i = 0; i < izlaz.length; i += 7) bufovi.push(c.dodaj(izlaz.slice(i, i + 7)))
    expect(spremljeno).toEqual([TOKEN])
    expect(c.spremljen).toBe(true)
    for (const b of bufovi) { expect(b).not.toContain(REP); expect(b).not.toContain(TOKEN.slice(14, 40)) }
    expect(bufovi.at(-1)).toContain('Store this token securely')
  })
  test('neuspio upis: greška bez vrijednosti, token i dalje skriven', () => {
    const c = new CitacSetupTokena(() => ({ ok: false, greska: 'vrijednost_preduga' }))
    const b = c.dodaj(`\r\n${TOKEN}\r\n`)
    expect(c.spremljen).toBe(false)
    expect(c.greska).toContain('vrijednost_preduga')
    expect(c.greska).not.toContain(REP)
    expect(b).not.toContain(REP)
  })
})

describe('E2E bez mreže: lažni `claude setup-token` kroz pravi PTY → spremište', () => {
  test('poveznica → zalijepljeni kod → token u spremištu; nema ga u odgovoru ni u dnevniku', async () => {
    const bin = join(MAPA, 'bin'); mkdirSync(bin, { recursive: true })
    // Glumi Ink: URL, upit za kod, pa token tek uz ispravan kod (kao prava razmjena koda za token).
    writeFileSync(join(bin, 'claude'), [
      '#!/bin/bash',
      '[ "$1" = setup-token ] || exit 2',
      `printf 'Browser didn'"'"'t open? Use the url below to sign in\\r\\n\\r\\nhttps://claude.com/cai/oauth/authorize?code=true&state=t1\\r\\n\\r\\nPaste code here if prompted > '`,
      'read -r kod',
      '[ "$kod" = "AbCd1234#EfGh5678" ] || { echo "OAuth error: bad code"; exit 1; }',
      `printf '\\r\\n\\033[32m✓\\033[39m Long-lived authentication token created successfully!\\r\\n\\r\\nYour OAuth token (valid for 1 year):\\r\\n\\r\\n%s\\r\\n\\r\\nStore this token securely.\\r\\n' "$TOKEN_LAZNI"`,
    ].join('\n'))
    chmodSync(join(bin, 'claude'), 0o755)
    const spremiste = join(MAPA, 'config', 'credentials.env')
    mkdirSync(join(MAPA, 'config'), { recursive: true })
    writeFileSync(spremiste, "GEMINI_API_KEY='ostaje'\n", { mode: 0o600 })

    const log = spyOn(console, 'log'), err = spyOn(console, 'error'), warn = spyOn(console, 'warn')
    const { cmd } = prijavaClaudea({ os: 'darwin' })
    const proc = Bun.spawn(ptyNaredba(cmd), {
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', cwd: MAPA,
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: MAPA, TERM: 'xterm-256color', TOKEN_LAZNI: TOKEN },
    })
    const c = new CitacSetupTokena(t => postaviTajnu(spremiste, CLAUDE_TOKEN_IME, t))
    let buf = '', url = '', poslan = false
    const reader = proc.stdout.getReader(); const dec = new TextDecoder()
    const rok = Date.now() + 15_000
    while (Date.now() < rok) {
      const { done, value } = await reader.read(); if (done) break
      buf = c.dodaj(dec.decode(value, { stream: true }))
      if (!url) url = izvuciLoginUrl(buf)
      if (url && !poslan && buf.includes('Paste code')) { proc.stdin.write('AbCd1234#EfGh5678' + LOGIN_POTVRDA); proc.stdin.flush?.(); poslan = true }
      if (c.spremljen) break
    }
    try { proc.kill() } catch {}
    const ispisano = [...log.mock.calls, ...err.mock.calls, ...warn.mock.calls].map(a => a.join(' ')).join('\n')
    log.mockRestore(); err.mockRestore(); warn.mockRestore()

    expect(url).toBe('https://claude.com/cai/oauth/authorize?code=true&state=t1')
    expect(c.spremljen).toBe(true)
    const tekst = readFileSync(spremiste, 'utf-8')
    expect(procitajIzTeksta(tekst, CLAUDE_TOKEN_IME)).toBe(TOKEN)
    expect(procitajIzTeksta(tekst, 'GEMINI_API_KEY')).toBe('ostaje')
    expect(kljucPrisutanUDatoteci(spremiste, CLAUDE_TOKEN_IME)).toBe(true)
    // Ono što ploča vraća pregledniku (handleLoginPoll: url + tail) i čuva u sesiji (buf).
    const odgovor = JSON.stringify({ id: 'claude', url, loggedIn: true, tail: maskirajLoginTail(buf), buf })
    expect(odgovor).not.toContain(REP)
    expect(odgovor).not.toContain(TOKEN.slice(14, 40))
    expect(ispisano).not.toContain(REP)
  }, 20_000)
})
