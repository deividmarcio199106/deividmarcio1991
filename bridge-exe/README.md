# T4-Bridge

Ponte entre o Profit e o analisador T4. Executável Windows portátil: duplo
clique, sem instalação, sem administrador, sem Node, sem Bun e **sem Excel**.

## Por que não precisa mais de planilha

O Profit registra um servidor RTD COM e implementa a interface RTD **padrão do
Excel** (`IRtdServer`). O Excel nunca foi necessário — era um intermediário. Este
programa fala com o mesmo servidor diretamente:

| | |
|---|---|
| ProgID | `RTDTrading.RtdServer` |
| CLSID | `{272D2E65-05FB-4500-BD7B-5905D5B0A1B8}` |
| Host | `LocalServer32` → `profitchart.exe` |

> A documentação anterior deste projeto usava o ProgID `profitchart.rtd`, que
> **não existe**. Uma planilha montada com ele nunca receberia dado.

## Como usar

1. **Abra o Profit**, faça login e deixe o gráfico do ativo na tela.
2. Dê **duplo clique em `T4-Bridge.exe`**. Deixe a janela aberta.
3. Abra o site e clique em **CONECTAR T4**.

A ordem importa. A bridge **não abre o Profit** de propósito — veja abaixo.

## Por que a bridge exige o Profit já aberto

Ativar o COM com o Profit fechado faz o Windows iniciá-lo, o `ServerStart`
responde normalmente, e aí **todo `ConnectData` estoura** com
`Access violation in module profitchart.exe` — porque o programa subiu na tela
de login, sem sessão de dados. O erro parece da bridge e não é. Então ela
verifica o processo antes e diz o que fazer.

## Configuração

`t4-bridge.ini`, ao lado do executável. Tudo é opcional.

```ini
port   = 8765
symbol = WINFUT

# Nomes dos campos no RTD do Profit. Variam entre versoes; um nome errado
# aparece como campo vazio no diagnostico, nunca como preco inventado.
field.last   = ULT
field.open   = ABE
field.high   = MAX
field.low    = MIN
field.close  = FEC
field.volume = VOL
field.qty    = QTD
field.bid    = COMPRA
field.ask    = VENDA
field.trades = NEG
field.time   = HORA
field.date   = DATA

# TLS (necessario para o site em HTTPS)
pfx         = tls\bridge.pfx
pfxPassword = t4bridge
```

## Endereços

| | |
|---|---|
| WebSocket (site em HTTPS) | `wss://localhost:8765` |
| WebSocket (site em HTTP) | `ws://127.0.0.1:8765` |
| Saúde | `http://127.0.0.1:8765/health` |

Os dois esquemas atendem na **mesma porta**: o primeiro byte decide (`0x16` é um
ClientHello TLS). Escuta em `127.0.0.1` e `::1`, **nunca** `0.0.0.0` — o feed não
sai da máquina.

Só três origens podem abrir o WebSocket: `https://analisador.dvdswap.com.br`,
`http://localhost:3000` e `http://127.0.0.1:3000`. Sem essa lista, qualquer
página aberta no seu navegador durante o pregão poderia ler o book — a política
de mesma origem **não** protege WebSocket.

## Compilar

```
bridge-exe\build.cmd
```

Usa o `csc.exe` que já vem no Windows. Por isso o código é C# 5: sem
interpolação de string, sem `?.`, sem separador de dígito, sem `nameof`.

Compila para **x86** porque o `LocalServer32` do Profit é de 32 bits; um
processo x64 não instancia o COM dele.

### Se o executável sumir depois de compilar

É antivírus, não erro de código. Um `.exe` recém-compilado, sem assinatura
digital e que abre porta de rede é alvo clássico de falso positivo — observado
nesta máquina com o **Bitdefender Endpoint Security Tools**, que remove o
arquivo e faz a compilação seguinte falhar com `CS0016: Acesso negado`.

Libere a pasta `bridge-exe` no antivírus. Em Bitdefender corporativo isso pode
exigir o administrador de TI. Para conferir que o código está bom, compile em
`%TEMP%`: o mesmo comando gera o executável normalmente lá.

## Testar

```
node bridge-exe\selftest.mjs
```

Sobe o executável de verdade e verifica HTTP, `/health`, 404, allowlist de
origem, CORS, handshake WebSocket, `subscribe`/`hello`, `ping`/`pong` e
heartbeat.

O **fluxo de dados do RTD fica marcado PENDENTE**: exige Profit aberto e logado,
e dizer que passou sem testar seria pior que dizer que falta.

## O que ele nunca faz

Não envia ordem. Não clica no Profit. Não lê a tela. Não inventa preço nem
candle. Campo que não veio é nulo, nunca zero — zero é um preço, ausência de
dado não é.
