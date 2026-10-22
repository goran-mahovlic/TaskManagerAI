/**
 * SpawnBreakerAudit.ts — M1 / TASK-4639 (REGOC_SYSTEM)
 *
 * ČEMU: canary osigurača spawnova (TASK-4624) smije se proširiti na cijelu flotu tek
 * „nakon 3 dana bez lažnog zatvaranja". Taj se sud dosad donosio okom nad ispisom
 * `spawn-breaker-status.ts --hours 72`. Dva su problema u toj provjeri:
 *
 *   1. RETENCIJA. `spawn_breaker_log` se u trenutku ovog nalaza kratio na 24 h
 *      (od TASK-4643 na 96 h, `spawnBreaker.logRetentionHours` — ali tek od restarta
 *      RegocDaemona, jer bun ne ucitava kod ponovno), pa prozor od 72 h tada nije bio
 *      dokaziv iz same tablice. Da se to nije primijetilo, sud
 *      bi „prošao" upravo zato što dokaza nema — a prazna tablica i uredan rad izgledaju
 *      jednako. (Da rezanje dosad nije udarilo, stvar je slučaja: `maybePrune` opali
 *      svakih 200 provjera unutar JEDNOG procesa, a pri izmjerenih 3,3 spawna/h to je
 *      ~60 h prometa bez restarta.)
 *   2. SUD NA OKO. „Lažno zatvaranje" je bilo u glavi čitatelja, ne u kodu.
 *
 * Ovaj modul zato radi dvoje: ARHIVIRA dnevnik prije nego ga retencija pojede, i donosi
 * STROJNU prosudbu koja pada ZATVORENO (`NEDOVOLJNO_DOKAZA`) kad pokrivenost nije dokazana.
 * Mjerilo koje ne zna razliku između „bilo je mirno" i „nisam gledao" nije mjerilo.
 *
 * Ne dira `SpawnBreaker.ts` niti ijedan živi proces — čita tablicu i piše vlastiti JSONL.
 */

import type { Database } from 'bun:sqlite'
import { appendFileSync, existsSync, readFileSync, chmodSync } from 'fs'

export const SAT = 3_600_000
/** Najveća dopuštena rupa između dviju snimaka arhiva da bi prozor bio „pokriven". */
export const ZADANA_RUPA_MS = 48 * SAT

export interface Dogadaj {
  id: number
  scope: string
  agent_id: string | null
  event: string
  kind: string | null
  mode: string
  detail: string | null
  created_ms: number
}

interface Snimka { k: 's'; ts_ms: number; max_id: number; n: number }
type Redak = ({ k: 'd' } & Dogadaj) | Snimka

function citajArhiv(putanja: string): { dogadaji: Dogadaj[]; snimke: number[] } {
  const dogadaji: Dogadaj[] = []
  const snimke: number[] = []
  if (!existsSync(putanja)) return { dogadaji, snimke }
  for (const linija of readFileSync(putanja, 'utf-8').split('\n')) {
    if (!linija.trim()) continue
    let r: Redak
    try { r = JSON.parse(linija) } catch { continue }   // oštećen redak nije razlog za pad
    if (r.k === 'd') dogadaji.push(r as Dogadaj)
    else if (r.k === 's' && typeof r.ts_ms === 'number') snimke.push(r.ts_ms)
  }
  return { dogadaji, snimke }
}

/**
 * Preuzmi nove retke iz `spawn_breaker_log` u trajni arhiv i zabilježi snimku.
 * Idempotentno po `id`. Snimka je dokaz „u ovom trenutku sam gledao" — bez nje se
 * pokrivenost prozora ne može tvrditi.
 */
export function arhiviraj(db: Database, putanja: string, nowMs: number = Date.now()):
  { novih: number; ukupnoUArhivu: number; maxId: number } {
  const { dogadaji } = citajArhiv(putanja)
  const poznati = new Set(dogadaji.map(d => d.id))
  let redci: any[] = []
  try {
    redci = db.query(`SELECT id, scope, agent_id, event, kind, mode, detail, created_ms
                        FROM spawn_breaker_log ORDER BY id`).all() as any[]
  } catch { redci = [] }                                 // tablica još ne postoji = 0 novih

  const novi = redci.filter(r => !poznati.has(r.id))
  const dijelovi = novi.map(r => JSON.stringify({ k: 'd', ...r }))
  const maxId = Math.max(0, ...redci.map(r => r.id), ...dogadaji.map(d => d.id))
  dijelovi.push(JSON.stringify({ k: 's', ts_ms: nowMs, max_id: maxId, n: novi.length }))
  appendFileSync(putanja, dijelovi.join('\n') + '\n')
  try { chmodSync(putanja, 0o600) } catch { /* nije kritično */ }
  return { novih: novi.length, ukupnoUArhivu: dogadaji.length + novi.length, maxId }
}

/** Događaji od `sinceMs` naovamo — unija žive tablice i arhiva (bez duplikata po id). */
export function ucitajDogadaje(db: Database, putanja: string, sinceMs: number, agent?: string): Dogadaj[] {
  const spoj = new Map<number, Dogadaj>()
  for (const d of citajArhiv(putanja).dogadaji) spoj.set(d.id, d)
  try {
    const redci = db.query(`SELECT id, scope, agent_id, event, kind, mode, detail, created_ms
                              FROM spawn_breaker_log`).all() as Dogadaj[]
    for (const d of redci) spoj.set(d.id, d)
  } catch { /* nema tablice → ostaje arhiv */ }
  return [...spoj.values()]
    .filter(d => d.created_ms >= sinceMs)
    .filter(d => !agent || d.agent_id === agent)
    .sort((a, b) => a.created_ms - b.created_ms || a.id - b.id)
}

