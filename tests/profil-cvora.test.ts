// TASK-5297 — alat profila čvora `scripts/profil-cvora.ts`, mjerila J1–J12 iz ADR-0004 §10.
// Bez mreže i bez pravog modela: čvor-dvojnik je privremena mapa (paket, HOME, baza, capguard
// stanje), a „ploča" su prave funkcije paketa (`razgovorPut`, `zatraziSposobnost`) nad bazom
// dvojnika — ista validacija i isti `settings_history` kao kroz HTTP.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createHash } from 'crypto'
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { zatraziSposobnost } from '../src/Capguard'
import { razgovorPut } from '../src/razgovor/RazgovorPloca'
import { ensureSettingsSchema } from '../src/core/ConcurrencySetting'
import {
  GreskaPreduvjeta, KOD, KORIJEN, glavna, izvediInstancu, konzolaDropIn, paketiKuka, provjeriVarijable, specZaProfil, vrijemeDropIn,
  ucinakZnacajki, ucitajProfil, zamijeni, type Ploca,
} from '../scripts/profil-cvora'
import { prikupiStanje } from '../scripts/profil-cvora-stanje'

const PROFIL = join(KORIJEN, 'profili', 'upravitelj-cvora', 'profil.json')
// Kanarinci: vrijednosti tajni koje se NIKAD ne smiju pojaviti u izlazu (J4).
const KAN = {
  tgToken: 'KANARINAC-TG-123456:AAA',
  kanal: 'KANARINAC-KANAL-feedbeef',
  botTokenJson: 'KANARINAC-BOTTOKEN-JSON',
  prijava: 'KANARINAC-PRIJAVA',
  nesto: 'KANARINAC-NESTO-TAJNO',
}

interface Dvojnik {
  root: string; home: string; paket: string; tmHome: string; sustav: string
  db: string; stanjeCap: string; inst: string; postavke: string
  pokreni(argv: string[], o?: { puno?: boolean }): Promise<{ kod: number; izlaz: string }>
  history(): number
}

let d: Dvojnik

