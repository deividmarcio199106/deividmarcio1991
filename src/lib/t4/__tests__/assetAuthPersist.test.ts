import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  assetAuthorization,
  assetConfig,
  resetAssetValidations,
  setAssetValidation,
  setAssetValidationStore,
  validatedForProduction,
  validationBlockReason,
} from "../assets";
import {
  bindAssetValidationStore,
  listAssetAuthorizationTrail,
  recordAssetAuthorization,
  resetTradingRepositoryForTests,
} from "@/server/tradingRepository";

/**
 * O DEFEITO QUE ESTES TESTES TRANCAM — E O DEFEITO OPOSTO.
 *
 * A liberação de um ativo vivia num Map em memória: reiniciar o servidor
 * devolvia o WIN ao estado semeado e a autorização conquistada sumia sem deixar
 * registro de que existiu. O comentário do arquivo admitia isso.
 *
 * Só que persistir de qualquer jeito cria o defeito oposto, que é pior: uma
 * marca temporária vira permissão permanente e o sistema libera sinal real
 * apoiado numa evidência que já não descreve a técnica em execução. Por isso a
 * autorização gravada é sempre o PAR (permissão, versão da técnica), acompanhada
 * da trilha que responde quem liberou, quando e contra qual evidência.
 */

const VERSAO_VALIDADA = "T4.9.0-teste";
const VERSAO_SEGUINTE = "T4.10.0-teste";
const EVIDENCIA = "relatorio_oos_2026-08-19";
const AUTOR = "TRILHA_DE_VALIDACAO";

let pastaTemporaria: string | null = null;

/**
 * Banco novo e descartável a cada caso. DATA_DIR aponta para uma pasta criada
 * agora — o banco real do usuário nunca é tocado por teste.
 */
function bancoTemporario(): void {
  resetTradingRepositoryForTests();
  const pasta = mkdtempSync(join(tmpdir(), "t4-asset-auth-"));
  pastaTemporaria = pasta;
  process.env["DATA_DIR"] = pasta;
  delete process.env["DATABASE_PATH"];
  bindAssetValidationStore();
}

/**
 * Reinício do servidor: fecha o SQLite, joga fora o cache em memória e liga uma
 * camada NOVA sobre o MESMO arquivo de banco. Se a autorização voltar, ela veio
 * do disco — não de memória residual.
 */
function reiniciarServidor(): void {
  resetTradingRepositoryForTests();
  bindAssetValidationStore();
}

afterEach(() => {
  resetTradingRepositoryForTests();
  resetAssetValidations();
  if (pastaTemporaria) rmSync(pastaTemporaria, { recursive: true, force: true });
  pastaTemporaria = null;
  delete process.env["DATA_DIR"];
  delete process.env["DATABASE_PATH"];
});

