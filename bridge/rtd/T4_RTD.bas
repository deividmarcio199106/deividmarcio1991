Attribute VB_Name = "T4_RTD"
'==============================================================================
' T4_RTD — produtor RTD do Profit para a t4-bridge.
'
' Este módulo NÃO inventa preço. Ele só lê as células que o servidor RTD do
' Profit atualiza e repassa o valor para a bridge local. Se o Profit fechar,
' as células param de mudar, nada é enviado, e o T4 se bloqueia sozinho.
'
' INSTALAÇÃO
' 1. Abra o Excel > Alt+F11 > Arquivo > Importar Arquivo... > T4_RTD.bas
' 2. Crie uma planilha chamada "RTD" com este layout (linha 1 = cabeçalho):
'
'      A          B        C       D       E         F      G
'  1  ATIVO      ULTIMO   COMPRA  VENDA   VOLUME    QTD    HORA
'  2  WINFUT     =RTD(... )  ...
'  3  WDOFUT     =RTD(... )  ...
'
'    Fórmulas (confirme os nomes dos campos na SUA versão do Profit —
'    Ferramentas > RTD, ou clique com o botão direito na cotação > Copiar RTD):
'
'      B2: =RTD("RTDTrading.RtdServer";;$A2;"ULT")
'      C2: =RTD("RTDTrading.RtdServer";;$A2;"COMPRA")
'      D2: =RTD("RTDTrading.RtdServer";;$A2;"VENDA")
'      E2: =RTD("RTDTrading.RtdServer";;$A2;"VOL")
'      F2: =RTD("RTDTrading.RtdServer";;$A2;"QTD_ULT")
'      G2: =RTD("RTDTrading.RtdServer";;$A2;"HORA")
'
'    Arraste a linha 2 para baixo para cada ativo que quiser publicar.
'
' 3. Cole o gatilho abaixo no código da PLANILHA "RTD" (não neste módulo):
'
'      Private Sub Worksheet_Calculate()
'          T4_RTD.CapturarTicks Me
'      End Sub
'
' 4. Suba a bridge (node bridge/t4-bridge.mjs) e salve como .xlsm.
'
' HORA: se a coluna G estiver vazia, o horário do RTD não está disponível e o
' módulo NÃO substitui por Now() — manda vazio e deixa a bridge recusar. Dado
' com hora inventada é pior que dado ausente.
'==============================================================================
Option Explicit

#If VBA7 Then
    Private Declare PtrSafe Function GetTickCount Lib "kernel32" () As Long
#Else
    Private Declare Function GetTickCount Lib "kernel32" () As Long
#End If

Private Const BRIDGE_URL As String = "http://127.0.0.1:8765/ingest"
Private Const BRIDGE_TOKEN As String = ""      ' preencha se subir a bridge com --token
Private Const MIN_FLUSH_MS As Long = 100       ' no máximo 10 envios por segundo
Private Const PRIMEIRA_LINHA As Long = 2

Private mBuffer As Collection
Private mUltimoFlush As Long
Private mUltimoValor As Object                 ' Scripting.Dictionary: ativo -> assinatura
Private mErros As Long

'--- Chamado pelo Worksheet_Calculate da planilha RTD --------------------------
Public Sub CapturarTicks(ByVal sh As Object)
    On Error GoTo Falhou

    Dim linha As Long
    Dim ativo As String, assinatura As String
    Dim ultimo As Variant, compra As Variant, venda As Variant
    Dim volume As Variant, qtd As Variant, hora As Variant

    If mBuffer Is Nothing Then Set mBuffer = New Collection
    If mUltimoValor Is Nothing Then Set mUltimoValor = CreateObject("Scripting.Dictionary")

    linha = PRIMEIRA_LINHA
    Do While Len(Trim$(CStr(sh.Cells(linha, 1).Value))) > 0
        ativo = UCase$(Trim$(CStr(sh.Cells(linha, 1).Value)))
        ultimo = sh.Cells(linha, 2).Value
        compra = sh.Cells(linha, 3).Value
        venda = sh.Cells(linha, 4).Value
        volume = sh.Cells(linha, 5).Value
        qtd = sh.Cells(linha, 6).Value
        hora = sh.Cells(linha, 7).Value

        ' Célula ainda em #N/A (RTD subindo) ou preço não numérico: ignora.
        If EhNumero(ultimo) Then
            assinatura = CStr(ultimo) & "|" & CStr(volume) & "|" & CStr(hora)
            ' Só publica mudança real: RTD recalcula a planilha inteira a cada tick.
            If Not mUltimoValor.Exists(ativo) Then
                mUltimoValor.Add ativo, ""
            End If
            If mUltimoValor(ativo) <> assinatura Then
                mUltimoValor(ativo) = assinatura
                mBuffer.Add MontarJson(ativo, ultimo, compra, venda, volume, qtd, hora)
            End If
        End If

        linha = linha + 1
    Loop

    If mBuffer.Count = 0 Then Exit Sub
    If GetTickCount - mUltimoFlush < MIN_FLUSH_MS Then Exit Sub
    Enviar

    Exit Sub
