/**
 * PromptBuilder — prompt agenta sastavljen iz PREDLOŠKA, bez ijedne naše rečenice.
 *
 * NAJSKUPLJI NALAZ REVIZIJE (ADR-0001 S13): živi daemon na dva mjesta upisuje u SVAKI
 * prompt rečenicu s adresama vlastite infrastrukture i popisom vlastitih agenata. To ne
 * ostaje u kodu — ide u svaki poziv modela, pa bi svaka tuđa instalacija u vlastitom
 * sistemskom kontekstu vidjela tuđe adrese.
 *
 * Ovdje je zato pravilo: jezgra o infrastrukturi ne zna NIŠTA. Sve činjenice dolaze iz
 * `orchestrator.json → prompt.systemFacts`, koje piše korisnik. Prazan popis je ispravno
 * zatečeno stanje.
 *
 * Predložak: `templates/prompt/zadatak.md` uz paket ili vlastita mapa
 * (`prompt.templateDir` / `TM_PROMPT_TEMPLATES`). Zamjene su `{ime}`; nepoznata se
 * ostavlja doslovno, da tipfeler u predlošku bude vidljiv umjesto da tiho nestane.
 *
 * Autorica: Jelena (Engineer), TASK-4800.
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { PAKET_DIR } from '../paths'
import type { PromptComposer, PromptContext } from './Ports'

/** Ugrađeni predložak — koristi se kad mapa s predlošcima ne postoji. */
export const UGRADENI_PREDLOZAK = `# Zadatak {taskId}: {title}

{description}

## Tko si
{agentUloga}

## Protokol ploče
Označi početak rada:
  curl -s -X PUT {apiBase}/api/tasks/{taskId} -H 'Content-Type: application/json' -d '{"status":"in_progress"}'

Kad je gotovo (resultSummary mora sadržavati DOKAZ: naredbu, datoteku, izmjereni broj,
HTTP status ili commit — ne rečenicu „gotovo je"):
  curl -s -X PUT {apiBase}/api/tasks/{taskId} -H 'Content-Type: application/json' -d '{"status":"completed","resultSummary":"..."}'

Ako ne možeš dovršiti:
  curl -s -X PUT {apiBase}/api/tasks/{taskId} -H 'Content-Type: application/json' -d '{"status":"blocked","blockedReason":"..."}'

{systemFacts}
{verificationGate}
## Zadnji redak odgovora
Zadnji redak MORA biti jedna od ove tri deklaracije:
  REGOC-STATUS: DONE — <što je isporučeno>
  REGOC-STATUS: BLOCKED — <što ti nedostaje>
  REGOC-STATUS: NEEDS_CONTEXT — <koji opis nedostaje>
`

const BLOK_VERIFIKACIJE = `## Vrata provjere
Popravak na disku nije popravak u pogonu: dugotrajan proces (poslužitelj, daemon, radnik)
ne učitava kod ponovno. Ako si dirao takav kod, restartaj ga i u rezultat upiši novi PID
i vrijeme. Bez toga je „gotovo" netočno.
`

function zamijeni(predlozak: string, mapa: Record<string, string>): string {
  return predlozak.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (cijeli, ime) =>
    Object.prototype.hasOwnProperty.call(mapa, ime) ? mapa[ime]! : cijeli)
}

export class PredloskomSastavljenPrompt implements PromptComposer {
  private predlozak: string
  private ukljuciProtokol: boolean
  private ukljuciVrata: boolean

  constructor(opcije: {
    templateDir?: string | null
    includeTaskProtocol?: boolean
    includeVerificationGate?: boolean
  } = {}) {
    this.ukljuciProtokol = opcije.includeTaskProtocol !== false
    this.ukljuciVrata = opcije.includeVerificationGate !== false
    this.predlozak = ucitajPredlozak(opcije.templateDir ?? null)
  }

  build(ctx: PromptContext): string {
    const facts = (ctx.systemFacts || []).filter(r => String(r).trim())
    const tekst = zamijeni(this.predlozak, {
      taskId: ctx.task.id,
      title: ctx.task.title || '',
      description: ctx.task.description || '(opis nije zadan)',
      agentId: ctx.agent.id,
      agentIme: ctx.agent.ime || ctx.agent.id,
      agentUloga: ctx.agent.uloga || `Agent „${ctx.agent.id}".`,
      apiBase: ctx.apiBaseUrl,
      projectId: ctx.task.projectId || '',
      systemFacts: facts.length
        ? '## Infrastruktura (iz konfiguracije ove instalacije)\n' + facts.map(r => `- ${r}`).join('\n') + '\n'
        : '',
      verificationGate: this.ukljuciVrata ? BLOK_VERIFIKACIJE : '',
    })
    if (this.ukljuciProtokol) return tekst
    // Bez protokola: makni odsjek „Protokol ploče" do sljedećeg naslova druge razine.
    return tekst.replace(/## Protokol ploče[\s\S]*?(?=\n## )/, '')
  }
}

/** Predložak iz mape (vlastite ili one uz paket), inače ugrađeni. */
export function ucitajPredlozak(templateDir: string | null): string {
  const mape = [
    templateDir,
    process.env.TM_PROMPT_TEMPLATES || null,
    join(PAKET_DIR, 'templates', 'prompt'),
  ].filter(Boolean) as string[]
  for (const d of mape) {
    const p = join(d, 'zadatak.md')
    if (existsSync(p)) {
      try { return readFileSync(p, 'utf-8') } catch { /* idemo dalje */ }
    }
  }
  return UGRADENI_PREDLOZAK
}
