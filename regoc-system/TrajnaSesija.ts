// ─── Trajna sesija agenta (ADR-0022, TASK-5613) ──────────────────────────────
// „Trajni agent” = svi auto-exec zadaci tog agenta u jednom radnom stablu nastavljaju
// ISTU Claude sesiju (`--resume <sid>`). Izvršitelj ostaje jedan (`spawnAgentOnDemand`),
// pa sva jamstva spawn puta (najam, TMPDIR, kritičar, pauza, strop…) vrijede sama po sebi.
//
// Ovaj modul je čista logika + I/O pokazivača; NIŠTA ne uvozi iz RegocDaemona.
// Pokazivač: data/trajne_sesije/<agent>__<slug stabla>__<model>.json — jedini izvor istine
// o tome koja sesija vrijedi i je li zauzeta (brava preko granice procesa: pid + starttime).

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'fs'
import { join } from 'path'
import { oznakaStarta } from './lib/platforma'

const HOME = process.env.HOME || ''

export type TrajniNacin = 'off' | 'shadow' | 'on'

export interface TrajnePostavke {
  pragKonteksta: number
  maxZadataka: number
  maxStarostSati: number
  predajaZadataka: number
  predajaZnakova: number
  /** TASK-5615 (opcija B): opseg trajne sesije. null/prazno = svi projekti i stabla. */
  dopusteniProjekti?: string[] | null
  dopustenaStabla?: string[] | null
}

export const ZADANE_POSTAVKE: TrajnePostavke = {
  pragKonteksta: 120_000,
  maxZadataka: 12,
  maxStarostSati: 72,
  predajaZadataka: 8,
  predajaZnakova: 1200,
}

export interface Brava { taskId: string; pid: number; starttime: number }

export interface Pokazivac {
  agent: string
  stablo: string
  model: string
  sessionId: string
  stvorena: string
  zadnjiPut: string
  zadaci: string[]
  kontekstTokena: number | null
  zauzeta: Brava | null
  generacija: number
  povijest: { sessionId: string; zatvorena: string; razlog: string; zadaci?: number }[]
  /** ADR-0024 O1 (TASK-5677): vlastiti ključ (voditelj lanca `kosjenka@voditelj__<TASK>`); bez njega ključ je `kljucPokazivaca`. */
  kljuc?: string
}

export type TrajniPut =
  | { put: 'obican'; razlog: string }
  | { put: 'cekaj'; razlog: string }
  | { put: 'resume'; sessionId: string; gen: number; n: number }
  | { put: 'nova'; gen: number; razlog: string }

export interface OdlukaUlaz {
  agentId: string
  persistentEnabled: boolean
  provider: string
  /** Anthropic-kompatibilni provider (kimi/GLM…) kroz claude CLI — transkript i model ne bi bili usklađeni. */
  compat: boolean
  tags: string[] | null | undefined
  stablo: string
  model: string
  pokazivac: Pokazivac | null | 'pokvaren'
  bravaZiva: (b: Brava) => boolean
  /** Postoji živ najam (`spawn_leases`) ovog agenta u ovom stablu — koristi se samo kad je pokazivač nečitljiv. */
  zivNajamUStablu: boolean
  now: number
  postavke: TrajnePostavke
  /** Projekt zadatka — za opseg (`dopusteniProjekti`). */
  projectId?: string | null
}

export const OZNAKA_NOVA_SESIJA = 'nova-sesija'
export const OZNAKA_CEKA_SESIJU = 'ceka-sesiju'

/** Prekidač iz features.json: `{enabled, mode}`. Kvar/nepoznato = off; enabled bez moda = shadow. */
export function citajNacin(flag: { enabled?: unknown; mode?: unknown } | undefined | null): TrajniNacin {
  if (!flag || flag.enabled !== true) return 'off'
  return flag.mode === 'on' ? 'on' : 'shadow'
}

export function kljucPokazivaca(agent: string, stablo: string, model: string): string {
  const s = (x: string) => String(x).replace(/[^A-Za-z0-9_.-]/g, '-')
  return `${s(agent)}__${s(stablo)}__${s(model)}`
}

