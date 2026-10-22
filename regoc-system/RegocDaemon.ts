#!/usr/bin/env bun
/**
 * REGOČ Daemon - Background Message Processor
 *
 * Continuously monitors SQLite queue and processes messages
 * addressed to 'regoc' WITHOUT requiring PAI interaction.
 *
 * Usage:
 *   bun RegocDaemon.ts              # Run in foreground
 *   bun RegocDaemon.ts --daemon     # Run in background
 *   bun RegocDaemon.ts --stop       # Stop daemon
 *   bun RegocDaemon.ts --status     # Check status
 */

import { MAX_MSG_LEN, mogaoMogla, parseAgentOutput, plainText, renderAgentOutput, renderMinimal, zavrsioZavrsila } from './AgentOutputParser'
import Database from 'bun:sqlite'
import { existsSync, writeFileSync, readFileSync, unlinkSync, readdirSync, statSync, appendFileSync, mkdirSync } from 'fs'
import { basename, dirname, join } from 'path'
import { CreateTaskInputSchema, type CreateTaskInput } from './zod/schemas/task'
import { createProjectWorkflow } from './workflows/CreateProjectWorkflow'
import { inference, type InferenceResult } from '../skills/CORE/Tools/Inference'
import { isEnabled, getFlag } from './FeatureFlags'
// ADR-0022 (TASK-5613): trajna sesija agenta — auto-exec zadaci trajnog agenta nastavljaju istu Claude sesiju.
import {
  odluciTrajniPut, citajPokazivac, zapisiPokazivac, zauzmiPokazivac, oslobodiPokazivac, umirovi, bravaZiva,
  procStarttime, kontekstIzTranskripta, gradiPredaju, kljucPokazivaca, trajneSesijeDir, citajPostavke,
  citajNacin, nemaRazgovora, trajniArgumenti, izdvojiAlatePoZadatku, kratkiSid, OZNAKA_CEKA_SESIJU,
  trajnaZamjenjujeAgentDaemon,
  type TrajniPut, type TrajniNacin, type Pokazivac,
} from './TrajnaSesija'
import { ucitajDezurnog, padSpawna, argumentiDezurnog, okolinaDezurnog, SIMULIRANI_PAD_CMD } from './DezurniSpawn'
// TASK-4779: putanja mjerila potrošnje ima JEDAN izvor istine — vrata autonomije
// odlučuju po njegovu postojanju, pa probe i odluka moraju gledati istu datoteku.
import { SESSION_USAGE_TOOL, setAutonomyThresholdsProvider, currentAutonomyThresholds } from './WorkStateJournal'
import { createAutonomyThresholdsReader, formatAutonomyChanges } from './AutonomyThresholdSetting'
import { isKlaudioAlive, shouldAttemptRestart, clearStaleKlaudioPidFilesReal } from './KlaudioLiveness'
import { classifyTier as classifyTierOffload } from './LocalOffload'
// P3/TASK-2569 s4: tier-recept u prompt, iza flaga `tierRecipesEnabled` (SHADOW dok se ne potvrdi).
import { getRecipe } from './TierRecipes'
// R2/TASK-4309: korak 2 lanca (istraživanje) nosi obvezan izlaz — dokument u RAG-u.
import { buildResearchStepBlock } from './ResearchRagGate'
import { evaluateCompletion, evaluateLocalExecutor, formatVerdictLabel, formatVerdictLog, formatShadowLog, shouldEnforce, loadGateConfig } from './CompletionGuard'
// TASK-5164 (nesukladnost B): `completed` od ne-daemona je zahtjev; ovdje ga provodi kritičar.
import { obradiZahtjeveZatvaranja, obradiSjenuZatvaranja, OZNAKA_CEKA, type ZahtjevZadatak, type SudKriticara } from './ZatvaranjeKrozDaemon'
// W3/TASK-4615: strukturirani izlaz koraka. `off` u config/step-schema.json → blokShemeKoraka()
// TASK-4810: blok stoji IZA recepta i „Pravila", a ispred projectTaila (Z3). Razlog je
// mjeren: prompt nosi tri obrasca izlaza, a zadnji pobjeđuje — dok je shema stajala uz
// TASKMANAGER PROTOCOL (sredina prompta), sažetci su dolazili u obliku „=== VERIFIKACIJA ==="
// (recept, TASK-4792/4791) ili „📋 REZULTAT" (Pravila, TASK-4752).
// vraća prazan niz i prompt je bajt-identičan starome (ADR-0003: nula boilerplatea kad ne treba).
import { blokShemeKoraka, formatSudKoraka } from './StepSchema'
// W5/TASK-4618: adversarijalna provjera nalaza. `off` u config/adversarial-verify.json →
// `blokNalazaZaKorak()` vrati '' i prompt je bajt-identičan onome prije W5 (ADR-0003).
import { blokNalazaZaKorak, blokUPromptu, loadAdversarialConfig, ocijeniPrihvatljivost } from './AdversarialVerify'
// M3/TASK-4625: `blocked_ok` (agent uredno stao) odvojeno od `failed`/`blocked`.
import { outcomeFromCompletionVerdict } from './RunOutcome'
import { checkVerificationBlock, buildRejectionInstruction } from './VerificationGate'
// DUR-4/TASK-3596: strop usporednih spawnova dolazi iz okoline (pretpostavka 3), ne iz koda.
import { spawnSlotAvailable, spawnLimitNotice } from './AgentConcurrency'
import { createConcurrencyReader, formatConcurrencyChange, CONCURRENCY_ENV, CONCURRENCY_KEY } from './ConcurrencySetting'
import { buildIdentityBlock } from './IdentityBlock'
import { readSwitch as readToolkitSwitch, modeFor as toolkitModeFor, selectToolkit, loadCatalog, logShadow as logToolkitShadow, taskInfoFromRow, type ToolkitSelection } from './TaskToolkit'
// TASK-5124: Hindsight memorija po opisu zadatka, iza prekidača (settings memorija.globalno / memorija.agenti).
import { createMemorijaReader, memorijaAgentaSinkrono, pripremiMemorijuAgenta, oznakaZadatka, oznakaBezMemorije } from './tools/hindsight/HindsightMemorija'
const memorijaNacin = createMemorijaReader({ dbPath: `${process.env.HOME}/.claude/regoc/data/regoc.db` })

/** TASK-5292: upit za Hindsight iz naslova i opisa zadatka (isti za pripremu i spawn). */
function memorijaUpit(taskId: string): string {
  const row = readTaskRow(taskId)
  return `${row?.title ?? ''}\n${row?.description ?? ''}`.trim().slice(0, 1000)
}

/**
 * TASK-5292: u načinu `on` spawn ČEKA dohvat memorije, najviše `memorija.rok_ms` (node-A 20 s,
 * strop 30 s), pa blok ide već pri prvom spawnu. Istek/greška ne zaustavljaju spawn — razlog
 * ostaje u kešu i spawn ga pretvara u oznaku 🧠🚫. Nikad ne baca.
 */
async function pripremiMemorijuZaSpawn(taskId: string | null | undefined, agentId: string): Promise<void> {
  if (!taskId) return
  try {
    if (memorijaNacin('agenti') !== 'on') return
    const t0 = Date.now()
    await pripremiMemorijuAgenta({ zadatak: String(taskId), agent: agentId, upit: memorijaUpit(String(taskId)), nacin: 'on' })
    const ms = Date.now() - t0
    if (ms > 1000) log(`🧠 [memorija ON] ${agentId}/${taskId}: priprema prije spawna ${ms} ms (rok ${memorijaNacin.rokMs()} ms)`)
  } catch (e) { log(`⚠️ [memorija] ${agentId}/${taskId}: priprema preskočena (${e})`) }
}

/** TASK-5292: izvještaj zadatka počinje oznakom 🧠🚫 ako je zadnji spawn radio bez memorije. */
function sOznakomMemorije(taskId: string, tekst: string): string {
  try {
    const o = oznakaZadatka(taskId)
    return o && !tekst.startsWith(o) ? `${o}\n${tekst}` : tekst
  } catch { return tekst }
}
import { resolveAgentTarget, type SpawnTarget } from './models/AgentModel'
// TASK-3669 (ADR-0004 O2 st. 6 i 9, O3): verifikacijski odsjeci iz `spawn_template`,
// sastavljač prenesen iz napuštenog UnifiedSpawnPipeline-a u živi put.
import { buildLiveVerificationBlock } from './SpawnVerificationBlock'
// I6/TASK-3655: `rag_collections` iz registra napokon ima čitatelja — vlastita kolekcija
// agenta ulazi u ragHints i u blok identiteta, ali SAMO ako postoji u ChromaDB-u.
import { knownCollections, ownRagCollection, registryRagCollection, ownMemorySection, withOwnCollection, refreshCollectionsCache, popisDostupan, withSystemCollection } from './RagCollections'
// TASK-5159: obvezne vještine iz oznaka `vjestina:*` (TaskBrief — isti izbor kao u predlošku).
import { obvezneVjestine } from './TaskBrief'
// TASK-5159: „🧭 Tijek posla” u dojavi o završetku (dizajn TASK-5158 §5).
import { sastaviTijek, oznakeOd, izmjeriSesiju, zapisIzTelemetrije, zapisiTijekPoslaUPozadini } from './TijekPosla'
import { loadWorkflowKatalog } from './WorkflowGate'
import { loadReportBackConfig, parseReportBackMarker, isReportBackTask } from './ReportBackTask'

/** Je li zadatak u nizu neke OTVORENE dojave (`report-back`) — tada tijek javlja dojava niza. */
function uNizuDojave(taskId: string): boolean {
  const db = new Database(TASKS_DB_PATH, { readonly: true })
  try {
    const redci = db.query("SELECT description, tags FROM tasks WHERE tags LIKE '%report-back%' AND status NOT IN ('completed','cancelled')").all() as Array<{ description: string | null; tags: string | null }>
    return redci.some(r => isReportBackTask(oznakeOd(r.tags)) && (parseReportBackMarker(r.description)?.taskIds || []).includes(taskId))
  } finally { db.close() }
}
// DUR-5/TASK-3597: osigurac na vratima SPAWNOVA (SendBreaker stoji na vratima poruka) +
// jitter na odgodi, da tri radnika koja padnu na istom rate-limitu ne krenu natrag u koraku.
import { SpawnBreaker, classifySpawnFailure, formatSpawnAlarm } from './SpawnBreaker'
import { razdvojiPoProvideru, providerZadatka } from './ProviderVrata'
import { TokenBucket } from './TokenBucket'
import { jitteredBackoff } from './Backoff'
import {
  watchEarlyWork, countModelSteps, transcriptPathForSession, recordEarlyWork,
  type EarlyWorkVerdict,
} from './EarlyWorkGuard'
// M4/TASK-4627: uredno gašenje — zadatak aktivnog spawna se pri restartu vraća u red, ne otkazuje
import {
  markSpawnsForResume, recordShutdownResume, resumeRound, withResumeTag,
  SHUTDOWN_RESUME_MAX_ROUNDS,
} from './ShutdownResume'
// R7/TASK-2563: neuspio spawn (exit≠0) vraća zadatak u red i JAVLJA korisniku — kraj tihih odustajanja.
import {
  requeueFailedTask, recordFailRequeue, FAIL_REQUEUE_MAX_ATTEMPTS, type FailRequeueDeps,
} from './FailRequeue'
import { tmpMapaSpawna, tmpOkolina, tmpKorijen, tmpMapaServisa, uputaRadneMape } from './TmpOkolina'
import { critiqueSpawnAsync, formatCritiqueLog, formatRepairBrief, loadCriticConfig, parseDeclaredChecks, type DeclaredParse, type CriticStatus } from './CriticGate'
// W4/TASK-4617: odbijeni korak se VRAĆA izvođaču s nalazom vratara (najviše `maxRounds`
// krugova), pa eskalacija čovjeku. Dosad su `repair` i `escalate` završavali isto — u
// `blocked` — pa je nalaz kritičara ostajao bez adresata.
import {
  returnStepForRepair, recordCriticRepair, repairPromptTail, clearRepairBrief, saveRepairBrief,
  type CriticRepairDeps,
} from './CriticRepairLoop'
// ADR-0012 (TASK-4827): zatvaranje zadatka je JEDINA točka istine pod opcijom (B), pa
// više ne smije biti goli `fetch` u `catch {}` (ADR-0012 §5) niti smije završiti u 400
// vratara bez odgovora (§12). Najam spawna je međuprocesni biljeg za `spawnCloseGuard`.
import { zatvoriZadatak, uzmiNajam, pustiNajam, pocistiNajmove, ziviNajmovi, najamAktivan } from './TaskCloser'
import { ZatvaranjeSpawna, saZatvaranjem } from './ZatvaranjeSpawna'
// ADR-0024 V2 (TASK-5677): voditelj lanca — tick, traka izvan stropa, vlastita trajna sesija.
import {
  TICK_MS as VODITELJ_TICK_MS, AGENT_VODITELJA, jeVoditelj, lanacVoditelja, oznakeIz, kljucSesijeVoditelja, trakaSpawna, mjestoUTraci,
  prolazVoditelja, zavrsiBudjenje, zabiljeziTrosakVoditelja, odlukaSesijeVoditelja, gradiPredajuVoditelja, tablicaLanca,
  planIzOpisa, repDnevnika, type ZadatakVoditelja, type BudjenjeUlaz, type Odgovor,
} from './VoditeljPogon'
import {
  citajNacin as citajNacinVoditelja, citajPostavke as citajPostavkeVoditelja, clanoviLanca, graneLanca, putDnevnika as putDnevnikaVoditelja,
  koraciSpajanja, odustaniOdSpajanja, OZNAKA_VODITELJA, type Clan as ClanLanca, type GranaInfo, type Zahtjev as ZahtjevVoditelja,
  type NacinVoditelja,
} from './VoditeljLanca'
import {
  odluciSiroce, planSiroce, jeRadnja as jeSiroceRadnja, ucitajSiroceConfig, ucitajBrojac, zabiljeziPokusaj,
  SIROCE_BROJAC_PATH, SIROCE_LOG_PATH, type SiroceZadatak,
} from './OrphanRecovery'
import { provjeriVratareZatvaranja } from './SpawnFinalizer'
import { registrirajPozadinu, prolazPozadine, ucitajPozadinaConfig } from './PozadinaPovrat'
// T10/TASK-3575: sud koji NIJE ništa provjerio prijavljuje se korisniku (ne blokira).
import {
  loadUnverifiedConfig,
  readUnverifiedState,
  writeUnverifiedState,
  unverifiedStatePath,
  decideUnverifiedAlert,
  summaryDue,
  afterSummary,
  summaryRows,
  formatUnverifiedAlert,
  formatUnverifiedSummary,
} from './UnverifiedReport'
import { getModeClassifier, type EffortTier } from './ModeClassifier'
// P5c/TASK-2584: razlaganje E4/E5 posla (čista logika; I/O je u tools/decompose.ts)
import { isDecomposable as isDecomposableTask, logDecision as logDecomposeDecision } from './TaskDecomposer'
import { zahtjevKorisnika } from './TaskTier'
// M2 dorada/TASK-4646: strojni POST na /api/tasks nosi SVOJ izvor (`createdBy`), inače
// daemon i čovjek dijele kvotu stropa stvaranja zadataka i dojava ne zna tko je rafalirao.
import { TASK_SOURCE, withCreatedBy } from './TaskCreateSource'
import { classifyTrivial, trivialResponse } from './TrivialResponder'
import { isNonActionableMessage, isSchedulerNotification } from './DispatchGuard'
import { detectProjectCommand, type ProjectDetectOutcome } from './ProjectDetect'
import { findMentionedAgents, hasHelperCue, isHelperEcho, resolveExplicitAgent, isSecurityTask, isVisualTask, r2Pomocnici, R2_STROP } from './AgentRouting'
// ADR-0018 F1 (TASK-5134): korak „odabir” prije spawna — u `shadow` samo bilješka + data/odabir_agenta.jsonl.
import { odaberiAgenta, odabirNacin, vecOdabrano, zapisiOdabir, formatBiljeska, zadatakIzRetka } from './AgentSelection'
import { resolveChildProject, inheritedNote, type ParentTaskInfo, type ProjectDecision } from './ProjectInheritance'
import { buildProjectTail, projectProtocolInstruction, fetchProjectName } from './PromptProjectBlock'
import { chatContextTail } from './TelegramContextTail'
import { originZaZadatak, chatZaAlarm } from './ZadatakKanal'   // TASK-5420
import { neprovjerenoIdeUDojavu, dopuniDojavu, razdvojiZaFlush } from './ChatDojava'   // TASK-5548
import { deliverDocuments } from '../tools/Telegram/lib/SendDoc'   // TASK-5548
// R2/TASK-2560: pravilo "je li task zaglavljen" + izuzeća (SSOT, dijeli ga i report alat)
import { loadStaleWatchdogConfig, evaluateStaleTasks, makeCheckpointLookup, type StaleDecision } from './StaleWatchdog'
// TASK-5204: naknadna revizija blokiranih — drugi prolaz istog nadzornika (docs/DIZAJN-revizija-blokiranih.md)
import {
  loadBlockedReviewConfig, nacinRevizije, zadnjiProlazZaPonavljanje, PONOVI_PRESKOCENI_PROLAZ_MS, izmjeriOkolinu, provjeriUzrok, makeBlockedReviewLookup,
  evaluateBlockedTasks, procitajBudzet, provjeriDeployServisa, formatBlockedDecisionLine, zapisRevizije,
  REVIZIJA_BLOKIRANIH_LOG, type BlockedDecision, type BlockedTask,
} from './StaleWatchdog'
import { zaglavljaZatvaraca } from './ZatvaranjeKrozDaemon'
// TASK-3019: preostala dva čistača in_progress taskova pod flagom/dry-runom (SSOT po mehanizmu)
import { loadZombieRecoveryConfig, evaluateZombieTasks, planZombieActions, withinStartupGrace, extractLiveTaskIds, isActionable as isZombieActionable } from './ZombieRecovery'
import { loadStaleReaperConfig, evaluateReaperTasks, planReaperActions, isActionable as isReaperActionable } from './StaleReaper'
// R3/TASK-2561: pravilo "je li agent mrtav" + rutanje na živ izvršni put (SSOT, dijeli ga i report alat)
import {
  loadDeadAgentReaperConfig, evaluateAgents, applyDecisions, decideSpawnRoute, makeReapEffects,
  type AgentDecision, type ReapEffects,
} from './DeadAgentReaper'
// TASK-2612: glasovni izlaz (Mumble) — poruke koje NE idu na Telegram nego u govor
import { MUMBLE_CHAT_BASE, MUMBLE_CHAT_MIN, isMumbleVoiceMessage } from './VoiceRelay'
// U3/TASK-4263: metapodatci ulaznih vrata (piše ih Telegram most, čita ih daemon).
import { procitajIngestMeta } from './IngestGateLive'
// D3/TASK-2955: forenzika izlaza spawnova — tko je ubio dijete (exit 143 = SIGTERM)
import {
  classifySpawnExit, renderSpawnExitLog, writeSpawnDiagnostics, redactSpawnCmd, SHUTDOWN_KILL_REASON,
  type SpawnExitFacts, type SpawnExitVerdict, type SpawnKillMark,
} from './SpawnExitDiagnostics'
// K7/TASK-2986: potrošnja po zadatku uživo (cost_log + data/run_log.jsonl).
import {
  parseSpawnOutput, readSessionPercent, readSessionUsage, recordSpawn,
  SESSION_USAGE_MAX_AGE_MS,
  type RunOutcome, type SpawnEnvelope,
} from './SpawnTelemetry'
// TASK-3461: dijagnoza mjerila potrošnje (401 mora biti glasan kvar, ne zamrznuta snimka).
import {
  assessMeter, classifyProbeExit, decideMeterAlarm, deliverMeterAlarm, METER_ALARM_FLAG, EMPTY_METER_ALARM_STATE,
  METER_STALE_MS, type MeterAlarmState,
  // TASK-3556: buđenje prijave kad 401 potraje (CLI je jedini koji token obnavlja).
  decideTokenNudge, noteNudgeStarted, noteProbeForNudge, shouldReportRelogin,
  formatReloginNeeded, EMPTY_TOKEN_NUDGE_STATE, TOKEN_NUDGE_MAX_TRIES, type TokenNudgeState,
} from './UsageMeter'
import { requestVoice } from '../VoiceServer/voice-client'
// TASK-2987: jedna putanja za daemon log (SSOT) + rotacija + O_APPEND.
// Bez ovoga je log bio nekronološki mozaik od 4 mjeseca (vidi LogPaths.ts).
import { REGOC_DAEMON_LOG, initDaemonLog, rotateIfNeeded, openAppendFd, stdoutIsSameFile } from './LogPaths'
// TASK-3047: ručna kočnica iz TaskManagera (globalna pauza + pauza po zadatku).
import { readPauseState, describePause } from './PauseControl'
import {
  pokreniProlaz as odluciteljProlaz, ucitajConfig as odluciteljConfig,
  trebaProlaz as odluciteljTrebaProlaz, opisiProlaz as odluciteljOpis,
  neizvedivaPustanja, type PustenZadatak,
} from './OdluciteljPogon'
// A1/TASK-3000: izolacija paralelnih spawnova u vlastiti git worktree.
import {
  loadWorktreeConfig, planIsolation, createWorktree, releaseWorktree, reapAbandonedWorktrees, sacuvaniWorktreeZadatka,
  resolveProjectWorkDir, korijenKriticaraZahtjeva, formatDecision, appendDecisionLog,
  type WorktreeRecord,
} from './WorktreeIsolation'
// A4/TASK-3003: vrata prije spajanja — rad iz izoliranog stabla ulazi u glavno tek na potpis.
import {
  runMergeGate, signoffFromCritique, formatGateLog, formatHoldBrief, loadMergeConfig,
  type MergeSignoff,
} from './MergeGate'
// A3/TASK-3002: vrata disjunktnog opsega — dva zadatka s presjekom datoteka ne kreću
// istovremeno. A1 sudar rješava pri spajanju, A3 ga sprječava prije spawna.
import {
  loadScopeConfig, planScope, readTaskScope, registerClaim, removeClaim, listClaims, listAllClaims,
  formatScopeDecision, appendScopeLog, noteDefer, clearDefer,
  type ScopeClaim,
} from './FileScopeGate'
// A5/TASK-3004: kontrolne točke ručnog pregleda. Pragovi autonomije mjere POTROŠNJU;
// ovo mjeri SADRŽAJ — staje se jer je gotov korak koji čovjek mora vidjeti.
import {
  loadCheckpointConfig, readCheckpointState, writeCheckpointState, appendCheckpointLog,
  detectTriggers, classifyHolds, dueNotification, formatCheckpointAlarm, formatHoldSummary,
  applyDecision, decisionFromTags, briefForResume, markBriefDelivered, formatResumeBrief,
  pruneDecided, checkpointIdFor,
  type CheckpointRecord, type CheckpointState,
} from './ReviewCheckpoint'
// TASK-5029: in_progress tek kad proces krene, R2 lanac jednom, pauza bez obzira na status.
import {
  CEKA_MJESTO_TAG, tagsAfterSpawnAttempt, waitingSlotNote, helperChainDecision, timPoNaporu, pausedTrackedIds,
  type SpawnStart,
} from './SpawnSlotRules'
// TASK-4895: singleton brava (A) i zabrana starta iz agentskog spawna (B).
import { acquireDaemonSingleton, spawnEnvRefusal, SPAWN_ENV_EXIT_CODE } from './DaemonSingleton'
import { cmdline as platformaCmdline, cpuVrijeme as platformaCpuVrijeme, odvojeno, pidovi as platformaPidovi } from './lib/platforma'
import { homedir } from 'os'
import { okolina, ollamaUrl, chromaUrl } from './lib/okolina-sustava' // TASK-5700 (K3a)
import { procitajTajnuSpremista } from './lib/spremiste-tajni' // TASK-5705
// TASK-5323 (prijenos s node-A, ADR-0004 §13.8): RAG prekidač po čvoru (TASK-5273, memory-config
// rag.enabled) i izlazni kanal TaskManagerAI paketa (TASK-5285). Na glavnom oboje bez učinka.
import { ragUkljucen } from '../skills/CORE/Tools/lib/rag-gate'
import { tokenKanala, chatZaPoruku, createPaketKanalReader, ucitajKanalPaketa } from './PaketKanal'

// ============================================
// Configuration
// ============================================

const HOME = process.env.HOME || homedir()
const REGOC_DIR = join(HOME, '.claude/regoc')
const DB_PATH = join(REGOC_DIR, 'messages.db')
const PID_FILE = join(REGOC_DIR, 'daemon.pid')
// TASK-4895: flock brava radnog procesa. Datoteka se nikad ne briše; jezgra bravu
// oslobađa smrću procesa, pa keeper nakon pada (i kill -9) odmah diže novi daemon.
const DAEMON_LOCK_FILE = join(REGOC_DIR, 'daemon.lock')
// TASK-2987: SSOT. Stara putanja ~/.tmp/regoc_daemon.log postaje simlink na ovu
// (initDaemonLog), pa postojeći grepovi i alati rade nepromijenjeni.
const LOG_FILE = REGOC_DAEMON_LOG
const STATUS_FILE = join(HOME, '.tmp/regoc_status.json')

const POLL_INTERVAL_MS = 1000  // Check every 1 second
const STATUS_UPDATE_INTERVAL = 1000  // Update status file every 1 second
const CONTEXT_CHECK_INTERVAL = 5000  // Check context every 5 seconds
const CONTEXT_THRESHOLD_PCT = 75  // Save to RAG when context exceeds 75%
const INFERENCE_TOOL = join(HOME, '.claude/skills/CORE/Tools/Inference.ts')
const RAG_STORE_TOOL = join(HOME, '.claude/skills/CORE/Tools/rag-store.ts')
const CONTEXT_HOOK_FILE = join(HOME, '.tmp/claude_hook_context.json')
const CONTEXT_EXPORT_FILE = join(HOME, '.tmp/claude_context_export.json')
const CONTEXT_EXPORT_INTERVAL = 300000 // Refresh export every 5 minutes
const PROJECTS_DIR = join(HOME, '.claude/projects')
const TASK_SCHEDULER_CHECK_INTERVAL = 30000 // Check task completions every 30s
const KLAUDIO_WATCHDOG_INTERVAL = 60000 // Check Klaudio every 60 seconds
const TELEGRAM_HOME = join(HOME, '.claude/tools/Telegram')
const KLAUDIO_PID_FILE = join(HOME, '.tmp/regoc_pids/klaudio.pid')  // (predmemorija; SSOT je ~/.tmp/telegram_agent.pid — v. KlaudioLiveness.ts)
const KLAUDIO_LOG_FILE = join(HOME, '.tmp/regoc_logs/klaudio.log')
const STALE_MESSAGE_CHECK_INTERVAL = 60000 // BUG-006: Check stale pending messages every 60s
const STALE_MESSAGE_THRESHOLD_SECONDS = 60 // Messages pending longer than 60s are considered stale
// REGOC_TASK_MANAGER_API: override SAMO za testove/alat — produkcija ga ne postavlja, pa je
// ponašanje nepromijenjeno. Isti obrazac kao REGOC_TASKWEBUI_PORT: uz HOME override daje
// potpuno izoliran daemon, čime se M4 (uredno gašenje) može dokazati STVARNIM restartom
// stvarnog daemona, bez ijednog dodira sa živom pločom. (M4/TASK-4627)
const TASK_MANAGER_API = process.env.REGOC_TASK_MANAGER_API || 'http://localhost:17781/api/tasks'
const PROJECTS_API_BASE = 'http://localhost:17781/api/projects' // TASK-3087: projekti (auto-otvaranje lanca)
const MEMORY_DIR = join(HOME, '.claude/MEMORY')
const CURRENT_WORK_FILE = join(MEMORY_DIR, 'STATE/current-work.json')
const WORK_DIR = join(MEMORY_DIR, 'WORK')
const VOICE_SERVER = 'http://localhost:8888/notify'

// ============================================
// TASK-623/624: System Mode (PLAN/WORK) + Persistent Agents
// ============================================

const MODE_FILE = join(HOME, '.tmp/regoc_mode.json')
const PERSISTENT_CONFIG_FILE = join(HOME, '.tmp/regoc_persistent_config.json')
const AGENT_DAEMON_SCRIPT = join(REGOC_DIR, 'AgentDaemon.ts')
const OPENROUTER_AGENT_SCRIPT = join(REGOC_DIR, 'tools/openrouter-agent.ts')
const OLLAMA_AGENT_SCRIPT = join(REGOC_DIR, 'tools/ollama-agent.ts')

type SystemMode = 'PLAN' | 'WORK'

function ensureModeFile(): void {
  if (!existsSync(MODE_FILE)) {
    writeFileSync(MODE_FILE, JSON.stringify({
      mode: 'WORK',
      since: new Date().toISOString(),
      setBy: 'system',
      reason: 'Default mode at startup'
    }, null, 2))
  }
}

function getSystemMode(): SystemMode {
  try {
    if (!existsSync(MODE_FILE)) return 'WORK'
    const data = JSON.parse(readFileSync(MODE_FILE, 'utf-8'))
    return data.mode === 'PLAN' ? 'PLAN' : 'WORK'
  } catch {
    return 'WORK'  // Fail-safe: default to WORK
  }
}

function setSystemMode(mode: SystemMode, setBy: string, reason?: string): void {
  const data = {
    mode,
    since: new Date().toISOString(),
    setBy,
    reason: reason || null
  }
  writeFileSync(MODE_FILE, JSON.stringify(data, null, 2))
  log(`[MODE] Changed to ${mode} by ${setBy}${reason ? `: ${reason}` : ''}`)
}

// ─── Persistent Agent Config ────────────────────────────────────

function isPersistentEnabled(agentId: string): boolean {
  try {
    if (!existsSync(PERSISTENT_CONFIG_FILE)) return false
    const config = JSON.parse(readFileSync(PERSISTENT_CONFIG_FILE, 'utf-8'))

    if (config.persistentMode === 'off') return false
    if (config.persistentMode === 'full') return true
    if (config.persistentMode === 'selective') {
      return config.enabledAgents?.includes(agentId) || false
    }
    return false
  } catch {
    return false
  }
}

function loadPersistentConfig(): any {
  try {
    if (!existsSync(PERSISTENT_CONFIG_FILE)) {
      return { persistentMode: 'off', enabledAgents: [], since: null, setBy: 'default' }
    }
    return JSON.parse(readFileSync(PERSISTENT_CONFIG_FILE, 'utf-8'))
  } catch {
    return { persistentMode: 'off', enabledAgents: [], since: null, setBy: 'default' }
  }
}

function savePersistentConfig(config: any): void {
  config.since = new Date().toISOString()
  writeFileSync(PERSISTENT_CONFIG_FILE, JSON.stringify(config, null, 2))
}

// ─── Persistent Agent Process Tracking ──────────────────────────

const persistentAgents = new Map<string, {
  pid: number,
  startTime: number,
  proc: ReturnType<typeof Bun.spawn>
}>()

function spawnPersistentAgent(agentId: string): void {
  // ADR-0022 O6/F3 (TASK-5615): u načinu `on` ne-Klaudio trajni agent nema AgentDaemon —
  // trajnost je sesija u spawn putu (jedan izvršitelj). Klaudio (Telegram) ostaje kako jest.
  if (trajnaZamjenjujeAgentDaemon(trajniNacin(), agentId)) {
    log(`[PERSISTENT] ${agentId}: trajna sesija u spawn putu (ADR-0022) — AgentDaemon se ne pokreće`)
    return
  }
  if (persistentAgents.has(agentId)) {
    log(`[PERSISTENT] Agent ${agentId} already running as persistent daemon`)
    return
  }

  // CROSS-PROCESS GUARD (TASK-638 loop fix): `persistentAgents` is per-process,
  // so each RegocDaemon restart spawned ANOTHER AgentDaemon blind to one a prior
  // RegocDaemon left alive — accumulating 5+ opus kosjenka daemons whose parallel
  // claude --print bursts cause the rate-limit exit-1 failures that feed the loop.
  // Skip spawning if an AgentDaemon for this agent already exists cross-process.
  try {
    const existing = Bun.spawnSync(['pgrep', '-f', `AgentDaemon.ts --agent ${agentId}`])
    const pids = existing.stdout.toString().trim().split('\n').filter(p => p && Number(p) !== process.pid)
    if (pids.length > 0) {
      log(`[PERSISTENT] Agent ${agentId} already running cross-process (PID ${pids.join(',')}) — NOT spawning duplicate`)
      return
    }
  } catch (e) {
    log(`[PERSISTENT] pgrep guard failed for ${agentId}: ${e} — proceeding`)
  }

  const agentConfig = agentRegistry?.agents?.[agentId]
  const fallbackModel = (agentConfig as any)?.model || 'sonnet'
  const spawnTarget = resolveSpawnModel(agentId, fallbackModel)
  // Perzistentni AgentDaemon radi preko claude CLI → podržan samo Anthropic.
  // Ne-Anthropic override (npr. ollama) pada na registarski alias (API spawn je za on-demand delegaciju).
  let model = fallbackModel
  if (spawnTarget.provider === 'anthropic') {
    model = spawnTarget.model
  } else {
    log(`[PERSISTENT] ${agentId}: override ${spawnTarget.provider}:${spawnTarget.model} nije podržan za perzistentni daemon (CLI) — koristim '${fallbackModel}'`)
  }

  log(`[PERSISTENT] Starting persistent agent daemon: ${agentId} (${model})`)

  // CRITICAL: Remove CLAUDECODE env vars
  const daemonEnv: Record<string, string> = {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME,
    USER: process.env.USER || 'klaudio',
    SHELL: process.env.SHELL || '/bin/bash',
    TERM: 'xterm-256color',
    REGOC_AGENT_ID: agentId,
    BUN_INSTALL: process.env.BUN_INSTALL || join(HOME, '.bun'),
    CLAUDE_SUBAGENT: '1',
  }

  const proc = Bun.spawn([
    'bun', AGENT_DAEMON_SCRIPT,
    '--agent', agentId,
    '--model', model
  ], {
    cwd: HOME,
    stdout: 'pipe',
    stderr: 'pipe',
    env: daemonEnv
  })

  persistentAgents.set(agentId, {
    pid: proc.pid,
    startTime: Date.now(),
    proc
  })

  // Handle unexpected exit — auto-restart after 30s cooldown
  ;(async () => {
    await proc.exited
    log(`[PERSISTENT] Agent ${agentId} exited. Will restart in 30s if still enabled.`)
    persistentAgents.delete(agentId)

    setTimeout(() => {
      if (!persistentAgents.has(agentId) && isPersistentEnabled(agentId)) {
        spawnPersistentAgent(agentId)
      }
    }, 30000)
  })()

  log(`[PERSISTENT] Agent ${agentId} spawned (PID: ${proc.pid})`)
}

/**
 * R3/TASK-2561: ima li `agentId` ŽIV perzistentni daemon (a ne samo zapis u mapi)?
 *
 * Vraća true samo ako proces stvarno postoji. Ako je zapis lažan (daemon umro, a
 * `proc.exited` handler nije stigao počistiti mapu — npr. RegocDaemon je u međuvremenu
 * restartan), zapis se REAPA: miče se iz mape, u live načinu i `agent_status`→offline.
 * Pozivatelj tada ide na spawn-on-demand, pa posao ne trune u inboxu mrtvog daemona.
 *
 * Rollback: `deadAgentReaper=false` → stara semantika (`persistentAgents.has`).
 */
function ensurePersistentAgentAlive(agentId: string): boolean {
  const entry = persistentAgents.get(agentId)
  if (!isEnabled('deadAgentReaper')) return !!entry   // stari put ostaje fallback

  const d = decideSpawnRoute({ persistentEnabled: true, entryPid: entry?.pid })
  if (d.route === 'persistent') return true
  if (!d.reap) return false

  const live = isEnabled('deadAgentReaperLive')
  log(`  💀 [deadAgent ${live ? 'LIVE' : 'DRY'}] ${agentId}: ${d.reason}`)
  recordDeadAgentDecision({
    agentId, status: 'persistent-entry', pid: entry?.pid ?? null, pidAlive: false,
    hbAgeMs: null, hbHours: 0, lastHeartbeat: null, currentTask: null,
    verdict: 'dead', reason: d.reason, markOffline: true, reclaimTasks: false,
  }, live)

  // In-memory zapis je dokazano lažan — briše se uvijek; inače bi svaka sljedeća
  // delegacija ponovno gađala mrtav inbox. Rutanje na spawn-on-demand je fail-safe
  // (nedestruktivno), pa ne čeka live flag; upis u bazu čeka.
  persistentAgents.delete(agentId)
  if (live) {
    try {
      const db = getDb()
      db.prepare(`UPDATE agent_status SET status='offline', current_task=NULL, updated_at=CURRENT_TIMESTAMP WHERE agent_id=?`).run(agentId)
      logEvent(db, 'dead_agent_offline', agentId, `spawn-gate · ${d.reason}`)
      db.close()
    } catch (e) { log(`  ⚠️ [deadAgent] reap zapisa za ${agentId} pao: ${e}`) }
  }
  return false
}

function stopPersistentAgent(agentId: string): void {
  const info = persistentAgents.get(agentId)
  if (!info) return

  log(`[PERSISTENT] Stopping agent ${agentId} (PID: ${info.pid})`)

  // Method 1: signal file (clean shutdown)
  const signalFile = join(HOME, `.tmp/agent_stop_${agentId}`)
  writeFileSync(signalFile, '')

  // Method 2: SIGTERM after 10s if still alive
  setTimeout(() => {
    if (persistentAgents.has(agentId)) {
      try { process.kill(info.pid, 'SIGTERM') } catch {}
    }
  }, 10000)
}

function startEnabledPersistentAgents(): void {
  const config = loadPersistentConfig()
  if (config.persistentMode === 'off') {
    log(`[PERSISTENT] Mode: off — no persistent agents to start`)
    return
  }

  const agentsToStart = config.persistentMode === 'full'
    ? Object.keys(agentRegistry?.agents || {}).filter(id =>
        id !== 'regoc' && id !== 'klaudio' && id !== 'stribor' && id !== 'emard')
    : (config.enabledAgents || [])

  log(`[PERSISTENT] Mode: ${config.persistentMode}, starting: [${agentsToStart.join(', ')}]`)

  for (const agentId of agentsToStart) {
    spawnPersistentAgent(agentId)
  }
}

// ============================================
// Persistent Agent Recovery Watchdog
// Checks every 30min: if persistent agent is dead but has pending messages, restart it
// ============================================

const PERSISTENT_RECOVERY_INTERVAL_MS = 30 * 60 * 1000  // 30 minutes
let lastPersistentRecoveryCheck = 0

/** Brave trajnih sesija agenta čiji je pid mrtav (ili ponovno uporabljen) → `zauzeta = null`. */
function oslobodiMrtveBrave(agentId: string): number {
  let n = 0
  try {
    const dir = trajneSesijeDir()
    for (const f of existsSync(dir) ? readdirSync(dir) : []) {
      if (!f.endsWith('.json') || !f.startsWith(`${agentId}__`)) continue
      const kljuc = f.slice(0, -5)
      const p = citajPokazivac(dir, kljuc)
      if (!p || p === 'pokvaren' || !p.zauzeta || bravaZiva(p.zauzeta)) continue
      zapisiPokazivac(dir, { ...p, zauzeta: null })
      log(`♻️ [trajni] ${agentId}: brava oslobođena (${p.zauzeta.taskId}, pid ${p.zauzeta.pid} mrtav) — sesija ${kratkiSid(p.sessionId)}`)
      n++
    }
  } catch (e) { log(`⚠️ [trajni] ${agentId}: provjera brava nije uspjela (${e})`) }
  return n
}

function watchdogRecoverPersistentAgents(): void {
  const now = Date.now()
  if (now - lastPersistentRecoveryCheck < PERSISTENT_RECOVERY_INTERVAL_MS) return
  lastPersistentRecoveryCheck = now

  const config = loadPersistentConfig()
  if (config.persistentMode === 'off') return

  const enabledAgents = config.persistentMode === 'full'
    ? Object.keys(agentRegistry?.agents || {}).filter(id =>
        id !== 'regoc' && id !== 'klaudio' && id !== 'stribor' && id !== 'emard')
    : (config.enabledAgents || [])

  for (const agentId of enabledAgents) {
    // ADR-0022 O6/F3 (TASK-5615): ne-Klaudio trajni agent u načinu `on` nema AgentDaemon;
    // nadzor prelazi na pokazivače sesija — brava s mrtvim pidom se oslobađa.
    if (trajnaZamjenjujeAgentDaemon(trajniNacin(), agentId)) { oslobodiMrtveBrave(agentId); continue }
    // Check if agent process is alive
    let isAlive = false
    try {
      const result = Bun.spawnSync(['pgrep', '-f', `AgentDaemon.ts --agent ${agentId}`])
      isAlive = result.stdout.toString().trim().length > 0
    } catch {}

    if (!isAlive) {
      // Check if there are pending messages for this agent
      try {
        const db = getDb()
        const pending = db.prepare(
          `SELECT COUNT(*) as count FROM messages WHERE to_agent = ? AND status = 'pending'`
        ).get(agentId) as any
        db.close()

        if (pending?.count > 0) {
          log(`🔄 [RECOVERY] Persistent agent ${agentId} is dead but has ${pending.count} pending messages — restarting`)
          spawnPersistentAgent(agentId)
        } else {
          log(`💤 [RECOVERY] Persistent agent ${agentId} is dead, no pending messages — restarting anyway (should be always-on)`)
          spawnPersistentAgent(agentId)
        }
      } catch (e) {
        log(`[RECOVERY] Error checking ${agentId}: ${e}`)
      }
    }
  }
}

// ============================================
// Status Types
// ============================================

type RegocStatus =
  | 'Idle'
  | 'Polling'
  | 'Processing message'
  | 'AI inference'
  | 'Sending response'
  | 'Starting'
  | 'Stopping'

interface RegocStatusData {
  status: RegocStatus
  currentTask: string | null
  pendingMessages: number
  processedToday: number
  lastUpdate: string
  uptime: number
  lastActivity: string | null  // What was last processed
  lastActivityTime: string | null  // When
  // Context monitoring
  contextPct: number  // Current context usage percentage
  contextSavedToRAG: number  // How many times we saved context to RAG
  lastContextSave: string | null  // When was last RAG save
  // TASK-623: System mode
  mode: SystemMode
  // TASK-2990: čitatelj (konzolna traka) mora moći provjeriti TKO je zapisao stanje i
  // OTKAD ono traje. Bez `pid` se zamrznuta datoteka ne razlikuje od žive; bez
  // `statusSince` se dugotrajna obrada ne razlikuje od zaglavljene.
  pid: number
  statusSince: string | null
}

let daemonStartTime = Date.now()
let processedCount = 0
let lastActivityDesc: string | null = null
let lastActivityTimestamp: string | null = null
let lastStatusUpdate = 0  // Track when we last updated status file

// TASK-2990: heartbeat — zadnje zapisano stanje i trenutak njegove PROMJENE.
let lastStatusData: { status: RegocStatus, currentTask: string | null, pendingCount: number } | null = null
let statusSince: string | null = null
let statusHeartbeat: ReturnType<typeof setInterval> | null = null
/** Otkucaj mora biti osjetno češći od praga zastarjelosti (30 s) u DaemonLiveness.ts. */
const STATUS_HEARTBEAT_MS = 10_000

// Context monitoring state
let currentContextPct = 0
let contextSaveCount = 0
let lastContextSaveTime: string | null = null
let lastContextCheck = 0
let lastContextExportRefresh = 0
let contextAlreadySavedThisSession = false  // Prevent spam saves

// Task scheduler state (BUG-001 FIX)
let lastTaskSchedulerCheck = 0
let lastKlaudioWatchdogCheck = 0
let klaudioRestartCount = 0
// TASK-3685: uzastopni neuspjesi → backoff (v. shouldAttemptRestart).
let klaudioRestartFailures = 0
// TASK-4894: koliko je neuspjeha bilo kad je zadnji alarm otišao Goranu (0 = nije nijedan).
let klaudioAlarmPoslanNa = 0
/** Nakon toliko uzastopnih neuspjelih restarta Klaudio se prijavljuje čovjeku. */
const KLAUDIO_ALARM_PRAG = 3
let klaudioLastRestartAttemptMs = 0
let taskSchedulerIntegration: any = null

// Stale message checker state (BUG-006 FIX)
let lastStaleMessageCheck = 0
let circuitBreakerState: Map<string, { count: number, firstSeen: number }> | null = null

// ─── R1 / TASK-2557: user-flush (pending to_agent='user' → Telegram) ─────────
// Flagovi (features.json, hot-reload):
//   userFlush        → glavni prekidač; ako false, mehanizam se ni ne poziva.
//   userFlushLive    → false = SHADOW (samo logira što bi poslao, NE mijenja status);
//                      true  = LIVE (stvarno šalje; status='completed' TEK nakon HTTP 200).
//   userFlushBacklog → true = smije slati i STARE (backlog) poruke s [ZAOSTALO od <dat>]
//                      prefiksom, throttle 1/tick. Default false → forward-only.
const USER_FLUSH_INTERVAL_MS = 60 * 1000        // provjeri jednom u minuti (throttle ≈1/min za backlog)
const USER_FLUSH_BACKLOG_AGE_MS = 30 * 60 * 1000 // starije od 30 min = backlog (traži userFlushBacklog)
const USER_FLUSH_FRESH_MAX = 5                   // max svježih poruka po ticku (anti-flood)
const USER_FLUSH_SENDING_STUCK_MS = 5 * 60 * 1000 // 'sending' >5 min → povrat na pending ([MOŽDA DUPLIKAT])
const USER_FLUSH_MAXLEN = MAX_MSG_LEN            // TASK-4815: jedan strop za sve kanale (AgentOutputParser)
/** TASK-5700: opis infrastrukture za prompt iz postavki (na glavnom isti tekst kao prije). */
const INFRA_OPIS = (() => { const h = (u: string) => { try { return new URL(u).hostname } catch { return u } }; return `Ollama ${h(ollamaUrl())}, ChromaDB/RAG ${h(chromaUrl())}` })()
const REGOC_GROUP_FALLBACK = okolina().telegram.chatRegoc  // pravilo #12: fallback grupa, NIKAD adminId (TASK-5700: config/okolina.json)
let lastUserFlushCheck = 0
let _telegramToken: string | null = null

/** TASK-5285 (node-A → glavni TASK-5323): kanal paketa, svježe najviše jednom u minuti (PaketKanal.ts). */
const paketKanal = createPaketKanalReader({ ucitaj: () => ucitajKanalPaketa(HOME), log })

/** TASK-5285: kanal paketa je izvor SAMO kad stroj nema vlastitu datoteku bota (~/.claude). */
function kanalJePaketov(): boolean {
  return !_telegramTokenIzDatoteke() && !!paketKanal()
}

function _telegramTokenIzDatoteke(): string | null {
  if (_telegramToken) return _telegramToken
  try {
    const cfg = JSON.parse(readFileSync(join(HOME, '.claude', 'telegram.json'), 'utf-8'))
    _telegramToken = cfg.botToken || null
  } catch { _telegramToken = null }
  return _telegramToken
}

function getTelegramToken(): string | null {
  return tokenKanala(_telegramTokenIzDatoteke(), paketKanal)
}

/**
 * Pošalji tekst u Telegram grupu. `ok:true` SAMO na HTTP 200 + ok:true (delivery-verified).
 *
 * TASK-3082: ishod nosi i RAZLOG, jer se dvije bitno različite stvari ne smiju liječiti isto:
 *   `no-channel` — kanal ne postoji na ovom stroju (nema botTokena). Trajno stanje; ponavljanje
 *                  ga ne mijenja, pa trošiti pokušaje i na kraju baciti poruku u `failed` znači
 *                  TIHO IZGUBITI korisnikov sadržaj. Nodovi nemaju token (pravilo #19: tajna na
 *                  VM samo uz Goranovo odobrenje), pa je to ondje redovno stanje, ne kvar.
 *   `transient`  — mreža/HTTP/API je pao. Tu ponavljanje ima smisla.
 */
type SendOutcome = { ok: boolean; reason: 'sent' | 'no-channel' | 'transient' }

/** Throttle za „nema kanala": inače isti redak ide u log svakih 60 s po poruci. */
let _noChannelLoggedAt = 0

async function sendTelegramText(chatId: number, text: string): Promise<SendOutcome> {
  const token = getTelegramToken()
  if (!token) {
    const now = Date.now()
    if (now - _noChannelLoggedAt > 3600_000) {
      _noChannelLoggedAt = now
      log('  ℹ️ [user-flush] Telegram kanal nije konfiguriran na ovom stroju — poruke se isporučuju u KONZOLU')
    }
    return { ok: false, reason: 'no-channel' }
  }
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text })
    })
    if (!resp.ok) { log(`  ⚠️ [user-flush] Telegram HTTP ${resp.status}`); return { ok: false, reason: 'transient' } }
    const body: any = await resp.json().catch(() => ({}))
    if (!body?.ok) { log(`  ⚠️ [user-flush] Telegram ok=false: ${JSON.stringify(body).substring(0, 120)}`); return { ok: false, reason: 'transient' } }
    return { ok: true, reason: 'sent' }
  } catch (e) {
    log(`  ⚠️ [user-flush] fetch greška: ${e}`)
    return { ok: false, reason: 'transient' }
  }
}

/**
 * TASK-5548: dokument iz `[[SEND_DOC: …]]` u Telegram (sendDocument). Prije je user-flush
 * marker slao kao goli tekst, pa dokument agentove isporuke nije stizao nikad.
 */
async function sendTelegramDocument(chatId: number, path: string, caption?: string): Promise<void> {
  const token = getTelegramToken()
  if (!token) throw new Error('nema Telegram kanala')
  const form = new FormData()
  form.append('chat_id', String(chatId))
  if (caption) form.append('caption', caption.slice(0, 1000))
  form.append('document', Bun.file(path), basename(path))
  const resp = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: 'POST', body: form })
  const body: any = await resp.json().catch(() => ({}))
  if (!resp.ok || !body?.ok) throw new Error(`Telegram sendDocument HTTP ${resp.status}: ${String(body?.description || '').slice(0, 120)}`)
}

// ============================================
// Agent Spawn-on-Demand Configuration
// ============================================

// Max concurrent agent spawns — DUR-4/TASK-3596 (Goranova odluka, Telegram 02.09.2026):
// natrag na 3, ali kao PODESIVA vrijednost: `REGOC_MAX_AGENT_CONCURRENT=1` vraca serijski
// rad bez ijedne izmjene koda. Jedini izvor istine je AgentConcurrency.ts (komentari u
// AutonomyQueue.ts i TokenBucket.ts su vec pretpostavljali 3).
//
// Povijest: 2026-08-27 (Goran) s 3 na 1 (kroz 2, istoga dana) — posao ide SERIJSKI, po
// prioritetu: tri Opus spawna odjednom trose sesiju brze nego sto posao napreduje, a
// spajanje je ionako serijsko (sudari oznaka, 26.08.). Goran: "samo su bitni prioriteti".
// Taj razlog i dalje stoji kao MOGUCNOST, ne kao jedina opcija — zato okolina, a ne broj.
//
// Strop NIJE dozvola za rafal: auto-exec prije SVAKOG spawna iznova mjeri potrosnju i pita
// vrata autonomije (`autonomyTierFromUsage`) — ispod 70 % vuce red do stropa, iznad 70 %
// (ili na staroj/slijepoj snimci) `autonomousQueue=false` zaustavlja auto-exec, a od 85 %
// `multiAgent=false` drzi najvise jedan spawn. Rafale 29.07. je proizveo fail-open na
// zastarjelom kesu (zatvoreno u TASK-3046), ne sam broj 3.
//
// TASK-5015 (Goran, 24.09.2026.): strop je POSTAVKA TaskManagera (`settings` u regoc.db,
// Config stranica / `PUT /api/config/concurrency`) i čita se UŽIVO — najviše jednom u 5 s,
// bez restarta. Okolina `REGOC_MAX_AGENT_CONCURRENT` je samo jednokratna početna vrijednost
// (seed u TaskManagerSQL) i rezerva dok baza nije nikad pročitana. Smanjenje ne ubija
// spawnove koji rade — samo `spawnSlotAvailable` ne pušta nove dok ih ne bude manje.
const maxAgentConcurrent = createConcurrencyReader({
  dbPath: join(REGOC_DIR, 'data', 'regoc.db'),
  env: process.env as Record<string, string | undefined>,
  onChange: (c) => log(`🎚️ [strop] ${formatConcurrencyChange(c)} — vrijedi odmah, aktivni spawnovi se ne prekidaju`),
})

// TASK-5028 (Goran, 24.09.2026.): pragovi vrata autonomije (sesija 70/85/95 %, tjedan 90 %)
// su postavka TaskManagera (`settings`: autonomy.*, Config stranica / `PUT /api/config/autonomy`).
// Čitač se instalira JEDNOM u WorkStateJournal, pa ga vide svi koji pitaju vrata
// (`autonomyTierFromUsage`, `quotaVerdict`, Sudac) — najviše jedno čitanje baze u 5 s, bez
// restarta. Mijenjaju se samo brojevi; fail-CLOSED semantika vrata ostaje u WorkStateJournal.
setAutonomyThresholdsProvider(createAutonomyThresholdsReader({
  dbPath: join(REGOC_DIR, 'data', 'regoc.db'),
  onChange: (c) => log(`🎚️ [autonomija] ${formatAutonomyChanges(c.changes, c.changedBy, c.source)} — vrijedi od sljedeće odluke vrata`),
  onInvalid: (why) => log(`⚠️ [autonomija] nevaljan zapis pragova u postavkama (${why}) — vrijedi zadnji dobar skup, inače zadano 70/85/95/90`),
  onError: (err) => log(`⚠️ [autonomija] postavka pragova nečitljiva (${String(err).slice(0, 160)}) — vrijedi zadnji dobar skup, inače zadano`),
}))

// TASK-4675: kad je strop dosegnut, auto-exec je prekidao prolaz NIJEMO. Zadnji zapis o
// prigušenom obavještavanju (vidi `spawnLimitNotice`) — null znači „još nijednom".
let lastSpawnLimitLogMs: number | null = null

// 2026-06-17 (Goran): Agenti smiju raditi danima na jednom problemu — NE gasimo ih
// više po fiksnom timeoutu (prije: tvrdi 5-min SIGTERM). Umjesto toga liveness watchdog
// svaka 2h provjeri pokazuje li agent CPU napredak (radi) ili stoji (zaglavljen).
// Tvrdo gasimo SAMO ako je zaglavljen ili pređe apsolutni strop (24h).
const AGENT_LIVENESS_SWEEP_MS = 60000                          // koliko često prolazimo listu (jeftino)
const AGENT_LIVENESS_CHECK_INTERVAL_MS = 30 * 60 * 1000         // 30min — prozor odluke po agentu (TASK-4992: smanjeno s 2h jer zaglavljeni claude --print blokira slot satima)
const AGENT_HARD_CEILING_MS = 24 * 60 * 60 * 1000             // 24h — apsolutni maksimum (zadnja linija obrane)

interface AgentSpawnInfo {
  agent: string
  startTime: number
  taskId: string | null
  fromAgent: string
  origin?: VoiceOrigin          // TASK-2612: glasovno porijeklo (Mumble kanal)
  pid: number
  lastCpuJiffies: number
  lastLivenessCheck: number
  /**
   * D3/TASK-2955: postavlja ga killAgentSpawn PRIJE slanja SIGTERM-a.
   * Ako je postavljen → izlaz procesa je NAŠ prekid (watchdog/restart).
   * Ako NIJE, a proces je umro od signala → ubojica je IZVAN daemona.
   * To je bila cijela rupa iza zapisa "❌ Agent X failed (exit 143): ".
   */
  killedBy?: SpawnKillMark
  /** Naredba bez prompta (prompt se NE zapisuje) — ide u dijagnostički dump. */
  cmdRedacted?: string[]
  /**
   * A1/TASK-3000: radno stablo u kojem spawn stvarno radi. Po njemu se broji „koliko
   * ih je u istom stablu" — to je jedini ulaz koji odlučuje treba li izolacija.
   */
  workTree?: string
  /** Zapis izoliranog worktreeja (samo kad je izolacija ŽIVA); oslobađa se u `finally`. */
  worktree?: WorktreeRecord
  /**
   * A3/TASK-3002: opseg datoteka koji ovaj spawn drži. Registar je na disku (dijeli ga i
   * CLI za proširenje opsega), pa se mora osloboditi po SVAKOM putu izlaska — inače
   * zaostali zahtjev drži datoteke koje više nitko ne uređuje.
   */
  scopeClaim?: ScopeClaim
}

const activeAgentSpawns = new Map<string, AgentSpawnInfo>()
/**
 * ADR-0024 O3 (TASK-5677): ZASEBNA traka buđenja voditelja lanca. Ne broji se u strop agenata
 * (`activeAgentSpawns`) i ne zauzima Kosjenku; vlastiti strop `maxIstodobno` (config/voditelj-lanca.json).
 * Najam (spawn_leases), TMPDIR i okolina vrijede kao za svaki spawn (isti `spawnAgentOnDemand`).
 */
const voditeljSpawns = new Map<string, AgentSpawnInfo>()

/** Buđenje voditelja lanca kroz `spawnAgentOnDemand` (ADR-0024 O3). */
interface VoditeljSpawn {
  rokMs: number
  maxTurns: number
  maxIstodobno: number
  /** Stalni cwd buđenja (trajna sesija resume traži isti cwd). */
  cwd: string
  /** Kraj buđenja: 'nastavak' = voditelj ostaje in_progress (normalni put zatvaranja se preskače). */
  naKraju: (r: { resultText: string; exitCode: number | null; killedBy: SpawnKillMark | undefined }) => Promise<'nastavak' | 'zatvaranje'>
  naTrosak: (usd: number) => void
}
/** TASK-5674: proces agenta je izašao, daemon još piše presudu (kritičar zna trajati 2 min) — siroče ga ne smije oteti. */
const zatvaranjeSpawna = new ZatvaranjeSpawna()
let lastAgentLivenessCheck = 0

// D3/TASK-2955: puni stdout/stderr neuspjelih spawnova — u logu stoji samo sažetak,
// ovdje ostaje cijeli tekst (log-linija ga ne smije progutati).
const SPAWN_DIAG_DIR = join(HOME, '.tmp/regoc_spawn_diag')
const SPAWN_DIAG_KEEP = 200          // koliko dumpova čuvamo (rotacija po vremenu)
const SHUTDOWN_GRACE_MS = 1500       // koliko čekamo da killAgentSpawn isporuči poruke prije exit-a

/**
 * Zapiši puni dump neuspjelog spawna i vrati putanju (ili null ako upis padne).
 * Namjerno se NE piše prompt — samo naredba bez njega, izlazi i identifikatori.
 */
function persistSpawnDiagnostics(facts: SpawnExitFacts, verdict: SpawnExitVerdict): string | null {
  const path = writeSpawnDiagnostics(SPAWN_DIAG_DIR, facts, verdict, SPAWN_DIAG_KEEP)
  if (!path) log(`⚠️ [spawn-diag] upis dijagnostike za ${facts.agent} (pid ${facts.pid}) nije uspio`)
  return path
}

// I9/TASK-3658: `redactSpawnCmd` je preseljen u `SpawnExitDiagnostics.ts` — RegocDaemon.ts
// se iz testa ne moze uvesti (nema `import.meta.main` granu), a redakcija dumpa mora imati test.


// F6 (TASK-2549): Per-agent failure tracker s exponential backoff
// Spriječava kaskadne retry petlje (Manda 1755 failova u 4h)
interface AgentFailureInfo {
  count: number
  lastFail: number
  backoffUntil: number
}
const agentFailureTracker = new Map<string, AgentFailureInfo>()

// DUR-5/TASK-3597: osigurac na vratima SPAWNOVA. `agentFailureTracker` gore je u MEMORIJI
// ovog procesa — restart ga brise, a AgentDaemon ga uopce ne vidi. Rate-limit je pak
// ZAJEDNICKI (jedan racun, jedan `claude --print`), pa stanje mora biti cross-process:
// SQLite/WAL u messages.db, isti obrazac kao SendBreaker. Uz njega ide i `TokenBucket`
// kao strop brzine, da rafal spawnova ne nastane ni prije prvog kvara.
// Vlastiti (dugozivuci) handle: `getDb()` otvara i zatvara bazu po pozivu, a osiguracu
// treba stalna veza da bi memorijski fallback prezivio izmedju provjera.
let _spawnBreaker: SpawnBreaker | null = null
function getSpawnBreaker(): SpawnBreaker {
  if (!_spawnBreaker) {
    const db = new Database(DB_PATH)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA busy_timeout = 5000')
    _spawnBreaker = new SpawnBreaker(db, { logger: log, bucket: new TokenBucket(DB_PATH) })
  }
  return _spawnBreaker
}

function updateStatus(status: RegocStatus, currentTask: string | null = null, pendingCount: number = 0): void {
  // TASK-2990: `statusSince` se pomiče SAMO kad se stanje doista promijeni, da bi
  // heartbeat (koji prepisuje isti status svakih 10 s) mogao osvježiti `lastUpdate`
  // a da pritom ne izbriše podatak koliko daemon već visi u istom stanju.
  const changed = !lastStatusData || lastStatusData.status !== status || lastStatusData.currentTask !== currentTask
  if (changed || statusSince === null) statusSince = new Date().toISOString()
  lastStatusData = { status, currentTask, pendingCount }

  const data: RegocStatusData = {
    status,
    currentTask,
    pendingMessages: pendingCount,
    processedToday: processedCount,
    lastUpdate: new Date().toISOString(),
    uptime: Math.floor((Date.now() - daemonStartTime) / 1000),
    pid: process.pid,
    statusSince,
    lastActivity: lastActivityDesc,
    lastActivityTime: lastActivityTimestamp,
    // Context monitoring
    contextPct: currentContextPct,
    contextSavedToRAG: contextSaveCount,
    lastContextSave: lastContextSaveTime,
    // TASK-623: System mode
    mode: getSystemMode()
  }
  try {
    writeFileSync(STATUS_FILE, JSON.stringify(data, null, 2))
  } catch {
    // Silent fail
  }
}

/**
 * TASK-2990: otkucaj srca status datoteke.
 *
 * Glavna petlja piše status svake sekunde SAMO dok se vrti u prazno — čim uđe u
 * `await processMessage` (spawn agenta traje i do 5 minuta) zapis stoji. Zbog toga se
 * po starosti zapisa nije moglo razlikovati „daemon radi" od „daemon je mrtav".
 * Timer se izvršava i dok petlja čeka na I/O, pa `lastUpdate` postaje pravi dokaz
 * da je proces živ i da mu je petlja događaja prohodna. Zaglavljen daemon (blokirana
 * petlja) prestaje kucati — i tek to konzola smije prikazati kao STALE.
 */
/** ADR-0012 §14: koliko često se čiste najmovi siročad (kill -9 ne stigne pustiti najam). */
const NAJAM_CISTKA_SVAKIH = 60_000
let zadnjaCistkaNajmova = 0

function startStatusHeartbeat(): void {
  if (statusHeartbeat) return
  statusHeartbeat = setInterval(() => {
    // ADR-0012 §14 t.3: `pocistiNajmove()` dosad nije imao pozivatelja. Najam čiji je pid
    // mrtav ionako NE zaključava ploču (fail-open u `najamAktivan`), ali zaostale datoteke
    // bez čistača rastu bez granice — isti razlog zbog kojeg se čiste `file_scope_claims`.
    const sad = Date.now()
    if (sad - zadnjaCistkaNajmova > NAJAM_CISTKA_SVAKIH) {
      zadnjaCistkaNajmova = sad
      try {
        const ocisceni = pocistiNajmove(sad)
        if (ocisceni.length) log(`🧹 [najam] očišćeno ${ocisceni.length} zaostalih najmova: ${ocisceni.slice(0, 5).join(', ')}`)
        // TASK-5140: očišćen najam = dokaz da je proces mrtav → siroče-oporavak ga provjerava
        // u sljedećem prolazu, bez čekanja praga (TASK-5134 je ovdje ostao in_progress bez ikoga).
        for (const id of ocisceni) if (/^TASK-\d+$/.test(id)) _siroceOcisceniNajmovi.set(id, sad)
      } catch { /* čišćenje nikad ne ruši otkucaj */ }
    }
    const s = lastStatusData
    if (!s) return
    updateStatus(s.status, s.currentTask, s.pendingCount)
  }, STATUS_HEARTBEAT_MS)
  // Otkucaj ne smije sam držati proces na životu kad se sve ostalo ugasi.
  if (typeof (statusHeartbeat as any)?.unref === 'function') (statusHeartbeat as any).unref()
}

function stopStatusHeartbeat(): void {
  if (statusHeartbeat) { clearInterval(statusHeartbeat); statusHeartbeat = null }
}

// ============================================
// Logging
// ============================================

// TASK-2987: rotacija se provjerava svakih N redaka, ne na svaki (statSync po retku
// bi bio suvišan syscall na svakom otkucaju).
const LOG_ROTATE_CHECK_EVERY = 500
let logLinesSinceRotateCheck = 0

// TASK-2987: u daemon modu je stdout VEĆ preusmjeren u LOG_FILE (O_APPEND fd), pa bi
// dodatni appendFileSync svaki redak zapisao dvaput. Mjereno nakon prvog deploya:
// cijeli startni blok bio je udvostručen. Provjera je jednokratna (dev+ino), ne po retku.
const STDOUT_IS_LOG_FILE = stdoutIsSameFile(LOG_FILE)

function log(message: string): void {
  const timestamp = new Date().toISOString()
  const line = `[${timestamp}] ${message}`
  console.log(line)

  // Also append to log file
  try {
    const fs = require('fs')
    if (!STDOUT_IS_LOG_FILE) fs.appendFileSync(LOG_FILE, line + '\n')
    if (++logLinesSinceRotateCheck >= LOG_ROTATE_CHECK_EVERY) {
      logLinesSinceRotateCheck = 0
      const r = rotateIfNeeded(LOG_FILE)
      if (r.rotated) {
        fs.appendFileSync(
          LOG_FILE,
          `[${new Date().toISOString()}] 🔄 log rotiran (${Math.round(r.sizeBefore / 1048576)} MB → ${r.archivedTo})\n`
        )
      }
    }
  } catch {}
}

/**
 * P3/TASK-2569 s6: strojni verifikacijski gate — POSLJEDNJA provjera prije completed,
 * ISKLJUČIVO na putu koji vodi u completed (`treatAsDone`). Ako je CompletionGuard/
 * criticGate već presudio blocked, gate se uopće ne pita — nije mu posao dupliciran
 * razlog blokade. Čista(ish) funkcija — izdvojena iz spawn-completion handlera baš
 * zato da se ponašanje po sva tri stanja flagova može testirati izolirano.
 *
 * Ponašanja (isEnabled, default false = OFF):
 *   OFF (oba flaga false)          → { instruction: null }, ništa se ne mijenja.
 *   verificationGateShadow=true    → GATE-SHADOW redak u daemon.log (preko log()),
 *                                     { instruction: null } — zatvaranje ide po starom.
 *   verificationGateLive=true      → { instruction: <uputa> } kad blok nedostaje/je
 *                                     neispravan; poziva mjesto tad odbija 'completed'.
 *
 * checkVerificationBlock() je sam po sebi fail-OPEN na Ollama kvar (advisory-only);
 * try/catch ovdje hvata i sam poziv (regex-put ne bi smio baciti, ali kvar u VLASTITOM
 * kodu ne smije zaustaviti isporuku — fail-OPEN, isti obrazac kao criticGate).
 */
async function evaluateVerificationGate(
  taskId: string | null,
  agentId: string,
  treatAsDone: boolean,
  resultText: string,
): Promise<{ instruction: string | null }> {
  const gateShadowOn = isEnabled('verificationGateShadow')
  const gateLiveOn = isEnabled('verificationGateLive')
  if (!treatAsDone || (!gateShadowOn && !gateLiveOn)) return { instruction: null }

  try {
    const gateResult = await checkVerificationBlock(resultText)
    if (gateLiveOn) {
      return { instruction: gateResult.ok ? null : buildRejectionInstruction(gateResult) }
    }
    log(`GATE-SHADOW task=${taskId || 'N/A'} ok=${gateResult.ok} reason=${gateResult.reason}`)
    return { instruction: null }
  } catch (e) {
    log(`⚠️ [verification-gate] provjera pala (${agentId}/${taskId || 'bez-zadatka'}) — ne blokiram (fail-OPEN): ${e}`)
    return { instruction: null }
  }
}

/**
 * Resolva --model vrijednost za spawn agenta, poštujući per-agent override
 * iz model-config.json (agentOverrides[id]). Postavlja se preko Info taba u TaskWebUI.
 *
 * Danas su preko `claude --print --model X` spawnable samo Anthropic modeli, pa se
 * uzima u obzir SAMO 'anthropic:<model>' override. Ostali provideri (Ollama itd.)
 * traže API spawn path (F2 / TASK-2588) — do tada padaju na fallback (registarski alias),
 * pa je promjena bihevioralno inertna dok Goran ne odabere Anthropic model.
 *
 * TASK-4839: sâmo RAZRJEŠENJE živi u `models/AgentModel.ts`, jer ga uz daemon treba i
 * `Sudac.ts` (agent-vratar), a preslika istog pravila se razilazi (ADR-0004, dizajn
 * TASK-4838 §4.2). Ovdje je ostao samo poziv i daemonov `log`.
 */
function resolveSpawnModel(agentId: string, fallbackModel: string): SpawnTarget {
  return resolveAgentTarget(agentId, fallbackModel, { log })
}

// ─── Tier modela po ZADATKU (A6 / TASK-3005) ──────────────────────────────────
// `resolveSpawnModel` gore odgovara na "koji model vozi OVAJ AGENT". Ovo odgovara na
// "koji model traži OVAJ POSAO" i smije taj odgovor SPUSTITI (nikad podići iznad
// agentovog — pravila i obrazloženje u `TaskTier.ts`). Cijela odluka je čista logika
// tamo; ovdje je samo I/O: povijest pokušaja, log, dnevnik odluka.

/** Dnevnik odluka o tieru — ulaz za `tools/tier-report.ts` (mjerenje uštede). */
const TIER_DECISIONS_LOG = join(HOME, '.claude/regoc/data/tier_decisions.jsonl')

/** Zadnjih N redaka `run_log.jsonl` — povijest pokušaja po zadatku (za eskalaciju). */
function readRecentRunLog(maxLines = 500): any[] {
  try {
    const file = join(HOME, '.claude/regoc/data/run_log.jsonl')
    if (!existsSync(file)) return []
    const lines = readFileSync(file, 'utf-8').trim().split('\n').slice(-maxLines)
    const out: any[] = []
    for (const l of lines) { try { out.push(JSON.parse(l)) } catch { /* pokvaren redak ne ruši odluku */ } }
    return out
  } catch { return [] }
}

/**
 * Spawn-meta za jedan zadatak, uz tier po težini posla.
 *
 * Zastavice: `taskTier` = odluka se donosi i bilježi (SHADOW, ponašanje nepromijenjeno),
 * `taskTierLive` = odluka se STVARNO primjenjuje na `--model`. Rollback je zastavica na
 * false (hot-reload ≤30 s, bez restarta). Fail-open: svaka greška vraća današnji izbor.
 */
async function resolveTaskSpawnTarget(
  agentId: string,
  task: { id?: string | null; title?: string | null; description?: string | null; tags?: unknown } | null,
  fallbackModel: string,
): Promise<SpawnTarget> {
  const base = resolveSpawnModel(agentId, fallbackModel)
  if (!isEnabled('taskTier', false)) return base
  try {
    const TT = await import('./TaskTier')
    const taskId = task?.id ? String(task.id) : null
    const attemptedModels = taskId ? TT.failedAttemptModels(readRecentRunLog(), taskId) : []
    const decision = TT.resolveTaskTier({
      title: task?.title,
      description: task?.description,
      tags: task?.tags,
      agentDefaultModel: base.model,
      provider: base.provider,
      attemptedModels,
    })
    const live = isEnabled('taskTierLive', false)
    log(`${live ? '' : '👁️ [SHADOW] '}${TT.formatDecisionLog(taskId, agentId, decision)}`)
    try {
      appendFileSync(TIER_DECISIONS_LOG, JSON.stringify({
        ts: new Date().toISOString(),
        task_id: taskId, agent: agentId, mode: live ? 'live' : 'shadow',
        tier: decision.tier, baseline: decision.baseline, model: decision.model,
        source: decision.source, reason: decision.reason, cost_factor: decision.costFactor,
        attempted_models: attemptedModels,
      }) + '\n')
    } catch { /* dnevnik odluka nije razlog da spawn ne krene */ }
    if (live && base.provider === 'anthropic' && decision.model !== base.model) {
      return { ...base, model: decision.model }
    }
  } catch (e) {
    log(`⚠️ [TIER] odluka pala (${e}) — ostaje ${base.provider}:${base.model}`)
  }
  return base
}

/**
 * Anthropic-kompatibilni provideri (Kimi/GLM/MiniMax/Qwen/DeepSeek): koriste ISTI `claude --print`
 * spawn put, samo s ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN preusmjerenim na njihov endpoint.
 * Time REGOČ dobiva SAMO njihov MODEL (u vlastitom agent-kontekstu), bez njihovih CLI/multiagent featurea.
 * Konfiguracija: model-config.json → providers.<id> = { anthropicCompatible:true, baseUrl, apiKey:"env:VAR" }.
 * Agent se rutira preko agentOverrides = "<provider>:<model>" (npr. "kimi:kimi-k2.6", "glm:glm-4.6").
 */
function getAnthropicCompatProvider(provider: string): { baseUrl: string, token: string } | null {
  try {
    const p = join(HOME, '.claude/regoc/models/model-config.json')
    if (!existsSync(p)) return null
    const mc = JSON.parse(readFileSync(p, 'utf-8'))
    const pc = mc?.providers?.[provider]
    if (!pc || !pc.anthropicCompatible || pc.enabled === false || !pc.baseUrl) return null
    const ak = pc.apiKey || ''
    const token = (typeof ak === 'string' && ak.startsWith('env:')) ? (process.env[ak.slice(4)] || '') : String(ak)
    if (!token) { log(`[PROVIDER] ${provider}: nema tokena (${pc.apiKey}) — preskačem`); return null }
    return { baseUrl: pc.baseUrl, token }
  } catch { return null }
}

// ============================================
// Context Monitoring
// ============================================

interface ContextData {
  context_window?: {
    current_usage?: {
      cache_read_input_tokens?: number
      input_tokens?: number
      cache_creation_input_tokens?: number
      output_tokens?: number
    }
    context_window_size?: number
  }
}

// ============================================
// Klaudio Watchdog - Auto-restart if crashed
// ============================================

function isKlaudioRunning(): boolean {
  // TASK-3685: liveness ide preko KlaudioLiveness.ts — agentov pid file je SSOT,
  // watchdogov je samo predmemorija koja se sama liječi, a živ PID se provjerava
  // po cmdline-u (PID-reuse). Ranije je ovdje bio SAMO watchdogov file, pa je svaki
  // start izvan watchdoga proizvodio lažni "Klaudio is DOWN" u petlji svakih 60 s.
  return isKlaudioAlive()
}

async function watchdogCheckKlaudio(): Promise<void> {
  // Appliance/headless (bez Telegrama): ENABLE_KLAUDIO=0 → watchdog no-op (inače beskonačni restart-spam).
  const _kf = (process.env.ENABLE_KLAUDIO ?? '').toLowerCase()
  if (_kf === '0' || _kf === 'false' || _kf === 'off' || _kf === 'no') return
  try {
    if (isKlaudioRunning()) {
      // TASK-3685: oporavak — čim je Klaudio opet živ, brojač neuspjeha pada na 0.
      if (klaudioAlarmPoslanNa > 0) {
        log('[WATCHDOG] Klaudio je opet živ — alarm se poništava')
        void sendTelegramText(REGOC_GROUP_FALLBACK,
          '✅ REGOČ: Klaudio (Telegram) je opet na vezi. Poruke ponovno stižu.')
      }
      klaudioRestartFailures = 0
      klaudioAlarmPoslanNa = 0
      return // All good
    }

    // TASK-3685: nakon neuspjelog restarta ne pokušavaj svakih 60 s (spam u logu).
    const nowMs = Date.now()
    if (!shouldAttemptRestart({ consecutiveFailures: klaudioRestartFailures, lastAttemptMs: klaudioLastRestartAttemptMs }, nowMs)) return
    klaudioLastRestartAttemptMs = nowMs

    // Klaudio is NOT running - restart it
    klaudioRestartCount++
    log(`[WATCHDOG] Klaudio is DOWN! Restart attempt #${klaudioRestartCount}`)

    // Ensure log directory exists (use ~/.tmp/ — /tmp is tmpfs and is volatile!)
    const logDir = join(HOME, '.tmp/regoc_logs')
    if (!existsSync(logDir)) {
      const { mkdirSync } = await import('fs')
      mkdirSync(logDir, { recursive: true })
    }

    // Ensure PID directory exists (use ~/.tmp/ — /tmp is tmpfs and is volatile!)
    const pidDir = join(HOME, '.tmp/regoc_pids')
    if (!existsSync(pidDir)) {
      const { mkdirSync } = await import('fs')
      mkdirSync(pidDir, { recursive: true })
    }

    // TASK-4894: `isKlaudioRunning()` je upravo rekao NE — a to je provjereno po
    // cmdline-u i skenu procesa (platforma), ne po pid fileu. Znači da svaki pid file koji je ostao
    // na disku LAŽE, i dijete će na njemu pasti s „already running" (exit 1). U padu
    // 16.09. je upravo to blokiralo svih 5 restarta. Zato laž brišemo PRIJE spawna;
    // file živog Klaudija se pritom ne dira.
    const obrisaniPidFileovi = clearStaleKlaudioPidFilesReal()
    if (obrisaniPidFileovi.length > 0) {
      log(`[WATCHDOG] Obrisan zastario pid file: ${obrisaniPidFileovi.join(', ')}`)
    }

    // Start Klaudio — brisanje CLAUDECODE env var je KRITIČNO!
    // Bez toga claude -p pada s "Cannot be launched inside another Claude Code session"
    const watchdogEnv = { ...process.env }
    delete watchdogEnv.CLAUDECODE
    delete watchdogEnv.CLAUDE_CODE_ENTRYPOINT

    // TASK-3685: log se otvara u APPEND modu. Bun.file() kao stdout piše od offseta 0
    // i tiho pregazi početak postojećeg loga (dokaz: "Klaudio already running (PID: 44974)"
    // preko prve linije klaudio.log-a) — pa se dijagnostika kvara nije ni vidjela.
    const { openSync } = await import('fs')
    const klaudioLogFd = openSync(KLAUDIO_LOG_FILE, 'a')
    const proc = Bun.spawn(['bun', join(TELEGRAM_HOME, 'telegram_agent.ts')], {
      stdout: klaudioLogFd,
      stderr: klaudioLogFd,
      stdin: 'ignore',
      env: watchdogEnv,
    })

    // Write PID file
    writeFileSync(KLAUDIO_PID_FILE, String(proc.pid))

    // Wait for Bun startup (SQLite + Telegram API handshake takes 2-4s)
    // FIX-003: increased from 3s to 8s to avoid false "FAILED" detections
    await new Promise(r => setTimeout(r, 8000))

    if (isKlaudioRunning()) {
      if (klaudioAlarmPoslanNa > 0) {
        void sendTelegramText(REGOC_GROUP_FALLBACK,
          `✅ REGOČ: Klaudio (Telegram) je opet na vezi nakon ${klaudioRestartFailures} neuspjelih pokušaja.`)
      }
      klaudioRestartFailures = 0
      klaudioAlarmPoslanNa = 0
      log(`[WATCHDOG] Klaudio restarted successfully (PID: ${proc.pid}, restart #${klaudioRestartCount})`)
    } else {
      klaudioRestartFailures++
      // TASK-3685: zašto je pao — bez ovoga je poruka bila neupotrebljiva za dijagnozu.
      const why = proc.exitCode !== null ? `exit=${proc.exitCode}` : 'proces nestao bez exit koda'
      const backoffMin = Math.round(Math.min(klaudioRestartFailures * 60_000, 15 * 60_000) / 60_000)
      log(`[WATCHDOG] Klaudio restart FAILED (attempt #${klaudioRestartCount}, ${why}, uzastopnih ${klaudioRestartFailures}, sljedeći pokušaj za ~${backoffMin} min; log: ${KLAUDIO_LOG_FILE})`)

      // TASK-4894: dosad je neuspjeli restart završavao ISKLJUČIVO u daemon.log — a Klaudio
      // je jedini kanal prema Goranu, pa je njegov pad bio nevidljiv upravo onome koga se
      // tiče. Mjereno 16.09.: 5 neuspjeha kroz 11 minuta, nula obavijesti. `sendTelegramText`
      // zove Bot API izravno, dakle NE ovisi o Klaudiju — alarm zaobilazi pokvareni dio.
      // Prag 3 (≈7 min backoffa) da prolazni restart ne budi nikoga; pa svakih 10 neuspjeha.
      const zaAlarm = klaudioRestartFailures >= KLAUDIO_ALARM_PRAG &&
        (klaudioAlarmPoslanNa === 0 || klaudioRestartFailures - klaudioAlarmPoslanNa >= 10)
      if (zaAlarm) {
        klaudioAlarmPoslanNa = klaudioRestartFailures
        const poruka =
          `🚨 REGOČ: Klaudio (Telegram) NE STARTA — ${klaudioRestartFailures} uzastopnih neuspjelih restarta (zadnji: ${why}).\n` +
          `Dok ovo traje, poruke s Telegrama ne ulaze u sustav; ovaj alarm ide izravno preko Bot API-ja.\n` +
          `Log: ${KLAUDIO_LOG_FILE}\n` +
          `Ručno: rm -f ~/.tmp/telegram_agent.pid ~/.tmp/regoc_pids/klaudio.pid && setsid bun ~/.claude/tools/Telegram/telegram_agent.ts &`
        void sendTelegramText(REGOC_GROUP_FALLBACK, poruka)
          .then(() => log(`[WATCHDOG] Alarm o padu Klaudija poslan u REGOČ grupu (${klaudioRestartFailures} neuspjeha)`))
          .catch(e => log(`[WATCHDOG] Alarm o padu Klaudija NIJE poslan: ${e}`))
      }
    }
  } catch (error) {
    log(`[WATCHDOG] Error checking/restarting Klaudio: ${error}`)
  }
}

// ============================================
// Task Completion Watcher (BUG-001 FIX)
// ============================================

// TASK-2987: zadnje ZAPISANO stanje — otkucaj bez promjene se ne loga.
let lastLoggedCompletedTask = ''
let lastLoggedQueuedSig = ''

async function checkTaskCompletions(): Promise<void> {
  try {
    // Lazy load TaskSchedulerIntegration to avoid circular dependencies
    if (!taskSchedulerIntegration) {
      const { TaskSchedulerIntegration } = await import('./TaskSchedulerIntegration')
      taskSchedulerIntegration = new TaskSchedulerIntegration()
      log('Task scheduler integration initialized')
    }

    // Run one tick of the scheduler
    await taskSchedulerIntegration.tick()

    const status = taskSchedulerIntegration.getStatus()
    // TASK-2987: prije je ovo bilo bezuvjetno, svakih 30 s → 392 968 od 421 635 redaka
    // (93 %) je bio JEDAN te isti „Last completed task: TASK-F8-010". Log bez sadržaja
    // je razlog zašto se zastoj tražio ručno. Sada se piše SAMO na promjenu.
    if (status.lastTaskCompleted && status.lastTaskCompleted !== lastLoggedCompletedTask) {
      lastLoggedCompletedTask = status.lastTaskCompleted
      log(`Last completed task: ${status.lastTaskCompleted}`)
    }
    const queuedSig = (status.queuedTasks || []).join(', ')
    if (queuedSig && queuedSig !== lastLoggedQueuedSig) {
      lastLoggedQueuedSig = queuedSig
      log(`Queued unblocked tasks: ${queuedSig}`)
    } else if (!queuedSig) {
      lastLoggedQueuedSig = ''
    }

  } catch (error) {
    log(`Task completion check error: ${error}`)
  }
}

// ============================================
// BUG-006 FIX: Stale Pending Message Checker
// ============================================

interface StalePendingMessage {
  id: string
  from_agent: string
  to_agent: string
  content: string
  message_type: string
  priority: number
  status: string
  created_at: string
  seconds_pending: number
}

/**
 * Checks for messages that have been pending for too long (> 60 seconds)
 * and processes them. This covers ALL agents, not just REGOČ.
 */
async function checkStalePendingMessages(): Promise<void> {
  try {
    const db = getDb()

    // Find messages pending longer than threshold for ANY agent
    const staleMessages = db.prepare(`
      SELECT
        id, from_agent, to_agent, content, message_type, priority, status, created_at,
        CAST((julianday('now') - julianday(created_at)) * 86400 AS INTEGER) as seconds_pending
      FROM messages
      WHERE status = 'pending'
        AND CAST((julianday('now') - julianday(created_at)) * 86400 AS INTEGER) > ?
      ORDER BY priority ASC, created_at ASC
      LIMIT 10
    `).all(STALE_MESSAGE_THRESHOLD_SECONDS) as StalePendingMessage[]

    if (staleMessages.length > 0) {
      log(`⚠️ BUG-006: Found ${staleMessages.length} stale pending message(s)`)

      for (const msg of staleMessages) {
        log(`  → Stale message for ${msg.to_agent} (pending ${msg.seconds_pending}s): "${msg.content.substring(0, 40)}..."`)

        // Handle based on target agent
        if (msg.to_agent === 'regoc') {
          // Process REGOČ messages with AI
          await processMessage(db, msg as Message)
        } else if (msg.to_agent === 'klaudio' || msg.to_agent === 'stribor') {
          // Communication agents - these should be picked up by their own daemons
          // Log warning but don't process - their daemon might be down
          log(`  ⚠️ Communication agent ${msg.to_agent} has stale message - daemon may be down`)
          logEvent(db, 'stale_message_warning', msg.to_agent, `Message pending ${msg.seconds_pending}s - daemon may need restart`)
        } else {
          // Specialist agents (Kosjenka, Jelena, Malik, etc.)
          // These are processed by PAI sessions, not daemons
          // Send reminder back to from_agent
          log(`  → Sending stale notification for specialist ${msg.to_agent}`)

          // Create a notification message
          const notificationContent = `⚠️ Poruka za ${msg.to_agent} čeka ${msg.seconds_pending}s bez odgovora. Originalna poruka: "${msg.content.substring(0, 100)}..."`

          // If from_agent is klaudio/stribor, send notification to them
          // Otherwise, send to klaudio as default notification channel
          const notifyAgent = (msg.from_agent === 'klaudio' || msg.from_agent === 'stribor')
            ? msg.from_agent
            : 'klaudio'

          sendResponse(db, notifyAgent, notificationContent, 3) // High priority

          // Update status to prevent repeated notifications
          db.prepare(`
            UPDATE messages
            SET status = 'stale_notified', updated_at = datetime('now')
            WHERE id = ?
          `).run(msg.id)

          logEvent(db, 'stale_message_notified', msg.to_agent, `Notified ${notifyAgent} about stale message`)
        }
      }
    }

    db.close()
  } catch (error) {
    log(`BUG-006 stale message check error: ${error}`)
  }
}

function findActiveSessions(): { id: string; project: string; last_activity: string; age_minutes: number }[] {
  const sessions: { id: string; project: string; last_activity: string; age_minutes: number }[] = []
  const now = Date.now()
  const maxAgeMs = 24 * 60 * 60 * 1000

  try {
    if (!existsSync(PROJECTS_DIR)) return sessions

    const projects = readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())

    for (const project of projects) {
      const projectPath = join(PROJECTS_DIR, project.name)
      try {
        const files = readdirSync(projectPath, { withFileTypes: true })
          .filter(f => f.isFile() && f.name.endsWith('.jsonl'))

        for (const file of files) {
          const filePath = join(projectPath, file.name)
          const stats = statSync(filePath)
          const ageMs = now - stats.mtimeMs

          if (ageMs < maxAgeMs) {
            sessions.push({
              id: file.name.replace('.jsonl', '').substring(0, 8),
              project: project.name.replace(/-/g, '/').substring(0, 30),
              last_activity: new Date(stats.mtimeMs).toISOString(),
              age_minutes: Math.round(ageMs / 60000)
            })
          }
        }
      } catch { /* skip */ }
    }

    sessions.sort((a, b) => a.age_minutes - b.age_minutes)
    return sessions.slice(0, 10)
  } catch {
    return sessions
  }
}

function refreshContextExport(totalTokens: number, maxContext: number, pct: number): void {
  const now = Date.now()
  if (now - lastContextExportRefresh < CONTEXT_EXPORT_INTERVAL) return

  try {
    const status = pct >= 75 ? 'critical' : pct >= 50 ? 'high' : pct >= 25 ? 'medium' : 'low'
    const activeSessions = findActiveSessions()

    const exportData = {
      context: {
        percentage: pct,
        used_tokens: totalTokens,
        max_tokens: maxContext,
        status
      },
      session: {
        id: 'daemon-refresh',
        model: 'unknown',
        duration_ms: 0,
        cwd: process.cwd()
      },
      active_sessions: activeSessions,
      updated_at: new Date().toISOString(),
      source: 'regoc-daemon'
    }

    writeFileSync(CONTEXT_EXPORT_FILE, JSON.stringify(exportData, null, 2))
    lastContextExportRefresh = now
    log(`[Context Export] Refreshed: ${pct}% (${Math.round(totalTokens/1000)}k tokens), ${activeSessions.length} sessions`)
  } catch (error) {
    log(`[Context Export] Error: ${error}`)
  }
}

async function checkAndSaveContext(): Promise<void> {
  try {
    // Read context hook file
    if (!existsSync(CONTEXT_HOOK_FILE)) return

    const contextJson = readFileSync(CONTEXT_HOOK_FILE, 'utf-8')
    const contextData: ContextData = JSON.parse(contextJson)

    const usage = contextData.context_window?.current_usage
    // Opus 4.6 ima nativno 1M kontekst — fallback ažuriran 14.09.2026.
    const maxContext = contextData.context_window?.context_window_size || 1000000

    if (!usage) return

    // Calculate total tokens
    const totalTokens = (usage.cache_read_input_tokens || 0) +
                       (usage.input_tokens || 0) +
                       (usage.cache_creation_input_tokens || 0) +
                       (usage.output_tokens || 0)

    // Calculate percentage (add baseline of ~22k for system prompts)
    const baseline = 22600
    const totalWithBaseline = totalTokens + baseline
    currentContextPct = Math.round((totalWithBaseline / maxContext) * 100)

    // Refresh context export file every 5 minutes
    refreshContextExport(totalWithBaseline, maxContext, currentContextPct)

    // Check if we need to save to RAG
    if (currentContextPct >= CONTEXT_THRESHOLD_PCT && !contextAlreadySavedThisSession && ragUkljucen()) {
      log(`⚠️ Context at ${currentContextPct}% (threshold: ${CONTEXT_THRESHOLD_PCT}%) - saving to RAG...`)

      // Extract current work context for richer save
      let workDir = 'unknown'
      let objectives: string[] = []
      let topics: string[] = []
      let sessionId = contextData.session_id || 'unknown'

      try {
        if (existsSync(CURRENT_WORK_FILE)) {
          const workJson = readFileSync(CURRENT_WORK_FILE, 'utf-8')
          const workData = JSON.parse(workJson)
          workDir = workData.work_dir || 'unknown'
          sessionId = workData.session_id || sessionId

          // Try to read META.yaml for objectives and topics
          const metaPath = join(WORK_DIR, workDir, 'META.yaml')
          if (existsSync(metaPath)) {
            const metaContent = readFileSync(metaPath, 'utf-8')

            // Extract objectives
            const objMatch = metaContent.match(/objectives:\s*\n((?:\s+-[^\n]+\n?)+)/)
            if (objMatch) {
              objectives = objMatch[1]
                .split('\n')
                .filter(line => line.trim().startsWith('-'))
                .map(line => line.replace(/^\s*-\s*/, '').trim())
                .filter(Boolean)
                .slice(0, 5) // Max 5 objectives
            }

            // Extract tags/topics
            const tagsMatch = metaContent.match(/tags:\s*\[([^\]]+)\]/)
            if (tagsMatch) {
              topics = tagsMatch[1].split(',').map(t => t.trim().replace(/"/g, ''))
            }
          }
        }
      } catch (e) {
        log(`[Context] Could not read work context: ${e}`)
      }

      // Create enriched summary for RAG
      let summaryParts = [
        `PAI Session Context Save (${new Date().toISOString()})`,
        `Session: ${workDir}`,
        `Context: ${currentContextPct}% (${Math.round(totalWithBaseline/1000)}k/${Math.round(maxContext/1000)}k tokens)`,
      ]

      if (objectives.length > 0) {
        summaryParts.push(`\nObjectives:\n${objectives.map(o => `- ${o}`).join('\n')}`)
      }

      if (topics.length > 0) {
        summaryParts.push(`\nTopics: ${topics.join(', ')}`)
      }

      summaryParts.push(`\nSession saved automatically when context exceeded ${CONTEXT_THRESHOLD_PCT}% threshold.`)

      const summary = summaryParts.join('\n')

      // Save to RAG with enriched metadata
      const proc = Bun.spawn(['bun', RAG_STORE_TOOL, '-c', 'pai_learning_system',
        '--content', summary,
        '--metadata', JSON.stringify({
          type: 'context_save',
          context_pct: currentContextPct,
          tokens: totalWithBaseline,
          date: new Date().toISOString(),
          auto_saved: true,
          session_id: sessionId,
          work_dir: workDir,
          objectives_count: objectives.length,
          topics: topics.join(', ')
        })
      ], { stdout: 'pipe', stderr: 'pipe' })

      await proc.exited

      contextSaveCount++
      lastContextSaveTime = new Date().toISOString()
      contextAlreadySavedThisSession = true

      log(`✅ Context saved to RAG (save #${contextSaveCount}) - session: ${workDir}, objectives: ${objectives.length}`)

      // Voice notification — 'system' događaj je po defaultu nijem (voice-policy.json)
      await requestVoice({
        agent: 'regoc',
        event: 'system',
        message: `Kontekst na ${currentContextPct} posto. Sesija spremljena u RAG.`,
      })
    }

    // Reset flag if context drops below threshold (new session likely)
    if (currentContextPct < 50) {
      contextAlreadySavedThisSession = false
    }

  } catch (error) {
    // Silent fail - context monitoring is optional
  }
}

// ============================================
// Database Operations
// ============================================

function getDb(): Database {
  const db = new Database(DB_PATH)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = 5000')
  return db
}

interface Message {
  id: string
  from_agent: string
  to_agent: string
  content: string
  message_type: string
  priority: number
  status: string
  voice_relay: boolean
  chat_id: number | null       // TASK-2612: Mumble kanal (kodiran) ili Telegram chat
  // Z2/TASK-3012: nosi lanac pokretanja (`taskId`/`parentTaskId`) — bez njega dijete
  // ne zna od koga nasljeđuje projekt. Dosad se stupac nije ni čitao.
  metadata: string | null
  created_at: string
}

function getPendingMessages(db: Database): Message[] {
  const stmt = db.prepare(`
    SELECT id, from_agent, to_agent, content, message_type, priority, status, voice_relay, chat_id, metadata, created_at
    FROM messages
    WHERE to_agent = 'regoc' AND status = 'pending'
    ORDER BY priority ASC, created_at ASC
    LIMIT 5
  `)
  return stmt.all() as Message[]
}

function claimMessage(db: Database, id: string): boolean {
  const stmt = db.prepare(`
    UPDATE messages
    SET status = 'processing', updated_at = datetime('now')
    WHERE id = ? AND status = 'pending'
  `)
  const result = stmt.run(id)
  return result.changes > 0
}

function completeMessage(db: Database, id: string): void {
  const stmt = db.prepare(`
    UPDATE messages
    SET status = 'completed', processed_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `)
  stmt.run(id)
}

/**
 * TASK-2612: porijeklo zahtjeva. Kad je zahtjev stigao GLASOM (Mumble kanal),
 * odgovor mora naslijediti chat_id + voice_relay, inače bi ga flushUserMessages
 * poslao na Telegram i korisnik u kanalu ne bi čuo ništa.
 *
 * U3/TASK-4263: isto vrijedi za zahtjev koji su otvorila ULAZNA VRATA iz telegramske
 * grupe. Bez naslijeđenog `chat_id` potvrda s brojem zadatka i kasniji izvještaj agenta
 * padnu na REGOC_GROUP_FALLBACK — dakle u REGOČ grupu, a ne onoj koja je pitala.
 * `voiceRelay` ostaje `false`: to je tekst na Telegramu, ne glas u Mumble kanalu.
 */
interface VoiceOrigin { chatId: number; voiceRelay: boolean }

function originOf(msg: { voice_relay?: unknown; chat_id?: unknown; metadata?: string | null }): VoiceOrigin | undefined {
  if (isMumbleVoiceMessage(msg)) return { chatId: msg.chat_id as number, voiceRelay: true }
  const ingest = procitajIngestMeta(msg.metadata)
  if (ingest && typeof msg.chat_id === 'number') return { chatId: msg.chat_id, voiceRelay: false }
  return undefined
}

function sendResponse(db: Database, toAgent: string, content: string, priority: number = 5,
                      origin?: VoiceOrigin): string {
  const id = crypto.randomUUID()
  const stmt = db.prepare(`
    INSERT INTO messages (id, from_agent, to_agent, content, message_type, priority, status, chat_id, voice_relay, created_at)
    VALUES (?, 'regoc', ?, ?, 'text', ?, 'pending', ?, ?, datetime('now'))
  `)
  stmt.run(id, toAgent, content, priority, origin?.chatId ?? null, origin?.voiceRelay ? 1 : 0)
  return id
}

// TASK-2561: SVIH 20 poziva bilo je tihi no-op — INSERT je gađao kolone (timestamp, event,
// agent) kojih u `event_log` nema (shema: event_type, agent_id, message_id, details,
// created_at), a prazan catch je gutao grešku. Audit trag R2/R3 reapa time nije postojao.
// Greška se sada barem jednom prijavi u log, da sljedeći raskorak sheme ne bude nevidljiv.
let _eventLogWarned = false
function logEvent(db: Database, event: string, agent: string, details: string): void {
  try {
    db.prepare(`INSERT INTO event_log (event_type, agent_id, details) VALUES (?, ?, ?)`)
      .run(event, agent, details)
  } catch (e) {
    if (!_eventLogWarned) { _eventLogWarned = true; log(`  ⚠️ [event_log] upis pao (${e}) — daljnji propusti se ne prijavljuju`) }
  }
}

// ============================================
// RAG Query
// ============================================

const RAG_TOOL = join(HOME, '.claude/skills/CORE/Tools/rag-query.ts')

async function queryRAG(query: string, limit: number = 3): Promise<string> {
  if (!ragUkljucen()) return '' // TASK-5273: čvor bez RAG-a — bez spawna i bez čekanja
  try {
    const proc = Bun.spawn(['bun', RAG_TOOL, '-c', 'pai_learning_system', '-q', query, '-n', String(limit)], {
      stdout: 'pipe',
      stderr: 'pipe'
    })
    const output = await new Response(proc.stdout).text()
    await proc.exited
    return output.trim()
  } catch (error) {
    log(`RAG query error: ${error}`)
    return ''
  }
}

// ============================================
// TaskManager API Integration
// ============================================

interface TaskCreateRequest {
  title: string
  description: string
  priority: number
  assignee?: string
  status?: string
  project_id?: string
  /** Izvor za strop stvaranja zadataka (TASK-4646). Bez njega zadatak pada u `user`. */
  createdBy?: string
  /** TASK-4761: `chat:<chatId>` ovdje daje `chatContextTail` odakle povući razgovor. */
  tags?: string[]
}

interface TaskCreateResponse {
  id: string
  title: string
  status: string
  priority: number
  assignee?: string
  tags?: string[]   // TASK-5029: applySpawnOutcome čuva postojeće oznake kad dodaje ceka-mjesto
}

async function createTaskInManager(task: TaskCreateRequest): Promise<TaskCreateResponse | null> {
  try {
    log(`Creating task in TaskManager: "${task.title}"`)
    const response = await fetch(TASK_MANAGER_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // TASK-4646: `createdBy` je IZVOR (tko je zadatak stvorio), ne izvršitelj — daemon
      // ostaje `regoc` i kad posao radi agent, jer strop mjeri pošiljatelja POST-a.
      body: JSON.stringify(withCreatedBy({
        title: task.title,
        description: task.description,
        priority: task.priority,
        assignee: task.assignee || 'regoc',
        status: task.status || 'pending',
        ...(task.project_id ? { project_id: task.project_id } : {}),
        ...(task.tags?.length ? { tags: task.tags } : {})
      }, task.createdBy || TASK_SOURCE.DAEMON))
    })

    if (!response.ok) {
      log(`TaskManager API error: ${response.status} ${response.statusText}`)
      return null
    }

    const result = await response.json() as TaskCreateResponse
    log(`Task created successfully: ${result.id}`)
    return result
  } catch (error) {
    log(`Failed to create task in TaskManager: ${error}`)
    return null
  }
}

/**
 * Auto-detect project_id from task title/description keywords.
 * Used when creating tasks during delegation to auto-assign project.
 */
function detectProjectId(text: string): string | undefined {
  const lower = text.toLowerCase()
  const rules: [RegExp, string][] = [
    [/ftsim|fast-track|fast_track|pcle|signal.?integrity|gerber2|impedanc|stackup/i, 'FAST-TRACK-SIM'],
    [/\bemc\b|sensorberg|tinysa|litevna|nf.?ff|lisn|siq.?chamber/i, 'REGOC_EMC'],
    [/cubes|ch32|intergalaktik.*edu/i, 'CUBES_2026'],
    [/minimax|woocommerce/i, 'MINIMAX'],
    [/gatemate|ksz9031|ksz.?903/i, 'GATEMATE_ETH'],
    [/ulx5m|ulx3s|litex|rgmii/i, 'ULX5M'],
    [/emc.?web|flask.?emc|emc.*app.*raspberry|emc.*pi/i, 'EMC_WEBAPP'],
    [/regoc|v4\.4|daemon|agent.*system|taskmanager|spawn.*agent|zod|vizualizac/i, 'REGOC_SYSTEM'],
    [/intergalaktik/i, 'INTERGALAKTIK'],
  ]
  for (const [pattern, projectId] of rules) {
    if (pattern.test(text)) return projectId
  }
  return undefined
}

/**
 * Z2/TASK-3012: dohvat roditeljskog zadatka za nasljeđivanje projekta.
 * Ide preko TaskManager API-ja (isti izvor istine kao i kreiranje), nikad izravno u bazu.
 */
async function fetchParentTask(taskId: string): Promise<ParentTaskInfo | null> {
  try {
    const res = await fetch(`${TASK_MANAGER_API}/${taskId}`)
    if (!res.ok) return null
    const t = await res.json() as any
    if (!t?.id) return null
    return { id: t.id, projectId: t.projectId ?? t.project_id ?? null, assignee: t.assignee ?? null }
  } catch {
    return null
  }
}

/**
 * Zapiši ODAKLE zadatku projekt (`project_source=…`) u progressNotes.
 *
 * Bez ovog zapisa se naslijeđeno ne razlikuje od ručno dodijeljenog, pa ciljani
 * popravak krivo naslijeđenih redaka (rollback) nije moguć. Upit za rollback:
 *   SELECT id FROM tasks WHERE progress_notes LIKE '%project_source=inherited:%'
 * Šalje se zajedno sa statusom da ne trošimo drugi PUT.
 */
async function applyProjectSource(taskId: string, decision: ProjectDecision, extra: Record<string, unknown> = {}): Promise<boolean> {
  try {
    const res = await fetch(`${TASK_MANAGER_API}/${taskId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...extra, progressNotes: [decision.note] })
    })
    if (!res.ok) {
      log(`⚠️ Zapis izvora projekta nije spremljen za ${taskId}: HTTP ${res.status}`)
      return false
    }
    return true
  } catch (e) {
    log(`⚠️ Zapis izvora projekta pao za ${taskId}: ${e}`)
    return false
  }
}

// Parse AI response for task creation requests
// Format: [CREATE_TASK] title="..." description="..." priority=1 assignee="..."
function parseTaskCreationRequest(aiResponse: string): CreateTaskInput | null {
  const taskMatch = aiResponse.match(
    /\[CREATE_TASK\]\s*title="([^"]+)"\s*description="([^"]+)"\s*priority=(\d+)(?:\s*assignee="([^"]+)")?/
  )

  if (!taskMatch) return null

  const rawTask = {
    title: taskMatch[1],
    description: taskMatch[2],
    priority: parseInt(taskMatch[3]),
    assignee: taskMatch[4]
  }

  // ZOD validation (TASK-160)
  const parseResult = CreateTaskInputSchema.safeParse(rawTask)

  if (!parseResult.success) {
    // Validation logging (TASK-161)
    log(`[Daemon] Task creation validation failed:`)
    parseResult.error.issues.forEach(issue => {
      log(`  - ${issue.path.join('.')}: ${issue.message}`)
    })
    log(`[Daemon] Raw input was: ${JSON.stringify(rawTask)}`)
    return null
  }

  log(`[Daemon] Task validation passed: "${parseResult.data.title}"`)
  return parseResult.data
}

// ============================================
// GEMINI.md Context (loaded once at startup)
// ============================================

let geminiContext: string = ''
// TASK-4794: putanja je bila tvrdo upisana na dom glavnog čvora (bez `HOME` rezerve), pa je
// na svakom čvoru s drugim HOME-om daemon dizao „GEMINI.md not found" i radio BEZ 23 pravila.
// Nađeno mjerenjem na node-B (HOME korisnika regoc) — normalizacija u isporuci gađa samo obrazac
// `process.env.HOME || '…'`, a ovo nije bila rezerva nego jedina putanja.
const GEMINI_PATH = join(HOME, 'app/regoc_system/GEMINI.md')
const AGENT_REGISTRY_PATH = join(HOME, '.claude/regoc/REGOC_AGENTS.json')

interface AgentInfo {
  id: string
  name: string
  role: string
  model: string
  communication_style: string
  required_knowledge?: string[]
}

interface AgentRegistry {
  agents: Record<string, AgentInfo>
}

let agentRegistry: AgentRegistry | null = null

function loadGeminiContext(): void {
  try {
    if (existsSync(GEMINI_PATH)) {
      geminiContext = readFileSync(GEMINI_PATH, 'utf-8')
      log(`📜 GEMINI.md loaded (${geminiContext.length} chars) - 23 rules active`)
    } else {
      log(`⚠️ GEMINI.md not found at ${GEMINI_PATH}`)
    }
  } catch (error) {
    log(`❌ Error loading GEMINI.md: ${error}`)
  }
}

function loadAgentRegistry(): void {
  try {
    if (existsSync(AGENT_REGISTRY_PATH)) {
      const content = readFileSync(AGENT_REGISTRY_PATH, 'utf-8')
      agentRegistry = JSON.parse(content)
      log(`📋 Agent registry loaded (${Object.keys(agentRegistry?.agents || {}).length} agents)`)
    }
  } catch (error) {
    log(`❌ Error loading agent registry: ${error}`)
  }
}

// ============================================
// Agent Routing - DELEGATION PATTERN
// ============================================

interface DelegationDecision {
  type: 'delegate' | 'self_respond' | 'system_query'
  agent?: string
  reason: string
  taskTitle?: string
  taskDescription?: string
  ragHints?: string[]
  /**
   * Gotov odgovor (TASK-2559): ako je postavljen, `system_query` grana ga šalje
   * doslovno umjesto poziva generateSystemResponse. Koristi TrivialResponder za
   * pozdrav/hvala/ok/ping — generateSystemResponse na njih vraća zbunjeni default.
   */
  templateResponse?: string
}

/**
 * REGOČ Delegation Logic
 *
 * KRITIČNO: REGOČ NE PUNI KONTEKST S PROJEKTIMA!
 * On samo:
 * 1. Klasificira zahtjev
 * 2. Odabire pravog agenta
 * 3. Delegira s kontekstom
 * 4. Odgovara samo na sistemske upite
 */
function classifyAndRoute(content: string, fromAgent: string): DelegationDecision {
  const lower = content.toLowerCase()

  // ============================================
  // 0. EKSPLICITNI [[AGENT:<id>]] OVERRIDE (deterministički routing)
  // ============================================
  // Marker na prvom retku poruke (npr. iz spec-upgrade dispatcha) zaobilazi
  // keyword-klasifikaciju i šalje izravno imenovanom agentu. Validira se protiv
  // REGOC_AGENTS.json (autoritet, uključuje emard — VALID_AGENTS ga nema).
  // Nepoznat id → fall-through na keyword-klasifikaciju (ne crashaj).
  // Capture grupa usklađena s REGOC_AGENTS.json id formatom (slovo+broj+_+-),
  // inače id-evi poput "agent_2"/"x-1" tiho fall-through-aju iako ih dispatch validacija prihvaća.
  const agentMatch = content.match(/^\s*\[\[AGENT:([a-z0-9_-]+)\]\]/i)
  if (agentMatch) {
    const targetId = agentMatch[1].toLowerCase()
    if (agentRegistry?.agents?.[targetId]) {
      return {
        type: 'delegate',
        agent: targetId,
        reason: 'Eksplicitni [[AGENT]] override',
        taskTitle: `Nadogradnja po spec: ${content.slice(0, 40)}...`,
        taskDescription: content
      }
    }
    // nepoznat id → padni na normalnu klasifikaciju ispod
  }

  // ============================================
  // 0b. EKSPLICITNO IMENOVAN AGENT (TASK-2637 / R3) — svi hrvatski padeži
  // ============================================
  // „daj Grgi da napravi vizual, Gita pomaže" → Grga (prije je keyword „vizual" slao Giti),
  // „Kosjenka, napravi plan", „zadaj Jeleni…", „neka Potjeh testira". Logika je u AgentRouting.ts
  // (jedan izvor istine, testirano: tests/agent-routing.test.ts). Sustavom generirani helper-opisi
  // se preskaču da helper-lanac ne bi sam sebe re-rutirao.
  if (!isHelperEcho(content)) {
    const explicit = resolveExplicitAgent(content)
    if (explicit && agentRegistry?.agents?.[explicit.agent]) {
      return {
        type: 'delegate',
        agent: explicit.agent,
        reason: `Eksplicitno imenovan agent („${explicit.form}", ${explicit.via})`,
        taskTitle: `${explicit.agent}: ${content.substring(0, 50)}...`,
        taskDescription: content,
        ragHints: ['pai_learning_system']
      }
    }
  }

  // ============================================
  // P1-lite / TASK-2559: ModeClassifier (E1–E5) — aditivno, iza flaga
  // ============================================
  // modeClassify=true → izračunaj tier iz postojećeg ModeClassifier.ts i LOGIRAJ
  //   (SHADOW); stari keyword-put i dalje donosi odluku (usporedba s '🎯 Decision' logom).
  // modeClassifyLive=true → E1 **I** TrivialResponder pogodak (pozdrav/hvala/ok/
  //   ping/status) dobiva template odgovor kroz 'system_query' BEZ spawna
  //   claude --print. Keyword-put ostaje fallback za sve ostalo.
  //
  // ZAŠTO DVOSTRUKI UVJET (E1 + trivial), a ne samo E1:
  //   shadow log 2026-07-21 je uhvatio „trebam vizual REGOČ-a" kao E1 (21 zn., bez
  //   glagola iz E2 liste) — sam E1 gate bi taj pravi zahtjev skrenuo s Gite na
  //   template. TrivialResponder je anchored whitelist i takve poruke odbija.
  if (isEnabled('modeClassify')) {
    try {
      const cls = getModeClassifier().classifyMessage(content)
      const live = isEnabled('modeClassifyLive')
      const trivial = cls.effort === 'E1' ? classifyTrivial(content) : null
      log(`  [modeClassify ${live ? 'LIVE' : 'SHADOW'}] effort=${cls.effort} mode=${cls.mode} trivial=${trivial ? trivial.kind : 'no'} agents=[${cls.suggestedAgents.join(',')}] est=${cls.estimatedMinutes}min :: "${content.replace(/\n/g, ' ').substring(0, 50)}"`)
      // TASK-2568 (F2/P2): SJENA lokalnog klasifikatora nad ISTIM prometom. Poziv je
      // fire-and-forget (`void`, bez `await`) — vraća deterministički odgovor odmah, a
      // Ollamu pita u pozadini i usporedbu piše u data/ollama_offload.jsonl. Odluku i
      // dalje donosi keyword-put iznad. Bez ovoga bi LocalOffload bio mrtav kod (kvar
      // od 2026-06-21: DispatchGuard.isRecycledAgentReport nije bio nigdje spojen).
      // Flag `ollamaClassifier=false` čini cijeli izraz no-opom.
      void classifyTierOffload(content).catch(() => {})

      if (live && trivial) {
        return {
          type: 'system_query',
          reason: `E1 trivijalno (${trivial.kind}) — template odgovor bez claude --print`,
          templateResponse: trivialResponse(trivial) ?? undefined
        }
      }
    } catch (e) {
      log(`  ⚠️ [modeClassify] greška, fallback na keyword: ${e}`)
    }
  }

  // ============================================
  // 1. SYSTEM QUERIES - REGOČ odgovara sam (kratko!)
  // ============================================

  // Status upiti
  if (lower.includes('status') && (lower.includes('daemon') || lower.includes('sustav') || lower.includes('sistem'))) {
    return {
      type: 'system_query',
      reason: 'Status upit o sustavu - REGOČ odgovara direktno'
    }
  }

  // Pitanja o agentima
  if (lower.includes('koji agent') || lower.includes('tko je') || lower.includes('lista agent')) {
    return {
      type: 'system_query',
      reason: 'Pitanje o agentima - REGOČ odgovara direktno'
    }
  }

  // Pravila sustava
  if (lower.includes('pravil') || lower.includes('23 pravila') || lower.includes('gemini')) {
    return {
      type: 'system_query',
      reason: 'Pitanje o pravilima - REGOČ odgovara direktno'
    }
  }

  // ============================================
  // 2. DELEGATION ROUTING - prema tipu zadatka
  // F7 (TASK-2550): Prošireni keyword matching za pouzdanije rutanje
  // Prije: 1845 AI inference failova padalo na slabe regexe → sve na Mandu
  // Sada: širi pokrov ključnih riječi po svakom agentu
  // ============================================

  // ARHITEKTURA → Kosjenka (provjeriti PRIJE implementacije — "kako" može biti i arch i impl)
  if (lower.includes('arhitektur') || lower.includes('dizajn sustav') || lower.includes('struktur') ||
      lower.includes('planiraj') || lower.includes('kako napraviti') || lower.includes('pristup') ||
      lower.includes('pregled') || lower.includes('review') || lower.includes('grill') ||
      lower.includes('adr') || lower.includes('spec') || lower.includes('nacrt') ||
      lower.includes('konceptualno') || lower.includes('strategij')) {
    return {
      type: 'delegate',
      agent: 'kosjenka',
      reason: 'Arhitekturni zadatak',
      taskTitle: `Arhitektura: ${content.substring(0, 50)}...`,
      taskDescription: content,
      ragHints: ['pai_learning_system']
    }
  }

  // IMPLEMENTACIJA → Jelena
  if (lower.includes('implement') || lower.includes('napravi') || lower.includes('kodiraj') ||
      lower.includes('typescript') || lower.includes('funkcij') || lower.includes('fix') ||
      lower.includes('popravi') || lower.includes('bug') || lower.includes('deploy') ||
      lower.includes('build') || lower.includes('skripta') || lower.includes('kod') ||
      lower.includes('refaktor') || lower.includes('migracij') || lower.includes('zakrp') ||
      lower.includes('integracija') || lower.includes('python') || lower.includes('bun ') ||
      lower.includes('kompajl') || lower.includes('kompilir')) {
    return {
      type: 'delegate',
      agent: 'jelena',
      reason: 'Implementacijski zadatak',
      taskTitle: `Implementacija: ${content.substring(0, 50)}...`,
      taskDescription: content,
      ragHints: ['pai_learning_system']
    }
  }

  // SIGURNOST → Malik
  if (lower.includes('sigurnost') || lower.includes('security') || lower.includes('ranjiv') ||
      lower.includes('audit') || lower.includes('pentest') || lower.includes('credential') ||
      lower.includes('penetration') || lower.includes('vulnerability') || lower.includes('cve') ||
      lower.includes('exploit') || lower.includes('hardening') || lower.includes('enkripcij') ||
      lower.includes('certifikat') || lower.includes('firewall')) {
    return {
      type: 'delegate',
      agent: 'malik',
      reason: 'Sigurnosni zadatak',
      taskTitle: `Security: ${content.substring(0, 50)}...`,
      taskDescription: content,
      ragHints: ['pai_learning_system']
    }
  }

  // TESTIRANJE → Potjeh
  if (lower.includes('testiraj') || lower.includes('test ') || lower.includes('verificiraj') || lower.includes('provjeri radi') ||
      lower.includes('qa') || lower.includes('validacija') || lower.includes('verifikacija') ||
      lower.includes('provjeri') || lower.includes('regresij') || lower.includes('e2e') ||
      lower.includes('smoke test') || lower.includes('unit test')) {
    return {
      type: 'delegate',
      agent: 'potjeh',
      reason: 'QA/Testing zadatak',
      taskTitle: `Test: ${content.substring(0, 50)}...`,
      taskDescription: content,
      ragHints: []
    }
  }

  // FPGA → Emard (spawn-on-demand, ne persistent — ali routing treba raditi)
  if (lower.includes('fpga') || lower.includes('verilog') || lower.includes('ulx3s') ||
      lower.includes('ulx5m') || lower.includes('hdl') || lower.includes('synthesis') ||
      lower.includes('gatemate') || lower.includes('serdes') || lower.includes('ulx4m') ||
      lower.includes('yosys') || lower.includes('nextpnr') || lower.includes('bitstream')) {
    return {
      type: 'delegate',
      agent: 'emard',
      reason: 'FPGA zadatak',
      taskTitle: `FPGA: ${content.substring(0, 50)}...`,
      taskDescription: content,
      ragHints: ['agent_emard']
    }
  }

  // ANALIZA → Dora
  if (lower.includes('analiz') || lower.includes('perspektiv') || lower.includes('usporedi') ||
      lower.includes('procijeni') || lower.includes('multiple') || lower.includes('compare') ||
      lower.includes('trade-off') || lower.includes('tradeoff') || lower.includes('evaluiraj') ||
      lower.includes('pros and cons') || lower.includes('prednosti i nedosta')) {
    return {
      type: 'delegate',
      agent: 'dora',
      reason: 'Analitički zadatak',
      taskTitle: `Analiza: ${content.substring(0, 50)}...`,
      taskDescription: content,
      ragHints: ['pai_learning_system']
    }
  }

  // ISTRAŽIVANJE → Manda (NAKON specifičnijih agenata, da ne gutaš sve)
  if (lower.includes('istraži') || lower.includes('research') || lower.includes('pronađi') ||
      lower.includes('dokumentiraj') || lower.includes('analiziraj rag') || lower.includes('pretraži') ||
      lower.includes('patent') || lower.includes('literatura') || lower.includes('izvor') ||
      lower.includes('deep research') || lower.includes('due diligence') || lower.includes('saznaj')) {
    return {
      type: 'delegate',
      agent: 'manda',
      reason: 'Istraživački zadatak',
      taskTitle: `Istraživanje: ${content.substring(0, 50)}...`,
      taskDescription: content,
      ragHints: ['pai_learning_system', 'pai_sessions']
    }
  }

  // VIZUALNO → Gita
  if (lower.includes('vizual') || lower.includes('dijagram') || lower.includes('slika') ||
      lower.includes('excalidraw') || lower.includes('grafik') || lower.includes('art') ||
      lower.includes('ilustracij') || lower.includes('ikona') || lower.includes('logo')) {
    return {
      type: 'delegate',
      agent: 'gita',
      reason: 'Vizualni zadatak',
      taskTitle: `Art: ${content.substring(0, 50)}...`,
      taskDescription: content,
      ragHints: []
    }
  }

  // UI/FRONTEND → Grga
  if (lower.includes('ui') || lower.includes('frontend') || lower.includes('dizajn') ||
      lower.includes('css') || lower.includes('responsive') || lower.includes('komponenta') ||
      lower.includes('webapp') || lower.includes('web app') || lower.includes('dashboard') ||
      lower.includes('layout') || lower.includes('tailwind') || lower.includes('react')) {
    return {
      type: 'delegate',
      agent: 'grga',
      reason: 'Frontend/Design zadatak',
      taskTitle: `Design: ${content.substring(0, 50)}...`,
      taskDescription: content,
      ragHints: []
    }
  }

  // ============================================
  // 3. DEFAULT - Manda za općenita pitanja
  // F7: Manda je catch-all TEK kad ništa ne matcha
  // ============================================

  return {
    type: 'delegate',
    agent: 'manda',
    reason: 'Općeniti zahtjev - nijedan keyword nije matchao specifičnog agenta',
    taskTitle: `Zahtjev: ${content.substring(0, 50)}...`,
    taskDescription: content,
    ragHints: ['pai_learning_system']
  }
}

/**
 * Generate system response (no AI needed - just use GEMINI context)
 */
function generateSystemResponse(content: string): string {
  const lower = content.toLowerCase()

  // Status daemon
  if (lower.includes('daemon') || lower.includes('status')) {
    const uptime = Math.floor((Date.now() - daemonStartTime) / 1000)
    const hours = Math.floor(uptime / 3600)
    const mins = Math.floor((uptime % 3600) / 60)
    return `🤖 **REGOČ Daemon Status**

✅ Daemon aktivan (PID: ${process.pid})
⏱️ Uptime: ${hours}h ${mins}m
📊 Obrađeno poruka: ${processedCount}
📜 GEMINI.md: ${geminiContext.length > 0 ? 'Učitan (23 pravila)' : 'NIJE učitan!'}
📋 Agent Registry: ${agentRegistry ? Object.keys(agentRegistry.agents).length + ' agenata' : 'NIJE učitan!'}

Kontekst: ${currentContextPct}%
Zadnja aktivnost: ${lastActivityDesc || 'Nema'}`
  }

  // Lista agenata
  if (lower.includes('agent') || lower.includes('tko je')) {
    if (!agentRegistry) return '❌ Agent registry nije učitan!'

    const agentList = Object.values(agentRegistry.agents)
      .filter(a => a.id !== 'regoc')
      .map(a => `• **${a.name}** (${a.role}) - ${a.model}`)
      .join('\n')

    return `🤖 **REGOČ Agenti**

${agentList}

Za delegaciju koristim routing tablicu baziranu na tipu zadatka.`
  }

  // Pravila
  if (lower.includes('pravil') || lower.includes('23')) {
    return `📜 **REGOČ Pravila**

GEMINI.md sadrži 23 kritična pravila:
• CORE PRAVILA (1-10): Write permissions, RAG-first, agenti, puni identitet pri spawnu (IdentityBlock.ts)...
• SO PROTOKOLI (11-16): Checkpoint, progress notes, /tmp prohibition...
• DODATNA PRAVILA (17-23): MonitorModeLoop, delegation, testing...

Puni tekst: ${GEMINI_PATH}`
  }

  return `📋 Sistemski upit primljen. Nisam siguran što točno tražiš.
Dostupne opcije:
• "status daemon" - status sustava
• "lista agenata" - svi REGOČ agenti
• "pravila" - 23 kritična pravila`
}

// ─── P3/TASK-3636: IZVOR tiera za recept (ADR-0003) ──────────────────────────
// Nalaz ADR-0003 (mjereno u TASK-3600): tier se dizao na REGOČ-ovom VLASTITOM
// boilerplateu u `description`-u, ne na poslu. `E4/E5` udio: samo naslov 1,5 % →
// naslov+opis 35,1 % (×23,4), uz E5 preciznost 0,0 % (22 lažna pozitivna, 0 stvarnih)
// i točnost tiera 30,0 % naspram osnovice „uvijek E1" 58,0 %. Posljedica: već
// razloženi listovi (npr. TASK-3634 · s3) dobivali su nalog da se dalje razlažu.
//
// Tri mjere, sve u `resolveRecipeTier()`:
//   1. RUČNI OVERRIDE — oznaka `tier:E1..E5` u tekstu pobjeđuje nad klasifikacijom
//      (dosad je postojala SAMO u AgentDaemonu, a promašaj je najveći baš ovdje).
//   2. KLASIFICIRAJ POSAO — klasificira se naslov + KORISNIČKI dio opisa; REGOČ-ovi
//      vlastiti odsjeci (ULAZI/IZLAZI/OPSEG/RECEPT/KONTEKST-PAKET/IZVORNI ZAHTJEV/
//      PRIHVATNI KRITERIJI/PROJEKT ZADATKA…) odsijecaju se PRIJE klasifikacije.
//   3. SUŽENA DOZA — IZVEDENI E4/E5 NE dobiva dekompozicijski recept („rastavi na
//      3–7 podzadataka"), jer ta grana nema pokriće u golden-setu; spušta se na E3
//      (isti verifikacijski blok, ali BEZ mijenjanja opsega posla). Dekompozicijski
//      recept ostaje dostupan samo uz IZRIČITU oznaku `tier:E4`/`tier:E5`.

/**
 * Naslovi odsjeka koje REGOČ SAM upisuje u `description` zadatka (TaskDecomposer
 * `buildSubtaskDescription`, `buildAcceptanceChecklist`, `PromptProjectBlock`,
 * protokolarni blokovi prompta). Usporedba je po PREFIKSU normaliziranog naslova
 * jer generatori dodaju pojašnjenja: „OPSEG — DRŽI SE GA", „RECEPT (haiku)",
 * „ULAZI (ovo pročitaj PRIJE nego počneš)".
 */
const REGOC_BOILERPLATE_HEADINGS = [
  'ULAZI', 'IZLAZI', 'PROVJERA', 'OPSEG', 'RECEPT', 'KONTEKST-PAKET',
  'IZVORNI ZAHTJEV', 'PRIHVATNI KRITERIJI', 'PROJEKT ZADATKA', 'KRITERIJ',
  'TASKMANAGER PROTOCOL', 'HEARTBEAT WATCHDOG', 'VERIFICATION GATE',
  'ZAVRSNI STATUS', 'OBVEZAN ZADNJI REDAK', 'POTREBNO ZNANJE', 'PRAVILA',
  'VODENJE', 'RAG KOLEKCIJE', 'SYSTEM MODE',
] as const

/** Diakritika van, velika slova, višestruki razmaci u jedan — za usporedbu naslova. */
function normalizeHeading(raw: string): string {
  return raw
    .replace(/[čć]/gi, 'c').replace(/š/gi, 's').replace(/ž/gi, 'z').replace(/đ/gi, 'd')
    .toUpperCase()
    .replace(/^#+\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Odsijeca REGOČ-ove vlastite blokove iz teksta zadatka i vraća SAMO korisnički dio.
 *
 * Ugovor:
 *  - tekst BEZ markdown-naslova vraća se nepromijenjen (obična korisnička poruka),
 *  - REZANJE JE REPOM: sve od PRVOG REGOČ-ovog naslova do kraja teksta. Generatori
 *    (TaskDecomposer, buildAcceptanceChecklist, PromptProjectBlock) uvijek pišu SVOJE
 *    blokove IZA korisničkog dijela (`## TVOJ DIO`, `## ŠTO`…), pa je rep točan rez.
 *    Rezanje odsjek-po-odsjek NE radi: `## KONTEKST-PAKET` u sebi nosi RAG izvatke s
 *    VLASTITIM markdown naslovima („# Patentni krajolik…"), pa bi prvi takav naslov
 *    ponovno uključio zadržavanje i pola konteksta bi ostalo u klasifikaciji
 *    (izmjereno na TASK-3633/3634: tier se tada NE spusti),
 *  - `── RECEPT (tier X) ──` (recept koji je REGOČ sam ubacio u prethodni prompt, pa
 *    se vratio kroz agentov izvještaj) reže tekst do kraja — povratna sprega iz ADR-a,
 *  - ako od teksta nakon rezanja ne ostane NIŠTA, vraća se izvorni tekst (fail-safe:
 *    radije klasificiraj previše nego ništa).
 */
function stripRegocBoilerplate(content: string): string {
  if (!content) return ''
  // Recept koji se vratio kroz izvještaj — sve od njega nadalje nije korisnikov posao.
  const recipeMarker = content.search(/^\s*──\s*RECEPT \(tier E[1-5]\)/m)
  const body = recipeMarker >= 0 ? content.slice(0, recipeMarker) : content

  const lines = body.split('\n')
  const kept: string[] = []
  for (const line of lines) {
    const m = line.match(/^#{1,4}\s+(.+)$/)
    if (m) {
      const h = normalizeHeading(m[1])
      if (REGOC_BOILERPLATE_HEADINGS.some(k => h.startsWith(k))) break
    }
    kept.push(line)
  }
  const out = kept.join('\n').trim()
  return out.length > 0 ? out : content.trim()
}

/** `tier:E3` bilo gdje u tekstu = ručni override; vraća `null` ako oznake nema. */
function explicitTierTag(content: string): EffortTier | null {
  const m = content.match(/(?:^|[\s\[(,;"'*-])tier:(E[1-5])(?![0-9A-Za-z])/i)
  return m ? (m[1].toUpperCase() as EffortTier) : null
}

/**
 * Tier iz kojeg se bira recept za `buildAgentPrompt()`.
 *
 * Vraća `null` kad recept NE treba ubaciti (prazan/neupotrebljiv tekst) — isti ugovor
 * kao `AgentDaemon.resolveEffortTier()`: nema teksta ⇒ tier je nepoznat ⇒ bez recepta
 * (E1 recept bi agentu rekao „odgovori izravno, bez izvođenja akcija").
 */
function resolveRecipeTier(content: string): EffortTier | null {
  const explicit = explicitTierTag(content || '')
  if (explicit) return explicit
  const work = stripRegocBoilerplate(content || '')
  if (!work.trim()) return null
  const derived = getModeClassifier().classifyMessage(work).effort
  // Suzena doza: IZVEDENI E4/E5 ne nosi dekompozicijski nalog (ADR-0003, odluka 2).
  if (derived === 'E4' || derived === 'E5') return 'E3'
  // Donji prag: zadatak koji je PROŠAO kroz REGOČ-ov generator (imao je njegove odsjeke)
  // nikad nije pozdrav/status, pa ne smije dobiti E1 recept („odgovori izravno, BEZ
  // izvođenja akcija") samo zato što je nakon rezanja ostao kratak. Isti rizik koji
  // `AgentDaemon.resolveEffortTier()` pokriva `null`-om za prazan tekst.
  const wasStructured = work !== (content || '').trim()
  if (derived === 'E1' && wasStructured) return 'E2'
  return derived
}

/**
 * Build agent prompt with full context (personality, knowledge, task)
 */
// Z3/TASK-3013: `projectTail` je JEDINA konkretna vrijednost projekta u promptu i ide NA KRAJ
// (v. PromptProjectBlock.ts). Predaje se gotov string jer je ova funkcija sinkrona, a ime projekta
// se dohvaća preko HTTP-a — pozivatelj ga složi s `buildProjectTail(projectId)`.
/**
 * TASK-5414: TMPDIR spawna (<korijen>/zadaci/TASK-<n>_<ime>/tmp) — JEDAN izračun za prompt i okolinu,
 * pa agent u uputi čita točno onu mapu koju mu daemon stvara (QA TASK-5409 N1: gola TASK-<n>).
 */
function radnaMapaSpawna(taskId: string | null, agentId: string): string {
  let naslov = ''
  if (taskId) try {
    const db = new Database(TASKS_DB_PATH, { readonly: true })
    try { naslov = ((db.query('SELECT title FROM tasks WHERE id = ?').get(taskId) as { title?: string } | null)?.title) || '' } finally { db.close() }
  } catch { /* bez naslova → TASK-<n> (fail-open) */ }
  return tmpMapaSpawna(taskId, agentId, undefined, naslov)
}

function buildAgentPrompt(agentId: string, originalContent: string, fromAgent: string, reason: string, ragHints: string[], taskId?: string | null, projectTail: string = ''): string {
  const agent = agentRegistry?.agents[agentId]
  if (!agent) {
    return `Obradi ovaj zadatak:\n\n${originalContent}`
  }

  // P3/TASK-2569 s4: recept po tieru (skela za slabe modele) — SAMO kad je
  // `tierRecipesEnabled=true` (features.json, hot-reload). Flag OFF → recipeSection
  // ostaje '' → prompt je bajt-identičan starome putu (stari put = fallback). Nepoznat/
  // nedostupan tier ne ruši prompt — samo ne dodaje ništa (getRecipe('') za nepoznat tier).
  // TASK-3636 (ADR-0003): tier VIŠE ne dolazi iz sirovog `classifyMessage(originalContent)` —
  // v. `resolveRecipeTier()` iznad (tier:EX override → odsijecanje REGOČ-ovog boilerplatea →
  // izvedeni E4/E5 spušten na E3). `null` = tier nepoznat ⇒ bez recepta.
  let recipeSection = ''
  if (isEnabled('tierRecipesEnabled')) {
    try {
      const tier = resolveRecipeTier(originalContent)
      const recipe = tier ? getRecipe(tier) : ''
      if (tier && recipe) {
        recipeSection = `\n\n── RECEPT (tier ${tier}) ──\n${recipe}\n`
      }
    } catch { /* fail-safe: bez recepta, prompt ide dalje kao stari put */ }
  }

  // Build knowledge loading instructions
  let knowledgeInstructions = ''
  if (agent.required_knowledge && agent.required_knowledge.length > 0) {
    const knowledgePaths = agent.required_knowledge.map(k => {
      if (k.startsWith('skills/')) return join(HOME, '.claude', k)
      if (k.startsWith('regoc_system/')) return join(HOME, 'app', k)
      if (k.startsWith('HDL-GuideLines/')) return join(HOME, 'fpga-AI-projects/ulx3s', k)
      return k
    })
    knowledgeInstructions = `\n## Potrebno znanje\nUčitaj ove fajlove prije rada:\n${knowledgePaths.map(k => `- ${k}`).join('\n')}\n`
  }

  // I6/TASK-3655: VLASTITA RAG KOLEKCIJA. `rag_collections` iz registra (12 agenata →
  // `agent_<ime>`) bila je mrtva mapa: `ragHints` su tvrdo upisani po pravilu usmjeravanja
  // i gotovo uvijek glase `pai_learning_system` (jedina iznimka: `agent_emard`, doslovno
  // upisan niže u odlukama). U `ragHints` (ČITANJE) ulazi samo kolekcija koja stvarno
  // postoji u ChromaDB-u; uputa za UPIS ide uvijek (R1c/TASK-4602 — v. niže).
  // `spawn_template.required_in_prompt[4]` traži oba smjera, a kod ih nije slao.
  // Iza istog flaga kao I2 (`agentIdentityBlock` = izračun/log, `…Live` = stvarno šalje).
  let ownCollection: string | null = null
  let memorySection = ''
  if (isEnabled('agentIdentityBlock') && ragUkljucen()) {
    try {
      // R1c/TASK-4602: DVA razlicita pitanja, dva razlicita vratara.
      //   ČITANJE  — `ownRagCollection`: ima li se STO citati? Kolekcija mora postojati,
      //              inace je hint u `ragHints` prazan poziv (queryMemory vraca []).
      //   UPIS     — `registryRagCollection`: kako se kolekcija ZOVE? Postojanje NIJE uvjet,
      //              jer `storeMemory()` ju stvara (`getOrCreateCollection`) — upis je upravo
      //              ono sto kolekciju dovodi u postojanje. Stari uvjet je bio kokos-jaje:
      //              8 od 12 agenata (04.09.2026.) nikad nije dobilo uputu za upis, pa ju
      //              nikad nije ni stvorilo. v. ADR-0005, dopuna R1c.
      const zaCitanje = ownRagCollection(agentId, agentRegistry, knownCollections())
      const zaUpis = registryRagCollection(agentId, agentRegistry)
      if (zaUpis && isEnabled('agentIdentityBlockLive')) {
        ownCollection = zaCitanje
        // R1b/TASK-4431: primjer upisa mora nositi KONKRETAN projekt i zadatak (-p/--task),
        // inače agent prvi upis potroši na grešku vratara sheme (R1/TASK-4308).
        memorySection = ownMemorySection(agentId, zaUpis, {
          projectId: readTaskContext(taskId ?? null).projectId,
          taskId: taskId ?? null,
          collectionExists: zaCitanje !== null,
        })
        if (!zaCitanje) log(`🌱 [RAG memorija] ${agentId}: kolekcija ${zaUpis} jos ne postoji — salje se uputa za PRVI upis (stvara ju storeMemory)`)
      } else if (zaUpis) {
        log(`👁️ [RAG memorija SHADOW] ${agentId}: kolekcija ${zaUpis} (postoji=${zaCitanje !== null}), NE šalje se (agentIdentityBlockLive=false)`)
      }
    } catch (e) { log(`⚠️ [RAG memorija] ${agentId}: kolekcija nije razriješena (${e}) — prompt ide bez nje`) }
  }
  // TASK-5159 R2: pitanje o samom sustavu → `regoc_popis` prije `pai_learning_system`.
  let popisOk = false
  try { popisOk = popisDostupan() } catch { popisOk = false }
  const effectiveHints = withSystemCollection(withOwnCollection(ragHints, ownCollection), originalContent, popisOk)

  let ragSection = ''
  if (effectiveHints.length > 0 && ragUkljucen()) {
    ragSection = `\n## RAG kolekcije za pretragu\n${effectiveHints.map(h => `- bun ~/.claude/skills/CORE/Tools/rag-query.ts -c ${h} -q "[relevantna tema]" -n 5`).join('\n')}\n`
  }
  ragSection += memorySection

  // TaskManager protocol section (only if task ID assigned)
  let taskManagerSection = ''
  if (taskId) {
    const heartbeatFile = join(HOME, `.tmp/agent_heartbeat_${agentId}.json`)
    taskManagerSection = `
## TASKMANAGER PROTOCOL (OBAVEZNO)
Tvoj task ID: **${taskId}**

Pri početku rada — NE TREBA NIŠTA: sustav je zadatak stavio u \`in_progress\` kad te pokrenuo.

Svaka 5 min ili značajan napredak (JEDINI PUT koji smiješ zvati):
  curl -s -X PUT http://localhost:17781/api/tasks/${taskId} -H 'Content-Type: application/json' -d '{"progressNotes":["Opis napretka..."]}'

## STATUS ZADATKA NE POSTAVLJAŠ TI
NE zovi PUT sa \`status\` (completed, blocked, cancelled). Takav poziv sustav odbija.
Status zatvara REGOČ nakon što nezavisni kritičar pokrene tvoje provjere nad onim što si
ostavio na disku. Tvoja presuda ide TEKSTOM, zadnjim retkom odgovora:
  REGOC-STATUS: DONE — <što je isporučeno>
  REGOC-STATUS: BLOCKED — <koji alat/pristup ti nedostaje>
  REGOC-STATUS: NEEDS_CONTEXT — <koji opis/kontekst nedostaje>
Taj redak je tvoj JEDINI kanal za ishod i sustav ga čita doslovno.
\`DONE\` bez dokaza izvršenja (naredba, datoteka, mjerenje, HTTP/exit status, commit) kritičar
obara — zadatak tada ide u \`blocked\`, ne u ✅. Deklariraj pošteno: nedovršen posao prijavljen
kao BLOCKED je uredan ishod, lažni DONE je kvar.

POZADINSKI POSAO (trening, lab, STT… koji radi dulje od tvog spawna): pokreni ga odvojeno
(setsid nohup … &), pa u retku IZNAD \`REGOC-STATUS: BLOCKED — …\` napiši
  REGOC-POZADINA: pid=<PID>[,<PID>] [gotovo=<datoteka>:<tekst>] [rok=<sati>]
Sustav tada prati PID-ove (i uvjet gotovosti) i SAM vraća zadatak u obradu kad posao završi,
padne ili istekne rok (zadano 48 h) — ne treba ručni čekač ni Goran. Navedi PID stvarnog
posla (ne ljuske koja odmah izlazi); \`gotovo=\` je pouzdaniji kad posao piše oznaku kraja.

NAZIVI POLJA: kanonski su camelCase (resultSummary, progressNotes, blockedReason); snake_case
(result_summary…) se i dalje prihvaća. Izmišljeno/pogrešno ime polja API sada ODBIJA s HTTP 400 —
ako dobiješ 400 "Unknown field", pročitaj popis dopuštenih polja iz odgovora i pošalji ponovo.
Provjeri da je spremljeno: GET .../api/tasks/${taskId} mora vratiti tvoj tekst (TASK-2976).

${projectProtocolInstruction(TASK_MANAGER_API)}

## ZAVRŠNI STATUS — TVRDO PRAVILO (bez iznimke)
\`DONE\` znači IZVRŠENO I PROVJERENO. Ako posao NIJE napravljen, NE deklariraj DONE —
lažni ✅ na ploči je gora šteta od vidljivo nezavršenog zadatka.

- Fali opis / kontekst / specifikacija zadatka:
  REGOC-STATUS: NEEDS_CONTEXT — <što točno nedostaje>
- Nemaš alat / pristup / ovlasti da bi ga izvršio:
  REGOC-STATUS: BLOCKED — <što ti nedostaje>

Nikada ne deklariraj DONE uz rezultat tipa "Zadatak je gotov.", "Gotovo." ili uz rečenicu
u kojoj priznaješ da nešto nisi mogao napraviti — vratar to obara i zadatak ide u \`blocked\`.
Tvoj izvještaj MORA sadržavati dokaz izvršenja: pokrenutu naredbu, dirnutu datoteku, izmjereni
broj (npr. "24 pass, 0 fail"), HTTP/exit status ili commit.

## PITANJE ZA ODLUKU — kad smiješ stati i pitati (RIJETKO)
Zaustavljanje uz pitanje ima TOČNO JEDAN povod: stvarna dilema između dva ili više puteva
(A/B, A/B/C, A/B/C/D) koje ne možeš razriješiti sam, a izbor mijenja ishod zadatka.
NIJE pitanje: nedostaje ti alat, pristup ili opis — to je \`BLOCKED\` odnosno \`NEEDS_CONTEXT\`.
NIJE pitanje ni ono što možeš izmjeriti, pročitati u kodu ili isprobati — izmjeri pa nastavi.
Najviše JEDNO pitanje po zadatku. Ako ti se čini da ih treba više, zadatak je prevelik: razloži ga.

Pitanje se postavlja SAMO ovim pozivom (dopisuje blok u opis, stavlja oznaku needs-decision i
zaustavlja zadatak jednim potezom):
  curl -s -X POST http://localhost:17781/api/tasks/${taskId}/pitanje -H 'Content-Type: application/json' -d '{
    "ekspert": "<koja struka zna odgovoriti, npr. sigurnost mrežnih usluga>",
    "pitanje": "Objasni mi sa svog stručnog stajališta <predmet> i pomozi mi da donesem odluku o <odluci>.",
    "opcije": ["<prva mogućnost> — <posljedica>", "<druga mogućnost> — <posljedica>"],
    "preporuka": "B — <zašto>"}'
API ODBIJA (HTTP 400) pitanje bez struke ili s manje od dvije opcije — bez opcija to nije
dilema nego posao koji treba obaviti. Struka je obavezna jer po njoj odgovarač (čovjek ili
model) zna u kojoj ulozi odgovara.

## OBVEZAN ZADNJI REDAK ODGOVORA
Zadnji redak tvog odgovora MORA biti strojno čitljiva deklaracija ishoda:
  REGOC-STATUS: DONE — <što je isporučeno>
  REGOC-STATUS: BLOCKED — <koji alat/pristup ti nedostaje>
  REGOC-STATUS: NEEDS_CONTEXT — <koji opis/kontekst nedostaje>
Daemon čita točno taj redak. Bez njega tvoj rad pada u "no-evidence" i zadatak se NE zatvara.
Deklariraj pošteno: DONE samo ako je posao stvarno napravljen i provjeren.

## HEARTBEAT WATCHDOG (OBAVEZNO svakih 60 min)
Svakih sat vremena MORAŠ javiti sustavu da si živ i dati kratki briefing:
  echo '{"agent":"${agentId}","task":"${taskId}","ts":"'$(date -Iseconds)'","status":"working","brief":"<kratki opis do kuda si dosao, max 100 znakova>"}' > ${heartbeatFile}
Ako se ne javiš 2 sata, sustav će te prekinuti. Ovo je tvoj watchdog kanal.

## VERIFICATION GATE — korak RUN uključuje DEPLOY (popravak na disku ≠ popravak u pogonu)
IDENTIFY → RUN → READ → VERIFY → CLAIM. Ako si dirao kod koji vrti DUGOTRAJAN PROCES
(daemon, server, worker), popravak NIJE gotov dok taj proces nije restartan i provjeren.
bun/node NE učitavaju kod ponovno — spremljena datoteka mijenja SAMO disk.

1. Provjeri vrti li se tvoj kod:
   bun ~/.claude/regoc/StaleCodeCheck.ts --entry <fajl.ts> --pid <pid procesa>
   (exit 3 + „STALE CODE" = proces vrti staru verziju; ~/.claude/regoc/regoc-services.sh status
   ispisuje isti alarm za RegocDaemon i cijeli tim)
2. Restart: RegocDaemon, ploču (TaskWebUI) i Klaudija NIKAD ne restartaj iz vlastitog spawna
   (TASK-5140) — novi daemon tvoj proces ne vidi i zadatak ostane in_progress bez ikoga.
   regoc-services.sh/manage.sh to odbijaju (izlaz 4). Umjesto toga zakaži odgođeni restart:
     setsid nohup bash ~/.claude/regoc/tools/servisi/restart_kad_mirno.sh ${taskId} >/dev/null 2>&1 &
   Izvede se kad nema zadataka in_progress, provjeri StaleCodeCheck i sam zatvori zadatak.
   Ostale procese (poslužitelj projekta, agent tima) restartaj normalno pa ponovi provjeru.
3. Ponovi provjeru i tek onda tvrdi DONE.
4. U svom izvještaju navedi NOVI PID i vrijeme restarta — sustav ga zapisuje u zadatak.

Bez toga je \`DONE\` lažan. Dokaz (28.07.): TASK-2953 zatvoren kao DONE u 10:47 uz vlastitu
napomenu „nije još deployan"; proces je bio od 10:40, pa su u 11:03 TASK-2974 i TASK-2983
zatvoreni kao COMPLETED s porukom hook-blokade u rezultatu — točno onaj kvar koji je taj
popravak trebao spriječiti. Ako ne smiješ/ne možeš restartati (daemon/ploča/Klaudio uvijek),
zakaži restart_kad_mirno.sh i deklariraj REGOC-STATUS: BLOCKED — čeka restart <servis>, NE DONE.
`
  }

  // TASK-623: System mode section
  const mode = getSystemMode()
  let modeSection = `\n## SYSTEM MODE: ${mode}\n`
  if (mode === 'PLAN') {
    modeSection += `**PLAN MOD JE AKTIVAN. STROGU ZABRANU POSTUJ:**\n\n`
    modeSection += `NE SMIJES:\n`
    modeSection += `- Pisati/mijenjati/kreirati fajlove (Edit, Write, Bash write operacije)\n`
    modeSection += `- Deployati, restartati, pokretati servise\n`
    modeSection += `- Slati poruke van sustava (Telegram, email, Git push)\n`
    modeSection += `- Pokretati komande koje mijenjaju stanje sustava\n`
    modeSection += `- Kreirati git commitove ili pushati\n\n`
    modeSection += `SMIJES:\n`
    modeSection += `- Citati fajlove (Read, Bash cat/head/less)\n`
    modeSection += `- Pretrazivati (grep, find, RAG query)\n`
    modeSection += `- Analizirati i planirati\n`
    modeSection += `- Davati preporuke i prijedloge\n\n`
    modeSection += `Tvoj output mora biti PLAN (sto bi napravio), NE implementacija.\n`
  } else {
    modeSection += `Normalan rad. Izvrsi zadatak do kraja.\n`
  }

  // Potjeh QA-sparring: agenti S ALATIMA mogu zovnuti Potjeha (lokalni QA model) kad
  // zapnu / trebaju širu sliku. Preskoči za samog Potjeha (nema self-consult) i Gitu
  // (text-only, nema Bash da pokrene alat).
  const potjehConsult = (agentId === 'potjeh' || agentId === 'gita') ? '' :
`5. Ako ZAPNEŠ ili trebaš ŠIRU SLIKU / korisničku perspektivu (bug koji ne reproduciraš, dvojba u dizajnu), prije nego odustaneš pitaj Potjeha (lokalni QA sparring):
   bun ~/.claude/regoc/tools/consult-potjeh.ts "[sažmi problem + relevantni kontekst]"
   Pročitaj njegov uvid (rangirane hipoteze, korisnička perspektiva) i nastavi SVOJIM alatima. Ako ne odgovori u 5 min, nastavi bez njega — miss se automatski signalizira.
`

  // Ne-Claude modeli (Ollama/Gemini/Kimi/OpenRouter): LAKSI, direktan prompt. Tezak Claude-prompt
  // (RAG-upute, TaskManager curl-protokol, heartbeat, consult, RAG pre-injekcija) ih preoptereti pa
  // vrate PRAZAN izlaz bez deliverabla (dokazano: TASK-064/065). Lakim promptom qwen3:8b stvarno napravi datoteku.
  // Excalidraw: slabi modeli griješe u strukturi JSON-a (izostave „},{") → uputi ih na deterministički
  // alat make_diagram (kod gradi valjanu strukturu, model daje samo čvorove i veze).
  const _excaHint = /excalidraw/i.test(originalContent) ? `
## EXCALIDRAW — koristi alat make_diagram (NE piši JSON, NE write_file za dijagram!)
Za excalidraw dijagram pozovi alat make_diagram sa spec objektom i out putanjom iz zadatka.
spec: prvi node = orkestrator (gore), ostali agenti u redu ispod; edges = veze [od, do].
Primjer: make_diagram({"spec":{"title":"REGOC sustav","nodes":[{"id":"regoc","label":"REGOC","color":"#ffd166"},{"id":"kosjenka","label":"Kosjenka","color":"#a8d8b9"}],"edges":[["regoc","kosjenka"]]},"out":"<ciljna putanja iz zadatka>"})
Koristi STVARNA imena agenata, ne „Agent 1/2/3". Kod gradi valjanu strukturu — ti samo daš čvorove i veze.` : ''
  // Predaja drugom agentu radi SUSTAV (createSequentialHelpers) — bez ove napomene primarni agent
  // beskonačno „traži" drugog agenta jer nema alat za to (dokazano: TASK-075 petljao 3+ min).
  const _handoffNote = hasHelperCue(originalContent) ? `
## PREDAJA SLJEDEĆEM AGENTU — obavlja SUSTAV automatski
Ovaj zadatak spominje predaju/nastavak drugom agentu. NE pokušavaj sam kontaktirati ni pozvati drugog agenta (nemaš taj alat). Napravi SAMO SVOJ dio, spremi deliverable na zadanu putanju i ZAVRŠI kratkom rečenicom. Sustav automatski pokreće sljedećeg agenta čim ti završiš.` : ''
  const _leanProv = resolveSpawnModel(agentId, agent.model || 'sonnet').provider
  if (_leanProv !== 'anthropic') {
    return `# Ti si ${agent.name} — ${agent.role}
Komunikacijski stil: ${agent.communication_style || 'profesionalan'}

## REGOČ — osnove (NE izmišljaj)
REGOČ = REsursni Gestor za Orkestraciju Članova, meta-orkestrator; 11 agenata: Kosjenka (arhitekt), Jelena (inženjer), Malik (sigurnost), Manda (istraživač), Dora (analitičar), Gita (umjetnik), Grga (dizajner), Potjeh (QA), Klaudio (Telegram), Stribor (glas/govor). Infra: ${INFRA_OPIS}, TaskManager http://localhost:17781 (REST: GET /api/tasks/<ID>).

## Zadatak (od ${fromAgent})
${originalContent}
${_excaHint}${_handoffNote}
## KAKO RADIŠ (obavezno)
1. KORISTI alate da STVARNO napraviš rezultat — write_file za datoteke, bash za naredbe. NE opisuj, NAPRAVI.
2. Ako je zadana putanja/datoteka, spremi TOČNO na nju write_file alatom.
2b. Ako zadatak traži SPECIFIČAN FORMAT (svg, pptx, docx…) ili SKIL/WORKFLOW: PRVO read_file ~/.claude/skills/<Skill>/SKILL.md, a ako postoji i ~/.claude/skills/<Skill>/Workflows/*.md (nađi ih s bash: ls ~/.claude/skills/<Skill>/Workflows/) — slijedi korake iz workflowa. Za excalidraw koristi make_diagram.
${ragUkljucen() ? '3. Za činjenice o sustavu pozovi rag_search (ili bash: bun ~/.claude/skills/CORE/Tools/rag-query.ts -c pai_learning_system -q "tema" -n 3). Inače ne izmišljaj.' : '3. Na ovom čvoru NEMA RAG-a: za činjenice o sustavu čitaj datoteke (read_file, grep). Inače ne izmišljaj.'}
4. Kad je deliverable spremljen i zadatak GOTOV → vrati JEDNU kratku rečenicu potvrde, BEZ daljnjih poziva alata.${recipeSection}${projectTail}`
  }

  // TASK-3669 (ADR-0004, O2 stavke 6 i 9): anti-racionalizacija BEZUVJETNO (protuotrov
  // lažnom „✅" — TASK-2953/2974/2983), ZOD UVJETNO (samo zadaci usporedbe iz
  // `zod_verification.required_for`; bezuvjetno bi bila boilerplate-inflacija iz ADR-0003).
  // `verification_gate` i `structured_status` se NE ubacuju — već idu uz `taskId` gore.
  // Tekst se ne prepisuje: jedini izvor je registar, preko SpawnVerificationBlock.ts.
  // Flag OFF → verificationSection ostaje '' → prompt bajt-identičan starome putu.
  // Racuna se TEK OVDJE, iza lean-returna: ne-Claude modeli (Ollama/Kimi/Gemini) idu
  // laksim promptom (TASK-064/065) pa im blok ne ide — a ni dnevnik ne smije tvrditi da ide.
  let verificationSection = ''
  if (isEnabled('spawnVerificationBlock')) {
    try {
      // Detekcija gleda POSAO, ne REGOČ-ov vlastiti rep (isti razlog kao resolveRecipeTier).
      const posao = stripRegocBoilerplate(originalContent || '')
      const v = buildLiveVerificationBlock(agentRegistry?.spawn_template, posao)
      if (!v.block) {
        log(`⚠️ [verifikacijski blok] ${agentId}: spawn_template nema tekstova — prompt ide bez bloka`)
      } else if (isEnabled('spawnVerificationBlockLive')) {
        verificationSection = `\n${v.block}\n`
        log(`🧪 [verifikacijski blok] ${agentId}: ${v.opis} → u prompt`)
      } else {
        log(`👁️ [verifikacijski blok SHADOW] ${agentId}: ${v.opis} — NE šalje se (spawnVerificationBlockLive=false)`)
      }
    } catch (e) { log(`⚠️ [verifikacijski blok] ${agentId}: nije sastavljen (${e}) — prompt ide bez njega`) }
  }

  return `# Ti si ${agent.name} - ${agent.role}

**Komunikacijski stil:** ${agent.communication_style || 'profesionalan'}

## REGOČ — osnove sustava (uvijek vrijedi, NE izmišljaj)
REGOČ = REsursni Gestor za Orkestraciju Članova — meta-orkestrator koji koordinira 11 agenata: Kosjenka (arhitekt), Jelena (inženjer), Malik (sigurnost), Manda (istraživač), Dora (analitičar), Gita (umjetnik), Grga (dizajner), Potjeh (QA), Klaudio (Telegram 24/7), Stribor (analiza glasa i govora), te REGOČ (orkestrator). Radi kroz TaskManager (SQLite, http://localhost:17781). Infra: ${INFRA_OPIS}. Za TOČNE detalje o sustavu/projektu koristi RAG ili read_file — NIKAD ne izmišljaj činjenice.
${uputaRadneMape(taskId ? dirname(radnaMapaSpawna(String(taskId), agentId)) : null, HOME)}
${modeSection}
${knowledgeInstructions}${ragSection}${taskManagerSection}${verificationSection}

## Zadatak od ${fromAgent}

${originalContent}

---

**Zašto ti:** ${reason}

## Pravila
1. Obavi zadatak temeljito i precizno
2. Ispiši rezultat jasno i strukturirano
${ragUkljucen() ? '3. Ako trebaš dodatni kontekst, provjeri RAG:\n   bun ~/.claude/skills/CORE/Tools/rag-query.ts -c pai_learning_system -q "[tema]" -n 5' : '3. Ako trebaš dodatni kontekst, čitaj datoteke (read_file, grep) — na ovom čvoru NEMA RAG-a'}
4. Koristi format:
   📋 REZULTAT: [Što si napravio]
   📊 STATUS: [Uspješno/Djelomično/Neuspješno]
   ➡️ SLJEDEĆI KORACI: [Ako ih ima]
${recipeSection}${potjehConsult}${blokShemeKoraka()}${projectTail}`
}

/**
 * Ollama baseUrl iz model-config.json (native Ollama nema auth). Ako je override odredio
 * '@node', koristi providers.ollama.nodes[node] (mesh overlay IP). Jedan izvor istine za
 * oba puta: tool-loop spawn (ollama-agent.ts) i text-only API spawn (OllamaProvider).
 */
function resolveOllamaBaseUrl(node?: string, agentId?: string): string {
  let baseUrl = ollamaUrl()
  try {
    const mc = JSON.parse(readFileSync(join(HOME, '.claude/regoc/models/model-config.json'), 'utf-8'))
    baseUrl = mc?.providers?.ollama?.baseUrl || baseUrl
    if (node) {
      const nodeUrl = mc?.providers?.ollama?.nodes?.[node]
      if (nodeUrl) { baseUrl = nodeUrl; log(`[MESH] ${agentId || 'agent'} → Ollama čvor '${node}' (${baseUrl})`) }
      else log(`⚠️ Ollama čvor '${node}' nije u providers.ollama.nodes — koristim default ${baseUrl}`)
    }
  } catch {}
  return baseUrl
}

// ============================================
// A1/TASK-3000 — izolacija paralelnog spawna u vlastiti git worktree
// ============================================

const TASKS_DB_PATH = join(REGOC_DIR, 'data', 'regoc.db')

/**
 * Redak zadatka iz regoc.db (TASKS_DB_PATH, read-only) za grane spawna koje trebaju naslov/opis
 * (ADR-0016 alati po zadatku, TASK-5124 memorija). TASK-5133: te su grane čitale preko getDb(),
 * a to je messages.db bez tablice `tasks` → 'no such table: tasks' na svakom spawnu.
 */
type TaskRow = { id: string; title: string | null; description: string | null; tags: string | null; project_id: string | null; created_by: string | null; assignee: string | null }
function readTaskRow(taskId: string | null): TaskRow | null {
  if (!taskId) return null
  const db = new Database(TASKS_DB_PATH, { readonly: true })
  try {
    return (db.query('SELECT id, title, description, tags, project_id, created_by, assignee FROM tasks WHERE id = ?').get(taskId) as TaskRow | null) ?? null
  } finally { db.close() }
}

/**
 * Tagovi, projekt i propisane provjere zadatka. Iz prva dva se zna smije li se izolirati
 * (`shared-tree`) i GDJE agent uopće radi (projectRepos); treće je ključ `[PROVJERA]` iz
 * opisa (TASK-3460) — naredba pregleda koju kritičar mora pokrenuti da bi njegov `pass`
 * značio „unaprijed dogovoreni pregled je prošao", a ne samo „datoteka se raščlanjuje".
 *
 * Čita se sinkrono i read-only — spawn se ne smije usporiti ni srušiti zbog konteksta
 * koji je samo poboljšanje odluke.
 */
function readTaskContext(taskId: string | null): { tags: string[]; projectId: string | null; declared: DeclaredParse | null; description: string | null } {
  if (!taskId) return { tags: [], projectId: null, declared: null, description: null }
  try {
    const db = new Database(TASKS_DB_PATH, { readonly: true })
    try {
      const row = db.query('SELECT tags, project_id, description FROM tasks WHERE id = ?').get(taskId) as
        { tags?: string | null; project_id?: string | null; description?: string | null } | null
      if (!row) return { tags: [], projectId: null, declared: null, description: null }
      let tags: string[] = []
      try {
        const parsed = JSON.parse(row.tags || '[]')
        if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === 'string')
      } catch {}
      let declared: DeclaredParse | null = null
      try { declared = parseDeclaredChecks(row.description || '') } catch {}
      return { tags, projectId: row.project_id || null, declared, description: row.description || null }
    } finally { db.close() }
  } catch {
    return { tags: [], projectId: null, declared: null, description: null }
  }
}

/**
 * TASK-4833/4834 §5.3 — `[PROVJERA] odjeljci:` iz teksta zahtjeva, U SJENI.
 *
 * Bratski uz `buildAcceptanceChecklist`, ali namjerno mnogo uži: izvlače se SAMO
 * navodnicima omeđena VELIKA imena odsjeka („IZVORI", „RASPON NESIGURNOSTI"), najviše 5.
 * Preširoko izvlačenje znači propisan oblik ondje gdje ga nitko nije tražio — a ADR-0003
 * je već izmjerio što radi preširok okidač (udio E4/E5 s 1,5 % na 35,1 %).
 *
 * ZASAD SE SAMO ZAPISUJE U DNEVNIK: dok se na živom prometu ne izmjeri koliko često
 * pogađa, ne upisuje se u opis zadatka. Čista funkcija — testira se bez baze.
 */
export function buildDocCheckDeclaration(content: string | null | undefined): string | null {
  const text = typeof content === 'string' ? content : ''
  if (!text) return null
  const found: string[] = []
  // Navodnici: „…", "…" i '…'. Ime mora biti VELIKIM slovima (uz razmake i crticu),
  // 3–40 znakova — tako „IZVORI" prolazi, a „ovaj dokument" ne.
  for (const m of text.matchAll(/[„“”"']([A-ZŠĐČĆŽ][A-ZŠĐČĆŽ0-9 \-]{2,39})[“”"']/g)) {
    const name = m[1].trim().replace(/\s+/g, ' ')
    if (name.length < 3) continue
    if (!found.includes(name)) found.push(name)
    if (found.length >= 5) break
  }
  return found.length ? `[PROVJERA] odjeljci: ${found.join(', ')}` : null
}

interface SpawnWorkspace {
  /** `cwd` koji ide u Bun.spawn. */
  cwd: string
  /** Izvorno radno stablo (po njemu se broje sudari) — ostaje isto i kad je spawn izoliran. */
  workTree: string
  /** Postoji samo kad je izolacija ŽIVA i worktree stvarno napravljen. */
  worktree?: WorktreeRecord
  /**
   * A4 dopuna/TASK-3052: trenutak kad je `git worktree add` ZAVRŠIO checkout.
   *
   * `git worktree add` ispiše cijelo stablo, pa svaka datoteka u svježem worktreeju ima
   * mtime = trenutak checkouta — a `spawnInfo.startTime` nastaje PRIJE ovoga. Bez ove
   * granice bi kritičar cijeli checkout smatrao izmjenom ovog agenta (izmjereno
   * 2026-07-29: checkout 1219 ms nakon zabilježenog starta). Sve prije = stablo kakvo je
   * agent zatekao, sve poslije = njegov rad.
   */
  worktreeReadyAtMs?: number
  /**
   * A4/TASK-3003: potpis kritičara nad ovim spawnom. Popunjava se TEK nakon što A2
   * sam pokrene provjere; ostaje `null` kad kritičar nije sudio — a bez potpisa
   * vrata spajanja zadržavaju rad, ne propuštaju ga.
   */
  signoff?: MergeSignoff | null
  /** Trenutak starta spawna — granica za pretragu kanala izvan gita. */
  startedAtMs?: number
}

/**
 * Odluči (i po potrebi napravi) radno stablo za spawn.
 *
 * Tri stanja, po kućnom obrascu flag → shadow → live:
 *   worktreeIsolation=false      → potpuni no-op, `cwd` je HOME kao i dosad
 *   +worktreeIsolationLive=false → SHADOW: odluka se donese, zapiše i logira, ali se
 *                                  ne dira disk (mjeri se koliko bi izolacija uopće radila)
 *   +worktreeIsolationLive=true  → LIVE: worktree se stvarno napravi i spawn radi u njemu
 *
 * Neuspjeh na BILO KOJEM koraku pada na zajedničko stablo uz log. Izolacija je zaštita,
 * a zaštita koja ruši spawn je gora od kvara koji sprječava.
 */
/**
 * TASK-3086: SERIJALIZACIJA kad izolacija nije moguća.
 *
 * `worktreeIsolation` izolira spawnove u vlastita git stabla, ali `~/.claude` NIJE git
 * repozitorij — ondje se ne može izolirati ništa, pa je dosad ostajalo samo glasno
 * upozorenje („IZOLACIJA NEMOGUĆA: 3 druga spawna…") dok su tri pisca i dalje gazila iste
 * datoteke. To je oblik kvara od 28.07. (tri pisca nad `TaskWebUI.ts`).
 *
 * Rješenje bez gita je red: dok u tom stablu radi drugi spawn, sljedeći ČEKA. Zadatak
 * ostaje `pending` i sljedeći prolaz auto-execa ga pokupi — dakle serijalizacija bez
 * ijednog izgubljenog zadatka.
 *
 * Vraća razlog čekanja ili `null` kad se smije krenuti.
 */
// ─── ADR-0022 (TASK-5613): TRAJNA SESIJA AGENTA ─────────────────────────────────────────
// Agent koji je na ploči (AGENTS) u trajnom načinu dobiva auto-exec zadatke u ISTOJ Claude
// sesiji (`--resume <sid>`) po radnom stablu. Izvršitelj ostaje `spawnAgentOnDemand`, pa
// najam, TMPDIR, kritičar, pauza, strop i siročad vrijede bez ijedne iznimke.
// Prekidač features.json `trajnaSesija` {enabled, mode}: off = stari put (bajt-identična
// naredba), shadow = samo zapis „👁️ [trajni SHADOW]”, on = živo. Pokazivači: data/trajne_sesije/.

/** Odluka trajnog puta koja putuje do spawna (samo u načinu `on`, samo resume/nova). */
interface TrajniSpawn {
  put: TrajniPut
  kljuc: string
  stablo: string
  model: string
  /** Predaja za novu generaciju; gradi se i za resume, za jedini ponovni pokušaj (No conversation found). */
  predaja: string | null
}

function trajniNacin(): TrajniNacin {
  try { return citajNacin(getFlag('trajnaSesija') as any) } catch { return 'off' }
}

/** Stablo po kojem se ključa sesija — CLI transkripte sprema po `cwd`, pa resume mora iz istog. */
function trajnoStablo(taskId: string | null): string {
  if (!isEnabled('worktreeIsolation')) return HOME
  try { return resolveProjectWorkDir(loadWorktreeConfig(), readTaskContext(taskId).projectId, HOME) } catch { return HOME }
}

const trajniZapisCekanja = new Map<string, number>()

function odlukaTrajnogPuta(agentId: string, taskId: string, tags: string[] | null | undefined, target: SpawnTarget, projectId?: string | null): { nacin: TrajniNacin; spawn: TrajniSpawn | null; put: TrajniPut | null } {
  const nacin = trajniNacin()
  if (nacin === 'off') return { nacin, spawn: null, put: null }
  try {
    const persistent = isPersistentEnabled(agentId)
    if (!persistent) return { nacin, spawn: null, put: null }
    const stablo = trajnoStablo(taskId)
    const kljuc = kljucPokazivaca(agentId, stablo, target.model)
    let put = odluciTrajniPut({
      agentId, persistentEnabled: persistent, provider: target.provider, compat: false, tags,
      stablo, model: target.model, pokazivac: citajPokazivac(trajneSesijeDir(), kljuc), bravaZiva,
      zivNajamUStablu: ziviNajmovi().some(n => n.agent === agentId && n.taskId !== taskId),
      now: Date.now(), postavke: citajPostavke(),
      // TASK-5615 (opcija B): opseg trajne sesije po projektu — izvan opsega = običan spawn
      projectId: projectId !== undefined ? projectId : readTaskContext(taskId).projectId,
    })
    // Trajni spawn radi u GLAVNOM stablu (resume traži isti cwd). Ako u njemu već netko radi
    // bez izolacije, ovaj bi po pravilima dobio worktree (drugi cwd) — zato čeka.
    if ((put.put === 'resume' || put.put === 'nova') && stablo !== HOME) {
      const glavno = [...activeAgentSpawns.values()].find(i => (i.workTree || HOME) === stablo && !i.worktree)
      if (glavno) put = { put: 'cekaj', razlog: `u stablu radi ${glavno.agent}/${glavno.taskId || '—'} bez izolacije (resume traži isti cwd)` }
    }
    return { nacin, spawn: { put, kljuc, stablo, model: target.model, predaja: null }, put }
  } catch (e) {
    log(`⚠️ [trajni] ${taskId} → ${agentId}: odluka nije uspjela (${e}) — običan spawn`)
    return { nacin, spawn: null, put: null }
  }
}

/**
 * Odluka trajnog puta za JEDAN zadatak, zajednička auto-exec petlji i putu poruke (F3, TASK-5615).
 * `cekaj` → zadatak ostaje `pending` uz oznaku `ceka-sesiju` (bez spawna); `spawn` → `trajni` je
 * null (običan spawn: off, shadow, izvan opsega, provider…) ili odluka resume/nova s predajom.
 */
async function pripremiTrajniSpawn(agentId: string, task: { id: string; tags?: string[] | null; projectId?: string | null }, target: SpawnTarget): Promise<{ akcija: 'spawn' | 'cekaj'; trajni: TrajniSpawn | null }> {
  const id = String(task.id)
  const trajno = odlukaTrajnogPuta(agentId, id, task.tags, target, task.projectId)
  if (!trajno.put) return { akcija: 'spawn', trajni: null }
  if (trajno.nacin === 'shadow') {
    log(`👁️ [trajni SHADOW] ${id} → ${agentId}: bi išao ${opisTrajnogPuta(trajno.put)}`)
    return { akcija: 'spawn', trajni: null }
  }
  if (trajno.put.put === 'cekaj') {
    const zadnji = trajniZapisCekanja.get(id) || 0
    if (Date.now() - zadnji > 5 * 60_000) {
      trajniZapisCekanja.set(id, Date.now())
      log(`⏸️ [trajni] ${id} → ${agentId}: ${trajno.put.razlog} — čekam`)
      const oznake = Array.isArray(task.tags) ? task.tags.map(String) : []
      if (!oznake.includes(OZNAKA_CEKA_SESIJU)) {
        await zatvoriZadatak(TASK_MANAGER_API, id, { tags: [...oznake, OZNAKA_CEKA_SESIJU], progressNotes: [`⏸️ Čeka trajnu sesiju agenta ${agentId}: ${trajno.put.razlog}. Ostaje pending i kreće sam kad se sesija oslobodi.`] }, { log, zapisiNeuspjeh: false })
      }
    }
    return { akcija: 'cekaj', trajni: null }
  }
  if (trajno.put.put === 'obican') {
    log(`🧷 [trajni] ${id} → ${agentId}: ${opisTrajnogPuta(trajno.put)}`)
    return { akcija: 'spawn', trajni: null }
  }
  const trajni = trajno.spawn
  if (trajni) trajni.predaja = await gradiPredajuTrajne(agentId, trajni.kljuc, id)
  trajniZapisCekanja.delete(id)
  return { akcija: 'spawn', trajni }
}

/** Kartica zadatka koji je krenuo trajnim putem: oznaka `trajni:<agent>` + bilješka 🧷. */
async function oznaciTrajniStart(taskId: string, tags: string[] | null | undefined, agentId: string, trajni: TrajniSpawn): Promise<void> {
  const post = citajPostavke()
  const pk = citajPokazivac(trajneSesijeDir(), trajni.kljuc)
  const sid = pk && pk !== 'pokvaren' ? pk.sessionId : (trajni.put.put === 'resume' ? trajni.put.sessionId : '')
  const ktx = pk && pk !== 'pokvaren' && typeof pk.kontekstTokena === 'number' ? `${Math.round(pk.kontekstTokena / 1000)}k` : '?'
  const n = trajni.put.put === 'resume' ? trajni.put.n : 1
  await zatvoriZadatak(TASK_MANAGER_API, taskId, {
    tags: trajneOznake(tags, agentId).filter(t => t !== CEKA_MJESTO_TAG),
    progressNotes: [`🧷 trajna sesija ${kratkiSid(sid)} · ${trajni.put.put === 'nova' ? `NOVA (gen ${trajni.put.gen}: ${trajni.put.razlog})` : `gen ${trajni.put.gen}`} · zadatak ${n} u sesiji · kontekst ${ktx}/${Math.round(post.pragKonteksta / 1000)}k`],
  }, { log, zapisiNeuspjeh: false })
}

/**
 * Put poruke (delegateToAgent): ide li posao u inbox AgentDaemona? U načinu `on` za ne-Klaudio
 * agenta NIKAD (ADR-0022 O6/F3 — jedan izvršitelj); inače stari uvjet (trajan + živ daemon).
 */
function inboxZaPoruku(agentId: string, ziv: (a: string) => boolean = ensurePersistentAgentAlive): boolean {
  if (!isPersistentEnabled(agentId)) return false
  if (trajnaZamjenjujeAgentDaemon(trajniNacin(), agentId)) return false
  return ziv(agentId)
}

/** Oznake zadatka koji je krenuo trajnim putem: `trajni:<agent>`, bez `ceka-sesiju`. */
function trajneOznake(tags: string[] | null | undefined, agentId: string): string[] {
  const o = (Array.isArray(tags) ? tags.map(String) : []).filter(t => t !== OZNAKA_CEKA_SESIJU && !t.startsWith('trajni:'))
  return [...o, `trajni:${agentId}`]
}

function opisTrajnogPuta(p: TrajniPut): string {
  if (p.put === 'resume') return `--resume ${kratkiSid(p.sessionId)} (gen ${p.gen}, zadatak ${p.n} u sesiji)`
  if (p.put === 'nova') return `NOVA sesija (gen ${p.gen}: ${p.razlog})`
  return `${p.put === 'cekaj' ? 'čeka' : 'običan spawn'} — ${p.razlog}`
}

/** Predaja nove generacije iz ploče (durabilni izvor), ne iz pamćenja modela. Kvar = null. */
async function gradiPredajuTrajne(agentId: string, kljuc: string, taskId: string): Promise<string | null> {
  try {
    const post = citajPostavke()
    const p = citajPokazivac(trajneSesijeDir(), kljuc)
    const ids = p && p !== 'pokvaren' ? p.zadaci.slice(-post.predajaZadataka) : []
    const zadaci: { id: string; title?: string; status?: string; resultSummary?: string | null }[] = []
    for (const id of ids) {
      try {
        const r = await fetch(`${TASK_MANAGER_API}/${id}`, { signal: AbortSignal.timeout(3000) })
        if (!r.ok) continue
        const j: any = await r.json(); const t = j?.task || j
        zadaci.push({ id, title: t?.title, status: t?.status, resultSummary: t?.resultSummary ?? t?.result_summary ?? null })
      } catch { /* zadatak bez odgovora se preskače */ }
    }
    const otvoreni: { id: string; title?: string; status?: string; tags?: string[] | null }[] = []
    for (const status of ['in_progress', 'blocked', 'pending']) {
      try {
        const r = await fetch(`${TASK_MANAGER_API}?assignee=${encodeURIComponent(agentId)}&status=${status}`, { signal: AbortSignal.timeout(3000) })
        if (!r.ok) continue
        const j: any = await r.json(); const lista = Array.isArray(j) ? j : (j?.tasks || [])
        for (const t of lista.slice(0, 10)) if (t?.id && t.id !== taskId) otvoreni.push({ id: t.id, title: t.title, status: t.status, tags: Array.isArray(t.tags) ? t.tags : null })
      } catch { /* bez popisa otvorenih */ }
    }
    const pozadina: { taskId: string; pids?: number[] }[] = []
    try {
      const dir = join(HOME, '.claude/regoc/data/pozadina')
      for (const f of existsSync(dir) ? readdirSync(dir) : []) {
        if (!f.endsWith('.json')) continue
        try {
          const n = JSON.parse(readFileSync(join(dir, f), 'utf-8'))
          if (n?.agent === agentId) pozadina.push({ taskId: n.taskId, pids: (n.pidovi || []).map((x: any) => Number(x?.pid)).filter(Boolean) })
        } catch {}
      }
    } catch {}
    return gradiPredaju({ zadaci, otvoreni, pozadina }, post)
  } catch (e) {
    log(`⚠️ [trajni] predaja za ${agentId} nije sastavljena (${e})`)
    return null
  }
}

function serializationHold(agentId: string, taskId: string | null): string | null {
  try {
    if (!isEnabled('worktreeIsolation')) return null
    const cfg = loadWorktreeConfig()
    const { tags, projectId } = readTaskContext(taskId)
    const workDir = resolveProjectWorkDir(cfg, projectId, HOME)
    let activeInSameTree = 0
    for (const info of activeAgentSpawns.values()) if ((info.workTree || HOME) === workDir) activeInSameTree++
    if (activeInSameTree === 0) return null
    const plan = planIsolation(cfg, { taskId, agentId, workDir, tags, activeInSameTree })
    // Izolacija je moguća → nema potrebe za čekanjem, svatko dobiva svoje stablo.
    if (plan.decision.mode === 'worktree' && isEnabled('worktreeIsolationLive')) return null
    // Zadatak koji IZRIJEKOM traži zajedničko stablo (`shared-tree`/`integration`) mora
    // vidjeti tuđe izmjene — njega ne serijaliziramo, samo upozoravamo kao dosad.
    if (plan.decision.code === 'opt-out-tag') return null
    return `${activeInSameTree} ${activeInSameTree === 1 ? 'drugi spawn radi' : 'druga spawna rade'} u istom stablu (${plan.decision.code}) — čekam da završe`
  } catch { return null }   // kvar u provjeri NE smije zaustaviti rad
}

function prepareSpawnWorkspace(agentId: string, taskId: string | null): SpawnWorkspace {
  if (!isEnabled('worktreeIsolation')) return { cwd: HOME, workTree: HOME }

  const live = isEnabled('worktreeIsolationLive')
  try {
    const cfg = loadWorktreeConfig()
    const { tags, projectId } = readTaskContext(taskId)
    const workDir = resolveProjectWorkDir(cfg, projectId, HOME)

    // Sudar se broji po IZVORNOM stablu: i izolirani spawn potječe iz njega.
    let activeInSameTree = 0
    for (const info of activeAgentSpawns.values()) if ((info.workTree || HOME) === workDir) activeInSameTree++

    const plan = planIsolation(cfg, { taskId, agentId, workDir, tags, activeInSameTree })
    log(formatDecision(plan.decision, plan.input, live))

    let record: WorktreeRecord | undefined
    let readyAtMs: number | undefined
    // TASK-5674: ponovni spawn ISTOG zadatka (dorada, reclaim iz `blocked`) nastavlja u
    // sačuvanom worktreeju tog zadatka — tamo su njegovi commiti. Bez ovoga je TASK-5657
    // dobio glavno stablo („shared (solo)"), a kritičar je propisane testove tražio na main.
    const sacuvan = live && plan.decision.code !== 'opt-out-tag'
      ? sacuvaniWorktreeZadatka(cfg, taskId, plan.repoRoot)
      : null
    if (sacuvan) {
      record = sacuvan
      readyAtMs = Date.now()
      log(`   ↳ ♻️ nastavljam u sačuvanom worktreeju zadatka ${sacuvan.worktreePath} (grana ${sacuvan.branch})`)
    } else if (live && plan.decision.mode === 'worktree' && plan.repoRoot) {
      try {
        record = createWorktree(cfg, { taskId, agentId, repoRoot: plan.repoRoot, nowMs: Date.now() })
        readyAtMs = Date.now()   // checkout je gotov TEK sada — vidi `worktreeReadyAtMs`
        log(`   ↳ worktree ${record.worktreePath} (grana ${record.branch})`)
      } catch (e) {
        log(`⚠️ [worktree] izolacija nije uspjela za ${agentId}/${taskId || 'bez-zadatka'} — radim u zajedničkom stablu: ${e}`)
      }
    }

    appendDecisionLog({
      ts: new Date().toISOString(),
      taskId,
      agentId,
      mode: record ? 'worktree' : 'shared',
      code: plan.decision.code,
      live,
      repoRoot: plan.repoRoot,
      workDir,
      activeInSameTree,
      reason: plan.decision.reason,
      warn: plan.decision.warn,
      worktreePath: record?.worktreePath,
    })

    return { cwd: record ? record.worktreePath : workDir, workTree: workDir, worktree: record, worktreeReadyAtMs: readyAtMs, signoff: null, startedAtMs: Date.now() }
  } catch (e) {
    log(`⚠️ [worktree] odluka o izolaciji pala (${agentId}) — zajedničko stablo: ${e}`)
    return { cwd: HOME, workTree: HOME }
  }
}

/**
 * Zatvori radno stablo spawna.
 *
 * Redoslijed je bitan i namjeran:
 *   1. A4 vrata spajanja — rad ulazi u glavno stablo SAMO uz potpis (`mergeGateLive`).
 *      Bez potpisa se zapisuje u pretinac s točnim naredbama za pregled i ostaje živ.
 *   2. A1 oslobađanje — tek ono što vrata nisu potrošila. Prazno se briše, posao se ČUVA.
 *
 * Kad su vrata ugašena (`mergeGate=false`), ponašanje je točno kao prije A4: worktree
 * s poslom se čuva, nitko ništa ne spaja.
 */
function finishSpawnWorkspace(
  ws: SpawnWorkspace | null,
  agentId: string,
  taskId: string | null,
  runOutcome: string = 'failed',
): void {
  if (!ws?.worktree) return

  // ── A4/TASK-3003: vrata prije spajanja ────────────────────────────────────
  if (isEnabled('mergeGate')) {
    const live = isEnabled('mergeGateLive')
    try {
      const res = runMergeGate({
        record: ws.worktree,
        agentId,
        taskId,
        signoff: ws.signoff ?? null,
        sinceMs: ws.startedAtMs ?? ws.worktree.createdAtMs,
        runOutcome,
        live,
      }, loadMergeConfig())
      log(formatGateLog({ record: ws.worktree, agentId, taskId, signoff: ws.signoff ?? null, sinceMs: ws.startedAtMs ?? 0, live }, res))
      if (res.exec) log(`   ↳ ${res.exec.detail}`)
      if (res.hold && live) log(formatHoldBrief(res.hold))
      // Vrata su zatvorila stablo (spojeno i uklonjeno) — A1 nema što oslobađati.
      if (res.worktreeConsumed) return
    } catch (e) {
      // Kvar u vratima ne smije pojesti rad ni srušiti spawn: pada na staro ponašanje
      // (A1 čuva worktree), nikad na „spoji svejedno".
      log(`⚠️ [merge] vrata spajanja pala (${agentId}/${taskId || 'bez-zadatka'}) — rad ostaje u svom stablu: ${e}`)
    }
  }

  try {
    const res = releaseWorktree(loadWorktreeConfig(), ws.worktree)
    const icon = res.outcome === 'preserved' ? '📦' : res.outcome === 'removed' ? '🧹' : '⚠️'
    log(`${icon} [worktree] ${agentId}/${taskId || 'bez-zadatka'} ${res.outcome}: ${res.detail}`)
  } catch (e) {
    log(`⚠️ [worktree] oslobađanje nije uspjelo (${agentId}/${taskId || 'bez-zadatka'}): ${e}`)
  }
}

// ============================================
// A3/TASK-3002 — vrata disjunktnog opsega datoteka
// ============================================

/** Zadatak u obliku koji vrata opsega čitaju (oznake + tekst za izvođenje opsega). */
function readTaskForScope(taskId: string | null): { id: string; title: string; description: string; tags: string[] } | null {
  if (!taskId) return null
  try {
    const db = new Database(TASKS_DB_PATH, { readonly: true })
    try {
      const row = db.query('SELECT id, title, description, tags FROM tasks WHERE id = ?').get(taskId) as
        { id: string; title?: string | null; description?: string | null; tags?: string | null } | null
      if (!row) return null
      let tags: string[] = []
      try {
        const parsed = JSON.parse(row.tags || '[]')
        if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === 'string')
      } catch { /* pokvarene oznake = nema oznaka, ne pad */ }
      return { id: row.id, title: row.title || '', description: row.description || '', tags }
    } finally { db.close() }
  } catch { return null }
}

/**
 * Smije li zadatak KRENUTI sada, s obzirom na opseg datoteka koji drže drugi.
 *
 * Tri stanja, po kućnom obrascu flag → shadow → live:
 *   fileScopeGate=false      → potpuni no-op
 *   +fileScopeGateLive=false → SHADOW: odluka se donese, zapiše i logira, ali se ne odgađa
 *                              ništa (mjeri se koliko bi vrata uopće zaustavljala)
 *   +fileScopeGateLive=true  → LIVE: zadatak s presjekom ostaje `pending` i dolazi na red
 *                              u sljedećem prolazu (15 s). Status se NE mijenja — `blocked`
 *                              bi tražio čovjeka, a ovo se razriješi samo od sebe.
 *
 * Greška u odluci pušta zadatak (fail-open): vrata koja zaustave rad zbog vlastitog kvara
 * bila bi gora od sudara koji sprječavaju.
 */
function scopeGateAllows(task: any, agentId: string): boolean {
  if (!isEnabled('fileScopeGate')) return true
  const live = isEnabled('fileScopeGateLive')
  const taskId = task?.id ? String(task.id) : null
  try {
    const cfg = loadScopeConfig()
    const plan = planScope(cfg, { task, agentId })
    log(formatScopeDecision(plan.decision, plan.input, live))
    for (const c of plan.decision.conflicts) log(`   ↳ ${c.code}: ${c.detail}`)
    appendScopeLog({
      ts: new Date().toISOString(),
      taskId,
      agentId,
      verdict: plan.decision.verdict,
      code: plan.decision.code,
      live,
      mode: plan.scope.mode,
      patterns: plan.scope.patterns,
      activeCount: plan.active.length,
      reason: plan.decision.reason,
      warn: plan.decision.warn,
      conflicts: plan.decision.conflicts.map(c => ({ taskId: c.taskId, agentId: c.agentId, code: c.code, detail: c.detail })),
    })

    if (plan.decision.verdict === 'defer' && taskId) {
      const note = noteDefer(taskId, plan.decision.code, Date.now(), cfg)
      if (note.starving) {
        // Odgoda bez trajanja je nevidljiva. Ovo je jedini način da se vidi razlika
        // između „čeka 30 s" i „čeka 3 h jer ga drži zadatak koji je zapeo".
        log(`⚠️ [opseg] ${taskId} čeka ${Math.round(note.waitedMs / 60000)} min (${note.count} pokušaja, razlog ${plan.decision.code}) — provjeri drži li opseg zadatak koji je stao`)
      }
      if (live) return false
      return true
    }
    if (taskId) {
      const waited = clearDefer(taskId, Date.now())
      if (waited !== null) log(`▶️ [opseg] ${taskId} kreće nakon ${Math.round(waited / 60000)} min čekanja`)
    }
    return true
  } catch (e) {
    log(`⚠️ [opseg] odluka pala (${agentId}/${taskId || 'bez-zadatka'}) — puštam (fail-open): ${e}`)
    return true
  }
}

/**
 * Zabilježi što ovaj spawn drži. Radi i kad vrata nisu ŽIVA — bez zapisa nema ni mjerenja
 * ni izvještaja, a zapis sam po sebi ništa ne zaustavlja.
 *
 * Vlasnik zahtjeva je DAEMON (njegov pid): kad daemon padne, svi njegovi zahtjevi postaju
 * mrtvi i registar se sam počisti. To je brana od zaključavanja reda zaostalim zapisima.
 */
function registerScopeClaim(agentId: string, taskId: string | null): ScopeClaim | undefined {
  if (!isEnabled('fileScopeGate')) return undefined
  try {
    const cfg = loadScopeConfig()
    const task = readTaskForScope(taskId) || { id: taskId || '', title: '', description: '', tags: [] }
    const scope = readTaskScope(task, cfg)
    return registerClaim({ taskId, agentId, scope, pid: process.pid, nowMs: Date.now() })
  } catch (e) {
    log(`⚠️ [opseg] zahtjev nije zabilježen (${agentId}/${taskId || 'bez-zadatka'}): ${e}`)
    return undefined
  }
}

function releaseScopeClaim(info: AgentSpawnInfo | undefined): void {
  if (!info?.scopeClaim) return
  try {
    removeClaim(info.scopeClaim.id)
    info.scopeClaim = undefined
  } catch (e) {
    log(`⚠️ [opseg] oslobađanje zahtjeva nije uspjelo (${info.agent}): ${e}`)
  }
}

/**
 * Zaostali zahtjevi prethodne generacije. `listClaims` sam briše one čiji je proces-vlasnik
 * mrtav — poziv pri startu je samo trenutak u kojem se to sigurno dogodi, prije prve odluke.
 */
function reapScopeClaimsOnStartup(): void {
  if (!isEnabled('fileScopeGate')) return
  try {
    const before = listAllClaims().length
    const live = listClaims().length      // usput briše zapise mrtvih vlasnika
    if (before > 0) log(`🧹 [opseg] registar zahtjeva pri startu: ${live} živih od ${before} zapisa (ostatak prethodne generacije očišćen)`)
  } catch (e) {
    log(`⚠️ [opseg] čišćenje registra pri startu nije uspjelo: ${e}`)
  }
}

/**
 * Napuštena stabla iz prethodne generacije. Kad daemon padne ili ga netko ubije, `finally`
 * se nikad ne izvrši — ovo je jedini put kojim se ti worktreejevi počiste. Prazni se brišu,
 * oni s poslom se ČUVAJU i prijave.
 */
function reapWorktreesOnStartup(): void {
  if (!isEnabled('worktreeIsolation')) return
  try {
    const cfg = loadWorktreeConfig()
    const dryRun = !isEnabled('worktreeIsolationLive')
    const entries = reapAbandonedWorktrees(cfg, { nowMs: Date.now(), dryRun })
    if (entries.length === 0) return
    log(`🧹 [worktree] žetva napuštenih (${dryRun ? 'DRY-RUN' : 'LIVE'}): ${entries.length} zapisa`)
    for (const e of entries) log(`   ${e.action.padEnd(12)} ${e.record.id} — ${e.detail}`)
  } catch (e) {
    log(`⚠️ [worktree] žetva pri startu nije uspjela: ${e}`)
  }
}

/**
 * Spawn agent on-demand via claude --print (fire-and-forget)
 * Results are delivered back to fromAgent via message queue
 */
function spawnAgentOnDemand(
  agentId: string,
  prompt: string,
  target: SpawnTarget,
  taskId: string | null,
  fromAgent: string,
  origin?: VoiceOrigin,       // TASK-2612: proslijedi glasovno porijeklo do izvještaja
  trajni?: TrajniSpawn | null, // ADR-0022 (TASK-5613): trajna sesija (samo auto-exec, način `on`)
  voditelj?: VoditeljSpawn | null // ADR-0024 O3 (TASK-5677): buđenje voditelja lanca — traka voditeljSpawns, izvan stropa
): SpawnStart {
  // TASK-5029: vraća je li proces STVARNO krenuo. Pozivatelj tek tada stavlja `in_progress`
  // — prije je status išao unaprijed, pa je odbijeni spawn (strop 3/3) ostavljao zadatak
  // „u radu" bez procesa (TASK-5026).
  // TASK-2637 (R1): Ollama (lokalno) više NIJE text-only — ide kroz ollama-agent.ts tool-loop
  // (/v1/chat/completions + alati bash/read_file/write_file/make_diagram), pa lokalni model može
  // stvarno napraviti datoteku/dokumentaciju. Text-only put (spawnAgentViaAPI) ostaje za mesh čvorove
  // i ručne pozive. OpenRouter → openrouter-agent; Anthropic (+ kompatibilni) → claude CLI.
  // TASK-5420: auto-exec ovdje dolazi BEZ origin-a, pa je svaki izvještaj zadatka nastalog u
  // drugoj grupi (oznaka `chat:<id>`) padao u REGOČ grupu (TASK-5416). Origin se izvodi iz
  // oznake PRIJE prvog izvještaja; zadani origin ima prednost, bez oznake ništa se ne mijenja.
  if (!origin && taskId) {
    try { origin = originZaZadatak(origin, readTaskRow(taskId)?.tags ?? null) } catch { /* fail-safe: stari put */ }
    if (origin) log(`📮 [kanal] ${taskId}: izvještaji idu u chat ${origin.chatId} (oznaka chat:)`)
  }
  const model = target.model
  const isOpenRouter = target.provider === 'openrouter'
  const isOllama = target.provider === 'ollama'
  const isKimiCli = target.provider === 'kimicli'   // Kimi Code CLI: OAuth pretplata (kimi login), headless `kimi -p` — bez API ključa
  const isGeminiCli = target.provider === 'geminicli' // Gemini CLI (Google): OAuth "Login with Google" preko linka, headless `gemini -p` — bez API ključa
  // Anthropic-kompatibilni provider (kimi-API/GLM/MiniMax/Qwen/DeepSeek) → isti claude CLI put, drugi endpoint+token.
  const compat = (target.provider !== 'anthropic' && !isOpenRouter && !isOllama && !isKimiCli && !isGeminiCli) ? getAnthropicCompatProvider(target.provider) : null
  if (target.provider !== 'anthropic' && !isOpenRouter && !isOllama && !isKimiCli && !isGeminiCli && !compat) {
    log(`⚠️ Provider '${target.provider}' nije podržan za spawn (nije ollama/openrouter/anthropic/kimicli/geminicli ni anthropic-kompatibilan) — preskačem ${agentId}`)
    const db = getDb(); sendResponse(db, fromAgent, `⚠️ Provider '${target.provider}' nije konfiguriran kao anthropic-kompatibilan. Provjeri model-config.json (baseUrl + apiKey).`, 5, origin); db.close()
    return { started: false, reason: 'provider' }
  }

  // TASK-3047: globalna pauza vrijedi za SVAKI spawn, ne samo za auto-exec. Ovo je jedini
  // čvor kroz koji prolaze svi putovi (poruka, auto-exec, lanac pomoćnika), pa je jedino
  // mjesto na kojem „stop" znači stop. Odgovor se šalje pošiljatelju da tišina ne izgleda
  // kao kvar.
  {
    const pause = readPauseState()
    if (pause.paused) {
      log(`⏸️ [pauza] spawn ${agentId} odbijen — ${describePause(pause)}`)
      const db = getDb()
      sendResponse(db, fromAgent, `⏸️ Rad je pauziran u TaskManageru (${pause.by || 'ručno'}${pause.reason ? `: ${pause.reason}` : ''}). Pritisni „Nastavi" za nastavak.`, 5, origin)
      db.close()
      return { started: false, reason: 'pauza' }
    }
  }

  // ADR-0024 O3: voditelj ide u svoju traku (vlastiti strop), običan spawn u strop agenata.
  const traka = trakaSpawna(!!voditelj, { aktivni: activeAgentSpawns, voditelji: voditeljSpawns })
  if (voditelj) {
    const m = mjestoUTraci(true, { aktivni: activeAgentSpawns, voditelji: voditeljSpawns }, maxAgentConcurrent(), voditelj.maxIstodobno)
    if (!m.ok) { log(`⏳ [voditelj] ${taskId}: ${m.razlog} — buđenje čeka`); return { started: false, reason: 'strop' } }
  }
  // Check concurrency limit
  else if (!spawnSlotAvailable(activeAgentSpawns.size, maxAgentConcurrent())) {
    log(`⚠️ Agent spawn limit reached (${maxAgentConcurrent()}). Skipping ${agentId} spawn.`)
    const db = getDb()
    // TASK-5029: zadatak NE treba ponovno slati — ostaje `pending` (oznaka ceka-mjesto) i
    // auto-exec ga pokreće sam čim se mjesto oslobodi.
    sendResponse(db, fromAgent, taskId
      ? `⏳ Svi agent slotovi zauzeti (${activeAgentSpawns.size}/${maxAgentConcurrent()}). ${taskId} čeka mjesto (pending) i krenut će sam čim se slot oslobodi.`
      : `⏳ Svi agent slotovi zauzeti (${activeAgentSpawns.size}/${maxAgentConcurrent()}). Pokušaj ponovno za par minuta.`, 5, origin)
    db.close()
    return { started: false, reason: 'strop' }
  }

  // F6 (TASK-2549): Per-agent exponential backoff — spriječava kaskadne retry petlje
  const failTracker = agentFailureTracker.get(agentId) || { count: 0, lastFail: 0, backoffUntil: 0 }
  if (Date.now() < failTracker.backoffUntil) {
    const remainingSec = Math.round((failTracker.backoffUntil - Date.now()) / 1000)
    log(`⏳ Agent ${agentId} u backoff-u (fail #${failTracker.count}) — preostalo ${remainingSec}s, preskačem spawn`)
    return { started: false, reason: 'backoff' }
  }

  // DUR-5/TASK-3597: OSIGURAC NA VRATIMA SPAWNA. Backoff iznad je per-agent i u memoriji
  // ovog procesa; osigurac je cross-process i pamti i GLOBALNI niz odbijenica (jedan racun,
  // jedan limit), pa hvata i slucaj u kojem svaki agent padne „samo jednom".
  {
    const gate = getSpawnBreaker().check(agentId)
    if (gate.wouldBlock) {
      if (gate.alarm) log(formatSpawnAlarm(agentId, gate))
      if (!gate.allowed) {
        log(`🛑 [spawn-breaker] spawn ${agentId} ODBIJEN — ${gate.reason}`)
        const db = getDb()
        sendResponse(db, fromAgent, `🛑 Osigurac spawnova je otvoren (${gate.reason}). Pokusaj ponovno kasnije.`, 5, origin)
        db.close()
        return { started: false, reason: 'osigurac' }
      }
      log(`👁️ [spawn-breaker SHADOW] ${agentId}: ${gate.reason}`)
    }
  }

  // TASK-623: Add PLAN prefix if in PLAN mode
  const currentMode = getSystemMode()
  if (currentMode === 'PLAN') {
    prompt = `[SYSTEM MODE: PLAN] Ovo je plan-only sesija. NE izvrsavaj, samo planiraj.\n\n` + prompt
    log(`[MODE] Agent ${agentId} spawned in PLAN mode`)
  }

  // I2/TASK-3651: IDENTITET NA SISTEMSKI KANAL. Do sada je agentu iz registra od 26 polja
  // stizalo troje (ime, uloga, stil) i to kroz opis zadatka — kanal izmjeren na 38 % posluha,
  // dok je na sistemskom kanalu (100 %) svaka sesija dobivala tuđi identitet („REGOČ
  // Meta-Orchestrator", 124/124 sesija). Blok se šalje kroz `--append-system-prompt` gdje
  // postoji claude CLI; gdje ga nema (ollama/openrouter/kimi/gemini) `-p` je jedini kanal,
  // pa ide na početak prompta. Flag OFF → prompt i naredba bajt-identični starome putu.
  let identityArgs: string[] = []
  if (isEnabled('agentIdentityBlock')) {
    try {
      // I6/TASK-3655: popis potvrđenih kolekcija dolazi izvana — `IdentityBlock` namjerno
      // ne ide na mrežu, pa bez ovoga redak „Tvoja RAG memorija" nikad nije izlazio.
      // ADR-0016 (TASK-5107): vještine i alati PO ZADATKU. Prekidač config/task-toolkit.json:
      // off = ništa (zadano), shadow = samo zapis u data/task_toolkit.jsonl, on = ide u blok.
      let toolkit: ToolkitSelection | null = null
      try {
        const tkMode = taskId ? toolkitModeFor(agentId, readToolkitSwitch()) : 'off'
        if (tkMode !== 'off') {
          const info = taskInfoFromRow(readTaskRow(taskId))
          if (info) {
            const sel = selectToolkit(info, agentId, agentRegistry?.agents?.[agentId], loadCatalog())
            logToolkitShadow(sel, { mode: tkMode })
            if (tkMode === 'on') toolkit = sel
            log(`🧰 [alati-po-zadatku ${tkMode.toUpperCase()}] ${agentId}/${taskId}: vještine ${sel.vjestine.map(v => v.ime).join(',') || '—'} · alati ${sel.alati.map(a => a.id).join(',') || '—'}`)
          }
        }
      } catch (e) { log(`⚠️ [alati-po-zadatku] ${agentId}: odabir nije uspio (${e}) — statični blok`) }
      // TASK-5159 (dizajn TASK-5158 §3.5, §7 R1): obvezne vještine iz oznaka `vjestina:*`
      // (vještina formata prati format naloga) i redak RAG-FIRST za `regoc_popis`.
      let obvezne: string[] = []
      try {
        const red = taskId ? readTaskRow(taskId) : null
        const oznake = red?.tags ? (() => { try { return JSON.parse(String(red.tags)) } catch { return String(red.tags).split(',') } })() : []
        if (Array.isArray(oznake) && oznake.some((o: unknown) => /^vjestina:/i.test(String(o)))) {
          obvezne = obvezneVjestine({ oznake: oznake.map(String), tekst: `${red?.title || ''}\n${red?.description || ''}` })
        }
      } catch { obvezne = [] }
      let regocPopis = false
      try { regocPopis = popisDostupan() } catch { regocPopis = false }
      const blok = buildIdentityBlock(agentId, agentRegistry, { ragCollections: knownCollections(), toolkit, obvezneVjestine: obvezne, regocPopis })
      if (obvezne.length) log(`🎯 [obvezne vještine] ${agentId}/${taskId}: ${obvezne.join(', ')} → sistemski kanal`)
      if (!blok) {
        log(`👁️ [identitet] ${agentId}: nema zapisa u registru — blok se ne šalje`)
      } else if (isEnabled('agentIdentityBlockLive')) {
        // I9/TASK-3658: PLAN zabrana ide UZ blok, na isti (sistemski) kanal. Blok nosi
        // naredbodavne rečenice („Pokreni ih alatom `Skill`", „pogledaj ove mape `ls …`"),
        // a sistemski kanal je izmjeren na 100 % posluha naspram 38 % za prompt — bez ovoga
        // bi u PLAN modu jača uputa govorila „izvrši", a slabija „ne izvršavaj".
        const blokZaSlanje = currentMode === 'PLAN'
          ? `${blok}\n\n### PLAN MOD JE AKTIVAN — NADREĐEN SVEMU GORE\nOvo je plan-only sesija. Gornje upute govore ČIME raspolažeš, NE da to sada pokreneš.\nNE izvršavaj, ne mijenjaj datoteke, ne pokreći alate koji mijenjaju stanje — samo planiraj.`
          : blok
        if (isOpenRouter || isOllama || isKimiCli || isGeminiCli) prompt = `${blokZaSlanje}\n\n${prompt}`
        else identityArgs = ['--append-system-prompt', blokZaSlanje]
        log(`🪪 [identitet] ${agentId}: blok ${blok.length} zn. → ${identityArgs.length ? 'sistemski kanal' : 'prompt'}`)
      } else {
        log(`👁️ [identitet SHADOW] ${agentId}: blok ${blok.length} zn. spreman, NE šalje se (agentIdentityBlockLive=false)`)
      }
    } catch (e) { log(`⚠️ [identitet] ${agentId}: blok nije sastavljen (${e}) — spawn ide bez njega`) }
  }

  let memBlokZaTrajni: string | null = null
  // TASK-5124: Hindsight memorija (banka iz memorija.banka) po opisu zadatka. Spawn je sinkron,
  // pa blok ide iz keša po zadatku (data/memorija_kes/, ≤6 h). TASK-5292: u načinu `on` pozivatelj
  // prije spawna čeka dohvat (`pripremiMemorijuZaSpawn`, najviše memorija.rok_ms), pa blok ide već
  // pri prvom spawnu; bez memorije (istek, greška, globalni strop) → bilješka 🧠🚫 s razlogom i
  // ista oznaka na početku izvještaja. off = ništa; shadow = samo zapis u
  // data/memorija_upotreba.jsonl. Ovlasti su iz bloka uklonjene (ADR-0014).
  try {
    const memNacin = taskId ? memorijaNacin('agenti') : 'off'
    // Uputa #184: traženo `on` koje globalni prekidač spušta = rad bez memorije, ne tihi shadow.
    const memOgranicenje = taskId ? memorijaNacin.ogranicenje('agenti') : null
    if ((memNacin !== 'off' || memOgranicenje) && taskId) {
      const mem = memorijaAgentaSinkrono({ zadatak: taskId, agent: agentId, upit: memorijaUpit(taskId), nacin: memNacin, ogranicenje: memOgranicenje })
      if (mem.bezMemorije) {
        const biljeska = `${oznakaBezMemorije(mem.bezMemorije)} — ${agentId} radi BEZ memorije sustava (banka ${memorijaNacin.banka()})`
        log(`🧠🚫 [memorija] ${agentId}/${taskId}: ${mem.bezMemorije}`)
        fetch(`${TASK_MANAGER_API}/${taskId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ progressNotes: [biljeska] }) })
          .catch(e => log(`⚠️ [memorija] ${taskId}: bilješka 🧠🚫 nije upisana (${e})`))
      }
      if (mem.blok) {
        if (isOpenRouter || isOllama || isKimiCli || isGeminiCli) prompt = `${mem.blok}\n\n${prompt}`
        else {
          const i = identityArgs.indexOf('--append-system-prompt')
          if (i >= 0) identityArgs[i + 1] = `${identityArgs[i + 1]}\n\n${mem.blok}`
          else identityArgs = ['--append-system-prompt', mem.blok]
        }
        memBlokZaTrajni = mem.blok
        log(`🧠 [memorija ON] ${agentId}/${taskId}: blok ${mem.blok.length} zn. iz keša`)
      } else {
        log(`🧠 [memorija ${memNacin.toUpperCase()}] ${agentId}/${taskId}: dohvat u pozadini (blok ne ide${memNacin === 'on' ? ' — keš još nije spreman' : ''})`)
      }
    }
  } catch (e) { log(`⚠️ [memorija] ${agentId}: preskočeno (${e}) — spawn ide bez memorije`) }

  // ADR-0022 (TASK-5613): TRAJNA SESIJA. `--resume` zanemaruje `--append-system-prompt`
  // (ADR-0017), pa se na nastavku identitet NE šalje (već je u transkriptu), a ono što je po
  // ZADATKU (alati ADR-0016, memorija) ide omeđeno u korisnički kanal. Nova generacija dobiva
  // identitet normalno + predaju na početku prompta. PLAN prefiks ostaje prvi redak.
  const trajniLive = !!trajni && !!taskId && (trajni.put.put === 'resume' || trajni.put.put === 'nova')
    && target.provider === 'anthropic' && !compat
  const planPrefiks = `[SYSTEM MODE: PLAN] Ovo je plan-only sesija. NE izvrsavaj, samo planiraj.\n\n`
  const sPrefiksom = (p: string, umetak: string): string => !umetak ? p
    : p.startsWith(planPrefiks) ? `${planPrefiks}${umetak}\n\n${p.slice(planPrefiks.length)}` : `${umetak}\n\n${p}`
  // Za jedini ponovni pokušaj (No conversation found) treba naredba nove generacije.
  const identityZaNovu = identityArgs
  const promptZaNovu = trajniLive && trajni!.predaja ? sPrefiksom(prompt, trajni!.predaja) : prompt
  if (trajniLive) {
    if (trajni!.put.put === 'resume') {
      const alati = izdvojiAlatePoZadatku(identityArgs[1] || '')
      const umetak = [
        alati ? `[ALATI ZA OVAJ ZADATAK — trajna sesija]\n${alati}\n[/ALATI]` : '',
        memBlokZaTrajni || '',
      ].filter(Boolean).join('\n\n')
      prompt = sPrefiksom(prompt, umetak)
      identityArgs = []
    } else {
      prompt = promptZaNovu
    }
  }

  // ADR-0018 F1 (TASK-5134): ODABIR AGENTA u sjeni. Pri PRVOM spawnu zadatka (nema retka u
  // data/odabir_agenta.jsonl) računa „koga trebamo” (AgentSelection, čista funkcija), zapisuje redak i
  // jednu bilješku „🧭 Odabir …” na zadatak. U `shadow` NIŠTA ne mijenja: spawn ide s `agentId`, a lanac
  // gradi stari `createSequentialHelpers`. `on` (F2) tek nakon revizije 13.10. Prekidač settings
  // `odabir.nacin`, kvar = off. Nikad ne ruši spawn.
  try {
    const odNacin = taskId ? odabirNacin() : 'off'
    if (odNacin !== 'off' && taskId && !vecOdabrano(taskId)) {
      const z = zadatakIzRetka(readTaskRow(taskId))
      if (z) {
        const o = odaberiAgenta({ zadatak: z, registar: agentRegistry as any, teamChainLive: isEnabled('teamChainLive') })
        zapisiOdabir(o, odNacin, { spawnAgent: agentId, stariAssignee: z.assignee ?? null, createdBy: z.createdBy ?? null })
        const biljeska = formatBiljeska(o)
        fetch(`${TASK_MANAGER_API}/${taskId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ progressNotes: [biljeska] }) })
          .catch(e => log(`⚠️ [odabir] ${taskId}: bilješka nije upisana (${e})`))
        log(`🧭 [odabir ${odNacin.toUpperCase()}] ${taskId}: ${o.izvor}/${o.pouzdanost} primarni=${o.primarni} (spawn=${agentId}) lanac=[${o.lanac.map(l => `${l.agent}:${l.okidac}`).join(',')}]`)
      }
    }
  } catch (e) { log(`⚠️ [odabir] ${agentId}/${taskId}: preskočeno (${e})`) }

  const spawnKey = `${agentId}-${Date.now()}`
  const spawnInfo: AgentSpawnInfo = {
    agent: agentId,
    startTime: Date.now(),
    taskId,
    fromAgent,
    origin,
    pid: 0,
    lastCpuJiffies: 0,
    lastLivenessCheck: Date.now()
  }
  traka.set(spawnKey, spawnInfo)
  // A3/TASK-3002: čim spawn zauzme slot, zauzeo je i opseg datoteka. Zapisuje se za SVAKI
  // put (i onaj Goranov, koji vrata ne zaustavljaju) — nalog koji ne čeka i dalje mora
  // reći što drži, inače bi vrata odlučivala na nepotpunoj slici.
  // ADR-0024: voditelj ne uređuje datoteke (radnje izvodi daemon), pa ne drži opseg.
  if (!voditelj) spawnInfo.scopeClaim = registerScopeClaim(agentId, taskId)

  log(`🚀 Spawning agent ${agentId} (${model}) on-demand...`)

  // A1/TASK-3000: vidljivo i `finally` bloku i vanjskom catchu — izolirano stablo se mora
  // osloboditi po SVAKOM putu izlaska, inače napušteni worktreejevi jedu disk (98% pun).
  let workspace: SpawnWorkspace | null = null

  try {
    let cmdArgs: string[]
    // M6/TASK-4626: postavlja se SAMO na claude putu (drugi CLI-jevi nemaju transkript sesije).
    let spawnSessionId: string | null = null
    if (isOpenRouter) {
      const pf = join(HOME, `.tmp/or_prompt_${agentId}_${Date.now()}.txt`)
      writeFileSync(pf, prompt)
      cmdArgs = ['bun', OPENROUTER_AGENT_SCRIPT, '--model', model, '--prompt-file', pf]
    } else if (isOllama) {
      // R1: lokalni model s alatima (tool-loop). Prompt ide datotekom (dug je, izbjegava ARG_MAX).
      const pf = join(HOME, `.tmp/ol_prompt_${agentId}_${Date.now()}.txt`)
      writeFileSync(pf, prompt)
      cmdArgs = ['bun', OLLAMA_AGENT_SCRIPT, '--model', model, '--prompt-file', pf]
    } else if (isKimiCli) {
      // Kimi Code CLI: headless jedan-shot; koristi OAuth token iz ~/.kimi-code (prijava: `kimi login`, bez API ključa).
      cmdArgs = model ? ['kimi', '-p', prompt, '-m', model] : ['kimi', '-p', prompt]
    } else if (isGeminiCli) {
      // Gemini CLI (Google): headless; koristi GEMINI_API_KEY (AI Studio) — OAuth Code Assist je Google ukinuo.
      // --skip-trust: bez interaktivne "trusted directory" potvrde u headless spawnu.
      cmdArgs = model ? ['gemini', '--skip-trust', '--yolo', '-m', model, '-p', prompt] : ['gemini', '--skip-trust', '--yolo', '-p', prompt]
    } else {
      // K7/TASK-2986: `--output-format json` uz rezultat vraća i usage/cost/session_id/num_turns,
      // pa se potrošnja po zadatku zna ODMAH (cost_log + run_log.jsonl) umjesto naknadnog
      // kopanja po transkriptima. Rezultat je od sada u polju `result` — SVE parsiranje
      // ide na `envelope.resultText`, nikad više na sirovi stdout.
      // M6/TASK-4626: `--session-id` unaprijed određuje putanju transkripta
      // (~/.claude/projects/<slug cwd-a>/<sid>.jsonl), a CLI ga piše INKREMENTALNO — to je
      // jedini ŽIVI signal „je li model napravio ijedan korak". Bez njega se `num_turns`
      // saznaje tek na kraju runa (medijan neuspjeha 402 s, najduži 43 min).
      // ADR-0022: trajni nastavak ide `--resume <sid>`; sve ostalo (i prekidač off) ostaje `--session-id`.
      spawnSessionId = trajniLive && trajni!.put.put === 'resume' ? trajni!.put.sessionId : crypto.randomUUID()
      cmdArgs = ['claude', '--print', '--dangerously-skip-permissions', '--output-format', 'json', '--model', model, ...(trajniLive ? trajniArgumenti(trajni!.put, spawnSessionId) : ['--session-id', spawnSessionId]), ...(voditelj ? ['--max-turns', String(voditelj.maxTurns)] : []), ...identityArgs, '-p', prompt]
    }

    const spawnEnv: Record<string, string> = {
      // User-local CLI-jevi (gemini/kimi/node instalirani u ~/.local/node/bin) MORAJU biti na PATH-u
      // spawnanog procesa — inače daemon ne nađe `gemini`/`node` (systemd unit PATH ih ne uključuje).
      PATH: `${join(HOME, '.local/node/bin')}:${join(HOME, '.local/bin')}:${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}`,
      HOME,
      USER: process.env.USER || 'klaudio',
      SHELL: process.env.SHELL || '/bin/bash',
      TERM: 'xterm-256color',
      REGOC_AGENT_ID: agentId,
      BUN_INSTALL: process.env.BUN_INSTALL || join(HOME, '.bun'),
      CLAUDE_SUBAGENT: '1',
      CLAUDE_CODE_TMPDIR: join(HOME, '.tmp/claude-tmp'),  // Stop hook preskače voice za spawned agente
      GEMINI_CLI_TRUST_WORKSPACE: 'true',
    }
    // R1b/TASK-4431: PRIPIS UPISA U RAG KROZ OKOLINU. `lib/rag-metadata.ts` čita
    // REGOC_TASK_ID/REGOC_PROJECT_ID kao zamjenu za `--task`/`-p`, pa upis ostaje ispravan
    // i kad agent zaboravi zastavicu ili je prompt skraćen. Mjereno 04.09.2026.: 209 od 233
    // nova dokumenta (90 %) bilo je bez projekta jer ga spawn nikad nije prenio.
    if (taskId) spawnEnv.REGOC_TASK_ID = String(taskId)
    // TASK-5336: TMPDIR spawna → ~/app/tmp/zadaci/<taskId>/tmp (pravilo 26, ADR-0020 §3.1). Bez toga agent i
    // njegov `bun test` pišu u /tmp (tmpfs 100 MB); 07.10. pun → kritičar pada s ENOSPC.
    // §9.2 ADR-0020 (TASK-5408): mapa zadatka = TASK-<n>_<kratko-ime iz naslova>; postojeća mapa ima prednost.
    // TASK-5414: ista putanja ide i u prompt (uputaRadneMape) i kao REGOC_TASK_DIR (tmpOkolina).
    Object.assign(spawnEnv, tmpOkolina(radnaMapaSpawna(taskId ? String(taskId) : null, agentId)))
    try {
      const _prj = readTaskContext(taskId ?? null).projectId
      if (_prj) spawnEnv.REGOC_PROJECT_ID = _prj
    } catch { /* projekt nije obvezan za spawn — bez njega upis samo traži izričit -p */ }
    log(`🏷️ [RAG pripis] ${agentId}: REGOC_TASK_ID=${spawnEnv.REGOC_TASK_ID || '—'} REGOC_PROJECT_ID=${spawnEnv.REGOC_PROJECT_ID || '—'}`)
    // Ollama tool-loop: host (uklj. mesh '@node') prosljeđuje se runneru kroz OLLAMA_HOST.
    if (isOllama) spawnEnv.OLLAMA_HOST = resolveOllamaBaseUrl(target.node, agentId)
    // Gemini API key (AI Studio) iz credentials.env → geminicli radi bez mrtvog OAuth-a.
    // TASK-5705: zajednički čitač — zapis ploče paketa (`IME='…'`) ne smije doći s navodnicima.
    { const _g = procitajTajnuSpremista('GEMINI_API_KEY'); if (_g) spawnEnv.GEMINI_API_KEY = _g }
    if (compat) {
      // Preusmjeri claude CLI na anthropic-kompatibilni endpoint (Kimi/GLM/MiniMax/Qwen/DeepSeek).
      spawnEnv.ANTHROPIC_BASE_URL = compat.baseUrl
      spawnEnv.ANTHROPIC_AUTH_TOKEN = compat.token
      spawnEnv.ANTHROPIC_API_KEY = compat.token   // neki endpointi čitaju API_KEY umjesto AUTH_TOKEN
      log(`🔀 ${agentId} → ${target.provider} (${compat.baseUrl}) model=${model}`)
    }
    // K7: potrošnja sesije PRIJE spawna (keš hookova, bez mrežnog probea).
    const sessionPercentBefore = readSessionPercent()

    // A1/TASK-3000: `cwd` više nije bezuvjetno HOME — kad u istom stablu već radi drugi
    // spawn, ovaj dobiva vlastiti git worktree (dok je mehanizam ugašen, ovo vraća HOME).
    // ADR-0022: trajna sesija radi u glavnom stablu iz pokazivača — izolirani worktree bi
    // promijenio cwd i `--resume` bi završio s `No conversation found` (petlja je zato čekala).
    // ADR-0024: voditelj ima stalni cwd (svoja sesija, bez izolacije i bez worktreeja).
    workspace = voditelj ? { cwd: voditelj.cwd, workTree: voditelj.cwd }
      : trajniLive ? { cwd: trajni!.stablo, workTree: trajni!.stablo } : prepareSpawnWorkspace(agentId, taskId)
    spawnInfo.workTree = workspace.workTree
    spawnInfo.worktree = workspace.worktree

    // TASK-5362: dežurni (rezervni model) iz paketa TaskManagerAI — samo claude CLI bez
    // preusmjerenja. Simulacija pada s ploče: primarni se ne zove, „pada" s 429 kao pravi.
    const dezurniMost = cmdArgs[0] === 'claude' && !compat && isEnabled('dezurniSpawn') ? ucitajDezurnog(log) : null
    const simuliranPad = !!dezurniMost?.simulacija()
    if (simuliranPad) log(`🔻 [dežurni] ${agentId} ${taskId || ''}: SIMULACIJA pada primarnog s ploče — primarni ${model} se ne poziva`)
    const proc = Bun.spawn(simuliranPad ? SIMULIRANI_PAD_CMD : cmdArgs, {
      cwd: workspace.cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      env: spawnEnv
    })

    // Zabilježi PID i CPU baseline za liveness watchdog
    spawnInfo.pid = proc.pid
    // ADR-0012 §14 (G3): najam se uzima TOČNO OVDJE, ne uz `activeAgentSpawns.set` — ondje
    // je `pid: 0`, a `najamAktivan()` traži živ PID (platforma.ziv). Najam s pidom 0 bi bio mrtav
    // kod koji uredno stoji u features.json i nikad ne odbije nijedan PUT.
    if (taskId) uzmiNajam({ taskId, agent: agentId, pid: proc.pid, startedAt: new Date().toISOString() })
    // ADR-0024 O3: rok buđenja voditelja (zadano 15 min) — prekid je NAŠ (killedBy), zadatak ostaje in_progress.
    const rokVoditelja = voditelj ? setTimeout(() => {
      try {
        if (!spawnInfo.pid || !isRunning(spawnInfo.pid)) return
        spawnInfo.killedBy = { reason: `rok buđenja voditelja ${Math.round(voditelj.rokMs / 60_000)} min`, by: 'voditelj-rok', at: Date.now() }
        log(`⏱️ [voditelj] ${taskId}: rok buđenja istekao — SIGTERM pid ${spawnInfo.pid}`)
        process.kill(spawnInfo.pid, 'SIGTERM')
      } catch (e) { log(`⚠️ [voditelj] ${taskId}: prekid po roku nije uspio (${e})`) }
    }, voditelj.rokMs) : null
    // ADR-0022: brava sesije — u datoteci, ne u memoriji, pa preživi restart daemona.
    const zauzmiTrajnu = (pid: number, sid: string): void => {
      try {
        const st = procStarttime(pid) ?? 0
        // ADR-0024 O1: vlastiti ključ (voditelj lanca) putuje u pokazivač — inače bi zapis pao pod ključ obične Kosjenke.
        const vlastitiKljuc = trajni!.kljuc !== kljucPokazivaca(agentId, trajni!.stablo, trajni!.model) ? trajni!.kljuc : undefined
        zapisiPokazivac(trajneSesijeDir(), zauzmiPokazivac(citajPokazivac(trajneSesijeDir(), trajni!.kljuc), trajni!.put,
          { agent: agentId, stablo: trajni!.stablo, model: trajni!.model, sessionId: sid, taskId: String(taskId), pid, starttime: st, now: Date.now(), kljuc: vlastitiKljuc }))
      } catch (e) { log(`⚠️ [trajni] ${taskId}: brava sesije nije zapisana (${e})`) }
    }
    if (trajniLive && spawnSessionId) {
      zauzmiTrajnu(proc.pid, spawnSessionId)
      log(`🧷 [trajni] ${taskId} → ${agentId}: ${opisTrajnogPuta(trajni!.put)} sid=${kratkiSid(spawnSessionId)} pid=${proc.pid} cwd=${workspace.cwd}`)
    }
    spawnInfo.lastCpuJiffies = Math.max(0, readProcCpuJiffies(proc.pid))
    // D3/TASK-2955: naredba (bez prompta) ide u dijagnostički dump ako spawn padne
    spawnInfo.cmdRedacted = redactSpawnCmd(cmdArgs)
    log(`   ↳ ${agentId} pid=${proc.pid} ppid=${process.pid} cmd=${cmdArgs[0]} model=${model}`)

    // ── M6/TASK-4626: rana provjera „ima li uopće posla" ────────────────────────────────
    // Nalaz (docs/ISTRAZIVANJE-neuspjesi-i-greske.md §4 M6): medijan NEUSPJELOG izvođenja je
    // 402 s, najduži 2 588 s, a u incidentu 02.09. svih 683 spawnova imalo je `num_turns=0`.
    // Sonda broji retke `type:"assistant"` u živom transkriptu; 0 koraka nakon 30 s = nema
    // posla. FAIL-OPEN: bez transkripta se NIKAD ne prekida (kriterij „nijedan uspješan
    // spawn nije prekinut"). Cijela grana je fire-and-forget — ne dira `await` lanac ispod.
    let earlyWork: { verdict: EarlyWorkVerdict; steps: number | null; elapsedS: number } | null = null
    let earlyWorkLogged = false
    const earlyWorkLive = isEnabled('earlyWorkGuardLive', false)
    const logEarlyWork = (finalNumTurns: number | null): void => {
      if (!earlyWork || earlyWorkLogged) return
      if (earlyWork.verdict.action !== 'abort' && earlyWork.verdict.action !== 'giveup') return
      earlyWorkLogged = true
      recordEarlyWork({
        ts: new Date().toISOString(),
        mode: earlyWorkLive ? 'live' : 'shadow',
        agent: agentId,
        task_id: taskId ?? null,
        session_id: spawnSessionId,
        pid: proc.pid,
        elapsed_s: earlyWork.elapsedS,
        model_steps: earlyWork.steps,
        action: earlyWork.verdict.action,
        reason: earlyWork.verdict.reason,
        // U SJENI je ovo mjerilo LAŽNOG prekida: >0 znači da bi živa sonda ubila spawn
        // koji je ipak radio. Prihvatni kriterij traži 0 takvih kroz 7 dana.
        final_num_turns: finalNumTurns,
      })
    }
    if (spawnSessionId && isEnabled('earlyWorkGuard', false)) {
      const ewStartedAt = Date.now()
      const ewSid = spawnSessionId
      const ewTranscript = () => transcriptPathForSession(workspace.cwd, ewSid)
      void (async () => {
        const verdict = await watchEarlyWork({
          now: () => Date.now(),
          sleep: (ms) => new Promise(r => setTimeout(r, ms)),
          countSteps: () => countModelSteps(ewTranscript()),
          // signal 0 ne šalje ništa, samo pita postoji li proces
          isAlive: () => { try { process.kill(proc.pid, 0); return true } catch { return false } },
        }, { startedAtMs: ewStartedAt })
        earlyWork = {
          verdict,
          steps: countModelSteps(ewTranscript()),
          elapsedS: Math.round((Date.now() - ewStartedAt) / 1000),
        }
        if (verdict.action === 'abort') {
          if (earlyWorkLive) {
            log(`⛔ [M6] ${agentId}: ${verdict.reason} — prekidam spawn pid=${proc.pid} nakon ${earlyWork.elapsedS}s`)
            // Zapis IDE PRIJE ubijanja: ubijeni run nema `num_turns` pa ga završni put ne bi imao čime dopuniti.
            logEarlyWork(null)
            // `pauza=true` — spawn nije napravio ništa, pa zadatak ostaje u zatečenom
            // stanju i nastavlja se poslije; ovo NIJE otkazivanje (pravilo 17).
            killAgentSpawn(spawnInfo, agentRegistry?.agents[agentId]?.name || agentId,
              `M6 NO_WORK_30S: ${verdict.reason}`, 'early-work-guard', true)
          } else {
            log(`👁️ [M6 SHADOW] ${agentId}: ${verdict.reason} — spawn bi bio prekinut nakon ${earlyWork.elapsedS}s (earlyWorkGuardLive=false)`)
          }
        }
      })().catch(e => log(`⚠️ [M6] ${agentId}: sonda pala (${e}) — spawn nastavlja nedirnut`))
    }


    // Handle completion asynchronously (fire-and-forget)
    // K7: telemetrija se puni ovdje, a zapisuje u `finally` — točno JEDAN redak po spawnu,
    // bez obzira je li run završio, blokiran, pao ili se raspao u handleru.
    let runOutcome: RunOutcome = 'failed'
    let runEnvelope: SpawnEnvelope = parseSpawnOutput('')
    let runExitCode: number | null = null
    let sessionPercentAfter: number | null = null
    let telemetryNote: string | undefined

    ;(async () => {
      try {
        // 2026-06-17: Nema tvrdog timeouta — agent radi do završetka zadatka.
        // Liveness watchdog (svaka 2h) gasi SAMO ako je zaglavljen ili pređe 24h strop.
        // TASK-3087: stderr se ČITA UŽIVO i svaki korak agenta ide u log (→ konzola).
        // Prije se čekao kraj spawna pa se sve gutalo odjednom: na ploči je stajalo
        // „radi…" i po nekoliko minuta bez ijednog traga, iako agent u međuvremenu piše
        // datoteke i vrti alate. Sada se vidi tijek rada, korak po korak.
        const stdoutP = new Response(proc.stdout).text()
        const stderrP = (async () => {
          let acc = ''
          try {
            const dec = new TextDecoder()
            let carry = ''
            for await (const chunk of proc.stderr as any) {
              const piece = typeof chunk === 'string' ? chunk : dec.decode(chunk, { stream: true })
              acc += piece
              carry += piece
              const lines = carry.split('\n')
              carry = lines.pop() ?? ''
              for (const raw of lines) {
                const line = raw.trim()
                if (!line) continue
                // Zanimljivi su koraci alata i završni sažetak; ostalo bi zatrpalo konzolu.
                const m = /\[(?:openrouter|ollama)-agent\]\s+(tool #\d+:.*|DONE .*|MAX_ITERS.*|pred-injektiran.*)/.exec(line)
                if (m) log(`     ⋯ ${agentId}: ${m[1].slice(0, 220)}`)
              }
            }
            if (carry.trim()) acc += ''
          } catch { /* stream može pući na gašenju — sadržaj do tada je sačuvan */ }
          return acc
        })()
        let stdout = await stdoutP
        let stderr = await stderrP
        let exitCode = await proc.exited
        if (taskId) zatvaranjeSpawna.zapocni(String(taskId))
        // TASK-5362: primarni pao (429/401/limit/nedostupan) → isti agent, isti prompt, na
        // dežurnom modelu kroz isti claude CLI (ANTHROPIC_BASE_URL); ostatak puta (vratar,
        // kritičar, report-back) vidi izlaz dežurnog kao da je primarnog.
        if (dezurniMost) {
          const pad = padSpawna(dezurniMost, exitCode, parseSpawnOutput(stdout).isError, stdout, stderr)
          if (pad) {
            dezurniMost.greska()
            const cilj = dezurniMost.cilj()
            const uzrok = `${simuliranPad ? 'SIMULIRAN pad' : pad.vrsta}: ${pad.razlog}`
            if (!cilj) {
              log(`🔻 [dežurni] ${agentId} ${taskId || ''}: primarni model pao (${uzrok}) — dežurni nema put kroz claude CLI (davatelj bez Anthropic-kompatibilnog endpointa ili ključa)`)
            } else {
              spawnSessionId = crypto.randomUUID()
              const args2 = argumentiDezurnog(cmdArgs, cilj.model, spawnSessionId)
              log(`🔻 [dežurni] ${agentId} ${taskId || ''}: primarni model pao (${uzrok}) — ponavljam na dežurnom ${cilj.spec}`)
              const p2 = Bun.spawn(args2, { cwd: workspace?.cwd || HOME, stdout: 'pipe', stderr: 'pipe', env: okolinaDezurnog(spawnEnv, cilj.env) })
              spawnInfo.pid = p2.pid
              spawnInfo.lastCpuJiffies = Math.max(0, readProcCpuJiffies(p2.pid))
              spawnInfo.cmdRedacted = redactSpawnCmd(args2)
              if (taskId) uzmiNajam({ taskId, agent: agentId, pid: p2.pid, startedAt: new Date().toISOString() })
              const [o2, e2] = await Promise.all([new Response(p2.stdout).text(), new Response(p2.stderr).text()])
              const x2 = await p2.exited
              stdout = o2; stderr = e2; exitCode = x2
              const env2 = parseSpawnOutput(o2)
              const ok = x2 === 0 && !env2.isError
              const razlog2 = ok ? '' : `: ${String(env2.resultText || e2 || '').replace(/\s+/g, ' ').trim().slice(0, 160)}`
              log(`🔻 [dežurni] ${agentId} ${taskId || ''}: dežurni ${cilj.spec} ${ok ? 'završio' : `NIJE uspio (exit ${x2}${razlog2})`}`)
              if (taskId) {
                try {
                  await fetch(`${TASK_MANAGER_API}/${taskId}`, {
                    method: 'PUT', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ progressNotes: [ok
                      ? `🔻 Primarni model ${model} pao (${uzrok}) — agent ${agentId} završio preko dežurnog ${cilj.spec}`
                      : `🔻 Primarni model ${model} pao (${uzrok}), a ni dežurni ${cilj.spec} nije uspio (exit ${x2}${razlog2})`] }),
                  })
                } catch {}
              }
            }
          } else if (exitCode === 0) {
            dezurniMost.uspjeh()
          }
        }
        // ADR-0022: `--resume` bez transkripta (nestao, drugi cwd, pokvaren) → TOČNO JEDAN
        // ponovni spawn istog zadatka kao nova generacija + predaja. Prvi proces je već mrtav
        // (čekali smo ga), pa nema dvostrukog izvođenja; drugi neuspjeh je običan kvar spawna.
        if (trajniLive && trajni!.put.put === 'resume' && nemaRazgovora(`${stdout}\n${stderr}`)) {
          const stariSid = trajni!.put.sessionId
          try {
            const pk = citajPokazivac(trajneSesijeDir(), trajni!.kljuc)
            if (pk && pk !== 'pokvaren') zapisiPokazivac(trajneSesijeDir(), { ...umirovi(pk, 'No conversation found', Date.now()), zauzeta: null })
          } catch {}
          trajni!.put = { put: 'nova', gen: trajni!.put.gen + 1, razlog: 'No conversation found' }
          spawnSessionId = crypto.randomUUID()
          const args3 = ['claude', '--print', '--dangerously-skip-permissions', '--output-format', 'json', '--model', model, '--session-id', spawnSessionId, ...identityZaNovu, '-p', promptZaNovu]
          log(`♻️ [trajni] ${taskId} → ${agentId}: --resume ${kratkiSid(stariSid)} nije uspio (No conversation found) — nova generacija ${kratkiSid(spawnSessionId)} + predaja`)
          const p3 = Bun.spawn(args3, { cwd: workspace?.cwd || HOME, stdout: 'pipe', stderr: 'pipe', env: spawnEnv })
          spawnInfo.pid = p3.pid
          spawnInfo.lastCpuJiffies = Math.max(0, readProcCpuJiffies(p3.pid))
          spawnInfo.cmdRedacted = redactSpawnCmd(args3)
          if (taskId) uzmiNajam({ taskId, agent: agentId, pid: p3.pid, startedAt: new Date().toISOString() })
          zauzmiTrajnu(p3.pid, spawnSessionId)
          const [o3, e3] = await Promise.all([new Response(p3.stdout).text(), new Response(p3.stderr).text()])
          stdout = o3; stderr = e3; exitCode = await p3.exited
        }
        runExitCode = exitCode
        sessionPercentAfter = readSessionPercent()

        // JSON omotnica `claude --print --output-format json`; ne-JSON izlaz (kimi/gemini/
        // ollama runner, poruka greške) pada na sirovi tekst — stari put ostaje netaknut.
        const envelope = parseSpawnOutput(stdout)
        runEnvelope = envelope
        // M6/TASK-4626: sad je `num_turns` poznat — zatvara redak sonde (mjerilo lažnih prekida).
        logEarlyWork(envelope.numTurns ?? null)
        const resultText = envelope.resultText
        // ADR-0024 O3: kraj buđenja voditelja ide SVOJIM putem — voditelj je in_progress dok lanac nije
        // gotov, pa ga vratar/kritičar/blokada ne smiju zatvoriti nakon svakog buđenja. Jedino
        // 'zatvaranje' (model kaže DONE i lanac je stvarno gotov) ide normalnim putem kroz kritičara.
        if (voditelj) {
          if (rokVoditelja) clearTimeout(rokVoditelja)
          let ishod: 'nastavak' | 'zatvaranje' = 'nastavak'
          try { ishod = await voditelj.naKraju({ resultText: String(resultText || ''), exitCode, killedBy: spawnInfo.killedBy }) }
          catch (e) { log(`⚠️ [voditelj] ${taskId}: kraj buđenja pao (${e}) — voditelj ostaje in_progress`) }
          if (ishod === 'nastavak') {
            runOutcome = exitCode === 0 ? 'completed' : 'failed'
            log(`🧭 [voditelj] ${taskId}: buđenje završeno (exit ${exitCode}${spawnInfo.killedBy ? `, ${spawnInfo.killedBy.reason}` : ''}) — voditelj nastavlja`)
            return
          }
          log(`🏁 [voditelj] ${taskId}: lanac gotov — zatvaranje normalnim putem (vratar + kritičar)`)
        }
        if (!envelope.parsed && !isOpenRouter && !isOllama && !isKimiCli && !isGeminiCli) {
          telemetryNote = `bez JSON omotnice (${envelope.parseNote || 'nepoznato'})`
          log(`⚠️ Agent ${agentId}: izlaz nije JSON omotnica (${envelope.parseNote || 'nepoznato'}) — telemetrija bez tokena, parsiranje po starom.`)
        }

        const db = getDb()
        const agentName = agentRegistry?.agents[agentId]?.name || agentId

        // TASK-2953: exit 0 NIJE dokaz uspjeha. Kad hook (npr. session_usage.py na
        // UserPromptSubmit) blokira ulaz, claude CLI ispiše poruku blokade i izađe s 0 —
        // agent nije napisao ni jedan token. Ranije je ta poruka završavala u
        // result_summary uz status=completed (lažni DONE: TASK-2561/2583/2950).
        const { classifySpawnOutcome } = await import('./HookBlockGuard')
        // `num_turns` iz omotnice: 0 = CLI nije napravio nijedan modelski korak → blokada,
        // iako exit kod i `subtype` izgledaju kao uspjeh.
        const outcome = classifySpawnOutcome(exitCode, resultText, stderr, { numTurns: envelope.numTurns })

        if (outcome.kind === 'blocked') {
          runOutcome = 'blocked'
          const blk = outcome.block
          log(`⛔ Agent ${agentId} zaustavljen na ULAZU (${blk.code}, hook=${blk.hookEvent}) — task ${taskId || 'N/A'} NIJE odrađen: ${blk.reason}`)

          // Backoff se NE resetira (spawn nije uspio). Session-budget blokada traje do
          // resetiranja sesije, pa bi bez backoffa daemon mlatio istu blokadu u petlji.
          // DUR-5/TASK-3597: blokada ULAZA je odbijenica — CLI je izasao s 0, ali model
          // nije napravio ni jedan korak. Isti ulaz pada isto dok se sesija ne obnovi.
          getSpawnBreaker().recordFailure(agentId, 'rejected', `hook ${blk.code}${blk.hookEvent ? `/${blk.hookEvent}` : ''}`)
          const bt = agentFailureTracker.get(agentId) || { count: 0, lastFail: 0, backoffUntil: 0 }
          bt.count++
          bt.lastFail = Date.now()
          // DUR-5/TASK-3597: isti eksponencijalni rast, ali RASPRSEN — bez jittera se tri
          // radnika koja padnu na istom limitu vracaju u istoj sekundi i obore ga ponovno.
          bt.backoffUntil = Date.now() + jitteredBackoff(bt.count)
          agentFailureTracker.set(agentId, bt)

          // Pravilo #8: blokada = BLOCKED (+ strojni blocked_reason), nikad DONE.
          // Poruka blokade ide u progress_notes kao trag, NIKAD u result_summary.
          if (taskId) {
            try {
              await fetch(`${TASK_MANAGER_API}/${taskId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(outcome.taskUpdate),
              })
            } catch {}
          }

          // Notifikacija nosi SAMO kratak razlog — CLI uz blokadu vraća cijeli prompt,
          // a njegovo prosljeđivanje je vektor echo-petlje (usp. DispatchGuard).
          sendResponse(db, fromAgent,
            `⛔ **${agentName}** — zadatak${taskId ? ` ${taskId}` : ''} nije ni započet: ${blk.reason}`, 4, origin)

          logEvent(db, 'agent_task_blocked', agentId, `Task ${taskId}: ${blk.code} (hook=${blk.hookEvent})`)
          db.close()
          return
        }

        if (exitCode === 0) {
          log(`✅ Agent ${agentId} completed task ${taskId || 'N/A'}`)

          // DUR-5/TASK-3597: uspjesan spawn dokazuje da racun radi → niz uzastopnih
          // odbijenica se brise (agentov I globalni osigurac).
          getSpawnBreaker().recordSuccess(agentId)

          // F6 (TASK-2549): Reset backoff na uspjeh
          const successTracker = agentFailureTracker.get(agentId)
          if (successTracker && successTracker.count > 0) {
            log(`🔄 Agent ${agentId} backoff resetiran (bio fail #${successTracker.count})`)
            successTracker.count = 0
            successTracker.backoffUntil = 0
          }

          // TASK-2954 (D2): exitCode === 0 NIJE dokaz da je posao napravljen.
          // Agent koji napiše "ne mogu, nemam pristup alatima" uredno izlazi s 0, pa je
          // ovaj put zatvarao neizvršene zadatke kao ✅ (dokazi: TASK-329/330/338).
          // Sada odlučuje SADRŽAJ rezultata: bez dokaza izvršenja → blocked s razlogom.
          // Rollout: isti shadow prekidač kao na API-ju (config/completion-gate.json).
          // U shadowu se heuristički sud SAMO logira ("BIH blokirala …") i status se
          // piše po starom; agentova vlastita REGOC-STATUS deklaracija provodi se odmah.
          // W3b/TASK-4879: spawn-put — prompt je nosio blok sheme, pa izuzeća ne vrijede.
          let verdict = evaluateCompletion(resultText, { izvor: 'agent' })
          const enforceVerdict = shouldEnforce(verdict)
          log(`${formatVerdictLog(verdict)} (task ${taskId || 'N/A'}, agent ${agentId})${verdict.accept ? '' : ` — ${enforceVerdict ? 'BLOKIRAM' : 'SHADOW'}`}`)
          if (!verdict.accept && !enforceVerdict) log(formatShadowLog(taskId || 'N/A', verdict))
          // W3/TASK-4615: sud o strukturiranom izlazu ide u dnevnik i kad ne mijenja ishod —
          // bez tog retka se udio strojno provjerljivog dokaza ne bi imalo po čemu mjeriti.
          if (verdict.stepSchema) log(`${formatSudKoraka(verdict.stepSchema)} (task ${taskId || 'N/A'}, agent ${agentId})`)
          // W5/TASK-4618: adversarijalna provjera nalaza. Pokreće se ODVOJENIM procesom i NE
          // čeka se: tri leće × do osam nalaza je do 24 poziva modela (mjereno ~13 s po pozivu),
          // a taj bi rok stajao na putu zatvaranja zadatka i serijalizirao daemon. Uz `off`
          // (zadano) ne pokreće se ništa — put je bajt-identičan onome prije W5.
          if (taskId) pokreniAdversarijalnuProvjeru(taskId)
          let treatAsDone = verdict.accept || !enforceVerdict

          // A2/TASK-3001: nezavisni kritičar. `CompletionGuard` gore sudi o TEKSTU
          // izvještaja; ovdje netko drugi POKREĆE provjere nad onim što je ostalo na
          // disku (bun build / bun test / JSON parse) i izvještaj ne ulazi u sud.
          // Kvar od 28.07. (sintaksna greška u isporučenom kodu uz ✅ na ploči) ovaj
          // put pada na `parse` provjeri u ~85 ms i bez ijednog tokena.
          // Rollout: criticGate = promatranje (samo log), criticGateLive = provodi se.
          let criticBlockReason = ''
          let criticBrief = ''
          /** E1/TASK-4787: koliko je provjera kritičar STVARNO pokrenuo (bez preskočenih). */
          let criticChecksRun = 0
          let criticChecksFailed = 0
          /** Od toga onih koje je propisao SAM ZADATAK (`[PROVJERA] cmd:`). */
          let criticDeclaredRun = 0
          /** W4: zadatak je VEĆ vraćen u `pending` — stari `blocked` bi to poništio. */
          let criticRepairHandled = false
          /** W4: poruka korisniku (vraćen na popravak / eskaliran); `null` = nema je. */
          let criticRepairMessage: string | null = null
          /** TASK-5548: sud kritičara za oznaku „neprovjereno” u dojavi naloga iz razgovora. */
          let criticStatusZaDojavu: CriticStatus | null = null
          if (isEnabled('criticGate')) {
            const criticLive = isEnabled('criticGateLive')
            // Opis se čita JEDNOM: iz njega izlaze i propisane naredbe i traženi odsjeci i
            // usporedba „dokument = preslika opisa". Dva čitanja iste baze ovdje bi značila
            // dvije istine ako se opis u međuvremenu doradi.
            const taskCtxForCritic = readTaskContext(taskId)
            try {
              const critique = await critiqueSpawnAsync({
                taskId,
                agentId,
                sinceMs: spawnInfo.startTime,
                resultText,
                live: criticLive,
                // Koliko DRUGIH spawnova još piše u isto stablo. Dok ih ima, granica po
                // mtimeu ne razlikuje njegovo od tuđeg (nedovršenog) posla, pa kritičar
                // kvar prijavljuje ali ne blokira. Čistu atribuciju vraća A1.
                concurrentSpawns: [...activeAgentSpawns.values()]
                  .filter((i) => i !== spawnInfo && (i.workTree || HOME) === (spawnInfo.workTree || HOME))
                  .length,
                // A4 dopuna/TASK-3052: kad je spawn izoliran, njegov je rad U WORKTREEJU,
                // a `watchRoots` pokriva samo ~/.claude/regoc — kritičar bi inače sudio o
                // nula datoteka koje se spajaju i A4 bi ga zaustavio kao `scope-mismatch`.
                // Šalje se TOČNO stablo ovog spawna (nikad korijen svih worktreejeva), uz
                // granicu na kraju checkouta da checkout ne ispadne agentova izmjena.
                // 26.08.2026: isto vrijedi i kad izolacije NEMA, a spawn ipak radi u
                // mapiranom repozitoriju projekta (`projectRepos`) umjesto u $HOME —
                // kritičar bi inače sudio o nula datoteka i sud bi ispao `unverifiable`.
                // Šalje se točno stablo ovog spawna; tuđe istovremeno pisanje već pokriva
                // `concurrentSpawns` (prijavi, ne blokiraj).
                extraRoots: workspace?.worktree && workspace.worktreeReadyAtMs
                  ? [{ path: workspace.worktree.worktreePath, sinceMs: workspace.worktreeReadyAtMs, vlastiti: true }]
                  : workspace?.workTree && workspace.workTree !== HOME
                    ? [{ path: workspace.workTree, sinceMs: workspace.startedAtMs ?? spawnInfo.startTime }]
                    : undefined,
                // TASK-3460: provjera koju je propisao SAM ZADATAK (`[PROVJERA] cmd:`).
                // Bez nje `pass` za Python projekt znači samo „datoteka se raščlanjuje", a
                // uz `auto-on-signoff` bi se takav rad spojio sam. Opis se čita SADA (a ne
                // pri spawnu) jer se u međuvremenu mogao doraditi.
                declared: taskCtxForCritic.declared,
                // TASK-4833/4834: opis ide i u doc-provjeru, i to u JEDNO pravilo —
                // „dokument je uglavnom preslika opisa zadatka". Nikad se ne izvršava.
                ...(taskCtxForCritic.description ? { taskDescription: taskCtxForCritic.description } : {}),
                // Stablo unutar kojeg se `cwd` propisane provjere smije razriješiti.
                rootDir: workspace?.cwd || workspace?.workTree || HOME,
                // TASK-5235: transkript OVOG spawna → kritičar zna što je spawn stvarno dirao
                // i ne pokreće tuđe testove ni snimke koda u docs/ (opsegMode u critic-gate.json).
                ...(spawnSessionId ? { spawnSessionId } : {}),
              })
              // E1/TASK-4787: broji se ono što je STVARNO izvedeno — preskočena provjera
              // (potrošen rok) nije dokaz, a `unverifiable` sud nastaje upravo iz nule.
              criticChecksRun = critique.verdict.checks.filter((c) => !c.skipped && c.exitCode !== null).length
              criticChecksFailed = critique.verdict.failed.length
              criticStatusZaDojavu = critique.verdict.status
              criticDeclaredRun = critique.verdict.checks.filter(
                (c) => c.kind === 'task' && !c.skipped && c.exitCode !== null).length
              log(formatCritiqueLog(taskId, critique, criticLive))
              if (critique.verdict.status === 'fail') log(formatRepairBrief(critique))
              // A4/TASK-3003: sud kritičara je JEDINI strojni potpis. Zapisuje se i kad
              // kritičar radi u promatranju — vrata ga tada samo ne provode. Potpis se
              // nikad ne čita iz agentova teksta; nastaje ovdje, u procesu koji je sam
              // pokrenuo provjere.
              if (workspace) workspace.signoff = signoffFromCritique(critique)
              // T10/TASK-3575: sud koji nije ništa provjerio više ne prolazi tiho. Ne
              // blokira — samo se prijavljuje, s ID-om zadatka, agentom, troškom i
              // popisom onoga što je NEDOSTAJALO.
              reportUnverifiedCritique(db, {
                taskId,
                agentId,
                status: critique.verdict.status,
                reasons: critique.reasons,
                // Trošak je poznat već ovdje (JSON omotnica CLI-ja); `recordSpawn` u
                // `finally` bloku radi tek kasnije, a dojava bez cijene ne govori koliko
                // je neprovjerenog rada plaćeno.
                costUsd: envelope.costUsd ?? null,
                durationS: Math.round((Date.now() - spawnInfo.startTime) / 1000),
                live: criticLive,
                // TASK-4833/4834 §5.3: kad je L0/L1 prošao, dojava više NE SMIJE tvrditi da
                // vratar nije provjerio ništa — imenuje razinu i ono što NIJE provjereno.
                razina: critique.verdict.razina,
                docChecked: critique.verdict.docChecked,
              })
              // §5.3 u sjeni: što BI se propisalo kao `[PROVJERA] odjeljci:` da je
              // izvlačenje živo. Samo dnevnik — opis zadatka se ne dira dok se ne izmjeri.
              if (taskCtxForCritic.description) {
                const bi = buildDocCheckDeclaration(taskCtxForCritic.description)
                if (bi) log(`  [doc-sjena] ${taskId}: iz zahtjeva bih propisao → ${bi}`)
              }
              if (critique.enforce) {
                treatAsDone = false
                criticBlockReason = critique.blockedReason
                criticBrief = formatRepairBrief(critique)

                // W4/TASK-4617: EVALUATOR–OPTIMIZER. Sud je već razlikovao `repair` od
                // `escalate`, ali su oba završavala u `blocked` — dakle jednako. Sada
                // `repair` VRAĆA korak izvođaču s nalazom (oznaka `kritika:<n>` + nalaz
                // koji `criticRepairTail` ubacuje u prompt sljedećeg prolaza), a
                // `escalate` ostaje `blocked`, ali s porukom koja nosi ID zadatka.
                if (isEnabled('criticRepairLoop', false)) {
                  const petlja = await returnStepForRepair(
                    {
                      agent: agentId, agentName, taskId,
                      action: critique.loop.action,
                      round: critique.loop.round,
                      brief: criticBrief,
                      sazetak: critique.verdict.reason.slice(0, 200),
                      signatures: critique.verdict.signatures,
                    },
                    { live: isEnabled('criticRepairLoopLive', false), maxRounds: loadCriticConfig().maxRounds },
                    criticRepairDeps(),
                  )
                  // `handled` = zadatak je VEĆ vraćen u `pending`; stari `blocked` bi to
                  // odmah poništio (isti ugovor kao R7 `requeue.handled`).
                  if (petlja.handled) criticRepairHandled = true
                  criticRepairMessage = petlja.userMessage
                }
              } else if (taskId && critique.verdict.status !== 'fail') {
                // Korak je prošao ⇒ nalaz iz prethodnog kruga više ne vrijedi. Bez ovoga bi
                // ustajali nalaz čekao na disku i sljedeći nevezani prolaz istog zadatka
                // dobio uputu da popravlja kvar kojega više nema.
                clearRepairBrief(taskId)
              }
            } catch (e) {
              // Kvar u kritičaru ne smije zaustaviti ploču: fail-open na VLASTITU grešku,
              // fail-closed samo na tuđi dokazani kvar.
              log(`⚠️ [critic] kritika pala (${agentId}/${taskId || 'bez-zadatka'}) — ne blokiram: ${e}`)
            }
          }

          // E1/TASK-4787: SLOJ IZVRŠITELJA. Sud o tekstu (gore) i sud kritičara (gore) mjere
          // OBLIK izvještaja i stanje repozitorija; nijedan ne zna TKO je pisao. Na node-A
          // je 09.09.2026. qwen3:8b zatvorio TASK-152 kao ✅ s izvještajem „datoteka sadrži
          // izlaz uname -a", dok je u datoteci stajao literal `$(uname -a)`; oba su vratara
          // rekla da je u redu (ACCEPT conf=heuristic evidence=2 / UNVERIFIABLE checks=0).
          // Rezultat nepovjerljivog izvršitelja od sada treba bar JEDNU provjeru koju je
          // pokrenuo netko drugi. Rollout: config/completion-gate.json → localExecutorStrictLive.
          if (treatAsDone && verdict.accept) {
            const localVerdict = evaluateLocalExecutor(verdict, {
              provider: target.provider,
              checksRun: criticChecksRun,
              checksFailed: criticChecksFailed,
              declaredChecksRun: criticDeclaredRun,
              declaredPresent: !!readTaskContext(taskId ?? null).declared?.present,
            })
            if (!localVerdict.accept) {
              const enforceLocal = shouldEnforce(localVerdict)
              log(`${formatVerdictLog(localVerdict)} (task ${taskId || 'N/A'}, agent ${agentId}, provider ${target.provider}) — ${enforceLocal ? 'BLOKIRAM' : 'SHADOW'}`)
              if (!enforceLocal) log(formatShadowLog(taskId || 'N/A', localVerdict))
              if (enforceLocal) {
                treatAsDone = false
                // Zamjenom suda i poruka i blocked_reason niže govore ISTI razlog —
                // inače bi ploča pisala „ok" uz zadatak koji nije zatvoren (TASK-4724).
                verdict = localVerdict
              }
            }
          }

          // P3/TASK-2569 s6: strojni verifikacijski gate — POSLJEDNJA provjera prije
          // completed. Odluka (OFF/SHADOW/LIVE) je u evaluateVerificationGate() (v. gore,
          // uz log()) — izdvojena baš zato da se svo troje ponašanje testira izolirano.
          const gate = await evaluateVerificationGate(taskId, agentId, treatAsDone, resultText)
          const gateRejectInstruction = gate.instruction

          if (gateRejectInstruction) {
            // LIVE odbijanje: nema PUT-a na TaskManager → status ostaje kakav jest
            // (in_progress). Ishod je 'blocked', a NE 'blocked_ok' (M3/TASK-4625):
            // agent nije imenovao prepreku nego je tvrdio da je gotov bez verifikacijskog
            // bloka — to je kvar koji se popravlja, ne uredan zastoj. TaskManager status
            // time nije dirnut.
            runOutcome = 'blocked'
            log(`⛔ [verification-gate] task ${taskId || 'N/A'} — completed odbijen (nedostaje verifikacijski blok), zadatak ostaje in_progress`)
            sendResponse(db, fromAgent, gateRejectInstruction, 3, origin)
            logEvent(db, 'agent_verification_gate_rejected', agentId,
              `Task ${taskId}: completed odbijen (gate), zadatak ostaje in_progress`)
          } else {
          // M3/TASK-4625: kad zadatak NIJE zatvoren, ishod izvođenja ovisi o tome ZAŠTO.
          // Agent koji je sam deklarirao BLOCKED/NEEDS_CONTEXT ili imenovao prepreku
          // stao je UREDNO (`blocked_ok`) — to nije kvar i ne popravlja se istim mjerama
          // kao odbijen rezultat ili pad kritičara (`blocked`).
          runOutcome = criticBlockReason
            ? 'blocked'
            : outcomeFromCompletionVerdict(treatAsDone, verdict.code)

          // Update task status in TaskManager
          // W4/TASK-4617: `criticRepairHandled` = petlja je zadatak već vratila u `pending`
          // s nalazom; stari `blocked` bi to poništio u istom dahu (ugovor kao R7).
          if (taskId && !criticRepairHandled) {
            try {
              // ADR-0012 §12 (G1): PRED-PROVJERA VRATARA. `ResearchRagGate` i `GitCommitGate`
              // su na API-ju `live` i vraćaju HTTP 400. Dosad je taj 400 dobivao AGENT pa ga
              // popravio (mjereno: TASK-4595 REJECT → dopuna RAG ID-a → ACCEPT). Pod (B) je
              // daemon jedini pozivatelj i nema petlju popravka — zadatak bi ostao zauvijek
              // `in_progress`. Zato isti sud donosimo SAMI i zatvaramo u `blocked`, koji ne
              // prolazi ni kroz jednog vratara. `force: true` se namjerno NE koristi: to bi
              // vratare ugasilo umjesto da ih poštuje.
              if (treatAsDone) {
                const ctx = readTaskContext(taskId)
                const vratar = provjeriVratareZatvaranja({
                  taskId, tags: ctx.tags, projectId: ctx.projectId, resultText, log,
                })
                if (!vratar.ok) {
                  treatAsDone = false
                  criticBlockReason = criticBlockReason || vratar.razlog
                  // `runOutcome` je izračunat par redaka gore i hrani vrata spajanja (A4) i
                  // telemetriju — ako ostane 'completed', rad koji NIJE prošao vratara ušao bi
                  // u glavno stablo uz zapis „uspjeh".
                  runOutcome = 'blocked'
                  log(`⛔ [pred-vratar] ${taskId}: ${vratar.code} — zatvaram kao blocked (inače zombi u in_progress)`)
                }
              }
              // Prije zatvaranja apendaj agentov odgovor u task (result_summary) —
              // ostaje vidljiv na završenom zadatku (uklj. eventualne linkove na dokumente).
              // `result_summary` je polje za ISPORUKU, ne za ispriku (dorada TASK-2959):
              // tekst neuspjeha ide u progress_notes s prefiksom `Auto:`.
              const body = treatAsDone
                ? { status: 'completed', result_summary: sOznakomMemorije(taskId, resultText).slice(0, 20000) }
                : {
                    status: 'blocked',
                    blocked_reason: (criticBlockReason || verdict.blockedReason).slice(0, 500),
                    progressNotes: [
                      sOznakomMemorije(taskId, criticBlockReason
                        ? `Auto: nezavisni kritičar je sam pokrenuo provjere i one padaju. Zadatak NIJE zatvoren kao completed.\n${criticBrief}\n\nOdgovor agenta:\n${resultText.slice(0, 3000)}`
                        : `Auto: agent je izašao s exit 0, ali rezultat nije dokaz izvršenja (${verdict.code}, conf=${verdict.confidence}). Zadatak NIJE zatvoren kao completed. Odgovor agenta:\n${resultText.slice(0, 4000)}`),
                    ],
                  }
              // ADR-0012 §5: najam se pušta PRIJE zapisa (inače daemon udari u vlastiti
              // `spawnCloseGuard`), a zapis ide kroz `zatvoriZadatak` — s provjerom `res.ok`,
              // jednim ponavljanjem za mrežu/5xx i tvrdim tragom u `data/close_failures.jsonl`.
              // Stari `catch {}` je isti ovaj ishod gutao bez ijednog retka (kvar iz §1 bio je
              // zato nevidljiv 4 puta u dnevniku: „netko ga je već zatvorio").
              pustiNajam(taskId)
              await zatvoriZadatak(TASK_MANAGER_API, taskId, body, { log })
              // TASK-5259: agent je ostavio posao u pozadini (`REGOC-POZADINA: pid=…`) → najam;
              // petlja `vratiPozadinske` vraća zadatak kad posao završi, padne ili istekne rok.
              if (!treatAsDone && isEnabled('pozadinaPovrat')) {
                await registrirajPozadinu({ api: TASK_MANAGER_API, taskId, agent: agentId, resultText, log })
              }
              // T2/TASK-3084: automatski nastavak. Agent koji je udario u strop koraka
              // isporučio je DIO posla i sam to prijavljuje; ostavljati takav zadatak da
              // čeka čovjeka znači da lanac stane na pola bez ijednog kvara.
              if (!treatAsDone) await maybeAutoResume(taskId, resultText)
            } catch (e) {
              // Zatvaranje više ne smije nestati bez traga ni kad padne izvan `zatvoriZadatak`
              // (npr. `readTaskContext` na zaključanoj bazi).
              log(`⛔ [zatvaranje] ${taskId}: neočekivana greška (${e}) — status na ploči možda nije zapisan`)
            }
          }

          // Send result to requester (NOT to regoc - prevents recursion).
          // Poruka mora govoriti istinu jednako kao i ploča — lažni "✅ završio" u
          // inboxu je isti problem kao lažni completed na ploči.
          // W4: „JEDNA poruka" — isti obrazac kao R7. Kad je naručitelj auto-exec
          // (`fromAgent === 'user'`), poruka petlje (vraćen na popravak / traži čovjeka)
          // ZAMJENJUJE generičku „NIJE izvršio": obje govore o istom ishodu, a druga ne
          // kaže ono što je ovdje jedino važno — ide li korak natrag ili čeka čovjeka.
          if (criticRepairMessage) {
            sendResponse(db, 'user', `${criticRepairMessage} (izvođač **${agentName}**)`, 4, origin)
          }
          // TASK-4724: oznaka i obrazloženje MORAJU izdržati i put na kojem je
          // CompletionGuard sud PRIHVATIO rezultat, a zadatak je oborio kritičar
          // (treatAsDone=false nad accept-sudom): tada je `label` null, a `reason` je
          // doslovno "ok" — poruka je glasila `NIJE izvršio (null) … ok`.
          // TASK-4815: JEDAN parser i JEDNO pravilo rezanja za sve kanale.
          // Ovo je mjesto koje proizvodi SVE poruke za korisnika (518 u 30 dana),
          // a prije je radilo `substring(0, 2000)` nad sirovim stdoutom: rez je padao
          // nasred zaglavlja, a markdown je stizao doslovno jer Telegram ovdje nema
          // `parse_mode` (izmjereno 4735 parova zvjezdica u 30 dana).
          // TASK-4817: podignuto IZNAD grananja jer isti parsirani izlaz sada hrani
          // i GLASOVNI kanal niže — jedan parse, tri kanala, nula ponovnog čitanja.
          const parsiraniIzlaz = parseAgentOutput(resultText)
          // TASK-5159 (dizajn TASK-5158 §5): „🧭 Tijek posla” uz ✅ — samo kad zadatak NIJE
          // u nizu s dojavom (inače bi Goran isti tijek dobio dvaput). Vještine i alati su
          // izmjereni iz transkripta ove sesije; bez mjerenja piše „nije izmjereno”.
          let tijekDodatak = ''
          if (treatAsDone && taskId && (!criticRepairMessage || fromAgent !== 'user')) {
            try {
              if (loadReportBackConfig().tijekPosla !== false && !uNizuDojave(taskId)) {
                const oz = oznakeOd(readTaskRow(taskId)?.tags ?? null)
                const mj = spawnSessionId ? await izmjeriSesiju(spawnSessionId) : null
                tijekDodatak = sastaviTijek(
                  [{ id: taskId, assignee: agentId, status: 'completed', tags: oz }],
                  new Map([[taskId, zapisIzTelemetrije(taskId, oz, mj)]]),
                  loadWorkflowKatalog(), { dojavaNiza: false })
              }
            } catch (e) { log(`⚠️ [tijek posla] ${taskId}: odjeljak nije sastavljen (${e})`) }
          }
          if (!criticRepairMessage || fromAgent !== 'user') {
            let dojavaGotovo = treatAsDone
              ? renderMinimal(parsiraniIzlaz, {
                  heading: `✅ ${agentName} ${zavrsioZavrsila(agentId)} zadatak${taskId ? ` ${taskId}` : ''}:`,
                  maxLen: tijekDodatak ? Math.max(500, USER_FLUSH_MAXLEN - tijekDodatak.length - 2) : USER_FLUSH_MAXLEN,
                }) + (tijekDodatak ? `\n\n${tijekDodatak}` : '')
              : ''
            // TASK-5548: nalog iz razgovora (`chat:`) — svi SEND_DOC markeri iz odgovora idu u
            // dojavu (renderMinimal ih zna izbaciti), a „neprovjereno” je samo oznaka u njoj.
            if (treatAsDone && taskId) {
              try {
                if (neprovjerenoIdeUDojavu(readTaskRow(taskId)?.tags ?? null, isEnabled('chatDojavaUvijek'))) {
                  const neprovjereno = criticStatusZaDojavu === 'unverifiable' || criticStatusZaDojavu === 'partial'
                    ? criticStatusZaDojavu : null
                  dojavaGotovo = dopuniDojavu(dojavaGotovo, resultText, { neprovjereno })
                }
              } catch (e) { log(`⚠️ [chat-dojava] ${taskId}: dopuna dojave pala (${e}) — ide izvorna`) }
            }
            sendResponse(db, fromAgent,
              treatAsDone
                ? dojavaGotovo
                : renderMinimal(parsiraniIzlaz, {
                    heading: `⚠️ ${agentName} NIJE izvršio zadatak${taskId ? ` ${taskId}` : ''} (${formatVerdictLabel(verdict)}).`
                      + `\n\n${plainText(criticBlockReason || verdict.reason)}\n\nOdgovor agenta:`,
                    maxLen: USER_FLUSH_MAXLEN,
                  }),
              treatAsDone ? 3 : 4, origin)
          }

          // Voice notification — samo za agente s glasom (allowlist u REGOC_AGENTS.json)
          // TASK-4817: TREĆI KANAL prekidača, dosad mrtav kod — `renderVoice` nije
          // zvao nitko, pa je glas govorio konzerviranu rečenicu bez ijedne riječi
          // agenta. Sada: ako je agent ostavio `🗣️` redak, izgovara se NJEGOV
          // sažetak; ako nije, `voice` vraća prazno (ugovor „nemam što reći") i
          // ostaje konzerva. Sirovi L3 tekst (79 % prometa) se NE čita naglas.
          // Rod je isti kao na Telegramu — muški zadano bio je kvar koji se ČUJE.
          const glas = renderAgentOutput(parsiraniIzlaz, { mode: 'voice' })
          const konzerva = treatAsDone
            ? `${agentName} je ${zavrsioZavrsila(agentId)} zadatak`
            : `${agentName} nije ${mogaoMogla(agentId)} izvršiti zadatak`
          await requestVoice({
            agent: agentId,
            event: treatAsDone ? 'agent_task_completed' : 'agent_task_blocked',
            message: glas.mode === 'voice' && glas.text ? `${agentName}: ${glas.text}` : konzerva,
          })

          logEvent(db, treatAsDone ? 'agent_task_completed' : 'agent_task_blocked', agentId,
            `Task ${taskId}: ${treatAsDone ? 'completed' : `blocked (${verdict.code}/${formatVerdictLabel(verdict)})`}`)
          }
        } else {
          runOutcome = 'failed'
          // D3/TASK-2955: prije je ovdje stajao jedan red — "failed (exit 143): " —
          // bez signala, PID-a, trajanja i (kod ubijenog procesa) bez ijednog znaka
          // stderr-a. Sada se izlaz klasificira (mi / vanjski proces / sam) i puni
          // tokovi se spremaju u ~/.tmp/regoc_spawn_diag/.
          const facts: SpawnExitFacts = {
            agent: agentId,
            agentName,
            taskId,
            pid: spawnInfo.pid || proc.pid,
            ppid: process.pid,
            startTime: spawnInfo.startTime,
            endTime: Date.now(),
            exitCode,
            signalCode: proc.signalCode ?? null,   // Bun: exitCode=null, signalCode='SIGTERM' kad ga pokosi signal
            stdout,
            stderr,
            killedBy: spawnInfo.killedBy,
            cmd: spawnInfo.cmdRedacted,
          }
          const exitVerdict = classifySpawnExit(facts)
          facts.diagPath = persistSpawnDiagnostics(facts, exitVerdict)
          log(renderSpawnExitLog(facts, exitVerdict))

          // F6 (TASK-2549): Exponential backoff — SAMO ako je kvar stvarno agentov.
          // Restart daemona ili vanjski SIGTERM nisu agentova krivnja; prije su trovali
          // backoff (fail #1, #2, …) i blokirali sljedeće spawnove bez razloga.
          // DUR-5/TASK-3597: osigurac sudi po POTPISU odbijenice, ne po exit kodu.
          // 429/usage-limit/preopterecenje → broji se (fail-CLOSED); sve ostalo (SIGTERM,
          // pad alata, exit 1 bez potpisa) → ne broji se (fail-OPEN).
          {
            const fk = classifySpawnFailure(exitCode, stderr, stdout)
            getSpawnBreaker().recordFailure(agentId, fk.kind, fk.reason)
          }

          let backoffSec = 0
          let failCount = 0
          if (exitVerdict.countsAsAgentFailure) {
            const ft = agentFailureTracker.get(agentId) || { count: 0, lastFail: 0, backoffUntil: 0 }
            ft.count++
            ft.lastFail = Date.now()
            // DUR-5/TASK-3597: jitter — v. objasnjenje kod hook-blokade iznad.
            ft.backoffUntil = Date.now() + jitteredBackoff(ft.count)
            agentFailureTracker.set(agentId, ft)
            backoffSec = Math.round((ft.backoffUntil - Date.now()) / 1000)
            failCount = ft.count
            log(`⚠️ Agent ${agentId} fail #${ft.count} — backoff ${backoffSec}s (do ${new Date(ft.backoffUntil).toISOString()})`)
          } else {
            log(`ℹ️ Agent ${agentId} — backoff preskočen (${exitVerdict.kind}: nije kvar agenta)`)
          }

          // Kad smo ga MI ugasili, killAgentSpawn je već obavijestio naručitelja i
          // zatvorio zadatak (cancelled) — ne diramo status niti šaljemo drugu poruku.
          if (exitVerdict.kind !== 'killed-by-daemon') {
            // R7/TASK-2563: KRAJ TIHIH ODUSTAJANJA.
            //
            // Stari put je zadatak parkirao u `blocked` i poslao poruku „❌ Agent X neuspješan
            // (exit 1)" — bez ID-a zadatka. Mjereno 05.09.2026.: 3 od 3 zadatka s razlogom
            // „Spawn prekinut…" nemaju nijednu poruku korisniku koja ih spominje, a `blocked`
            // je groblje (87 zadataka, medijan 8,3 dana). Odustalo se, a nitko nije znao od čega.
            //
            // Sada: zadatak se vraća u `pending` s oznakom `pokusaj:<n>` (auto-exec ga pokupi
            // sljedeći prolaz), a korisnik dobiva JEDNU poruku koja NOSI ID. Iznad stropa
            // pokušaja ostaje stari put (`blocked`), ali i tada s porukom.
            // Sve iza flagova: `failRequeue` (glavni) + `failRequeueLive` (shadow → live).
            let requeue: Awaited<ReturnType<typeof requeueFailedTask>> | null = null
            if (taskId && isEnabled('failRequeue', false)) {
              requeue = await requeueFailedTask(
                { agent: agentId, agentName, taskId, exitCode, cause: exitVerdict.cause },
                { live: isEnabled('failRequeueLive', false), maxAttempts: FAIL_REQUEUE_MAX_ATTEMPTS },
                failRequeueDeps(),
              )
            }

            // `handled` = zadatak je VEĆ vraćen u `pending`; stari `blocked` bi to odmah poništio.
            if (taskId && !requeue?.handled) {
              try {
                await fetch(`${TASK_MANAGER_API}/${taskId}`, {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    status: 'blocked',
                    blocked_reason: `Spawn prekinut: ${exitVerdict.cause}`.slice(0, 500),
                    progressNotes: [`Neuspjeh agenta (exit ${exitCode}${exitVerdict.signal ? `, signal ${exitVerdict.signal}` : ''}, pid ${facts.pid}, trajanje ${Math.round(exitVerdict.durationMs / 1000)}s) — ${exitVerdict.cause}. Dijagnostika: ${facts.diagPath || 'nije zapisana'}. Rucno vrati u obradu (blocked->pending) ili promijeni model.`]
                  })
                })
              } catch {}
            }

            // Notify requester about failure - DO NOT re-delegate!
            // R7: „JEDNA poruka" — kad je auto-exec naručitelj (`fromAgent === 'user'`),
            // nova poruka s ID-em ZAMJENJUJE staru; korisnik ne dobiva dvije o istom padu.
            // Kad je naručitelj drugi agent, on i dalje dobiva svoju (stari put je fallback),
            // a korisniku ide R7 poruka kroz R1 kanal (`to_agent='user'`).
            if (requeue?.userMessage) {
              sendResponse(db, 'user',
                `${requeue.userMessage} (agent **${agentName}**, exit ${exitCode}${exitVerdict.signal ? `/${exitVerdict.signal}` : ''})`, 5, origin)
            }
            if (!requeue?.userMessage || fromAgent !== 'user') {
              sendResponse(db, fromAgent,
                `❌ Agent **${agentName}** neuspješan (exit ${exitCode}${exitVerdict.signal ? `/${exitVerdict.signal}` : ''}) — ${exitVerdict.cause}. Zadatak${taskId ? ` **${taskId}**` : ''} nije izvršen.${failCount > 1 ? ` Backoff: ${backoffSec}s (fail #${failCount}).` : ''}`, 5, origin)
            }
          }

          logEvent(db, 'agent_task_failed', agentId,
            `Task ${taskId}: exit ${exitCode}${exitVerdict.signal ? `/${exitVerdict.signal}` : ''}, ${exitVerdict.kind}, pid ${facts.pid}, ${Math.round(exitVerdict.durationMs / 1000)}s${exitVerdict.countsAsAgentFailure ? `, backoff fail #${failCount}` : ', bez backoffa'}`)
        }

        db.close()
      } catch (e) {
        log(`❌ Agent ${agentId} spawn handler error: ${e}`)
        telemetryNote = `spawn handler error: ${e}`
      } finally {
        // K7/TASK-2986: jedan redak po spawnu u data/run_log.jsonl (+ cost_log kad ima
        // mjerenja). Stoji u `finally` da se run zabilježi i kad handler pukne — inače bi
        // upravo najskuplji, najčudniji runovi ostali nevidljivi.
        try {
          const entry = recordSpawn({
            agentId,
            taskId,
            requestedModel: model,
            provider: target.provider,
            exitCode: runExitCode,
            outcome: runOutcome,
            startedAtMs: spawnInfo.startTime,
            envelope: runEnvelope,
            sessionPercentBefore,
            sessionPercentAfter,
            note: telemetryNote,
          })
          const t = entry.tokens
          log(`📊 ${agentId} ${taskId || 'bez-zadatka'} ${entry.outcome} — izlaz ${t.out}, ulaz ${t.in}, cache R ${t.cache_r}/W ${t.cache_w}, ${entry.cost_usd.toFixed(4)} USD (${entry.cost_source}), ${entry.duration_s}s`)
          // TASK-5159: trajni redak tijeka posla (vještine i alati iz transkripta) — run_log je
          // upravo zapisan, pa ga `--task` nalazi. U pozadini: ne smije usporiti oslobađanje slota.
          if (taskId) zapisiTijekPoslaUPozadini(taskId)
          if (voditelj) { try { voditelj.naTrosak(entry.cost_usd) } catch (e) { log(`⚠️ [voditelj] ${taskId}: trošak nije upisan (${e})`) } }
        } catch (e) {
          log(`⚠️ Telemetrija spawna nije zapisana (${agentId}/${taskId || 'bez-zadatka'}): ${e}`)
        }

        // A1/TASK-3000: izolirano stablo se oslobađa ovdje, uz telemetriju — isti razlog
        // zbog kojeg je i ona u `finally`: baš najčudniji runovi inače ostave smeće.
        // A4/TASK-3003: prije oslobađanja kroz vrata spajanja; `runOutcome` je bitan jer
        // rad spawna koji nije uredno završio ne ulazi u glavno stablo ni uz potpis.
        finishSpawnWorkspace(workspace, agentId, taskId, runOutcome)
        // A3/TASK-3002: opseg se oslobađa uz stablo i iz istog razloga — zaostali zahtjev
        // drži datoteke koje više nitko ne uređuje i tiho zaustavlja tuđe zadatke.
        releaseScopeClaim(spawnInfo)

        // ADR-0012: najam prati slot — zaostali najam drži zadatak zaključanim za
        // svakoga osim daemona (fail-open ga ipak otpušta po mrtvom pidu, ali ne odmah).
        // ADR-0022: brava sesije se otpušta uz najam; pokazivač ide za VRAĆENIM session_id.
        // Pozadinski posao (REGOC-POZADINA) ne drži sesiju — sljedeći zadatak smije nastaviti.
        if (trajniLive && taskId) {
          try {
            const pk = citajPokazivac(trajneSesijeDir(), trajni!.kljuc)
            if (pk && pk !== 'pokvaren' && pk.zauzeta?.taskId === String(taskId)) {
              const sid = runEnvelope.sessionId || pk.sessionId
              const ktx = kontekstIzTranskripta(transcriptPathForSession(workspace?.cwd || HOME, sid))
              const nov = oslobodiPokazivac(pk, { taskId: String(taskId), sessionId: runEnvelope.sessionId, kontekstTokena: ktx, now: Date.now() })
              zapisiPokazivac(trajneSesijeDir(), nov)
              log(`🧷 [trajni] ${taskId} → ${agentId}: sesija ${kratkiSid(nov.sessionId)} slobodna (gen ${nov.generacija}, ${nov.zadaci.length} zadataka, kontekst ${ktx === null ? '?' : `${Math.round(ktx / 1000)}k`})`)
            }
          } catch (e) { log(`⚠️ [trajni] ${taskId}: brava sesije nije otpuštena (${e}) — otpušta je mrtav pid`) }
        }
        if (taskId) pustiNajam(taskId)
        if (taskId) zatvaranjeSpawna.zavrsi(String(taskId))
        if (rokVoditelja) clearTimeout(rokVoditelja)
        traka.delete(spawnKey)
        log(voditelj ? `🔓 [voditelj] traka slobodna (${voditeljSpawns.size}/${voditelj.maxIstodobno}); agenti ${activeAgentSpawns.size}/${maxAgentConcurrent()}`
          : `🔓 Agent slot freed. Active: ${activeAgentSpawns.size}/${maxAgentConcurrent()}`)
      }
    })()
    return { started: true }

  } catch (e) {
    // Spawn se nije ni pokrenuo → nema potpisa i nema uspješnog ishoda: vrata zadržavaju.
    finishSpawnWorkspace(workspace, agentId, taskId, 'failed')
    releaseScopeClaim(spawnInfo)
    if (taskId) pustiNajam(taskId)
    traka.delete(spawnKey)
    log(`❌ Failed to spawn agent ${agentId}: ${e}`)
    return { started: false, reason: 'greska' }
  }
}

/**
 * API spawn put — pokreće agenta preko HTTP inference API-ja (za sada Ollama),
 * umjesto `claude --print` CLI-ja. Koristi se kad je per-agent override ne-Anthropic.
 *
 * OGRANIČENJE: čisti text-in/text-out — agent NEMA alate (Bash, datoteke, MCP).
 * Prikladno za niske tierove (pozdrav/status/sažetak/klasifikacija). Za zadatke koji
 * traže izvršavanje koristi Anthropic (CLI) put. Isti downstream kao CLI: task update,
 * sendResponse, voice, backoff, audit.
 */
async function spawnAgentViaAPI(
  agentId: string,
  prompt: string,
  provider: string,
  model: string,
  taskId: string | null,
  fromAgent: string,
  node?: string
): Promise<void> {
  // Concurrency limit (dijeli isti pool kao CLI spawn)
  if (!spawnSlotAvailable(activeAgentSpawns.size, maxAgentConcurrent())) {
    log(`⚠️ Agent spawn limit reached (${maxAgentConcurrent()}). Skipping ${agentId} API spawn.`)
    const db = getDb()
    sendResponse(db, fromAgent, `⏳ Svi agent slotovi zauzeti (${activeAgentSpawns.size}/${maxAgentConcurrent()}). Pokušaj ponovno za par minuta.`, 5)
    db.close()
    return
  }

  // Per-agent backoff (isti tracker kao CLI)
  const failTracker = agentFailureTracker.get(agentId) || { count: 0, lastFail: 0, backoffUntil: 0 }
  if (Date.now() < failTracker.backoffUntil) {
    const remainingSec = Math.round((failTracker.backoffUntil - Date.now()) / 1000)
    log(`⏳ Agent ${agentId} u backoff-u (fail #${failTracker.count}) — preostalo ${remainingSec}s, preskačem API spawn`)
    return
  }

  if (getSystemMode() === 'PLAN') {
    prompt = `[SYSTEM MODE: PLAN] Ovo je plan-only sesija. NE izvrsavaj, samo planiraj.\n\n` + prompt
    log(`[MODE] Agent ${agentId} API spawn in PLAN mode`)
  }

  const spawnKey = `${agentId}-api-${Date.now()}`
  activeAgentSpawns.set(spawnKey, {
    agent: agentId, startTime: Date.now(), taskId, fromAgent,
    pid: 0, lastCpuJiffies: 0, lastLivenessCheck: Date.now(),
  })
  const agentName = agentRegistry?.agents[agentId]?.name || agentId
  log(`🚀 Spawning agent ${agentId} via API (${provider}${node ? '@' + node : ''}:${model})...`)

  try {
    // Rule #12: task ide pending→in_progress→completed (API ne dopušta pending→completed direktno).
    if (taskId) {
      // ADR-0012 §16 (G6): i ovaj PUT je gutao ishod. Ulaz u `in_progress` koji tiho padne
      // ostavlja zadatak `pending` dok se na njemu radi — točno ono što pravilo 12 zabranjuje.
      await zatvoriZadatak(TASK_MANAGER_API, taskId, { status: 'in_progress' }, { log, zapisiNeuspjeh: false })
    }

    if (provider !== 'ollama') {
      throw new Error(`API spawn provider '${provider}' nije podržan (zasad samo ollama)`)
    }

    const baseUrl = resolveOllamaBaseUrl(node, agentId)

    const { OllamaProvider } = await import('./models/providers/OllamaProvider')
    const providerInst = new OllamaProvider(baseUrl)

    const systemPrompt = `Ti si ${agentName}, REGOČ agent. Odgovaraj na hrvatskom standardnom jeziku. ` +
      `VAŽNO: ovo je lokalni model bez pristupa alatima (nema Bash, datoteka ni MCP-a) — odgovori tekstualno najbolje što možeš; ` +
      `ako zadatak zahtijeva izvršavanje ili alate, jasno reci da to ovdje nije moguće.`

    const resp = await providerInst.chat(
      [{ role: 'user', content: prompt }],
      { model, systemPrompt, temperature: 0.5, maxTokens: 2048, timeout: 240000 }
    )
    const output = (resp.content || '').trim()
    if (!output) throw new Error('Prazan odgovor od modela')

    const db = getDb()

    // TASK-2954 (D2): ovaj put je bio najgori izvor lažnih ✅. System prompt gore
    // EKSPLICITNO traži od modela da kaže kako bez alata ne može izvršiti zadatak —
    // i taj se odgovor onda spremao kao result_summary uz status `completed`.
    // Doslovni dokaz: TASK-330 = "Nemam pristup alatima (Bash, datotekama, MCP-u)..."
    // zatvoren kao completed.
    //
    // PRAVILO (arhitektonska dorada, TASK-2959), ne heuristika: model bez alata po
    // definiciji NE MOŽE isporučiti izvršni zadatak, pa mu se ukida pravo zatvaranja.
    // Ovaj put NIKADA ne postavlja `completed` — izlaz ide u progress_notes i
    // pošiljatelju, status u `blocked`. Time cijela klasa TASK-329/330/338 nestaje
    // bez ijednog regexa; guard ovdje služi samo za točniju oznaku razloga.
    const verdict = evaluateCompletion(output)
    log(`⚠️ Agent ${agentId} (API ${provider}:${model}) task ${taskId || 'N/A'} — ${resp.latencyMs}ms, out=${resp.usage?.outputTokens ?? '?'} tok · bez alata ⇒ NIKAD completed · ${formatVerdictLog(verdict)}`)

    // Reset backoff na uspjeh — model je odgovorio, transport radi; sud o SADRŽAJU
    // je odvojena stvar i ne smije okinuti backoff (inače bi loše specificiran task
    // kaznio zdravog agenta).
    const st = agentFailureTracker.get(agentId)
    if (st && st.count > 0) { st.count = 0; st.backoffUntil = 0 }

    if (taskId) {
      // `result_summary` je polje za ISPORUKU, ne za ispriku — odgovor modela bez
      // alata ide u progress_notes s prefiksom `Auto:` (dorada TASK-2959).
      // ADR-0012 §16 (G6): `zatvoriZadatak` umjesto `fetch` u `catch {}` — ishod se vidi.
      await zatvoriZadatak(TASK_MANAGER_API, taskId, {
        status: 'blocked',
        blocked_reason: (verdict.accept
          ? `BLOCKED: lokalni model (${provider}:${model}) nema alate — odgovor je tekst, ne izvršen zadatak.`
          : verdict.blockedReason
        ).slice(0, 500),
        progressNotes: [
          `Auto: lokalni model (${provider}:${model}) bez alata — nema pravo zatvoriti zadatak. Odgovor modela:\n${output.slice(0, 4000)}`,
        ],
      }, { log })
    }

    // TASK-4817: ova grana (lokalni model bez alata) bila je POSLJEDNJA koja je
    // korisniku slala sirov tekst — `**markdown**` koji Telegram ovdje ne tumači
    // (nema `parse_mode`) i slijepi `substring(0, 20000)`, pet puta veći od stropa,
    // pa je rez padao na izlaznim vratima nasred formata. Isti parser kao svugdje.
    const parsiranoBezAlata = parseAgentOutput(output)
    sendResponse(db, fromAgent,
      renderMinimal(parsiranoBezAlata, {
        heading: `⚠️ ${agentName} (lokalno · ${model}) NIJE ${zavrsioZavrsila(agentId)} zadatak${taskId ? ` ${taskId}` : ''}`
          + ` — model bez alata ne može izvršiti zadatak, odgovor je samo tekst.\n\nOdgovor modela:`,
        maxLen: USER_FLUSH_MAXLEN,
      }),
      4)
    const glasBezAlata = renderAgentOutput(parsiranoBezAlata, { mode: 'voice' })
    await requestVoice({
      agent: agentId,
      event: 'agent_task_blocked',
      message: glasBezAlata.mode === 'voice' && glasBezAlata.text
        ? `${agentName}: ${glasBezAlata.text}`
        : `${agentName} nije ${mogaoMogla(agentId)} izvršiti zadatak`,
    })
    logEvent(db, 'agent_task_blocked', agentId,
      `Task ${taskId}: via ${provider}:${model} (${resp.latencyMs}ms) — no-tools-runner, ${verdict.code}/${formatVerdictLabel(verdict)}`)
    db.close()
  } catch (e: any) {
    const db = getDb()
    const ft = agentFailureTracker.get(agentId) || { count: 0, lastFail: 0, backoffUntil: 0 }
    ft.count++
    ft.lastFail = Date.now()
    // DUR-5/TASK-3597: jitter i na API putu — isti razlog (vise radnika, jedan limit).
    ft.backoffUntil = Date.now() + jitteredBackoff(ft.count)
    agentFailureTracker.set(agentId, ft)
    const backoffSec = Math.round((ft.backoffUntil - Date.now()) / 1000)
    const emsg = e?.message ? e.message : String(e)
    log(`❌ Agent ${agentId} API spawn failed: ${emsg} — backoff ${backoffSec}s (fail #${ft.count})`)

    if (taskId) {
      // ADR-0012 §16 (G6): ishod neuspjeha mora imati trag — inače zadatak visi bez razloga.
      await zatvoriZadatak(TASK_MANAGER_API, taskId, {
        status: 'blocked', progressNotes: [`Neuspjeh (API spawn): ${emsg}. Rucno vrati u obradu ili promijeni model.`],
      }, { log })
    }
    sendResponse(db, fromAgent, `❌ Agent **${agentName}** (lokalno · ${model}) neuspješan: ${emsg}.${ft.count > 1 ? ` Backoff: ${backoffSec}s (fail #${ft.count}).` : ''}`, 5)
    logEvent(db, 'agent_task_failed', agentId, `Task ${taskId}: API ${provider}:${model} error: ${emsg}`)
    db.close()
  } finally {
    activeAgentSpawns.delete(spawnKey)
    log(`🔓 Agent slot freed. Active: ${activeAgentSpawns.size}/${maxAgentConcurrent()}`)
  }
}

/**
 * DEDUP-GUARD (TASK-636): Detect when the content being delegated is itself a
 * recycled PAI-format agent report rather than a fresh request.
 *
 * The existing ANTI-RECURSION GUARD only catches narrow notification patterns
 * (e.g. "✅ **...završio", "❌ ...neuspješan"). A full structured agent report
 * (📋 SUMMARY … ⭐ RATE … 🗣️) slips through, becomes a new task's description,
 * and gets re-delegated — producing liveness chains like TASK-627→629→…→636
 * where each task's "description" is the previous task's copied SUMMARY.
 *
 * Heuristic: a genuine request does not carry a full report block. If the
 * content contains several PAI report section markers, treat it as recycled.
 * Returns the markers found (>= REPORT_MARKER_THRESHOLD ⇒ recycled).
 */
const PAI_REPORT_MARKERS = [
  '📋 SUMMARY',
  '🔍 ANALYSIS',
  '⚡ ACTIONS',
  '✅ RESULTS',
  '📊 STATUS',
  '📁 CAPTURE',
  '➡️ NEXT',
  '📖 STORY EXPLANATION',
  '⭐ RATE',
]
const REPORT_MARKER_THRESHOLD = 4

function detectRecycledReport(content: string): { recycled: boolean; markers: string[] } {
  const markers = PAI_REPORT_MARKERS.filter(m => content.includes(m))
  return { recycled: markers.length >= REPORT_MARKER_THRESHOLD, markers }
}

/**
 * Delegate task to an agent - creates task + spawns agent on-demand
 */
// R2: sekvencijalni multi-agent — pomocni agenti se izvrsavaju NAKON primarnog (lanac blokiranih P1 taskova).
// Lokalno je bolje sekvencijalno (jedan model/RAM u isto vrijeme). Redoslijed = lanac blockedBy.
/**
 * T1/TASK-3080: prirodni redoslijed lanca — tko prvi, tko zadnji. Istraživanje i plan
 * prethode izradi, provjere idu na kraj. Bez ovoga bi QA znao krenuti prije implementacije.
 */
const TEAM_ORDER: Record<string, number> = {
  manda: 1, kosjenka: 2, dora: 3, jelena: 4, grga: 5, gita: 6, malik: 7, potjeh: 8,
}

/**
 * TASK-4992: Kanal-agenti — NIKAD ne smiju biti u teamChain.
 * Stribor = TeamSpeak voice agent (nema skillova za generalni rad).
 * Klaudio = Telegram kanal (nema skillova za generalni rad).
 * Emard = FPGA specijalist (samo za #fpga/#verilog zadatke, ali na blacklisti jer
 *         nije u TEAM_ROLE_BRIEF i ne smije ući kroz helper cue).
 */
const TEAM_CHAIN_BLACKLIST = new Set(['stribor', 'klaudio', 'emard'])

// TASK-4992: VISUAL/SECURITY_KEYWORDS_RE + isVisualTask/isSecurityTask su premješteni u AgentRouting.ts
// (ADR-0018, TASK-5134) — isti izvor za filtar tima i za AgentSelection (SIG-povrsina, tim-E5).

/**
 * TASK-4992: Filtrira predloženi tim po relevantnosti za konkretan sadržaj zadatka.
 * - Kanal-agenti (stribor, klaudio, emard) nikad nisu u timu
 * - Gita i Grga: samo za vizualne zadatke
 * - Malik: samo za sigurnosne zadatke
 * - Potjeh: uvijek OK (QA), ali samo ako je u listi
 */
function filterTeamByRelevance(agents: string[], taskContent: string): string[] {
  const visual = isVisualTask(taskContent)
  const security = isSecurityTask(taskContent)
  return agents.filter(id => {
    if (TEAM_CHAIN_BLACKLIST.has(id)) return false
    if ((id === 'gita' || id === 'grga') && !visual) return false
    if (id === 'malik' && !security) return false
    return true
  })
}

/**
 * T1/TASK-3080: tko VODI lanac. Keyword-router gleda pojedine riječi („izrada aplikacije"
 * → jelena), pa je Goranov zahtjev „napravi ISTRAŽIVANJE za izradu…" dobio inženjera, a
 * istraživač je završio iza njega — implementacija prije nego itko provjeri činjenice.
 * Kad je zadatak COMPLEX i klasifikator predlaže agenta koji po prirodnom redoslijedu
 * dolazi RANIJE od routerova izbora, vodstvo preuzima on. Zahvat je uzak: samo COMPLEX,
 * samo kad je razlika u redoslijedu stvarna, i samo dok je `teamChainLive` upaljen.
 */
function applyTeamLead(decision: DelegationDecision, content: string): DelegationDecision {
  try {
    if (decision.type !== 'delegate' || !decision.agent) return decision
    if (!isEnabled('teamChain') || !isEnabled('teamChainLive')) return decision
    if (isHelperEcho(content) || hasHelperCue(content)) return decision   // korisnik/sustav je već imenovao
    const cls = getModeClassifier().classifyMessage(content)
    if (cls.mode !== 'COMPLEX') return decision
    const lead = (cls.suggestedAgents || []).filter(a => TEAM_ROLE_BRIEF[a])[0]
    if (!lead || lead === decision.agent) return decision
    if ((TEAM_ORDER[lead] ?? 99) >= (TEAM_ORDER[decision.agent] ?? 99)) return decision
    log(`  [teamChain] vodstvo: ${decision.agent} → ${lead} (${cls.effort}, prirodni redoslijed)`)
    return { ...decision, agent: lead, reason: `${decision.reason} → vodi ${lead} (${cls.effort} lanac)` }
  } catch (e) { log(`  ⚠️ [teamChain] vodstvo palo: ${e}`); return decision }
}

/**
 * TASK-3086: naziv za naslov zadatka kad projekt NIJE zaveden (na nodovima je baza projekata
 * prazna, pa bi svaki lanac dobio isto generičko „zadatak"). Redom:
 *   1. CamelCase ime iz zahtjeva — „VoiceKeeper", „TaskManager", „RegocMobile";
 *   2. prva riječ Velikim slovom koja nije na početku rečenice (npr. „Nextcloud");
 *   3. prve dvije riječi zahtjeva, bez uvodnih glagola.
 * Cilj je da se na ploči na prvi pogled vidi O ČEMU je lanac, a ne samo tko ga radi.
 */
function labelFromContent(content: string): string {
  const txt = String(content || '').replace(/\s+/g, ' ').trim()
  if (!txt) return 'zadatak'
  const camel = txt.match(/\b([A-Z][a-z]+(?:[A-Z][A-Za-z0-9]+)+)\b/)
  if (camel) return camel[1]
  const proper = txt.slice(1).match(/\b([A-ZČĆŠĐŽ][a-zčćšđž]{3,})\b/)
  if (proper) return proper[1]
  const stop = /^(treba|trebam|napravi|napraviti|istrazi|istraži|istrazivanje|molim|dizajniraj|implementiraj|provjeri|za|i|na|u|se|da|mi)$/i
  const words = txt.split(' ').filter(w => w.length > 2 && !stop.test(w))
  return words.slice(0, 2).join(' ') || 'zadatak'
}

/**
 * TASK-3087: lanac za novu temu dobiva SVOJ projekt.
 *
 * Dosad se projekt otvarao samo na izričitu naredbu („napravi projekt X"), pa je posao
 * pokrenut iz razgovora padao u pretinac bez projekta — na ploči se nije vidjelo čemu
 * pripada. Sada se projekt otvara sam, ali tek nakon provjere da ne postoji.
 *
 * PROVJERA DUPLIKATA je namjerno tolerantna: uspoređuje se normalizirano ime (mala slova,
 * bez dijakritike, bez razmaka i interpunkcije), pa „VoiceKeeper", „voice keeper" i
 * „Voice-Keeper" znače isti projekt. Bez toga bi svaki novi razgovor o istoj temi otvorio
 * još jedan projekt pod malo drukčijim imenom.
 */
/**
 * TASK-3088: projekt dobiva SVOJE git radno stablo — time izolacija (A1) prestaje biti
 * nemoguća i lanac može ići paralelno umjesto da čeka u redu (serijalizacija ostaje samo
 * kao mreža za stabla koja nisu git).
 *
 * Radi `~/projects/<Ime>` + `git init` + prazan početni commit, pa upiše mapiranje
 * `projectRepos[<PRJ-ID>]` u `config/worktree-isolation.json`. Config se čita pri svakoj
 * odluci (bez restarta), pa mapiranje vrijedi odmah za sljedeći spawn.
 *
 * Iza zastavice `projectGitInit` — bez nje se ponašanje ne mijenja.
 */
async function ensureProjectRepo(projectId: string, projectName: string): Promise<void> {
  if (!isEnabled('projectGitInit')) return
  try {
    const safe = String(projectName).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || projectId
    const dir = join(HOME, 'projects', safe)
    const run = (args: string[], cwd?: string) => Bun.spawnSync(['git', ...args], { cwd })
    mkdirSync(dir, { recursive: true })
    if (!existsSync(join(dir, '.git'))) {
      if (run(['init', '-q'], dir).exitCode !== 0) { log(`  ⚠️ [git] init pao za ${dir}`); return }
      const { git } = okolina()  // TASK-5700: identitet iz config/okolina.json
      run(['config', 'user.email', git.email], dir)
      run(['config', 'user.name', git.name], dir)
      writeFileSync(join(dir, 'README.md'), `# ${projectName}\n\nRadno stablo projekta ${projectId}. Otvorio REGOČ automatski.\n`)
      run(['add', '-A'], dir)
      run(['commit', '-qm', `${projectId}: početno stablo projekta ${projectName}`], dir)
      log(`  🌱 [git] radno stablo ${dir} (init + početni commit)`)
    }
    // Mapiranje projectId → stablo, da `resolveProjectWorkDir` prestane vraćati HOME.
    const cfgPath = join(HOME, '.claude', 'regoc', 'config', 'worktree-isolation.json')
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'))
    if (!cfg.projectRepos || typeof cfg.projectRepos !== 'object') cfg.projectRepos = {}
    if (cfg.projectRepos[projectId] !== dir) {
      cfg.projectRepos[projectId] = dir
      writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))
      log(`  🌱 [git] projectRepos[${projectId}] → ${dir}`)
    }
  } catch (e) { log(`  ⚠️ [git] ${e}`) }
}

function normalizeProjectName(s: string): string {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * TASK-3089: projekt se otvara SAMO za uvjerljivo ime.
 *
 * Prva verzija je otvarala projekt za svaki lanac, pa su iz običnih Goranovih poruka nastali
 * projekti „ok, imamo", „umjesto shazam" i „Projekta" (i tri prazna git stabla uz njih).
 * Ime projekta mora izgledati kao ime, a ne kao ulomak rečenice:
 *   • CamelCase (`VoiceKeeper`, `MelodyFinder`, `TaskManager`), ili
 *   • jedna riječ koja počinje velikim slovom i nije obična hrvatska riječ iz zahtjeva.
 * Sve ostalo → bez projekta. Bolje zadatak bez projekta nego ploča puna izmišljenih.
 */
const NOT_A_PROJECT = /^(projekt|projekta|projektu|zadatak|zadatka|aplikacija|aplikacije|sustav|sustava|rjesenje|rješenje|analiza|verzija|imamo|ostalo|nesto|nešto|treba|molim|hitno|ostalo)$/i

function isProjectWorthyName(name: string): boolean {
  const n = String(name || '').trim()
  if (n.length < 4 || n.length > 40) return false
  if (/[,;:!?/\\]/.test(n)) return false                 // ulomak rečenice, ne ime
  if (/\s/.test(n)) return false                          // ime projekta je jedna riječ
  if (NOT_A_PROJECT.test(n)) return false
  if (/^[A-ZČĆŠĐŽ][a-zčćšđž0-9]*(?:[A-ZČĆŠĐŽ][A-Za-zčćšđž0-9]*)+$/.test(n)) return true   // CamelCase
  return /^[A-ZČĆŠĐŽ][a-zčćšđž0-9-]{3,}$/.test(n)         // jedna riječ Velikim slovom
}

async function ensureProjectForChain(label: string): Promise<string | null> {
  try {
    const name = String(label || '').trim()
    if (!isProjectWorthyName(name)) {
      log(`  📁 [projekt] „${name}" ne izgleda kao ime projekta — lanac ostaje bez projekta`)
      return null
    }
    const key = normalizeProjectName(name)
    if (!key) return null
    const res = await fetch(PROJECTS_API_BASE)
    if (res.ok) {
      const raw: any = await res.json()
      const list: any[] = Array.isArray(raw) ? raw : (raw?.projects || [])
      const hit = list.find(p => normalizeProjectName(p?.name) === key)
      if (hit?.id) { log(`  📁 [projekt] postojeći: ${hit.id} "${hit.name}"`); return String(hit.id) }
    }
    const mk = await fetch(PROJECTS_API_BASE, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description: `Automatski otvoren iz zahtjeva korisnika (multi-agent lanac).` }),
    })
    if (!mk.ok) return null
    const p: any = await mk.json()
    if (!p?.id) return null
    log(`  📁 [projekt] otvoren novi: ${p.id} "${p.name}"`)
    await ensureProjectRepo(String(p.id), name)
    return String(p.id)
  } catch (e) { log(`  ⚠️ [projekt] ${e}`); return null }
}

/**
 * TASK-3093: PRIHVATNI KRITERIJI — zahtjev pretvoren u provjerljivu listu.
 *
 * Revizija 30.07. (Goranov zahtjev za glazbenu aplikaciju): od ~13 izričitih traženja
 * isporuka je pokrila 3. Promašeno je SVE što je bilo konkretno i provjerljivo — ime mape
 * na Nextcloudu (`Regoc-Music`), dijeljenje s korisnikom, boja sučelja, popis statusa
 * („Transcribing, searching, downloading %, Ready copy, playing"), rad kroz TaskManager.
 * Uzrok nije bila slabost modela nego to što je zahtjev kroz lanac putovao kao proza:
 * svaki agent ga je sažeo po svom, pa su detalji ispali.
 *
 * Ovdje se iz zahtjeva izvlače STAVKE koje se mogu odškvačiti — rečenice s „mora/treba",
 * navedena vlastita imena, nabrajanja i brojevi — i idu u prompt kao numerirana lista koju
 * agent na kraju mora proći jednu po jednu. Ne tumači zahtjev; samo ga čini nezaboravnim.
 */
/**
 * R2/TASK-4309: zadatak s oznakom `istrazivanje` na kraj prompta dobiva OBVEZAN izlaz
 * koraka 2 (dokument u RAG-u s project_id, tip=istrazivanje i izvorima). Bez ovoga bi
 * vratar u TaskWebUI-ju kažnjavao agenta za pravilo koje mu nitko nije rekao — isti
 * kvar zbog kojeg je CompletionGuard morao čekati promptove s `REGOC-STATUS` retkom.
 * Oznake se čitaju iz baze (`readTaskContext`), pa neoznačeni zadatak dobiva '' i
 * prompt mu je bajt-identičan starome putu.
 */
function researchStepTail(taskId: string | null, projectId: string | null): string {
  try {
    if (!taskId) return ''
    const { tags, projectId: dbProject } = readTaskContext(String(taskId))
    return buildResearchStepBlock({ id: String(taskId), tags, projectId: projectId || dbProject })
  } catch { return '' }
}

function buildAcceptanceChecklist(content: string): string {
  const txt = String(content || '').replace(/\r/g, '')
  if (txt.length < 120) return ''
  const parts = txt
    .split(/(?:\n+|(?<=[.!?])\s+|\s+-\s+|\s+—\s+)/)
    .map(s => s.trim())
    .filter(s => s.length >= 12 && s.length <= 320)
  const MUST = /\b(mora|moraju|treba|trebaju|obavezno|nemoj|ne smije|automatski|neka se zove|podijeli|podijelite|assignaj|assignajte|koristi|koristite|stavite|otvorite)\b/i
  const CONCRETE = /[A-ZČĆŠĐŽ][A-Za-zčćšđž0-9_-]{2,}|\d|%|\/|"|„/
  const seen = new Set<string>()
  const items: string[] = []
  for (const p of parts) {
    if (!MUST.test(p) && !CONCRETE.test(p)) continue
    const key = p.toLowerCase().replace(/[^a-zčćšđž0-9]/g, '').slice(0, 60)
    if (!key || seen.has(key)) continue
    seen.add(key)
    items.push(p)
    if (items.length >= 20) break
  }
  if (items.length < 3) return ''
  return `\n\n## PRIHVATNI KRITERIJI (iz zahtjeva korisnika — provjeri SVAKI prije nego javiš gotovo)\n` +
    items.map((s, i) => `${i + 1}. ${s}`).join('\n') +
    `\n\nNa kraju rezultata OBAVEZNO prođi listu i za svaku stavku napiši: broj + ✅ napravljeno (uz dokaz: datoteka/naredba/izlaz) ili ❌ nije napravljeno (uz razlog). ` +
    `Stavku koju NISI mogao napraviti ne preskači i ne prešuti — to je razlika između isporuke i izvještaja.`
}

/**
 * TASK-5029: koliko zadataka nosi oznaku `parent:<taskId>` (svi statusi, i otkazani).
 * Fail-CLOSED za lanac: nečitljiva baza vraća 1, jer je dupli lanac skuplja greška od
 * propuštenog (Goran ih ionako ne želi).
 */
function countChainChildren(taskId: string): number {
  try {
    const db = new Database(TASKS_DB_PATH, { readonly: true })
    try {
      const r = db.query(`SELECT COUNT(*) AS n FROM tasks WHERE tags LIKE ?`).get(`%"parent:${taskId}"%`) as { n?: number } | null
      return Number(r?.n || 0)
    } finally { db.close() }
  } catch (e) { log(`⚠️ [R2] brojanje djece ${taskId} nije uspjelo (${e}) — lanac se ne gradi`); return 1 }
}

/**
 * TASK-5029: status i oznaka `ceka-mjesto` prate STVARNI ishod spawna. Proces krenuo →
 * `in_progress` (i makni oznaku); strop → ostaje `pending`, oznaka + jedna bilješka.
 */
async function applySpawnOutcome(taskId: string, start: SpawnStart, tags?: string[] | null): Promise<void> {
  const body: Record<string, unknown> = {}
  const newTags = tagsAfterSpawnAttempt(tags, start)
  if (newTags) body.tags = newTags
  if (start.started) body.status = 'in_progress'
  else if (newTags) body.progressNotes = [waitingSlotNote(activeAgentSpawns.size, maxAgentConcurrent())]
  if (!Object.keys(body).length) {
    if (!start.started) log(`⏳ ${taskId} ostaje pending — spawn odbijen (${start.reason})`)
    return
  }
  await zatvoriZadatak(TASK_MANAGER_API, taskId, body, { log, zapisiNeuspjeh: false })
  if (!start.started) log(`⏳ ${taskId} ostaje pending s oznakom ${CEKA_MJESTO_TAG} (${activeAgentSpawns.size}/${maxAgentConcurrent()})`)
}

/** Posao koji taj agent STVARNO radi u lancu — generički „doradi" je premalo uputa. */
const TEAM_ROLE_BRIEF: Record<string, string> = {
  manda: 'Istraži temu i vrati činjenice s izvorima (RAG/web). Ne piši kod.',
  kosjenka: 'Napravi arhitekturu i plan izvedbe: komponente, tok podataka, rizici, redoslijed koraka.',
  dora: 'Analiziraj rezultat prethodnog koraka iz više perspektiva i izdvoji nalaze i preporuke.',
  jelena: 'Implementiraj po planu prethodnog koraka: napiši kod/datoteke i pokreni provjeru da radi.',
  grga: 'Osmisli i izradi UI/UX dio (izgled, raspored, korisnički tok).',
  gita: 'Izradi vizualni materijal (dijagram/slika/SVG) za ovaj zadatak.',
  malik: 'Sigurnosni pregled isporučenog: ulazi, tajne, ovlasti, OWASP rizici. Navedi konkretne nalaze.',
  potjeh: 'QA: provjeri radi li isporučeno STVARNO — pokreni build/testove/pozive i izvijesti PASS/FAIL po stavci.',
}

async function createSequentialHelpers(content: string, primaryAgent: string, primaryTaskId: string | null,
                                       primaryProjectId?: string, chatTag?: string | null,
                                       primaryTags?: string[] | null, primaryCreatedBy?: string | null): Promise<void> {
  if (!primaryTaskId) return
  try {
    // Anti-kaskada: helper-taskovi nose sustavni opis + originalni sadržaj → ne smiju stvarati nove helpere.
    if (isHelperEcho(content)) return
    // TASK-5029: lanac se gradi NAJVIŠE JEDNOM po zadatku, nikad za `nalog`, i gasi se
    // prekidačem `sequentialHelpers`. Prije je svaki ponovni spawn TASK-4999 rodio novi
    // „doradi rad" lanac (TASK-5002/5012/5021), iako je stari već bio otkazan.
    {
      const d = helperChainDecision({
        tags: primaryTags,
        existingChildren: countChainChildren(primaryTaskId),
        enabled: isEnabled('sequentialHelpers', true),
        createdBy: primaryCreatedBy, // TASK-255: korak lanca se izvršava u mjestu
      })
      if (!d.allow) { log(`  [R2] ${primaryTaskId}: lanac se ne gradi — ${d.reason}`); return }
    }
    // Cue (pomaže/predaj/„daj <ime>") + ostali spomenuti agenti — prepoznavanje je u AgentRouting.ts
    // (svi padeži, bez lažnih pogodaka na „git"/„mandat"/„doradi").
    let helpers: string[] = []
    let fromTeam = false
    // ADR-0018 F0b (TASK-5135, odluka A 02.10.): lanac SAMO uz izričitu dodjelu — glagol dodjele
    // + ime ili oznaka `lanac:<agent>`; sam spomen imena nije okidač (TASK-5114/5121 su dobivali
    // „doradi rad” zbog spomena). Kanal/sustav isključeni, strop 3. Povratak bez izmjene koda:
    // features.json `r2IzricitaDodjela.enabled=false` → stari okidač (hasHelperCue + spomen).
    const izricita = isEnabled('r2IzricitaDodjela', true)
    if (izricita) {
      const r = r2Pomocnici(content, primaryTags, primaryAgent)
      helpers = r.helpers
      log(`  [R2 izričito] ${primaryTaskId}: ${helpers.length ? `[${helpers.join(',')}] — ${r.razlog}` : r.razlog}${r.odbaceni.length ? ` · odbačeni: ${r.odbaceni.join(',')}` : ''}`)
    } else if (hasHelperCue(content)) {
      // TASK-4992: filtriraj po relevantnosti — kanal-agenti i neodgovarajući agenti ne smiju
      // ući u tim samo zbog toga što im je ime zapisano u sadržaju zadatka (npr. popis RAG
      // kolekcija: "agent_gita, agent_klaudio, agent_stribor" → lažni helper cue).
      helpers = filterTeamByRelevance(
        findMentionedAgents(content).filter(id => id !== primaryAgent),
        content
      )
    }
    // T1/TASK-3080: kad korisnik NE imenuje nikoga (uobičajen slučaj), tim predlaže
    // ModeClassifier. Do sada su ti prijedlozi išli samo u log, pa je i E4/E5 zahtjev
    // završavao na jednom agentu — Goranov nalaz 30.07. (TASK-071: široko istraživanje
    // dobila sama Jelena, potrošila 20 iteracija bez rezultata).
    if (!helpers.length && isEnabled('teamChain')) {
      try {
        const cls = getModeClassifier().classifyMessage(content)
        // TASK-255 (uzrok #1 pre-eskalacija): E1/E2 NE postaje multi-agent tim (SpawnSlotRules.timPoNaporu).
        if (!timPoNaporu(cls.effort)) {
          log(`  [teamChain] ${primaryTaskId}: ${cls.effort} — trivijalno/jednostručno, bez tima`)
        } else {
        const live = isEnabled('teamChainLive')
        const ordered = (cls.suggestedAgents || [])
          .filter(id => id && id !== primaryAgent && TEAM_ROLE_BRIEF[id])
          // TASK-4992: filtriraj po relevantnosti NAKON što ModeClassifier predloži tim
          .filter(id => filterTeamByRelevance([id], content).length > 0)
          .filter((id, i, a) => a.indexOf(id) === i)
          .sort((a, b) => (TEAM_ORDER[a] ?? 99) - (TEAM_ORDER[b] ?? 99))
        // TASK-3094: QA je zadnji po prirodnom redoslijedu, pa je kod stropa od 3 pomoćnika
        // ISPADAO iz lanca (E5 tim kosjenka/jelena/potjeh/malik/dora → potjeh se odrezao).
        // Upravo on prolazi prihvatne kriterije, pa mu se mjesto na KRAJU rezervira: strop
        // se primjenjuje na ostale, a QA se doda natrag kao zadnji korak.
        const qa = ordered.filter(id => id === 'potjeh')
        // F0b: bez izričite dodjele strop su 2 pomoćnika (ADR-0018 §2.2); stari put zadržava 3.
        const strop = izricita ? R2_STROP : 3
        const rest = ordered.filter(id => id !== 'potjeh').slice(0, strop - qa.length)
        const team = [...rest, ...qa]   // QA ostaje zadnji
        log(`  [teamChain ${live ? 'LIVE' : 'SHADOW'}] ${cls.mode}/${cls.effort} primarni=${primaryAgent} tim=[${team.join(',')}]`)
        if (live) { helpers = team; fromTeam = true }
        }
      } catch (e) { log(`  ⚠️ [teamChain] klasifikacija pala: ${e}`) }
    }
    if (!helpers.length) return
    // TASK-3086: naslov mora reći O KOJEM PROJEKTU je riječ i KOJI je ovo korak, jer se
    // „jelena: doradi rad (kosjenka)" na ploči ne razlikuje od bilo kojeg drugog lanca.
    // Format: „<Projekt> v1.<korak> · <agent>: <posao>" — verzija raste kroz lanac pa se
    // tijek zadatka vidi vizualno, po redu.
    let projName = (await fetchProjectName(primaryProjectId).catch(() => null)) || ''
    let chainProjectId = primaryProjectId
    if (!projName) {
      // Nema zavedenog projekta → otvori ga (uz provjeru da ne postoji) i zalijepi cijeli
      // lanac na njega, uključujući primarni zadatak. TASK-3087.
      const label = labelFromContent(content)
      const newId = await ensureProjectForChain(label)
      if (newId) {
        chainProjectId = newId
        projName = (await fetchProjectName(newId).catch(() => null)) || label
        // ADR-0012 §16 (G6): nije zatvaranje, ali je isti obrazac — `zapisiNeuspjeh:false`
        // jer promašen projekt ne pripada dnevniku neuspjelih ZATVARANJA.
        await zatvoriZadatak(TASK_MANAGER_API, primaryTaskId, { projectId: newId }, { log, zapisiNeuspjeh: false })
      } else projName = label
    }
    const acceptance = buildAcceptanceChecklist(content)
    let step = 1
    let prevTask = primaryTaskId
    for (const h of helpers) {
      step++
      const desc = fromTeam
        ? `Multi-agent lanac (sustav je sam rasporedio tim). TVOJ DIO: ${TEAM_ROLE_BRIEF[h]}\n\nPrethodni korak je radio: ${primaryAgent}. Pročitaj njegov rezultat u TaskManageru (zadatak ${prevTask}) i nastavi OD NJEGA — ne kreći ispočetka i ne ponavljaj njegov posao.\n\nOriginalni zahtjev korisnika: ${content}\n\nKoristi TOČNE putanje iz zahtjeva (ne izmišljaj imena datoteka). Ako ti za tvoj dio nedostaje ulaz, status je blocked s razlogom, ne completed.${acceptance}`
        : `Sekvencijalni multi-agent: nastavi i doradi rezultat prethodnog agenta (${primaryAgent}) na istom zadatku. Originalni zahtjev korisnika: ${content}. Koristi TOČNU putanju iz zahtjeva (ne izmišljaj imena datoteka); provjeri izlaz prethodnog koraka u ${HOME}/ i nadogradi svoj dio (npr. stil, kvaliteta, provjera).${acceptance}`
      try {
        // Z2/TASK-3012: helper je dijete primarnog zadatka — nasljeđuje njegov projekt
        // i nosi zapis izvora, inače cijeli lanac dorade završi bez projekta.
        const posao = fromTeam ? TEAM_ROLE_BRIEF[h].split(/[:.]/)[0].toLowerCase() : `doradi rad (${primaryAgent})`
        const title = `${projName} v1.${step} · ${h}: ${posao}`
        // `parent:<ID>` preživljava auto-unblock (koji briše `blockedBy`) — bez njega
        // `parentResultTail` ne zna čiji rezultat ubaciti u prompt. TASK-3082.
        // TASK-4646: lanac ima VLASTITI izvor (`regoc-chain`) — podivljali lanac je drugi
        // kvar od podivljale delegacije i mora se moći odvojeno izmjeriti i zaustaviti.
        // TASK-4761: `chat:<id>` mora putovati NIZ CIJELI lanac, ne samo na primarni zadatak —
        // inače pomoćni/nastavni korak (npr. TASK-4760 tip) dobije praznu, izoliranu sesiju
        // baš kad treba javiti natrag u razgovor koji ga je pokrenuo.
        const helperTags = [`parent:${prevTask}`, ...(chatTag ? [chatTag] : [])]
        const res = await fetch(TASK_MANAGER_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(withCreatedBy({ title, description: desc, priority: 1, assignee: h, blockedBy: [prevTask], tags: helperTags, status: 'pending', ...(chainProjectId ? { projectId: chainProjectId } : {}) }, TASK_SOURCE.CHAIN)) })
        const j = await res.json() as any
        log(`🔗 ${fromTeam ? 'T1 tim' : 'R2 helper'}: ${h} (blockedBy ${prevTask}) → ${j?.id || '?'}${primaryProjectId ? ` [${primaryProjectId} ← ${primaryTaskId}]` : ''}`)
        if (j?.id && chainProjectId) {
          await applyProjectSource(j.id, { kind: 'inherited', projectId: chainProjectId, parentTaskId: primaryTaskId, note: inheritedNote(primaryTaskId, chainProjectId) })
        }
        if (j?.id) prevTask = j.id
      } catch (e) { log(`R2 helper create fail (${h}): ${e}`) }
    }
  } catch (e) { log(`R2 error: ${e}`) }
}

async function delegateToAgent(decision: DelegationDecision, fromAgent: string, originalContent: string,
                               origin?: VoiceOrigin, parentMeta?: string | null): Promise<string> {
  if (!decision.agent || !decision.taskTitle) {
    return '❌ Greška u delegaciji - nedostaju parametri'
  }

  // DEDUP-GUARD (TASK-636): refuse to spawn a task from a recycled agent report.
  const guard = detectRecycledReport(originalContent)
  if (guard.recycled) {
    log(`🛑 DEDUP-GUARD: content is a recycled PAI report (markers: ${guard.markers.join(', ')}) — NOT delegating to ${decision.agent}`)
    return `🛑 **Delegacija blokirana (dedup-guard)**

Sadržaj koji se delegira je već gotov agent-izvještaj (PAI format), ne novi zahtjev.
Pronađeni markeri: ${guard.markers.join(', ')} (prag: ${REPORT_MARKER_THRESHOLD}).

Recikliranje summary-ja u opis novog taska je spriječeno — nije kreiran novi task niti pokrenut agent.
Za stvarni zadatak pošalji specifikaciju, ne kopirani izvještaj.`
  }

  log(`🎯 Delegating to ${decision.agent}: "${decision.taskTitle}"`)

  const agent = agentRegistry?.agents[decision.agent]
  // A6/TASK-3005: i delegacija iz poruke dobiva tier po težini posla. Zadatak još ne
  // postoji (kreira se par redaka niže), pa nema ni oznaka ni povijesti pokušaja —
  // odlučuje se isključivo iz teksta, a eskalacija ionako radi tek na sljedećem prolazu.
  const spawnTarget = await resolveTaskSpawnTarget(
    decision.agent,
    { id: null, title: decision.taskTitle, description: originalContent, tags: [] },
    agent?.model || 'sonnet',
  )
  const model = spawnTarget.provider === 'anthropic' ? spawnTarget.model : `${spawnTarget.provider}:${spawnTarget.model}`

  // Build full task description for TaskManager
  let fullDescription = `## Originalni zahtjev od: ${fromAgent}\n\n${originalContent}\n\n---\n\n**Zašto:** ${decision.reason}`

  // Auto-detect project from title + original content
  // U3/TASK-4263: kad zahtjev dolazi kroz ULAZNA VRATA iz telegramske grupe, projekt je
  // već određen na ulazu (`ProjectGuess` — ista pravila kao retroaktivni uvoz, uz ZADANI
  // PROJEKT GRUPE kao pad). Njegova odluka ima prednost pred `detectProjectId` jer daemon
  // ne zna iz koje je grupe poruka stigla: mjereno na sjeni (100 SportAI poruka / 7 dana)
  // 58 % ih projekt dobiva upravo iz grupe, pa bi bez ovoga većina troška grupe pala u
  // pretinac PRJ-033 umjesto na PRJ-034 — dakle točno ono što U3 treba popraviti.
  const ingestMeta = procitajIngestMeta(parentMeta)
  const detectedProject = ingestMeta?.projectId || detectProjectId(`${decision.taskTitle} ${originalContent}`)
  if (ingestMeta) {
    log(`📥 Ulazna vrata (${ingestMeta.grupa}, chat ${ingestMeta.chatId}): projekt ${ingestMeta.projectId} po izvoru „${ingestMeta.projectSource}", težina ${ingestMeta.effort}/${ingestMeta.tezina}`)
  }

  // Z2/TASK-3012: projekt se više ne pogađa samo iz teksta — dijete nasljeđuje projekt
  // roditelja iz lanca pokretanja. Dokaz iz sadržaja i dalje ima prednost (lanac smije
  // prijeći granicu projekta), a odluka uvijek nosi zapis izvora.
  const projectDecision = await resolveChildProject({
    fromAgent,
    content: originalContent,
    metadata: parentMeta ?? null,
    detected: detectedProject,
    lookupTask: fetchParentTask,
  })

  // Create task in TaskManager (for tracking only)
  // TASK-4761: `chat:<chatId>` ovdje omogućava `chatContextTail` da agentu (na SVAKOM
  // sljedećem spawnu ovog zadatka, uklj. lanac koji iz njega nastane) automatski priloži
  // sažetak razgovora — bez toga bi ga morao ručno prepisati (v. TelegramContextTail.ts).
  const taskRequest: TaskCreateRequest = {
    title: decision.taskTitle,
    description: fullDescription,
    priority: 2,
    assignee: decision.agent,
    // TASK-5029: NE `in_progress` unaprijed — status prelazi tek kad proces krene (applySpawnOutcome).
    project_id: projectDecision.projectId,
    tags: ingestMeta ? [`chat:${ingestMeta.chatId}`] : undefined,
  }

  log(`📁 Projekt djeteta: ${projectDecision.projectId} (${projectDecision.note})`)
  if (projectDecision.warning) log(`⚠️ Projekt/lanac: ${projectDecision.warning}`)

  const createdTask = await createTaskInManager(taskRequest)
  const taskId = createdTask?.id || null
  // TASK-5029: zadatak ostaje `pending` dok spawn ne krene (strop 3/3 ga je prije ostavljao
  // `in_progress` bez procesa — TASK-5026). Zapis izvora projekta ide odmah.
  if (taskId) await applyProjectSource(taskId, projectDecision)

  if (createdTask) {
    log(`✅ Task ${createdTask.id} created for ${decision.agent}`)
  }

  // TASK-624: Check if persistent daemon is running for this agent
  // R3/TASK-2561: `persistentAgents` je in-memory i preživi smrt daemona — rutanje po samom
  // zapisu je slalo posao u inbox koji nitko ne čita. Sada odlučuje PID (SSOT: decideSpawnRoute):
  // živ → persistent, mrtav → REAP lažnog zapisa + spawn-on-demand (put koji uvijek radi).
  // ADR-0022 F3 (TASK-5615): u načinu `on` ne-Klaudio trajni agent poruku NE dobiva u inbox —
  // ide istim spawn putem kao auto-exec (trajna sesija u opsegu, inače običan spawn).
  if (trajniNacin() === 'shadow' && isPersistentEnabled(decision.agent) && decision.agent !== 'klaudio') {
    log(`👁️ [trajni SHADOW] poruka ${taskId || '—'} → ${decision.agent}: put poruke ostaje ${persistentAgents.has(decision.agent) ? 'inbox (AgentDaemon)' : 'spawn'} — F3 nije uključen`)
  }
  if (inboxZaPoruku(decision.agent)) {
    // Route via messages.db inbox — persistent daemon picks it up
    log(`[PERSISTENT] Routing to persistent daemon: ${decision.agent}`)
    const db = getDb()
    const msgId = `delegate-${decision.agent}-${Date.now()}`
    // U3/TASK-4263: `chat_id` putuje i do durabilnog radnika — inače bi njegov izvještaj
    // (put kroz `AgentDaemon` → `user`) završio u REGOČ grupi, a ne u onoj koja je pitala.
    db.prepare(`
      INSERT INTO messages (id, from_agent, to_agent, content, message_type, priority, status, chat_id, metadata)
      VALUES (?, 'regoc', ?, ?, 'command', 3, 'pending', ?, ?)
    `).run(msgId, decision.agent, originalContent, origin?.voiceRelay === false ? origin.chatId : null,
           JSON.stringify(ingestMeta ? { taskId, ...ingestMeta } : { taskId }))
    db.close()

    return `✅ **Agent ${agent?.name || decision.agent} (persistent)**

**Task ID:** ${taskId || 'N/A'}
**Agent:** ${agent?.name || decision.agent} (${agent?.role || 'Specialist'})
**Model:** ${model}
**Razlog:** ${decision.reason}

Poruka poslana persistent daemon-u. Ceka u inbox-u.`
  }

  // Fallback: Build agent prompt and spawn on-demand (ALWAYS works)
  // Z3/TASK-3013: agentu se KAŽE na kojem je projektu (zadnji odjeljak prompta) da bi
  // taj isti `projectId` mogao proslijediti kad sam stvara zadatke.
  const prompt = buildAgentPrompt(
    decision.agent,
    originalContent,
    fromAgent,
    decision.reason,
    decision.ragHints || [],
    taskId,
    // TASK-3097: i na putu iz konzole primarni agent dobiva prihvatne kriterije, ne samo
    // helperi — inače prvi korak lanca radi bez liste koju svi ostali imaju.
    // TASK-4761: chatContextTail ovdje, ne samo u auto-exec petlji — ovo JE prvi spawn.
    (await buildProjectTail(projectDecision.projectId)) + buildAcceptanceChecklist(originalContent) + chatContextTail(taskRequest.tags)
  )

  // ADR-0022 F3 (TASK-5615): trajni agent i na putu poruke nastavlja svoju sesiju (u opsegu).
  // Zauzeta sesija → zadatak ostaje `pending` + `ceka-sesiju`; auto-exec ga pokreće kad se oslobodi.
  let trajniPoruke: TrajniSpawn | null = null
  if (taskId && trajniNacin() === 'on' && decision.agent !== 'klaudio') {
    const tr = await pripremiTrajniSpawn(decision.agent, { id: taskId, tags: createdTask?.tags ?? taskRequest.tags ?? [], projectId: projectDecision.projectId || null }, spawnTarget)
    if (tr.akcija === 'cekaj') {
      await createSequentialHelpers(originalContent, decision.agent, taskId, projectDecision.projectId, ingestMeta ? `chat:${ingestMeta.chatId}` : null, taskRequest.tags ?? [])
      return `⏳ **Zadatak ${taskId} čeka trajnu sesiju** agenta ${agent?.name || decision.agent}

**Razlog:** sesija je zauzeta drugim zadatkom. Status ostaje pending; kreće sam čim se sesija oslobodi.`
    }
    trajniPoruke = tr.trajni
  }

  // Spawn agent on-demand (fire-and-forget); status ide za stvarnim ishodom (TASK-5029).
  await pripremiMemorijuZaSpawn(taskId, decision.agent)
  const start = spawnAgentOnDemand(decision.agent, prompt, spawnTarget, taskId, fromAgent, origin, trajniPoruke)
  if (taskId) await applySpawnOutcome(taskId, start, createdTask?.tags ?? taskRequest.tags ?? [])
  if (taskId && start.started && trajniPoruke) await oznaciTrajniStart(taskId, createdTask?.tags ?? taskRequest.tags ?? [], decision.agent, trajniPoruke)
  await createSequentialHelpers(originalContent, decision.agent, taskId, projectDecision.projectId, ingestMeta ? `chat:${ingestMeta.chatId}` : null, taskRequest.tags ?? [])

  if (!start.started) {
    return `⏳ **Zadatak ${taskId || 'N/A'} čeka** (${start.reason === 'strop' ? `sva mjesta zauzeta, ${activeAgentSpawns.size}/${maxAgentConcurrent()}` : start.reason})

**Agent:** ${agent?.name || decision.agent} (${agent?.role || 'Specialist'})
**Razlog:** ${decision.reason}

Status ostaje pending; auto-exec ga pokreće čim to bude moguće.`
  }

  return `✅ **Agent ${agent?.name || decision.agent} pokrenut**

**Task ID:** ${taskId || 'N/A'}
**Agent:** ${agent?.name || decision.agent} (${agent?.role || 'Specialist'})
**Model:** ${model}
**Razlog:** ${decision.reason}

Agent radi na zadatku. Rezultat dolazi čim završi.`
}

// ============================================
// LEGACY: AI Processing (kept for complex cases)
// ============================================

async function processWithAI(content: string, fromAgent: string): Promise<string> {
  // This is now only used for edge cases that don't fit routing
  log(`⚠️ Fallback to AI processing (should be rare)`)

  const ragContext = await queryRAG(`REGOČ ${content.substring(0, 100)}`, 3)

  const systemPrompt = `Ti si REGOČ orchestrator. Odgovori KRATKO (max 3 rečenice).
Ako zahtjev treba delegaciju, reci "Delegiram [AGENTU]" i navedi razlog.
Kontekst: ${ragContext || 'Nema'}
Od: ${fromAgent}`

  try {
    const proc = Bun.spawn(['bun', INFERENCE_TOOL, '--level', 'standard', systemPrompt, content], {
      stdout: 'pipe',
      stderr: 'pipe'
    })

    const output = await new Response(proc.stdout).text()
    await proc.exited
    return output.trim()
  } catch (error) {
    return `Greška: ${error}`
  }
}

// ============================================
// TASK-185: Task Completion Detection
// ============================================

/**
 * Extract task completion signal from agent response
 * Format: [TASK_COMPLETE:TASK-XXX]
 */
function extractTaskCompletion(content: string): string | null {
  const match = content.match(/\[TASK_COMPLETE:([A-Z]+-\d+)\]/i)
  return match ? match[1] : null
}

/**
 * Extract task progress update from agent response
 * Format: [PROGRESS:50%]
 */
function extractTaskProgress(content: string): number | null {
  const match = content.match(/\[PROGRESS:(\d+)%\]/i)
  return match ? parseInt(match[1]) : null
}

/**
 * Update task status when agent signals completion
 */
async function handleTaskCompletion(taskId: string, agent: string): Promise<void> {
  try {
    log(`✅ TASK-185: Agent ${agent} completed task ${taskId}`)

    // Import TaskManagerSQL dynamically to avoid circular dependencies
    const { getTaskManagerSQL } = await import('./TaskManagerSQL')
    const taskManager = getTaskManagerSQL()

    // Update task to completed
    taskManager.completeTask(taskId, `Auto-completed by agent ${agent}`, agent)

    log(`  Task ${taskId} marked as completed`)
    logEvent(getDb(), 'task_auto_completed', agent, `Task ${taskId} auto-completed by ${agent}`)
  } catch (error) {
    log(`  ❌ Error updating task ${taskId}: ${error}`)
  }
}

/**
 * Update task progress when agent signals progress
 */
async function handleTaskProgress(taskId: string, agent: string, progress: number): Promise<void> {
  try {
    log(`📊 TASK-185: Agent ${agent} updated progress on ${taskId} to ${progress}%`)

    const { getTaskManagerSQL } = await import('./TaskManagerSQL')
    const taskManager = getTaskManagerSQL()

    const task = taskManager.updateTask(taskId, { progressPercent: progress })

    if (task) {
      log(`  Task ${taskId} progress updated to ${progress}%`)
      logEvent(getDb(), 'task_progress_updated', agent, `Task ${taskId} progress: ${progress}%`)
    } else {
      log(`  ⚠️ Task ${taskId} not found`)
    }
  } catch (error) {
    log(`  ❌ Error updating task ${taskId} progress: ${error}`)
  }
}

// ============================================
// TASK-308: Project Command Detection
// TASK-3601 (F2): REGEX PRVI — model samo kad regex ne nađe ništa
// ============================================
// Logika je preseljena u `./ProjectDetect` da bi mjerilo
// `tests/project_detect_accuracy.ts` mjerilo ISTI kod koji vrti pogon (import daemona
// bi pokrenuo daemon, pa je mjerilo logiku dosad portalo — a kopija tiho oduta).
// Mjereno 02.09.2026. na popisu svih 19 poruka iz messages.db koje spominju „projekt":
// regex 18/19 uz 0 poziva, Sonnet 17/19 uz 19 spawnova, Ollama 16/19. Plaćeni model
// dakle radi VIŠE grešaka od regexa — i zato više nije prvi.

// ============================================
// Message Processing - DELEGATION PATTERN
// ============================================

async function processMessage(db: Database, msg: Message): Promise<void> {
  log(`📨 Message from ${msg.from_agent}: "${msg.content.substring(0, 50)}..."`)
  updateStatus('Processing message', `Od ${msg.from_agent}: ${msg.content.substring(0, 40)}...`)

  // Claim the message
  if (!claimMessage(db, msg.id)) {
    log(`  Message already claimed, skipping`)
    return
  }

  logEvent(db, 'message_processing', msg.from_agent, msg.content.substring(0, 100))

  try {
    // ============================================
    // TASK-185: Check for task completion signals
    // ============================================

    const completedTaskId = extractTaskCompletion(msg.content)
    if (completedTaskId) {
      await handleTaskCompletion(completedTaskId, msg.from_agent)
    }

    const progressValue = extractTaskProgress(msg.content)
    if (progressValue !== null) {
      // Try to extract task ID from previous messages or context
      // For now, we'll need the agent to specify the task ID in the progress update
      // Future: maintain conversation context to auto-detect task ID
      const taskIdMatch = msg.content.match(/(?:task|TASK-|#)([A-Z]+-\d+)/i)
      if (taskIdMatch) {
        await handleTaskProgress(taskIdMatch[1], msg.from_agent, progressValue)
      }
    }
    // ============================================
    // GUARD (TASK-3605): agentov ZAVRŠNI IZVJEŠTAJ nije specifikacija novog posla
    // ============================================
    // RegocDaemon je TREĆI neovisni potrošač messages.db (uz AgentDaemon.ts:241 i
    // AgentWorker.ts:382) i JEDINI koji `isNonActionableMessage` nije zvao — pa je
    // 02.09.2026. 11:30:15 kosjenkin završni izvještaj o TASK-3587 prošao ravno u
    // classifyAndRoute (E5) i otvorio TASK-3605 nad samim sobom (echo-dispatch).
    // Provjera stoji ISPRED project-detekcije (TASK-3601: ta više ne spawna model,
    // ali izvještaj ionako ne smije proći dalje u rutanje).
    // Signali dovršenosti (extractTaskCompletion/Progress) gore se i dalje obrade;
    // ovdje se zaustavlja samo pretvaranje izvještaja u NOVI zadatak.
    // TASK-4752: STROJNA DOJAVA SCHEDULERA nije specifikacija. Sud je strukturan
    // (from_agent='scheduler' / metadata.type), jer frazni `isNonActionableMessage`
    // nad živim korpusom hvata 162 od 303 takve poruke — promašuje svaki
    // "AUTO-START: …" i svaku dojavu s retkom "Next unblocked: …". Na scheduler se
    // NE odgovara: 'scheduler' je proces bez inboxa, odgovor bi samo punio red.
    const schedulerNotice = isSchedulerNotification(msg)
    if (schedulerNotice || isNonActionableMessage(msg.content)) {
      if (!schedulerNotice) {
        const notice = '🛑 Poruka prepoznata kao završni izvještaj / sistemska obavijest, ne kao specifikacija — NE otvaram novi zadatak. Ako je ovo stvarno novi posao, pošalji ga kao specifikaciju (ŠTO / ZAŠTO / KOJI fajlovi / KRITERIJ gotovosti).'
        sendResponse(db, msg.from_agent, notice, msg.priority, originOf(msg))
      }
      const razlog = schedulerNotice
        ? 'scheduler notice (task_completion / AUTO-START)'
        : 'non-actionable (završni izvještaj / lifecycle notice)'
      log(`🛑 NOT delegating message ${String(msg.id).substring(0, 8)} from ${msg.from_agent}: ${razlog}, not a task spec`)
      logEvent(db, 'dispatch_blocked', msg.from_agent, schedulerNotice ? 'scheduler notice: task_completion / auto-start' : 'non-actionable: completion report / lifecycle notice')
      completeMessage(db, msg.id)
      processedCount++
      return
    }

    // ============================================
    // TASK-308 / TASK-3601 (F2): Project Command Detection — REGEX PRVI
    // ============================================

    // TASK-2559: trivijalna poruka („bok", „hvala", „ok", „ping") NIKAD nije
    // project-command. Preskok ostaje jer je i regex-put suvišan posao za takvu poruku.
    // Uvjet je isti kao za live gate (oba flaga) → flag OFF = potpuno staro ponašanje.
    const trivialEarly = isEnabled('modeClassify') && isEnabled('modeClassifyLive')
      ? classifyTrivial(msg.content)
      : null
    if (trivialEarly) {
      log(`  ⏭️ [modeClassify LIVE] trivijalno (${trivialEarly.kind}) — preskačem project-detection`)
    }

    // TASK-3601: redoslijed je OBRNUT — regex je prvi (18/19, 0 poziva, 0 ms), a model
    // se zove SAMO kad regex ništa ne nađe i samo ako je `ollamaProjectDetect` upaljen
    // (tada LOKALNA Ollama). Flag OFF ⇒ NIJEDAN `claude --print` spawn po poruci.
    const projectCommandResult: ProjectDetectOutcome = trivialEarly
      ? { isProjectCommand: false, projectName: null, action: null, via: 'none', modelCalled: false }
      : await detectProjectCommand(
          { content: msg.content, from_agent: msg.from_agent },
          { modelEnabled: isEnabled('ollamaProjectDetect'), backend: 'local', log },
        )

    if (projectCommandResult.isProjectCommand && projectCommandResult.projectName) {
      const projectName = projectCommandResult.projectName
      const action = projectCommandResult.action

      log(`🎯 TASK-308: Project command detected (${projectCommandResult.via}) - Action: ${action}, Project: "${projectName}"`)

      try {
        const result = await createProjectWorkflow({ name: projectName })

        if (result.success && result.project) {
          const response = `✅ Kreiran projekt: ${result.project.name}\n📁 Nextcloud: ${result.nextcloud?.folder_path || 'N/A'}\n🆔 ID: ${result.project.id}`
          const responseId = sendResponse(db, msg.from_agent, response, msg.priority, originOf(msg))
          log(`✅ Project workflow completed: ${result.project.id}`)

          completeMessage(db, msg.id)
          processedCount++

          lastActivityDesc = `${msg.from_agent}: Projekt "${projectName}" kreiran`
          lastActivityTimestamp = new Date().toISOString()

          logEvent(db, 'project_created', msg.from_agent, `Project: ${result.project.id} - ${projectName}`)
          updateStatus('Idle', 'Spreman za zahtjeve')
          return
        } else {
          const errorResponse = `❌ Greška pri kreiranju projekta: ${result.error}`
          const responseId = sendResponse(db, msg.from_agent, errorResponse, msg.priority)
          log(`❌ Project workflow failed: ${result.error}`)

          completeMessage(db, msg.id)
          processedCount++

          logEvent(db, 'project_creation_failed', msg.from_agent, result.error || 'Unknown error')
          updateStatus('Idle', 'Spreman za zahtjeve')
          return
        }
      } catch (projectError) {
        log(`❌ Project workflow exception: ${projectError}`)
        const errorResponse = `❌ Greška pri kreiranju projekta: ${projectError instanceof Error ? projectError.message : String(projectError)}`
        sendResponse(db, msg.from_agent, errorResponse, msg.priority)
        completeMessage(db, msg.id)
        processedCount++
        logEvent(db, 'project_creation_exception', msg.from_agent, String(projectError))
        updateStatus('Idle', 'Spreman za zahtjeve')
        return
      }
    }

    // ============================================
    // ANTI-RECURSION GUARD: Prevent agent results from being re-delegated
    // Agent result notifications are NOT tasks - just acknowledge them.
    // Catches: old AgentWorker messages AND any agent status notifications.
    // ============================================

    // SPAWN-FAILURE GUARD (TASK-638 loop fix): a claude --print spawn that exits
    // non-zero posts back a bare failure string ("Nisam uspio izvrsiti zadatak:
    // claude --print exit 1") with NO ❌/neuspješan prefix and NO PAI markers, so
    // it slips past both the anti-recursion guard and the dedup-guard, gets
    // classified as "Općeniti zahtjev" and re-delegated — producing the infinite
    // exit-1 → delegate → exit-1 loop (TASK-2396 …). Treat these as failure
    // notifications, not tasks.
    const isSpawnFailure =
      msg.content.includes('claude --print exit') ||
      msg.content.includes('Nisam uspio izvrsiti zadatak')

    // AGENT-LIFECYCLE GUARD (TASK-638 loop fix): the original guard only matched
    // "✅ **..završio" for the success case, letting the FAR more common
    // "✅ **Agent X pokrenut**" (agent-started, 829 in the live backlog) and the
    // daemon's own self-status notices ("Svi agent slotovi zauzeti", "Greška pri
    // obradi zahtjeva") through to be re-delegated. None of these are requests.
    const isLifecycleNotification =
      (msg.content.includes('Agent') && (msg.content.includes('pokrenut') || msg.content.includes('završio') || msg.content.includes('neuspješan'))) ||
      msg.content.includes('Svi agent slotovi zauzeti') ||
      msg.content.startsWith('Greška pri obradi zahtjeva')

    const isAgentNotification =
      msg.message_type === 'agent_result' ||
      (msg.from_agent === 'agentworker') ||
      (msg.content.startsWith('❌ Agent ') && msg.content.includes('neuspješan')) ||
      (msg.content.startsWith('✅ **') && msg.content.includes('završio')) ||
      isSpawnFailure ||
      isLifecycleNotification

    if (isAgentNotification) {
      const isFailure = isSpawnFailure || msg.content.includes('neuspješan') || msg.content.startsWith('❌')
      const logPrefix = isFailure ? '❌' : '✅'
      log(`${logPrefix} Agent notification received (NOT delegating): ${msg.content.substring(0, 100)}...`)

      logEvent(db, isFailure ? 'agent_task_failed' : 'agent_task_completed', msg.from_agent, msg.content.substring(0, 300))

      completeMessage(db, msg.id)
      processedCount++

      lastActivityDesc = `Agent notification: ${msg.content.substring(0, 60)}`
      lastActivityTimestamp = new Date().toISOString()

      updateStatus('Idle', 'Spreman za zahtjeve')
      return
    }

    // ============================================
    // CIRCUIT BREAKER: Prevent infinite loops from repeated identical messages
    // If same content hash from same agent appears 3+ times in 5 min → drop, don't delegate
    // ============================================
    if (!circuitBreakerState) circuitBreakerState = new Map()
    const cbKey = `${msg.from_agent}:${msg.content.substring(0, 80)}`
    const cbNow = Date.now()
    const cbEntry = circuitBreakerState.get(cbKey) || { count: 0, firstSeen: cbNow }
    cbEntry.count++
    circuitBreakerState.set(cbKey, cbEntry)
    // Clean old entries every 100 messages
    if (processedCount % 100 === 0) {
      for (const [k, v] of circuitBreakerState) {
        if (cbNow - v.firstSeen > 300000) circuitBreakerState.delete(k)
      }
    }
    if (cbEntry.count >= 3 && cbNow - cbEntry.firstSeen < 300000) {
      log(`🛑 CIRCUIT BREAKER: "${msg.content.substring(0, 60)}..." repeated ${cbEntry.count}x in ${Math.round((cbNow - cbEntry.firstSeen) / 1000)}s — DROPPING (not delegating)`)
      completeMessage(db, msg.id)
      processedCount++
      updateStatus('Idle', 'Circuit breaker triggered')
      return
    }

    // ============================================
    // Delegation Pattern
    // ============================================

    // 1. Classify and route the message
    const decision = applyTeamLead(classifyAndRoute(msg.content, msg.from_agent), msg.content)
    log(`🎯 Decision: ${decision.type} → ${decision.agent || 'SELF'} (${decision.reason})`)

    let response: string

    switch (decision.type) {
      case 'system_query':
        // REGOČ odgovara sam - bez AI, samo iz GEMINI konteksta
        // TASK-2559: trivijalne poruke nose gotov template (pozdrav/hvala/ok/ping);
        // sve ostalo i dalje ide kroz generateSystemResponse.
        updateStatus('System query', `Odgovaram na sistemski upit...`)
        response = decision.templateResponse ?? generateSystemResponse(msg.content)
        break

      case 'delegate':
        // Delegiraj agentu - NE koristi AI, samo routing
        updateStatus('Delegating', `Delegiram ${decision.agent}...`)
        // Z2/TASK-3012: msg.metadata nosi lanac pokretanja → dijete nasljeđuje projekt roditelja.
        response = await delegateToAgent(decision, msg.from_agent, msg.content, originOf(msg), msg.metadata)
        break

      default:
        // Fallback - rijetko bi se trebao koristiti
        updateStatus('AI fallback', `Fallback obrada...`)
        response = await processWithAI(msg.content, msg.from_agent)
    }

    // Send response back to the agent
    updateStatus('Sending response', `Šaljem odgovor ${msg.from_agent}...`)
    // U3/TASK-4263: odgovor nasljeđuje porijeklo poruke. Za zahtjev iz telegramske grupe
    // to je jedina potvrda koju korisnik dobiva — s brojem zadatka i imenom izvršitelja.
    // Bez `originOf` bi otišla na REGOC_GROUP_FALLBACK, dakle u tuđu grupu.
    const responseId = sendResponse(db, msg.from_agent, response, msg.priority, originOf(msg))
    log(`✅ Response sent to ${msg.from_agent} (ID: ${responseId})`)

    // Mark original message as completed
    completeMessage(db, msg.id)
    processedCount++

    // Track last activity for status display
    lastActivityDesc = `${msg.from_agent}: "${msg.content.substring(0, 30)}..." → ${decision.type}`
    lastActivityTimestamp = new Date().toISOString()

    logEvent(db, 'message_completed', msg.from_agent, `${decision.type}: ${response.substring(0, 100)}`)

  } catch (error) {
    log(`❌ Error processing: ${error}`)
    logEvent(db, 'message_error', msg.from_agent, String(error))

    // Send error response
    sendResponse(db, msg.from_agent, `Greška pri obradi zahtjeva: ${error}`, msg.priority, originOf(msg))
    completeMessage(db, msg.id)
  }
}

// ============================================
// Daemon Control
// ============================================

function writePid(): void {
  writeFileSync(PID_FILE, String(process.pid))
}

function readPid(): number | null {
  try {
    if (existsSync(PID_FILE)) {
      return parseInt(readFileSync(PID_FILE, 'utf-8').trim())
    }
  } catch {}
  return null
}

function removePid(): void {
  try {
    if (existsSync(PID_FILE)) {
      unlinkSync(PID_FILE)
    }
  } catch {}
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Kumulativno CPU vrijeme procesa (utime+stime+cutime+cstime, u jiffies) iz
 * platformnog sloja (Linux procfs stat, macOS `ps -o time=`). Vraća -1 ako proces ne postoji.
 * Koristi se kao "radi li agent" signal: ako u 2h prozoru CPU NE poraste, stoji.
 */
function readProcCpuJiffies(pid: number): number {
  try {
    return platformaCpuVrijeme(pid) ?? -1
  } catch {
    return -1
  }
}

/**
 * Ugasi zaglavljen/predug agent spawn i obavijesti naručitelja.
 * Entry iz activeAgentSpawns briše spawn handler (proc.exited) u svom finally bloku.
 */
function killAgentSpawn(info: AgentSpawnInfo, agentName: string, reason: string, by: string = 'watchdog',
                       pauza: boolean = false, biljeska?: string): void {
  // D3/TASK-2955: OZNAKA PRIJE SIGNALA. Handler spawna po njoj razlikuje "ubili smo ga mi"
  // od "netko izvan daemona ga je ubio" — bez nje su oba slučaja izgledala isto (exit 143).
  info.killedBy = { reason, by, at: Date.now() }
  const ageSec = Math.round((Date.now() - info.startTime) / 1000)
  log(`🛑 Šaljem SIGTERM agentu ${info.agent} (${agentName}) pid=${info.pid} ppid=${process.pid} task=${info.taskId || 'N/A'} starost=${ageSec}s — ${by}: ${reason}`)

  try { process.kill(info.pid, 'SIGTERM') } catch {}
  setTimeout(() => { try { process.kill(info.pid, 'SIGKILL') } catch {} }, 5000)

  try {
    const db = getDb()
    sendResponse(db, info.fromAgent,
      `🛑 Agent **${agentName}** prekinut: ${reason}. Zadatak ${info.taskId || 'N/A'} ${pauza ? 'ostaje u zatečenom stanju i nastavlja se poslije.' : 'nije dovršen.'}`, 5,
      info.origin)   // TASK-2612: glasovni zahtjev → i obavijest o prekidu ide u kanal
    logEvent(db, 'agent_task_killed', info.agent, `Task ${info.taskId}: ${reason}`)
    db.close()
  } catch {}

  if (info.taskId) {
    // PAUZA NIJE OTKAZIVANJE (pravilo 17).
    //
    // Do 25.08.2026. je svako gašenje spawna upisivalo `cancelled`, pa je i pauza —
    // koja postoji baš zato da se rad zaustavi BEZ gubitka mjesta — zadatak gurala u
    // terminalno stanje iz kojega se ne vraća ni s force. Dogodilo se dvaput u jednom
    // danu (TASK-3447 i TASK-3428), a oba je puta posao morao biti otvoren iznova.
    //
    // Sada: pauza ostavlja status kakav jest i upisuje samo bilješku. Otkazivanje
    // ostaje za stvarne prekide — gašenje daemona, dosegnut maksimum izvođenja,
    // agent bez znakova života.
    //
    // M4/TASK-4627: `pauza` je od sada „ne diraj status, samo zabilježi" u ŠIREM smislu —
    // uz pauzu je tu i uredno gašenje, gdje je status VEĆ vraćen u `pending` (reclaim) prije
    // slanja signala. Zato bilješka smije doći izvana: fiksni tekst „status ostaje" bi u tom
    // slučaju lagao. Bez `biljeska` ponašanje je nepromijenjeno.
    const tijelo = pauza
      ? { progress_note: (biljeska || `⏸️ Agent prekinut (${by}): ${reason}. Status ostaje — zadatak se nastavlja po nastavku rada.`).slice(0, 500) }
      : { status: 'cancelled', blocked_reason: `Prekinuto (${by}): ${reason}`.slice(0, 500) }
    fetch(`${TASK_MANAGER_API}/${info.taskId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tijelo)
    }).catch(() => {})
  }
}

/**
 * D3/TASK-2955: uredno gašenje svih aktivnih spawnova prije izlaza daemona.
 *
 * Prije je SIGTERM handler samo pozvao process.exit(0). Bun pri izlazu tiho ubije
 * svu spawnanu djecu, pa su ona u logu ispadala kao "❌ failed (exit 143): " —
 * bez ijednog traga da ih je pokosio NAŠ restart. Sada svako dijete prođe kroz
 * killAgentSpawn s razlogom, pa se u logu vidi tko je naredio i zašto.
 */
function shutdownActiveSpawns(reason: string, resumed: Set<string> = new Set()): number {
  prekiniVoditelje(reason, 'shutdown')
  const count = activeAgentSpawns.size
  if (count === 0) return 0

  log(`🛑 Gašenje: ${count} aktivn(ih) spawn(ova) — prekidam ih uredno (razlog: ${reason})`)
  for (const [, info] of activeAgentSpawns.entries()) {
    const agentName = agentRegistry?.agents?.[info.agent]?.name || info.agent
    try {
      // M4/TASK-4627: zadatak koji je već vraćen u red NE smije dobiti `cancelled` —
      // `pending -> cancelled` je dopušten prijelaz, pa bi ovaj poziv poništio nastavak.
      const zaNastavak = !!info.taskId && resumed.has(info.taskId)
      killAgentSpawn(info, agentName, reason, 'shutdown', zaNastavak,
        zaNastavak
          ? `↻ Agent prekinut urednim gašenjem (${reason}). Zadatak je vraćen u red s oznakom nastavka — sljedeći prolaz ga nastavlja.`
          : undefined)
    } catch (e) {
      log(`⚠️ [shutdown] prekid ${info.agent} (pid ${info.pid}) pao: ${e}`)
    }
  }
  return count
}

/**
 * M4/TASK-4627: prije SIGTERM-a vrati zadatke aktivnih spawnova u red.
 *
 * Gašenje ne smije visjeti — cijela radnja ide pod rokom `SHUTDOWN_RESUME_TIMEOUT_MS`;
 * ako TaskManager ne odgovori na vrijeme, vraća se prazan skup i sve ide starim putem
 * (otkazivanje), jer je vidljivo otkazan zadatak bolji od daemona koji se ne gasi.
 */
const SHUTDOWN_RESUME_TIMEOUT_MS = 5000

async function prepareShutdownResume(reason: string): Promise<Set<string>> {
  const prazno = new Set<string>()
  try {
    if (!isEnabled('shutdownResume', false)) return prazno
    if (activeAgentSpawns.size === 0) return prazno
    const live = isEnabled('shutdownResumeLive', false)

    const spawns = [...activeAgentSpawns.values()].map(i => ({ agent: i.agent, taskId: i.taskId, pid: i.pid }))
    const posao = markSpawnsForResume(spawns, { reason, live, maxRounds: SHUTDOWN_RESUME_MAX_ROUNDS }, {
      getTask: async (id) => {
        const r = await fetch(`${TASK_MANAGER_API}/${id}`)
        if (!r.ok) return null
        return await r.json() as any
      },
      setTags: async (id, tags, note) => {
        const r = await fetch(`${TASK_MANAGER_API}/${id}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tags, progressNotes: [note] }),
        })
        return r.ok
      },
      // `in_progress -> pending` NIJE u ValidStatusTransitions — obični PUT bi vratio 409.
      reclaim: async (id, why) => {
        const r = await fetch(`${TASK_MANAGER_API}/${id}/reclaim`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: why, by: 'shutdown-resume' }),
        })
        if (!r.ok) log(`  ⚠️ [gašenje→nastavak] reclaim ${id} → HTTP ${r.status}`)
        return r.ok
      },
      record: recordShutdownResume,
      log,
    })

    const izvjestaj = await Promise.race([
      posao,
      new Promise<null>(r => setTimeout(() => r(null), SHUTDOWN_RESUME_TIMEOUT_MS)),
    ])
    if (!izvjestaj) {
      log(`  ⚠️ [gašenje→nastavak] rok od ${SHUTDOWN_RESUME_TIMEOUT_MS} ms istekao — sve ide starim putem`)
      return prazno
    }
    log(`  ${live ? '↻' : '👁️'} [gašenje→nastavak${live ? '' : ' SHADOW'}] vraćeno u red: ${izvjestaj.resumed.length}`
      + `, strop: ${izvjestaj.exhausted.length}, palo: ${izvjestaj.failed.length}, preskočeno: ${izvjestaj.skipped.length}`)
    return new Set(izvjestaj.resumed)
  } catch (e) {
    log(`  ⚠️ [gašenje→nastavak] ${e} — sve ide starim putem`)
    return prazno
  }
}

/**
 * R7/TASK-2563: nuspojave za `requeueFailedTask` (mreža + dnevnik).
 *
 * Isti oblik kao kod M4 gašenja: `in_progress -> pending` ide ISKLJUČIVO kroz
 * `POST /api/tasks/:id/reclaim` — obični PUT bi vratio 409 (prijelaz namjerno nije
 * u `ValidStatusTransitions`).
 */
function failRequeueDeps(): FailRequeueDeps {
  return {
    getTask: async (id) => {
      const r = await fetch(`${TASK_MANAGER_API}/${id}`)
      if (!r.ok) return null
      return await r.json() as any
    },
    setTags: async (id, tags, note) => {
      const r = await fetch(`${TASK_MANAGER_API}/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags, progressNotes: [note] }),
      })
      return r.ok
    },
    reclaim: async (id, why) => {
      const r = await fetch(`${TASK_MANAGER_API}/${id}/reclaim`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: why, by: 'fail-requeue' }),
      })
      if (!r.ok) log(`  ⚠️ [neuspjeh→red] reclaim ${id} → HTTP ${r.status}`)
      return r.ok
    },
    record: recordFailRequeue,
    log,
  }
}

/**
 * W4/TASK-4617: nuspojave za `returnStepForRepair` (mreža + disk + dnevnik).
 *
 * Isti oblik kao `failRequeueDeps` i namjerno ISTI put natrag u red — `POST
 * /api/tasks/:id/reclaim`. Obični PUT `in_progress -> pending` vraća 409 (prijelaz
 * namjerno nije u `ValidStatusTransitions`), pa bi petlja tiho pala baš na koraku
 * zbog kojeg postoji. `by: 'critic-repair'` razlikuje ovo vraćanje od R7 (pad spawna)
 * i M4 (uredno gašenje) u dnevniku TaskManagera — tri različita uzroka, tri traga.
 */
function criticRepairDeps(): CriticRepairDeps {
  return {
    getTask: async (id) => {
      const r = await fetch(`${TASK_MANAGER_API}/${id}`)
      if (!r.ok) return null
      return await r.json() as any
    },
    setTags: async (id, tags, note) => {
      const r = await fetch(`${TASK_MANAGER_API}/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags, progressNotes: [note] }),
      })
      if (!r.ok) log(`  ⚠️ [vratar→popravak] oznaka ${id} → HTTP ${r.status}`)
      return r.ok
    },
    reclaim: async (id, why) => {
      const r = await fetch(`${TASK_MANAGER_API}/${id}/reclaim`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: why, by: 'critic-repair' }),
      })
      if (!r.ok) log(`  ⚠️ [vratar→popravak] reclaim ${id} → HTTP ${r.status}`)
      return r.ok
    },
    saveBrief: saveRepairBrief,
    clearBrief: clearRepairBrief,
    record: recordCriticRepair,
    log,
  }
}

/**
 * Liveness watchdog za spawn-on-demand agente (Goran 2026-06-17).
 * Prolazi listu jeftino (svakih AGENT_LIVENESS_SWEEP_MS), ali odluku o pojedinom
 * agentu donosi tek nakon punog 2h prozora od njegove zadnje provjere.
 * Agenti smiju raditi danima — NE gasimo po vremenu, samo ako:
 *   (a) ne pokazuju CPU napredak u zadnja 2h (zaglavljeni), ili
 *   (b) pređu apsolutni strop od 24h.
 */
async function watchdogCheckAgentSpawns(): Promise<void> {
  // ADR-0024: mrtav proces voditelja ne smije trajno držati traku (handler je fire-and-forget).
  for (const [key, info] of voditeljSpawns.entries()) {
    if (info.pid && !isRunning(info.pid)) { voditeljSpawns.delete(key); log(`🧹 [watchdog] mrtvo buđenje voditelja očišćeno: ${info.taskId} pid=${info.pid}`) }
  }
  if (activeAgentSpawns.size === 0) return
  const now = Date.now()

  for (const [key, info] of activeAgentSpawns.entries()) {
    // Handler još nije upisao pid → preskoči (handler će ga postaviti)
    if (!info.pid) continue
    // TASK-4992 FIX: ako je proces mrtav, očisti entry ODMAH umjesto da čekaš handler.
    // Handler je async fire-and-forget i može zauvijek ostati zagljavljen —
    // bez ovog čišćenja mrtav spawn blokira slot trajno.
    if (!isRunning(info.pid)) {
      activeAgentSpawns.delete(key)
      log(`🧹 [watchdog] mrtav spawn očišćen: ${info.agent} pid=${info.pid} task=${info.taskId || 'N/A'} — slot oslobođen (Active: ${activeAgentSpawns.size}/${maxAgentConcurrent()})`)
      continue
    }

    const ageMin = Math.floor((now - info.startTime) / 60000)
    const agentName = agentRegistry?.agents?.[info.agent]?.name || info.agent

    // TASK-4992 FIX (trajni): Ako task VIŠE NIJE in_progress (staleWatchdog/zombie ga
    // vratio na pending ili je completed/cancelled), a spawn još živi — ubij ga odmah.
    // Ovo hvata slučaj kad claude --print završi rad ali proces ostane visjeti.
    if (info.taskId && ageMin >= 10) {
      try {
        const taskResp = await fetch(`${TASK_MANAGER_API}/${info.taskId}`)
        if (taskResp.ok) {
          const taskData = await taskResp.json() as any
          const taskStatus = taskData?.status
          if (taskStatus && taskStatus !== 'in_progress') {
            log(`🧹 [watchdog] spawn ${info.agent} pid=${info.pid} za ${info.taskId} — task je "${taskStatus}" ali spawn još živi (${ageMin}min). Gašenje.`)
            killAgentSpawn(info, agentName, `task ${info.taskId} status="${taskStatus}" ali spawn živ ${ageMin}min — siroče`, 'orphan-watchdog', true,
              `↻ Spawn ugašen jer task više nije in_progress (status: ${taskStatus}).`)
            activeAgentSpawns.delete(key)
            continue
          }
        }
      } catch {}
    }

    // Apsolutni maksimum (24h) — zadnja linija obrane
    if (now - info.startTime >= AGENT_HARD_CEILING_MS) {
      log(`⏰ Agent ${info.agent} dosegao apsolutni maksimum (${ageMin}min) — gašenje.`)
      killAgentSpawn(info, agentName, `dosegnut maksimum izvođenja (${ageMin} min)`, 'hard-ceiling')
      continue
    }

    // Odluku o "zaglavljen" donosimo tek nakon punog 2h prozora ovog agenta
    if (now - info.lastLivenessCheck < AGENT_LIVENESS_CHECK_INTERVAL_MS) continue

    // Provjera 1: Heartbeat datoteka (agent sam javlja da je živ)
    const heartbeatFile = join(HOME, `.tmp/agent_heartbeat_${info.agent}.json`)
    let heartbeatAge = Infinity
    let heartbeatBrief = ''
    try {
      if (existsSync(heartbeatFile)) {
        const hb = JSON.parse(readFileSync(heartbeatFile, 'utf-8'))
        heartbeatAge = now - new Date(hb.ts).getTime()
        heartbeatBrief = hb.brief || ''
      }
    } catch {}

    // Ako je heartbeat svjež (< 2h), agent je definitivno živ — logiramo briefing
    if (heartbeatAge < AGENT_LIVENESS_CHECK_INTERVAL_MS) {
      log(`💓 Agent ${info.agent} heartbeat OK (${Math.round(heartbeatAge/60000)}min ago): ${heartbeatBrief}`)
      info.lastLivenessCheck = now
      continue
    }

    // Provjera 2: CPU jiffies (fallback ako agent ne piše heartbeat)
    const cpu = readProcCpuJiffies(info.pid)
    const delta = cpu < 0 ? -1 : cpu - info.lastCpuJiffies

    if (cpu >= 0 && delta <= 0) {
      log(`🛑 Agent ${info.agent} bez heartbeata i CPU napretka ${ageMin}min (CPU Δ=${delta}) — proglašen zaglavljenim, gašenje.`)
      killAgentSpawn(info, agentName, `bez heartbeata i CPU napretka ${ageMin} min`, 'liveness-watchdog')
      continue
    }

    log(`✅ Agent ${info.agent} radi (${ageMin}min, CPU Δ=+${delta}, no heartbeat) — nastavlja.`)
    if (cpu >= 0) info.lastCpuJiffies = cpu
    info.lastLivenessCheck = now
  }
}

// ============================================
// F3: Stale-Task Reaper Watchdog
// Checks every 30 min: tasks in_progress without progress for >24h → blocked
// Tasks in_progress for >7 days → cancelled
// ============================================

// ─── F1 / TASK-2560+2561: robusnost watchdogovi (DRY-RUN prvo) ───────────────
// Načelo (Goran): watchdog PRVO alarmira, ne mijenja. Prvih 7 dana samo dojava
// (log + Telegram kroz R1 flush), stvarno djelovanje tek preko *Live flaga.
// Trajni trag odluka (dry-run dokaz "što BI dirao" + live audit).
const STALE_WATCHDOG_LOG = join(REGOC_DIR, 'data', 'stale_watchdog.jsonl')
const DEAD_AGENT_LOG = join(REGOC_DIR, 'data', 'dead_agent_reaper.jsonl')
let lastStaleWatchdogCheck = 0
let lastDeadAgentCheck = 0
const _alarmedStaleTasks = new Set<string>()   // anti-spam: alarm 1× po epizodi
// TASK-5204: revizija blokiranih ima vlastiti interval (zadano 60 min) i anti-spam po presudi.
let lastBlockedReviewCheck = 0
const _javljeneRevizije = new Map<string, string>()   // taskId → presuda o kojoj je Goran već obaviješten
// T10/TASK-3575: koliko često se provjerava je li dnevni sažetak „neprovjereno" na redu.
const UNVERIFIED_SUMMARY_INTERVAL_MS = 5 * 60_000
let lastUnverifiedSummaryCheck = 0
const _alarmedDeadAgents = new Set<string>()

/**
 * Ubaci alarm korisniku kroz messages tablicu — R1 flush ga isporuči na Telegram (ako je live).
 *
 * Vraća je li poruka STVARNO ušla u red. A5/TASK-3004 o tome ovisi: `userFlushBacklog` je
 * `false`, pa poruka starija od 30 min nikad ne ode. Pozivatelj koji pamti „obaviješten sam"
 * mora znati je li upis uspio, inače bi zapisao laž i obavijest bi se tiho izgubila.
 */
function queueUserAlarm(db: Database, text: string, chatId: number = REGOC_GROUP_FALLBACK): boolean {
  try {
    const id = crypto.randomUUID()
    db.prepare(
      `INSERT INTO messages (id, from_agent, to_agent, content, message_type, priority, status, chat_id, created_at)
       VALUES (?, 'regoc', 'user', ?, 'text', 4, 'pending', ?, CURRENT_TIMESTAMP)`
    ).run(id, text, chatId)
    return true
  } catch (e) {
    log(`  ⚠️ [alarm] upis alarma pao: ${e}`)
    return false
  }
}

/**
 * T10/TASK-3575 — vratar mora reći kad NIJE ništa provjerio.
 *
 * ZATEČENO (izmjereno 01.09.2026. na data/critic_gate.jsonl): pass 49, fail 4,
 * unverifiable 53. Polovica prolaza kroz vrata nije provjerila ništa, a `decideNextAction`
 * je sve što nije `fail` vraćao kao običan `accept` — bez ijedne dojave. Primjer:
 * TASK-3571 (malik, 6,57 USD, 1328 s) prošao je s `checks=0 failed=0 akcija=accept live`.
 *
 * ŠTO OVDJE: dojava, NE blokada. Rad se ne zaustavlja — blokira i dalje samo `fail`.
 * Buka je ograničena na dva načina (prag u config/unverified-alert.json, ne u kodu):
 * jedna dojava po zadatku dnevno, a preko praga se prelazi na JEDAN dnevni sažetak.
 */
function reportUnverifiedCritique(db: Database, i: {
  taskId: string | null
  agentId: string
  status: CriticStatus
  reasons: string[]
  costUsd?: number | null
  durationS?: number | null
  live: boolean
  /** TASK-4833/4834: razina doc-provjere koja je prošla (`L0`/`L1`), `null` kad je nema. */
  razina?: 'L0' | 'L1' | null
  docChecked?: string[]
}): void {
  if (!isEnabled('criticUnverifiedAlert')) return
  // Spawn bez zadatka nema što prijaviti — dojava bez ID-a je poruka na koju se ne može
  // reagirati, a upravo takve dojave ubijaju povjerenje u kanal.
  if (!i.taskId) return
  try {
    // Prvo eventualni zaostali sažetak (npr. ponoć je prošla dok daemon nije spawnao) —
    // inače bi se `state.day` prevrnuo ovdje i jučerašnji odgođeni zadaci bi nestali.
    maybeSendUnverifiedSummary(db)

    // TASK-5548: nalog iz razgovora (`chat:`) ne troši prag i ne ide u dnevni sažetak —
    // „neprovjereno” mu ide kao oznaka u pojedinačnu dojavu ✅ (dopuniDojavu).
    if ((i.status === 'unverifiable' || i.status === 'partial')
        && neprovjerenoIdeUDojavu(readTaskRow(i.taskId)?.tags ?? null, isEnabled('chatDojavaUvijek'))) {
      log(`🔎 [neprovjereno] ${i.taskId} (${i.status}) — nalog iz razgovora (chat:), oznaka ide u pojedinačnu dojavu; prag i dnevni sažetak se ne primjenjuju`)
      return
    }

    const cfg = loadUnverifiedConfig()
    const now = Date.now()
    const state = readUnverifiedState(unverifiedStatePath(), now, cfg.timeZone)
    const d = decideUnverifiedAlert(state, { taskId: i.taskId, status: i.status, nowMs: now }, cfg)
    if (d.action === 'ignore') return

    if (d.action === 'alert') {
      const text = formatUnverifiedAlert({
        taskId: i.taskId, agentId: i.agentId, status: i.status,
        costUsd: i.costUsd, durationS: i.durationS, reasons: i.reasons, live: i.live,
        razina: i.razina ?? null, docChecked: i.docChecked || [],
      }, cfg)
      // Stanje se upisuje SAMO ako je poruka stvarno ušla u red (queueUserAlarm vraća
      // je li upis uspio). Inače bismo zapisali „javljeno" za dojavu koje nema — isti
      // razlog zbog kojeg A5/TASK-3004 traži povratnu vrijednost.
      if (queueUserAlarm(db, text)) {
        writeUnverifiedState(d.state)
        log(`🔎 [neprovjereno] dojava poslana za ${i.taskId} (${i.status}, ${d.reason})`)
      } else {
        log(`⚠️ [neprovjereno] dojava za ${i.taskId} NIJE ušla u red — pokušavam ponovo kod sljedećeg suda`)
      }
      return
    }

    if (d.action === 'defer') {
      writeUnverifiedState(d.state)
      log(`🔎 [neprovjereno] ${i.taskId} (${i.status}) ide u dnevni sažetak — ${d.reason}`)
      // Ako je termin sažetka VEĆ prošao, odgođeni zadatak ne smije čekati sljedeći
      // spawn da bi se uopće prijavio — tada bi „sažetak" značio „možda sutra".
      maybeSendUnverifiedSummary(db)
      return
    }

    log(`🔎 [neprovjereno] ${i.taskId} (${i.status}) — ${d.reason}, ne ponavljam dojavu`)
  } catch (e) {
    // Dojava nikad ne smije srušiti put zatvaranja zadatka.
    log(`⚠️ [neprovjereno] dojava pala (${i.taskId}): ${e}`)
  }
}

/** Dnevni sažetak odgođenih „neprovjereno" zadataka. Šalje se najviše jednom po danu. */
function maybeSendUnverifiedSummary(db: Database): void {
  if (!isEnabled('criticUnverifiedAlert')) return
  try {
    const cfg = loadUnverifiedConfig()
    const now = Date.now()
    const state = readUnverifiedState(unverifiedStatePath(), now, cfg.timeZone)
    const due = summaryDue(state, now, cfg)
    if (!due.due) return
    const text = formatUnverifiedSummary(due.day, summaryRows(due.taskIds), cfg)
    if (queueUserAlarm(db, text)) {
      writeUnverifiedState(afterSummary(state, now, cfg))
      log(`🔎 [neprovjereno] dnevni sažetak za ${due.day} poslan (${due.taskIds.length} zadataka) — ${due.reason}`)
    }
  } catch (e) {
    log(`⚠️ [neprovjereno] dnevni sažetak pao: ${e}`)
  }
}

// R2/TASK-2560: stale-task watchdog. Pravilo i izuzeća žive u `StaleWatchdog.ts` (SSOT) —
// isti modul koristi `tools/stale-watchdog-report.ts`, pa izvještaj "što BI resetirao"
// ne može odlutati od stvarnog ponašanja daemona.
//   dry-run (staleWatchdog=true, staleWatchdogLive=false) → alarm + JSONL zapis, NE dira task
//   live    (staleWatchdogLive=true)                      → POST /api/tasks/:id/reclaim (in_progress→pending)
async function watchdogStaleTasksDryRun(db: Database): Promise<void> {
  await watchdogInProgress(db)
  // TASK-5204: drugi prolaz istog nadzornika, nad `blocked` (vlastiti prekidač i interval).
  try { await revidirajBlokirane(db, Date.now()) } catch (e) { log(`  ⚠️ [revizija] prolaz pao: ${e}`) }
}

async function watchdogInProgress(db: Database): Promise<void> {
  if (!isEnabled('staleWatchdog')) return
  const config = loadStaleWatchdogConfig()
  const now = Date.now()
  if (now - lastStaleWatchdogCheck < config.intervalMinutes * 60_000) return
  lastStaleWatchdogCheck = now
  const live = isEnabled('staleWatchdogLive')
  try {
    const resp = await fetch(`${TASK_MANAGER_API}?status=in_progress`)
    if (!resp.ok) { log(`  [staleWatchdog] TaskManager API ${resp.status}`); return }
    const tasks = await resp.json() as any[]
    const decisions = evaluateStaleTasks(tasks || [], { now, config, lookupCheckpoint: makeCheckpointLookup(db) })
    let resets = 0

    for (const d of decisions) {
      if (d.verdict !== 'stale') {
        // Izuzet ili svjež — čisti anti-spam trag da se alarm ponovi ako opet zaglavi.
        _alarmedStaleTasks.delete(d.taskId)
        if (d.verdict === 'excluded') log(`  [staleWatchdog] ${d.taskId} preskočen — ${d.reason}`)
        continue
      }

      log(`  [staleWatchdog ${live ? 'LIVE' : 'DRY'}] ${d.taskId} (${d.assignee || '-'}) ${d.reason}`)
      recordStaleWatchdogDecision(d, live)

      if (!_alarmedStaleTasks.has(d.taskId)) {
        _alarmedStaleTasks.add(d.taskId)
        // Naslov u alarmu — goli TASK-ID nije akcijski, Goran mora znati o čemu se radi.
        const naslov = d.title ? ` „${d.title.slice(0, 60)}"` : ''
        queueUserAlarm(db, `⚠️ [stale-task] ${d.taskId}${naslov} (${d.assignee || 'bez assigneeja'}) — ${d.reason}. ${live ? 'Vraćam ga na pending.' : '(dry-run — samo dojava, ne diram)'}`)
      }

      if (live) {
        // Brana: masovni reset je uvijek sumnjiv (kriva konfiguracija, a ne 10 mrtvih agenata).
        // Dokazano 2026-07-28: canary s prekratkim pragom resetirao 21 tuđi task u jednom prolazu.
        if (resets >= config.maxResetsPerRun) {
          log(`  🛑 [staleWatchdog] brana: ${config.maxResetsPerRun} resetiranja u ovom prolazu — ostatak preskačem`)
          queueUserAlarm(db, `🛑 [stale-task] Watchdog je u jednom prolazu htio resetirati više od ${config.maxResetsPerRun} taskova — stao je iz sigurnosti. Provjeri config/stale-watchdog.json.`)
          break
        }
        try {
          // Namjenska ruta: običan PUT status=pending je zabranjen prijelaz (409).
          const r = await fetch(`${TASK_MANAGER_API}/${d.taskId}/reclaim`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: d.reason, by: 'stale-watchdog' })
          })
          if (r.ok) {
            resets++
            logEvent(db, 'stale_task_reset', d.assignee || 'unassigned', `${d.taskId} ${d.staleHours}h`)
            // TASK-4992 FIX: reclaim bez gašenja spawna ostavljao zauzet slot zauvijek.
            // Ako za ovaj task postoji živ spawn, ubij ga uredno i oslobodi slot.
            for (const [key, info] of activeAgentSpawns.entries()) {
              if (info.taskId === d.taskId) {
                const agentName = agentRegistry?.agents?.[info.agent]?.name || info.agent
                killAgentSpawn(info, agentName, `stale-watchdog reclaim (${d.staleHours}h bez updatea)`, 'stale-watchdog', true,
                  `↻ Zadatak vraćen u red (stale ${d.staleHours}h). Spawn ugašen, slot oslobođen.`)
                activeAgentSpawns.delete(key)
                log(`🧹 [staleWatchdog] spawn ${info.agent} pid=${info.pid} za ${d.taskId} ugašen i slot oslobođen`)
                break
              }
            }
          } else {
            log(`  ⚠️ [staleWatchdog] reclaim ${d.taskId} → HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`)
          }
        } catch (e) { log(`  ⚠️ [staleWatchdog] reclaim ${d.taskId} pao: ${e}`) }
      }
    }
  } catch (e) {
    log(`  ⚠️ [staleWatchdog] ${e}`)
  }
}

/**
 * TASK-5204 — naknadna revizija blokiranih (docs/DIZAJN-revizija-blokiranih.md §4.3).
 *
 *   off    (revizijaBlokiranih=false)                → ništa
 *   shadow (revizijaBlokiranih=true, …Live=false)     → svaka presuda u revizija_blokiranih.jsonl + daemon.log,
 *                                                      bez promjene statusa/oznaka i bez poruka
 *   on     (…Live=true)                               → radnje iz §4.3 t. 5; PUŠTANJA samo za klase iz
 *                                                      config.blocked.klaseUzivo (klase „uvijek Goranu” nikad)
 *
 * Puštanje = `POST /reclaim {from:'blocked'}` → `pending`; spawn ostaje redu autonomije (vrata, strop,
 * kočnica). Nikad `cancelled`. Pravila su u StaleWatchdog.ts (isti modul čita izvještaj i ploča).
 */
async function revidirajBlokirane(db: Database, now: number): Promise<void> {
  const nacin = nacinRevizije(n => isEnabled(n))
  if (nacin === 'off') return
  const config = loadBlockedReviewConfig()
  if (now - lastBlockedReviewCheck < config.intervalMinutes * 60_000) return
  lastBlockedReviewCheck = now
  const live = nacin === 'on'
  const zapisi = (red: Record<string, unknown>) => {
    try { appendFileSync(REVIZIJA_BLOKIRANIH_LOG, JSON.stringify(red) + '\n') } catch (e) { log(`  ⚠️ [revizija] zapis pao: ${e}`) }
  }

  // Ručna kočnica (pravilo 17): zabilježi da je prolaz bio, ali ništa ne puštaj.
  if (readPauseState().paused) {
    zapisi({ ts: new Date(now).toISOString(), prolaz: true, nacin: live ? 'live' : 'shadow', preskoceno: 'pauza' })
    log(`  ⏸️ [revizija] preskočeno — ručna kočnica (${describePause(readPauseState())}); ponavljam za ${PONOVI_PRESKOCENI_PROLAZ_MS / 60_000} min`)
    // QA-5205 N3: preskočen prolaz ne troši interval — restart_kad_mirno restarta pod kočnicom.
    lastBlockedReviewCheck = zadnjiProlazZaPonavljanje(now, config.intervalMinutes)
    return
  }

  const t0 = Date.now()
  const resp = await fetch(`${TASK_MANAGER_API}?status=blocked`)
  if (!resp.ok) {
    log(`  ⚠️ [revizija] TaskManager API ${resp.status}; ponavljam za ${PONOVI_PRESKOCENI_PROLAZ_MS / 60_000} min`)
    lastBlockedReviewCheck = zadnjiProlazZaPonavljanje(now, config.intervalMinutes)
    return
  }
  const tasks = (await resp.json()) as BlockedTask[]
  const okolina = await izmjeriOkolinu(now, { startupGrace: now - daemonStartTime < 10 * 60_000 })
  const uzrok = provjeriUzrok(okolina, now, config)
  const rdb = new Database(TASKS_DB_PATH, { readonly: true })
  let decisions: BlockedDecision[]
  try {
    const ulaz = makeBlockedReviewLookup(rdb as any, {
      now, config, uzrok, deploy: provjeriDeployServisa,
      // Kritičar se ne pušta dok P0a (popravci kritičara) nije u pogonu — dizajn §5.2.
      kriticarSpreman: isEnabled('revizijaBlokiranihKriticar', false) && isEnabled('criticRepairLoopLive', false),
    })
    decisions = evaluateBlockedTasks(tasks || [], { now, config, ulaz, budzet: procitajBudzet(now) })
  } finally { rdb.close() }

  const broj: Record<string, number> = {}
  let izvedeno = 0
  const poruke: Array<{ taskId: string; presuda: string; tekst: string }> = []
  for (const d of decisions) {
    broj[d.presuda] = (broj[d.presuda] || 0) + 1
    let ok = false
    if (live) {
      try { ok = await izvediPresuduRevizije(db, d, config.klaseUzivo, poruke) } catch (e) { log(`  ⚠️ [revizija] ${d.taskId} radnja pala: ${e}`) }
      if (ok) izvedeno++
    }
    zapisi(zapisRevizije(d, nacin, ok, now))
    if (d.presuda !== 'ceka' && d.presuda !== 'izuzet') {
      log(`  🔁 [revizija ${live ? (ok ? 'UŽIVO' : 'UŽIVO—nije izvedeno') : 'SJENA'}] ${formatBlockedDecisionLine(d)}`)
    }
  }
  // Poruke: do tri pojedinačno, više od toga JEDNA zbirna — prvi prolaz uživo inače bi poslao
  // desetke poruka (izmjereno u sjeni 04.10.: 26 presuda „Goranu” odjednom).
  if (poruke.length > 0) {
    const tekstovi = poruke.length <= 3 ? poruke.map(p => p.tekst)
      : [`🔁 [revizija] ${poruke.length} blokiranih zadataka treba tebe ili je vraćeno u red:\n` + poruke.map(p => `• ${p.tekst.replace(/^\S+ \[revizija\] /, '')}`).join('\n').slice(0, 3500)]
    let poslano = true
    for (const t of tekstovi) poslano = queueUserAlarm(db, t) && poslano
    if (poslano) for (const p of poruke) _javljeneRevizije.set(p.taskId, p.presuda)
  }
  // Prolaz se bilježi i kad nema presuda — šutnja je kvar („puštanje nije pokretanje”).
  zapisi({ ts: new Date().toISOString(), prolaz: true, nacin: live ? 'live' : 'shadow', blokiranih: decisions.length,
    presude: broj, izvedeno, uzrok: uzrok.razlog, trajanjeMs: Date.now() - t0 })
  log(`  🔁 [revizija ${live ? 'UŽIVO' : 'SJENA'}] ${decisions.length} blokiranih → ${Object.entries(broj).map(([k, v]) => `${k} ${v}`).join(', ')}` +
    `${live ? ` · izvedeno ${izvedeno}` : ''} · ${Date.now() - t0} ms`)
}

/** Jedna radnja revizije uživo. Vraća je li radnja stvarno izvedena (ide u dnevnik kao `izvedeno`). */
async function izvediPresuduRevizije(db: Database, d: BlockedDecision, klaseUzivo: string[],
  poruke: Array<{ taskId: string; presuda: string; tekst: string }>): Promise<boolean> {
  const api = (put: string, method: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`${TASK_MANAGER_API}${put}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const naslov = d.title ? ` „${d.title.slice(0, 60)}”` : ''
  // Anti-spam po obrascu `_alarmedStaleTasks`: ista presuda za isti zadatak javlja se jednom.
  const javi = (tekst: string) => {
    if (_javljeneRevizije.get(d.taskId) === d.presuda) return
    poruke.push({ taskId: d.taskId, presuda: d.presuda, tekst })
  }

  switch (d.presuda) {
    case 'pusti':
    case 'otpusti-lanac': {
      if (!klaseUzivo.includes(d.klasa)) return false
      const r = await api(`/${d.taskId}/reclaim`, 'POST', { from: 'blocked', by: 'revizija-blokiranih', reason: d.razlog })
      if (!r.ok) { log(`  ⚠️ [revizija] reclaim ${d.taskId} → HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`); return false }
      if (d.oznake) await api(`/${d.taskId}`, 'PUT', { tags: d.oznake })
      logEvent(db, 'blocked_redrive', d.assignee || 'unassigned', `${d.taskId} ${d.klasa} ${d.presuda}`)
      if (d.presuda === 'pusti') javi(`🔁 [revizija] ${d.taskId}${naslov} (${d.assignee}) — ${d.razlog}`)
      return true
    }
    case 'popravi-lanac': {
      if (!klaseUzivo.includes('lanac')) return false
      // Reciprocitet ide postojećim putem (TaskManagerSQL.updateTask, TASK-3521): skini pa vrati
      // roditelje bez `blocks` u `blockedBy` djeteta — `dodani` tada upišu dijete u `blocks` roditelja.
      const t = await (await api(`/${d.taskId}`, 'GET')).json() as any
      const svi: string[] = Array.isArray(t?.blockedBy) ? t.blockedBy : []
      const bez = d.roditeljiBezBlocks || []
      if (svi.length === 0 || bez.length === 0) return false
      await api(`/${d.taskId}`, 'PUT', { blockedBy: svi.filter(x => !bez.includes(x)) })
      await api(`/${d.taskId}`, 'PUT', { blockedBy: svi, progressNotes: [`revizija-blokiranih: popravljen reciprocitet lanca (${bez.join(', ')} → blocks ${d.taskId})`] })
      // Provjera u bazi u OBA smjera — popravak bez provjere je samo nada.
      const rdb = new Database(TASKS_DB_PATH, { readonly: true })
      try {
        const dijete = rdb.prepare('SELECT blocked_by FROM tasks WHERE id = ?').get(d.taskId) as any
        const okDijete = bez.every(p => JSON.parse(dijete?.blocked_by || '[]').includes(p))
        const okRoditelji = bez.every(p => JSON.parse((rdb.prepare('SELECT blocks FROM tasks WHERE id = ?').get(p) as any)?.blocks || '[]').includes(d.taskId))
        if (!okDijete || !okRoditelji) log(`  ⚠️ [revizija] ${d.taskId} reciprocitet NIJE popravljen (dijete ${okDijete}, roditelji ${okRoditelji})`)
        return okDijete && okRoditelji
      } finally { rdb.close() }
    }
    case 'zatvori-deploy': {
      if (!klaseUzivo.includes('deploy')) return false
      // API traži dva koraka (pravilo 12), a zatvara daemon svojim tokenom (TASK-5164, nesukladnost B).
      const a = await api(`/${d.taskId}`, 'PUT', { status: 'in_progress', progressNotes: [`revizija-blokiranih: ${d.razlog}`] })
      if (!a.ok) return false
      const b = await api(`/${d.taskId}`, 'PUT', {
        status: 'completed',
        resultSummary: `Isporuka u pogon potvrđena revizijom blokiranih (TASK-5204): ${d.razlog}\nREGOC-STATUS: DONE — deploy izveden, StaleCodeCheck exit 0`,
      }, zaglavljaZatvaraca())
      if (!b.ok) log(`  ⚠️ [revizija] zatvaranje ${d.taskId} → HTTP ${b.status}`)
      return b.ok
    }
    case 'goranu':
    case 'strop': {
      // Restriktivna radnja (ništa ne pušta) — izvodi se uživo za svaku klasu, ne samo klaseUzivo.
      if (!d.oznake) return false
      // TASK-5302: zaglavlje = oznake je dao SUSTAV — povrat iz blocked ih poslije smije skinuti.
      const r = await api(`/${d.taskId}`, 'PUT', { tags: d.oznake, progressNotes: [`revizija-blokiranih: ${d.razlog}`] },
        { 'X-REGOC-Oznake-Izvor': 'revizija-blokiranih' })
      if (!r.ok) return false
      javi(d.presuda === 'strop'
        ? `⛔ [revizija] ${d.taskId}${naslov} — ${d.razlog}. Treba tvoju odluku.`
        : `🙋 [revizija] ${d.taskId}${naslov} — ${d.klasa}: ${d.razlog}. Na traci „Čeka odluku”.`)
      return true
    }
    default:
      return false
  }
}

/**
 * Trajni zapis svake stale-odluke u JSONL — dokaz za "što BI watchdog resetirao"
 * kroz cijeli dry-run period (revizija 2026-07-13: izvještaj PRIJE aktivacije).
 */
function recordStaleWatchdogDecision(d: StaleDecision, live: boolean): void {
  appendDecisionJsonl(STALE_WATCHDOG_LOG, live, {
    mechanism: 'stale-watchdog',
    taskId: d.taskId,
    assignee: d.assignee,
    title: d.title,
    staleHours: d.staleHours,
    lastActivity: d.lastActivity,
    checkpoint: d.checkpoint,
    reason: d.reason,
  })
}

/**
 * Jedan redak revizijskog traga za SVAKI automatski mehanizam koji dira tuđi task
 * (TASK-3019). `mode` je jedini razlikovni podatak dry-runa i live načina, pa se
 * izvještaji svih mehanizama čitaju istim alatom. Zapis nikad ne ruši petlju.
 */
function appendDecisionJsonl(file: string, live: boolean, payload: Record<string, unknown>): void {
  try {
    appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), mode: live ? 'live' : 'dry-run', ...payload }) + '\n')
  } catch (e) {
    log(`  ⚠️ [audit] zapis odluke u ${file} pao: ${e}`)
  }
}

// R3/TASK-2561: dead-agent reaper. Pravilo i izuzeća žive u `DeadAgentReaper.ts` (SSOT) —
// isti modul koristi `tools/dead-agent-report.ts`, pa izvještaj "koga BI reapao" ne može
// odlutati od stvarnog ponašanja daemona.
//   dry-run (deadAgentReaper=true, deadAgentReaperLive=false) → alarm + JSONL, NE dira ništa
//   live    (deadAgentReaperLive=true)                        → status offline (+ /reclaim za mrtve)
// Taskovi se oslobađaju ISKLJUČIVO kroz R2 rutu POST /api/tasks/:id/reclaim — običan
// PUT status=pending je zabranjen prijelaz (409), pa bi tiho ostavljao taskove zaključanima.
async function watchdogDeadAgents(db: Database): Promise<void> {
  if (!isEnabled('deadAgentReaper')) return
  const config = loadDeadAgentReaperConfig()
  const now = Date.now()
  if (now - lastDeadAgentCheck < config.intervalMinutes * 60_000) return
  lastDeadAgentCheck = now
  const live = isEnabled('deadAgentReaperLive')
  try {
    // Starost heartbeata računa SQL (julianday) — neovisno o TZ zapisu u bazi.
    const rows = db.prepare(
      `SELECT agent_id, status, current_task, pid, last_heartbeat,
              CAST((julianday('now') - julianday(last_heartbeat)) * 86400000 AS INTEGER) AS hb_age_ms
         FROM agent_status`
    ).all() as any[]
    const decisions = evaluateAgents(rows || [], { now, config })
    await applyDecisions(decisions, {
      live, config, alarmed: _alarmedDeadAgents,
      effects: makeDaemonReapEffects(db),
    })
  } catch (e) {
    log(`  ⚠️ [deadAgent] ${e}`)
  }
}

/** Prave nuspojave reapa — implementacija je u SSOT modulu (dijeli je verifikacijski harness). */
function makeDaemonReapEffects(db: Database): ReapEffects {
  return makeReapEffects(db, {
    taskApi: TASK_MANAGER_API,
    log,
    alarm: (msg) => queueUserAlarm(db, msg),
    audit: recordDeadAgentDecision,
    event: (name, agentId, details) => logEvent(db, name, agentId, details),
  })
}

/** Trajni zapis svake odluke u JSONL — dokaz "koga BI reaper dirao" kroz dry-run period. */
function recordDeadAgentDecision(d: AgentDecision, live: boolean): void {
  try {
    appendFileSync(DEAD_AGENT_LOG, JSON.stringify({
      ts: new Date().toISOString(),
      mode: live ? 'live' : 'dry-run',
      agentId: d.agentId,
      verdict: d.verdict,
      status: d.status,
      pid: d.pid,
      pidAlive: d.pidAlive,
      hbHours: d.hbHours,
      lastHeartbeat: d.lastHeartbeat,
      currentTask: d.currentTask,
      reason: d.reason,
    }) + '\n')
  } catch (e) {
    log(`  ⚠️ [deadAgent] zapis odluke pao: ${e}`)
  }
}

// ─── R1 / TASK-2557: flushUserMessages ──────────────────────────────────────
// Aditivno: dodaje POTROŠAČA za poruke to_agent='user' (danas ih nitko ne čita →
// „agenti šute"). Stari put ostaje netaknut; sve iza flagova. Rollback = flag=false.
async function flushUserMessages(db: Database): Promise<void> {
  if (!isEnabled('userFlush')) return
  const now = Date.now()
  if (now - lastUserFlushCheck < USER_FLUSH_INTERVAL_MS) return
  lastUserFlushCheck = now

  const live = isEnabled('userFlushLive')
  const allowBacklog = isEnabled('userFlushBacklog')

  try {
    // (a) Oporavak zaglavljenih 'sending' (proces umro usred slanja) → natrag na pending.
    //     Rijedak slučaj; prihvaćamo mali rizik dvostrukog slanja (v1) uz log-upozorenje.
    if (live) {
      // TASK-2612: glasovne (Mumble) izuzimamo — njihov 'sending' drži mumble_bridge
      // dok govori; oporavak tih poruka je njegov posao (db_io.recover_stuck).
      const stuck = db.prepare(
        `SELECT id FROM messages WHERE to_agent='user' AND status='sending'
           AND updated_at < datetime('now', '-5 minutes')
           AND NOT (voice_relay = 1 AND chat_id BETWEEN ? AND ?)`
      ).all(MUMBLE_CHAT_MIN, MUMBLE_CHAT_BASE) as any[]
      for (const s of stuck) {
        db.prepare(`UPDATE messages SET status='pending', updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(s.id)
        log(`  ⚠️ [user-flush] 'sending' zaglavljen >5min → pending (moguć duplikat): ${s.id}`)
      }
    }

    const pending = db.prepare(
      `SELECT id, from_agent, content, chat_id, voice_relay, created_at, retry_count, max_retries,
              CAST((julianday('now') - julianday(created_at)) * 86400000 AS INTEGER) AS age_ms
         FROM messages
        WHERE to_agent='user' AND status='pending'
        ORDER BY created_at ASC`
    ).all() as any[]

    if (pending.length === 0) return

    let freshSent = 0
    let backlogSentThisTick = 0
    let voiceSkipped = 0
    let consoleDelivered = 0   // TASK-3083: isporučeno u konzolu (stroj bez Telegram kanala)
    for (const msg of pending) {
      // TASK-2612: glasovne poruke (Mumble) NE idu na Telegram — njih preuzima
      // mumble_bridge (pending → sending → completed). Preskačemo ih ovdje da
      // isti odgovor ne bude i izgovoren i poslan u chat.
      if (isMumbleVoiceMessage(msg)) { voiceSkipped++; continue }

      const isBacklog = (msg.age_ms ?? 0) > USER_FLUSH_BACKLOG_AGE_MS
      // TASK-3083: pragovi ispod (backlog-odobrenje, anti-flood, throttle) postoje da se Gorana
      // ne zatrpa na TELEFONU. Na stroju bez Telegram kanala isporuka ide u konzolu, gdje ta
      // opasnost ne postoji — a filtri bi inače ostavili poruke da zauvijek vise u redu
      // (node-A: 10 poruka, najstarije od 19.07.). Zato se ondje preskaču.
      const toConsole = !getTelegramToken()
      if (!toConsole) {
        if (isBacklog && !allowBacklog) continue                 // forward-only dok backlog nije odobren
        if (!isBacklog && freshSent >= USER_FLUSH_FRESH_MAX) continue  // anti-flood svježih
        if (isBacklog && backlogSentThisTick >= 1) continue      // throttle backlog ≈1/min
      }

      // TASK-5285: na stroju čiji je kanal paketov, „fallback grupa” glavnog sustava nije naša —
      // poruka bez chata (ili s tim fallbackom) ide u chat koji je vlasnik upisao na ploči.
      const _pk = kanalJePaketov() ? paketKanal() : null
      const chatId = chatZaPoruku(msg.chat_id, _pk, REGOC_GROUP_FALLBACK)
      const datePart = String(msg.created_at).substring(0, 10)
      const prefix = isBacklog ? `[ZAOSTALO od ${datePart}]\n` : ''
      // TASK-5548: `[[SEND_DOC: …]]` se izdvaja PRIJE rezanja i šalje kao dokument (nakon
      // teksta). Konzola (stroj bez kanala) i dalje dobiva izvorni tekst s markerima.
      const _razdvojeno = !toConsole && isEnabled('chatDojavaUvijek')
        ? razdvojiZaFlush(String(msg.content)) : { text: String(msg.content), docs: [] as { path: string; caption?: string }[] }
      // TASK-5285: stil izlaza s ploče (telegram.stil; kratko = ishod + do 5 točaka, bez zida teksta).
      let out = prefix + (_pk ? _pk.oblikuj(_razdvojeno.text) : _razdvojeno.text)
      if (out.length > USER_FLUSH_MAXLEN) out = out.substring(0, USER_FLUSH_MAXLEN) + '\n…(skraćeno)'

      if (!live) {
        // SHADOW: samo logiraj što BI poslao; NE mijenjaj status, NE šalji.
        log(`  [user-flush SHADOW] chat=${chatId} ${isBacklog ? 'BACKLOG' : 'fresh'} od=${msg.from_agent} (${msg.created_at}): "${String(msg.content).replace(/\n/g, ' ').substring(0, 60)}..."`)
        if (isBacklog) backlogSentThisTick++; else freshSent++
        continue
      }

      // LIVE: idempotencija — zauzmi poruku ('sending') pa šalji.
      db.prepare(`UPDATE messages SET status='sending', updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'`).run(msg.id)
      // Poruka koja je bila SAMO marker: tekst se ne šalje (prazan sendMessage Telegram odbija).
      const res: SendOutcome = _razdvojeno.docs.length > 0 && !_razdvojeno.text.trim()
        ? { ok: true, reason: 'sent' }
        : await sendTelegramText(chatId, out)
      if (res.ok && _razdvojeno.docs.length > 0) {
        // Jedan pokvaren dokument ne ruši ni tekst ni ostale; ne ponavlja se (tekst je već otišao).
        const d = await deliverDocuments(_razdvojeno.docs, {
          send: (put, opis) => sendTelegramDocument(chatId, put, opis),
          log: (p) => log(`  📎 [user-flush] ${p}`),
        })
        log(`  📎 [user-flush] SEND_DOC chat=${chatId}: poslano ${d.sent.length}, preskočeno ${d.skipped.length}${d.skipped.length ? ` (${d.skipped.map(x => `${basename(x.path)}: ${x.razlog}`).join('; ')})` : ''}`)
      }
      // TASK-3083 (Goranov nalog): na stroju bez Telegram kanala poruka NE čeka u redu nego se
      // ISPORUČUJE U KONZOLU. Konzola čita `messages` iz baze (TaskWebUI.streamMessageQueue), pa
      // je zatvaranje u `completed` upravo ta isporuka — poruka se prikaže kao ✅ sa svojim
      // sadržajem. Ostavljanje u `pending` (prva verzija ovog popravka) spriječilo je gubitak,
      // ali je poruke učinilo nevidljivima i tjeralo flush da ih dovijeka pokušava slati.
      if (!res.ok && res.reason === 'no-channel') {
        db.prepare(
          `UPDATE messages SET status='completed', processed_at=CURRENT_TIMESTAMP,
           updated_at=CURRENT_TIMESTAMP, error='delivered-to-console (no telegram channel)' WHERE id=?`
        ).run(msg.id)
        // Konzola TaskManagera prikazuje daemonov log (TaskWebUI.streamLogFiles prati
        // ~/.tmp/regoc_daemon.log), pa je ISPIS PUNE PORUKE ovdje ujedno i njezina isporuka.
        // Sama obavijest „isporučeno u konzolu" bila je beskorisna — Goran je vidio da se
        // nešto dogodilo, ali ne i ŠTO piše (TASK-3086).
        log(`  🖥️ ━━━ PORUKA ZA TEBE (od ${msg.from_agent}, ${msg.created_at}) ━━━\n${out}\n  🖥️ ━━━ kraj poruke ━━━`)
        consoleDelivered++
        continue
      }
      const ok = res.ok
      if (ok) {
        db.prepare(`UPDATE messages SET status='completed', processed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(msg.id)
        // TASK-3087: puni tekst ide u log I kad je isporučen na Telegram. Konzola prikazuje
        // daemonov log, pa je bez ovoga lokalna konzola bila nijema (poruka ode na mobitel,
        // a tko gleda ploču ne vidi ništa) — dok je na nodu bez tokena sve pisalo.
        log(`  📨 ━━━ ODGOVOR AGENTA (od ${msg.from_agent}, ${msg.created_at}) ━━━\n${out}\n  📨 ━━━ kraj ━━━`)
        log(`  ✅ [user-flush] isporučeno (HTTP 200) chat=${chatId} od=${msg.from_agent} ${msg.created_at}`)
        if (isBacklog) backlogSentThisTick++; else freshSent++
      } else {
        const rc = (msg.retry_count ?? 0) + 1
        const maxr = msg.max_retries ?? 3
        if (rc >= maxr) {
          db.prepare(`UPDATE messages SET status='failed', retry_count=?, error='user-flush: max_retries', updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(rc, msg.id)
          log(`  ❌ [user-flush] max_retries (${maxr}) — status=failed: ${msg.id}`)
        } else {
          db.prepare(`UPDATE messages SET status='pending', retry_count=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(rc, msg.id)
          log(`  ↻ [user-flush] slanje palo, retry ${rc}/${maxr}, natrag na pending: ${msg.id}`)
        }
      }
    }

    // TASK-2612: vidljivost glasovne grane — bez ovoga se „ništa nije dogodilo"
    // ne razlikuje od „preskočeno jer ide u govor".
    if (voiceSkipped > 0) {
      log(`  🔊 [user-flush] preskočeno ${voiceSkipped} glasovnih (Mumble) — isporučuje mumble_bridge`)
    }
    if (consoleDelivered > 0) {
      log(`  🖥️ [user-flush] ${consoleDelivered} poruka isporučeno u konzolu (Telegram kanal nije konfiguriran na ovom stroju)`)
    }
  } catch (e) {
    log(`  ⚠️ [user-flush] greška: ${e}`)
  }
}

// TASK-3019: stari F3 reaper je do 2026-07-29 rezao status bez flaga, bez izuzeća i bez traga.
// Sada je pod istim režimom kao R2: pravilo i pragovi u `StaleReaper.ts` + config/stale-reaper.json,
//   dry-run (staleReaper=true, staleReaperLive=false) → alarm + data/stale_reaper.jsonl, NE dira task
//   live    (staleReaperLive=true)                    → PUT blocked (24h) / cancelled (7d)
const STALE_REAPER_LOG = join(REGOC_DIR, 'data', 'stale_reaper.jsonl')
let lastStaleTaskReaperCheck = 0
const _alarmedReaperTasks = new Set<string>()   // anti-spam: alarm 1× po epizodi

async function watchdogStaleTaskReaper(db: Database): Promise<void> {
  if (!isEnabled('staleReaper')) return
  const config = loadStaleReaperConfig()
  const now = Date.now()
  if (now - lastStaleTaskReaperCheck < config.intervalMinutes * 60_000) return
  lastStaleTaskReaperCheck = now
  const live = isEnabled('staleReaperLive')

  try {
    const resp = await fetch(`${TASK_MANAGER_API}?status=in_progress`)
    if (!resp.ok) { log(`  [staleReaper] TaskManager API ${resp.status}`); return }
    const raw = await resp.json() as any
    const decisions = evaluateReaperTasks(Array.isArray(raw) ? raw : [], { now, config })

    // 1) DOJAVA — svaka odluka koja bi dirala status ostavlja trag, i u dry-runu.
    for (const d of decisions) {
      if (!isReaperActionable(d.verdict)) {
        // Izuzet ili svjež — čisti anti-spam trag da se alarm ponovi ako opet zaglavi.
        _alarmedReaperTasks.delete(d.taskId)
        if (d.verdict === 'excluded') log(`  [staleReaper] ${d.taskId} preskočen — ${d.reason}`)
        continue
      }

      log(`  [staleReaper ${live ? 'LIVE' : 'DRY'}] ${d.taskId} (${d.assignee || '-'}) → ${d.targetStatus}: ${d.reason}`)
      appendDecisionJsonl(STALE_REAPER_LOG, live, {
        mechanism: 'stale-reaper',
        taskId: d.taskId, assignee: d.assignee, title: d.title,
        verdict: d.verdict, targetStatus: d.targetStatus,
        staleHours: d.staleHours, staleDays: d.staleDays, lastActivity: d.lastActivity, reason: d.reason,
      })

      if (!_alarmedReaperTasks.has(d.taskId)) {
        _alarmedReaperTasks.add(d.taskId)
        const naslov = d.title ? ` „${d.title.slice(0, 60)}"` : ''
        queueUserAlarm(db, `${d.verdict === 'cancel' ? '🪦' : '⚠️'} [stale-reaper] ${d.taskId}${naslov} (${d.assignee || 'bez assigneeja'}) — ${d.reason}. ${live ? `Stavljam ga u ${d.targetStatus}.` : '(dry-run — samo dojava, ne diram)'}`)
      }
    }

    // 2) RADNJA — u dry-runu je plan uvijek prazan (planReaperActions, SSOT).
    const { actions, capped } = planReaperActions(decisions, { live, config })
    if (capped) {
      log(`  🛑 [staleReaper] brana: više od ${config.maxActionsPerRun} promjena statusa u ovom prolazu — ostatak preskačem`)
      queueUserAlarm(db, `🛑 [stale-reaper] Reaper je u jednom prolazu htio dirati više od ${config.maxActionsPerRun} taskova — stao je iz sigurnosti. Provjeri config/stale-reaper.json.`)
    }
    for (const a of actions) {
      try {
        const r = await fetch(`${TASK_MANAGER_API}/${a.taskId}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(a.body)
        })
        if (r.ok) {
          logEvent(db, 'stale_task_reaped', a.assignee || 'unassigned', `${a.taskId} → ${a.targetStatus} (${a.decision.staleHours}h)`)
        } else {
          log(`  ⚠️ [staleReaper] ${a.taskId} → HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`)
        }
      } catch (e) { log(`  ⚠️ [staleReaper] ${a.taskId} pao: ${e}`) }
    }
  } catch (error) {
    log(`  ⚠️ [staleReaper] ${error}`)
  }
}

function stopDaemon(): void {
  const pid = readPid()
  if (pid && isRunning(pid)) {
    console.log(`Stopping REGOČ daemon (PID: ${pid})...`)
    process.kill(pid, 'SIGTERM')
    removePid()
    console.log('Daemon stopped.')
  } else {
    console.log('Daemon is not running.')
    removePid()
  }
}

function showStatus(): void {
  const pid = readPid()
  if (pid && isRunning(pid)) {
    console.log(`REGOČ Daemon is RUNNING (PID: ${pid})`)
    console.log(`Log file: ${LOG_FILE}`)
    console.log(`Database: ${DB_PATH}`)

    // Show queue stats
    const db = getDb()
    const pending = db.prepare(`SELECT COUNT(*) as count FROM messages WHERE to_agent = 'regoc' AND status = 'pending'`).get() as any
    const processing = db.prepare(`SELECT COUNT(*) as count FROM messages WHERE to_agent = 'regoc' AND status = 'processing'`).get() as any
    console.log(`\nQueue Status:`)
    console.log(`  Pending: ${pending.count}`)
    console.log(`  Processing: ${processing.count}`)
    db.close()
  } else {
    console.log('REGOČ Daemon is NOT RUNNING')
    removePid()
  }
}

// ============================================
// Main Loop
// ============================================

let lastP1Check = 0

// ── TASK-2987: samoprovjera „vrtim li stari kod" ────────────────────
const STALE_CODE_CHECK_INTERVAL_MS = 300_000 // 5 min
let lastStaleCodeCheck = 0
let staleCodeAlarmActive = false

/**
 * Ako je izvorna datoteka spremljena NAKON starta ovog procesa, popravak nije u pogonu.
 * Alarm se piše na PRIJELAZ stanja (ne svakih 5 min) — inače bi i ovo postalo šum
 * kakav je bio „Last completed task" (93 % loga).
 */
async function checkOwnCodeFreshness(): Promise<void> {
  if (Date.now() - lastStaleCodeCheck < STALE_CODE_CHECK_INTERVAL_MS) return
  lastStaleCodeCheck = Date.now()
  try {
    const { checkStaleCode } = await import('./StaleCodeCheck')
    const rep = checkStaleCode(import.meta.path, process.pid, { label: 'RegocDaemon' })
    if (rep.isStale && !staleCodeAlarmActive) {
      staleCodeAlarmActive = true
      log(`❌❌❌ STALE CODE: ${rep.stale.length} izvorna datoteka novija od procesa (PID ${process.pid}, start ${new Date(rep.startedAtMs).toISOString()})`)
      for (const f of rep.stale.slice(0, 5)) log(`   ${f.path} → ${new Date(f.mtimeMs).toISOString()}`)
      log('   → popravak NIJE u pogonu dok se daemon ne restarta: ~/.claude/regoc/regoc-services.sh restart-service regoc')
    } else if (!rep.isStale && staleCodeAlarmActive) {
      staleCodeAlarmActive = false
      log('✅ STALE CODE riješen — kod u pogonu == kod na disku')
    }
  } catch { /* provjera ne smije rušiti petlju */ }
}
// ─── TASK-3019: zombie-recovery pod flagom (dry-run prvo) ────────────────────
// Načelo (Goran, 2026-07-29): nijedan automatski mehanizam ne mijenja status taska bez
// (1) flaga, (2) zapisa u JSONL i (3) alarma. Zadano stanje je promatranje:
//   zombieRecovery=true, zombieRecoveryLive=false → alarm + JSONL, status se NE dira.
// Pravilo i izuzeća su u `ZombieRecovery.ts` (SSOT), pragovi u config/zombie-recovery.json.
const ZOMBIE_RECOVERY_LOG = join(REGOC_DIR, 'data', 'zombie_recovery.jsonl')
/**
 * Zadnja ZABILJEŽENA presuda po tasku. Petlja se vrti svakih 15 s, a u dry-runu se task
 * NE miče iz in_progress — bez ove memorije bi isti zombi svakih 15 s napunio JSONL i alarm.
 * Zapisuje se samo PROMJENA presude; unos se briše kad task nestane iz in_progress popisa
 * (tada je epizoda gotova i sljedeća se opet prijavljuje).
 */
const _zombieEpisode = new Map<string, string>()

/**
 * Koliko je epizoda oporavka task VEĆ prošao — ulaz u `evaluateZombieTasks`, koji po tome
 * odustaje od beskonačnog vraćanja istog zadatka u obradu.
 *
 * Deklaracija je nedostajala (TASK-3019), pa je `recoverZombieTasks` na svakom prolazu
 * bacao `ReferenceError: zombieRecoveryCount is not defined`. Vlastiti try/catch ga je
 * gutao u jednu redak-poruku, pa je oporavak zombija bio TIHO MRTAV — vidljivo tek pri
 * restartu daemona 29.07.2026. (11 identičnih redaka u minuti).
 */
const zombieRecoveryCount = new Map<string, number>()

/**
 * Kad je zadnja RADNJA izvršena nad taskom (TASK-3598). Radnja se, za razliku od dojave,
 * ne smije prigušiti presudom — ali se mora ograničiti u vremenu: ako `/reclaim` padne
 * (npr. task je u međuvremenu promijenio status), petlja od 15 s inače postaje bubnjanje
 * po API-ju. Hlad je kratak jer uspješna radnja task ionako makne iz `in_progress`.
 */
const _zombieLastAction = new Map<string, number>()
const ZOMBIE_ACTION_COOLDOWN_MS = 60_000

/**
 * Zadaci s ŽIVIM procesom, očitani iz cmdlinea svih procesa (platforma; TASK-3598). Pravilo je u `ZombieRecovery.ts`
 * (SSOT), ovdje je samo čitanje sustava. Greška nikad ne ruši petlju — prazan skup znači
 * „nemam dodatnog dokaza", pa odluka pada natrag na `activeAgentSpawns`.
 */
function taskIdsWithLiveProcess(): Set<string> {
  try {
    const cmdlines: string[] = []
    for (const pid of platformaPidovi()) {
      const c = platformaCmdline(pid)     // null = proces je nestao
      if (c !== null) cmdlines.push(c)
    }
    return extractLiveTaskIds(cmdlines)
  } catch { return new Set<string>() }
}

// ============================================
// Siroče-oporavak (TASK-5140)
// ============================================
//
// Zadatak `in_progress` s izvršiteljem-agentom, a bez živog spawna, procesa i najma. Pravilo
// je u `OrphanRecovery.ts` (SSOT); ovdje je samo čitanje sustava i izvođenje plana.
// Rollback: features.json `siroceOporavak.enabled=false` (djeluje ≤30 s, bez restarta) —
// tada sve opet radi samo zombie-recovery.

/** Zadaci kojima je otkucaj očistio najam (mrtav pid) → vrijeme čišćenja. */
const _siroceOcisceniNajmovi = new Map<string, number>()
/** Zadnji trenutak kad je zadatak u OVOJ generaciji daemona pokazao znak života. */
const _siroceZadnjiZivot = new Map<string, number>()
/** Zadnja zabilježena presuda po zadatku — dojava samo pri promjeni (petlja je 15 s). */
const _siroceEpizoda = new Map<string, string>()
const _siroceZadnjaRadnja = new Map<string, number>()
/** Očišćen najam čeka najdulje ovoliko (npr. dok daemon zatvara spawn), pa se zaboravlja. */
const SIROCE_NAJAM_PAMTI_MS = 30 * 60_000

async function oporaviSirocad(db: Database, trackedSpawns: Set<string>): Promise<Set<string>> {
  const preuzeti = new Set<string>()
  if (!isEnabled('siroceOporavak')) return preuzeti
  const now = Date.now()
  for (const [id, t] of [..._siroceOcisceniNajmovi]) if (now - t > SIROCE_NAJAM_PAMTI_MS) _siroceOcisceniNajmovi.delete(id)
  try {
    const config = ucitajSiroceConfig()
    const ziviProcesi = taskIdsWithLiveProcess()
    const zN = new Set(ziviNajmovi(now).map(n => String(n.taskId)))
    const resp = await fetch(`${TASK_MANAGER_API}?status=in_progress`)
    if (!resp.ok) { log(`  [siroče] TaskManager API ${resp.status}`); return preuzeti }
    const raw = await resp.json() as any
    const tasks: SiroceZadatak[] = Array.isArray(raw) ? raw : (Array.isArray(raw?.tasks) ? raw.tasks : [])
    const brojac = ucitajBrojac()
    const vidjeni = new Set<string>()
    let radnji = 0
    for (const t of tasks) {
      vidjeni.add(t.id)
      if (trackedSpawns.has(t.id) || ziviProcesi.has(t.id) || zN.has(t.id)) _siroceZadnjiZivot.set(t.id, now)
      const upd = Date.parse(String(t.updatedAt || ''))
      const zadnjiZivotMs = Math.max(_siroceZadnjiZivot.get(t.id) || 0, daemonStartTime, Number.isFinite(upd) ? upd : 0)
      const d = odluciSiroce(t, {
        now, config, tracked: trackedSpawns, ziviProcesi, ziviNajmovi: zN,
        ocisceniNajmovi: new Set(_siroceOcisceniNajmovi.keys()), zadnjiZivotMs, dosadasnjih: brojac.get(t.id) || 0,
      })
      if (d.presuda === 'ceka' || jeSiroceRadnja(d.presuda)) preuzeti.add(t.id)
      if (d.presuda === 'izuzet' || d.presuda === 'nije') _siroceOcisceniNajmovi.delete(t.id)
      const ep = `${d.presuda}:${d.okidac || ''}`
      if (_siroceEpizoda.get(t.id) !== ep) {
        _siroceEpizoda.set(t.id, ep)
        if (d.presuda === 'izuzet' && _siroceOcisceniNajmovi.has(t.id)) log(`  ♻️ [siroče] ${t.id} preskočen — ${d.razlog}`)
      }
      if (!jeSiroceRadnja(d.presuda)) continue
      if (now - (_siroceZadnjaRadnja.get(t.id) || 0) < 60_000) continue
      if (radnji >= config.maxRadnjiPoProlazu) {
        log(`  🛑 [siroče] brana: više od ${config.maxRadnjiPoProlazu} radnji u prolazu — ostatak preskačem`)
        break
      }
      // Svježa provjera tik prije radnje: spawn je mogao krenuti dok je trajao fetch.
      if ([...activeAgentSpawns.values()].some(i => i.taskId === t.id) || najamAktivan(t.id)) continue
      const a = planSiroce(d)
      if (!a) continue
      radnji++
      _siroceZadnjaRadnja.set(t.id, now)
      try {
        const r = await fetch(`${TASK_MANAGER_API}${a.path}`, {
          method: a.method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(a.body),
        })
        const zapis = {
          ts: new Date().toISOString(), mechanism: 'siroce-oporavak', taskId: t.id, assignee: d.assignee, title: d.title,
          presuda: d.presuda, okidac: d.okidac, pokusaj: d.pokusaj, strop: d.strop, odsutanMs: d.odsutanMs,
          method: a.method, path: a.path, http: r.status, ok: r.ok, razlog: d.razlog,
        }
        try { appendFileSync(SIROCE_LOG_PATH, JSON.stringify(zapis) + '\n') } catch { /* zapis nije kritičan */ }
        if (r.ok) {
          zabiljeziPokusaj(SIROCE_BROJAC_PATH, t.id, d.pokusaj)
          _siroceOcisceniNajmovi.delete(t.id)
          log(`  ♻️ [siroče] ${t.id} (${d.assignee}) → ${a.targetStatus}: ${d.razlog} (HTTP ${r.status})`)
          logEvent(db, 'siroce_oporavak', d.assignee || 'unassigned', `${t.id} → ${a.targetStatus} (pokušaj ${d.pokusaj}/${d.strop}, okidač ${d.okidac})`)
          const naslov = d.title ? ` „${d.title.slice(0, 60)}"` : ''
          queueUserAlarm(db, a.targetStatus === 'blocked'
            ? `🛑 [siroče] ${t.id}${naslov} (${d.assignee}) — ${d.razlog}. Zadatak je u blocked.`
            : `♻️ [siroče] ${t.id}${naslov} (${d.assignee}) — ostao in_progress bez procesa (${d.okidac === 'najam' ? 'najam očišćen' : 'prag'}). Vraćam ga u obradu (pokušaj ${d.pokusaj}/${d.strop}).`,
            chatZaAlarm(t.tags ?? readTaskRow(t.id)?.tags ?? null, REGOC_GROUP_FALLBACK))   // TASK-5420
        } else {
          log(`  ⚠️ [siroče] ${t.id} ${a.method} ${a.path} → HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`)
        }
      } catch (e) { log(`  ⚠️ [siroče] ${t.id} pao: ${e}`) }
    }
    for (const id of [..._siroceEpizoda.keys()]) if (!vidjeni.has(id)) { _siroceEpizoda.delete(id); _siroceZadnjiZivot.delete(id) }
    // Očišćen najam zadatka koji više nije in_progress (zatvoren, vraćen) se zaboravlja.
    for (const id of [..._siroceOcisceniNajmovi.keys()]) if (!vidjeni.has(id)) _siroceOcisceniNajmovi.delete(id)
  } catch (e) {
    log(`  ⚠️ [siroče] ${e}`)
  }
  return preuzeti
}

// ============================================
// Pozadina-povrat (TASK-5259)
// ============================================
//
// Agent koji pokrene dugi posao u pozadini i javi BLOCKED + `REGOC-POZADINA: pid=…` dobiva
// najam (data/pozadina/<taskId>.json). Ovdje se svakih `razmakSekundi` (zadano 120) provjerava:
// svi PID-ovi mrtvi (uz starttime) / uvjet gotovosti / rok → /reclaim from:blocked by
// `pozadina-gotova` → pending → uobičajeni auto-exec (vrata autonomije, strop usporednih).
// Pravilo je u `PozadinaPovrat.ts`. Rollback: features.json `pozadinaPovrat.enabled=false`.
let _pozadinaZadnjiProlaz = 0

async function vratiPozadinske(db: Database): Promise<void> {
  if (!isEnabled('pozadinaPovrat')) return
  const now = Date.now()
  const config = ucitajPozadinaConfig()
  if (now - _pozadinaZadnjiProlaz < config.razmakSekundi * 1000) return
  _pozadinaZadnjiProlaz = now
  try {
    await prolazPozadine({
      api: TASK_MANAGER_API, config, now, log,
      globalnaPauza: readPauseState().paused,
      alarm: (poruka, taskId) => {
        logEvent(db, 'pozadina_povrat', 'regoc', poruka.slice(0, 300))
        // TASK-5420: dojava ide u grupu zadatka (oznaka chat:), bez nje u REGOČ grupu.
        let chat = REGOC_GROUP_FALLBACK
        try { chat = chatZaAlarm(taskId ? readTaskRow(taskId)?.tags ?? null : null, REGOC_GROUP_FALLBACK) } catch { /* zadana */ }
        queueUserAlarm(db, poruka, chat)
      },
    })
  } catch (e) { log(`  ⚠️ [pozadina] ${e}`) }
}

async function recoverZombieTasks(db: Database, trackedSpawns: Set<string>, prepusteni: Set<string> = new Set()): Promise<void> {
  if (!isEnabled('zombieRecovery')) return
  const live = isEnabled('zombieRecoveryLive')
  const config = loadZombieRecoveryConfig()
  // Dva neovisna dokaza života: spawn u ovom daemonu I živ proces u sustavu. Drugi pokriva
  // sesije prethodne generacije daemona i interaktivne sesije, koje prvi ne može vidjeti.
  const zivi = taskIdsWithLiveProcess()
  const tracked = new Set<string>([...trackedSpawns, ...zivi])
  const spaseni = [...zivi].filter(id => !trackedSpawns.has(id))
  if (spaseni.length > 0) log(`  🫀 [zombie] živ proces (izvan evidencije spawnova) za: ${spaseni.join(', ')} — ne diram ih`)
  try {
    const resp = await fetch(`${TASK_MANAGER_API}?status=in_progress`)
    if (!resp.ok) { log(`  [zombie] TaskManager API ${resp.status}`); return }
    const raw = await resp.json() as any
    const tasks = Array.isArray(raw) ? raw : []
    const decisions = evaluateZombieTasks(tasks, { now: Date.now(), config, tracked, priorRecoveries: zombieRecoveryCount, delegated: prepusteni })
    const seen = new Set<string>()
    const novo: typeof decisions = []

    // 1) DOJAVA — samo za presude koje su se promijenile od zadnjeg prolaza.
    for (const d of decisions) {
      seen.add(d.taskId)
      if (_zombieEpisode.get(d.taskId) === d.verdict) continue   // ista presuda kao zadnji put → tišina
      _zombieEpisode.set(d.taskId, d.verdict)
      if (!isZombieActionable(d.verdict)) {
        if (d.verdict === 'excluded') log(`  [zombie] ${d.taskId} preskočen — ${d.reason}`)
        continue
      }
      novo.push(d)

      log(`  [zombie ${live ? 'LIVE' : 'DRY'}] ${d.taskId} (${d.assignee}) ${d.reason}`)
      appendDecisionJsonl(ZOMBIE_RECOVERY_LOG, live, {
        mechanism: 'zombie-recovery',
        taskId: d.taskId, assignee: d.assignee, title: d.title,
        verdict: d.verdict, ageMs: d.ageMs, recoveryCount: d.recoveryCount, reason: d.reason,
      })
      const naslov = d.title ? ` „${d.title.slice(0, 60)}"` : ''
      queueUserAlarm(db, `⚠️ [zombie] ${d.taskId}${naslov} (${d.assignee}) — ${d.reason}. ${live ? 'Vraćam ga u obradu.' : '(dry-run — samo dojava, ne diram)'}`)
    }

    // Task koji više nije in_progress je završio epizodu — sljedeći put se opet prijavljuje.
    for (const id of [..._zombieEpisode.keys()]) if (!seen.has(id)) _zombieEpisode.delete(id)

    // 2) RADNJA — u dry-runu je plan uvijek prazan (planZombieActions, SSOT).
    // Startna milost (TASK-3598): odmah nakon restarta je `tracked` prazan, pa svaki živ
    // agent nakratko izgleda kao zombi — plan u tom prozoru ostaje prazan, dojava ne.
    const startupGrace = withinStartupGrace(Date.now(), daemonStartTime, config)
    if (startupGrace && novo.length > 0) {
      log(`  ⏳ [zombie] startna milost (${config.startupGraceMinutes}min od restarta) — ${novo.length} presuda samo zabilježeno, ništa se ne dira`)
    }
    // NALAZ 02.09.2026. (canary TASK-3598, dokazan na TASK-3615): plan se gradio iz `novo`,
    // a `novo` sadrži samo presude PROMIJENJENE od zadnjeg prolaza. Zombi jednom prijavljen
    // u dry-runu zadržava presudu zauvijek, pa ga paljenje live načina više nikad ne bi
    // dotaknulo — mehanizam bi izgledao upaljen, a ne bi vratio nijedan zadatak u red
    // (točno kvar koji DUR-1 popravlja). Zato: DOJAVA ostaje prigušena (`novo`), a RADNJA
    // ide po SVIM aktualnim presudama, uz kratki hlad po tasku.
    const zaRadnju = decisions.filter(d =>
      isZombieActionable(d.verdict) && Date.now() - (_zombieLastAction.get(d.taskId) || 0) > ZOMBIE_ACTION_COOLDOWN_MS
    )
    const { actions, capped } = planZombieActions(zaRadnju, { live, config, startupGrace })
    if (capped) {
      log(`  🛑 [zombie] brana: više od ${config.maxActionsPerRun} promjena statusa u ovom prolazu — ostatak preskačem`)
      queueUserAlarm(db, `🛑 [zombie] Recovery je u jednom prolazu htio dirati više od ${config.maxActionsPerRun} taskova — stao je iz sigurnosti. Provjeri config/zombie-recovery.json.`)
    }
    for (const a of actions) {
      // Epizodu brojimo tek kad se stvarno djeluje — inače bi dry-run tiho „potrošio"
      // prvu epizodu i pri paljenju live načina task bi odmah otišao u BLOCKED.
      zombieRecoveryCount.set(a.taskId, a.decision.recoveryCount)
      _zombieLastAction.set(a.taskId, Date.now())
      try {
        // NALAZ 2026-07-28 (TASK-2560): PUT in_progress→pending TIHO PADA na 409 (zabranjen
        // prijelaz) — do 02.09.2026. je live način bio mrtvo slovo. Goranova odluka
        // (Telegram, 02.09.2026., TASK-3598): povratak u obradu ide kroz R2 rutu
        // POST /api/tasks/:id/reclaim, uz izuzeća dijeljena sa stale-watchdogom.
        // Ruta i metoda dolaze IZ PLANA (ZombieRecovery.ts) — daemon ih ne bira sam.
        const r = await fetch(`${TASK_MANAGER_API}${a.path}`, {
          method: a.method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(a.body)
        })
        // ISHOD, ne samo namjera: do sada je JSONL bilježio što bi mehanizam učinio, a ne
        // je li uspio — pa se 409 na PUT-u nije vidio nigdje osim u logu (TASK-3598).
        const ishod = {
          mechanism: 'zombie-recovery', event: 'action',
          taskId: a.taskId, assignee: a.assignee, title: a.decision.title,
          verdict: a.decision.verdict, targetStatus: a.targetStatus,
          route: a.route, method: a.method, path: a.path,
          http: r.status, ok: r.ok, recoveryCount: a.decision.recoveryCount, reason: a.decision.reason,
        }
        if (r.ok) {
          appendDecisionJsonl(ZOMBIE_RECOVERY_LOG, live, ishod)
          logEvent(db, 'zombie_recovery', a.assignee || 'unassigned', `${a.taskId} → ${a.targetStatus} preko ${a.route} (epizoda ${a.decision.recoveryCount})`)
          log(`  ✅ [zombie] ${a.taskId} → ${a.targetStatus} (${a.method} ${a.path}, HTTP ${r.status})`)
          // TASK-4992 FIX: reclaim bez gašenja spawna ostavljao zauzet slot zauvijek.
          for (const [key, info] of activeAgentSpawns.entries()) {
            if (info.taskId === a.taskId) {
              const agentName = agentRegistry?.agents?.[info.agent]?.name || info.agent
              killAgentSpawn(info, agentName, `zombie-recovery reclaim (epizoda ${a.decision.recoveryCount})`, 'zombie-recovery', true,
                `↻ Zadatak vraćen u red (zombie). Spawn ugašen, slot oslobođen.`)
              activeAgentSpawns.delete(key)
              log(`🧹 [zombie] spawn ${info.agent} pid=${info.pid} za ${a.taskId} ugašen i slot oslobođen`)
              break
            }
          }
        } else {
          const tijelo = (await r.text()).slice(0, 200)
          appendDecisionJsonl(ZOMBIE_RECOVERY_LOG, live, { ...ishod, error: tijelo })
          log(`  ⚠️ [zombie] ${a.taskId} ${a.method} ${a.path} → HTTP ${r.status}: ${tijelo}`)
        }
      } catch (e) { log(`  ⚠️ [zombie] ${a.taskId} pao: ${e}`) }
    }
  } catch (e) {
    log(`  ⚠️ [zombie] ${e}`)
  }
}

// ============================================
// Mjerenje potrošnje sesije (vlastito, neovisno o agentima)
// ============================================
//
// TASK-3046. Do 29.07.2026. keš potrošnje pisali su ISKLJUČIVO Claude Code hookovi
// (`UserPromptSubmit`/`Stop` → tools/session_usage.py). Znači: mjerilo je radilo samo dok
// su agenti radili. Vrata autonomije su na prestarom kešu fail-open, pa je nastala petlja
// koja se sama hrani:
//
//   gate zaustavi agente → nitko ne mjeri → keš zastari (30 min) → gate oslijepi →
//   fail-open pusti rafal od MAX_AGENT_CONCURRENT spawnova → njihov hook izmjeri 100 % →
//   spawnovi se odbiju (429/no-turns) → zadaci padnu u `blocked` → gate opet zaustavi …
//
// Dokaz iz `daemon.log` 29.07.: rafali po 3 Opus spawna u 07:24:43, 07:55:06, 08:25:30,
// 08:55:54 — razmak ≈ 30,4 min, točno prozor zastarijevanja keša; svaki je pao u
// „no-turns" jer je sesija stajala na 100 %.
//
// Lijek je da mjerilo ima vlastiti pogon: daemon sam pokreće probe (~1 token) neovisno o
// tome radi li ijedan agent. Prazan hod je 1 token / 5 min.
const SESSION_USAGE_REFRESH_MS = 5 * 60 * 1000
/**
 * Donja granica između DVA PRISILNA mjerenja i kratki rok za njih.
 *
 * Prisilno mjerenje zove se iz odluke o spawnu, dakle iz glavne petlje, i to svakih
 * 15 s dok god snimka stoji stara (npr. probe je pukao jer mreža ne radi). Bez ove
 * granice pokvareni probe znači novi python proces svakih 15 s, a dugi rok znači da
 * jedno mrežno visjenje zaustavi CIJELU petlju (rutanje poruka, heartbeat, watchdoge).
 * Ako mjerenje ne stigne u roku, snimka ostaje stara — a stara snimka je fail-CLOSED,
 * pa nas isticanje roka ne može gurnuti u rafal.
 */
const SESSION_USAGE_FORCE_MIN_MS = 30 * 1000
const SESSION_USAGE_PROBE_TIMEOUT_MS = 45_000
const SESSION_USAGE_FORCE_TIMEOUT_MS = 12_000
let lastSessionUsageRefresh = 0
let sessionUsageRefreshInFlight = false

/**
 * Zadnji poznati razlog zašto mjerenje ne prolazi (TASK-3461).
 *
 * Ne čita se iz keša nego se pamti ovdje, jer keš po pravilu fail-CLOSED NE prima neuspjele
 * snimke — u njemu i dalje stoji `http_error` iz zadnjeg USPJEŠNOG mjerenja. Kad je 26.08.
 * 223 uzastopna probea vratilo 401, keš o tome nije znao ništa.
 */
let lastUsageProbeFailure: string | null = null
/** TASK-3556: koliko dugo traje niz 401 i koliko je buđenja prijave već pokušano. */
let tokenNudgeState: TokenNudgeState = { ...EMPTY_TOKEN_NUDGE_STATE }
/** Anti-spam za redak o odbijenom mjerilu: isti razlog se ponavlja najviše ovako često. */
const USAGE_REJECT_LOG_REPEAT_MS = 15 * 60 * 1000
let lastUsageRejectLog = { reason: '', at: 0 }

/**
 * Osvježi keš potrošnje sesije vlastitim probeom. Ne baca i ne blokira petlju —
 * `force` preskače redovni razmak od 5 min (koristi se kad gate zatekne prestaru
 * snimku), ali NE i tvrdu donju granicu iz `SESSION_USAGE_FORCE_MIN_MS`.
 */
async function refreshSessionUsage(force = false): Promise<void> {
  const now = Date.now()
  if (sessionUsageRefreshInFlight) return
  const minGap = force ? SESSION_USAGE_FORCE_MIN_MS : SESSION_USAGE_REFRESH_MS
  if (now - lastSessionUsageRefresh < minGap) return
  if (!existsSync(SESSION_USAGE_TOOL)) return
  sessionUsageRefreshInFlight = true
  lastSessionUsageRefresh = now
  try {
    // `--quiet` = izmjeri, zapiši u JSONL i keš, ništa ne ispisuj.
    const proc = Bun.spawn(['/usr/bin/python3', SESSION_USAGE_TOOL, '--quiet'], {
      stdout: 'ignore', stderr: 'pipe', cwd: HOME,
    })
    const timeoutMs = force ? SESSION_USAGE_FORCE_TIMEOUT_MS : SESSION_USAGE_PROBE_TIMEOUT_MS
    const code = await Promise.race([
      proc.exited,
      new Promise<number>(r => setTimeout(() => { try { proc.kill() } catch {} ; r(-1) }, timeoutMs)),
    ])
    // TASK-3461: tri ishoda se razlikuju jer traže različit postupak — `rejected` (exit 2)
    // znači da je Anthropic odbio probe (istekao token, ovlasti), `timeout` da je spor, a
    // sve ostalo da je alat pao. Do sada su sva tri bila isti redak, a exit 2 nije ni
    // postojao: 401 je prolazio kao uspjeh i mjerilo je tiho stajalo satima.
    const stderr = code === 0 ? '' : await new Response(proc.stderr).text().catch(() => '')
    const verdict = classifyProbeExit(code, stderr, timeoutMs)
    // TASK-3556: niz 401 se broji ovdje, na izvoru, jer je ovo jedino mjesto koje zna
    // ishod SVAKOG probea (keš neuspjele snimke po pravilu fail-CLOSED ne prima).
    tokenNudgeState = noteProbeForNudge(tokenNudgeState, verdict.reason, Date.now())
    if (verdict.outcome === 'ok') {
      lastUsageProbeFailure = null
      lastUsageRejectLog = { reason: '', at: 0 }
    } else {
      lastUsageProbeFailure = verdict.reason
      const sameAsLast = verdict.outcome === 'rejected'
        && lastUsageRejectLog.reason === verdict.reason
        && Date.now() - lastUsageRejectLog.at < USAGE_REJECT_LOG_REPEAT_MS
      if (!sameAsLast) {
        if (verdict.outcome === 'rejected') lastUsageRejectLog = { reason: verdict.reason || '', at: Date.now() }
        log(verdict.logLine)
      }
    }
  } catch (e) {
    lastUsageProbeFailure = `probe potrošnje pao: ${e}`
    log(`⚠️ [usage] probe potrošnje pao: ${e}`)
  } finally {
    sessionUsageRefreshInFlight = false
  }
}

// ── Buđenje prijave na dugotrajni 401 (TASK-3556) ───────────────────────────
//
// Pozadina i pravila odluke su u `UsageMeter.ts`; ovdje je samo spawn i dojava. Ukratko:
// token obnavlja isključivo Claude CLI, pa kad autonomija stane (tjedni strop) nitko CLI
// ne pokreće, token istekne i mjerilo umre — 40,3 h u nizu, izmjereno 01.09.2026.
//
// Poziv NE nosi posao: jedan prompt na najjeftinijem modelu, bez alata, samo da CLI usput
// prepiše prijavu. Zato ne dira vrata autonomije ni tjedni strop (pravilo #20 gasi vučenje
// posla iz reda, ne održavanje mjerila). Ručnu kočnicu ipak poštuje — kad je Goran pauzirao
// sve, ne pokreće se ni ovo.
const TOKEN_NUDGE_MODEL = 'claude-haiku-4-5-20251001'
const TOKEN_NUDGE_TIMEOUT_MS = 90_000
let tokenNudgeInFlight = false

async function nudgeCliTokenRefresh(db: Database): Promise<void> {
  const now = Date.now()
  // Prvo tekući pokušaj, pa tek onda presuda o njemu: dok buđenje traje, još se ne zna je
  // li uspjelo, pa bi dojava „treba ručna prijava" bila preuranjena.
  if (tokenNudgeInFlight) return
  if (shouldReportRelogin(tokenNudgeState)) {
    const poruka = formatReloginNeeded(tokenNudgeState, now)
    tokenNudgeState = { ...tokenNudgeState, reloginReported: true }
    log(poruka)
    queueUserAlarm(db, poruka)
    return
  }
  if (!decideTokenNudge(tokenNudgeState, now)) return
  if (readPauseState().paused) return   // kočnica je kočnica i za ovo

  tokenNudgeState = noteNudgeStarted(tokenNudgeState, now)
  tokenNudgeInFlight = true
  const minuta = tokenNudgeState.unauthorizedSince === null
    ? '?' : Math.round((now - tokenNudgeState.unauthorizedSince) / 60000)
  log(`🔑 [prijava] 401 traje ${minuta} min — budim CLI (${TOKEN_NUDGE_MODEL}, pokušaj ${tokenNudgeState.tries}/${TOKEN_NUDGE_MAX_TRIES}) da obnovi token`)
  try {
    const proc = Bun.spawn(
      ['claude', '--print', '--dangerously-skip-permissions', '--model', TOKEN_NUDGE_MODEL, '-p', 'ok'],
      {
        cwd: HOME,
        stdout: 'ignore',
        stderr: 'pipe',
        env: {
          PATH: `${join(HOME, '.local/node/bin')}:${join(HOME, '.local/bin')}:${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}`,
          HOME,
          USER: process.env.USER || 'klaudio',
          SHELL: process.env.SHELL || '/bin/bash',
          TERM: 'xterm-256color',
          BUN_INSTALL: process.env.BUN_INSTALL || join(HOME, '.bun'),
          CLAUDE_SUBAGENT: '1',                               // Stop hook preskače glas
          CLAUDE_CODE_TMPDIR: join(HOME, '.tmp/claude-tmp'),
          ...tmpOkolina(tmpMapaSpawna(null, 'prijava')),      // TASK-5336: ne u /tmp
        },
      },
    )
    const code = await Promise.race([
      proc.exited,
      new Promise<number>(r => setTimeout(() => { try { proc.kill() } catch {} ; r(-1) }, TOKEN_NUDGE_TIMEOUT_MS)),
    ])
    if (code === 0) {
      log('🔑 [prijava] CLI je odgovorio — provjeravam je li mjerilo proradilo')
    } else {
      const err = (await new Response(proc.stderr).text().catch(() => '')).trim().split('\n')[0] || `exit ${code}`
      log(`⚠️ [prijava] buđenje CLI-ja nije uspjelo (${code === -1 ? `nema odgovora u ${TOKEN_NUDGE_TIMEOUT_MS} ms` : err.slice(0, 200)})`)
    }
  } catch (e) {
    log(`⚠️ [prijava] buđenje CLI-ja palo: ${e}`)
  } finally {
    tokenNudgeInFlight = false
  }
  // Presudu donosi probe, ne izlazni kod CLI-ja: tek prolazak probea briše niz 401.
  await refreshSessionUsage(true)
}

// ── Alarm na zamrznutu snimku (TASK-3461, B) ────────────────────────────────
//
// Odluka je čista funkcija u `UsageMeter.ts`; ovdje je samo I/O oko nje. Prolaz je throttlan
// na minutu jer se glavna petlja vrti svakih par sekundi, a mjerilo se ionako osvježava svakih
// 5 min — češće provjeravanje ne bi doznalo ništa novo.
const METER_WATCHDOG_INTERVAL_MS = 60_000
let lastMeterWatchdog = 0
let meterAlarmState: MeterAlarmState = { ...EMPTY_METER_ALARM_STATE }

/**
 * Javi jednom kad mjerilo potrošnje stane, pa šuti do idućeg sata; javi i kad proradi.
 *
 * Zapis reda (`data/autonomy_queue.json`) dobiva `meter_status` pri svakom prolazu, i kad
 * posao teče — inače bi ploča čitala stanje mjerila iz zapisa starog satima.
 */
async function usageMeterWatchdog(db: Database): Promise<void> {
  const now = Date.now()
  if (now - lastMeterWatchdog < METER_WATCHDOG_INTERVAL_MS) return
  lastMeterWatchdog = now
  try {
    const usage = readSessionUsage(now)
    const { hasUsageHistory } = await import('./SpawnTelemetry')
    const health = assessMeter({
      now,
      snapshotAgeMs: usage ? usage.ageMs : null,
      sessionPercent: usage?.sessionPercent ?? null,
      // Keš ne prima neuspjele snimke, pa je razlog iz vlastitog probea jedini svjež trag;
      // `http_error` iz snimke je zamjena kad daemon još nije sam mjerio.
      lastError: lastUsageProbeFailure || usage?.httpError || null,
      // Svježa snimka bez postotka i bez odbijenice = mjerilo se vrti u prazno.
      snapshotUninformative: !!usage && usage.sessionPercent === null && usage.status !== 'rejected',
      everMeasured: hasUsageHistory(),
      // TASK-4780: čvor bez `session_usage.py` nema čime mjeriti — bez ovoga ploča piše
      // `meter_status=ok` iznad autonomije koju su vrata (TASK-4779) već zaustavila.
      meterInstalled: existsSync(SESSION_USAGE_TOOL),
    }, METER_STALE_MS)

    const { saveMeterHealth } = await import('./AutonomyQueue')
    saveMeterHealth({
      meter_status: health.down ? 'down' : 'ok',
      meter_down_min: health.downMin,
      meter_error: health.down ? health.lastError : null,
    }, now)

    // TASK-3556: kad je uzrok kvara istekla prijava, probaj je probuditi. Ide bez `await` —
    // buđenje traje do 90 s, a watchdog ne smije toliko držati glavnu petlju.
    void nudgeCliTokenRefresh(db)

    const decision = decideMeterAlarm(meterAlarmState, health, now)
    meterAlarmState = decision.state
    // TASK-5512: `mjeriloDojava=false` gasi samo Telegram (NodeA); dnevnik i stanje ostaju.
    deliverMeterAlarm(decision, isEnabled(METER_ALARM_FLAG, true), { log, queue: (m) => queueUserAlarm(db, m) })
  } catch (e) {
    // Dojava koja ruši petlju gora je od dojave koje nema.
    log(`⚠️ [mjerilo] provjera zdravlja mjerila pala: ${e}`)
  }
}

// ============================================
// Ručna kočnica (TASK-3047)
// ============================================

/**
 * Provedi pauze: globalnu i po zadatku. Prekida tekuće spawnove i vraća `true` ako je
 * rad globalno zaustavljen (pozivatelj tada ne pokreće ništa novo).
 *
 * Prekid ide kroz `killAgentSpawn`, isti put kojim ide watchdog — tako spawn handler
 * zna da je izlaz NAŠ prekid (`killedBy`), pa zadatak ne padne u `blocked` s lažnom
 * dijagnostikom „agent je sam pao".
 */
let lastPauseLog = 0

function enforcePauses(pausedTaskIds: Set<string>): boolean {
  const state = readPauseState()
  if (state.paused) {
    if (Date.now() - lastPauseLog > 60000) {
      lastPauseLog = Date.now()
      log(`⏸️ [pauza] ${describePause(state)} — auto-exec stoji`)
    }
    for (const [key, info] of activeAgentSpawns.entries()) {
      if (info.killedBy) continue
      killAgentSpawn(info, key, `globalna pauza${state.reason ? `: ${state.reason}` : ''}`, state.by || 'user', true)
    }
    prekiniVoditelje(`globalna pauza${state.reason ? `: ${state.reason}` : ''}`, state.by || 'user')
    return true
  }
  for (const info of voditeljSpawns.values()) {
    if (!info.killedBy && info.taskId && pausedTaskIds.has(info.taskId)) prekiniVoditelje('zadatak voditelja je pauziran', 'user', info.taskId)
  }
  for (const [key, info] of activeAgentSpawns.entries()) {
    if (info.killedBy || !info.taskId || !pausedTaskIds.has(info.taskId)) continue
    killAgentSpawn(info, key, 'zadatak je pauziran u TaskManageru', 'user', true)
  }
  return false
}

// ============================================
// Okidač na obnovu kvote (A7 / TASK-3006, DIO 1)
// ============================================
//
// Pravilo koje ovdje vrijedi i koje se lako izgubi: okidač NE POKREĆE POSAO. Posao pokreće
// auto-exec čim vrata autonomije propuste. Okidač radi jednu jedinu stvar — u trenutku
// `session_reset_at + razmak` prisili SVJEŽE mjerenje potrošnje, jer bi se inače čekalo na
// redovni probe (5 min) ili, gore, na tuđi hook. Odluka („je li vrijeme") je čista funkcija
// u `QuotaWakeup.ts` i pokrivena je testovima; ovdje je samo I/O oko nje.

let lastWakeupLogKey = ''
let lastWakeupLogAt = 0

/**
 * Koliko je prošlo otkad je ČOVJEK zadnji put nešto napravio (ms), ili `null` ako se ne zna.
 *
 * Dva traga, oba jeftina i oba već postoje: poruka koju je poslao čovjek (`messages`, Telegram
 * ili konzola) i zadatak koji je čovjek stvorio (`created_by='user'` iz popisa koji je
 * auto-exec ionako upravo dohvatio). Namjerno se NE gleda mtime Telegram razgovora niti
 * svježina transkripta: te datoteke dira i sam sustav kad javlja izvještaje, pa bi autonomija
 * vlastitu buku čitala kao „čovjek radi" i odgađala se u nedogled.
 */
async function readHumanIdleMs(db: Database, pendingTasks: any[], now: number): Promise<number | null> {
  const stamps: unknown[] = []
  try {
    const row = db.query("SELECT MAX(created_at) AS ts FROM messages WHERE from_agent IN ('user','goran')").get() as any
    stamps.push(row?.ts)
  } catch { /* nema tablice/stupca → trag se jednostavno ne broji */ }
  for (const t of pendingTasks) {
    if ((t?.createdBy || t?.created_by) === 'user') stamps.push(t?.createdAt || t?.created_at)
  }
  const { humanIdleMs } = await import('./QuotaWakeup')
  return humanIdleMs(now, stamps)
}

/**
 * Jedan prolaz okidača dok su vrata zatvorena: zapiši red čekanja i, ako je termin došao,
 * prisili mjerenje. Vraća (moguće novu) razinu autonomije — pozivatelj radi s njom dalje.
 */
/** Zadnje prijavljeno stanje preskočenog reda — da se isti redak ne ponavlja svakih 15 s. */
let _zadnjiOtisakPreskocenih = ''

async function quotaWakeupPass(db: Database, ctx: { tasks: any[], queue: any, usage: any, tier: any }): Promise<any> {
  const now = Date.now()
  try {
    const QW = await import('./QuotaWakeup')
    const AQ = await import('./AutonomyQueue')
    const { autonomyTierFromUsage } = await import('./WorkStateJournal')

    const state = QW.readWakeupState()
    const decision = QW.planWakeup({
      now,
      gateOpen: false,
      queueDepth: ctx.tasks.length,
      // Vrijeme se čita IZNOVA iz zadnje snimke — prozor je klizni, pa „prošli + 5 h" laže.
      sessionResetAt: ctx.usage?.sessionResetAt ?? null,
      lastWakeAt: state.lastWakeAt ? Date.parse(state.lastWakeAt) : null,
      attempts: state.attempts,
      humanIdleMs: await readHumanIdleMs(db, ctx.tasks, now),
      // Globalna kočnica je već obrađena na ulazu u `processP1Tasks` (enforcePauses).
      paused: false,
    })

    // Red čekanja dobiva razlog i termin. Tjedna kvota nema `weekly_reset_at` u snimci, pa
    // ondje termina nema — okidač tada radi po eksponencijalnom razmaku, ne po satu.
    const wp = ctx.usage?.weeklyPercent
    const weeklyBlocked = typeof wp === 'number' && wp >= currentAutonomyThresholds().weeklyBlock
    const waitingFor = weeklyBlocked ? 'quota-weekly' : 'quota-session'
    // TASK-3461: uz „na što se čeka" ide i „radi li mjerilo". Bez toga „87 %, mjereno prije
    // 139 min" i „87 %, mjereno prije 2 min" na ploči izgledaju isto, a prvo znači kvar.
    const health = assessMeter({
      now,
      snapshotAgeMs: ctx.usage ? ctx.usage.ageMs : null,
      sessionPercent: ctx.usage?.sessionPercent ?? null,
      lastError: lastUsageProbeFailure || ctx.usage?.httpError || null,
      snapshotUninformative: !!ctx.usage && ctx.usage.sessionPercent === null && ctx.usage.status !== 'rejected',
      everMeasured: (await import('./SpawnTelemetry')).hasUsageHistory(),
      // TASK-4780: ista činjenica i ovdje — zapis reda i vrata autonomije moraju govoriti isto.
      meterInstalled: existsSync(SESSION_USAGE_TOOL),
    }, METER_STALE_MS)
    const snapshot = AQ.buildWaitingQueue({
      now,
      entries: ctx.queue.eligible,
      humanGated: ctx.queue.counts['human-gated'] || 0,
      waitingFor,
      meter: {
        meter_status: health.down ? 'down' : 'ok',
        meter_down_min: health.downMin,
        meter_error: health.down ? health.lastError : null,
      },
      reason: ctx.tier.reason,
      resumeEta: weeklyBlocked ? null : decision.dueAt,
      resumeEtaLocal: weeklyBlocked ? null : QW.formatLocalTime(decision.dueAt),
      previous: AQ.readWaitingQueue(),
    })
    if (AQ.saveWaitingQueue(snapshot)) log(`🧾 [red] ${AQ.describeWaitingQueue(snapshot)}`)

    if (decision.action !== 'wake') {
      // Log se ponavlja samo kad se promijeni razlog ili prođe 15 min — inače bi petlja od
      // 15 s pisala isti redak 240 puta na sat (točno bolest koju je K4 trebao izliječiti).
      const key = `${decision.action}:${decision.dueAt || '-'}`
      if (key !== lastWakeupLogKey || now - lastWakeupLogAt > 15 * 60 * 1000) {
        lastWakeupLogKey = key
        lastWakeupLogAt = now
        log(`⏳ [okidač] ${decision.reason}`)
        if (decision.action === 'defer-human') {
          QW.appendWakeupJournal({
            ts: new Date(now).toISOString(), event: 'deferred', reason: decision.reason,
            attempt: decision.attempt, queue_depth: ctx.tasks.length,
            session_percent: ctx.usage?.sessionPercent ?? null,
            session_reset_at: ctx.usage?.sessionResetAt ?? null,
            session_reset_local: QW.formatLocalTime(ctx.usage?.sessionResetAt ?? null),
          })
        }
      }
      return ctx.tier
    }

    // Zastavica `quotaWakeup` (features.json, hot-reload ≤30 s): false = okidač samo vodi red
    // čekanja i šuti, ne mjeri. Default je TRUE jer buđenje NE POKREĆE posao — ono naruči
    // mjerenje od ~1 tokena, a odluku i dalje donose vrata autonomije (`autonomyGate`, već
    // live od 28.07.). Rollback bez restarta ostaje moguć.
    if (!isEnabled('quotaWakeup', true)) {
      log(`👁️ [okidač SHADOW] ${decision.reason} — mjerenje preskočeno (quotaWakeup=false)`)
      return ctx.tier
    }

    log(`⏰ [okidač] ${decision.reason}`)
    await refreshSessionUsage(true)
    const fresh = readSessionUsage()
    const newTier = autonomyTierFromUsage(fresh)
    const opened = newTier.autonomousQueue === true

    const wakeState = QW.recordWake(now, decision.dueAt, state)
    QW.writeWakeupState(opened ? QW.clearAttempts(wakeState) : wakeState)
    QW.appendWakeupJournal({
      ts: new Date(now).toISOString(),
      event: opened ? 'resumed' : 'still-blocked',
      reason: opened ? `kvota obnovljena — ${ctx.tasks.length} zadataka kreće` : newTier.reason,
      attempt: wakeState.attempts,
      queue_depth: ctx.tasks.length,
      session_percent: fresh?.sessionPercent ?? null,
      session_reset_at: fresh?.sessionResetAt ?? null,
      session_reset_local: QW.formatLocalTime(fresh?.sessionResetAt ?? null),
    })

    if (opened) {
      const waitedMs = AQ.clearWaitingQueue(now)
      lastWakeupLogKey = ''
      log(`✅ [okidač] kvota obnovljena (sesija ${fresh?.sessionPercent ?? '?'} %) — ${ctx.tasks.length} zadataka kreće${waitedMs !== null ? `, čekalo ${Math.round(waitedMs / 60000)} min` : ''}`)
    } else {
      const next = QW.retryDelayMs(wakeState.attempts)
      log(`🔁 [okidač] kvote još nema (${newTier.reason}) — sljedeći pokušaj za ${Math.round(next / 60000)} min`)
    }
    return newTier
  } catch (e) {
    // Fail-open prema ZATEČENOM ponašanju: greška u okidaču ne smije ni pokrenuti rad ni
    // zaustaviti petlju — vraća se razina koja je vrijedila i prije poziva.
    log(`⚠️ [okidač] pao: ${e}`)
    return ctx.tier
  }
}

const P1_CHECK_INTERVAL_MS = 15000
/**
 * SHADOW brojač: koliko bi zadataka ušlo u razlaganje. Ne mijenja ništa i ne troši
 * model — `isDecomposable` je čista heuristika nad naporom i opisom. Zapis ide u
 * data/task_decomposition.jsonl, isti tok kao ostale sjene (tier, worktree, scope).
 */
function observeDecomposable(task: any): void {
  if (!isEnabled('taskDecompose')) return
  try {
    // TASK-5367: zadatak iz ulaza nosi predložak koraka — napor se mjeri nad zahtjevom, ne nad predloškom.
    const opis = zahtjevKorisnika(task.description)
    const cls = getModeClassifier().classify({ title: task.title || '', description: opis, tags: task.tags || [] })
    const gate = isDecomposableTask({ id: String(task.id), title: task.title, description: opis, tags: task.tags }, cls.effort)
    if (!gate.eligible) return
    logDecomposeDecision({ event: 'observed', taskId: String(task.id), effort: cls.effort, assignee: task.assignee || null, reason: gate.reason, live: isEnabled('taskDecomposeLive') })
    log(`  🧩 [razlaganje SHADOW] ${task.id} (${cls.effort}) bi išao u 3–7 podzadataka umjesto jednom generalistu — plan: bun tools/decompose.ts plan ${task.id} --notify`)
  } catch { /* promatranje nikad ne smije srušiti auto-exec */ }
}

// ─── P5c/TASK-2584: pogon razloženih zadataka ────────────────────────────────
// Razlaganje E4/E5 posla živi u `TaskDecomposer.ts` (čista logika) i
// `tools/decompose.ts` (plan → potvrda → materijalizacija). Daemonu treba samo
// jedno: otpremiti korake kojima su ovisnosti upravo postale gotove.
const DECOMPOSE_PUMP_INTERVAL_MS = 60_000
let lastDecomposePump = 0

async function decompositionPump(): Promise<void> {
  if (!isEnabled('taskDecompose')) return
  if (Date.now() - lastDecomposePump < DECOMPOSE_PUMP_INTERVAL_MS) return
  lastDecomposePump = Date.now()
  try {
    const { listPlans } = await import('./TaskDecomposer')
    const { pumpPlan } = await import('./tools/decompose')
    for (const plan of listPlans().filter(p => p.status === 'materialized')) {
      const n = await pumpPlan(plan.taskId)
      if (n > 0) log(`🔗 [razlaganje] ${plan.taskId}: otpremljeno ${n} podzadataka (chain_next)`)
    }
  } catch (e) { log(`⚠️ [razlaganje] pump pao: ${e}`) }
}

// P1 auto-execution (Goran): pending taskovi s priority=1 se automatski pokrecu.
// ─── A5/TASK-3004: kontrolne točke ručnog pregleda ──────────────────────────
// Prolaz je odvojen od auto-exec petlje (15 s) jer traži popis DOVRŠENIH zadataka, a to je
// jedini skup koji nije ionako dohvaćen. Zato se vrti rjeđe: okidač je dovršetak zadatka,
// događaj koji se mjeri u minutama, ne u sekundama.
const CHECKPOINT_SCAN_INTERVAL_MS = 60_000
let lastCheckpointScan = 0
let _checkpointState: CheckpointState | null = null   // zadnje pročitano stanje (za brief pri spawnu)
let _alarmedCorruptState = false

/**
 * Otvori nove točke, pročitaj odluke s ploče, javi čovjeku. Vraća točke koje trenutno
 * zadržavaju rad (prazno kad je mehanizam ugašen).
 *
 * Ne mijenja NIJEDAN status zadatka — to je jezgra odgovora na „gdje se čuva stanje dok se
 * čeka": čekanje živi u `data/review_checkpoints.json`, a zadatak ostaje `pending`. Izmjereno
 * 29.07.: `blocked` je groblje (87 zadataka, 67 bez razloga, medijan 8,3 dana), a `in_progress`
 * love tri čistača i on je broj koji Goran čita kao „koliko sada radi".
 */
async function reviewCheckpointPass(db: Database): Promise<CheckpointRecord[]> {
  if (!isEnabled('reviewCheckpoint')) { _checkpointState = null; return [] }
  const now = Date.now()
  if (now - lastCheckpointScan < CHECKPOINT_SCAN_INTERVAL_MS) {
    return (_checkpointState?.checkpoints || []).filter(c => c.status !== 'approved')
  }
  lastCheckpointScan = now

  try {
    const cfg = loadCheckpointConfig()
    const live = isEnabled('reviewCheckpointLive')
    const read = readCheckpointState()
    let state = read.state

    if (read.corrupt) {
      // Fail-open, ali NIKAD tiho: brana koja zaustavi rad bez traga biva isključena isti dan,
      // a brana koja tiho ne radi ništa je gora od one koje nema.
      if (!_alarmedCorruptState) {
        _alarmedCorruptState = true
        log('❌ [točka] zapis kontrolnih točaka je NEČITLJIV — radim kao da točaka nema (fail-open)')
        queueUserAlarm(db, '❌ REGOČ: zapis kontrolnih točaka (data/review_checkpoints.json) je neispravan. Kontrolne točke TRENUTNO NE ZADRŽAVAJU rad. Provjeri: bun ~/.claude/regoc/tools/checkpoint.ts list')
        appendCheckpointLog({ ts: new Date(now).toISOString(), event: 'error', checkpointId: null, detail: 'nečitljiv zapis stanja', live })
      }
    } else {
      _alarmedCorruptState = false
    }

    const pending = await fetchTasksByStatus('pending')
    const completed = await fetchTasksByStatus('completed')

    // 1) Nove točke — zadatak koji izjavljuje `stop-after` upravo je završio.
    const det = detectTriggers(completed, state, { now, cfg, pending })
    if (det.opened.length > 0) {
      state = { ...state, checkpoints: [...state.checkpoints, ...det.opened] }
      for (const cp of det.opened) {
        log(`⏸️ [točka] otvorena ${cp.id} — okinuo ${cp.taskId}, zadržava ${cp.scopeKind}${cp.scopeValue ? ':' + cp.scopeValue : ''} (${cp.heldIds.length} zadataka)`)
        appendCheckpointLog({
          ts: new Date(now).toISOString(), event: 'opened', checkpointId: cp.id, taskId: cp.taskId,
          live, scopeKind: cp.scopeKind, scopeValue: cp.scopeValue, held: cp.heldIds.length,
        })
      }
    }
    for (const s of det.skipped) log(`   ↳ [točka] ${s.taskId} preskočen: ${s.reason}`)

    // 2) Odluke s ploče. Oznaka na zadatku koji je točku okinuo vrijedi jednako kao alat —
    //    Goran je češće pred pločom nego pred ljuskom, a mehanizam koji traži terminal
    //    u praksi znači „nitko ne odobrava".
    const byTaskId = new Map(completed.map(t => [String(t.id), t]))
    for (const cp of state.checkpoints.filter(c => c.status === 'open')) {
      const src = byTaskId.get(cp.taskId)
      const d = src ? decisionFromTags(src) : null
      if (!d) continue
      const res = applyDecision(state, cp.id, d, 'goran (ploča)', `oznaka na ${cp.taskId}`, now)
      if (res.changed) {
        state = res.state
        log(`${d === 'approved' ? '▶️' : '⛔'} [točka] ${cp.id} — ${d} s ploče (oznaka na ${cp.taskId})`)
        appendCheckpointLog({ ts: new Date(now).toISOString(), event: 'decided', checkpointId: cp.id, taskId: cp.taskId, decision: d, by: 'ploča', live })
      }
    }

    // 3) Obavještavanje. `notifiedAt` se postavlja SAMO kad upis u red stvarno uspije —
    //    inače bi se zapisalo „javljeno", a poruka bi istrunula (userFlushBacklog=false).
    for (let i = 0; i < state.checkpoints.length; i++) {
      const cp = state.checkpoints[i]
      const kind = dueNotification(cp, now, cfg)
      if (!kind) continue
      const text = formatCheckpointAlarm(cp, kind, now)
      const ok = queueUserAlarm(db, live ? text : `👁️ [SHADOW — rad NIJE zaustavljen]\n${text}`)
      if (!ok) { log(`⚠️ [točka] obavijest za ${cp.id} nije ušla u red — pokušavam ponovo u sljedećem prolazu`); continue }
      state.checkpoints[i] = {
        ...cp,
        notifiedAt: cp.notifiedAt || new Date(now).toISOString(),
        lastReminderAt: new Date(now).toISOString(),
        reminders: kind === 'first' ? cp.reminders : cp.reminders + 1,
      }
      log(`📨 [točka] ${kind} obavijest za ${cp.id} poslana u red`)
      appendCheckpointLog({ ts: new Date(now).toISOString(), event: 'notified', checkpointId: cp.id, taskId: cp.taskId, kind, live })
    }

    // 4) Osvježi popis zadržanih (za izvještaj i za brief nastavka) + higijena zapisa.
    const holding = state.checkpoints.filter(c => c.status !== 'approved')
    for (let i = 0; i < state.checkpoints.length; i++) {
      const cp = state.checkpoints[i]
      if (cp.status !== 'open') continue
      const held = classifyHolds(pending, [cp], cfg).filter(h => h.verdict === 'hold').map(h => h.taskId)
      // Popis se PROŠIRUJE, ne zamjenjuje: zadatak koji je čekao pa je u međuvremenu otišao
      // drugim putem i dalje treba dobiti sažetak ako se vrati.
      const merged = [...new Set([...cp.heldIds, ...held])]
      if (merged.length !== cp.heldIds.length) state.checkpoints[i] = { ...cp, heldIds: merged }
    }
    if (state.checkpoints.filter(c => c.status === 'open').length > cfg.maxOpenCheckpoints) {
      log(`⚠️ [točka] otvoreno više od ${cfg.maxOpenCheckpoints} točaka — provjeri lijepi li netko oznaku masovno`)
    }
    state = pruneDecided(state, now)
    writeCheckpointState(state)
    _checkpointState = state
    return holding
  } catch (e) {
    log(`⚠️ [točka] prolaz pao: ${e}`)
    return []   // fail-open: kvar u ovom prolazu ne smije zamrznuti autonomiju
  }
}

/** Dohvat zadataka po statusu s ploče. Prazan popis na grešci — pozivi su fail-open. */
async function fetchTasksByStatus(status: string): Promise<any[]> {
  try {
    const r = await fetch(`${TASK_MANAGER_API}?status=${status}`)
    if (!r.ok) return []
    const j = await r.json() as any
    return Array.isArray(j) ? j : (Array.isArray(j?.tasks) ? j.tasks : [])
  } catch { return [] }
}

/**
 * Sažetak prethodnog rada za zadatak koji kreće nakon odobrene točke. Vraća '' kad nema što
 * predati. Sesija se ne može zamrznuti i odmrznuti — kontekst se prenosi zapisom, ne procesom.
 */
/**
 * TASK-3082: rezultat PRETHODNOG koraka lanca ide agentu U PROMPT, gotov.
 *
 * Izmjereno 30.07. (reprodukcija pada Jelene na `deepseek-v4-flash`): od 20 iteracija
 * **11 je potrošeno na traženje tuđeg rezultata** — model je gađao ploču na adresi GPU stroja (`<ollama-ip>:17781`)
 * (jedini IP koji je vidio u prompt-liniji o infrastrukturi) i putanju `/tasks/<ID>`
 * umjesto `/api/tasks/<ID>`, pa je pao na `find / -name "TASK-078*"` po disku. Do posla
 * nikad nije stigao i vratio je „Dosegnut limit iteracija".
 *
 * Zaključak: nije bila „slabost modela" nego navigacija. Ono što sustav već zna ne smije
 * se tražiti od modela da pogađa. Ovo uklanja i točku kvara i ~55 % iteracija.
 */
/**
 * T2/TASK-3084: AUTOMATSKI NASTAVAK.
 *
 * Kad agentski stroj udari u strop koraka, on od TASK-3082 vraća popis stvarno zapisanih
 * datoteka i `REGOC-STATUS: BLOCKED — djelomično isporučeno, treba nastavak`. Posao je dakle
 * napravljen dijelom, a ne pokvaren — takav zadatak se vraća u red i nastavlja sljedeći krug,
 * umjesto da čeka da ga čovjek ručno vrati u `pending`.
 *
 * Granice (namjerno uske, da se ne vrti u prazno):
 *   • samo na „strop koraka / djelomično isporučeno" — NE na kvar, ne na `no_evidence` bez isporuke;
 *   • najviše AUTO_RESUME_MAX_ROUNDS krugova, brojano oznakom `resume:<n>` na zadatku;
 *   • iza zastavica `autoResume` (promatranje) / `autoResumeLive` (provodi se).
 */
const AUTO_RESUME_MAX_ROUNDS = Number(process.env.REGOC_AUTO_RESUME_ROUNDS || 3)

// M4/TASK-4627: brojač krugova živi u `ShutdownResume.ts` (jedan izvor istine). Ovdje je
// bila druga kopija istog regexa — dva mehanizma dijele oznaku `resume:<n>` i moraju je
// čitati na isti način, inače im se strop razilazi.
const autoResumeRound = resumeRound

/** Prepoznaje ISKLJUČIVO „stao na stropu, ima isporuke" — ne bilo koji neuspjeh. */
function isPartialDelivery(resultText: string): boolean {
  const t = String(resultText || '')
  if (!/strop koraka|Dosegnut strop od/i.test(t)) return false
  return /Zapisane datoteke \(\d+\)|Pokrenute naredbe \(\d+/i.test(t)
}

async function maybeAutoResume(taskId: string, resultText: string): Promise<void> {
  try {
    if (!isEnabled('autoResume')) return
    if (!isPartialDelivery(resultText)) return
    const r = await fetch(`${TASK_MANAGER_API}/${taskId}`)
    if (!r.ok) return
    const task: any = await r.json()
    const round = autoResumeRound(task?.tags)
    const live = isEnabled('autoResumeLive')
    if (round >= AUTO_RESUME_MAX_ROUNDS) {
      log(`  🛑 [nastavak] ${taskId}: iskorišteno ${round}/${AUTO_RESUME_MAX_ROUNDS} krugova — dalje traži čovjeka`)
      return
    }
    log(`${live ? '  ↻ [nastavak]' : '  👁️ [nastavak SHADOW]'} ${taskId}: djelomična isporuka, krug ${round + 1}/${AUTO_RESUME_MAX_ROUNDS}`)
    if (!live) return
    const tags = withResumeTag(task?.tags, round + 1)
    await fetch(`${TASK_MANAGER_API}/${taskId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'pending', tags,
        progressNotes: [`Auto-nastavak (krug ${round + 1}/${AUTO_RESUME_MAX_ROUNDS}): prethodni prolaz je stao na stropu koraka uz djelomičnu isporuku. Zadatak se vraća u red; sljedeći prolaz nastavlja od zatečenog stanja na disku.`],
      })
    })
  } catch (e) { log(`  ⚠️ [nastavak] ${taskId}: ${e}`) }
}

async function parentResultTail(task: any): Promise<string> {
  try {
    // `blockedBy` NE VRIJEDI ovdje: `TaskManagerSQL.updateTask` ga pri auto-unblocku briše
    // (filter na linijama 711/802), pa je u trenutku pokretanja uvijek prazan. Roditelj se
    // zato čita iz oznake `parent:<ID>` koju upisuje `createSequentialHelpers`, uz povratni
    // put preko teksta opisa za lance nastale prije te oznake.
    const tags: string[] = Array.isArray(task?.tags) ? task.tags.map((t: any) => String(t)) : []
    const fromTag = tags.map(t => /^parent:(TASK-[A-Za-z0-9-]+)$/.exec(t)?.[1]).filter(Boolean) as string[]
    const fromDesc = fromTag.length ? [] : (String(task?.description || '').match(/zadatak (TASK-[A-Za-z0-9-]+)/)?.[1] ? [String(task.description).match(/zadatak (TASK-[A-Za-z0-9-]+)/)![1]] : [])
    const blockedRaw = Array.isArray(task?.blockedBy) ? task.blockedBy.map(String) : []
    const blocked = [...fromTag, ...fromDesc, ...blockedRaw].filter((v, i, a) => a.indexOf(v) === i)
    if (!blocked.length) return ''
    const parts: string[] = []
    for (const pid of blocked.slice(0, 2)) {
      const r = await fetch(`${TASK_MANAGER_API}/${pid}`)
      if (!r.ok) continue
      const p: any = await r.json()
      const summary = String(p?.resultSummary || p?.result_summary || '').trim()
      if (!summary) continue
      parts.push(`### ${pid} — ${p?.assignee || '?'} (${p?.title || ''})\n${summary.slice(0, 6000)}`)
    }
    if (!parts.length) return ''
    log(`  📎 [lanac] ${task?.id}: rezultat prethodnog koraka ubačen u prompt (${parts.length})`)
    return `\n\n## REZULTAT PRETHODNOG KORAKA (već dohvaćeno — NE traži ga sam, ne zovi TaskManager za ovo)\n${parts.join('\n\n')}\n`
  } catch (e) {
    log(`  ⚠️ [lanac] dohvat rezultata roditelja pao: ${e}`)
    return ''
  }
}

function resumeBriefTail(taskId: string): string {
  if (!isEnabled('reviewCheckpoint') || !_checkpointState) return ''
  try {
    const cp = briefForResume(taskId, _checkpointState)
    if (!cp) return ''
    _checkpointState = markBriefDelivered(_checkpointState, cp.id, taskId)
    writeCheckpointState(_checkpointState)
    appendCheckpointLog({
      ts: new Date().toISOString(), event: 'brief-delivered', checkpointId: cp.id, taskId,
      live: isEnabled('reviewCheckpointLive'),
    })
    log(`📎 [točka] ${taskId} nastavlja s kontekstom iz ${cp.id}`)
    return `\n\n${formatResumeBrief(cp)}\n`
  } catch { return '' }
}

/**
 * W4/TASK-4617: nalaz vratara iz PRETHODNOG kruga → u prompt ovog prolaza.
 *
 * Ovo je mjesto na kojem evaluator–optimizer prestaje biti zamisao. Bez njega petlja
 * samo vrati zadatak u red, a izvođač dobije BAJT-IDENTIČAN prompt kao prvi put i padne
 * na istoj provjeri — skupa vrtnja koja ništa ne uči. `progress_notes` tu ne pomažu:
 * `readTaskContext` čita samo `tags`, `project_id` i `description`, pa nalaz zapisan u
 * bilješke nema adresata (izmjereno, v. zaglavlje CriticRepairLoop.ts).
 *
 * Oznake se čitaju IZ BAZE u trenutku spawna (ne iz zapisa u redu čekanja) jer je oznaku
 * `kritika:<n>` upisala petlja NAKON što je zadatak ušao u red. Ustajalost hvata
 * `repairPromptTail`: nalaz se ubacuje samo kad se njegov krug poklapa s oznakom.
 */
/**
 * W5/TASK-4618: dopuna shemi izlaza za korake koji STVARAJU NALAZE (sigurnosna revizija,
 * evaluacija prijave, dijagnoza kvara) i teži su od praga. Ostatak prometa ne vidi ni redak —
 * blok je uz `off` prazan, a uz `shadow`/`on` ga dobiva samo kvalificirani korak.
 *
 * Bez ovog bloka nalazi postoje samo u prozi, pa provjeravatelj sudi o rečenici bez dokaza i
 * `dokaz` leća obori sve (izmjereno 05.09.2026. na 37 proznih nalaza). Zato W5 ovisi o W3.
 */
function adversarialVerifyTail(taskId: string | null, content: string): string {
  try {
    const { tags } = readTaskContext(taskId)
    const p = ocijeniPrihvatljivost({ taskId, naslov: content.slice(0, 400), opis: content, oznake: tags })
    return blokNalazaZaKorak(p)
  } catch { return '' }   // vrata nikad ne smiju srušiti sastavljanje prompta
}

/**
 * Odvojen proces provjere (`tools/adversarial-provjeri.ts`). Namjerno se NE čeka i namjerno
 * NE dira zadatak: alat samo zapisuje sud u `data/adversarial_verify.jsonl`. Tako se W5 mjeri
 * na živom prometu bez ijedne milisekunde na putu zatvaranja zadatka.
 */
function pokreniAdversarijalnuProvjeru(taskId: string): void {
  try {
    const cfg = loadAdversarialConfig()
    if (!blokUPromptu(cfg)) return   // `off` → ni procesa
    const proc = Bun.spawn(['bun', join(HOME, '.claude/regoc/tools/adversarial-provjeri.ts'), taskId, '--json'], {
      cwd: HOME, stdout: 'ignore', stderr: 'ignore', stdin: 'ignore',
    })
    proc.unref()
    log(`adversarial-verify: pokrenuta provjera nalaza za ${taskId} (način ${cfg.nacin}, pid ${proc.pid})`)
  } catch (e: any) {
    log(`adversarial-verify: provjera za ${taskId} nije pokrenuta — ${e?.message || e}`)
  }
}

function criticRepairTail(taskId: string | null): string {
  if (!taskId || !isEnabled('criticRepairLoop', false)) return ''
  try {
    const { tags } = readTaskContext(String(taskId))
    const tail = repairPromptTail(String(taskId), tags, loadCriticConfig().maxRounds)
    if (tail) log(`↩︎ [vratar→popravak] ${taskId}: nalaz iz prethodnog kruga ide u prompt`)
    return tail
  } catch { return '' }   // prompt se mora sastaviti i kad nalaz nije čitljiv
}

// ============================================
// Voditelj lanca (ADR-0024 V2, TASK-5677)
// ============================================
// Tick 60 s: za svaki zadatak s `voditelj-lanca` + `lanac:<x>` (pending/in_progress) deterministički
// predprolaz (VoditeljLanca.predprolaz); model se budi kroz spawnAgentOnDemand u traci voditeljSpawns
// (izvan stropa), pod ključem trajne sesije kosjenka@voditelj__<TASK>. Plan modela daemon provjerava
// (provjeriPlan) i izvodi kroz rute ploče. Prekidač features.json `voditeljLanca` off/shadow/on.

let lastVoditeljTick = 0
let zadnjiNacinVoditelja: NacinVoditelja | null = null

function voditeljNacin(): NacinVoditelja {
  try { return citajNacinVoditelja(getFlag('voditeljLanca') as any) } catch { return 'off' }
}

/** Prekid budnog voditelja (pauza, gašenje): samo proces — zadatak ostaje in_progress (kraj buđenja = nastavak). */
function prekiniVoditelje(razlog: string, by: string, samoTaskId?: string): void {
  for (const info of voditeljSpawns.values()) {
    if (info.killedBy || !info.pid || (samoTaskId && info.taskId !== samoTaskId)) continue
    info.killedBy = { reason: razlog, by, at: Date.now() }
    try { process.kill(info.pid, 'SIGTERM'); log(`🛑 [voditelj] ${info.taskId}: buđenje prekinuto (${razlog})`) } catch {}
  }
}

function redakUClana(r: any): ClanLanca & { paused?: boolean } {
  return {
    id: String(r.id), title: r.title ?? undefined, status: String(r.status), assignee: r.assignee ?? null,
    tags: oznakeIz(r.tags), blockedBy: oznakeIz(r.blocked_by), blocks: oznakeIz(r.blocks),
    blockedReason: r.blocked_reason ?? null, description: r.description ?? null, projectId: r.project_id ?? null,
    paused: !!r.paused,
  }
}

const STUPCI_CLANA = 'id, title, status, assignee, tags, blocked_by, blocks, blocked_reason, description, project_id, paused'

function citajVoditelje(): (ZadatakVoditelja & { paused: boolean })[] {
  const db = new Database(TASKS_DB_PATH, { readonly: true })
  try {
    const redovi = db.query(`SELECT ${STUPCI_CLANA} FROM tasks WHERE status IN ('pending','in_progress') AND tags LIKE '%${OZNAKA_VODITELJA}%'`).all() as any[]
    return redovi.map(redakUClana).filter(c => jeVoditelj(c.tags))
      .map(c => ({ id: c.id, status: c.status, tags: c.tags || [], projectId: c.projectId ?? null, description: c.description, paused: !!c.paused }))
  } finally { db.close() }
}

function citajClanoveLanca(lanac: string): ClanLanca[] {
  const db = new Database(TASKS_DB_PATH, { readonly: true })
  try {
    const redovi = db.query(`SELECT ${STUPCI_CLANA} FROM tasks WHERE tags LIKE ?`).all(`%${lanac}%`) as any[]
    return clanoviLanca(redovi.map(redakUClana), lanac)
  } finally { db.close() }
}

function statusIzBaze(taskId: string): string | undefined {
  const db = new Database(TASKS_DB_PATH, { readonly: true })
  try { return (db.query('SELECT status FROM tasks WHERE id = ?').get(taskId) as any)?.status } finally { db.close() }
}

/** Zadnje 3 bilješke i rezultat — izvještaj kritičara za reviziju (O4a). */
function izvjestajKriticaraIzBaze(taskId: string): string {
  const db = new Database(TASKS_DB_PATH, { readonly: true })
  try {
    const r = db.query('SELECT progress_notes, result_summary FROM tasks WHERE id = ?').get(taskId) as any
    if (!r) return ''
    let notes: any[] = []
    try { notes = JSON.parse(String(r.progress_notes || '[]')) } catch {}
    const zadnje = (Array.isArray(notes) ? notes : []).slice(-3)
      .map(n => typeof n === 'string' ? n : `[${n?.agent || '?'} ${n?.timestamp || ''}] ${n?.note || n?.text || JSON.stringify(n)}`)
    return [...zadnje, r.result_summary ? `REZULTAT: ${String(r.result_summary).slice(0, 1500)}` : ''].filter(Boolean).join('\n').slice(0, 4000)
  } catch { return '' } finally { db.close() }
}

function stabloLanca(projectId: string | null): string {
  try { return resolveProjectWorkDir(loadWorktreeConfig(), projectId, HOME) } catch { return HOME }
}

async function apiVoditelja(z: ZahtjevVoditelja): Promise<Odgovor> {
  const url = `${TASK_MANAGER_API.replace(/\/api\/tasks\/?$/, '')}${z.put}`
  const r = await fetch(url, {
    method: z.metoda, signal: AbortSignal.timeout(15_000),
    headers: { 'Content-Type': 'application/json', ...zaglavljaZatvaraca() },
    // Novi zadatak (popravak, spajanje) nosi strojni izvor — inače pada u `user` i troši čovjekov strop (ADR-0007).
    body: JSON.stringify(z.metoda === 'POST' && z.put === '/api/tasks' ? withCreatedBy(z.tijelo, TASK_SOURCE.CHAIN) : z.tijelo),
  })
  const txt = await r.text()
  let tijelo: any = txt
  try { tijelo = JSON.parse(txt) } catch {}
  return { ok: r.ok, status: r.status, tijelo }
}

/** Naredba s rokom, asinkrono (spajanje i testovi ne smiju zaustaviti petlju daemona). */
async function pokreniAsinkrono(cmd: string[], cwd: string, rokMs: number): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' })
  const t = setTimeout(() => { try { p.kill() } catch {} }, rokMs)
  const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  const code = await p.exited
  clearTimeout(t)
  return { code, out: `${o}\n${e}`.trim().slice(-2000) }
}

/** D1-A (Goran 21.10.): merge i testovi u privremenom worktreeju, main samo --ff-only; neuspjeh → proba se uklanja. */
async function spojiGranuVoditelja(voditeljId: string, stablo: string, grana: string): Promise<{ ok: boolean; razlog: string }> {
  const proba = join(HOME, 'app', 'tmp', 'voditelji', voditeljId, `proba-${grana.replace(/[^A-Za-z0-9_.-]/g, '-')}`)
  for (const k of koraciSpajanja(grana, proba)) {
    const r = await pokreniAsinkrono(k.naredba, k.gdje === 'proba' ? proba : stablo, k.naredba[0] === 'git' ? 60_000 : 15 * 60_000)
    if (r.code !== 0) {
      for (const n of odustaniOdSpajanja(grana, proba)) await pokreniAsinkrono(n, stablo, 60_000).catch(() => null)
      return { ok: false, razlog: `${k.opis}: exit ${r.code} ${r.out.slice(-300)}` }
    }
  }
  return { ok: true, razlog: 'spojeno --ff-only' }
}

function popisAdrova(stablo: string, projectId: string | null): string[] {
  const out: string[] = []
  const mape = [join(stablo, 'docs'), join(HOME, 'app', 'regoc_system', 'docs')]
  for (const m of mape) {
    try {
      for (const f of readdirSync(m)) {
        if (!/^ADR-.*\.md$/.test(f)) continue
        const put = join(m, f)
        if (m.startsWith(stablo) || (projectId && readFileSync(put, 'utf-8').includes(projectId))) out.push(put)
      }
    } catch {}
  }
  return out.slice(0, 40)
}

function predajaVoditelja(u: { voditelj: ZadatakVoditelja; lanac: string; stablo: string; clanovi: ClanLanca[]; grane: GranaInfo[] }): string {
  let planLanca: { put: string; tekst: string } | null = null
  try {
    const put = planIzOpisa(u.voditelj.description)
    if (put) planLanca = { put, tekst: readFileSync(put, 'utf-8').slice(0, 6000) }
  } catch {}
  return gradiPredajuVoditelja({
    voditeljId: u.voditelj.id, lanac: u.lanac, projectId: u.voditelj.projectId || '', planLanca,
    adrovi: popisAdrova(u.stablo, u.voditelj.projectId), tablica: tablicaLanca(u.clanovi, u.grane), grane: u.grane,
    dnevnik: repDnevnika(putDnevnikaVoditelja(u.voditelj.id), 20),
  })
}

// V3 (TASK-5678): trag voditelja — poruka u grupu lanca kroz kanonski tg_send.py (ADR-0015), bilješka na voditelju.
const TG_SEND_VODITELJA = join(HOME, '.claude', 'regoc', 'tools', 'telegram', 'tg_send.py')
async function posaljiVoditeljTg(chatId: number, tekst: string): Promise<boolean> {
  try {
    const p = Bun.spawn(['python3', TG_SEND_VODITELJA, 'tekst', `--chat=${chatId}`], { stdin: new TextEncoder().encode(tekst), stdout: 'pipe', stderr: 'pipe' })
    const t = setTimeout(() => { try { p.kill() } catch {} }, 30_000)
    const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
    const code = await p.exited
    clearTimeout(t)
    if (code !== 0 || !o.startsWith('ok')) log(`⚠️ [voditelj] tg_send exit ${code}: ${(e || o).trim().slice(0, 200)}`)
    return code === 0 && o.startsWith('ok')
  } catch (err) { log(`⚠️ [voditelj] tg_send nije pokrenut: ${err}`); return false }
}
const tragVoditelja = {
  posalji: posaljiVoditeljTg,
  biljeska: async (tid: string, tekst: string) => { await apiVoditelja({ metoda: 'PUT', put: `/api/tasks/${encodeURIComponent(tid)}`, tijelo: { progressNotes: [tekst] } }).catch(() => null) },
}

async function budiVoditelja(u: BudjenjeUlaz): Promise<{ started: boolean; reason?: string }> {
  const id = u.voditelj.id
  const fallback = (agentRegistry?.agents?.[AGENT_VODITELJA]?.model) || 'opus'
  const target = await resolveTaskSpawnTarget(AGENT_VODITELJA, { id, description: u.voditelj.description, tags: u.voditelj.tags }, fallback)
  const cwd = existsSync(u.stablo) ? u.stablo : HOME
  // O1: vlastiti ključ — obični pokazivači Kosjenke se ne čitaju ni zaključavaju.
  const kljuc = kljucSesijeVoditelja(id)
  const put = odlukaSesijeVoditelja({ taskId: id, stablo: cwd, model: target.model, provider: target.provider,
    pokazivac: citajPokazivac(trajneSesijeDir(), kljuc), bravaZiva, now: Date.now(), postavke: citajPostavke() })
  if (put.put === 'cekaj') return { started: false, reason: `sesija voditelja: ${put.razlog}` }
  const trajni: TrajniSpawn | null = put.put === 'resume' || put.put === 'nova'
    ? { put, kljuc, stablo: cwd, model: target.model, predaja: u.predaja }
    : null
  const lanac = u.lanac
  const start = spawnAgentOnDemand(AGENT_VODITELJA, u.prompt, target, id, 'regoc', undefined, trajni, {
    rokMs: u.rokMs, maxTurns: u.maxTurns, maxIstodobno: u.maxIstodobno, cwd,
    naKraju: async r => (await zavrsiBudjenje({ id, projectId: u.voditelj.projectId, tags: u.voditelj.tags }, lanac, r.resultText, {
      trag: tragVoditelja, nacin: voditeljNacin,
      clanovi: citajClanoveLanca, grane: (st, ids) => existsSync(st) ? graneLanca(st, ids) : [], zivNajam: t => najamAktivan(t),
      postavke: () => citajPostavkeVoditelja(), now: () => Date.now(), log, zahtjev: apiVoditelja,
      spoji: async rr => spojiGranuVoditelja(id, u.stablo, rr.grana),
      biljeska: async (tid, tekst) => { await apiVoditelja({ metoda: 'PUT', put: `/api/tasks/${encodeURIComponent(tid)}`, tijelo: { progressNotes: [tekst] } }).catch(() => null) },
    })).ishod,
    naTrosak: usd => zabiljeziTrosakVoditelja(id, usd, Date.now()),
  })
  if (start.started && trajni) {
    const p = trajni.put
    log(`🧷 [voditelj] ${id}: sesija ${kljuc} — ${p.put === 'resume' ? `resume gen ${p.gen}` : p.put === 'nova' ? `NOVA gen ${p.gen} (${p.razlog})` : p.put}`)
  }
  return start.started ? { started: true } : { started: false, reason: 'reason' in start ? String(start.reason) : undefined }
}

async function voditeljiProlaz(): Promise<void> {
  try {
    const nacin = voditeljNacin()
    if (nacin !== zadnjiNacinVoditelja) { log(`🧭 [voditelj] voditeljLanca=${nacin}`); zadnjiNacinVoditelja = nacin }
    if (nacin === 'off') return
    const voditelji = citajVoditelje()
    if (!voditelji.length) return
    const pauza = readPauseState().paused
    let vrata = true
    try {
      const { autonomyTierFromUsage } = await import('./WorkStateJournal')
      vrata = autonomyTierFromUsage(readSessionUsage()).autonomousQueue
    } catch (e) { vrata = false; log(`⚠️ [voditelj] vrata autonomije nečitljiva (${e}) — ne budim model`) }
    const paused = new Map(voditelji.map(v => [v.id, v.paused]))
    await prolazVoditelja({
      nacin: () => nacin, postavke: () => citajPostavkeVoditelja(), voditelji: () => voditelji,
      clanovi: citajClanoveLanca, stabloProjekta: stabloLanca,
      grane: (st, ids) => existsSync(st) ? graneLanca(st, ids) : [],
      zivNajam: t => najamAktivan(t), statusZadatka: statusIzBaze, izvjestajKriticara: izvjestajKriticaraIzBaze,
      kocnica: v => pauza || !!paused.get(v.id), vrataPustaju: () => vrata, aktivnihVoditelja: () => voditeljSpawns.size,
      pokreni: async v => {
        const r = await apiVoditelja({ metoda: 'PUT', put: `/api/tasks/${encodeURIComponent(v.id)}`, tijelo: { status: 'in_progress', progressNotes: ['🧭 Voditelj lanca pokrenut (ADR-0024): in_progress dok lanac nije gotov; model se budi samo kad ima posla, izvan stropa.'] } }).catch(e => ({ ok: false, status: 0, tijelo: String(e) }))
        if (!r.ok) log(`⚠️ [voditelj] ${v.id}: pending → in_progress HTTP ${r.status}`)
        return r.ok
      },
      budi: budiVoditelja, predaja: predajaVoditelja,
      alarm: (v, tekst) => {
        log(`🚨 ${tekst}`)
        apiVoditelja({ metoda: 'PUT', put: `/api/tasks/${encodeURIComponent(v.id)}`, tijelo: { progressNotes: [tekst] } }).catch(() => null)
      },
      log, now: () => Date.now(), trag: tragVoditelja,
    })
  } catch (e) {
    log(`⚠️ [voditelj] prolaz pao: ${e}`)
  }
}

async function processP1Tasks(db: Database): Promise<void> {
  try {
    // Skup taskova koje aktivno izvrsavamo (da ne diramo/dupliciramo)
    const tracked = new Set<string>()
    for (const info of activeAgentSpawns.values()) if (info.taskId) tracked.add(info.taskId)
    for (const info of voditeljSpawns.values()) if (info.taskId) tracked.add(info.taskId)

    // 0) RUČNA KOČNICA (TASK-3047) — prije svega ostalog. Pauzirani zadatak koji upravo
    //    radi mora stati ODMAH, a ne tek kad sam završi; zato prekid ide prije reda čekanja.
    // TASK-5029: popis se gradi iz ŽIVIH spawnova, ne iz statusa. Stari upit
    // (samo zadaci u statusu in_progress) nije vidio pauziran zadatak u `blocked`, pa je TASK-4999 radio
    // dalje (pid 664983, 24.09. 18:37) dok ga REGOČ nije ručno ubio.
    let pausedIds = new Set<string>()
    if (tracked.size > 0) {
      try {
        const ids = [...tracked]
        const tdb = new Database(TASKS_DB_PATH, { readonly: true })
        let rows: any[] = []
        try { rows = tdb.query(`SELECT id, paused, status FROM tasks WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as any[] } finally { tdb.close() }
        pausedIds = pausedTrackedIds(rows, tracked)
      } catch { /* fail-open: bez popisa se ne prekida ništa */ }
    }
    if (enforcePauses(pausedIds)) return

    // 1) RECOVERY zombie in_progress: task in_progress bez aktivnog spawna (npr. spawn umro
    //    na restartu). TASK-3019: pod flagom i u DRY-RUNU — pravilo živi u `ZombieRecovery.ts`.
    // TASK-5140: siroče-oporavak prije zombija — zadatke koje preuzme zombie ne dira.
    // TASK-5674: čuvar briše „mrtav spawn" čim proces izađe, a presuda (kritičar) još traje —
    // takav zadatak je živ za siroče i zombie, inače PASS padne s 409 na `pending`.
    const zivi = saZatvaranjem(tracked, zatvaranjeSpawna)
    const prepusteni = await oporaviSirocad(db, zivi)
    await recoverZombieTasks(db, zivi, prepusteni)
    // TASK-5259: blocked zadaci koji čekaju vlastiti pozadinski posao (REGOC-POZADINA).
    await vratiPozadinske(db)
    // 2) Pokreni SVE pending taskove s agentom (P1 prvo) — nista ne smije visiti u pending
    const resp = await fetch(`${TASK_MANAGER_API}?status=pending`)
    if (!resp.ok) return
    const raw = await resp.json() as any
    // TASK-2701: sadržajni guard PRIJE spawna. Do sada se filtriralo samo po assigneeju,
    // pa je svaki pending task s agentom dobio punu Opus sesiju — uključujući test-fixture
    // ('Full Task' / 'Detailed description', 'Task 1', prazan description) koje `bun test`
    // upisuje u živu bazu (incident 2026-07-27 22:42: ~70 fixtura po test-runu).
    // Fixture se odmah gasi u cancelled da ne kruži pending → zombie-recovery → pending.
    // A7/TASK-3006 (DIO 3): red čekanja je od sada imenovan pojam, a ne „ono što ostane
    // nakon filtra". Tko smije, tko čeka čovjeka, tko je fixture i kojim redom — sve živi u
    // `AutonomyQueue.ts` (čiste funkcije, pokrivene testovima). Ponašanje filtra je isto kao
    // prije, uz dvije razlike: poredak sada uzima i STAROST (ne samo prioritet), a zadatci s
    // ljudskim oznakama (`waiting-for-human`/`needs-decision`/`no-autonomy`) ispadaju iz reda.
    // TASK-3047: pauziran zadatak se preskače, ali NE mijenja status — ostaje pending i
    // vraća se u red čim ga se odpauzira. (Zato pauza, a ne `cancelled`: cancelled je
    // terminalno i zadatak se iz njega ne vraća ni s force — vidi memoriju o assignee auto-spawnu.)
    const { classifyAutonomyQueue, clearWaitingQueue, describeSkippedQueue } = await import('./AutonomyQueue')
    const rawTasks: any[] = Array.isArray(raw) ? raw : []
    const byId = new Map<string, any>(rawTasks.map((t: any) => [String(t.id), t]))
    const queue = classifyAutonomyQueue(rawTasks, { trackedIds: tracked, now: Date.now() })
    // Fixture se odmah gasi u cancelled da ne kruži pending → zombie-recovery → pending.
    for (const f of queue.fixture) {
      log(`🚫 Auto-exec preskočen (prazan/fixture task): ${f.id} "${f.title}" → cancelled`)
      try {
        await fetch(`${TASK_MANAGER_API}/${f.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status: 'cancelled',
            progressNotes: ['Auto: task bez izvršivog sadržaja (prazan/placeholder description ili test-fixture naslov) — nije spawnan agent. Ako je zadatak stvaran, dopiši description (ŠTO/ZAŠTO/KOJI fajlovi/KRITERIJ) i vrati u pending.'],
          }),
        })
      } catch (e) { log(`   ⚠️ cancel ${f.id} pao: ${e}`) }
    }
    // Poredak (prioritet → starost → id) dolazi iz `orderQueue`; drugo sortiranje ovdje bi
    // bio drugi izvor istine za istu odluku.
    let tasks: any[] = queue.eligible.map(e => byId.get(e.id)).filter(Boolean)
    // ADR-0024 (TASK-5677): voditelja lanca budi SAMO njegov tick (izvan stropa) — nikad auto-exec kao običan zadatak.
    tasks = tasks.filter(t => !jeVoditelj(t.tags))

    // Red pun preskočenih zadataka izgledao je do 04.09.2026. IDENTIČNO kao prazan red: nula
    // zapisa. Devet zadataka stajalo je 1,5 h s oznakom `needs-decision`, a u dnevniku o tome
    // nije bilo ni retka — pa je Goran morao pitati zašto posao ne kreće. Sada se to kaže,
    // ali samo kad se stanje PROMIJENI (inače bi bio redak svakih 15 s).
    // Pravilo (koga se javlja, kojim redom, kada se šuti) živi u `describeSkippedQueue` u
    // AutonomyQueue.ts — čista funkcija, pokrivena testom `autonomy-queue-skipped-log.test.ts`.
    // Ovdje ostaje samo pamćenje otiska između prolaza petlje.
    if (tasks.length === 0) {
      const notice = describeSkippedQueue(queue.skipped as any, _zadnjiOtisakPreskocenih)
      _zadnjiOtisakPreskocenih = notice.fingerprint
      for (const redak of notice.lines) log(redak)
    } else {
      _zadnjiOtisakPreskocenih = ''
    }

    // ─── A5/TASK-3004: kontrolne točke ručnog pregleda ──────────────────────
    // Vrata autonomije (dolje) pitaju „ima li kvote"; ovo pita „smijem li uopće dalje bez
    // Gorana". Provjerava se PRIJE njih i prije `resolveTaskSpawnTarget` jer zadržan zadatak
    // ne smije platiti procjenu koju neće iskoristiti — isti razlog kao kod A3 vrata opsega.
    // Status se NE mijenja: zadatak ostaje `pending` i vraća se u red čim Goran odobri.
    const holdingCheckpoints = await reviewCheckpointPass(db)
    if (holdingCheckpoints.length > 0 && tasks.length > 0) {
      const cpCfg = loadCheckpointConfig()
      const cpLive = isEnabled('reviewCheckpointLive')
      const decisions = classifyHolds(tasks, holdingCheckpoints, cpCfg)
      const summary = formatHoldSummary(decisions, cpLive)
      if (summary) log(summary)
      for (const d of decisions.filter(x => x.verdict === 'hold')) {
        appendCheckpointLog({
          ts: new Date().toISOString(), event: 'held', checkpointId: d.checkpointId,
          taskId: d.taskId, live: cpLive, detail: d.reason,
        })
      }
      if (cpLive) {
        const held = new Set(decisions.filter(d => d.verdict === 'hold').map(d => d.taskId))
        tasks = tasks.filter(t => !held.has(String(t.id)))
      }
    }

    // ─── Vrata autonomije (Goranova odluka 2026-07-28, popravak TASK-3046) ────
    // Auto-exec je JEDINO mjesto gdje sustav sam sebi dodjeljuje posao, pa je i
    // jedino mjesto gdje prag od 70 % ima smisla. Posao koji je Goran naručio ide
    // drugim putem i ovdje se ne dira — inače bi prag utišao i njegove naloge.
    //
    // Prije: `readSessionPercent()` je na prestarom kešu vraćao null → `autonomyTier(null)`
    // → fail-open → rafal spawnova. Sada odluku donosi `autonomyTierFromUsage()` nad
    // CIJELOM snimkom (uključujući staru), a daemon mjerilo drži svježim sam
    // (`refreshSessionUsage`), pa je slijepa točka iznimka umjesto pravila.
    //
    // Zastavica `autonomyGate` (features.json): false = SHADOW (samo logira što bi
    // zaustavio), true = LIVE.
    const live = isEnabled('autonomyGate', false)
    let usage = readSessionUsage()
    if (tasks.length > 0 && (!usage || usage.stale)) {
      // Slijepi smo baš kad odlučujemo → izmjeri ODMAH i odluči na svježem broju.
      await refreshSessionUsage(true)
      usage = readSessionUsage()
    }
    const { autonomyTierFromUsage } = await import('./WorkStateJournal')
    let tier = autonomyTierFromUsage(usage)

    // ─── Okidač na obnovu kvote + red čekanja (A7/TASK-3006) ─────────────────
    // Vrata su zatvorena i posao stoji → od sada se to bilježi kao ČEKANJE S TERMINOM
    // (`data/autonomy_queue.json`), a u trenutku `session_reset_at + 10 min` okidač prisili
    // svježe mjerenje da se vrata otvore odmah, a ne tek kad na red dođe redovni probe.
    // Kad vrata propuštaju, red se prazni i brojač pokušaja briše.
    if (tasks.length > 0 && !tier.autonomousQueue) {
      tier = await quotaWakeupPass(db, { tasks, queue, usage, tier })
      usage = readSessionUsage()
    } else {
      // Vrata su otvorena ILI je red ostao prazan — u oba slučaja više se ni na što ne čeka.
      // (Prazan red se briše izrijekom: zapis koji tvrdi da posao čeka, a posla nema, laže
      // isto kao „Last completed task" redak koji je 2 h 36 min tvrdio da je sve u redu.)
      const waitedMs = clearWaitingQueue(Date.now())
      if (waitedMs !== null) {
        const mins = Math.round(waitedMs / 60000)
        log(tier.autonomousQueue
          ? `▶️ [red] rad se nastavlja — čekalo se ${mins} min`
          : `🧹 [red] nema više posla koji čeka (stajalo ${mins} min)`)
        try {
          const QW = await import('./QuotaWakeup')
          QW.writeWakeupState(QW.clearAttempts(QW.readWakeupState()))
        } catch { /* stanje okidača nije razlog za pad petlje */ }
      }
    }

    // Zadatak koji je Goran IZRIJEKOM pustio (gumb „Nastavi" na ploči → oznaka `nalog`) nije
    // autonomni rad nego nalog, pa prolazi ista vrata kao poruka s Telegrama: odlučuje
    // `spawnOnRequest`, ne `autonomousQueue`. Bez ove razlike odluka se uredno zapiše, zadatak
    // se kvalificira — i onda stoji, jer autonomija čeka obnovu kvote (izmjereno 04.09.2026.:
    // dvije odluke u 21:29 i 21:30 nisu krenule na 82 % sjednice). Tjedni strop i ručna
    // kočnica se time NE zaobilaze: oni gase i `spawnOnRequest`.
    // TASK-5029: `ceka-mjesto` je zahtjev koji je već prošao vrata (poruka/nalog), a odbio ga je
    // samo strop mjesta — ne smije ga sada zaustaviti autonomija kao da je autonomni posao.
    const nalozi = tasks.filter(t => (t.tags || []).some((g: string) => ['nalog', CEKA_MJESTO_TAG].includes(String(g).toLowerCase())))
    // TASK-5305 (uputa #189): vrata mjere ANTHROPIC sesiju, pa koče SAMO zadatke čiji izvršitelj
    // ide preko Anthropica (`agentOverrides` → provider, isto kao spawn). Zadatak na OpenRouteru,
    // Ollami, kimi/glm… prolazi i kad je sesija potrošena — inače „sve stoji" iako put postoji.
    const poProvideru = razdvojiPoProvideru(tasks, t => providerZadatka(t))
    const vanAnthropica = new Set<any>(poProvideru.ostali)
    const pustiVanAnthropica = (razlog: string): boolean => {
      if (!poProvideru.ostali.length) return false
      const provideri = [...new Set(poProvideru.ostali.map(t => providerZadatka(t)))].join(', ')
      log(`▶️ [vrata po provideru] ${poProvideru.ostali.length} zadatak(a) ide preko ne-Anthropic izvršitelja (${provideri}) — Anthropic kvota ih ne koči („${razlog}")`)
      tasks = poProvideru.ostali
      return true
    }
    if (nalozi.length > 0 && tier.spawnOnRequest && !tier.autonomousQueue) {
      log(`▶️ [nalog] ${nalozi.length} zadatak(a) pušten ručno — prolaze unatoč „${tier.reason}"`)
      tasks = [...nalozi, ...poProvideru.ostali.filter(t => !nalozi.includes(t))]
    } else if (tasks.length > 0) {
      if (!tier.autonomousQueue) {
        if (poProvideru.anthropic.length) log(`${live ? '⛔' : '👁️'} [autonomy${live ? '' : ' SHADOW'}] ${tier.reason} — ${poProvideru.anthropic.length} zadataka čeka obnovu kvote`)
        if (live && !pustiVanAnthropica(tier.reason)) return
      } else if (!tier.multiAgent && activeAgentSpawns.size >= 1) {
        // 85–95 %: jedan po jedan, bez multiagenata.
        log(`${live ? '⛔' : '👁️'} [autonomy${live ? '' : ' SHADOW'}] ${tier.reason} — već radi ${activeAgentSpawns.size} spawn(ova), ne dodajem`)
        if (live && !pustiVanAnthropica(tier.reason)) return
      }
    }

    let spawnedThisPass = 0
    for (const task of tasks) {
      if (!spawnSlotAvailable(activeAgentSpawns.size, maxAgentConcurrent())) {
        // Bez ovog zapisa je dosegnut strop nevidljiv: provjera mjesta stoji PRIJE
        // serijalizacije po stablu, pa pri stropu 1 nestane i redak o stablu — red utihne
        // bez razloga. Prigušeno, jer se ovaj prolaz vrti svakih ~15 s.
        const notice = spawnLimitNotice({
          activeCount: activeAgentSpawns.size,
          max: maxAgentConcurrent(),
          pendingCount: tasks.length - spawnedThisPass,
          nowMs: Date.now(),
          lastLoggedMs: lastSpawnLimitLogMs,
        })
        if (notice.shouldLog) { lastSpawnLimitLogMs = Date.now(); log(notice.message) }
        break
      }
      // TASK-3046: vrata se PONOVNO provjeravaju prije SVAKOG spawna, ne jednom po prolazu.
      // Stara provjera „jednom pa petlja" je značila da svako otvaranje vrata pusti puni
      // MAX_AGENT_CONCURRENT rafal — a upravo su rafali od 3 Opusa progutali sesiju.
      // TASK-5305: ponovna provjera Anthropic sesije samo za zadatak koji je troši.
      if (spawnedThisPass > 0 && !vanAnthropica.has(task)) {
        if (!tier.multiAgent) {
          log(`${live ? '⛔' : '👁️'} [autonomy${live ? '' : ' SHADOW'}] ${tier.reason} — stao nakon 1 spawna u ovom prolazu`)
          if (live) break
        }
        // Svaki daljnji spawn u istom prolazu traži svježe očitanje: jedan Opus zadatak
        // zna pojesti 4–15 pp sesije, pa broj otprije 15 s više ne opisuje stvarnost.
        await refreshSessionUsage(true)
        tier = autonomyTierFromUsage(readSessionUsage())
        if (!tier.autonomousQueue) {
          log(`${live ? '⛔' : '👁️'} [autonomy${live ? '' : ' SHADOW'}] ${tier.reason} — prekidam prolaz nakon ${spawnedThisPass} spawn(ova)`)
          if (live) break
        }
      }
      const agentId = String(task.assignee)
      // A3/TASK-3002: vrata disjunktnog opsega. Provjeravaju se PRIJE `resolveTaskSpawnTarget`
      // jer taj put zna koštati poziva modelu — odgođen zadatak ne smije platiti procjenu
      // koju ionako neće iskoristiti. Odgoda ne mijenja status: zadatak ostaje `pending` i
      // vraća se u red za 15 s, čim vlasnik opsega završi.
      if (!scopeGateAllows(task, agentId)) continue
      const fallback = (agentRegistry?.agents?.[agentId]?.model) || 'sonnet'
      // A6/TASK-3005: auto-exec je put kojim sustav sam sebi dodjeljuje posao i mjereno
      // najveći potrošač (26 Opus runova = 106,88 USD, 29.07.), pa tier po težini posla
      // ovdje ima najviše smisla — isti razlog zbog kojeg su ovdje i vrata autonomije.
      const target = await resolveTaskSpawnTarget(agentId, task, fallback)

      // TASK-3086: serijalizacija ide PRIJE označavanja `in_progress`. Prvi pokušaj (16:45)
      // provjeravao je tek nakon PUT-a, pa je zadatak koji čeka red ostajao zauvijek
      // `in_progress` bez ijednog procesa — ploča je pokazivala „Jelena radi", a nitko nije
      // radio (TASK-101). Ovako zadatak ostaje `pending` i sljedeći prolaz ga uredno pokupi.
      const hold = serializationHold(agentId, String(task.id))
      if (hold) { log(`⏸️ [serijalizacija] ${task.id} -> ${agentId}: ${hold}`); continue }

      // ADR-0022 (TASK-5613): trajni agent → ista sesija. Odluka ide IZA serijalizacije i PRIJE
      // `in_progress` (isti obrazac kao TASK-3086): zadatak koji čeka sesiju ostaje `pending`.
      const tr = await pripremiTrajniSpawn(agentId, { id: String(task.id), tags: task.tags, projectId: task.projectId || null }, target)
      if (tr.akcija === 'cekaj') continue
      const trajni = tr.trajni

      // P5c/TASK-2584: PROMATRANJE — je li ovo posao koji bi trebao ići u razlaganje
      // umjesto jednom generalistu? Odluka se SAMO zapiše; spawn ide starim putem.
      // Mjereno 02.09. na regoc.db: 32,6 % zadataka je E4/E5, a 78 od 92 takva s
      // odlukom tiera otišlo je na opus kao jedan div. Ovo je brojač te pojave.
      observeDecomposable(task)

      const content = `${task.title}\n\n${task.description || ''}`
      // TASK-2637: RAG pre-injekcija za ollama maknuta — funkcija nije ni postojala u ovoj datoteci
      // (poziv je tiho padao u catch), a s R1 tool-loopom lokalni agent RAG dohvaća sam (rag_search/bash).
      // Z3/TASK-3013: i auto-exec put nosi projekt zadatka na kraju prompta.
      // A5/TASK-3004: ako ovaj zadatak kreće nakon odobrene kontrolne točke, na kraj prompta
      // ide sažetak onoga što je prethodilo i što je Goran odlučio. Sesija se ne može zamrznuti
      // pa se kontekst prenosi zapisom — isti obrazac kojim se prenosi i projekt.
      // TASK-3097: prihvatni kriteriji idu i PRIMARNOM agentu. Prvo su išli samo helperima
      // (grade se u `createSequentialHelpers`), pa je onaj koji radi PRVI i postavlja smjer
      // cijelog lanca — u ovom slučaju Kosjenka — jedini radio bez liste. Dokaz: prompt
      // `or_prompt_kosjenka_1785448502996.txt` nije sadržavao nijedan kriterij.
      const prompt = buildAgentPrompt(agentId, content, 'user', `Auto-exec (prioritet ${task.priority})`, [], task.id, (await buildProjectTail(task.projectId || null)) + resumeBriefTail(String(task.id)) + (await parentResultTail(task)) + buildAcceptanceChecklist(content) + researchStepTail(String(task.id), task.projectId || null) + criticRepairTail(String(task.id)) + adversarialVerifyTail(String(task.id), content) + chatContextTail(task.tags))
      log(`⚡ Auto-exec P${task.priority}: ${task.id} -> ${agentId} (${target.provider}:${target.model})`)
      // ADR-0012 §16 (G6) + TASK-5029: ULAZ u `in_progress` tek kad proces STVARNO krene.
      // Prije je PUT išao prije spawna, pa je odbijeni spawn (pauza/strop/osigurač) ostavljao
      // zadatak „u radu" bez procesa dok ga zombi-oporavak ne bi vratio.
      await pripremiMemorijuZaSpawn(String(task.id), agentId)
      const start = spawnAgentOnDemand(agentId, prompt, target, task.id, 'user', undefined, trajni)
      await applySpawnOutcome(String(task.id), start, task.tags)
      if (!start.started) continue
      if (trajni) await oznaciTrajniStart(String(task.id), task.tags, agentId, trajni)
      spawnedThisPass++
      // R2: i P1/auto-exec put gradi sekvencijalni lanac (task iz konzole/curl-a, ne samo poruka).
      // Z2/TASK-3012: lanac nasljeđuje projekt zadatka-roditelja (uz zapis izvora).
      // TASK-4761: chat: oznaka roditelja putuje niz cijeli lanac (v. createSequentialHelpers).
      const parentChatTag = (Array.isArray(task.tags) ? task.tags : []).find((t: string) => /^chat:-?\d+$/.test(String(t)))
      await createSequentialHelpers(content, agentId, task.id, task.projectId || undefined, parentChatTag || null, task.tags, (task as any).createdBy)
    }
  } catch (e) { log(`⚠️ Auto-exec error: ${e}`) }
}

/**
 * Prolaz odlucitelja — model odgovara umjesto covjeka na zadatcima s oznakom `needs-decision`.
 *
 * ZASTO OVDJE: prekidac „neka model odluci umjesto mene" (config/odlucitelj.json) do 05.09.2026.
 * nije imao nijednog pozivatelja osim gumba na ploci. Ukljucen prekidac + nitko da ga vozi =
 * zadatci stoje, a covjek gleda zelenu oznaku i ceka. Pogon je u `OdluciteljPogon.ts`.
 *
 * Rucna kocnica vrijedi i ovdje: dok je pauza pritisnuta, model ne odlucuje nista. Odluka
 * naime zavrsi kao oznaka `nalog`, a to je ulaznica za spawn — pauza bi inace curila.
 */
let lastOdluciteljRun = 0
let odluciteljUTijeku = false

/**
 * NE ceka se na ishod: mrezni model odgovara i po minutu po zadatku, a glavna petlja u
 * meduvremenu mora citati poruke, mjeriti potrosnju i drzati heartbeat. Zato prolaz ide
 * u pozadinu, uz zastavicu koja sprjecava da se dva prolaza preklope.
 */
function odluciteljPass(): void {
  if (odluciteljUTijeku) return
  if (!odluciteljTrebaProlaz(lastOdluciteljRun, Date.now())) return
  if (!odluciteljConfig().ukljucen) { lastOdluciteljRun = Date.now(); return }
  if (readPauseState().paused) { lastOdluciteljRun = Date.now(); return }
  lastOdluciteljRun = Date.now()
  odluciteljUTijeku = true
  void odluciteljProlazZavrsi()
}

/**
 * Redci zadataka koje je odlučitelj upravo pustio — samo polja po kojima se sudi može li ih
 * red uopće podići. Read-only i bez rušenja: nepročitan redak znači „nemam što prijaviti",
 * a ne lažnu uzbunu.
 */
function citajZaPustanje(ids: string[]): PustenZadatak[] {
  if (!ids.length) return []
  try {
    const db = new Database(TASKS_DB_PATH, { readonly: true })
    try {
      const upit = db.query('SELECT id, assignee, status, paused FROM tasks WHERE id = ?')
      const out: PustenZadatak[] = []
      for (const id of ids) {
        const r = upit.get(id) as { id?: string; assignee?: string | null; status?: string; paused?: number } | null
        if (r?.id) out.push({ id: r.id, assignee: r.assignee ?? null, status: String(r.status || ''), paused: r.paused })
      }
      return out
    } finally { db.close() }
  } catch {
    return []
  }
}

async function odluciteljProlazZavrsi(): Promise<void> {
  try {
    const z = await odluciteljProlaz()
    if (!z) return
    // Sutnja je bila izvorni kvar — svaki prolaz ostavlja redak, i kad nije nista odlucio.
    log(`🤖 [odlucitelj] ${odluciteljOpis(z)}`)
    for (const i of z.ishodi) {
      log(`   ↳ ${i.id}: ${i.rijec === 'opcija' ? `opcija ${i.opcija}` : (i.rijec || 'bez odgovora')}`
        + ` — ${i.ishod || 'nije upisano'}${i.odgodaPuta ? ` (${i.odgodaPuta}. odgoda, ${i.odgodaSati} h)` : ''}`
        + `${i.razlog ? ` · ${String(i.razlog).slice(0, 90)}` : ''}`)
      // Pušten prepoznati rizik mora ostaviti glasan trag — to je jedini potez odlučitelja
      // koji troši novac ili mijenja nešto izvan sustava.
      if (i.rizikPusten) {
        log(`   ⚠️ [odlucitelj] ${i.id}: model je PUSTIO zadatak s prepoznatim rizikom „${i.filtar}"`)
      }
    }
    // PUŠTANJE KOJE SE NE MOŽE POKRENUTI (Goran, 05.09.2026.: „izgleda da se zadaci nisu
    // odključali"). Mjerenje vremena je radilo — TASK-4619 je pušten minutu nakon isteka roka
    // — ali je izvršitelj bio `regoc`, a takav zadatak red NAMJERNO ne spawna. Odluka je
    // tako promijenila samo bazu, a čovjek je vidio zadatak koji stoji. Sada se to imenuje.
    const zaProvjeru = z.ishodi
      .filter(i => (i.rijec === 'kreni' || i.rijec === 'opcija') && i.ishod === 'upisano')
      .map(i => i.id)
    const nepokretljivi = zaProvjeru.length ? neizvedivaPustanja(citajZaPustanje(zaProvjeru)) : []
    for (const n of nepokretljivi) {
      log(`   ⛔ [odlucitelj] ${n.id}: PUŠTEN, ali ga stroj ne može podići — ${n.razlog}`)
    }

    // NAJAVA (Goran, 05.09.2026.): „imate x vremena za <sto treba odluciti> odluku inace model
    // xx odlucuje za vas." Ide U KONZOLU I NA TELEGRAM; rok se daje jednom po zadatku, pa se
    // ni poruka ne ponavlja.
    const najave = z.ishodi.filter(i => i.rijec === 'najava' && i.najavaTekst)
    // Zadatak koji model odgađa iznova nije blokada, ali jest vijest: nešto u njemu stroj ne
    // može razriješiti sam. Javlja se, a zadatak se svejedno vraća u sljedeći prolaz.
    const odgode = z.ishodi.filter(i => i.javiti && i.rijec === 'odgodi')
    const poruke: string[] = [
      ...najave.map(i => String(i.najavaTekst)),
      ...nepokretljivi.map(n =>
        `⛔ REGOČ: ${n.id} je pušten u rad, ali ga stroj ne može podići — ${n.razlog}.`),
      ...(odgode.length
        ? [`🤖 REGOČ: odlučitelj je više puta zaredom odgodio: `
           + odgode.map(i => `${i.id} (${i.odgodaPuta}× — ${i.filtar || 'prosudba modela'})`).join(', ')
           + '. Ne čeka te — vratit će se sam u sljedeći prolaz.']
        : []),
    ]
    if (poruke.length) {
      // Vlastita veza na bazu: prolaz je asinkron i završava nakon što je petlja svoju
      // već zatvorila.
      let vlastita: ReturnType<typeof getDb> | null = null
      try { vlastita = getDb() } catch { /* javka je uvid, ne uvjet rada */ }
      for (const tekst of poruke) {
        log(tekst)
        if (vlastita) { try { queueUserAlarm(vlastita, tekst) } catch { /* isto */ } }
      }
      try { vlastita?.close() } catch { }
    }
  } catch (e: any) {
    log(`⚠️ [odlucitelj] prolaz nije uspio: ${String(e?.message ?? e).slice(0, 160)}`)
  } finally {
    odluciteljUTijeku = false
  }
}

// ─── TASK-5164: zahtjevi zatvaranja (nesukladnost B, DIZAJN-nesukladnosti-BCD §2.2 B3) ─────
// Ploča `completed` od bilo koga osim daemona i čovjeka ne zatvara, nego označi `ceka-kriticara`
// (uživo) ili samo zapiše zahtjev (sjena). Ovdje ih provodi ISTI kritičar kao spawn — datoteke od
// `started_at` + `[PROVJERA] cmd:` — i zatvara kroz `zatvoriZadatak` (daemon + token).
// Pogon: svakih 15 s, nikad dva prolaza istodobno; ne blokira glavnu petlju (void).
let lastZatvaranjePass = 0
let zatvaranjePassRadi = false
const ZATVARANJE_PASS_MS = 15_000

async function kriticarZaZahtjev(z: ZahtjevZadatak, live: boolean): Promise<SudKriticara> {
  const ctx = readTaskContext(z.id)
  const pocetak = z.startedAt ? Date.parse(z.startedAt) : NaN
  let rootDir = HOME
  try { rootDir = korijenKriticaraZahtjeva(loadWorktreeConfig(), z.id, ctx.projectId, HOME) } catch { /* ostaje HOME */ }
  const c = await critiqueSpawnAsync({
    taskId: z.id,
    agentId: z.assignee || 'regoc',
    // Bez `started_at` (zatvaranje bez otvaranja) gleda se zadnjih sat vremena — bolje nešto
    // nego nula datoteka i lažni `unverifiable`.
    sinceMs: Number.isFinite(pocetak) ? pocetak : Date.now() - 3_600_000,
    resultText: z.resultSummary || '',
    live,
    // Tuđi spawnovi pišu u isto stablo → kritičar prijavljuje, ne blokira (kao na spawn putu).
    concurrentSpawns: activeAgentSpawns.size,
    declared: ctx.declared,
    ...(ctx.description ? { taskDescription: ctx.description } : {}),
    // TASK-5680: stablo zadatka (worktree → stablo projekta), kao `workspace.cwd || workTree`
    // na putu spawna. Uz `$HOME` je `bun test tests/…` padao s „filters did not match".
    rootDir,
  })
  log(formatCritiqueLog(z.id, c, live))
  return {
    status: c.verdict.status,
    razlog: c.verdict.reason,
    provjera: c.verdict.checks.filter((x) => !x.skipped && x.exitCode !== null).length,
    // QA-5165 N2 (odluka B): propisana [PROVJERA] koja se nije mogla izvesti. `__doc2__` je
    // sučev (L2) neizvedeni sud — kvar vratara, ne zadatka, pa se ne broji.
    neizvedivo: (c.verdict.unrunnable || []).filter((u) => !String(u.raw).startsWith('__doc2__')).length,
  }
}

// Vratar teksta za put zahtjeva. BEZ izuzeća `orkestrator`: izuzeće je pisano za sažetak koji
// orkestrator piše UMJESTO agenta, a ne za vlastiti rad (dizajn B3 korak 3). `trivial_result`
// se PROVODI bez obzira na completion-gate live (QA-5165 N2, odluka B, TASK-5210) — na ovom putu
// kritičar jedini sudi, pa „Gotovo, sve radi.” ne smije biti ✅. Ostali kodovi po completion-gate.json.
function vratarTekstaZahtjeva(sazetak: string, z: ZahtjevZadatak): string | null {
  const v = evaluateCompletion(sazetak, {
    pocetoU: z.startedAt ?? null, zavrsenoU: new Date().toISOString(), izvor: null, oznake: z.tags || [],
  } as any)
  if (v.accept) return null
  return v.code === 'trivial_result' || shouldEnforce(v, loadGateConfig()) ? `${v.code}: ${v.reason}` : null
}

async function zatvaranjeZahtjeviPass(): Promise<void> {
  if (zatvaranjePassRadi || Date.now() - lastZatvaranjePass < ZATVARANJE_PASS_MS) return
  if (!isEnabled('zatvaranjeKrozDaemon')) return
  lastZatvaranjePass = Date.now()
  zatvaranjePassRadi = true
  try {
    const live = isEnabled('zatvaranjeKrozDaemonLive')
    if (live) {
      await obradiZahtjeveZatvaranja({
        zahtjevi: async () => {
          const r = await fetch(`${TASK_MANAGER_API}?status=in_progress`)
          if (!r.ok) throw new Error(`HTTP ${r.status}`)
          const svi = await r.json() as any[]
          return svi.filter((t) => Array.isArray(t.tags) && t.tags.includes(OZNAKA_CEKA))
        },
        kriticar: (z) => kriticarZaZahtjev(z, true),
        vratarTeksta: vratarTekstaZahtjeva,
        zatvori: async (id, body) => (await zatvoriZadatak(TASK_MANAGER_API, id, body, { log })).ok,
        log,
      })
    } else {
      await obradiSjenuZatvaranja({
        zadatak: async (id) => {
          const r = await fetch(`${TASK_MANAGER_API}/${id}`)
          return r.ok ? await r.json() as ZahtjevZadatak : null
        },
        kriticar: (z) => kriticarZaZahtjev(z, false),
        vratarTeksta: vratarTekstaZahtjeva,
        log,
      })
    }
  } catch (e) {
    log(`⚠️ [zatvaranje-zahtjev] prolaz pao: ${e}`)
  } finally {
    zatvaranjePassRadi = false
  }
}

async function mainLoop(): Promise<void> {
  log('═══════════════════════════════════════════════════════════')
  log('REGOČ Daemon v4.5.0 starting... (SPAWN-ON-DEMAND PATTERN)')
  log('═══════════════════════════════════════════════════════════')
  log(`Poll interval: ${POLL_INTERVAL_MS}ms`)
  log(`Context check interval: ${CONTEXT_CHECK_INTERVAL}ms (threshold: ${CONTEXT_THRESHOLD_PCT}%)`)
  log(`Database: ${DB_PATH}`)

  // TASK-5336: daemon i sve što pokreće bez vlastite okoline (kritičar, python alati)
  // nasljeđuje TMPDIR. Ako ga regoc-services.sh nije postavio (ili pokazuje u /tmp),
  // postavi ga ovdje — /tmp je tmpfs od 100 MB i nestaje s kontejnerom (pravilo 26).
  if (!process.env.TMPDIR || process.env.TMPDIR === '/tmp' || process.env.TMPDIR.startsWith('/tmp/')) {
    Object.assign(process.env, tmpOkolina(tmpMapaServisa('daemon')))   // ADR-0020 §3.1: servisi/daemon/tmp
  }
  log(`TMPDIR: ${process.env.TMPDIR || '(nije postavljen — /tmp)'}`)

  // TASK-2987: log SSOT — rotiraj ako treba i preveži naslijeđene putanje na kanonsku.
  try {
    const init = initDaemonLog(LOG_FILE)
    log(`Log (SSOT): ${init.canonical}`)
    if (init.rotation.rotated) {
      log(`🔄 log rotiran pri startu (${Math.round(init.rotation.sizeBefore / 1048576)} MB → ${init.rotation.archivedTo})`)
    }
    for (const [legacy, res] of Object.entries(init.compat)) {
      if (res !== 'already-linked') log(`↪️  naslijeđena putanja ${legacy}: ${res}`)
    }
  } catch (e) {
    log(`⚠️ initDaemonLog nije uspio: ${e}`)
  }

  // TASK-2987: „popravak na disku ≠ popravak u pogonu". Daemon sam prijavljuje vrti li
  // stari kod — dokaz iz runa 28.07.: RegocDaemon.ts spremljen 11:02, proces od 10:40,
  // pa su u 11:03 dva taska zatvorena kao COMPLETED s porukom hook-blokade u rezultatu.
  try {
    const { checkStaleCode, formatStaleReport } = await import('./StaleCodeCheck')
    const rep = checkStaleCode(import.meta.path, process.pid, { label: 'RegocDaemon' })
    if (rep.isStale) {
      log('❌❌❌ STALE CODE: ovaj proces je startao PRIJE zadnje izmjene izvora!')
      for (const f of rep.stale.slice(0, 5)) {
        log(`   ${f.path} (${new Date(f.mtimeMs).toISOString()})`)
      }
    } else {
      log(`✅ kod u pogonu == kod na disku (${rep.files.length} izvornih datoteka)`)
    }
  } catch (e) {
    log(`⚠️ StaleCodeCheck nije uspio: ${e}`)
  }

  // I6/TASK-3655: popis kolekcija iz ChromaDB-a se osvježi ODMAH pri startu, da prvi
  // spawn ne radi iz praznog keša (`buildAgentPrompt` je sinkron pa mrežu ne smije dirati).
  // Nedostupna Chroma → keš ostaje kakav je, a uputa se jednostavno ne doda.
  if (!ragUkljucen()) log('📚 RAG isključen na ovom čvoru (memory-config rag.enabled=false) — ChromaDB se ne dira')
  else try {
    const kolekcije = await refreshCollectionsCache()
    log(kolekcije
      ? `📚 ChromaDB kolekcije osvježene: ${kolekcije.length} (vlastitih agentskih: ${kolekcije.filter(k => k.startsWith('agent_')).length})`
      : '📚 ChromaDB nedostupna pri startu — vlastite RAG kolekcije idu iz keša (ili se ne dodaju)')
  } catch (e) {
    log(`⚠️ osvježavanje ChromaDB kolekcija nije uspjelo: ${e}`)
  }

  // A1/TASK-3000: prethodna generacija spawnova je mrtva po definiciji — njihovi izolirani
  // worktreejevi su napušteni i ovo je jedino mjesto gdje se čiste. Posao se ne briše.
  reapWorktreesOnStartup()
  // A3/TASK-3002: isti razlog za registar opsega — zahtjevi mrtve generacije bi inače
  // držali datoteke i tiho zaustavljali svaki zadatak koji ih dira.
  reapScopeClaimsOnStartup()

  // ============================================
  // CRITICAL: Load GEMINI.md and Agent Registry at startup
  // This gives REGOČ full system awareness
  // ============================================
  log('📜 Loading REGOČ context...')
  loadGeminiContext()
  loadAgentRegistry()

  if (!geminiContext) {
    log('⚠️ WARNING: GEMINI.md not loaded - daemon may lack 23 rules context!')
  }
  if (!agentRegistry) {
    log('⚠️ WARNING: Agent registry not loaded - delegation may fail!')
  }

  // TASK-623: Ensure mode file exists and show current mode
  ensureModeFile()
  log(`[MODE] System mode: ${getSystemMode()}`)

  // TASK-624: Start enabled persistent agents
  startEnabledPersistentAgents()

  log('═══════════════════════════════════════════════════════════')
  log('SPAWN-ON-DEMAND ROUTING (AgentWorker DISABLED):')
  log('  • Istraživanje → Manda (spawn claude --print)')
  log('  • Arhitektura → Kosjenka (spawn claude --print)')
  log('  • Implementacija → Jelena (spawn claude --print)')
  log('  • Sigurnost → Malik (spawn claude --print)')
  log('  • Testiranje → Potjeh (spawn claude --print)')
  log('  • Analiza → Dora (spawn claude --print)')
  log('  • Vizualno → Gita (spawn claude --print)')
  log('  • UI/Frontend → Grga (spawn claude --print)')
  log('  • FPGA → Emard (DISABLED — persistentan u REGOČ sesiji)')
  log('  • Sistemski upiti → REGOČ (sam odgovara)')
  log(`  • Max concurrent spawns: ${maxAgentConcurrent()} (postavka TaskManagera '${CONCURRENCY_KEY}', uživo ≤5 s — Config → Usporedni agenti)`)
  { const th = currentAutonomyThresholds(); log(`  • Vrata autonomije: sesija ${th.sessionAutonomy}/${th.sessionCaution}/${th.sessionBlock} %, tjedan ${th.weeklyBlock} % (postavka TaskManagera 'autonomy.*', uživo ≤5 s — Config → Vrata autonomije)`) }
  // TASK-5015: okolina više ne odlučuje. Ako je još postavljena, to je trag stare
  // konfiguracije (npr. docker-compose) — upozori jednom pri pokretanju.
  if (process.env[CONCURRENCY_ENV] !== undefined && process.env[CONCURRENCY_ENV] !== '') {
    log(`  ⚠️ ${CONCURRENCY_ENV}=${process.env[CONCURRENCY_ENV]} je ZASTARJELA — služi samo kao jednokratna početna vrijednost dok postavka ne postoji; mijenjaj na Config stranici`)
  }
  log(`  • Liveness check: ${AGENT_LIVENESS_CHECK_INTERVAL_MS / 3600000}h, hard ceiling: ${AGENT_HARD_CEILING_MS / 3600000}h`)
  // D3/TASK-2955: potvrda da je forenzika izlaza aktivna (bez ovog reda u logu → vrti se stari kod)
  log(`  • Spawn exit forenzika: AKTIVNA — dumpovi u ${SPAWN_DIAG_DIR} (zadnjih ${SPAWN_DIAG_KEEP}), gašenje prekida spawnove s razlogom "${SHUTDOWN_KILL_REASON}"`)
  // M4/TASK-4627: bez ovog retka u logu → daemon vrti kod od PRIJE urednog gašenja.
  log(`  • Uredno gašenje: ${isEnabled('shutdownResume', false)
    ? (isEnabled('shutdownResumeLive', false)
        ? `AKTIVNO (live) — zadaci u letu se pri restartu vraćaju u pending s oznakom resume:<n>, strop ${SHUTDOWN_RESUME_MAX_ROUNDS} krugova`
        : 'SJENA — odluka se bilježi, zadaci u letu se i dalje otkazuju')
    : 'ISKLJUČENO — zadaci u letu se otkazuju (staro ponašanje)'}`)
  log('═══════════════════════════════════════════════════════════')

  daemonStartTime = Date.now()
  processedCount = 0
  updateStatus('Starting', 'Inicijalizacija...')

  writePid()
  log(`PID: ${process.pid}`)

  // TASK-2990: od sada status datoteka kuca i dok petlja obrađuje poruku.
  startStatusHeartbeat()
  log(`  • Status heartbeat: svakih ${STATUS_HEARTBEAT_MS / 1000} s (konzola zove OFFLINE nakon 30 s tišine)`)

  // Handle shutdown signals
  // D3/TASK-2955: prije se ovdje odmah zvao process.exit(0) — Bun je tada tiho
  // pobio svu spawnanu djecu, a ona su u log padala kao anonimni "exit 143".
  // Sada ih uredno prekidamo (killAgentSpawn s razlogom "daemon restart") i damo
  // kratku milost da poruke i PUT-ovi odu prije izlaza.
  let shuttingDown = false
  const gracefulShutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) { log(`(${signal} ponovno primljen — gašenje već traje)`); return }
    shuttingDown = true

    log(`Received ${signal}, shutting down...`)
    updateStatus('Stopping', 'Zatvaranje...')
    // Otkucaj mora stati prije nego maknemo PID: inače bi zadnji tik osvježio
    // `lastUpdate` na već ugašenom daemonu i traka bi ga načas prikazala kao živog.
    stopStatusHeartbeat()

    // M4/TASK-4627: zadatci u letu se PRVO vrate u red, pa tek onda ide signal.
    // Obrnut redoslijed ne bi vrijedio: nakon SIGTERM-a dijete može zatvoriti zadatak samo.
    const zaNastavak = await prepareShutdownResume(SHUTDOWN_KILL_REASON)
    const killed = shutdownActiveSpawns(SHUTDOWN_KILL_REASON, zaNastavak)
    removePid()

    if (killed > 0) {
      await new Promise(r => setTimeout(r, SHUTDOWN_GRACE_MS))
      log(`✅ Gašenje: ${killed} spawn(ova) uredno prekinuto (razlog zapisan u logu i u zadacima)`)
    }
    process.exit(0)
  }

  process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM') })
  process.on('SIGINT', () => { void gracefulShutdown('SIGINT') })

  updateStatus('Idle', 'Spreman za zahtjeve')

  // Main processing loop
  while (true) {
    try {
      const db = getDb()
      const messages = getPendingMessages(db)

      if (messages.length > 0) {
        log(`Found ${messages.length} pending message(s)`)
        updateStatus('Polling', `Pronađeno ${messages.length} poruka`, messages.length)

        for (const msg of messages) {
          await processMessage(db, msg)
        }

        updateStatus('Idle', 'Spreman za zahtjeve')
        lastStatusUpdate = Date.now()
      } else {
        // Update status every 10 seconds even when idle (keeps uptime fresh)
        const now = Date.now()
        if (now - lastStatusUpdate >= STATUS_UPDATE_INTERVAL) {
          updateStatus('Idle', 'Spreman za zahtjeve')
          lastStatusUpdate = now
        }
      }

      // R1/TASK-2557: flush pending 'user' poruka → Telegram (iza flaga; interno throttled ~1/min)
      await flushUserMessages(db)

      // TASK-3046: mjerilo potrošnje ima vlastiti pogon — mjeri i kad nijedan agent ne radi.
      // Bez ovoga gate autonomije oslijepi točno u trenutku kad je zaustavio agente.
      void refreshSessionUsage()

      // TASK-3461: mjerilo koje je stalo mora se ČUTI. (interno throttled ~1 min)
      await usageMeterWatchdog(db)

      // P1 auto-execution: pending P1 taskovi se automatski pokrecu (interno throttled).
      if (Date.now() - lastP1Check >= P1_CHECK_INTERVAL_MS) { lastP1Check = Date.now(); await processP1Tasks(db) }

      // Goran, 05.09.2026.: „prebacio sam odluku na model, ali ne vidim da se nesto desava."
      // Prekidac je do tada samo upisivao zelju u config — pogon nije postojao. (interno
      // priguseno na ~5 min, fail-safe: iskljucen prekidac = potpuni no-op)
      odluciteljPass()

      // TASK-2987: dugotrajni proces sam prijavljuje kad mu se kod promijenio ispod nogu.
      await checkOwnCodeFreshness()

      // F1/TASK-2560+2561: robusnost watchdogovi (dry-run; interno throttled ~30 min)
      await watchdogStaleTasksDryRun(db)
      await watchdogDeadAgents(db)
      // TASK-3019: stari F3 reaper (24h → blocked, 7d → cancelled), sada iza flaga i u dry-runu.
      // Premješten OVDJE iz repa petlje jer alarm treba otvorenu vezu na bazu (db.close() je niže).
      await watchdogStaleTaskReaper(db)
      // T10/TASK-3575: dnevni sažetak „neprovjereno" ima vlastiti pogon — inače bi se
      // poslao tek kad sljedeći spawn slučajno završi, a to može biti i sutra.
      if (Date.now() - lastUnverifiedSummaryCheck >= UNVERIFIED_SUMMARY_INTERVAL_MS) {
        lastUnverifiedSummaryCheck = Date.now()
        maybeSendUnverifiedSummary(db)
      }

      // P5c/TASK-2584: pogon razloženih zadataka. Podzadatak čijem su koraku sve
      // ovisnosti gotove prelazi blocked→in_progress i odlazi durabilnom radniku kao
      // `chain_next`. Bez ovoga bi drugi val plana stajao u `blocked` — a `blocked` je
      // kod nas izmjereno groblje (87 zadataka, medijan 8,3 dana, TASK-3019).
      // Iza zastavice `taskDecompose`; bez odobrenog plana nema što pumpati (no-op).
      await decompositionPump()

      // ADR-0024 V2 (TASK-5677): voditelji lanca — predprolaz svakih 60 s, model samo kad ima posla.
      if (Date.now() - lastVoditeljTick >= VODITELJ_TICK_MS) { lastVoditeljTick = Date.now(); await voditeljiProlaz() }

      // TASK-5164 (B3): zahtjevi zatvaranja — kritičar nad zadacima koje nije zatvorio daemon.
      void zatvaranjeZahtjeviPass()

      db.close()

      // Check context every 5 seconds
      const now = Date.now()
      if (now - lastContextCheck >= CONTEXT_CHECK_INTERVAL) {
        await checkAndSaveContext()
        lastContextCheck = now
      }

      // BUG-001 FIX: Check task completions and auto-continue
      if (now - lastTaskSchedulerCheck >= TASK_SCHEDULER_CHECK_INTERVAL) {
        await checkTaskCompletions()
        lastTaskSchedulerCheck = now
      }

      // WATCHDOG: Check if Klaudio is alive and restart if needed
      if (now - lastKlaudioWatchdogCheck >= KLAUDIO_WATCHDOG_INTERVAL) {
        await watchdogCheckKlaudio()
        lastKlaudioWatchdogCheck = now
      }

      // AGENT LIVENESS WATCHDOG (Goran 2026-06-17): NE gasimo agente po vremenu —
      // svaka 2h provjeri rade li (CPU napredak) ili su zaglavljeni. Sweep je jeftin (60s),
      // odluka po agentu tek nakon punog 2h prozora (logika u watchdogCheckAgentSpawns).
      if (now - lastAgentLivenessCheck >= AGENT_LIVENESS_SWEEP_MS) {
        await watchdogCheckAgentSpawns()
        watchdogRecoverPersistentAgents()
        lastAgentLivenessCheck = now
      }

      // BUG-006 DISABLED: Stale message notifications were not working properly
      // User request 2026-01-26: "to smo dodali ali nije radilo pa treba maknuti"
      // The feature was sending notifications to Klaudio about specialist agents
      // (Kosjenka, Jelena, etc.) that don't have daemons and are processed by PAI sessions.
      // This caused spam notifications like "⚠️ Poruka za kosjenka čeka 85s bez odgovora"
      // without any way for them to be resolved.
      //
      // if (now - lastStaleMessageCheck >= STALE_MESSAGE_CHECK_INTERVAL) {
      //   await checkStalePendingMessages()
      //   lastStaleMessageCheck = now
      // }

    } catch (error) {
      log(`Error in main loop: ${error}`)
      updateStatus('Idle', `Greška: ${error}`)
    }

    // Wait before next poll
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
  }
}

// ============================================
// Entry Point
// ============================================

const args = process.argv.slice(2)

// TASK-4895 (nalaz TASK-4880): provjera „već radi" bila je samo u grani --daemon, a
// keeper diže goli `bun RegocDaemon.ts` — pa je ručni start iz agentskog spawna postao
// DRUGI orkestrator nad istim execution_queue (strop konkurentnosti 1 + 3).
// Vrata se prolaze PRIJE mainLoopa: odbijeni primjerak ne dira red, pidfile ni worktreeje.
function daemonStartGate(): void {
  const refusal = spawnEnvRefusal(process.env)
  if (refusal) {
    console.error(refusal)
    log(`⛔ [singleton] start odbijen — pokrenut iz spawna agenta (REGOC_TASK_ID=${process.env.REGOC_TASK_ID}, PID ${process.pid}, ppid ${process.ppid})`)
    process.exit(SPAWN_ENV_EXIT_CODE)
  }
  const lock = acquireDaemonSingleton({ lockPath: DAEMON_LOCK_FILE, pidFile: PID_FILE })
  if (!lock.ok) {
    console.log(lock.message)
    log(`⛔ [singleton] ${lock.message} (odbijen PID ${process.pid}, ppid ${process.ppid})`)
    process.exit(0)
  }
}

if (args.includes('--stop')) {
  stopDaemon()
} else if (args.includes('--status')) {
  showStatus()
} else if (args.includes('--daemon')) {
  // TASK-4895 B: pokretač iz spawna agenta odbija odmah (dijete bi i samo odbilo).
  const refusal = spawnEnvRefusal(process.env)
  if (refusal) {
    console.error(refusal)
    process.exit(SPAWN_ENV_EXIT_CODE)
  }
  // Check if already running
  const existingPid = readPid()
  if (existingPid && isRunning(existingPid)) {
    console.log(`Daemon already running (PID: ${existingPid})`)
    process.exit(0)
  }

  // Start in background using nohup pattern
  // FIX-004: remove CLAUDECODE env vars to prevent "Cannot be launched inside Claude Code" errors
  console.log('Starting REGOČ Daemon in background...')
  const daemonEnv = { ...process.env }
  delete daemonEnv.CLAUDECODE
  delete daemonEnv.CLAUDE_CODE_ENTRYPOINT

  // TASK-2987: `Bun.file(LOG_FILE)` piše od OFFSETA 0 (bez O_APPEND). Uz istovremeni
  // appendFileSync iz log(), svaki restart je prepisivao početak datoteke u mjestu —
  // log je postao nekronološki mozaik (redak 1 = 28.07., redak 80 001 = 19.04.).
  // O_APPEND fd: svaki write ide na kraj, pa je poredak zajamčen i rotacija sigurna.
  const logFd = openAppendFd(LOG_FILE)
  // TASK-4781: pokretač se do 09.09.2026. NIJE VRAĆAO. Bun.spawn bez unref drži
  // događajnu petlju roditelja dok dijete živi, a dijete je bio sam daemon — dakle
  // zauvijek. Uživo izmjereno: PID 200129 `bash manage.sh start` → 200132 `--daemon`
  // → 200166 worker, sva tri živa 16 min nakon starta. Svaki pozivatelj s timeoutom
  // (alatni sloj, `timeout`, CI) tada SIGTERM-om pobije POKRETAČA I DAEMON, jer dijete
  // dijeli procesnu grupu s pozivateljem.
  //   odvojeno (detached → nova sesija, setsid(2), radi i na macOS-u)
  //           → daemon izlazi iz naše procesne grupe i sesije (SIGTERM pozivatelju ga
  //             ne nosi sa sobom; nohup to ne bi riješio — umire na kraju alata);
  //   unref() → roditelj više ne visi o djetetu;
  //   exit(0) → pokretač se vraća pozivatelju s jasnim izlaznim kodom.
  odvojeno([process.execPath, import.meta.path], { env: daemonEnv, izlazFd: logFd })

  // Daemon sam upisuje pidfile kad uđe u mainLoop — čekamo taj upis, ne fiksnu sekundu.
  let newPid: number | null = null
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500))
    newPid = readPid()
    if (newPid && isRunning(newPid)) break
    newPid = null
  }
  if (newPid) {
    console.log(`Daemon started (PID: ${newPid})`)
    console.log(`Log: ${LOG_FILE}`)
    process.exit(0)
  }
  console.log('Failed to start daemon. Check log for errors.')
  process.exit(1)
} else {
  // Run in foreground
  daemonStartGate()
  mainLoop().catch(err => {
    log(`Fatal error: ${err}`)
    removePid()
    process.exit(1)
  })
}
