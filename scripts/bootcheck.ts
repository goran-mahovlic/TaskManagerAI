#!/usr/bin/env bun
/**
 * bootcheck — provjera čvora nakon podizanja ili nadogradnje (plan Mac v3 K4, P3).
 * Ništa ne pokreće i ništa ne popravlja: samo mjeri i zapisuje dokaz. Pokreće ga
 * `scripts/bootcheck.sh` (učita postavke čvora kao usluga, pa poziva ovo).
 *
 *   M1 vlasnik usluge      upravitelj usluga (platforma.opisUsluge): radi, PID, radna mapa = paket
 *   M2 radna mapa procesa  cwd glavnog PID-a = paket i proces je ploča (src/TaskWebUI.ts)
 *   M3 HTTP                200 za vlastiti Host (TM_ALLOWED_HOSTS), 403 za tuđi
 *   M4 siročad             vrata drži usluga (PID ili njegov potomak); nema druge ploče iz paketa
 *   M5 model i autonomija  barem jedan AI servis prijavljen (BILO KOJI, odluka 6); uz autonomyGate i mjerilo radi
 *   M6 sat                 NTP sinkroniziran / odstupanje ≤ 60 s (inače upozorenje, nikad pad)
 *   M7 memorija i RAG      odabrani izvor (memorija.json: nasa/lokalna/iskljuceno) odgovara; neodabrane lokalne usluge stoje
 *   M8 ovlasti korisnika   `sudo -n -l` bez NOPASSWD: ALL (inače upozorenje: ploča bez autentikacije = put do root-a)
 *   M9 tajne kompleta      uz --komplet: koje tajne iz regoc-system/TAJNE.json još nisu upisane (samo IMENA) i što bez njih ne radi
 *
 * Sud po mjerenju: PASS · UPOZORENJE (ne obara verdikt; --strogo ga obara) · FAIL.
 * Okolina usluge (TM_PORT, TM_FEATURES_FILE…) čita se iz živog procesa usluge, pa bootcheck
 * vidi ono što vidi ploča, a ne ono što ima ljuska koja ga je pozvala.
 *
 *   bun scripts/bootcheck.ts [--json] [--strogo] [--cekaj SEK] [--usluga IME] [--paket DIR] [--bez-zapisa]
 * Izlaz: 0 PASS · 1 FAIL · 2 pogrešna uporaba.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync, copyFileSync } from 'fs'
import { homedir, hostname } from 'os'
import { join } from 'path'
import * as P from '../src/core/platforma'
import { adreseVezanja, SVA_SUCELJA, PETLJA } from '../src/core/vezanje'
import { spojiSModelConfigom } from '../src/core/davateljiAI'
import { procitajIzTeksta } from '../src/LoginCreds'
import { stanjePrijave } from './prijava-ai'

export type Sud = 'PASS' | 'UPOZORENJE' | 'FAIL'
export interface Mjerenje { id: string; naslov: string; sud: Sud; detalji: string[] }
export interface Izvjestaj { host: string; os: string; vrijeme: string; vrsta: string; paket: string; usluga: string; mjerenja: Mjerenje[]; verdikt: Sud }

export interface Kontekst {
  os: string
  okolina: P.Okolina
  paket: string
  home: string
  tmHome: string
  usluga: string
  /** Okolina kakvu vidi usluga (postavke čvora + varijable živog procesa). */
  env: Record<string, string | undefined>
  opisUsluge: (ime: string) => P.OpisStanjaUsluge
  procesi: () => P.Proces[]
  cwd: (pid: number) => string | null
  pidNaVratima: (vrata: number) => number | null
  okolinaProcesa: (pid: number, ime: string) => string | null
  /** HTTP statusni kod (0 = nema odgovora); `host` = zaglavlje Host. */
  http: (url: string, host?: string) => Promise<number>
  json: (url: string) => Promise<any | null>
  tcp: (host: string, port: number) => Promise<boolean>
  /** Vrijeme poslužitelja iz zaglavlja Date (ms) ili null — rezerva za M6 bez NTP podatka. */
  httpDatum?: (url: string) => Promise<number | null>
  citaj: (put: string) => string | null
  postoji: (put: string) => boolean
  sada: () => number
  realpath?: (put: string) => string
}

const TUDI_HOST = 'evil.example.invalid'
const VARIJABLE_USLUGE = ['TM_HOME', 'TM_PORT', 'TM_BIND', 'TM_ALLOWED_HOSTS', 'TM_FEATURES_FILE', 'TM_CREDENTIALS',
  'TM_MODEL_CONFIG', 'TM_SESSION_USAGE_SCRIPT', 'TM_IZVORNI_PODACI', 'TM_HINDSIGHT_URL', 'MEMORIJA_BANKA', 'OLLAMA_HOST', 'TM_SUSTAV_DIR']

