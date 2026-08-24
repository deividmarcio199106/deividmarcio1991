# Analisador T4 — Observação Contínua do Profit

Aplicação desktop/web assistida para leitura visual do gráfico do Profit, replay histórico e acompanhamento operacional **sem execução automática de ordens**.

## Arquitetura atual

O fluxo oficial é contínuo:

`Profit → captura de tela → frame diff/ROI → calibração/OCR → reconstrução temporal → eventos estruturados → Wyckoff/HSS/Liquidez/POI/SMS → evidência histórica → OOS/walk-forward → decisão → gerenciamento → resultado real → SQLite → Laboratório`

Não existe autorização operacional por nota agregada ou por faixas percentuais. A quantidade máxima é limitada por risco financeiro configurado, distância do stop, valor por ponto, drawdown e teto físico de contratos.

## Modos

- **Operação ao Vivo:** usa uma versão congelada da técnica em produção durante toda a sessão, acompanha entrada/parcial/stop/alvo e grava o resultado real.
- **Backtest/Replay:** observa a janela histórica em movimento, reconstrói candles somente com dados já visíveis naquele instante, cria trechos quando há descontinuidade e rotula pregões quando o OCR confirma a data.
- **Laboratório de Técnicas:** usa os resultados persistidos para descobrir hipóteses, medir amostra, expectância, profit factor, drawdown, OOS e walk-forward. Uma candidata não altera uma sessão ao vivo em andamento.

## Persistência

A fonte oficial de histórico é SQLite no **backend**. O navegador mantém apenas cache hidratado da API e preferências locais de interface. Dados oficiais persistidos incluem:

- sessões ao vivo;
- pregões;
- trechos cronológicos;
- eventos de mercado;
- backtests/replays;
- trades e seus desfechos;
- técnica em produção;
- técnicas candidatas;
- resultados de validação.

Configure `DATA_DIR` (ou `DATABASE_PATH`) em produção. Na VPS sugerimos `/var/lib/analisador`.

## Ollama / GPU

O navegador nunca fala diretamente com o Ollama. O fluxo é:

`Browser → backend do analisador → 127.0.0.1:11435 na VPS → túnel SSH → Ollama da GPU`

Variáveis principais:

```env
OLLAMA_BASE_URL=http://127.0.0.1:11435
OLLAMA_TEXT_MODEL=qwen3.5:35b
OLLAMA_VISION_MODEL=qwen3.5:35b
DATA_DIR=/var/lib/analisador
```

`OLLAMA_VISION_MODEL` deve ser preenchido somente com um modelo multimodal realmente instalado. A aplicação informa separadamente disponibilidade textual e visual.

## Desenvolvimento

Requer Node.js >= 22.5 (SQLite nativo do Node) e Bun ou npm compatível com o projeto.

```bash
bun install
bun run typecheck
bun run test
bun run build
```

## Integridade estatística

- decisão em `T` só usa dados `<= T`;
- candles futuros servem apenas para classificar o desfecho;
- stop e alvo no mesmo candle, sem granularidade suficiente, são tratados conservadoramente como stop primeiro e ficam auditáveis;
- registros `LEGACY_IMAGE` permanecem históricos, mas ficam fora da evidência atual por padrão;
- replay repetido é deduplicado;
- ausência de amostra suficiente é exibida explicitamente, sem inventar confiança.

## Integração RTD

O pacote recebido não continha um conector RTD funcional do Profit. Por isso esta consolidação **não exibe RTD como funcionalidade pronta** e não simula dados. Uma integração RTD real exige um bridge compatível com o ambiente Windows/Profit e deve ser implementada e testada separadamente.

## Segurança

- nenhuma chave de API/SSH deve entrar no bundle do frontend;
- o analisador não envia ordens para corretora;
- o endpoint da GPU deve permanecer acessível apenas pelo backend da VPS.
