#!/bin/sh
set -eu
rm -rf /workspace/accepted
# Root-owned: only root writes here (the Worker, ack3-mount-tests); the agent reads.
install -d -m 0755 -o 0 -g 0 /workspace/accepted
