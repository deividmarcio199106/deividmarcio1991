# Cria o ambiente virtual em quant-lab\.venv e instala as dependencias (Windows PowerShell 5.1+).
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
python -m venv .venv
& .\.venv\Scripts\python.exe -m pip install --upgrade pip
& .\.venv\Scripts\python.exe -m pip install -r requirements.txt
Write-Host 'pronto: use .\.venv\Scripts\python.exe -m qlab --help'
