#!/usr/bin/env bun
/**
 * BranaBrisanja — `smije_brisati <putanja>`: JEDINO mjesto koje odlučuje smije li se nešto obrisati
 * (ADR-0020 §5.2, TASK-5397).
 *
 * ZAŠTO POSTOJI
 *   09.10.2026. ujutro, dok se čistio pun disk, obrisan je `~/.tmp/tts_curlic` (46,6 GB: Piper okolina,
 *   venv za faster-whisper/ECAPA, DeepFilterNet, modeli). Kopije nije bilo. Alat i otpad izgledali su
 *   jednako, a `SecurityValidator` nije razlikovao `rm -rf ~/.tmp/regoc-dbtemplate-x` od toga.
 *
 * ODGOVOR je `DA` ili `NE: <razlog>`. NE kad:
 *   0. putanja je korijen stabla (HOME, ~/app, ~/app/tmp, ~/app/raid, ~/.tmp, ~/.claude, vrh stabla §3) ili njegov predak;
 *   1. putanja, predak ili potomak (do dubine 4) ima `.trajno`;
 *   2. putanja je u katalogu (ili je predak stavke kataloga) ili je ispod zaštićene zone
 *      (alati/, raid/projekti|tools|modeli|skupovi|archive|hindsight|pgvector);
 *   3. drži je živ proces (fd, cwd, exe, maps u /proc);
 *   4. pripada zadatku koji nije zatvoren barem 7 dana (osim podmape `<zadatak>/tmp/` — to je TMPDIR);
 *   5. ima ≥ 1 GiB, a nije ispod ispitno/ ni predmemorija/ i nema provjerenu kopiju (_red/tablica.tsv)
 *      → `NE: karantena`.
 *
 * POVEZNICE: `rm -rf link/` (kosa crta na kraju) briše SADRŽAJ cilja (izmjereno 09.10.: GNU rm), pa se
 *   takva putanja razrješava do kraja (realpath). Bez kose crte rm briše samo poveznicu → razrješava se
 *   roditelj, a poveznica ostaje zadnja sastavnica. Međusastavnice se uvijek razrješavaju.
 *
 * ŠTO KUKA VIDI U NAREDBI (presudaNaredbe, dorada TASK-5402 po QA TASK-5399 N1–N3):
 *   rm/unlink/shred, find -delete|-exec, find … | xargs rm (cilj = početne putanje finda), rsync --delete;
 *   mv (premještanje van .trajno/zone = brisanje za zonu; unutar iste .trajno mape i U zonu prolazi);
 *   bash|sh -c, eval, $(…), `…`, heredoc za ljusku → rekurzivno; python/node/bun/perl -c|-e i heredoc:
 *   pozivi brisanja/premještanja traže se u kodu BEZ sadržaja stringova, ciljevi su literalne putanje;
 *   pisanje u POSTOJEĆU .trajno (>, >>, truncate, tee, cp, dd of=, mv preko nje) → NE (novu smiješ stvoriti).
 *   NE vidi: skriptu iz datoteke (python3 x.py), git mv, ssh, prepisivanje obične datoteke (truncate/dd/>)
 *   — za to je brana u kodu čistača i tjedni pregled nestalih .trajno (ADR §10).
 *
 * MALIKOV PREGLED (TASK-5400 → TASK-5403):
 *   H1 jedan prolaz kroz /proc po naredbi (otvorenePutanje), strop 200 ciljeva izvan ispitno/predmemorija
 *      i vlastiti rok 8 s → NE; kuka uz to ima rok 10 s u radniku (hooks/lib/brana_radnik.ts).
 *   H3 xargs rm|mv i ljuska (find -exec / xargs sh -c) koja briše, bez poznatog popisa → strogo: NE ispod
 *      HOME izvan ispitno/predmemorija; naredba iz varijable (R=rm; $R) se razrješava, nerazriješena uz rm → NE.
 *   M1 cd -, pushd/popd se prate; nerazriješen cd → relativni cilj NE (ako je radna mapa bila ispod HOME).
 *   M2 {a,b} i {1..3} se proširuju. M3 find -mindepth ≥ 1 sudi djecu, ne početnu točku. L1 git clean pod .trajno → NE.
 *
 * FAIL-CLOSED: ako brana pukne (nečitljiva baza zadataka, iznimka), odgovor je NE. Namjerno odstupanje
 *   od fail-open načela sustava — ishod brisanja je nepovratan. Sustav radi dalje, samo se ne briše.
 *
 * Uporaba:
 *   bun brana_brisanja.ts <putanja>…            # ispis „DA <p>” / „NE: <razlog> <p>”; izlaz 0 = sve DA, 1 = neko NE
 *   bun brana_brisanja.ts --naredba '<bash>'    # presuda nad cijelom bash naredbom (kao kuka)
 *   bash brana_brisanja.sh …            # isto, iz ljuske (`smije_brisati` funkcija)
 * Ispit: ~/.claude/regoc/tools/servisi/brana_brisanja.test.ts
 */
import { Database } from 'bun:sqlite'
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync } from 'fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'path'
import { homedir } from 'os'

export const GIB = 1024 ** 3

export interface BranaOpcije {
  home?: string
  /** SSD korijen stabla (ADR-0020 §3.1), zadano REGOC_TMP_ROOT ili ~/app/tmp */
  tmp?: string
  raid?: string
  dotTmp?: string
  katalog?: string
  db?: string
  proc?: string
  pragKarantene?: number
  daniZatvoren?: number
  sada?: Date
  /** presudaNaredbe: najviše ciljeva izvan ispitno/ i predmemorija/ (zadano 200), više → NE (H1, TASK-5403) */
  stropCiljeva?: number
  /** presudaNaredbe: vlastiti rok u ms (zadano 8000), istek → NE (H1, TASK-5403) */
  rokMs?: number
  /** podmetanje u testovima */
  zauzeto?: (p: string) => string | null
  statusZadatka?: (id: string) => { status: string; zatvoreno: string | null } | null
}

export type Presuda = { smije: true } | { smije: false; razlog: string }

interface Okolina {
  home: string; tmp: string; raid: string; dotTmp: string; katalog: string; db: string; proc: string
  prag: number; dani: number; sada: Date
  zauzeto: (p: string) => string | null
  statusZadatka: (id: string) => { status: string; zatvoreno: string | null } | null
}

function rp(p: string): string {
  try { return realpathSync(p) } catch { return resolve(p) }
}

export function okolina(o: BranaOpcije = {}): Okolina {
  const home = o.home ?? process.env.HOME ?? homedir()
  const tmp = rp(o.tmp ?? process.env.REGOC_TMP_ROOT ?? join(home, 'app', 'tmp'))
  const raid = rp(o.raid ?? join(home, 'app', 'raid'))
  const proc = o.proc ?? '/proc'
  const db = o.db ?? join(home, '.claude', 'regoc', 'data', 'regoc.db')
  const env: Okolina = {
    home: rp(home), tmp, raid,
    dotTmp: o.dotTmp ?? join(home, '.tmp'),
    katalog: o.katalog ?? join(home, '.claude', 'regoc', 'catalog', 'katalog.json'),
    db, proc,
    prag: o.pragKarantene ?? GIB,
    dani: o.daniZatvoren ?? 7,
    sada: o.sada ?? new Date(),
    zauzeto: o.zauzeto ?? ((p) => drziProces(p, proc)),
    statusZadatka: o.statusZadatka ?? ((id) => statusIzBaze(id, db)),
  }
  return env
}

// ─── razrješavanje putanje ────────────────────────────────────────────────────────────────
/** Putanja nad kojom rm stvarno djeluje: kosa crta na kraju → do kraja; inače roditelj + ime. */
export function razrijesi(putanja: string, cwd = process.cwd()): string {
  const abs = isAbsolute(putanja) ? putanja : join(cwd, putanja)
  if (/\/\.?$/.test(abs) || /\/\.$/.test(abs)) return rp(abs.replace(/\/+\.?$/, '') || '/')
  const norm = resolve(abs)
  if (norm === '/') return '/'
  return join(rp(dirname(norm)), basename(norm))
}

function ispod(p: string, korijen: string): boolean {
  return p === korijen || p.startsWith(korijen.endsWith(sep) ? korijen : korijen + sep)
}

// ─── .trajno ──────────────────────────────────────────────────────────────────────────────
export function trajnoPredak(p: string): string | null {
  let d = p
  for (;;) {
    if (existsSync(join(d, '.trajno'))) return d
    const r = dirname(d)
    if (r === d) return null
    d = r
  }
}

