/**
 * Sakupljač stanja čvora za `scripts/profil-cvora.ts` (ADR-0004 §5).
 *
 * SAMO ČITA i vraća SAMO ono što mu specifikacija imenuje (bijela lista, pravilo 1):
 *   - retke `config/postavke.env` čije je ime na popisu; tajni retci samo kao `true/false`;
 *   - polja `telegram.json` koja postoje u obliku profila, bez polja `nikadNeIzvozi`;
 *   - ključeve `settings` s popisa, iz baze otvorene `mode=ro` (pravilo 3);
 *   - capguard zastavice s popisa, `hooks` iz `settings.json`, sha256 kuke, postoji/nema.
 * Vrijednost tajne nikad ne izlazi (pravilo 2) — ni djelomično.
 *
 * Namjerno nema uvoza iz paketa: ista datoteka se na tuđem čvoru izvodi preko SSH-a sa
 * standardnog ulaza (`bun run - <spec>`), bez ijedne datoteke na čvoru.
 */
import { Database } from 'bun:sqlite'
import { createHash } from 'crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { connect } from 'net'
import { homedir } from 'os'
import { join } from 'path'

export interface ZnacajkaSpec { znacajka: string; datoteka?: string; grep?: [string, string] }

export interface SpecStanja {
  /** Mapa paketa na čvoru; prazno = `~/TaskManagerAI`. */
  paket?: string
  /** Vrijednosti za `${IME}` u putanjama (instanca); `HOME` dodaje sakupljač sam. */
  varijable?: Record<string, string>
  envKljucevi: string[]
  envTajne: string[]
  envNesmije: string[]
  /** Oblik `telegram.json` iz profila — sakupljač vraća samo ta polja. */
  telegramOblik?: unknown
  telegramNikad: string[]
  /** Oblik `email.json` iz profila (TASK-5358) — sakupljač vraća samo ta polja; bez njega ništa. */
  epostaOblik?: unknown
  /** Ime tajne u datoteci vjerodajnica (npr. TELEGRAM_BOT_TOKEN) — samo postoji/nema. */
  telegramTajne: string[]
  settingsKljucevi: string[]
  settingsNikad: string[]
  capguardKljucevi: string[]
  settingsJson?: string
  kuke: string[]
  upravitelj?: string
  grepNema?: { uzorak: string; u: string[] }
  paketSadrzi: ZnacajkaSpec[]
  /** Datoteke paketa s ključevima postavki ploče — iz njih se vidi koje ključeve API čvora zna. */
  apiDatoteke?: string[]
  /** Provjere sustava (systemd, vrata, verzije alata). Testovi ih gase. */
  sustav?: { unitovi: string[]; vrata: number[]; alati: string[] }
  /** features.json (samo imenovani ključevi) i zna li kod čvora za ključ (doslovno 'ime' u *.ts mapa kodU). */
  znacajke?: { datoteka: string; kljucevi: string[]; kodU: string[] }
  /** Datoteke izvornog sustava koje profil traži + oznake u kodu (TASK-255). */
  izvorni?: { mapa: string; datoteke: string[]; grep: Array<{ datoteka: string; sadrzi: string }> }
  /** Starost datoteka konzole (min) i sadržaj drop-ina user-unita. */
  konzola?: { datoteke: string[]; dropIni: string[] }
  /** TASK-5331: mogućnosti, stanje upisa znanja, timer, banke i dokumenti kroz memorija.url. */
  znanje?: { mogucnosti?: string; stanje?: string; korpus?: string; timer?: string; memorijaUrl: string; banka: string; zabranjeniDokumenti: string[] }
}

export interface StanjeZnanja {
  mogucnosti: { postoji: boolean; starostSati: number | null; vrijednosti: Record<string, boolean> }
  upis: { postoji: boolean; banka: string; sustav: number; cvor: number; starostSati: number | null }
  korpusPaketa: number
  timer: { datoteka: boolean; aktivan: string }
  /** Banke koje čvor vidi kroz memorija.url (null = memorija ne odgovara). */
  banke: string[] | null
  /** Dokumenti u banci čiji id počinje zabranjenim prefiksom (null = nečitljivo). */
  tudjiDokumenti: number | null
}