function dvojnik(opcije: { bezZnacajke?: boolean; bezKodaZa?: string[] } = {}): Dvojnik {
  const root = mkdtempSync(join(tmpdir(), 'tmai-profil-'))
  const home = join(root, 'home')
  const paket = join(home, 'TaskManagerAI')
  const tmHome = join(home, '.taskmanager')
  const sustav = join(root, 'sustav')
  for (const m of [join(paket, 'config'), join(paket, 'src', 'razgovor'), join(tmHome, 'config'), join(sustav, 'data'),
    join(home, '.claude', 'hooks')]) mkdirSync(m, { recursive: true })

  // Kod paketa na čvoru: značajke iz profila + prava datoteka postavki (iz nje se vidi API).
  const profil = JSON.parse(readFileSync(PROFIL, 'utf-8'))
  for (const z of profil.moduli.paket.paketSadrzi) {
    if (opcije.bezZnacajke && z.grep && z.grep[1] === 'od-bota') continue
    if (z.datoteka) { mkdirSync(join(paket, z.datoteka, '..'), { recursive: true }); writeFileSync(join(paket, z.datoteka), '// x\n') }
  }
  copyFileSync(join(KORIJEN, 'src/razgovor/RazgovorPostavke.ts'), join(paket, 'src/razgovor/RazgovorPostavke.ts'))
  writeFileSync(join(paket, 'src/razgovor/RazgovorPostavke.ts'),
    readFileSync(join(paket, 'src/razgovor/RazgovorPostavke.ts'), 'utf-8') + '\n// glasPrepoznavanje\n')
  writeFileSync(join(paket, 'src/TaskWebUI.ts'), opcije.bezZnacajke ? '// stara ploča\n' : "// '/api/razgovor/od-bota'\n")

  const db = join(sustav, 'data', 'regoc.db')
  const b = new Database(db)
  ensureSettingsSchema(b)
  b.exec(`CREATE TABLE capability_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
    desired INTEGER NOT NULL, requested_by TEXT, status TEXT NOT NULL DEFAULT 'pending', approved_by TEXT,
    note TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE capability_catalog (name TEXT PRIMARY KEY, tier INTEGER, requires_admin INTEGER,
    default_on INTEGER, action TEXT, description TEXT);`)
  for (const [ime, tier] of [['plan_mode', 1], ['allow_spawn', 1], ['allow_messaging', 1], ['allow_fs_write', 1],
    ['allow_lan', 2], ['allow_internet', 2], ['allow_root', 2], ['allow_mesh', 2]] as const) {
    b.query('INSERT INTO capability_catalog VALUES (?,?,0,0,?,?)').run(ime, tier, 'flag', ime)
  }
  b.close()

  const stanjeCap = join(root, 'capabilities.state')
  writeFileSync(stanjeCap, JSON.stringify({ capabilities: {
    plan_mode: { on: true, tier: 1 }, allow_spawn: { on: true, tier: 1 }, allow_messaging: { on: false, tier: 1 },
    allow_fs_write: { on: false, tier: 1 }, allow_lan: { on: true, tier: 2 }, allow_internet: { on: true, tier: 2 },
    allow_root: { on: false, tier: 2 }, allow_mesh: { on: false, tier: 2 },
  } }))

  const cred = join(tmHome, 'config', 'credentials.env')
  writeFileSync(cred, `TELEGRAM_BOT_TOKEN=${KAN.tgToken}\n`, { mode: 0o600 })
  const postavke = join(paket, 'config', 'postavke.env')
  writeFileSync(postavke, [
    '# postavke dvojnika', 'TM_PORT=17781', `TM_HOME=${tmHome}`, `TM_DB=${db}`, `TM_CAPGUARD_STATE=${stanjeCap}`,
    `TM_CREDENTIALS=${cred}`, `TM_BOT_KANAL_TOKEN=${KAN.kanal}`, `TM_NESTO_TAJNO=${KAN.nesto}`, 'TM_CHROMA_HOST=rag.example', '',
  ].join('\n'), { mode: 0o600 })
  writeFileSync(join(paket, 'config', 'telegram.json'), JSON.stringify({ botToken: KAN.botTokenJson, ukljucen: false, tudjePolje: 1 }), { mode: 0o600 })

  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({
    model: 'tudi-kljuc', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'tudja-kuka' }] }] },
  }, null, 2))
  writeFileSync(join(home, '.claude', 'hooks', 'SecurityValidator.hook.ts'), '// kuka\n')
  writeFileSync(join(home, '.claude', '.credentials.json'), JSON.stringify({ t: KAN.prijava }))
  writeFileSync(join(sustav, 'REGOC_AGENTS.json'), JSON.stringify({ agents: { inzenjer: {}, istrazivac: {} } }))
  writeFileSync(join(sustav, 'RegocDaemon.ts'), '// bez tuđeg doma\nconst prepusteni = await oporaviSirocad(db, tracked)\n')
  // Kod izvornog sustava „zna" svaki prekidač profila (doslovno 'ime'), osim onih iz bezKodaZa (J14).
  const kljucevi = Object.keys(profil.moduli.znacajke.kljucevi).filter(k => !(opcije.bezKodaZa || []).includes(k))
  writeFileSync(join(sustav, 'Prekidaci.ts'), kljucevi.map(k => `isEnabled('${k}')`).join('\n') + '\n')
  for (const f of profil.moduli.paket.izvorniSustavSadrzi.datoteke) {
    mkdirSync(dirname(join(sustav, f)), { recursive: true })
    writeFileSync(join(sustav, f), '// x\n')
  }
  writeFileSync(join(sustav, 'AgentRouting.ts'), '// TASK-255 anti-kaskada\n')
  writeFileSync(join(sustav, 'features.json'), JSON.stringify({
    staleReaper: { enabled: true, since: '2026-08-01', note: 'čvor: agresivnije od glavnog' },
    tudjiPrekidac: { enabled: true, note: 'nije u profilu — ostaje' },
  }, null, 2) + '\n')
  // Kuke paketa (TM_PAKET) i izvornog sustava (HOME) — datoteke postoje, kuke nisu spojene.
  mkdirSync(join(paket, 'hooks'), { recursive: true })
  mkdirSync(join(paket, 'tools'), { recursive: true })
  for (const f of ['hooks/TaskInstructionsInject.hook.ts', 'hooks/RegocConsoleLog.hook.ts', 'tools/session_usage.py']) writeFileSync(join(paket, f), '// x\n')
  for (const h of profil.moduli.kuke.popis) {
    if (h.paket === 'pai-ucenje') writeFileSync(join(home, '.claude', 'hooks', `${h.ime}.hook.ts`), '// pai\n')
  }

  const inst = join(tmHome, 'config', 'profil.instanca.env')
  writeFileSync(inst, [
    'CVOR_IME=cvor-t', 'CVOR_DOPUSTENI_HOSTOVI=10.0.0.9,cvor-t', 'TG_CHAT_ID=-1001234567890',
    'TG_DOPUSTENI_CHATOVI=["-1001234567890"]', 'RAZGOVOR_IME=Upravitelj', 'RAZGOVOR_DOPUSTENI_KORISNICI=["100000001","vlasnik"]',
    'MEMORIJA_BANKA=banka_t', 'ZADANI_IZVRSITELJ=inzenjer', 'RAZGOVOR_PRESKOCI_AKO_SADRZI=["@drugi_bot"]',
    'RAZGOVOR_RADNI_DIR=', 'BOTKANAL_ADRESE=', 'BOTKANAL_CHATOVI=[]', 'BOTKANAL_DRUGI=[]', 'BOTKANAL_STOP_KORISNICI=[]',
    `SUSTAV_DIR=${sustav}`, '# dom kojeg na čvoru ne smije biti', 'TUDI_HOME=/nepostojeci/dom',
    `SECURITYVALIDATOR_SHA256=${createHash('sha256').update('// kuka\n').digest('hex')}`, '',
  ].join('\n'))

  const ploca = (puno: boolean): Ploca => ({
    async put(ruta, tijelo) {
      expect(ruta).toBe('/api/config/razgovor')
      const prije = process.env.TM_RAZGOVOR_PUNO
      // Okolina PLOČE: `puno` otključava samo redak koji je čovjek upisao (TM_RAZGOVOR_PUNO=1).
      if (puno) process.env.TM_RAZGOVOR_PUNO = '1'; else delete process.env.TM_RAZGOVOR_PUNO
      try { const r = razgovorPut(db, tijelo); return { status: r.status, tijelo: r.tijelo } }
      finally { if (prije === undefined) delete process.env.TM_RAZGOVOR_PUNO; else process.env.TM_RAZGOVOR_PUNO = prije }
    },
    async post(ruta, tijelo) {
      expect(ruta).toBe('/api/capabilities/request')
      const x = new Database(db)
      try { const r = zatraziSposobnost(x, tijelo as any, { TM_CAPGUARD_STATE: stanjeCap }); return { status: r.status, tijelo: r.body } }
      finally { x.close() }
    },
  })

  return {
    root, home, paket, tmHome, sustav, db, stanjeCap, inst, postavke,
    async pokreni(argv, o = {}) {
      const redovi: string[] = []
      const kod = await glavna([...argv, '--paket', paket, '--instanca', inst, '--bez-sustava'], {
        home, ispis: r => redovi.push(r), ploca: ploca(!!o.puno), hostname: 'cvor-t',
        sat: () => new Date('2026-10-07T01:00:00Z'),
      })
      return { kod, izlaz: redovi.join('\n') }
    },
    history() {
      const x = new Database(db, { readonly: true })
      try { return (x.query('SELECT count(*) n FROM settings_history').get() as any).n } finally { x.close() }
    },
  }
}

