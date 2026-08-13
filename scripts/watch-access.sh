#!/bin/bash
# 访问申请捕获器：监控网关日志，发现访问申请即提取 openid+code 写入结果文件
LOG=/tmp/dsh-qq-bridge-gw.log
OUT=$PWD/.access-request.json
START_LINES=0
for i in $(seq 1 600); do
  if [ -f "$LOG" ]; then
    LINE=$(grep -E '访问申请' "$LOG" | tail -1)
    if [ -n "$LINE" ]; then
      # 提取 openid 与 code：格式 "[router] 访问申请：<openid> 码 <code>"
      OPENID=$(echo "$LINE" | sed -E 's/.*访问申请：([^ ]+) 码.*/\1/')
      CODE=$(echo "$LINE" | sed -E 's/.*码 ([A-Z0-9]{6}).*/\1/')
      if [ -n "$OPENID" ] && [ -n "$CODE" ]; then
        echo "{\"openid\": \"$OPENID\", \"code\": \"$CODE\", \"at\": $(date +%s), \"line\": \"$LINE\"}" > "$OUT"
        echo "CAPTURED openid=$OPENID code=$CODE"
        exit 0
      fi
    fi
    # 也捕获任何入站（已被授权的直接消息）
    IN=$(grep -E '\[router\] 入站' "$LOG" | tail -1)
    if [ -n "$IN" ]; then
      echo "{\"inbound\": \"$IN\", \"at\": $(date +%s)}" > "$OUT"
      echo "INBOUND_CAPTURED"
      exit 0
    fi
  fi
  sleep 10
done
echo "WATCHER_TIMEOUT"
exit 1
