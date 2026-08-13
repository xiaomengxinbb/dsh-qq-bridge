#!/bin/bash
# 自动晋升：捕获到访问申请后 → 更新 allowUsers → 重启网关
# 依赖：.access-request.json（watch-access.sh 产出）
CAPTURE=$PWD/.access-request.json
CONFIG=$HOME/.dsh/qq-bridge/config.json
DONE=$PWD/.promotion-done
for i in $(seq 1 900); do
  if [ -f "$CAPTURE" ]; then
    OPENID=$(python3 -c "import json;print(json.load(open('$CAPTURE'))['openid'])" 2>/dev/null)
    if [ -n "$OPENID" ]; then
      python3 - "$OPENID" <<'PYEOF'
import json, os, sys
path = os.path.expanduser('~/.dsh/qq-bridge/config.json')
openid = sys.argv[1]
c = json.load(open(path))
if openid not in c.get('allowUsers', []):
    c['allowUsers'] = c.get('allowUsers', []) + [openid]
    open(path, 'w').write(json.dumps(c, indent=2, ensure_ascii=False) + '
')
    os.chmod(path, 0o600)
print('allowUsers updated with', openid)
PYEOF
      # 停旧网关（等锁释放）
      pkill -f 'dsh --profile dev-int' 2>/dev/null
      sleep 4
      rm -f "$HOME/.dsh/qq-bridge/qq-bridge.lock"
      rm -f /tmp/dsh-qq-bridge-gw.log
      # 起新网关（detached）
      cd "$HOME"
      nohup "$(command -v dsh)" --profile dev-int --patch "$PWD/dev-overlay.yml" > /tmp/real-gw-auto.log 2>&1 &
      disown
      echo "{\"openid\": \"$OPENID\", \"promotedAt\": $(date +%s)}" > "$DONE"
      echo "PROMOTED openid=$OPENID"
      exit 0
    fi
  fi
  sleep 10
done
echo "PROMOTER_TIMEOUT"
exit 1
