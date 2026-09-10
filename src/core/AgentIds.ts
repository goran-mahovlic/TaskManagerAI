/**
 * AgentIds — tko smije biti nositelj zadatka. Popis je PODATAK, ne kod.
 *
 * ZAŠTO OVA DATOTEKA POSTOJI. Do 10.09.2026. je popis dopuštenih imena bio zatvoren
 * `z.enum` u `src/zod/schemas/task.ts` s imenima NAŠIH jedanaest agenata. Korisnik koji
 * doslovce slijedi `docs/INSTALL.md` i postavi vlastiti tim dobivao je na
 * `POST /api/tasks {"assignee":"ana"}` odgovor `400 invalid_enum_value` — dokumentacija je
 * obećavala tuđi tim, a kod je priznavao samo naš (nalaz N1,
 * `docs/QA_E2E_SAMOSTALNOST_2026-09-10.md`). To je ista vrsta kvara kao tuđi `$HOME` kao
 * zadana vrijednost: naša instalacija upisana u paket.
 *
 * KAKO SE POPIS RAZRJEŠAVA (jedan lanac, po uzoru na `konfigPutanja` u `paths.ts`):
 *
 *   1. `config/agents.json` (putanja preko `TM_AGENTS_CONFIG`) — registar orkestratora,
 *      glavni izvor istine: ondje ionako piše tko postoji i što radi;
 *   2. `TM_AGENTS` — imena odvojena zarezom, prečac za instalaciju bez orkestratora;
 *   3. `user` i `scheduler` — uvijek, njih piše sama jezgra (ne korisnik).
 *
 * Izvori se ZBRAJAJU (unija), ne pregaze. Prioritet bi vratio najčešći kvar prve
 * instalacije — „dvije istine o tome tko postoji" iz INSTALL.md §6: `TM_AGENTS` bez imena
 * iz `agents.json` odbio bi zadatke upravo onom agentu kojeg orkestrator pokreće.
 *
 * BEZ IJEDNOG IZVORA popis NIJE zatvoren: provjerava se samo OBLIK imena. Nema izvora
 * istine, pa nema ni protiv čega provjeravati — zatvoren popis tada bi značio ili tuđa
 * imena (naša, opet u paketu) ili odbijanje svakog nositelja u svježoj instalaciji. Čim
 * korisnik popis ikako izrazi, provjera se sama pooštri i hvata tipfelere.
 *
 * Autorica: Kosjenka (Architect), TASK-4808.
 */

import { loadAgents, agentsConfigPath } from './orchestrator/AgentRegistry'

/** Nositelji koje upisuje sam sustav — vrijede neovisno o korisnikovoj postavci. */
export const SUSTAVSKI_AGENTI = ['user', 'scheduler'] as const

/**
 * Dopušten oblik imena: mala slova, znamenke, `-` i `_`, počinje slovom, do 32 znaka.
 * Ovo NIJE popis nego higijena — ime završi u putanjama dnevnika, u SQL upitima i u
 * naslovu poruke, pa razmak, kosa crta ili prazan niz ondje nemaju što tražiti.
 */
export const OBLIK_AGENT_ID = /^[a-z][a-z0-9_-]{0,31}$/

export interface RazrijeseniAgenti {
  /** Dopuštena imena (mala slova, poredana). Prazno kad popis nije zatvoren. */
  popis: string[]
  /** Koji su izvori doprinijeli: `registar`, `TM_AGENTS`. Prazno = popis nije zatvoren. */
  izvori: string[]
  /** `true` = zatvoren popis (hvata tipfelere); `false` = provjerava se samo oblik. */
  strogo: boolean
}

/**
 * Predmemorija s kratkim rokom. Razrješavanje čita datoteku, a shema se poziva nekoliko
 * puta po HTTP zahtjevu; s druge strane, registar smije nastati POSLIJE pokretanja ploče
 * (korisnik ga stvara u koraku 6 instalacije), pa zamrznuta vrijednost ne dolazi u obzir.
 * Sekunda je kompromis: neprimjetna korisniku, a datoteku ne čita po svakom polju.
 */
const ROK_MS = 1000
let predmemorija: { u: number; r: RazrijeseniAgenti } | null = null

/** Zaboravi predmemoriju (test, ili promjena postavke u istom procesu). */
export function osvjeziDopusteneAgente(): void {
  predmemorija = null
}

function izRegistra(): string[] {
  try {
    return loadAgents(agentsConfigPath()).map(a => a.id.trim().toLowerCase()).filter(Boolean)
  } catch {
    return []
  }
}

function izOkruzja(): string[] {
  return String(process.env.TM_AGENTS || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
}

/** Razriješi popis dopuštenih nositelja (v. lanac u zaglavlju). */
export function dopusteniAgenti(): RazrijeseniAgenti {
  const sada = Date.now()
  if (predmemorija && sada - predmemorija.u < ROK_MS) return predmemorija.r

  const registar = izRegistra()
  const okruzje = izOkruzja()

  const izvori: string[] = []
  if (registar.length) izvori.push('registar')
  if (okruzje.length) izvori.push('TM_AGENTS')

  const popis = izvori.length
    ? [...new Set([...registar, ...okruzje, ...SUSTAVSKI_AGENTI])].sort()
    : []

  const r: RazrijeseniAgenti = { popis, izvori, strogo: izvori.length > 0 }
  predmemorija = { u: sada, r }
  return r
}

/** Smije li `id` biti nositelj? Usporedba ne razlikuje velika i mala slova. */
export function jeDopustenAgent(id: string): boolean {
  const ime = String(id ?? '').trim().toLowerCase()
  if (!OBLIK_AGENT_ID.test(ime)) return false
  const r = dopusteniAgenti()
  return r.strogo ? r.popis.includes(ime) : true
}

/** Rečenica koja korisniku kaže i ŠTO je krivo i GDJE se popis mijenja. */
export function objasnjenjeOdbijenogAgenta(id: string): string {
  const ime = String(id ?? '').trim()
  const r = dopusteniAgenti()
  if (!OBLIK_AGENT_ID.test(ime.toLowerCase())) {
    return `nositelj „${ime}" nije ispravno ime agenta (mala slova, znamenke, `
      + `„-" i „_", počinje slovom, do 32 znaka)`
  }
  return `nositelj „${ime}" nije na popisu agenata [${r.popis.join(', ')}]; `
    + `popis dolazi iz ${r.izvori.join(' + ')} (config/agents.json odn. TM_AGENTS) — `
    + `dopiši ga ondje ili ispravi ime`
}
