import { describe, expect, it } from "vitest";

import fixtures from "./fixtures/sessao20ago.json";
import { detectChartBounds, roiFromPixels, roiUsable } from "../chartRoi";
import { detectClipping } from "../viewportChange";
import { dominantTone, estimateBackground, isInk, rowCoverage } from "../inkModel";

/**
 * A BASE VISUAL, MEDIDA CONTRA PIXEL REAL DA JANELA DO OPERADOR.
 *
 * Os fixtures são luma de VERDADE, extraídos de três capturas da sessão de
 * 20/08/2026 e reduzidos à mesma grade 240×240 que o caminho de produção
 * amostra. Não são desenhos sintéticos: o defeito que estes testes trancam —
 * fundo em gradiente do tema claro do Profit — não aparece em retângulo
 * chapado, e foi por isso que ele sobreviveu a uma suíte inteira de sintéticos.
 *
 * NENHUMA COORDENADA DESTA MÁQUINA ESTÁ ESCRITA AQUI. As asserções são sobre
 * PROPRIEDADES (a moldura exclui o cromo, sobra área plausível, gráfico com
 * margem não acusa corte), com faixas largas o bastante para outra janela do
 * Profit passar. O que não pode voltar é o número absoluto: 83 de 83 acusando
 * corte, 0 de 83 com ROI utilizável.
 */

interface Fixture {
  origem: string;
  resolucao: string;
  nota: string;
  cols: number;
  rows: number;
  luma: string;
}

const REAIS = fixtures as unknown as Record<string, Fixture>;

/** Decodifica o fixture para a grade que as funções de visão consomem. */
function grade(chave: string): { luma: Float64Array; cols: number; rows: number } {
  const f = REAIS[chave]!;
  const bytes = Buffer.from(f.luma, "base64");
  const luma = new Float64Array(f.cols * f.rows);
  for (let i = 0; i < luma.length; i += 1) luma[i] = bytes[i]!;
  return { luma, cols: f.cols, rows: f.rows };
}

const CHAVES = ["print001", "print008", "print005"] as const;

describe("o gradiente do tema claro é real, e é ele que quebrava tudo", () => {
  it("o fundo do gráfico VARIA muito mais que o limiar de tinta", () => {
    /*
     * Este teste não valida código: ele fixa o FATO que motiva o modelo
     * adaptativo. Se um dia um fixture deixar de ter gradiente, os testes
     * abaixo passam a provar menos do que dizem provar, e é melhor saber.
     */
    const { luma, cols, rows } = grade("print001");
    const modelo = estimateBackground(luma, cols, rows);
    const fundos = Array.from(modelo.byRow);
    const amplitude = Math.max(...fundos) - Math.min(...fundos);
    expect(amplitude).toBeGreaterThan(26);
  });

  it("com fundo GLOBAL, área vazia do gráfico é lida como tinta", () => {
    // A reprodução do defeito, para ninguém "simplificar" o modelo de volta.
    const { luma, cols, rows } = grade("print001");
    const global = dominantTone(luma, cols * rows);
    const faixa = { de: Math.floor(rows * 0.78), ate: Math.floor(rows * 0.82) };
    let pior = 0;
    for (let y = faixa.de; y < faixa.ate; y += 1) {
      let tinta = 0;
      for (let x = 0; x < cols; x += 1) if (isInk(luma[y * cols + x]!, global)) tinta += 1;
      pior = Math.max(pior, tinta / cols);
    }
    expect(pior).toBeGreaterThan(0.2);
  });

  it("com fundo POR LINHA, a mesma área fica quieta", () => {
    const { luma, cols, rows } = grade("print001");
    const modelo = estimateBackground(luma, cols, rows);
    const cobertura = rowCoverage(luma, cols, rows, modelo);
    const faixa = cobertura.slice(Math.floor(rows * 0.78), Math.floor(rows * 0.82));
    expect(Math.max(...faixa)).toBeLessThan(0.15);
  });

  it("e o CROMO continua sendo tinta — a guarda da mediana", () => {
    /*
     * O risco do fundo por linha: numa linha de barra de ferramentas a mediana
     * É a cor da barra, e sem guarda o cromo deixaria de contar como tinta,
     * invertendo o problema. Barra e rodapé têm de saturar.
     */
    const { luma, cols, rows } = grade("print001");
    const cobertura = rowCoverage(luma, cols, rows, estimateBackground(luma, cols, rows));
    const topo = Math.max(...cobertura.slice(0, Math.floor(rows * 0.08)));
    const base = Math.max(...cobertura.slice(Math.floor(rows * 0.92)));
    expect(topo).toBeGreaterThan(0.85);
    expect(base).toBeGreaterThan(0.85);
  });
});

