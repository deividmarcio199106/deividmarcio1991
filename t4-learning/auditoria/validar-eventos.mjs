/**
 * CORRECAO FINAL DE INTEGRIDADE de um lote de eventos observados.
 *
 * Nao reanalisa video, nao cria evento, nao inventa valor. Faz cinco coisas
 * mecanicas e declaradas, todas registradas no relatorio:
 *   1. repara sintaxe (sim/nao soltos -> true/false, virgula sobrando);
 *   2. remove variavel NAO OBSERVAVEL (pressao oculta, intencao institucional,
 *      forca escondida, absorcao, exaustao) — o que nao se ve no print sai;
 *   3. remove conclusao retrospectiva (falso rompimento, falha, tende a
 *      reverter, alta probabilidade, regra vencedora) e normaliza o resultado
 *      para o enum MOVIMENTO_POSTERIOR_*;
 *   4. uniformiza o schema — chave ausente vira null (ausencia declarada);
 *   5. revalida o JSON e imprime as travas.
 *
 * Uso: node t4-learning/auditoria/validar-eventos.mjs <entrada.json> [saida.json]
 */
import { readFileSync, writeFileSync } from "node:fs";

const entrada = process.argv[2];
if (entrada === undefined) {
  console.error("uso: node t4-learning/auditoria/validar-eventos.mjs <entrada.json> [saida.json]");
  process.exit(2);
}
const saida = process.argv[3] ?? entrada.replace(/\.json$/i, "") + "-CORRIGIDO.json";

const inconsistencias = [];
const anotar = (tipo, onde, detalhe) => inconsistencias.push({ tipo, onde, detalhe });

/* 1. REPARO SINTATICO */
let bruto = readFileSync(entrada, "utf8");
const reparos = [
  [/:\s*sim\s*([,}\]])/gi, ": true$1", "valor `sim` -> true"],
  [/:\s*nao\s*([,}\]])/gi, ": false$1", "valor `nao` -> false"],
  [/:\s*não\s*([,}\]])/gi, ": false$1", "valor `nao` acentuado -> false"],
  [/,(\s*[}\]])/g, "$1", "virgula sobrando antes de fechar"],
];
for (const [re, sub, nome] of reparos) {
  const achados = bruto.match(re);
  if (achados !== null) {
    bruto = bruto.replace(re, sub);
    anotar("SINTAXE", "arquivo", `${nome} (${achados.length} ocorrencia(s))`);
  }
}
let doc;
try {
  doc = JSON.parse(bruto);
} catch (erro) {
  console.error(`JSON continua invalido apos reparo: ${erro.message}`);
  process.exit(1);
}

let eventos = null;
let chave = null;
if (Array.isArray(doc)) {
  eventos = doc;
} else {
  for (const [k, v] of Object.entries(doc)) {
    if (Array.isArray(v) && v.every((e) => e !== null && typeof e === "object")) {
      eventos = v;
      chave = k;
      break;
    }
  }
}
if (eventos === null) {
  console.error("nao achei um array de eventos no arquivo");
  process.exit(1);
}

/* 2 e 3. LISTAS DE CORTE */
const NAO_OBSERVAVEL = [
  "pressao",
  "pressão",
  "oculta",
  "oculto",
  "intencao",
  "intenção",
  "institucional",
  "forca escondida",
  "força escondida",
  "smart money",
  "agressor",
  "absorcao",
  "absorção",
  "manipulacao",
  "manipulação",
  "exaustao",
  "exaustão",
];
const RETROSPECTIVO = [
  "falso rompimento",
  "falhou",
  "falha",
  "tende a reverter",
  "tendencia a reverter",
  "alta probabilidade",
  "provavel",
  "provável",
  "regra vencedora",
  "deu certo",
  "deu errado",
  "taxa de acerto",
];
const ENUM = {
  FAVORAVEL: "MOVIMENTO_POSTERIOR_FAVORAVEL",
  CONTRARIO: "MOVIMENTO_POSTERIOR_CONTRARIO",
  LATERAL: "MOVIMENTO_POSTERIOR_LATERAL",
  INDETERMINADO: "MOVIMENTO_POSTERIOR_INDETERMINADO",
};
const semAcento = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const contem = (lista, texto) => lista.some((t) => semAcento(texto).includes(semAcento(t)));

function normalizarMovimento(valor) {
  // Valor ja no enum canonico entra sem ser reescrito — so o sufixo importa.
  const s = semAcento(String(valor)).replace(/^movimento_posterior_/, "");
  if (s.startsWith("favoravel")) return ENUM.FAVORAVEL;
  if (s.startsWith("contrario")) return ENUM.CONTRARIO;
  if (s.includes("lateral")) return ENUM.LATERAL;
  if (s.includes("indetermin")) return ENUM.INDETERMINADO;
  return null;
}

