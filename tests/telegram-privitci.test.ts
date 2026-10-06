/**
 * Privitci iz Telegrama (TASK-5282): slika, dokument, glas, zvuk i video spremaju se lokalno
 * kad je `telegram.privitci.ukljucen`, a putanja ide dalje u tekstu poruke (`[PRIVITAK: …]`).
 *
 * Sve bez mreže: `preuzmi` je UBRIZGAN kroz `Api`, mapa je privremena.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { ZADANO_STANJE, jedanProlaz, type Api, type StanjePollera, type Update } from '../src/TelegramPoller'
import {
  ZADANE_POSTAVKE, ZADANI_ULAZ, loadTelegramConfig, saveTelegramConfig, validateTelegramPatch,
  type TelegramPostavke,
} from '../src/TelegramConfig'
import {
  ZADANI_PRIVITCI, bezTajne, dopustenoPreuzeti, imePrivitka, mapaPrivitaka, odaberiPrivitak,
} from '../src/TelegramPrivitci'
import { RAZGOVOR_ZADANO, type RazgovorPostavke } from '../src/razgovor/RazgovorPostavke'

let mapa: string
beforeEach(() => { mapa = mkdtempSync(join(tmpdir(), 'tm-priv-')) })
afterEach(() => { rmSync(mapa, { recursive: true, force: true }) })

const GRUPA = -1001234567890

function cfg(priv: Partial<TelegramPostavke['privitci']> = {}, ulaz: Partial<TelegramPostavke['ulaz']> = {}): TelegramPostavke {
  return {
    ...ZADANE_POSTAVKE, ukljucen: true, botToken: '123:ABC',
    ulaz: { ...ZADANI_ULAZ, ukljucen: true, dopusteniChatovi: [String(GRUPA)], ...ulaz },
    privitci: { ...ZADANI_PRIVITCI, ukljucen: true, mapa, ...priv },
  }
}

function poruka(over: Partial<NonNullable<Update['message']>> = {}, id = 1): Update {
  return {
    update_id: id,
    message: {
      message_id: 100 + id,
      date: 1_791_300_000,
      chat: { id: GRUPA, title: 'Grupa', type: 'supergroup' },
      from: { id: 42, first_name: 'Ivan', username: 'ivan' },
      ...over,
    },
  }
}

const FOTO = [
  { file_id: 'mala', file_unique_id: 'u1', width: 90, height: 60, file_size: 1000 },
  { file_id: 'velika', file_unique_id: 'u3', width: 1280, height: 853, file_size: 90_000 },
  { file_id: 'srednja', file_unique_id: 'u2', width: 320, height: 213, file_size: 9000 },
]

class LazniApi implements Api {
  updates: Update[] = []
  ingesti: Record<string, unknown>[] = []
  preuzeto: { fileId: string; maxBajta: number }[] = []
  sadrzaj = new TextEncoder().encode('SLIKA')
  filePath = 'photos/file_7.jpg'
  greskaPreuzimanja: string | null = null
  async getUpdates() { return { ok: true, result: this.updates } }
  async ingest(tijelo: Record<string, unknown>) {
    this.ingesti.push(tijelo)
    return { status: 201, tijelo: { ok: true, taskId: 'TASK-1' } }
  }
  async odgovori() { return true }
  async preuzmi(fileId: string, maxBajta: number) {
    this.preuzeto.push({ fileId, maxBajta })
    if (this.greskaPreuzimanja) return { ok: false, greska: this.greskaPreuzimanja }
    return { ok: true, bajtovi: this.sadrzaj, filePath: this.filePath }
  }
}

const stanje = (): StanjePollera => ({ ...ZADANO_STANJE })

describe('postavka telegram.privitci', () => {
  test('zadano je ISKLJUČENO, 20 MB i svih pet vrsta', () => {
    expect(ZADANE_POSTAVKE.privitci.ukljucen).toBe(false)
    expect(ZADANE_POSTAVKE.privitci.maxMB).toBe(20)
    expect(ZADANE_POSTAVKE.privitci.vrste.sort()).toEqual(['audio', 'document', 'photo', 'video', 'voice'])
    expect(ZADANE_POSTAVKE.privitci.mapa).toBe('')
  })

  test('validator prima ispravnu zakrpu i odbija nepoznato polje, krivu vrstu, relativnu mapu i ..', () => {
    const ok = validateTelegramPatch({ privitci: { ukljucen: true, maxMB: 5, vrste: ['photo', 'voice'], mapa: '/srv/priv' } })
    expect(ok.ok).toBe(true)
    expect(ok.zakrpa.privitci).toEqual({ ukljucen: true, maxMB: 5, vrste: ['photo', 'voice'], mapa: '/srv/priv' })

    expect(validateTelegramPatch({ privitci: { ukljucenn: true } }).greske.join()).toContain('privitci.ukljucenn')
    expect(validateTelegramPatch({ privitci: { vrste: ['sticker'] } }).ok).toBe(false)
    expect(validateTelegramPatch({ privitci: { maxMB: 0 } }).ok).toBe(false)
    expect(validateTelegramPatch({ privitci: { maxMB: 21 } }).ok).toBe(false)
    expect(validateTelegramPatch({ privitci: { mapa: 'relativna/mapa' } }).ok).toBe(false)
    expect(validateTelegramPatch({ privitci: { mapa: '/srv/../etc' } }).ok).toBe(false)
    // Prazna mapa = zadano ($TM_HOME/privitci)
    expect(validateTelegramPatch({ privitci: { mapa: '' } }).ok).toBe(true)
  })

  test('spremanje i čitanje spaja privitke po dubini (jedno polje ne briše ostala)', () => {
    const p = join(mapa, 'telegram.json')
    saveTelegramConfig({ privitci: { ukljucen: true } } as any, p)
    const c = loadTelegramConfig(p)
    expect(c.privitci.ukljucen).toBe(true)
    expect(c.privitci.maxMB).toBe(20)
    expect(c.privitci.vrste.length).toBe(5)
  })

  test('mapa: zadano $TM_HOME/privitci/<chatId>, inače <mapa>/<chatId>', () => {
    expect(mapaPrivitaka({ ...ZADANI_PRIVITCI }, '-100', '/tm')).toBe('/tm/privitci/-100')
    expect(mapaPrivitaka({ ...ZADANI_PRIVITCI, mapa: '/srv/p' }, '-100', '/tm')).toBe('/srv/p/-100')
  })
})

describe('odabir privitka', () => {
  test('fotografija: NAJVEĆA rezolucija, ne zadnja u nizu', () => {
    const p = odaberiPrivitak(poruka({ photo: FOTO }).message!, ZADANI_PRIVITCI.vrste)
    expect(p?.vrsta).toBe('photo')
    expect(p?.fileId).toBe('velika')
  })
  test('dokument nosi izvorno ime, glas nema ime', () => {
    const d = odaberiPrivitak(poruka({ document: { file_id: 'd1', file_name: 'racun.pdf', file_size: 10 } }).message!, ZADANI_PRIVITCI.vrste)
    expect(d).toMatchObject({ vrsta: 'document', fileId: 'd1', ime: 'racun.pdf', velicina: 10 })
    const v = odaberiPrivitak(poruka({ voice: { file_id: 'v1', duration: 3 } }).message!, ZADANI_PRIVITCI.vrste)
    expect(v).toMatchObject({ vrsta: 'voice', fileId: 'v1' })
  })
  test('vrsta koja nije na popisu se ne bira', () => {
    expect(odaberiPrivitak(poruka({ voice: { file_id: 'v1' } }).message!, ['photo'])).toBeNull()
  })
})

describe('sanitizacija imena', () => {
  test('nema ../, kose crte ni skrivene datoteke; oblik <datum>_<message_id>_<ime>', () => {
    const i = imePrivitka('../../etc/passwd', 101, 1_791_300_000)
    expect(i).toBe('2026-10-06_101_passwd')
    expect(imePrivitka('..', 5, 1_791_300_000)).toBe('2026-10-06_5_privitak')
    expect(imePrivitka('.bashrc', 5, 1_791_300_000)).toBe('2026-10-06_5_bashrc')
    expect(imePrivitka('a b;$(rm -rf).sh', 5, 1_791_300_000)).toBe('2026-10-06_5_a_b___rm_-rf_.sh')
    expect(imePrivitka('šifra čćž.pdf', 5, 1_791_300_000)).toBe('2026-10-06_5_šifra_čćž.pdf')
    expect(imePrivitka('x'.repeat(300) + '.pdf', 5, 1_791_300_000).length).toBeLessThanOrEqual(140)
  })
})

describe('tko smije', () => {
  const rp = (dop: string[]): RazgovorPostavke => ({ ...RAZGOVOR_ZADANO, dopusteniKorisnici: dop, preskociAkoSadrzi: [] } as RazgovorPostavke)
  const m = poruka().message!
  test('korisnik s popisa ulaza ili razgovora (id ili ime) smije', () => {
    expect(dopustenoPreuzeti(m, { ...ZADANI_ULAZ, dopusteniKorisnici: ['42'] }, null)).toBe(true)
    expect(dopustenoPreuzeti(m, { ...ZADANI_ULAZ, dopusteniKorisnici: ['nitko'] }, rp(['@Ivan']))).toBe(true)
    expect(dopustenoPreuzeti(m, { ...ZADANI_ULAZ, dopusteniKorisnici: ['7'] }, rp(['8']))).toBe(false)
  })
  test('bez popisa korisnika odlučuje izričit popis chatova; bez ikakvog popisa — NE', () => {
    expect(dopustenoPreuzeti(m, { ...ZADANI_ULAZ, dopusteniChatovi: [String(GRUPA)] }, rp([]))).toBe(true)
    expect(dopustenoPreuzeti(m, { ...ZADANI_ULAZ }, rp([]))).toBe(false)
  })
})

describe('bezTajne', () => {
  test('token i oblik bot<id>:<tajna> ne izlaze u tekst greške', () => {
    const s = bezTajne('fetch https://api.telegram.org/file/bot123:ABC-def_9/photos/x.jpg pao', '123:ABC-def_9')
    expect(s).not.toContain('ABC-def_9')
    expect(bezTajne('url bot999:XYZabc pao', '')).not.toContain('XYZabc')
  })
})

describe('jedanProlaz s privitcima', () => {
  test('poruka SAMO sa slikom: NIJE preskočena, slika spremljena, putanja ide u ingest', async () => {
    const api = new LazniApi()
    api.updates = [poruka({ photo: FOTO })]
    const st = stanje()
    const i = await jedanProlaz(cfg(), st, api)
    expect(i.preskoceno).toBe(0)
    expect(api.preuzeto).toEqual([{ fileId: 'velika', maxBajta: 20 * 1024 * 1024 }])
    const cilj = join(mapa, String(GRUPA), '2026-10-06_101_file_7.jpg')
    expect(existsSync(cilj)).toBe(true)
    expect(readFileSync(cilj, 'utf-8')).toBe('SLIKA')
    expect((statSync(cilj).mode & 0o111)).toBe(0) // bez izvršavanja
    expect(api.ingesti[0]!.text).toBe(`[PRIVITAK: ${cilj}]`)
  })

  test('opis + dokument: tekst ostaje, putanja se dopisuje; izvorno ime dokumenta', async () => {
    const api = new LazniApi()
    api.updates = [poruka({ caption: 'pogledaj račun', document: { file_id: 'd1', file_name: 'racun.pdf', file_size: 5 } })]
    await jedanProlaz(cfg(), stanje(), api)
    const cilj = join(mapa, String(GRUPA), '2026-10-06_101_racun.pdf')
    expect(api.ingesti[0]!.text).toBe(`pogledaj račun\n[PRIVITAK: ${cilj}]`)
  })

  test('isključeno: poruka samo sa slikom preskoči se kao prije i ništa se ne preuzima', async () => {
    const api = new LazniApi()
    api.updates = [poruka({ photo: FOTO })]
    const i = await jedanProlaz(cfg({ ukljucen: false }), stanje(), api)
    expect(i.preskoceno).toBe(1)
    expect(api.preuzeto.length).toBe(0)
    expect(readdirSync(mapa).length).toBe(0)
  })

  test('nedopušten chat: ništa se ne preuzima', async () => {
    const api = new LazniApi()
    api.updates = [poruka({ photo: FOTO, chat: { id: -5, type: 'group' } })]
    await jedanProlaz(cfg(), stanje(), api)
    expect(api.preuzeto.length).toBe(0)
    expect(api.ingesti.length).toBe(0)
  })

  test('nedopušten korisnik: ne preuzima se; tekst bez privitka ide dalje bez putanje', async () => {
    const api = new LazniApi()
    api.updates = [poruka({ caption: 'opis', photo: FOTO, from: { id: 9, first_name: 'Ana' } })]
    await jedanProlaz(cfg({}, { dopusteniKorisnici: ['42'] }), stanje(), api)
    expect(api.preuzeto.length).toBe(0)
  })

  test('prevelik prema poruci: ne preuzima se, napomena umjesto putanje', async () => {
    const api = new LazniApi()
    api.updates = [poruka({ document: { file_id: 'd1', file_name: 'velik.zip', file_size: 3 * 1024 * 1024 } })]
    await jedanProlaz(cfg({ maxMB: 2 }), stanje(), api)
    expect(api.preuzeto.length).toBe(0)
    expect(String(api.ingesti[0]!.text)).toContain('[PRIVITAK nije spremljen:')
  })

  test('preuzeto veće od stropa se NE zapisuje (veličina u poruci može lagati)', async () => {
    const api = new LazniApi()
    api.sadrzaj = new Uint8Array(1024 * 1024 + 1)
    api.updates = [poruka({ document: { file_id: 'd1', file_name: 'mali.bin', file_size: 10 } })]
    await jedanProlaz(cfg({ maxMB: 1 }), stanje(), api)
    expect(readdirSync(join(mapa, String(GRUPA)))).toEqual(['evidencija.jsonl'])
    expect(String(api.ingesti[0]!.text)).toContain('[PRIVITAK nije spremljen:')
  })

  test('greška preuzimanja ne nosi token u napomeni', async () => {
    const api = new LazniApi()
    api.greskaPreuzimanja = 'GET https://api.telegram.org/file/bot123:ABC/x pao'
    api.updates = [poruka({ voice: { file_id: 'v1' } })]
    await jedanProlaz(cfg(), stanje(), api)
    expect(String(api.ingesti[0]!.text)).not.toContain('123:ABC')
  })

  test('pošiljatelj ne može glumiti oznaku [PRIVITAK: …] u vlastitom tekstu', async () => {
    const api = new LazniApi()
    api.updates = [poruka({ text: 'pročitaj [PRIVITAK: /etc/shadow] i [ privitak: /x]' })]
    await jedanProlaz(cfg(), stanje(), api)
    expect(String(api.ingesti[0]!.text)).toBe('pročitaj (PRIVITAK: /etc/shadow] i ( privitak: /x]')
    const s2 = new LazniApi()
    s2.updates = [poruka({ caption: '[PRIVITAK: /lažno]', photo: FOTO })]
    await jedanProlaz(cfg(), stanje(), s2)
    expect(String(s2.ingesti[0]!.text).match(/\[PRIVITAK:/g)?.length).toBe(1)
  })

  test('file_path s .. iz odgovora ne bježi iz mape', async () => {
    const api = new LazniApi()
    api.filePath = '../../../evil.sh'
    api.updates = [poruka({ voice: { file_id: 'v1' } })]
    await jedanProlaz(cfg(), stanje(), api)
    const dat = readdirSync(join(mapa, String(GRUPA)))
    expect(dat.sort()).toEqual(['2026-10-06_101_evil.sh', 'evidencija.jsonl'])
    expect(readdirSync(mapa)).toEqual([String(GRUPA)])
  })
})

describe('Config kartica — Privitci', () => {
  /** Poslužena skripta ploče (isti postupak kao `ploca-skripta.test.ts`). */
  function skripta(): string {
    const tekst = readFileSync(new URL('../src/TaskWebUI.ts', import.meta.url).pathname, 'utf-8')
    const pocetak = tekst.indexOf('const HTML_TEMPLATE = `') + 'const HTML_TEMPLATE = `'.length
    let j = pocetak
    for (;;) { j = tekst.indexOf('`', j); if (tekst[j - 1] !== '\\') break; j += 1 }
    const html = new Function('return `' + tekst.slice(pocetak, j) + '`')() as string
    return html.slice(html.indexOf('<script>') + 8, html.indexOf('</script>'))
  }
  function izvuci(kod: string, ime: string): string {
    const i = kod.indexOf(`function ${ime}(`)
    expect(i).toBeGreaterThan(-1)
    let dubina = 0, k = kod.indexOf('{', i)
    for (let x = k; x < kod.length; x++) {
      if (kod[x] === '{') dubina++
      else if (kod[x] === '}' && --dubina === 0) return kod.slice(i, x + 1)
    }
    throw new Error('nezatvorena funkcija')
  }

  test('renderira stanje iz /api/telegram/config i šalje zakrpu privitci.*', () => {
    const kod = skripta()
    const fn = new Function(
      "var _T = function (k, d) { return d; };" +
      "var _esc = function (s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;'); };" +
      "var _stil = function () { return ''; };" +
      "var _red = function (a, b, c) { return '<tr><td>' + a + '</td><td>' + b + '</td><td>' + c + '</td></tr>'; };" +
      "var _TEL_VRSTE = ['photo', 'document', 'voice', 'audio', 'video'];" +
      izvuci(kod, 'renderTelegramPrivitci') + '; return renderTelegramPrivitci;')()
    const h: string = fn({ postavke: { privitci: { ukljucen: true, mapa: '/srv/p', maxMB: 7, vrste: ['photo', 'voice'] } } })
    expect(h).toContain('spremiTelegram({privitci:{ukljucen:this.checked}}')
    expect(h).toContain('value="/srv/p"')
    expect(h).toContain('value="7"')
    expect(h).toMatch(/value="photo" checked/)
    expect(h).toMatch(/value="voice" checked/)
    expect(h).not.toMatch(/value="document" checked/)
    expect(h).not.toContain('<datum>') // opis je zaštićen, ne postaje HTML oznaka
    // Bez grane u odgovoru (stara instalacija) — ne puca, prikaže zadano
    expect(() => fn({ postavke: {} })).not.toThrow()
    expect(kod).toContain('function spremiTelegramVrste(')
  })
})

