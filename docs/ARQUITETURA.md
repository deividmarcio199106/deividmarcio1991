# Arquitetura consolidada

## Pipeline

1. O usuário seleciona a janela real do Profit via captura nativa do navegador.
2. `frameProcessor` e a calibração preço↔pixel extraem somente dados observáveis.
3. O reconstrutor temporal mantém candles fechados separados do candle em formação.
4. O pipeline técnico produz fatos de estrutura, Wyckoff, liquidez, POI, HSS, SMS, regime, volatilidade e risco.
5. O event store transforma mudanças relevantes em eventos estruturados e mantém memória temporal curta.
6. O motor de similaridade consulta ocorrências históricas compatíveis.
7. O motor estatístico valida amostra, expectância, profit factor, drawdown, OOS e walk-forward.
8. O motor de decisão retorna AGUARDAR, REJEITAR ou ENTRAR e dimensiona contratos somente por risco financeiro configurado.
9. O gerenciamento congela entrada, stop, parcial e alvo na confirmação e acompanha o desfecho candle a candle.
10. Sessões, pregões, trechos, eventos, backtests e trades são persistidos em SQLite no servidor.
11. O Laboratório trabalha com hipóteses e versões candidatas sem alterar a técnica ativa de uma sessão em andamento.

## Anti-look-ahead

Replay e operação ao vivo usam somente dados conhecidos no instante da decisão. O desfecho posterior nunca recalcula a decisão congelada.

## Pregões e trechos

O OCR de contexto lê data/hora/ativo/timeframe em uma ROI. Uma data só é confirmada após leituras consecutivas coerentes. Descontinuidades de timeline continuam criando trechos independentes mesmo quando a data não muda.

## Persistência

SQLite é acessado somente no backend por `src/server/tradingRepository.ts`. O frontend usa `/api/trading/*` e mantém um cache hidratado; `localStorage` fica restrito a preferências de interface e memória não crítica do assistente.

Tabelas principais: `live_sessions`, `trading_sessions`, `segments`, `market_events`, `backtest_runs`, `trades`, `replay_sessions`, `techniques`, `technique_candidates`, `validation_results` e `app_state`.

## IA

A IA é separada em modelo textual e visual. Ollama usa `/api/chat` nativo. A disponibilidade do modelo visual é verificada de forma independente e nunca inferida apenas pelo nome do modelo.