export interface StanjeCvora {
  home: string
  paket: string
  tmHome: string
  /** Kamo `primijeni` dopisuje postavke (okolinaCvora); stariji sakupljač je nema → uz paket. */
  postavkeDatoteka?: string
  env: Record<string, string>
  envTajne: Record<string, boolean>
  envNesmije: Record<string, boolean>
  punoDopusteno: boolean
  telegram: Record<string, unknown> | null
  telegramTajne: Record<string, boolean>
  eposta: Record<string, unknown> | null
  baza: { putanja: string; postoji: boolean; greska?: string }
  settings: Record<string, string>
  capguard: { postoji: boolean; zastavice: Record<string, boolean>; pending: string[] }
  settingsJson: { postoji: boolean; hooks: unknown }
  kuke: Record<string, string | null>
  claudePrijava: boolean
  upravitelj: { postoji: boolean; bajtova: number }
  grepNema: Record<string, number | null>
  znacajke: Record<string, boolean>
  /** Ključevi postavki koje kod ploče NA ČVORU zna upisati kroz API (doslovno u apiDatoteke). */
  apiKljucevi: string[]
  git: string | null
  sustav: null | { unitovi: Record<string, string>; vrata: Record<string, boolean>; alati: Record<string, string | null> }
  /** `null` = profil nema modul; vrijednost `null` = ključa (ili datoteke) nema → isEnabled = false. */
  znacajkeCvor: null | { vrijednosti: Record<string, boolean | null>; kodZna: Record<string, boolean> }
  izvorni: Record<string, boolean>
  konzola: { starostMin: Record<string, number | null>; dropIni: Record<string, string | null> }
  znanje?: StanjeZnanja | null
}

/** `${HOME}` i ostale varijable u putanji; nepoznata ostaje doslovno (pa se ne nađe). */
export function putanja(p: string, v: Record<string, string>): string {
  return p.replace(/\$\{(\w+)\}/g, (m, ime) => (ime in v ? v[ime] : m)).replace(/^~(?=\/)/, v.HOME)
}

export function citajEnv(put: string): Record<string, string> {
  const o: Record<string, string> = {}
  if (!existsSync(put)) return o
  for (const red of readFileSync(put, 'utf-8').split('\n')) {
    const r = red.trim()
    if (!r || r.startsWith('#')) continue
    const i = r.indexOf('=')
    if (i < 1) continue
    let v = r.slice(i + 1).trim()
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1)
    o[r.slice(0, i).replace(/^export\s+/, '').trim()] = v
  }
  return o
}

/** Iz stvarnog JSON-a samo polja koja postoje u obliku (rekurzivno), bez zabranjenih. */
export function poObliku(stvarno: unknown, oblik: unknown, nikad: string[]): unknown {
  if (!oblik || typeof oblik !== 'object' || Array.isArray(oblik)) return stvarno
  if (!stvarno || typeof stvarno !== 'object' || Array.isArray(stvarno)) return stvarno
  const o: Record<string, unknown> = {}
  for (const k of Object.keys(oblik as object)) {
    if (nikad.includes(k)) continue
    if (k in (stvarno as object)) o[k] = poObliku((stvarno as any)[k], (oblik as any)[k], nikad)
  }
  return o
}

function sha256(put: string): string | null {
  try { return createHash('sha256').update(readFileSync(put)).digest('hex') } catch { return null }
}

function neprazno(put: string): boolean {
  try { return statSync(put).size > 0 } catch { return false }
}

function slusa(vrata: number): Promise<boolean> {
  return new Promise(res => {
    const s = connect({ host: '127.0.0.1', port: vrata })
    const kraj = (v: boolean) => { s.destroy(); res(v) }
    s.setTimeout(1500, () => kraj(false))
    s.on('connect', () => kraj(true))
    s.on('error', () => kraj(false))
  })
}

function naredba(argv: string[]): string | null {
  try {
    const r = Bun.spawnSync(argv, { stdout: 'pipe', stderr: 'pipe' })
    return r.exitCode === 0 ? r.stdout.toString().trim() : (r.stdout.toString().trim() || null)
  } catch { return null }
}

