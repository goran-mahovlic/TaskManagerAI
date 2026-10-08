/**
 * PrikazVremena — vremena iz baze u zoni čitatelja (TASK-5368, nalaz TASK-5360).
 *
 * Baza nosi dva zapisa istog trenutka: ISO s `Z` (created_at, completed_at, bilješke) i
 * SQLite `CURRENT_TIMESTAMP` bez zone ('2026-10-08 14:33:13', updated_at). SQLite piše UTC
 * neovisno o TZ procesa, pa su OBA zapisa UTC. Ploča je drugi zapis čitala kao lokalni sat
 * preglednika: na čvoru (stroj EDT, ploča TZ=UTC, čitatelj CEST) to su bile tri zone u istim
 * zapisima. Ovdje je jedno pravilo: zapis bez zone je UTC, prikaz ide u zadanu zonu
 * (`TM_ZONA`, inače zona procesa).
 *
 * Ista pravila (parsiranje + format) ploča ugrađuje u preglednik kao tekst funkcija, pa se
 * poslužitelj i preglednik ne mogu razići.
 *
 * Autorica: Jelena (Engineer), TASK-5368.
 */

/** Vremenska oznaka iz baze → Date; zapis bez zone je UTC. Neispravno → null. */
export function parsirajVrijemeBaze(ts: unknown): Date | null {
  if (ts === null || ts === undefined || ts === '') return null
  if (ts instanceof Date) return isNaN(ts.getTime()) ? null : ts
  if (typeof ts === 'number') { const d = new Date(ts); return isNaN(d.getTime()) ? null : d }
  const s = String(ts).trim()
  const imaZonu = /[zZ]$|[+-]\d\d:?\d\d$/.test(s)
  const iso = s.includes('T') ? s : s.replace(' ', 'T')
  const d = new Date(imaZonu ? iso : iso + 'Z')
  return isNaN(d.getTime()) ? null : d
}

/** 'YYYY-MM-DD HH:MM' u zadanoj zoni (prazno/neispravna zona = zona procesa). */
export function formatirajVrijeme(ts: unknown, zona?: string | null, sekunde = false): string {
  const d = parsirajVrijemeBaze(ts)
  if (!d) return ''
  const opcije: Intl.DateTimeFormatOptions = {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    ...(sekunde ? { second: '2-digit' } : {}), hourCycle: 'h23',
  }
  let dijelovi: Intl.DateTimeFormatPart[]
  try {
    dijelovi = new Intl.DateTimeFormat('en-CA', { ...opcije, ...(zona ? { timeZone: zona } : {}) }).formatToParts(d)
  } catch {
    dijelovi = new Intl.DateTimeFormat('en-CA', opcije).formatToParts(d)
  }
  const p = Object.fromEntries(dijelovi.map(x => [x.type, x.value]))
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}${sekunde ? ':' + p.second : ''}`
}

/** Zona prikaza ploče: `TM_ZONA` ako je ispravna IANA zona, inače zona procesa. */
export function zonaPrikaza(env: Record<string, string | undefined> = process.env): string {
  const z = (env.TM_ZONA || '').trim()
  if (z) {
    try { new Intl.DateTimeFormat('en', { timeZone: z }); return z } catch { /* neispravna → proces */ }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

/** Oznaka u skripti ploče koju `ugradiPrikazVremena` zamjenjuje (komentar — skripta se
 *  raščlanjuje i bez zamjene, v. tests/ploca-skripta.test.ts). */
export const OZNAKA_PRIKAZA_VREMENA = '/*__PRIKAZ_VREMENA__*/'

/**
 * Skripta za preglednik: iste `parsirajVrijemeBaze`/`formatirajVrijeme` kao na poslužitelju
 * (izvor funkcije, ne prepisana kopija) + `_kad`/`_sat`/`_dan` u zoni ploče.
 */
export function skriptaPrikazaVremena(zona: string): string {
  return [
    `const ZONA_PRIKAZA = ${JSON.stringify(zona)};`,
    parsirajVrijemeBaze.toString(),
    formatirajVrijeme.toString(),
    'function _kad(ts) { return formatirajVrijeme(arguments.length ? ts : Date.now(), ZONA_PRIKAZA); }',
    'function _sat(ts) { return _kad.apply(null, arguments).slice(11); }',
    'function _dan(ts) { return _kad.apply(null, arguments).slice(0, 10); }',
  ].join('\n')
}

export function ugradiPrikazVremena(html: string, zona: string): string {
  return html.replace(OZNAKA_PRIKAZA_VREMENA, () => skriptaPrikazaVremena(zona))
}
