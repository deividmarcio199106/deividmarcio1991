/**
 * CICLO DE VIDA DA ESCALA — quando chamar o Qwen, quando reusar, por que falhou.
 *
 * Três decisões estavam espalhadas pelo hook e por isso ninguém conseguia
 * responder "por que está CALIBRANDO há três minutos". Aqui elas ficam juntas e
 * testáveis sem React, sem canvas e sem GPU:
 *
 *   1. PRECISO CHAMAR?  Só quando o `geometryHash` muda. A escala de preço não
 *      muda com o tempo — muda quando a JANELA muda. Hash igual é CACHE HIT e
 *      NENHUMA chamada acontece, por mais tempo que passe.
 *   2. POSSO CHAMAR AGORA?  Backoff após falha, um pedido por vez. Enfileirar
 *      recortes com o modelo levando 6–12s só produz respostas velhas.
 *   3. POR QUE NÃO DEU?  Um `ScaleRejectCode`, sempre. "CALIBRANDO · 3
 *      tentativas · 0/2 âncoras" não é diagnóstico: não diz se a GPU caiu, se a
 *      ROI está na região errada ou se a régua percentual foi ignorada.
 *
 * O QUE ESTE MÓDULO NUNCA FAZ: bloquear a leitura. A T4 lê estrutura em unidade
 * de pixel desde o primeiro frame; a escala só decide se um NÚMERO pode ser
 * publicado. Falhar aqui mantém `priceScaleReady=false` e nada mais.
 */

import {
  assetScaleIssue,
  calibrateRobust,
  normalizeScaleAnchorsForAsset,
  type Calibration,
  type ScaleAnchor,
} from "./priceScale";
import type { LabelReading, Regression } from "./scaleLabels";
import { buildPriceScale, EMPTY_PRICE_SCALE, type PriceScaleState } from "./priceScaleTracker";
import { geometryHash, ScaleCache, type Geometry } from "./geometryHash";
import { classifyCalibration, scaleReject, type ScaleReject, type LabelAudit } from "./scaleReject";

/** Estado do cache para o painel — HIT significa zero GPU nesta geometria. */
export type ScaleCacheState = "COLD" | "HIT" | "MISS";

export interface ScaleSessionState {
  scale: PriceScaleState;
  /** Assinatura da geometria em vigor. Null antes do primeiro frame. */
  geometryHash: string | null;
  /** Sobe a cada mudança de geometria. Resposta com revisão velha é descartada. */
  revision: number;
  cache: ScaleCacheState;
  /** Tentativas de OCR nesta sessão — só as que de fato saíram para a GPU. */
  attempts: number;
  consecutiveFailures: number;
  lastAttemptAt: number | null;
  /** Por que a escala não está pronta. Null quando está. */
  reject: ScaleReject | null;
  lastAudit: LabelAudit | null;
  /** CADA rotulo da ultima leitura, com o motivo do descarte. */
  lastLabels: LabelReading[];
  /** Reta da ultima leitura: R2 e desvio maximo, para o painel. */
  lastRegression: Regression | null;
  lastLatencyMs: number | null;
  calibratedAt: number | null;
  model: string | null;
}

export const SCALE_SESSION_CONFIG = {
  /** Recuo após falha. Nunca desiste, só desacelera. */
  backoffBaseMs: 5_000,
  maxBackoffMs: 120_000,
  /**
   * Rede de segurança para uma mudança que o hash não capture. NÃO é o gatilho
   * normal: com hash estável a escala vale indefinidamente.
   */
  revalidateMs: 10 * 60_000,
} as const;

export const EMPTY_SCALE_SESSION: ScaleSessionState = {
  scale: EMPTY_PRICE_SCALE,
  geometryHash: null,
  revision: 0,
  cache: "COLD",
  attempts: 0,
  consecutiveFailures: 0,
  lastAttemptAt: null,
  reject: null,
  lastAudit: null,
  lastLabels: [],
  lastRegression: null,
  lastLatencyMs: null,
  calibratedAt: null,
  model: null,
};

/** Resposta do OCR já parseada, do jeito que o servidor devolve. */
export interface ScaleOcrResponse {
  anchors: ScaleAnchor[];
  model: string;
  error: string | null;
  reject: ScaleReject | null;
  audit: LabelAudit | null;
  labels?: LabelReading[];
  regression?: Regression | null;
  /** Revisão do recorte enviado — carimbada no envio, conferida na volta. */
  revision: number;
  sentAt: number;
}

function backoffFor(failures: number): number {
  if (failures === 0) return 0;
  return Math.min(
    SCALE_SESSION_CONFIG.maxBackoffMs,
    SCALE_SESSION_CONFIG.backoffBaseMs * Math.pow(2, Math.min(failures - 1, 5)),
  );
}

export class PriceScaleSession {
  private state: ScaleSessionState = EMPTY_SCALE_SESSION;
  private cacheStore = new ScaleCache<Calibration>();
  private inFlight = false;

  constructor(
    private sessionId: string,
    private asset: string,
  ) {}

  snapshot(): ScaleSessionState {
    return this.state;
  }

  /** Trocar de janela ou de ativo mata a escala: outro gráfico, outra reta. */
  reset(sessionId: string, asset: string): void {
    this.sessionId = sessionId;
    this.asset = asset;
    this.cacheStore.clear();
    this.inFlight = false;
    this.state = EMPTY_SCALE_SESSION;
  }

