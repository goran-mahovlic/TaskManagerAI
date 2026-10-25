/**
 * Znanje ČVORA (ADR-0006 §7): dokumenti `cvor/*` koje čvor gradi iz vlastite ploče, vlastitog
 * Telegrama i vlastitih postavki, i plan upisa korpusa u banku (§5.3, mjerilo Z4).
 *
 * Sve čiste funkcije — ulaz su već pročitani podaci, izlaz je tekst dokumenta. Ovdje NE vrijedi
 * brana općih uzoraka (chat id, PRJ-…): to su vlastiti podaci čvora i smiju u njegovu banku.
 * Vrijedi samo brana TAJNI — oblik ključa ili tokena u dokumentu = dokument se ne upisuje.
 */
import { createHash } from 'crypto'
import { naredbaRestarta } from '../core/platforma'

/** Oblici tajni (isti kao brana kompleta + česti tokeni + dugi heks). Vrijednost se nikad ne ispisuje. */
export const UZORCI_TAJNI: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{20}/, /sk-or-v1-[A-Za-z0-9]{20}/, /\bsk-[A-Za-z0-9]{32,}/,
  /\b\d{8,10}:AA[A-Za-z0-9_-]{30}/, /AKIA[0-9A-Z]{16}/, /-----BEGIN [A-Z ]*PRIVATE KEY/,
  /\bghp_[A-Za-z0-9]{30,}/, /\bglpat-[A-Za-z0-9_-]{20}/, /\bxox[abp]-[A-Za-z0-9-]{10,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, /\b[a-f0-9]{48,}\b/i,
  /\b(?:password|lozinka|passwd|api[_-]?key|token|secret|tajna)\s*[:=]\s*\S{8,}/i,
]

export const imaTajnu = (t: string): boolean => UZORCI_TAJNI.some(rx => rx.test(t))

export const sha = (t: string): string => createHash('sha256').update(t).digest('hex')

export interface Projekt { id: string; name: string; description?: string | null; status?: string; task_count?: number; completed_task_count?: number; in_progress_task_count?: number }

export function dokumentProjekti(cvor: string, projekti: Projekt[]): string {
  const r = [`# Projekti na ploči čvora ${cvor}`, '',
    `Ovo su JEDINI projekti ovog čvora. ID projekta (PRJ-…) vrijedi samo na ploči čvora ${cvor}; drugi sustavi imaju svoje projekte s istim oblikom ID-a.`, '']
  for (const p of [...projekti].sort((a, b) => a.id.localeCompare(b.id))) {
    const opis = (p.description || '').replace(/\s+/g, ' ').trim().slice(0, 400)
    r.push(`## ${p.id} — ${p.name}`,
      `Projekt ${p.id} („${p.name}") ima stanje ${p.status || 'nepoznato'}, ukupno ${p.task_count ?? 0} zadataka, `
      + `od toga ${p.completed_task_count ?? 0} završenih i ${p.in_progress_task_count ?? 0} u radu.${opis ? ` Opis: ${opis}` : ''}`, '')
  }
  return r.join('\n').trimEnd() + '\n'
}

export interface Zadatak { id: string; title: string; status: string; assignee?: string | null; project_id?: string | null; projectId?: string | null; result_summary?: string | null; resultSummary?: string | null; completed_at?: string | null; updated_at?: string | null }

/**
 * Zatvoren zadatak → kratak dokument (naslov, projekt, izvršitelj, prvih ~2 KB rezultata).
 * `null` = PUNI tekst (prije skraćivanja) nosi oblik tajne — skraćivanje ne smije prepoloviti tajnu
 * pa je pustiti kroz branu.
 */
