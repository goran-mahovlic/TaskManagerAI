/**
 * ZatvaranjeKrozDaemon — `PUT status=completed` je ZAHTJEV, a provodi ga daemon (TASK-5164).
 *
 * Dizajn: DIZAJN-nesukladnosti-BCD.md §2 (nesukladnost B) u repozitoriju sustava domaćina.
 * Prenesen u paket u TASK-5327 (ploča provodi B2; B3 izvodi daemon koji zatvara — na čvoru je to
 * komplet izvornog sustava, pa ključ zatvarača i dnevnici žive u NJEGOVOJ mapi podataka).
 *
 * Rupa (izmjereno 03.10.2026.): 257 zadataka u živoj instalaciji zatvoreno je od 01.09. izravnim PUT-om,
 * 0 ih je vidjelo kritičara. ADR-0012 je zatvorio put samo za daemonove spawnove; ploča nije
 * razlikovala daemonov PUT od običnog curla, pa se „zatvara samo daemon” nije dalo provesti.
 *
 *  B1  Daemon se predstavlja: `X-REGOC-Zatvara: daemon` + `X-REGOC-Zatvarac: <token>`.
 *      Token je u `<podaci daemona>/zatvarac.token` (600) — `TM_IZVORNI_PODACI`, bez nje `TM_DATA`. Nije zaštita od napadača (isti UID), nego od
 *      prečaca: model koji ga pročita čini vidljiv prekršaj u transkriptu.
 *  B2  Ploča: `completed` od bilo koga osim daemona i čovjeka (`X-REGOC-Zatvara: covjek`)
 *      → 202 + oznaka `ceka-kriticara` (uživo) ili samo zapis (sjena).
 *  B3  Daemon: zadatke s oznakom provodi kroz ISTOG kritičara kao spawn (datoteke od
 *      `started_at` + `[PROVJERA] cmd:`) i zatvara ih kao `completed` ili `blocked`.
 *
 * Prekidači (features.json, čitaju se uživo): `zatvaranjeKrozDaemon` (sjena) i
 * `zatvaranjeKrozDaemonLive` (provedba). Sve ovdje je fail-open prema STAROM ponašanju:
 * kvar u ovom modulu nikad ne ruši PUT.
 */
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, chmodSync } from 'fs'
import { dirname, join } from 'path'
import { randomBytes, timingSafeEqual } from 'crypto'
import { izvorniPodaci } from './RevizijaBlokiranih'

export const OZNAKA_CEKA = 'ceka-kriticara'

/** Mapa podataka daemona koji zatvara: ploča i daemon MORAJU čitati isti ključ i isti dnevnik. */
const dataDir = () => izvorniPodaci()
export const putTokena = () => join(dataDir(), 'zatvarac.token')
export const putZahtjeva = () => join(dataDir(), 'zatvaranje_zahtjevi.jsonl')
export const putSudova = () => join(dataDir(), 'zatvaranje_sudovi.jsonl')

// ─── B1: token ───────────────────────────────────────────────────────────────

export function procitajToken(put: string = putTokena()): string | null {
  try {
    const t = readFileSync(put, 'utf-8').trim()
    return t.length >= 32 ? t : null
  } catch { return null }
}

/** Vrati token; ako ga nema, stvori ga (600). Poziva ga samo daemonova strana. */
export function osigurajToken(put: string = putTokena()): string {
  const postojeci = procitajToken(put)
  if (postojeci) return postojeci
  mkdirSync(dirname(put), { recursive: true })
  const t = randomBytes(24).toString('hex')
  writeFileSync(put, t + '\n', { mode: 0o600 })
  chmodSync(put, 0o600)
  return t
}

/** Zaglavlja s kojima daemon (TaskCloser) zove ploču. Kvar tokena = samo uloga (ploča → `ostali`). */
export function zaglavljaZatvaraca(put: string = putTokena()): Record<string, string> {
  try {
    return { 'X-REGOC-Zatvara': 'daemon', 'X-REGOC-Zatvarac': osigurajToken(put) }
  } catch {
    return { 'X-REGOC-Zatvara': 'daemon' }
  }
}

