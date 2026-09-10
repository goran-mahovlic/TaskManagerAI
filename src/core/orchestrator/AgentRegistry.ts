/**
 * AgentRegistry — tko postoji i tko što radi (ADR-0001 O5).
 *
 * ZAŠTO PRAZAN PREDLOŽAK, A NE NAŠI AGENTI. Živi daemon nosi devet grana hrvatskih ključnih
 * riječi koje vode na imenovane agente jedne instalacije (nalaz S7) i registar s njihovim
 * ulogama (S6). To u paketu nema smisla: tuđi korisnik nema ni ta imena ni te uloge.
 * Rutiranje zato prelazi iz KODA u KONFIGURACIJU — `config/agents.json`, jedan zapis po
 * agentu s vlastitim ključnim riječima.
 *
 * Bez ijednog agenta jezgra radi, ali ništa ne spawna i to jasno kaže u dnevniku. To je
 * ispravno zatečeno stanje svježe instalacije, ne kvar.
 *
 * Autorica: Jelena (Engineer), TASK-4800.
 */

import { readFileSync } from 'fs'
import { konfigPutanja } from '../paths'
import type { AgentDirectory, AgentInfo, Ruta } from './Ports'

/**
 * Putanja se razrjesava PRI SVAKOM CITANJU: registar smije nastati POSLIJE pokretanja
 * ploce (korisnik ga stvara u koraku 6 instalacije), a zamrznuta vrijednost bi tada
 * zauvijek pokazivala da agenata nema.
 */
export function agentsConfigPath(): string {
  return konfigPutanja('agents.json', 'TM_AGENTS_CONFIG')
}

/** Zamrznuto pri pokretanju — samo za prikaz. */
export const AGENTS_CONFIG_PATH = agentsConfigPath()

export interface AgentsDatoteka {
  agents: AgentInfo[]
}

/** Pročitaj registar. Neispravna datoteka = prazan registar (i redak u dnevniku). */
export function loadAgents(path: string = agentsConfigPath()): AgentInfo[] {
  try {
    const sirovo = JSON.parse(readFileSync(path, 'utf-8'))
    const popis = Array.isArray(sirovo) ? sirovo : sirovo?.agents
    if (!Array.isArray(popis)) return []
    return popis
      .filter(a => a && typeof a === 'object' && typeof a.id === 'string' && a.id.trim())
      .map((a: any): AgentInfo => ({
        id: String(a.id).trim(),
        ime: a.ime ? String(a.ime) : undefined,
        uloga: a.uloga ? String(a.uloga) : undefined,
        model: a.model ? String(a.model) : undefined,
        keywords: Array.isArray(a.keywords) ? a.keywords.map((k: unknown) => String(k).toLowerCase()) : [],
        rag: Array.isArray(a.rag) ? a.rag.map((k: unknown) => String(k)) : [],
        executor: a.executor ? String(a.executor) : undefined,
      }))
  } catch {
    return []
  }
}

/**
 * Rutiranje po ključnim riječima iz konfiguracije.
 *
 * Redoslijed je namjerno određen: pobjeđuje agent s NAJDUŽOM pogođenom ključnom riječi, a
 * `*` (catch-all) tek kad nijedna druga ne pogodi. Bez tog pravila redoslijed u datoteci
 * tiho odlučuje o rutiranju, pa isti tekst ide različitim agentima ovisno o tome tko je
 * gore — kvar koji se u živom daemonu vidio kao „zadatak je opet dobio krivog agenta".
 */
export class KonfiguracijskiRegistar implements AgentDirectory {
  private popis: AgentInfo[]

  constructor(popis: AgentInfo[] = []) {
    this.popis = popis
  }

  static izDatoteke(path: string = agentsConfigPath()): KonfiguracijskiRegistar {
    return new KonfiguracijskiRegistar(loadAgents(path))
  }

  list(): AgentInfo[] { return [...this.popis] }

  get(id: string): AgentInfo | null {
    const trazen = String(id || '').trim().toLowerCase()
    return this.popis.find(a => a.id.toLowerCase() === trazen) || null
  }

  route(tekst: string): Ruta | null {
    const t = String(tekst || '').toLowerCase()
    if (!this.popis.length) return null

    let najbolji: { agent: AgentInfo; kljuc: string } | null = null
    for (const a of this.popis) {
      for (const k of a.keywords || []) {
        if (k === '*') continue
        if (!k || !t.includes(k)) continue
        if (!najbolji || k.length > najbolji.kljuc.length) najbolji = { agent: a, kljuc: k }
      }
    }
    if (najbolji) {
      return { agentId: najbolji.agent.id, razlog: `ključna riječ „${najbolji.kljuc}"` }
    }

    const catchAll = this.popis.find(a => (a.keywords || []).includes('*'))
    if (catchAll) return { agentId: catchAll.id, razlog: 'catch-all (*)' }
    return null
  }
}
