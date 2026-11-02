# Laboratório quantitativo WIN/WDO

Sistema de **pesquisa** de estratégias intradiárias para Mini Índice (WIN) e Mini Dólar (WDO).
Não envia ordens, não se conecta a corretora e não opera dinheiro real.

## Estado atual (02/11/2026)

- **Não há histórico OHLC no repositório.** O catálogo (`results/catalogo_datasets.csv`)
  encontrou só o ZIP `ANALISADOR_T4_RTD_bb247b8.zip`, que é um snapshot do próprio app T4
  (código e JSON, nenhum CSV). O arquivo `WDOFUT_F_0_5min_01-01-2026_01-11-2026.csv` da
  Bolsa Quant Pro **não está disponível** aqui. Por isso **não existe resultado de pesquisa**:
  nenhuma estratégia foi aprovada ou pode ser chamada de vencedora.
- **Sem GPU nesta máquina** (`nvidia-smi` ausente; `results/gpu_check.txt`). O XGBoost
  instalado tem suporte a CUDA e usa a GPU automaticamente onde ela existir.
- `results/exemplo_sintetico/` mostra o relatório gerado com dados **aleatórios** só para
  provar que o encanamento funciona. Ali, como esperado, as melhores configurações do treino
  (Sharpe alto dentro da amostra) perdem na validação e nada é congelado.

## Instalação

```bash
cd quant-lab
```

```bash
scripts/setup.sh
```

No Windows: `.\scripts\setup.ps1`. Requer Python 3.11+.

## Comandos

Todos rodam de dentro de `quant-lab/` (troque `.venv/bin/python` por
`.\.venv\Scripts\python.exe` no Windows).

| Comando | O que faz |
|---|---|
| `python -m qlab catalog --root ..` | Cataloga CSV, ZIP (inspecionado em memória) e repositórios de estratégia |
| `python -m qlab inspect ARQUIVO.csv` | Mostra separador, decimal, colunas, símbolo e timeframe detectados |
| `python -m qlab quality ARQUIVO.csv` | Grade de preços, horários, calendário B3, vencimentos e rolagem |
| `python -m qlab gpu-check` / `gpu-bench` | Detecta CUDA e mede XGBoost em CPU x GPU |
| `python -m qlab run --data ARQUIVO.csv` | Uma rodada delimitada (retoma de onde parou) |
| `python -m qlab status` | Resume experimentos, congelados, testes e alertas |
| `python -m qlab report` | Gera os CSVs e `results/relatorio.html` |
| `python -m qlab make-synthetic ...` | CSV **sintético** só para testar o software |

Primeira rodada com o arquivo da Bolsa Quant Pro (coloque-o em `quant-lab/data/`):

```bash
.venv/bin/python -m qlab inspect data/WDOFUT_F_0_5min_01-01-2026_01-11-2026.csv
```

```bash
.venv/bin/python -m qlab quality data/WDOFUT_F_0_5min_01-01-2026_01-11-2026.csv
```

```bash
scripts/run_round.sh --data data/WDOFUT_F_0_5min_01-01-2026_01-11-2026.csv --rounds 3 --max-minutes 30 --max-experiments 500
```

Com GPU: `scripts/gpu_check.sh` e depois `scripts/run_gpu.sh --data ...`.

## Formatos de CSV aceitos

O leitor detecta separador (`;` `,` tab), decimal (`,` ou `.`), separador de milhar, ordem
crescente ou decrescente e cabeçalhos em português ou inglês (Data, Hora, Abertura, Máxima,
Mínima, Fechamento, Volume, Quantidade / date, time, open, high, low, close, volume). Também
aceita o layout do Profit sem cabeçalho (9 colunas). Se o arquivo não for reconhecido, o
programa **para com erro** em vez de adivinhar. O formato exato da Bolsa Quant Pro não pôde ser
conferido: rode `inspect` primeiro e confira o resultado.

O símbolo (WIN/WDO) vem da coluna de ativo ou do nome do arquivo; senão use `--root WIN|WDO`.

## Protocolo de validação

1. **Sem lookahead.** Indicadores na barra t usam só barras ≤ t; a ordem é executada na
   abertura de t+1. `tests/test_no_lookahead.py` trunca a série em vários pontos e exige que
   nenhum indicador ou sinal mude.
2. **Divisão temporal 60/20/20** por pregão, em ordem cronológica. A divisão é gravada no
   SQLite na primeira rodada; mudar a proporção depois é recusado.
3. **Treino:** todas as configurações da grade são medidas só nos pregões de treino. Os 3
   melhores de cada família (por Sharpe, com mínimo de operações, líquido e PF > 1) seguem.
4. **Validação:** líquido > 0, PF ≥ 1,10, operações mínimas, **bootstrap estacionário com
   correção de Holm** sobre todas as avaliações de validação já feitas no dataset e
   **sensibilidade** (≥ 60% das configurações vizinhas na grade positivas). O XGBoost calibra
   o limiar de probabilidade aqui. Ensemble = voto majoritário dos aprovados, validado com
   "deixa um de fora".
5. **Walk-forward ancorado** por família nos pregões pré-teste, medindo o procedimento de
   seleção (não um parâmetro).
6. **Congelamento:** parâmetros (e o modelo XGBoost, com hash SHA-256) são gravados antes do
   teste. O modelo é recarregado e o hash conferido na avaliação.
7. **Teste final:** cada congelado é avaliado **uma única vez** (chave primária no SQLite) e há
   um **orçamento de teste** por dataset (padrão 10), para que rodadas repetidas não virem
   otimização no teste. Critérios: metas abaixo, **Deflated Sharpe** (com o número total de
   tentativas) e bootstrap com Bonferroni pelo orçamento.
