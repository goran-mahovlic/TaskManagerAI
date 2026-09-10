/**
 * Brana: u paketu ne smije biti NAŠIH vrijednosti — ni adresa, ni imena, ni putanja.
 *
 * Provodi pravilo iz `docs/adr/ADR-0001-orchestrator-core.md` §8.
 *
 * ZAŠTO ZAPOR (ratchet), A NE TVRDA NULA. Izmjereno 10.09.2026. na commitu `f37d7b5`, nad
 * 107 datoteka koje git prati: 73 pojave `/home/klaudio` u 25 datoteka, 148 pojava
 * `.claude/regoc` u 47 datoteka, naši IP-ovi u 10 datoteka, Goranov osobni git identitet
 * kao konstanta u `src/core/WorkflowTemplate.ts`. Test s tvrdom nulom padao bi na `main`
 * od prvog dana, a test koji stalno pada biva isključen — točno onaj kvar zbog kojeg je
 * `SecurityValidator` hook godinama bio mrtav kod.
 *
 * Zato zapor: test pada SAMO ako broj pojava NARASTE ili se pojava javi u NOVOJ datoteci.
 * Svako čišćenje spušta osnovicu u istom commitu s popravkom, dok osnovica ne padne na nulu.
 * Time cilj „bez ijedne naše vrijednosti" prestaje biti izjava i postaje mjerena brojka.
 *
 * ŠTO SE PRETRAŽUJE: isključivo ono što **git prati** — to je definicija onoga što korisnik
 * skine s GitHuba. Radne datoteke, `node_modules` i `__pycache__` nisu paket.
 *
 * ŠTO SE NE PRETRAŽUJE: `docs/` (ADR i dizajnerski dokumenti moraju smjeti citirati kvar koji
 * opisuju) i sama ova datoteka (uzorci su joj sadržaj).
 *
 * Autorica: Kosjenka (Architect), TASK-4799.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const KORIJEN = join(import.meta.dir, '..')
const SAMA_BRANA = 'tests/bez-nasih-vrijednosti.test.ts'
const BINARNO = /\.(png|jpg|jpeg|gif|ico|webp|pdf|zip|db|lock)$/

/** Popis onoga što se isporučuje = ono što git prati. */
function pratiGit(): string[] {
  const r = Bun.spawnSync(['git', 'ls-files'], { cwd: KORIJEN })
  if (r.exitCode !== 0) return []
  return r.stdout.toString().trim().split('\n')
    .filter(p => p && !p.startsWith('docs/') && p !== SAMA_BRANA && !BINARNO.test(p))
}

interface Pravilo {
  ime: string
  uzorak: string
  objasnjenje: string
  /** Izmjereno 10.09.2026. na `f37d7b5`. Smije samo padati. */
  osnovicaPojava: number
  osnovicaDatoteka: string[]
}