export function trajnoPotomak(p: string, dubina = 4): string | null {
  let st
  try { st = lstatSync(p) } catch { return null }
  if (!st.isDirectory()) return null
  const red: [string, number][] = [[p, 0]]
  while (red.length) {
    const [d, n] = red.shift()!
    let imena: string[]
    try { imena = readdirSync(d) } catch { continue }
    if (imena.includes('.trajno')) return d
    if (n >= dubina) continue
    for (const i of imena) {
      const q = join(d, i)
      try { if (lstatSync(q).isDirectory()) red.push([q, n + 1]) } catch { /* nestalo */ }
    }
  }
  return null
}

// ─── katalog ──────────────────────────────────────────────────────────────────────────────
let katalogKes: { put: string; mtime: number; putanje: [string, string][] } | null = null
function putanjeKataloga(env: Okolina): [string, string][] {
  const mt = statSync(env.katalog).mtimeMs
  if (katalogKes && katalogKes.put === env.katalog && katalogKes.mtime === mt) return katalogKes.putanje
  const k = JSON.parse(readFileSync(env.katalog, 'utf-8'))
  const out: [string, string][] = []
  const ex = (s: string) => s.startsWith('~') ? env.home + s.slice(1) : s
  for (const s of k.stavke || []) {
    for (const p of [s.putanja, ...(s.aliasi || [])]) if (p) out.push([rp(ex(p)), s.id])
  }
  katalogKes = { put: env.katalog, mtime: mt, putanje: out }
  return out
}

// ─── živi procesi ─────────────────────────────────────────────────────────────────────────
export function drziProces(p: string, proc = '/proc'): string | null {
  const pogodak = (t: string | null) => !!t && ispod(t.replace(/ \(deleted\)$/, ''), p)
  let pidovi: string[]
  try { pidovi = readdirSync(proc).filter((x) => /^\d+$/.test(x)) } catch { return null }
  const ja = String(process.pid)
  for (const pid of pidovi) {
    if (pid === ja) continue
    const b = join(proc, pid)
    const rl = (x: string) => { try { return readlinkSync(x) } catch { return null } }
    if (pogodak(rl(join(b, 'cwd'))) || pogodak(rl(join(b, 'exe')))) return pid
    let fds: string[] = []
    try { fds = readdirSync(join(b, 'fd')) } catch { /* tuđi proces */ }
    for (const f of fds) if (pogodak(rl(join(b, 'fd', f)))) return pid
    try {
      const m = readFileSync(join(b, 'maps'), 'utf-8')
      if (m.includes(p)) for (const l of m.split('\n')) {
        const i = l.indexOf('/')
        if (i >= 0 && pogodak(l.slice(i))) return pid
      }
    } catch { /* tuđi proces */ }
  }
  return null
}

/**
 * Jedan prolaz kroz /proc (H1, TASK-5403): svaka otvorena putanja (cwd, exe, fd, maps) i SVI njezini preci →
 * PID. `drziProces(p)` čita cijeli /proc za svaki cilj (4404 ciljeva × /proc = 78 s); ovdje je upit `get(p)`.
 */
export function otvorenePutanje(proc = '/proc'): Map<string, string> {
  const m = new Map<string, string>()
  const dodaj = (t: string | null, pid: string) => {
    if (!t || t[0] !== '/') return
    let p = t.replace(/ \(deleted\)$/, '')
    while (!m.has(p)) { m.set(p, pid); const r = dirname(p); if (r === p) break; p = r }
  }
  let pidovi: string[]
  try { pidovi = readdirSync(proc).filter((x) => /^\d+$/.test(x)) } catch { return m }
  const ja = String(process.pid)
  const rl = (x: string) => { try { return readlinkSync(x) } catch { return null } }
  for (const pid of pidovi) {
    if (pid === ja) continue
    const b = join(proc, pid)
    dodaj(rl(join(b, 'cwd')), pid); dodaj(rl(join(b, 'exe')), pid)
    let fds: string[] = []
    try { fds = readdirSync(join(b, 'fd')) } catch { /* tuđi proces */ }
    for (const f of fds) dodaj(rl(join(b, 'fd', f)), pid)
    try {
      for (const l of readFileSync(join(b, 'maps'), 'utf-8').split('\n')) { const i = l.indexOf('/'); if (i >= 0) dodaj(l.slice(i), pid) }
    } catch { /* tuđi proces */ }
  }
  return m
}

// ─── zadaci ───────────────────────────────────────────────────────────────────────────────
export function statusIzBaze(id: string, dbPut: string): { status: string; zatvoreno: string | null } | null {
  const db = new Database(dbPut, { readonly: true })   // baca → fail-closed u pozivatelju
  try {
    const r = db.query('SELECT status, completed_at, updated_at FROM tasks WHERE id = ?').get(id) as
      { status: string; completed_at: string | null; updated_at: string | null } | null
    if (!r) return null
    return { status: r.status, zatvoreno: r.completed_at || r.updated_at }
  } finally { db.close() }
}

const ZADATAK = /^(?:task-?|t)(\d{3,6})(?:[-_.].*)?$/i
/** Zadatak kojem putanja pripada + je li unutar njegove `tmp/` podmape. */
export function zadatakPutanje(p: string, env: Okolina): { id: string; uTmp: boolean; mapa: string } | null {
  const kandidati: string[] = [join(env.tmp, 'zadaci'), env.tmp, rp(env.dotTmp), join(env.raid, 'zadaci')]
  for (const k of kandidati) {
    if (!ispod(p, k) || p === k) continue
    const dijelovi = p.slice(k.length + 1).split(sep)
    // raid/zadaci/<GGGG>/<TASK>
    const i = k === join(env.raid, 'zadaci') && /^\d{4}$/.test(dijelovi[0]) ? 1 : 0
    const m = dijelovi[i]?.match(ZADATAK)
    if (!m) continue
    return { id: `TASK-${m[1]}`, uTmp: dijelovi[i + 1] === 'tmp' && dijelovi.length > i + 1, mapa: join(k, ...dijelovi.slice(0, i + 1)) }
  }
  return null
}

// ─── veličina i kopija ────────────────────────────────────────────────────────────────────
/** Zauzeće na disku (kao du), uz rani izlaz kad prijeđe granicu. */
export function velicina(p: string, granica = Infinity): number {
  let zbroj = 0
  const stog = [p]
  while (stog.length) {
    const q = stog.pop()!
    let st
    try { st = lstatSync(q) } catch { continue }
    zbroj += (st.blocks ?? 0) * 512 || st.size
    if (zbroj >= granica) return zbroj
    if (st.isDirectory()) {
      try { for (const i of readdirSync(q)) stog.push(join(q, i)) } catch { /* bez prava */ }
    }
  }
  return zbroj
}

export const TABLICA_ZAGLAVLJE = 'datum\tradnja\tizvor\tcilj\tstavki\tbajtova\tprovjera\ttko\trazlog'
export function provjerenaKopija(p: string, env: Okolina): string | null {
  const t = join(env.tmp, '_red', 'tablica.tsv')
  if (!existsSync(t)) return null
  for (const red of readFileSync(t, 'utf-8').split('\n')) {
    const s = red.split('\t')
    if (s[2] === p && s[6] === 'OK' && s[3] && existsSync(s[3])) return s[3]
  }
  return null
}

// ─── presuda ──────────────────────────────────────────────────────────────────────────────
export const ZASTICENE_ZONE = (env: Okolina) => [
  join(env.tmp, 'alati'), join(env.tmp, 'tools'),
  ...['projekti', 'tools', 'modeli', 'skupovi', 'archive', 'hindsight', 'pgvector'].map((x) => join(env.raid, x)),
]
export const VRH_SSD = ['alati', 'tools', 'zadaci', 'projekti', 'servisi', 'predmemorija', 'ispitno', '_red']

export function korijeni(env: Okolina): string[] {
  return [env.home, join(env.home, 'app'), join(env.home, '.claude'), env.tmp, env.raid, rp(env.dotTmp),
    ...VRH_SSD.map((x) => join(env.tmp, x)),
    ...['projekti', 'tools', 'modeli', 'skupovi', 'zadaci', 'archive', 'work', 'hindsight', 'pgvector'].map((x) => join(env.raid, x))]
}

