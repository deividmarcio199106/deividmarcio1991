/**
 * IDENTIDADE DA GEOMETRIA — a escala só precisa ser relida quando ISTO muda.
 *
 * Com o Qwen levando 6 a 12 segundos por leitura mesmo numa RTX 5090, chamar a
 * IA por timer é desperdício e atraso. A escala de preço não muda com o tempo:
 * ela muda quando a JANELA muda. Resolução, área do gráfico, faixa do eixo e
 * ativo — mudou algum, a reta antiga não vale mais; não mudou nenhum, ela vale
 * indefinidamente e converter pixel em preço é aritmética local instantânea.
 *
 * Por isso o gatilho de recalibração é uma IGUALDADE de hash, não um relógio.
 *
 * O que NÃO entra no hash, de propósito: a posição dos candles. O gráfico rola
 * a cada minuto e os preços sobem e descem o pregão inteiro sem que a escala
 * mude — incluir isso faria a T4 recalibrar sem parar, que é o comportamento
 * que estamos eliminando.
 */

import type { Roi } from "./chartRoi";

export interface Geometry {
  frameWidth: number;
  frameHeight: number;
  roi: Roi;
  /** Fração horizontal onde a faixa do eixo de preço começa. */
  priceAxisFrom: number;
  symbol: string;
}

/**
 * Assinatura estável da geometria.
 *
 * As frações são arredondadas para 3 casas: variação abaixo disso é
 * antialiasing de borda, não gesto do operador, e disparar uma chamada de 6 a
 * 12 segundos por causa de meio pixel seria absurdo.
 */
export function geometryHash(geometry: Geometry): string {
  const r = (value: number) => Math.round(value * 1000) / 1000;
  return [
    geometry.frameWidth,
    geometry.frameHeight,
    r(geometry.roi.x),
    r(geometry.roi.y),
    r(geometry.roi.width),
    r(geometry.roi.height),
    r(geometry.priceAxisFrom),
    geometry.symbol.trim().toUpperCase(),
  ].join("|");
}

export interface ScaleCacheEntry<T> {
  sessionId: string;
  captureRevision: number;
  geometryHash: string;
  value: T;
  storedAt: number;
}

/**
 * Cache de escala por sessão + geometria.
 *
 * A `captureRevision` NÃO participa da busca de propósito: ela identifica o
 * recorte enviado, e o objetivo do cache é justamente reaproveitar a escala
 * entre recortes diferentes da MESMA geometria. Ela fica guardada só para o
 * diagnóstico poder dizer de quando veio a calibração em uso.
 *
 * Trocar de sessão invalida tudo: outra janela compartilhada é outro gráfico.
 */
export class ScaleCache<T> {
  private entries = new Map<string, ScaleCacheEntry<T>>();

  constructor(private readonly maxEntries = 8) {}

  key(sessionId: string, hash: string): string {
    return `${sessionId}::${hash}`;
  }

  get(sessionId: string, hash: string): ScaleCacheEntry<T> | null {
    return this.entries.get(this.key(sessionId, hash)) ?? null;
  }

  set(entry: ScaleCacheEntry<T>): void {
    const key = this.key(entry.sessionId, entry.geometryHash);
    this.entries.delete(key);
    this.entries.set(key, entry);
    // Descarta o mais antigo: o operador alterna entre poucos layouts, e
    // guardar tudo faria uma escala de meia hora atrás voltar à vida.
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** Encerrar a leitura ou trocar de janela zera tudo. */
  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * A geometria mudou o bastante para invalidar a escala?
 *
 * Compara hashes. Igual significa que a reta continua válida — e nesse caso
 * NENHUMA chamada à IA acontece, por mais tempo que passe.
 */
export function geometryChanged(previous: string | null, current: string): boolean {
  return previous !== current;
}
