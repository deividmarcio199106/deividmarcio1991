import { beforeEach, describe, expect, it } from "vitest";

import { aiReachable, resetAiReachableCache } from "../aiReachable";
import { carregarProvider, PROVIDER_DESCONHECIDO, resetProviderCache } from "../providerCache";

/**
 * DEFEITO MEDIDO EM PRODUÇÃO (Network do domínio público): dois consumidores
 * independentes disparavam a MESMA pergunta a cada carga de página — par
 * idêntico de requisições. Não quebrava nada, e é por isso que sobreviveu.
 */

describe("saúde da IA — uma pergunta, uma requisição", () => {
  beforeEach(() => resetAiReachableCache());

  it("duas perguntas SIMULTÂNEAS viram UMA requisição", async () => {
    let chamadas = 0;
    const buscar = async () => {
      chamadas += 1;
      return true;
    };
    const [a, b] = await Promise.all([
      aiReachable({ buscar, agora: () => 0 }),
      aiReachable({ buscar, agora: () => 0 }),
    ]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(chamadas).toBe(1);
  });

  it("dentro do TTL reaproveita; passado o TTL mede de novo", async () => {
    let chamadas = 0;
    const buscar = async () => {
      chamadas += 1;
      return true;
    };
    await aiReachable({ buscar, agora: () => 1_000 });
    await aiReachable({ buscar, agora: () => 3_000 });
    expect(chamadas).toBe(1);
    // Saúde vencida seria pior que uma requisição a mais.
    await aiReachable({ buscar, agora: () => 20_000 });
    expect(chamadas).toBe(2);
  });

  it("falha de rede é false — ausência de resposta não é 'provavelmente no ar'", async () => {
    const ok = await aiReachable({
      buscar: async () => {
        throw new Error("rede caiu");
      },
      agora: () => 0,
    });
    expect(ok).toBe(false);
  });
});

describe("provedor de IA — compartilhado entre os dois hooks", () => {
  beforeEach(() => resetProviderCache());

  const provedor = { configured: true, model: "qwen3.5:35b", provider: "ollama" };

  it("leitura ao vivo e backtest montando juntos fazem UMA chamada", async () => {
    let chamadas = 0;
    const buscar = async () => {
      chamadas += 1;
      return provedor;
    };
    const [a, b] = await Promise.all([
      carregarProvider(buscar, () => 0),
      carregarProvider(buscar, () => 0),
    ]);
    expect(a.model).toBe("qwen3.5:35b");
    expect(b.model).toBe("qwen3.5:35b");
    expect(chamadas).toBe(1);
  });

  it("falha NÃO é memorizada — backend que volta não fica 5 min como 'não configurado'", async () => {
    let n = 0;
    const buscar = async () => {
      n += 1;
      if (n === 1) throw new Error("backend reiniciando");
      return provedor;
    };
    expect(await carregarProvider(buscar, () => 0)).toEqual(PROVIDER_DESCONHECIDO);
    // Segundos depois, dentro do TTL: pergunta de novo porque a falha não virou cache.
    expect((await carregarProvider(buscar, () => 1_000)).configured).toBe(true);
  });
});