/** p je već razriješena putanja (razrijesi()). */
export function smijeBrisatiRazrijeseno(p: string, o: BranaOpcije = {}): Presuda {
  try {
    const env = okolina(o)
    const ne = (razlog: string): Presuda => ({ smije: false, razlog })
    if (p === '/' || p === '') return ne('korijen datotečnog sustava')
    for (const k of korijeni(env)) if (ispod(k, p)) return ne(`korijen stabla (${k})`)

    let jeLink = false
    try { jeLink = lstatSync(p).isSymbolicLink() } catch { /* ne postoji */ }
    // poveznica bez kose crte: rm je ne slijedi, pa se preci gledaju od roditelja (cilj u grani jeLink niže)
    const pred = trajnoPredak(jeLink ? dirname(p) : p)
    if (pred) return ne(`.trajno u ${pred}`)
    if (!jeLink) {
      const pot = trajnoPotomak(p)
      if (pot) return ne(`.trajno u ${pot}`)
    }
    for (const z of ZASTICENE_ZONE(env)) if (ispod(p, z)) return ne(`zaštićena zona ${z}`)
    for (const [kp, id] of putanjeKataloga(env)) if (ispod(kp, p)) return ne(`u katalogu: ${id}`)
    if (jeLink) {
      // rm bez kose crte briše samo poveznicu; ali poveznica za kompatibilnost na zaštićeno (npr.
      // ~/.tmp/tts_curlic → raid/projekti/…) ostaje: njih mijenja tek korak 7 ADR-0020.
      const cilj = rp(p)
      if (cilj !== p && existsSync(cilj)) {
        const z = ZASTICENE_ZONE(env).find((x) => ispod(cilj, x))
        const t = trajnoPredak(cilj)
        if (z || t) return ne(`poveznica na zaštićeno (${t ? '.trajno u ' + t : z}) — poveznice mijenja korak 7`)
      }
      return { smije: true }
    }
    if (!existsSync(p)) return { smije: true }

    const proces = env.zauzeto(p)
    if (proces) return ne(`drži je živ proces (PID ${proces})`)

    const posebno = ispod(p, join(env.tmp, 'ispitno')) || ispod(p, join(env.tmp, 'predmemorija'))
    if (!posebno) {
      const z = zadatakPutanje(p, env)
      if (z && !z.uTmp) {
        const s = env.statusZadatka(z.id)
        if (s) {
          const zatvoren = s.status === 'completed' || s.status === 'cancelled'
          const dana = s.zatvoreno ? (env.sada.getTime() - Date.parse(s.zatvoreno.replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(s.zatvoreno) ? '' : 'Z'))) / 86_400_000 : 0
          if (!zatvoren) return ne(`pripada zadatku ${z.id} (${s.status})`)
          if (!(dana >= env.dani)) return ne(`pripada zadatku ${z.id} zatvorenom prije ${dana.toFixed(1)} d (< ${env.dani} d)`)
        }
      }
      if (velicina(p, env.prag) >= env.prag && !provjerenaKopija(p, env)) {
        return ne(`karantena (≥ ${(env.prag / GIB).toFixed(env.prag < GIB ? 3 : 0)} GiB bez provjerene kopije)`)
      }
    }
    return { smije: true }
  } catch (e) {
    return { smije: false, razlog: `brana nije mogla odlučiti (fail-closed): ${(e as Error).message}` }
  }
}

export function smijeBrisati(putanja: string, o: BranaOpcije & { cwd?: string } = {}): Presuda {
  try {
    const home = o.home ?? process.env.HOME ?? homedir()
    const s = putanja.replace(/^~(?=\/|$)/, home)
    return smijeBrisatiRazrijeseno(razrijesi(s, o.cwd), o)
  } catch (e) {
    return { smije: false, razlog: `brana nije mogla odlučiti (fail-closed): ${(e as Error).message}` }
  }
}

/**
 * Premještanje (mv, shutil.move…) je brisanje za zonu iz koje stvar odlazi (QA TASK-5399, N1): `.trajno`
 * mapa premještena u /tmp ili oznaka premještena van mape više nisu zaštićene. Provjerava se samo zaštita
 * (korijen, .trajno, zona, katalog) — ne zadatak, veličina ni proces, jer premještanje ne uništava podatke.
 * Prolazi: premještanje unutar iste `.trajno` mape (ne njezin korijen) i premještanje U zaštićenu zonu.
 * `odr` je konačna razriješena odredišna putanja (null = nepoznata → kao da ide van zaštite).
 */
export function smijePremjestitiRazrijeseno(p: string, odr: string | null, o: BranaOpcije = {}, labavo = false): Presuda {
  try {
    const env = okolina(o)
    const ne = (razlog: string): Presuda => ({ smije: false, razlog })
    if (p === '/' || p === '') return ne('korijen datotečnog sustava')
    for (const k of korijeni(env)) if (ispod(k, p)) return ne(`korijen stabla (${k})`)
    if (odr === p) return { smije: true }
    if (basename(p) === '.trajno' && existsSync(p)) return ne('premještanje .trajno oznake — mijenja se samo kroz katalog')
    const uZoni = (x: string) => ZASTICENE_ZONE(env).find((z) => ispod(x, z))
    const odrZona = odr ? uZoni(odr) : undefined
    let jeLink = false
    try { jeLink = lstatSync(p).isSymbolicLink() } catch { /* ne postoji */ }
    if (labavo) {
      // izvor je literal iz koda, odredište nepoznato (os.replace(tmp, p)): blokira se samo ono što bi
      // odnijelo zaštitu cijelu — korijen .trajno mape (ili njezin predak) i stavka na vrhu zone
      const pot = jeLink ? null : trajnoPotomak(p)
      if (pot) return ne(`.trajno u ${pot} (premještanje van zaštite)`)
      const zl = uZoni(p)
      if (zl && dirname(p) === zl && !odrZona) return ne(`zaštićena zona ${zl} (premještanje van zone)`)
      return { smije: true }
    }
    const pred = trajnoPredak(jeLink ? dirname(p) : p)
    if (pred && !odrZona && !(odr && p !== pred && ispod(odr, pred))) return ne(`.trajno u ${pred} (premještanje van zaštite)`)
    if (!jeLink) {
      const pot = trajnoPotomak(p)
      if (pot && !odrZona) return ne(`.trajno u ${pot} (premještanje van zaštite)`)
    }
    const z = uZoni(p)
    if (z && !odrZona) return ne(`zaštićena zona ${z} (premještanje van zone)`)
    for (const [kp, id] of putanjeKataloga(env)) if (ispod(kp, p)) return ne(`u katalogu: ${id} — prvo izmijeni katalog`)
    if (jeLink) {
      const cilj = rp(p)
      if (cilj !== p && existsSync(cilj) && (uZoni(cilj) || trajnoPredak(cilj))) return ne('poveznica na zaštićeno — poveznice mijenja korak 7')
    }
    return { smije: true }
  } catch (e) {
    return { smije: false, razlog: `brana nije mogla odlučiti (fail-closed): ${(e as Error).message}` }
  }
}

// ═══ Bash naredba → ciljevi brisanja (za kuku SecurityValidator) ═══════════════════════════
interface Rijec { t: string; glob: boolean; varijabla: boolean; navodnik: boolean; op?: string }

/**
 * Heredoc tijela izvlače se PRIJE leksiranja: inače bi se svaki redak tijela čitao kao naredba
 * (`cat > x.md <<EOF` s retkom „rm -rf …” bio bi lažna blokada), a tijelo za `bash`/`python3 -`
 * se ne bi vidjelo kao cjelina. Na mjestu `<<EOF` ostaje oznaka `<<\u0001<n>\u0001`.
 */
export function izvuciHeredoce(cmd: string): { cmd: string; tijela: string[] } {
  const tijela: string[] = []
  let s = cmd, i = 0, nav: string | null = null
  while (i < s.length) {
    const c = s[i]
    if (nav) { if (c === '\\' && nav === '"') i++; else if (c === nav) nav = null; i++; continue }
    if (c === "'" || c === '"') { nav = c; i++; continue }
    if (c === '\\') { i += 2; continue }
    if (c === '<' && s[i + 1] === '<' && s[i + 2] !== '<' && s[i - 1] !== '<') {
      const m = s.slice(i + 2).match(/^(-?)[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/)
      const nl = s.indexOf('\n', i)
      if (m && nl >= 0) {
        const redovi = s.slice(nl + 1).split('\n')
        const k = redovi.findIndex((r) => (m[1] ? r.replace(/^\t+/, '') : r).trim() === m[3])
        if (k >= 0) {
          tijela.push(redovi.slice(0, k).join('\n'))
          const oznaka = `<<\u0001${tijela.length - 1}\u0001`
          const ostatak = redovi.slice(k + 1).join('\n')
          s = s.slice(0, i) + oznaka + s.slice(i + 2 + m[0].length, nl + 1) + ostatak
          i += oznaka.length
          continue
        }
      }
    }
    i++
  }
  return { cmd: s, tijela }
}

/**
 * Indeks zagrade koja zatvara `$(` na mjestu i (s[i] === '$'); preskače '…', "…" i \x. Bez para → s.length - 1.
 * (TASK-5403: naivno brojanje zagrada zatvaralo je `$(python3 -c "… 1) …")` usred teksta, a ostatak je
 * postajao lažna naredba.)
 */
export function krajZamjene(s: string, i: number): number {
  let d = 0
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j]
    if (c === '\\') { j++; continue }
    if (c === "'") { const k = s.indexOf("'", j + 1); if (k < 0) return s.length - 1; j = k; continue }
    if (c === '"') { j++; while (j < s.length && s[j] !== '"') { if (s[j] === '\\') j++; j++ } continue }
    if (c === '(') d++
    else if (c === ')' && --d === 0) return j
  }
  return s.length - 1
}

