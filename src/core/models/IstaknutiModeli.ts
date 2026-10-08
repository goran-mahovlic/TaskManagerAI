/**
 * Istaknuti OpenRouter modeli — jedan popis za SVA mjesta gdje ploča nudi model (TASK-5351).
 *
 * Model po agentu i „prebaci sve" čitaju kurirani popis (`/api/models/available`); dežurni i
 * odlučitelj čitaju živi katalog OpenRoutera poredan po cijeni, a dežurni ga još reže na 60
 * najjeftinijih. Skuplji model koji je vlasnik izabrao (Mistral Large 4, 0,68 $/M) u tom
 * rezu ne stigne — zato ga `istaknutiNaVrh` stavlja odmah iza auto-rutera.
 *
 * Istaknuti NIJE zadani: nijedan popis ga ne stavlja na prvo mjesto zadanog modela.
 */

/** Mistral Large 4 — NE miješati sa starijim `mistral-large-2512` / `-2407`. */
export const MISTRAL_LARGE_4 = 'mistralai/mistral-large-4-0'

export interface IstaknutiModel { model: string; label: string; tier: string }

export const ISTAKNUTI_OPENROUTER: IstaknutiModel[] = [
  { model: MISTRAL_LARGE_4, label: 'Mistral Large 4 (OpenRouter)', tier: 'frontier' },
]

/** Katalog s istaknutima iza auto-rutera (`openrouter/*`), bez duplikata. Istaknuti se nude
 *  i kad katalog nije dostupan (nod bez izlaza prema /models) — poziv modela ide drugim putem. */
export function istaknutiNaVrh(katalog: string[]): string[] {
  const istaknuti = ISTAKNUTI_OPENROUTER.map(m => m.model)
  const auto = katalog.filter(m => m.startsWith('openrouter/'))
  const ostali = katalog.filter(m => !m.startsWith('openrouter/') && !istaknuti.includes(m))
  return [...auto, ...istaknuti, ...ostali]
}
