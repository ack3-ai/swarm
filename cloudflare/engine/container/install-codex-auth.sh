#!/bin/sh
set -eu
install -d -m 0700 -o 10001 -g 10001 /codex-home /workspace/home /workspace/results /workspace/accepted
install -m 0600 -o 10001 -g 10001 /workspace/private/codex-auth.json /codex-home/auth.json
rm -f /workspace/private/codex-auth.json
chown -R 10001:10001 /workspace/home /workspace/results /workspace/accepted /workspace/source 2>/dev/null || true
