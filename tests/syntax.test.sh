#!/usr/bin/env bash
# 對全 repo *.js 跑 node --check（語法回歸測試）
# 用法：bash tests/syntax.test.sh

set -u
cd "$(dirname "$0")/.." || exit 1

fail=0
count=0

for f in *.js; do
  count=$((count + 1))
  if ! node --check "$f" > /dev/null 2>&1; then
    echo "FAIL: $f"
    node --check "$f"
    fail=1
  fi
done

if [ "$fail" -eq 0 ]; then
  echo "syntax.test.sh: ${count} files passed."
  exit 0
else
  echo "syntax.test.sh: FAILED."
  exit 1
fi
