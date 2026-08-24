import { createServerFn } from "@tanstack/react-start";
import * as z from "zod";

import { aiConfig } from "@/services/ai/config";
import { aiBreaker, describeAIError } from "@/services/ai/gateway";
import { parseChartClock, type ChartClockRead } from "@/lib/vision/chartClock";

/**
 * Leitura de data/hora/ativo/timeframe da barra do gráfico (comando §16).
 * Usa EXCLUSIVAMENTE o modelo VISUAL configurado (AI_VISION_MODEL) — o modelo
 * textual nunca recebe imagem, mesmo que o nome sugira visão.
 */

const Input = z.object({ imageDataUrl: z.string().min(32) });

const PROMPT = `Você lê a FAIXA INFERIOR/eixo de tempo de um gráfico de trading do Profit.
Responda SOMENTE JSON: {"date":"dd/mm/aaaa ou UNKNOWN","time":"HH:mm ou UNKNOWN","asset":"código ou UNKNOWN","timeframe":"ex: 1 min ou UNKNOWN","confidence":0..1}.
Se existir um tooltip do cursor/crosshair com data completa e hora (ex.: 11/02/2026 15:01), ele tem PRIORIDADE. Caso contrário use a data/hora mais à direita que esteja realmente legível. Rótulos abreviados como 11/fev sem ano NÃO autorizam inventar o ano: nesse caso date=UNKNOWN. Ignore relógio/data do Windows, barra de tarefas, abas de layout e qualquer horário externo ao eixo do gráfico. Asset/timeframe podem ser UNKNOWN porque esta ROI pode não mostrá-los. Se não estiver visível, use UNKNOWN. NUNCA invente.`;

export const readChartClock = createServerFn({ method: "POST" })
  .validator((data: unknown) => Input.parse(data))
  .handler(async ({ data }): Promise<{ read: ChartClockRead | null; error: string | null }> => {
    const cfg = aiConfig();
    if (!cfg.baseUrl)
      return { read: null, error: "IA indisponível: configure OLLAMA_BASE_URL/AI_BASE_URL." };
    if (!cfg.visionModel)
      return { read: null, error: "Modelo visual não configurado. Defina OLLAMA_VISION_MODEL." };
    try {
      const base64 = data.imageDataUrl.split(",")[1] ?? "";
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (cfg.apiKey && cfg.apiKey !== "not-required") {
        headers.authorization = `Bearer ${cfg.apiKey}`;
      }
      const text = await aiBreaker.run(async () => {
        const response = await fetch(`${cfg.baseUrl}/api/chat`, {
          method: "POST",
          headers,
          signal: AbortSignal.timeout(cfg.timeoutMs),
          body: JSON.stringify({
            model: cfg.visionModel,
            stream: false,
            messages: [{ role: "user", content: PROMPT, images: [base64] }],
          }),
        });
        if (!response.ok) throw new Error(`status ${response.status}`);
        const payload = (await response.json()) as { message?: { content?: string } };
        return payload.message?.content ?? "";
      });
      return { read: parseChartClock(text), error: null };
    } catch (raised) {
      return { read: null, error: describeAIError(raised, cfg.visionModel, cfg.timeoutMs) };
    }
  });
