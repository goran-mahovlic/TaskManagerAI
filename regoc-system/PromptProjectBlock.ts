/**
 * Projekt zadatka u prompt-predlošku agenata (Z3 / TASK-3013).
 *
 * KVAR KOJI OVO ZATVARA: agentu se nikad nije REKLO na kojem je projektu. Zato ni
 * nije mogao poslati `projectId` kad sam stvara nove zadatke — svaki takav zadatak
 * je padao u pretinac PRJ-033 i pokrivenost projektima je pala na 26 %. Z1 je
 * zatvorio NULL, Z2 nasljeđivanje niz lanac; ovo je treći put nastanka zadatka —
 * onaj koji agent otkuca rukom (POST /api/tasks) — i njega je mogao popraviti
 * samo prompt.
 *
 * ZAMKA S KEŠOM (uvjet završetka zadatka, ne stilska preporuka):
 * prefiks prompta se kešira. Zajednički dio predloška je isti za SVE spawnove,
 * pa dijele keš. Ako se KONKRETNA vrijednost projekta ubaci rano u taj zajednički
 * dio, spawnovi različitih projekata prestaju dijeliti prefiks i trošak trajno
 * raste. Zato je podjela ovdje TVRDA:
 *
 *   1. `projectProtocolInstruction()` — bez konkretne vrijednosti, smije ići u
 *      zajednički dio (blok TASKMANAGER PROTOCOL). Isti tekst za sve → keš drži.
 *   2. `renderProjectTail()` — jedina konkretna vrijednost, ide NA KRAJ prompta,
 *      iza svega zajedničkog. Razlikuje se po projektu, ali ne razbija prefiks.
 *
 * Modul je namjerno ODVOJEN od RegocDaemon.ts / AgentDaemon.ts: oba se pokreću
 * čim ih se importa (nemaju `import.meta.main` granu), pa se iz testa ne mogu
 * učitati. Ovdje je čista logika, pokrivena testovima bez daemona.
 */

import { INBOX_PROJECT_ID } from './TaskManagerSQL'

/** Naslov završnog odjeljka. Testovi i daemoni ga dijele — ne prepisuj ga rukom. */
export const PROJECT_TAIL_HEADING = '## PROJEKT ZADATKA'

/** Zadana adresa kataloga projekata (isti host kao TaskManager API). */
const PROJECTS_API = 'http://localhost:17781/api/projects'

/**
 * Uputa BEZ konkretne vrijednosti — pripada zajedničkom dijelu predloška
 * (blok TASKMANAGER PROTOCOL). Mora biti bajt-u-bajt ista za svaki spawn,
 * inače pada keš-prefiks; zato ne prima ništa osim adrese API-ja.
 */
export function projectProtocolInstruction(apiBase = 'http://localhost:17781/api/tasks'): string {
  return `PROJEKT: zadatak na kojem radiš pripada projektu naveden na KRAJU ovog prompta
(odjeljak „${PROJECT_TAIL_HEADING}"). Kad SAM stvaraš novi zadatak, OBAVEZNO proslijedi taj isti projekt:
  curl -s -X POST ${apiBase} -H 'Content-Type: application/json' \\
    -d '{"title":"…","description":"…","assignee":"…","projectId":"<projectId s kraja prompta>"}'
Polje je \`projectId\` (radi i snake alias \`project_id\`). Bez njega zadatak pada u pretinac
${INBOX_PROJECT_ID} i ispada iz izvještaja i troška po projektu.`
}

/**
 * Jedina konkretna vrijednost u predlošku — MORA biti zadnja u promptu.
 * Bez projekta vraća prazan string, pa se prompt tada uopće ne mijenja
 * (spawnovi bez zadatka zadržavaju stari, već keširani oblik).
 */
export function renderProjectTail(projectId?: string | null, projectName?: string | null): string {
  const id = (projectId || '').trim()
  if (!id) return ''
  const name = (projectName || '').trim()
  const label = name && name !== id ? `${id} (${name})` : id
  const inboxNote = id === INBOX_PROJECT_ID
    ? `\nOvo je pretinac za zadatke bez projekta. Ako iz posla vidiš kojem projektu zadatak zapravo pripada, javi to u rezultatu.`
    : ''
  return `\n\n---\n${PROJECT_TAIL_HEADING}\nprojectId: ${label}${inboxNote}\n`
}

/**
 * Ime projekta iz kataloga, s keširanjem u memoriji (katalog se mijenja rijetko,
 * a prompt se gradi na svakom spawnu). Nikad ne baca — ime je ukras, ID je bit;
 * ako katalog ne odgovori, prompt i dalje nosi ispravan `projectId`.
 */
const nameCache = new Map<string, string | null>()

export async function fetchProjectName(
  projectId?: string | null,
  apiBase = PROJECTS_API,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const id = (projectId || '').trim()
  if (!id) return null
  if (nameCache.has(id)) return nameCache.get(id) ?? null
  let name: string | null = null
  try {
    const res = await fetchImpl(`${apiBase}/${encodeURIComponent(id)}`)
    if (res.ok) {
      const p = await res.json() as { name?: string }
      name = typeof p?.name === 'string' && p.name.trim() ? p.name.trim() : null
    }
  } catch {
    name = null
  }
  nameCache.set(id, name)
  return name
}

/** Testni pomoćnik — čisti keš imena (produkcija ga ne zove). */
export function _clearProjectNameCache(): void {
  nameCache.clear()
}

/**
 * Skraćenica za daemone: dohvati ime i složi završni odjeljak u jednom koraku.
 * Bez projekta ne radi ni HTTP poziv.
 */
export async function buildProjectTail(
  projectId?: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const id = (projectId || '').trim()
  if (!id) return ''
  return renderProjectTail(id, await fetchProjectName(id, PROJECTS_API, fetchImpl))
}
