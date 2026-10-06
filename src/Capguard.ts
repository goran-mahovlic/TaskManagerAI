/**
 * Capguard — kartica „Sigurnost" na ploči (TASK-2619, vraćena u paket kao uvjetni dio u TASK-5270).
 *
 * Capguard je root servis instalacije koji provodi sposobnosti (internet, mesh, root, …). Ploča
 * smije samo DVIJE stvari:
 *   1. pročitati stvarno stanje iz datoteke stanja (root je piše, svijet čita);
 *   2. upisati NAMJERU u `capability_requests` sa statusom `pending`.
 * Primjenu radi isključivo capguard: Tier-1 sam, Tier-2 tek uz odobrenje admina ili host
 * tokena. Ploča nikad ne poziva capguard, ne traži root i ne upisuje `applied`/`approved_by`.
 *
 * Bez capguarda (zadani put paketa) kartica i API ne postoje: uključuje ih datoteka stanja na
 * disku ili `TM_CAPGUARD=1`; `TM_CAPGUARD=0` ih gasi i kad datoteka postoji.
 */
import { existsSync, readFileSync } from 'fs'
import type { Database } from 'bun:sqlite'

type Env = Record<string, string | undefined>

/** Putanje koje postavlja sam capguard (v. njegov deploy); varijable služe za drugi raspored. */
const ZADANO_STANJE = '/etc/regoc/capabilities.state'
const ZADANI_BIN = '/usr/local/sbin/regoc-capguard'
const ZADANI_HOST_TOKENI = '/media/sf_regoc_approvals'

export interface CapguardPostavke {
  aktivno: boolean
  izvor: 'stanje' | 'env' | null
  statePath: string
}

export function capguardPostavke(env: Env = process.env): CapguardPostavke {
  const statePath = (env.TM_CAPGUARD_STATE || '').trim() || ZADANO_STANJE
  const prekidac = (env.TM_CAPGUARD || '').trim()
  if (prekidac === '0') return { aktivno: false, izvor: null, statePath }
  if (existsSync(statePath)) return { aktivno: true, izvor: 'stanje', statePath }
  if (prekidac === '1') return { aktivno: true, izvor: 'env', statePath }
  return { aktivno: false, izvor: null, statePath }
}

/** `internet` → `allow_internet`; puna imena i zastavice (`plan_mode`) ostaju. */
export function punoIme(ime: string): string {
  const s = String(ime || '').trim()
  if (!s || s.startsWith('allow_') || s.includes('_')) return s
  return 'allow_' + s
}

/** Kandidati imena za katalog: točno ime, pa `allow_<ime>` (`fs_write` → `allow_fs_write`). */
function kandidatiImena(ime: string): string[] {
  const s = String(ime || '').trim()
  if (!s) return []
  return s.startsWith('allow_') ? [s] : [punoIme(s), s, 'allow_' + s].filter((v, i, a) => a.indexOf(v) === i)
}

/** Kratko ime kakvo capguard CLI prima (`allow_internet` → `internet`). */
export function kratkoIme(ime: string): string {
  return ime.startsWith('allow_') ? ime.slice('allow_'.length) : ime
}

export interface UputaOdobrenja { admin: string; hostToken: string; hostTokenSadrzaj: string }

/** Kako se Tier-2 zahtjev odobrava IZVAN ploče (ploča to ne može i ne smije učiniti). */
export function uputaOdobrenja(ime: string, ukljuci: boolean, env: Env = process.env): UputaOdobrenja {
  const bin = (env.TM_CAPGUARD_BIN || '').trim() || ZADANI_BIN
  const tokeni = (env.TM_CAPGUARD_HOST_TOKENI || '').trim() || ZADANI_HOST_TOKENI
  const smjer = ukljuci ? 'on' : 'off'
  return {
    admin: `sudo ${bin} approve ${kratkoIme(ime)} ${smjer}`,
    hostToken: `${tokeni}/${ime}.approve`,
    hostTokenSadrzaj: `${smjer} <epoch>`,
  }
}

export interface StavkaKataloga { name: string; tier: number; requires_admin: number; default_on: number; action: string; description: string }
export interface PendingZahtjev { id: number; name: string; desired: number; requested_by: string; status: string; created_at: string; uputa?: UputaOdobrenja }

export interface StanjeCapguarda {
  aktivno: boolean
  izvor: CapguardPostavke['izvor']
  statePath: string
  effective: Record<string, boolean>
  updated_at: string | null
  host: string | null
  catalog: StavkaKataloga[]
  pending: PendingZahtjev[]
  greska?: string
}