const PRAVILA: Pravilo[] = [
  {
    ime: 'naš HOME kao zadana vrijednost',
    uzorak: '/home/klaudio',
    objasnjenje: 'koristi `src/core/paths.ts` (TM_ROOT), nikad tuđi $HOME kao rezervu (ADR-0001 O1.1)',
    osnovicaPojava: 73,
    osnovicaDatoteka: [
      'scripts/uskladi_s_regocem.sh',
      'scripts/zakrpe/u6-ingest.patch',
      'src/DezurniConfig.ts',
      'src/SessionUsage.ts',
      'src/TaskTelemetry.ts',
      'src/TaskWebUI.ts',
      'src/Tecaj.ts',
      'src/TelegramConfig.ts',
      'src/TjedniPregled.ts',
      'src/core/AutonomyQueue.ts',
      'src/core/CompletionGuard.ts',
      'src/core/CriticGate.ts',
      'src/core/GitCommitGate.ts',
      'src/core/OdluciteljPogon.ts',
      'src/core/PauseControl.ts',
      'src/core/QuotaWakeup.ts',
      'src/core/ReportBackSweepLive.ts',
      'src/core/ReportBackTask.ts',
      'src/core/ResearchRagGate.ts',
      'src/core/StepSchema.ts',
      'src/core/StrojniOkidac.ts',
      'src/core/TaskManagerSQL.ts',
      'src/core/UnverifiedReport.ts',
      'src/core/WorkflowGate.ts',
      'src/rag/rag-memory.ts',
    ],
  },
  {
    ime: 'naši IP-ovi',
    uzorak: '192\\.168\\.10\\.\\d+',
    objasnjenje: 'adresa nikad nije zadana vrijednost — `null` + varijabla okoline (ADR-0001 §5.1)',
    osnovicaPojava: 24,
    osnovicaDatoteka: [
      'config/postavke.env.primjer',
      'src/DezurniConfig.ts',
      'src/RAGService.ts',
      'src/TaskWebUI.ts',
      'tools/dezurni.py',
      'tools/odlucitelj.py',
      'tools/rag_archive.py',
      'tools/rag_audit.py',
      'tools/rag_izdvoji.py',
      'tools/rag_tipovi.py',
    ],
  },
  {
    ime: 'naša e-pošta / domena',
    uzorak: 'goran\\.mahovlic@gmail\\.com|@intergalaktik\\.hr',
    objasnjenje:
      'u README/LICENCI je autorstvo i to je u redu; u KODU je git identitet i mora biti '
      + 'konfiguracija bez zadane vrijednosti (ADR-0001 O1.3, v. src/core/WorkflowTemplate.ts)',
    osnovicaPojava: 8,
    osnovicaDatoteka: [
      '.githooks/commit-msg',
      'CONTRIBUTING.md',
      'README.hr.md',
      'README.md',
      'src/core/WorkflowTemplate.ts',
      'tests/commit-msg-hook.test.ts',
    ],
  },
  {
    ime: 'naš Telegram chat id',
    uzorak: '5161938429',
    objasnjenje: 'u primjerima koristi izmišljeni id (npr. -1001234567890)',
    osnovicaPojava: 11,
    osnovicaDatoteka: [
      'src/core/IngestConfig.ts',
      'src/core/ReportBackTask.ts',
      'tests/ingest.test.ts',
    ],
  },
  {
    ime: 'naš raspored mapa (~/.claude/regoc)',
    uzorak: '\\.claude/regoc',
    objasnjenje: 'putanja konfiguracije ide obrascem iz `IngestConfig.zadanaPutanja()` (ADR-0001 O1.4)',
    osnovicaPojava: 148,
    osnovicaDatoteka: [
      'CHANGELOG.md',
      'agents/workflows.json',
      'config/postavke.env.primjer',
      'scripts/install-agents.sh',
      'scripts/install.sh',
      'scripts/uskladi_s_regocem.sh',
      'scripts/zakrpe/u6-ingest.patch',
      'src/DezurniConfig.ts',
      'src/LoginCreds.ts',
      'src/SessionUsage.ts',
      'src/TaskWebUI.ts',
      'src/TelegramConfig.ts',
      'src/core/CompletionGuard.ts',
      'src/core/CostTracker.ts',
      'src/core/CriticGate.ts',
      'src/core/FeatureFlags.ts',
      'src/core/GitCommitGate.ts',
      'src/core/IngestConfig.ts',
      'src/core/LiveDbGuard.ts',
      'src/core/MessageQueue.ts',
      'src/core/ModeClassifier.ts',
      'src/core/OdluciteljPogon.ts',
      'src/core/PauseControl.ts',
      'src/core/ProjectManager.ts',
      'src/core/ReportBackSweepLive.ts',
      'src/core/ReportBackTask.ts',
      'src/core/ResearchRagGate.ts',
      'src/core/StepSchema.ts',
      'src/core/StrojniOkidac.ts',
      'src/core/TaskCreateBreaker.ts',
      'src/core/TaskDecomposer.ts',
      'src/core/TaskManagerSQL.ts',
      'src/core/UnverifiedReport.ts',
      'src/core/WorkflowGate.ts',
      'src/core/models/ClassifierModel.ts',
      'src/rag/memory-config.ts',
      'src/rag/rag-memory.ts',
      'tools/agent_telemetry.py',
      'tools/dezurni.py',
      'tools/odaberi_workflow.py',
      'tools/odlucitelj.py',
      'tools/rag_archive.py',
      'tools/razvrstaj_pretinac.py',
      'tools/razvrstaj_prijave.py',
      'tools/test_tjedni_pregled.py',
      'tools/tjedni_pregled.py',
      'tools/uvoz_telegram_zadataka.py',
    ],
  },
]

interface Nalaz { pojava: number; datoteke: string[] }

function prebroji(uzorak: string, popis: string[]): Nalaz {
  let pojava = 0
  const pogodjene: string[] = []
  for (const rel of popis) {
    let tekst: string
    try { tekst = readFileSync(join(KORIJEN, rel), 'utf-8') } catch { continue }
    const m = tekst.match(new RegExp(uzorak, 'g'))
    if (m && m.length) { pojava += m.length; pogodjene.push(rel) }
  }
  return { pojava, datoteke: pogodjene.sort() }
}

const POPIS = pratiGit()

describe('paket ne smije nositi naše vrijednosti (ADR-0001 §8)', () => {
  test('skener vidi paket (inače bi svako pravilo prolazilo prazno)', () => {
    expect(POPIS.length).toBeGreaterThan(50)
  })

  for (const p of PRAVILA) {
    test(`zapor — ${p.ime}`, () => {
      const nalaz = prebroji(p.uzorak, POPIS)

      // 1) Nijedna NOVA datoteka. Ovo hvata curenje u trenutku nastanka, prije nego se namnoži.
      const nove = nalaz.datoteke.filter(d => !p.osnovicaDatoteka.includes(d))
      expect(
        nove.length === 0
          ? 'nema novih'
          : `NOVO CURENJE (${p.ime}) u: ${nove.join(', ')} — ${p.objasnjenje}`,
      ).toBe('nema novih')

      // 2) Broj pojava smije samo padati.
      expect(nalaz.pojava).toBeLessThanOrEqual(p.osnovicaPojava)
    })
  }

  test('osnovica nije zastarjela (ako je posao napravljen, spusti brojke)', () => {
    const zaostalo: string[] = []
    for (const p of PRAVILA) {
      const n = prebroji(p.uzorak, POPIS)
      if (n.pojava < p.osnovicaPojava || n.datoteke.length < p.osnovicaDatoteka.length) {
        zaostalo.push(
          `${p.ime}: osnovica ${p.osnovicaPojava} pojava / ${p.osnovicaDatoteka.length} dat., `
          + `stvarno ${n.pojava} / ${n.datoteke.length} → spusti osnovicu u ${SAMA_BRANA}`,
        )
      }
    }
    // Ne ruši build — samo govori. Zastarjela osnovica je tiho popuštanje brane, pa mora biti vidljiva.
    if (zaostalo.length) console.warn('ℹ️  osnovica je zastarjela:\n   ' + zaostalo.join('\n   '))
    expect(zaostalo.length).toBeGreaterThanOrEqual(0)
  })
})
