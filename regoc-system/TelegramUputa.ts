// ~/.claude/regoc/TelegramUputa.ts
//
// TASK-5024 (nastavak TASK-5013): Goranova poruka s Telegrama tipa „upiši Jeleni da koristi ILA”
// ili „reci Jeleni …” dok agent ima zadatak u tijeku završava kao UPUTA za taj zadatak
// (`POST /api/tasks/:id/uputa`, author=<pošiljatelj>), a ne kao novi zadatak ni kao progressNote.
//
// Odluke (docs/ADR-0013-uputa-s-telegrama.md):
//   O1 Namjera se prepoznaje u Klaudijevu ulazu (telegram_agent.ts), DETERMINISTIČKI, prije
//      direktnog prosljeđivanja REGOČu i prije Claude CLI-ja. Ne u RegocDaemon.classifyAndRoute
//      (tamo poruka stiže bez chata za odgovor i već je na putu prema novom zadatku) i ne u
//      Klaudijevu promptu (model bi odlučivao hoće li ubaciti tekst u tuđu sesiju).
//   O2 Jaki glagoli (upiši/dopiši/uputa) = uvijek uputa. Slabi (reci/javi/poruči/kaži) = uputa
//      SAMO ako agent ima zadatak u tijeku; inače se poruka vraća na stari put (novi nalog).
//   O3 Koji zadatak: izričit TASK-ID u poruci > TASK-ID iz poruke na koju Goran odgovara
//      (reply) > jedini zadatak u tijeku. Više kandidata bez odrednice → NE pogađa se:
//      Goran dobije popis i primjer kako napisati.
//   O4 Nema zadatka u tijeku (jaki glagol) → uputa se NE sprema, Goran dobije objašnjenje.
//   O5 Potvrda ide u isti chat dvaput: odmah „spremljena, čeka dostavu”, pa „dostavljena”
//      kad hook preuzme uputu (ili „još čeka” nakon roka praćenja).
//
// Modul je čist (fetch i slanje se ubrizgavaju) da bi se mogao testirati bez Telegrama i API-ja.

export const AGENT_OBLICI: Record<string, { oblici: string[]; dativ: string }> = {
  kosjenka: { oblici: ['kosjenka', 'kosjenki', 'kosjenku'], dativ: 'Kosjenki' },
  jelena: { oblici: ['jelena', 'jeleni', 'jelenu'], dativ: 'Jeleni' },
  manda: { oblici: ['manda', 'mandi', 'mandu'], dativ: 'Mandi' },
  malik: { oblici: ['malik', 'maliku', 'malika'], dativ: 'Maliku' },
  potjeh: { oblici: ['potjeh', 'potjehu', 'potjeha'], dativ: 'Potjehu' },
  dora: { oblici: ['dora', 'dori', 'doru'], dativ: 'Dori' },
  gita: { oblici: ['gita', 'giti', 'gitu'], dativ: 'Giti' },
  grga: { oblici: ['grga', 'grgi', 'grgu'], dativ: 'Grgi' },
  emard: { oblici: ['emard', 'emardu', 'emarda'], dativ: 'Emardu' },
}

const JAKI = ['upi[sš]i', 'dopi[sš]i', 'uputa']
const SLABI = ['reci', 'javi', 'poru[cč]i', 'ka[zž]i']
const TASK_RE = /TASK-\d+/gi

export interface UputaNamjera {
  agent: string
  tekst: string
  /** jaki glagol (upiši/dopiši/uputa) — uputa i kad agent nema zadatak (pa odbijanje) */
  jaka: boolean
  taskId: string | null
}

const oblikUAgent = new Map<string, string>()
for (const [id, { oblici }] of Object.entries(AGENT_OBLICI)) for (const o of oblici) oblikUAgent.set(o, id)

const NAMJERA_RE = new RegExp(
  '^\\s*(' + [...JAKI, ...SLABI].join('|') + ')\\s+(?:za\\s+)?(' + [...oblikUAgent.keys()].join('|') + ')(?![a-zčćžšđ])' +
  '\\s*(?:(?:za|na)\\s+)?\\(?\\s*(TASK-\\d+)?\\s*\\)?\\s*[,:\\-–—]?\\s*(?:da\\s+)?([\\s\\S]*)$',
  'i',
)