describe("a moldura do gráfico, nas capturas reais", () => {
  for (const chave of CHAVES) {
    it(`${chave} (${REAIS[chave]!.resolucao}): moldura utilizável e sem cromo`, () => {
      const { luma, cols, rows } = grade(chave);
      const bounds = detectChartBounds(luma, cols, rows);
      expect(bounds.usable).toBe(true);
      // O cromo do topo e da base foi removido — mas nada de coordenada fixa:
      // o que se exige é que ALGO tenha sido descascado dos dois lados.
      expect(bounds.peeled.top).toBeGreaterThan(0);
      expect(bounds.peeled.bottom).toBeGreaterThan(0);
      // E sobrou gráfico de verdade: nem quase-nada, nem a janela inteira.
      expect(bounds.height).toBeGreaterThan(0.4);
      expect(bounds.height).toBeLessThan(0.9);
      expect(bounds.width).toBeGreaterThan(0.5);
    });
  }

  it("as duas resoluções da mesma sessão convergem para a mesma moldura", () => {
    /*
     * 1366×720 e 1968×1440 têm ASPECTOS diferentes, e a mesma janela do Profit
     * por trás. Se a moldura fosse artefato de amostragem, os dois números
     * divergiriam. A tolerância é folgada porque a convergência é o ponto, não
     * o valor.
     */
    const a = grade("print001");
    const b = grade("print008");
    const ma = detectChartBounds(a.luma, a.cols, a.rows);
    const mb = detectChartBounds(b.luma, b.cols, b.rows);
    expect(Math.abs(ma.y - mb.y)).toBeLessThan(0.05);
    expect(Math.abs(ma.height - mb.height)).toBeLessThan(0.08);
  });

  it("grade pequena ou incompleta devolve moldura NÃO utilizável", () => {
    expect(detectChartBounds(new Float64Array(0), 0, 0).usable).toBe(false);
    expect(detectChartBounds(new Float64Array(10), 240, 240).usable).toBe(false);
  });
});

describe("ROI a partir do bitmap", () => {
  for (const chave of CHAVES) {
    it(`${chave}: ROI utilizável — antes eram 0 de 83`, () => {
      const { luma, cols, rows } = grade(chave);
      const roi = roiFromPixels(luma, cols, rows);
      expect(roiUsable(roi)).toBe(true);
      expect(roi.confidence).toBeGreaterThanOrEqual(50);
    });
  }
});

describe("corte de enquadramento nas capturas reais", () => {
  it("print001: gráfico com margem NÃO é acusado de corte", () => {
    /*
     * A REGRESSÃO PRINCIPAL. Com o modelo de fundo global, este print — que
     * tem folga acima e muita folga abaixo dos candles — era acusado de
     * "cortado no topo E no fundo", junto com os outros 82 da sessão. Como o
     * corte bloqueia confirmação, aquilo pausava a T4 em 100% das capturas.
     */
    const { luma, cols, rows } = grade("print001");
    const r = detectClipping(luma, cols, rows);
    expect(r.avaliavel).toBe(true);
    expect(r.clipped).toBe(false);
  });

  it("print008: idem na outra resolução", () => {
    const { luma, cols, rows } = grade("print008");
    const r = detectClipping(luma, cols, rows);
    expect(r.avaliavel).toBe(true);
    expect(r.clipped).toBe(false);
  });

  it("print005: LIMITAÇÃO CONHECIDA — zona desenhada pelo operador acusa corte", () => {
    /*
     * Este teste tranca um FALSO POSITIVO que permanece, de propósito e dito.
     *
     * O print 005 tem uma zona retangular roxa desenhada pelo operador
     * atravessando a largura inteira do gráfico ("Zona de Liquidez (Reteste)"),
     * e ela encosta na borda da moldura. Para o detector isso é indistinguível
     * de uma faixa de candles rente à borda — é tinta larga e contínua.
     *
     * Ficam 2 falsos positivos em 83 (2,4%), contra 83 em 83 antes. O erro é na
     * direção conservadora: acusar corte BLOQUEIA entrada, com o motivo na
     * tela. Quando isto mudar, é para mudar sabendo — não por acidente.
     */
    const { luma, cols, rows } = grade("print005");
    const r = detectClipping(luma, cols, rows);
    expect(r.avaliavel).toBe(true);
    expect(r.clipped).toBe(true);
  });
});
