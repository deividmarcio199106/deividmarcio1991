import { describe, expect, it } from "vitest";

import { buildZipStore, crc32 } from "../printExport";

/**
 * O zip é formato binário: um byte errado e o WinRAR recusa o arquivo
 * inteiro. Estes testes trancam as assinaturas, o CRC (vetor clássico de
 * verificação) e a contagem do diretório central.
 */

const AT = Date.UTC(2026, 7, 19, 12, 0, 0);

describe("crc32", () => {
  it("bate o vetor de verificação clássico: '123456789' → 0xCBF43926", () => {
    const data = new TextEncoder().encode("123456789");
    expect(crc32(data)).toBe(0xcbf43926);
  });

  it("vazio → 0", () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe("buildZipStore", () => {
  const arquivo = (nome: string, texto: string) => ({
    name: nome,
    data: new TextEncoder().encode(texto),
  });

  it("assinaturas PK nos três blocos e contagem correta no fim", () => {
    const zip = buildZipStore([arquivo("a.txt", "alpha"), arquivo("b.txt", "beta")], AT);
    // Local header do primeiro arquivo.
    expect([...zip.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    // Fim do diretório central nos últimos 22 bytes.
    const eocd = zip.slice(zip.length - 22);
    expect([...eocd.slice(0, 4)]).toEqual([0x50, 0x4b, 0x05, 0x06]);
    // Contagem de entradas (offsets 8-9 e 10-11 do EOCD).
    expect(eocd[8]! | (eocd[9]! << 8)).toBe(2);
    expect(eocd[10]! | (eocd[11]! << 8)).toBe(2);
  });

  it("método store: o conteúdo aparece literal dentro do zip", () => {
    const zip = buildZipStore([arquivo("nota.txt", "CONTEUDO_LITERAL_XYZ")], AT);
    const texto = new TextDecoder("latin1").decode(zip);
    expect(texto).toContain("CONTEUDO_LITERAL_XYZ");
    expect(texto).toContain("nota.txt");
  });

  it("zip vazio ainda é um zip válido (só o EOCD)", () => {
    const zip = buildZipStore([], AT);
    expect(zip.length).toBe(22);
    expect([...zip.slice(0, 4)]).toEqual([0x50, 0x4b, 0x05, 0x06]);
  });

  it("determinístico: mesmo conteúdo e mesmo instante, mesmos bytes", () => {
    const a = buildZipStore([arquivo("x.png", "png-fake")], AT);
    const b = buildZipStore([arquivo("x.png", "png-fake")], AT);
    expect([...a]).toEqual([...b]);
  });
});
