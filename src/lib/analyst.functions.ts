import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { generateAIText, publicAIConfig } from "@/services/ai";

const Input = z.object({
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(12000) }))
    .min(1)
    .max(30),
  context: z.string().max(12000).optional(),
});

const MARKET_SYSTEM = `Você é o assistente de leitura de mercado da tela "Operação ao Vivo" de um analisador visual de day trade T4.

Regras:
- Responda em português do Brasil, curto e direto.
- Use EXCLUSIVAMENTE os dados fornecidos no contexto atual: ativo, timeframe, preço, direção, eventos, sequência causal, evidência histórica, entrada/stop/3R/5R/runner e bloqueios.
- Nunca invente números. Se um dado estiver indisponível, diga isso explicitamente.
- A decisão operacional vem da técnica validada + evidência histórica + risco; não crie notas, pontuações ou probabilidades artificiais.
- Nunca prometa resultado, lucro garantido, operação sem risco ou 100% de acerto.
- Esta ferramenta só analisa — nunca envia, altera ou cancela ordens.`;

const SYSTEM = `Você é um analista quantitativo sênior de day trade que ajuda a evoluir um analisador visual T4 baseado em observação contínua, eventos estruturados e validação estatística.

Regras:
- Responda em português do Brasil, direto e técnico, em markdown curto.
- Aponte falhas concretas como look-ahead, dupla contagem de evidências correlacionadas, stop/alvo irreais, amostra insuficiente e overfitting.
- Baseie recomendações nas estatísticas reais de backtest; se a amostra for pequena, diga isso claramente.
- Diferencie observação, hipótese candidata, validação OOS/walk-forward e técnica em produção.
- Não proponha notas agregadas. Proponha regras objetivas, features mensuráveis e testes que possam aprová-las ou rejeitá-las.
- Nunca altere automaticamente a estratégia em produção: candidatas precisam de validação e promoção controlada.
- Nunca prometa lucro nem transforme confluência técnica em probabilidade inventada.`;

/**
 * Toda a conversa com o provedor acontece no AI Gateway (`src/services/ai`): estas
 * funções de servidor só montam o prompt. Antes, cada uma repetia a montagem da
 * URL, o timeout e a tradução de erro.
 */

export const getAssistantProviders = createServerFn({ method: "GET" }).handler(async () => {
  const cfg = publicAIConfig();
  return { configured: cfg.configured, model: cfg.model, provider: cfg.provider };
});

export const askAnalyst = createServerFn({ method: "POST" })
  .validator((data: unknown) => Input.parse(data))
  .handler(async ({ data }) =>
    generateAIText({
      system: data.context ? `${SYSTEM}\n\nContexto atual do projeto:\n${data.context}` : SYSTEM,
      messages: data.messages,
    }),
  );

/** Chat opcional de mercado, usando o mesmo gateway e contexto congelado. */
export const askMarketAssistant = createServerFn({ method: "POST" })
  .validator((data: unknown) => Input.parse(data))
  .handler(async ({ data }) =>
    generateAIText({
      system: data.context
        ? `${MARKET_SYSTEM}\n\nContexto atual do mercado:\n${data.context}`
        : MARKET_SYSTEM,
      messages: data.messages,
    }),
  );
