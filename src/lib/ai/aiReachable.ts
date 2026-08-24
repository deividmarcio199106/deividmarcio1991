/**
 * "A IA está alcançável?" — UMA pergunta, UMA requisição.
 *
 * Dois consumidores independentes (o painel de captura e o `useProfitVision`)
 * mantinham cada um seu próprio `setInterval` de 30s batendo em
 * `/api/ai/health`. Nas telas onde ambos montam, cada carga disparava a mesma
 * checagem DUAS vezes — visível no Network como par idêntico. Não quebrava
 * nada, mas dobrava tráfego para responder a mesma coisa, e um terceiro
 * consumidor dobraria de novo.
 *
 * Aqui a resposta é compartilhada por dois mecanismos:
 *  — TTL curto: quem pergunta dentro da janela recebe a última leitura;
 *  — dedupe de voo: perguntas simultâneas esperam a MESMA promessa, em vez de
 *    abrirem requisições paralelas.
 *
 * O TTL é menor que o intervalo de sondagem de propósito: ele existe para
 * colapsar chamadas quase simultâneas, não para segurar um estado velho —
 * saúde vencida seria pior que uma requisição a mais.
 */

const TTL_MS = 5_000;

let ultimaLeitura: { ok: boolean; at: number } | null = null;
let emVoo: Promise<boolean> | null = null;

/** Zera o estado compartilhado — usado pelos testes. */
export function resetAiReachableCache(): void {
  ultimaLeitura = null;
  emVoo = null;
}

export interface AiReachableDeps {
  buscar: () => Promise<boolean>;
  agora: () => number;
}

const PADRAO: AiReachableDeps = {
  buscar: async () => {
    const r = await fetch("/api/ai/health", { cache: "no-store" });
    return r.ok;
  },
  agora: () => Date.now(),
};

/**
 * Devolve se a IA respondeu. Falha de rede é `false` — ausência de resposta
 * não é "provavelmente no ar".
 */
export async function aiReachable(deps: Partial<AiReachableDeps> = {}): Promise<boolean> {
  const { buscar, agora } = { ...PADRAO, ...deps };

  const cache = ultimaLeitura;
  if (cache !== null && agora() - cache.at < TTL_MS) return cache.ok;
  if (emVoo !== null) return await emVoo;

  emVoo = (async () => {
    try {
      const ok = await buscar();
      ultimaLeitura = { ok, at: agora() };
      return ok;
    } catch {
      ultimaLeitura = { ok: false, at: agora() };
      return false;
    } finally {
      emVoo = null;
    }
  })();
  return await emVoo;
}