/**
 * Stanje usluge — ZRCALO `platforma.usluga` iz src/core/platforma.ts (ova datoteka ne smije
 * uvoziti paket, vidi zaglavlje). Linux: sirovi izlaz `is-active` (active/inactive/failed…),
 * macOS: LaunchDaemon `hr.regoc.<ime>`; timer (StartInterval) je aktivan kad je učitan.
 * Ugovor s platformom: tests/profil-cvora-stanje-usluga.test.ts (TASK-5668).
 */
export function stanjeUsluge(ime: string, os = process.platform as string, nar: (argv: string[]) => string | null = naredba): string {
  if (os === 'darwin') {
    const out = nar(['launchctl', 'print', `system/${launchdOznakaZrcalo(ime)}`])
    if (!out) return 'inactive'
    if (ime.endsWith('.timer')) return 'active'
    return /^\s*state\s*=\s*running/m.test(out) ? 'active' : 'inactive'
  }
  return nar(['systemctl', '--user', 'is-active', ime]) || 'nepoznato'
}

/** Zrcalo `platforma.launchdOznaka`. */
export function launchdOznakaZrcalo(ime: string): string {
  return 'hr.regoc.' + ime.replace(/\.(service|timer)$/, '').replace(/^regoc-/, '')
}

/** Datoteka periodičke usluge: systemd korisnički timer | LaunchDaemon plist. */
export function datotekaTimera(unit: string, home: string, os = process.platform as string): string {
  return os === 'darwin' ? `/Library/LaunchDaemons/${launchdOznakaZrcalo(unit)}.plist` : join(home, '.config', 'systemd', 'user', `${unit}.timer`)
}

/**
 * Okolina čvora ISTIM redom kao usluga (scripts/s-okolinom.sh, TASK-5663): instalacija po README-u
 * drži postavke u $TM_HOME/config (instalacija.env, pa postavke.env s prednošću); stari raspored
 * (node-A) ih drži uz paket. `datoteka` = kamo `primijeni` dopisuje postavke.
 */
export function okolinaCvora(paket: string, home: string): { env: Record<string, string>; datoteka: string } {
  const cfg = join(home, '.taskmanager', 'config')
  const inst = join(cfg, 'instalacija.env'), post = join(cfg, 'postavke.env')
  if (existsSync(inst) || existsSync(post)) return { env: { ...citajEnv(inst), ...citajEnv(post) }, datoteka: post }
  const uzPaket = join(paket, 'config', 'postavke.env')
  return { env: citajEnv(uzPaket), datoteka: uzPaket }
}

/** Claude prijava: datoteka CLI-ja (Linux) ili token pretplate u spremištu (macOS, TASK-5754). */
export function claudePrijavljen(home: string, cred: Record<string, string>): boolean {
  return neprazno(join(home, '.claude', '.credentials.json')) || !!cred.CLAUDE_CODE_OAUTH_TOKEN
}

