// ─── Stil izlaza u chat (TASK-5285) ──────────────────────────────────────────
// Opcija paketa `telegram.stil`: `kratko` (zadano) ili `puno`. Kratko je oblik koji se čita
// u prolazu na mobitelu: prvi redak = ishod (✅/⚠️/❌ + jedna rečenica), zatim najviše 5
// kratkih točaka, poveznica za detalje — bez uvoda, ponavljanja pitanja i sažetka na kraju.
// Dulji izvještaj ostaje na ploči (ili ide kao dokument), ne kao zid teksta u grupi.
//
// Vrijedi za obavijesti o zadacima (TelegramConfig), poruke daemona korisniku (user-flush,
// preko `IzlazniKanal`) i razgovorne odgovore (uputa u sistemskom promptu, `UPUTA_KRATKO`).
// Čiste funkcije, bez I/O — ista poruka uvijek daje isti ispis.
//
// Autorica: Jelena (Engineer), TASK-5285.

export type Stil = 'kratko' | 'puno'
export const STILOVI: readonly Stil[] = ['kratko', 'puno'] as const
export const ZADANI_STIL: Stil = 'kratko'

export type Ishod = 'ok' | 'upozorenje' | 'greska'
const IKONA: Record<Ishod, string> = { ok: '✅', upozorenje: '⚠️', greska: '❌' }

/** Uputa razgovornom modelu (sistemski prompt) kad je stil `kratko`. */
export const UPUTA_KRATKO = [
  'Oblik odgovora (stil „kratko"): Prvi redak je ishod — ✅, ⚠️ ili ❌ i jedna rečenica.',
  'Zatim najviše 3–5 kratkih točaka (što, gdje, sljedeći korak), svaka u jednom retku.',
  'Bez uvoda, bez ponavljanja pitanja, bez sažetka na kraju, bez tablica i naslova.',
  'Za detalje daj putanju ili poveznicu; dulji izvještaj pošalji kao dokument, ne kao zid teksta.',
  'Na jednostavno pitanje odgovori jednim retkom.',
].join(' ')

export interface KratkoOpcije {
  /** Ide u prvi redak ispred rečenice (npr. „TASK-9 Provjera sustava"). */
  naslov?: string
  /** Izričit ishod; bez njega se čita iz teksta. */
  ishod?: Ishod
  /** Putanja ili poveznica za detalje — zadnji redak. */
  detalji?: string
  /** Najviše točaka (zadano 4, strop 5). */
  maxTocaka?: number
  /** Najviše znakova rečenice u prvom retku. */
  maxRecenica?: number
}

const MAX_TOCKA = 120

/** Retci koji su ukras ili šablona izvještaja, ne sadržaj. */
const SABLONA = /^(REGOC-STATUS|REGOC-IZLAZ|REGOC-POZADINA|===|📊\s*STATUS|➡️|📁|📖|⭐|🗣️|STORY|RATE\b)/i
/** Naslovi sažetka/zaključka — sve ispod njih se ne prenosi (sažetak sažetka). */
const SAZETAK = /^(sažetak|sazetak|ukratko|zaključak|zakljucak|summary|tl;?dr)\s*:?\s*$/i
/** Oznaka-etikete na početku retka: „📋 REZULTAT:", „REZULTAT:", „SUMMARY:". */
const ETIKETA = /^(?:[\p{Extended_Pictographic}️]\s*)?(?:rezultat|summary|analysis|analiza|actions|results|sažetak|status)\s*:\s*/iu
/** Vodeća ikona ishoda — da se ne ponovi uz našu. */
const VODECA_IKONA = /^(?:✅|❌|⚠️|⚠|🛑|📋|ℹ️|🖥️)\s*/u

