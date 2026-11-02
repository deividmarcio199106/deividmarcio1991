# Detecta GPU/CUDA e compara o XGBoost em CPU e CUDA.
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
& .\.venv\Scripts\python.exe -m qlab gpu-check
& .\.venv\Scripts\python.exe -m qlab gpu-bench
