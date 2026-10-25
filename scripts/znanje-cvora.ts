#!/usr/bin/env bun
/**
 * Znanje čvora u njegovoj banci memorije (ADR-0006 §5.3, §6, §7) — radi NA ČVORU.
 *
 *   bun scripts/znanje-cvora.ts mogucnosti [--pisi]          # izmjeri → $TM_HOME/config/mogucnosti.json
 *   bun scripts/znanje-cvora.ts sastavi                      # znanje/sustav (render) + cvor/* → $TM_HOME/data/znanje/korpus
 *   bun scripts/znanje-cvora.ts upisi (--suho | --pisi) [--samo sustav|cvor] [--najvise N]
 *   bun scripts/znanje-cvora.ts osvjezi [--pisi]             # mogucnosti + sastavi + upisi (petlja/timer)
 *   bun scripts/znanje-cvora.ts banka [--pisi]               # stvori/uskladi banku: ime i misija čvora
 *   bun scripts/znanje-cvora.ts izvezi --u <datoteka.json>   # arhiva banke (dokumenti + činjenice), samo čitanje
 *
 * Zajedničke zastavice: `--banka <id>` i `--url <memorija>` (zadano: postavke ploče
 * memorijaBanka/memorijaUrl), `--instanca <env>` (zadano $TM_HOME/config/profil.instanca.env).
 *
 * Što ulazi (ADR-0006 §3): `sustav/*` = opći korpus iz paketa (`znanje/sustav`), render po
 * mogućnostima čvora; `cvor/*` = projekti, zatvoreni zadaci i agenti s ploče ČVORA, stanje i
 * mogućnosti čvora te dnevni razgovori iz NJEGOVA Telegrama (prekidač instance
 * `ZNANJE_RAZGOVOR` = off | shadow | on; shadow = dokument na disku, ne u banci).
 * Nikad: ništa s glavnog stroja osim `znanje/sustav` iz paketa; vrijednosti tajni (dan razgovora
 * s oblikom tajne se preskače).
 *
 * Izlazni kodovi: 0 OK · 1 dio dokumenata nije upisan · 2 neispravan poziv/ulaz · 3 vrata kvote
 * zatvorena (429) · 4 upis već radi (brava) · 5 brana (oblik tajne ili opći uzorak u sustav/*).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { branaKorpusa, renderZaCvor, type Mogucnost } from '../src/znanje/Korpus'
import { usluga, uslugeRegoc } from '../src/core/platforma'
import { internetCvora } from '../src/core/InternetCvora'
import {
  dokumentAgenti, dokumentProjekti, dokumentRazgovor, dokumentStanje, dokumentZadatak, imaTajnu,
  planUpisa, sha, vaznost, type PotezRazgovora,
} from '../src/znanje/Cvor'

const KORIJEN = join(import.meta.dir, '..')
const HOME = process.env.HOME || homedir()

// ─── okolina čvora ───────────────────────────────────────────────────────────

function citajEnv(put: string): Record<string, string> {
  const o: Record<string, string> = {}
  if (!existsSync(put)) return o
  for (const r of readFileSync(put, 'utf-8').split('\n')) {
    const m = r.replace(/^export\s+/, '').match(/^([A-Z][A-Z0-9_]*)=(.*)$/)
    if (m) o[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return o
}

const jsonPopis = (v: string | undefined): string[] => { try { const j = JSON.parse(v || '[]'); return Array.isArray(j) ? j.map(String) : [] } catch { return [] } }

interface Okolina {
  postavke: Record<string, string>
  inst: Record<string, string>
  tmHome: string
  ploca: string
  korpusDir: string
  stanjeDat: string
}

function okolina(instanca?: string): Okolina {
  const postavke = { ...citajEnv(join(KORIJEN, 'config', 'postavke.env')), ...process.env as Record<string, string> }
  const tmHome = postavke.TM_HOME || join(HOME, '.taskmanager')
  const inst = citajEnv(instanca || join(tmHome, 'config', 'profil.instanca.env'))
  return {
    postavke, inst, tmHome,
    ploca: `http://127.0.0.1:${postavke.TM_PORT || '17781'}`,
    korpusDir: join(tmHome, 'data', 'znanje', 'korpus'),
    stanjeDat: join(tmHome, 'data', 'znanje', 'stanje.json'),
  }
}

/** Mapa izvornog sustava: SUSTAV_DIR instance ili TM_SUSTAV_DIR; bez nje paket radi samo sa sobom (ADR-0001 O1.4). */
function sustavDirZa(o: Okolina): string {
  return (o.inst.SUSTAV_DIR || o.postavke.TM_SUSTAV_DIR || '').trim() || join(KORIJEN, 'nema-izvornog-sustava')
}

