/**
 * O PRINT CONGELADO DOS DOIS INSTANTES QUE IMPORTAM.
 *
 * O QUE ISTO RESOLVE. O operador não pode ficar olhando a tela o dia inteiro —
 * e não precisa. O que ele precisa é de duas fotografias, tiradas sozinhas:
 *
 *   1. APROXIMAÇÃO — "está chegando numa região operacional; olhe";
 *   2. ENTRADA CONFIRMADA — "a técnica fechou; a decisão é esta".
 *
 * Fora desses dois instantes, o sistema MONITORA e não guarda nada. Congelar a
 * cada frame encheria o disco de fotografias do mesmo gráfico parado e, pior,
 * daria ao operador uma pilha onde ele teria de procurar o que importa.
 *
 * POR QUE "CONGELAR" E NÃO "SALVAR". Auditado neste repositório: no caminho ao
 * vivo os níveis publicados vinham da decisão NOVA a cada frame — entrada,
 * stop e alvos podiam mudar depois do sinal, enquanto o operador digitava a
 * ordem. Um registro que muda depois do fato não é evidência, é rascunho.
 * Aqui, uma vez escrito, o registro é imutável POR CONSTRUÇÃO (`Object.freeze`)
 * e a segunda gravação do mesmo instante é recusada — não sobrescrita.
 *
 * O QUE ESTE MÓDULO NÃO FAZ: não decide, não avalia gate, não toca som e não
 * executa ordem. Ele guarda o que a técnica decidiu, no instante em que
 * decidiu, com a imagem que ela estava vendo.
 */

import type { Candle, Direction } from "@/lib/engines/types";
import type { T4SetupId } from "@/lib/engines/t4Engine";

/** Qual dos dois instantes esta fotografia registra. */
export type MomentoCongelado = "APROXIMACAO" | "ENTRADA_CONFIRMADA";

export interface NiveisCongelados {
  entrada: number | null;
  stop: number | null;
  alvo1: number | null;
  alvo2: number | null;
  /** Risco:retorno do plano no instante do congelamento. */
  rr: number | null;
}

export interface PrintCongelado {
  /** Identidade do setup — a mesma que a máquina de estágio usa. */
  setupId: string;
  momento: MomentoCongelado;
  /** Instante de MERCADO (relógio do gráfico quando confiável). */
  chartTimestamp: number;
  /** Instante local, só telemetria — nunca data de mercado. */
  capturadoEm: number;
  asset: string;
  direcao: Direction;
  familia: T4SetupId | null;
  estagio: string;
  maturidade: number;
  niveis: NiveisCongelados;
  /** Preço no instante — null quando a escala não estava calibrada. */
  precoAtual: number | null;
  /** true quando os níveis são preço de mercado, não unidade de pixel. */
  precoConfiavel: boolean;
  /** O que ainda falta (aproximação) ou o que provou (confirmação). */
  motivo: string;
  confluencias: string[];
  /** Candle fechado que sustenta o registro, quando existe. */
  candle: Candle | null;
  /** A IMAGEM do gráfico naquele instante, em data URL. */
  imagem: string | null;
  /** Assinatura perceptual do frame — prova de qual fotografia é esta. */
  frameHash: string | null;
  versaoDaTecnica: string;
}

export interface RegistroDoSetup {
  setupId: string;
  aproximacao: PrintCongelado | null;
  confirmacao: PrintCongelado | null;
}

/**
 * O cofre dos congelamentos da sessão.
 *
 * Guarda no máximo DOIS registros por setup. Tentar regravar um instante já
 * gravado devolve `false` — a primeira fotografia é a que vale, porque é a que
 * o operador viu quando o alerta tocou.
 */
export class CofreDeEvidencias {
  private readonly porSetup = new Map<string, RegistroDoSetup>();
  private readonly ordem: string[] = [];

  constructor(private readonly limiteDeSetups = 200) {}

  /**
   * Congela um instante. Devolve `false` quando já existia — sem sobrescrever.
   */
  congelar(print: PrintCongelado): boolean {
    const existente = this.porSetup.get(print.setupId);
    const registro: RegistroDoSetup = existente ?? {
      setupId: print.setupId,
      aproximacao: null,
      confirmacao: null,
    };
    const campo = print.momento === "APROXIMACAO" ? "aproximacao" : "confirmacao";
    if (registro[campo] !== null) return false;

    // Imutável a partir daqui: nem este módulo consegue reescrever.
    registro[campo] = Object.freeze({ ...print, niveis: Object.freeze({ ...print.niveis }) });
    if (!existente) {
      this.porSetup.set(print.setupId, registro);
      this.ordem.push(print.setupId);
      // Teto de memória: a sessão de um pregão inteiro não pode crescer sem fim.
      while (this.ordem.length > this.limiteDeSetups) {
        const antigo = this.ordem.shift();
        if (antigo !== undefined) this.porSetup.delete(antigo);
      }
    }
    return true;
  }

  /** true quando este instante deste setup já foi congelado. */
  jaCongelado(setupId: string, momento: MomentoCongelado): boolean {
    const r = this.porSetup.get(setupId);
    if (!r) return false;
    return (momento === "APROXIMACAO" ? r.aproximacao : r.confirmacao) !== null;
  }

  registro(setupId: string): RegistroDoSetup | null {
    return this.porSetup.get(setupId) ?? null;
  }

  /** Todos os registros, do mais antigo para o mais novo. */
  todos(): RegistroDoSetup[] {
    return this.ordem
      .map((id) => this.porSetup.get(id))
      .filter((r): r is RegistroDoSetup => r !== undefined);
  }

  /** Só as confirmações — a lista que o operador abre no fim do dia. */
  confirmacoes(): PrintCongelado[] {
    return this.todos()
      .map((r) => r.confirmacao)
      .filter((p): p is PrintCongelado => p !== null);
  }

  limpar(): void {
    this.porSetup.clear();
    this.ordem.length = 0;
  }
}
