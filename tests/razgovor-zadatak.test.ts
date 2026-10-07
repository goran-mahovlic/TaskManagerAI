/**
 * TASK-5337 — trag razgovora na ploči čvora i SEND_DOC iz mape privitaka chata.
 *
 * node-A 07.10.2026.: Šaban je napravio xlsx u `privitci/<chat>`, oznaku SEND_DOC je jezgra
 * prepoznala, ali ju je odbila („izvan dopuštene mape") jer je dopuštena bila samo radna mapa.
 * Razgovor bot↔bot (Šaban ↔ @klaudioAI_bot) nije ostavio nikakav trag na ploči, pa vlasnik nije
 * vidio je li poruka primljena ni radi li se išta.
 *
 * Autorica: Jelena (Engineer), TASK-5337.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { RAZGOVOR_ZADANO, type RazgovorPostavke } from '../src/razgovor/RazgovorPostavke'
import type { Kanal, UlaznaPoruka } from '../src/razgovor/Kanal'
import { stvoriRazgovor, type RazgovorOvisnosti } from '../src/razgovor/Razgovor'
import { stvoriZadatkeRazgovora, type PlocaRazgovora } from '../src/razgovor/ZadatakRazgovora'
import { sastaviIdentitet } from '../src/razgovor/Identitet'
import { zapisiKonzolu, citajKonzolu } from '../src/razgovor/Zapis'
import type { ExecRequest, ExecResult } from '../src/core/orchestrator/Ports'

const mape: string[] = []
let mapa: string
beforeEach(() => { mapa = mkdtempSync(join(tmpdir(), 'tm-razg-zad-')); mape.push(mapa) })
afterAll(() => { for (const m of mape) rmSync(m, { recursive: true, force: true }) })

const cekaj = (ms: number) => new Promise(r => setTimeout(r, ms))

class LaznaPloca implements PlocaRazgovora {
  zadaci = new Map<string, { naslov: string; opis: string; oznake: string[]; autor: string; status: string; biljeske: string[]; rezultat?: string }>()
  n = 0
  stvori(o: { naslov: string; opis: string; oznake: string[]; autor: string }) {
    const id = `TASK-${++this.n}`
    this.zadaci.set(id, { ...o, status: 'pending', biljeske: [] })
    return id
  }
  status(id: string) { return this.zadaci.get(id)?.status ?? null }
  postaviStatus(id: string, status: 'in_progress' | 'completed', rezultat?: string) {
    const z = this.zadaci.get(id)
    if (!z) return false
    // isti prijelazi kao TaskManagerSQL: pending → in_progress → completed
    if (status === 'completed' && z.status !== 'in_progress') return false
    if (status === 'in_progress' && !['pending', 'blocked'].includes(z.status)) return z.status === 'in_progress'
    z.status = status
    if (rezultat) z.rezultat = rezultat
    return true
  }
  biljeska(id: string, _autor: string, tekst: string) { this.zadaci.get(id)?.biljeske.push(tekst) }
}

class Kanalic implements Kanal {
  ime = 'telegram' as const
  maxDuljinaPoruke = 4096
  maxDokumentBajta = 1024 * 1024
  tekstovi: string[] = []
  dokumenti: string[] = []
  ishodDokumenta: { ok: boolean; razlog?: string } = { ok: true }
  async posaljiTekst(_c: string, t: string) { this.tekstovi.push(t); return true }
  async posaljiDokument(_c: string, putanja: string) { this.dokumenti.push(putanja); return this.ishodDokumenta.ok }
  async posaljiDokumentIshod(_c: string, putanja: string) { this.dokumenti.push(putanja); return this.ishodDokumenta }
}

class Izvrsitelj {
  ime = 'lazni'
  zahtjevi: ExecRequest[] = []
  odgovori: Array<Partial<ExecResult>> = []
  trajanjeMs = 0
  async run(req: ExecRequest): Promise<ExecResult> {
    this.zahtjevi.push(req)
    if (this.trajanjeMs) await cekaj(this.trajanjeMs)
    return { exitCode: 0, resultText: 'odgovor', sessionId: 'S1', numTurns: 1, ...(this.odgovori.shift() || {}) }
  }
}

function okolina(o: Partial<RazgovorPostavke> = {}, dodatno: Partial<RazgovorOvisnosti> = {}, prijenos: string = 'bez-spomena') {
  const postavke: RazgovorPostavke = { ...RAZGOVOR_ZADANO, ime: 'Šaban', dopusteniKorisnici: ['42'], ukljucen: true, burstMs: 0, radniDir: join(mapa, 'radni'), ...o }
  const izv = new Izvrsitelj()
  const kanal = new Kanalic()
  const ploca = new LaznaPloca()
  const zadaci = stvoriZadatkeRazgovora({ ploca, korijen: join(mapa, 'razgovor'), autor: () => 'Šaban', pragMs: 40 })
  const r = stvoriRazgovor({
    postavke: () => postavke,
    izvrsitelj: izv,
    jePauza: () => false,
    kvotaPuna: async () => false,
    korijen: join(mapa, 'razgovor'),
    tmHome: join(mapa, 'tm'),
    home: join(mapa, 'home'),
    port: 17781,
    plocaUrl: 'http://127.0.0.1:17781',
    instalacija: 'node-A',
    env: { PATH: '/bin' },
    log: () => {},
    zadaci,
    botKanal: () => ({ jeZaustavljen: () => false, ovlasti: () => 'citanje', prenesi: async (u: any) => (prijenos === 'poslano' && !String(u.tekst).includes('@klaudioAI_bot') ? 'bez-spomena' : prijenos) as any }),
    ...dodatno,
  })
  return { r, izv, kanal, ploca, zadaci }
}

let brojac = 0
const por = (o: Partial<UlaznaPoruka> = {}): UlaznaPoruka => ({
  kanal: 'telegram', chatId: '-511', porukaId: String(++brojac), posiljateljId: '42', posiljateljIme: 'Korisnik',
  posiljateljJeBot: false, tekst: 'pitanje', ts: '2026-10-07T20:00:00Z', privatno: true, obracanjeBotu: true,
  ...o,
})

// ─── SEND_DOC ────────────────────────────────────────────────────────────────

describe('SEND_DOC iz mape privitaka chata (node-A 07.10.)', () => {
  test('datoteka iz privitci/<chat> se šalje, oznaka nestaje iz teksta', async () => {
    const priv = join(mapa, 'privitci', '-511')
    mkdirSync(priv, { recursive: true })
    writeFileSync(join(priv, 'pinout.xlsx'), 'xlsx')
    const o = okolina({}, { dokumentiMapeChata: (_k, chatId) => [join(mapa, 'privitci', chatId)] })
    o.izv.odgovori = [{ resultText: `Evo tablice.\n[[SEND_DOC: ${join(priv, 'pinout.xlsx')} | ULX5M-GS pinout]]` }]
    o.r.primi(por({ tekst: 'pošalji xlsx u grupu' }), o.kanal)
    await o.r.mirno()
    expect(o.kanal.dokumenti).toEqual([join(priv, 'pinout.xlsx')])
    expect(o.kanal.tekstovi.join('\n')).not.toContain('SEND_DOC')
    expect(o.kanal.tekstovi.join('\n')).not.toContain('nije poslan')
  })

  test('privitci DRUGOG chata nisu dopušteni', async () => {
    const tudja = join(mapa, 'privitci', '-999')
    mkdirSync(tudja, { recursive: true })
    writeFileSync(join(tudja, 'tajno.xlsx'), 'x')
    const o = okolina({}, { dokumentiMapeChata: (_k, chatId) => [join(mapa, 'privitci', chatId)] })
    o.izv.odgovori = [{ resultText: `[[SEND_DOC: ${join(tudja, 'tajno.xlsx')} | x]]` }]
    o.r.primi(por(), o.kanal)
    await o.r.mirno()
    expect(o.kanal.dokumenti).toEqual([])
    expect(o.kanal.tekstovi.join('\n')).toContain('izvan dopuštene mape')
  })

  test('Telegram odbije slanje → razlog ide u grupu, ne tišina', async () => {
    const o = okolina()
    // radniDir chata je podmapa — datoteku stavimo tamo gdje je jezgra traži
    const { radniDirRazgovora } = await import('../src/razgovor/Ovlasti')
    const dir = radniDirRazgovora(join(mapa, 'radni'), { korijen: join(mapa, 'razgovor'), home: join(mapa, 'home'), tmHome: join(mapa, 'tm'), kanal: 'telegram', chatId: '-511' }).dir
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'a.txt'), 'a')
    o.izv.odgovori = [{ resultText: `ok [[SEND_DOC: ${join(dir, 'a.txt')} | a]]` }]
    o.kanal.ishodDokumenta = { ok: false, razlog: 'Bad Request: chat not found' }
    o.r.primi(por(), o.kanal)
    await o.r.mirno()
    const sve = o.kanal.tekstovi.join('\n')
    expect(sve).toContain('📎 dokument a.txt nije poslan')
    expect(sve).toContain('chat not found')
  })

  test('identitet navodi STVARNE mape iz kojih se šalje i kaže da se oznaka ne citira', () => {
    const t = sastaviIdentitet({
      ime: 'Šaban', instalacija: 'node-A', ovlasti: 'puno', plocaUrl: 'http://127.0.0.1:17781', port: 17781,
      dokumenti: true, radniDir: '/r/radni', dokumentiMape: ['/r/privitci/-511'],
    })
    expect(t).toContain('[[SEND_DOC: /apsolutna/putanja | kratak opis]]')
    expect(t).toContain('/r/radni')
    expect(t).toContain('/r/privitci/-511')
    expect(t).toMatch(/ne piši oznaku .*kao primjer/i)
  })
})

// ─── Trag razgovora na ploči ─────────────────────────────────────────────────

describe('zadatak razgovora na ploči čvora', () => {
  test('kratak ljudski potez → nema zadatka', async () => {
    const o = okolina()
    o.r.primi(por({ tekst: 'koliko je sati?' }), o.kanal)
    await o.r.mirno()
    expect(o.ploca.zadaci.size).toBe(0)
  })

  test('dug ljudski potez (> praga) → zadatak: primljeno, radi, odgovor, gotovo', async () => {
    const o = okolina()
    o.izv.trajanjeMs = 120
    o.izv.odgovori = [{ resultText: 'Tablica je gotova, 104 pina.' }]
    o.r.primi(por({ tekst: 'napravi mi xlsx s pinovima ulx5m-gs' }), o.kanal)
    await cekaj(80)
    const [id, z] = [...o.ploca.zadaci.entries()][0]!
    expect(z.status).toBe('in_progress')
    expect(z.oznake).toEqual(expect.arrayContaining(['razgovor', 'no-autonomy']))
    expect(z.naslov).toContain('napravi mi xlsx')
    await o.r.mirno()
    expect(o.ploca.status(id)).toBe('completed')
    const b = z.biljeske.join('\n')
    expect(b).toContain('📥')
    expect(b).toContain('Korisnik')
    expect(b).toContain('⚙️')
    expect(b).toContain('104 pina')
  })

  test('upit drugom botu → zadatak odmah, bilješka „poslano", ostaje u radu; odgovor bota se upisuje i zatvara', async () => {
    const o = okolina({}, {}, 'poslano')
    o.izv.odgovori = [{ resultText: '@klaudioAI_bot kako da pošaljem datoteku?' }]
    o.r.primi(por({ tekst: 'pitaj klaudija kako se šalje datoteka' }), o.kanal)
    await o.r.mirno()
    expect(o.ploca.zadaci.size).toBe(1)
    const [id, z] = [...o.ploca.zadaci.entries()][0]!
    expect(z.status).toBe('in_progress')
    expect(z.biljeske.join('\n')).toContain('📤')
    expect(z.biljeske.join('\n')).toContain('kako da pošaljem datoteku')

    // odgovor drugog bota (LAN kanal) — isti zadatak, ne novi
    o.izv.odgovori = [{ resultText: 'Hvala, šaljem.' }]
    o.r.primi(por({ izvor: 'bot', posiljateljIme: 'klaudio', posiljateljId: 'bot:klaudio', tekst: 'Koristi [[SEND_DOC]] oznaku.', lanac: { lanacId: 'L1', skok: 1 } as any }), o.kanal)
    await o.r.mirno()
    expect(o.ploca.zadaci.size).toBe(1)
    const b = z.biljeske.join('\n')
    expect(b).toContain('📥')
    expect(b).toContain('klaudio')
    expect(b).toContain('Koristi')
    expect(o.ploca.status(id)).toBe('completed')
  })

  test('poruka upućena drugom botu dok je zadatak otvoren → bilješka „pročitano"', async () => {
    const o = okolina({ preskociAkoSadrzi: ['@klaudioAI_bot'] } as any, {}, 'poslano')
    o.izv.odgovori = [{ resultText: '@klaudioAI_bot pomozi' }]
    o.r.primi(por({ tekst: 'pitaj klaudija' }), o.kanal)
    await o.r.mirno()
    o.r.primi(por({ tekst: '@klaudioAI_bot otvori taj zadatak', obracanjeBotu: false, privatno: false }), o.kanal)
    await o.r.mirno()
    const z = [...o.ploca.zadaci.values()][0]!
    expect(z.biljeske.join('\n')).toContain('otvori taj zadatak')
  })

  test('drugi bot ne odgovori u roku → zadatak se zatvara s napomenom (ne visi u radu)', () => {
    const ploca = new LaznaPloca()
    let sada = 1_000_000
    const zr = stvoriZadatkeRazgovora({ ploca, korijen: join(mapa, 'r'), autor: () => 'Šaban', sat: () => sada, cekanjeBotaMs: 60_000 })
    const id = zr.otvori('telegram:-511', { naslov: 'x', opis: 'y', primljeno: '📥 Korisnik: x' })!
    zr.radi('telegram:-511')
    zr.cekaBota('telegram:-511', '📤 poslano')
    sada += 61_000
    zr.provjeriRokove()
    expect(ploca.status(id)).toBe('completed')
    expect(ploca.zadaci.get(id)!.biljeske.join('\n')).toContain('⌛')
    expect(zr.aktivni('telegram:-511')).toBeNull()
  })

  test('stanje preživi restart (datoteka zadaci.json)', () => {
    const ploca = new LaznaPloca()
    const korijen = join(mapa, 'r2')
    const a = stvoriZadatkeRazgovora({ ploca, korijen, autor: () => 'Šaban' })
    const id = a.otvori('telegram:-511', { naslov: 'x', opis: 'y', primljeno: '📥' })
    const b = stvoriZadatkeRazgovora({ ploca, korijen, autor: () => 'Šaban' })
    expect(b.aktivni('telegram:-511')).toBe(id)
  })
})

// ─── Konzola ─────────────────────────────────────────────────────────────────

describe('konzola razgovora je trajna', () => {
  test('redak se upisuje u datoteku i čita natrag (tko otvori konzolu kasnije, vidi ga)', () => {
    const korijen = join(mapa, 'k')
    zapisiKonzolu(korijen, '💬 ⇢ Korisnik: bok', 'info', Date.parse('2026-10-07T20:00:00Z'))
    zapisiKonzolu(korijen, '💬 ⇠ Šaban: bok', 'ok', Date.parse('2026-10-07T20:00:05Z'))
    const r = citajKonzolu(korijen, 10)
    expect(r).toHaveLength(2)
    expect(r[0]).toContain('2026-10-07T20:00:00')
    expect(r[1]).toContain('Šaban')
    expect(readFileSync(join(korijen, 'konzola.log'), 'utf-8').split('\n').filter(Boolean)).toHaveLength(2)
  })
})

// ─── Telegram kanal: razlog neuspjeha ────────────────────────────────────────

describe('telegramKanal.posaljiDokumentIshod', () => {
  test('Bot API 400 → ok:false s opisom greške (bez tokena u razlogu)', async () => {
    const { telegramKanal } = await import('../src/TelegramPoller')
    const izvor = join(mapa, 'a.xlsx')
    writeFileSync(izvor, 'x')
    const stari = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({ ok: false, description: 'Bad Request: chat not found' }), { status: 400 })) as any
    try {
      const k = telegramKanal('123:TAJNA')
      const r = await k.posaljiDokumentIshod!('-511', izvor, 'opis')
      expect(r.ok).toBe(false)
      expect(r.razlog).toContain('chat not found')
      expect(r.razlog).not.toContain('TAJNA')
      expect(await k.posaljiDokument('-511', izvor, 'opis')).toBe(false)
    } finally { globalThis.fetch = stari }
  })
})

// ─── Adapter na stvarnu ploču (SQLite) ───────────────────────────────────────

describe('plocaIzTaskManagera nad stvarnom bazom', () => {
  test('pending → in_progress → completed, bilješke, bez nositelja, no-autonomy', async () => {
    const { TaskManagerSQL } = await import('../src/core/TaskManagerSQL')
    const { plocaIzTaskManagera } = await import('../src/razgovor/RazgovorPloca')
    const { createEmptyTaskDb } = await import('./helpers/db-fixture')
    createEmptyTaskDb(join(mapa, 'tasks.db'))
    const tm = new TaskManagerSQL(join(mapa, 'tasks.db'))
    const zr = stvoriZadatkeRazgovora({ ploca: plocaIzTaskManagera(tm as any), korijen: join(mapa, 'r'), autor: () => 'Šaban' })
    const id = zr.otvori('telegram:-511', { naslov: '💬 Šaban · pinout', opis: 'trag', primljeno: '📥 od Korisnik: pinout' })!
    expect(tm.getTask(id)!.status).toBe('pending')
    expect(tm.getTask(id)!.assignee || '').toBe('')
    expect(tm.getTask(id)!.tags).toEqual(expect.arrayContaining(['razgovor', 'no-autonomy']))
    zr.radi('telegram:-511', '⚙️ radi')
    expect(tm.getTask(id)!.status).toBe('in_progress')
    zr.cekaBota('telegram:-511', '📤 upit poslan')
    zr.gotovo('telegram:-511', '✅ gotovo')
    const t = tm.getTask(id)!
    expect(t.status).toBe('completed')
    expect(t.progressNotes.map(n => n.note).join('\n')).toContain('📥 od Korisnik')
    expect(t.progressNotes.map(n => n.note).join('\n')).toContain('📤 upit poslan')
    expect(t.progressNotes.map(n => n.agent)).toContain('Šaban')
  })
})

// ─── CLI: token iz konfiguracije čvora ───────────────────────────────────────

describe('scripts/posalji-dokument.ts', () => {
  const pokreni = (args: string[], env: Record<string, string>) => {
    const r = Bun.spawnSync(['bun', join(import.meta.dir, '..', 'scripts', 'posalji-dokument.ts'), ...args], {
      env: { PATH: process.env.PATH!, HOME: mapa, TM_HOME: join(mapa, 'tm'), ...env },
    })
    return { kod: r.exitCode, izlaz: r.stdout.toString() + r.stderr.toString() }
  }
  const pripremi = () => {
    const cfg = join(mapa, 'postavke-kanala.json')
    writeFileSync(cfg, JSON.stringify({ ukljucen: true, botTokenEnv: 'TM_PROBA_TOKEN', chatId: '-511', ulaz: { dopusteniChatovi: ['-511'] } }))
    const dat = join(mapa, 'pinout.xlsx')
    writeFileSync(dat, 'xlsx')
    return { cfg, dat }
  }

  test('--suho: token iz konfiguracije čvora, chat dopušten → izlaz 0, token se ne ispisuje', () => {
    const { cfg, dat } = pripremi()
    const r = pokreni(['--chat', '-511', '--datoteka', dat, '--suho'], { TM_TELEGRAM_CONFIG: cfg, TM_PROBA_TOKEN: '999:LAZNI' })
    expect(r.izlaz).toContain('token čvora postoji')
    expect(r.izlaz).not.toContain('LAZNI')
    expect(r.kod).toBe(0)
  })

  test('chat koji nije u postavkama čvora → izlaz 1', () => {
    const { cfg, dat } = pripremi()
    const r = pokreni(['--chat', '-777', '--datoteka', dat, '--suho'], { TM_TELEGRAM_CONFIG: cfg, TM_PROBA_TOKEN: '999:LAZNI' })
    expect(r.kod).toBe(1)
    expect(r.izlaz).toContain('nije u postavkama')
  })

  test('bez tokena u konfiguraciji čvora → izlaz 1 s razlogom', () => {
    const { cfg, dat } = pripremi()
    const r = pokreni(['--chat', '-511', '--datoteka', dat, '--suho'], { TM_TELEGRAM_CONFIG: cfg })
    expect(r.kod).toBe(1)
    expect(r.izlaz).toContain('nema bot tokena')
  })
})