async function dohvatiJson(url: string, init?: RequestInit, rokMs = 15_000): Promise<{ status: number; j: any }> {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(rokMs) })
  let j: any = null
  try { j = await r.json() } catch { /* prazno */ }
  return { status: r.status, j }
}

async function memorijaPostavke(o: Okolina, a: Argumenti): Promise<{ url: string; banka: string }> {
  let url = a.url, banka = a.banka
  if (!url || !banka) {
    try {
      const { j } = await dohvatiJson(`${o.ploca}/api/config/razgovor`)
      url ||= j?.postavke?.memorijaUrl
      banka ||= j?.postavke?.memorijaBanka
    } catch { /* ploča ne odgovara */ }
  }
  url ||= 'http://127.0.0.1:17792'
  banka ||= o.inst.MEMORIJA_BANKA
  if (!banka) throw new Error('nema banke: --banka, postavka ploče memorijaBanka ili MEMORIJA_BANKA u instanci')
  return { url: url.replace(/\/+$/, ''), banka }
}

// ─── mogućnosti (§6.1) ───────────────────────────────────────────────────────

async function izmjeriMogucnosti(o: Okolina, mem: { url: string }): Promise<Record<string, boolean>> {
  const sustav = sustavDirZa(o)
  const m: Record<string, boolean> = {}
  // rag: isti izvor kao rag-gate (memory-config rag.enabled), uz TM_CHROMA_* koji ga uključuje u paketu.
  const gate = join(HOME, '.claude', 'skills', 'CORE', 'Tools', 'lib', 'rag-gate.ts')
  let rag = false
  if (existsSync(gate)) {
    const p = Bun.spawnSync([process.execPath, '-e', `import { ragUkljucen } from ${JSON.stringify(gate)}; console.log(ragUkljucen())`], { stdout: 'pipe', stderr: 'pipe' })
    rag = p.stdout.toString().trim() === 'true'
  }
  m.rag = rag || !!o.postavke.TM_CHROMA_HOST
  try { m.memorija = (await fetch(`${mem.url}/health`, { signal: AbortSignal.timeout(5000) })).ok } catch { m.memorija = false }
  // Vjerodajnice: SAMO ime ključa (vrijednost se ne čita u varijablu niti ispisuje).
  const cred = o.postavke.TM_CREDENTIALS || join(sustav, 'credentials.env')
  const imena = existsSync(cred) ? readFileSync(cred, 'utf-8').split('\n').map(r => r.replace(/^export\s+/, '').split('=')[0].trim()) : []
  m.nextcloud = imena.some(k => /^NEXTCLOUD_(URL|USER|USERNAME|PASSWORD|PASS|TOKEN)$/.test(k))
  m.docuseal = imena.some(k => /^DOCUSEAL_/.test(k))
  m.glas = usluga('regoc-voice') === 'active'
  let ollama = o.postavke.TM_OLLAMA_URL || o.postavke.OLLAMA_URL || ''
  if (!ollama) {
    try {
      const mc = JSON.parse(readFileSync(o.postavke.TM_MODEL_CONFIG || join(sustav, 'models', 'model-config.json'), 'utf-8'))
      ollama = mc?.providers?.ollama?.baseUrl || ''
    } catch { /* nema */ }
  }
  try { m.ollama = !!ollama && (await fetch(`${ollama.replace(/\/+$/, '')}/api/tags`, { signal: AbortSignal.timeout(5000) })).ok } catch { m.ollama = false }
  let capguard: boolean | null = null
  try {
    const { status, j } = await dohvatiJson(`${o.ploca}/api/capabilities`)
    if (status === 200 && j?.effective) capguard = !!j.effective.allow_internet
    m.root = !!j?.effective?.allow_root
  } catch { m.root = false }
  // TASK-5795: postavka čvora TM_INTERNET (macOS nema capguard) — čitanje weba ≠ objava.
  const net = internetCvora({ ...citajEnv(join(o.tmHome, 'config', 'postavke.env')), ...o.postavke }, capguard)
  m.web = net.citanje
  m.internet = net.objava
  return m
}