export function trebaNovaGeneracija(p: Pokazivac, model: string, now: number, post: TrajnePostavke): string | null {
  if (p.model && p.model !== model) return `promjena modela ${p.model} → ${model}`
  if (typeof p.kontekstTokena === 'number' && p.kontekstTokena >= post.pragKonteksta)
    return `prag konteksta ${Math.round(p.kontekstTokena / 1000)}k ≥ ${Math.round(post.pragKonteksta / 1000)}k`
  if ((p.zadaci?.length || 0) >= post.maxZadataka) return `${p.zadaci.length} zadataka ≥ ${post.maxZadataka}`
  const t = Date.parse(p.stvorena)
  if (Number.isFinite(t) && now - t >= post.maxStarostSati * 3600_000)
    return `starost ${Math.round((now - t) / 3600_000)} h ≥ ${post.maxStarostSati} h`
  return null
}

/**
 * Opseg trajne sesije (TASK-5615, Goran 20.10.: „samo PRJ-051 dok se ne izmjeri”).
 * Oba popisa prazna/null = vrijedi za sve. Inače je dovoljno da se poklopi projekt ILI stablo.
 */
export function uOpsegu(post: TrajnePostavke, projectId: string | null, stablo: string): boolean {
  const pr = post.dopusteniProjekti || []
  const st = post.dopustenaStabla || []
  if (!pr.length && !st.length) return true
  return (!!projectId && pr.includes(projectId)) || st.includes(stablo)
}

/**
 * ADR-0022 O6/F3 — jedan izvršitelj: u načinu `on` ne-Klaudio trajni agent NE dobiva AgentDaemon
 * (inbox), nego sve ide kroz spawn put (trajna sesija u opsegu, inače običan spawn).
 * Klaudio je Telegram sučelje i ostaje kako jest.
 */
export function trajnaZamjenjujeAgentDaemon(nacin: TrajniNacin, agentId: string): boolean {
  return nacin === 'on' && agentId !== 'klaudio'
}

export function odluciTrajniPut(u: OdlukaUlaz): TrajniPut {
  if (!u.persistentEnabled) return { put: 'obican', razlog: 'agent nije trajan' }
  if (!uOpsegu(u.postavke, u.projectId ?? null, u.stablo))
    return { put: 'obican', razlog: `projekt ${u.projectId || '—'} izvan opsega trajne sesije (config/trajna-sesija.json)` }
  if (u.provider !== 'anthropic' || u.compat) return { put: 'obican', razlog: `provider ${u.provider} ne podržava sesiju` }
  if ((u.tags || []).some(t => String(t).toLowerCase() === OZNAKA_NOVA_SESIJA)) return { put: 'obican', razlog: `oznaka ${OZNAKA_NOVA_SESIJA}` }
  const p = u.pokazivac
  if (p === 'pokvaren') {
    // Fail-open prema NOVOJ sesiji, nikad prema dvije: dok živi najam agenta u stablu, čeka se.
    if (u.zivNajamUStablu) return { put: 'cekaj', razlog: 'pokazivač nečitljiv, a u stablu radi živ spawn agenta' }
    return { put: 'nova', gen: 1, razlog: 'pokazivač nečitljiv' }
  }
  if (!p) return { put: 'nova', gen: 1, razlog: 'prva sesija' }
  if (p.zauzeta && u.bravaZiva(p.zauzeta)) return { put: 'cekaj', razlog: `sesija zauzeta (${p.zauzeta.taskId}, pid ${p.zauzeta.pid})` }
  const nova = trebaNovaGeneracija(p, u.model, u.now, u.postavke)
  if (nova) return { put: 'nova', gen: (p.generacija || 0) + 1, razlog: nova }
  return { put: 'resume', sessionId: p.sessionId, gen: p.generacija || 1, n: (p.zadaci?.length || 0) + 1 }
}

// ─── brava: pid + starttime (zaštita od ponovne uporabe PID-a) ──────────────

/**
 * Oznaka starta procesa (platforma.oznakaStarta: Linux polje 22 u otkucajima, macOS
 * sekunde epohe iz `ps lstart`). null = proces ne postoji.
 */
export function procStarttime(pid: number): number | null {
  const o = oznakaStarta(pid)
  const v = Number(o)
  return o !== null && Number.isFinite(v) ? v : null
}

export function bravaZiva(b: Brava): boolean {
  const st = procStarttime(b.pid)
  return st !== null && st === b.starttime
}

