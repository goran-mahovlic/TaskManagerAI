#!/bin/bash
# REGOČ Daemon Management Script
#
# Usage:
#   ./manage.sh start     - Start daemon (arm the keeper; returns immediately)
#   ./manage.sh stop      - Stop daemon (deliberate outage; keeper is paused)
#   ./manage.sh restart   - Restart daemon
#   ./manage.sh status    - Show status
#   ./manage.sh logs      - Show recent logs
#   ./manage.sh nacin     - Tko drži daemon: usluga (systemd/launchd) ili keeper
#
# ZAŠTO IDE PREKO KEEPERA (TASK-4781, izmjereno 09.09.2026.)
#   Do sada je `start` bio `bun RegocDaemon.ts --daemon` i NIJE SE VRAĆAO: Bun.spawn bez
#   unref drži događajnu petlju roditelja dok dijete živi. Uživo: PID 200129
#   `bash manage.sh start` → 200132 `--daemon` → 200166 worker, sva tri živa 16 min nakon
#   starta. Svaki pozivatelj s timeoutom (alatni sloj, `timeout`, CI) tada SIGTERM-om
#   pobije i pokretača i daemon — restart pod timeoutom je bio mina.
#   Uz to je daemon ostajao BEZ nadzornika: keeper (tools/daemon-keeper.sh) postoji od
#   TASK-2969, ali ga nitko nije naoružavao, pa je `kill -9` nad workerom 09.09. ostavio
#   sustav bez daemona ~7 minuta. Sada je keeper JEDINI pokretač daemona (SSOT), a
#   `manage.sh` samo naredbeno sučelje nad njim: naoružaj → digni → vrati se.
#
# ZAŠTO NE systemd (kao na node-B)
#   U ovom spremniku systemd nije PID 1 (/run/systemd/system ne postoji) i nema crona.
#   korisnički systemd ovdje nema kome govoriti. Odvojena petlja u novoj sesiji (keeper) je
#   jedina izvediva opcija — vidi docs/DAEMON_BOOT_<stroj>.md u regoc_system.
#
# ČVOR S UPRAVITELJEM USLUGA (TASK-5668, Mac K1b, plan v3 P10 #7)
#   Na node-A (systemd korisnička jedinica regoc-daemon) i na macOS-u (LaunchDaemon hr.regoc.daemon,
#   KeepAlive) daemon drži upravitelj usluga; keeper bi mimo njega digao drugi daemon, a na macOS-u
#   ni ne radi (petlja i brava keepera su util-linux). Tada start/stop/restart/status idu kroz
#   lib/platforma.ts (start-/stop-/restart-usluge), a keeper ostaje samo za stroj bez upravitelja.
#   Otkrivanje: macOS → usluga; Linux → usluga ako je jedinica regoc-daemon učitana; inače keeper.
#   REGOC_UPRAVITELJ=keeper|usluga nadjačava otkrivanje.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# REGOC_DAEMON_ENTRY je šav za ispitivanje (tests/daemon-keeper-boot.test.ts): bez njega
# bi test `stop` ubio PRAVI daemon. U produkciji se ne postavlja.
DAEMON="${REGOC_DAEMON_ENTRY:-$SCRIPT_DIR/RegocDaemon.ts}"
KEEPER="$SCRIPT_DIR/tools/daemon-keeper.sh"
PLAT="$SCRIPT_DIR/lib/platforma.ts"
USLUGA="regoc-daemon"
DAEMON_PID_FILE="${REGOC_KEEPER_DAEMON_PID_FILE:-$SCRIPT_DIR/daemon.pid}"
# Koliko čekamo da daemon bude gore prije nego se `start` vrati. Keeper interno troši do
# 10 s (podizanje petlje) + 25 s (provjera starta); strop mora ostati ispod minute jer je
# `regoc-services.sh restart-service regoc` mjeren kriterijem "< 60 s".
START_WAIT_S="${REGOC_START_WAIT_S:-40}"

