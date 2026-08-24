import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Runner LONGO da campanha: fora dela (CAMPANHA_T4!=1) vira skip — uma suite
// normal de testes nunca dispara horas de GPU por engano.
const rodarCampanha = process.env["CAMPANHA_T4"] === "1" ? describe : describe.skip;
import { probeVideo } from "@/server/video/ffmpeg";
import { lerPregaoDoVideo, type OpcoesDoPregao } from "@/server/video/pregao";
import { acharPivos, type PontoDeVarredura, type Pivo } from "@/server/video/varredura";

/**
 * O RUNNER DOS QUATRO BRACOS — BASE, H2, H1 e H1H2 no MESMO codigo.
 *
 * O braco vem do ambiente e muda EXATAMENTE uma coisa por hipotese (contrato
 * de comparacao): H2 liga o stop estrutural; H1 liga o obstaculo vivo; H1H2
 * liga os dois. Percepcao vem do ledger do BASELINE (REPRODUZIR — leitura nova
 * vai para overlay proprio); os cortes de dia vem de day-boundaries-frozen —
 * os mesmos para todos os bracos. Checkpoint por dia: COMPLETE so depois do
 * JSON validado; rerun continua do proximo pendente.
 */

const RAIZ =
  "C:/Users/user/Desktop/projetos/_REF_PRODUCAO/ANALISADOR_T4_RTD/ANALISADOR_T4_RTD/t4-learning";
const VIDEO = process.env["VIDEO_DIAS"] ?? "marco";
const BRACO = (process.env["BRACO"] ?? "BASE") as "BASE" | "H2" | "H1" | "H1H2" | "H3" | "H1H2H3";

const EXPERIMENTOS: Record<string, OpcoesDoPregao["experimento"]> = {
  BASE: undefined,
  H2: { stopEstrutural: { bufferPontos: 100, pisoPontos: 200 } },
  H1: { obstaculoVivo: { aceitacaoPontos: 150 } },
  H1H2: {
    stopEstrutural: { bufferPontos: 100, pisoPontos: 200 },
    obstaculoVivo: { aceitacaoPontos: 150 },
  },
  /*
   * H3 — CONFIRMACAO SEM ALVO DE 3R (descoberta em 23/08/2026).
   *
   * POR QUE ESTE BRACO E O DECISIVO. A corrida BASE deste mesmo runner ja roda
   * com `exigirCandleFechado: false` (linha abaixo, decisao de 22/08), ou seja
   * a trava do candle JA estava desligada — e mesmo assim o dia 12 fechou com
   * 7 leituras em ARMED, o preco 165 pontos alem do gatilho, e ZERO
   * confirmacoes. Logo o bloqueio que sobra e o do alvo: sem `targets` na
   * analise, assessTradeRisk sai RISK_UNKNOWN e RISK_UNKNOWN nunca aprova.
   *
   * H3 muda EXATAMENTE essa variavel e mais nenhuma.
   */
  H3: { confirmacaoSemAlvo: { alvoNoObstaculo: true } },
  H1H2H3: {
    stopEstrutural: { bufferPontos: 100, pisoPontos: 200 },
    obstaculoVivo: { aceitacaoPontos: 150 },
    confirmacaoSemAlvo: { alvoNoObstaculo: true },
  },
};

interface DiaCongelado {
  dayId: number;
  data: string | null;
  startTimestamp: number;
  endTimestamp: number;
  estado: "CONFIRMED" | "AMBIGUOUS";
}

function balancosDoDia(pivos: Pivo[], amplitudeDoDia: number, riscoReferencia: number) {
  const balancos: Array<Record<string, number | string>> = [];
  for (let i = 1; i < pivos.length; i++) {
    const a = pivos[i - 1]!;
    const b = pivos[i]!;
    if (a.tipo === b.tipo) continue;
    const pontos = Math.abs(b.preco - a.preco);
    balancos.push({
      deSeg: a.segundoNoVideo,
      ateSeg: b.segundoNoVideo,
      de: a.preco,
      ate: b.preco,
      direcao: b.preco > a.preco ? "ALTA" : "BAIXA",
      pontos,
      fracaoDaAmplitude: amplitudeDoDia > 0 ? Number((pontos / amplitudeDoDia).toFixed(3)) : 0,
      rPotencialRef: Number((pontos / riscoReferencia).toFixed(2)),
      duracaoMinutos: Math.round((b.segundoNoVideo - a.segundoNoVideo) * 12),
    });
  }
  return balancos;
}

