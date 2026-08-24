# T4 — produto final

## Objetivo

T4 é a técnica única de produção para WIN 1m. Replay e Ao Vivo usam o mesmo `analysisPipeline` e o mesmo `evaluateT4`, sempre com candle fechado e sem look-ahead.

## Gestão

- 3 contratos.
- Stop por invalidação estrutural; nunca encurtar para forçar RR.
- Espaço técnico mínimo: 3R.
- Contrato 1: 3R.
- Contrato 2: 5R.
- Contrato 3: runner estrutural.
- Proteção após 3,5R; lock +0,25R; trailing do runner a partir de 5R.

## Famílias T4

- TREND_FIRST_PULLBACK / LPS-LPSY.
- RANGE_SWEEP nas bordas.
- FAILED_BREAKOUT confirmado.
- PHASE_RESET completo.
- EXPANSION_RETEST sem perseguir candle esticado.
- HSS_CAPTURE somente com captura + estrutura + reteste.

## Guards

DIRECTION_SANITY, OVEREXTENSION_BLOCK, FAKE_CONTINUATION_DETECTOR, LOSS_RESET, REAL_3R_SPACE e NO_MIDDLE_RANGE.

## Critérios de qualidade

- Mínimo 12 pregões operados/mês quando a base observada possuir >=12 pregões.
- Preferência: 14–18 pregões/mês.
- PF agregado alvo >=3.
- DD alvo <=5R.
- RR mínimo 1:3.

## Aprendizado diário

Ao encerrar cada pregão, T4 revisa trades, no-trade, MFE/MAE, direção, stop, alvo e degradação por setup. O aprendizado cria uma candidata de laboratório versionada inclusive quando o dia observado termina sem trade. A produção fica congelada durante toda a sessão. Mudanças só podem chegar à produção após BACKTEST -> OOS -> WALK_FORWARD -> VALIDATED e promoção; a nova versão vale apenas na sessão seguinte.

## Paridade replay x ao vivo

O replay não usa o resultado futuro para confirmar entrada. O mesmo candle fechado gera a mesma leitura técnica quando o mesmo histórico, escala, símbolo, timeframe e versão T4 são reproduzidos. Diferenças de OCR/captura/zoom podem mudar a reconstrução visual; por isso a sessão persiste versão, eventos, segmentos e trades para auditoria.

## Benchmark de desenvolvimento Fev–Jul/2026

Este benchmark é de desenvolvimento sobre reconstrução visual, não OOS independente e não OHLC/tick oficial.

| Mês       | Base disponível | Operados | Gain | Loss | Pontos estimados |   PF |    DD |
| --------- | --------------: | -------: | ---: | ---: | ---------------: | ---: | ----: |
| Fevereiro |              11 |       10 |    7 |    3 |         +2.629,6 | 5,83 | 1,76R |
| Março     |              22 |       17 |   11 |    6 |         +3.635,3 | 4,97 |    3R |
| Abril     |              17 |       13 |    7 |    5 |           +320,6 | 1,92 |    2R |
| Maio      |              16 |       14 |    6 |    8 |         +1.284,3 | 2,52 |    3R |
| Junho     |              19 |       14 |    9 |    5 |         +1.438,9 | 2,51 |    2R |
| Julho     |              22 |       15 |    8 |    7 |         +2.027,4 | 2,68 |    3R |

Total: 84 dias operados, 48 gain, 35 loss, +11.252,3 pontos estimados, PF 3,09, DD 3R.

Para 3 WIN, usando R$0,60 por ponto, o benchmark bruto equivalente é R$6.751,39 antes de imposto/taxas. Resultado histórico não garante resultado futuro.
