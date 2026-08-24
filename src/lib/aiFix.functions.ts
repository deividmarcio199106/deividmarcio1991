import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import {
  PROVIDER_ORDER,
  checkAllProviders,
  publicProviderStatus,
  routeAI,
  type AIProviderId,
} from "@/services/ai/router";
import { readAuditableFile } from "@/server/sourceAccess";

/**
 * CORREÇÃO ASSISTIDA POR IA — lado servidor.
 *
 * O que estas funções fazem: leem arquivo dentro da allowlist, mandam para o
 * provedor escolhido junto do diagnóstico, e devolvem uma PROPOSTA em texto.
 *
 * O que elas deliberadamente NÃO fazem: escrever no disco. Aplicar patch em
 * produção a partir de um clique no navegador é a diferença entre uma
 * ferramenta de diagnóstico e uma superfície de execução remota de código.
 * A aplicação continua sendo um passo humano, com o diff na mão.
 */

const FIX_SYSTEM = `Você é um engenheiro sênior revisando um analisador de day trade em TypeScript (TanStack Start + React 19 + Vitest).

Contexto que não pode ser violado:
- A técnica T4 é DETERMINÍSTICA. Você não pode propor que a IA gere, altere ou libere sinal de mercado.
- A fonte operacional atual é Profit Vision: getDisplayMedia -> useProfitVision -> ChartTracker -> analyze -> decide -> máquina de entrada. O caminho antigo (planilha em tempo real, ponte local por WebSocket e os hooks de sessão que reconstruíam candle por amostragem) foi REMOVIDO do runtime e não pode ser reintroduzido — há um teste de arquitetura que falha se qualquer um daqueles identificadores voltar ao código.
- Nunca proponha mock, simulação ou dado sintético em caminho de produção.
- Preço, hora e volume são da fonte. Não proponha "corrigir" preço, preencher candle faltante ou emendar lacuna de série.
- Nenhuma chave de API pode ir para código de cliente.

Regras da resposta:
- Português do Brasil, direto e técnico.
- Comece pela CAUSA RAIZ em uma frase.
- Depois: o patch mínimo, em bloco de código com o caminho do arquivo.
- Depois: como verificar (comando de teste concreto).
- Se o diagnóstico não for suficiente para concluir, diga exatamente qual informação falta. Não invente correção.
- Nunca prometa que o patch funciona sem rodar typecheck, lint, testes e build.`;

const ProposeInput = z.object({
  provider: z.enum(["claude", "openai", "gemini", "ollama"]).optional(),
  /** Resumo do diagnóstico já formatado pelo cliente. */
  report: z.string().min(1).max(40_000),
  /** Arquivos que o operador quer que a IA leia (validados contra a allowlist). */
  files: z.array(z.string().min(1).max(300)).max(6).optional(),
  /** Logs/stack recortados pelo MODO ENGENHEIRO. */
  logs: z.string().max(20_000).optional(),
});

export const getAiProviders = createServerFn({ method: "GET" }).handler(async () =>
  publicProviderStatus(),
);

export const checkAiProviders = createServerFn({ method: "GET" }).handler(async () => {
  const statuses = await checkAllProviders();
  // `proven` é o que separa READY real de READY presumido.
  return statuses.map((status) => ({
    id: status.id,
    label: status.label,
    configured: status.configured,
    state: status.state,
    model: status.model,
    latencyMs: status.latencyMs,
    proven: status.proven,
    message: status.message,
  }));
});

export const proposeAiFix = createServerFn({ method: "POST" })
  .validator((data: unknown) => ProposeInput.parse(data))
  .handler(async ({ data }) => {
    const requested = data.files ?? [];
    const attachments: string[] = [];
    const refused: string[] = [];

    for (const path of requested) {
      const result = readAuditableFile(path);
      if (result.ok) {
        attachments.push(`--- ${result.path} ---\n${result.content}`);
      } else {
        refused.push(`${path}: ${result.reason}`);
      }
    }

    const prompt = [
      "DIAGNÓSTICO ATUAL:",
      data.report,
      data.logs ? `\nLOGS / STACK:\n${data.logs}` : "",
      attachments.length ? `\nARQUIVOS:\n${attachments.join("\n\n")}` : "",
      refused.length
        ? `\nARQUIVOS RECUSADOS PELA ALLOWLIST (não foram lidos):\n${refused.join("\n")}`
        : "",
      "\nProduza a análise no formato pedido.",
    ]
      .filter(Boolean)
      .join("\n");

    const response = await routeAI({
      system: FIX_SYSTEM,
      prompt,
      preferred: (data.provider ?? "claude") as AIProviderId,
      maxTokens: 6_000,
    });

    return {
      text: response.text,
      provider: response.provider,
      usedFallback: response.usedFallback,
      attempts: response.attempts,
      filesRead: attachments.length,
      refused,
      order: PROVIDER_ORDER,
    };
  });

const ReviewInput = ProposeInput.extend({
  /** Proposta da primeira IA, para ser criticada por outra. */
  proposal: z.string().min(1).max(40_000),
  reviewer: z.enum(["claude", "openai", "gemini", "ollama"]),
});

const REVIEW_SYSTEM = `Você revisa a proposta de correção de OUTRO modelo, num analisador de day trade T4 determinístico.

Sua tarefa é procurar defeito, não concordar:
- a correção ataca a causa raiz ou só esconde o sintoma?
- ela quebra alguma garantia? (T4 determinística, sem mock em produção, preço nunca corrigido, candle nunca fabricado, chave nunca no cliente)
- ela introduz regressão em quem consome o código alterado?
- os testes propostos realmente provariam a correção, ou passariam de qualquer jeito?

Responda em português do Brasil: VEREDITO (APROVA / APROVA COM RESSALVA / REJEITA), seguido dos motivos concretos. Se rejeitar, diga o que fazer em vez disso.`;

/** REVISÃO MULTI-IA: um modelo propõe, outro procura o defeito. */
export const reviewAiFix = createServerFn({ method: "POST" })
  .validator((data: unknown) => ReviewInput.parse(data))
  .handler(async ({ data }) => {
    const response = await routeAI({
      system: REVIEW_SYSTEM,
      prompt: ["DIAGNÓSTICO:", data.report, "\nPROPOSTA A REVISAR:", data.proposal].join("\n"),
      preferred: data.reviewer,
      maxTokens: 4_000,
    });
    return {
      text: response.text,
      provider: response.provider,
      usedFallback: response.usedFallback,
      attempts: response.attempts,
    };
  });