// ─── sastavi (§5.3, §7) ──────────────────────────────────────────────────────

type Korpus = Map<string, { sadrzaj: string; kontekst: string; oznake: string[] }>

const sigurno = (s: string) => s.replace(/[^\w.-]/g, '_')

function citajZapis(dat: string): PotezRazgovora[] {
  const out: PotezRazgovora[] = []
  for (const r of readFileSync(dat, 'utf-8').split('\n')) {
    if (!r.trim()) continue
    try { out.push(JSON.parse(r)) } catch { /* pokvaren redak */ }
  }
  return out
}

async function sastavi(o: Okolina, mem: { banka: string }, mog: Record<string, boolean>, ispis: (r: string) => void): Promise<{ korpus: Korpus; razgovorNaDisk: number; preskoceno: string[] }> {
  const cvor = o.inst.CVOR_IME || 'čvor'
  const sustavDir = sustavDirZa(o)
  const korpus: Korpus = new Map()
  const preskoceno: string[] = []
  const varijable = { SUSTAV_DIR: sustavDir, MEMORIJA_BANKA: mem.banka, HOME, TM_HOME: o.tmHome }
  const postoji = (p: string) => existsSync(p.replace(/^~(?=\/)/, HOME))

  // 1) opći korpus iz paketa
  const zs = join(KORIJEN, 'znanje', 'sustav')
  for (const f of existsSync(zs) ? readdirSync(zs).filter(x => x.endsWith('.md')).sort() : []) {
    const t = renderZaCvor(readFileSync(join(zs, f), 'utf-8'), { mogucnosti: mog as Partial<Record<Mogucnost, boolean>>, varijable, postoji })
    // Brana općih uzoraka i nad renderom: put na čvoru smije (HOME čvora), ništa drugo.
    const pog = branaKorpusa(t.replaceAll(HOME, '~').replaceAll(sustavDir.replace(HOME, '~'), '${SUSTAV_DIR}'), [])
    if (pog.length) { preskoceno.push(`sustav/${f} (brana: ${pog.map(p => p.kat).join(', ')})`); continue }
    const naslov = t.match(/^# (.+)$/m)?.[1] || f
    korpus.set(`sustav/${f.replace(/\.md$/, '')}`, { sadrzaj: t, kontekst: `Opći sustav REGOČ — ${naslov}`, oznake: ['sustav'] })
  }

  // 2) ploča čvora: projekti, zatvoreni zadaci
  const { j: projekti } = await dohvatiJson(`${o.ploca}/api/projects`)
  const pretinci = new Set<string>()
  if (Array.isArray(projekti)) {
    for (const p of projekti) if (/pretinac|bez projekta/i.test(p.name || '')) pretinci.add(p.id)
    korpus.set('cvor/projekti', { sadrzaj: dokumentProjekti(cvor, projekti), kontekst: `Projekti čvora ${cvor}`, oznake: ['cvor', 'projekti'] })
  } else preskoceno.push('cvor/projekti (ploča ne odgovara)')
  const { j: zadaci } = await dohvatiJson(`${o.ploca}/api/tasks?status=completed&limit=1000`, undefined, 60_000)
  if (Array.isArray(zadaci)) {
    for (const z of zadaci) {
      const pr = z.projectId || z.project_id
      if (!pr || pretinci.has(pr)) continue
      const d = dokumentZadatak(cvor, z)
      if (!d) { preskoceno.push(`cvor/zadatak/${z.id} (oblik tajne)`); continue }
      korpus.set(`cvor/zadatak/${z.id}`, { sadrzaj: d, kontekst: `Zatvoren zadatak ${z.id} na čvoru ${cvor}`, oznake: ['cvor', 'zadatak'] })
    }
  }

  // 3) agenti iz registra čvora
  try {
    const reg = JSON.parse(readFileSync(o.postavke.TM_AGENTS_REGISTRY || join(sustavDir, 'REGOC_AGENTS.json'), 'utf-8'))
    const lista = (Array.isArray(reg?.agents) ? reg.agents : Object.entries(reg?.agents || {}).map(([id, a]: any) => ({ id, ...a })))
      // Tajni agent (registar: visibility=secret) ne ide u banku koju čita razgovor (isto pravilo kao popis karte).
      .filter((a: any) => a && !a.hidden && !/tajn|secret|private|hidden/i.test(String(a.vidljivost || a.visibility || '')))
      .map((a: any) => ({ id: a.id, name: a.name, fullName: a.fullName || a.full_name, role: a.role || a.uloga, description: a.description || a.opis, skills: a.skills || a.vjestine }))
    if (lista.length) korpus.set('cvor/agenti', { sadrzaj: dokumentAgenti(cvor, lista), kontekst: `Agenti čvora ${cvor}`, oznake: ['cvor', 'agenti'] })
  } catch { preskoceno.push('cvor/agenti (registar nečitljiv)') }

  // 4) stanje čvora
  const servisi = uslugeRegoc().filter(u => !u.unit.startsWith('regoc-znanje')) // sam timer ne opisuje čvor
  const git = Bun.spawnSync(['git', '-C', KORIJEN, 'rev-parse', '--short', 'HEAD'], { stdout: 'pipe', stderr: 'pipe' }).stdout.toString().trim()
  let verzija = ''
  try { verzija = JSON.parse(readFileSync(join(KORIJEN, 'package.json'), 'utf-8')).version || '' } catch { /* */ }
  const mape = { 'izvorni sustav (daemon, registar, alati)': sustavDir.replace(HOME, '~'), 'paket TaskManagerAI': KORIJEN.replace(HOME, '~'),
    'podaci ploče i razgovora': o.tmHome.replace(HOME, '~'), 'vještine': '~/.claude/skills', 'kuke': '~/.claude/hooks' }
  korpus.set('cvor/stanje', { sadrzaj: dokumentStanje({ cvor, mogucnosti: mog, banka: mem.banka, paketVerzija: verzija, paketCommit: git, servisi, mape, ploca: o.ploca }),
    kontekst: `Stanje i mogućnosti čvora ${cvor}`, oznake: ['cvor', 'stanje'] })

  // 5) Telegram čvora — samo dopušteni chatovi, samo završeni dani (današnji se još mijenja)
  const nacin = (o.inst.ZNANJE_RAZGOVOR || 'shadow').trim()
  let razgovorNaDisk = 0
  if (nacin !== 'off') {
    const chatovi = new Set(jsonPopis(o.inst.TG_DOPUSTENI_CHATOVI).filter(c => c.startsWith('-')))
    const korijen = join(o.tmHome, 'data', 'razgovor', 'telegram')
    const danas = new Date().toISOString().slice(0, 10)
    // Razgovori prije čiste banke ponavljaju činjenice stare (propusne) banke — ne ulaze (ADR-0006 §14).
    const od = (o.inst.ZNANJE_RAZGOVOR_OD || '').trim()
    const ime = o.inst.RAZGOVOR_IME || 'bot'
    for (const chat of existsSync(korijen) ? readdirSync(korijen) : []) {
      if (!chatovi.has(chat)) continue
      for (const f of readdirSync(join(korijen, chat)).filter(x => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(x)).sort()) {
        const datum = f.slice(0, 10)
        if (datum >= danas || (od && datum < od)) continue
        const r = dokumentRazgovor(cvor, ime, chat, datum, citajZapis(join(korijen, chat, f)))
        if (r.tajna) { preskoceno.push(`cvor/razgovor/${chat}/${datum} (oblik tajne — dan se ne upisuje)`); continue }
        if (!r.sadrzaj) continue
        const id = `cvor/razgovor/${chat}/${datum}`
        if (nacin === 'on') korpus.set(id, { sadrzaj: r.sadrzaj, kontekst: `Razgovor u chatu ${chat}, ${datum}`, oznake: ['cvor', 'razgovor'] })
        else {
          const d = join(o.tmHome, 'data', 'znanje', 'razgovor-sjena', sigurno(chat))
          mkdirSync(d, { recursive: true })
          writeFileSync(join(d, `${datum}.md`), r.sadrzaj)
          razgovorNaDisk++
        }
      }
    }
  }

  // Brana tajni nad SVAKIM dokumentom korpusa, na jednom mjestu (i sustav/*, projekti, agenti, stanje).
  for (const [id, d] of korpus) if (imaTajnu(d.sadrzaj)) { korpus.delete(id); preskoceno.push(`${id} (oblik tajne)`) }

  // Zapis korpusa na disk čvora (pregled i otisci); stara slika se zamjenjuje.
  rmSync(o.korpusDir, { recursive: true, force: true })
  for (const [id, d] of korpus) {
    const p = join(o.korpusDir, `${id.split('/').map(sigurno).join('/')}.md`)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, d.sadrzaj)
  }
  ispis(`sastavljeno: ${korpus.size} dokumenata (sustav ${[...korpus.keys()].filter(k => k.startsWith('sustav/')).length}, cvor ${[...korpus.keys()].filter(k => k.startsWith('cvor/')).length})`
    + `, razgovor=${nacin}${razgovorNaDisk ? ` (${razgovorNaDisk} dana samo na disku)` : ''}${preskoceno.length ? `; preskočeno ${preskoceno.length}` : ''}`)
  preskoceno.forEach(p => ispis(`  preskočeno: ${p}`))
  return { korpus, razgovorNaDisk, preskoceno }
}