export function dokumentZadatak(cvor: string, z: Zadatak, najvise = 2000): string | null {
  const projekt = z.projectId || z.project_id || 'bez projekta'
  const sirovo = z.resultSummary || z.result_summary || ''
  if (imaTajnu(`${z.title}\n${sirovo}`)) return null
  const rez = sirovo.replace(/```[\s\S]*?```/g, '[blok koda izostavljen]').trim()
  return [`# Zadatak ${z.id} na čvoru ${cvor}: ${z.title}`, '',
    `Zadatak ${z.id} („${z.title}") u projektu ${projekt} izvršio je ${z.assignee || 'nepoznat izvršitelj'}; završen ${(z.completed_at || z.updated_at || '').slice(0, 10) || 'nepoznato kad'}.`,
    '', rez ? `Rezultat (skraćeno):\n${rez.slice(0, najvise)}${rez.length > najvise ? ' …' : ''}` : 'Rezultat nije zapisan.', ''].join('\n')
}

export interface Agent { id: string; name?: string; fullName?: string; role?: string; description?: string; skills?: string[]; vidljivost?: string; hidden?: boolean }

/** Agenti iz registra ČVORA (model i stanje nisu ovdje — mijenjaju se; uloga i vještine jesu). */
export function dokumentAgenti(cvor: string, agenti: Agent[]): string {
  const r = [`# Agenti na čvoru ${cvor}`, '', `Registar agenata čvora ${cvor} ima ${agenti.length} agenata. Agent se pokreće na zahtjev kad zadatak na ploči čvora ima njegov id kao izvršitelja.`, '']
  for (const a of agenti) {
    const ime = a.fullName || a.name || a.id
    const vj = (a.skills || []).slice(0, 12)
    r.push(`## ${ime} (\`${a.id}\`)`, `${ime} (\`${a.id}\`) je ${a.role || 'agent'}.${a.description ? ` ${String(a.description).trim().slice(0, 300)}` : ''}`
      + (vj.length ? ` Vještine: ${vj.join(', ')}.` : ''), '')
  }
  return r.join('\n').trimEnd() + '\n'
}

export interface StanjeCvora {
  cvor: string
  mogucnosti: Record<string, boolean>
  banka: string
  paketVerzija?: string
  paketCommit?: string
  servisi?: Array<{ unit: string; opis: string; aktivan: string }>
  mape?: Record<string, string>
  ploca?: string
  /** OS čvora (`process.platform`); zadano: ovaj stroj. */
  os?: string
}

const OPIS_MOG: Record<string, [string, string]> = {
  rag: ['RAG (ChromaDB/pgvector kolekcije) je uključen', 'RAG NIJE uključen — memorija je samo Hindsight banka, a za činjenice o sustavu čitaj memoriju i datoteke'],
  memorija: ['Hindsight memorija radi', 'Hindsight memorija trenutačno ne odgovara'],
  nextcloud: ['Nextcloud je spojen', 'Nextcloud NIJE spojen — dokumenti ostaju na disku i šalju se kao privitak'],
  docuseal: ['DocuSeal (potpisivanje) je spojen', 'DocuSeal NIJE spojen — potpisivanja nema'],
  glas: ['glasovni servis (STT/TTS) radi', 'glasovnog servisa nema'],
  ollama: ['lokalni modeli (Ollama) su dostupni', 'lokalnih modela (Ollama) nema'],
  // TASK-5795: čitanje weba (web) i objava (internet) su dvije mogućnosti — „objava nije dopuštena"
  // model je čitao kao zabranu i pretraživanja.
  web: ['čitanje weba je dopušteno: smiješ pretraživati internet (WebSearch) i dohvaćati stranice (WebFetch) za odgovor, uz navođenje izvora',
    'čitanje weba nije uključeno (vlasnik ga uključuje postavkom TM_INTERNET=citanje)'],
  internet: ['dopuštena je objava na internet (uz pravila vlasnika)',
    'objava na internet (GitHub, javni linkovi) traži odobrenje vlasnika — to se odnosi samo na objavu, ne na čitanje weba'],
  root: ['čvor ima root ovlasti', 'čvor nema root ovlasti'],
}