const m = (id: string, naslov: string, sud: Sud, detalji: string[]): Mjerenje => ({ id, naslov, sud, detalji })
const najgori = (...s: Sud[]): Sud => s.includes('FAIL') ? 'FAIL' : s.includes('UPOZORENJE') ? 'UPOZORENJE' : 'PASS'

function stvarna(k: Kontekst, put: string): string {
  try { return (k.realpath ?? realpathSync)(put).replace(/\/+$/, '') } catch { return put.replace(/\/+$/, '') }
}
function jsonIz(k: Kontekst, put: string | undefined): any | null {
  if (!put) return null
  const t = k.citaj(put)
  if (t === null) return null
  try { return JSON.parse(t) } catch { return null }
}
/** Prva postojeća konfiguracija: varijabla usluge → $TM_HOME/config → paket (kao paths.konfigPutanja). */
function konfig(k: Kontekst, ime: string, envVar?: string): string | null {
  if (envVar && k.env[envVar]) return k.env[envVar]!
  for (const p of [join(k.tmHome, 'config', ime), join(k.paket, 'config', ime)]) if (k.postoji(p)) return p
  return null
}
function spremiste(k: Kontekst): string { return k.env.TM_CREDENTIALS || join(k.tmHome, 'config', 'credentials.env') }
function vrata(k: Kontekst): number { return Number(k.env.TM_PORT) || 17781 }
const jePloca = (cmd: string) => /(^|[\s/])src\/TaskWebUI\.ts(\s|$)/.test(cmd)

// ─── M1–M4: usluga ───────────────────────────────────────────────────────────

export async function m1(k: Kontekst): Promise<Mjerenje> {
  const u = k.opisUsluge(k.usluga)
  const izvor = P.naredbaOpisaUsluge(k.usluga, k.okolina)
  const d = [`${izvor} → stanje=${u.stanje} pid=${u.pid ?? '—'} radna mapa=${u.cwd ?? '—'}`]
  if (u.stanje !== 'active' || !u.pid) return m('M1', 'vlasnik usluge', 'FAIL', [...d, 'usluga ne radi pod upraviteljem sustava'])
  if (!u.cwd || stvarna(k, u.cwd) !== stvarna(k, k.paket))
    return m('M1', 'vlasnik usluge', 'FAIL', [...d, `upravitelj vodi uslugu iz ${u.cwd ?? '(nije zadano)'}, a paket je ${k.paket}`])
  return m('M1', 'vlasnik usluge', 'PASS', d)
}

export async function m2(k: Kontekst): Promise<Mjerenje> {
  const pid = k.opisUsluge(k.usluga).pid
  if (!pid) return m('M2', 'radna mapa procesa', 'FAIL', ['usluga nema glavni PID'])
  const c = k.cwd(pid)
  const cmd = k.procesi().find(p => p.pid === pid)?.cmd ?? ''
  const d = [`PID ${pid} cwd=${c ?? '—'}`, `naredba=${cmd || '—'}`]
  if (!c || stvarna(k, c) !== stvarna(k, k.paket)) return m('M2', 'radna mapa procesa', 'FAIL', [...d, `očekivano ${k.paket}`])
  if (!jePloca(cmd)) return m('M2', 'radna mapa procesa', 'FAIL', [...d, 'glavni proces nije ploča (src/TaskWebUI.ts)'])
  return m('M2', 'radna mapa procesa', 'PASS', d)
}

export async function m3(k: Kontekst): Promise<Mjerenje> {
  const v = vrata(k)
  const adrese = adreseVezanja(k.env.TM_BIND).adrese
  const adresa = adrese.includes(SVA_SUCELJA) || adrese.includes(PETLJA) ? PETLJA : adrese[0]
  const url = `http://${adresa.includes(':') ? `[${adresa}]` : adresa}:${v}/`
  const vlastiti = (k.env.TM_ALLOWED_HOSTS || '').split(',').map(s => s.trim()).find(Boolean) || adresa
  const hostZ = /:\d+$/.test(vlastiti) ? vlastiti : `${vlastiti}:${v}`
  const [h200, h403] = [await k.http(url, hostZ), await k.http(url, TUDI_HOST)]
  const d = [`${url} Host: ${hostZ} → ${h200 || 'nema odgovora'} (očekivano 200)`, `${url} Host: ${TUDI_HOST} → ${h403 || 'nema odgovora'} (očekivano 403)`]
  return m('M3', 'HTTP vlastiti/tuđi Host', h200 === 200 && h403 === 403 ? 'PASS' : 'FAIL', d)
}

