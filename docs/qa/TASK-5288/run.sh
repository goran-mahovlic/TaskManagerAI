#!/bin/bash
# TASK-5288: prijenos probe na node-A i pokretanje nad isporučenim kodom. KORACI=3,4,5 bira točke.
set -u
K="${KORACI:-1,2,3,4,5}"
ssh -o BatchMode=yes regoc@192.168.10.20 'mkdir -p ~/.tmp/TASK-5288' || exit 1
scp -q -o BatchMode=yes /home/klaudio/app/tmp/TASK-5288/proba.ts regoc@192.168.10.20:.tmp/TASK-5288/proba.ts || exit 1
ssh -o BatchMode=yes regoc@192.168.10.20 "cd ~/TaskManagerAI && set -a && . config/postavke.env && set +a && unset TM_RAZGOVOR_PUNO && export PATH=\$HOME/.local/bin:\$HOME/.bun/bin:\$PATH && KORACI=$K bun ~/.tmp/TASK-5288/proba.ts" 2>&1 | tee "/home/klaudio/app/tmp/TASK-5288/proba-${K//,/}.log"
