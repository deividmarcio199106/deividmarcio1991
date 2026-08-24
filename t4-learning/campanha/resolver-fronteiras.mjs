/**
 * RESOLVE AS FRONTEIRAS PELA SEQUENCIA DE DATAS — offline, sem GPU nova.
 *
 * O QUE OS VOTOS ENSINARAM (22/08, marco): na fronteira verdadeira a data lida
 * e a do dia VELHO (a tela ainda mostra ele); no meio do dia, a do dia
 * CORRENTE. Entao a fronteira real fica ENTRE dois candidatos consecutivos com
 * datas validas DIFERENTES — e dentro desse intervalo, o candidato certo e o
 * de maior evidencia (votos de reset de horario, depois tamanho do gap).
 * Datas fora de sequencia (08/ago da marca d'agua, 05/mar no meio de 12/mar)
 * sao lixo de leitura e caem pelo filtro de monotonicidade.
 *
 * Uso: node t4-learning/campanha/resolver-fronteiras.mjs [video]
 */
import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";

const RAIZ = "t4-learning";
const VIDEO = process.argv[2] ?? "marco";
const MESES = {
  jan: 1,
  fev: 2,
  mar: 3,
  abr: 4,
  mai: 5,
  jun: 6,
  jul: 7,
  ago: 8,
  set: 9,
  out: 10,
  nov: 11,
  dez: 12,
};
const DATA_RE = /\b(\d{1,2})\s*[\/\- ]\s*(jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)\b/i;

const atual = JSON.parse(
  readFileSync(`${RAIZ}/dataset/${VIDEO}/day-boundaries-frozen.json`, "utf8"),
);
const varredura = JSON.parse(readFileSync(`${RAIZ}/dataset/${VIDEO}/varredura-mes.json`, "utf8"));
const pontos = varredura.pontos.filter((p) => p.preco !== null);

function gapEm(seg) {
  for (let i = 1; i < pontos.length; i++) {
    if (Math.abs(pontos[i].segundoNoVideo - seg) < 0.06) {
      return pontos[i].preco - pontos[i - 1].preco;
    }
  }
  return 0;
}

/** Todas as datas lidas num candidato, como numero ordenavel (mes*100+dia). */
function datasDoCandidato(f) {
  const datas = [];
  for (const prova of f.provas ?? []) {
    const bruto = prova?.leitura?.dataVisivel;
    if (typeof bruto !== "string") continue;
    const m = bruto.match(DATA_RE);
    if (m === null) continue;
    // Dia juliano de 2026 — a virada de mes (27/fev -> 02/mar) precisa contar 3 dias, nao 75.
    datas.push(
      Math.round(Date.UTC(2026, MESES[m[2].toLowerCase()] - 1, Number(m[1])) / 86_400_000),
    );
  }
  return datas;
}

/*
 * 1. SEQUENCIA MONOTONICA DE DATAS. Caminha pelos candidatos estabelecendo a
 *    data corrente; leitura que regride ou salta demais (>7 dias) e lixo.
 */
const candidatos = [...atual.fronteiras].sort((a, b) => a.seg - b.seg);
let corrente = null;
const anotados = candidatos.map((f) => {
  const votosVirada = (f.votos ?? []).filter((v) => v === "VIRADA").length;
  let data = null;
  for (const d of datasDoCandidato(f)) {
    if (corrente === null || (d >= corrente && d - corrente <= 7)) {
      data = d;
      corrente = d;
      break;
    }
  }
  return { seg: f.seg, votosVirada, data, gap: gapEm(f.seg) };
});

/*
 * 2. UMA FRONTEIRA POR PAR DE DATAS DISTINTAS. Entre o ultimo candidato com a
 *    data d1 e o primeiro com d2>d1 existe exatamente uma virada de pregao; o
 *    candidato eleito e o de maior evidencia no intervalo (s1, s2].
 */
