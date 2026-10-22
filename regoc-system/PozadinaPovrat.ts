#!/usr/bin/env bun
/**
 * PozadinaPovrat — pozadinski posao drži zadatak, a sustav ga sam vraća kad posao završi.
 *
 * TASK-5259 (REGOC_SYSTEM, Goran 05.10.2026., opcija B). Pravilo je OVDJE (čiste funkcije +
 * prolaz s ubrizganim ovisnostima); RegocDaemon i SpawnFinalizer samo zovu
 * `registrirajPozadinu` pri zatvaranju u `blocked` i `prolazPozadine` iz glavne petlje.
 *
 * Povod (TASK-5250): agent je pokrenuo dugi lanac u pozadini (PID 3544782/3544783) i pošteno
 * javio BLOCKED. Zadatak je otišao u `blocked` (declared_not_done) i tu bi ostao zauvijek:
 * /reclaim iz `blocked` smiju samo `revizija-blokiranih` i `goran`, a živa revizija je ugašena
 * (TASK-5204). Privremeno ga je čuvao ručni čekač `p_vrati_kad_gotovo.sh` — ovo je taj čekač
 * pretvoren u pravilo.
 *
 * UGOVOR ZA AGENTA (redak IZNAD zadnjeg `REGOC-STATUS: BLOCKED — …`):
 *   REGOC-POZADINA: pid=<PID>[,<PID>…] [gotovo=<datoteka>:<tekst>] [rok=<sati>]
 * ili polje `"pozadina": {"pid":[…], "gotovo":"<datoteka>:<tekst>", "rok":<sati>}` u REGOC-IZLAZ.
 *
 * OKIDAČI POVRATA (prvi koji vrijedi):
 *   `gotovo`  — datoteka postoji (i sadrži tekst, ako je zadan)
 *   `pidovi`  — svi navedeni PID-ovi su mrtvi (PID se uspoređuje sa starttime-om iz
 *               oznakom starta (platforma.oznakaStarta) zabilježenom pri upisu — ponovno iskorišten PID je mrtav)
 *   `rok`     — prošao je rok (zadano 48 h, najviše 168 h)
 * Povrat ide kroz `POST /api/tasks/:id/reclaim {from:'blocked', by:'pozadina-gotova'}`, dakle
 * u `pending`; spawn tada ide uobičajenim putem (vrata autonomije, strop usporednih agenata).
 * Ručna kočnica (globalna i po zadatku) zadržava povrat. Najviše `stropPovrata` (5) povrata
 * po zadatku, pa zadatak ostaje `blocked` s razlogom „strop”.
 *
 * Najam (`data/pozadina/<taskId>.json`) i brojač (`data/pozadina_brojac.json`) su u DATOTECI:
 * dugi posao preživljava restart daemona, pa ga mora preživjeti i najam.
 *
 * Autor: Jelena (Engineer) · 2026-10-05
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, appendFileSync, openSync, readSync, closeSync, fstatSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { oznakaStarta } from './lib/platforma'

const HOME = process.env.HOME || homedir()
const REGOC = join(HOME, '.claude', 'regoc')
export const POZADINA_DIR = join(REGOC, 'data', 'pozadina')
export const POZADINA_BROJAC_PATH = join(REGOC, 'data', 'pozadina_brojac.json')
export const POZADINA_LOG_PATH = join(REGOC, 'data', 'pozadina_povrat.jsonl')
export const POZADINA_CONFIG_PATH = join(REGOC, 'config', 'pozadina-povrat.json')
/** Oznaka na ploči: zadatak je blocked jer čeka vlastiti pozadinski posao, ne čovjeka. */
export const OZNAKA_CEKA_POZADINU = 'ceka-pozadinu'
/** Ovlašteni pozivatelj `/reclaim` iz `blocked` (TaskWebUI RECLAIM_IZ_BLOCKED_SMIJU). */
export const RECLAIM_BY_POZADINA = 'pozadina-gotova'

const H = 3600_000
/** Zapis brojača stariji od ovoga se ne broji (dugi treninzi traju danima, pa 30 d). */
const BROJAC_VRIJEDI_MS = 30 * 24 * H
/** Iz datoteke uvjeta gotovosti čita se samo rep (dnevnici treninga znaju imati stotine MB). */
const REP_DATOTEKE_B = 1024 * 1024

// ============================================
// KONFIGURACIJA
// ============================================

