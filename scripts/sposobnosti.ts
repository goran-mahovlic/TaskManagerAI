#!/usr/bin/env bun
/**
 * Neobavezne ovisnosti za UKLJUČENE sposobnosti čvora (TASK-5358, uputa #200).
 *
 *   bun scripts/sposobnosti.ts               # samo provjera: što treba, što nedostaje
 *   bun scripts/sposobnosti.ts --instaliraj  # nedostaje li nešto → `bun install` (s neobaveznim)
 *
 * Izlaz: 0 sve potrebno postoji · 1 nešto i dalje nedostaje (npr. čvor bez registra) · 2 greška.
 * Zovu ga `scripts/install.sh` i ažuriranje čvora; korisnik nikad ne mora pokretati `bun add`.
 */
import { join } from 'path'
import { nedostaju, potrebneOvisnosti } from '../src/Sposobnosti'

const PAKET = join(import.meta.dir, '..')
const instaliraj = process.argv.includes('--instaliraj')

try {
  const potrebe = potrebneOvisnosti()
  if (!potrebe.length) { console.log('  sposobnosti: nijedna neobavezna sposobnost nije uključena'); process.exit(0) }
  for (const p of potrebe) console.log(`  sposobnost: ${p.sposobnost} → ${p.paketi.join(', ')}`)
  let fale = nedostaju(potrebe, PAKET)
  if (fale.length && instaliraj) {
    console.log(`  nedostaje: ${fale.join(', ')} — bun install (neobavezne ovisnosti iz package.json)`)
    const r = Bun.spawnSync(['bun', 'install'], { cwd: PAKET, stdout: 'ignore', stderr: 'pipe', timeout: 180_000 })
    if (r.exitCode !== 0) console.log(`  bun install nije uspio (izlaz ${r.exitCode}): ${String(r.stderr || '').trim().split('\n').pop()?.slice(0, 200) || 'nema registra?'}`)
    fale = nedostaju(potrebe, PAKET)
  }
  if (fale.length) {
    console.log(`  UPOZORENJE: i dalje nedostaje ${fale.join(', ')}${instaliraj ? '' : ' (pokreni s --instaliraj)'}`)
    process.exit(1)
  }
  console.log('  sposobnosti: sve potrebne knjižnice postoje ✓')
} catch (e) {
  console.log(`  sposobnosti: greška ${String(e)}`)
  process.exit(2)
}
