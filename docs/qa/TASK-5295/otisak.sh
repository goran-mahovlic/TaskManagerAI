# Otisak stanja čvora (TASK-5295): hash netajnih konfiguracija + broj redaka settings/settings_history. Samo čitanje.
P=~/TaskManagerAI
DB=$(grep '^TM_DB=' $P/config/postavke.env | cut -d= -f2)
{ ls -l --time-style=+%s $P/config/ ~/.claude 2>/dev/null; git -C $P rev-parse HEAD; git -C $P status --porcelain;
  sqlite3 -readonly "$DB" "select count(*) from settings; select count(*) from settings_history;" 2>/dev/null ||
  python3 -c "import sqlite3,sys;c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True);print(c.execute('select count(*) from settings').fetchone(),c.execute('select count(*) from settings_history').fetchone())" "$DB"
} | sha256sum | cut -c1-16