rodarCampanha(`DIAS ${VIDEO}.mp4 — braco ${BRACO}`, () => {
  it(
    "roda cada dia confirmado, com checkpoint atomico",
    async () => {
      const fronteiras = JSON.parse(
        readFileSync(`${RAIZ}/dataset/${VIDEO}/day-boundaries-frozen.json`, "utf8"),
      ) as { dias: DiaCongelado[] };
      const dataset = JSON.parse(
        readFileSync(`${RAIZ}/dataset/${VIDEO}/varredura-mes.json`, "utf8"),
      ) as { pontos: PontoDeVarredura[] };
      const info = probeVideo(`C:/Users/user/Desktop/BACKTEST/${VIDEO}.mp4`);
      if ("erro" in info) throw new Error(info.erro);

      const sufixo = BRACO === "BASE" ? "" : `-${BRACO.toLowerCase()}`;
      const dirRelatorios = `${RAIZ}/reports/${VIDEO}${sufixo}`;
      mkdirSync(dirRelatorios, { recursive: true });
      mkdirSync(`${RAIZ}/frozen-frames/${VIDEO}${sufixo}`, { recursive: true });

      const agregado: unknown[] = [];
      let pulados = 0;

      for (const dia of fronteiras.dias) {
        const saida = `${dirRelatorios}/dia-${String(dia.dayId).padStart(2, "0")}.json`;
        if (existsSync(saida)) {
          agregado.push(JSON.parse(readFileSync(saida, "utf8")).resumo);
          continue;
        }
        if (dia.estado === "AMBIGUOUS") {
          // Trecho com fronteira ambigua: isolado, registrado, NAO trava o resto.
          pulados++;
          agregado.push({
            dia: dia.dayId,
            estado: "AMBIGUOUS",
            motivo: "fronteira ambigua no trecho",
          });
          continue;
        }
        const offset = Math.round(dia.startTimestamp * 10);
        const pontosDoDia = dataset.pontos
          .filter(
            (p) => p.segundoNoVideo >= dia.startTimestamp && p.segundoNoVideo <= dia.endTimestamp,
          )
          .map((p) => ({ ...p, indice: p.indice - offset }));
        const pivosDoDia = acharPivos(pontosDoDia);
        const precosDoDia = pontosDoDia.map((p) => p.preco).filter((x): x is number => x !== null);
        const amplitude =
          precosDoDia.length > 0 ? Math.max(...precosDoDia) - Math.min(...precosDoDia) : 0;
        const balancos = balancosDoDia(pivosDoDia, amplitude, 250);

        const r = await lerPregaoDoVideo(info, {
          ativo: "WINFUT",
          inicioSeg: dia.startTimestamp,
          fimSeg: dia.endTimestamp,
          intervaloSeg: 0.1,
          /*
           * Regua revalida a cada 120s de video (nao 30): 76% dos pedidos de
           * leitura eram rotulos de OCR. A QUARENTENA continua forcando OCR
           * quando a regua contradiz a propagacao — a seguranca nao sai daqui.
           */
          intervaloOcrSeg: 120,
          funil: {
            pivos: pivosDoDia,
            janelaDoPivo: 8,
            proximidadePontos: 250,
            /*
             * PRINT POR PREGAO, NAO MERCADO ROLANDO — ordem do dono da tecnica
             * (22/08): o modelo le o print no INICIO da aproximacao (para ter
             * zona e stop) e DE NOVO so quando o preco entra na zona — perto da
             * confirmacao. Releitura periodica cai de 12 frames (~14 min) para
             * 60 (~72 min), so como resgate de episodio muito longo. Mesmo
             * valor nos 4 bracos: a comparabilidade nao muda.
             */
            reanalisarAposFrames: 100000, // video acelerado: episodio le 1x; quem re-le e a ENTRADA NA ZONA
          },
          recorte: { left: 0, top: 82, width: 1340, height: 590 },
          exigirCandleFechado: false,
          experimento: EXPERIMENTOS[BRACO],
          ledger: {
            base: `${RAIZ}/dataset/${VIDEO}/leituras.jsonl`,
            ...(BRACO === "BASE"
              ? {}
              : { novas: `${RAIZ}/dataset/${VIDEO}/leituras${sufixo}.jsonl` }),
          },
          pastaDeSaida: `${RAIZ}/frozen-frames/${VIDEO}${sufixo}`,
        });

        const resumo = {
          braco: BRACO,
          dia: dia.dayId,
          data: dia.data,
          inicioSeg: dia.startTimestamp,
          fimSeg: dia.endTimestamp,
          amplitudeDoDia: amplitude,
          funil: r.funil,
          ledger: r.ledgerResumo,
          aproximacoes: r.aproximacoes,
          confirmacoes: r.confirmacoes,
          operacoes: r.operacoes.length,
          ganhos: r.ganhos,
          perdas: r.perdas,
          pontos: r.pontosLiquidos,
          somaR: r.somaR,
          recusadasPorEspaco: r.recusadasPorEspaco,
          recusasComForense: r.recusasDeEspaco.length,
          balancos: balancos.length,
          balancosGrandes750: balancos.filter((b) => (b["pontos"] as number) >= 750).length,
          balancos3RRef: balancos.filter((b) => (b["rPotencialRef"] as number) >= 3).length,
          erro: r.erro,
        };
        // ATOMICO: escreve em .tmp, valida o JSON relendo, so entao renomeia.
        const tmp = `${saida}.tmp`;
        writeFileSync(
          tmp,
          JSON.stringify({ resumo, pregao: r, pivosDoDia, balancos }, null, 1),
          "utf8",
        );
        JSON.parse(readFileSync(tmp, "utf8"));
        renameSync(tmp, saida);
        agregado.push(resumo);
        console.log(
          `[${BRACO}] ${VIDEO} dia ${dia.dayId} (${dia.data ?? "?"}): modelo=${r.funil.chamadasDeModelo} ` +
            `hits=${r.ledgerResumo?.hits ?? 0} setups=${r.funil.setupsNascidos} conf=${r.confirmacoes} ` +
            `ops=${r.operacoes.length} R=${r.somaR.toFixed(2)} recusasEspaco=${r.recusasDeEspaco.length} erro=${r.erro ?? "-"}`,
        );
      }

      writeFileSync(
        `${dirRelatorios}/agregado.json`,
        JSON.stringify({ video: VIDEO, braco: BRACO, pulados, dias: agregado }, null, 1),
        "utf8",
      );
      expect(agregado.length).toBeGreaterThan(0);
    },
    12 * 3600 * 1000,
  );
});
