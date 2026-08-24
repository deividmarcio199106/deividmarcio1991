/**
 * "QUAL PROVEDOR DE IA ESTÁ CONFIGURADO?" — UMA pergunta, UMA requisição.
 *
 * Mesmo defeito medido no `/api/ai/health`, em outro par de consumidores:
 * `useProfitVision` e `useContinuousBacktest` chamavam `getAssistantProviders`
 * cada um no seu próprio efeito. Nas telas onde os dois hooks montam, o
 * Network mostrava a MESMA server function duas vezes por carga.
 *
 * A configuração do provedor muda quando alguém edita o ambiente do servidor —
 * ou seja, praticamente nunca durante uma sessão. Por isso aqui a janela é
 * longa: o objetivo é responder a mesma pergunta uma vez, não vigiar mudança.
 *
 * Os dois mecanismos são os mesmos do outro poller: TTL para colapsar chamadas
 * próximas e dedupe de voo para que perguntas simultâneas esperem a MESMA
 * promessa em vez de abrirem requisições paralelas.
 */

export interface ProviderInfo {
  configured: boolean;
  model: string;
  provider: string;
}

/** Provedor não muda no meio de um pregão; 5 minutos é folgado e seguro. */
const TTL_MS = 5 * 60_000;

/** Ausência declarada — o que se mostra quando a pergunta falha. */
export const PROVIDER_DESCONHECIDO: ProviderInfo = {
  configured: false,
  model: "",
  provider: "",
};

let ultima: { valor: ProviderInfo; at: number } | null = null;
let emVoo: Promise<ProviderInfo> | null = null;

/** Zera o estado compartilhado — usado pelos testes. */
export function resetProviderCache(): void {
  ultima = null;
  emVoo = null;
}

/**
 * Falha vira `PROVIDER_DESCONHECIDO`, e o resultado NÃO é memorizado: um erro
 * de rede não pode congelar "IA não configurada" por cinco minutos numa tela
 * cujo backend voltou no segundo seguinte.
 */
export async function carregarProvider(
  buscar: () => Promise<ProviderInfo>,
  agora: () => number = () => Date.now(),
): Promise<ProviderInfo> {
  const cache = ultima;
  if (cache !== null && agora() - cache.at < TTL_MS) return cache.valor;
  if (emVoo !== null) return await emVoo;

  emVoo = (async () => {
    try {
      const valor = await buscar();
      ultima = { valor, at: agora() };
      return valor;
    } catch {
      return PROVIDER_DESCONHECIDO;
    } finally {
      emVoo = null;
    }
  })();
  return await emVoo;
}
