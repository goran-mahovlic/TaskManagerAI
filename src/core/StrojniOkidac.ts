/**
 * StrojniOkidac.ts — brava za zadatke čiji je okidač STROJNO PROVJERLJIV.
 *
 * POVOD (mjereno 05.09.2026. na TASK-4651, iz `progress_notes`):
 *   13:55:43  odlučitelj (openrouter/auto): ODGODI — „okidač još nije stigao, ponovilo bi TASK-4641"
 *   14:02:10  isti odlučitelj, isti zadatak, NEPROMIJENJENA podloga: KRENI — „waiting 15h"
 * Suprotan sud u sedam minuta; pobijedio je drugi i digao zadatak 2,2 dana prerano (arhiv
 * osigurača pokriva prozor tek 07.09.2026. 17:44Z). Isti kvar je prije toga već digao TASK-4641.
 *
 * UZROK NIJE MODEL nego raspodjela ovlasti: odlučitelj sudi ISKLJUČIVO iz naslova i opisa, a
 * stanje okidača (je li datoteka nastala, je li prošao trenutak, je li preduvjetni zadatak
 * dovršen) NE VIDI. Za takav zadatak svaki njegov sud — i ODGODI i KRENI — je nagađanje, a
 * `smije_kreni: true` nagađanje pretvara u spawn. Oznaka `needs-decision` to nije zaustavljala:
 * `handleTaskOdluka` na KRENI skida SVE oznake iz `OZNAKE_ODLUKE`, dopiše `nalog` i vrati
 * zadatak u `pending` — dakle oznaka je bila natpis, ne brava.
 *
 * RJEŠENJE (Kosjenka, 05.09.2026., ADR-0010): ne zabranjuje se puštanje nego NAGAĐANJE.
 * Zadatak s oznakom `okidac-strojni` smije se pustiti samo uz **činjenicu koju poslužitelj
 * može sam provjeriti** — datoteka koja postoji, trenutak koji je prošao, zadatak koji je
 * dovršen. Tvrdnja se ne vjeruje na riječ: ovaj modul je provjeri ovdje i sada. Model koji
 * nema pristup stanju ne može izmisliti činjenicu koja prolazi provjeru, a čovjek koji ju
 * doista zna samo ju napiše.
 *
 * Zašto ne `smije_kreni: false` globalno: to bi ugasilo odlučitelja i za 99 % zadataka kojima
 * okidač uopće nije stroj — lijek bi bio širi od bolesti (i vlasnik ga nije odobrio).
 *
 * ČOVJEKOV IZLAZ U NUŽDI je namjerno odvojen potez: skini oznaku `okidac-strojni` s zadatka
 * (PUT /api/tasks/<ID> `{tags: […bez nje]}`) pa odluči normalno. Odlučitelj to nikad ne radi
 * — on piše samo kroz `/odluka`.
 */
import { existsSync, readFileSync } from 'fs'

/** Oznaka koja kaže: „okidač ovog zadatka je stroj, ne prosudba." */
export const OZNAKA_STROJNI_OKIDAC = 'okidac-strojni'

export function imaStrojniOkidac(tags: unknown): boolean {
  return Array.isArray(tags)
    && tags.some(g => String(g).trim().toLowerCase() === OZNAKA_STROJNI_OKIDAC)
}

export interface SudCinjenice {
  ok: boolean
  /** Ljudski čitljivo što je provjereno i kako je ispalo — ide u povijest zadatka. */
  opis: string
}

/** Oblici koje poslužitelj zna provjeriti. Ispisuju se u odbijenici da pozivatelj zna što smije. */
export const OBLICI_CINJENICE = [
  'poslije:<ISO trenutak>  — npr. poslije:2026-09-07T17:44:00Z (prošao je taj trenutak)',
  'datoteka:<putanja>      — npr. datoteka:$TM_HOME/data/x.json (postoji)',
  'zadatak:<TASK-ID>       — npr. zadatak:TASK-4641 (dovršen je)',
  'zapis:<putanja>#<ključ>=<vrijednost> — npr. '
    + 'zapis:$TM_HOME/data/spawn_breaker_arhiv.state.json#last_ishod=PASS',
]

export interface KontekstProvjere {
  /** Postoji li datoteka. Provjere podmeću vlastitu da ne ovise o disku. */
  postoji?: (put: string) => boolean
  /** Sadržaj datoteke (za `zapis:`). Baca kad je nema — to je „nije dokazano". */
  citaj?: (put: string) => string
  /** Sadašnji trenutak u ms. */
  sada?: () => number
  /** Status zadatka po ID-u (`undefined` = zadatak ne postoji). */
  status?: (id: string) => string | undefined
}

