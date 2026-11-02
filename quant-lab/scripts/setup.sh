#!/usr/bin/env bash
# Cria o ambiente virtual em quant-lab/.venv e instala as dependências.
set -euo pipefail
cd "$(dirname "$0")/.."
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -r requirements.txt
echo "pronto: use .venv/bin/python -m qlab --help"
