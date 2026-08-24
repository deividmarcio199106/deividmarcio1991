import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ANALYSIS_TIMEOUT_MS,
  CAPTURE_PERIOD_MS,
  MarketMonitor,
  syncLabel,
  RENDER_DELAY_MS,
  type CaptureMeta,
} from "../marketMonitor";
import { NO_CLIPPING } from "@/lib/vision/viewportChange";

/**
 * Geometria de frame para os stubs de captura.
 *
 * Estes testes falam de CADENCIA e FILA, nao de pixel: a moldura e as
 * dimensoes existem no contrato porque a producao as mede, e aqui entram como
 * um valor plausivel e fixo. Quem testa a moldura de verdade e inkModel.test,
 * contra luma de captura real.
 */
const GEOMETRIA = {
  chartBounds: {
    x: 0,
    y: 0.11,
    width: 0.97,
    height: 0.73,
    px: { x0: 0, y0: 27, x1: 232, y1: 202 },
    peeled: { top: 27, bottom: 37, left: 0, right: 7 },
    usable: true,
    reason: "moldura do grafico: 97% x 73% da janela",
  },
  rawWidth: 1366,
  rawHeight: 720,
  normalizedWidth: 1366,
  normalizedHeight: 720,
  devicePixelRatio: 1,
} as const;

/**
 * O contrato do operador em forma de teste: UM print real por minuto,
 * obrigatoriamente, com o gráfico parado ou não. O roteiro de aceite
 * (5 minutos → #001..#005) roda aqui com relógio falso — o que o navegador
 * confirma depois é o mesmo comportamento em tempo real.
 */

