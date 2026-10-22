/**
 * TierRecipes.ts — recepti po tieru za slabe modele (P3 / TASK-2569, korak s1)
 *
 * PROBLEM (Jelena, JELENA_REGOC_ANALIZA.md §3 P3): slabiji model dobije zadatak
 * i mora SAM planirati kako ga izvesti — halucinira "completed" bez ikakve
 * provjere. LifeOS Algorithm ideja je da model ne planira nego SLIJEDI recept
 * za svoj tier (`ModeClassifier.EffortTier`), a svaki korak recepta završava
 * strojno provjerljivom verifikacijom.
 *
 * OVAJ MODUL je čista logika (bez I/O, bez importa daemona) — isti obrazac kao
 * `TaskTier.ts`: RegocDaemon.ts nema `import.meta.main` gate, pa bi ga import
 * u testu pokrenuo. `getRecipe()` samo vraća tekst; UGRADNJA u
 * `buildAgentPrompt()`/`AgentDaemon.buildPrompt()` i strojni gate koji odbija
 * `completed` bez verifikacijskog bloka NISU u opsegu ovog koraka (to je P3
 * "strojni verifikacijski gate" — poseban podzadatak istog nadzadatka).
 *
 * OBRAZAC BLOKA (RECIPE_BLOCK_MARKERS): svaki recept ovdje sadrži doslovno
 *   === VERIFIKACIJA ===
 *   naredba: <cmd>
 *   izlaz:
 *   <izlaz>
 *   === KRAJ VERIFIKACIJE ===
 * Agent ovaj obrazac citira u svom odgovoru; budući gate (drugi podzadatak)
 * regexom traži točno te markere da provjeri je li verifikacija stvarno
 * izvedena, ne samo tvrđena.
 */

import type { EffortTier } from './ModeClassifier'

/** Markeri bloka koje recepti propisuju i koje će strojni gate tražiti u odgovoru agenta. */
export const RECIPE_BLOCK_MARKERS = {
  /** Otvara verifikacijski blok. */
  START: '=== VERIFIKACIJA ===',
  /** Prefiks retka s izvršenom naredbom (nastavlja se `<cmd>`). */
  COMMAND_PREFIX: 'naredba:',
  /** Prefiks retka koji uvodi zabilježeni izlaz naredbe. */
  OUTPUT_PREFIX: 'izlaz:',
  /** Zatvara verifikacijski blok. */
  END: '=== KRAJ VERIFIKACIJE ===',
} as const

/** Primjer bloka umetnut u svaki recept — doslovan, agent ga citira uz svoje stvarne vrijednosti. */
function verificationBlockExample(cmd: string, expected: string): string {
  return [
    RECIPE_BLOCK_MARKERS.START,
    `${RECIPE_BLOCK_MARKERS.COMMAND_PREFIX} ${cmd}`,
    RECIPE_BLOCK_MARKERS.OUTPUT_PREFIX,
    expected,
    RECIPE_BLOCK_MARKERS.END,
  ].join('\n')
}

const E1_RECIPE = `RECEPT E1 — minimalan odgovor:
1. E1 je trivijalan zadatak (pozdrav, status, jednoznačno pitanje) — ODGOVORI izravno,
   bez izvođenja akcija i bez recepta E2/E3/E4/E5.
2. Ako odgovor ipak tvrdi da je nešto PROVJERENO (npr. status sustava), zalijepi doslovni
   obrazac s pravim izlazom umjesto pretpostavke:

${verificationBlockExample('<naredba koja dokazuje tvrdnju>', '<stvarni izlaz te naredbe>')}

3. Bez akcije nema ni koraka commit/checkpoint — javi odgovor izravno.`

const E2_RECIPE = `RECEPT E2 — jedna akcija:
1. Izvedi TOČNO JEDNU akciju koju zadatak traži (jedna izmjena, jedna naredba, jedan poziv).
2. Verificiraj rezultat konkretnom naredbom i doslovno zalijepi njezin izlaz u ovom obrascu:

${verificationBlockExample('<naredba koja dokazuje da akcija radi>', '<stvarni izlaz te naredbe>')}

3. Javi status (DONE/BLOCKED/NEEDS_CONTEXT) TEK nakon što je blok iznad ispunjen stvarnim izlazom — prazan ili izmišljen izlaz se ne priznaje.`

const E3_RECIPE = `RECEPT E3 — pročitaj → izvedi → testiraj → checkpoint → javi:
1. PROČITAJ kontekst — sve navedene ulazne datoteke, PRIJE prve izmjene.
2. IZVEDI zadatak — točno ono što je traženo, ni manje ni više.
3. TESTIRAJ — pokreni provjeru (test/naredbu) koja dokazuje da izvedeno radi.
4. COMMIT/CHECKPOINT — zabilježi napredak durabilno (git commit ili checkpoint zapis), ne samo u odgovoru.
5. Za korak 3 zalijepi doslovni obrazac s pravim izlazom:

${verificationBlockExample('<test/build naredba>', '<stvarni izlaz — npr. "0 fail" ili broj prošlih testova>')}

6. JAVI status tek nakon što je blok iznad ispunjen stvarnim izlazom.`

const E4_E5_RECIPE = `RECEPT E4/E5 — dekompozicija na 3–7 podzadataka:
1. NE izvodi cijeli zadatak u jednom potezu. Rastavi ga na 3 do 7 uskih podzadataka,
   svaki s jasnim ulazom, izlazom i vlasnikom.
2. Svaki podzadatak dobiva SVOJ recept prema svojoj težini:
   - podzadatak jednake veličine kao "1 akcija" → koristi RECEPT E2 (vidi getRecipe('E2')).
   - podzadatak veličine "pročitaj→izvedi→testiraj" → koristi RECEPT E3 (vidi getRecipe('E3')).
3. Svaki podzadatak MORA završiti vlastitim verifikacijskim blokom u obrascu:

${verificationBlockExample('<naredba specifična za taj podzadatak>', '<stvarni izlaz tog podzadatka>')}

4. Nadzadatak se javlja kao DONE tek kad su SVI podzadaci javili DONE sa svojim blokovima
   — jedan nedostajući ili izmišljeni blok drži nadzadatak otvorenim.`

const RECIPES: Readonly<Record<EffortTier, string>> = {
  E1: E1_RECIPE,
  E2: E2_RECIPE,
  E3: E3_RECIPE,
  E4: E4_E5_RECIPE,
  E5: E4_E5_RECIPE,
}

/**
 * Vraća tekst recepta za dani tier (E1–E5, na hrvatskom).
 *
 * Nepoznat/nevažeći tier NIKAD ne baca — vraća prazan string, isti ugovor kao
 * `tierOfModel()` u `TaskTier.ts` koji za nepoznato vraća `null` umjesto throwa.
 */
export function getRecipe(tier: string): string {
  return (RECIPES as Record<string, string>)[tier] ?? ''
}