/** Otisak svih datoteka dvojnika (putanja + sha256 + prava). */
function otisak(korijen: string): string {
  const h = createHash('sha256')
  const hodaj = (m: string) => {
    for (const ime of readdirSync(m).sort()) {
      const p = join(m, ime)
      const st = statSync(p)
      if (st.isDirectory()) hodaj(p)
      else h.update(`${p}:${(st.mode & 0o777).toString(8)}:`).update(readFileSync(p))
    }
  }
  hodaj(korijen)
  return h.digest('hex')
}

function settingsVrijednost(db: string, kljuc: string): string | null {
  const x = new Database(db, { readonly: true })
  try { return (x.query('SELECT value FROM settings WHERE key = ?').get(kljuc) as any)?.value ?? null } finally { x.close() }
}

beforeEach(() => { d = dvojnik() })
afterEach(() => { rmSync(d.root, { recursive: true, force: true }) })

describe('J1 — shema profila (zod)', () => {
  test('predani profil upravitelj-cvora prolazi shemu', () => {
    const p = ucitajProfil(PROFIL)
    expect(p.profil).toBe('upravitelj-cvora')
    // 13 iz TASK-5295 + znacajke, kuke, konzola, oporavak (ADR-0004 §13.2)
    expect(Object.keys(p.moduli).length).toBe(17)
  })

  test('neispravan profil → izlaz 3 s porukom koja imenuje polje', async () => {
    const los = JSON.parse(readFileSync(PROFIL, 'utf-8'))
    los.moduli.capguard.zeljeno.allow_root = 'da'
    const put = join(d.root, 'los.json')
    writeFileSync(put, JSON.stringify(los))
    const r = await d.pokreni(['provjeri', '--profil', put])
    expect(r.kod).toBe(KOD.PREDUVJET)
    expect(r.izlaz).toContain('moduli.capguard.zeljeno.allow_root')
  })

  test('nepoznat modul → izlaz 3, imenovan', async () => {
    const los = JSON.parse(readFileSync(PROFIL, 'utf-8'))
    los.moduli.izmisljeni = { vlasnik: 'paket' }
    const put = join(d.root, 'los2.json')
    writeFileSync(put, JSON.stringify(los))
    const r = await d.pokreni(['provjeri', '--profil', put])
    expect(r.kod).toBe(3)
    expect(r.izlaz).toMatch(/izmisljeni/)
  })
})

describe('J2 — supstitucija ${IME} i ${IME:json}', () => {
  test('niz, složeni niz i JSON popis', () => {
    const inst = { A: 'x', L: '["1","2"]', H: '/dom' }
    expect(zamijeni('${A}', inst)).toBe('x')
    expect(zamijeni('${H}/CLAUDE.md', inst)).toBe('/dom/CLAUDE.md')
    expect(zamijeni('${L:json}', inst)).toEqual(['1', '2'])
    expect(zamijeni({ a: ['${A}', 3] }, inst)).toEqual({ a: ['x', 3] })
    expect(zamijeni('${PRAZNO:json}', inst)).toEqual([])
  })

  test('neispravan JSON u instanci → GreskaPreduvjeta', () => {
    expect(() => zamijeni('${L:json}', { L: 'nije-json' })).toThrow(GreskaPreduvjeta)
  })

  test('nedostaje obavezna varijabla instance → izlaz 3', async () => {
    writeFileSync(d.inst, readFileSync(d.inst, 'utf-8').replace(/^MEMORIJA_BANKA=.*$/m, 'MEMORIJA_BANKA='))
    const r = await d.pokreni(['provjeri'])
    expect(r.kod).toBe(3)
    expect(r.izlaz).toContain('MEMORIJA_BANKA')
  })

  test('nepoznata varijabla u profilu → izlaz 3', async () => {
    const p = JSON.parse(readFileSync(PROFIL, 'utf-8'))
    p.moduli.razgovor.settings['razgovor.ime'] = '${NEPOSTOJECA}'
    const put = join(d.root, 'p.json')
    writeFileSync(put, JSON.stringify(p))
    const r = await d.pokreni(['provjeri', '--profil', put])
    expect(r.kod).toBe(3)
    expect(r.izlaz).toContain('${NEPOSTOJECA}')
    expect(() => provjeriVarijable(ucitajProfil(PROFIL), {})).toThrow(/obavezna/)
  })
})

describe('J3 — izvoz po bijeloj listi', () => {
  test('nepoznati ključ postavke.env i botToken iz JSON-a ne izlaze', async () => {
    const van = join(d.root, 'izvezeno.env')
    const r = await d.pokreni(['izvezi', '--instanca-van', van])
    const rj = await d.pokreni(['izvezi', '--instanca-van', van, '--json'])
    const sve = r.izlaz + rj.izlaz + readFileSync(van, 'utf-8')
    expect(sve).not.toContain('TM_NESTO_TAJNO')
    expect(sve).not.toContain(KAN.nesto)
    expect(sve).not.toContain('botToken"')
    expect(sve).not.toContain(KAN.botTokenJson)
    expect(sve).not.toContain('tudjePolje')
    // ni sakupljač (ono što bi preko SSH-a prešlo žicu) ih ne vraća
    const p = ucitajProfil(PROFIL)
    const st = JSON.stringify(await prikupiStanje(specZaProfil(p, {}, d.paket, false), d.home))
    for (const x of ['TM_NESTO_TAJNO', KAN.nesto, KAN.botTokenJson, 'tudjePolje', KAN.tgToken, KAN.kanal, KAN.prijava]) expect(st).not.toContain(x)
  })
})