8. **Alerta** só para candidato que passa em tudo no teste final **e** em dataset real
   (`state/alertas.jsonl` + tabela `alerts`). Dataset sintético nunca gera alerta.

## Metas e custos (`config/default.toml`)

- Capital R$ 2.000, até 5 contratos, risco por operação de 3% do capital; operação que não
  cabe no risco ou na margem é **pulada**, nunca forçada para 1 contrato.
- ≥ 70% de pregões positivos (entre os operados, com mínimo de 5 por mês) em cada mês do
  teste, 100% dos meses positivos, líquido após custos > 0, drawdown ≤ 30% do capital.
- WIN: tick 5 pts = R$ 1,00. WDO: tick 0,5 pt = R$ 5,00.
- **Suposições a confirmar com a sua corretora:** taxas por lado (WIN R$ 0,50; WDO R$ 1,50),
  slippage de 1 tick por lado, margem de day trade (WIN R$ 150; WDO R$ 300).
- Com R$ 2.000 e 3% de risco, um stop de WDO acima de ~4,5 pontos já não cabe em 1 contrato:
  muitas operações de WDO serão puladas. Isso é consequência real do capital, não um defeito.

Mudar custos, capital, horários ou rolagem muda o identificador dos experimentos, então tudo
é recalculado com a configuração nova.

## Famílias de estratégia

| Família | Estratégias |
|---|---|
| Abertura e rompimento | rompimento da faixa de abertura (3/6/12 barras), reversão de gap |
| Reversão à média | z-score do fechamento |
| Momentum | variação em N barras contra ATR |
| Volatilidade | expansão de range com fechamento no extremo |
| Regimes | reversão em volatilidade baixa, momentum em alta (percentil de 20 pregões) |
| VWAP | reversão à VWAP e cruzamento a favor da tendência (exige volume) |
| Tendência | cruzamento de médias exponenciais |
| Microestrutura | saldo de agressão; **só roda se o CSV trouxer volume comprador e vendedor** |
| ML | XGBoost (direção nas próximas 6 barras do mesmo pregão) |
| Ensemble | voto majoritário dos aprovados na validação |

Saídas comuns: stop de 1,0 ou 1,5 ATR, alvo de 1R ou 2R, zeragem às 17:50, até 3 operações
por pregão, sem posição de um dia para o outro.

## Execução contínua com limites

`run` executa **uma rodada delimitada**: para no orçamento de experimentos
(`--max-experiments`), no de tempo (`--max-minutes`), quando a fila acaba ou com Ctrl+C. Cada
lote é gravado no SQLite (`state/qlab.sqlite`) e em `state/checkpoint.json`; rodar de novo
continua do ponto em que parou e nunca repete um experimento. `--rounds N` (máximo 100) roda
várias rodadas seguidas e para antes se não houver nada novo. Não existe laço infinito.

O paralelismo é computacional: um pool de processos (`--workers`) roda as configurações em
paralelo, com resultado idêntico ao sequencial (testado). A GPU entra só no treino do XGBoost;
a simulação de operações é limitada por CPU, e por isso não vai para a GPU.

## Calendário B3

Feriados nacionais, Carnaval, Sexta-feira Santa, Corpus Christi, 24/12 e 31/12 sem pregão,
20/11 a partir de 2024. Vencimentos: WIN na quarta-feira mais próxima do dia 15 dos meses
pares; WDO no primeiro dia útil do mês. Rolagem prevista no pregão anterior ao vencimento;
nesse dia os indicadores descontam o salto de preço (ajuste causal "para frente"), enquanto a
execução usa o preço bruto. O calendário é verificação cruzada: divergências com os dados
aparecem no relatório de qualidade. **Confirme 25/01, 09/07 e 20/11 de anos anteriores no
calendário oficial da B3.**

## Testes

```bash
.venv/bin/python -m pytest -q
```

Cobrem calendário e vencimentos, contratos e dimensionamento, leitura de vários formatos,
ausência de lookahead (indicadores, sinais, ensemble e rótulo do ML), divisão cronológica,
motor de execução (entrada, stop antes do alvo na mesma barra, gap pelo stop, zeragem, custos,
operação pulada por risco), estatística (Holm, bootstrap, Deflated Sharpe), rodada delimitada,
retomada sem repetição, recusa de nova divisão, orçamento e unicidade do teste, alerta só em
dado real e paralelo igual ao sequencial. Um teste usa uma série com **vantagem plantada** para
provar que o funil aprova quando a vantagem existe; os outros provam que ruído não passa.

## Limitações conhecidas

- Simulação em barras: a ordem real dentro da barra é desconhecida (stop primeiro quando
  ambíguo; operações assim são contadas no relatório).
- Sem livro de ofertas nem negócio a negócio: microestrutura de verdade não é possível com OHLC.
- O teste final tem 20% do histórico; com 10 meses de dados são cerca de 2 meses, pouca
  amostra para uma meta de 100% de meses positivos.
- Imposto de renda de day trade (20% sobre o lucro mensal) não é descontado do líquido.
- A rota de orquestração desta entrega foi `solo`: não houve revisão independente por outro
  modelo. Veja o histórico do commit.

## Mapa de arquivos

```text
quant-lab/
├── config/default.toml   metas, contratos, custos, horários, orçamento
├── qlab/                 pacote Python (cli, runner, data, quality, features, strategies,
│                         backtest, metrics, validation, stats, ml, gpu, state, report, catalog)
├── tests/                pytest
├── scripts/              setup, rodada, GPU (sh e ps1)
├── data/                 coloque aqui os CSV de histórico
├── results/              catálogo, CSVs e relatório HTML
└── state/                SQLite, checkpoint, modelos e alertas (não versionado)
```
