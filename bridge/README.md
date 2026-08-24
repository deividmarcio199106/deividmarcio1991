# t4-bridge — Profit RTD → WebSocket local

A bridge é o único caminho por onde dado de mercado real entra no T4 no modo RTD.
Ela roda na **sua máquina**, ao lado do Profit, e não depende de internet.

```
Profit ──RTD──> Excel ──HTTP──> t4-bridge ──WebSocket──> site ──> candles 1Min ──> T4
```

**Não existe modo simulado.** Não há gerador de tick, replay ou demo. Profit fechado
= bridge sem dados = T4 bloqueado. É esse o comportamento correto.

---

## 1. Subir a bridge

Requer Node 18+ **ou** Bun. Sem `npm install` — a bridge não tem dependências.

```bash
node bridge/t4-bridge.mjs
```

Saída esperada:

```
[bridge] t4-bridge 1.0.0 — sessão 3f2c...
[bridge] WebSocket  ws://127.0.0.1:8765
[bridge] Ingest     POST http://127.0.0.1:8765/ingest
[bridge] Health     GET  http://127.0.0.1:8765/health
[bridge] Aguardando ticks reais do Profit. Não há gerador simulado.
```

Opções: `--port 8765`, `--host 127.0.0.1`, `--token SEGREDO`
(ou as variáveis `T4_BRIDGE_PORT`, `T4_BRIDGE_HOST`, `T4_BRIDGE_TOKEN`).

Por padrão escuta **só em 127.0.0.1** — nada sai da máquina.

---

## 2. Conectar o RTD do Profit

O servidor RTD do Profit precisa de um host RTD. O host universal é o Excel.
Escolha **uma** das duas opções — as duas leem exatamente as mesmas células.

### Opção A — Módulo VBA (`rtd/T4_RTD.bas`), envio dirigido por evento

Publica no instante em que o RTD recalcula. É o caminho de menor latência.

1. Excel → `Alt+F11` → Arquivo → Importar Arquivo… → `bridge/rtd/T4_RTD.bas`
2. Crie a planilha `RTD` com este layout (linha 1 = cabeçalho, dados a partir da 2):

   | | A | B | C | D | E | F | G |
   |---|---|---|---|---|---|---|---|
   |1| ATIVO | ULTIMO | COMPRA | VENDA | VOLUME | QTD | HORA |
   |2| WINFUT | `=RTD(...)` | … | … | … | … | … |
   |3| WDOFUT | `=RTD(...)` | … | … | … | … | … |

   Fórmulas:

   ```excel
   B2: =RTD("RTDTrading.RtdServer";;$A2;"ULT")
   C2: =RTD("RTDTrading.RtdServer";;$A2;"COMPRA")
   D2: =RTD("RTDTrading.RtdServer";;$A2;"VENDA")
   E2: =RTD("RTDTrading.RtdServer";;$A2;"VOL")
   F2: =RTD("RTDTrading.RtdServer";;$A2;"QTD_ULT")
   G2: =RTD("RTDTrading.RtdServer";;$A2;"HORA")
   ```

   > Confirme os nomes dos campos na **sua** versão do Profit: clique com o botão
   > direito na cotação → *Copiar fórmula RTD* e compare. Nomes de campo mudam
   > entre versões; a bridge recusa o que não entender em vez de adivinhar.

3. No código da planilha `RTD` (não no módulo), cole:

   ```vb
   Private Sub Worksheet_Calculate()
       T4_RTD.CapturarTicks Me
   End Sub
   ```

4. Salve como `.xlsm` e habilite macros.

Diagnóstico: `=T4_STATUS()` em qualquer célula mostra buffer, erros e último envio.

### Opção B — PowerShell (`rtd/Push-ProfitRtd.ps1`), sem macro

Lê por COM a planilha já aberta e publica a cada 200 ms.

```powershell
powershell -ExecutionPolicy Bypass -File bridge\rtd\Push-ProfitRtd.ps1 -Sheet RTD
```

Mesmo layout de células da Opção A. Requer o Excel **aberto** com as fórmulas.

### Opção C — Seu próprio produtor

Qualquer programa que faça POST no contrato abaixo funciona.

---

## 3. Contrato de ingest

`POST http://127.0.0.1:8765/ingest` · `Content-Type: application/json`
Aceita um objeto ou um array (lote). Header `X-Bridge-Token` quando a bridge
subiu com `--token`.

```json
{
  "symbol": "WINFUT",
  "timestamp": "2026-08-10T13:45:12",
  "price": 141230,
  "bid": 141225,
  "ask": 141235,
  "volume": 184320,
  "qty": 5
}
```

| Campo | Obrigatório | Observação |
|---|---|---|
| `symbol` | sim | normalizado para MAIÚSCULAS |
| `timestamp` | sim | epoch ms, epoch s, ISO, `"HH:MM:SS"` ou `"yyyy-MM-dd HH:mm:ss"`. **ISO sem fuso = hora local da máquina**, que é a hora do pregão |
| `price` | sim | > 0 |
| `bid` / `ask` | não | ignorados se ≤ 0 |
| `volume` | não | volume acumulado do dia |
| `qty` | não | quantidade do negócio |

