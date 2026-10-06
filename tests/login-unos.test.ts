// TASK-5269 — prijava za Claude na ploči (Config → Login): čišćenje zalijepljenog koda,
// izvlačenje URL-a iz OSC-8 hiperveze i maskiranje izlaza CLI-ja prije slanja u preglednik.
import { describe, expect, test } from 'bun:test'
import { ocistiLoginKod, izvuciLoginUrl, ocistiTerminal, maskirajLoginTail, loginOauthGreska, LOGIN_POTVRDA } from '../src/LoginUnos'

const ESC = '\x1b', BEL = '\x07'
// Izmišljen kod istog oblika kao Claude OAuth kod (<znakovi>#<znakovi>), nije stvaran.
const KOD = 'AbCdEfGh0123456789_-xyzAbCdEfGh0123456789#Zz9-Yy8_Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0'
const URL_OAUTH = 'https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=s1'

describe('ocistiLoginKod', () => {
  test('kod + razmak + ANSI + URL → samo kod', () => {
    const zalijepljeno = `${KOD} ${ESC}[38;5;246m${ESC}]8;;${URL_OAUTH}${BEL}${URL_OAUTH}${ESC}]8;;${BEL}${ESC}[39m\n`
    expect(ocistiLoginKod(zalijepljeno)).toBe(KOD)
  })
  test('ANSI ispred koda i oko njega', () => {
    expect(ocistiLoginKod(`${ESC}[1m${KOD}${ESC}[22m`)).toBe(KOD)
  })
  test('kod s # ima prednost i kad nije prva riječ', () => {
    expect(ocistiLoginKod(`kod: ${KOD} [38`)).toBe(KOD)
  })
  test('bez # → prva riječ (npr. Gemini 4/0A… kod)', () => {
    expect(ocistiLoginKod('  4/0AbCdEf_gh-12  višak')).toBe('4/0AbCdEf_gh-12')
  })
  test('prazno, samo ANSI ili samo URL → null', () => {
    expect(ocistiLoginKod('')).toBeNull()
    expect(ocistiLoginKod('   \n')).toBeNull()
    expect(ocistiLoginKod(`${ESC}[31m${ESC}[0m`)).toBeNull()
    expect(ocistiLoginKod(URL_OAUTH)).toBeNull()
    expect(ocistiLoginKod(undefined as unknown as string)).toBeNull()
  })
  test('rezultat nikad ne sadrži kontrolne znakove ni \\r/\\n', () => {
    const r = ocistiLoginKod(`\r${KOD}\r\n`)!
    expect(r).toBe(KOD)
    expect(/[\x00-\x1f\x7f]/.test(r)).toBe(false)
  })
  test('potvrda unosa za Ink/PTY je \\r, ne \\n', () => {
    expect(LOGIN_POTVRDA).toBe('\r')
  })
})

describe('izvuciLoginUrl', () => {
  test('OSC-8 hiperveza (stvarni izlaz claude auth login) → čist URL bez BEL-a i duplikata', () => {
    const buf = `Opening browser to sign in…\r\nIf the browser didn't open, visit: ${ESC}]8;;${URL_OAUTH}${BEL}${URL_OAUTH}${ESC}]8;;${BEL}\r\nPaste code here if prompted >`
    expect(izvuciLoginUrl(buf)).toBe(URL_OAUTH)
  })
  test('obični URL', () => {
    expect(izvuciLoginUrl(`visit ${URL_OAUTH}\n`)).toBe(URL_OAUTH)
  })
  test('nema URL-a → prazno', () => {
    expect(izvuciLoginUrl('Opening browser')).toBe('')
  })
})

describe('maskirajLoginTail', () => {
  test('sk-ant-… token se ne vraća pregledniku', () => {
    const tok = 'sk-ant-oat01-' + 'Q'.repeat(40) + '_w-AA'
    const r = maskirajLoginTail(`Your token:\r\n${tok}\r\nStore it safely`)
    expect(r).not.toContain(tok)
    expect(r).not.toContain('Q'.repeat(20))
    expect(r).toContain('sk-ant-')
    expect(r).toContain('[skriveno]')
  })
  test('dugi base64 niz i OAuth kod se maskiraju', () => {
    const b64 = 'eyJhbGciOiJIUzI1NiJ9' + 'aB3+/x'.repeat(8) + '=='
    const r = maskirajLoginTail(`a ${b64} b ${KOD} c`)
    expect(r).not.toContain(b64)
    expect(r).not.toContain(KOD)
    expect(r).toContain('a [skriveno] b [skriveno] c')
  })
  test('ANSI i OSC-8 sekvence očišćene, \\r uklonjen, URL ostaje čitljiv', () => {
    const r = maskirajLoginTail(`${ESC}[2K${ESC}[1Gvisit: ${ESC}]8;;https://x.y/a${BEL}https://x.y/a${ESC}]8;;${BEL}\r\nOK`)
    expect(/[\x00-\x08\x0b-\x1f\x7f]/.test(r)).toBe(false)
    expect(r).toBe('visit: https://x.y/a\nOK')
  })
  test('rep je ograničen na zadnjih N znakova nakon čišćenja', () => {
    expect(maskirajLoginTail('ab '.repeat(2000), 400).length).toBe(400)
  })
  test('obične riječi i kratki brojevi ostaju', () => {
    expect(maskirajLoginTail('Paste code here if prompted > ****')).toBe('Paste code here if prompted > ****')
  })
})

describe('loginOauthGreska', () => {
  test('OAuth error → jasna poruka', () => {
    expect(loginOauthGreska(`${ESC}[31mOAuth error: Request failed with status code 400${ESC}[39m`)).toMatch(/kod/i)
  })
  test('bez greške → null', () => {
    expect(loginOauthGreska('Paste code here if prompted >')).toBeNull()
  })
})
