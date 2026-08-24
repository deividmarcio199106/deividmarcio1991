/**
 * ROMPIMENTO × RETESTE — a medição que decide onde a entrada mora.
 *
 * A PERGUNTA. Nos 11 pregões congelados de março, 98% das entradas a limite
 * (reteste) nunca foram tocadas: o preço confirmou e FOI, sem voltar. Este
 * script mede o contrafactual: e se, no mesmo instante do sinal, a entrada
 * fosse A MERCADO no preço corrente, mantendo o MESMO stop estrutural?
 *
 * O QUE ELE NÃO É. Não é backtest oficial, não altera regra, não promove nada.
 * É SIMULAÇÃO EXPLORATÓRIA sobre a série de preços da varredura (o badge de
 * último preço lido a ~10 fps de vídeo), com as limitações declaradas:
 *   - preço amostrado, sem OHLC intrabar → toque de stop/alvo é aproximado;
 *   - 24% dos frames sem preço legível → lacunas puladas;
 *   - braço RETESTE usa o RESULTADO GRAVADO pelo motor (não re-simula), então
 *     a comparação é honesta com o que o sistema de fato decidiu.
 *
 * COORTES SEPARADAS, como manda o protocolo:
 *   A. As confirmações OFICIAIS (n minúsculo — nenhuma regra sai daqui).
 *   B. As recusas de espaço com contrafactual gravado (n=159) — mede o MESMO
 *      fenômeno de colocação de entrada, mas sobre sinais que o gate 3R vetou.
 *
 * Uso: node t4-learning/experiments/rompimento-vs-reteste.mjs [video]
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";

const RAIZ = "t4-learning";
const VIDEO = process.argv[2] ?? "marco";

const varredura = JSON.parse(readFileSync(`${RAIZ}/dataset/${VIDEO}/varredura-mes.json`, "utf8"));
const pontos = varredura.pontos
  .filter((p) => p.preco !== null && Number.isFinite(p.preco))
  .sort((a, b) => a.segundoNoVideo - b.segundoNoVideo);

/** Série de preço dentro de uma janela de vídeo, com outliers de leitura fora. */
function serie(deSeg, ateSeg) {
  const bruto = pontos.filter((p) => p.segundoNoVideo >= deSeg && p.segundoNoVideo <= ateSeg);
  if (bruto.length < 5) return bruto;
  // Outlier de OCR: salto de mais de 3000 pts contra a mediana móvel local é
  // rótulo mal lido, não mercado — WINFUT não anda 3000 pts num frame.
  const out = [];
  for (let i = 0; i < bruto.length; i++) {
    const viz = bruto
      .slice(Math.max(0, i - 5), i + 6)
      .map((p) => p.preco)
      .sort((a, b) => a - b);
    const med = viz[Math.floor(viz.length / 2)];
    if (Math.abs(bruto[i].preco - med) <= 3000) out.push(bruto[i]);
  }
  return out;
}

/**
 * Caminha a série a partir do preenchimento e devolve o primeiro evento.
 * Sem OHLC: o toque é "preço amostrado cruzou o nível" — declarado no topo.
 */
function caminhar({ direcao, precoEntrada, stop, alvo3, s0, fimSeg }) {
  const caminho = serie(s0, fimSeg);
  if (caminho.length === 0) return { resultado: "SEM_SERIE", mfePontos: null };
  const venda = direcao === "VENDA";
  let mfe = 0;
  for (const p of caminho) {
    const favor = venda ? precoEntrada - p.preco : p.preco - precoEntrada;
    if (favor > mfe) mfe = favor;
    const bateuStop = venda ? p.preco >= stop : p.preco <= stop;
    const bateuAlvo = venda ? p.preco <= alvo3 : p.preco >= alvo3;
    // No mesmo frame, o stop tem precedência: é a leitura conservadora.
    if (bateuStop) return { resultado: "STOP", mfePontos: mfe };
    if (bateuAlvo) return { resultado: "ALVO_3R", mfePontos: mfe };
  }
  const ultimo = caminho[caminho.length - 1].preco;
  const pontosEod = venda ? precoEntrada - ultimo : ultimo - precoEntrada;
  return { resultado: "FIM_DO_DIA", pontosEod, mfePontos: mfe };
}

/** Braço ROMPIMENTO: mercado no preço corrente do sinal, stop estrutural mantido. */
function bracoRompimento(sinal, fimSeg) {
  const proximos = serie(sinal.segundoNoVideo, sinal.segundoNoVideo + 3);
  if (proximos.length === 0) return { resultado: "SEM_PRECO_NO_SINAL" };
  const p0 = proximos[0].preco;
  const risco = Math.abs(p0 - sinal.stop);
  if (risco <= 0 || risco > 3000) return { resultado: "RISCO_INVALIDO", risco };
  const venda = sinal.direcao === "VENDA";
  // Sanidade: numa venda o stop precisa estar ACIMA do preço; espelho na compra.
  if (venda ? sinal.stop <= p0 : sinal.stop >= p0) return { resultado: "STOP_DO_LADO_ERRADO" };
  const alvo3 = venda ? p0 - 3 * risco : p0 + 3 * risco;
  const fim = caminhar({
    direcao: sinal.direcao,
    precoEntrada: p0,
    stop: sinal.stop,
    alvo3,
    s0: proximos[0].segundoNoVideo,
    fimSeg,
  });
  const r =
    fim.resultado === "ALVO_3R"
      ? 3
      : fim.resultado === "STOP"
        ? -1
        : fim.resultado === "FIM_DO_DIA"
          ? fim.pontosEod / risco
          : null;
  return { ...fim, precoEntrada: p0, risco, r };
}

