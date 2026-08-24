/**
 * O LEDGER DE LEITURAS — a percepção da IA congelada, chamada a chamada.
 *
 * POR QUE ELE EXISTE. Os hashes de código e de configuração provam que o MOTOR
 * é o mesmo — mas não que a PERCEPÇÃO é a mesma: o leitor visual é
 * estocástico, e duas passadas sobre o mesmo print podem devolver stops
 * diferentes. Sem este ledger, comparar H1 contra o baseline poderia estar
 * comparando duas interpretações do mesmo gráfico, não duas regras.
 *
 * O CONTRATO: toda chamada de visão do caminho de vídeo passa por aqui,
 * identificada por (hash da imagem, hash do prompt). No BASELINE o ledger
 * GRAVA cada resposta estruturada com sua proveniência completa. Nos
 * experimentos ele REPRODUZ: mesma imagem + mesmo prompt ⇒ exatamente a
 * resposta gravada, sem tocar o modelo. Só o que o baseline nunca perguntou
 * vira chamada nova — gravada num arquivo PRÓPRIO (overlay), nunca no arquivo
 * do baseline, que depois do congelamento é só-leitura.
 *
 * MESMA PERCEPÇÃO → REGRA DIFERENTE. A divisão de papéis é estrita: o que o
 * modelo respondeu é percepção e mora aqui; o que se DERIVA da resposta
 * (obstáculo entre pivôs, alvos 3R/5R, zona válida) é regra e é recomputado a
 * cada corrida — é exatamente o que os experimentos têm o direito de mudar.
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export function sha256(texto: string): string {
  return createHash("sha256").update(texto).digest("hex");
}

export interface RegistroDeLeitura {
  /** "estrutura" | "niveis" | "rotulo" — a boca de visão que perguntou. */
  tipo: string;
  imageHash: string;
  promptHash: string;
  provider: string;
  model: string;
  parametros: Record<string, unknown>;
  respostaBrutaHash: string | null;
  respostaEstruturadaHash: string;
  /** A resposta estruturada — é o que a reprodução devolve, byte a byte. */
  valor: unknown;
  timestamp: string;
  tentativa: number;
  latenciaMs: number;
}

export interface OpcoesDoLedger {
  /** O arquivo-base (JSONL). No baseline, também recebe as gravações. */
  base: string;
  /**
   * Overlay dos experimentos: leituras NOVAS vão para cá, nunca para o base.
   * Ausente = modo baseline (grava no próprio base).
   */
  novas?: string;
}

export class LedgerDeLeituras {
  private readonly indice = new Map<string, RegistroDeLeitura>();
  private readonly destino: string;
  /** Contadores da corrida — viram relatório, nunca ficam implícitos. */
  hits = 0;
  misses = 0;

  constructor(private readonly opcoes: OpcoesDoLedger) {
    this.destino = opcoes.novas ?? opcoes.base;
    for (const caminho of [opcoes.base, opcoes.novas]) {
      if (caminho === undefined || !existsSync(caminho)) continue;
      for (const linha of readFileSync(caminho, "utf8").split("\n")) {
        if (linha.trim() === "") continue;
        try {
          const reg = JSON.parse(linha) as RegistroDeLeitura;
          this.indice.set(this.chave(reg.imageHash, reg.promptHash), reg);
        } catch {
          // Linha corrompida (gravação interrompida): ignorada, será reobtida.
        }
      }
    }
    mkdirSync(dirname(this.destino), { recursive: true });
  }

  private chave(imageHash: string, promptHash: string): string {
    return `${imageHash}:${promptHash}`;
  }

  /** A resposta congelada, ou null — e o chamador então pergunta ao modelo. */
  consultar(imageHash: string, promptHash: string): RegistroDeLeitura | null {
    const reg = this.indice.get(this.chave(imageHash, promptHash)) ?? null;
    if (reg !== null) this.hits++;
    return reg;
  }

  /** Grava uma leitura nova. No overlay em experimento; no base no baseline. */
  registrar(
    registro: Omit<RegistroDeLeitura, "timestamp" | "respostaEstruturadaHash">,
  ): RegistroDeLeitura {
    const completo: RegistroDeLeitura = {
      ...registro,
      respostaEstruturadaHash: sha256(JSON.stringify(registro.valor ?? null)),
      timestamp: new Date().toISOString(),
    };
    this.misses++;
    this.indice.set(this.chave(completo.imageHash, completo.promptHash), completo);
    appendFileSync(this.destino, JSON.stringify(completo) + "\n");
    return completo;
  }

  resumo(): { total: number; hits: number; misses: number } {
    return { total: this.indice.size, hits: this.hits, misses: this.misses };
  }
}