Falhou:
    mErros = mErros + 1
    ' Erro de rede não pode travar a planilha nem o Profit: só conta e segue.
    Err.Clear
End Sub

'--- Envia o lote acumulado ---------------------------------------------------
Public Sub Enviar()
    On Error GoTo Falhou

    If mBuffer Is Nothing Then Exit Sub
    If mBuffer.Count = 0 Then Exit Sub

    Dim corpo As String, i As Long
    corpo = "["
    For i = 1 To mBuffer.Count
        If i > 1 Then corpo = corpo & ","
        corpo = corpo & mBuffer(i)
    Next i
    corpo = corpo & "]"

    Set mBuffer = New Collection
    mUltimoFlush = GetTickCount

    Dim http As Object
    Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
    http.setTimeouts 500, 500, 1000, 2000
    http.Open "POST", BRIDGE_URL, False
    http.setRequestHeader "Content-Type", "application/json"
    If Len(BRIDGE_TOKEN) > 0 Then http.setRequestHeader "X-Bridge-Token", BRIDGE_TOKEN
    http.send corpo
    Exit Sub

Falhou:
    mErros = mErros + 1
    Set mBuffer = New Collection
    Err.Clear
End Sub

'--- Diagnóstico rápido: cole =T4_STATUS() em qualquer célula ------------------
Public Function T4_STATUS() As String
    Dim pendentes As Long
    If Not mBuffer Is Nothing Then pendentes = mBuffer.Count
    T4_STATUS = "buffer=" & pendentes & " erros=" & mErros & _
                " ultimoEnvio=" & mUltimoFlush
End Function

'--- Helpers ------------------------------------------------------------------
Private Function EhNumero(ByVal v As Variant) As Boolean
    If IsError(v) Then
        EhNumero = False
    ElseIf IsEmpty(v) Then
        EhNumero = False
    Else
        EhNumero = IsNumeric(v)
    End If
End Function

Private Function NumeroJson(ByVal v As Variant) As String
    If Not EhNumero(v) Then
        NumeroJson = "null"
    Else
        ' Ponto decimal sempre, independente da configuração regional do Windows.
        NumeroJson = Replace(Format$(CDbl(v), "0.############"), ",", ".")
    End If
End Function

Private Function HoraJson(ByVal v As Variant) As String
    If IsError(v) Or IsEmpty(v) Then
        HoraJson = "null"
    ElseIf IsDate(v) Then
        ' Data serial do Excel: manda ISO local, sem fuso (a bridge usa o local).
        HoraJson = """" & Format$(CDate(v), "yyyy-mm-dd\THH:nn:ss") & """"
    ElseIf Len(Trim$(CStr(v))) = 0 Then
        HoraJson = "null"
    Else
        ' Texto puro "HH:MM:SS" — a bridge resolve para o dia corrente.
        HoraJson = """" & Trim$(CStr(v)) & """"
    End If
End Function

Private Function MontarJson(ByVal ativo As String, ByVal ultimo As Variant, _
                            ByVal compra As Variant, ByVal venda As Variant, _
                            ByVal volume As Variant, ByVal qtd As Variant, _
                            ByVal hora As Variant) As String
    MontarJson = "{""symbol"":""" & ativo & """" & _
                 ",""timestamp"":" & HoraJson(hora) & _
                 ",""price"":" & NumeroJson(ultimo) & _
                 ",""bid"":" & NumeroJson(compra) & _
                 ",""ask"":" & NumeroJson(venda) & _
                 ",""volume"":" & NumeroJson(volume) & _
                 ",""qty"":" & NumeroJson(qtd) & "}"
End Function