  /**
   * Registra a geometria do frame atual.
   *
   * Hash igual: nada acontece — nem chamada, nem invalidação, por mais tempo que
   * passe. Hash diferente: a reta anterior não vale mais, e o cache é consultado
   * ANTES de cogitar gastar 6–12 segundos de GPU.
   */
  observe(geometry: Geometry, now: number): ScaleSessionState {
    const hash = geometryHash(geometry);
    if (hash === this.state.geometryHash) return this.state;

    const cached = this.cacheStore.get(this.sessionId, hash);
    if (cached !== null) {
      // CACHE HIT: esta janela já foi calibrada nesta sessão. Zero GPU.
      this.state = {
        ...this.state,
        geometryHash: hash,
        revision: this.state.revision + 1,
        cache: "HIT",
        scale: buildPriceScale(cached.value.anchors, now),
        reject: null,
        consecutiveFailures: 0,
        calibratedAt: cached.storedAt,
      };
      return this.state;
    }

    this.state = {
      ...this.state,
      geometryHash: hash,
      revision: this.state.revision + 1,
      cache: this.state.geometryHash === null ? "COLD" : "MISS",
      // A geometria mudou: a reta antiga descreveria uma janela que não existe
      // mais, e preço plausível e errado é o pior resultado possível.
      scale: EMPTY_PRICE_SCALE,
      reject: null,
      calibratedAt: null,
    };
    return this.state;
  }

  /**
   * Vale chamar o modelo agora?
   *
   * A pergunta anterior — "já passou o intervalo?" — chamava a GPU a cada 30s
   * para reconfirmar uma reta que não tinha mudado. Aqui a escala pronta só é
   * rechecada pela rede de segurança, e mesmo assim sem derrubá-la.
   */
  shouldRequest(now: number): boolean {
    if (this.inFlight) return false;
    if (this.state.geometryHash === null) return false;
    if (this.state.scale.priceScaleReady) {
      const since = this.state.calibratedAt;
      return since !== null && now - since > SCALE_SESSION_CONFIG.revalidateMs;
    }
    const failures = this.state.consecutiveFailures;
    if (failures > 0 && this.state.lastAttemptAt !== null) {
      if (now - this.state.lastAttemptAt < backoffFor(failures)) return false;
    }
    return true;
  }

  /** Carimba o envio. A revisão devolvida volta na resposta para conferência. */
  begin(now: number): { revision: number; sentAt: number } {
    this.inFlight = true;
    this.state = {
      ...this.state,
      attempts: this.state.attempts + 1,
      lastAttemptAt: now,
    };
    return { revision: this.state.revision, sentAt: now };
  }

  /**
   * Aplica (ou descarta) uma resposta.
   *
   * A conferência de revisão vem PRIMEIRO: entre o envio e a volta o operador
   * pode ter dado zoom, e uma reta lida na geometria antiga produziria preços
   * plausíveis e errados — exatamente o que não pode chegar à tela.
   */
  apply(response: ScaleOcrResponse, now: number): ScaleSessionState {
    this.inFlight = false;
    const latency = now - response.sentAt;

    if (response.revision !== this.state.revision) {
      this.state = {
        ...this.state,
        lastLatencyMs: latency,
        reject: scaleReject(
          "STALE_RESPONSE",
          `resposta da revisão ${response.revision}, geometria já está na ${this.state.revision}`,
        ),
      };
      return this.state;
    }

    const fail = (reject: ScaleReject): ScaleSessionState => {
      this.state = {
        ...this.state,
        scale: EMPTY_PRICE_SCALE,
        reject,
        lastAudit: response.audit,
        lastLabels: response.labels ?? [],
        lastRegression: response.regression ?? null,
        lastLatencyMs: latency,
        model: response.model || this.state.model,
        consecutiveFailures: this.state.consecutiveFailures + 1,
      };
      return this.state;
    };

    if (response.reject !== null) return fail(response.reject);
    if (response.anchors.length === 0) {
      return fail(scaleReject("NO_LABELS", response.error ?? "nenhuma âncora devolvida"));
    }

    const anchors = normalizeScaleAnchorsForAsset(this.asset, response.anchors);
    const issue = assetScaleIssue(this.asset, anchors);
    if (issue !== null) {
      // Números fora da faixa do contrato são de indicador, volume ou relógio —
      // não da escala. Aceitá-los calibraria a T4 com a régua errada.
      return fail(scaleReject("BAD_TICK", issue));
    }

    // Robusta: um rótulo lido na altura errada não reprova os outros três.
    const calibration = calibrateRobust(anchors);
    const calibrationReject = classifyCalibration(calibration);
    if (calibrationReject !== null) return fail(calibrationReject);

    const hash = this.state.geometryHash;
    if (hash !== null) {
      this.cacheStore.set({
        sessionId: this.sessionId,
        captureRevision: response.revision,
        geometryHash: hash,
        value: calibration,
        storedAt: now,
      });
    }

    this.state = {
      ...this.state,
      scale: buildPriceScale(calibration.anchors, now),
      reject: null,
      lastAudit: response.audit,
      lastLabels: response.labels ?? [],
      lastRegression: response.regression ?? null,
      lastLatencyMs: latency,
      model: response.model || this.state.model,
      consecutiveFailures: 0,
      calibratedAt: now,
    };
    return this.state;
  }

  /** Falha antes mesmo de sair (canvas indisponível, recorte impossível). */
  failLocally(reject: ScaleReject, now: number): ScaleSessionState {
    this.inFlight = false;
    this.state = {
      ...this.state,
      reject,
      consecutiveFailures: this.state.consecutiveFailures + 1,
      lastAttemptAt: now,
    };
    return this.state;
  }

  get cacheSize(): number {
    return this.cacheStore.size;
  }
}