describe('J4 — tajna se nikad ne ispisuje', () => {
  test('provjeri, --json, --suho, --pisi i izvezi ne sadrže kanarince', async () => {
    const izlazi: string[] = []
    for (const argv of [['provjeri'], ['provjeri', '--json'], ['primijeni', '--suho'], ['primijeni', '--suho', '--json'],
      ['primijeni', '--pisi'], ['primijeni', '--pisi', '--json'], ['izvezi', '--instanca-van', join(d.root, 'v.env')]]) {
      izlazi.push((await d.pokreni(argv)).izlaz)
    }
    izlazi.push(readFileSync(join(d.root, 'v.env'), 'utf-8'))
    const sve = izlazi.join('\n')
    for (const k of Object.values(KAN)) expect(sve).not.toContain(k)
    expect(sve).toContain('TAJNA postoji TELEGRAM_BOT_TOKEN')
    expect(sve).toContain('TAJNA postoji TM_CREDENTIALS')
  })
})

describe('J5 — provjeri i --suho ne mijenjaju ništa', () => {
  test('otisak datoteka i broj redaka settings_history prije = poslije', async () => {
    const prije = otisak(d.root)
    const h0 = d.history()
    const r1 = await d.pokreni(['provjeri'])
    const r2 = await d.pokreni(['primijeni', '--suho'])
    const r3 = await d.pokreni(['primijeni'])          // --suho je zadano
    expect([r1.kod, r2.kod, r3.kod]).toEqual([1, 1, 1])
    expect(r3.izlaz).toContain('SUHO')
    expect(otisak(d.root)).toBe(prije)
    expect(d.history()).toBe(h0)
  })
})

describe('J6 — idempotentno', () => {
  test('drugi --pisi zaredom: 0 promjena, settings_history ne raste; autor profil-cvora', async () => {
    const r1 = await d.pokreni(['primijeni', '--pisi'])
    expect(r1.izlaz).toMatch(/PRIMIJENJENO: [1-9]\d* promjena/)
    expect(r1.izlaz).toContain('potreban restart regoc-taskmanager: da')
    const h1 = d.history()
    expect(h1).toBeGreaterThan(0)
    const r2 = await d.pokreni(['primijeni', '--pisi'])
    expect(r2.izlaz).toContain('PRIMIJENJENO: 0 promjena')
    expect(r2.izlaz).toContain('potreban restart regoc-taskmanager: ne')
    expect(d.history()).toBe(h1)
    const x = new Database(d.db, { readonly: true })
    const autori = x.query('SELECT DISTINCT changed_by FROM settings_history').all() as any[]
    x.close()
    expect(autori.map(a => a.changed_by)).toEqual(['profil-cvora'])
    // ostaje samo ono što alat ne smije: ljudske stavke, kod/izvorni sustav → izlaz 2
    expect(r2.kod).toBe(KOD.LJUDI)
    expect(r2.izlaz).not.toMatch(/^\s+RAZLIKA/m)
  })

  test('postavke.env: dopisani su samo retci s bijele liste, tajni retci netaknuti, prava 0600, kopija prije', async () => {
    await d.pokreni(['primijeni', '--pisi'])
    const env = readFileSync(d.postavke, 'utf-8')
    expect(env).toContain(`TM_BOT_KANAL_TOKEN=${KAN.kanal}`)
    expect(env).toContain(`TM_NESTO_TAJNO=${KAN.nesto}`)
    expect(env).toContain('TM_ALLOWED_HOSTS=10.0.0.9,cvor-t')
    expect(env).toContain('# profil-cvora: TM_CHROMA_HOST=rag.example')
    expect(statSync(d.postavke).mode & 0o777).toBe(0o600)
    const tg = JSON.parse(readFileSync(join(d.paket, 'config', 'telegram.json'), 'utf-8'))
    expect(tg.botToken).toBe(KAN.botTokenJson)       // tajna ostaje na mjestu, alat je ne piše
    expect(tg.stil).toBe('kratko')
    const kopije = readdirSync(join(d.tmHome, 'backup'))
    expect(kopije.length).toBe(1)
    expect(readdirSync(join(d.tmHome, 'backup', kopije[0])).sort()).toEqual(['features.json', 'postavke.env', 'settings.json', 'telegram.json'])
  })
})

describe('J7 — ovlasti=puno samo uz čovjekov TM_RAZGOVOR_PUNO=1', () => {
  test('bez retka → upisano citanje + upozorenje', async () => {
    const r = await d.pokreni(['primijeni', '--pisi'])
    // nepostojeći ključ već vrijedi `citanje` (zadano paketa), pa ga alat ne mora ni pisati
    expect(settingsVrijednost(d.db, 'razgovor.ovlasti') ?? 'citanje').toBe('citanje')
    expect(r.izlaz).toContain('UPOZORENJE razgovor.ovlasti')
    expect(r.izlaz).toContain('ČOVJEK TM_RAZGOVOR_PUNO')
    expect(readFileSync(d.postavke, 'utf-8')).not.toContain('TM_RAZGOVOR_PUNO')   // alat ga nikad ne piše
  })

  test('zatečeni puno bez retka → alat ga spušta na citanje (kroz API, s poviješću)', async () => {
    const x = new Database(d.db)
    x.query("INSERT INTO settings(key, value) VALUES ('razgovor.ovlasti', 'puno')").run()
    x.close()
    const r = await d.pokreni(['primijeni', '--pisi'])
    expect(settingsVrijednost(d.db, 'razgovor.ovlasti')).toBe('citanje')
    expect(r.izlaz).toContain('UPOZORENJE razgovor.ovlasti')
  })

  test('s retkom koji je upisao čovjek → puno', async () => {
    writeFileSync(d.postavke, readFileSync(d.postavke, 'utf-8') + 'TM_RAZGOVOR_PUNO=1\n')
    const r = await d.pokreni(['primijeni', '--pisi'], { puno: true })
    expect(settingsVrijednost(d.db, 'razgovor.ovlasti')).toBe('puno')
    expect(r.izlaz).not.toContain('ČOVJEK TM_RAZGOVOR_PUNO')
  })
})

