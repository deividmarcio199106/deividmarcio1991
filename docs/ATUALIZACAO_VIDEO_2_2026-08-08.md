# Atualização baseada no vídeo 2 — 08/08/2026

Esta revisão foi feita a partir da observação do fluxo real no Profit: o usuário navega pelo gráfico histórico, com janelas fortemente sobrepostas, mudanças de autoescala e saltos entre períodos.

## Correções aplicadas

- Backtest usa o mesmo compartilhamento de tela da Operação ao Vivo.
- Um único clique seleciona a janela e inicia o Backtest; não há etapa de gravação/upload.
- O gráfico compartilhado continua visível dentro do analisador.
- Calibração de preço não bloqueia leitura estrutural; enquanto ela procura âncoras, a estrutura roda em unidades geométricas relativas.
- A calibração é revalidada periodicamente porque a autoescala do Profit pode mudar sem redimensionar a janela.
- A costura geométrica aceita mudança afim de escala/offset somente enquanto não há preço real calibrado.
- Rótulos brasileiros do WIN como `203.625` são normalizados para `203625` quando o modelo visual devolve o valor como decimal.
- O OCR de data/hora do Backtest usa uma banda dedicada do eixo de tempo (~82%–95% da altura e sem a extrema direita), evitando a ROI da escala de preço e reduzindo risco de ler barra do Windows/status externo.
- Cada lote de candles revelado em um frame é reproduzido internamente candle a candle. A decisão em `T` recebe somente o histórico que termina em `T`.
- Candles posteriores só atualizam o desfecho de uma decisão já congelada; nunca recalculam a decisão original.
- Frames sobrepostos são deduplicados; retrocessos/saltos continuam abrindo novo segmento.
- Teste da visão foi isolado das variáveis `OLLAMA_*` da VPS e usa `qwen3.5:35b`, evitando falso erro por ambiente externo.

## Motivo da fronteira cronológica

No vídeo real, uma mesma tela pode mostrar candles posteriores ao ponto destacado pelo cursor. Tratar a tela inteira como conhecimento disponível em um instante antigo contaminaria o backtest com look-ahead. `chronologicalFrontiers` transforma cada lote novo em passos progressivos, garantindo que cada análise só veja o prefixo temporal permitido.

## Validação recomendada na VPS

```bash
bun install
bun run typecheck
bun run test
bun run build
```

A revisão não altera automaticamente a técnica de produção a partir de uma única gravação. Primeiro corrige a ingestão temporal para que os próximos resultados de backtest sejam estatisticamente confiáveis; mudanças de técnica devem passar por amostra, OOS e walk-forward antes de promoção.
