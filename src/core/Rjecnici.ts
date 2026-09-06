/**
 * Rjecnici.ts — provjera da su rječnici sučelja doista stigli uz kod.
 *
 * VLASTITO U PAKETU (TASK-4719). U živoj REGOČ instalaciji ovog modula nema: ondje su
 * `locales/` i `config/jezik.json` uvijek uz ploču, pa se pitanje ne postavlja. U paketu se
 * postavlja, jer paket putuje — na node-A, node-B i u javni repozitorij.
 *
 * ZAŠTO POSTOJI. TASK-4713: preslika `regeneriraj.sh` nosila je `TaskWebUI.ts`, a `locales/`
 * i `config/jezik.json` je ispustila. Ploča se digla, `/health` vratio 200, provjera javila
 * „0 zaostaje" — a izbornika jezika na čvoru nije bilo. Kvar se vidio tek u pregledniku.
 * Ista rupa stoji i u `scripts/install.sh`: instalacija javlja „U REDU" na temelju `/health`,
 * koji o rječnicima ne zna ništa.
 *
 * UGOVOR se ne izmišlja ovdje — prepisan je iz `src/TaskWebUI.ts`:
 *   LOCALES_DIR   = `${import.meta.dir}/../locales`            (redak 10286)
 *   zadani jezik  = `${import.meta.dir}/../config/jezik.json`  (redak 10296), inače 'hr'
 *   podloga       = `${LOCALES_DIR}/en.json`                   (redak 10332)
 *
 * Razlika GREŠKA/UPOZORENJE je namjerna: instalacija smije stati samo na onome što ploču
 * doista lomi. Nepotpun prijevod ploču ne lomi (zatečena vrijednost ostaje podloga), pa bi
 * ga tvrda greška samo naučila ljude da provjeru preskaču.
 */
import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'

export interface NalazRjecnika {
  /** Ono što ploču doista lomi — instalacija na ovome staje. */
  greske: string[]
  /** Ono što vrijedi znati, ali ploča radi — instalacija ovo samo ispiše. */
  upozorenja: string[]
  /** Kodovi jezika nađeni u `locales/` (abecedno), isto kao `/api/jezici`. */
  jezici: string[]
  /** Jezik koji će ploča ponuditi prva. */
  zadani: string
}

/** Isto čitanje kao `zadaniJezik()` u TaskWebUI.ts: nema datoteke → hrvatski. */
function citajZadani(korijen: string, upozorenja: string[]): string {
  const put = join(korijen, 'config/jezik.json')
  if (!existsSync(put)) {
    upozorenja.push(`nema config/jezik.json — ploča kreće na hrvatskom (zadano)`)
    return 'hr'
  }
  try {
    const c = JSON.parse(readFileSync(put, 'utf-8')) as { zadani?: unknown }
    if (typeof c.zadani === 'string' && c.zadani.trim()) return c.zadani.trim().toLowerCase()
    upozorenja.push(`config/jezik.json nema polje "zadani" — ploča kreće na hrvatskom`)
  } catch (err) {
    upozorenja.push(`config/jezik.json nije ispravan JSON (${String(err)}) — kreće na hrvatskom`)
  }
  return 'hr'
}

/**
 * @param korijen korijen paketa (mapa u kojoj su `src/`, `locales/`, `config/`)
 */
export function provjeriRjecnike(korijen: string): NalazRjecnika {
  const greske: string[] = []
  const upozorenja: string[] = []
  const mapa = join(korijen, 'locales')

  const zadani = citajZadani(korijen, upozorenja)

  if (!existsSync(mapa)) {
    // Točan kvar TASK-4713: kod je stigao, mapa `locales/` nije.
    greske.push(`nema mape locales/ (${mapa}) — ploča bi pokazala samo ključeve`)
    return { greske, upozorenja, jezici: [], zadani }
  }

  const datoteke = readdirSync(mapa).filter((f) => f.endsWith('.json')).sort()
  if (datoteke.length === 0) {
    greske.push(`mapa locales/ ne sadrži nijedan rječnik (*.json)`)
    return { greske, upozorenja, jezici: [], zadani }
  }

  const rjecnici = new Map<string, Record<string, unknown>>()
  for (const f of datoteke) {
    try {
      const sadrzaj = JSON.parse(readFileSync(join(mapa, f), 'utf-8')) as unknown
      if (!sadrzaj || typeof sadrzaj !== 'object' || Array.isArray(sadrzaj)) {
        greske.push(`locales/${f} nije objekt ključ→prijevod`)
        continue
      }
      rjecnici.set(f.replace(/\.json$/, '').toLowerCase(), sadrzaj as Record<string, unknown>)
    } catch (err) {
      greske.push(`locales/${f} nije ispravan JSON: ${String(err)}`)
    }
  }

  const jezici = [...rjecnici.keys()].sort()

  // Podloga: TaskWebUI svaki prijevod slaže PREKO `en.json`. Bez nje nedostajući ključ
  // ne pada na englesku riječ nego na ništa.
  if (!rjecnici.has('en')) greske.push(`nema locales/en.json — podloga prijevoda nedostaje`)

  // Zadani jezik bez svog rječnika = prazan izbornik na čvoru (TASK-4713).
  if (jezici.length > 0 && !rjecnici.has(zadani)) {
    greske.push(`zadani jezik "${zadani}" nema locales/${zadani}.json (postoje: ${jezici.join(', ')})`)
  }

  // Nepotpun prijevod — upozorenje, ne greška.
  const podloga = rjecnici.get('en')
  if (podloga) {
    for (const [kod, rj] of rjecnici) {
      if (kod === 'en') continue
      const fale = Object.keys(rj).filter((k) => !(k in podloga))
      if (fale.length > 0) {
        const prvi = fale.slice(0, 5).join(', ')
        upozorenja.push(
          `locales/en.json nema ${fale.length} ključ(ev)a iz ${kod}.json: ${prvi}` +
          (fale.length > 5 ? ' …' : ''),
        )
      }
    }
  }

  return { greske, upozorenja, jezici, zadani }
}