// ─── upis u banku (§5.3) ─────────────────────────────────────────────────────

interface StanjeUpisa { banka: string; dokumenti: Record<string, string>; zadnjiUpis?: string; zadnjeUskladjeno?: string }

function citajStanje(o: Okolina, banka: string): StanjeUpisa {
  try {
    const s = JSON.parse(readFileSync(o.stanjeDat, 'utf-8'))
    if (s.banka === banka) return s
  } catch { /* prvo */ }
  return { banka, dokumenti: {} }
}

function spremiStanje(o: Okolina, s: StanjeUpisa): void {
  mkdirSync(dirname(o.stanjeDat), { recursive: true })
  writeFileSync(o.stanjeDat + '.tmp', JSON.stringify(s, null, 1))
  Bun.spawnSync(['mv', o.stanjeDat + '.tmp', o.stanjeDat])
}

function brava(o: Okolina): (() => void) | null {
  const p = join(o.tmHome, 'data', 'znanje', 'upis.lock')
  mkdirSync(dirname(p), { recursive: true })
  if (existsSync(p)) {
    const pid = Number(readFileSync(p, 'utf-8').trim())
    try { process.kill(pid, 0); return null } catch { /* mrtva brava */ }
  }
  writeFileSync(p, String(process.pid))
  return () => { try { if (readFileSync(p, 'utf-8').trim() === String(process.pid)) rmSync(p) } catch { /* */ } }
}