function limpar(no, caminho) {
  if (no === null || typeof no !== "object") return no;
  if (Array.isArray(no)) return no.map((x, i) => limpar(x, `${caminho}[${i}]`));
  const out = {};
  for (const [k, v] of Object.entries(no)) {
    const onde = caminho === "" ? k : `${caminho}.${k}`;
    if (contem(NAO_OBSERVAVEL, k)) {
      anotar("NAO_OBSERVAVEL", onde, `chave removida (valor era ${JSON.stringify(v)})`);
      continue;
    }
    if (k === "movimentoPosterior" && typeof v === "string") {
      const e = normalizarMovimento(v);
      if (e === null) {
        anotar("ENUM", onde, `"${v}" nao mapeia -> ${ENUM.INDETERMINADO}`);
        out[k] = ENUM.INDETERMINADO;
      } else {
        if (e !== v) anotar("ENUM", onde, `"${v}" -> ${e}`);
        out[k] = e;
      }
      continue;
    }
    if (typeof v === "string") {
      if (contem(NAO_OBSERVAVEL, v)) {
        anotar("NAO_OBSERVAVEL", onde, `chave removida por conteudo: "${v}"`);
        continue;
      }
      if (contem(RETROSPECTIVO, v)) {
        anotar("RETROSPECTIVO", onde, `chave removida por conclusao retrospectiva: "${v}"`);
        continue;
      }
      out[k] = v;
      continue;
    }
    out[k] = limpar(v, onde);
  }
  return out;
}

const limpos = eventos.map((e, i) => limpar(e, `evento[${i}]`));

/* 4. SCHEMA UNIFORME */
function caminhos(no, prefixo, mapa) {
  if (no === null || typeof no !== "object" || Array.isArray(no)) {
    mapa.set(prefixo, no === null ? "null" : Array.isArray(no) ? "array" : typeof no);
    return mapa;
  }
  for (const [k, v] of Object.entries(no))
    caminhos(v, prefixo === "" ? k : `${prefixo}.${k}`, mapa);
  return mapa;
}
const mapas = limpos.map((e) => caminhos(e, "", new Map()));
const uniao = new Map();
for (const m of mapas) {
  for (const [c, t] of m) {
    if (t === "null") continue;
    if (!uniao.has(c)) uniao.set(c, t);
    else if (uniao.get(c) !== t) uniao.set(c, "MISTO");
  }
}
function definir(obj, caminho, valor) {
  const p = caminho.split(".");
  let cur = obj;
  for (let i = 0; i < p.length - 1; i++) {
    if (cur[p[i]] === undefined || cur[p[i]] === null || typeof cur[p[i]] !== "object")
      cur[p[i]] = {};
    cur = cur[p[i]];
  }
  if (cur[p[p.length - 1]] === undefined) cur[p[p.length - 1]] = valor;
}
for (let i = 0; i < limpos.length; i++) {
  for (const [c, t] of uniao) {
    if (!mapas[i].has(c)) {
      anotar("SCHEMA", `evento[${i}].${c}`, "chave ausente -> null (ausencia declarada)");
      definir(limpos[i], c, null);
    } else if (t !== "MISTO" && mapas[i].get(c) !== t && mapas[i].get(c) !== "null") {
      anotar("SCHEMA", `evento[${i}].${c}`, `tipo ${mapas[i].get(c)} difere do dominante ${t}`);
    }
  }
}

/* COERENCIA INTERNA — contradicoes que nao se corrigem sozinhas, so se declaram. */
for (let i = 0; i < limpos.length; i++) {
  const e = limpos[i];
  const st = e?.evidencia?.precoComprovado?.status ?? null;
  const q = e?.atributosPreEvento?.qualidadeEvidencia ?? null;
  if (st === "ILEGIVEL" && q === "ALTA") {
    anotar(
      "COERENCIA",
      `evento[${i}]`,
      "qualidadeEvidencia=ALTA com precoComprovado ILEGIVEL — qualidade e derivada, nao observada",
    );
  }
  if (e?.horaGrafico !== null && e?.evidencia?.horaComprovada === null) {
    anotar(
      "COERENCIA",
      `evento[${i}]`,
      `horaGrafico="${e.horaGrafico}" preenchida mas horaComprovada=null`,
    );
  }
}

const finalDoc = chave === null ? limpos : { ...doc, [chave]: limpos };
const texto = JSON.stringify(finalDoc, null, 1);
let sintaxeOk = true;
try {
  JSON.parse(texto);
} catch {
  sintaxeOk = false;
}
const mapasFinais = limpos.map((e) => caminhos(e, "", new Map()));
const schemaValido =
  mapasFinais.length > 0 &&
  mapasFinais.every(
    (m) => m.size === mapasFinais[0].size && [...mapasFinais[0].keys()].every((c) => m.has(c)),
  );
const corpo = JSON.stringify(limpos);
const vazamentos = RETROSPECTIVO.filter((t) => semAcento(corpo).includes(semAcento(t)));
const naoObservaveis = NAO_OBSERVAVEL.filter((t) => semAcento(corpo).includes(semAcento(t)));

writeFileSync(saida, texto, "utf8");

console.log("=== INCONSISTENCIAS CORRIGIDAS ===");
if (inconsistencias.length === 0) console.log("  (nenhuma)");
for (const i of inconsistencias) console.log(`  [${i.tipo}] ${i.onde}: ${i.detalhe}`);
console.log("");
console.log(`JSON_GLOBAL_FINAL_VALIDO=${saida}`);
console.log(`SINTAXE_VALIDA=${sintaxeOk}`);
console.log(`SCHEMA_VALIDO=${schemaValido}`);
console.log(`EVENTOS_PRESENTES=${limpos.length}`);
console.log(`15_EVENTOS_PRESENTES=${limpos.length === 15}`);
console.log(
  `SEM_VAZAMENTO_RETROSPECTIVO=${vazamentos.length === 0}${vazamentos.length ? ` (residuo: ${vazamentos.join(", ")})` : ""}`,
);
console.log(
  `SEM_VARIAVEL_NAO_OBSERVAVEL=${naoObservaveis.length === 0}${naoObservaveis.length ? ` (residuo: ${naoObservaveis.join(", ")})` : ""}`,
);