const dias = readdirSync(`${RAIZ}/reports/${VIDEO}`)
  .filter((f) => f.startsWith("dia-"))
  .sort();

const coorteA = [];
const coorteB = [];
for (const arq of dias) {
  const d = JSON.parse(readFileSync(`${RAIZ}/reports/${VIDEO}/${arq}`, "utf8"));
  const fimSeg = d.resumo.fimSeg;
  for (const op of d.pregao.operacoes ?? []) {
    coorteA.push({
      dia: d.resumo.dia,
      data: d.resumo.data,
      reteste: { resultado: op.resultado, r: op.r, mfePontos: op.mfePontos ?? null },
      rompimento: bracoRompimento(
        { segundoNoVideo: op.segundoNoVideo, direcao: op.direcao, stop: op.stop },
        fimSeg,
      ),
    });
  }
  for (const rec of d.pregao.recusasDeEspaco ?? []) {
    if (!rec.semTrava || rec.stop === null || rec.entrada === null) continue;
    coorteB.push({
      dia: d.resumo.dia,
      reteste: {
        resultado: rec.semTrava.resultado,
        r: rec.semTrava.r,
        mfePontos: rec.semTrava.mfePontos ?? null,
      },
      rompimento: bracoRompimento(
        { segundoNoVideo: rec.segundoNoVideo, direcao: rec.direcao, stop: rec.stop },
        fimSeg,
      ),
    });
  }
}

function resumo(coorte) {
  const romp = coorte.map((c) => c.rompimento);
  const validos = romp.filter((r) => typeof r.r === "number");
  const alvo = romp.filter((r) => r.resultado === "ALVO_3R").length;
  const stop = romp.filter((r) => r.resultado === "STOP").length;
  const eod = romp.filter((r) => r.resultado === "FIM_DO_DIA").length;
  const invalidos = romp.length - alvo - stop - eod;
  const somaR = validos.reduce((s, r) => s + r.r, 0);
  const ret = coorte.map((c) => c.reteste);
  return {
    sinais: coorte.length,
    reteste: {
      executadas: ret.filter((r) => r.resultado === "GANHO" || r.resultado === "PERDA").length,
      ganhos: ret.filter((r) => r.resultado === "GANHO").length,
      perdas: ret.filter((r) => r.resultado === "PERDA").length,
      naoExecutadas: ret.filter((r) => r.resultado === "NAO_EXECUTADA").length,
    },
    rompimento: {
      preenchidas: validos.length,
      alvo3R: alvo,
      stop,
      fimDoDia: eod,
      semDado: invalidos,
      somaR: Number(somaR.toFixed(2)),
      expectanciaR: validos.length > 0 ? Number((somaR / validos.length).toFixed(3)) : null,
      taxaAlvo: alvo + stop > 0 ? Number(((100 * alvo) / (alvo + stop)).toFixed(1)) + "%" : null,
    },
  };
}

const relatorio = {
  video: VIDEO,
  geradoEm: new Date().toISOString(),
  natureza:
    "SIMULACAO EXPLORATORIA — serie amostrada sem OHLC, braço reteste = resultado gravado pelo motor. NENHUMA regra muda por este arquivo.",
  metodo: {
    rompimento:
      "entrada a mercado no primeiro preço lido a partir do sinal; stop estrutural gravado mantido; alvo único 3R sobre o risco NOVO; caminhada até stop/alvo/fim do pregão; stop tem precedência no mesmo frame",
    limites: [
      "preço a ~10fps de vídeo, sem máximas/mínimas intrabar",
      "24% dos frames sem preço — lacunas puladas",
      "TTL de 40 candles do motor não se aplica ao braço a mercado (preenchimento é imediato)",
    ],
  },
  coorteA_confirmacoesOficiais: { casos: coorteA, resumo: resumo(coorteA) },
  coorteB_recusasComContrafactual: { resumo: resumo(coorteB) },
};

writeFileSync(
  `${RAIZ}/reports/${VIDEO}-rompimento-vs-reteste.json`,
  JSON.stringify(relatorio, null, 1),
  "utf8",
);

console.log("=== COORTE A — confirmações oficiais ===");
console.log(JSON.stringify(relatorio.coorteA_confirmacoesOficiais, null, 1));
console.log("\n=== COORTE B — 159 recusas (contrafactual) ===");
console.log(JSON.stringify(relatorio.coorteB_recusasComContrafactual.resumo, null, 1));
