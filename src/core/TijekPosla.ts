/**
 * „Tijek posla” u dojavi o završetku (TASK-5159, dizajn TASK-5158 §5).
 *
 * NALOG (vlasnik, 03.10.2026.): „Bitno je da mi se kod riješenog zadatka javi i tijek posla i da taj
 * tijek postoji, pa ćemo ga lako mijenjati po potrebi i slučaju.”
 *
 * `sastaviTijek()` je ČISTA funkcija: iz zadataka (oznake `workflow:`, `korak:`, `nalog:`,
 * `vjestina:`) i izmjerenih zapisa (`data/tijek_posla.jsonl`, piše ga `agent_telemetry.py
 * --tijek-posla-out` pri zatvaranju) slaže odjeljak ≤ 700 znakova. Vještine i alati su IZMJERENI
 * iz transkripta, ne iz izjave agenta; bez mjerenja piše „nije izmjereno” (ADR-TELEMETRIJA §9).
 * Zovu je dojava niza (`ReportBackTask.runReportBackSweep`) i put uspjeha u `RegocDaemon`.
 *
 * Paket (prijenos TASK-5625): sastavljač i dnevnik su isti kao u glavnom sustavu, dnevnik je u
 * `TM_DATA/tijek_posla.jsonl`. Pogonsko mjerenje sesije (`izmjeriSesiju`,
 * `zapisiTijekPoslaUPozadini`) NIJE preneseno: paketov `tools/agent_telemetry.py` nema
 * `--tijek-posla-out` ni mjerenje vještina iz kataloga, pa bez zapisa korak kaže „nije izmjereno”.
 */

import { existsSync, readFileSync } from 'fs'
import type { Katalog, Korak } from './WorkflowGate'
import { stanjePutanja } from './paths'

export const TIJEK_POSLA_LOG = stanjePutanja('tijek_posla.jsonl')
export const TIJEK_MAX = 700
export const IZMJENA_REDAK = (wid: string) =>
  `Izmjena tijeka: workflows.json › ${wid} (ili oznaka workflow:<id> na nalogu)`

export interface TijekZadatak {
  id: string
  title?: string | null
  status?: string | null
  assignee?: string | null
  tags?: string[] | string | null
}

export interface TijekZapis {
  taskId: string
  obvezneVjestine?: string[] | null
  pozvaneVjestine?: string[] | null
  alati?: string[] | null
  izmjereno?: boolean
}

export function oznakeOd(tags: TijekZadatak['tags']): string[] {
  if (Array.isArray(tags)) return tags.map(String).map(s => s.trim()).filter(Boolean)
  const s = String(tags || '').trim()
  if (!s) return []
  try { const j = JSON.parse(s); if (Array.isArray(j)) return j.map(String).map(x => x.trim()).filter(Boolean) } catch { /* zarezi */ }
  return s.split(',').map(x => x.trim()).filter(Boolean)
}

const prva = (oz: string[], prefiks: string): string | null => {
  const o = oz.find(x => x.toLowerCase().startsWith(prefiks))
  return o ? o.slice(prefiks.length).trim() || null : null
}

export function ucitajZapise(put: string = TIJEK_POSLA_LOG): Map<string, TijekZapis> {
  const m = new Map<string, TijekZapis>()
  try {
    if (!existsSync(put)) return m
    for (const r of readFileSync(put, 'utf-8').split('\n')) {
      if (!r.trim()) continue
      try { const z = JSON.parse(r); if (z?.taskId) m.set(String(z.taskId), z) } catch { /* preskoči */ }
    }
  } catch { /* prazno */ }
  return m
}

const IKONA: Record<string, string> = { completed: '✅', cancelled: '✖', blocked: '⛔', failed: '⛔' }
const ikona = (s?: string | null) => IKONA[String(s || '').toLowerCase()] || '⏳'

function mjereno(z: TijekZapis | undefined): { vj: string; al: string } | null {
  if (!z || z.izmjereno === false || z.pozvaneVjestine == null || z.alati == null) return null
  return { vj: z.pozvaneVjestine.length ? z.pozvaneVjestine.join(', ') : '—', al: z.alati.length ? z.alati.slice(0, 4).join(', ') : '—' }
}

/**
 * TASK-5200/N2: je li obvezna vještina pozvana. Bez obzira na slova (`vjestina:pdf` = Skill
 * `Pdf`) i bez prefiksa plugina (`anthropic-skills:pdf` je Pdf) — inače dojava lažno javlja ⚠️.
 */
const imeVjestine = (v: string) => String(v).trim().toLowerCase().split(':').pop() || ''
export function vjestinaPozvana(obvezna: string, pozvane: string[] | null | undefined): boolean {
  const cilj = imeVjestine(obvezna)
  return !!cilj && (pozvane || []).some(p => imeVjestine(p) === cilj)
}

/** Obvezne vještine zadatka i upozorenja za nepozvane (samo kad je sesija izmjerena). */
function provjeriObvezne(z: TijekZadatak, oz: string[], zap: TijekZapis | undefined): { obvezno: number; pozvano: number; upozorenja: string[] } {
  const ob = (zap?.obvezneVjestine && zap.obvezneVjestine.length ? zap.obvezneVjestine
    : oz.filter(o => /^vjestina:/i.test(o)).map(o => o.slice(9)))
  const m = mjereno(zap)
  let pozvano = 0
  const upozorenja: string[] = []
  for (const v of ob) {
    if (m && vjestinaPozvana(v, zap!.pozvaneVjestine)) pozvano++
    else if (m) upozorenja.push(`⚠️ obvezna vještina ${v} nije pozvana (${z.id})`)
  }
  return { obvezno: ob.length, pozvano, upozorenja }
}