async function upisi(o: Okolina, mem: { url: string; banka: string }, korpus: Korpus, a: Argumenti, ispis: (r: string) => void): Promise<number> {
  const api = `${mem.url}/v1/default/banks/${encodeURIComponent(mem.banka)}`
  const st = citajStanje(o, mem.banka)
  const hashevi = Object.fromEntries([...korpus].filter(([id]) => !a.samo || id.startsWith(a.samo + '/')).map(([id, d]) => [id, sha(d.sadrzaj)]))
  const stanjeOpsega = a.samo ? Object.fromEntries(Object.entries(st.dokumenti).filter(([id]) => id.startsWith(a.samo + '/'))) : st.dokumenti
  const plan = planUpisa(hashevi, stanjeOpsega)
  const zaUpis = [...plan.novi, ...plan.promijenjeni].sort((x, y) => vaznost(x) - vaznost(y)).slice(0, a.najvise ?? Infinity)
  ispis(`banka ${mem.banka}: novo ${plan.novi.length}, promijenjeno ${plan.promijenjeni.length}, nestalo ${plan.nestali.length}, isto ${plan.isti}`
    + (zaUpis.length < plan.novi.length + plan.promijenjeni.length ? ` (ovaj prolaz: ${zaUpis.length})` : ''))
  if (!a.pisi) { ispis('SUHO: ništa nije upisano (za upis --pisi)'); return 0 }
  const pusti = brava(o)
  if (!pusti) { ispis('upis već radi (brava) — preskačem'); return 4 }
  let neuspjelo = 0
  try {
    for (const id of plan.nestali) {
      const r = await fetch(`${api}/documents/${encodeURIComponent(id)}`, { method: 'DELETE', signal: AbortSignal.timeout(120_000) })
      if (r.ok || r.status === 404) { delete st.dokumenti[id]; ispis(`  obrisano ${id}`) } else { neuspjelo++; ispis(`  ERR brisanje ${id} http=${r.status}`) }
    }
    spremiStanje(o, st)
    for (const id of zaUpis) {
      const d = korpus.get(id)!
      if (imaTajnu(d.sadrzaj)) { neuspjelo++; ispis(`  PRESKOČENO ${id} — oblik tajne`); continue } // druga linija
      const t0 = performance.now()
      if (id in st.dokumenti) {
        // Isti obrazac kao dopuna naše banke: brisanje pa upis = čisto ponovno izvlačenje činjenica.
        await fetch(`${api}/documents/${encodeURIComponent(id)}`, { method: 'DELETE', signal: AbortSignal.timeout(120_000) }).catch(() => null)
      }
      const item = { content: d.sadrzaj, document_id: id, context: d.kontekst, tags: d.oznake, update_mode: 'replace',
        metadata: { izvor: id.startsWith('sustav/') ? 'paket' : 'cvor', cvor: o.inst.CVOR_IME || '' } }
      let r: Response
      try {
        r = await fetch(`${api}/memories`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [item], async: false }), signal: AbortSignal.timeout(30 * 60_000) })
      } catch (e: any) { neuspjelo++; ispis(`  ERR ${id} ${String(e?.message || e).slice(0, 120)}`); continue }
      const s = ((performance.now() - t0) / 1000).toFixed(1)
      if (r.status === 429) {
        let raz = ''
        try { raz = (await r.json() as any)?.razlog || '' } catch { /* */ }
        ispis(`STOP: vrata kvote zatvorena (${raz}) — upisano do sada se pamti, ostatak u sljedećem prolazu`)
        return 3
      }
      if (!r.ok) { neuspjelo++; ispis(`  ERR ${id} http=${r.status} ${s}s`); continue }
      st.dokumenti[id] = hashevi[id]
      st.zadnjiUpis = new Date().toISOString()
      spremiStanje(o, st)
      ispis(`  OK  ${id} ${s}s`)
    }
    // Prolaz bez greške = banka usklađena i kad nije bilo što upisati; bez upisa banka se pita
    // je li dostupna, inače mirni čvor nakon maxStarostSati izgleda kao da mu dotok ne radi.
    if (!neuspjelo && zaUpis.length === plan.novi.length + plan.promijenjeni.length) {
      const dostupna = zaUpis.length || plan.nestali.length
        || await fetch(`${api}/documents?limit=1`, { signal: AbortSignal.timeout(15_000) }).then(r => r.ok, () => false)
      if (dostupna) { st.zadnjeUskladjeno = new Date().toISOString(); spremiStanje(o, st) }
      else ispis('  banka ne odgovara — usklađenost nije potvrđena')
    }
  } finally { pusti() }
  return neuspjelo ? 1 : 0
}

