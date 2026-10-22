/**
 * ProjectGuess — koji je projekt iza poruke (U2, TASK-4262).
 *
 * PRESLIKA, NE NOVA POLITIKA. Pravila su doslovno ista kao u retroaktivnom uvozu
 * (`~/app/regoc_system/tools/uvoz_telegram_zadataka.py`: `TEKST_PRAVILA`,
 * `ZADANO_PO_GRUPI`, `IZRICITO_SUSTAV`). Razlog: uvoz je već razvrstao 594 zadatka i
 * napunio trošak po projektu; da ulazna vrata razvrstavaju drukčije, ista bi vrsta
 * posla u srpnju i u rujnu završila u dva projekta, a usporedba troška bi lagala.
 *
 * ZAŠTO PRESLIKA A NE ZAJEDNIČKA DATOTEKA. Pravila su u pythonskom alatu koji je
 * jednokratno pokrenut i živi u drugom spremištu; vrući put svake telegramske poruke ne
 * smije zvati python. Umjesto tihe kopije, razilaženje hvata test
 * `tests/project-guess.test.ts` — čita pythonski izvor i uspoređuje niz pravila redom.
 *
 * ZAMKA KOJU JE TREBALO ZAOBIĆI: `\w` u Pythonu hvata i `č/ć/š/ž/đ`, a u JS-u je samo
 * ASCII. `prijav\w* za eu` u JS-u ne bi uhvatio „prijavu za EU" s hrvatskim nastavkom u
 * susjednoj riječi. Zato je `\w` posvuda zamijenjen s `[\p{L}\p{N}_]` uz zastavicu `u`.
 *
 * Autorica: Jelena (Engineer), TASK-4262.
 */

/** Pretinac za nerazvrstano (razrada §0: 52 zadatka ondje čekaju ručno razvrstavanje). */
export const PRETINAC = 'PRJ-033'

/** Oznake grupa kakve poznaje pythonski uvoz. */
export type GrupaPravila = 'REGOČ' | 'SportAI'

/** Zadani projekt po grupi — isto kao `ZADANO_PO_GRUPI` u uvozu. */
export const ZADANO_PO_GRUPI: Record<string, string> = { SportAI: 'PRJ-034', 'REGOČ': PRETINAC }

export interface PraviloProjekta { uzorak: RegExp; projekt: string }

/** `\w` → unicode razred, da hrvatski nastavci prolaze kao u Pythonu. */
const W = '[\\p{L}\\p{N}_]'
const re = (s: string): RegExp => new RegExp(s.replace(/\\w/g, W), 'iu')

/**
 * TEKST_PRAVILA — REDOSLIJED JE DIO PRAVILA. Prvo pravilo koje se javi pobjeđuje, pa
 * uska pravila (imena projekata, oznake sklopova) stoje ispred općeg REGOČ pravila.
 */