/** Grubi leksički razdjel bash naredbe: riječi, operatori (; && || | & novi red ( )) → null, preusmjeravanja → {op}. */
export function lex(cmd: string, razdjelnici?: string[]): (Rijec | null)[] {
  const out: (Rijec | null)[] = []
  let cur = '', glob = false, vari = false, nav = false, ima = false
  const kraj = () => { if (ima) out.push({ t: cur, glob, varijabla: vari, navodnik: nav }); cur = ''; glob = vari = nav = ima = false }
  const op = (o: string, t = '') => out.push({ t, glob: false, varijabla: false, navodnik: false, op: o })
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
    if (c === "'") { const j = cmd.indexOf("'", i + 1); const e = j < 0 ? cmd.length : j; cur += cmd.slice(i + 1, e); i = e; nav = ima = true; continue }
    if (c === '"') {
      let j = i + 1
      while (j < cmd.length && cmd[j] !== '"') { if (cmd[j] === '\\') { cur += cmd[j + 1] ?? ''; j += 2; continue } if (cmd[j] === '$' || cmd[j] === '`') vari = true; cur += cmd[j]; j++ }
      i = j; nav = ima = true; continue
    }
    if (c === '\\') { cur += cmd[i + 1] ?? ''; i++; ima = true; continue }
    if (c === '$') { vari = true; ima = true; cur += c; if (cmd[i + 1] === '(') { const j = krajZamjene(cmd, i); cur += cmd.slice(i + 1, j + 1); i = j } continue }
    if (c === '`') { const j = cmd.indexOf('`', i + 1); const e = j < 0 ? cmd.length : j; cur += cmd.slice(i, e + 1); vari = ima = true; i = e; continue }
    if (c === '>' || c === '<' || (c === '&' && cmd[i + 1] === '>')) {
      if (c === '<' && cmd[i + 1] === '(') { kraj(); continue }            // <(…) — zagrada je zaseban segment
      if (ima && !nav && /^\d+$/.test(cur)) { cur = ''; ima = false } else kraj()   // 2> — broj je deskriptor
      if (c === '&') { const dva = cmd[i + 2] === '>'; op(dva ? '&>>' : '&>'); i += dva ? 2 : 1; continue }
      if (c === '>') {
        if (cmd[i + 1] === '&' && /[\d-]/.test(cmd[i + 2] ?? '')) { i += 2; while (/[\d-]/.test(cmd[i + 1] ?? '')) i++; continue } // >&2
        if (cmd[i + 1] === '>' || cmd[i + 1] === '|' || cmd[i + 1] === '&') { op('>' + cmd[i + 1]); i++; continue }
        op('>'); continue
      }
      if (cmd.startsWith('<<<', i)) { op('<<<'); i += 2; continue }
      if (cmd.startsWith('<<\u0001', i)) { const j = cmd.indexOf('\u0001', i + 3); op('heredoc', cmd.slice(i + 3, j)); i = j; continue }
      if (cmd[i + 1] === '&') { i++; while (/[\d-]/.test(cmd[i + 1] ?? '')) i++; continue }  // <&0
      if (cmd[i + 1] === '<') { op('<<'); i++; continue }
      op('<'); continue
    }
    if (c === ' ' || c === '\t') { kraj(); continue }
    if (c === '\n' || c === ';' || c === '|' || c === '&' || c === '(' || c === ')') {
      // razdjelnik se pamti (| = cijev, za xargs bez finda — H3, TASK-5403); || i && su jedan razdjelnik
      let r: string = c
      if ((c === '|' || c === '&') && cmd[i + 1] === c) { r = c + c; i++ } else if (c === '|' && cmd[i + 1] === '&') { r = '|&'; i++ }
      kraj(); out.push(null); razdjelnici?.push(r); continue
    }
    if (c === '#' && !ima) { const j = cmd.indexOf('\n', i); i = j < 0 ? cmd.length : j - 1; continue }
    if ('*?['.includes(c)) glob = true
    cur += c; ima = true
  }
  kraj()
  return out
}

/**
 * Brace expansion kao u bashu (M2, TASK-5403): `a/{b,c}/d` → a/b/d, a/c/d; `x{1..3}`, `{a..c}`. `{}` i `{x}`
 * ostaju doslovni. Više od 1000 varijanti → iznimka (presuda je tada fail-closed).
 */
export function zagrade(s: string): string[] {
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{' || s[i - 1] === '$') continue
    let d = 0, j = i
    const zarezi: number[] = []
    for (; j < s.length; j++) {
      if (s[j] === '{') d++
      else if (s[j] === '}') { if (--d === 0) break }
      else if (s[j] === ',' && d === 1) zarezi.push(j)
    }
    if (j >= s.length) return [s]
    let dijelovi: string[] | null = null
    if (zarezi.length) {
      dijelovi = []; let a = i + 1
      for (const z of zarezi) { dijelovi.push(s.slice(a, z)); a = z + 1 }
      dijelovi.push(s.slice(a, j))
    } else {
      const unutra = s.slice(i + 1, j)
      const n = unutra.match(/^(-?\d+)\.\.(-?\d+)$/), z = unutra.match(/^([A-Za-z])\.\.([A-Za-z])$/)
      if (n || z) {
        const a = n ? +n[1] : z![1].charCodeAt(0), b = n ? +n[2] : z![2].charCodeAt(0)
        if (Math.abs(b - a) > 1000) throw new Error('brace expansion prevelik')
        dijelovi = []
        for (let k = a; a <= b ? k <= b : k >= b; k += a <= b ? 1 : -1) dijelovi.push(n ? String(k) : String.fromCharCode(k))
      }
    }
    if (!dijelovi) { i = j; continue }
    const pre = s.slice(0, i), post = s.slice(j + 1)
    const out = dijelovi.flatMap((x) => zagrade(pre + x + post))
    if (out.length > 1000) throw new Error('brace expansion prevelik')
    return out
  }
  return [s]
}

/** Unutarnje naredbe iz `$(…)` i `…` u riječi (za rekurzivnu presudu). */
function zamjene(t: string): string[] {
  const out: string[] = []
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '$' && t[i + 1] === '(') {
      const j = krajZamjene(t, i)
      out.push(t.slice(i + 2, t[j] === ')' ? j : j + 1)); i = j
    } else if (t[i] === '`') {
      const j = t.indexOf('`', i + 1)
      if (j < 0) break
      out.push(t.slice(i + 1, j)); i = j
    }
  }
  return out
}

/**
 * Kod jezika → (kod s ispražnjenim stringovima, popis jednorednih literala). Pozna trostruke navodnike
 * (python) i `…` (JS) preko više redaka; višeredni literali nisu putanje (to je tekst, ne cilj).
 */
export function razdvojiLiterale(k: string): { bez: string; literali: string[] } {
  let bez = ''
  const literali: string[] = []
  for (let i = 0; i < k.length; i++) {
    const c = k[i]
    if (c !== "'" && c !== '"' && c !== '`') { bez += c; continue }
    const trojni = (c === "'" || c === '"') && k.startsWith(c.repeat(3), i)
    const zatv = trojni ? c.repeat(3) : c
    let j = i + zatv.length, sadrzaj = ''
    for (; j < k.length; j++) {
      if (k[j] === '\\') { sadrzaj += k[j + 1] ?? ''; j++; continue }
      if (k.startsWith(zatv, j)) break
      if (k[j] === '\n' && !trojni && c !== '`') break
      sadrzaj += k[j]
    }
    if (!trojni && !sadrzaj.includes('\n')) literali.push(sadrzaj)
    bez += zatv + ' '.repeat(Math.max(0, Math.min(j, k.length) - i - zatv.length)) + (j < k.length ? zatv : '')
    i = j + zatv.length - 1
  }
  return { bez, literali }
}

