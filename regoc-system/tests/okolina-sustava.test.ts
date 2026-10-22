/**
 * okolina-sustava.test.ts — TASK-5700 (plan Mac v3 K3a/P11): adrese strojeva i identitet
 * (git, Telegram, ploča, banka) više nisu tvrdo upisani u kod kompleta. Glavni stroj ih
 * čita iz postavki (`config/okolina.json`, memory-config, model-config) pa se ponašanje
 * ne mijenja; javni izvoz (`gradi_komplet.sh --javno`) ih ne nosi, a bez postavki vrijede
 * lokalne zadane vrijednosti.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { okolina, OKOLINA_ZADANO, ollamaUrl, chromaUrl } from '../lib/okolina-sustava'

let dir: string
const stari = { ...process.env }

beforeEach(() => {
  dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'okolina-'))
  delete process.env.OLLAMA_HOST
  delete process.env.CHROMA_HOST
  delete process.env.CHROMA_PORT
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  process.env = { ...stari }
})

describe('okolina() — config/okolina.json', () => {
  test('bez datoteke: lokalne zadane vrijednosti, bez ičijeg identiteta', () => {
    const o = okolina(join(dir, 'nema.json'))
    expect(o).toEqual(OKOLINA_ZADANO)
    expect(o.git.email).toBe('regoc@localhost')
    expect(o.plocaUrl).toBe('http://localhost:17781')
    expect(o.telegram.chatRegoc).toBe(0)
    expect(o.telegram.dopusteni).toEqual([])
    expect(o.telegram.grupe).toEqual([])
    expect(o.glavniHome).toBe('')
  })

  test('datoteka nadjačava polje po polje (ostalo ostaje zadano)', () => {
    const p = join(dir, 'okolina.json')
    writeFileSync(p, JSON.stringify({
      git: { name: 'Ana Primjer', email: 'ana@example.invalid' },
      ploca_url: 'http://ploca.example.invalid:17781',
      telegram: { chat_regoc: -42, dopusteni: [7, 8], grupe: [{ id: -42, ime: 'Grupa A', projekt: 'PRJ-1' }, { id: 'krivo' }] },
      memorija_banka: 'banka_x',
      glavni_home: '/home/korisnik',
    }))
    const o = okolina(p)
    expect(o.git).toEqual({ name: 'Ana Primjer', email: 'ana@example.invalid' })
    expect(o.plocaUrl).toBe('http://ploca.example.invalid:17781')
    expect(o.telegram).toEqual({ chatRegoc: -42, dopusteni: [7, 8], grupe: [{ id: -42, ime: 'Grupa A', projekt: 'PRJ-1' }] })
    expect(o.memorijaBanka).toBe('banka_x')
    expect(o.glavniHome).toBe('/home/korisnik')
  })

  test('neispravan JSON ili kriva vrsta polja → zadano (nikad ne baca)', () => {
    const p = join(dir, 'okolina.json')
    writeFileSync(p, '{ ovo nije json')
    expect(okolina(p)).toEqual(OKOLINA_ZADANO)
    writeFileSync(p, JSON.stringify({ telegram: { chat_regoc: 'abc', dopusteni: 'x' }, memorija_banka: 'NE SMIJE!' }))
    const o = okolina(p)
    expect(o.telegram).toEqual(OKOLINA_ZADANO.telegram)
    expect(o.memorijaBanka).toBe(OKOLINA_ZADANO.memorijaBanka)
  })
})

describe('ollamaUrl() / chromaUrl()', () => {
  const home = () => join(dir, 'home')
  const mc = (baseUrl: string) => {
    mkdirSync(join(home(), '.claude/regoc/models'), { recursive: true })
    writeFileSync(join(home(), '.claude/regoc/models/model-config.json'), JSON.stringify({ providers: { ollama: { baseUrl } } }))
  }

  test('OLLAMA_HOST ima prednost', () => {
    process.env.OLLAMA_HOST = 'http://ollama.example.invalid:11434/'
    mc('http://drugi.example.invalid:11434')
    expect(ollamaUrl({ home: home() })).toBe('http://ollama.example.invalid:11434')
  })

  test('zatim providers.ollama.baseUrl iz model-config.json', () => {
    mc('http://mc.example.invalid:11434')
    expect(ollamaUrl({ home: home() })).toBe('http://mc.example.invalid:11434')
  })

  test('bez env i model-configa → ollamaHost iz memory-configa (zadano lokalno)', () => {
    expect(ollamaUrl({ home: home(), memorija: { ollamaHost: 'http://127.0.0.1:11434', chromaHost: 'x', chromaPort: 1 } }))
      .toBe('http://127.0.0.1:11434')
  })

  test('chromaUrl iz memory-configa (host + vrata)', () => {
    expect(chromaUrl({ memorija: { ollamaHost: '', chromaHost: 'chroma.example.invalid', chromaPort: 18765 } }))
      .toBe('http://chroma.example.invalid:18765')
  })

  test('zadani memory-config (bez datoteke) daje samo lokalne adrese', () => {
    process.env.REGOC_MEMORY_CONFIG = join(dir, 'nema-memory.json')
    expect(chromaUrl({ reload: true })).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(ollamaUrl({ home: home(), reload: true })).toBe('http://127.0.0.1:11434')
  })
})