function deferido<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("MarketMonitor", () => {
  let capturas: number;
  let monitor: MarketMonitor;
  let analisadas: CaptureMeta[];

  beforeEach(() => {
    vi.useFakeTimers();
    /*
     * Relógio FIXADO numa virada de minuto exata.
     *
     * O ciclo deixou de ser "agora + 60s" e passou a ser ancorado na virada do
     * candle: sem fixar o relógio, o primeiro disparo cairia num offset
     * diferente a cada execução e o teste ficaria intermitente — que é pior
     * que não ter teste. A base soma a folga de render para que cada avanço de
     * CAPTURE_PERIOD_MS caia EXATAMENTE num alvo de captura.
     */
    vi.setSystemTime(new Date(Date.UTC(2026, 7, 19, 13, 0, 0) + RENDER_DELAY_MS));
    capturas = 0;
    analisadas = [];
    monitor = new MarketMonitor({
      captureFrame: () => {
        capturas += 1;
        return {
          ok: true,
          frameHash: null,
          clipping: NO_CLIPPING,
          ...GEOMETRIA,
          dataUrl: `data:image/jpeg;base64,${"x".repeat(30)}#${capturas}`,
        };
      },
      probe: () => ({ live: true, videoTime: Date.now() / 1000, validDims: true, ended: false }),
    });
    monitor.setAnalyzer(async (_url, meta) => {
      analisadas.push(meta);
      return true;
    });
  });

  afterEach(() => {
    monitor.resetForTests();
    vi.useRealTimers();
  });

  it("roteiro de aceite: 5 minutos → 5 prints, um por minuto, todos analisados", async () => {
    monitor.begin();
    for (let minuto = 1; minuto <= 5; minuto += 1) {
      await vi.advanceTimersByTimeAsync(CAPTURE_PERIOD_MS);
      expect(capturas).toBe(minuto);
    }
    expect(analisadas).toHaveLength(5);
    expect(analisadas.every((meta) => meta.code === "CICLO_60S")).toBe(true);
    expect(monitor.getState().captures).toBe(5);
  });

  it("gráfico parado NÃO importa: o print sai do mesmo jeito (cadência fixa)", async () => {
    // O probe/captura não sabem nada de mudança — não existe mais detector.
    monitor.begin();
    await vi.advanceTimersByTimeAsync(CAPTURE_PERIOD_MS * 3);
    expect(capturas).toBe(3);
  });

  it("antes da virada do candle não captura nada", async () => {
    monitor.begin();
    await vi.advanceTimersByTimeAsync(CAPTURE_PERIOD_MS - 1_000);
    expect(capturas).toBe(0);
    expect(monitor.getState().stage).toBe("MONITORANDO");
  });

  it("a captura acontece LOGO APÓS a virada do minuto, não 60s depois do clique", async () => {
    // Começa 20s DENTRO de um candle: o primeiro print sai na virada
    // seguinte (40s depois), não 60s adiante — é o que mantém o print
    // alinhado com o candle que o operador vê no Profit.
    vi.setSystemTime(new Date(Date.UTC(2026, 7, 19, 13, 0, 20)));
    monitor.begin();
    await vi.advanceTimersByTimeAsync(39_000);
    expect(capturas).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000 + RENDER_DELAY_MS);
    expect(capturas).toBe(1);
    // E o print pertence ao candle 13:01, o que acabou de abrir.
    expect(analisadas[0]!.candleTime).toBe(Date.UTC(2026, 7, 19, 13, 1, 0));
    expect(analisadas[0]!.captureDelayMs).toBeLessThanOrEqual(RENDER_DELAY_MS + 50);
    expect(analisadas[0]!.sync).toBe("SINCRONIZADO");
  });

  it("IA lenta: o minuto seguinte CAPTURA normalmente e só o pendente mais novo espera", async () => {
    const primeira = deferido<boolean>();
    let chamadas = 0;
    let simultaneas = 0;
    let pico = 0;
    monitor.setAnalyzer(async (url) => {
      chamadas += 1;
      simultaneas += 1;
      pico = Math.max(pico, simultaneas);
      try {
        if (chamadas === 1) return await primeira.promise;
        analisadas.push({
          reason: url,
          code: "CICLO_60S",
          at: 0,
          captureId: "t",
          clipping: NO_CLIPPING,
          ...GEOMETRIA,
          capturedAt: 0,
          candleTime: 0,
          captureDelayMs: 0,
          sync: "SINCRONIZADO",
        });
        return true;
      } finally {
        simultaneas -= 1;
      }
    });
    monitor.begin();
    // Três minutos passam com a primeira análise pendurada.
    await vi.advanceTimersByTimeAsync(CAPTURE_PERIOD_MS * 3);
    expect(capturas).toBe(3); // os prints existem — a captura nunca esperou a IA
    expect(chamadas).toBe(1); // mas só UMA request foi ao ar
    primeira.resolve(true);
    await vi.advanceTimersByTimeAsync(10);
    // Só o pendente MAIS RECENTE (print #3) foi analisado; o #2 foi descartado.
    expect(chamadas).toBe(2);
    expect(pico).toBe(1); // nunca duas análises simultâneas
    expect(analisadas[0]!.reason).toContain("#3");
  });

  it("ANALISAR AGORA captura já e NÃO desloca o ciclo automático", async () => {
    monitor.begin();
    await vi.advanceTimersByTimeAsync(30_000);
    monitor.analyzeNow();
    expect(capturas).toBe(1);
    // O alvo dos 60s originais continua de pé: +30s e o ciclo dispara.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(capturas).toBe(2);
  });

  it("PAUSAR segura o ciclo mantendo o stream; CONTINUAR volta na próxima virada", async () => {
    monitor.begin();
    await vi.advanceTimersByTimeAsync(CAPTURE_PERIOD_MS + RENDER_DELAY_MS);
    expect(capturas).toBe(1);
    monitor.pause();
    await vi.advanceTimersByTimeAsync(CAPTURE_PERIOD_MS * 5);
    expect(capturas).toBe(1); // pausado: nenhum print novo
    expect(monitor.getState().stage).toBe("PAUSADO");
    monitor.resume();
    // Retomar não dispara: espera a virada do candle seguinte, como o ciclo.
    await vi.advanceTimersByTimeAsync(CAPTURE_PERIOD_MS - RENDER_DELAY_MS - 1_000);
    expect(capturas).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000 + RENDER_DELAY_MS);
    expect(capturas).toBe(2);
  });

  it("begin() repetido NÃO duplica timers — um print por minuto, nunca dois", async () => {
    monitor.begin();
    monitor.begin();
    monitor.begin();
    await vi.advanceTimersByTimeAsync(CAPTURE_PERIOD_MS);
    expect(capturas).toBe(1);
    await vi.advanceTimersByTimeAsync(CAPTURE_PERIOD_MS);
    expect(capturas).toBe(2);
  });

  it("falha de captura não conta como print, não vira análise e o ciclo segue", async () => {
    let falhar = true;
    monitor = new MarketMonitor({
      captureFrame: () => {
        capturas += 1;
        if (falhar) return { ok: false, problem: "frame uniforme (preto/vazio)" };
        return {
          ok: true,
          frameHash: null,
          clipping: NO_CLIPPING,
          ...GEOMETRIA,
          dataUrl: `data:image/jpeg;base64,${"x".repeat(30)}`,
        };
      },
      probe: () => ({ live: true, videoTime: 1, validDims: true, ended: false }),
    });
    const analises: string[] = [];
    monitor.setAnalyzer(async (url) => {
      analises.push(url);
      return true;
    });
    monitor.begin();
    await vi.advanceTimersByTimeAsync(CAPTURE_PERIOD_MS);
    expect(monitor.getState().captures).toBe(0); // tentou, falhou, não contou
    expect(monitor.getState().lastError).toContain("preto/vazio");
    expect(analises).toHaveLength(0); // request vazia NUNCA sobe
    falhar = false;
    await vi.advanceTimersByTimeAsync(CAPTURE_PERIOD_MS);
    expect(monitor.getState().captures).toBe(1); // ciclo continuou e se recuperou
    expect(analises).toHaveLength(1);
  });

  it("erro da IA não encerra o monitoramento — o próximo minuto captura de novo", async () => {
    monitor.setAnalyzer(async () => {
      throw new Error("túnel da GPU caiu");
    });
    monitor.begin();
    await vi.advanceTimersByTimeAsync(CAPTURE_PERIOD_MS);
    expect(monitor.getState().lastError).toContain("túnel");
    await vi.advanceTimersByTimeAsync(CAPTURE_PERIOD_MS);
    expect(capturas).toBe(2); // seguiu capturando
    expect(monitor.getState().stage).toBe("MONITORANDO");
  });

  it("fim do compartilhamento (onended) para o scheduler e pede nova seleção", async () => {
    let ended = false;
    monitor = new MarketMonitor({
      captureFrame: () => ({
        ok: true,
        frameHash: null,
        clipping: NO_CLIPPING,
        ...GEOMETRIA,
        dataUrl: `data:image/jpeg;base64,${"x".repeat(30)}`,
      }),
      probe: () => ({ live: !ended, videoTime: 1, validDims: true, ended }),
    });
    monitor.setAnalyzer(async () => true);
    monitor.begin();
    await vi.advanceTimersByTimeAsync(CAPTURE_PERIOD_MS);
    ended = true;
    await vi.advanceTimersByTimeAsync(2_000); // heartbeat percebe
    expect(monitor.getState().stage).toBe("ENCERRADO");
    expect(monitor.getState().needsReselect).toBe(true);
    await vi.advanceTimersByTimeAsync(CAPTURE_PERIOD_MS * 2);
    expect(monitor.getState().captures).toBe(1); // nada mais capturou
  });

  it("ENCERRAR limpa timers e nada mais dispara", async () => {
    monitor.begin();
    await vi.advanceTimersByTimeAsync(CAPTURE_PERIOD_MS);
    monitor.stop();
    await vi.advanceTimersByTimeAsync(CAPTURE_PERIOD_MS * 3);
    expect(capturas).toBe(1);
    expect(monitor.getState().stage).toBe("ENCERRADO");
  });

  it("contador regressivo aparece no estado (PRÓXIMO PRINT: Xs)", async () => {
    monitor.begin();
    await vi.advanceTimersByTimeAsync(17_000);
    // Alvo em :60,9 e já se passaram 17s → faltam ~44s.
    const s = monitor.getState().secondsToNext;
    expect(s).not.toBeNull();
    expect(s!).toBeGreaterThanOrEqual(43);
    expect(s!).toBeLessThanOrEqual(45);
  });

  /**
   * ITEM 13 DO ACEITE — 10 candles consecutivos.
   *
   * O que estes testes provam, e que a versão por cronômetro não provava:
   * cada candle gera exatamente UM print, nenhum minuto se repete, nenhum
   * minuto se perde, e o print carrega o candle a que pertence.
   */
  describe("um print por candle, dez candles seguidos", () => {
    it("10 candles = 10 prints, minutos consecutivos e sem repetição", async () => {
      monitor.begin();
      for (let i = 0; i < 10; i += 1) {
        await vi.advanceTimersByTimeAsync(CAPTURE_PERIOD_MS);
      }
      // O último alvo cai RENDER_DELAY_MS depois da décima virada.
      await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS);

      expect(capturas).toBe(10);
      expect(analisadas).toHaveLength(10);

      const candles = analisadas.map((m) => m.candleTime);
      // Nenhum minuto repetido.
      expect(new Set(candles).size).toBe(10);
      // Nenhum minuto perdido: sequência estritamente de 60 em 60 segundos.
      for (let i = 1; i < candles.length; i += 1) {
        expect(candles[i]! - candles[i - 1]!).toBe(CAPTURE_PERIOD_MS);
      }
      // Todo print sai logo após a virada — nunca no meio do candle.
      for (const meta of analisadas) {
        expect(meta.captureDelayMs).toBeLessThanOrEqual(RENDER_DELAY_MS + 50);
        expect(meta.sync).toBe("SINCRONIZADO");
      }
      // captureId único por captura: é a chave que amarra imagem e análise.
      expect(new Set(analisadas.map((m) => m.captureId)).size).toBe(10);
    });

    it("§8 — dois disparos no MESMO minuto geram UM print, e a duplicata é dita", async () => {
      monitor.begin();
      await vi.advanceTimersByTimeAsync(CAPTURE_PERIOD_MS + RENDER_DELAY_MS);
      expect(capturas).toBe(1);

      // Segundo disparo dentro do mesmo candle (aba voltando do background,
      // timer reagendado): a captura é recusada pela chave do candle.
      monitor.forceCycleForTests();
      expect(capturas).toBe(1);
      expect(monitor.getState().duplicatesSkipped).toBe(1);
    });

    it("trocar de ativo/timeframe RESETA a referência de candle", async () => {
      monitor.begin();
      await vi.advanceTimersByTimeAsync(CAPTURE_PERIOD_MS + RENDER_DELAY_MS);
      expect(capturas).toBe(1);

      // Sem o reset, a primeira captura da série nova seria engolida como
      // duplicata só porque caiu no mesmo minuto de relógio.
      monitor.setSeries("WDOFUT", "1Min");
      monitor.forceCycleForTests();
      expect(capturas).toBe(2);
      expect(monitor.getState().duplicatesSkipped).toBe(0);
    });

    it("a imagem chega à tela ANTES da análise (onCapture dispara na captura)", async () => {
      const ordem: string[] = [];
      const lenta = deferido<boolean>();
      monitor.setOnCapture((_url, meta) => ordem.push(`captura:${meta.captureId}`));
      monitor.setAnalyzer(async (_url, meta) => {
        ordem.push(`analise:${meta.captureId}`);
        return await lenta.promise;
      });

      monitor.begin();
      await vi.advanceTimersByTimeAsync(CAPTURE_PERIOD_MS + RENDER_DELAY_MS);
      // A captura foi anunciada antes de a análise sequer começar a resolver.
      expect(ordem[0]).toMatch(/^captura:/);

      // Candle seguinte com a IA ainda pendurada: a IMAGEM entra na tela
      // mesmo assim — é isto que elimina o print atrasado.
      await vi.advanceTimersByTimeAsync(CAPTURE_PERIOD_MS);
      const capturasAnunciadas = ordem.filter((e) => e.startsWith("captura:"));
      expect(capturasAnunciadas).toHaveLength(2);
      lenta.resolve(true);
    });
  });

  describe("§3 — fonte congelada não vira análise", () => {
    /** Monitor cuja fonte devolve sempre a MESMA assinatura de frame. */
    function comFonteCongelada() {
      const analisadas: CaptureMeta[] = [];
      const congelada = "ab".repeat(576);
      const m = new MarketMonitor({
        captureFrame: () => ({
          ok: true,
          frameHash: congelada,
          clipping: NO_CLIPPING,
          ...GEOMETRIA,
          dataUrl: `data:image/jpeg;base64,${"x".repeat(30)}`,
        }),
        probe: () => ({ live: true, videoTime: Date.now() / 1000, validDims: true, ended: false }),
      });
      m.setAnalyzer(async (_url, meta) => {
        analisadas.push(meta);
        return true;
      });
      return { analisadas, monitor: m };
    }

    it("CASO B: dez capturas iguais produzem UMA análise", async () => {
      const { analisadas, monitor: m } = comFonteCongelada();
      m.begin();
      for (let i = 0; i < 10; i += 1) await vi.advanceTimersByTimeAsync(CAPTURE_PERIOD_MS);
      // A PRIMEIRA imagem é legítima: ninguém a tinha visto antes.
      expect(analisadas).toHaveLength(1);
      expect(m.getState().duplicateFrames).toBeGreaterThan(0);
      m.resetForTests();
    });

    it("imagem repetida não conta como print — o contador não anda", async () => {
      const { monitor: m } = comFonteCongelada();
      m.begin();
      await vi.advanceTimersByTimeAsync(CAPTURE_PERIOD_MS);
      const depoisDaPrimeira = m.getState().captures;
      await vi.advanceTimersByTimeAsync(CAPTURE_PERIOD_MS * 5);
      expect(m.getState().captures).toBe(depoisDaPrimeira);
      m.resetForTests();
    });

    it("§5 — a tela NUNCA diz SINCRONIZADO sobre frame repetido", async () => {
      const { monitor: m } = comFonteCongelada();
      m.begin();
      await vi.advanceTimersByTimeAsync(CAPTURE_PERIOD_MS * 2);
      expect(syncLabel(m.getState())).toBe("AGUARDANDO_FRAME");
      m.resetForTests();
    });

    it("ANALISAR AGORA continua atendendo — gesto do operador não é engolido", async () => {
      const { analisadas, monitor: m } = comFonteCongelada();
      m.begin();
      await vi.advanceTimersByTimeAsync(CAPTURE_PERIOD_MS * 3);
      expect(analisadas).toHaveLength(1);
      m.analyzeNow();
      await vi.advanceTimersByTimeAsync(10);
      expect(analisadas).toHaveLength(2);
      expect(analisadas[1]!.code).toBe("MANUAL");
      m.resetForTests();
    });

    it("quando a imagem volta a mudar, a análise volta", async () => {
      const analisadas: CaptureMeta[] = [];
      let congelado = true;
      const m = new MarketMonitor({
        captureFrame: () => ({
          ok: true,
          frameHash: congelado ? "ab".repeat(576) : "cd".repeat(576),
          clipping: NO_CLIPPING,
          ...GEOMETRIA,
          dataUrl: `data:image/jpeg;base64,${"x".repeat(30)}`,
        }),
        probe: () => ({ live: true, videoTime: Date.now() / 1000, validDims: true, ended: false }),
      });
      m.setAnalyzer(async (_url, meta) => {
        analisadas.push(meta);
        return true;
      });
      m.begin();
      await vi.advanceTimersByTimeAsync(CAPTURE_PERIOD_MS * 4);
      expect(analisadas).toHaveLength(1);
      congelado = false;
      await vi.advanceTimersByTimeAsync(CAPTURE_PERIOD_MS);
      expect(analisadas).toHaveLength(2);
      expect(syncLabel(m.getState())).not.toBe("AGUARDANDO_FRAME");
      m.resetForTests();
    });
  });
});

