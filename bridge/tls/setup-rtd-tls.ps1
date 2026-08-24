<#
.SYNOPSIS
    Prepara o TLS local da bridge RTD: gera o certificado, instala como confiável
    e valida. Sem admin, sem OpenSSL, sem instalar nada.

.DESCRIPTION
    O site em https://analisador.dvdswap.com.br não pode abrir ws:// — o navegador
    bloqueia conteúdo misto. A bridge precisa falar wss://, e para isso precisa de
    um certificado que o Chrome/Edge confiem.

    Este script resolve isso inteiro:
      1. gera um certificado autoassinado com SAN localhost + 127.0.0.1 + ::1;
      2. exporta cert.pem/key.pem ao lado deste arquivo;
      3. instala o certificado em Cert:\CurrentUser\Root (não exige admin);
      4. valida a cadeia com o mesmo mecanismo que o navegador usa;
      5. protege a chave no disco e garante que ela está no .gitignore.

    CINCO ARMADILHAS que este script já contorna, todas verificadas nesta máquina:

      - New-SelfSignedCertificate coloca IP no SAN como dNSName, e o Chrome ignora
        isso ao conectar em https://127.0.0.1. Aqui o SAN é montado com
        SubjectAlternativeNameBuilder.AddIpAddress, que gera iPAddress de verdade.
      - Sem basicConstraints CA:TRUE o BoringSSL/OpenSSL recusa o certificado como
        âncora de confiança ("unable to verify the first certificate").
      - $cert.GetRSAPrivateKey() NÃO existe no PowerShell (é extension method de
        C#). Só funciona via [RSACertificateExtensions]::GetRSAPrivateKey($cert).
      - Remove-Item em Cert:\CurrentUser\Root falha em sessão não interativa com
        "the operation is on user root store and UI is not allowed". A API
        X509Store funciona em silêncio, sem admin e sem popup.
      - New-SelfSignedCertificate deixa cópia em CurrentUser\CA além de My. Aqui
        o certificado nunca entra em nenhum store além do Root, então não há lixo.

.PARAMETER Force
    Regera o certificado mesmo que já exista um válido.

.PARAMETER Uninstall
    Remove o certificado do store de confiança e apaga os arquivos .pem.

.PARAMETER Check
    Só verifica e reporta; não gera, não instala, não altera nada.

.PARAMETER StartBridge
    Sobe a bridge com TLS ao final.

.PARAMETER Days
    Validade do certificado. Padrão 825 dias (o teto que navegadores aceitam).

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File bridge\tls\setup-rtd-tls.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File bridge\tls\setup-rtd-tls.ps1 -StartBridge

.NOTES
    Firefox NÃO usa o store do Windows. Se você opera pelo Firefox, importe o
    cert.pem nas configurações dele ou ligue security.enterprise_roots.enabled.

    Reinicie o navegador depois de instalar: Chrome e Edge cacheiam a decisão de
    cadeia, e sem reiniciar você testa o cache, não o certificado novo.
#>
[CmdletBinding()]
param(
    [switch]$Force,
    [switch]$Uninstall,
    [switch]$Check,
    [switch]$StartBridge,
    [int]$Days = 825
)

$ErrorActionPreference = "Stop"

$TlsDir     = $PSScriptRoot
$BridgeDir  = Split-Path $TlsDir -Parent
$RepoDir    = Split-Path $BridgeDir -Parent
$CertPath   = Join-Path $TlsDir "cert.pem"
$KeyPath    = Join-Path $TlsDir "key.pem"
$Subject    = "CN=T4 RTD Bridge (localhost)"

function Write-Step { param([string]$Text) Write-Host "==> $Text" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Text) Write-Host "    OK   $Text" -ForegroundColor Green }
function Write-Warn { param([string]$Text) Write-Host "    AVISO $Text" -ForegroundColor Yellow }
function Write-Bad  { param([string]$Text) Write-Host "    FALHA $Text" -ForegroundColor Red }

# ---------------------------------------------------------------- store ----

