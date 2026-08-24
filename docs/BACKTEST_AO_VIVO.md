# Backtest contínuo — leitura como se fosse ao vivo

Esta revisão corrige o bootstrap do histórico sem enfraquecer a operação ao vivo.

## Regra temporal

O Backtest revela e processa os candles em ordem cronológica. Uma decisão criada no instante T recebe apenas o histórico disponível até T. Entrada, stop, parcial, alvo, contexto e versão da técnica são congelados naquele instante. Candles posteriores só podem executar a entrada ou atualizar parcial, alvo, stop, MFE e MAE; eles não podem reescrever a decisão original.

## Bootstrap da evidência

Em produção, a decisão continua dependendo de evidência histórica validada. No Backtest, `BACKTEST_DISCOVERY` permite registrar um setup tecnicamente completo mesmo quando ainda não existem 30 casos semelhantes. Isso resolve o bloqueio em que uma base vazia nunca conseguia criar os próprios primeiros casos. A evidência histórica existente continua sendo registrada como informação, mas não autoriza a entrada histórica.

## Resultado por pregão

A tela de Backtest agora agrega pregões analisados, dias com gain, dias com loss, dias sem operação, operações, pontos ganhos/perdidos, saldo líquido, win rate, Profit Factor, expectância, drawdown, MFE e MAE. A tabela diária usa os trades efetivamente persistidos pelo Backtest.

## Captura visual

A extração de candles ignora melhor toolbar/topo e UI inferior do Profit. Candles históricos comprimidos com apenas 1 px de largura podem ser preservados; o candle em formação continua sendo removido pela posição mais à direita. A calibração de preço permanece independente da análise estrutural.

## Produção

`useLiveSession` não ativa `BACKTEST_DISCOVERY`. Portanto o modo ao vivo continua usando a técnica de produção e os gates de evidência/OOS/walk-forward existentes.
