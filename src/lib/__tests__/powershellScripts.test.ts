import { describe, expect, it } from "vitest";

// @ts-expect-error — script utilitário em JS puro, sem tipos
import { checkPowerShellScripts } from "../../../scripts/check-ps1.mjs";

/**
 * Os scripts PowerShell rodam na máquina do operador, não no CI — então um
 * defeito neles só aparece quando alguém está tentando abrir o pregão.
 *
 * O caso real que motivou este teste: `Push-ProfitRtd.ps1` estava em UTF-8 sem
 * BOM. No Windows PowerShell 5.1 (o que abre com "Executar com o PowerShell")
 * o travessão `—` era lido como `â€”`, cujo último caractere é `”` — aspa
 * tipográfica que o PowerShell aceita como delimitador de string. A string
 * fechava no meio da linha e o parser reportava 4 erros em lugares onde não
 * havia nada errado.
 */
describe("scripts PowerShell", () => {
  const resultados = checkPowerShellScripts() as { file: string; problems: string[] }[];

  it("encontra os scripts do projeto", () => {
    expect(resultados.length).toBeGreaterThan(0);
  });

  it.each(resultados)("$file é compatível com PowerShell 5.1 e 7", ({ problems }) => {
    expect(problems).toEqual([]);
  });
});