describe('evidencija i poslani dokumenti (uputa #187)', () => {
  const evid = (chat = String(GRUPA)) =>
    readFileSync(join(mapa, chat, 'evidencija.jsonl'), 'utf-8').trim().split('\n').map(r => JSON.parse(r))

  test('primljeni privitak upisuje se u evidenciju: smjer, tko, kad, putanja', async () => {
    const api = new LazniApi()
    api.updates = [poruka({ photo: FOTO })]
    await jedanProlaz(cfg(), stanje(), api)
    const [z] = evid()
    expect(z).toMatchObject({
      smjer: 'primljeno', vrsta: 'photo', chatId: String(GRUPA), poruka: 101,
      tkoId: '42', tko: 'Ivan (@ivan)', putanja: join(mapa, String(GRUPA), '2026-10-06_101_file_7.jpg'),
    })
    expect(Number.isNaN(Date.parse(z.kad))).toBe(false)
  })

  test('nespremljen privitak se također evidentira, s razlogom', async () => {
    const api = new LazniApi()
    api.updates = [poruka({ document: { file_id: 'd1', file_name: 'v.zip', file_size: 3 * 1024 * 1024 } })]
    await jedanProlaz(cfg({ maxMB: 2 }), stanje(), api)
    const [z] = evid()
    expect(z.smjer).toBe('primljeno')
    expect(z.putanja).toBeUndefined()
    expect(z.greska).toContain('2 MB')
  })

  test('dokument koji bot pošalje (SEND_DOC) kopira se u mapu chata i evidentira kao poslano', async () => {
    const { telegramKanal } = await import('../src/TelegramPoller')
    const izvor = join(mapa, 'izvjestaj.pdf')
    require('fs').writeFileSync(izvor, 'PDF')
    const stari = globalThis.fetch
    const pozivi: string[] = []
    globalThis.fetch = (async (url: any) => {
      pozivi.push(String(url))
      return new Response(JSON.stringify({ ok: true, result: { message_id: 555 } }), { status: 200 })
    }) as any
    try {
      const k = telegramKanal('123:ABC', () => cfg().privitci, () => ({ id: 7, username: 'moj_bot' }))
      expect(await k.posaljiDokument(String(GRUPA), izvor, 'evo')).toBe(true)
    } finally { globalThis.fetch = stari }
    const z = evid().find(x => x.smjer === 'poslano')
    expect(z).toMatchObject({ smjer: 'poslano', vrsta: 'document', chatId: String(GRUPA), poruka: 555, tkoId: '7', tko: '@moj_bot', izvor })
    expect(readFileSync(z.putanja, 'utf-8')).toBe('PDF')
    expect(z.putanja.startsWith(join(mapa, String(GRUPA)) + '/')).toBe(true)
    expect(z.putanja.endsWith('_555_izvjestaj.pdf')).toBe(true)
    expect(statSync(z.putanja).mode & 0o111).toBe(0)
  })

  test('isključeni privitci: poslani dokument se NE kopira', async () => {
    const { telegramKanal } = await import('../src/TelegramPoller')
    const izvor = join(mapa, 'a.pdf')
    require('fs').writeFileSync(izvor, 'PDF')
    const stari = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }))) as any
    try {
      await telegramKanal('123:ABC', () => ({ ...cfg().privitci, ukljucen: false })).posaljiDokument(String(GRUPA), izvor, '')
    } finally { globalThis.fetch = stari }
    expect(existsSync(join(mapa, String(GRUPA)))).toBe(false)
  })
})
