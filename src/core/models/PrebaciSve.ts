// ─── „Prebaci sve na model" (TASK-5305, uputa #189) ──────────────────────────────
// Vlasnik, 07.10.2026.: kad je Anthropic sesija potrošena, cijeli sustav jednim potezom na drugi
// model. NEMA nove logike usmjeravanja: prekidač samo PIŠE postojeća polja `model-config.json`
// koja daemon, razgovor i Config već čitaju (`defaults`, `agentOverrides`, `componentOverrides`).
// Daemon to vidi kao obični `[MODEL-OVERRIDE] <agent> → <provider>:<model>`.
//
// Ne dira se: `embeddings` (promjena modela mijenja vektorski prostor i kvari RAG/Hindsight) i
// `classifier` (lokalno rutiranje svake poruke — na Claudeu bi to bio spawn po poruci).
// Stanje prije PRVOG prebacivanja pamti se u `_prebaciSvePrije` (ključevi s `_` su komentari koje
// razrješivač preskače), pa „Vrati" vraća točno ono što je bilo, i nakon više prebacivanja.
//
// Modul je bez putanja i bez okoline — isti u paketu i u pogonu.
// Autorica: Jelena (Engineer), TASK-5305.

/** Komponente koje prekidač NIKAD ne mijenja. */
export const IZUZETE_KOMPONENTE = ['embeddings', 'classifier'] as const
/** Razine u `defaults` koje se ne diraju (rutiranje, ne izvršavanje). */
const IZUZETE_RAZINE = ['classifier']
/** Ključ razgovora (Šaban) u `agentOverrides` — `RazgovorPloca.modelIzKonfiguracije`. */
export const RAZGOVOR_KLJUC = 'razgovor'
/** Ključ snimke stanja prije prvog prebacivanja. */
export const SNIMKA_KLJUC = '_prebaciSvePrije'
/** OpenRouterov Anthropic-kompatibilni endpoint (Claude Code: ANTHROPIC_BASE_URL). */
export const OPENROUTER_ANTHROPIC_URL = 'https://openrouter.ai/api'

export interface Spec { provider: string; model: string; node?: string }

/** `provider[@node]:model` → dijelovi; model smije sadržavati `:` (`qwen3:8b`). Goli alias → null. */
export function rasclaniSpec(spec: string | null | undefined): Spec | null {
  const s = String(spec ?? '').trim()
  const i = s.indexOf(':')
  if (i <= 0 || i === s.length - 1) return null
  const glava = s.slice(0, i)
  const model = s.slice(i + 1)
  const at = glava.indexOf('@')
  const provider = at >= 0 ? glava.slice(0, at) : glava
  if (!provider) return null
  return at >= 0 ? { provider, node: glava.slice(at + 1), model } : { provider, model }
}

/** Troši li ovaj provider Anthropic sesiju (pretplata/OAuth)? Samo `anthropic` i `claude`. */
export function jeAnthropicProvider(provider: string | null | undefined): boolean {
  const p = String(provider ?? '').trim().toLowerCase()
  return p === 'anthropic' || p === 'claude'
}

/** Provjera cilja prema `providers` model-configa. Vraća razlog odbijanja ili null. */
export function provjeriCilj(spec: string, providers: Record<string, any> | undefined): string | null {
  const c = rasclaniSpec(spec)
  if (!c) return `neispravan cilj '${spec}' — očekujem provider:model (npr. openrouter:z-ai/glm-5.2)`
  if (/\s/.test(spec) || spec.length > 200) return `neispravan cilj '${spec.slice(0, 60)}'`
  const p = providers?.[c.provider]
  if (!p) return `nepoznat provider '${c.provider}' (nema ga u providers)`
  if (p.enabled === false) return `provider '${c.provider}' je isključen — uključi ga na Config stranici`
  return null
}

export interface PrebaciOpcije {
  tko: string
  kada: string
  /** Agenti iz registra — dobivaju override i ako ga prije nisu imali. */
  agenti?: string[]
}

function kopija<T>(o: T): T { return JSON.parse(JSON.stringify(o ?? null)) }

/**
 * Prepiši izvršna polja na `spec`. Vraća NOVI objekt (ulaz se ne mijenja) i popis promijenjenih
 * polja. Baca na neispravan cilj — ništa se ne piše.
 */
