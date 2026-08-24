import { describe, expect, it } from "vitest";

import {
  aggregateHealth,
  IDADE_CAPTURA_ERRO_MS,
  LATENCIA_ERRO_MS,
  GRAVACOES_DEGRADADO_BYTES,
  medirArmazenamento,
  medirGravacoes,
  medirFila,
  medirIdadeUltimaCaptura,
  medirLatencia,
  medirMemoria,
  naoMedido,
  podeEmitirSinal,
  SUBSISTEMAS_QUE_BLOQUEIAM_SINAL,
  type SubsystemHealth,
} from "../systemHealth";

/**
 * A LEI DESTE MÓDULO: um painel que fica verde porque não conseguiu medir é
 * pior que um painel vermelho — ele autoriza operar sobre uma ignorância que
 * parece confirmação. Estes testes trancam exatamente isso.
 */

const AT = Date.UTC(2026, 7, 19, 14, 0, 0);

const ok = (id: string): SubsystemHealth => ({
  id,
  label: id.toUpperCase(),
  state: "OK",
  detail: "medido e saudável",
  value: 1,
  unit: null,
});

/** Os três críticos medidos e saudáveis — o piso de qualquer cenário verde. */
function criticosSaudaveis(): SubsystemHealth[] {
  return SUBSISTEMAS_QUE_BLOQUEIAM_SINAL.map((id) => ok(id));
}

describe("agregação — o pior estado manda", () => {
  it("todos OK e os críticos presentes: OK", () => {
    const health = aggregateHealth(criticosSaudaveis(), AT);
    expect(health.state).toBe("OK");
    expect(health.checkedAt).toBe(AT);
    expect(health.note).toContain("saudáveis");
  });

  it("um DEGRADED entre OKs derruba o conjunto para DEGRADED", () => {
    const health = aggregateHealth(
      [...criticosSaudaveis(), naoMedido("pesquisa", "PESQUISA", "sem execução recente")],
      AT,
    );
    expect(health.state).toBe("DEGRADED");
    expect(health.note).toContain("PESQUISA");
  });

  it("um ERROR domina qualquer DEGRADED", () => {
    const erro: SubsystemHealth = {
      id: "banco",
      label: "BANCO",
      state: "ERROR",
      detail: "arquivo inacessível",
      value: null,
      unit: null,
    };
    const health = aggregateHealth([ok("captura"), ok("ia"), erro], AT);
    expect(health.state).toBe("ERROR");
    expect(health.note).toContain("em ERRO");
  });

  it("lista VAZIA é ERROR, nunca 'tudo bem'", () => {
    const health = aggregateHealth([], AT);
    expect(health.state).toBe("ERROR");
    expect(health.note).toContain("sem medição");
  });

  it("crítico que nem foi enumerado rebaixa: não medido não é OK", () => {
    // Só a captura foi medida; IA e banco não apareceram na lista.
    const health = aggregateHealth([ok("captura")], AT);
    expect(health.state).toBe("DEGRADED");
    expect(health.note).toContain("sem leitura");
  });
});

describe("podeEmitirSinal — falha de serviço não gera sinal falso", () => {
  it("com os três críticos medidos e sem ERROR, libera", () => {
    expect(podeEmitirSinal(aggregateHealth(criticosSaudaveis(), AT))).toBe(true);
  });

  it("qualquer crítico em ERROR bloqueia", () => {
    for (const alvo of SUBSISTEMAS_QUE_BLOQUEIAM_SINAL) {
      const leituras = criticosSaudaveis().map((s) =>
        s.id === alvo ? { ...s, state: "ERROR" as const } : s,
      );
      expect(podeEmitirSinal(aggregateHealth(leituras, AT))).toBe(false);
    }
  });

  it("crítico AUSENTE bloqueia igual a crítico quebrado", () => {
    for (const alvo of SUBSISTEMAS_QUE_BLOQUEIAM_SINAL) {
      const leituras = criticosSaudaveis().filter((s) => s.id !== alvo);
      expect(podeEmitirSinal(aggregateHealth(leituras, AT))).toBe(false);
    }
  });

  it("DEGRADED não bloqueia — degradado é aviso, não impedimento", () => {
    const leituras = criticosSaudaveis().map((s) =>
      s.id === "ia" ? { ...s, state: "DEGRADED" as const } : s,
    );
    expect(podeEmitirSinal(aggregateHealth(leituras, AT))).toBe(true);
  });
});

describe("construtores — ausência é dita, nunca disfarçada", () => {
  it("naoMedido sempre carrega a marca no texto, mesmo se o chamador esquecer", () => {
    const s = naoMedido("fila", "FILA", "vive no navegador");
    expect(s.state).toBe("DEGRADED");
    expect(s.value).toBeNull();
    expect(s.detail.toLowerCase()).toContain("não medido");
  });

  it("medida ausente vira DEGRADED em todos os construtores — nunca zero otimista", () => {
    for (const s of [
      medirLatencia(null),
      medirIdadeUltimaCaptura(null, AT),
      medirFila(null),
      medirArmazenamento(null),
      medirMemoria(null),
    ]) {
      expect(s.state).toBe("DEGRADED");
      expect(s.value).toBeNull();
    }
  });

  it("latência e idade da captura acima do limiar viram ERROR com o número dito", () => {
    const lenta = medirLatencia(LATENCIA_ERRO_MS + 1);
    expect(lenta.state).toBe("ERROR");
    expect(lenta.value).toBe(LATENCIA_ERRO_MS + 1);

    const parada = medirIdadeUltimaCaptura(AT - (IDADE_CAPTURA_ERRO_MS + 1), AT);
    expect(parada.state).toBe("ERROR");
  });

  it("captura recente e latência baixa são OK", () => {
    expect(medirIdadeUltimaCaptura(AT - 30_000, AT).state).toBe("OK");
    expect(medirLatencia(120).state).toBe("OK");
    expect(medirFila(0).state).toBe("OK");
  });
});

/**
 * REGRESSÃO DE PRODUÇÃO (19/08): o painel acusou "1 GB em prints" quando os
 * prints eram 33 MB — o número era o DATA_DIR inteiro, dominado pelas
 * gravações de replay. Número certo com rótulo errado manda o operador
 * consertar a coisa errada.
 */
describe("armazenamento: prints e gravações são medidas SEPARADAS", () => {
  it("cada medida tem id próprio — nada de um número servindo para dois donos", () => {
    const prints = medirArmazenamento(33 * 1024 * 1024);
    const gravacoes = medirGravacoes(1.1 * 1024 * 1024 * 1024);
    expect(prints.id).toBe("armazenamento");
    expect(gravacoes.id).toBe("gravacoes");
    expect(prints.id).not.toBe(gravacoes.id);
  });

  it("prints dentro da janela de retenção ficam OK", () => {
    expect(medirArmazenamento(33 * 1024 * 1024).state).toBe("OK");
  });

  it("gravações dizem que a limpeza NÃO é automática", () => {
    const g = medirGravacoes(GRAVACOES_DEGRADADO_BYTES + 1);
    expect(g.state).toBe("DEGRADED");
    expect(g.detail).toContain("retenção automática");
  });

  it("diretório ausente é não medido, nunca zero", () => {
    expect(medirGravacoes(null).state).toBe("DEGRADED");
    expect(medirGravacoes(null).value).toBeNull();
  });
});