export interface Prosudba {
  ishod: 'PASS' | 'FAIL' | 'NEDOVOLJNO_DOKAZA'
  razlozi: string[]
  odbijenih: number          // `refused` na opsegu agenta/globalnom (pravo zatvaranje vrata)
  sumnjivih: number          // od toga bez dokazane podloge = lažno zatvaranje
  kantaOdbila: number        // `refused` iz stropa brzine — druga vrsta, ne lažno zatvaranje
  biOdbio: number            // `would_refuse` (sjena) — najava za agente izvan canaryja
  sumnjiviOpisi: string[]
  rupeH: number[]            // rupe u pokrivenosti arhiva, u satima
  pokrivenoOd: number | null
}

export function prosudi(opt: {
  db: Database
  arhiv: string
  sinceMs: number
  nowMs?: number
  agent?: string
  maxRupaMs?: number
}): Prosudba {
  const nowMs = opt.nowMs ?? Date.now()
  const maxRupa = opt.maxRupaMs ?? ZADANA_RUPA_MS
  const razlozi: string[] = []

  // ── 1. Pokrivenost: smijem li uopće suditi o ovom prozoru? ──
  const { snimke } = citajArhiv(opt.arhiv)
  const uzorci = [...snimke].sort((a, b) => a - b)
  const rupeH: number[] = []
  let pokriveno = uzorci.length > 0
  let pokrivenoOd: number | null = uzorci[0] ?? null

  if (!pokriveno) {
    razlozi.push('arhiv dnevnika je prazan — nijedna snimka ne dokazuje da je prozor uopće gledan')
  } else {
    if (uzorci[0] > opt.sinceMs) {
      pokriveno = false
      razlozi.push(`arhiv počinje tek ${new Date(uzorci[0]).toISOString()}, a prozor traži od `
        + `${new Date(opt.sinceMs).toISOString()} — raniji dio prozora nije dokaziv`)
    }
    const tocke = [...uzorci.filter(t => t >= opt.sinceMs), nowMs]
    let prije = Math.max(uzorci[0], opt.sinceMs)
    for (const t of tocke) {
      const rupa = t - prije
      if (rupa > maxRupa) { rupeH.push(+(rupa / SAT).toFixed(1)); pokriveno = false }
      prije = t
    }
    if (rupeH.length) {
      razlozi.push(`rupe u pokrivenosti arhiva (h): ${rupeH.join(', ')} — dopušteno je najviše `
        + `${(maxRupa / SAT).toFixed(0)} h, iznad toga je retencija od 24 h mogla pojesti dokaze`)
    }
  }

  // ── 2. Lažno zatvaranje: `refused` bez dokazane podloge ──
  // Kontekst se čita 24 h prije prozora: `open` koji je otvorio vrata smije biti stariji
  // od prozora, a odbijenica koju objašnjava unutar njega.
  const svi = ucitajDogadaje(opt.db, opt.arhiv, opt.sinceMs - 24 * SAT, opt.agent)
  const uProzoru = svi.filter(d => d.created_ms >= opt.sinceMs && d.created_ms <= nowMs)

  let odbijenih = 0, sumnjivih = 0, kantaOdbila = 0, biOdbio = 0
  const sumnjiviOpisi: string[] = []

  for (const d of uProzoru) {
    if (d.event === 'would_refuse') { biOdbio++; continue }
    if (d.event !== 'refused') continue
    if (d.scope === 'bucket') { kantaOdbila++; continue }
    odbijenih++
    // Podloga: zadnji `open` na istom opsegu prije ove odbijenice, bez `reset` u međuvremenu.
    const povijest = svi.filter(x => x.scope === d.scope && x.created_ms <= d.created_ms)
    let podloga: Dogadaj | null = null
    for (let i = povijest.length - 1; i >= 0; i--) {
      const e = povijest[i]
      if (e.event === 'reset') break
      if (e.event === 'open') { podloga = e; break }
    }
    if (!podloga) {
      sumnjivih++
      sumnjiviOpisi.push(`${new Date(d.created_ms).toISOString()} ${d.scope}: odbijen spawn, `
        + 'a u zapisu nema nijednog `open` koji bi ga objasnio')
    } else if (podloga.kind !== 'rejected') {
      sumnjivih++
      sumnjiviOpisi.push(`${new Date(d.created_ms).toISOString()} ${d.scope}: vrata otvorena na `
        + `kind='${podloga.kind}' (nije dokazana odbijenica) — prekršeno pravilo fail-OPEN na nepoznatu grešku`)
    }
  }

  if (sumnjivih > 0) razlozi.push(`${sumnjivih} odbijenica bez dokazane podloge = lažno zatvaranje`)
  const ishod: Prosudba['ishod'] = sumnjivih > 0 ? 'FAIL' : (pokriveno ? 'PASS' : 'NEDOVOLJNO_DOKAZA')
  if (ishod === 'PASS') {
    razlozi.push(odbijenih === 0
      ? 'nijedna odbijenica u prozoru, a pokrivenost arhiva je dokazana'
      : `sve odbijenice (${odbijenih}) imaju stvarnu podlogu u zapisu`)
  }

  return { ishod, razlozi, odbijenih, sumnjivih, kantaOdbila, biOdbio, sumnjiviOpisi, rupeH, pokrivenoOd }
}