function ocistiRedak(r: string): string {
  return r
    .replace(/\*\*|__|`/g, '')
    .replace(/^#{1,6}\s*/, '')
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1 ($2)')
    .replace(/\s+/g, ' ')
    .trim()
}

function skrati(t: string, max: number): string {
  if (t.length <= max) return t
  const rez = t.lastIndexOf(' ', max - 1)
  return (rez > max * 0.6 ? t.slice(0, rez) : t.slice(0, max - 1)).replace(/[,;:—–-]\s*$/, '') + '…'
}

/** Prva rečenica retka (do . ! ? iza kojih slijedi razmak), skraćena. */
function prvaRecenica(t: string, max: number): string {
  const m = t.match(/^(.+?[.!?])(\s|$)/)
  return skrati(m ? m[1]! : t, max)
}

/** Ishod iz teksta: izričiti status agenta prvo, pa ikone i riječi. */
export function procitajIshod(tekst: string): Ishod {
  const st = tekst.match(/REGOC-STATUS:\s*(DONE|BLOCKED|NEEDS_CONTEXT)/i)
  if (st) return st[1]!.toUpperCase() === 'DONE' ? 'ok' : 'upozorenje'
  const prvi = tekst.trim().split('\n')[0] || ''
  if (/^\s*(❌|🛑)/u.test(prvi) || /\b(neuspje(h|šno|sno)|pao|pala|palo|greška|greska|failed|error)\b/i.test(prvi)) return 'greska'
  if (/^\s*⚠/u.test(prvi) || /\b(djelomi[čc]no|blocked|blokiran|nije dovr[šs]en)\b/i.test(tekst)) return 'upozorenje'
  return 'ok'
}

/** Red tablice → „prva ćelija: druga ćelija"; razdjelnik i zaglavlje → null. */
function redTablice(r: string, prviRed: boolean): string | null {
  const celije = r.trim().replace(/^\||\|$/g, '').split('|').map(c => ocistiRedak(c))
  if (celije.every(c => /^:?-{2,}:?$/.test(c) || c === '')) return null
  if (prviRed) return null
  const [a, b] = celije
  if (!a) return null
  return b ? `${a}: ${b}` : a
}

/**
 * Dugi izvještaj → kratak oblik. Kod, tablice-razdjelnici, šablone izvještaja i sve ispod
 * naslova „Sažetak" se izbacuju; prvi sadržajni redak postaje ishod, ostali točke.
 */
export function kratkiIzvjestaj(tekst: string, o: KratkoOpcije = {}): string {
  const izvor = String(tekst || '')
  const ishod = o.ishod ?? procitajIshod(izvor)
  const maxTocaka = Math.max(0, Math.min(5, o.maxTocaka ?? 4))
  const sadrzaj: string[] = []
  let uKodu = false
  let tablicaPrvi = true
  for (const sirovi of izvor.replace(/\r/g, '').split('\n')) {
    const r = sirovi.trim()
    if (r.startsWith('```')) { uKodu = !uKodu; continue }
    if (uKodu || !r) { if (!r) tablicaPrvi = true; continue }
    if (SABLONA.test(r)) continue
    if (SAZETAK.test(ocistiRedak(r))) break
    if (r.startsWith('|')) {
      const t = redTablice(r, tablicaPrvi)
      tablicaPrvi = false
      if (t) sadrzaj.push(t)
      continue
    }
    tablicaPrvi = true
    const c = ocistiRedak(r).replace(ETIKETA, '').replace(VODECA_IKONA, '').replace(ETIKETA, '')
    if (c) sadrzaj.push(c)
  }

  // Kratko zaglavlje s dvotočkom („Ana završio zadatak:") spaja se sa sljedećim retkom.
  let prvi = sadrzaj.shift() || ''
  if (prvi.endsWith(':') && prvi.length <= 60 && sadrzaj.length) {
    const sljedeci = sadrzaj.shift()!
    prvi = `${prvi} ${prvaRecenica(sljedeci, o.maxRecenica ?? 160)}`
  } else {
    prvi = prvaRecenica(prvi, o.maxRecenica ?? 160)
  }
  const glava = [o.naslov?.trim(), prvi].filter(Boolean).join(' — ') || '(bez teksta)'
  const izlaz = [`${IKONA[ishod]} ${glava}`]
  for (const t of sadrzaj.slice(0, maxTocaka)) izlaz.push(`• ${skrati(t, MAX_TOCKA)}`)
  if (o.detalji) izlaz.push(`↪ detalji: ${o.detalji}`)
  return izlaz.join('\n')
}

export function primijeniStil(tekst: string, stil: Stil | undefined, o: KratkoOpcije = {}): string {
  return stil === 'puno' ? tekst : kratkiIzvjestaj(tekst, o)
}

export function jeStil(v: unknown): v is Stil {
  return typeof v === 'string' && (STILOVI as readonly string[]).includes(v)
}