export async function m4(k: Kontekst): Promise<Mjerenje> {
  const v = vrata(k)
  const glavni = k.opisUsluge(k.usluga).pid
  const tablica = k.procesi()
  const roditelj = new Map(tablica.map(p => [p.pid, p.ppid]))
  // potomak glavnog PID-a (omotač exec-a ili dijete); PPID=1 sam po sebi nije siroče (launchd je roditelj LaunchDaemona)
  const uUsluzi = (pid: number) => {
    for (let p: number | undefined = pid, i = 0; p && i < 64; p = roditelj.get(p), i++) if (p === glavni) return true
    return false
  }
  const d: string[] = []
  let sud: Sud = 'PASS'
  const drzi = k.pidNaVratima(v)
  if (drzi === null) { sud = 'FAIL'; d.push(`nitko ne sluša na vratima ${v}`) }
  else if (!glavni || !uUsluzi(drzi)) {
    sud = 'FAIL'
    d.push(`vrata ${v} drži PID ${drzi} (${tablica.find(p => p.pid === drzi)?.cmd ?? '?'}, PPID ${roditelj.get(drzi) ?? '?'}) — nije usluga${glavni ? ` (glavni PID ${glavni})` : ''}`)
  } else d.push(`vrata ${v} drži PID ${drzi} (usluga)`)
  const paket = stvarna(k, k.paket)
  const sirocad = tablica.filter(p => jePloca(p.cmd) && !(glavni && uUsluzi(p.pid)) && p.pid !== drzi)
    .filter(p => { const c = k.cwd(p.pid); return c !== null && stvarna(k, c) === paket })
  if (sirocad.length) { sud = 'FAIL'; d.push(`ploča iz paketa izvan usluge: ${sirocad.map(p => `PID ${p.pid} (PPID ${p.ppid})`).join(', ')}`) }
  else d.push('druge ploče iz paketa: nema')
  return m('M4', 'osirotjeli procesi na vratima', sud, d)
}

// ─── M5: model i mjerilo autonomije ──────────────────────────────────────────

