/**
 * Orchestrator core — sloj 1 (ADR-0001).
 *
 * Jedan uvoz za domaćina: `sastaviOrkestrator()` složi jezgru iz konfiguracije i vrati je
 * spremnu za `start()`. Tko treba drukčije portove (vlastiti red poruka, vlastiti registar),
 * uvozi razrede pojedinačno i slaže sam.
 */

export * from './Ports'
export * from './OrchestratorConfig'
export { Orchestrator, type IshodProlaza } from './Orchestrator'
export { SpawnQueue } from './SpawnQueue'
export { Watchdogs, type Nalaz } from './Watchdogs'
export { KonfiguracijskiRegistar, loadAgents, agentsConfigPath, AGENTS_CONFIG_PATH } from './AgentRegistry'
export { PredloskomSastavljenPrompt, ucitajPredlozak, UGRADENI_PREDLOZAK } from './PromptBuilder'
export { CliExecutor, HttpExecutor, napraviIzvodace } from './Executors'
export { ProcLiveness, SignalLiveness, odaberiLiveness } from './Liveness'
export {
  HttpBoard, PraznaMagistrala, TelegramNotifier, TihiNotifier, DatotecniLogger, SistemskiSat,
} from './Adapters'

import { Orchestrator } from './Orchestrator'
import { KonfiguracijskiRegistar } from './AgentRegistry'
import { PredloskomSastavljenPrompt } from './PromptBuilder'
import { napraviIzvodace } from './Executors'
import { odaberiLiveness } from './Liveness'
import { DatotecniLogger, HttpBoard, PraznaMagistrala, SistemskiSat, TelegramNotifier } from './Adapters'
import { loadOrchestratorConfig, type OrchestratorPostavke } from './OrchestratorConfig'
import type { OrchestratorPorts } from './Ports'

export interface Sastav {
  orkestrator: Orchestrator | null
  cfg: OrchestratorPostavke
  greske: string[]
}

/**
 * Složi jezgru iz konfiguracije. Vraća `orkestrator: null` uz POPIS RAZLOGA kad nešto
 * nedostaje — svježa instalacija bez izvođača mora dobiti rečenicu što joj fali, ne tišinu.
 */
export function sastaviOrkestrator(
  cfg: OrchestratorPostavke = loadOrchestratorConfig(),
  portovi: Partial<OrchestratorPorts> = {},
): Sastav {
  const greske: string[] = []
  const { zadani, greske: greskeIzvodaca } = napraviIzvodace(cfg.executors as any)
  greske.push(...greskeIzvodaca)

  const executor = portovi.executor || zadani
  if (!executor) greske.push('nijedan izvođač nije podešen (orchestrator.json → executors)')

  const agents = portovi.agents
    || (cfg.agents.registryPath
      ? KonfiguracijskiRegistar.izDatoteke(cfg.agents.registryPath)
      : KonfiguracijskiRegistar.izDatoteke())
  if (!agents.list().length) greske.push('registar agenata je prazan (config/agents.json)')

  if (!executor) return { orkestrator: null, cfg, greske }

  const ports: OrchestratorPorts = {
    board: portovi.board || new HttpBoard(cfg.api.baseUrl),
    bus: portovi.bus || new PraznaMagistrala(),
    executor,
    agents,
    prompt: portovi.prompt || new PredloskomSastavljenPrompt({
      templateDir: cfg.prompt.templateDir,
      includeTaskProtocol: cfg.prompt.includeTaskProtocol,
      includeVerificationGate: cfg.prompt.includeVerificationGate,
    }),
    liveness: portovi.liveness || odaberiLiveness(cfg.liveness.mode, cfg.liveness.heartbeatDir),
    notifier: portovi.notifier || new TelegramNotifier(),
    clock: portovi.clock || SistemskiSat,
    logger: portovi.logger || new DatotecniLogger(),
  }
  return { orkestrator: new Orchestrator(ports, cfg), cfg, greske }
}
