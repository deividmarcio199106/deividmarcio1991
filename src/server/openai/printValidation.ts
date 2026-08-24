/**
 * FLUXO DE VALIDAÇÃO DO PRINT — Luna lê tudo, Terra desafia o que pode virar
 * entrada, o combinador determinístico dá a palavra final.
 *
 *   Profit → captura 60s → motor T4 (decide) → Luna (lê o print)
 *        → [se PRE_ALERTA/ARMADO/possível CONFIRMADO] Terra (ataca)
 *        → finalConfirmation (código, não IA) → persistência idempotente.
 *
 * TRÊS INVARIANTES OPERACIONAIS:
 *   1. OpenAI fora do ar NÃO para a captura: devolve INDISPONÍVEL e o
 *      combinador nega apenas a CONFIRMAÇÃO que dependeria da IA.
 *   2. Nada aqui recalcula técnica: `deterministic` chega pronto do motor.
 *   3. Persistência nunca sobrescreve: (imageHash, candleTime) é idempotente —
 *      reprocessar o mesmo print não reescreve história.
 */

import {
  LUNA_JSON_SCHEMA,
  LunaPrintReadSchema,
  TERRA_JSON_SCHEMA,
  TerraChallengeSchema,
  parseAi,
  type LunaPrintRead,
  type TerraChallenge,
} from "@/lib/t4/aiSchemas";
import {
  aiStatusRows,
  finalConfirmation,
  lunaSanity,
  type AiAvailability,
  type FinalConfirmation,
  type LunaSanityRead,
} from "@/lib/t4/aiValidation";
import { saveAiValidation } from "../tradingRepository";
import { callOpenAi, openAiConfigured } from "./openaiClient";

export interface DeterministicSnapshot {
  pass: boolean;
  e2Closed: boolean;
  rr: number | null;
  rrOk: boolean;
  entry: number | null;
  stop: number | null;
  levelsValid: boolean;
  stage: string;
  blockCode: string | null;
  blockReason: string | null;
}

export interface PrintValidationInput {
  imageDataUrl: string;
  imageHash: string;
  captureId: string;
  candleTime: number;
  deterministic: DeterministicSnapshot;
  fetchImpl?: typeof fetch;
}

export interface PrintValidationOutput {
  luna: AiAvailability<{ read: LunaPrintRead; sanity: LunaSanityRead }>;
  terra: AiAvailability<TerraChallenge>;
  final: FinalConfirmation;
  ui: { luna: string; terra: string; t4: string; veredito: string };
}

/** Estágios que justificam gastar a segunda validação (Terra). */
const ESTAGIOS_DE_TERRA = new Set(["PRE_ALERT", "PRE_ALERTA", "ARMED", "ARMADO", "CONFIRMED"]);

const REGRAS_COMUNS = [
  "NÃO invente preço, nível ou candle: o que não estiver legível é null.",
  "Candle ABERTO nunca confirma nada.",
  "Não use nenhuma informação posterior ao instante do print.",
  "Você NÃO calcula nem libera entrada: o código determinístico é a fonte de R:R>=3, stop estrutural, 3R/5R, horário e confirmação.",
].join("\n");

function promptLuna(d: DeterministicSnapshot, captureId: string, candleTime: number): string {
  return [
    "Você lê UM print de gráfico WINFUT 1min e devolve SOMENTE o JSON do schema.",
    REGRAS_COMUNS,
    `captureId=${captureId} candleTime=${candleTime}`,
    `Estado T4 determinístico atual: ${JSON.stringify(d)}`,
    "Compare o que VÊ com esse estado; contradições vão no campo contradictions.",
  ].join("\n\n");
}

function promptTerra(d: DeterministicSnapshot, luna: LunaPrintRead): string {
  return [
    "Você é o SEGUNDO validador, ADVERSARIAL: sua tarefa é procurar ERRO na leitura abaixo e na decisão determinística — não concordar.",
    REGRAS_COMUNS,
    `Decisão determinística T4: ${JSON.stringify(d)}`,
    `Leitura Luna: ${JSON.stringify(luna)}`,
    "Se houver QUALQUER inconsistência entre print, leitura e decisão, verdict=REJECT com o criticalIssue. Dúvida séria = INCONCLUSIVE. APPROVE só sem furo.",
  ].join("\n\n");
}