# Postavke okoline iz datoteke (istodobnost i sl.). Drže se izvan skripte da se mijenjaju
# bez diranja koda; ako datoteke nema, vrijede ugrađene zadane vrijednosti.
if [ -f "$SCRIPT_DIR/config/daemon.env" ]; then
    set -a
    . "$SCRIPT_DIR/config/daemon.env"
    set +a
fi

daemon_alive() {
    local pid
    [ -f "$DAEMON_PID_FILE" ] || return 1
    pid="$(tr -d '[:space:]' < "$DAEMON_PID_FILE" 2>/dev/null)"
    case "$pid" in ''|*[!0-9]*) return 1 ;; esac
    kill -0 "$pid" 2>/dev/null
}

daemon_pid() { tr -d '[:space:]' < "$DAEMON_PID_FILE" 2>/dev/null; }

upravitelj() {
    case "${REGOC_UPRAVITELJ:-}" in keeper|usluga) echo "$REGOC_UPRAVITELJ"; return ;; esac
    if [ "$(uname -s)" = Darwin ] || bun "$PLAT" usluga-postoji "$USLUGA" >/dev/null 2>&1; then echo usluga
    else echo keeper; fi
}

cekaj_daemon() {
    local waited=0
    while [ "$waited" -lt "$START_WAIT_S" ]; do
        daemon_alive && { echo "✅ RegocDaemon radi (PID $(daemon_pid))"; return 0; }
        sleep 1; waited=$((waited + 1))
    done
    echo "❌ daemon nije gore ni nakon ${START_WAIT_S}s — pogledaj: bun $PLAT usluga $USLUGA" >&2
    return 1
}

# Upravitelj usluga (systemd | launchd) drži daemon — keeper se ne dira.
usluga_cmd() {
    case "$1" in
        start)   bun "$PLAT" start-usluge "$USLUGA" >/dev/null || { echo "❌ start usluge $USLUGA nije uspio" >&2; return 1; }
                 cekaj_daemon ;;
        restart) bun "$PLAT" restart-usluge "$USLUGA" >/dev/null || { echo "❌ restart usluge $USLUGA nije uspio" >&2; return 1; }
                 sleep 1; cekaj_daemon ;;
        stop)    bun "$PLAT" stop-usluge "$USLUGA" >/dev/null && echo "🛑 usluga $USLUGA zaustavljena" ;;
        status)  echo "usluga $USLUGA: $(bun "$PLAT" usluga "$USLUGA" 2>/dev/null || echo nepoznato)"
                 bun "$DAEMON" --status ;;
    esac
}

cmd_start() {
    if [ ! -r "$KEEPER" ]; then
        echo "❌ nema $KEEPER — ne mogu naoružati nadzornika" >&2
        return 1
    fi
    # 1) Naoružaj nadzornika (idempotentno: drugi start ne stvara duplikat).
    bash "$KEEPER" start
    # 2) `resume` ukida eventualnu pauzu OD `stop`-a i odmah radi jednu provjeru, koja
    #    pod flockom digne daemon. `start` sam to ne bi napravio ako keeper već radi i
    #    ako je pauza postavljena — tada bi daemon ostao dolje bez ijedne poruke.
    bash "$KEEPER" resume >/dev/null 2>&1 || true

    local waited=0
    while [ "$waited" -lt "$START_WAIT_S" ]; do
        daemon_alive && { echo "✅ RegocDaemon radi (PID $(daemon_pid))"; return 0; }
        sleep 1; waited=$((waited + 1))
    done
    echo "❌ daemon nije gore ni nakon ${START_WAIT_S}s — pogledaj: bash $KEEPER status" >&2
    return 1
}

