/**
 * Nasljeđivanje projekta niz lanac pokretanja (Z2 / TASK-3012).
 *
 * KVAR KOJI OVO ZATVARA: zadatak koji nastane iz spawna nije nasljeđivao ništa —
 * u srpnju 2026. nijedan agentski zadatak nije imao projekt. Delegacija je projekt
 * pogađala isključivo `detectProjectId` regexima nad tekstom; kad tekst nije imao
 * ključnu riječ, dijete je ostajalo bez projekta i trošak/pokrivenost po projektu
 * su bili neupotrebljivi.
 *
 * ŽUTI RIZIK (tihi kvar) koji ovaj modul NAMJERNO drži pod kontrolom:
 * lanac smije prijeći granicu projekta — agent koji radi na DRIBLER-u delegira
 * popravak REGOČ daemona. Slijepo nasljeđivanje bi djetetu tiho dalo KRIVI projekt;
 * radilo bi "uspješno", trovalo statistiku i nitko to ne bi vidio. Zato:
 *
 *   1. DOKAZ IZ SADRŽAJA IMA PREDNOST. Ako `detectProjectId` u tekstu zahtjeva
 *      prepozna projekt, on pobjeđuje nasljeđivanje. Razilaženje s roditeljem se
 *      LOGIRA (`warning`) umjesto da se progutа.
 *   2. RODITELJ IZ SADRŽAJA MORA BITI POTVRĐEN. "TASK-1234" iz teksta poruke je
 *      samo kandidat — prihvaća se tek ako je taj zadatak stvarno dodijeljen
 *      agentu koji delegira. Inače bi citiranje tuđeg zadatka u opisu preusmjerilo
 *      dijete u tuđi projekt.
 *   3. SVAKI UPIS BILJEŽI IZVOR. Bez toga se naslijeđeno ne razlikuje od ručno
 *      dodijeljenog i ciljani popravak krivih redaka (rollback) nije moguć.
 *      Oblik zapisa: `project_source=inherited:<id_roditelja> project=<PRJ>`.
 *
 * Modul je namjerno ODVOJEN od RegocDaemon.ts: taj se pokreće čim ga se importa
 * (nema `import.meta.main` grane), pa se iz testa ne može učitati. Ovdje je čista
 * logika + injektirani `lookupTask`, pa je pokrivena testovima bez daemona.
 */

import { INBOX_PROJECT_ID } from './TaskManagerSQL'
import { jeDopustenAgent } from './AgentIds'

/** Prefiks po kojem se naslijeđeni redci pronalaze u `progress_notes` (rollback upit). */
export const PROJECT_SOURCE_PREFIX = 'project_source='

/** Podaci o roditeljskom zadatku koje trebamo za odluku. */
export interface ParentTaskInfo {
  id: string
  projectId: string | null
  assignee: string | null
}

/** Dohvat roditelja (HTTP u produkciji, stub u testu). `null` = nema takvog zadatka. */
export type TaskLookup = (taskId: string) => Promise<ParentTaskInfo | null>

/** Kandidat za roditelja + je li izvor pouzdan (metadata) ili samo tekst poruke. */
export interface ParentCandidate {
  id: string
  /** `true` = strukturirani metapodatak spawna; `false` = TASK-ID izvučen iz teksta. */
  trusted: boolean
}

export type ProjectSourceKind =
  /** Projekt prepoznat iz sadržaja zahtjeva — jači od nasljeđivanja. */
  | 'detected'
  /** Projekt preuzet od roditeljskog zadatka. */
  | 'inherited'
  /** Ni jedno ni drugo — dijete ide u pretinac PRJ-033, nikad u NULL. */
  | 'inbox'

export interface ProjectDecision {
  kind: ProjectSourceKind
  /** Projekt koji se šalje TaskManageru. Za `inbox` je to pretinac PRJ-033. */
  projectId: string
  /** ID roditelja kad je projekt naslijeđen (ili kad je roditelj postojao pa odbijen). */
  parentTaskId?: string
  /** Redak za `progressNotes` / `task_history` — počinje s `project_source=`. */
  note: string
  /** Nešto što čovjek mora vidjeti u logu (razilaženje, odbijen roditelj). */
  warning?: string
}

/** Agenti od kojih uopće ima smisla nasljeđivati (čovjek/kanal nema roditeljski zadatak). */
const NON_AGENT_SENDERS = new Set(['user', 'telegram', 'mumble', 'system', 'scheduler'])