Rejeições (contadas em `/health`, nunca corrigidas silenciosamente):
`symbol ausente`, `timestamp ausente ou ilegível`, `timestamp no futuro`
(> 60 s adiante), `price ausente`, `price não positivo`.

Resposta: `{"ok":true,"accepted":3,"rejected":0,"errors":[]}`

---

## 4. Protocolo WebSocket

Conecte em `ws://127.0.0.1:8765`.

**Bridge → cliente**

| `type` | Quando | Carga |
|---|---|---|
| `hello` | na conexão | `sessionId`, `version`, `serverTime`, `producer`, último tick por ativo |
| `tick` | a cada tick aceito | `tick` com `seq` monotônico por ativo |
| `heartbeat` | a cada 1 s | `serverTime`, `producer`, contadores |
| `subscribed` | após `subscribe` | ativos efetivos + último tick |
| `pong` | após `ping` | `clientTime` ecoado + `serverTime` |

**Cliente → bridge**

```json
{"type":"subscribe","symbols":["WINFUT"]}
{"type":"ping","clientTime":1760000000000}
```

Dois campos sustentam a continuidade do feed:

- **`sessionId`** — muda quando a bridge reinicia. O site zera candles e histórico
  ao ver `sessionId` diferente, porque `seq` recomeça.
- **`seq`** — monotônico por ativo. Salto de sequência = tick perdido; o site
  registra a lacuna em vez de emendar a série como se nada tivesse acontecido.

---

## 5. Health

`GET http://127.0.0.1:8765/health`

```json
{
  "ok": true,
  "producer": "LIVE",
  "lastIngestAgeMs": 240,
  "ticksAccepted": 18402,
  "ticksRejected": 0,
  "clients": 1,
  "symbols": [{ "symbol": "WINFUT", "ticks": 18402, "seq": 18402, "lastPrice": 141230 }]
}
```

`producer`: `WAITING` (nunca chegou tick) · `LIVE` · `STALE` (sem ingest há > 10 s).

---

## 6. HTTPS em produção — TLS na mesma porta

Uma página servida por **HTTPS não pode abrir `ws://`**: o navegador bloqueia
antes de qualquer tentativa e o erro não diz o motivo. Por isso a bridge fala
**os dois esquemas na mesma porta 8765**, decidindo pelo primeiro byte da
conexão (`0x16` é um ClientHello TLS; uma letra ASCII é HTTP em claro).

| Quem | Endereço | Por quê |
|---|---|---|
| Site em `https://analisador.dvdswap.com.br` | `wss://localhost:8765` | única forma que o navegador aceita |
| Site em `http://localhost:3000` (dev) | `ws://127.0.0.1:8765` | sem TLS, sem certificado |
| Produtor RTD (Excel, PowerShell) | `http://127.0.0.1:8765/ingest` | cliente nativo não valida certificado |

O site escolhe sozinho pelo protocolo da própria página. Um endereço `ws://`
gravado antes do suporte a TLS é promovido para `wss://` automaticamente.

### Preparar o TLS (uma vez)

```powershell
powershell -ExecutionPolicy Bypass -File bridge\tls\setup-rtd-tls.ps1
```

Gera o certificado com SAN `localhost` + `127.0.0.1` + `::1`, instala em
`Cert:\CurrentUser\Root` (**não exige administrador**), valida a cadeia com o
mesmo mecanismo do navegador e acrescenta os `.pem` ao `.gitignore`.

**Reinicie o Chrome/Edge depois** — eles guardam a decisão de cadeia em cache.

Confira abrindo `https://localhost:8765/health`: se aparecer o JSON, está pronto.

Outras opções: `-Check` (só verifica), `-Force` (regera), `-Uninstall` (remove),
`-StartBridge` (sobe a bridge ao final).

> **Firefox** não usa o store do Windows. Se você opera por ele, importe o
> `cert.pem` nas configurações ou ligue `security.enterprise_roots.enabled`.

### O que a bridge NÃO faz

- **Não escuta fora do loopback.** `--host 0.0.0.0` é recusado com erro, não
  aceito com aviso. Os dados do Profit não saem da máquina.
- **Não aceita qualquer origem.** Só `https://analisador.dvdswap.com.br`,
  `http://localhost:3000` e `http://127.0.0.1:3000` podem abrir o WebSocket.
  Sem isso, qualquer site aberto no seu navegador durante o pregão poderia ler
  seu book — a política de mesma origem não protege WebSocket.
- **Não precisa de túnel.** Nada de ngrok, nada de expor a 8765 à internet.

---

## 7. Teste da bridge sem o Profit

Verifica **a bridge**, não o mercado — o tick é declaradamente de teste e vai
para um símbolo `TESTE`, que o T4 não aceita como ativo de operação.

```bash
node bridge/selftest.mjs
```