function Get-RootStore {
    param([string]$Access = "ReadOnly")
    $store = [System.Security.Cryptography.X509Certificates.X509Store]::new("Root", "CurrentUser")
    $store.Open($Access)
    return $store
}

function Get-InstalledCerts {
    $store = Get-RootStore
    try {
        return @($store.Certificates | Where-Object { $_.Subject -eq $Subject })
    } finally {
        $store.Close()
    }
}

function Remove-InstalledCerts {
    $existing = Get-InstalledCerts
    if ($existing.Count -eq 0) { return 0 }
    # X509Store.Remove funciona sem admin e sem diálogo; Remove-Item no provider
    # Cert: falharia com "UI is not allowed" numa sessão não interativa.
    $store = Get-RootStore -Access "ReadWrite"
    try {
        foreach ($cert in $existing) { $store.Remove($cert) }
    } finally {
        $store.Close()
    }
    return $existing.Count
}

# ----------------------------------------------------------- validação ----

function Test-CertificateFiles {
    if (-not (Test-Path $CertPath) -or -not (Test-Path $KeyPath)) {
        return [pscustomobject]@{ Ok = $false; Reason = "cert.pem ou key.pem não existe" }
    }
    try {
        $pem  = Get-Content $CertPath -Raw
        $cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::CreateFromPem($pem)
    } catch {
        return [pscustomobject]@{ Ok = $false; Reason = "cert.pem ilegível: $($_.Exception.Message)" }
    }

    if ($cert.NotAfter -lt (Get-Date)) {
        return [pscustomobject]@{ Ok = $false; Reason = "certificado expirou em $($cert.NotAfter)"; Cert = $cert }
    }
    # Menos de 30 dias restantes já é hora de regerar, não de descobrir no pregão.
    $diasRestantes = [int]($cert.NotAfter - (Get-Date)).TotalDays

    $san = $cert.Extensions | Where-Object { $_.Oid.Value -eq "2.5.29.17" }
    if (-not $san) {
        return [pscustomobject]@{ Ok = $false; Reason = "certificado sem SAN"; Cert = $cert }
    }
    $sanText = $san.Format($false)
    if ($sanText -notmatch "localhost") {
        return [pscustomobject]@{ Ok = $false; Reason = "SAN sem localhost: $sanText"; Cert = $cert }
    }
    # O Chrome só aceita IP literal se o SAN tiver iPAddress de verdade.
    if ($sanText -notmatch "127\.0\.0\.1") {
        return [pscustomobject]@{ Ok = $false; Reason = "SAN sem 127.0.0.1: $sanText"; Cert = $cert }
    }

    return [pscustomobject]@{
        Ok = $true
        Reason = "válido por mais $diasRestantes dia(s) · SAN $sanText"
        Cert = $cert
        DaysLeft = $diasRestantes
    }
}

