/**
 * ChronoOrder — jedno pravilo poretka za cijeli TaskManager: NAJNOVIJE NA VRHU.
 *
 * Nalaz (vlasnik, 28.08.2026., TASK-3516): „Na našem task manageru sve mora biti
 * posloženo kronološki — najnovije na vrhu — to vrijedi i za taskove koje su
 * completed i za projekte i padajuće liste."
 *
 * Zašto zaseban modul: poredak se prije pisao na tri mjesta (TaskManagerSQL,
 * ProjectManager, HTML/JS ploče) i razilazio se. TASK-3513 traži isti kriterij
 * za projekte, pa ga oba zadatka sada uzimaju odavde umjesto da se pišu dvije
 * izvedbe istoga poretka.
 *
 * DVA ZAPISA VREMENA U BAZI (mjereno na data/regoc.db, 28.08.2026.):
 *   created_at   1260 ISO ('2026-08-28T11:07:02.561Z')
 *   updated_at   1253 SQLite ('2026-08-28 11:07:02') + 7 ISO
 *   completed_at  860 ISO
 * Oba zapisa nose ISTI (lokalni) sat — provjereno na TASK-3400, gdje su
 * created_at '…T14:37:13.270Z' i updated_at '… 14:37:13' isti trenutak.
 * Razlikuju se samo znakovi, a usporedba nizova na tome pada: 'T' (0x54) je
 * veći od razmaka (0x20), pa bi unutar istoga dana ISO zapis uvijek pobijedio
 * SQLite zapis bez obzira na sat. Zato svaku oznaku prvo svodimo na isti oblik.
 */

/** SQL izraz koji vremensku oznaku svodi na usporediv oblik 'YYYY-MM-DD HH:MM:SS[.mmm]'. */
export function normTs(column: string): string {
  return `NULLIF(REPLACE(REPLACE(${column}, 'T', ' '), 'Z', ''), '')`
}

/**
 * Vrijeme zadnjeg relevantnog događaja na zadatku:
 *  - dovršen/otkazan zadatak → vrijeme dovršenja (completed_at), jer se popis
 *    dovršenih traži „po vremenu dovršenja silazno";
 *  - sve ostalo → vrijeme zadnje promjene (updated_at).
 * Ako oznake nema, pada na created_at da redak nikad ne ostane bez ključa.
 */
export const TASK_ACTIVITY_TS = `
        CASE WHEN status IN ('completed', 'cancelled')
             THEN COALESCE(${normTs('completed_at')}, ${normTs('updated_at')}, ${normTs('created_at')})
             ELSE COALESCE(${normTs('updated_at')}, ${normTs('created_at')})
        END`.trim()

/**
 * Brojčani dio ID-a zadatka ('TASK-3516' → 3516) kao INTEGER.
 * Usporedba nizova bi ovdje lagala: 'TASK-999' > 'TASK-1000' po znakovima.
 */
export const TASK_ID_NUMBER = `CAST(SUBSTR(id, INSTR(id, '-') + 1) AS INTEGER)`

/**
 * Poredak zadataka: unutar statusne skupine — najnovije na vrhu.
 * Skupine po statusu ostaju jer ploča ionako crta četiri stupca, a ostalim
 * potrošačima (scheduler, izvještaji) čuva dosadašnji raspored.
 * PRIORITET VIŠE NIJE KLJUČ POREDKA (bio je `priority ASC` ispred vremena) —
 * prioritet se i dalje vidi po boji kartice, ali ne pretječe kronologiju.
 */
export const TASKS_ORDER_BY = `
      ORDER BY
        CASE status
          WHEN 'in_progress' THEN 1
          WHEN 'pending' THEN 2
          WHEN 'blocked' THEN 3
          WHEN 'completed' THEN 4
          WHEN 'cancelled' THEN 5
        END,
        ${TASK_ACTIVITY_TS} DESC,
        ${TASK_ID_NUMBER} DESC`

/**
 * Zadnji rad na projektu = najnovija promjena bilo kojeg zadatka toga projekta
 * (TASK-3513: max(updated_at) nad zadatcima), a ne datum otvaranja projekta.
 * `srcAlias` je tablica/pogled iz kojega se čitaju projekti.
 */
export function projectLastActivityExpr(srcAlias: string): string {
  return `COALESCE(
        (SELECT MAX(${normTs('t.updated_at')}) FROM tasks t WHERE t.project_id = ${srcAlias}.id),
        ${normTs(`${srcAlias}.updated_at`)},
        ${normTs(`${srcAlias}.created_at`)}
      )`
}

/** Poredak projekata: onaj na kojemu se zadnje radilo ide prvi. */
export function projectsOrderBy(srcAlias: string): string {
  return ` ORDER BY ${projectLastActivityExpr(srcAlias)} DESC, ${normTs(`${srcAlias}.created_at`)} DESC`
}
