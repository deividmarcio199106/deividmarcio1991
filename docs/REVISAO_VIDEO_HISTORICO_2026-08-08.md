# Revisão baseada nos vídeos históricos — 08/08/2026

Principais alterações:

- Backtest passa a conseguir construir evidência a partir de base vazia (`BACKTEST_DISCOVERY`).
- Operação ao vivo continua em modo de produção, sem afrouxar gates históricos.
- Decisões permanecem congeladas em T; candles futuros são apenas outcome.
- Resultado por pregão adicionado à interface, com GAIN/LOSS/SEM OPERAÇÃO e métricas em pontos/R.
- Extração visual ajustada para histórico comprimido do Profit e para reduzir contaminação por toolbar/UI.
- Testes adicionados para bootstrap histórico, pontos/dias e candles fechados de 1 px.

A análise offline dos vídeos é apenas uma reconstrução visual de auditoria. O Backtest persistido pelo aplicativo é a fonte operacional de referência após o deploy.
