/**
 * InfraKartica — stavke kartice „Infrastruktura" na Config (TASK-5368, nalaz TASK-5360).
 *
 * Kartica je prije pisala tvrde adrese (VoiceServer localhost:8888, STT localhost:8787,
 * RegocPulse :17780) koje na čvoru ne sluša nitko, a Ollamu je tražila samo u
 * `TM_OLLAMA_URL` — pa je pisala „nije podešeno" dok je kartica AI Providers istu Ollamu
 * (iz model-config.json) vidjela online. Sada svaka stavka nosi adresu iz ISTOG izvora iz
 * kojega je čita ostatak ploče, ime tog izvora i stvarnu probu dosežnosti.
 *
 * ADR-0001 §5.1: adresa bez postavke je `null` („nije podešeno"), nikad naša vrijednost.
 * Iznimka je glasovni servis: njegova zadana adresa (127.0.0.1:8899) je lokalna i ista je
 * ona koju razgovor stvarno zove (Glas.ts), pa je kartica smije pokazati.
 *
 * Autorica: Jelena (Engineer), TASK-5368.
 */
import { GLAS_ZADANI_URL } from '../razgovor/Glas'

export type InfraStanje = 'online' | 'offline' | 'nije_podeseno'

export interface InfraStavka {
  /** Ime za prikaz kad rječnik nema `nameKey`. */
  name: string
  nameKey: string
  /** Adresa kako je čita ploča; `null` = nije podešeno. */
  endpoint: string | null
  /** Odakle je adresa pročitana — tehničko ime varijable/postavke, isto na svakom jeziku. */
  izvor: string
  /** URL koji proba zove; `null` = nema što probati. */
  probaUrl: string | null
  stanje?: InfraStanje
  greska?: string
}

export interface InfraUlaz {
  env: Record<string, string | undefined>
  /** `providers.ollama.baseUrl` iz model-config.json — isti izvor kao kartica AI Providers. */
  ollamaUrl?: string | null
  /** `glasUrl` iz postavki razgovora — isti izvor kao razgovor (Glas.ts). */
  glasUrl?: string | null
}

const bezKose = (u: string) => u.trim().replace(/\/+$/, '')

export function stavkeInfrastrukture(u: InfraUlaz): InfraStavka[] {
  const env = u.env
  const port = (env.TM_PORT || '').trim() || '17781'

  const glasPostavljen = !!(u.glasUrl && u.glasUrl.trim())
  const glas = bezKose(glasPostavljen ? u.glasUrl! : GLAS_ZADANI_URL)

  const chromaHost = (env.TM_CHROMA_HOST || '').trim()
  const chroma = chromaHost ? `${chromaHost}:${(env.TM_CHROMA_PORT || '').trim() || '8000'}` : null

  const ollamaIzPostavki = !!(u.ollamaUrl && u.ollamaUrl.trim())
  const ollamaSirovo = ollamaIzPostavki ? u.ollamaUrl! : (env.TM_OLLAMA_URL || '')
  const ollama = ollamaSirovo.trim() ? bezKose(ollamaSirovo) : null

  return [
    { name: 'TaskWebUI', nameKey: 'infra_ploca', endpoint: `localhost:${port}`,
      izvor: env.TM_PORT ? 'TM_PORT' : 'TM_PORT (17781)', probaUrl: null },
    { name: 'Glasovni servis (STT + TTS)', nameKey: 'infra_glas', endpoint: glas,
      izvor: glasPostavljen ? 'razgovor.glasUrl' : 'GLAS_ZADANI_URL (razgovor.glasUrl = "")',
      probaUrl: `${glas}/health` },
    { name: 'ChromaDB', nameKey: 'infra_chroma', endpoint: chroma,
      izvor: 'TM_CHROMA_HOST', probaUrl: chroma ? `http://${chroma}/api/v2/heartbeat` : null },
    { name: 'Ollama', nameKey: 'infra_ollama', endpoint: ollama,
      izvor: ollamaIzPostavki ? 'model-config.json → providers.ollama.baseUrl' : 'TM_OLLAMA_URL',
      probaUrl: ollama ? `${ollama}/api/tags` : null },
  ]
}

/**
 * Proba dosežnosti: svaki HTTP odgovor znači da servis sluša (i 404 — vrata su otvorena),
 * mrežna greška ili istek roka znači offline. Ploča (`infra_ploca`) je proces koji upravo
 * odgovara, pa je online po definiciji. Probe idu usporedno — kartica čeka najviše `rokMs`.
 */
export async function probajInfrastrukturu(
  stavke: InfraStavka[], fetchImpl: typeof fetch = fetch, rokMs = 1500,
): Promise<InfraStavka[]> {
  return Promise.all(stavke.map(async (s): Promise<InfraStavka> => {
    if (s.nameKey === 'infra_ploca') return { ...s, stanje: 'online' }
    if (!s.endpoint || !s.probaUrl) return { ...s, stanje: 'nije_podeseno' }
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), rokMs)
    try {
      await fetchImpl(s.probaUrl, { method: 'GET', signal: ac.signal })
      return { ...s, stanje: 'online' }
    } catch (e: any) {
      return { ...s, stanje: 'offline', greska: String(e?.message || e).slice(0, 120) }
    } finally {
      clearTimeout(t)
    }
  }))
}