describe('J8 — capguard: samo zahtjev pending', () => {
  test('razlika → pending u capability_requests, nikad approved/applied; ponovni --pisi ne dodaje', async () => {
    const r = await d.pokreni(['primijeni', '--pisi'])
    const x = new Database(d.db, { readonly: true })
    const redovi = x.query('SELECT name, desired, status, approved_by FROM capability_requests ORDER BY name').all() as any[]
    x.close()
    expect(redovi.map(z => z.name)).toEqual(['allow_messaging', 'allow_root'])
    expect(redovi.every(z => z.status === 'pending' && z.approved_by === null && z.desired === 1)).toBe(true)
    expect(r.izlaz).toContain('ČOVJEK allow_root — zahtjev čeka odobrenje')
    // capguard stanje alat ne dira
    expect(JSON.parse(readFileSync(d.stanjeCap, 'utf-8')).capabilities.allow_root.on).toBe(false)
    await d.pokreni(['primijeni', '--pisi'])
    const y = new Database(d.db, { readonly: true })
    expect((y.query('SELECT count(*) n FROM capability_requests').get() as any).n).toBe(2)
    y.close()
  })
})

describe('J9 — settings.json: spoj hooks, tuđe ostaje, kopija prije', () => {
  test('tuđi ključ i tuđa kuka ostaju, dodaju se samo kuke profila', async () => {
    const prije = readFileSync(join(d.home, '.claude', 'settings.json'), 'utf-8')
    await d.pokreni(['primijeni', '--pisi', '--modul', 'kuke'])
    const j = JSON.parse(readFileSync(join(d.home, '.claude', 'settings.json'), 'utf-8'))
    expect(j.model).toBe('tudi-kljuc')
    expect(j.hooks.Stop[0].hooks[0].command).toBe('tudja-kuka')
    expect(j.hooks.PreToolUse[0].hooks[0].command).toBe(`${d.home}/.bun/bin/bun run ${d.home}/.claude/hooks/SecurityValidator.hook.ts`)
    // jezgra: SecurityValidator + session_usage --hook prompt
    expect(j.hooks.UserPromptSubmit.length).toBe(2)
    const kop = readdirSync(join(d.tmHome, 'backup'))
    expect(readFileSync(join(d.tmHome, 'backup', kop[0], 'settings.json'), 'utf-8')).toBe(prije)
    // --modul claude: ništa izvan modula nije dirano
    expect(existsSync(join(d.tmHome, 'backup', kop[0], 'postavke.env'))).toBe(false)
    expect(d.history()).toBe(0)
  })
})

describe('J10 — izvoz s čvora → isti profil, 0 razlika (dvojnik; živi node-A: docs/qa/TASK-5297)', () => {
  test('nakon primjene izvoz daje istu instancu i nijednu razliku', async () => {
    writeFileSync(d.postavke, readFileSync(d.postavke, 'utf-8') + 'TM_RAZGOVOR_PUNO=1\n')
    await d.pokreni(['primijeni', '--pisi'], { puno: true })
    const van = join(d.root, 'izvezeno.env')
    const r = await d.pokreni(['izvezi', '--instanca-van', van])
    expect(r.izlaz).toContain('RAZLIKA 0')
    const citaj = (p: string) => Object.fromEntries(readFileSync(p, 'utf-8').split('\n')
      .filter(x => x && !x.startsWith('#') && x.includes('=')).map(x => [x.slice(0, x.indexOf('=')), x.slice(x.indexOf('=') + 1)]))
    const izv = citaj(van), ref = citaj(d.inst)
    // Iz čvora se ne vide: ime čvora (samo u CLAUDE.md) i tuđi HOME (mora ga NE biti).
    for (const k of Object.keys(ref).filter(k => !['CVOR_IME', 'TUDI_HOME'].includes(k))) {
      expect(`${k}=${izv[k]}`).toBe(`${k}=${ref[k]}`)
    }
  })

  test('izvediInstancu: složeni predložak daje varijablu (SUSTAV_DIR iz TM_DB)', async () => {
    const p = ucitajProfil(PROFIL)
    const st = await prikupiStanje(specZaProfil(p, {}, d.paket, false), d.home)
    expect(izvediInstancu(p, st).inst.SUSTAV_DIR).toBe(d.sustav)
  })
})

describe('J11 — CLAUDE.md.predlozak', () => {
  const PRED = join(KORIJEN, 'profili', 'upravitelj-cvora', 'CLAUDE.md.predlozak')

  test('predložak postoji, ima {{…}} mjesta i primjena piše ~/CLAUDE.md bez praznih mjesta', async () => {
    const t = readFileSync(PRED, 'utf-8')
    expect(t).toContain('{{CVOR_IME}}')
    expect(t).toContain('{{MEMORIJA_BANKA}}')
    await d.pokreni(['primijeni', '--pisi', '--modul', 'upravitelj'])
    const out = readFileSync(join(d.home, 'CLAUDE.md'), 'utf-8')
    expect(out).not.toMatch(/\{\{\w+\}\}/)
    expect(out).toContain('# cvor-t — vodič')
    expect(out).toContain('banka_t')
    expect(out).toContain('inzenjer, istrazivac')
    expect(out.length).toBeLessThanOrEqual(16000)
    expect(statSync(join(d.home, 'CLAUDE.md')).mode & 0o777).toBe(0o600)
  })

  test('postojeći ~/CLAUDE.md se ne prepisuje', async () => {
    writeFileSync(join(d.home, 'CLAUDE.md'), 'ručno\n')
    await d.pokreni(['primijeni', '--pisi', '--modul', 'upravitelj'])
    expect(readFileSync(join(d.home, 'CLAUDE.md'), 'utf-8')).toBe('ručno\n')
  })

  test('nepoznato mjesto u predlošku → izlaz 3', async () => {
    const p = JSON.parse(readFileSync(PROFIL, 'utf-8'))
    const los = join(d.root, 'los.predlozak')
    writeFileSync(los, '# {{NEPOZNATO}}\n')
    p.moduli.upravitelj.predlozak = los
    const put = join(d.root, 'p.json')
    writeFileSync(put, JSON.stringify(p))
    const r = await d.pokreni(['provjeri', '--profil', put])
    expect(r.kod).toBe(3)
    expect(r.izlaz).toContain('{{NEPOZNATO}}')
  })
})

