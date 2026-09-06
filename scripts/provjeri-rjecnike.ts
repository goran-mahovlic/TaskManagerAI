#!/usr/bin/env bun
/**
 * provjeri-rjecnike.ts — TASK-4719. Ulaz za `scripts/install.sh`.
 *
 * Instalacija je dosad javljala „U REDU" na temelju `/health`, koji o rječnicima ne zna
 * ništa (kvar TASK-4713: kod stigne, `locales/` ne). Ovo je ista provjera koju vrti
 * `bun test`, samo pokrenuta na stvarnoj instalaciji.
 *
 *   bun scripts/provjeri-rjecnike.ts            # izlaz 0 = u redu, 1 = ploča bi bila bez jezika
 *   bun scripts/provjeri-rjecnike.ts /putanja   # provjeri drugi korijen (npr. ~/TaskManagerAI)
 */
import { provjeriRjecnike } from '../src/core/Rjecnici'

const korijen = process.argv[2] || `${import.meta.dir}/..`
const nalaz = provjeriRjecnike(korijen)

for (const u of nalaz.upozorenja) console.log(`  upozorenje: ${u}`)
for (const g of nalaz.greske) console.log(`  GREŠKA: ${g}`)

if (nalaz.greske.length > 0) {
  console.log(`  rječnici: NEISPRAVNO (${nalaz.greske.length} greš.) — ploča bi pokazala ključeve`)
  process.exit(1)
}
console.log(`  rječnici: ${nalaz.jezici.join(', ') || '—'} (zadani: ${nalaz.zadani})`)
