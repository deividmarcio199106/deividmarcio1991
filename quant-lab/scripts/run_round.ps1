# Rodadas delimitadas (retomam de onde pararam). Exemplo:
#   .\scripts\run_round.ps1 --data data\WDOFUT_F_0_5min_01-01-2026_01-11-2026.csv --rounds 3 --max-minutes 30
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
& .\.venv\Scripts\python.exe -m qlab run --report results @args
exit $LASTEXITCODE
