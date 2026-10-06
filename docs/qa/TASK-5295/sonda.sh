# Sonda čvora (TASK-5295): samo čitanje, nikad ne ispisuje vrijednost tajne (samo postoji/nema).
P=~/TaskManagerAI; E=$P/config/postavke.env
echo "sha=$(git -C $P rev-parse --short HEAD 2>/dev/null)"
echo "razgovor_modul=$(test -d $P/src/razgovor && echo da || echo ne)"
echo "botkanal_modul=$(grep -q 'od-bota' $P/src/TaskWebUI.ts 2>/dev/null && echo da || echo ne)"
echo "telegram_json=$(test -f $P/config/telegram.json && echo da || echo ne)"
for k in TM_PORT TM_ALLOWED_HOSTS TM_DB TM_AGENTS_REGISTRY TM_RAZGOVOR_PUNO TM_RAZGOVOR_UPUTE TM_BOT_KANAL_TOKEN TM_HINDSIGHT_URL TM_CHROMA_HOST TM_CREDENTIALS; do
  grep -q "^$k=" $E 2>/dev/null && echo "env.$k=postoji" || echo "env.$k=nema"; done
DB=$(grep '^TM_DB=' $E | cut -d= -f2)
python3 - "$DB" <<'PY'
import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
n=lambda p: c.execute("select count(*) from settings where key like ?",(p,)).fetchone()[0]
print("settings.razgovor=",n('razgovor.%'),"settings.memorija=",n('memorija.%'))
PY
echo "bun=$(test -x ~/.bun/bin/bun && ~/.bun/bin/bun --version || echo nema)"
C=$(ls ~/.local/bin/claude 2>/dev/null || command -v claude); echo "claude=${C:-nema} $($C --version 2>/dev/null)"
test -s ~/.claude/.credentials.json && echo "claude_prijava=postoji" || echo "claude_prijava=nema"
echo "claude_md=$(test -f ~/CLAUDE.md && wc -c < ~/CLAUDE.md || echo nema)"
python3 -c "import json,os;s=json.load(open(os.path.expanduser('~/.claude/settings.json')));print('settings_json_hooks=',sorted({h2['command'].split('/')[-1] for e in s.get('hooks',{}).values() for h in e for h2 in h.get('hooks',[])}))" 2>&1
echo "securityvalidator=$(test -f ~/.claude/hooks/SecurityValidator.hook.ts && echo da || echo ne)"
echo "capguard_bin=$(test -x /usr/local/sbin/regoc-capguard && echo da || echo ne) stanje=$(test -r /etc/regoc/capabilities.state && echo da || echo ne)"
grep -E '^(allow_internet|allow_root|allow_sudo|allow_packages)' /etc/regoc/capabilities.state 2>/dev/null | tr '\n' ' '; echo
echo "home_klaudio_u_daemonu=$(grep -c '/home/klaudio' ~/.claude/regoc/RegocDaemon.ts 2>/dev/null)"
echo "rag=$(grep -q '^TM_CHROMA_HOST=' $E && echo ukljucen || echo iskljucen)"
for p in 17781 17790 17792 8899; do ss -ltn | grep -q ":$p " && echo "vrata.$p=slusa" || echo "vrata.$p=ne"; done
for u in regoc-taskmanager regoc-daemon regoc-voice regoc-setup; do echo "unit.$u=$(systemctl --user is-active $u 2>/dev/null)"; done
echo "voice_model=$(grep -h WHISPER_MODEL ~/.config/systemd/user/regoc-voice.service ~/.config/systemd/user/regoc-voice.service.d/* 2>/dev/null | tail -1)"
echo "disk=$(df -h ~ | tail -1 | awk '{print $5" zauzeto, "$4" slobodno"}')"
