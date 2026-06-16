#!/usr/bin/env bash
set -euo pipefail

curl -fsS http://localhost:8787/health
printf '\n'