cmd_restart() {
    # kill -9, NE `--stop`: SIGTERM pokreće gracefulShutdown → shutdownActiveSpawns, koji
    # pobije SVE žive agentske spawnove. Restart daemona (npr. radi novog koda) nije
    # razlog da tim izgubi rad na kojem je u tom trenutku. Namjerno gašenje s urednim
    # zatvaranjem spawnova i dalje postoji — to je `stop`.
    local pid; pid="$(daemon_pid)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        kill -9 "$pid" 2>/dev/null
        rm -f "$DAEMON_PID_FILE"
        echo "🛑 RegocDaemon $pid ubijen (SIGKILL — žive agente ne diramo)"
    else
        echo "ℹ️  RegocDaemon nije radio"
    fi
    sleep 1
    cmd_start
}

cmd_stop() {
    # Pauza PRIJE gašenja: bez nje bi keeper daemon vratio unutar jednog intervala i
    # `stop` bi bio bez učinka. Pauzu ukida `start` (odnosno `keeper resume`).
    [ -r "$KEEPER" ] && bash "$KEEPER" pause >/dev/null 2>&1
    bun "$DAEMON" --stop
}

# TASK-5140: ZABRANA SAMORESTARTA. Spawnani agent (REGOC_TASK_ID u okolini) ne smije restartati
# daemon, ploču ni Klaudija iz sebe: novi daemon njegov proces više nema u evidenciji, pa zadatak
# ostane in_progress bez procesa (TASK-5134, 02.10.2026.). Isporuka u pogon ide odgođeno, kroz
# restart_kad_mirno.sh — on briše REGOC_TASK_ID iz okoline pa ga ova brana ne zaustavlja.
brana_samorestarta() {
  [ -z "${REGOC_TASK_ID:-}" ] && return 0
  echo "⛔ Restart ($*) odbijen: pozvan iz spawna agenta (REGOC_TASK_ID=${REGOC_TASK_ID})." >&2
  echo "   Restart iz vlastitog spawna ostavlja zadatak in_progress bez procesa (TASK-5134)." >&2
  echo "   Umjesto toga pokreni odgođeni restart (izvede se kad nema zadataka in_progress ni spawnova):" >&2
  echo "     setsid nohup bash ~/.claude/regoc/tools/servisi/restart_kad_mirno.sh ${REGOC_TASK_ID} >/dev/null 2>&1 &" >&2
  echo "   Pravilo: CLAUDE.md (Kritična pravila), docs/SIROCE-oporavak-i-zabrana-samorestarta.md" >&2
  return 4
}

case "$1" in
    stop|restart) [ -n "${REGOC_DAEMON_ENTRY:-}" ] || brana_samorestarta "manage.sh $1" || exit 4 ;;
esac

case "$1" in
    nacin) upravitelj; exit 0 ;;
    start|stop|restart|status)
        if [ "$(upravitelj)" = usluga ]; then usluga_cmd "$1"; exit $?; fi ;;
esac

case "$1" in
    start)
        cmd_start
        ;;
    stop)
        cmd_stop
        ;;
    restart)
        cmd_restart
        ;;
    status)
        bun "$DAEMON" --status
        echo ""
        [ -r "$KEEPER" ] && bash "$KEEPER" status
        ;;
    logs)
        # TASK-2987: SSOT. Prije je ovdje stajao /tmp/regoc_daemon.log koji NIKAD nije
        # postojao (daemon je pisao u ~/.tmp/…), pa je `manage.sh logs` bio tih.
        tail -50 "$HOME/.claude/regoc/daemon.log"
        ;;
    *)
        echo "REGOČ Daemon Manager"
        echo ""
        echo "Usage: $0 {start|stop|restart|status|logs|nacin}"
        echo ""
        echo "Commands:"
        echo "  start   - Arm the keeper and bring the daemon up (returns immediately)"
        echo "  stop    - Stop the daemon and pause the keeper (deliberate outage)"
        echo "  restart - Restart the daemon"
        echo "  status  - Show daemon + keeper status and queue info"
        echo "  logs    - Show recent log entries"
        echo "  nacin   - Who holds the daemon: usluga (systemd/launchd) or keeper"
        ;;
esac
