/**
 * TASK-5285 — Telegram nalog s izvršiteljem, kratki („ADHD") stil izlaza, razgovor koji se vidi.
 *
 *  1. ulaz: zadatak iz Telegrama dobiva izvršitelja (ulaz.zadaniIzvrsitelj → odabir po vrsti
 *     posla → zadani) i oznaku `nalog` kad ga šalje dopušteni korisnik (put „na nalog");
 *  2. uz uključen razgovor jednostavan posao (E1–E2) ide u razgovor, ne u zadatak — osim kad
 *     poruka izrijekom traži zadatak;
 *  3. stil `kratko`: prvi redak = ishod (✅/⚠️/❌ + rečenica), najviše 5 točaka, bez uvoda i
 *     sažetka, poveznica za detalje; `puno` = tekst kakav jest;
 *  4. obavijest o zadatku samo na PRIJELAZU u completed/failed (ne completed → completed);
 *  5. izravno obraćanje botu („Šabane, …") pobjeđuje popis preskociAkoSadrzi;
 *  6. razgovor: „tipka…" se ponavlja dok model radi; [OD: ime (uid:N)]; Konzola vidi ulaz i izlaz;
 *     uz ovlasti `rad` sesija smije ČITATI zapise razgovora, pošiljatelje i ingest.jsonl.
 *
 * Bez mreže: `api`, izvršitelj i kanal su ubrizgani.
 *
 * Autorica: Jelena (Engineer), TASK-5285.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { kratkiIzvjestaj, primijeniStil, UPUTA_KRATKO } from '../src/Stil'
import { kanalZaDaemon, putanjeIzPostavki } from '../src/IzlazniKanal'
import {
  ZADANE_POSTAVKE, ZADANI_ULAZ, izlazniKanal, obavijestiZadatak, trebaObavijest, validateTelegramPatch,
  type TelegramPostavke,
} from '../src/TelegramConfig'
import { odaberiIzvrsitelja, procijeniIngest, trazeZadatak, RAZLOG } from '../src/core/Ingest'
import { KLASIFIKATOR_ZADANI } from '../src/core/ModeClassifier'
import { KonfiguracijskiRegistar } from '../src/core/orchestrator/AgentRegistry'
import { ZADANE_POSTAVKE as INGEST_ZADANO } from '../src/core/IngestConfig'
import { ZADANO_STANJE, jedanProlaz, ulaznaPorukaIzTelegrama, type Api, type RazgovorUlaza, type Update } from '../src/TelegramPoller'
import { RAZGOVOR_ZADANO, type RazgovorPostavke } from '../src/razgovor/RazgovorPostavke'
import { jeZaDrugog, pocinjeImenom } from '../src/razgovor/Filtar'
import { argumentiOvlasti } from '../src/razgovor/Ovlasti'
import { sastaviIdentitet } from '../src/razgovor/Identitet'
import { stvoriRazgovor, type RazgovorOvisnosti } from '../src/razgovor/Razgovor'
import type { Kanal, UlaznaPoruka } from '../src/razgovor/Kanal'
import type { ExecRequest, ExecResult } from '../src/core/orchestrator/Ports'

let mapa: string
beforeEach(() => { mapa = mkdtempSync(join(tmpdir(), 'tm-5285-')) })
afterEach(() => { rmSync(mapa, { recursive: true, force: true }) })
const cekaj = (ms: number) => new Promise(r => setTimeout(r, ms))

// ─── 3. Stil ─────────────────────────────────────────────────────────────────

const DUGI = [
  '✅ **Ana** završio zadatak:',
  '',
  '📋 **REZULTAT:** Proveo sam provjeru funkcionalnosti REGOČ sustava — sve ključne komponente su podignute i rade.',
  '',
  '| Komponenta | Status | Dokaz |',
  '|---|---|---|',
  '| TaskManager (localhost:17781) | ✅ UP | HTTP 200, 4ms |',
  '| RegocDaemon (PID 524708) | ✅ RUNNING | StaleCode OK |',
  '',
  '```json',
  '{"status":"healthy"}',
  '```',
  '- Hindsight odgovara unutar roka',
  '- Ollama dostupna',
  '- ChromaDB dostupna',
  '- Disk 61 %',
  '',
  '## Sažetak',
  'Sve radi.',
  'REGOC-STATUS: DONE — provjera sustava',
].join('\n')

describe('Stil kratko', () => {
  test('prvi redak = ishod s ikonom i jednom rečenicom, bez markdowna i oznaka', () => {
    const k = kratkiIzvjestaj(DUGI)
    const reci = k.split('\n')
    expect(reci[0]!.startsWith('✅ ')).toBe(true)
    expect(reci[0]).toContain('Proveo sam provjeru funkcionalnosti')
    expect(k).not.toContain('**')
    expect(k).not.toContain('REZULTAT:')
    expect(k).not.toContain('```')
    expect(k).not.toContain('REGOC-STATUS')
    expect(k).not.toContain('Sažetak')
    // ikona se ne ponavlja na početku
    expect(reci[0]!.startsWith('✅ ✅')).toBe(false)
  })

  test('najviše 5 točaka, svaka kratka', () => {
    const k = kratkiIzvjestaj(DUGI, { maxTocaka: 5 })
    const tocke = k.split('\n').filter(r => r.startsWith('• '))
    expect(tocke.length).toBeGreaterThanOrEqual(3)
    expect(tocke.length).toBeLessThanOrEqual(5)
    for (const t of tocke) expect(t.length).toBeLessThanOrEqual(122)
    expect(k).toContain('TaskManager (localhost:17781): ✅ UP')
  })

  // Izmjereno na node-A (TASK-195): razdjelnik „---" iz izvještaja agenta postao je točka „• ---".
  test.each(['---', '***', '___', '- - -', '—', '=====', '* * *'])('crta %p nije točka', (crta) => {
    const k = kratkiIzvjestaj(`Ana završio zadatak: dojava stvorena.\n\n${crta}\nfree -h na node-A:\n- Mem: 15Gi`)
    expect(k.split('\n').filter(r => r.startsWith('• '))).toEqual(['• free -h na node-A:', '• Mem: 15Gi'])
  })

  // Stvarna poruka daemona na node-A (TASK-201, 06.10.2026.): uvodna fraza je bila „ishod",
  // a naslovi i tablica prihvatnih kriterija postali su točke.
  test('uvodna fraza, naslovi i prihvatni kriteriji nisu ni ishod ni točke', () => {
    const t = [
      '✅ **Jelena** završio zadatak:', '',
      'Sve je na mjestu. Evo finalnog izvještaja.', '', '---', '',
      '## TASK-201 — Rezultat', '',
      '**node-A** je VirtualBox appliance VM `regocAI`.', '',
      '**Uptime: 1 dan, 15 sati, 10 minuta** (boot: 2026-10-05 u 02:35:22).', '', '---', '',
      '## Provjera prihvatnih kriterija (1–20)', '',
      '| # | Stavka | Status | Dokaz |', '|---|---|---|---|',
      '| 1 | Zahtjev korisnika | ✅ | curl |',
    ].join('\n')
    const reci = kratkiIzvjestaj(t, { maxTocaka: 5 }).split('\n')
    expect(reci[0]).toBe('✅ Jelena završio zadatak: node-A je VirtualBox appliance VM regocAI.')
    expect(reci.slice(1)).toEqual(['• Uptime: 1 dan, 15 sati, 10 minuta (boot: 2026-10-05 u 02:35:22).'])
  })

  test.each([
    ['Gotovo. Disk je na 71 %.', 'Disk je na 71 %.'],
    ['Evo rezultata: disk je na 71 %.', 'disk je na 71 %.'],
    ['Zadatak je završen. Disk je na 71 %.', 'Disk je na 71 %.'],
  ])('uvodna fraza %p se preskače', (ulaz, ocekivano) => {
    expect(kratkiIzvjestaj(ulaz).split('\n')[0]).toBe(`✅ ${ocekivano}`)
  })

  test('detalji idu u zadnji redak kao poveznica', () => {
    const k = kratkiIzvjestaj(DUGI, { detalji: 'http://127.0.0.1:17781/#TASK-9' })
    expect(k.split('\n').pop()).toBe('↪ detalji: http://127.0.0.1:17781/#TASK-9')
  })

  test('ishod iz sadržaja: BLOCKED → ⚠️, neuspjeh → ❌, izričit ishod pobjeđuje', () => {
    expect(kratkiIzvjestaj('Nisam mogao pristupiti.\nREGOC-STATUS: BLOCKED — nema pristupa').startsWith('⚠️ ')).toBe(true)
    expect(kratkiIzvjestaj('❌ Agent pao: exit 1').startsWith('❌ ')).toBe(true)
    expect(kratkiIzvjestaj('Gotovo.', { ishod: 'greska' }).startsWith('❌ ')).toBe(true)
  })

  test('naslov ide u prvi redak prije rečenice', () => {
    expect(kratkiIzvjestaj('Sve radi.', { naslov: 'TASK-9 Provjera' }).split('\n')[0]).toBe('✅ TASK-9 Provjera — Sve radi.')
  })

  test('puno = tekst kakav jest', () => {
    expect(primijeniStil(DUGI, 'puno')).toBe(DUGI)
    expect(primijeniStil(DUGI, 'kratko')).toBe(kratkiIzvjestaj(DUGI))
  })

  test('uputa za razgovor opisuje oblik (prvi redak ishod, do 5 točaka, bez uvoda i sažetka)', () => {
    expect(UPUTA_KRATKO).toContain('Prvi redak')
    expect(UPUTA_KRATKO).toContain('5')
    expect(UPUTA_KRATKO.toLowerCase()).toContain('bez uvoda')
  })
})

// ─── Telegram postavke: stil, zadani izvršitelj, kanal za daemon, obavijest ───

describe('TelegramConfig — stil, zadaniIzvrsitelj, izlazniKanal, obavijest', () => {
  test('stil je u zadanom kratko; kratko|puno prolaze, ostalo se odbija', () => {
    expect(ZADANE_POSTAVKE.stil).toBe('kratko')
    expect(validateTelegramPatch({ stil: 'puno' }).ok).toBe(true)
    expect(validateTelegramPatch({ stil: 'dugo' }).ok).toBe(false)
  })

  test('ulaz.zadaniIzvrsitelj: ime agenta ili prazno', () => {
    expect(ZADANI_ULAZ.zadaniIzvrsitelj).toBe('')
    const ok = validateTelegramPatch({ ulaz: { zadaniIzvrsitelj: 'Ana' } })
    expect(ok.ok).toBe(true)
    expect((ok.zakrpa as any).ulaz.zadaniIzvrsitelj).toBe('ana')
    expect(validateTelegramPatch({ ulaz: { zadaniIzvrsitelj: 'rm -rf /' } }).ok).toBe(false)
  })

  test('izlazniKanal: token iz spremišta tajni paketa, chatId i stil iz telegram.json; bez tajne u JSON-u', () => {
    const cfgPut = join(mapa, 'telegram.json')
    const tajne = join(mapa, 'credentials.env')
    writeFileSync(cfgPut, JSON.stringify({ ukljucen: true, botTokenEnv: 'TG_PROBA_5285', chatId: '-100777', stil: 'kratko' }))
    writeFileSync(tajne, 'TG_PROBA_5285=111:probni\n')
    const k = izlazniKanal({ configPath: cfgPut, credPath: tajne })
    expect(k).toEqual({ token: '111:probni', chatId: '-100777', stil: 'kratko', obavijestZavrseno: true })
    writeFileSync(cfgPut, JSON.stringify({ ukljucen: false, botTokenEnv: 'TG_PROBA_5285', chatId: '-1' }))
    expect(izlazniKanal({ configPath: cfgPut, credPath: tajne })).toBeNull()
  })

  test('obavijest samo na prijelazu (completed → completed = ništa, TASK-5287)', () => {
    expect(trebaObavijest('in_progress', 'completed')).toBe(true)
    expect(trebaObavijest('completed', 'completed')).toBe(false)
    expect(trebaObavijest('in_progress', 'failed')).toBe(true)
    expect(trebaObavijest('pending', 'in_progress')).toBe(false)
    expect(trebaObavijest(undefined, 'completed')).toBe(true)
  })

  test('obavijest u stilu kratko: ishod u prvom retku + točke iz rezultata, bez prefiksa', async () => {
    const cfgPut = join(mapa, 'telegram.json')
    writeFileSync(cfgPut, JSON.stringify({ ukljucen: true, botToken: '1:x', chatId: '-5', prefix: '📋', stil: 'kratko' }))
    const poslano: any[] = []
    const orig = globalThis.fetch
    globalThis.fetch = (async (_u: any, init: any) => { poslano.push(JSON.parse(init.body)); return new Response('{"ok":true}') }) as any
    try {
      const r = await obavijestiZadatak('TASK-9', 'Provjera sustava', 'completed', cfgPut, { rezultat: DUGI, detalji: 'http://p/#TASK-9' })
      expect(r.ok).toBe(true)
    } finally { globalThis.fetch = orig }
    const t = poslano[0].text as string
    expect(t.startsWith('✅ TASK-9 Provjera sustava — ')).toBe(true)
    expect(t).toContain('↪ detalji: http://p/#TASK-9')
    expect(t.split('\n').filter(r => r.startsWith('• ')).length).toBeLessThanOrEqual(5)
  })
})

// ─── 1–2. Ulaz: izvršitelj, nalog, razgovor za jednostavno ─────────────────

describe('Ingest — izvršitelj i razgovor', () => {
  const registar = (agents: { id: string; keywords: string[] }[]) => new KonfiguracijskiRegistar(agents)
  test('odaberiIzvrsitelja: izričit → ruting po ključnoj riječi → prijedlog → zadani → catch-all → prvi', () => {
    const r = registar([{ id: 'ana', keywords: ['disk'] }, { id: 'ivan', keywords: ['*'] }])
    expect(odaberiIzvrsitelja({ izricit: 'marko', tekst: 'disk', registar: r })).toBe('marko')
    expect(odaberiIzvrsitelja({ tekst: 'provjeri disk', prijedlozi: ['ivan'], registar: r })).toBe('ana')
    expect(odaberiIzvrsitelja({ tekst: 'nešto', prijedlozi: ['ivan'], dopusteni: ['ana', 'ivan'], registar: registar([]) })).toBe('ivan')
    expect(odaberiIzvrsitelja({ tekst: 'nešto', prijedlozi: ['nepoznat'], dopusteni: ['ana'], zadani: 'ana', registar: registar([]) })).toBe('ana')
    expect(odaberiIzvrsitelja({ tekst: 'nešto', zadani: 'marko', registar: r })).toBe('marko')
    expect(odaberiIzvrsitelja({ tekst: 'nešto', registar: r })).toBe('ivan')
    expect(odaberiIzvrsitelja({ tekst: 'nešto', dopusteni: ['ana'], registar: registar([]) })).toBe('ana')
  })

  test('prijedlog „nitko posebno" (orkestrator) se preskače', () => {
    expect(odaberiIzvrsitelja({ prijedlozi: [KLASIFIKATOR_ZADANI], zadani: 'ana', registar: registar([]) })).toBe('ana')
    expect(odaberiIzvrsitelja({ dopusteni: [KLASIFIKATOR_ZADANI, 'ivan'], registar: registar([]) })).toBe('ivan')
  })

  test('zadatak iz ulaza uvijek ima izvršitelja', () => {
    const o = procijeniIngest({ source: 'telegram', text: 'Provjeri da li je sustav funkcionalan!', zadaniIzvrsitelj: 'ana' }, INGEST_ZADANO)
    expect(o.akcija).toBe('zadatak')
    expect(o.zadatak!.assignee).toBe('ana')
  })

  test('izričit izvršitelj iz zahtjeva ostaje', () => {
    const o = procijeniIngest({ source: 'telegram', text: 'Provjeri da li je sustav funkcionalan!', assignee: 'marko' }, INGEST_ZADANO)
    expect(o.zadatak!.assignee).toBe('marko')
  })

  test('uz razgovor: E2 bez izričitog traženja zadatka → odgovor (razgovor), ploča čista', () => {
    const o = procijeniIngest({ source: 'telegram', text: 'Provjeri da li je sustav funkcionalan!', razgovor: true }, INGEST_ZADANO)
    expect(o.akcija).toBe('odgovor')
    expect(o.razlog).toBe(RAZLOG.RAZGOVOR)
  })

  test('uz razgovor: nalog s imenovanim nositeljem ostaje zadatak (TASK-5293)', () => {
    const o = procijeniIngest({ source: 'telegram', text: 'Provjeri da li je sustav funkcionalan!', razgovor: true, assignee: 'ana' }, INGEST_ZADANO)
    expect(o.akcija).toBe('zadatak')
    expect(o.zadatak!.assignee).toBe('ana')
  })

  test('uz razgovor: „zadatak: …" ili /zadatak otvara zadatak i za E2', () => {
    expect(trazeZadatak('zadatak: provjeri disk')).toBe(true)
    expect(trazeZadatak('/zadatak provjeri disk')).toBe(true)
    expect(trazeZadatak('Šabane, otvori zadatak da se provjeri disk')).toBe(true)
    expect(trazeZadatak('kako napreduje zadatak 5?')).toBe(false)
    const o = procijeniIngest({ source: 'telegram', text: 'zadatak: provjeri da li je sustav funkcionalan!', razgovor: true }, INGEST_ZADANO)
    expect(o.akcija).toBe('zadatak')
  })
})

const JA = { id: 900, username: 'regoc_saban_bot' }

function cfgTg(ulaz: Partial<TelegramPostavke['ulaz']> = {}): TelegramPostavke {
  return { ...ZADANE_POSTAVKE, ukljucen: true, botToken: '123:ABC', ulaz: { ...ZADANI_ULAZ, ukljucen: true, ...ulaz } }
}

function poruka(over: Partial<NonNullable<Update['message']>> = {}, id = 1): Update {
  return {
    update_id: id,
    message: {
      message_id: 100 + id, date: 1_700_000_000, text: 'zadatak: provjeri disk na čvoru',
      chat: { id: -100555, title: 'Grupa', type: 'supergroup' },
      from: { id: 42, first_name: 'Ivan', username: 'ivan' },
      ...over,
    },
  }
}

class LazniApi implements Api {
  updates: Update[] = []
  ingesti: Record<string, unknown>[] = []
  odgovorIngest = { status: 201, tijelo: { ok: true, created: true, taskId: 'TASK-7', title: 'Provjeri disk na čvoru', assignee: 'ana' } as any }
  poslane: string[] = []
  async getUpdates() { return { ok: true, result: this.updates } }
  async ingest(t: Record<string, unknown>) { this.ingesti.push(t); return this.odgovorIngest }
  async odgovori(_c: string | number, tekst: string) { this.poslane.push(tekst); return true }
}

function razgovorUlaz(p: Partial<RazgovorPostavke> = {}) {
  const primljeno: UlaznaPoruka[] = []
  const r: RazgovorUlaza = {
    razgovor: { primi: (u: UlaznaPoruka) => { primljeno.push(u) } },
    postavke: () => ({ ...RAZGOVOR_ZADANO, dopusteniKorisnici: ['42'], ukljucen: true, ime: 'Šaban', odgovaraNa: 'dopusteni-sve', ...p }),
    ja: JA,
    kanal: { ime: 'telegram' } as Kanal,
  }
  return { r, primljeno }
}

describe('Poller — nalog dopuštenog korisnika', () => {
  test('dopušteni pošiljatelj → tijelo ingesta nosi oznaku nalog, zadanog izvršitelja i razgovor:true', async () => {
    const api = new LazniApi()
    api.updates = [poruka()]
    const { r } = razgovorUlaz()
    await jedanProlaz(cfgTg({ zadaniIzvrsitelj: 'ana' }), { ...ZADANO_STANJE }, api, r)
    expect(api.ingesti.length).toBe(1)
    expect(api.ingesti[0]!.tags).toEqual(['nalog'])
    expect(api.ingesti[0]!.zadaniIzvrsitelj).toBe('ana')
    expect(api.ingesti[0]!.razgovor).toBe(true)
  })

  test('nedopušteni pošiljatelj → bez oznake nalog (ide kroz vrata autonomije)', async () => {
    const api = new LazniApi()
    api.updates = [poruka({ from: { id: 77, first_name: 'Netko' } })]
    const { r } = razgovorUlaz()
    await jedanProlaz(cfgTg(), { ...ZADANO_STANJE }, api, r)
    expect(api.ingesti[0]!.tags).toBeUndefined()
  })

  test('dopušten po ulaz.dopusteniKorisnici (bez razgovora) → nalog', async () => {
    const api = new LazniApi()
    api.updates = [poruka()]
    await jedanProlaz(cfgTg({ dopusteniKorisnici: ['42'] }), { ...ZADANO_STANJE }, api)
    expect(api.ingesti[0]!.tags).toEqual(['nalog'])
  })

  test('potvrda u chat: „⏳ radim TASK-x — naslov (izvršitelj)"', async () => {
    const api = new LazniApi()
    api.updates = [poruka()]
    await jedanProlaz(cfgTg(), { ...ZADANO_STANJE }, api)
    expect(api.poslane).toEqual(['⏳ radim TASK-7 — Provjeri disk na čvoru (ana)'])
  })
})

// ─── 5. Izravno obraćanje pobjeđuje popis ────────────────────────────────────

describe('Izravno obraćanje botu ima prednost pred preskociAkoSadrzi', () => {
  test('„Šabane da li vidiš korisnika Pero" — vokativ je obraćanje', () => {
    expect(pocinjeImenom('Šabane da li vidiš korisnika Pero', 'Šaban')).toBe(true)
    expect(pocinjeImenom('Šabanu je dosadno', 'Šaban')).toBe(true)
    expect(pocinjeImenom('Šabanovićevi su došli', 'Šaban')).toBe(false)
    const m = poruka({ text: 'Šabane da li vidiš korisnika Pero' }).message!
    const p = ulaznaPorukaIzTelegrama(m, m.text!, JA, 'Šaban')
    expect(p.obracanjeBotu).toBe(true)
    expect(jeZaDrugog(p, { preskociAkoSadrzi: ['Pero', 'Korisnik'], tisinaKadDrugom: false })).toBe(false)
  })

  test('bez obraćanja popis i dalje vrijedi', () => {
    const m = poruka({ text: 'Pero, pogledaj ovo' }).message!
    const p = ulaznaPorukaIzTelegrama(m, m.text!, JA, 'Šaban')
    expect(jeZaDrugog(p, { preskociAkoSadrzi: ['Pero'], tisinaKadDrugom: false })).toBe(true)
  })
})

// ─── 6. Razgovor ─────────────────────────────────────────────────────────────

class Kanal5285 implements Kanal {
  ime = 'telegram' as const
  maxDuljinaPoruke = 4096
  maxDokumentBajta = 1024
  tekstovi: string[] = []
  tipkanja = 0
  async posaljiTekst(_c: string, tekst: string) { this.tekstovi.push(tekst); return true }
  async posaljiDokument() { return true }
  async pise() { this.tipkanja++ }
}

class SporiIzvrsitelj {
  ime = 'spori'
  zahtjevi: ExecRequest[] = []
  constructor(private ms: number, private tekst = 'Sustav radi.') {}
  async run(req: ExecRequest): Promise<ExecResult> {
    this.zahtjevi.push(req)
    await cekaj(this.ms)
    return { exitCode: 0, resultText: this.tekst, sessionId: 'S1', numTurns: 1, usage: { costUsd: 0.01 } as any }
  }
}

function jezgra(izv: SporiIzvrsitelj, o: Partial<RazgovorPostavke> = {}, dod: Partial<RazgovorOvisnosti> = {}) {
  return stvoriRazgovor({
    postavke: () => ({ ...RAZGOVOR_ZADANO, dopusteniKorisnici: ['1001'], ukljucen: true, burstMs: 5, radniDir: join(mapa, 'radni'), ...o }),
    izvrsitelj: izv, jePauza: () => false, kvotaPuna: async () => false,
    korijen: join(mapa, 'razgovor'), tmHome: join(mapa, 'tm'), home: join(mapa, 'home'),
    port: 17781, plocaUrl: 'http://127.0.0.1:17781', instalacija: 'proba', env: { PATH: '/bin' },
    log: () => {}, ...dod,
  })
}

const ulazna = (o: Partial<UlaznaPoruka> = {}): UlaznaPoruka => ({
  kanal: 'telegram', chatId: '-100777', porukaId: '1', posiljateljId: '1001', posiljateljIme: 'Korisnik',
  posiljateljJeBot: false, tekst: 'je li sustav funkcionalan?', ts: '2026-10-06T10:00:00Z', privatno: false, obracanjeBotu: true,
  ...o,
})

describe('Razgovor — tipkanje, uid, Konzola, stil', () => {
  test('„tipka…" se ponavlja dok model radi (svakih pisiMs), pa stane', async () => {
    const izv = new SporiIzvrsitelj(120)
    const k = new Kanal5285()
    const r = jezgra(izv, {}, { pisiMs: 25 })
    r.primi(ulazna(), k)
    await r.mirno()
    expect(k.tipkanja).toBeGreaterThanOrEqual(3)
    const nakon = k.tipkanja
    await cekaj(80)
    expect(k.tipkanja).toBe(nakon)
  })

  test('prompt nosi [OD: ime (uid:N)]', async () => {
    const izv = new SporiIzvrsitelj(1)
    const r = jezgra(izv)
    r.primi(ulazna(), new Kanal5285())
    await r.mirno()
    expect(izv.zahtjevi[0]!.prompt).toContain('[OD: Korisnik (uid:1001)]')
  })

  test('Konzola dobiva ulaz i izlaz (trajanje, trošak), tajne zatamnjene', async () => {
    const izv = new SporiIzvrsitelj(1, 'token je 123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
    const redovi: string[] = []
    const r = jezgra(izv, {}, { konzola: (t: string) => redovi.push(t) })
    r.primi(ulazna(), new Kanal5285())
    await r.mirno()
    const sve = redovi.join('\n')
    expect(sve).toContain('Korisnik (uid:1001)')
    expect(sve).toContain('je li sustav funkcionalan?')
    expect(sve).toMatch(/⇠ .*\d+(,\d)? s/)
    expect(sve).not.toContain('AAAAAAAAAAAAAAAA')
  })

  test('identitet: stil kratko dodaje uputu, puno ne', () => {
    const baza = { ime: 'Šaban', instalacija: 'x', ovlasti: 'rad' as const, plocaUrl: 'http://p', port: 1, dokumenti: false, radniDir: '/r' }
    expect(sastaviIdentitet({ ...baza, stil: 'kratko' })).toContain(UPUTA_KRATKO)
    expect(sastaviIdentitet({ ...baza, stil: 'puno' })).not.toContain(UPUTA_KRATKO)
  })
})

describe('Ovlasti rad — čitanje zapisa razgovora i ulaza', () => {
  const o = { port: 17781, radniDir: '/r', tmHome: '/tm', home: '/h', korijen: '/tm/data/razgovor', ingestLog: '/tm/data/ingest.jsonl', kanal: 'telegram', chatId: '-100777' }
  test('rad: Read zapisa OVOG chata, pošiljatelja i ingest.jsonl; bez pisanja tamo i bez drugih chatova', () => {
    const a = argumentiOvlasti('rad', o)
    const dopusteno = a[a.indexOf('--allowedTools') + 1]!
    expect(dopusteno).toContain('Read(//tm/data/razgovor/telegram/-100777/**)')
    expect(dopusteno).not.toContain('Read(//tm/data/razgovor/telegram/**)')
    expect(dopusteno).toContain('Read(//tm/data/razgovor/posiljatelji.json)')
    expect(dopusteno).toContain('Read(//tm/data/ingest.jsonl)')
    expect(dopusteno).not.toContain('Write(//tm/data/razgovor')
  })
  test('citanje: bez pristupa zapisima', () => {
    const a = argumentiOvlasti('citanje', o)
    expect(a[a.indexOf('--allowedTools') + 1]).not.toContain('razgovor/telegram')
  })
})

describe('IzlazniKanal — daemon dobiva kanal ploče', () => {
  test('iz postavke.env idu samo putanje (TM_HOME/TM_CREDENTIALS/TM_TELEGRAM_CONFIG)', () => {
    const p = join(mapa, 'postavke.env')
    writeFileSync(p, '# x\nTM_CREDENTIALS=/a/c.env\nTM_PORT=1\nNEKA_TAJNA=x\nTM_TELEGRAM_CONFIG="/a/telegram.json"\n')
    expect(putanjeIzPostavki(p)).toEqual({ TM_CREDENTIALS: '/a/c.env', TM_TELEGRAM_CONFIG: '/a/telegram.json' })
  })

  test('kanalZaDaemon: token iz spremišta ploče, chat iz telegram.json, oblikuje u stilu kratko', () => {
    const cfg = join(mapa, 'telegram.json')
    const spremiste = join(mapa, 'c.env')
    const post = join(mapa, 'postavke.env')
    writeFileSync(cfg, JSON.stringify({ ukljucen: true, botTokenEnv: 'TG_PROBA_5285_B', chatId: '-77' }))
    writeFileSync(spremiste, 'TG_PROBA_5285_B=222:probni\n')
    writeFileSync(post, `TM_CREDENTIALS=${spremiste}\nTM_TELEGRAM_CONFIG=${cfg}\n`)
    const staro = { c: process.env.TM_CREDENTIALS, t: process.env.TM_TELEGRAM_CONFIG }
    delete process.env.TM_CREDENTIALS
    delete process.env.TM_TELEGRAM_CONFIG
    try {
      const k = kanalZaDaemon({ postavkePut: post })!
      expect(k.token).toBe('222:probni')
      expect(k.chatId).toBe('-77')
      expect(k.oblikuj(DUGI).startsWith('✅ ')).toBe(true)
    } finally {
      if (staro.c === undefined) delete process.env.TM_CREDENTIALS; else process.env.TM_CREDENTIALS = staro.c
      if (staro.t === undefined) delete process.env.TM_TELEGRAM_CONFIG; else process.env.TM_TELEGRAM_CONFIG = staro.t
    }
  })
})