/** Prepoznaje „upiši Jeleni da …”, „reci Grgi: …”, „uputa za Jelenu TASK-5009: …”. */
export function prepoznajUputu(text: string): UputaNamjera | null {
  const m = (text || '').match(NAMJERA_RE)
  if (!m) return null
  const glagol = m[1].toLowerCase()
  const agent = oblikUAgent.get(m[2].toLowerCase())
  const tekst = (m[4] || '').trim()
  if (!agent || !tekst) return null
  const jaka = JAKI.some(j => new RegExp(`^${j}$`, 'i').test(glagol))
  return { agent, tekst, jaka, taskId: m[3] ? m[3].toUpperCase() : null }
}

export interface Kandidat { id: string; title?: string; assignee?: string; status?: string }

export type Razrjesenje =
  | { vrsta: 'jedan'; taskId: string; izvor: 'poruka' | 'odgovor' | 'jedini' }
  | { vrsta: 'vise'; kandidati: Kandidat[] }
  | { vrsta: 'nijedan' }

/** O3: izričit ID > ID iz poruke na koju se odgovara > jedini kandidat. Nikad ne pogađa. */
export function razrijesiZadatak(namjera: UputaNamjera, kandidati: Kandidat[], replyText?: string | null): Razrjesenje {
  if (namjera.taskId) return { vrsta: 'jedan', taskId: namjera.taskId, izvor: 'poruka' }
  const ids = new Set(kandidati.map(k => k.id.toUpperCase()))
  if (replyText) {
    const uOdgovoru = [...new Set((replyText.match(TASK_RE) || []).map(s => s.toUpperCase()))].filter(id => ids.has(id))
    if (uOdgovoru.length === 1) return { vrsta: 'jedan', taskId: uOdgovoru[0], izvor: 'odgovor' }
  }
  if (kandidati.length === 1) return { vrsta: 'jedan', taskId: kandidati[0].id, izvor: 'jedini' }
  if (kandidati.length === 0) return { vrsta: 'nijedan' }
  return { vrsta: 'vise', kandidati }
}

export interface UputaOkolina {
  apiBase: string
  fetch: typeof fetch
  timeoutMs?: number
}

async function api(env: UputaOkolina, path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), env.timeoutMs ?? 5000)
  try {
    const r = await env.fetch(env.apiBase + path, { ...init, signal: ctrl.signal })
    let body: any = null
    try { body = await r.json() } catch {}
    return { status: r.status, body }
  } finally { clearTimeout(t) }
}

export interface IshodUpute {
  /** true = poruka je obrađena ovdje (odgovor Goranu), NE ide dalje starim putem */
  obradjeno: boolean
  odgovor?: string
  taskId?: string
  uputaId?: number
}

function naslov(k: Kandidat): string {
  const t = (k.title || '').replace(/\s+/g, ' ').trim()
  return t.length > 70 ? t.slice(0, 69) + '…' : t
}

/**
 * Cijeli tok za jednu poruku. Vraća `obradjeno:false` kad poruka nije uputa (ili je slab
 * glagol bez zadatka / API nedostupan) — tada pozivatelj nastavlja starim putem.
 */