export interface Nerazrijesen { rijec: string; prefiks: string | null; strogo?: boolean; razlog?: string }
export interface Premjestanje { izvor: string; odrediste: string | null; uMapu: boolean; /** izvor iz koda bez para (izvor, odredište) */ labavo?: boolean }
export interface CiljeviNaredbe {
  ciljevi: string[]
  /**
   * riječi koje se ne mogu razriješiti ($VAR bez vrijednosti, xargs rm…): uz dio putanje do prve varijable.
   * `strogo` (H3/M1, TASK-5403): NE kad je prefiks ispod HOME izvan ispitno/ i predmemorija/ (prefiks null → NE).
   */
  nerazrijeseni: Nerazrijesen[]
  /** mv / shutil.move / renameSync… (N1) */
  premjestanja: Premjestanje[]
  /** putanje u koje naredba piše (>, >>, truncate, tee, cp…) — brana gleda samo postojeću `.trajno` (N3) */
  pisanja: string[]
}

const OMOTACI = new Set(['sudo', 'command', 'nice', 'ionice', 'nohup', 'time', 'exec', 'builtin', 'setsid', 'stdbuf'])
const BRISACI = ['rm', 'unlink', 'shred']
const LJUSKE = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'su'])
const JEZIK = /^(python[\d.]*|pypy3?|node|nodejs|bun|deno|perl|ruby|php)$/
/** naredbe u cijevi između find i xargs koje ne mijenjaju značenje popisa */
const FILTRI = new Set(['sort', 'grep', 'egrep', 'head', 'tail', 'uniq', 'tr', 'sed', 'awk', 'cat', 'tac', 'cut'])
/** kod ljuske (find -exec sh -c, xargs bash -c) koji briše ili premješta → strogo (H3, TASK-5403) */
const BRISE_U_LJUSCI = /\b(rm|rmdir|unlink|shred|mv|rsync)\b|-delete\b/
const XARGS_VRIJEDNOST = new Set(['-I', '-n', '-P', '-L', '-s', '-d', '-E', '-a', '--arg-file', '--delimiter', '--max-args', '--max-procs'])

