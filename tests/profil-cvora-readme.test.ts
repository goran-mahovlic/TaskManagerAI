/**
 * TASK-5755 (Mac K9): profil „upravitelj-cvora" je snimljen na node-A (Linux, sustav u ~/.claude/regoc,
 * postavke uz paket). Na čvoru instaliranom po README-u (macOS) dio stavki ne vrijedi ili se
 * provjerava drugačije — slijepa primjena bi ploči promijenila bazu (TM_DB) ili pisala systemd drop-ine.
 *
 *   - README raspored: putanje kompleta (${SUSTAV_DIR}/…) koje čvor nema → PRESKOČENO, nikad primjena;
 *   - macOS: capguard N/A; konzola usluge = plist StandardOutPath (poveznica na mjesto koje ploča
 *     čita); PATH iz plista; TZ kroz postavke.env (s-okolinom.sh ga daje objema uslugama);
 *   - PROFIL_ISKLJUCI u instanci: modul ili ključ koji ovaj čvor svjesno ne vodi (npr. glas).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { KORIJEN, izlazniKod, kartaApija, primijeni, ucitajProfil, usporedi, type Kontekst, type Ploca, type Stavka } from '../scripts/profil-cvora'
import { okolinaCvora, plistUsluge, type StanjeCvora } from '../scripts/profil-cvora-stanje'

const profil = ucitajProfil(join(KORIJEN, 'profili', 'upravitelj-cvora', 'profil.json'))
const H = '/Users/regoc'
const SUSTAV = `${H}/.claude/regoc`

const inst: Record<string, string> = {
  CVOR_IME: 'macmini-pv', CVOR_DOPUSTENI_HOSTOVI: 'localhost,127.0.0.1', TG_CHAT_ID: '-1', TG_DOPUSTENI_CHATOVI: '["-1"]',
  RAZGOVOR_IME: 'Upravitelj', RAZGOVOR_DOPUSTENI_KORISNICI: '["1"]', MEMORIJA_BANKA: 'cvor_mac', ZADANI_IZVRSITELJ: 'inzenjer',
  SUSTAV_DIR: SUSTAV, KUKE_PAKETI: 'jezgra', ZNACAJKE_ISKLJUCI: '[]', ZNACAJKE_UKLJUCI: '[]',
}

function stanje(o: Partial<StanjeCvora> = {}): StanjeCvora {
  return {
    home: H, paket: `${H}/TaskManagerAI`, tmHome: `${H}/.taskmanager`, postavkeDatoteka: `${H}/.taskmanager/config/postavke.env`,
    env: { TM_HOME: `${H}/.taskmanager`, TM_PORT: '17781', TM_SUSTAV_DIR: SUSTAV, TM_MODEL_CONFIG: `${SUSTAV}/models/model-config.json` },
    envTajne: {}, envNesmije: {}, punoDopusteno: false, telegram: null, telegramTajne: {}, eposta: null,
    baza: { putanja: `${H}/.taskmanager/data/tasks.db`, postoji: true }, settings: {},
    capguard: { postoji: false, zastavice: {}, pending: [] }, settingsJson: { postoji: true, hooks: {} }, kuke: {},
    claudePrijava: true, upravitelj: { postoji: true, bajtova: 100 }, grepNema: {}, znacajke: {}, apiKljucevi: [],
    git: 'abc1234', sustav: { unitovi: {}, vrata: {}, alati: {} }, znacajkeCvor: { vrijednosti: {}, kodZna: {} }, izvorni: {},
    konzola: { starostMin: {}, dropIni: {}, poveznice: {} }, znanje: null,
    os: 'darwin', raspored: 'readme',
    plist: {
      'regoc-taskmanager': { standardOut: `${H}/.taskmanager/log/taskmanager.log`, env: { PATH: `${H}/.bun/bin:${H}/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin` } },
      'regoc-daemon': { standardOut: `${H}/.taskmanager/log/daemon.log`, env: { PATH: `${H}/.bun/bin:${H}/.local/bin:/usr/local/bin:/usr/bin:/bin` } },
      'regoc-voice': null,
    },
    ...o,
  }
}

async function kontekst(st: StanjeCvora, i: Record<string, string> = inst): Promise<Kontekst> {
  const { karta, zadano } = await kartaApija()
  return { profil, inst: i, stanje: st, karta, zadano, korijen: KORIJEN, hostname: 'mac' }
}
const nadji = (s: Stavka[], modul: string, kljuc: string) => s.find(x => x.modul === modul && x.kljuc === kljuc)

describe('okolina na README čvoru', () => {
  test('putanje kompleta koje čvor nema su PRESKOČENO bez primjene — TM_DB se nikad ne prepisuje', async () => {
    const s = usporedi(await kontekst(stanje()))
    for (const k of ['TM_DB', 'TM_AGENTS_REGISTRY', 'TM_MODULE_CONFIG', 'TM_ODLUCITELJ_CONFIG', 'TM_DEZURNI_CONFIG', 'TM_UPUTE_PO_TIPU', 'TM_FEATURES_FILE']) {
      const x = nadji(s, 'okolina', k)!
      expect(x.vrsta).toBe('PRESKOČENO')
      expect(x.primjena).toBeUndefined()
    }
    expect(nadji(s, 'okolina', 'TM_DB')!.poruka).toContain('tasks.db')
    // TM_MODEL_CONFIG je u instalacija.env (install.sh) i jednak — uspoređuje se normalno.
    expect(nadji(s, 'okolina', 'TM_MODEL_CONFIG')!.vrsta).toBe('OK')
  })

  test('vrijednost kompleta koju je čvor sam upisao, a drugačija je → UPOZORENJE, ne primjena', async () => {
    const st = stanje()
    st.env.TM_DB = `${H}/.taskmanager/data/tasks.db`
    const x = nadji(usporedi(await kontekst(st)), 'okolina', 'TM_DB')!
    expect(x.vrsta).toBe('UPOZORENJE')
    expect(x.primjena).toBeUndefined()
  })

  test('TM_RAZGOVOR_UPUTE (nije putanja kompleta) se i na README čvoru primjenjuje', async () => {
    const x = nadji(usporedi(await kontekst(stanje())), 'okolina', 'TM_RAZGOVOR_UPUTE')!
    expect(x.vrsta).toBe('RAZLIKA')
    expect(x.primjena).toEqual({ vrsta: 'env', kljuc: 'TM_RAZGOVOR_UPUTE', vrijednost: `${H}/CLAUDE.md` })
  })

  test('stari raspored (node-A) ostaje: TM_DB je RAZLIKA koju alat primjenjuje', async () => {
    const x = nadji(usporedi(await kontekst(stanje({ raspored: 'paket', os: 'linux' }))), 'okolina', 'TM_DB')!
    expect(x.vrsta).toBe('RAZLIKA')
    expect(x.primjena?.vrsta).toBe('env')
  })
})

describe('macOS: usporedba s plistom umjesto systemd drop-ina', () => {
  test('capguard je N/A (Linux, root)', async () => {
    const x = nadji(usporedi(await kontekst(stanje())), 'capguard', '(stanje)')!
    expect(x.vrsta).toBe('PRESKOČENO')
  })

  test('konzola ploče: poveznica s mjesta koje ploča čita na StandardOutPath plista', async () => {
    const s = usporedi(await kontekst(stanje()))
    expect(s.some(x => x.kljuc.endsWith('.drop-in'))).toBe(false)
    const x = nadji(s, 'konzola', 'taskwebui.launchd')!
    expect(x.vrsta).toBe('RAZLIKA')
    expect(x.primjena).toEqual({ vrsta: 'poveznica', datoteka: `${H}/.tmp/regoc_logs/taskwebui.log`, cilj: `${H}/.taskmanager/log/taskmanager.log` })
  })

  test('poveznica već pokazuje na plist → OK; obična datoteka na tom mjestu se ne dira (NEDOSTAJE)', async () => {
    const log = '${HOME}/.tmp/regoc_logs/taskwebui.log'
    const ok = stanje({ konzola: { starostMin: { [log]: 1 }, dropIni: {}, poveznice: { [log]: `${H}/.taskmanager/log/taskmanager.log` } } })
    const s = usporedi(await kontekst(ok))
    expect(nadji(s, 'konzola', 'taskwebui.launchd')!.vrsta).toBe('OK')
    expect(nadji(s, 'konzola', 'taskwebui')!.vrsta).toBe('OK')
    const obicna = stanje({ konzola: { starostMin: { [log]: 1 }, dropIni: {}, poveznice: { [log]: null } } })
    const y = nadji(usporedi(await kontekst(obicna)), 'konzola', 'taskwebui.launchd')!
    expect(y.vrsta).toBe('NEDOSTAJE')
    expect(y.primjena).toBeUndefined()
  })

  test('PATH iz plista sadrži ~/.bun/bin i ~/.local/bin → OK; bez njih NEDOSTAJE (plist piše install.sh)', async () => {
    const s = usporedi(await kontekst(stanje()))
    expect(nadji(s, 'oporavak', 'regoc-daemon.PATH')!.vrsta).toBe('OK')
    expect(nadji(s, 'oporavak', 'regoc-taskmanager.PATH')!.vrsta).toBe('OK')
    const bez = stanje()
    bez.plist!['regoc-daemon'] = { standardOut: null, env: { PATH: '/usr/bin:/bin' } }
    const x = nadji(usporedi(await kontekst(bez)), 'oporavak', 'regoc-daemon.PATH')!
    expect(x.vrsta).toBe('NEDOSTAJE')
    expect(x.primjena).toBeUndefined()
  })

  test('TZ: bez retka → RAZLIKA s primjenom TZ=UTC u postavke.env; s retkom OK', async () => {
    const s = usporedi(await kontekst(stanje()))
    const x = nadji(s, 'oporavak', 'regoc-daemon.TZ')!
    expect(x.vrsta).toBe('RAZLIKA')
    expect(x.primjena).toEqual({ vrsta: 'env', kljuc: 'TZ', vrijednost: 'UTC' })
    const st = stanje()
    st.env.TZ = 'UTC'
    expect(nadji(usporedi(await kontekst(st)), 'oporavak', 'regoc-taskmanager.TZ')!.vrsta).toBe('OK')
  })
})

describe('PROFIL_ISKLJUCI — modul ili ključ koji čvor svjesno ne vodi', () => {
  const i2 = { ...inst, PROFIL_ISKLJUCI: '["glas","memorija.globalno","memorija.agenti"]' }
  test('glas: postavke, servis i izvor konzole tog servisa → PRESKOČENO, bez primjene', async () => {
    const st = stanje({ apiKljucevi: ['razgovor.glas', 'razgovor.glasPrepoznavanje'] })
    const s = usporedi(await kontekst(st, i2))
    for (const x of s.filter(x => x.modul === 'glas')) {
      expect(x.vrsta).toBe('PRESKOČENO')
      expect(x.primjena).toBeUndefined()
    }
    expect(s.filter(x => x.modul === 'konzola' && x.kljuc.startsWith('voiceserver')).every(x => x.vrsta === 'PRESKOČENO')).toBe(true)
    expect(nadji(s, 'memorija', 'memorija.globalno')!.vrsta).toBe('PRESKOČENO')
    expect(nadji(s, 'memorija', 'memorija.razgovor')!.vrsta).not.toBe('PRESKOČENO')
  })
  test('nepoznato ime → UPOZORENJE; bez instance ništa nije isključeno', async () => {
    const s = usporedi(await kontekst(stanje(), { ...inst, PROFIL_ISKLJUCI: '["nema-ga"]' }))
    expect(s.some(x => x.vrsta === 'UPOZORENJE' && (x.poruka || '').includes('nema-ga'))).toBe(true)
    expect(nadji(usporedi(await kontekst(stanje())), 'memorija', 'memorija.globalno')!.vrsta).toBe('NEDOSTAJE')
  })
  test('paket se ne može isključiti (preduvjet)', async () => {
    const s = usporedi(await kontekst(stanje(), { ...inst, PROFIL_ISKLJUCI: '["paket"]' }))
    expect(s.filter(x => x.modul === 'paket').every(x => x.vrsta !== 'PRESKOČENO' || x.kljuc === 'izvorniSustavSadrzi')).toBe(true)
    expect(s.some(x => x.vrsta === 'UPOZORENJE' && (x.poruka || '').includes('paket'))).toBe(true)
  })
})

describe('primjena na macOS-u', () => {
  let d: string
  beforeEach(() => { d = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'pc-readme-')) })
  afterEach(() => rmSync(d, { recursive: true, force: true }))
  const ploca: Ploca = { async put() { return { status: 200, tijelo: {} } }, async post() { return { status: 200, tijelo: {} } } }

  test('poveznica konzole i jedan redak TZ za obje usluge; drugi put isto (idempotentno)', async () => {
    const home = join(d, 'h'), tm = join(home, '.taskmanager'), cilj = join(tm, 'log', 'taskmanager.log')
    mkdirSync(join(tm, 'log'), { recursive: true }); mkdirSync(join(tm, 'config'), { recursive: true })
    writeFileSync(cilj, 'ploča\n')
    writeFileSync(join(tm, 'config', 'postavke.env'), 'TM_BIND=127.0.0.1\n', { mode: 0o600 })
    const st = stanje({ home, tmHome: tm, postavkeDatoteka: join(tm, 'config', 'postavke.env') })
    st.plist!['regoc-taskmanager'] = { standardOut: cilj, env: { PATH: `${home}/.bun/bin:${home}/.local/bin:/usr/bin:/bin` } }
    const k = await kontekst(st)
    const stavke = usporedi(k).filter(x => ['konzola', 'oporavak'].includes(x.modul))
    const ishod = await primijeni(stavke, k, ploca, new Date('2026-10-24T20:00:00Z'))
    expect(ishod.greske).toEqual([])
    const log = join(home, '.tmp', 'regoc_logs', 'taskwebui.log')
    expect(lstatSync(log).isSymbolicLink()).toBe(true)
    expect(readlinkSync(log)).toBe(cilj)
    expect(readFileSync(join(tm, 'config', 'postavke.env'), 'utf-8')).toBe('TM_BIND=127.0.0.1\nTZ=UTC\n')
    expect(ishod.restart).toBe(true)
    const ponovo = await primijeni(stavke, k, ploca, new Date('2026-10-24T20:01:00Z'))
    expect(ponovo.greske).toEqual([])
    expect(readlinkSync(log)).toBe(cilj)
    expect(readFileSync(join(tm, 'config', 'postavke.env'), 'utf-8')).toBe('TM_BIND=127.0.0.1\nTZ=UTC\n')
  })
})

describe('sakupljač: README raspored i plist', () => {
  let d: string
  beforeEach(() => { d = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'pc-readme-s-')) })
  afterEach(() => rmSync(d, { recursive: true, force: true }))

  test('instalacija.env u ~/.taskmanager/config = README raspored; bez nje paket', () => {
    const home = join(d, 'h'), paket = join(home, 'TaskManagerAI')
    mkdirSync(join(paket, 'config'), { recursive: true }); mkdirSync(join(home, '.taskmanager', 'config'), { recursive: true })
    expect(okolinaCvora(paket, home).raspored).toBe('paket')
    writeFileSync(join(home, '.taskmanager', 'config', 'instalacija.env'), 'TM_PORT=17781\n')
    expect(okolinaCvora(paket, home).raspored).toBe('readme')
  })

  test('plistUsluge: samo StandardOutPath, PATH i TZ (bijela lista); nema plista → null', () => {
    const json = JSON.stringify({ Label: 'hr.regoc.taskmanager', StandardOutPath: '/x/t.log',
      EnvironmentVariables: { PATH: '/a:/b', HOME: '/U', TAJNO: 'ne-smije-van' } })
    const p = plistUsluge('regoc-taskmanager', argv => (argv.includes('/Library/LaunchDaemons/hr.regoc.taskmanager.plist') ? json : null))
    expect(p).toEqual({ standardOut: '/x/t.log', env: { PATH: '/a:/b' } })
    expect(JSON.stringify(p)).not.toContain('ne-smije-van')
    expect(plistUsluge('regoc-voice', () => null)).toBeNull()
  })
})

describe('profil = glavni sustav', () => {
  test('autoResume je ugašen (Goran, TASK-3085, 22.10.2026.) — profil ga ne pali', () => {
    expect(profil.moduli.znacajke!.kljucevi.autoResume.on).toBe(false)
  })
  test('PROFIL_ISKLJUCI je neobavezna varijabla instance', () => {
    expect(profil.instanca.neobavezno).toContain('PROFIL_ISKLJUCI')
  })
})

test('izlazniKod: samo ČOVJEK → 2', () => {
  expect(izlazniKod([{ modul: 'okolina', kljuc: 'TM_RAZGOVOR_PUNO', vrsta: 'ČOVJEK' }, { modul: 'x', kljuc: 'y', vrsta: 'PRESKOČENO' }])).toBe(2)
})