export interface PozadinaConfig {
  /** Razmak prolaza petlje u daemonu. */
  razmakSekundi: number
  /** Rok kad ga agent ne navede. */
  zadaniRokSati: number
  /** Gornja granica roka (agent ne može zadatak zaključati na mjesec dana). */
  maxRokSati: number
  /** Najviše povrata po zadatku; sljedeći okidač ostavlja zadatak u `blocked`. */
  stropPovrata: number
  /** Najviše PID-ova u jednom najmu. */
  maxPidova: number
}

export const DEFAULT_POZADINA_CONFIG: PozadinaConfig = {
  razmakSekundi: 120,
  zadaniRokSati: 48,
  maxRokSati: 168,
  stropPovrata: 5,
  maxPidova: 16,
}

function poz(v: unknown, d: number): number {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : d
}

/** Nedostajuća ili pokvarena datoteka → zadano; nikad ne baca. */
export function ucitajPozadinaConfig(path: string = POZADINA_CONFIG_PATH): PozadinaConfig {
  const d = DEFAULT_POZADINA_CONFIG
  let raw: any = {}
  try { if (existsSync(path)) raw = JSON.parse(readFileSync(path, 'utf-8')) || {} } catch { raw = {} }
  return {
    razmakSekundi: poz(raw.razmakSekundi, d.razmakSekundi),
    zadaniRokSati: poz(raw.zadaniRokSati, d.zadaniRokSati),
    maxRokSati: poz(raw.maxRokSati, d.maxRokSati),
    stropPovrata: poz(raw.stropPovrata, d.stropPovrata),
    maxPidova: poz(raw.maxPidova, d.maxPidova),
  }
}

// ============================================
// PARSIRANJE UGOVORA
// ============================================

export interface UvjetGotovosti { datoteka: string; tekst: string }

export interface PozadinaDeklaracija {
  pidovi: number[]
  gotovo: UvjetGotovosti | null
  rokSati: number | null
}