describe('J12 — docs/INSTALL.md: „Novi čvor iz profila"', () => {
  test('odjeljak postoji i nosi korake ADR-0004 §6', () => {
    const t = readFileSync(join(KORIJEN, 'docs', 'INSTALL.md'), 'utf-8')
    const i = t.indexOf('Novi čvor iz profila')
    expect(i).toBeGreaterThan(0)
    const o = t.slice(i, i + 6000)
    for (const x of ['tm-cvor-azuriraj.sh', 'profil.instanca.env', 'profil-cvora.ts provjeri', 'PROFIL_CVORA_TAJNE.md',
      'primijeni --suho', 'primijeni --pisi', '0 promjena', 'ADR-0004']) expect(o).toContain(x)
  })
})

describe('preduvjet P1 i odbijanja (izlazi 3 i 4)', () => {
  test('kod čvora bez značajke → izlaz 3, a --pisi ne piše ništa', async () => {
    rmSync(d.root, { recursive: true, force: true })
    d = dvojnik({ bezZnacajke: true })
    const prije = otisak(d.root)
    const r = await d.pokreni(['provjeri'])
    expect(r.kod).toBe(KOD.PREDUVJET)
    expect(r.izlaz).toContain('PREDUVJET kanal bot↔bot')
    const w = await d.pokreni(['primijeni', '--pisi'])
    expect(w.kod).toBe(KOD.PREDUVJET)
    expect(w.izlaz).toContain('ništa nije zapisano')
    expect(otisak(d.root)).toBe(prije)
  })

  test('ovaj paket (bez isporuke TASK-5290+5294) prijavljuje izlaz 3', async () => {
    const st = await prikupiStanje(specZaProfil(ucitajProfil(PROFIL), {}, KORIJEN, false), d.home)
    const nema = Object.entries(st.znacajke).filter(([, v]) => !v).map(([k]) => k)
    // Kad isporuka uđe u main, ovaj popis postaje prazan — tada test treba obrnuti (P1 ispunjen).
    if (nema.length) expect(nema.join(',')).toMatch(/bot↔bot|glas/)
  })

  test('izlaz 4: --suho i --pisi zajedno, --pisi preko --ssh, nepoznata naredba', async () => {
    expect((await d.pokreni(['primijeni', '--suho', '--pisi'])).kod).toBe(KOD.ODBIJENO)
    expect((await d.pokreni(['primijeni', '--pisi', '--ssh', 'netko@cvor'])).kod).toBe(KOD.ODBIJENO)
    expect((await d.pokreni(['obrisi'])).kod).toBe(KOD.ODBIJENO)
    expect((await d.pokreni(['izvezi'])).kod).toBe(KOD.ODBIJENO)
  })
})

// ─── ADR-0004 §13.6: paritet s glavnim (TASK-5308) ───────────────────────────

/** Dopiše retke u instancu dvojnika (ZNACAJKE_*, KUKE_PAKETI). */
function instanca(retci: string[]): void {
  writeFileSync(d.inst, readFileSync(d.inst, 'utf-8') + retci.join('\n') + '\n')
}
const features = () => JSON.parse(readFileSync(join(d.sustav, 'features.json'), 'utf-8'))
const settingsJson = () => JSON.parse(readFileSync(join(d.home, '.claude', 'settings.json'), 'utf-8'))

describe('J13 — modul znacajke: samo `enabled` imenovanih ključeva, idempotentno, bez restarta', () => {
  test('profil = glavni: 53 ON; note/since i tuđi ključ ostaju; drugi --pisi → 0 promjena', async () => {
    const r = await d.pokreni(['primijeni', '--pisi', '--modul', 'znacajke'])
    expect(r.izlaz).toContain('potreban restart regoc-taskmanager: ne')
    const f = features()
    const p = ucitajProfil(PROFIL).moduli.znacajke!
    for (const [k, z] of Object.entries(p.kljucevi)) expect(f[k]?.enabled === true).toBe(z.on)
    expect(Object.values(p.kljucevi).filter(z => z.on).length).toBe(53)
    expect(f.staleReaper).toEqual({ enabled: false, since: '2026-08-01', note: 'čvor: agresivnije od glavnog' })
    expect(f.tudjiPrekidac).toEqual({ enabled: true, note: 'nije u profilu — ostaje' })
    expect(f.userFlush.note).toContain('profil-cvora')
    const prije = readFileSync(join(d.sustav, 'features.json'), 'utf-8')
    const r2 = await d.pokreni(['primijeni', '--pisi', '--modul', 'znacajke'])
    expect(r2.izlaz).toContain('PRIMIJENJENO: 0 promjena')
    expect(readFileSync(join(d.sustav, 'features.json'), 'utf-8')).toBe(prije)
    expect(r2.kod).toBe(KOD.OK)
  })

  test('instanca: ISKLJUCI smije sve, UKLJUCI samo „uvjetno" (van ostaje off uz upozorenje)', async () => {
    instanca(['ZNACAJKE_ISKLJUCI=["staleWatchdogLive","siroceOporavak"]', 'ZNACAJKE_UKLJUCI=["projectGitInit","teamChainLive"]'])
    const r = await d.pokreni(['primijeni', '--pisi', '--modul', 'znacajke'])
    const f = features()
    expect(f.staleWatchdogLive?.enabled ?? false).toBe(false)     // ključa nema = isEnabled false, ne piše se
    expect(f.siroceOporavak?.enabled ?? false).toBe(false)
    expect(f.projectGitInit.enabled).toBe(true)
    expect(f.teamChainLive?.enabled ?? false).toBe(false)
    expect(r.izlaz).toContain('teamChainLive je „van"')
  })

  test('ucinakZnacajki: isključenje pobjeđuje uključenje', () => {
    const p = ucitajProfil(PROFIL)
    const { ucinak } = ucinakZnacajki(p, { ZNACAJKE_UKLJUCI: '["projectGitInit"]', ZNACAJKE_ISKLJUCI: '["projectGitInit"]' })
    expect(ucinak.projectGitInit).toBe(false)
  })
})

