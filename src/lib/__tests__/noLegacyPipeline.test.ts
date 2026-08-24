import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * O LEGADO NÃO PODE VOLTAR SOZINHO.
 *
 * Ao vivo, com PROFIT VISION ativo e rodando, o card inferior ainda escrevia
 * "PRÓXIMO PASSO: Conectando na bridge local". Nenhuma bridge existia; o texto
 * vinha de uma escada de progresso do caminho RTD que continuava importada. O
 * operador lia uma instrução para consertar um componente que já não fazia
 * parte do sistema.
 *
 * Esconder aquele texto teria resolvido o sintoma e deixado o mecanismo. Este
 * teste ataca o mecanismo: se alguém reintroduzir bridge, RTD, WebSocket 8765
 * ou os hooks legados no código do aplicativo, ele falha ANTES de a UI voltar a
 * mentir. É uma asserção de arquitetura, não de aparência.
 */

const ROOT = join(process.cwd(), "src");

/** Termos que não podem existir no runtime do aplicativo. */
const FORBIDDEN: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /useLiveSession/, why: "hook legado de sessão visual (CandleReconstructor)" },
  { pattern: /useRtdSession/, why: "hook do caminho RTD" },
  { pattern: /CandleReconstructor/, why: "reconstrutor legado por amostragem" },
  { pattern: /\blive\.diagnostics\b/, why: "diagnóstico do motor legado" },
  { pattern: /t4-bridge/, why: "bridge local" },
  { pattern: /localhost:8765|127\.0\.0\.1:8765/, why: "porta da bridge" },
  { pattern: /BRIDGE_CONNECTED|RTD_CONNECTED/, why: "gates de dado do RTD" },
  { pattern: /Conectando na bridge/, why: "texto da escada de progresso do RTD" },
  { pattern: /@\/lib\/rtd\//, why: "módulo do caminho RTD" },
  { pattern: /@\/hooks\/useRtdSession|@\/hooks\/useLiveSession/, why: "import de hook legado" },
];

/**
 * Remove comentários antes de auditar.
 *
 * Um comentário que EXPLICA por que a bridge saiu é documentação do conserto —
 * apagar essa explicação para o teste passar seria trocar memória institucional
 * por verde. O que não pode existir é código que referencie o legado.
 */
function executableCode(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, found);
      continue;
    }
    if (/\.tsx?$/.test(entry)) found.push(full);
  }
  return found;
}

describe("pipeline único — o legado não existe no runtime", () => {
  const files = sourceFiles(ROOT).filter(
    // Este próprio arquivo cita os termos: é a lista do que é proibido.
    (file) => !file.endsWith("noLegacyPipeline.test.ts"),
  );

  it("encontra os arquivos-fonte para auditar", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  for (const { pattern, why } of FORBIDDEN) {
    it(`nenhum arquivo referencia ${pattern.source} (${why})`, () => {
      const offenders = files.filter((file) =>
        pattern.test(executableCode(readFileSync(file, "utf8"))),
      );
      expect(offenders.map((file) => file.replace(process.cwd(), ""))).toEqual([]);
    });
  }

  it("os módulos legados não existem mais no disco", () => {
    const gone = ["lib/rtd", "components/rtd", "hooks/useLiveSession.ts", "hooks/useRtdSession.ts"];
    for (const path of gone) {
      expect(() => statSync(join(ROOT, path))).toThrow();
    }
  });
});
