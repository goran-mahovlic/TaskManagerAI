/**
 * SpawnSlotRules — čista pravila oko mjesta za spawn (TASK-5029).
 *
 * Goranov nalog 24.09.2026. 19:05: na ploči 4 „u radu", a strop je 3. Četvrti (TASK-5026)
 * je dobio `in_progress` iako ga je strop odbio, a TASK-4999 je pauziran u statusu `blocked`
 * radio dalje jer je kočnica gledala samo `in_progress`. Pravila su ovdje (a ne inline u
 * RegocDaemon.ts) da bi bila testabilna bez pokretanja daemona.
 */

/** Oznaka zadatka koji čeka slobodno mjesto (strop usporednih agenata). */
export const CEKA_MJESTO_TAG = 'ceka-mjesto'

export type SpawnRefusal = 'pauza' | 'strop' | 'backoff' | 'osigurac' | 'provider' | 'greska'
export type SpawnStart = { started: true } | { started: false; reason: SpawnRefusal }

/**
 * Oznake zadatka nakon pokušaja spawna, ili `null` kad se ništa ne mijenja.
 * Strop → dodaj `ceka-mjesto`; proces krenuo → makni je. Ostale odbijenice (pauza, backoff,
 * osigurač) nisu „čekanje mjesta" i ne smiju se tako prikazati.
 */
export function tagsAfterSpawnAttempt(tags: string[] | null | undefined, start: SpawnStart): string[] | null {
  const cur = Array.isArray(tags) ? tags.map(String) : []
  const has = cur.includes(CEKA_MJESTO_TAG)
  if (start.started) return has ? cur.filter(t => t !== CEKA_MJESTO_TAG) : null
  if (start.reason !== 'strop' || has) return null
  return [...cur, CEKA_MJESTO_TAG]
}

export function waitingSlotNote(active: number, max: number): string {
  return `⏳ Čeka mjesto: radi ${active}/${max} agenata (strop). Status ostaje pending dok proces stvarno ne krene; auto-exec ga pokreće čim se mjesto oslobodi.`
}

export interface HelperChainInput {
  tags: string[] | null | undefined
  /** Broj zadataka s oznakom `parent:<ovaj>` u bilo kojem statusu (i otkazani). */
  existingChildren: number
  /** Prekidač `sequentialHelpers` u features.json. */
  enabled: boolean
  /** Izvor zadatka (`createdBy`); `regoc-chain` = korak lanca (TASK-255). */
  createdBy?: string | null
}

/**
 * Smije li ovaj spawn graditi R2 lanac „doradi rad"?
 * Ne smije: kad je prekidač isključen, za Goranov `nalog`, i kad lanac za taj zadatak već
 * postoji — inače svaki ponovni spawn (nastavak, zombi, pauza→nastavak) rađa novi lanac
 * (TASK-5002/5012/5021 su sva tri nastala iz TASK-4999).
 */
export function helperChainDecision(i: HelperChainInput): { allow: boolean; reason: string } {
  if (!i.enabled) return { allow: false, reason: 'prekidač sequentialHelpers je isključen' }
  const tags = Array.isArray(i.tags) ? i.tags.map(t => String(t).toLowerCase()) : []
  if (tags.includes('nalog')) return { allow: false, reason: 'zadatak je nalog — bez automatskog lanca' }
  // TASK-255 (node-A, prijenos TASK-5323): korak lanca se izvršava u mjestu, ne gradi novi lanac.
  // Dokaz: re-ingestiran tim-korak → „doradi rad" junk v1.2→v1.11 (kaskada regoc-chain na node-A).
  if (String(i.createdBy || '') === 'regoc-chain' || tags.some(t => t.startsWith('parent:')))
    return { allow: false, reason: 'član lanca (createdBy regoc-chain / parent:) — izvršava se u mjestu, bez novog lanca' }
  if (i.existingChildren > 0) return { allow: false, reason: `lanac već postoji (${i.existingChildren} zadatak/a s parent oznakom) — ponovni spawn ga ne gradi opet` }
  return { allow: true, reason: 'ok' }
}

/**
 * TASK-255 (uzrok #1 pre-eskalacija): trivijalan/jednostručan zahtjev (E1/E2) ne postaje
 * multi-agent tim — „df -h" je na node-A dobio kosjenka+dora+jelena+potjeh. Tim tek od E3.
 */
export function timPoNaporu(effort: string | null | undefined): boolean {
  return !(effort === 'E1' || effort === 'E2')
}

/** Zadaci koji imaju živi spawn I zastavicu `paused` — status je nevažan. */
export function pausedTrackedIds(
  rows: Array<{ id: string; paused?: number | boolean | null; status?: string }>,
  tracked: Set<string>,
): Set<string> {
  const out = new Set<string>()
  for (const r of rows) {
    if (r && tracked.has(String(r.id)) && (r.paused === true || Number(r.paused) === 1)) out.add(String(r.id))
  }
  return out
}