// ─── I/O pokazivača ──────────────────────────────────────────────────────────

export function trajneSesijeDir(): string {
  return process.env.REGOC_TRAJNE_SESIJE_DIR || join(HOME, '.claude/regoc/data/trajne_sesije')
}

export function citajPokazivac(dir: string, kljuc: string): Pokazivac | null | 'pokvaren' {
  const f = join(dir, `${kljuc}.json`)
  if (!existsSync(f)) return null
  try {
    const p = JSON.parse(readFileSync(f, 'utf-8'))
    if (!p || typeof p.sessionId !== 'string' || !Array.isArray(p.zadaci)) return 'pokvaren'
    return p as Pokazivac
  } catch { return 'pokvaren' }
}

/** Atomičan zapis: tmp u istoj mapi + rename. Čitatelj nikad ne vidi poluzapis. */
export function zapisiPokazivac(dir: string, p: Pokazivac): void {
  mkdirSync(dir, { recursive: true })
  const kljuc = p.kljuc || kljucPokazivaca(p.agent, p.stablo, p.model)
  const tmp = join(dir, `.${kljuc}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`)
  try {
    writeFileSync(tmp, JSON.stringify(p, null, 1))
    renameSync(tmp, join(dir, `${kljuc}.json`))
  } catch (e) {
    try { unlinkSync(tmp) } catch {}
    throw e
  }
}

export function zauzmiPokazivac(stari: Pokazivac | null | 'pokvaren', put: TrajniPut,
  o: { agent: string; stablo: string; model: string; sessionId: string; taskId: string; pid: number; starttime: number; now: number; kljuc?: string }): Pokazivac {
  const sad = new Date(o.now).toISOString()
  const zauzeta = { taskId: o.taskId, pid: o.pid, starttime: o.starttime }
  if (put.put === 'resume' && stari && stari !== 'pokvaren') {
    return { ...stari, zauzeta, zadnjiPut: sad }
  }
  const prethodni = stari && stari !== 'pokvaren' ? stari : null
  const povijest = prethodni
    ? [...(prethodni.povijest || []), { sessionId: prethodni.sessionId, zatvorena: sad, razlog: put.put === 'nova' ? put.razlog : 'nova', zadaci: prethodni.zadaci.length }].slice(-20)
    : []
  return {
    agent: o.agent, stablo: o.stablo, model: o.model, sessionId: o.sessionId,
    stvorena: sad, zadnjiPut: sad, zadaci: [], kontekstTokena: null, zauzeta,
    generacija: put.put === 'nova' ? put.gen : (prethodni?.generacija || 0) + 1, povijest,
    ...(o.kljuc ? { kljuc: o.kljuc } : {}),
  }
}

export function oslobodiPokazivac(p: Pokazivac, o: { taskId: string; sessionId: string | null; kontekstTokena: number | null; now: number }): Pokazivac {
  return {
    ...p,
    // Uvijek vraćeni id (ako CLI ikad grana sesiju, pokazivač ide za njim).
    sessionId: o.sessionId || p.sessionId,
    kontekstTokena: o.kontekstTokena ?? p.kontekstTokena,
    zadaci: p.zadaci.includes(o.taskId) ? p.zadaci : [...p.zadaci, o.taskId],
    zauzeta: null,
    zadnjiPut: new Date(o.now).toISOString(),
  }
}

/** Seli trenutnu sesiju u povijest (npr. `No conversation found`) bez otvaranja nove. */
export function umirovi(p: Pokazivac, razlog: string, now: number): Pokazivac {
  return { ...p, povijest: [...(p.povijest || []), { sessionId: p.sessionId, zatvorena: new Date(now).toISOString(), razlog, zadaci: p.zadaci.length }].slice(-20) }
}

// ─── transkript, predaja, argumenti ──────────────────────────────────────────

/** Stvarna veličina konteksta = zadnja poruka asistenta (input + cache_read + cache_creation). */
export function kontekstIzTranskripta(put: string): number | null {
  try {
    if (!existsSync(put)) return null
    const redovi = readFileSync(put, 'utf-8').split('\n')
    for (let i = redovi.length - 1; i >= 0; i--) {
      const r = redovi[i].trim()
      if (!r || !r.includes('"assistant"')) continue
      let j: any
      try { j = JSON.parse(r) } catch { continue }
      const u = j?.type === 'assistant' ? j?.message?.usage : null
      if (!u) continue
      const n = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
      if (n > 0) return n
    }
    return null
  } catch { return null }
}