describe('J14 — prekidač ON bez koda na čvoru → izlaz 3 s imenom', () => {
  test('kod ne zna siroceOporavak → PREDUVJET, --pisi ništa ne piše; odgoda u instanci ga skida', async () => {
    rmSync(d.root, { recursive: true, force: true })
    d = dvojnik({ bezKodaZa: ['siroceOporavak'] })
    const r = await d.pokreni(['provjeri', '--modul', 'znacajke'])
    expect(r.kod).toBe(KOD.PREDUVJET)
    expect(r.izlaz).toContain('PREDUVJET siroceOporavak')
    const prije = otisak(d.root)
    expect((await d.pokreni(['primijeni', '--pisi'])).kod).toBe(KOD.PREDUVJET)
    expect(otisak(d.root)).toBe(prije)
    instanca(['ZNACAJKE_ISKLJUCI=["siroceOporavak"]'])
    expect((await d.pokreni(['provjeri', '--modul', 'znacajke'])).kod).toBe(KOD.RAZLIKA)
  })

  test('izvorniSustavSadrzi: nedostaje modul ili oznaka TASK-255 → NEDOSTAJE (ne blokira --pisi)', async () => {
    rmSync(join(d.sustav, 'OrphanRecovery.ts'))
    writeFileSync(join(d.sustav, 'AgentRouting.ts'), '// stari\n')
    const r = await d.pokreni(['provjeri', '--modul', 'paket'])
    expect(r.izlaz).toContain('NEDOSTAJE izvorni.OrphanRecovery.ts')
    expect(r.izlaz).toContain('NEDOSTAJE anti-kaskada regoc-chain (TASK-255)')
  })

  // TASK-5308: modul bez ožičenja u daemonu je lažni paritet — prekidač je ON, a nitko ga ne zove.
  test('siroče-oporavak: OrphanRecovery.ts bez poziva u RegocDaemonu i bez postavki → NEDOSTAJE', async () => {
    rmSync(join(d.sustav, 'config', 'siroce-oporavak.json'))
    writeFileSync(join(d.sustav, 'RegocDaemon.ts'), '// stari daemon: siroče-oporavak nije pozvan\n')
    const r = await d.pokreni(['provjeri', '--modul', 'paket'])
    expect(r.izlaz).not.toContain('izvorni.OrphanRecovery.ts')          // modul postoji
    expect(r.izlaz).toContain('NEDOSTAJE izvorni.config/siroce-oporavak.json')
    expect(r.izlaz).toContain('NEDOSTAJE siroče-oporavak ožičen u daemonu (TASK-5140)')
  })
})