function procitajStanje(statePath: string) {
  const effective: Record<string, boolean> = {}
  const tierIzStanja: Record<string, { tier: number; action: string }> = {}
  if (!existsSync(statePath)) return { effective, tierIzStanja, updated_at: null, host: null, greska: 'nema datoteke stanja ' + statePath }
  try {
    const raw = JSON.parse(readFileSync(statePath, 'utf-8'))
    for (const [k, v] of Object.entries<any>(raw.capabilities || {})) {
      effective[k] = !!v?.on
      tierIzStanja[k] = { tier: Number(v?.tier) || 0, action: String(v?.action || '') }
    }
    return { effective, tierIzStanja, updated_at: raw.updated_at || null, host: raw.host || null, greska: undefined }
  } catch (e: any) {
    return { effective: {}, tierIzStanja: {}, updated_at: null, host: null, greska: 'neispravna datoteka stanja: ' + (e?.message || e) }
  }
}

function tablicaPostoji(db: Database, ime: string): boolean {
  return !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(ime)
}

export function stanjeCapguarda(db: Database, env: Env = process.env): StanjeCapguarda {
  const p = capguardPostavke(env)
  const st = procitajStanje(p.statePath)
  let catalog: StavkaKataloga[] = []
  let pending: PendingZahtjev[] = []
  if (tablicaPostoji(db, 'capability_catalog')) {
    catalog = db.query('SELECT name,tier,requires_admin,default_on,action,description FROM capability_catalog ORDER BY tier,name').all() as StavkaKataloga[]
  }
  if (!catalog.length) {
    // Baza bez kataloga (npr. ploča uz drugu bazu) — redovi iz same datoteke stanja.
    catalog = Object.entries(st.tierIzStanja)
      .map(([name, v]) => ({ name, tier: v.tier, requires_admin: 0, default_on: 0, action: v.action, description: '' }))
      .sort((a, b) => a.tier - b.tier || a.name.localeCompare(b.name))
  }
  if (tablicaPostoji(db, 'capability_requests')) {
    pending = db.query("SELECT id,name,desired,requested_by,status,created_at FROM capability_requests WHERE status='pending' ORDER BY id").all() as PendingZahtjev[]
  }
  const tier2 = new Set(catalog.filter(c => c.tier === 2).map(c => c.name))
  for (const z of pending) if (tier2.has(z.name)) z.uputa = uputaOdobrenja(z.name, !!z.desired, env)
  return {
    aktivno: p.aktivno, izvor: p.izvor, statePath: p.statePath,
    effective: st.effective, updated_at: st.updated_at, host: st.host,
    catalog, pending, ...(st.greska && p.izvor === 'stanje' ? { greska: st.greska } : {}),
  }
}

function procitajDesired(v: unknown): 0 | 1 | null {
  if (v === true || v === 1 || v === '1' || v === 'on') return 1
  if (v === false || v === 0 || v === '0' || v === 'off') return 0
  return null
}

export interface OdgovorZahtjeva { status: number; body: any }

/** Upis namjere. Status je UVIJEK `pending` — sve ostalo radi capguard. */
export function zatraziSposobnost(db: Database, tijelo: { name?: string; desired?: unknown }, env: Env = process.env): OdgovorZahtjeva {
  if (!capguardPostavke(env).aktivno) return { status: 404, body: { error: 'capguard nije prisutan na ovom stroju' } }
  const kandidati = kandidatiImena(String(tijelo?.name ?? ''))
  if (!kandidati.length) return { status: 400, body: { error: 'name je obavezan' } }
  const desired = procitajDesired(tijelo?.desired)
  if (desired === null) return { status: 400, body: { error: 'desired mora biti on|off' } }
  if (!tablicaPostoji(db, 'capability_catalog') || !tablicaPostoji(db, 'capability_requests')) {
    return { status: 503, body: { error: 'baza nema tablice capguarda (capability_catalog/capability_requests)' } }
  }
  db.exec('PRAGMA busy_timeout=4000')
  const nadji = db.query('SELECT name,tier FROM capability_catalog WHERE name=?')
  let cat: { name: string; tier: number } | null = null
  for (const k of kandidati) { cat = nadji.get(k) as typeof cat; if (cat) break }
  if (!cat) return { status: 400, body: { error: 'nepoznata sposobnost: ' + kandidati[0] } }
  const name = cat.name
  const postoji = db.query("SELECT id FROM capability_requests WHERE name=? AND status='pending'").get(name)
  if (postoji) return { status: 409, body: { error: 'već postoji zahtjev na čekanju za ' + name } }
  db.prepare("INSERT INTO capability_requests(name,desired,requested_by,status) VALUES(?,?,'webui','pending')").run(name, desired)
  if (cat.tier === 2) {
    return { status: 200, body: { ok: true, name, desired, tier: 2, uputa: uputaOdobrenja(name, !!desired, env) } }
  }
  return { status: 200, body: { ok: true, name, desired, tier: cat.tier } }
}