// ─── B2: ploča ───────────────────────────────────────────────────────────────

export type Pozivatelj = 'daemon' | 'covjek' | 'ostali'

function jednako(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export function pozivateljZatvaranja(
  zaglavlja: { get(k: string): string | null },
  token: string | null,
): Pozivatelj {
  const uloga = zaglavlja.get('X-REGOC-Zatvara')
  if (uloga === 'daemon') {
    const dani = zaglavlja.get('X-REGOC-Zatvarac') || ''
    return token && jednako(dani, token) ? 'daemon' : 'ostali'
  }
  if (uloga === 'covjek') return 'covjek'
  return 'ostali'
}

export function odlukaZatvaranja(a: {
  status: string
  trenutni: string
  pozivatelj: Pozivatelj
  ukljuceno: boolean
  live: boolean
}): { zahtjev: boolean; provedi: boolean } {
  // Samo `in_progress → completed`: iz ostalih stanja PUT ionako pada na 409 i ta poruka
  // (s uputom) korisnija je od 202 koji bi obećao zatvaranje koje se ne može dogoditi.
  const zahtjev = a.ukljuceno && a.status === 'completed' && a.trenutni === 'in_progress' && a.pozivatelj === 'ostali'
  return { zahtjev, provedi: zahtjev && a.live }
}

export function tijelo202(taskId: string) {
  return {
    stanje: OZNAKA_CEKA,
    zadatak: taskId,
    poruka: 'Zatvaranje je primljeno kao zahtjev. Daemon će pokrenuti kritičara (provjere iz [PROVJERA] cmd: ' +
      'i datoteke izmijenjene od started_at) i zatvoriti zadatak kao completed ili blocked. Ne šalji PUT ponovo.',
    pratiti: `GET /api/tasks/${taskId}`,
  }
}

export function zapisiZahtjev(red: Record<string, unknown>, put: string = putZahtjeva()): void {
  try {
    mkdirSync(dirname(put), { recursive: true })
    appendFileSync(put, JSON.stringify({ ts: new Date().toISOString(), ...red }) + '\n')
  } catch { /* mjerenje nikad ne ruši PUT */ }
}

// ─── B3: daemon ──────────────────────────────────────────────────────────────

export interface ZahtjevZadatak {
  id: string
  status: string
  assignee?: string | null
  description?: string
  resultSummary?: string
  tags?: string[]
  startedAt?: string | null
}

export interface SudKriticara {
  status: 'pass' | 'fail' | 'unverifiable' | 'partial'
  razlog: string
  /** Koliko je provjera stvarno pokrenuto. */
  provjera: number
  /**
   * QA-5165 N2: koliko propisanih `[PROVJERA]` NIJE bilo moguće izvesti (nedopušten izvršitelj,
   * metaznak, naredba se nije pokrenula, istek roka). Nedostaje = 0 (stari kritičar).
   */
  neizvedivo?: number
}

export interface PetljaDeps {
  zahtjevi: () => Promise<ZahtjevZadatak[]>
  kriticar: (z: ZahtjevZadatak) => Promise<SudKriticara>
  /**
   * Vratar teksta (CompletionGuard); `null` = prolazi. Na ovom putu se `trivial_result` provodi
   * bez obzira na completion-gate live (QA-5165 N2, odluka B) — ožičenje je u daemonu.
   */
  vratarTeksta?: (sazetak: string, z: ZahtjevZadatak) => string | null
  zatvori: (taskId: string, body: Record<string, unknown>) => Promise<boolean>
  log: (m: string) => void
}

export interface IshodZahtjeva {
  taskId: string
  ishod: 'completed' | 'blocked' | 'greska'
  kriticar?: SudKriticara['status']
}

const bezOznake = (tags: string[] | undefined) => (tags || []).filter((t) => t !== OZNAKA_CEKA)

export interface PresudaZahtjeva {
  status: 'completed' | 'blocked'
  blockedReason?: string
  biljeska: string
}

/**
 * Jedna presuda za provedbu i sjenu (QA-5165 N2, odluka B, TASK-5210). Redoslijed:
 *   1. kritičar `fail`                         → blocked CRITIC_FAILED
 *   2. propisana [PROVJERA] nije izvediva       → blocked NEIZVEDIVA_PROVJERA (TASK-5206)
 *   3. vratar teksta odbije (npr. trivial_result) → blocked (TASK-5208)
 *   4. inače completed; unverifiable/partial bez propisane provjere uz sadržajan sažetak
 *      prolazi kao na spawn putu, s bilješkom „neprovjereno”.
 * Vrijedi SAMO za put zahtjeva (pozivatelj bez daemonova tokena); spawn put se ne mijenja.
 */
export function presudaZahtjeva(sud: SudKriticara, tekst: string | null): PresudaZahtjeva {
  if (sud.status === 'fail') {
    return { status: 'blocked', blockedReason: `BLOCKED: CRITIC_FAILED — ${sud.razlog}`.slice(0, 500),
      biljeska: `🧪 Kritičar (zahtjev zatvaranja): FAIL — ${sud.razlog}`.slice(0, 600) }
  }
  if ((sud.neizvedivo ?? 0) > 0) {
    const r = `NEIZVEDIVA_PROVJERA — zadatak je propisao ${sud.neizvedivo} [PROVJERA] koju kritičar ne može izvesti; `
      + `ispravi naredbu (dopušteni izvršitelji, bez metaznakova) ili dodaj dokaz. ${sud.razlog}`
    return { status: 'blocked', blockedReason: `BLOCKED: ${r}`.slice(0, 500),
      biljeska: `🧪 Kritičar (zahtjev zatvaranja): ${sud.status} — ${r}`.slice(0, 600) }
  }
  if (tekst) {
    return { status: 'blocked', blockedReason: `BLOCKED: ${tekst}`.slice(0, 500),
      biljeska: `🧪 Vratar teksta (zahtjev zatvaranja): ${tekst}`.slice(0, 600) }
  }
  const neprovjereno = sud.status === 'unverifiable' || sud.status === 'partial'
  return { status: 'completed', biljeska: neprovjereno
    ? `🔎 Kritičar (zahtjev zatvaranja): ${sud.status} — neprovjereno (${sud.razlog || 'nema izvršnog artefakta'}); zatvoreno kao na spawn putu`
    : `✅ Kritičar (zahtjev zatvaranja): pass, ${sud.provjera} provjera` }
}

export async function obradiZahtjeveZatvaranja(d: PetljaDeps): Promise<IshodZahtjeva[]> {
  const out: IshodZahtjeva[] = []
  let lista: ZahtjevZadatak[] = []
  try { lista = await d.zahtjevi() } catch (e) { d.log(`⚠️ [zatvaranje-zahtjev] popis nije dohvaćen: ${e}`); return out }
  for (const z of lista) {
    if (z.status !== 'in_progress' || !(z.tags || []).includes(OZNAKA_CEKA)) continue
    let sud: SudKriticara
    try {
      sud = await d.kriticar(z)
    } catch (e) {
      // Kritičar koji pukne ne smije zatvoriti zadatak naslijepo — ostaje čekati sljedeći prolaz.
      d.log(`⚠️ [zatvaranje-zahtjev] ${z.id}: kritičar pao (${e}) — zadatak čeka sljedeći prolaz`)
      out.push({ taskId: z.id, ishod: 'greska' })
      continue
    }
    const tekst = d.vratarTeksta ? d.vratarTeksta(z.resultSummary || '', z) : null
    const p = presudaZahtjeva(sud, tekst)
    const body: Record<string, unknown> = { status: p.status, tags: bezOznake(z.tags),
      ...(p.blockedReason ? { blockedReason: p.blockedReason } : {}), progressNotes: [p.biljeska] }
    const ok = await d.zatvori(z.id, body).catch(() => false)
    if (!ok) { out.push({ taskId: z.id, ishod: 'greska', kriticar: sud.status }); continue }
    d.log(`🧪 [zatvaranje-zahtjev] ${z.id} → ${body.status} (kritičar ${sud.status}${sud.neizvedivo ? `, neizvedivo ${sud.neizvedivo}` : ''}${tekst ? `, vratar: ${tekst}` : ''})`)
    out.push({ taskId: z.id, ishod: body.status as 'completed' | 'blocked', kriticar: sud.status })
  }
  return out
}

export interface SjenaDeps {
  zahtjeviPut?: string
  sudoviPut?: string
  zadatak: (id: string) => Promise<ZahtjevZadatak | null>
  kriticar: (z: ZahtjevZadatak) => Promise<SudKriticara>
  /** Isti vratar teksta kao u provedbi — sjena mjeri istu presudu (QA-5165 N2). */
  vratarTeksta?: (sazetak: string, z: ZahtjevZadatak) => string | null
  log: (m: string) => void
  /** Najviše toliko sudova po prolazu — sjena ne smije zagušiti glavnu petlju. */
  najvise?: number
}

function citajJsonl(put: string): any[] {
  if (!existsSync(put)) return []
  return readFileSync(put, 'utf-8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}

/**
 * Sjena: zahtjev je zapisan, a PUT je zatvorio po starom. Daemon ipak pokrene kritičara i
 * zabilježi što BI učinio — to je mjerilo „lažnih blokada” prije prelaska u provedbu (§2.4).
 * Vraća broj novih sudova.
 */
export async function obradiSjenuZatvaranja(d: SjenaDeps): Promise<number> {
  const zp = d.zahtjeviPut ?? putZahtjeva()
  const sp = d.sudoviPut ?? putSudova()
  const zahtjevi = citajJsonl(zp).filter((r) => r.nacin === 'shadow' && r.taskId)
  if (!zahtjevi.length) return 0
  const vec = new Set(citajJsonl(sp).map((r) => `${r.taskId}|${r.zahtjevTs}`))
  let n = 0
  for (const r of zahtjevi) {
    if (n >= (d.najvise ?? 3)) break
    const kljuc = `${r.taskId}|${r.ts}`
    if (vec.has(kljuc)) continue
    const z = await d.zadatak(r.taskId).catch(() => null)
    let red: Record<string, unknown>
    if (!z) {
      red = { taskId: r.taskId, zahtjevTs: r.ts, bihZatvorio: null, kriticar: null, razlog: 'zadatak nije dohvaćen' }
    } else {
      const zz = { ...z, startedAt: r.startedAt ?? z.startedAt }
      const sud = await d.kriticar(zz).catch((e) => ({ status: 'unverifiable' as const, razlog: `kritičar pao: ${e}`, provjera: 0 }))
      const tekst = d.vratarTeksta ? d.vratarTeksta(zz.resultSummary || '', zz) : null
      const p = presudaZahtjeva(sud, tekst)
      red = { taskId: r.taskId, zahtjevTs: r.ts, kriticar: sud.status, provjera: sud.provjera,
        neizvedivo: sud.neizvedivo ?? 0, bihZatvorio: p.status,
        ...(p.blockedReason ? { bihRazlog: p.blockedReason.slice(0, 300) } : {}),
        razlog: String(sud.razlog || '').slice(0, 300) }
    }
    try {
      mkdirSync(dirname(sp), { recursive: true })
      appendFileSync(sp, JSON.stringify({ ts: new Date().toISOString(), nacin: 'shadow', ...red }) + '\n')
    } catch { /* mjerenje */ }
    d.log(`🧪 [zatvaranje-sjena] ${r.taskId}: kritičar ${red.kriticar ?? '—'} → BIH ${red.bihZatvorio ?? '—'}`)
    vec.add(kljuc)
    n++
  }
  return n
}
