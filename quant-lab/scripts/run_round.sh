#!/usr/bin/env bash
# Rodadas delimitadas (retomam de onde pararam). Uso:
#   scripts/run_round.sh --data data/ARQUIVO.csv --rounds 3 --max-minutes 30 --max-experiments 500
set -euo pipefail
cd "$(dirname "$0")/.."
PY=${PY:-.venv/bin/python}
"$PY" -m qlab run --report results "$@"