function rezi(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + '…'
}

export interface SastaviOpcije {
  maxLen?: number
  /** `true` = ovo JE dojava niza (korak `report-back` se prikazuje kao „ova poruka”). */
  dojavaNiza?: boolean
}

export function sastaviTijek(zadaci: TijekZadatak[], zapisi: Map<string, TijekZapis>, katalog?: Katalog | null, o: SastaviOpcije = {}): string {
  const maxLen = o.maxLen ?? TIJEK_MAX
  const dojavaNiza = o.dojavaNiza !== false
  if (!zadaci.length) return ''
  const s = zadaci.map(z => ({ z, oz: oznakeOd(z.tags) }))
  const wid = s.map(x => prva(x.oz, 'workflow:')).find(Boolean) || null
  const nalog = s.map(x => prva(x.oz, 'nalog:')).find(Boolean) || null
  const tijek = wid ? katalog?.workflows?.[wid] : null
  const koraciDef: Korak[] = (tijek?.koraci || []) as Korak[]

  const opisMjere = (id: string) => {
    const m = mjereno(zapisi.get(id))
    return m ? `vještine: ${m.vj} · alati: ${m.al}` : 'vještine/alati: nije izmjereno'
  }

  // Jedan zadatak bez tijeka — jedan redak.
  if (!wid && zadaci.length === 1) {
    const z = zadaci[0]
    const glava = `🧭 Tijek posla: bez tijeka${nalog ? ` · nalog ${nalog}` : ''} · 1 korak: ${z.assignee || '?'} — ${opisMjere(z.id)}`
    const { upozorenja } = provjeriObvezne(z, s[0].oz, zapisi.get(z.id))
    return rezi([glava, ...upozorenja.slice(0, 3)].join('\n'), maxLen)
  }

  const redci: string[] = []
  redci.push(wid
    ? `🧭 Tijek posla: ${wid}${tijek?.naziv ? ` (${tijek.naziv})` : ''}${nalog ? ` · nalog ${nalog}` : ''}`
    : `🧭 Tijek posla: ad-hoc (ručni lanac bez tijeka${nalog ? `, nalog ${nalog}` : ''})`)

  // Redoslijed: po `korak:n`, inače redoslijed niza.
  const poredano = s.map((x, i) => {
    const k = prva(x.oz, 'korak:')
    const n = k ? Number(k.split('/')[0]) : NaN
    return { ...x, n: Number.isFinite(n) ? n : null, i }
  }).sort((a, b) => (a.n ?? 1e6 + a.i) - (b.n ?? 1e6 + b.i))

  const upozorenja: string[] = []
  let obvezno = 0, pozvano = 0
  const zauzeti = new Set<number>()
  poredano.forEach((x, idx) => {
    const n = x.n ?? idx + 1
    zauzeti.add(n)
    const uloga = (x.n && koraciDef[x.n - 1]?.uloga) || 'korak'
    redci.push(` ${n}. ${x.z.assignee || '?'} · ${uloga} — ${ikona(x.z.status)} ${x.z.id} · ${opisMjere(x.z.id)}`)
    const pr = provjeriObvezne(x.z, x.oz, zapisi.get(x.z.id))
    obvezno += pr.obvezno
    pozvano += pr.pozvano
    upozorenja.push(...pr.upozorenja)
  })
  // Koraci bez modela (report-back) — dojava je upravo taj korak.
  koraciDef.forEach((k, i) => {
    if (k.mehanizam === 'report-back' && !zauzeti.has(i + 1)) {
      redci.push(` ${i + 1}. isporuka · report-back — ${dojavaNiza ? '✅ (ova poruka)' : '⏳ (dojava niza kad lanac završi)'}`)
    }
  })
  if (obvezno) redci.push(`   obvezne vještine pozvane: ${pozvano}/${obvezno}`)
  redci.push(...upozorenja.slice(0, 3))
  if (wid) redci.push(IZMJENA_REDAK(wid))
  else redci.push('Novi tijek: workflows.json (ponovljeni ručni lanac je prijedlog za tijek)')

  // Rezanje: najprije upozorenja i srednji koraci se skraćuju po retku, zaglavlje i izmjena ostaju.
  let out = redci.join('\n')
  if (out.length > maxLen) {
    const glava = redci[0], rep = redci[redci.length - 1]
    const sredina = redci.slice(1, -1)
    const prostor = Math.max(60, maxLen - glava.length - rep.length - 2)
    const po = Math.max(40, Math.floor(prostor / Math.max(1, sredina.length)) - 1)
    out = [glava, ...sredina.map(r => rezi(r, po)), rep].join('\n')
    out = rezi(out, maxLen)
  }
  return out
}

// ─── Zapis iz mjerenja (agent_telemetry.py --json) ───────────────────────────

/** Zapis iz JSON-a `agent_telemetry.py --json` (jedan zapis) + oznake zadatka. */
export function zapisIzTelemetrije(taskId: string, oznake: string[], mjera: any | null): TijekZapis {
  const al = mjera?.alati || null
  const vj = al && Array.isArray(al.vjestine) ? al.vjestine.map(String) : null
  const ka = al && Array.isArray(al.katalog_alati) ? al.katalog_alati.map((x: any) => String(x?.id)) : null
  return {
    taskId,
    obvezneVjestine: oznake.filter(o => /^vjestina:/i.test(o)).map(o => o.slice(9)),
    pozvaneVjestine: vj,
    alati: ka,
    izmjereno: vj !== null && ka !== null,
  }
}