describe("timeout libera o lock e resultado tardio não governa nada", () => {
  let capturas: number;
  let monitor: MarketMonitor;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 7, 19, 13, 0, 0) + RENDER_DELAY_MS));
    capturas = 0;
    monitor = new MarketMonitor({
      captureFrame: () => {
        capturas += 1;
        return {
          ok: true,
          frameHash: null,
          clipping: NO_CLIPPING,
          ...GEOMETRIA,
          dataUrl: `data:image/jpeg;base64,${"x".repeat(30)}#${capturas}`,
        };
      },
      probe: () => ({ live: true, videoTime: Date.now() / 1000, validDims: true, ended: false }),
    });
  });

  afterEach(() => {
    monitor.resetForTests();
    vi.useRealTimers();
  });

  it("análise PENDURADA além do teto: o lock abre sozinho e a fila anda", async () => {
    const primeira = deferido<boolean>();
    const atendidas: string[] = [];
    let chamadas = 0;
    let simultaneas = 0;
    let pico = 0;
    monitor.setAnalyzer(async (url) => {
      chamadas += 1;
      simultaneas += 1;
      pico = Math.max(pico, simultaneas);
      try {
        if (chamadas === 1) return await primeira.promise; // nunca resolve sozinha
        atendidas.push(url);
        return true;
      } finally {
        simultaneas -= 1;
      }
    });
    monitor.begin();

    // Minutos 1..3: a primeira análise fica pendurada; capturas seguem.
    await vi.advanceTimersByTimeAsync(CAPTURE_PERIOD_MS * 3);
    expect(capturas).toBe(3);
    expect(chamadas).toBe(1);
    expect(monitor.getState().analysisBusy).toBe(true);

    // O teto vence em t = 60s (início da análise) + ANALYSIS_TIMEOUT_MS.
    await vi.advanceTimersByTimeAsync(ANALYSIS_TIMEOUT_MS);
    // O lock ABRIU sem ninguém resolver a promessa: o pendente mais novo (#3)
    // rodou, e o print do minuto seguinte também — a fila nunca congelou.
    expect(chamadas).toBeGreaterThanOrEqual(2);
    expect(atendidas[0]).toContain("#3");
    // O race NÃO cancela a promessa pendurada — ele a ABANDONA. No pior
    // instante existem a zumbi (#1, nunca resolvida) e a nova em voo: pico 2.
    // O que não pode existir é uma TERCEIRA — a fila continua serializada.
    expect(pico).toBeLessThanOrEqual(2);
    expect(monitor.getState().analysisBusy).toBe(false);

    // RESULTADO TARDIO: a análise #1 volta DEPOIS do timeout. Nada muda — não
    // reprocessa fila, não retrava o lock, não sobrescreve estado.
    const chamadasAntes = chamadas;
    const estadoAntes = monitor.getState();
    primeira.resolve(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(chamadas).toBe(chamadasAntes);
    expect(monitor.getState().analysisBusy).toBe(false);
    expect(monitor.getState().captures).toBe(estadoAntes.captures);
  });

  it("analisador que LANÇA no minuto seguinte não deixa busy preso", async () => {
    let chamadas = 0;
    monitor.setAnalyzer(async () => {
      chamadas += 1;
      throw new Error("explodiu");
    });
    monitor.begin();
    await vi.advanceTimersByTimeAsync(CAPTURE_PERIOD_MS * 2);
    expect(chamadas).toBe(2); // a segunda só roda porque o lock abriu no finally
    expect(monitor.getState().analysisBusy).toBe(false);
  });

  /*
   * ROBUSTEZ B8 (auditoria sênior): assinante hostil, dependência que lança e
   * lock herdado — os três buracos que deixavam o monitor "vivo" na tela e
   * morto por dentro.
   */
  describe("robustez B8 — assinante hostil e ciclo imortal", () => {
    it("assinante que LANÇA não trava a fila: os demais veem, busy solta e o próximo ciclo dispara", async () => {
      let vistos = 0;
      let analisados = 0;
      monitor.setAnalyzer(async () => {
        analisados += 1;
        return true;
      });
      monitor.subscribe(() => {
        throw new Error("tela quebrada");
      });
      monitor.subscribe(() => {
        vistos += 1;
      });
      monitor.begin();
      await vi.advanceTimersByTimeAsync(CAPTURE_PERIOD_MS);
      expect(analisados).toBe(1);
      expect(monitor.getState().analysisBusy).toBe(false);
      await vi.advanceTimersByTimeAsync(CAPTURE_PERIOD_MS);
      // O ciclo SEGUINTE disparou — o assinante hostil não matou o agendamento.
      expect(analisados).toBe(2);
      // E os assinantes saudáveis continuaram recebendo cada patch.
      expect(vistos).toBeGreaterThan(0);
    });

    it("captureFrame que LANÇA não mata o agendamento — o próximo minuto tenta de novo", async () => {
      let chamadas = 0;
      monitor = new MarketMonitor({
        captureFrame: () => {
          chamadas += 1;
          if (chamadas === 1) throw new Error("frame explodiu");
          return {
            ok: true,
            frameHash: null,
            clipping: NO_CLIPPING,
            ...GEOMETRIA,
            dataUrl: `data:image/jpeg;base64,${"x".repeat(30)}#${chamadas}`,
          };
        },
        probe: () => ({ live: true, videoTime: Date.now() / 1000, validDims: true, ended: false }),
      });
      const ok: CaptureMeta[] = [];
      monitor.setAnalyzer(async (_url, meta) => {
        ok.push(meta);
        return true;
      });
      monitor.begin();
      await vi.advanceTimersByTimeAsync(CAPTURE_PERIOD_MS);
      expect(chamadas).toBe(1);
      expect(monitor.getState().lastError).toContain("ciclo falhou");
      await vi.advanceTimersByTimeAsync(CAPTURE_PERIOD_MS);
      expect(chamadas).toBe(2);
      expect(ok).toHaveLength(1);
    });

    it("stop() durante análise pendurada zera o lock — begin() novo nasce livre", async () => {
      const pendurada = deferido<boolean>();
      monitor.setAnalyzer(() => pendurada.promise);
      monitor.begin();
      await vi.advanceTimersByTimeAsync(CAPTURE_PERIOD_MS);
      expect(monitor.getState().analysisBusy).toBe(true);
      monitor.stop();
      const novas: CaptureMeta[] = [];
      monitor.setAnalyzer(async (_url, meta) => {
        novas.push(meta);
        return true;
      });
      monitor.begin();
      await vi.advanceTimersByTimeAsync(CAPTURE_PERIOD_MS);
      // A sessão nova analisa DE IMEDIATO: não herdou o busy da análise morta.
      expect(novas).toHaveLength(1);
      expect(monitor.getState().analysisBusy).toBe(false);
    });

    it("análise que vence a corrida LIMPA o timer de 180s — sem relógio fantasma", async () => {
      monitor.begin();
      const base = vi.getTimerCount();
      await vi.advanceTimersByTimeAsync(CAPTURE_PERIOD_MS);
      // Ciclo reagendado + heartbeat: o mesmo número de timers de antes. Um
      // timer a mais aqui seria o timeout da análise vazando após o race.
      expect(vi.getTimerCount()).toBe(base);
    });
  });
});