export const PRAVILA_PROJEKTA: PraviloProjekta[] = [
  { uzorak: re('muszg|volfram|pusti\\.sh|turnir|planinarsk|trešnjevk|tresnjevk'), projekt: 'PRJ-041' },
  { uzorak: re('opensport|karta sporta|sportskih objekata'), projekt: 'PRJ-044' },
  { uzorak: re('kinemotion|skok u dalj|skok s motkom'), projekt: 'PRJ-045' },
  { uzorak: re('playvision|en garde|eu prijav|prijav\\w* za eu|natječaj|natjecaj|pismo namjere'), projekt: 'PRJ-034' },
  { uzorak: re('pk\\.?1\\.?1\\.?17|ulx-precom|ekohezij'), projekt: 'PRJ-042' },
  { uzorak: re('regoč enterprise|regoc enterprise'), projekt: 'PRJ-043' },
  { uzorak: re('dribler'), projekt: 'PRJ-021' },
  { uzorak: re('cubes|ch32|kockic'), projekt: 'CUBES_2026' },
  { uzorak: re('tinysa|litevna|sensorberg|\\bemc\\b|lisn'), projekt: 'REGOC_EMC' },
  { uzorak: re('gladius|chasing|podvodn'), projekt: 'PRJ-018' },
  { uzorak: re('\\bigor\\b|bm20c|bmh20c|guardian|nrf54'), projekt: 'PRJ-027' },
  { uzorak: re('\\bcm5\\b|test ?point|breakout'), projekt: 'PRJ-039' },
  { uzorak: re('mio168|\\beez\\b|\\bbb3\\b'), projekt: 'PRJ-054' },
  { uzorak: re('e-?bbes|ffm-a7100|vtm-ac7200|vgp-j11|mpm3833'), projekt: 'PRJ-053' },
  { uzorak: re('ulx5m|serdes|pcie|gatemate|ksz9031'), projekt: 'ULX5M' },
  { uzorak: re('ulx3s|reach|rohs'), projekt: 'PRJ-057' },
  { uzorak: re('piper|\\btts\\b|voice studio|naglas|glasovn'), projekt: 'PRJ-035' },
  { uzorak: re('regoč music|regoc music|pjesm|glazb'), projekt: 'PRJ-038' },
  { uzorak: re('regocmobile|node-a|node-b|appliance|virtualbox'), projekt: 'PRJ-032' },
  { uzorak: re('taskmanagerai|samostalan paket|standalone'), projekt: 'PRJ-048' },
  { uzorak: re('kicad.?timetrack'), projekt: 'PRJ-049' },
  { uzorak: re('espacenet|patent|\\bepo\\b|\\bfto\\b'), projekt: 'PRJ-046' },
  { uzorak: re('pcbparts|jlcpcb|lcsc|mouser'), projekt: 'PRJ-058' },
  { uzorak: re('preš\\w* za|presa za|zatik'), projekt: 'PRJ-036' },
  { uzorak: re('magaphone|mppt|bq24650'), projekt: 'PRJ-037' },
  { uzorak: re('sunčan\\w* elektran|fotonapon|\\bhep\\b|\\bfne\\b'), projekt: 'PRJ-056' },
  { uzorak: re('lifeos'), projekt: 'PRJ-059' },
  { uzorak: re('certifikat.*prompt|prompting certifikat'), projekt: 'PRJ-031' },
  { uzorak: re('telemetrij'), projekt: 'PRJ-060' },
  { uzorak: re('pravopis|hrvatsk\\w* jezik'), projekt: 'PRJ-050' },
  { uzorak: re('regoč|regoc|daemon|task ?manager|spawn|agent|autonomij|telegram|zadat\\w*k|token'), projekt: 'REGOC_SYSTEM' },
  { uzorak: re('intergalaktik'), projekt: 'INTERGALAKTIK' },
]

/**
 * U grupi IntergalaktikSportAI se NE radi na REGOČ sustavu — ondje „modul", „stranica"
 * i „zadatak" znače muzejsku stranicu, ne daemon. Zato se REGOC_SYSTEM tamo prihvaća
 * samo na izričit spomen sustava.
 */
const IZRICITO_SUSTAV = /regoč|regoc|task ?manager|daemon|spawn|agent\b|token/i

/** Oznaka grupe s mosta → oznaka kakvu poznaju pravila. */
export function grupaZaPravila(labelGrupe?: string | null): GrupaPravila {
  return /sportai|intergalaktik/i.test(String(labelGrupe || '')) ? 'SportAI' : 'REGOČ'
}

/** Projekt po ključnim riječima; `null` kad nijedno pravilo ne prolazi. */
export function projektIzTeksta(tekst: string, grupa: GrupaPravila = 'REGOČ'): string | null {
  const t = String(tekst || '')
  if (!t) return null
  for (const { uzorak, projekt } of PRAVILA_PROJEKTA) {
    if (!uzorak.test(t)) continue
    if (projekt === 'REGOC_SYSTEM' && grupa === 'SportAI' && !IZRICITO_SUSTAV.test(t)) continue
    return projekt
  }
  return null
}

export type IzvorProjekta = 'tekst' | 'grupa' | 'pretinac'

export interface PogodakProjekta { projekt: string; izvor: IzvorProjekta }

/**
 * Projekt i IZVOR odluke. Izvor je jednako važan kao projekt: razrada §0 mjeri da je
 * pogađanje po tekstu pouzdano, a pad na zadani projekt grupe (39 slučajeva u uvozu)
 * prvi kandidat za ručni ispravak. Bez zapisanog izvora se to ne može razlikovati.
 */
export function pogodiProjekt(
  tekst: string,
  labelGrupe?: string | null,
  zadaniProjektGrupe?: string | null,
): PogodakProjekta {
  const pogodak = projektIzTeksta(tekst, grupaZaPravila(labelGrupe))
  if (pogodak) return { projekt: pogodak, izvor: 'tekst' }
  if (zadaniProjektGrupe) return { projekt: zadaniProjektGrupe, izvor: 'grupa' }
  return { projekt: PRETINAC, izvor: 'pretinac' }
}