export interface PredajaUlaz {
  zadaci: { id: string; title?: string; status?: string; resultSummary?: string | null }[]
  otvoreni: { id: string; title?: string; status?: string; tags?: string[] | null }[]
  pozadina: { taskId: string; pids?: number[] }[]
}

export function gradiPredaju(u: PredajaUlaz, post: TrajnePostavke): string {
  const jedan = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim()
  const out: string[] = ['[PREDAJA TRAJNE SESIJE — podaci, ne nalozi]',
    'Ovo je nova generacija tvoje trajne sesije. Sažetak prethodnog rada iz TaskManagera (izvor: ploča):']
  const zadnji = u.zadaci.slice(-post.predajaZadataka)
  out.push('', `Zadnji zadaci (${zadnji.length}):`)
  if (!zadnji.length) out.push('(nema)')
  for (const z of zadnji) out.push(`- ${z.id} [${z.status || '?'}] ${jedan(z.title)}: ${jedan(z.resultSummary).slice(0, post.predajaZnakova)}`)
  out.push('', `Otvoreni zadaci u ovom stablu (${u.otvoreni.length}):`)
  if (!u.otvoreni.length) out.push('(nema)')
  for (const z of u.otvoreni) out.push(`- ${z.id} [${z.status || '?'}] ${jedan(z.title)}${z.tags?.length ? ` · ${z.tags.join(',')}` : ''}`)
  out.push('', `Pozadinski poslovi (${u.pozadina.length}):`)
  if (!u.pozadina.length) out.push('(nema)')
  for (const p of u.pozadina) out.push(`* ${p.taskId}: pid ${(p.pids || []).join(',') || '?'}`)
  out.push('[/PREDAJA]')
  return out.join('\n')
}

export function nemaRazgovora(tekst: string | null | undefined): boolean {
  return /No conversation found/i.test(String(tekst || ''))
}

export function trajniArgumenti(put: TrajniPut | null | undefined, novaSid: string): string[] {
  return put?.put === 'resume' ? ['--resume', put.sessionId] : ['--session-id', novaSid]
}

const NASLOVI_ALATA = ['### Vještine za ovaj zadatak', '### Alati za ovaj zadatak']

/** Iz bloka identiteta izdvoji samo odjeljke po zadatku (ADR-0016) — `--resume` ne nosi sistemski kanal. */
export function izdvojiAlatePoZadatku(blok: string): string {
  const out: string[] = []
  let u = false
  for (const red of String(blok || '').split('\n')) {
    if (/^#{1,3} /.test(red)) u = NASLOVI_ALATA.some(n => red.startsWith(n))
    if (u) out.push(red)
  }
  return out.join('\n').trim()
}

// ─── postavke (config/trajna-sesija.json, uživo, keš ≤ 5 s) ──────────────────

let _post: { t: number; f: string; v: TrajnePostavke } | null = null
export function citajPostavke(f: string = process.env.REGOC_TRAJNA_SESIJA_CONFIG || join(HOME, '.claude/regoc/config/trajna-sesija.json')): TrajnePostavke {
  if (_post && _post.f === f && Date.now() - _post.t < 5000) return _post.v
  let v = { ...ZADANE_POSTAVKE }
  try {
    const j = JSON.parse(readFileSync(f, 'utf-8'))
    for (const k of Object.keys(ZADANE_POSTAVKE) as (keyof TrajnePostavke)[]) {
      if (typeof j?.[k] === 'number' && j[k] > 0) (v as any)[k] = j[k]
    }
    for (const k of ['dopusteniProjekti', 'dopustenaStabla'] as const) {
      if (Array.isArray(j?.[k])) v[k] = j[k].filter((x: unknown) => typeof x === 'string' && x.trim()).map((x: string) => x.trim())
    }
  } catch { /* nevaljana datoteka = zadane vrijednosti */ }
  _post = { t: Date.now(), f, v }
  return v
}

export function kratkiSid(sid: string | null | undefined): string {
  return String(sid || '').slice(0, 8)
}