describe.sequential("autorização de produção por ativo que sobrevive a reinício", () => {
  it("a autorização do WINFUT continua valendo depois do reinício", () => {
    bancoTemporario();
    setAssetValidation("WINFUT", "VALIDATED_FOR_PRODUCTION", VERSAO_VALIDADA, {
      evidenceRef: EVIDENCIA,
      grantedBy: AUTOR,
      at: 1_700_000_000_000,
    });
    expect(validatedForProduction(assetConfig("WINFUT"), VERSAO_VALIDADA)).toBe(true);

    resetTradingRepositoryForTests();
    // A PROVA DE QUE O REINÍCIO É REAL: sem o store religado o ativo volta ao
    // estado semeado. Sem esta asserção o teste passaria por memória residual.
    expect(assetConfig("WINFUT")?.validation).toBe("IN_VALIDATION");

    bindAssetValidationStore();
    expect(validatedForProduction(assetConfig("WINFUT"), VERSAO_VALIDADA)).toBe(true);
    expect(validationBlockReason(assetConfig("WINFUT"), "WINFUT", VERSAO_VALIDADA)).toBeNull();
  });

  it("a trilha guarda quem concedeu, quando, sob qual versão e contra qual evidência", () => {
    bancoTemporario();
    setAssetValidation("WINFUT", "VALIDATED_FOR_PRODUCTION", VERSAO_VALIDADA, {
      evidenceRef: EVIDENCIA,
      grantedBy: AUTOR,
      at: 1_700_000_000_000,
    });
    reiniciarServidor();

    expect(assetAuthorization("WINFUT")).toMatchObject({
      symbol: "WINFUT",
      status: "VALIDATED_FOR_PRODUCTION",
      techniqueVersion: VERSAO_VALIDADA,
      evidenceRef: EVIDENCIA,
      grantedBy: AUTOR,
      grantedAt: 1_700_000_000_000,
      revokedAt: null,
    });
  });

  it("a autorização persistida NÃO vale para outra versão da técnica", () => {
    bancoTemporario();
    setAssetValidation("WINFUT", "VALIDATED_FOR_PRODUCTION", VERSAO_VALIDADA, {
      evidenceRef: EVIDENCIA,
      grantedBy: AUTOR,
    });
    reiniciarServidor();

    // É ISTO que impede a persistência de virar permissão eterna: a evidência
    // descreve a técnica antiga, então a permissão cai sozinha no bump.
    expect(validatedForProduction(assetConfig("WINFUT"), VERSAO_SEGUINTE)).toBe(false);
    expect(validationBlockReason(assetConfig("WINFUT"), "WINFUT", VERSAO_SEGUINTE)).toContain(
      "Revalidar",
    );
  });

  it("conceder produção sem referência de evidência é recusado e nada é gravado", () => {
    bancoTemporario();
    expect(() =>
      setAssetValidation("WINFUT", "VALIDATED_FOR_PRODUCTION", VERSAO_VALIDADA, {
        grantedBy: AUTOR,
      }),
    ).toThrow(/evidência/);

    expect(listAssetAuthorizationTrail("WINFUT")).toHaveLength(0);
    expect(validatedForProduction(assetConfig("WINFUT"), VERSAO_VALIDADA)).toBe(false);
  });

  it("gravar autorização sem declarar quem concedeu é recusado", () => {
    bancoTemporario();
    expect(() =>
      setAssetValidation("WINFUT", "VALIDATED_FOR_PRODUCTION", VERSAO_VALIDADA, {
        evidenceRef: EVIDENCIA,
      }),
    ).toThrow(/quem concedeu/);
    expect(listAssetAuthorizationTrail("WINFUT")).toHaveLength(0);
  });

  it("o banco recusa produção sem evidência mesmo quando gravam por fora do assets.ts", () => {
    bancoTemporario();
    expect(() =>
      recordAssetAuthorization({
        symbol: "WINFUT",
        status: "VALIDATED_FOR_PRODUCTION",
        techniqueVersion: VERSAO_VALIDADA,
        evidenceRef: null,
        grantedAt: 1,
        grantedBy: AUTOR,
        revokedAt: null,
      }),
    ).toThrow();
    expect(listAssetAuthorizationTrail("WINFUT")).toHaveLength(0);
  });

  it("revogar persiste como EVENTO e o ativo volta a bloquear depois do reinício", () => {
    bancoTemporario();
    setAssetValidation("WINFUT", "VALIDATED_FOR_PRODUCTION", VERSAO_VALIDADA, {
      evidenceRef: EVIDENCIA,
      grantedBy: AUTOR,
      at: 1_000,
    });
    setAssetValidation("WINFUT", "LAB_ONLY", null, { grantedBy: "AUDITORIA", at: 2_000 });

    reiniciarServidor();
    expect(validatedForProduction(assetConfig("WINFUT"), VERSAO_VALIDADA)).toBe(false);
    expect(validationBlockReason(assetConfig("WINFUT"), "WINFUT", VERSAO_VALIDADA)).toContain(
      "LAB ONLY",
    );

    // A concessão anterior CONTINUA na trilha, encerrada — revogar por delete
    // apagaria a prova de que a permissão existiu e de quando caiu.
    const trilha = listAssetAuthorizationTrail("WINFUT");
    expect(trilha).toHaveLength(2);
    expect(trilha[0]).toMatchObject({
      status: "LAB_ONLY",
      revokedAt: null,
      grantedBy: "AUDITORIA",
    });
    expect(trilha[1]).toMatchObject({
      status: "VALIDATED_FOR_PRODUCTION",
      evidenceRef: EVIDENCIA,
      revokedAt: 2_000,
    });
  });

  it("autorizar o WIN não autoriza o WDO, nem depois do reinício", () => {
    bancoTemporario();
    setAssetValidation("WINFUT", "VALIDATED_FOR_PRODUCTION", VERSAO_VALIDADA, {
      evidenceRef: EVIDENCIA,
      grantedBy: AUTOR,
    });
    reiniciarServidor();

    expect(validatedForProduction(assetConfig("WDOFUT"), VERSAO_VALIDADA)).toBe(false);
    expect(validationBlockReason(assetConfig("WDOFUT"), "WDOFUT", VERSAO_VALIDADA)).toContain(
      "LAB ONLY",
    );
    expect(listAssetAuthorizationTrail("WDOFUT")).toHaveLength(0);
  });

  it("sem store injetado nada é gravado e a marca segue temporária — como antes", () => {
    bancoTemporario();
    setAssetValidationStore(null);

    // Sem persistência, conceder não exige trilha: é exatamente o caminho que o
    // cliente percorre hoje, e ele não pode ter mudado.
    setAssetValidation("WINFUT", "VALIDATED_FOR_PRODUCTION", VERSAO_VALIDADA);
    expect(validatedForProduction(assetConfig("WINFUT"), VERSAO_VALIDADA)).toBe(true);
    expect(listAssetAuthorizationTrail("WINFUT")).toHaveLength(0);

    resetAssetValidations();
    expect(assetConfig("WINFUT")?.validation).toBe("IN_VALIDATION");
  });
});