export async function validatePrintWithOpenAI(
  input: PrintValidationInput,
): Promise<PrintValidationOutput> {
  const { deterministic: d } = input;

  let luna: PrintValidationOutput["luna"];
  let terra: PrintValidationOutput["terra"] = { status: "NAO_CHAMADO" };
  let latencyMs = 0;
  let tokens = 0;

  if (!openAiConfigured()) {
    luna = { status: "INDISPONIVEL", reason: "OPENAI_API_KEY não configurada no servidor." };
  } else {
    const r = await callOpenAi({
      role: "PRINT",
      prompt: promptLuna(d, input.captureId, input.candleTime),
      imageDataUrl: input.imageDataUrl,
      jsonSchema: LUNA_JSON_SCHEMA,
      fetchImpl: input.fetchImpl,
    });
    latencyMs += r.latencyMs;
    tokens += (r.usage.inputTokens ?? 0) + (r.usage.outputTokens ?? 0);
    if (!r.ok || r.outputText === null) {
      luna = { status: "INDISPONIVEL", reason: r.error ?? "sem resposta" };
    } else {
      let bruto: unknown;
      try {
        bruto = JSON.parse(r.outputText);
      } catch {
        bruto = null;
      }
      const parsed = parseAi(LunaPrintReadSchema, bruto);
      if (!parsed.ok) {
        // JSON fora do schema BLOQUEIA — nunca aproveita "o que deu certo".
        luna = { status: "INDISPONIVEL", reason: `JSON inválido: ${parsed.reason}` };
      } else {
        const sanity = lunaSanity({
          luna: parsed.value,
          deterministic: { entry: d.entry, stop: d.stop },
        });
        luna = { status: "OK", value: { read: parsed.value, sanity } };

        // Terra: só quando existe possível entrada em jogo — e Luna utilizável.
        if (ESTAGIOS_DE_TERRA.has(d.stage) && sanity.usable) {
          const t = await callOpenAi({
            role: "VALIDATOR",
            prompt: promptTerra(d, parsed.value),
            imageDataUrl: input.imageDataUrl,
            jsonSchema: TERRA_JSON_SCHEMA,
            fetchImpl: input.fetchImpl,
          });
          latencyMs += t.latencyMs;
          tokens += (t.usage.inputTokens ?? 0) + (t.usage.outputTokens ?? 0);
          if (!t.ok || t.outputText === null) {
            terra = { status: "INDISPONIVEL", reason: t.error ?? "sem resposta" };
          } else {
            let tb: unknown;
            try {
              tb = JSON.parse(t.outputText);
            } catch {
              tb = null;
            }
            const tp = parseAi(TerraChallengeSchema, tb);
            terra = tp.ok
              ? { status: "OK", value: tp.value }
              : { status: "INDISPONIVEL", reason: `JSON inválido: ${tp.reason}` };
          }
        }
      }
    }
  }

  const final = finalConfirmation({
    t4DeterministicPass: d.pass,
    e2Closed: d.e2Closed,
    rrOk: d.rrOk,
    levelsValid: d.levelsValid,
    luna,
    terra,
  });

  // HISTÓRICO: grava sempre — inclusive INDISPONÍVEL. O que não pode é
  // sobrescrever: a chave (imageHash, candleTime) torna o replay idempotente.
  // E FALHA DE BANCO NÃO DERRUBA A VALIDAÇÃO (auditoria sênior, B6): o
  // veredito já existe e o chamador precisa dele; perder o REGISTRO é um
  // defeito declarado no log, não uma exceção que apaga a resposta — a
  // captura nunca para porque um INSERT falhou.
  try {
    saveAiValidation({
      imageHash: input.imageHash,
      captureId: input.captureId,
      candleTime: input.candleTime,
      t4DecisionJson: JSON.stringify(d),
      lunaJson: luna.status === "OK" ? JSON.stringify(luna.value.read) : null,
      terraJson: terra.status === "OK" ? JSON.stringify(terra.value) : null,
      latencyMs,
      tokens,
      // Custo real depende da tabela de preço vigente; sem ela, null — nunca 0.
      costUsd: null,
      status: final.confirmado
        ? "CONFIRMADO"
        : luna.status !== "OK"
          ? "AI_INDISPONIVEL"
          : "AGUARDAR",
    });
  } catch (raised) {
    console.error(
      `[printValidation] veredito emitido mas NÃO persistido (${input.imageHash.slice(0, 12)}…, candle ${input.candleTime}): ${String(raised).slice(0, 200)}`,
    );
  }

  return {
    luna,
    terra,
    final,
    ui: aiStatusRows({ luna, terra, t4DeterministicPass: d.pass, final }),
  };
}