/**
 * Provjeri navedenu činjenicu. Vraća `ok: false` za sve što nije DOKAZANO točno —
 * neprepoznat oblik, nepostojeći zadatak i neispravan nadnevak jednako su „nije dokazano".
 * Fail-closed je ovdje jedina ispravna strana: pogreška u čitanju ne smije pustiti zadatak.
 */
export function provjeriCinjenicu(cinjenica: string, ctx: KontekstProvjere = {}): SudCinjenice {
  const postoji = ctx.postoji ?? ((p: string) => existsSync(p))
  const sada = ctx.sada ?? (() => Date.now())
  const status = ctx.status ?? (() => undefined)

  const tekst = String(cinjenica || '').trim()
  if (!tekst) return { ok: false, opis: 'nije navedena provjerena činjenica' }

  const razdvoj = tekst.indexOf(':')
  const vrsta = (razdvoj > 0 ? tekst.slice(0, razdvoj) : tekst).trim().toLowerCase()
  const vrijednost = razdvoj > 0 ? tekst.slice(razdvoj + 1).trim() : ''

  if (!vrijednost) return { ok: false, opis: `oblik „${tekst}" nema vrijednost iza dvotočke` }

  switch (vrsta) {
    case 'poslije': {
      // `Date.parse` bez vremenske zone čita kao lokalno vrijeme — to je ovdje prihvatljivo
      // jer je odstupanje najviše sat-dva, a pogreška ide na stranu čekanja samo ako je
      // zapisano bez zone. Preporučeni oblik u ispisu nosi `Z`.
      const t = Date.parse(vrijednost)
      if (Number.isNaN(t)) return { ok: false, opis: `„${vrijednost}" nije čitljiv trenutak` }
      const razlika = sada() - t
      return razlika >= 0
        ? { ok: true, opis: `trenutak ${vrijednost} je prošao (prije ${Math.round(razlika / 6e4)} min)` }
        : { ok: false, opis: `trenutak ${vrijednost} JOŠ NIJE stigao (fali ${Math.round(-razlika / 6e4)} min)` }
    }
    case 'datoteka': {
      if (!vrijednost.startsWith('/')) {
        return { ok: false, opis: `putanja „${vrijednost}" nije apsolutna` }
      }
      return postoji(vrijednost)
        ? { ok: true, opis: `datoteka ${vrijednost} postoji` }
        : { ok: false, opis: `datoteke ${vrijednost} NEMA` }
    }
    case 'zapis': {
      // Za okidače koje stroj već negdje zapisuje: `spawn-breaker-arhiv-cron.sh` upisuje
      // `last_ishod` u svoj `state.json`, pa se PASS ne mora prepričavati — pročita se.
      // Namjerno SAMO čitanje JSON-a; naredbe se ne pokreću (opis piše agent).
      const rez = vrijednost.indexOf('#')
      if (rez < 0) return { ok: false, opis: `„${vrijednost}" nema oblik <putanja>#<ključ>=<vrijednost>` }
      const put = vrijednost.slice(0, rez).trim()
      const uvjet = vrijednost.slice(rez + 1)
      const eq = uvjet.indexOf('=')
      if (!put.startsWith('/') || eq < 0) {
        return { ok: false, opis: `„${vrijednost}" nema oblik <apsolutna putanja>#<ključ>=<vrijednost>` }
      }
      const kljuc = uvjet.slice(0, eq).trim()
      const trazeno = uvjet.slice(eq + 1).trim()
      let podatci: any
      try {
        podatci = JSON.parse((ctx.citaj ?? ((p: string) => readFileSync(p, 'utf-8')))(put))
      } catch {
        return { ok: false, opis: `${put} se ne može pročitati kao JSON` }
      }
      // Ključ smije biti ugniježđen (`a.b.c`) — plitko gledanje bi tjeralo na ravne datoteke.
      let cvor: any = podatci
      for (const dio of kljuc.split('.')) {
        cvor = (cvor && typeof cvor === 'object') ? cvor[dio] : undefined
      }
      if (cvor === undefined) return { ok: false, opis: `u ${put} nema ključa ${kljuc}` }
      const nadjeno = String(cvor)
      return nadjeno.toLowerCase() === trazeno.toLowerCase()
        ? { ok: true, opis: `${put} → ${kljuc} = ${nadjeno}` }
        : { ok: false, opis: `${kljuc} je „${nadjeno}", a traži se „${trazeno}"` }
    }
    case 'zadatak': {
      const id = vrijednost.toUpperCase()
      const s = status(id)
      if (s === undefined) return { ok: false, opis: `zadatka ${id} nema u bazi` }
      return s === 'completed'
        ? { ok: true, opis: `zadatak ${id} je dovršen` }
        : { ok: false, opis: `zadatak ${id} NIJE dovršen (status: ${s})` }
    }
    default:
      return { ok: false, opis: `oblik „${vrsta}" nije provjerljiv na poslužitelju` }
  }
}