const comData = anotados.filter((a) => a.data !== null);
const fronteirasEleitas = [];
for (let i = 1; i < comData.length; i++) {
  const a = comData[i - 1];
  const b = comData[i];
  if (b.data === a.data) continue;
  const intervalo = anotados.filter((c) => c.seg > a.seg && c.seg <= b.seg);
  intervalo.sort(
    (x, y) =>
      2 * y.votosVirada + Math.abs(y.gap) / 1000 - (2 * x.votosVirada + Math.abs(x.gap) / 1000),
  );
  const eleito = intervalo[0];
  if (eleito !== undefined) {
    fronteirasEleitas.push({ seg: eleito.seg, dataQueTermina: a.data, dataQueComeca: b.data });
  }
}

/* 3. DIAS: cada um rotulado pela data que COMECA na sua fronteira de abertura. */
const info = { duracaoSeg: varredura.resumo.fimSeg ?? pontos[pontos.length - 1].segundoNoVideo };
const inicios = [{ seg: 0, data: fronteirasEleitas[0]?.dataQueTermina ?? null }].concat(
  fronteirasEleitas.map((f) => ({ seg: f.seg, data: f.dataQueComeca })),
);
const dias = inicios.map((ini, i) => {
  const fim = i + 1 < inicios.length ? inicios[i + 1].seg : info.duracaoSeg;
  let rotulo = null;
  if (ini.data !== null) {
    const dt = new Date(ini.data * 86_400_000);
    rotulo = `${String(dt.getUTCDate()).padStart(2, "0")}/${Object.keys(MESES).find((k) => MESES[k] === dt.getUTCMonth() + 1)}`;
  }
  const duracao = fim - ini.seg;
  return {
    videoId: `${VIDEO}.mp4`,
    dayId: i + 1,
    data: rotulo,
    startTimestamp: ini.seg,
    endTimestamp: fim,
    frameInicial: Math.round(ini.seg * 10),
    frameFinal: Math.round(fim * 10),
    // Dia com duracao absurda (fusao) ou sem data: isolado como AMBIGUOUS.
    estado: duracao > 90 || duracao < 20 || rotulo === null ? "AMBIGUOUS" : "CONFIRMED",
    confidence: rotulo === null ? 0.3 : 0.9,
  };
});

/* 4. VALIDACAO DECLARADA antes de congelar. */
const confirmados = dias.filter((d) => d.estado === "CONFIRMED");
console.log(
  `candidatos=${candidatos.length} comDataValida=${comData.length} fronteirasEleitas=${fronteirasEleitas.length}`,
);
console.log(
  `DIAS=${dias.length} confirmados=${confirmados.length} ambiguos=${dias.length - confirmados.length}`,
);
for (const d of dias) {
  console.log(
    `  dia ${String(d.dayId).padStart(2)} ${String(d.data ?? "????").padEnd(7)} ${String(d.startTimestamp.toFixed(0)).padStart(5)}-${String(d.endTimestamp.toFixed(0)).padStart(5)}s (${(d.endTimestamp - d.startTimestamp).toFixed(0)}s) ${d.estado}`,
  );
}
if (dias.length < 15 || dias.length > 25) {
  console.error(`REPROVADO: ${dias.length} dias fora da faixa plausivel [15..25] — nao congela.`);
  process.exit(1);
}

/* 5. Congela v3, arquivando a v2. */
renameSync(
  `${RAIZ}/dataset/${VIDEO}/day-boundaries-frozen.json`,
  `${RAIZ}/dataset/${VIDEO}/day-boundaries-v2-descartado.json`,
);
writeFileSync(
  `${RAIZ}/dataset/${VIDEO}/day-boundaries-frozen.json`,
  JSON.stringify(
    {
      video: `${VIDEO}.mp4`,
      criadoEm: new Date().toISOString(),
      metodo:
        "v3: sequencia monotonica de DATAS lidas nas provas da v2 (na fronteira le-se a data do dia velho; no meio, a do corrente); fronteira eleita no intervalo entre datas distintas pelo maior placar 2xvotosReset + |gap|/1000; dias >90s ou <20s ou sem data = AMBIGUOUS",
      fonteDasProvas: "day-boundaries-v2-descartado.json (nenhuma leitura nova de GPU)",
      fronteiras: atual.fronteiras,
      fronteirasEleitas,
      dias,
    },
    null,
    1,
  ),
  "utf8",
);
console.log("CONGELADO v3");