export async function m5(k: Kontekst): Promise<Mjerenje> {
  const d: string[] = []
  const mcPut = konfig(k, 'model-config.json', 'TM_MODEL_CONFIG')
  const mc = jsonIz(k, mcPut ?? undefined)
  const tajne = k.citaj(spremiste(k)) ?? ''
  const iz = { os: k.os, env: k.env, home: k.home, uSpremistu: (t: string) => procitajIzTeksta(tajne, t) !== null, postoji: k.postoji }
  const prijavljeni: string[] = []
  const iskljuceni: string[] = []
  for (const dav of spojiSModelConfigom(mc)) {
    let s = stanjePrijave(dav, iz)
    if (dav.nacin === 'lokalno' && dav.ukljucen === true) {
      const baza = (k.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/+$/, '')
      if (await k.http(`${/^https?:/.test(baza) ? baza : `http://${baza}`}/api/tags`) === 200) s = { prijavljen: true, kako: `${baza} odgovara` }
    }
    if (!s.prijavljen) continue
    if (dav.ukljucen === false) iskljuceni.push(`${dav.id} (${s.kako})`)
    else prijavljeni.push(`${dav.id} (${s.kako})`)
  }
  let sud: Sud = 'PASS'
  if (prijavljeni.length) d.push(`prijavljen AI servis: ${prijavljeni.join(', ')}`)
  else {
    sud = 'UPOZORENJE'
    d.push(iskljuceni.length ? `prijavljen samo servis isključen u model-configu: ${iskljuceni.join(', ')}` : 'nijedan AI servis nije prijavljen (izbor servisa je korisnikov)')
    d.push(`prijava: bun ${k.paket}/scripts/prijava-ai.ts  ili ploča → Config → Prijava / Tajne`)
  }
  // mjerilo autonomije
  const ff = jsonIz(k, konfig(k, 'features.json', 'TM_FEATURES_FILE') ?? undefined)
  if (ff?.autonomyGate?.enabled !== true) { d.push('autonomyGate=false — mjerilo potrošnje nije potrebno'); return m('M5', 'model i mjerilo autonomije', sud, d) }
  const skripta = k.env.TM_SESSION_USAGE_SCRIPT || join(k.paket, 'tools', 'session_usage.py')
  if (!k.postoji(skripta)) return m('M5', 'model i mjerilo autonomije', 'FAIL', [...d, `autonomyGate uključen, a mjerila nema (${skripta}) — autonomija bi bila fail-open`])
  const kesevi = [join(k.tmHome, 'data', 'session_usage.cache.json'), k.env.TM_IZVORNI_PODACI && join(k.env.TM_IZVORNI_PODACI, 'session_usage.cache.json')]
    .filter((p): p is string => !!p).map(p => ({ p, j: jsonIz(k, p) })).filter(x => x.j && Number.isFinite(Number(x.j.cached_at)))
    .sort((a, b) => Number(b.j.cached_at) - Number(a.j.cached_at))
  if (!kesevi.length) return m('M5', 'model i mjerilo autonomije', 'FAIL', [...d, 'autonomyGate uključen, a mjerilo još nije ništa izmjerilo (nema session_usage.cache.json)'])
  const zadnje = kesevi[0]
  const starost = Math.round((k.sada() / 1000 - Number(zadnje.j.cached_at)) / 60)
  const greska = zadnje.j.entry?.http_error
  if (greska) return m('M5', 'model i mjerilo autonomije', 'FAIL', [...d, `mjerilo ne radi: zadnje mjerenje (prije ${starost} min) s HTTP greškom ${greska}`])
  d.push(`mjerilo radi: zadnje mjerenje prije ${starost} min (${zadnje.p})`)
  if (starost > 6 * 60) { d.push('mjerenje starije od 6 h'); sud = najgori(sud, 'UPOZORENJE') }
  return m('M5', 'model i mjerilo autonomije', sud, d)
}

// ─── M6: sat ─────────────────────────────────────────────────────────────────

const PRAG_SATA_S = 60

export async function m6(k: Kontekst): Promise<Mjerenje> {
  const ex = k.okolina.izvrsi ?? P.izvrsiZadano
  const d: string[] = []
  let sinkroniziran: boolean | null = null
  let odmak: number | null = null
  if (P.jeLinux(k.okolina)) {
    const t = ex(['timedatectl', 'show', '-p', 'NTPSynchronized', '--value'])?.trim()
    if (t) { sinkroniziran = t === 'yes'; d.push(`timedatectl NTPSynchronized=${t}`) }
  } else {
    const posluzitelj = k.env.TM_NTP_SERVER || (k.citaj('/etc/ntp.conf') ?? '').match(/^\s*server\s+(\S+)/m)?.[1] || 'time.apple.com'
    const out = ex(['sntp', '-t', '5', posluzitelj])
    const o = Number(out?.trim().split('\n').pop()?.match(/^([+-]?\d+(?:\.\d+)?)\s/)?.[1])
    if (out && Number.isFinite(o)) { odmak = o; sinkroniziran = true; d.push(`sntp ${posluzitelj}: odstupanje ${o.toFixed(3)} s`) }
  }
  if (odmak === null && sinkroniziran !== true) {
    const url = k.env.TM_SAT_URL || 'https://www.cloudflare.com'
    const t = await (k.httpDatum ?? httpDatumZadano)(url)
    if (t !== null) { odmak = (k.sada() - t) / 1000; d.push(`HTTP Date ${url}: odstupanje ${Math.round(odmak)} s`) }
  }
  if (odmak !== null && Math.abs(odmak) > PRAG_SATA_S)
    return m('M6', 'sat', 'UPOZORENJE', [...d, `sat odstupa ${Math.round(Math.abs(odmak))} s (≈ ${(Math.abs(odmak) / 3600).toFixed(1)} h) > ${PRAG_SATA_S} s`])
  if (sinkroniziran === true) return m('M6', 'sat', 'PASS', d)
  if (sinkroniziran === false) return m('M6', 'sat', 'UPOZORENJE', [...d, 'NTP nije uključen/sinkroniziran — sat će se razići (uključi: timedatectl set-ntp true)'])
  return m('M6', 'sat', odmak !== null ? 'PASS' : 'UPOZORENJE', odmak !== null ? d : [...d, 'sat se nije mogao provjeriti (nema NTP podatka ni mreže)'])
}

// ─── M7: memorija i RAG ──────────────────────────────────────────────────────

type Izvor = 'nasa' | 'lokalna' | 'iskljuceno'
const IZVORI: Izvor[] = ['nasa', 'lokalna', 'iskljuceno']

export async function m7(k: Kontekst): Promise<Mjerenje> {
  const d: string[] = []
  const sudovi: Sud[] = []
  const put = join(k.tmHome, 'config', 'memorija.json')
  const mj = jsonIz(k, put)
  const mcPut = konfig(k, 'memory-config.json', 'TM_MEMORY_CONFIG')
  const mc = jsonIz(k, mcPut ?? undefined)
  let memIzvor: Izvor, ragIzvor: Izvor
  if (mj) {
    memIzvor = IZVORI.includes(mj.memorija?.izvor) ? mj.memorija.izvor : 'iskljuceno'
    ragIzvor = IZVORI.includes(mj.rag?.izvor) ? mj.rag.izvor : 'iskljuceno'
    d.push(`${put}: memorija.izvor=${memIzvor}, rag.izvor=${ragIzvor}`)
  } else {
    memIzvor = k.env.TM_HINDSIGHT_URL || k.env.MEMORIJA_BANKA ? 'nasa' : 'iskljuceno'
    ragIzvor = mc?.rag?.enabled === true ? 'nasa' : 'iskljuceno'
    d.push(`memorija.json ne postoji — izvedeno iz postavki: memorija=${memIzvor} (MEMORIJA_BANKA/TM_HINDSIGHT_URL), rag=${ragIzvor} (memory-config rag.enabled)`)
  }

  // memorija
  const mem = mj?.memorija ?? {}
  if (memIzvor === 'nasa') {
    const url = mj ? `http://${mem.nasa?.host || '127.0.0.1'}:${mem.nasa?.port || 17792}` : (k.env.TM_HINDSIGHT_URL || 'http://127.0.0.1:17792').replace(/\/+$/, '')
    const h = await k.http(`${url}/health`)
    if (h === 200) { sudovi.push('PASS'); d.push(`memorija nasa: ${url}/health → 200`) }
    else { sudovi.push('UPOZORENJE'); d.push(`memorija nasa: ${url}/health → ${h || 'nema odgovora'} — dijeljeni izvor nedostupan, čvor radi dalje (fail-safe)`) }
  } else if (memIzvor === 'lokalna') {
    const usl = mem.lokalna?.usluga || 'regoc-hindsight'
    const url = `http://${mem.lokalna?.host || '127.0.0.1'}:${mem.lokalna?.port || 17796}`
    const u = k.opisUsluge(usl)
    const h = await k.http(`${url}/health`)
    if (u.stanje !== 'active' || h !== 200) { sudovi.push('FAIL'); d.push(`memorija lokalna: usluga ${usl}=${u.stanje}, ${url}/health → ${h || 'nema odgovora'}`) }
    else {
      const banka = mem.lokalna?.banka || k.env.MEMORIJA_BANKA
      const banke: any[] = (await k.json(`${url}/v1/default/banks`))?.banks ?? []
      const izbor = banka ? banke.filter(b => b?.bank_id === banka) : banke
      const broj = izbor.reduce((s, b) => s + (Number(b?.fact_count) || 0), 0)
      if (broj > 0) { sudovi.push('PASS'); d.push(`memorija lokalna: ${usl} radi, banka ${banka ?? '(sve)'} ima ${broj} memorija`) }
      else { sudovi.push('FAIL'); d.push(`memorija lokalna: banka ${banka ?? '(nijedna)'} je prazna ili je nema — prekidač lokalna traži uvezenu banku (K11)`) }
    }
  } else { sudovi.push('PASS'); d.push('memorija: isključena') }
  if (memIzvor !== 'lokalna') {
    const usl = mem.lokalna?.usluga || 'regoc-hindsight'
    if (k.opisUsluge(usl).stanje === 'active') { sudovi.push('FAIL'); d.push(`lokalni Hindsight (${usl}) radi, a izvor nije lokalna — troši RAM/CPU u mirovanju`) }
  }

  // RAG
  const rag = mj?.rag ?? {}
  if (ragIzvor === 'nasa') {
    const host = mj ? rag.nasa?.host || '127.0.0.1' : mc?.rag?.chromaHost || '127.0.0.1'
    const port = Number(mj ? rag.nasa?.port || 15432 : mc?.rag?.chromaPort || 18765)
    const ok = await k.tcp(host, port)
    const ugr = mj ? (rag.nasa?.ollama || 'http://127.0.0.1:11434') : null
    const okUgr = ugr ? await k.http(`${ugr.replace(/\/+$/, '')}/api/tags`) === 200 : true
    d.push(`rag nasa: ${host}:${port} ${ok ? 'odgovara' : 'ne odgovara'}${ugr ? `, ugrađivanje ${ugr} ${okUgr ? 'odgovara' : 'ne odgovara'}` : ''}`)
    sudovi.push(ok && okUgr ? 'PASS' : 'UPOZORENJE')
    if (!(ok && okUgr)) d.push('dijeljeni RAG nedostupan — čvor radi dalje bez njega (fail-safe)')
  } else if (ragIzvor === 'lokalna') {
    const l = rag.lokalna ?? {}
    const usl = l.usluga || 'regoc-pgvector'
    const host = l.host || '127.0.0.1', port = Number(l.port || 15433)
    if (!(await k.tcp(host, port))) { sudovi.push('FAIL'); d.push(`rag lokalna: pgvector ${host}:${port} ne odgovara (usluga ${usl}=${k.opisUsluge(usl).stanje})`) }
    else {
      const bin = jsonIz(k, join(k.tmHome, 'rag', 'spremno.json'))?.bin
      const psql = bin ? join(bin, 'psql') : null
      const lozinka = procitajIzTeksta(k.citaj(spremiste(k)) ?? '', l.lozinkaEnv || 'TM_PGVECTOR_LOKALNA_PASSWORD')
      const ver = psql && k.postoji(psql) && lozinka
        ? (k.okolina.izvrsi ?? P.izvrsiZadano)([psql, '-h', host, '-p', String(port), '-U', l.korisnik || 'rag', '-d', l.baza || 'rag', '-tAc',
          "SELECT extversion FROM pg_extension WHERE extname='vector'"], { PGPASSWORD: lozinka, PGCONNECT_TIMEOUT: '5' })?.trim()
        : null
      if (ver) { sudovi.push('PASS'); d.push(`rag lokalna: ${host}:${port} vector ${ver}`) }
      else { sudovi.push(psql && lozinka ? 'FAIL' : 'UPOZORENJE'); d.push(`rag lokalna: ${host}:${port} odgovara, ali ekstenzija vector nije potvrđena${psql && lozinka ? '' : ' (nema psql iz spremno.json ili lozinke u spremištu)'}`) }
    }
  } else {
    sudovi.push('PASS'); d.push('rag: isključen')
    if (mc?.rag?.enabled === true && mj) { sudovi.push('FAIL'); d.push(`rag.izvor=iskljuceno, a ${mcPut} ima rag.enabled=true`) }
  }
  if (ragIzvor !== 'lokalna') {
    const usl = rag.lokalna?.usluga || 'regoc-pgvector'
    if (k.opisUsluge(usl).stanje === 'active') { sudovi.push('FAIL'); d.push(`lokalni pgvector (${usl}) radi, a rag.izvor nije lokalna — troši RAM/CPU u mirovanju`) }
  }
  return m('M7', 'izvori memorije i RAG-a', najgori(...sudovi), d)
}

// ─── sastavljanje ────────────────────────────────────────────────────────────

/** Daje li izlaz `sudo -n -l` neograničen sudo bez lozinke (`(ALL) NOPASSWD: ALL`, `(ALL : ALL) …`, `(root) …`). Isti uzorak ima install.sh. */
export function neogranicenSudo(izlaz: string): boolean {
  return /^\s*\((ALL|root)(\s*:\s*ALL)?\)\s+([A-Z_]+:\s*)*NOPASSWD:\s*([A-Z_]+:\s*)*ALL\s*$/m.test(izlaz)
}

/** M8: korisnik usluge (bootcheck radi kao on) nema neograničen sudo — K5 V1. Upozorenje, nikad pad. */
export async function m8(k: Kontekst): Promise<Mjerenje> {
  const out = (k.okolina.izvrsi ?? P.izvrsiZadano)(['sudo', '-n', '-l'])
  if (out !== null && neogranicenSudo(out))
    return m('M8', 'ovlasti korisnika usluge', 'UPOZORENJE', ['korisnik usluge ima neograničen sudo (NOPASSWD: ALL) — ploča nema autentikacije, pa je pristup ploči put do root-a',
      'zamijeni ga suženim: bun scripts/instalacija/servis.ts sudoers --korisnik IME (templates/servis/sudoers.primjer, docs/INSTALL.md §2.4)'])
  return m('M8', 'ovlasti korisnika usluge', 'PASS', [out === null ? 'sudo -n -l: bez ovlasti bez lozinke' : 'sudo -n -l: bez NOPASSWD: ALL'])
}

// ─── M9: tajne kompleta (TASK-5705, uputa #441) ──────────────────────────────

/**
 * Komplet (TM_SUSTAV_DIR iz instalacija.env) nosi TAJNE.json: imena tajni koje njegov kod čita.
 * Ovdje se broji koja još nisu upisana u spremište čvora (ili okolinu usluge) — samo IMENA i što
 * bez njih ne radi. Nijedna nije uvjet da čvor radi, pa je nedostatak UPOZORENJE, ne pad.
 */
export async function m9(k: Kontekst): Promise<Mjerenje> {
  const N = 'tajne kompleta'
  const dir = (k.env.TM_SUSTAV_DIR || '').trim()
  if (!dir) return m('M9', N, 'PASS', ['komplet nije instaliran (install.sh bez --komplet)'])
  const reg = jsonIz(k, join(dir, 'TAJNE.json'))
  if (!Array.isArray(reg?.tajne)) return m('M9', N, 'UPOZORENJE', [`${join(dir, 'TAJNE.json')} nije čitljiv — popis tajni kompleta nepoznat`])
  const tekst = k.citaj(spremiste(k)) ?? ''
  const fale = (reg.tajne as any[]).filter(t => typeof t?.ime === 'string' && !k.env[t.ime] && procitajIzTeksta(tekst, t.ime) === null)
  const ukupno = reg.tajne.length
  if (!fale.length) return m('M9', N, 'PASS', [`upisano ${ukupno}/${ukupno}`])
  return m('M9', N, 'UPOZORENJE', [
    `upisano ${ukupno - fale.length}/${ukupno}; nedostaju (samo imena):`,
    ...fale.map(t => `${t.ime}${t.obavezno ? ' (obavezna)' : ''} — bez nje: ${t.bez_nje?.hr ?? '?'}`),
    'upis: ploča → Config → Tajne (regoc-system/README.md, „Tajne nakon instalacije")',
  ])
}

export function verdikt(mj: Mjerenje[], strogo = false): Sud {
  const s = najgori(...mj.map(x => x.sud))
  return s === 'FAIL' || (strogo && s === 'UPOZORENJE') ? 'FAIL' : 'PASS'
}

export async function pokreni(k: Kontekst, strogo = false): Promise<Omit<Izvjestaj, 'host' | 'vrijeme' | 'vrsta'> & { verdikt: Sud }> {
  const mjerenja: Mjerenje[] = []
  for (const f of [m1, m2, m3, m4, m5, m6, m7, m8, m9]) {
    try { mjerenja.push(await f(k)) } catch (e: any) { mjerenja.push(m(`M${mjerenja.length + 1}`, 'greška mjerenja', 'FAIL', [String(e?.message ?? e)])) }
  }
  return { os: k.os, paket: k.paket, usluga: k.usluga, mjerenja, verdikt: verdikt(mjerenja, strogo) }
}

async function httpZadano(url: string, host?: string): Promise<number> {
  const out = P.izvrsiZadano(['curl', '-s', '-o', '/dev/null', '-m', '8', '-w', '%{http_code}', ...(host ? ['-H', `Host: ${host}`] : []), url])
  return Number(out?.trim()) || 0
}
async function jsonZadano(url: string): Promise<any | null> {
  const out = P.izvrsiZadano(['curl', '-s', '-m', '8', url])
  try { return out ? JSON.parse(out) : null } catch { return null }
}
async function tcpZadano(host: string, port: number): Promise<boolean> {
  return await new Promise<boolean>(res => {
    const t = setTimeout(() => res(false), 3000)
    Bun.connect({ hostname: host, port, socket: { open(s) { clearTimeout(t); s.end(); res(true) }, data() {}, error() { clearTimeout(t); res(false) }, connectError() { clearTimeout(t); res(false) } } })
      .catch(() => { clearTimeout(t); res(false) })
  })
}
async function httpDatumZadano(url: string): Promise<number | null> {
  const out = P.izvrsiZadano(['curl', '-sI', '-m', '5', url])
  const t = out?.match(/^date:\s*(.+)$/im)?.[1]
  const ms = t ? Date.parse(t.trim()) : NaN
  return Number.isFinite(ms) ? ms : null
}

/** Kontekst sa stvarnim izvorima; sve se može podmetnuti (testovi, drugi OS). */
export function napraviKontekst(p: Partial<Kontekst> = {}): Kontekst {
  const okolina = p.okolina ?? {}
  const os = p.os ?? okolina.os ?? process.platform
  const home = p.home ?? (process.env.HOME || homedir())
  const env = { ...(p.env ?? process.env) }
  const k: Kontekst = {
    os, okolina, home, env,
    paket: p.paket ?? join(import.meta.dir, '..'),
    tmHome: p.tmHome ?? (env.TM_HOME || join(home, '.taskmanager')),
    usluga: p.usluga ?? 'regoc-taskmanager',
    opisUsluge: p.opisUsluge ?? (ime => P.opisUsluge(ime, okolina)),
    procesi: p.procesi ?? (() => P.procesi(okolina)),
    cwd: p.cwd ?? (pid => P.cwd(pid, okolina)),
    pidNaVratima: p.pidNaVratima ?? (v => P.pidNaVratima(v, okolina)),
    okolinaProcesa: p.okolinaProcesa ?? ((pid, ime) => P.okolinaProcesa(pid, ime, okolina)),
    http: p.http ?? httpZadano,
    json: p.json ?? jsonZadano,
    tcp: p.tcp ?? tcpZadano,
    httpDatum: p.httpDatum ?? httpDatumZadano,
    citaj: p.citaj ?? (put => { try { return readFileSync(put, 'utf-8') } catch { return null } }),
    postoji: p.postoji ?? existsSync,
    sada: p.sada ?? Date.now,
    realpath: p.realpath,
  }
  // okolina žive usluge ima prednost: bootcheck mjeri ono što vidi ploča
  const pid = k.opisUsluge(k.usluga).pid
  if (pid) for (const ime of VARIJABLE_USLUGE) { const v = k.okolinaProcesa(pid, ime); if (v !== null && v !== '') k.env[ime] = v }
  if (!p.tmHome && k.env.TM_HOME) k.tmHome = k.env.TM_HOME
  return k
}

export function tekst(iz: Izvjestaj): string {
  const r = [`=== BOOTCHECK TaskManagerAI (plan Mac v3 K4) ===`,
    `host=${iz.host} os=${iz.os} vrsta=${iz.vrsta} vrijeme=${iz.vrijeme}`, `paket=${iz.paket} usluga=${iz.usluga}`, '']
  for (const x of iz.mjerenja) {
    r.push(`${x.id} ${x.naslov.padEnd(30)} ${x.sud}`)
    for (const d of x.detalji) r.push(`     ${d}`)
  }
  const upoz = iz.mjerenja.filter(x => x.sud === 'UPOZORENJE').map(x => x.id)
  r.push('', `=== SUD: ${iz.mjerenja.map(x => `${x.id}=${x.sud}`).join(' ')} ===`,
    `VERDIKT: ${iz.verdikt}${upoz.length && iz.verdikt === 'PASS' ? ` (upozorenja: ${upoz.join(', ')})` : ''}`)
  return r.join('\n') + '\n'
}

function uptimeS(k: Kontekst): number {
  return Math.round((k.sada() - P.bootMs(k.okolina)) / 1000)
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const vrijednost = (i: number) => { const v = args[i + 1]; if (v === undefined) { console.error(`nedostaje vrijednost za ${args[i]}`); process.exit(2) } return v }
  let json = false, strogo = false, zapis = true, cekaj = 60
  const p: Partial<Kontekst> = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--json') json = true
    else if (a === '--strogo') strogo = true
    else if (a === '--bez-zapisa') zapis = false
    else if (a === '--cekaj') { cekaj = Number(vrijednost(i)); i++ }
    else if (a === '--usluga') { p.usluga = vrijednost(i); i++ }
    else if (a === '--paket') { p.paket = vrijednost(i); i++ }
    else if (a === '-h' || a === '--help') { console.log(readFileSync(import.meta.path, 'utf-8').split('*/')[0].replace(/^#!.*\n\/\*\*\n?/, '').replace(/^ \* ?/gm, '')); process.exit(0) }
    else { console.error(`bootcheck: nepoznata opcija ${a} (--help)`); process.exit(2) }
  }
  if (!Number.isFinite(cekaj) || cekaj < 0) { console.error('bootcheck: --cekaj traži broj sekundi'); process.exit(2) }
  const k = napraviKontekst(p)
  // usluga se pri bootu diže paralelno — pričekaj da otvori vrata, ali je NE pokreći
  for (const kraj = Date.now() + cekaj * 1000; Date.now() < kraj;) {
    if (await k.http(`http://127.0.0.1:${vrata(k)}/health`) === 200) break
    await Bun.sleep(2000)
  }
  const up = uptimeS(k)
  const r = await pokreni(k, strogo)
  const iz: Izvjestaj = { host: hostname(), vrijeme: new Date(k.sada()).toISOString(), vrsta: up >= 0 && up < 600 ? 'POST-BOOT' : 'RUCNO', ...r }
  const t = tekst(iz)
  if (zapis) {
    try {
      const dir = join(k.tmHome, 'log', 'bootcheck')
      mkdirSync(dir, { recursive: true })
      const ime = join(dir, `${iz.vrsta}_${iz.vrijeme.replace(/[-:]/g, '').replace(/\..*$/, '')}`)
      writeFileSync(`${ime}.txt`, t); writeFileSync(`${ime}.json`, JSON.stringify(iz, null, 2) + '\n')
      copyFileSync(`${ime}.txt`, join(dir, 'zadnji.txt')); copyFileSync(`${ime}.json`, join(dir, 'zadnji.json'))
    } catch (e: any) { console.error(`bootcheck: zapis nije spremljen (${e?.message ?? e})`) }
  }
  process.stdout.write(json ? JSON.stringify(iz, null, 2) + '\n' : t)
  process.exit(iz.verdikt === 'PASS' ? 0 : 1)
}
