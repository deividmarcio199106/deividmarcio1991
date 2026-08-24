<#
.SYNOPSIS
    Publica os ticks RTD do Profit (lidos de uma planilha Excel ABERTA) na t4-bridge.

.DESCRIPTION
    Alternativa ao módulo VBA para quem não pode habilitar macros. O script
    conecta na instância do Excel que já está aberta, lê as células alimentadas
    pelo servidor RTD do Profit e faz POST na bridge quando o valor muda.

    Não gera dado. Se a planilha não recalcular (Profit fechado, RTD parado),
    nada é enviado — e o T4 bloqueia por falta de feed, que é o comportamento
    correto.

.PARAMETER Workbook
    Nome do arquivo aberto no Excel (ex.: "RTD.xlsx"). Padrão: primeira pasta
    de trabalho que contenha a planilha informada em -Sheet.

.PARAMETER Sheet
    Nome da planilha com o layout ATIVO | ULTIMO | COMPRA | VENDA | VOLUME | QTD | HORA.

.PARAMETER BridgeUrl
    Endpoint de ingest da bridge.

.PARAMETER IntervalMs
    Intervalo de leitura. 150–300 ms é suficiente: o T4 fecha candles de 1 minuto.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Push-ProfitRtd.ps1 -Sheet RTD

.NOTES
    Requer Excel instalado e a planilha ABERTA com as fórmulas RTD.
    Layout esperado a partir da linha 2 (linha 1 = cabeçalho).
#>
[CmdletBinding()]
param(
    [string]$Workbook = "",
    [string]$Sheet = "RTD",
    [string]$BridgeUrl = "http://127.0.0.1:8765/ingest",
    [string]$Token = "",
    [int]$IntervalMs = 200,
    [int]$FirstRow = 2
)

$ErrorActionPreference = "Stop"

function Get-ExcelInstance {
    try {
        return [Runtime.InteropServices.Marshal]::GetActiveObject("Excel.Application")
    } catch {
        throw "Excel não está aberto. Abra a planilha com as fórmulas RTD antes de rodar este script."
    }
}

function Resolve-Sheet {
    param($Excel, [string]$WorkbookName, [string]$SheetName)

    foreach ($wb in $Excel.Workbooks) {
        if ($WorkbookName -and $wb.Name -ne $WorkbookName) { continue }
        foreach ($ws in $wb.Worksheets) {
            if ($ws.Name -eq $SheetName) { return $ws }
        }
    }
    throw "Planilha '$SheetName' não encontrada nas pastas de trabalho abertas."
}

function ConvertTo-Number {
    param($Value)
    if ($null -eq $Value) { return $null }
    $text = [string]$Value
    if ([string]::IsNullOrWhiteSpace($text)) { return $null }
    # Célula em erro (#N/A enquanto o RTD sobe) vem como string começando com '#'.
    if ($text.StartsWith("#")) { return $null }
    $parsed = 0.0
    $invariant = [Globalization.CultureInfo]::InvariantCulture
    if ([double]::TryParse($text, [Globalization.NumberStyles]::Any, $invariant, [ref]$parsed)) { return $parsed }
    if ([double]::TryParse($text, [Globalization.NumberStyles]::Any, [Globalization.CultureInfo]::CurrentCulture, [ref]$parsed)) { return $parsed }
    return $null
}

function ConvertTo-Timestamp {
    param($Value)
    if ($null -eq $Value) { return $null }
    if ($Value -is [datetime]) { return $Value.ToString("yyyy-MM-ddTHH:mm:ss") }
    $text = ([string]$Value).Trim()
    if ([string]::IsNullOrWhiteSpace($text) -or $text.StartsWith("#")) { return $null }
    # Serial do Excel (fração do dia) vira hora do dia corrente.
    $serial = ConvertTo-Number $text
    if ($null -ne $serial -and $serial -gt 0 -and $serial -lt 2) {
        return [datetime]::Today.AddDays($serial).ToString("yyyy-MM-ddTHH:mm:ss")
    }
    return $text
}

$excel = Get-ExcelInstance
$worksheet = Resolve-Sheet -Excel $excel -WorkbookName $Workbook -SheetName $Sheet
Write-Host "[rtd] Lendo '$($worksheet.Name)' e publicando em $BridgeUrl"
Write-Host "[rtd] Ctrl+C para parar. Nenhum dado é gerado por este script."

$lastSignature = @{}
$headers = @{ "Content-Type" = "application/json" }
if ($Token) { $headers["X-Bridge-Token"] = $Token }
$sent = 0
$failures = 0

while ($true) {
    $batch = New-Object System.Collections.Generic.List[object]
    $row = $FirstRow

    while ($true) {
        $symbol = [string]$worksheet.Cells.Item($row, 1).Value2
        if ([string]::IsNullOrWhiteSpace($symbol)) { break }
        $symbol = $symbol.Trim().ToUpperInvariant()

        $price = ConvertTo-Number $worksheet.Cells.Item($row, 2).Value2
        if ($null -ne $price -and $price -gt 0) {
            $volume = ConvertTo-Number $worksheet.Cells.Item($row, 5).Value2
            $timestamp = ConvertTo-Timestamp $worksheet.Cells.Item($row, 7).Value2
            $signature = "$price|$volume|$timestamp"

            if ($lastSignature[$symbol] -ne $signature) {
                $lastSignature[$symbol] = $signature
                $batch.Add([ordered]@{
                    symbol    = $symbol
                    timestamp = $timestamp
                    price     = $price
                    bid       = ConvertTo-Number $worksheet.Cells.Item($row, 3).Value2
                    ask       = ConvertTo-Number $worksheet.Cells.Item($row, 4).Value2
                    volume    = $volume
                    qty       = ConvertTo-Number $worksheet.Cells.Item($row, 6).Value2
                })
            }
        }
        $row++
    }

    if ($batch.Count -gt 0) {
        try {
            $body = $batch | ConvertTo-Json -Depth 4 -Compress
            if ($batch.Count -eq 1) { $body = "[$body]" }
            Invoke-RestMethod -Uri $BridgeUrl -Method Post -Headers $headers -Body $body -TimeoutSec 2 | Out-Null
            $sent += $batch.Count
            Write-Host "`r[rtd] enviados=$sent falhas=$failures" -NoNewline
        } catch {
            $failures++
            Write-Host "`r[rtd] enviados=$sent falhas=$failures — $($_.Exception.Message)" -NoNewline
        }
    }

    Start-Sleep -Milliseconds $IntervalMs
}
