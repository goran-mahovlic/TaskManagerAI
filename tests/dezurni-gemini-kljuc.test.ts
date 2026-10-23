/**
 * TASK-5730 — dežurni preko Google Gemini API-ja s ključem `GEMINI_API_KEY`.
 *
 * Kvar (macmini-pv, 23.10.2026.): Martina je na stranici Tajne upisala GEMINI_API_KEY. Model
 * davatelja `google` nosi `apiKey: "env:GEMINI_API_KEY|GOOGLE_API_KEY"`, ali:
 *   1. `davateljiDezurnog` je cijeli niz s `|` tražio kao JEDNO ime → google nikad „spreman";
 *   2. most `google` je ključ čitao samo pod imenom GOOGLE_API_KEY.
 * Bot zato nije imao kamo pasti kad primarni (`claude`, neprijavljen) padne → „kvar izvršitelja".
 * Uz to Google je ugasio gemini-2.5-flash za nove korisnike (404 ModelNotFound) — katalog
 * dežurnog i CLI-ja nudi gemini-3.8-flash.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { pitajModel } from '../src/Dezurni'
import { davateljiDezurnog, POZNATI_MODELI_DEZURNI } from '../src/DezurniConfig'

let mapa: string
beforeEach(() => { mapa = mkdtempSync(join(tmpdir(), 'tm-dez-gem-')) })
afterEach(() => rmSync(mapa, { recursive: true, force: true }))

function mc(): string {
  const p = join(mapa, 'model-config.json')
  writeFileSync(p, JSON.stringify({ providers: { google: { enabled: true, apiKey: 'env:GEMINI_API_KEY|GOOGLE_API_KEY' } } }))
  return p
}

describe('spremnost davatelja s više imena ključa (A|B)', () => {
  test('ključ upisan pod prvim imenom (GEMINI_API_KEY) → google spreman', () => {
    const cred = join(mapa, 'credentials.env')
    writeFileSync(cred, "GEMINI_API_KEY='AIza-test'\n")
    expect(davateljiDezurnog(mc(), cred, {}).google!.spreman).toBe(true)
  })

  test('ključ upisan pod drugim imenom (GOOGLE_API_KEY) → google spreman', () => {
    const cred = join(mapa, 'credentials.env')
    writeFileSync(cred, "GOOGLE_API_KEY='AIza-test'\n")
    expect(davateljiDezurnog(mc(), cred, {}).google!.spreman).toBe(true)
  })

  test('nijedno ime → nije spreman, razlog navodi oba imena', () => {
    const cred = join(mapa, 'credentials.env')
    writeFileSync(cred, "OSTALO='x'\n")
    const g = davateljiDezurnog(mc(), cred, {}).google!
    expect(g.spreman).toBe(false)
    expect(g.zasto).toContain('GEMINI_API_KEY|GOOGLE_API_KEY')
  })
})

describe('most google — ključ iz GEMINI_API_KEY', () => {
  function okruzje(tajne: Record<string, string>) {
    const dezPut = join(mapa, 'dezurni.json')
    writeFileSync(dezPut, JSON.stringify({ provider: 'google', model: 'gemini-3.8-flash' }))
    const pozivi: string[] = []
    const fetchImpl = (async (url: string) => {
      pozivi.push(String(url))
      return Response.json({ candidates: [{ content: { parts: [{ text: 'radi (gemini)' }] } }] })
    }) as any
    return { pozivi, o: { dezPut, mcPut: mc(), stanjePut: join(mapa, 's.json'), fetchImpl, citajTajnu: (i: string) => tajne[i] ?? null } }
  }

  test('samo GEMINI_API_KEY → zove generateContent i vraća odgovor', async () => {
    const { pozivi, o } = okruzje({ GEMINI_API_KEY: 'k-gem' })
    expect(await pitajModel('s', 'p', 50, o)).toBe('radi (gemini)')
    expect(pozivi[0]).toContain('/models/gemini-3.8-flash:generateContent')
    expect(pozivi[0]).toContain('key=k-gem')
  })

  test('samo GOOGLE_API_KEY i dalje radi (stari put)', async () => {
    const { pozivi, o } = okruzje({ GOOGLE_API_KEY: 'k-goo' })
    expect(await pitajModel('s', 'p', 50, o)).toBe('radi (gemini)')
    expect(pozivi[0]).toContain('key=k-goo')
  })

  test('bez ključa → ne zove ništa', async () => {
    const { pozivi, o } = okruzje({})
    expect(await pitajModel('s', 'p', 50, o)).toBeNull()
    expect(pozivi.length).toBe(0)
  })
})

describe('katalog modela Googlea', () => {
  test('nudi gemini-3.8-flash; ugašeni gemini-2.5-flash više nije prvi izbor', () => {
    expect(POZNATI_MODELI_DEZURNI.google).toContain('gemini-3.8-flash')
    expect(POZNATI_MODELI_DEZURNI.google![0]).toBe('gemini-3.8-flash')
  })
})
