@echo off
REM Compila o Atualizador T4 usando o compilador C# que ja vem no Windows.
REM Nao precisa instalar .NET SDK, Visual Studio nem nada.
REM
REM Uso:  updater\build.cmd
REM Saida: updater\Atualizar-T4.exe
REM
REM ATENCAO ao editar AtualizadorT4.cs: o csc.exe do .NET Framework 4 e um
REM compilador C# 5. Nada de interpolacao de string ($"..."), separador de
REM digito (30_000), operador ?. nem nameof — o codigo esta escrito em C# 5
REM de proposito, para nao exigir instalacao de SDK nenhum.

setlocal
set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" set CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe
if not exist "%CSC%" (
  echo ERRO: csc.exe nao encontrado. Este Windows nao tem o .NET Framework 4.
  exit /b 1
)

pushd "%~dp0"

"%CSC%" /nologo /target:winexe /platform:anycpu /optimize+ ^
  /out:"Atualizar-T4.exe" ^
  /reference:System.dll ^
  /reference:System.Core.dll ^
  /reference:System.Drawing.dll ^
  /reference:System.Windows.Forms.dll ^
  AtualizadorT4.cs

if errorlevel 1 (
  echo.
  echo FALHA NA COMPILACAO.
  popd
  exit /b 1
)

echo.
echo OK: %~dp0Atualizar-T4.exe
echo Coloque updater.config.json na MESMA pasta do .exe antes de usar.
popd
endlocal