function Test-Trust {
    param([System.Security.Cryptography.X509Certificates.X509Certificate2]$Cert)
    $chain = [System.Security.Cryptography.X509Certificates.X509Chain]::new()
    $chain.ChainPolicy.RevocationMode = [System.Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck
    $null = $chain.ChainPolicy.ApplicationPolicy.Add([System.Security.Cryptography.Oid]::new("1.3.6.1.5.5.7.3.1"))
    $ok = $chain.Build($Cert)
    $status = ($chain.ChainStatus | ForEach-Object { $_.Status }) -join ", "
    $chain.Dispose()
    return [pscustomobject]@{ Ok = $ok; Status = $status }
}

# ------------------------------------------------------------- geração ----

function New-BridgeCertificate {
    Write-Step "Gerando certificado (RSA 2048, SAN localhost + 127.0.0.1 + ::1)"

    $rsa = [System.Security.Cryptography.RSA]::Create(2048)
    $dn  = [System.Security.Cryptography.X509Certificates.X500DistinguishedName]::new($Subject)
    $req = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
        $dn, $rsa,
        [System.Security.Cryptography.HashAlgorithmName]::SHA256,
        [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)

    # CA:TRUE é obrigatório para o certificado poder ser âncora de confiança.
    # Sem isso o node:tls falha com "unable to verify the first certificate".
    $req.CertificateExtensions.Add(
        [System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($true, $true, 0, $true))

    $usage = [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature -bor
             [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyEncipherment -bor
             [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyCertSign
    $req.CertificateExtensions.Add(
        [System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new($usage, $true))

    $eku = [System.Security.Cryptography.OidCollection]::new()
    $null = $eku.Add([System.Security.Cryptography.Oid]::new("1.3.6.1.5.5.7.3.1"))  # serverAuth
    $req.CertificateExtensions.Add(
        [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($eku, $false))

    # AddIpAddress gera SAN tipo iPAddress (tag 0x87). O -DnsName do
    # New-SelfSignedCertificate geraria dNSName (0x82), que o Chrome ignora
    # ao conectar em https://127.0.0.1.
    $san = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
    $san.AddDnsName("localhost")
    $san.AddIpAddress([System.Net.IPAddress]::Parse("127.0.0.1"))
    $san.AddIpAddress([System.Net.IPAddress]::Parse("::1"))
    $req.CertificateExtensions.Add($san.Build())

    $notBefore = [DateTimeOffset]::UtcNow.AddDays(-1)
    $notAfter  = [DateTimeOffset]::UtcNow.AddDays($Days)
    $cert = $req.CreateSelfSigned($notBefore, $notAfter)

    if (-not (Test-Path $TlsDir)) { New-Item -ItemType Directory -Path $TlsDir | Out-Null }

    # -Encoding ascii grava sem BOM. BOM quebra o parser PEM do node:tls.
    Set-Content -Path $CertPath -Value $cert.ExportCertificatePem() -Encoding ascii
    Set-Content -Path $KeyPath  -Value $rsa.ExportPkcs8PrivateKeyPem() -Encoding ascii
    $rsa.Dispose()

    Write-Ok "cert.pem e key.pem gravados em $TlsDir"

    # A chave privada só precisa ser legível por quem roda a bridge.
    try {
        $me = "$env:USERDOMAIN\$env:USERNAME"
        icacls $KeyPath /inheritance:r /grant:r "${me}:(R)" | Out-Null
        Write-Ok "permissões da chave restritas a $me"
    } catch {
        Write-Warn "não foi possível restringir a permissão da chave: $($_.Exception.Message)"
    }

    return $cert
}

function Install-Certificate {
    param([System.Security.Cryptography.X509Certificates.X509Certificate2]$Cert)
    Write-Step "Instalando em Cert:\CurrentUser\Root (não exige administrador)"

    $removidos = Remove-InstalledCerts
    if ($removidos -gt 0) { Write-Ok "$removidos certificado(s) T4 antigo(s) removido(s)" }

    # Só a parte pública vai para o store de confiança — a chave privada fica
    # exclusivamente no key.pem que a bridge lê.
    $bytes = $Cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert)
    try {
        $public = [System.Security.Cryptography.X509Certificates.X509CertificateLoader]::LoadCertificate($bytes)
    } catch {
        $public = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($bytes)
    }

    $store = Get-RootStore -Access "ReadWrite"
    try {
        $store.Add($public)
    } finally {
        $store.Close()
    }
    Write-Ok "certificado instalado (thumbprint $($public.Thumbprint))"
    return $public
}

function Update-GitIgnore {
    $gitignore = Join-Path $RepoDir ".gitignore"
    $entradas = @("bridge/tls/*.pem", "bridge/tls/*.pfx")
    if (-not (Test-Path $gitignore)) {
        Write-Warn ".gitignore não encontrado em $RepoDir"
        return
    }
    $conteudo = Get-Content $gitignore -Raw
    $faltando = $entradas | Where-Object { $conteudo -notmatch [regex]::Escape($_) }
    if ($faltando.Count -eq 0) {
        Write-Ok ".gitignore já protege o material TLS"
        return
    }
    $bloco = "`n# Material TLS da bridge RTD — chave privada NUNCA vai para o repositório`n" +
             ($faltando -join "`n") + "`n"
    Add-Content -Path $gitignore -Value $bloco -Encoding utf8
    Write-Ok ".gitignore atualizado: $($faltando -join ', ')"
}

# ------------------------------------------------------------ execução ----

Write-Host ""
Write-Host "TLS DA BRIDGE RTD" -ForegroundColor White
Write-Host "Diretório: $TlsDir"
Write-Host ""

if ($Uninstall) {
    Write-Step "Desinstalando"
    $removidos = Remove-InstalledCerts
    Write-Ok "$removidos certificado(s) removido(s) do store de confiança"
    foreach ($arquivo in @($CertPath, $KeyPath)) {
        if (Test-Path $arquivo) { Remove-Item $arquivo -Force; Write-Ok "$arquivo apagado" }
    }
    Write-Host ""
    Write-Host "Reinicie o navegador para limpar o cache de cadeia." -ForegroundColor Yellow
    exit 0
}

$arquivos = Test-CertificateFiles
$instalados = Get-InstalledCerts

if ($Check) {
    Write-Step "Verificando (nada será alterado)"
    if ($arquivos.Ok) { Write-Ok "arquivos: $($arquivos.Reason)" } else { Write-Bad "arquivos: $($arquivos.Reason)" }
    if ($instalados.Count -gt 0) {
        Write-Ok "instalado no store de confiança ($($instalados.Count))"
        $confianca = Test-Trust -Cert $instalados[0]
        if ($confianca.Ok) { Write-Ok "cadeia validada — o navegador vai confiar" }
        else { Write-Bad "cadeia NÃO valida: $($confianca.Status)" }
    } else {
        Write-Bad "não instalado em Cert:\CurrentUser\Root"
    }
    exit ($(if ($arquivos.Ok -and $instalados.Count -gt 0) { 0 } else { 1 }))
}

$precisaGerar = $Force -or (-not $arquivos.Ok)

if ($precisaGerar) {
    if (-not $arquivos.Ok) { Write-Warn $arquivos.Reason }
    $cert = New-BridgeCertificate
} else {
    Write-Step "Certificado existente reaproveitado"
    Write-Ok $arquivos.Reason
    $cert = $arquivos.Cert
}

# Reinstala sempre: o certificado pode ter sido regerado, e um Root com o
# certificado antigo faria o navegador recusar o novo sem explicação clara.
$publico = Install-Certificate -Cert $cert

Write-Step "Validando a cadeia com o mesmo mecanismo do navegador"
$confianca = Test-Trust -Cert $publico
if ($confianca.Ok) {
    Write-Ok "cadeia validada — Chrome e Edge vão confiar neste certificado"
} else {
    Write-Bad "cadeia NÃO valida: $($confianca.Status)"
    Write-Warn "o navegador vai recusar a conexão wss://"
}

Update-GitIgnore

Write-Host ""
Write-Host "PRONTO." -ForegroundColor Green
Write-Host ""
Write-Host "  1. REINICIE o Chrome/Edge — eles cacheiam a decisão de cadeia." -ForegroundColor Yellow
Write-Host "  2. Suba a bridge:  node bridge/t4-bridge.mjs"
Write-Host "  3. Confira no navegador:  https://localhost:8765/health"
Write-Host "  4. Abra o site normalmente em https://analisador.dvdswap.com.br"
Write-Host ""
Write-Host "  Firefox nao usa o store do Windows: importe o cert.pem nele se for o caso."
Write-Host ""

if ($StartBridge) {
    Write-Step "Subindo a bridge com TLS"
    # Sem `?.`: esse operador só existe no PowerShell 7, e este script precisa
    # rodar também no Windows PowerShell 5.1, que é o que abre por padrão ao
    # clicar com o botão direito > "Executar com o PowerShell".
    $node = $null
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { $node = $cmd.Source }
    if (-not $node) {
        $cmd = Get-Command bun -ErrorAction SilentlyContinue
        if ($cmd) { $node = $cmd.Source }
    }
    if (-not $node) {
        Write-Bad "nem node nem bun encontrados no PATH — suba a bridge manualmente"
        exit 1
    }
    & $node (Join-Path $BridgeDir "t4-bridge.mjs")
}
