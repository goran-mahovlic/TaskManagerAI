/**
 * DezurniConfig — postavke dežurnog (rezervnog) modela, čitanje i pisanje s ploče.
 *
 * D4 iz `docs/PLAN-dezurni-fallback.md` §4: datoteka `config/dezurni.json` postoji i u pogonu
 * je na sva tri stroja, ali se model dosad mijenjao ručnim uređivanjem te datoteke. Ovdje je
 * jedini put kojim ploča smije u nju pisati.
 *
 * ZAŠTO BEZ RESTARTA: i most (`tools/Telegram/dezurni.ts` → `postavke()`) i alat
 * (`tools/dezurni.py` → `postavke()`) čitaju datoteku pri SVAKOM pozivu — nitko je ne kešira
 * u memoriji procesa. Zato je zapis na disk dovoljan, i zato ovaj modul ne smije uvesti keš:
 * keš bi bio jedina stvar koja bi zahtijevala restart.
 *
 * Autor: Grga (Designer), TASK-4633.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

export const DEZURNI_CONFIG_PATH = join(
  process.env.HOME || '/home/klaudio', '.claude/regoc/config/dezurni.json')

export interface DezurniPostavke {
  ukljucen: boolean
  provider: string
  model: string
  baseUrl: string
  okidac_uzastopnih_gresaka: number
  smije_podici: boolean
  razmak_straze_min: number
}

/** Zadano mora biti ISTO kao u `dezurni.py` (ZADANE_POSTAVKE) i `dezurni.ts` (ZADANE) —
 *  tri preslike zadanih vrijednosti su cijena toga što isti posao rade tri jezika. */
export const ZADANE_POSTAVKE: DezurniPostavke = {
  ukljucen: true,
  provider: 'ollama',
  model: 'qwen3:8b',
  baseUrl: 'http://192.168.10.4:11434',
  okidac_uzastopnih_gresaka: 2,
  smije_podici: true,
  razmak_straze_min: 30,
}

/** Most prema modelu zna govoriti samo Ollamin `/api/chat` (`dezurni.ts → ollama()`).
 *  Dok se ne napiše drugi pozivatelj, ponuditi drugog davatelja značilo bi ponuditi kvar. */
export const PODRZANI_PROVIDERI = ['ollama'] as const

export const GRANICE = {
  okidac_uzastopnih_gresaka: { min: 1, max: 10 },
  razmak_straze_min: { min: 5, max: 240 },
} as const

/** Uvijek svjež pročitaj s diska. Nepoznata polja iz datoteke se ČUVAJU (netko ih je upisao
 *  s razlogom), pa vraćamo i njih — ploča prikazuje samo ona koja poznaje. */
export function loadDezurniConfig(path: string = DEZURNI_CONFIG_PATH):
  DezurniPostavke & Record<string, unknown> {
  try {
    const sirovo = JSON.parse(readFileSync(path, 'utf-8'))
    if (!sirovo || typeof sirovo !== 'object' || Array.isArray(sirovo)) return { ...ZADANE_POSTAVKE }
    return { ...ZADANE_POSTAVKE, ...sirovo }
  } catch {
    return { ...ZADANE_POSTAVKE }
  }
}

export interface Provjera {
  ok: boolean
  greske: string[]
  zakrpa: Partial<DezurniPostavke>
}

/**
 * Provjeri zakrpu s ploče. Prihvaća SAMO poznata polja — tipfeler u imenu polja tiho bi
 * stvorio mrtvu postavku koju nitko ne čita (isti kvar koji je `progress_notes` gutao).
 */
export function validateDezurniPatch(tijelo: unknown): Provjera {
  const greske: string[] = []
  const zakrpa: Record<string, unknown> = {}
  if (!tijelo || typeof tijelo !== 'object' || Array.isArray(tijelo)) {
    return { ok: false, greske: ['Očekivan je JSON objekt s postavkama'], zakrpa: {} }
  }
  const t = tijelo as Record<string, unknown>
  const dopustena = Object.keys(ZADANE_POSTAVKE)

  for (const kljuc of Object.keys(t)) {
    if (!dopustena.includes(kljuc)) {
      greske.push(`Nepoznato polje: ${kljuc} (dopušteno: ${dopustena.join(', ')})`)
    }
  }

  for (const kljuc of ['ukljucen', 'smije_podici'] as const) {
    if (kljuc in t) {
      if (typeof t[kljuc] !== 'boolean') greske.push(`${kljuc} mora biti true ili false`)
      else zakrpa[kljuc] = t[kljuc]
    }
  }

  if ('provider' in t) {
    const v = String(t.provider || '').trim()
    if (!(PODRZANI_PROVIDERI as readonly string[]).includes(v)) {
      greske.push(`provider mora biti jedan od: ${PODRZANI_PROVIDERI.join(', ')} ` +
        '(most prema modelu zna samo Ollamin /api/chat)')
    } else zakrpa.provider = v
  }

  if ('model' in t) {
    const v = String(t.model ?? '').trim()
    if (!v) greske.push('model ne smije biti prazan')
    else if (v.length > 120) greske.push('model je predugačak (najviše 120 znakova)')
    else zakrpa.model = v
  }

  if ('baseUrl' in t) {
    const v = String(t.baseUrl ?? '').trim().replace(/\/+$/, '')
    if (!/^https?:\/\/[^\s]+$/.test(v)) greske.push('baseUrl mora biti oblika http://host:port')
    else zakrpa.baseUrl = v
  }

  for (const kljuc of ['okidac_uzastopnih_gresaka', 'razmak_straze_min'] as const) {
    if (kljuc in t) {
      const v = Number(t[kljuc])
      const g = GRANICE[kljuc]
      if (!Number.isInteger(v) || v < g.min || v > g.max) {
        greske.push(`${kljuc} mora biti cijeli broj ${g.min}–${g.max}`)
      } else zakrpa[kljuc] = v
    }
  }

  if (!greske.length && !Object.keys(zakrpa).length) {
    greske.push('Nijedna postavka nije poslana')
  }
  return { ok: greske.length === 0, greske, zakrpa: zakrpa as Partial<DezurniPostavke> }
}

/**
 * Spoji zakrpu s onim što je na disku i zapiši. Zapis ide preko privremene datoteke pa
 * `rename` — dežurni tu datoteku čita u trenutku kvara, a napola zapisan JSON značio bi da
 * upravo tada padne na zadane vrijednosti.
 */
export function saveDezurniConfig(
  zakrpa: Partial<DezurniPostavke>,
  path: string = DEZURNI_CONFIG_PATH,
): DezurniPostavke & Record<string, unknown> {
  const trenutno = loadDezurniConfig(path)
  const novo = { ...trenutno, ...zakrpa }
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(novo, null, 2) + '\n', 'utf-8')
  renameSync(tmp, path)
  return novo
}
