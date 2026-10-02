/**
 * `sustavPutanja()` — repozitorij sustava domaćina samo iz `TM_SUSTAV_DIR` (TASK-5109).
 *
 * Paket je ranije alate tražio i u `~/app/<naš repozitorij>/tools/` — mapa koja postoji samo
 * na našem stroju. Ugovor: bez varijable nema vanjske putanje (`null`), s varijablom je
 * putanja relativna na nju; varijabla se čita pri svakom pozivu, ne pri uvozu modula.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'path'
import { PAKET_DIR, sustavPutanja } from '../src/core/paths'

const prije = process.env.TM_SUSTAV_DIR
afterEach(() => {
  if (prije === undefined) delete process.env.TM_SUSTAV_DIR
  else process.env.TM_SUSTAV_DIR = prije
})

describe('sustavPutanja', () => {
  test('bez TM_SUSTAV_DIR nema vanjske putanje', () => {
    delete process.env.TM_SUSTAV_DIR
    expect(sustavPutanja('tools/odlucitelj.py')).toBeNull()
  })

  test('prazna varijabla je isto što i nepostavljena', () => {
    process.env.TM_SUSTAV_DIR = '   '
    expect(sustavPutanja('tools/odlucitelj.py')).toBeNull()
  })

  test('s TM_SUSTAV_DIR putanja je relativna na nju', () => {
    process.env.TM_SUSTAV_DIR = '/srv/sustav'
    expect(sustavPutanja('tools/odlucitelj.py')).toBe(join('/srv/sustav', 'tools/odlucitelj.py'))
  })

  test('PAKET_DIR je korijen paketa (u njemu je package.json)', async () => {
    expect(await Bun.file(join(PAKET_DIR, 'package.json')).exists()).toBe(true)
  })
})
