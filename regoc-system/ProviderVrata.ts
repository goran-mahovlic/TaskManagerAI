/**
 * ProviderVrata — koga vrata autonomije uopće smiju kočiti (TASK-5305, uputa #189).
 *
 * Vrata autonomije (`autonomyTierFromUsage`, WorkStateJournal) mjere ANTHROPIC sesiju. Do sada
 * su se primjenjivala na SVE zadatke u redu, pa je potrošena Anthropic sesija zaustavljala i
 * zadatke koje vozi OpenRouter, Ollama ili kimi/glm (vlasnik, 07.10.2026.: „kad se potroši
 * sesija, ne može se prebaciti na OpenRouter jer je sve blokirano").
 *
 * Odluka: vrata se pitaju SAMO za zadatke čiji razriješeni provider troši Anthropic sesiju
 * (`anthropic`, `claude`). Razrješenje je isto kojim spawn bira model (`agentOverrides` u
 * model-config.json, `provider[@node]:model`), samo bez zapisa u log. Nove logike usmjeravanja
 * nema — modul samo odgovara „ide li ovaj zadatak preko Anthropica".
 *
 * Samostalan (bez uvoza iz daemona), pa je isti na glavnom stroju i na node-A.
 * Autorica: Jelena (Engineer), TASK-5305.
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const HOME = process.env.HOME || homedir()
export const MODEL_CONFIG = join(HOME, '.claude/regoc/models/model-config.json')

/** Troši li ovaj provider Anthropic sesiju (pretplata/OAuth)? */
export function jeAnthropicProvider(provider: string | null | undefined): boolean {
  const p = String(provider ?? '').trim().toLowerCase()
  return p === 'anthropic' || p === 'claude'
}

/**
 * Provider kojim bi spawn vozio zadatak: `agentOverrides[assignee]` → `provider`, inače
 * `anthropic` (registarski alias). Isto pravilo kao `resolveAgentTarget`/`resolveSpawnModel`.
 */
export function providerZadatka(task: { assignee?: unknown }, configPath: string = MODEL_CONFIG): string {
  const agentId = String(task?.assignee ?? '')
  if (!agentId || agentId.startsWith('_') || !existsSync(configPath)) return 'anthropic'
  const spec = JSON.parse(readFileSync(configPath, 'utf-8'))?.agentOverrides?.[agentId]
  if (typeof spec !== 'string') return 'anthropic'
  const i = spec.indexOf(':')
  if (i <= 0 || i === spec.length - 1) return 'anthropic'
  const glava = spec.slice(0, i)
  const at = glava.indexOf('@')
  return (at >= 0 ? glava.slice(0, at) : glava) || 'anthropic'
}

/**
 * Razdvoji red na zadatke koje vrata Anthropic sesije koče i one koje ne koče. Redoslijed
 * (prioritet) se čuva. Greška razrješenja = Anthropic: neznanje ne smije zaobići vrata.
 */
export function razdvojiPoProvideru<T>(tasks: T[], providerOf: (t: T) => string): { anthropic: T[]; ostali: T[] } {
  const anthropic: T[] = []
  const ostali: T[] = []
  for (const t of tasks) {
    let p = 'anthropic'
    try { p = providerOf(t) } catch { p = 'anthropic' }
    ;(jeAnthropicProvider(p) ? anthropic : ostali).push(t)
  }
  return { anthropic, ostali }
}
