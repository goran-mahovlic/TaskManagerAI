#!/usr/bin/env bun
/**
 * Pokretač orkestratora — sloj 1 (ADR-0001 O2, korak „Pokreni orkestrator" iz INSTALL.md).
 *
 *   bun scripts/orchestrator.ts                 # petlja, čita config/orchestrator.json
 *   bun scripts/orchestrator.ts --jednom        # točno jedan prolaz (za cron ili provjeru)
 *   bun scripts/orchestrator.ts --stanje        # ispiši što je podešeno i izađi
 *   bun scripts/orchestrator.ts --api http://…  # nadjačaj adresu ploče
 *
 * Bez `enabled: true` u konfiguraciji (ili `TM_ORCHESTRATOR_ENABLED=1`) pokretač NIŠTA ne
 * spawna i to kaže. Svježa instalacija ne smije početi dizati agente time što je netko
 * pokrenuo skriptu da vidi što radi.
 */

import {
  loadOrchestratorConfig, orkestratorUkljucen, sastaviOrkestrator, stanjeOrkestratora,
} from '../src/core/orchestrator'

const args = process.argv.slice(2)
const imaZastavicu = (i: string) => args.includes(i)
const vrijednost = (i: string) => {
  const k = args.indexOf(i)
  return k >= 0 && args[k + 1] ? args[k + 1]! : null
}

const cfg = loadOrchestratorConfig()
const api = vrijednost('--api')
if (api) cfg.api.baseUrl = api.replace(/\/+$/, '')

const stanje = stanjeOrkestratora(cfg)

if (imaZastavicu('--stanje')) {
  const { greske } = sastaviOrkestrator(cfg)
  console.log(JSON.stringify({ stanje, ploca: cfg.api.baseUrl, greske }, null, 2))
  process.exit(greske.length ? 1 : 0)
}

const { orkestrator, greske } = sastaviOrkestrator(cfg)
for (const g of greske) console.warn(`⚠️  ${g}`)

if (!orkestrator) {
  console.error('✗ orkestrator nije složen — v. razloge gore i docs/INSTALL.md, korak „Sloj 1".')
  process.exit(1)
}

if (!orkestratorUkljucen(cfg)) {
  console.log('ℹ️  orkestrator je isključen (enabled: false). Uključi ga na ploči, u')
  console.log('   config/orchestrator.json ili varijablom TM_ORCHESTRATOR_ENABLED=1.')
  process.exit(0)
}

if (imaZastavicu('--jednom')) {
  const ishod = await orkestrator.jedanProlaz()
  console.log(JSON.stringify(ishod, null, 2))
  process.exit(0)
}

orkestrator.start()
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    orkestrator.stop()
    process.exit(0)
  })
}