/**
 * Nađi kandidata za roditeljski zadatak u dolaznoj poruci.
 *
 * Redoslijed: `metadata.parentTaskId` → `metadata.taskId` (oboje strukturirano i
 * pouzdano, upisuje ih daemon pri spawnu) → prvi `TASK-\d+` iz teksta (nepouzdano,
 * mora proći provjeru vlasništva u `resolveChildProject`).
 */
export function extractParentTaskId(msg: {
  from_agent?: string | null
  content?: string | null
  metadata?: string | null
}): ParentCandidate | null {
  if (msg.metadata) {
    try {
      const meta = JSON.parse(msg.metadata) as Record<string, unknown>
      const structured = meta.parentTaskId ?? meta.taskId
      if (typeof structured === 'string' && /^TASK-\d+$/.test(structured)) {
        return { id: structured, trusted: true }
      }
    } catch { /* nevaljan JSON u metadata — padamo na tekst */ }
  }

  const from = (msg.from_agent || '').toLowerCase()
  // Iz TEKSTA čitamo samo kad poruku šalje agent: čovjekov zahtjev koji spominje
  // "kao u TASK-1234" nije lanac pokretanja nego referenca.
  if (!from || NON_AGENT_SENDERS.has(from) || !jeDopustenAgent(from)) return null

  const match = (msg.content || '').match(/\bTASK-\d+\b/)
  return match ? { id: match[0], trusted: false } : null
}

/**
 * Odluči koji projekt dobiva dijete i pod kojim izvorom se to bilježi.
 *
 * `detected` je rezultat `detectProjectId` nad naslovom + sadržajem (RegocDaemon).
 */
export async function resolveChildProject(opts: {
  fromAgent: string
  content: string
  metadata?: string | null
  detected?: string | null
  lookupTask: TaskLookup
}): Promise<ProjectDecision> {
  const { fromAgent, content, metadata, detected, lookupTask } = opts

  const candidate = extractParentTaskId({ from_agent: fromAgent, content, metadata })
  let parent: ParentTaskInfo | null = null
  let rejected: string | undefined

  if (candidate) {
    try {
      parent = await lookupTask(candidate.id)
    } catch {
      parent = null
    }
    if (!parent) {
      rejected = `roditelj ${candidate.id} nije pronađen`
    } else if (!candidate.trusted && (parent.assignee || '').toLowerCase() !== fromAgent.toLowerCase()) {
      // Zaštita od preskakanja granice projekta preko citata tuđeg zadatka.
      rejected = `TASK-ID ${candidate.id} iz teksta pripada agentu ${parent.assignee || '?'}, a delegira ${fromAgent} — NE nasljeđujem`
      parent = null
    }
  }

  // Pretinac kod roditelja znači "roditelj nema projekt" — nema se što naslijediti.
  const parentProject = parent && parent.projectId && parent.projectId !== INBOX_PROJECT_ID
    ? parent.projectId
    : null

  if (detected) {
    const note = parentProject && parentProject !== detected
      ? `${PROJECT_SOURCE_PREFIX}detected project=${detected} parent=${parent!.id}:${parentProject} (razilazak — lanac prelazi granicu projekta)`
      : `${PROJECT_SOURCE_PREFIX}detected project=${detected}`
    return {
      kind: 'detected',
      projectId: detected,
      parentTaskId: parent?.id,
      note,
      warning: parentProject && parentProject !== detected
        ? `lanac prelazi granicu projekta: roditelj ${parent!.id}=${parentProject}, sadržaj upućuje na ${detected} — uzimam ${detected}`
        : rejected,
    }
  }

  if (parentProject) {
    return {
      kind: 'inherited',
      projectId: parentProject,
      parentTaskId: parent!.id,
      note: `${PROJECT_SOURCE_PREFIX}inherited:${parent!.id} project=${parentProject}`,
      warning: rejected,
    }
  }

  // Ni dokaz iz sadržaja ni roditelj — pretinac, NIKAD NULL (TASK-3009).
  const why = parent ? `roditelj ${parent.id} nema projekt` : (rejected || 'nema roditelja u lancu')
  return {
    kind: 'inbox',
    projectId: INBOX_PROJECT_ID,
    parentTaskId: parent?.id,
    note: `${PROJECT_SOURCE_PREFIX}inbox project=${INBOX_PROJECT_ID} razlog=${why}`,
    warning: rejected,
  }
}

/**
 * Zapis izvora za dijete koje nastaje IZ POZNATOG roditeljskog zadatka
 * (sekvencijalni helperi — roditelj je primarni zadatak, ne poruka).
 */
export function inheritedNote(parentTaskId: string, projectId: string): string {
  return `${PROJECT_SOURCE_PREFIX}inherited:${parentTaskId} project=${projectId}`
}

export { INBOX_PROJECT_ID }
