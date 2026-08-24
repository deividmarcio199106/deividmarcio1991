/**
 * QUATRO SUBSISTEMAS, QUATRO ESTADOS INDEPENDENTES.
 *
 * O DEFEITO: o estado da GPU era DERIVADO do erro de escala. Uma leitura de eixo
 * que falhasse por rótulo ilegível marcava a GPU como OFFLINE — e o operador ia
 * reiniciar um túnel que estava funcionando perfeitamente, enquanto o problema
 * real (o recorte da escala) seguia intocado.
 *
 * São perguntas diferentes, com respostas independentes e consertos diferentes:
 *
 *   GPU       o serviço de visão responde?        → túnel, Ollama, modelo
 *   CAPTURA   chega imagem utilizável?            → janela, permissão, monitor
 *   ESCALA    a régua pixel→preço é confiável?    → recorte, rótulos, modelo
 *   T4        o motor está analisando?            → histórico, dado válido
 *
 * A regra que as amarra: um subsistema PODE estar bom com outro ruim. GPU online
 * com escala em erro é o caso normal quando o eixo está cortado. Escala calibrada
 * com T4 aguardando é o caso normal no começo da sessão. Nenhum deles deve
 * contaminar o rótulo do outro.
 */

export type GpuStatus = "ONLINE" | "OFFLINE" | "DESCONHECIDO";
export type CaptureStatus = "ONLINE" | "OFFLINE";
export type ScaleStatus = "CALIBRADA" | "RECALIBRANDO" | "ERRO";
export type EngineStatus = "ANALISANDO" | "AGUARDANDO";

/**
 * Tentativas seguidas antes de chamar a escala de ERRO.
 *
 * Abaixo disso é RECALIBRANDO: o sistema está tentando, e a tentativa faz parte
 * do funcionamento normal. Declarar ERRO na primeira falha transformaria uma
 * retentativa comum — gráfico rolando, eixo momentaneamente encoberto — em
 * alarme, e alarme que dispara à toa deixa de ser lido.
 */
export const SCALE_ERROR_AFTER_ATTEMPTS = 4;

export interface SubsystemInput {
  /** O operador pediu leitura. Sem isso, nada esta ativo — nem otimisticamente. */
  requested: boolean;
  /** Última resposta HTTP do serviço de visão, se houve alguma. */
  gpuReachable: boolean | null;
  captureUsable: boolean;
  scaleReady: boolean;
  scaleAttempts: number;
  scaleConsecutiveFailures: number;
  engineAnalyzing: boolean;
}

export interface SubsystemStatus {
  gpu: GpuStatus;
  capture: CaptureStatus;
  scale: ScaleStatus;
  engine: EngineStatus;
}

/**
 * O estado da GPU vem do HEALTH do serviço, e de mais nada.
 *
 * `null` significa "nunca perguntamos" — e isso é DESCONHECIDO, não ONLINE.
 * Verde sem prova foi o defeito que este projeto vem eliminando.
 */
export function gpuStatusFrom(reachable: boolean | null): GpuStatus {
  if (reachable === null) return "DESCONHECIDO";
  return reachable ? "ONLINE" : "OFFLINE";
}

export function subsystemStatus(input: SubsystemInput): SubsystemStatus {
  return {
    // NÃO olha a escala. Era exatamente isso que estava errado.
    gpu: gpuStatusFrom(input.gpuReachable),
    /*
     * ONLINE EXIGE SESSAO PEDIDA.
     *
     * `isUsable` trata o estado UNKNOWN (antes do primeiro frame) como
     * utilizavel — correto para deixar o pipeline arrancar sem esperar, e
     * ERRADO como rotulo de status: o painel dizia CAPTURA ONLINE com a leitura
     * nem iniciada. Verde antes de existir prova.
     */
    capture: input.requested && input.captureUsable ? "ONLINE" : "OFFLINE",
    // Sem sessao nao ha o que calibrar: RECALIBRANDO ali significaria uma
    // tentativa que nao esta acontecendo.
    scale: !input.requested
      ? "RECALIBRANDO"
      : input.scaleReady
        ? "CALIBRADA"
        : input.scaleConsecutiveFailures >= SCALE_ERROR_AFTER_ATTEMPTS
          ? "ERRO"
          : "RECALIBRANDO",
    engine: input.engineAnalyzing ? "ANALISANDO" : "AGUARDANDO",
  };
}
