#!/usr/bin/env bash
# Detecta GPU/CUDA e compara o XGBoost em CPU e CUDA antes de usar a GPU.
set -euo pipefail
cd "$(dirname "$0")/.."
PY=${PY:-.venv/bin/python}
"$PY" -m qlab gpu-check
"$PY" -m qlab gpu-bench --rows "${ROWS:-200000}"
