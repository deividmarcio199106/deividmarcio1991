# Subir o NEXUS e igualar o Backtest à Operação ao Vivo

## Parte 1 — Subir o projeto como está

Copiar o conteúdo do arquivo enviado para o repositório (sem metadados de git), mantendo SQLite local (`node:sqlite`) e Ollama, como você escolheu:

- Código: `src/` completo (rotas, componentes, hooks, engines, services, lib), `migrations/`, `docs/`, `public/`, `Dockerfile`, `docker-compose.yml`, `.env.example`, `vitest.config.ts`.
- Dependências do `package.json` do pacote (lightweight-charts, recharts, radix, etc.) instaladas no projeto.
- Rodar a suíte de testes (`vitest`) e o typecheck para confirmar que a base subiu íntegra.

Aviso importante: o preview do Lovable roda em runtime edge, onde `node:sqlite` e o Ollama da sua VPS não existem. Portanto as telas que dependem de persistência e de IA vão mostrar erro no preview — o alvo continua sendo o deploy na VPS via Docker. O código fica versionado e testável aqui.

## Parte 2 — Backtest com o cockpit idêntico ao ao vivo

Hoje as duas telas já usam o MESMO motor de decisão (`analysisPipeline.analyze`, sem look-ahead), mas o Backtest só mostra o gravador e as estatísticas agregadas. Vou igualar a apresentação.

Extrair o cockpit da Operação ao Vivo para um componente compartilhado (`AnalysisCockpit`) com as três colunas atuais:

1. Contexto do mercado (ativo, regime, estado de leitura, POIs, liquidez).
2. Gráfico dominante (`TradingChart`) com zona de POI e as linhas ENTRADA / STOP / PARCIAL / ALVO.
3. Decisão + gestão da operação (`ManagementPanel`, `TradeManagementCard`, `EvidenceTable`) e o chat da IA.

Na tela de Backtest, o cockpit passa a ser alimentado pelo replay:

- Durante a gravação/processamento, o cockpit acompanha a análise no instante T corrente — mesma leitura, mesmos bloqueios, mesmo plano que ao vivo.
- Depois de processar, um controle de navegação (voltar/avançar/play sobre os passos do replay) reposiciona o cockpit em qualquer decisão congelada, mostrando entrada, stop, parcial, alvo e o desfecho (GANHO/PERDA/NEUTRO, R, MFE/MAE).
- As linhas de preço usam os valores CONGELADOS da decisão, exatamente como o `frozenEntry` do ao vivo.
- As estatísticas da base histórica e o assistente continuam abaixo do cockpit.

## Detalhes técnicos

- `runChronologicalReplay` já devolve `steps` e `decisions` com o `AnalysisResult` completo por decisão; expor esses passos no `useReplayRecorder`/`ReplayResult` para alimentar o cockpit sem recalcular nada.
- Criar `src/components/analysis/AnalysisCockpit.tsx` com props puras (`candles`, `analysis`, `frozen`, `management`, `evidence`) e refatorar `operacao-ao-vivo.tsx` para consumi-lo — nenhuma mudança de comportamento no ao vivo.
- `backtest.tsx` monta o mesmo cockpit com os candles costurados do segmento e a análise do passo selecionado; painéis que só existem ao vivo (captura de tela, calibração) ficam fora.
- Regra anti look-ahead preservada: o cockpit só recebe candles com `t <= T` do passo selecionado.
