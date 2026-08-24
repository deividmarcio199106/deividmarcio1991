import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { T42_EXECUTION } from "../techniqueT42";
import {
  computeZone,
  executeHybridEntry,
  recalcAtFill,
  trackFill,
  type OhlcLike,
} from "../t42FillEngine";

/**
 * OS 20 TESTES OBRIGATÓRIOS DA T4.2 (GPT_MEMORIA_T4 §10) — exercitando o
 * MOTOR com candles sintéticos, nunca a configuração. Os números esperados
 * derivam de T42_EXECUTION importada: se o congelamento mudar, estes testes
 * quebram — que é exatamente o alarme desejado.
 */

const TICK = T42_EXECUTION.tickSize;
const SLIP = T42_EXECUTION.fillSlippageTicks * TICK;

const candle = (o: number, h: number, l: number, c: number): OhlcLike => ({ o, h, l, c });

/** E2 de COMPRA: verde, range 100 (1900..2000), fecha em 1990. */
const E2_COMPRA = candle(1_920, 2_000, 1_900, 1_990);
/** E2 de VENDA: vermelho, range 100 (1900..2000), fecha em 1910. */
const E2_VENDA = candle(1_980, 2_000, 1_900, 1_910);

/** Candle longe da zona de compra (nunca desce até 1990). */
const LONGE_COMPRA = candle(2_010, 2_030, 2_001, 2_020);
/** Candle longe da zona de venda (nunca sobe até 1910). */
const LONGE_VENDA = candle(1_890, 1_899, 1_870, 1_880);