// ─── banka i izvoz ───────────────────────────────────────────────────────────

function opisBanke(o: Okolina, banka: string) {
  const cvor = o.inst.CVOR_IME || 'čvor'
  const vlasnik = o.inst.VLASNIK_ULOGA_IME || 'vlasnik'
  return {
    name: `REGOČ — čvor ${cvor} (${banka})`,
    mission: o.inst.MEMORIJA_MISIJA || `Banka je memorija čvora ${cvor}. Zna OPĆI sustav REGOČ (agenti, pravila, tijekovi, alati i kako se koriste, TaskManager) i SAM ovaj čvor: njegove projekte, zatvorene zadatke, agente, mogućnosti i razgovore iz njegova Telegrama. ID-evi projekata i zadataka su ID-evi ploče ovog čvora. Drugi sustavi i čvorovi nisu u ovoj banci.`,
    retain_mission: `Izvlači činjenice o sustavu REGOČ i o čvoru ${cvor}: putanje, servise, agente i uloge, pravila, ovlasti, postupke, projekte i zadatke. Zadrži izvorni jezik (hrvatski) i doslovne nazive datoteka, naredbi i API putanja. Nikad ne izvlači vrijednosti tajni. Uloga „${vlasnik}" je vlasnik ovog čvora. NASLOV ODJELJKA JE UVJET svake rečenice ispod njega (npr. „Što smije samo uz vlasnikovo izričito odobrenje" → svaka činjenica počinje tim uvjetom; „Što sustav ne smije nikad" → činjenica sadrži „nikad ne smije"). Nikad ne pretvaraj zabranu ili uvjetnu ovlast u bezuvjetno „može". Ako dokument kaže da mogućnost na ovom čvoru NIJE uključena, to je činjenica o ovom čvoru.`,
  }
}

