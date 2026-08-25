/**
 * Jedan izvor istine za NAZIVE polja zadatka na HTTP ulazu (D6 / TASK-2976).
 *
 * KVAR: prompt-predložak koji daemon šalje svakom agentu piše snake_case
 * (`result_summary`, `progress_notes`, `blocked_reason`), a shema/baza rade u
 * camelCase. Zod po defaultu radi `.strip()` — nepoznat ključ nestane BEZ greške,
 * pa je agent slao sažetak, dobivao HTTP 200, a sažetak se nikad nije spremio.
 * Mjereno 2026-07-28 u regoc.db: 449 od 509 završenih zadataka bez rezultata.
 *
 * RJEŠENJE: aliasi se NE prepisuju ručno (drugi popis = novi izvor truleži) nego se
 * IZVODE iz Zod sheme — `progressNotes` ⇒ `progress_notes`. Novo polje u shemi
 * automatski dobiva alias. Nakon preslikavanja ono što je preostalo je stvarno
 * nepoznato i pozivatelj o tome MORA čuti (400 na PUT, upozorenje na POST).
 */
import { CreateTaskInputSchema, UpdateTaskInputSchema } from '../zod/schemas/task'

/** `resultSummary` → `result_summary`. Jedina konverzija; sve ostalo se iz nje izvodi. */
export const camelToSnake = (s: string): string => s.replace(/[A-Z]/g, c => '_' + c.toLowerCase())

/** Kanonska (camelCase) polja koja API prima — čitana iz Zod sheme, ne prepisana. */
export const UPDATE_TASK_FIELDS: readonly string[] = Object.keys(UpdateTaskInputSchema.shape)
export const CREATE_TASK_FIELDS: readonly string[] = [
  ...Object.keys(CreateTaskInputSchema.shape),
  // Stvaratelj se dosad tvrdo upisivao kao 'user' bez obzira što je pozivatelj poslao —
  // isti obrazac tihog gutanja. Sad je polje priznato (i dalje s razumnim defaultom).
  'createdBy',
]

export interface NormalizedFields {
  /** Tijelo prevedeno u kanonske nazive; nepoznati ključevi su IZBAČENI, ne progutani. */
  normalized: Record<string, unknown>
  /** Ključevi koje API ne poznaje ni pod jednim imenom (tipfeler, izmišljen naziv). */
  unknown: string[]
  /** snake_case ključevi koji su preslikani u kanonske (za log/telemetriju). */
  aliased: string[]
  /** Poslana OBA naziva istog polja — camelCase je mjerodavan, ovo je popis progutanih. */
  conflicts: string[]
}

/**
 * Prevede tijelo zahtjeva u kanonske nazive polja i prijavi sve što ne prepoznaje.
 * Ništa se ne gubi u tišini: svaki ključ završi ili u `normalized`, ili u `unknown`,
 * ili u `conflicts`.
 */
export function normalizeTaskFields(body: unknown, fields: readonly string[]): NormalizedFields {
  const out: NormalizedFields = { normalized: {}, unknown: [], aliased: [], conflicts: [] }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return out

  // alias (snake) → kanonsko (camel); samo za polja koja se stvarno razlikuju.
  const aliasToCanonical = new Map<string, string>()
  for (const field of fields) {
    const snake = camelToSnake(field)
    if (snake !== field) aliasToCanonical.set(snake, field)
  }
  const known = new Set(fields)

  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (known.has(key)) {
      out.normalized[key] = value
      continue
    }
    const canonical = aliasToCanonical.get(key)
    if (!canonical) {
      out.unknown.push(key)
      continue
    }
    // Ako je camelCase varijanta već stigla, ona je mjerodavna — alias se ne primjenjuje,
    // ali se prijavi da pozivatelj ne misli da je poslao dvije različite vrijednosti.
    if (Object.prototype.hasOwnProperty.call(body, canonical)) {
      out.conflicts.push(key)
      continue
    }
    out.normalized[canonical] = value
    out.aliased.push(key)
  }
  return out
}

/** Popis parova za dokumentaciju API-ja (docs/API_TASK_FIELDS.md se generira iz ovoga). */
export function taskFieldAliasTable(fields: readonly string[]): Array<{ canonical: string; alias: string }> {
  return fields
    .map(canonical => ({ canonical, alias: camelToSnake(canonical) }))
    .filter(p => p.alias !== p.canonical)
}

/** Poruka za HTTP 400 — mora reći ŠTO se smije poslati, inače agent samo ponovi tipfeler. */
export function unknownFieldResponseBody(unknown: string[], fields: readonly string[]) {
  return {
    error: 'Unknown field',
    code: 'unknown_field',
    unknownFields: unknown,
    details:
      `API ne poznaje polje/polja: ${unknown.join(', ')}. ` +
      `Zahtjev je ODBIJEN u cijelosti (prije se tiho vraćalo 200 i polje bi nestalo — D6/TASK-2976).`,
    acceptedFields: [...fields].sort(),
    hint:
      'Nazivi su camelCase; snake_case alias se prihvaća (resultSummary/result_summary, ' +
      'progressNotes/progress_notes, blockedReason/blocked_reason). Vidi docs/API_TASK_FIELDS.md.',
  }
}