describe("t42FillEngine — os 20 testes do §10", () => {
  // 1. compra calcula zona correta
  it("1. COMPRA: zona do close até 50% do range, abaixo do fechamento, ao tick", () => {
    const z = computeZone(E2_COMPRA, "COMPRA");
    // close 1990 (múltiplo de 5) → proximal 1990; 50% de 100 = 50 → distal 1940.
    expect(z.proximal).toBe(1_990);
    expect(z.distal).toBe(1_940);
    expect(z.zoneHigh).toBe(1_990);
    expect(z.zoneLow).toBe(1_940);
    expect(z.proximal % TICK).toBe(0);
    expect(z.distal % TICK).toBe(0);
  });

  // 2. venda calcula zona correta
  it("2. VENDA: zona do close até 50% do range, acima do fechamento, ao tick", () => {
    const z = computeZone(E2_VENDA, "VENDA");
    expect(z.proximal).toBe(1_910);
    expect(z.distal).toBe(1_960);
    expect(z.zoneLow).toBe(1_910);
    expect(z.zoneHigh).toBe(1_960);
  });

  it("arredondamento é PARA DENTRO: close não-múltiplo encolhe a zona", () => {
    const z = computeZone(candle(1_920, 2_000, 1_900, 1_993), "COMPRA");
    expect(z.proximal).toBe(1_990); // floor(1993)
    expect(z.distal).toBe(1_945); // ceil(1943)
  });

  // 3-5. toque nos candles 1..3 = fill
  for (const n of [1, 2, 3] as const) {
    it(`${n + 2}. toque no candle ${n} = fill na proximal + slippage contra`, () => {
      const z = computeZone(E2_COMPRA, "COMPRA");
      const candles: OhlcLike[] = [];
      for (let i = 1; i < n; i++) candles.push(LONGE_COMPRA);
      candles.push(candle(2_005, 2_010, 1_985, 2_000)); // toca 1990 vindo de fora
      const r = trackFill(z, "COMPRA", candles);
      expect(r.filled).toBe(true);
      if (r.filled) {
        expect(r.fillCandle).toBe(n);
        expect(r.rawFillPrice).toBe(z.proximal);
        expect(r.fillPrice).toBe(z.proximal + SLIP); // compra paga MAIS
      }
    });
  }

  // 6. toque apenas no candle 4 = NO FILL
  it("6. toque SÓ no candle 4 (TTL+1) NÃO executa", () => {
    const z = computeZone(E2_COMPRA, "COMPRA");
    const candles = [LONGE_COMPRA, LONGE_COMPRA, LONGE_COMPRA, candle(2_005, 2_010, 1_985, 2_000)];
    const r = trackFill(z, "COMPRA", candles);
    expect(r.filled).toBe(false);
    if (!r.filled) expect(r.code).toBe("EXPIRED_NO_FILL");
  });

  // 7. nunca tocou = EXPIRED_NO_FILL
  it("7. sem toque nos 3 candles = EXPIRED_NO_FILL com motivo numérico", () => {
    const z = computeZone(E2_COMPRA, "COMPRA");
    const r = trackFill(z, "COMPRA", [LONGE_COMPRA, LONGE_COMPRA, LONGE_COMPRA]);
    expect(r.filled).toBe(false);
    if (!r.filled) {
      expect(r.code).toBe("EXPIRED_NO_FILL");
      expect(r.reason).toMatch(/\d/);
      expect(r.candlesExaminados).toBe(T42_EXECUTION.ttlCandles);
    }
  });

  // 8. gap atravessando a zona tem regra determinística
  it("8. gap ATRAVÉS da zona preenche na PROXIMAL (nunca assume melhora)", () => {
    const z = computeZone(E2_COMPRA, "COMPRA");
    // Abre ABAIXO da distal (1930 < 1940): atravessou a zona no gap.
    const r = trackFill(z, "COMPRA", [candle(1_930, 1_960, 1_920, 1_950)]);
    expect(r.filled).toBe(true);
    if (r.filled) expect(r.rawFillPrice).toBe(z.proximal);
    // Abertura DENTRO da zona preenche NA ABERTURA.
    const r2 = trackFill(z, "COMPRA", [candle(1_960, 1_995, 1_950, 1_990)]);
    expect(r2.filled).toBe(true);
    if (r2.filled) expect(r2.rawFillPrice).toBe(1_960);
  });

  // 9. slippage aplicado contra a posição
  it("9. slippage é CONTRA: compra paga acima, venda recebe abaixo", () => {
    const zc = computeZone(E2_COMPRA, "COMPRA");
    const rc = trackFill(zc, "COMPRA", [candle(2_005, 2_010, 1_985, 2_000)]);
    if (rc.filled) expect(rc.fillPrice).toBe(rc.rawFillPrice + SLIP);
    const zv = computeZone(E2_VENDA, "VENDA");
    const rv = trackFill(zv, "VENDA", [candle(1_895, 1_915, 1_890, 1_900)]);
    expect(rv.filled).toBe(true);
    if (rv.filled) expect(rv.fillPrice).toBe(rv.rawFillPrice - SLIP);
  });

  // 10-12. fill recalcula stop/3R/5R sobre o risco NOVO
  it("10-12. no fill: stop estrutural imutável, 3R e 5R sobre o risco novo", () => {
    const r = recalcAtFill({
      direction: "COMPRA",
      fillPrice: 1_995,
      stopEstrutural: 1_895,
      obstaculo: null,
    });
    expect(r.allowed).toBe(true);
    if (r.allowed) {
      expect(r.plan.stop).toBe(1_895); // imutável
      expect(r.plan.stopDistance).toBe(100);
      expect(r.plan.target3R).toBe(1_995 + 300);
      expect(r.plan.target5R).toBe(1_995 + 500);
      expect(r.plan.rr).toBe(3);
    }
  });

  // 13. RR 2.99 bloqueia
  it("13. RR abaixo de 3 no preço real do fill bloqueia com RR_LT_3", () => {
    // Risco 99 (não múltiplo do tick): 3R ideal = 297 → alvo ao tick 295 → rr 2,98.
    const r = recalcAtFill({
      direction: "COMPRA",
      fillPrice: 1_994,
      stopEstrutural: 1_895,
      obstaculo: null,
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.code).toBe("RR_LT_3");
      expect(r.reason).toContain("2.9");
    }
  });

  // 14. RR 3.00 passa se demais gates aprovarem
  it("14. RR exatamente 3,00 passa quando os demais gates aprovam", () => {
    const r = recalcAtFill({
      direction: "VENDA",
      fillPrice: 1_905,
      stopEstrutural: 2_005,
      obstaculo: 1_300,
    });
    expect(r.allowed).toBe(true);
    if (r.allowed) expect(r.plan.rr).toBe(3);
  });

  // 15. obstáculo <5R bloqueia
  it("15. obstáculo antes dos 5R do risco NOVO bloqueia com TARGET_5R_NO_ROOM", () => {
    const r = recalcAtFill({
      direction: "COMPRA",
      fillPrice: 1_995,
      stopEstrutural: 1_895, // risco 100 → 5R = 500
      obstaculo: 2_300, // 305 pontos = 3,05R
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.code).toBe("TARGET_5R_NO_ROOM");
      expect(r.reason).toContain("3.05");
    }
  });

  it("stop do lado errado bloqueia com código — nunca null mudo", () => {
    const r = recalcAtFill({
      direction: "COMPRA",
      fillPrice: 1_995,
      stopEstrutural: 2_100,
      obstaculo: null,
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.code).toBe("STOP_TOO_SMALL");
  });

  // 16. não perseguir preço
  it("16. sem perseguição POR CONSTRUÇÃO: TTL vencido não reabre com mais candles", () => {
    const e2 = E2_COMPRA;
    const quatro = [LONGE_COMPRA, LONGE_COMPRA, LONGE_COMPRA, candle(2_005, 2_010, 1_985, 2_000)];
    const out = executeHybridEntry({
      e2,
      direction: "COMPRA",
      stopEstrutural: 1_895,
      obstaculo: null,
      candlesFechadosAposE2: quatro,
    });
    expect(out.status).toBe("EXPIRED_NO_FILL");
    // E não existe parâmetro para ampliar zona/TTL: a assinatura é a prova.
    const args: Parameters<typeof executeHybridEntry>[0] = {
      e2,
      direction: "COMPRA",
      stopEstrutural: 1_895,
      obstaculo: null,
      candlesFechadosAposE2: [],
    };
    expect(Object.keys(args).sort()).toEqual([
      "candlesFechadosAposE2",
      "direction",
      "e2",
      "obstaculo",
      "stopEstrutural",
    ]);
  });

  // 17. T não usa T+1
  it("17. o veredito com N candles não muda quando T+1 chega depois (prefixo estável)", () => {
    const e2 = E2_COMPRA;
    const primeiros = [candle(2_005, 2_010, 1_985, 2_000)]; // fill no candle 1
    const decisaoCedo = executeHybridEntry({
      e2,
      direction: "COMPRA",
      stopEstrutural: 1_895,
      obstaculo: null,
      candlesFechadosAposE2: primeiros,
    });
    const comFuturo = executeHybridEntry({
      e2,
      direction: "COMPRA",
      stopEstrutural: 1_895,
      obstaculo: null,
      candlesFechadosAposE2: [...primeiros, candle(1_800, 1_810, 1_700, 1_705)],
    });
    expect(comFuturo).toEqual(decisaoCedo);
  });

  // 18. replay/live iguais
  it("18. determinístico: mesma entrada, mesmo objeto — é a MESMA função nos três caminhos", () => {
    const entrada = {
      e2: E2_VENDA,
      direction: "VENDA" as const,
      stopEstrutural: 2_010,
      obstaculo: 1_300,
      candlesFechadosAposE2: [LONGE_VENDA, candle(1_895, 1_915, 1_890, 1_900)],
    };
    expect(executeHybridEntry(entrada)).toEqual(executeHybridEntry(entrada));
  });

  // 19. resultado futuro não altera fill histórico
  it("19. candles depois do fill não mudam preço nem candle do fill", () => {
    const z = computeZone(E2_COMPRA, "COMPRA");
    const soFill = trackFill(z, "COMPRA", [candle(2_005, 2_010, 1_985, 2_000)]);
    const comDesastreDepois = trackFill(z, "COMPRA", [
      candle(2_005, 2_010, 1_985, 2_000),
      candle(1_700, 1_710, 1_600, 1_605),
      candle(1_600, 1_610, 1_500, 1_505),
    ]);
    expect(comDesastreDepois).toEqual(soFill);
  });

  // 20. bloqueio não congela scheduler
  it("20. BLOCKED devolve objeto estruturado — nunca lança, nunca null", () => {
    const out = executeHybridEntry({
      e2: E2_COMPRA,
      direction: "COMPRA",
      stopEstrutural: 2_100, // stop inválido → BLOCKED
      obstaculo: null,
      candlesFechadosAposE2: [candle(2_005, 2_010, 1_985, 2_000)],
    });
    expect(out.status).toBe("BLOCKED");
    if (out.status === "BLOCKED") {
      expect(out.code).toBe("STOP_TOO_SMALL");
      expect(out.reason.length).toBeGreaterThan(0);
      expect(out.details).toBeDefined();
    }
  });

  it("com menos candles que o TTL e sem toque, o estado é AGUARDANDO_RETESTE", () => {
    const out = executeHybridEntry({
      e2: E2_COMPRA,
      direction: "COMPRA",
      stopEstrutural: 1_895,
      obstaculo: null,
      candlesFechadosAposE2: [LONGE_COMPRA],
    });
    expect(out.status).toBe("AGUARDANDO_RETESTE");
    if (out.status === "AGUARDANDO_RETESTE") {
      expect(out.candlesVistos).toBe(1);
      expect(out.ttl).toBe(T42_EXECUTION.ttlCandles);
    }
  });

  it("nenhum número da execução é redigitado: o motor deriva tudo de T42_EXECUTION", () => {
    // Prova por leitura do fonte: o arquivo do motor não contém os literais.
    // (Guarda estática — complementa a prova semântica dos testes acima.)
    const fonte = readFileSync("src/lib/t4/t42FillEngine.ts", "utf8");
    expect(fonte).toContain("T42_EXECUTION");
    expect(fonte).not.toMatch(/zoneDepthOfE2Range\s*=|ttlCandles\s*=|0\.5\s*\*/);
  });
});