async function izvezi(mem: { url: string; banka: string }, u: string, ispis: (r: string) => void): Promise<number> {
  const api = `${mem.url}/v1/default/banks/${encodeURIComponent(mem.banka)}`
  const dokumenti: any[] = [], cinjenice: any[] = []
  for (let off = 0; ; off += 100) {
    const { status, j } = await dohvatiJson(`${api}/documents?limit=100&offset=${off}`, undefined, 60_000)
    if (status !== 200) { ispis(`ERR dokumenti http=${status}`); return 1 }
    const it = j?.items || []
    dokumenti.push(...it)
    if (it.length < 100) break
  }
  for (let off = 0; ; off += 500) {
    const { status, j } = await dohvatiJson(`${api}/memories/list?limit=500&offset=${off}`, undefined, 60_000)
    if (status !== 200) { ispis(`ERR činjenice http=${status}`); return 1 }
    const it = j?.items || []
    cinjenice.push(...it)
    if (it.length < 500) break
  }
  const { j: banke } = await dohvatiJson(`${mem.url}/v1/default/banks`)
  const opis = (banke?.banks || []).find((b: any) => b.bank_id === mem.banka) || null
  mkdirSync(dirname(u), { recursive: true })
  writeFileSync(u, JSON.stringify({ banka: mem.banka, izvezeno: new Date().toISOString(), opis, dokumenti, cinjenice }, null, 1))
  ispis(`izvezeno: ${dokumenti.length} dokumenata, ${cinjenice.length} činjenica → ${u} (${statSync(u).size} B)`)
  return 0
}