describe('J15 — modul kuke: putanje iz HOME/TM_PAKET, tuđe ostaju, kuka bez datoteke se ne spaja', () => {
  test('jezgra = 7 kuka; svaka naredba je iz HOME/TM_PAKET čvora; drugi --pisi → 0 promjena', async () => {
    const r = await d.pokreni(['primijeni', '--pisi', '--modul', 'kuke'])
    expect(r.kod).toBe(KOD.OK)
    const j = settingsJson()
    const naredbe = Object.values(j.hooks).flat().flatMap((e: any) => e.hooks.map((h: any) => h.command)) as string[]
    expect(naredbe.length).toBe(1 + 7)                     // tuđa + jezgra
    expect(naredbe.filter(n => n !== 'tudja-kuka').every(n => n.includes(d.home))).toBe(true)
    expect(naredbe).toContain(`${d.home}/.bun/bin/bun run ${d.paket}/hooks/TaskInstructionsInject.hook.ts`)
    expect(j.hooks.SessionStart.length).toBe(1)
    expect(j.hooks.PostToolUse.map((e: any) => e.matcher)).toEqual([undefined, 'Bash|Edit|MultiEdit|Write|NotebookEdit|Task'])
    expect((await d.pokreni(['primijeni', '--pisi', '--modul', 'kuke'])).izlaz).toContain('PRIMIJENJENO: 0 promjena')
    expect(readFileSync(PROFIL, 'utf-8')).not.toMatch(/"\/home\//)          // nijedna apsolutna putanja doma u profilu
  })

  test('KUKE_PAKETI=jezgra,pai-ucenje → 14 kuka; nepoznat paket → upozorenje', async () => {
    instanca(['KUKE_PAKETI=jezgra,pai-ucenje,nepostojeci'])
    const r = await d.pokreni(['primijeni', '--pisi', '--modul', 'kuke'])
    expect(r.izlaz).toContain('paket nepostojeci')
    const n = Object.values(settingsJson().hooks).flat().flatMap((e: any) => e.hooks).length
    expect(n).toBe(1 + 14)
    expect(paketiKuka(ucitajProfil(PROFIL), { KUKE_PAKETI: 'pai-ucenje' })).toEqual(['jezgra', 'pai-ucenje'])
  })

  test('kuka bez datoteke → NEDOSTAJE i nije spojena; postojeća SecurityValidator kuka čvora se ne duplicira', async () => {
    rmSync(join(d.paket, 'hooks', 'RegocConsoleLog.hook.ts'))
    await d.pokreni(['primijeni', '--pisi', '--modul', 'kuke'])
    const r = await d.pokreni(['provjeri', '--modul', 'kuke'])
    expect(r.kod).toBe(KOD.LJUDI)
    expect(r.izlaz).toContain('NEDOSTAJE PostToolUse[Bash|Edit|MultiEdit|Write|NotebookEdit|Task] RegocConsoleLog')
    expect(JSON.stringify(settingsJson())).not.toContain('RegocConsoleLog')
    expect(settingsJson().hooks.PreToolUse.length).toBe(1)
  })
})

describe('J16 — staleReaper ON na čvoru → RAZLIKA i kad je staleReaperLive off', () => {
  test('provjeri javlja RAZLIKA staleReaper, a oporavak NEDOSTAJE dok je upaljen', async () => {
    const r = await d.pokreni(['provjeri', '--modul', 'znacajke,oporavak'])
    expect(r.izlaz).toContain('RAZLIKA staleReaper: profil=false čvor=true')
    expect(r.izlaz).toContain('NEDOSTAJE staleReaper — mora biti isključen')
  })
})

describe('J17 — modul konzola: drop-in u datoteku, svježi izvori', () => {
  test('drop-in za oba user-unita; drugi --pisi 0; traži daemon-reload', async () => {
    const r = await d.pokreni(['primijeni', '--pisi', '--modul', 'konzola'])
    expect(r.izlaz).toContain('daemon-reload')
    for (const [unit, ime] of [['regoc-taskmanager', 'taskwebui'], ['regoc-voice', 'voiceserver']]) {
      const dropIn = join(d.home, '.config', 'systemd', 'user', `${unit}.service.d`, 'konzola.conf')
      const log = join(d.home, '.tmp', 'regoc_logs', `${ime}.log`)
      expect(readFileSync(dropIn, 'utf-8')).toBe(konzolaDropIn(log))
      expect(readFileSync(dropIn, 'utf-8')).toContain(`StandardOutput=append:${log}`)
      expect(existsSync(join(d.home, '.tmp', 'regoc_logs'))).toBe(true)
    }
    expect((await d.pokreni(['primijeni', '--pisi', '--modul', 'konzola'])).izlaz).toContain('PRIMIJENJENO: 0 promjena')
  })

  test('svjež izvor = OK, nepostojeći = NEDOSTAJE s imenom punitelja', async () => {
    mkdirSync(join(d.home, '.tmp', 'regoc_logs'), { recursive: true })
    writeFileSync(join(d.home, '.tmp', 'regoc_logs', 'regoc.log'), '[x] agent · TASK-1 · Bash: test\n')
    const r = await d.pokreni(['provjeri', '--modul', 'konzola'])
    expect(r.izlaz).not.toContain('NEDOSTAJE regoc ')
    expect(r.izlaz).toContain('NEDOSTAJE daemon — izvor konzole nije svjež')
  })
})

// TASK-5308 (izmjereno na node-A, EDT): ploča vraća vrijeme bez zone („2026-10-07 09:07:56", UTC), a
// `Date.parse` ga čita kao LOKALNO → na čvoru izvan UTC-a zadatak je „u budućnosti" i siroče/zombie
// ne vide odsutnost (TASK-267: 16 min in_progress bez procesa, presuda „čeka, 0 min").
describe('oporavak — vrijeme izvornog sustava je UTC (drop-in TZ)', () => {
  test('bez drop-ina → RAZLIKA za daemon i ploču; --pisi upiše Environment=TZ=UTC; drugi --pisi 0', async () => {
    const r = await d.pokreni(['provjeri', '--modul', 'oporavak'])
    expect(r.izlaz).toContain('RAZLIKA regoc-daemon.TZ')
    expect(r.izlaz).toContain('RAZLIKA regoc-taskmanager.TZ')
    const p = await d.pokreni(['primijeni', '--pisi', '--modul', 'oporavak'])
    expect(p.izlaz).toContain('daemon-reload')
    for (const unit of ['regoc-daemon', 'regoc-taskmanager']) {
      const f = join(d.home, '.config', 'systemd', 'user', `${unit}.service.d`, 'vrijeme.conf')
      expect(readFileSync(f, 'utf-8')).toBe(vrijemeDropIn('UTC'))
      expect(readFileSync(f, 'utf-8')).toContain('Environment=TZ=UTC')
    }
    expect((await d.pokreni(['primijeni', '--pisi', '--modul', 'oporavak'])).izlaz).toContain('PRIMIJENJENO: 0 promjena')
  })
})

describe('oporavak — samo provjera', () => {
  test('nakon primjene profila: uključeno + kod + svjež daemon.log → OK', async () => {
    await d.pokreni(['primijeni', '--pisi', '--modul', 'znacajke,oporavak'])
    mkdirSync(join(d.home, '.tmp'), { recursive: true })
    writeFileSync(join(d.home, '.tmp', 'regoc_daemon.log'), '[x] daemon\n')
    const r = await d.pokreni(['provjeri', '--modul', 'oporavak'])
    expect(r.kod).toBe(KOD.OK)
  })
})

describe('C3 — config/features.example.json = modul znacajke profila', () => {
  test('isti 75 ključeva i iste vrijednosti; svaki note nosi odluku', () => {
    const pr = ucitajProfil(PROFIL).moduli.znacajke!.kljucevi
    const ex = JSON.parse(readFileSync(join(KORIJEN, 'config', 'features.example.json'), 'utf-8'))
    const kljucevi = Object.keys(ex).filter(k => k !== '_opis')
    expect(kljucevi.sort()).toEqual(Object.keys(pr).sort())
    for (const k of kljucevi) {
      expect(ex[k].enabled).toBe(pr[k].on)
      expect(ex[k].note.startsWith(pr[k].odluka)).toBe(true)
    }
  })
})