export function dokumentStanje(s: StanjeCvora): string {
  const r = [`# Stanje i mogućnosti čvora ${s.cvor}`, '', `Ovo je opis čvora ${s.cvor}: što na njemu radi, gdje su mape i kako se njime upravlja.`, '', '## Mogućnosti']
  for (const [k, v] of Object.entries(s.mogucnosti)) {
    const o = OPIS_MOG[k]
    r.push(`- Na čvoru ${s.cvor} ${o ? o[v ? 0 : 1] : `${k}: ${v ? 'da' : 'ne'}`}.`)
  }
  r.push('', '## Memorija', `Memorija čvora ${s.cvor} je Hindsight banka \`${s.banka}\`. Banka zna opći sustav REGOČ (dokumenti \`sustav/*\`) i ovaj čvor (dokumenti \`cvor/*\`: projekti, zatvoreni zadaci, agenti, razgovori). Druge banke čvoru nisu dostupne.`)
  if (s.paketVerzija || s.paketCommit) r.push('', '## Paket', `Ploča i daemon čvora rade iz paketa TaskManagerAI${s.paketVerzija ? ` verzije ${s.paketVerzija}` : ''}${s.paketCommit ? ` (commit ${s.paketCommit})` : ''}.`)
  if (s.ploca) r.push('', '## Ploča', `Ploča (TaskManager) čvora je na ${s.ploca}; REST API zadataka je ${s.ploca}/api/tasks, projekata ${s.ploca}/api/projects. Uputa agentu u radu ide preko POST /api/tasks/<ID>/uputa.`)
  // TASK-5509: odgovor na dolazni mail — samo preko ploče (tajnu drži ploča, nalog je čovjekov).
  if (s.ploca) r.push('', '## Odgovor na dolazni mail', `Na čvoru ${s.cvor} odgovor na dolazni mail ide ISKLJUČIVO preko ploče: curl -s -X POST ${s.ploca}/api/email/posalji -H 'Content-Type: application/json' -H "X-Regoc-Nalog: $TM_NALOG_POTEZA" -d '{"odgovorNa":"<IMAP UID iz „[mail N]”>","tekst":"…","privitci":["/apsolutna/putanja"]}'. Ploča sama bira primatelja (pošiljatelj tog maila ili Reply-To), uvijek stavlja vlasnika u CC (postavka e-pošte), predmet „Re: …" i nit (In-Reply-To/References); privitci smiju samo iz radne mape chata, iz privitci/<chat> ili iz mape tog maila, uz strop veličine; odgovara se samo na mail obaviješten u chatu naloga. Nalog poteza ($TM_NALOG_POTEZA) dobiva samo potez koji je pokrenuo dopušteni čovjek na razini puno — jednokratan, vrijedi dok potez traje; bot-poruka, autonomija i agenti ga nemaju, pa im ploča slanje odbija. Nikad vlastita skripta za slanje ni čitanje SMTP lozinke (razina puno tajne namjerno ne vidi). Ako ploča odbije, javi doslovan razlog iz polja greska. Proba (X-Regoc-Proba) vanjskoj adresi ne šalje ništa — ploča vrati samo pripremu.`)
  if (s.mape && Object.keys(s.mape).length) {
    r.push('', '## Mape')
    for (const [k, v] of Object.entries(s.mape)) r.push(`- ${k}: \`${v}\``)
  }
  if (s.servisi?.length) {
    const mac = (s.os ?? process.platform) === 'darwin'
    const vrsta = mac ? 'LaunchDaemoni (launchd, oznaka hr.regoc.<ime>)' : 'systemd korisničke jedinice'
    r.push('', '## Servisi', `Servisi čvora su ${vrsta}; restart je \`${naredbaRestarta(mac ? '<ime>' : '<jedinica>', { os: s.os })}\` i smije SAMO kad je na ploči 0 zadataka u statusu in_progress (inače aktivni zadaci padaju). Iz spawna agenta restart ploče i daemona nije dopušten.`)
    // Bez trenutnog stanja jedinice: dokument bi se mijenjao svaki prolaz i trošio retain.
    for (const u of s.servisi) r.push(`- \`${u.unit}\`: ${u.opis}`)
  }
  return r.join('\n') + '\n'
}