// ─── naredbeni redak ─────────────────────────────────────────────────────────

interface Argumenti { naredba: string; pisi: boolean; banka?: string; url?: string; instanca?: string; samo?: string; najvise?: number; u?: string }

function argumenti(argv: string[]): Argumenti {
  const [naredba, ...ost] = argv
  if (!['mogucnosti', 'sastavi', 'upisi', 'osvjezi', 'banka', 'izvezi'].includes(naredba || '')) throw new Error('naredba: mogucnosti | sastavi | upisi | osvjezi | banka | izvezi')
  const a: Argumenti = { naredba, pisi: false }
  for (let i = 0; i < ost.length; i++) {
    const x = ost[i]
    if (x === '--pisi') a.pisi = true
    else if (x === '--suho') a.pisi = false
    else if (['--banka', '--url', '--instanca', '--samo', '--u', '--najvise'].includes(x)) {
      const v = ost[++i]
      if (!v) throw new Error(`${x} traži vrijednost`)
      if (x === '--najvise') a.najvise = Number(v)
      else (a as any)[x.slice(2)] = v
    } else throw new Error(`nepoznata zastavica ${x}`)
  }
  if (a.samo && !['sustav', 'cvor'].includes(a.samo)) throw new Error('--samo sustav | cvor')
  if (a.naredba === 'izvezi' && !a.u) throw new Error('izvezi traži --u <datoteka.json>')
  return a
}

export async function glavna(argv: string[], ispis: (r: string) => void = console.log): Promise<number> {
  let a: Argumenti
  try { a = argumenti(argv) } catch (e: any) { ispis(`ODBIJENO: ${e.message}`); return 2 }
  const o = okolina(a.instanca)
  let mem: { url: string; banka: string }
  try { mem = await memorijaPostavke(o, a) } catch (e: any) { ispis(`ODBIJENO: ${e.message}`); return 2 }

  if (a.naredba === 'izvezi') return izvezi(mem, a.u!, ispis)
  if (a.naredba === 'banka') {
    const tijelo = opisBanke(o, mem.banka)
    if (!a.pisi) { ispis(`SUHO: PUT banke ${mem.banka}: ${tijelo.name}`); return 0 }
    const { status } = await dohvatiJson(`${mem.url}/v1/default/banks/${encodeURIComponent(mem.banka)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(tijelo) })
    ispis(`PUT banke ${mem.banka} → ${status}`)
    return status === 200 ? 0 : 1
  }

  const mog = await izmjeriMogucnosti(o, mem)
  if (a.naredba === 'mogucnosti') {
    ispis(JSON.stringify(mog))
    if (a.pisi) {
      const p = join(o.tmHome, 'config', 'mogucnosti.json')
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, JSON.stringify({ ...mog, izmjereno: new Date().toISOString() }, null, 1) + '\n')
      ispis(`zapisano ${p}`)
    }
    return 0
  }
  if (a.naredba === 'osvjezi' && a.pisi) {
    const p = join(o.tmHome, 'config', 'mogucnosti.json')
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify({ ...mog, izmjereno: new Date().toISOString() }, null, 1) + '\n')
  }
  const { korpus } = await sastavi(o, mem, mog, ispis)
  if (a.naredba === 'sastavi') return 0
  return upisi(o, mem, korpus, a, ispis)
}

if (import.meta.main) process.exit(await glavna(process.argv.slice(2)))