export async function prikupiStanje(spec: SpecStanja, home = process.env.HOME || homedir()): Promise<StanjeCvora> {
  const v: Record<string, string> = { ...(spec.varijable || {}), HOME: home }
  const paket = putanja(spec.paket || '${HOME}/TaskManagerAI', v)
  v.TM_PAKET = paket
  const { env: sveEnv, datoteka: postavkeDatoteka } = okolinaCvora(paket, home)
  const tmHome = sveEnv.TM_HOME || join(home, '.taskmanager')

  const env: Record<string, string> = {}
  for (const k of spec.envKljucevi) if (k in sveEnv && !spec.envTajne.includes(k)) env[k] = sveEnv[k]
  const envTajne: Record<string, boolean> = {}
  for (const k of spec.envTajne) envTajne[k] = !!sveEnv[k]
  const envNesmije: Record<string, boolean> = {}
  for (const k of spec.envNesmije) envNesmije[k] = k in sveEnv

  const tgPut = sveEnv.TM_TELEGRAM_CONFIG || join(paket, 'config', 'telegram.json')
  let telegram: Record<string, unknown> | null = null
  let tgSirovo: any = null
  try { tgSirovo = JSON.parse(readFileSync(tgPut, 'utf-8')) } catch { /* nema datoteke */ }
  if (tgSirovo) telegram = poObliku(tgSirovo, spec.telegramOblik || {}, spec.telegramNikad) as Record<string, unknown>
  // Tajna Telegrama: ključ u datoteci vjerodajnica ili (stariji oblik) polje botToken.
  const credPut = sveEnv.TM_CREDENTIALS || [join(tmHome, 'config', 'credentials.env'), join(paket, 'config', 'credentials.env')].find(existsSync) || ''
  const cred = credPut ? citajEnv(credPut) : {}
  const telegramTajne: Record<string, boolean> = {}
  for (const k of spec.telegramTajne) telegramTajne[k] = !!cred[k] || !!(tgSirovo && tgSirovo.botToken)

  // TASK-5358: email.json istim redom kao paket (TM_EMAIL_CONFIG → $TM_HOME/config → paket).
  let eposta: Record<string, unknown> | null = null
  if (spec.epostaOblik) {
    const kandidati = [sveEnv.TM_HOME ? join(sveEnv.TM_HOME, 'config', 'email.json') : '', join(paket, 'config', 'email.json')]
    const epPut = sveEnv.TM_EMAIL_CONFIG || kandidati.find(x => x && existsSync(x)) || ''
    try { if (epPut) eposta = poObliku(JSON.parse(readFileSync(epPut, 'utf-8')), spec.epostaOblik, []) as Record<string, unknown> } catch { /* nema datoteke */ }
  }

  const dbPut = sveEnv.TM_DB || join(tmHome, 'data', 'tasks.db')
  const baza: StanjeCvora['baza'] = { putanja: dbPut, postoji: existsSync(dbPut) }
  const settings: Record<string, string> = {}
  let pending: string[] = []
  if (baza.postoji) {
    let db: Database | null = null
    try {
      // SQLITE_OPEN_READONLY = `mode=ro` (bun:sqlite ne prima `file:` URI).
      db = new Database(dbPut, { readonly: true })
      const trazi = spec.settingsKljucevi.filter(k => !spec.settingsNikad.includes(k))
      if (trazi.length) {
        const redovi = db.query(`SELECT key, value FROM settings WHERE key IN (${trazi.map(() => '?').join(',')})`)
          .all(...trazi) as Array<{ key: string; value: string }>
        for (const r of redovi) settings[r.key] = r.value
      }
      try {
        pending = (db.query("SELECT name FROM capability_requests WHERE status='pending'").all() as any[]).map(r => r.name)
      } catch { /* nema tablice capguarda */ }
    } catch (e: any) {
      baza.greska = String(e?.message || e)
    } finally { db?.close() }
  }

  const capPut = sveEnv.TM_CAPGUARD_STATE || '/etc/regoc/capabilities.state'
  const capguard: StanjeCvora['capguard'] = { postoji: existsSync(capPut), zastavice: {}, pending }
  try {
    const c = JSON.parse(readFileSync(capPut, 'utf-8')).capabilities || {}
    for (const k of spec.capguardKljucevi) if (k in c) capguard.zastavice[k] = !!c[k]?.on
  } catch { /* nema capguarda */ }

  const sjPut = spec.settingsJson ? putanja(spec.settingsJson, v) : join(home, '.claude', 'settings.json')
  const settingsJson: StanjeCvora['settingsJson'] = { postoji: existsSync(sjPut), hooks: null }
  try { settingsJson.hooks = JSON.parse(readFileSync(sjPut, 'utf-8')).hooks ?? null } catch { /* nema */ }

  const kuke: Record<string, string | null> = {}
  for (const k of spec.kuke) kuke[k] = sha256(putanja(k, v))

  const uprPut = spec.upravitelj ? putanja(spec.upravitelj, v) : ''
  const upravitelj = { postoji: !!uprPut && existsSync(uprPut), bajtova: 0 }
  if (upravitelj.postoji) upravitelj.bajtova = statSync(uprPut).size

  const grepNema: Record<string, number | null> = {}
  if (spec.grepNema && spec.grepNema.uzorak) {
    for (const f of spec.grepNema.u) {
      const p = putanja(f, v)
      try { grepNema[f] = readFileSync(p, 'utf-8').split(spec.grepNema.uzorak).length - 1 } catch { grepNema[f] = null }
    }
  }

  const znacajke: Record<string, boolean> = {}
  for (const z of spec.paketSadrzi) {
    if (z.datoteka) znacajke[z.znacajka] = existsSync(join(paket, z.datoteka))
    else if (z.grep) {
      try { znacajke[z.znacajka] = readFileSync(join(paket, z.grep[0]), 'utf-8').includes(z.grep[1]) } catch { znacajke[z.znacajka] = false }
    } else znacajke[z.znacajka] = false
  }

  let izvorApija = ''
  for (const f of spec.apiDatoteke || []) { try { izvorApija += readFileSync(join(paket, f), 'utf-8') } catch { /* nema */ } }
  const apiKljucevi = spec.settingsKljucevi.filter(k => izvorApija.includes(`'${k}'`))

  let sustav: StanjeCvora['sustav'] = null
  if (spec.sustav) {
    const unitovi: Record<string, string> = {}
    for (const u of spec.sustav.unitovi) unitovi[u] = stanjeUsluge(u)
    const vrata: Record<string, boolean> = {}
    for (const p of spec.sustav.vrata) vrata[String(p)] = await slusa(p)
    const alati: Record<string, string | null> = {}
    const PUT: Record<string, string[]> = {
      bun: [join(home, '.bun', 'bin', 'bun'), 'bun'],
      claude: [join(home, '.local', 'bin', 'claude'), 'claude'],
      python3: ['python3'],
    }
    for (const a of spec.sustav.alati) {
      let izlaz: string | null = null
      for (const bin of PUT[a] || [a]) {
        if (bin.includes('/') && !existsSync(bin)) continue
        izlaz = naredba([bin, '--version'])
        if (izlaz) break
      }
      const m = izlaz?.match(/\d+\.\d+(\.\d+)?/)
      alati[a] = m ? m[0] : null
    }
    sustav = { unitovi, vrata, alati }
  }

  let znacajkeCvor: StanjeCvora['znacajkeCvor'] = null
  if (spec.znacajke) {
    let f: Record<string, any> | null = null
    try { f = JSON.parse(readFileSync(putanja(spec.znacajke.datoteka, v), 'utf-8')) } catch { /* nema */ }
    let kod = ''
    for (const m of spec.znacajke.kodU) {
      const mapa = putanja(m, v)
      let imena: string[] = []
      try { imena = readdirSync(mapa).filter(x => x.endsWith('.ts')) } catch { continue }
      for (const ime of imena) { try { kod += readFileSync(join(mapa, ime), 'utf-8') } catch { /* nečitljivo */ } }
    }
    const vrijednosti: Record<string, boolean | null> = {}
    const kodZna: Record<string, boolean> = {}
    for (const k of spec.znacajke.kljucevi) {
      const x = f?.[k]
      vrijednosti[k] = x && typeof x === 'object' ? x.enabled === true : x === undefined ? null : x === true
      kodZna[k] = kod.includes(`'${k}'`) || kod.includes(`"${k}"`)
    }
    // Bez datoteke svaki ključ je `null` (isEnabled → false) — primjena je tada stvara.
    znacajkeCvor = { vrijednosti, kodZna }
  }

  const izvorni: Record<string, boolean> = {}
  if (spec.izvorni) {
    const mapa = putanja(spec.izvorni.mapa, v)
    for (const f of spec.izvorni.datoteke) izvorni[f] = existsSync(join(mapa, f))
    for (const g of spec.izvorni.grep) {
      try { izvorni[`${g.datoteka}:${g.sadrzi}`] = readFileSync(join(mapa, g.datoteka), 'utf-8').includes(g.sadrzi) } catch { izvorni[`${g.datoteka}:${g.sadrzi}`] = false }
    }
  }

  const konzola: StanjeCvora['konzola'] = { starostMin: {}, dropIni: {} }
  const sad = Date.now()
  for (const f of spec.konzola?.datoteke || []) {
    try { konzola.starostMin[f] = Math.floor((sad - statSync(putanja(f, v)).mtimeMs) / 60_000) } catch { konzola.starostMin[f] = null }
  }
  for (const f of spec.konzola?.dropIni || []) {
    try { konzola.dropIni[f] = readFileSync(putanja(f, v), 'utf-8') } catch { konzola.dropIni[f] = null }
  }

  // TASK-5331: znanje čvora — samo brojevi, imena banaka i id-evi dokumenata (nikad sadržaj).
  let znanje: StanjeZnanja | null = null
  if (spec.znanje) {
    const z = spec.znanje
    const sati = (p: string) => { try { return Math.round((sad - statSync(p).mtimeMs) / 36e5 * 10) / 10 } catch { return null } }
    const mog = { postoji: false, starostSati: null as number | null, vrijednosti: {} as Record<string, boolean> }
    if (z.mogucnosti) {
      const p = join(tmHome, z.mogucnosti)
      try {
        const j = JSON.parse(readFileSync(p, 'utf-8'))
        mog.postoji = true
        mog.starostSati = sati(p)
        for (const [k, x] of Object.entries(j)) if (typeof x === 'boolean') mog.vrijednosti[k] = x
      } catch { /* nema */ }
    }
    const upis = { postoji: false, banka: '', sustav: 0, cvor: 0, starostSati: null as number | null }
    if (z.stanje) {
      try {
        const j = JSON.parse(readFileSync(join(tmHome, z.stanje), 'utf-8'))
        const ids = Object.keys(j.dokumenti || {})
        upis.postoji = true
        upis.banka = String(j.banka || '')
        upis.sustav = ids.filter(i => i.startsWith('sustav/')).length
        upis.cvor = ids.filter(i => i.startsWith('cvor/')).length
        upis.starostSati = j.zadnjiUpis ? Math.round((sad - Date.parse(j.zadnjiUpis)) / 36e5 * 10) / 10 : null
      } catch { /* nema */ }
    }
    let korpusPaketa = 0
    try { korpusPaketa = readdirSync(join(paket, z.korpus || 'znanje/sustav')).filter(f => f.endsWith('.md')).length } catch { /* nema */ }
    const timer = { datoteka: false, aktivan: 'nepoznato' }
    if (z.timer) {
      timer.datoteka = existsSync(datotekaTimera(z.timer, home))
      timer.aktivan = stanjeUsluge(`${z.timer}.timer`)
    }
    let banke: string[] | null = null
    let tudjiDokumenti: number | null = null
    if (z.memorijaUrl) {
      try {
        const r = await fetch(`${z.memorijaUrl}/v1/default/banks`, { signal: AbortSignal.timeout(8000) })
        banke = r.ok ? (((await r.json()) as any).banks || []).map((b: any) => String(b.bank_id)) : null
      } catch { banke = null }
      if (z.banka) {
        try {
          const r = await fetch(`${z.memorijaUrl}/v1/default/banks/${encodeURIComponent(z.banka)}/documents?limit=1000`, { signal: AbortSignal.timeout(15000) })
          if (r.ok) {
            const ids: string[] = (((await r.json()) as any).items || []).map((d: any) => String(d.id || d.document_id || ''))
            tudjiDokumenti = ids.filter(i => z.zabranjeniDokumenti.some(p => i.startsWith(p))).length
          }
        } catch { /* nečitljivo */ }
      }
    }
    znanje = { mogucnosti: mog, upis, korpusPaketa, timer, banke, tudjiDokumenti }
  }

  return {
    znanje,
    home, paket, tmHome, env, envTajne, envNesmije,
    punoDopusteno: sveEnv.TM_RAZGOVOR_PUNO === '1',
    telegram, telegramTajne, eposta, baza, settings, capguard, settingsJson, kuke,
    claudePrijava: claudePrijavljen(home, cred),
    postavkeDatoteka,
    upravitelj, grepNema, znacajke, apiKljucevi,
    git: naredba(['git', '-C', paket, 'rev-parse', '--short', 'HEAD']),
    sustav, znacajkeCvor, izvorni, konzola,
  }
}

// Na tuđem čvoru: `bun run - <spec u base64>` sa standardnog ulaza, ispis JSON-a.
if (import.meta.main) {
  const arg = process.argv[2]
  if (!arg) { console.error('upotreba: profil-cvora-stanje.ts <spec base64>'); process.exit(4) }
  const spec = JSON.parse(Buffer.from(arg, 'base64').toString('utf-8')) as SpecStanja
  console.log(JSON.stringify(await prikupiStanje(spec)))
}