// kod u -c/-e argumentu jezika: brisanje, premještanje, pisanje, poziv ljuske
const KOD_BRISE = /shutil\.rmtree|\brmtree\b|remove_tree|\bos\.(?:remove|unlink|rmdir|removedirs)\b|\.unlink\s*\(|\.rmdir\s*\(|\b(?:rmSync|unlinkSync|rmdirSync)\b|\bfsp?\.(?:rm|unlink|rmdir)\s*\(|promises\.(?:rm|unlink|rmdir)\b|FileUtils\.rm|\bunlink\s*[(\s'"]|\[\s*['"]rm['"]/
const KOD_SELI = /shutil\.move|\bos\.(?:rename|replace|renames)\b|\.rename\s*\(|\.replace\s*\(\s*['"]\/|\brenameSync\b|FileUtils\.mv|\brename\s*\(/
const KOD_PISE = /open\s*\([^)]*,\s*['"][^'"]*[wax+]|write_text|write_bytes|writeFile|appendFile|Bun\.write|truncate|createWriteStream/
const KOD_LJUSKA = /\bos\.system|subprocess|os\.popen|execSync|spawnSync|child_process|Bun\.spawn|\bsystem\s*\(|\bexec\s*\(/
const PAR_SELI = [
  /(?:shutil\.move|\bos\.(?:rename|replace|renames)|renameSync|FileUtils\.mv)\s*\(\s*(['"])(.+?)\1\s*,\s*(['"])(.+?)\3/g,
  /Path\(\s*(['"])(.+?)\1\s*\)\.(?:rename|replace)\(\s*(['"])(.+?)\3/g,
]

export function ciljeviBrisanja(cmd: string, cwd = process.cwd(), env: Record<string, string | undefined> = process.env, dubina = 0): CiljeviNaredbe {
  if (dubina > 6) throw new Error('preduboko ugniježđena naredba (bash -c / eval / $(…))')
  const rez: CiljeviNaredbe = { ciljevi: [], nerazrijeseni: [], premjestanja: [], pisanja: [] }
  const vars: Record<string, string | null> = {}
  const home = env.HOME || homedir()
  let dir = cwd
  /** M1 (TASK-5403): radna mapa poslije nerazriješenog cd ($(…), $NEPOZNATA, popd bez stoga) nije poznata */
  let dirNepoznat: { uHome: boolean } | null = null
  let stara: { dir: string; nep: { uHome: boolean } | null } | null = null    // OLDPWD za `cd -`
  const stogMapa: { dir: string; nep: { uHome: boolean } | null }[] = []      // pushd/popd
  const hd = izvuciHeredoce(cmd)
  const segmenti: Rijec[][] = [[]]
  const razd: string[] = [], sepPrije: string[] = ['']
  let ri = 0
  for (const r of lex(hd.cmd, razd)) {
    if (r === null) { segmenti.push([]); sepPrije.push(razd[ri++] ?? ';') } else segmenti[segmenti.length - 1].push(r)
  }

  const apsolutna = (s: string) => isAbsolute(s) ? s : join(dir, s)
  const prosiri = (r: Rijec): string | null => {
    let s = r.t
    if (!r.navodnik || s.startsWith('~/')) s = s.replace(/^~(?=\/|$)/, home)
    if (!r.varijabla) return s
    let neuspjeh = false
    s = s.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (_m, ime) => {
      if (ime in vars) { const v = vars[ime]; if (v === null) neuspjeh = true; return v ?? '' }
      const v = env[ime]; if (v === undefined) neuspjeh = true; return v ?? ''
    })
    if (neuspjeh || /\$\(|`/.test(s)) return null
    return s
  }
  /** riječ → apsolutne putanje (glob proširen nad diskom); null = nerazriješeno (već upisano u rez) */
  const rasiri = (r: Rijec): string[] | null => {
    if (/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/.test(r.t)) {
      const ime = r.t.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)/)![1]
      if (vars[ime] === '\u0000mktemp') return []             // svježa mktemp mapa — nije postojeće stanje
    }
    const s = prosiri(r)
    if (s === null) {
      const lit = r.t.replace(/^~(?=\/|$)/, home)
      // $(echo /putanja) / `ls -d /putanja*`: putanje iz zamjene se provjeravaju kao ciljevi (N1)
      const izZamjene: string[] = []
      for (const z of zamjene(lit)) for (const tok of z.split(/\s+/)) {
        const t = tok.replace(/^['"]|['"]$/g, '').replace(/^~(?=\/|$)/, home)
        if (t.startsWith('/') && t.length > 1) izZamjene.push(t)
      }
      if (izZamjene.length) return izZamjene.flatMap((t) => rasiri({ t, glob: /[*?[]/.test(t), varijabla: false, navodnik: false }) ?? [])
      const i = lit.search(/\$|`/)
      const pre = i > 0 ? lit.slice(0, i) : ''
      const pd = pre.includes('/') ? pre.slice(0, pre.lastIndexOf('/') + 1) : null
      const zamjena = /\$\(|`/.test(lit)
      rez.nerazrijeseni.push({ rijec: r.t, prefiks: pd ? apsolutna(pd) : zamjena ? dir + '/' : null })
      return null
    }
    if (dirNepoznat && !isAbsolute(s) && !s.includes('\u0000')) {
      rez.nerazrijeseni.push({ rijec: r.t, prefiks: null, strogo: dirNepoznat.uHome, razlog: 'relativni cilj nakon nerazriješenog cd (radna mapa nepoznata)' })
      return null
    }
    // M2: {a,b} se proširuje prije globa; u navodnicima ostaje i doslovna riječ (lex ne zna je li zagrada bila u njima)
    const varijante = zagrade(s)
    if (r.navodnik && varijante.length > 1) varijante.push(s)
    const out: string[] = []
    for (const v of varijante) {
      const abs = apsolutna(v)
      if (r.glob && !r.navodnik && /[*?[]/.test(v)) {
        const zadnji = abs.search(/[*?[]/)
        const baza = abs.slice(0, abs.lastIndexOf('/', zadnji)) || '/'
        const uzorak = abs.slice(baza.length + 1).replace(/\/+$/, '')
        const kosa = abs.endsWith('/')
        try {
          for (const m of new Bun.Glob(uzorak).scanSync({ cwd: baza, onlyFiles: false, dot: false, followSymlinks: false })) {
            out.push(join(baza, m) + (kosa ? '/' : ''))
          }
        } catch { rez.nerazrijeseni.push({ rijec: r.t, prefiks: baza + '/' }) }
        continue
      }
      out.push(abs + (v.endsWith('/') && !abs.endsWith('/') ? '/' : ''))
    }
    return out
  }
  /** riječ → apsolutni prefiks (do prvog globa/zagrade/varijable) za strogu provjeru; null = nepoznato */
  const prefiksRijeci = (a: Rijec): string | null => {
    let s = prosiri(a)
    if (s === null) { const lit = a.t.replace(/^~(?=\/|$)/, home); const i = lit.search(/\$|`/); s = i > 0 ? lit.slice(0, lit.lastIndexOf('/', i) + 1) : '' }
    if (!s || s.includes('\u0000')) return null
    const g = s.search(/[*?[{]/)
    if (g >= 0) s = s.slice(0, s.lastIndexOf('/', g) + 1) || '/'
    if (!isAbsolute(s) && dirNepoznat) return null
    return apsolutna(s)
  }
  const strogo = (rijec: string, prefiksi: (string | null)[], razlog: string) => {
    for (const p of prefiksi.length ? prefiksi : [dirNepoznat ? null : dir + '/']) rez.nerazrijeseni.push({ rijec, prefiks: p, strogo: true, razlog })
  }
  const dodaj = (r: Rijec) => { for (const p of rasiri(r) ?? []) rez.ciljevi.push(p) }
  const pisanje = (r: Rijec) => { const s = prosiri(r); if (s) rez.pisanja.push(apsolutna(s)) }
  const pod = (kod: string) => {
    const poznate: Record<string, string | undefined> = { ...env }
    for (const [k, v] of Object.entries(vars)) if (v !== null && v !== '\u0000mktemp') poznate[k] = v
    const r = ciljeviBrisanja(kod, dir, poznate, dubina + 1)
    rez.ciljevi.push(...r.ciljevi); rez.nerazrijeseni.push(...r.nerazrijeseni)
    rez.premjestanja.push(...r.premjestanja); rez.pisanja.push(...r.pisanja)
  }
  /** kod jezika (python -c, node -e, heredoc): literalne putanje uz pozive brisanja/premještanja/pisanja */
  const kod = (k: string, jezik: string) => {
    // pozivi se traže u kodu BEZ sadržaja stringova: python koji uređuje .ts s „renameSync” u tekstu nije brisanje
    const { bez: gol, literali: lit } = razdvojiLiterale(k)
    const putanje = lit.filter((l) => l.length > 1 && !/[{}%\n]/.test(l) && !/^\/+$/.test(l) &&
      (l.startsWith('/') || l.startsWith('~/') || l.startsWith('./') || l.startsWith('../') ||
        (/^[\w.@+-][\w.@+/-]*$/.test(l) && existsSync(join(dir, l)))))
    const kao = (l: string): Rijec => ({ t: l, glob: /[*?[]/.test(l), varijabla: false, navodnik: false })
    const brise = KOD_BRISE.test(gol), seli = KOD_SELI.test(gol)
    if (KOD_LJUSKA.test(gol)) for (const l of lit) if (/\s/.test(l)) pod(l)
    if (brise) {
      for (const l of putanje) dodaj(kao(l))
      // cilj zadan izrazom (sys.argv, varijabla): provjerava se barem radna mapa
      rez.nerazrijeseni.push({ rijec: `${jezik}: ${k.replace(/\s+/g, ' ').slice(0, 60)}`, prefiks: dir + '/' })
    }
    if (seli) {
      let par = false
      for (const re of PAR_SELI) for (const m of k.matchAll(re)) {
        if (gol.slice(m.index!, m.index! + 6) !== k.slice(m.index!, m.index! + 6)) continue   // poziv je tekst u stringu
        par = true
        const iz = rasiri(kao(m[2])) ?? [], u = prosiri(kao(m[4]))
        for (const p of iz) rez.premjestanja.push({ izvor: p, odrediste: u ? apsolutna(u) : null, uMapu: false })
        if (u) rez.pisanja.push(apsolutna(u))
      }
      // bez literalnog para (os.replace(tmp, p) — atomično pisanje): samo .trajno i zone, ne katalog
      if (!par) for (const l of putanje) for (const p of rasiri(kao(l)) ?? []) rez.premjestanja.push({ izvor: p, odrediste: null, uMapu: false, labavo: true })
    }
    if (brise || seli || KOD_PISE.test(gol)) {
      for (const l of putanje) if (basename(l) === '.trajno') { const s = prosiri(kao(l)); if (s) rez.pisanja.push(apsolutna(s)) }
    }
  }

  /** kod ljuske iz find -exec / xargs: {} i $1/$@/$* su stavke ispod početnih putanja → zamijeni stablom */
  const ljuskaNad = (k: string, pocetne: Rijec[] | null, izvor: (string | null)[] = []) => {
    // H3: ljuska koja briše nad stavkama koje brana ne vidi ($0, "$x", petlja) — sudi se cijelo stablo izvora
    if (BRISE_U_LJUSCI.test(k)) strogo(`ljuska: ${k.replace(/\s+/g, ' ').slice(0, 60)}`, pocetne ? pocetne.map(prefiksRijeci) : izvor,
      'ljuska iz find -exec / xargs briše ispod HOME izvan ispitno/ i predmemorija/')
    if (!pocetne) { pod(k); return }
    for (const a of pocetne) {
      const s = prosiri(a)
      if (s === null) { pod(k); continue }
      const put = apsolutna(s).replace(/\/+$/, '') + '/'
      pod(k.replace(/"\$[@*1]"|\$[@*1]|\{\}/g, `'${put.replace(/'/g, `'\\''`)}'`))
    }
  }

  let findPocetne: Rijec[] | null = null      // N2: početne putanje zadnjeg finda u cijevi
  let findDjeca = false                       // M3: taj find ima -mindepth ≥ 1 (početna točka se ne briše)
  let izvorCijevi: (string | null)[] | null = null   // H3: putanje iz glave cijevi (du/ls/echo …) za xargs bez finda
  /** find cilj: bez -mindepth briše se i početna točka (kosa crta = sadržaj); s -mindepth ≥ 1 samo djeca */
  const ciljFinda = (a: Rijec, djeca: boolean) => {
    if (!djeca) { dodaj({ ...a, t: a.t.endsWith('/') ? a.t : a.t + '/' }); return }
    for (const p of rasiri(a) ?? []) {
      const q = p.replace(/(.)\/+$/, '$1')
      let imena: string[]
      try { imena = readdirSync(q) } catch { rez.ciljevi.push(q + '/'); continue }
      for (const i of imena) rez.ciljevi.push(join(q, i))
    }
  }
  for (let si = 0; si < segmenti.length; si++) {
    const seg = segmenti[si]
    const uCijevi = sepPrije[si] === '|' || sepPrije[si] === '|&'
    // preusmjeravanja izlaze iz riječi naredbe; heredoc/herestring postaju ulaz (kod / naredbe)
    const ulazi: string[] = []
    let w: Rijec[] = []
    for (let k = 0; k < seg.length; k++) {
      const r = seg[k]
      if (!r.op) { w.push(r); continue }
      if (r.op === 'heredoc') { ulazi.push(hd.tijela[+r.t] ?? ''); continue }
      const c = seg[k + 1] && !seg[k + 1].op ? seg[++k] : null
      if (!c) continue
      if (r.op === '<<<') ulazi.push(c.t)
      else if (r.op.startsWith('>') || r.op.startsWith('&>')) pisanje(c)
      if (c.varijabla) for (const z of zamjene(c.t)) pod(z)
    }
    // $(…) i `…` u bilo kojoj riječi su naredbe same za sebe
    for (const r of w) if (r.varijabla) for (const z of zamjene(r.t)) pod(z)

    // dodjele na početku segmenta (X=… ; export X=…)
    if (w[0]?.t === 'export' || w[0]?.t === 'local' || w[0]?.t === 'declare') w = w.slice(1)
    while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0].t)) {
      const [ime, ...v] = w[0].t.split('=')
      const val = v.join('=')
      vars[ime] = /^\$\(\s*mktemp\b/.test(val) ? '\u0000mktemp' : prosiri({ ...w[0], t: val })
      w = w.slice(1)
    }
    // H3: naredba iz varijable (R=rm; $R …, $(echo rm) …) — razriješi i nastavi kao da je napisana
    if (w[0] && /^[$`]/.test(w[0].t)) {
      const s = prosiri(w[0])
      if (s !== null && !s.includes('\u0000')) w = [...(lex(s).filter(Boolean) as Rijec[]), ...w.slice(1)]
      else if (s === null) {
        if (BRISE_U_LJUSCI.test(cmd)) strogo(`naredba iz varijable: ${w[0].t}`, w.slice(1).filter((a) => !a.t.startsWith('-')).map(prefiksRijeci),
          'ime naredbe je nerazriješena varijabla, a naredba spominje brisanje')
        izvorCijevi = null
        continue
      }
    }
    // omotači
    for (;;) {
      const n = w[0]?.t
      if (!n) break
      if (OMOTACI.has(n)) { w = w.slice(1); while (w[0]?.t.startsWith('-')) w = w.slice(1); continue }
      if (n === 'env') { w = w.slice(1); while (w[0] && (w[0].t.startsWith('-') || /^[A-Za-z_]\w*=/.test(w[0].t))) w = w.slice(1); continue }
      if (n === 'timeout') { w = w.slice(1); while (w[0]?.t.startsWith('-')) w = w.slice(1); w = w.slice(1); continue }
      break
    }
    if (!w.length) continue
    const ime = basename(w[0].t)
    const arg = w.slice(1)
    const prethodniFind = findPocetne, prethodnaDjeca = findDjeca
    if (ime !== 'find' && !FILTRI.has(ime)) findPocetne = null
    const izvorPrije = uCijevi ? izvorCijevi : null
    if (!FILTRI.has(ime) || !uCijevi) {
      izvorCijevi = ime === 'xargs' ? null : arg.filter((a) => !a.t.startsWith('-') && (a.t.includes('/') || a.t === '.' || a.t === '..' || a.t.startsWith('~'))).map(prefiksRijeci)
    }
    const pozicijski = () => {
      const out: Rijec[] = []; let opc = true
      for (const a of arg) { if (opc && a.t === '--') { opc = false; continue } if (opc && a.t.startsWith('-') && a.t.length > 1) continue; out.push(a) }
      return out
    }

    if (ime === 'cd' || ime === 'pushd' || ime === 'popd') {
      // M1: cd -, pushd/popd se prate; nerazriješen cd → radna mapa nepoznata (relativni ciljevi strogo)
      const ovdje = { dir, nep: dirNepoznat }
      const a = arg.filter((x) => !/^-[LPe@]+$/.test(x.t))
      const nepoznato = () => { dirNepoznat = { uHome: dirNepoznat ? dirNepoznat.uHome : ispod(dir, home) } }
      if (ime === 'popd') {
        const v = stogMapa.pop()
        if (v) { dir = v.dir; dirNepoznat = v.nep } else nepoznato()
        continue
      }
      if (a[0]?.t === '-' && !a[0].navodnik) {
        if (stara) { dir = stara.dir; dirNepoznat = stara.nep } else nepoznato()
      } else {
        const s = a[0] ? prosiri(a[0]) : home
        if (s === null) nepoznato()
        else if (s.includes('\u0000')) { dir = '/\u0000mktemp'; dirNepoznat = null }       // svježa mktemp mapa
        else if (isAbsolute(s) || !dirNepoznat) { dir = apsolutna(s); dirNepoznat = null }
      }
      if (ime === 'pushd') stogMapa.push(ovdje)
      stara = ovdje
      continue
    }
    if (ime === 'eval') { pod(arg.map((a) => a.t).join(' ')); continue }
    if (LJUSKE.has(ime)) {
      const k = arg.findIndex((a) => /^-[A-Za-z]*c[A-Za-z]*$/.test(a.t))
      if (k >= 0 && arg[k + 1]) pod(arg[k + 1].t)
      else if (!arg.some((a) => !a.t.startsWith('-'))) for (const u of ulazi) pod(u)   // bash <<EOF / bash -s <<<
      continue
    }
    if (JEZIK.test(ime)) {
      const k = arg.findIndex((a) => ['-c', '-e', '-E', '--eval', '-r', '--command', '-p', '--print'].includes(a.t) || /^-[A-Za-z]*c$/.test(a.t))
      if (k >= 0 && arg[k + 1]) kod(arg[k + 1].t, ime)
      for (const u of ulazi) kod(u, ime)
      continue
    }
    if (ime === 'xargs') {
      let k = 0
      while (k < arg.length && arg[k].t.startsWith('-')) k += XARGS_VRIJEDNOST.has(arg[k].t) ? 2 : 1
      const naredba = arg[k] ? basename(arg[k].t) : ''
      if (LJUSKE.has(naredba)) {
        const c = arg.findIndex((a, i) => i > k && /^-[A-Za-z]*c[A-Za-z]*$/.test(a.t))
        if (c > 0 && arg[c + 1]) ljuskaNad(arg[c + 1].t, prethodniFind, izvorPrije ?? [])
        else if (!prethodniFind) rez.nerazrijeseni.push({ rijec: 'xargs ' + arg[k].t, prefiks: null })
        continue
      }
      const brise = BRISACI.includes(naredba), seli = naredba === 'mv'
      if (!brise && !seli) continue
      if (prethodniFind) {
        for (const a of prethodniFind) {
          if (brise) ciljFinda(a, prethodnaDjeca)
          else for (const p of rasiri(a) ?? []) rez.premjestanja.push({ izvor: p, odrediste: null, uMapu: false })
        }
      } else {
        // H3: `du … | sort | awk | xargs rm -rf` — popis je nepoznat, sudi se izvor cijevi (ili radna mapa)
        strogo('xargs ' + arg[k].t, izvorPrije ?? [], `xargs ${naredba} bez poznatog popisa ispod HOME izvan ispitno/ i predmemorija/`)
      }
      continue
    }
    if (BRISACI.includes(ime)) {
      for (const a of pozicijski()) dodaj(a)
      continue
    }
    if (ime === 'mv') {
      let cilj: Rijec | null = null, T = false, opc = true
      const poz: Rijec[] = []
      for (let k = 0; k < arg.length; k++) {
        const a = arg[k]
        if (opc && a.t === '--') { opc = false; continue }
        if (opc && (a.t === '-t' || a.t === '--target-directory' || /^-[A-Za-z]*t$/.test(a.t))) { cilj = arg[++k] ?? null; continue }
        if (opc && a.t.startsWith('--target-directory=')) { cilj = { ...a, t: a.t.slice(a.t.indexOf('=') + 1) }; continue }
        if (opc && (a.t === '-T' || a.t === '--no-target-directory')) { T = true; continue }
        if (opc && a.t.startsWith('-') && a.t.length > 1) continue
        poz.push(a)
      }
      const izvori = cilj ? poz : poz.slice(0, -1)
      const odr = cilj ?? poz[poz.length - 1] ?? null
      const os = odr ? prosiri(odr) : null
      const odrAbs = os ? apsolutna(os) : null
      const uMapu = !T && (!!cilj || izvori.length > 1)
      for (const a of izvori) for (const p of rasiri(a) ?? []) rez.premjestanja.push({ izvor: p.replace(/(.)\/+$/, '$1'), odrediste: odrAbs, uMapu })
      if (odrAbs) rez.pisanja.push(odrAbs)
      continue
    }
    if (ime === 'cp' || ime === 'install' || ime === 'ln') {
      const p = pozicijski(); const t = arg.findIndex((a) => a.t === '-t')
      const odr = t >= 0 ? arg[t + 1] : p[p.length - 1]
      if (odr && p.length > 1) pisanje(odr)
      continue
    }
    if (ime === 'truncate') {
      for (let k = 0; k < arg.length; k++) {
        if (['-s', '-r', '--size', '--reference'].includes(arg[k].t)) { k++; continue }
        if (!arg[k].t.startsWith('-')) pisanje(arg[k])
      }
      continue
    }
    if (ime === 'tee' || ime === 'sed') { for (const a of pozicijski()) pisanje(a); continue }
    if (ime === 'dd') { for (const a of arg) if (a.t.startsWith('of=')) pisanje({ ...a, t: a.t.slice(3) }); continue }
    if (ime === 'find') {
      const tekst = arg.map((a) => a.t)
      const pocetne: Rijec[] = []
      for (const a of arg) { if (a.t.startsWith('-') || a.t === '!' || a.t === '(') break; pocetne.push(a) }
      if (!pocetne.length) pocetne.push({ t: '.', glob: false, varijabla: false, navodnik: false })
      findPocetne = pocetne
      const mi = tekst.indexOf('-mindepth')
      findDjeca = mi >= 0 && Number(tekst[mi + 1]) >= 1
      const exec = tekst.map((t, i) => (t === '-exec' || t === '-execdir' || t === '-ok' || t === '-okdir') ? basename(tekst[i + 1] || '') : null).filter(Boolean) as string[]
      for (let i = 0; i < tekst.length; i++) if (/^-(exec|execdir|ok|okdir)$/.test(tekst[i]) && LJUSKE.has(basename(tekst[i + 1] || ''))) {
        const c = tekst.indexOf('-c', i); if (c > i && tekst[c + 1]) ljuskaNad(tekst[c + 1], pocetne)
      }
      const brise = tekst.includes('-delete') || exec.some((e) => BRISACI.includes(e))
      if (brise) for (const a of pocetne) ciljFinda(a, findDjeca)
      else if (exec.includes('mv')) for (const a of pocetne) for (const p of rasiri(a) ?? []) rez.premjestanja.push({ izvor: p, odrediste: null, uMapu: false })
      continue
    }
    if (ime === 'git' && arg.some((a) => a.t === 'clean') && arg.some((a) => /^-[A-Za-z]*f/.test(a.t) || a.t === '--force')) {
      // L1 (TASK-5403): git clean briše neprećene datoteke ispod radne mape — NE pod .trajno i u zaštićenoj zoni
      rez.nerazrijeseni.push({ rijec: `git clean u ${dir}`, prefiks: dirNepoznat ? null : dir + '/', strogo: dirNepoznat?.uHome })
      continue
    }
    if (ime === 'rsync' && arg.some((a) => a.t.startsWith('--delete') || a.t === '--remove-source-files')) {
      const ne = arg.filter((a) => !a.t.startsWith('-'))
      const dst = ne[ne.length - 1]
      if (arg.some((a) => a.t === '--remove-source-files')) for (const a of ne.slice(0, -1)) if (!a.t.includes(':')) dodaj(a)
      if (dst && !dst.t.includes(':')) dodaj({ ...dst, t: dst.t.endsWith('/') ? dst.t : dst.t + '/' })
      continue
    }
  }
  return rez
}

export interface PresudaNaredbe { blokirano: { cilj: string; razlog: string }[]; upozorenja: string[]; provjereno: number }

/** Predfiltar: naredba koja ništa od ovoga ne spominje ne može brisati, premještati ni pisati u oznaku. */
const MOZDA_BRISE = /\b(clean|rm|unlink|shred|find|rsync|xargs|mv|cp|ln|install|tee|truncate|dd|sed|eval|bash|sh|zsh|dash|ksh|su|python[\d.]*|pypy3?|node|nodejs|bun|deno|perl|ruby|php|rmtree)\b|>|\.trajno/

/** Kuka: provjeri sve ciljeve brisanja/premještanja ispod HOME. Iznimka → blokada (fail-closed). */
export const STROP_CILJEVA = 200
export const ROK_PRESUDE_MS = 8000
const UPUTA_MASOVNO = 'briši manjim skupinama, kroz petlju sa smije_brisati (brana_brisanja.sh) ili premjesti u karantenu (tmp_red.sh karantena)'

export function presudaNaredbe(cmd: string, cwd = process.cwd(), oUlaz: BranaOpcije = {}): PresudaNaredbe {
  const out: PresudaNaredbe = { blokirano: [], upozorenja: [], provjereno: 0 }
  if (!MOZDA_BRISE.test(cmd)) return out
  const pocetak = Date.now()
  const rok = pocetak + (oUlaz.rokMs ?? ROK_PRESUDE_MS)
  // H1: /proc se čita JEDNOM po naredbi (lijeno — tek kad neki cilj stvarno treba provjeru procesa)
  let mapa: Map<string, string> | null = null
  const o: BranaOpcije = { ...oUlaz, zauzeto: oUlaz.zauzeto ?? ((p) => (mapa ??= otvorenePutanje(oUlaz.proc)).get(p) ?? null) }
  const home = rp(o.home ?? process.env.HOME ?? homedir())
  let c: CiljeviNaredbe
  try { c = ciljeviBrisanja(cmd, cwd, { ...process.env, HOME: o.home ?? process.env.HOME }) } catch (e) {
    out.blokirano.push({ cilj: cmd.slice(0, 80), razlog: `brana nije mogla razložiti naredbu (fail-closed): ${(e as Error).message}` })
    return out
  }
  const uHome = (p: string) => ispod(p, home) || ispod(home, p)
  const razr = (x: string) => { try { return razrijesi(x, cwd) } catch { return x } }
  const env = okolina(o)
  const posebno = (p: string) => ispod(p, join(env.tmp, 'ispitno')) || ispod(p, join(env.tmp, 'predmemorija'))

  // H1: strop broja ciljeva — masovno brisanje se ne sudi stavku po stavku (78 s nad ~/.tmp/*), nego odbija
  const ciljevi = c.ciljevi.map(razr).filter(uHome)
  const izvori = c.premjestanja.map((m) => ({ m, p: razr(m.izvor.replace(/(.)\/+$/, '$1')) })).filter((x) => uHome(x.p))
  const strop = o.stropCiljeva ?? STROP_CILJEVA
  const broj = ciljevi.filter((p) => !posebno(p)).length + izvori.filter((x) => !posebno(x.p)).length
  if (broj > strop) {
    out.blokirano.push({ cilj: `${broj} ciljeva`, razlog: `previše ciljeva u jednoj naredbi (${broj} > ${strop}) — ${UPUTA_MASOVNO}` })
    return out
  }
  const isteklo = () => {
    if (Date.now() <= rok) return false
    out.blokirano.push({ cilj: cmd.slice(0, 80), razlog: `brana nije stigla odlučiti u ${Date.now() - pocetak} ms (fail-closed) — ${UPUTA_MASOVNO}` })
    return true
  }
  for (const p of ciljevi) {
    if (isteklo()) return out
    out.provjereno++
    const r = smijeBrisatiRazrijeseno(p, o)
    if (!r.smije) out.blokirano.push({ cilj: p, razlog: r.razlog })
  }
  for (const { m, p } of izvori) {
    if (isteklo()) return out
    out.provjereno++
    let odr: string | null = null
    if (m.odrediste) {
      let d = m.odrediste.replace(/(.)\/+$/, '$1')
      try { if (m.uMapu || (existsSync(d) && statSync(d).isDirectory())) d = join(d, basename(p)) } catch { /* ne postoji */ }
      odr = razr(d)
    }
    const r = smijePremjestitiRazrijeseno(p, odr, o, !!m.labavo)
    if (!r.smije) out.blokirano.push({ cilj: p, razlog: r.razlog })
  }
  for (const pis of c.pisanja) {
    const p = razr(pis)
    if (basename(p) !== '.trajno' || !uHome(p)) continue
    out.provjereno++
    if (existsSync(p)) out.blokirano.push({ cilj: p, razlog: 'pisanje u postojeću .trajno oznaku — mijenja se samo kroz katalog (katalog.py)' })
  }
  for (const n of c.nerazrijeseni) {
    if (n.strogo) {
      // H3/M1: nepoznat popis (xargs, ljuska nad $0, cd u nepoznato) — dopušteno samo izvan HOME ili u ispitno/predmemorija
      if (n.prefiks === null) { out.blokirano.push({ cilj: n.rijec, razlog: `${n.razlog ?? 'nerazriješen cilj'} — ${UPUTA_MASOVNO}` }); continue }
      const d = rp(n.prefiks.replace(/(.)\/+$/, '$1'))
      if (uHome(d)) {
        const tr = trajnoPredak(d)
        if (tr) { out.blokirano.push({ cilj: n.rijec, razlog: `nerazriješen cilj ispod .trajno (${tr})` }); continue }
        if (!posebno(d)) { out.blokirano.push({ cilj: n.rijec, razlog: `${n.razlog ?? 'nerazriješen cilj'} (${d}) — ${UPUTA_MASOVNO}` }); continue }
      }
      out.upozorenja.push(`brana ne može razriješiti cilj „${n.rijec}” — propušteno uz zapis`)
      continue
    }
    if (n.prefiks) {
      const d = rp(n.prefiks.replace(/(.)\/+$/, '$1'))
      if (ispod(d, home)) {
        const zona = ZASTICENE_ZONE(env).find((z) => ispod(d, z) || d === z)
        const tr = trajnoPredak(d)
        if (zona || tr) { out.blokirano.push({ cilj: n.rijec, razlog: zona ? `nerazriješen cilj u zaštićenoj zoni ${zona}` : `nerazriješen cilj ispod .trajno (${tr})` }); continue }
      }
    }
    out.upozorenja.push(`brana ne može razriješiti cilj „${n.rijec}” — propušteno uz zapis`)
  }
  return out
}

// ─── CLI ──────────────────────────────────────────────────────────────────────────────────
if (import.meta.main) {
  const a = process.argv.slice(2)
  if (!a.length || a[0] === '-h' || a[0] === '--help') {
    console.log('uporaba: bun brana_brisanja.ts <putanja>… | --naredba "<bash>"   (izlaz 0 = DA, 1 = NE)')
    process.exit(a.length ? 0 : 2)
  }
  if (a[0] === '--naredba') {
    const p = presudaNaredbe(a.slice(1).join(' '))
    for (const b of p.blokirano) console.log(`NE: ${b.razlog} ${b.cilj}`)
    for (const u of p.upozorenja) console.log(`UPOZORENJE: ${u}`)
    if (!p.blokirano.length) console.log(`DA (${p.provjereno} ciljeva)`)
    process.exit(p.blokirano.length ? 1 : 0)
  }
  let ne = 0
  for (const p of a) {
    const r = smijeBrisati(p)
    if (r.smije) console.log(`DA ${p}`)
    else { ne++; console.log(`NE: ${r.razlog} ${p}`) }
  }
  process.exit(ne ? 1 : 0)
}
