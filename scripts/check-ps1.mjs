/**
 * Verifica os scripts PowerShell do projeto contra dois defeitos que só
 * aparecem na máquina do operador, nunca no CI.
 *
 * 1. UTF-8 SEM BOM.
 *    O Windows PowerShell 5.1 — que é o que abre ao clicar com o botão direito
 *    em "Executar com o PowerShell" — lê arquivo sem BOM usando a página de
 *    código ANSI. Todo acento vira lixo. O caso que custou caro: o travessão
 *    `—` (E2 80 94 em UTF-8) é lido como `â€”`, e o terceiro byte 0x94 é `”`,
 *    ASPA TIPOGRÁFICA — que o PowerShell aceita como delimitador de string. A
 *    string fecha no meio da linha e o parser cascateia em erros que apontam
 *    para lugares onde não há nada errado.
 *
 * 2. SINTAXE EXCLUSIVA DO POWERSHELL 7.
 *    `?.`, `??`, `??=` e o ternário `? :` não existem no 5.1. O script parseia
 *    perfeitamente na máquina de quem escreveu e falha na de quem usa.
 *
 * Roda em Node puro, sem depender de ter PowerShell instalado — por isso vale
 * também no deploy da VPS, que é Linux. A validação com o parser de verdade
 * está em `npm run t4:ps-parse` (só Windows).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const IGNORED = new Set(["node_modules", "tools", ".output", ".git", ".t4run"]);

/** Operadores que o Windows PowerShell 5.1 não conhece. */
const PS7_ONLY = [
  { pattern: /\)\s*\?\./, name: "operador `?.` (null-conditional)" },
  { pattern: /\$\w+\s*\?\./, name: "operador `?.` (null-conditional)" },
  { pattern: /\?\?=/, name: "operador `??=`" },
  { pattern: /[^?]\?\?[^?]/, name: "operador `??` (null-coalescing)" },
];

function collectPs1(dir, found = []) {
  for (const entry of readdirSync(dir)) {
    if (IGNORED.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectPs1(full, found);
    else if (entry.toLowerCase().endsWith(".ps1")) found.push(full);
  }
  return found;
}

/** @returns {{file: string, problems: string[]}[]} */
export function checkPowerShellScripts(root = ROOT) {
  return collectPs1(root).map((file) => {
    const bytes = readFileSync(file);
    const problems = [];

    const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    const text = bytes.toString("utf8");
    const naoAscii = text.match(/[^\x00-\x7F]/g) ?? [];

    if (!hasBom && naoAscii.length > 0) {
      const amostra = [...new Set(naoAscii)].slice(0, 8).join(" ");
      problems.push(
        `UTF-8 sem BOM com ${naoAscii.length} caractere(s) não-ASCII (${amostra}). ` +
          `O PowerShell 5.1 vai ler como ANSI e corromper. Grave como UTF-8 com BOM.`,
      );
    }

    // Ignora o conteúdo de comentários de bloco: um `??` dentro de texto
    // explicativo não quebra nada.
    const semComentarios = text.replace(/<#[\s\S]*?#>/g, "").replace(/^\s*#.*$/gm, "");
    for (const { pattern, name } of PS7_ONLY) {
      if (pattern.test(semComentarios)) {
        problems.push(`usa ${name}, que não existe no Windows PowerShell 5.1`);
      }
    }

    return { file: relative(root, file), problems };
  });
}

// `file://C:/...` (montado à mão) nunca bate com `file:///C:/...` (o que o Node
// gera no Windows). pathToFileURL normaliza os dois lados.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const resultados = checkPowerShellScripts();
  let falhou = false;
  for (const { file, problems } of resultados) {
    if (problems.length === 0) {
      console.log(`  OK    ${file}`);
    } else {
      falhou = true;
      console.log(`  FALHA ${file}`);
      for (const problem of problems) console.log(`        ${problem}`);
    }
  }
  console.log(
    `\n${resultados.length} script(s) PowerShell verificado(s)${falhou ? " — com problema" : " — todos compatíveis com 5.1 e 7"}.`,
  );
  process.exit(falhou ? 1 : 0);
}
