#!/usr/bin/env bash
set -euo pipefail

/usr/bin/curl -fsS http://localhost:8787/health
printf '\n'
