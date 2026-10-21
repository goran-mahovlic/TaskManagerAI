// TASK-5363: SEND_DOC iz rezultata zadatka (nalog iz Telegram grupe) šalje se u chat naloga
// istim kanalom kao razgovor — dopuštene mape, lista zabrane, razlog neuspjeha u chat.
import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { chatZadatka, posaljiDokumenteZadatka, type KanalDokumenata } from '../src/razgovor/SendDocZadatka'
import { procijeniIngest } from '../src/core/Ingest'
import { ZADANE_POSTAVKE } from '../src/core/IngestConfig'

let dir: string
let posla: { chatId: string; putanja: string; opis: string }[]
let tekstovi: { chatId: string; tekst: string }[]

function kanal(ishod: (p: string) => { ok: boolean; razlog?: string } = () => ({ ok: true })): KanalDokumenata {
  return {
    maxDokumentBajta: 1024,
    async posaljiDokumentIshod(chatId, putanja, opis) { posla.push({ chatId, putanja, opis }); return ishod(putanja) },
    async posaljiTekst(chatId, tekst) { tekstovi.push({ chatId, tekst }); return true },
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'senddoc-zad-'))
  mkdirSync(join(dir, 'tmp', 'TASK-1'), { recursive: true })
  mkdirSync(join(dir, 'tajno'), { recursive: true })
  writeFileSync(join(dir, 'tmp', 'TASK-1', 'proba.pdf'), '%PDF-1.4 proba')
  writeFileSync(join(dir, 'tmp', 'TASK-1', 'glas.mp3'), 'ID3')
  writeFileSync(join(dir, 'tajno', 'izvan.txt'), 'x')
  posla = []; tekstovi = []
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('chatZadatka', () => {
  test('chat iz oznake chat:<id>', () => {
    expect(chatZadatka({ tags: ['ulaz', 'chat:-1001234567890'] })).toBe('-1001234567890')
  })
  test('bez oznake ili s nebrojčanom → null', () => {
    expect(chatZadatka({ tags: ['ulaz'] })).toBeNull()
    expect(chatZadatka({ tags: ['chat:abc'] })).toBeNull()
    expect(chatZadatka({})).toBeNull()
  })
})

describe('posaljiDokumenteZadatka', () => {
  const zadatak = (rez: string) => ({ id: 'TASK-306', resultSummary: rez, tags: ['chat:-1001234567890'] })

  test('PDF i mp3 iz rezultata idu u chat naloga', async () => {
    const r = await posaljiDokumenteZadatka(zadatak(
      `Gotovo.\n[[SEND_DOC: ${dir}/tmp/TASK-1/proba.pdf | slova]]\n[[SEND_DOC: ${dir}/tmp/TASK-1/glas.mp3]]`),
      kanal(), { dopusteneMape: () => [join(dir, 'tmp')] })
    expect(r?.chatId).toBe('-1001234567890')
    expect(posla.map(p => [p.chatId, p.putanja.split('/').pop(), p.opis])).toEqual([
      ['-1001234567890', 'proba.pdf', 'slova'], ['-1001234567890', 'glas.mp3', ''],
    ])
    expect(r?.poslano).toEqual(['proba.pdf', 'glas.mp3'])
    expect(tekstovi).toEqual([])
  })

  test('datoteka izvan dopuštene mape se NE šalje, razlog ide u chat', async () => {
    const r = await posaljiDokumenteZadatka(zadatak(`[[SEND_DOC: ${dir}/tajno/izvan.txt]]`),
      kanal(), { dopusteneMape: () => [join(dir, 'tmp')] })
    expect(posla).toEqual([])
    expect(r?.neposlano[0]).toEqual({ ime: 'izvan.txt', razlog: 'izvan dopuštene mape' })
    expect(tekstovi[0]!.chatId).toBe('-1001234567890')
    expect(tekstovi[0]!.tekst).toContain('izvan.txt nije poslan: izvan dopuštene mape')
  })

  test('odbijanje kanala (Bot API) ide u chat s razlogom', async () => {
    const r = await posaljiDokumenteZadatka(zadatak(`[[SEND_DOC: ${dir}/tmp/TASK-1/proba.pdf]]`),
      kanal(() => ({ ok: false, razlog: 'HTTP 400: chat not found' })), { dopusteneMape: () => [join(dir, 'tmp')] })
    expect(r?.neposlano).toEqual([{ ime: 'proba.pdf', razlog: 'HTTP 400: chat not found' }])
    expect(tekstovi[0]!.tekst).toContain('chat not found')
  })

  test('ista datoteka dvaput u rezultatu šalje se jednom', async () => {
    await posaljiDokumenteZadatka(zadatak(
      `[[SEND_DOC: ${dir}/tmp/TASK-1/proba.pdf]] i opet [[SEND_DOC: ${dir}/tmp/TASK-1/proba.pdf]]`),
      kanal(), { dopusteneMape: () => [join(dir, 'tmp')] })
    expect(posla.length).toBe(1)
  })

  test('bez oznake SEND_DOC ili bez chata → ništa (null)', async () => {
    expect(await posaljiDokumenteZadatka(zadatak('samo tekst'), kanal(), { dopusteneMape: () => [dir] })).toBeNull()
    expect(await posaljiDokumenteZadatka({ id: 'TASK-1', resultSummary: `[[SEND_DOC: ${dir}/tmp/TASK-1/proba.pdf]]`, tags: [] },
      kanal(), { dopusteneMape: () => [dir] })).toBeNull()
    expect(posla).toEqual([])
  })
})