export function prebaciSve(mcUlaz: any, spec: string, o: PrebaciOpcije): { mc: any; promijenjeno: string[] } {
  const greska = provjeriCilj(spec, mcUlaz?.providers)
  if (greska) throw new Error(greska)
  const mc = kopija(mcUlaz) || {}
  if (!mc[SNIMKA_KLJUC]) {
    mc[SNIMKA_KLJUC] = {
      defaults: kopija(mc.defaults ?? null),
      agentOverrides: kopija(mc.agentOverrides ?? null),
      componentOverrides: kopija(mc.componentOverrides ?? null),
    }
  }
  Object.assign(mc[SNIMKA_KLJUC], { cilj: spec, tko: o.tko, kada: o.kada })

  const promijenjeno: string[] = []
  const postavi = (sekcija: string, kljuc: string) => {
    if (mc[sekcija][kljuc] !== spec) promijenjeno.push(`${sekcija}.${kljuc}`)
    mc[sekcija][kljuc] = spec
  }

  if (!mc.defaults || typeof mc.defaults !== 'object') mc.defaults = {}
  for (const k of Object.keys(mc.defaults)) {
    if (k.startsWith('_') || IZUZETE_RAZINE.includes(k) || typeof mc.defaults[k] !== 'string') continue
    postavi('defaults', k)
  }

  if (!mc.agentOverrides || typeof mc.agentOverrides !== 'object') mc.agentOverrides = {}
  const agenti = new Set<string>([...Object.keys(mc.agentOverrides), ...(o.agenti || []), RAZGOVOR_KLJUC])
  for (const a of agenti) {
    if (!a || a.startsWith('_')) continue
    postavi('agentOverrides', a)
  }

  if (!mc.componentOverrides || typeof mc.componentOverrides !== 'object') mc.componentOverrides = {}
  for (const k of Object.keys(mc.componentOverrides)) {
    if (k.startsWith('_') || (IZUZETE_KOMPONENTE as readonly string[]).includes(k)) continue
    if (typeof mc.componentOverrides[k] !== 'string') continue
    postavi('componentOverrides', k)
  }
  return { mc, promijenjeno }
}

/** Vrati stanje prije prvog prebacivanja. Bez snimke → ništa (`vraceno: false`). */
export function vratiPrebacivanje(mcUlaz: any): { mc: any; vraceno: boolean } {
  const mc = kopija(mcUlaz) || {}
  const s = mc[SNIMKA_KLJUC]
  if (!s) return { mc, vraceno: false }
  for (const k of ['defaults', 'agentOverrides', 'componentOverrides']) {
    if (s[k] === null || s[k] === undefined) delete mc[k]
    else mc[k] = s[k]
  }
  delete mc[SNIMKA_KLJUC]
  return { mc, vraceno: true }
}

export function stanjePrebacivanja(mc: any): { aktivno: boolean; cilj: string | null; tko: string | null; kada: string | null } {
  const s = mc?.[SNIMKA_KLJUC]
  if (!s) return { aktivno: false, cilj: null, tko: null, kada: null }
  return { aktivno: true, cilj: s.cilj ?? null, tko: s.tko ?? null, kada: s.kada ?? null }
}

export interface CiljRazgovora {
  /** Vrijednost za `claude -p --model` (bez prefiksa providera). */
  model: string | undefined
  /** Dodatna okolina procesa: preusmjerenje na Anthropic-kompatibilni endpoint. */
  env: Record<string, string>
  /** Troši li poziv Anthropic sesiju (vrata kvote razgovora pitaju samo tada). */
  anthropic: boolean
  greska?: string
}

/**
 * Model razgovora (`razgovor.model` / `agentOverrides.razgovor`) → poziv `claude -p`.
 * Anthropic ili goli alias: `--model <alias>`. Drugi provider ide ISTIM CLI-jem preko
 * `ANTHROPIC_BASE_URL` (isti put kojim daemon vozi kimi/glm): njegov `baseUrl` ako je
 * `anthropicCompatible`, za OpenRouter njegov Anthropic-kompatibilni endpoint. Bez tog puta
 * (npr. Ollama) → greška; nema tihog pada natrag na Claude.
 */
export function ciljRazgovora(
  spec: string | null | undefined,
  providers: Record<string, any> | undefined,
  citajTajnu: (ime: string) => string | null,
): CiljRazgovora {
  const s = spec ? String(spec).trim() : ''
  if (!s) return { model: undefined, env: {}, anthropic: true }
  const c = rasclaniSpec(s)
  if (!c) return { model: s, env: {}, anthropic: true }
  if (jeAnthropicProvider(c.provider)) return { model: c.model, env: {}, anthropic: true }

  const p = providers?.[c.provider] || {}
  const baseUrl = p.anthropicCompatible && p.baseUrl
    ? String(p.baseUrl)
    : c.provider === 'openrouter' ? OPENROUTER_ANTHROPIC_URL : ''
  if (!baseUrl) {
    return { model: c.model, env: {}, anthropic: false, greska: `provider '${c.provider}' nema Anthropic-kompatibilan endpoint — razgovor ga ne može voziti kroz claude CLI` }
  }
  const ref = typeof p.apiKey === 'string' && p.apiKey.startsWith('env:')
    ? p.apiKey.slice(4)
    : `${c.provider.toUpperCase()}_API_KEY`
  let token: string | null = null
  for (const ime of ref.split('|').map((x: string) => x.trim()).filter(Boolean)) {
    token = citajTajnu(ime)
    if (token) break
  }
  if (!token) return { model: c.model, env: {}, anthropic: false, greska: `nema ključa ${ref} za provider '${c.provider}'` }
  return {
    model: c.model,
    env: { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: token, ANTHROPIC_API_KEY: '' },
    anthropic: false,
  }
}
