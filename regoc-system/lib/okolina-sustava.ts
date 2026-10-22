/**
 * okolina-sustava.ts — TASK-5700 (plan Mac v3 K3a/P11): sve što je vezano uz JEDAN stroj
 * (adrese Ollame i ChromaDB-a, git identitet, Telegram chat i uid-ovi, URL ploče, banka
 * memorije, HOME glavnog stroja) čita se iz postavki, a ne iz koda.
 *
 * Kod kompleta tako ide na GitHub bez naših adresa i imena (brane `gradi_komplet.sh --javno`),
 * a glavni stroj i čvorovi zadržavaju isto ponašanje jer vrijednosti dolaze iz:
 *   - `config/okolina.json` (identitet; javni izvoz ga NE nosi),
 *   - `memory-config.json` (ChromaDB, Ollama za RAG) i `models/model-config.json` (Ollama za modele).
 * Bez postavki vrijede lokalne zadane vrijednosti (127.0.0.1, localhost, bez ičijeg uid-a).
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { loadMemoryConfig } from '../tools/rag/lib/memory-config'

export interface TelegramGrupa { id: number; ime: string; projekt: string }

export interface Okolina {
  git: { name: string; email: string }
  plocaUrl: string
  /** grupe: poznate Telegram grupe (ime, projekt) — zadane postavke ulaza poruka (IngestGateConfig). */
  telegram: { chatRegoc: number; dopusteni: number[]; grupe: TelegramGrupa[] }
  memorijaBanka: string
  /** HOME glavnog stroja (za usporedbu koda čvora s glavnim, TmRazlike); prazno = nema. */
  glavniHome: string
}

export const OKOLINA_ZADANO: Okolina = Object.freeze({
  git: Object.freeze({ name: 'REGOC', email: 'regoc@localhost' }),
  plocaUrl: 'http://localhost:17781',
  telegram: Object.freeze({ chatRegoc: 0, dopusteni: [] as number[], grupe: [] as TelegramGrupa[] }),
  memorijaBanka: 'regoc',
  glavniHome: '',
}) as Okolina

const BANKA_RE = /^[a-z0-9_]{1,64}$/
const domaci = () => process.env.HOME || homedir()

export function okolinaPut(home = domaci()): string {
  return process.env.REGOC_OKOLINA || join(home, '.claude', 'regoc', 'config', 'okolina.json')
}

const tekst = (v: unknown, z: string) => (typeof v === 'string' && v.trim() ? v.trim() : z)
const broj = (v: unknown, z: number) => (typeof v === 'number' && Number.isFinite(v) ? v : z)

/** Postavke stroja; nepostojeća ili neispravna datoteka/polje → zadano (nikad ne baca). */
export function okolina(put = okolinaPut()): Okolina {
  let j: any = {}
  try { if (existsSync(put)) j = JSON.parse(readFileSync(put, 'utf-8')) ?? {} } catch { j = {} }
  const z = OKOLINA_ZADANO
  const dop = Array.isArray(j?.telegram?.dopusteni) && j.telegram.dopusteni.every((x: unknown) => typeof x === 'number')
    ? [...j.telegram.dopusteni] : [...z.telegram.dopusteni]
  const banka = tekst(j?.memorija_banka, z.memorijaBanka)
  const grupe: TelegramGrupa[] = (Array.isArray(j?.telegram?.grupe) ? j.telegram.grupe : [])
    .filter((g: any) => typeof g?.id === 'number' && Number.isFinite(g.id))
    .map((g: any) => ({ id: g.id, ime: tekst(g.ime, String(g.id)), projekt: tekst(g.projekt, '') }))
  return {
    git: { name: tekst(j?.git?.name, z.git.name), email: tekst(j?.git?.email, z.git.email) },
    plocaUrl: tekst(j?.ploca_url, z.plocaUrl).replace(/\/+$/, ''),
    telegram: { chatRegoc: broj(j?.telegram?.chat_regoc, z.telegram.chatRegoc), dopusteni: dop, grupe },
    memorijaBanka: BANKA_RE.test(banka) ? banka : z.memorijaBanka,
    glavniHome: tekst(j?.glavni_home, z.glavniHome).replace(/\/+$/, ''),
  }
}

interface MemorijaAdrese { ollamaHost: string; chromaHost: string; chromaPort: number }
interface Opcije { home?: string; memorija?: MemorijaAdrese; reload?: boolean }

const memorija = (o: Opcije): MemorijaAdrese => o.memorija ?? loadMemoryConfig({ reload: o.reload }).rag

/** Ollama: OLLAMA_HOST → model-config `providers.ollama.baseUrl` → memory-config `ollamaHost`. */
export function ollamaUrl(o: Opcije = {}): string {
  const env = process.env.OLLAMA_HOST
  if (env && env.trim()) return env.trim().replace(/\/+$/, '')
  try {
    const mc = JSON.parse(readFileSync(join(o.home ?? domaci(), '.claude/regoc/models/model-config.json'), 'utf-8'))
    const u = mc?.providers?.ollama?.baseUrl
    if (typeof u === 'string' && u.trim()) return u.trim().replace(/\/+$/, '')
  } catch {}
  return memorija(o).ollamaHost.replace(/\/+$/, '')
}

/** ChromaDB iz memory-configa (CHROMA_HOST/CHROMA_PORT ga nadjačavaju unutar loadMemoryConfig). */
export function chromaUrl(o: Opcije = {}): string {
  const m = memorija(o)
  return `http://${m.chromaHost}:${m.chromaPort}`
}