describe('ingest iz Telegrama nosi chat:<id>', () => {
  const PORUKA = 'Napravi PDF s probom slova i mp3 izvještaj, spremi u radnu mapu i pošalji u grupu.'
  const cfg = { ...ZADANE_POSTAVKE, enabled: true, perSource: { '*': 'on' as const }, projectBySource: {} } as any
  test('replyTo telegram chata postaje oznaka zadatka', () => {
    const o = procijeniIngest({ source: 'telegram', text: PORUKA, replyTo: '-1001234567890', externalId: '-1001234567890:1' }, cfg)
    expect(o.zadatak?.tags).toContain('chat:-1001234567890')
  })
  test('ne-telegram izvor ne dobiva chat oznaku', () => {
    // TASK-5371: e-pošta pod `*: on` je samo sjena — izričit ključ `email` otvara zadatak.
    const o = procijeniIngest({ source: 'email', text: PORUKA, replyTo: 'a@b.c', externalId: 'x' },
      { ...cfg, perSource: { ...cfg.perSource, email: 'on' } })
    expect(o.zadatak).toBeDefined()
    expect(o.zadatak!.tags.some(t => t.startsWith('chat:'))).toBe(false)
  })
})

describe('pravi Telegram kanal (lažni Bot API) → evidencija.jsonl', () => {
  test('poslani dokument iz rezultata ostavlja redak `poslano` u privitci/<chat>/evidencija.jsonl', async () => {
    const { telegramKanal } = await import('../src/TelegramPoller')
    const { readFileSync } = await import('fs')
    const stari = globalThis.fetch
    const pozivi: string[] = []
    globalThis.fetch = (async (url: any) => {
      pozivi.push(String(url).replace(/bot[^/]+/, 'bot***'))
      return new Response(JSON.stringify({ ok: true, result: { message_id: 4242 } }), { status: 200 })
    }) as any
    try {
      const priv = { ukljucen: true, mapa: join(dir, 'privitci'), maxMB: 20, vrste: ['document'] as any }
      const k = telegramKanal('123:TEST', () => priv, () => ({ id: 1, username: 'probni_bot' }))
      const r = await posaljiDokumenteZadatka(
        { id: 'TASK-306', resultSummary: `[[SEND_DOC: ${dir}/tmp/TASK-1/proba.pdf | proba slova]]`, tags: ['chat:-1001234567890'] },
        { ...k, posaljiDokumentIshod: k.posaljiDokumentIshod! }, { dopusteneMape: () => [join(dir, 'tmp')] })
      expect(r?.poslano).toEqual(['proba.pdf'])
      expect(pozivi).toEqual(['https://api.telegram.org/bot***/sendDocument'])
      const redak = JSON.parse(readFileSync(join(dir, 'privitci', '-1001234567890', 'evidencija.jsonl'), 'utf-8').trim())
      expect(redak).toMatchObject({ smjer: 'poslano', chatId: '-1001234567890', poruka: 4242, vrsta: 'document', tko: '@probni_bot' })
      expect(redak.izvor).toEndWith('/tmp/TASK-1/proba.pdf')
    } finally { globalThis.fetch = stari }
  })
})

describe('predložak ingesta uči agenta SEND_DOC oznaku', () => {
  test('nalog iz Telegrama: opis kaže kako poslati datoteku u chat', async () => {
    const { renderirajOpis } = await import('../src/core/IngestTemplate')
    const opis = renderirajOpis({ message: 'izradi pdf', weight: 20, source: 'telegram', replyTo: '-1001234567890', taskId: 'TASK-306' })
    expect(opis).toContain('[[SEND_DOC: /apsolutna/putanja | opis]]')
    expect(opis).toContain('-1001234567890')
  })
  test('nalog bez Telegrama: nema SEND_DOC upute', async () => {
    const { renderirajOpis } = await import('../src/core/IngestTemplate')
    expect(renderirajOpis({ message: 'izradi pdf', weight: 20, source: 'email', replyTo: 'a@b.c' })).not.toContain('SEND_DOC')
  })
})

describe('sigurnosne granice (pregled TASK-5363)', () => {
  test('chat koji ploča ne poznaje → ništa se ne šalje ni ne javlja', async () => {
    const r = await posaljiDokumenteZadatka(
      { id: 'TASK-306', resultSummary: `[[SEND_DOC: ${dir}/tmp/TASK-1/proba.pdf]]`, tags: ['chat:-999'] },
      kanal(), { dopusteneMape: () => [join(dir, 'tmp')], chatDopusten: c => c === '-1001234567890' })
    expect(r).toBeNull()
    expect(posla).toEqual([])
    expect(tekstovi).toEqual([])
  })
  test('dopuštene mape dobivaju i ID zadatka (radna mapa samo tog zadatka)', async () => {
    const vidio: string[] = []
    await posaljiDokumenteZadatka(
      { id: 'TASK-1', resultSummary: `[[SEND_DOC: ${dir}/tmp/TASK-1/proba.pdf]]`, tags: ['chat:-1001234567890'] },
      kanal(), { dopusteneMape: (c, id) => { vidio.push(`${c}|${id}`); return [join(dir, 'tmp', id)] } })
    expect(vidio).toEqual(['-1001234567890|TASK-1'])
    expect(posla.length).toBe(1)
  })
})