export async function obradiUputu(
  text: string,
  opts: { author: string; replyText?: string | null; env: UputaOkolina },
): Promise<IshodUpute> {
  const n = prepoznajUputu(text)
  if (!n) return { obradjeno: false }
  const ime = AGENT_OBLICI[n.agent].dativ
  const Ime = n.agent[0].toUpperCase() + n.agent.slice(1)
  const env = opts.env

  let kandidati: Kandidat[] = []
  try {
    if (n.taskId) {
      const r = await api(env, `/api/tasks/${encodeURIComponent(n.taskId)}`)
      if (r.status === 404) return { obradjeno: true, odgovor: `❌ ${n.taskId} ne postoji. Uputa nije spremljena.` }
      if (r.status !== 200 || !r.body) throw new Error(`HTTP ${r.status}`)
      const a = String(r.body.assignee || '').toLowerCase()
      if (a && a !== n.agent) {
        return { obradjeno: true, odgovor: `❌ ${n.taskId} ne pripada agentu ${ime} (izvršitelj: ${r.body.assignee}). Uputa nije spremljena.` }
      }
      kandidati = [r.body]
    } else {
      const r = await api(env, `/api/tasks?status=in_progress&assignee=${encodeURIComponent(n.agent)}`)
      if (r.status !== 200 || !Array.isArray(r.body)) throw new Error(`HTTP ${r.status}`)
      // API filtar assignee je obvezan; ipak provjeri, da tuđi zadatak nikad ne dobije uputu.
      kandidati = r.body.filter((t: any) => String(t.assignee || '').toLowerCase() === n.agent)
    }
  } catch (e: any) {
    if (!n.jaka) return { obradjeno: false }
    return { obradjeno: true, odgovor: `❌ TaskManager (17781) nije dostupan (${e?.message || e}). Uputa ${ime} nije spremljena, pošalji je ponovo.` }
  }

  const rj = razrijesiZadatak(n, kandidati, opts.replyText)
  if (rj.vrsta === 'nijedan') {
    if (!n.jaka) return { obradjeno: false } // O2: „reci Jeleni …” bez zadatka = stari put (novi nalog)
    return {
      obradjeno: true,
      odgovor: `ℹ️ ${Ime} trenutno nema zadatak u tijeku, pa uputa NIJE spremljena.\n`
        + `Za novi zadatak napiši „${Ime}, …”. `
        + `Za određeni zadatak: „upiši ${ime} TASK-1234: …”.`,
    }
  }
  if (rj.vrsta === 'vise') {
    const popis = rj.kandidati.map(k => `• ${k.id} — ${naslov(k)}`).join('\n')
    return {
      obradjeno: true,
      odgovor: `❓ ${Ime} ima ${rj.kandidati.length} zadatka u tijeku, uputa NIJE spremljena:\n${popis}\n\n`
        + `Napiši „upiši ${ime} ${rj.kandidati[0].id}: ${n.tekst.slice(0, 40)}${n.tekst.length > 40 ? '…' : ''}”.`,
    }
  }

  let r: { status: number; body: any }
  try {
    r = await api(env, `/api/tasks/${encodeURIComponent(rj.taskId)}/uputa`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: n.tekst, author: opts.author }),
    })
  } catch (e: any) {
    return { obradjeno: true, odgovor: `❌ Uputa ${ime} nije spremljena: TaskManager ne odgovara (${e?.message || e}).` }
  }
  if (r.status !== 201) {
    const razlog = r.body?.error || `HTTP ${r.status}`
    return { obradjeno: true, odgovor: `❌ Uputa za ${rj.taskId} nije spremljena: ${razlog}` }
  }
  const id = Number(r.body?.id ?? r.body?.instruction?.id)
  const k = kandidati.find(x => x.id.toUpperCase() === rj.taskId)
  return {
    obradjeno: true,
    taskId: rj.taskId,
    uputaId: Number.isFinite(id) ? id : undefined,
    odgovor: `📨 Uputa${Number.isFinite(id) ? ` #${id}` : ''} spremljena za ${rj.taskId}${k?.title ? ` („${naslov(k).replace(/[„“”"]/g, '')}”)` : ''}, agent: ${Ime}.\n`
      + `Stiže agentu uz njegov sljedeći alat; javim kad je preuzme.`,
  }
}

/**
 * O5: prati dostavu i javi u isti chat. Vraća 'dostavljeno' | 'ceka' | 'nepoznato'.
 * Nikad ne baca: pogreška API-ja se samo preskače do sljedećeg pokušaja.
 */
export async function pratiDostavu(
  taskId: string,
  uputaId: number,
  opts: { env: UputaOkolina; posalji: (tekst: string) => Promise<unknown>; intervalMs?: number; rokMs?: number; spavaj?: (ms: number) => Promise<void> },
): Promise<'dostavljeno' | 'ceka' | 'nepoznato'> {
  const interval = opts.intervalMs ?? 10_000
  const rok = opts.rokMs ?? 10 * 60_000
  const spavaj = opts.spavaj ?? ((ms: number) => new Promise<void>(res => setTimeout(res, ms)))
  let proteklo = 0
  let vidjena = false
  while (proteklo < rok) {
    await spavaj(interval)
    proteklo += interval
    try {
      const r = await api(opts.env, `/api/tasks/${encodeURIComponent(taskId)}/upute`)
      const u = (r.body?.instructions || []).find((x: any) => Number(x.id) === uputaId)
      if (!u) continue
      vidjena = true
      if (u.delivered_at) {
        const sesija = u.delivered_session ? ` (sesija ${String(u.delivered_session).slice(0, 8)})` : ''
        try { await opts.posalji(`📬 Uputa #${uputaId} dostavljena agentu na ${taskId}${sesija}.`) } catch {}
        return 'dostavljeno'
      }
    } catch {}
  }
  const min = Math.round(rok / 60_000)
  try {
    await opts.posalji(`⏳ Uputa #${uputaId} za ${taskId} još čeka nakon ${min} min (agent je u dugom alatu ili trenutno ne radi). `
      + `Dobit će je uz sljedeći alat ili pri sljedećem pokretanju zadatka; stanje je na ploči 17781.`)
  } catch {}
  return vidjena ? 'ceka' : 'nepoznato'
}
