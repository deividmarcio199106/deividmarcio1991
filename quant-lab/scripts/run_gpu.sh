#!/usr/bin/env bash
# Uma rodada com XGBoost obrigatoriamente em CUDA (falha se a GPU não estiver disponível).
# Uso: scripts/run_gpu.sh --data data/WDOFUT_F_0_5min_01-01-2026_01-11-2026.csv [opções do qlab run]
set -euo pipefail
cd "$(dirname "$0")/.."
PY=${PY:-.venv/bin/python}
"$PY" -m qlab run --device cuda --report results "$@"