export interface PotezRazgovora { ts: string; smjer: string; posiljateljIme?: string; posiljateljId?: string; tekst?: string; dokumenti?: unknown }

/**
 * Dnevni zapis razgovora jednog chata → dokument za banku (§7.2). Tekst poteza skraćen, privitci
 * samo imenom. `null` = dan sadrži oblik tajne i NE ide u banku (javlja se pozivatelju).
 */
export function dokumentRazgovor(cvor: string, ime: string, chat: string, datum: string, potezi: PotezRazgovora[], najviseZnakova = 800): { sadrzaj: string | null; tajna: boolean; poteza: number } {
  const redovi: string[] = []
  let tajna = false
  for (const p of potezi) {
    const t = String(p.tekst || '').replace(/\s+/g, ' ').trim()
    if (!t) continue
    if (imaTajnu(t)) tajna = true // puni tekst, prije skraćivanja
    const tko = p.smjer === 'izlaz' ? ime : (p.posiljateljIme || p.posiljateljId || 'korisnik')
    const vrijeme = (p.ts || '').slice(11, 16)
    redovi.push(`- ${vrijeme} ${tko}${p.smjer === 'procitano' ? ' (nije se obraćao botu)' : ''}: ${t.slice(0, najviseZnakova)}${t.length > najviseZnakova ? ' …' : ''}`)
  }
  if (!redovi.length) return { sadrzaj: null, tajna: false, poteza: 0 }
  const sadrzaj = [`# Razgovor u Telegram chatu ${chat} na čvoru ${cvor}, ${datum}`, '',
    `Zapis razgovora bota ${ime} u chatu ${chat} dana ${datum}. Izvuci odluke, imenovane projekte i zadatke te tko je što tražio; ne prepisuj svaku poruku.`, '', ...redovi, ''].join('\n')
  if (tajna || imaTajnu(sadrzaj)) return { sadrzaj: null, tajna: true, poteza: redovi.length }
  return { sadrzaj, tajna: false, poteza: redovi.length }
}

/**
 * Redoslijed upisa po važnosti: vrata kvote mogu prekinuti upis usred korpusa, pa prvo ide ono bez
 * čega čvor ne zna sebe ni pravila — znanje čvora, ručni sloj (pravila, tijekovi, ovlasti), alati,
 * tijekovi s koracima, pa tek onda opisi vještina.
 */
export function vaznost(id: string): number {
  if (id.startsWith('cvor/')) return id.startsWith('cvor/razgovor/') ? 1 : 0
  if (!id.startsWith('sustav/popis-')) return 2
  if (id.startsWith('sustav/popis-alati-')) return 3
  if (id.startsWith('sustav/popis-tijek')) return 4
  return 5
}

export interface Plan { novi: string[]; promijenjeni: string[]; nestali: string[]; isti: number }

/** Što upisati: id → sha korpusa prema id → sha zadnjeg upisa. Nestali `sustav/*` se brišu (Z4). */
/** Razgovori se ne brišu kad dnevni zapis istekne na disku — memorija ih nadživljava. */
const briseSeZadano = (id: string) => id.startsWith('sustav/') || (id.startsWith('cvor/') && !id.startsWith('cvor/razgovor/'))

export function planUpisa(korpus: Record<string, string>, stanje: Record<string, string>, briseSe = briseSeZadano): Plan {
  const novi: string[] = [], promijenjeni: string[] = []
  let isti = 0
  for (const [id, h] of Object.entries(korpus).sort()) {
    if (!(id in stanje)) novi.push(id)
    else if (stanje[id] !== h) promijenjeni.push(id)
    else isti++
  }
  const nestali = Object.keys(stanje).filter(id => !(id in korpus) && briseSe(id)).sort()
  const poVaznosti = (a: string, b: string) => vaznost(a) - vaznost(b) || a.localeCompare(b)
  return { novi: novi.sort(poVaznosti), promijenjeni: promijenjeni.sort(poVaznosti), nestali, isti }
}