function prosiriPutanju(p: string): string {
  const s = p.trim().replace(/^["'`]+|["'`]+$/g, '')
  if (s === '~') return HOME
  if (s.startsWith('~/')) return join(HOME, s.slice(2))
  if (s.startsWith('$HOME/')) return join(HOME, s.slice(6))
  return s
}

function parsirajPidove(v: unknown): number[] {
  const izvor = Array.isArray(v) ? v.map(String) : String(v ?? '').split(/[,\s]+/)
  const out: number[] = []
  for (const x of izvor) {
    if (!/^\d+$/.test(x.trim())) continue
    const n = Number(x)
    // 0 = „cijela grupa”, 1 = init: nijedan nije agentov pozadinski posao
    if (n > 1 && !out.includes(n)) out.push(n)
  }
  return out
}

function parsirajGotovo(v: unknown): UvjetGotovosti | null {
  if (v && typeof v === 'object') {
    const o = v as any
    const datoteka = typeof o.datoteka === 'string' ? o.datoteka : (typeof o.file === 'string' ? o.file : '')
    if (!datoteka.trim()) return null
    return { datoteka: prosiriPutanju(datoteka), tekst: typeof o.tekst === 'string' ? o.tekst.trim() : '' }
  }
  const s = String(v ?? '').trim().replace(/^["'`]+|["'`]+$/g, '')
  if (!s) return null
  const i = s.indexOf(':')
  const datoteka = i < 0 ? s : s.slice(0, i)
  if (!datoteka.trim()) return null
  return { datoteka: prosiriPutanju(datoteka), tekst: i < 0 ? '' : s.slice(i + 1).trim() }
}

function parsirajRok(v: unknown): number | null {
  const m = String(v ?? '').trim().match(/^(\d+(?:[.,]\d+)?)\s*h?$/i)
  if (!m) return null
  const n = Number(m[1].replace(',', '.'))
  return Number.isFinite(n) && n > 0 ? n : null
}

function izgradi(pidovi: number[], gotovo: UvjetGotovosti | null, rokSati: number | null): PozadinaDeklaracija | null {
  if (pidovi.length === 0 && !gotovo) return null
  return { pidovi, gotovo, rokSati }
}

/** `REGOC-POZADINA: …` (zadnji redak vrijedi) ili polje `pozadina` u REGOC-IZLAZ JSON-u. */
export function parsirajPozadinu(text: string): PozadinaDeklaracija | null {
  if (!text) return null
  const retci = text.split('\n')
  for (let i = retci.length - 1; i >= 0; i--) {
    const m = retci[i].match(/REGOC-POZADINA\s*:\s*(.*)$/)
    if (!m) continue
    const ostatak = m[1].replace(/[`*]+\s*$/, '').trim()
    const vrijednosti: Record<string, string> = {}
    const kljucevi = [...ostatak.matchAll(/(?:^|\s)(pid|pids|pidovi|gotovo|rok)=/gi)]
    kljucevi.forEach((k, j) => {
      const pocetak = (k.index ?? 0) + k[0].length
      const kraj = j + 1 < kljucevi.length ? (kljucevi[j + 1].index ?? ostatak.length) : ostatak.length
      vrijednosti[k[1].toLowerCase().startsWith('pid') ? 'pid' : k[1].toLowerCase()] = ostatak.slice(pocetak, kraj).trim()
    })
    return izgradi(parsirajPidove(vrijednosti.pid), parsirajGotovo(vrijednosti.gotovo), parsirajRok(vrijednosti.rok))
  }
  // REGOC-IZLAZ JSON (zadnji ```json blok s poljem `pozadina`)
  const blokovi = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)]
  for (let i = blokovi.length - 1; i >= 0; i--) {
    try {
      const o = JSON.parse(blokovi[i][1])
      const p = o?.pozadina
      if (!p || typeof p !== 'object') continue
      return izgradi(parsirajPidove(p.pid ?? p.pidovi ?? p.pids), parsirajGotovo(p.gotovo), parsirajRok(p.rok))
    } catch { /* nije JSON */ }
  }
  return null
}

// ============================================
// PROCESI (pid reuse kroz starttime)
// ============================================

export type CitajStarttime = (pid: number) => string | null

/**
 * Oznaka starta procesa (platforma.oznakaStarta): na Linuxu polje 22 procfs stat-a u
 * otkucajima (isti oblik kao ranije zapisi), na macOS-u sekunde epohe iz `ps lstart`.
 * Zombi je završen proces → `null`. `procRoot` podmeću samo testovi (lažno procfs stablo).
 */
export function procitajStarttime(pid: number, procRoot?: string): string | null {
  return oznakaStarta(pid, procRoot ? { procRoot } : undefined)
}

export interface PozadinaPid { pid: number; starttime: string | null }

export function pidZiv(p: PozadinaPid, citaj: CitajStarttime = procitajStarttime): boolean {
  if (!p.starttime) return false
  const sad = citaj(p.pid)
  return sad !== null && sad === p.starttime
}

/** Rep datoteke (najviše 1 MB) — `null` kad datoteke nema. */
function repDatoteke(path: string): string | null {
  let fd = -1
  try {
    fd = openSync(path, 'r')
    const vel = fstatSync(fd).size
    const n = Math.min(vel, REP_DATOTEKE_B)
    const buf = Buffer.alloc(n)
    readSync(fd, buf, 0, n, vel - n)
    return buf.toString('utf-8')
  } catch { return null } finally { if (fd >= 0) try { closeSync(fd) } catch {} }
}

export function gotovoIspunjeno(g: UvjetGotovosti, citaj: (p: string) => string | null = repDatoteke): boolean {
  const s = citaj(g.datoteka)
  if (s === null) return false
  return !g.tekst || s.includes(g.tekst)
}

// ============================================
// NAJAM (durabilan)
// ============================================

export interface PozadinaNajam {
  taskId: string
  agent: string
  pidovi: PozadinaPid[]
  gotovo: UvjetGotovosti | null
  rokSati: number
  rokDoMs: number
  registriranoMs: number
  registrirano: string
  izvor: string
}

export function napraviNajam(
  taskId: string, agent: string, d: PozadinaDeklaracija, cfg: PozadinaConfig, now: number,
  citaj: CitajStarttime = procitajStarttime, izvor = 'spawn',
): PozadinaNajam {
  const rokSati = Math.min(d.rokSati ?? cfg.zadaniRokSati, cfg.maxRokSati)
  return {
    taskId, agent,
    pidovi: d.pidovi.slice(0, cfg.maxPidova).map(pid => ({ pid, starttime: citaj(pid) })),
    gotovo: d.gotovo, rokSati, rokDoMs: now + rokSati * H,
    registriranoMs: now, registrirano: new Date(now).toISOString(), izvor,
  }
}

const sigurnoIme = (taskId: string) => taskId.replace(/[^A-Za-z0-9_-]/g, '_')

export function zapisiNajam(dir: string, n: PozadinaNajam): void {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${sigurnoIme(n.taskId)}.json`)
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(n, null, 2))
  renameSync(tmp, path)
}

export function obrisiNajam(dir: string, taskId: string): void {
  try { unlinkSync(join(dir, `${sigurnoIme(taskId)}.json`)) } catch { /* već ga nema */ }
}

/** Svi valjani najmovi; pokvarena datoteka se preskače (nikad ne baca). */
export function ucitajNajmove(dir: string): PozadinaNajam[] {
  const out: PozadinaNajam[] = []
  let imena: string[] = []
  try { imena = readdirSync(dir).filter(f => f.endsWith('.json')) } catch { return out }
  for (const f of imena) {
    try {
      const n = JSON.parse(readFileSync(join(dir, f), 'utf-8'))
      if (!n || typeof n.taskId !== 'string' || !Array.isArray(n.pidovi) || !Number.isFinite(n.rokDoMs)) continue
      out.push(n as PozadinaNajam)
    } catch { /* pokvaren zapis */ }
  }
  return out
}

// ============================================
// BROJAČ POVRATA (durabilan)
// ============================================

export function ucitajBrojacPovrata(path: string = POZADINA_BROJAC_PATH, now: number = Date.now()): Map<string, number> {
  const out = new Map<string, number>()
  try {
    if (!existsSync(path)) return out
    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    if (!raw || typeof raw !== 'object') return out
    for (const [id, v] of Object.entries(raw as Record<string, any>)) {
      const broj = Number(v?.broj)
      const t = Date.parse(v?.zadnji)
      if (!Number.isFinite(broj) || broj <= 0) continue
      if (Number.isFinite(t) && now - t > BROJAC_VRIJEDI_MS) continue
      out.set(id, broj)
    }
  } catch { /* pokvaren brojač → od nule */ }
  return out
}

export function zabiljeziPovrat(path: string, taskId: string, broj: number, now: number = Date.now()): void {
  try {
    let raw: Record<string, any> = {}
    try { if (existsSync(path)) raw = JSON.parse(readFileSync(path, 'utf-8')) || {} } catch { raw = {} }
    for (const [id, v] of Object.entries(raw)) {
      const t = Date.parse(v?.zadnji)
      if (!Number.isFinite(t) || now - t > BROJAC_VRIJEDI_MS) delete raw[id]
    }
    raw[taskId] = { broj, zadnji: new Date(now).toISOString() }
    mkdirSync(join(path, '..'), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(raw, null, 2))
    renameSync(tmp, path)
  } catch { /* pomoćni zapis */ }
}

// ============================================
// ODLUKA (čista funkcija)
// ============================================

/**
 * `nije`     = zadatak više nije blocked (netko ga je već vratio/zatvorio) → najam se briše
 * `ceka`     = posao još radi, rok nije prošao
 * `kocnica`  = okidač je tu, ali ručna kočnica (globalna ili po zadatku) drži → ne diram
 * `vrati`    = /reclaim from:blocked → pending
 * `odustani` = strop povrata → ostaje blocked s razlogom, najam se briše
 */
export type PozadinaPresuda = 'nije' | 'ceka' | 'kocnica' | 'vrati' | 'odustani'
export type PozadinaOkidac = 'gotovo' | 'pidovi' | 'rok'

export interface PozadinaUlaz {
  now: number
  status: string
  paused?: boolean | number | string | null
  globalnaPauza: boolean
  /** Koliko je PID-ova iz najma još živo (starttime se slaže). */
  ziviPidovi: number
  gotovo: boolean
  dosadasnjih: number
  config: PozadinaConfig
}

export interface PozadinaOdluka {
  taskId: string
  presuda: PozadinaPresuda
  okidac: PozadinaOkidac | null
  pokusaj: number
  strop: number
  razlog: string
}

function jePauziran(p: unknown): boolean {
  return p === true || p === 1 || p === '1' || p === 'true'
}

const pidPopis = (n: PozadinaNajam) => n.pidovi.map(p => p.pid).join(',') || '—'

export function odluciPozadinu(n: PozadinaNajam, u: PozadinaUlaz): PozadinaOdluka {
  const strop = u.config.stropPovrata
  const base = { taskId: n.taskId, okidac: null, pokusaj: 0, strop }
  if (u.status !== 'blocked') return { ...base, presuda: 'nije', razlog: `zadatak je ${u.status || 'nepoznat'}` }

  let okidac: PozadinaOkidac | null = null
  let zasto = ''
  if (n.gotovo && u.gotovo) {
    okidac = 'gotovo'
    zasto = `pozadinski posao završio (${n.gotovo.datoteka}${n.gotovo.tekst ? ` sadrži „${n.gotovo.tekst}”` : ' postoji'}) — dovrši izvještaj`
  } else if (n.pidovi.length > 0 && u.ziviPidovi === 0) {
    okidac = 'pidovi'
    zasto = `pozadinski posao završio (PID ${pidPopis(n)} više ne radi) — dovrši izvještaj; provjeri je li uspio ili pao`
  } else if (u.now >= n.rokDoMs) {
    okidac = 'rok'
    zasto = `rok istekao (${n.rokSati} h), pozadinski posao još radi (PID ${pidPopis(n)}, živih ${u.ziviPidovi}) — provjeri`
  }
  if (!okidac) {
    return { ...base, presuda: 'ceka', razlog: `radi (živih PID-ova ${u.ziviPidovi}/${n.pidovi.length}), rok za ${Math.max(0, Math.round((n.rokDoMs - u.now) / 60_000))} min` }
  }
  if (u.globalnaPauza || jePauziran(u.paused)) {
    return { ...base, okidac, presuda: 'kocnica', razlog: `${zasto} — ali ručna kočnica (${u.globalnaPauza ? 'globalna' : 'zadatak'}) drži povrat` }
  }
  const pokusaj = (u.dosadasnjih || 0) + 1
  if (pokusaj > strop) {
    return { ...base, okidac, pokusaj, presuda: 'odustani', razlog: `${zasto}; strop ${strop} povrata iskorišten — treba čovjek` }
  }
  return { ...base, okidac, pokusaj, presuda: 'vrati', razlog: `${zasto} (povrat ${pokusaj}/${strop})` }
}

// ============================================
// PLAN RADNJE
// ============================================

export interface PozadinaRadnja {
  method: 'POST' | 'PUT'
  /** Relativno na `/api/tasks`. */
  path: string
  body: Record<string, unknown>
  odluka: PozadinaOdluka
}

export function planPozadine(d: PozadinaOdluka): PozadinaRadnja | null {
  if (d.presuda === 'vrati') {
    return {
      method: 'POST', path: `/${d.taskId}/reclaim`, odluka: d,
      body: { from: 'blocked', by: RECLAIM_BY_POZADINA, reason: `Pozadina-povrat (TASK-5259): ${d.razlog}` },
    }
  }
  if (d.presuda === 'odustani') {
    return {
      method: 'PUT', path: `/${d.taskId}`, odluka: d,
      body: {
        blockedReason: `BLOCKED: pozadina-povrat — ${d.razlog}`.slice(0, 500),
        progressNotes: [`🔁 Auto (pozadina-povrat): ${d.razlog}. Zadatak ostaje blocked; vrati ga ručno kad je uzrok jasan.`],
      },
    }
  }
  return null
}

// ============================================
// IZVOĐENJE (ubrizgane ovisnosti — daemon daje prave)
// ============================================

interface ZajednickeOvisnosti {
  /** Baza API-ja zadataka, npr. `http://localhost:17781/api/tasks`. */
  api: string
  dir?: string
  config?: PozadinaConfig
  fetchFn?: typeof fetch
  citajStarttime?: CitajStarttime
  log?: (poruka: string) => void
}

async function postaviOznaku(api: string, taskId: string, ukljuci: boolean, fetchFn: typeof fetch,
  biljeska?: string): Promise<void> {
  const r = await fetchFn(`${api}/${taskId}`)
  if (!r.ok) return
  const t: any = await r.json()
  const tags: string[] = Array.isArray(t?.tags) ? t.tags : []
  const ima = tags.includes(OZNAKA_CEKA_POZADINU)
  if (ima === ukljuci && !biljeska) return
  const nove = ukljuci ? (ima ? tags : [...tags, OZNAKA_CEKA_POZADINU]) : tags.filter(x => x !== OZNAKA_CEKA_POZADINU)
  await fetchFn(`${api}/${taskId}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(biljeska ? { tags: nove, progressNotes: [biljeska] } : { tags: nove }),
  })
}

/**
 * Pri zatvaranju spawna u `blocked`: ako odgovor nosi `REGOC-POZADINA`, zapiši najam i oznaku
 * `ceka-pozadinu`. Vraća najam ili `null` (nema deklaracije). Nikad ne baca.
 */
export async function registrirajPozadinu(o: ZajednickeOvisnosti & {
  taskId: string; agent: string; resultText: string; now?: number; izvor?: string
}): Promise<PozadinaNajam | null> {
  const log = o.log ?? (() => {})
  try {
    const d = parsirajPozadinu(o.resultText)
    if (!d) return null
    const cfg = o.config ?? ucitajPozadinaConfig()
    const citaj = o.citajStarttime ?? ((pid: number) => procitajStarttime(pid))
    const n = napraviNajam(o.taskId, o.agent, d, cfg, o.now ?? Date.now(), citaj, o.izvor ?? 'spawn')
    zapisiNajam(o.dir ?? POZADINA_DIR, n)
    const zivih = n.pidovi.filter(p => p.starttime).length
    const opis = `PID ${pidPopis(n)} (živih ${zivih}/${n.pidovi.length})` +
      `${n.gotovo ? `, gotovo kad ${n.gotovo.datoteka}${n.gotovo.tekst ? ` sadrži „${n.gotovo.tekst}”` : ' postoji'}` : ''}, rok ${n.rokSati} h`
    try {
      await postaviOznaku(o.api, o.taskId, true, o.fetchFn ?? fetch,
        `🔁 Čeka pozadinski posao: ${opis}. Sustav vraća zadatak u obradu kad posao završi (TASK-5259).`)
    } catch (e) { log(`  ⚠️ [pozadina] ${o.taskId}: oznaka nije postavljena (${e})`) }
    log(`  🔁 [pozadina] ${o.taskId} (${o.agent}) čeka pozadinski posao: ${opis}`)
    return n
  } catch (e) {
    log(`  ⚠️ [pozadina] ${o.taskId}: najam nije zapisan (${e})`)
    return null
  }
}

export interface PozadinaIshod {
  taskId: string
  presuda: PozadinaPresuda
  okidac: PozadinaOkidac | null
  razlog: string
  http: number | null
  ok: boolean
}

/** Jedan prolaz petlje: za svaki najam odluči i izvedi. Nikad ne baca. */
export async function prolazPozadine(o: ZajednickeOvisnosti & {
  now?: number
  globalnaPauza: boolean
  brojacPath?: string
  logPath?: string
  /** Dojava korisniku (npr. queueUserAlarm) — samo za radnje. */
  alarm?: (poruka: string, taskId?: string) => void   // TASK-5420: taskId → grupa iz oznake chat:
}): Promise<PozadinaIshod[]> {
  const log = o.log ?? (() => {})
  const fetchFn = o.fetchFn ?? fetch
  const dir = o.dir ?? POZADINA_DIR
  const cfg = o.config ?? ucitajPozadinaConfig()
  const citaj = o.citajStarttime ?? ((pid: number) => procitajStarttime(pid))
  const brojacPath = o.brojacPath ?? POZADINA_BROJAC_PATH
  const logPath = o.logPath ?? POZADINA_LOG_PATH
  const now = o.now ?? Date.now()
  const ishodi: PozadinaIshod[] = []
  const brojac = ucitajBrojacPovrata(brojacPath, now)

  for (const n of ucitajNajmove(dir)) {
    try {
      const r = await fetchFn(`${o.api}/${n.taskId}`)
      if (r.status === 404) {
        obrisiNajam(dir, n.taskId)
        log(`  🔁 [pozadina] ${n.taskId}: zadatak ne postoji — najam obrisan`)
        continue
      }
      if (!r.ok) { log(`  ⚠️ [pozadina] ${n.taskId}: GET → HTTP ${r.status}`); continue }
      const t: any = await r.json()
      const d = odluciPozadinu(n, {
        now, status: String(t?.status || ''), paused: t?.paused, globalnaPauza: o.globalnaPauza,
        ziviPidovi: n.pidovi.filter(p => pidZiv(p, citaj)).length,
        gotovo: n.gotovo ? gotovoIspunjeno(n.gotovo) : false,
        dosadasnjih: brojac.get(n.taskId) || 0, config: cfg,
      })
      const ishod: PozadinaIshod = { taskId: n.taskId, presuda: d.presuda, okidac: d.okidac, razlog: d.razlog, http: null, ok: true }
      ishodi.push(ishod)

      if (d.presuda === 'nije') {
        obrisiNajam(dir, n.taskId)
        try { await postaviOznaku(o.api, n.taskId, false, fetchFn) } catch {}
        log(`  🔁 [pozadina] ${n.taskId}: ${d.razlog} — najam obrisan`)
        continue
      }
      const a = planPozadine(d)
      if (!a) continue

      const res = await fetchFn(`${o.api}${a.path}`, {
        method: a.method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(a.body),
      })
      ishod.http = res.status
      ishod.ok = res.ok
      try {
        appendFileSync(logPath, JSON.stringify({
          ts: new Date(now).toISOString(), mechanism: 'pozadina-povrat', taskId: n.taskId, agent: n.agent,
          presuda: d.presuda, okidac: d.okidac, pokusaj: d.pokusaj, strop: d.strop,
          pidovi: n.pidovi, method: a.method, path: a.path, http: res.status, ok: res.ok, razlog: d.razlog,
        }) + '\n')
      } catch { /* zapis nije kritičan */ }
      if (!res.ok) {
        const tekst = (await res.text()).slice(0, 500)
        // TASK-5302: ručna ljudska oznaka drži zadatak u blocked. Najam je ispunio svrhu (posao je
        // završio), pa se gasi — inače bi petlja svakih 120 s ponavljala isti odbijeni povrat.
        let gated: string[] | null = null
        if (res.status === 409) { try { const j = JSON.parse(tekst); if (j?.error === 'Human-gated') gated = j.ljudskeOznake || [] } catch {} }
        if (gated && d.presuda === 'vrati') {
          obrisiNajam(dir, n.taskId)
          const biljeska = `🔁 Auto (pozadina-povrat): ${d.razlog}. Zadatak ostaje blocked — drži ga ljudska oznaka ${gated.join(', ')} (nije je dao sustav). Skini je ili odluči ručno.`
          try { await postaviOznaku(o.api, n.taskId, false, fetchFn, biljeska) } catch {}
          log(`  🔁 [pozadina] ${n.taskId} (${n.agent}) → ostaje blocked: ljudska oznaka ${gated.join(', ')} — najam obrisan`)
          o.alarm?.(`🛑 [pozadina] ${n.taskId} (${n.agent}) — ${d.razlog}, ali zadatak drži ljudska oznaka ${gated.join(', ')}. Ostaje u blocked, čeka tebe.`, n.taskId)
          continue
        }
        log(`  ⚠️ [pozadina] ${n.taskId} ${a.method} ${a.path} → HTTP ${res.status}: ${tekst.slice(0, 200)}`)
        continue
      }
      obrisiNajam(dir, n.taskId)
      if (d.presuda === 'vrati') zabiljeziPovrat(brojacPath, n.taskId, d.pokusaj, now)
      try { await postaviOznaku(o.api, n.taskId, false, fetchFn) } catch {}
      log(`  🔁 [pozadina] ${n.taskId} (${n.agent}) → ${d.presuda === 'vrati' ? 'pending' : 'ostaje blocked'}: ${d.razlog} (HTTP ${res.status})`)
      o.alarm?.(d.presuda === 'vrati'
        ? `🔁 [pozadina] ${n.taskId} (${n.agent}) — ${d.razlog}. Vraćam ga u obradu.`
        : `🛑 [pozadina] ${n.taskId} (${n.agent}) — ${d.razlog}. Zadatak ostaje u blocked.`, n.taskId)
    } catch (e) {
      log(`  ⚠️ [pozadina] ${n.taskId}: ${e}`)
    }
  }
  return ishodi
}

// ============================================
// CLI: pregled najmova (ručna dijagnostika)
// ============================================

if (import.meta.main) {
  const najmovi = ucitajNajmove(POZADINA_DIR)
  if (najmovi.length === 0) console.log('Nema najmova pozadinskog posla.')
  for (const n of najmovi) {
    const zivi = n.pidovi.filter(p => pidZiv(p)).length
    const gotovo = n.gotovo ? gotovoIspunjeno(n.gotovo) : false
    console.log(`${n.taskId} (${n.agent}) PID ${pidPopis(n)} živih ${zivi}/${n.pidovi.length}` +
      `${n.gotovo ? ` gotovo=${gotovo}` : ''} rok ${new Date(n.rokDoMs).toISOString()}`)
  }
}
