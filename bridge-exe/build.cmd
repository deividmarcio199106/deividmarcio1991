@echo off
REM Compila o T4-Bridge com o compilador C# que ja vem no Windows.
REM Nao precisa de .NET SDK, Visual Studio, Node, Bun nem Excel.
REM
REM Uso:  bridge-exe\build.cmd
REM Saida: bridge-exe\T4-Bridge.exe
REM
REM ATENCAO ao editar os .cs: o csc.exe do .NET Framework 4 e um compilador
REM C# 5. Nada de interpolacao de string ($"..."), separador de digito
REM (30_000), operador ?. nem nameof.

setlocal
set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" set CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe
if not exist "%CSC%" (
  echo ERRO: csc.exe nao encontrado. Este Windows nao tem o .NET Framework 4.
  exit /b 1
)

cd /d "%~dp0"

"%CSC%" /nologo /target:exe /platform:x86 /out:T4-Bridge.exe ^
  /reference:System.dll ^
  /reference:System.Core.dll ^
  /reference:System.Windows.Forms.dll ^
  /reference:System.Security.dll ^
  T4Bridge.cs RtdClient.cs WsServer.cs Program.cs

if errorlevel 1 goto :falhou
if not exist "T4-Bridge.exe" goto :sumiu

echo.
echo OK: bridge-exe\T4-Bridge.exe
echo.
echo Por que /platform:x86: o servidor RTD do Profit e um LocalServer32 de
echo 32 bits. Um processo x64 nao consegue instanciar o COM dele.
exit /b 0

:sumiu
echo.
echo O COMPILADOR TERMINOU MAS O EXECUTAVEL NAO ESTA NO DISCO.
echo.
echo Isso e antivirus, nao erro de codigo. Um .exe recem-compilado, sem
echo assinatura digital e que abre porta de rede e um alvo classico de
echo falso positivo  foi observado nesta maquina com o Bitdefender
echo Endpoint Security Tools.
echo.
echo O que fazer:
echo   1. abra o antivirus e libere a pasta bridge-exe (exclusao/excecao);
echo   2. em Bitdefender corporativo isso pode exigir o administrador de TI;
echo   3. para conferir que o codigo esta bom, compile fora da pasta vigiada:
echo      copie os .cs para %%TEMP%% e rode o csc la.
echo.
echo Nao ha o que corrigir no codigo: o mesmo comando gera o executavel
echo normalmente em uma pasta que o antivirus nao vigia.
exit /b 2

:falhou
echo.
echo FALHA NA COMPILACAO.
echo Se o erro for CS0016 "Acesso negado", leia a explicacao sobre antivirus
echo mais acima neste arquivo.
exit /b 1
