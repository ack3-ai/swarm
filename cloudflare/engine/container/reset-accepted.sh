#!/bin/sh
set -eu
rm -rf /workspace/accepted
install -d -m 0750 -o 10001 -g 10001 /workspace/accepted
