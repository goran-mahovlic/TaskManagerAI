// ─── Gemini modeli u izbornicima ploče (TASK-5730, TASK-5733) ────────────────────────────
// `geminicli:*` = agent i razgovor preko `gemini` CLI-ja (alati). `google:*` = izravni HTTP API
// (GoogleProvider): agent bez alata, a razgovor ga i dalje vozi `gemini` CLI-jem (PrebaciSve.ts).
//
// Autorica: Jelena (Engineer), TASK-5733.

export interface GeminiModel {
  spec: string
  provider: 'geminicli' | 'google'
  model: string
  tier: string
  label: string
  spawnable: boolean
  /** Nudi se u izborniku „Model sustava" iako agent nije spawnable (izravni API). */
  sustav?: boolean
}

/** Google je gemini-2.5-flash ugasio za nove korisnike (404 → „use gemini-3.8-flash", TASK-5730). */
const MODELI: Array<[string, string, string]> = [
  ['gemini-3.8-flash', 'good', 'Gemini 3.8 Flash'],
  ['gemini-2.5-pro', 'frontier', 'Gemini 2.5 Pro'],
  ['gemini-2.5-flash', 'good', 'Gemini 2.5 Flash (samo stari računi)'],
]

export function modeliGeminija(o: { kljuc: boolean; oauth: boolean }): GeminiModel[] {
  if (!o.kljuc && !o.oauth) return []
  const out: GeminiModel[] = MODELI.map(([model, tier, ime]) => ({
    spec: `geminicli:${model}`, provider: 'geminicli', model, tier, label: `${ime} (Google API key)`, spawnable: true,
  }))
  if (o.kljuc) {
    for (const [model, tier, ime] of MODELI) {
      out.push({
        spec: `google:${model}`, provider: 'google', model, tier,
        label: `${ime} (izravni API — agenti bez alata, razgovor kroz gemini CLI)`, spawnable: false, sustav: true,
      })
    }
  }
  return out
}

/**
 * „Model sustava" na `google:*`: davatelj `google` je u primjeru model-configa isključen, pa bi
 * odabir pao na „provider je isključen". Uz prisutan ključ odabir ga uključuje. Vraća je li mijenjao.
 */
export function ukljuciGoogleZaCilj(mc: any, spec: string, kljuc: boolean): boolean {
  if (!kljuc || !String(spec).startsWith('google:')) return false
  const p = mc?.providers?.google
  if (!p || p.enabled !== false) return false
  p.enabled = true
  return true
}
