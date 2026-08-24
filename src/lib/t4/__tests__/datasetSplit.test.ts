import { describe, expect, it } from "vitest";

import { dateInSlice, MIN_SPLIT_DAYS, splitTradingDates } from "../datasetSplit";

function pregoes(count: number): string[] {
  return Array.from({ length: count }, (_, i) => {
    const day = String((i % 28) + 1).padStart(2, "0");
    const month = String(Math.floor(i / 28) + 1).padStart(2, "0");
    return `2026-${month}-${day}`;
  });
}

describe("splitTradingDates", () => {
  it("divide cronologicamente com o OOS sempre no fim", () => {
    const dates = pregoes(20);
    const split = splitTradingDates(dates)!;
    expect(split).not.toBeNull();
    expect(split.treino.dates.length).toBeGreaterThan(split.oos.dates.length);
    // O fora-da-amostra é o FUTURO relativo: tudo nele vem depois do treino.
    expect(split.oos.startDate > split.treino.endDate).toBe(true);
    expect(split.validacao.startDate > split.treino.endDate).toBe(true);
    expect(split.oos.startDate > split.validacao.endDate).toBe(true);
    // Nada se perde nem se repete.
    const todas = [...split.treino.dates, ...split.validacao.dates, ...split.oos.dates];
    expect(todas).toEqual([...new Set(dates)].sort());
  });

  it("menos pregões que o mínimo devolve null — dividir ruído não é método", () => {
    expect(splitTradingDates(pregoes(MIN_SPLIT_DAYS - 1))).toBeNull();
  });

  it("nenhuma fatia sai vazia mesmo no limite mínimo", () => {
    const split = splitTradingDates(pregoes(MIN_SPLIT_DAYS))!;
    expect(split.treino.dates.length).toBeGreaterThanOrEqual(1);
    expect(split.validacao.dates.length).toBeGreaterThanOrEqual(1);
    expect(split.oos.dates.length).toBeGreaterThanOrEqual(1);
  });

  it("datas duplicadas e vazias são saneadas antes da divisão", () => {
    const dates = [...pregoes(12), ...pregoes(12), ""];
    const split = splitTradingDates(dates)!;
    expect(split.totalDays).toBe(12);
  });

  it("dateInSlice confere pertencimento real, não só o intervalo", () => {
    const split = splitTradingDates(pregoes(20))!;
    const dia = split.oos.dates[0]!;
    expect(dateInSlice(dia, split.oos)).toBe(true);
    expect(dateInSlice(dia, split.treino)).toBe(false);
  });
});
