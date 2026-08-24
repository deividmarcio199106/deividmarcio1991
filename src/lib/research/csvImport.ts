/**
 * IMPORTADOR DE CSV DE CANDLES — exports do Profit/Nelogica (roteiro §25).
 *
 * PURO por contrato: recebe o TEXTO já lido, nunca toca arquivo, relógio ou
 * rede — quem faz IO é o chamador. Tolerante por decisão: linha inválida é
 * DESCARTADA e CONTADA em `problems` (silêncio esconderia furo na série;
 * abortar o arquivo inteiro jogaria fora um pregão por causa de uma linha
 * podre). O que este módulo NUNCA faz é adivinhar: cabeçalho irreconhecível
 * ou campo ilegível não vira valor inventado — vira problema declarado.
 */
import type { Candle } from "../engines/types";

type ColumnKey = "timestamp" | "date" | "time" | "open" | "high" | "low" | "close" | "volume";

/**
 * Nomes aceitos por coluna, já normalizados (minúsculas, sem acento, só
 * letras). Cobre os exports PT (Profit/Nelogica) e EN. Match é EXATO de
 * propósito: "abertura_ajustada" não pode virar "abertura" em silêncio.
 *
 * `timestamp` é o campo ÚNICO (epoch ms/s ou ISO). Note que "time" NÃO entra
 * nos aliases dele: em export com `date`+`time`, "time" é a HORA, e confundir
 * os dois trocaria a grade do pregão inteiro por um número sem sentido.
 */
const HEADER_ALIASES: Record<ColumnKey, readonly string[]> = {
  timestamp: ["timestamp", "datetime", "datahora", "epoch", "epochms", "unix", "unixtime"],
  date: ["data", "date", "dia"],
  time: ["hora", "time", "horario"],
  open: ["abertura", "abert", "open"],
  high: ["maxima", "maximo", "max", "high"],
  low: ["minima", "minimo", "min", "low"],
  close: ["fechamento", "fech", "close", "ultimo", "last"],
  volume: ["volume", "vol", "qtd", "quantidade"],
};

/**
 * Colunas sem as quais não existe candle. O instante entra por UM dos dois
 * caminhos — `timestamp` único OU `date` (+ `time` opcional) — e a exigência é
 * "pelo menos um deles", conferida à parte.
 */
const REQUIRED_PRICE_COLUMNS: readonly ColumnKey[] = ["open", "high", "low", "close"];

const PT_HEADERS = new Set([
  "data",
  "hora",
  "horario",
  "datahora",
  "abertura",
  "abert",
  "maxima",
  "maximo",
  "minima",
  "minimo",
  "fechamento",
  "fech",
  "ultimo",
  "qtd",
  "quantidade",
  "dia",
]);
const EN_HEADERS = new Set([
  "date",
  "time",
  "timestamp",
  "datetime",
  "epoch",
  "open",
  "high",
  "low",
  "close",
  "last",
  "max",
  "min",
  "vol",
]);

/**
 * Teto de problemas DETALHADOS. Um arquivo com 1 milhão de linhas podres não
 * pode virar 1 milhão de strings — mas a CONTAGEM total nunca é omitida:
 * a última entrada declara quantos ficaram fora do detalhe.
 */
const MAX_PROBLEM_DETAILS = 50;

/** Minúsculas, sem acento, só letras — para casar cabeçalho PT/EN. */
function normalizeHeaderCell(cell: string): string {
  return (
    cell
      .normalize("NFD")
      // Faixa dos diacríticos combinantes em escape explícito: acento nunca
      // pode depender do encoding do editor que salvou este arquivo.
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z]/g, "")
  );
}

/**
 * Detecta o separador pelo CABEÇALHO — é a única linha garantidamente sem
 * vírgula decimal, então a contagem não se contamina. Empate resolve por
 * prioridade `;` > tab > `,` (ponto e vírgula é o export BR típico).
 */
function detectSeparator(headerLine: string): ";" | "\t" | "," | null {
  const counts: Array<{ sep: ";" | "\t" | ","; n: number }> = [
    { sep: ";", n: headerLine.split(";").length - 1 },
    { sep: "\t", n: headerLine.split("\t").length - 1 },
    { sep: ",", n: headerLine.split(",").length - 1 },
  ];
  counts.sort((a, b) => b.n - a.n);
  return counts[0]!.n > 0 ? counts[0]!.sep : null;
}

/**
 * Converte campo numérico respeitando o decimal detectado. Regex primeiro:
 * `Number("12abc")` seria NaN de qualquer forma, mas "1.2.3" e "1,2,3"
 * precisam ser recusados EXPLICITAMENTE, não maquiados.
 * BR: "128.450,50" (milhar com ponto) e "0,5"; EN: "128,450.50" e "0.5".
 */
function parseNumber(raw: string, decimal: "," | "."): number {
  const cleaned = raw.trim().replace(/^"(.*)"$/, "$1");
  if (cleaned === "") return NaN;
  const pattern =
    decimal === "," ? /^-?(\d{1,3}(\.\d{3})+|\d+)(,\d+)?$/ : /^-?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/;
  if (!pattern.test(cleaned)) return NaN;
  const normalized =
    decimal === "," ? cleaned.replace(/\./g, "").replace(",", ".") : cleaned.replace(/,/g, "");
  return Number(normalized);
}

/**
 * Data dd/MM/yyyy ou yyyy-MM-dd + hora HH:mm(:ss) → timestamp em ms.
 *
 * UTC de propósito: o fuso da MÁQUINA que importa não pode mudar o timestamp
 * do pregão (mesma lição do `dayKey()` da auditoria — grade ancorada em
 * relógio local diverge entre caminhos). Data inexistente (31/02) é recusada
 * pelo round-trip, não "corrigida" pelo Date.
 */
function parseTimestamp(dateRaw: string, timeRaw: string): number | null {
  const dateField = dateRaw.trim().replace(/^"(.*)"$/, "$1");
  let datePart = dateField;
  let timePart = timeRaw.trim().replace(/^"(.*)"$/, "$1");
  // Data com hora embutida ("18/03/2026 09:00") vale quando não há coluna Hora.
  const spaceIdx = dateField.indexOf(" ");
  if (spaceIdx > 0 && timePart === "") {
    datePart = dateField.slice(0, spaceIdx);
    timePart = dateField.slice(spaceIdx + 1).trim();
  }

  let y: number;
  let mo: number;
  let d: number;
  const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(datePart);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(datePart);
  if (br) {
    d = Number(br[1]);
    mo = Number(br[2]);
    y = Number(br[3]);
  } else if (iso) {
    y = Number(iso[1]);
    mo = Number(iso[2]);
    d = Number(iso[3]);
  } else {
    return null;
  }

  let hh = 0;
  let mi = 0;
  let ss = 0;
  if (timePart !== "") {
    const tm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(timePart);
    if (!tm) return null;
    hh = Number(tm[1]);
    mi = Number(tm[2]);
    ss = tm[3] ? Number(tm[3]) : 0;
  }

  if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mi > 59 || ss > 59) return null;
  const t = Date.UTC(y, mo - 1, d, hh, mi, ss);
  const check = new Date(t);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
    return null;
  }
  return t;
}

/**
 * De onde veio a informação de fuso do instante lido.
 *
 * Existe porque timestamp sem fuso NÃO é um instante: é um relógio de parede.
 * O importador nunca resolve essa ambiguidade em silêncio — ele a DECLARA.
 */
type TzKind = "EPOCH" | "UTC" | "OFFSET" | "SEM_DECLARACAO";

interface Instant {
  t: number;
  tz: TzKind;
  /** Offset como veio no arquivo (ex.: "-03:00"). Só existe em `tz: "OFFSET"`. */
  offset?: string;
}

/** Abaixo disto (≈2001-09-09) um "epoch em segundos" é chute, não dado. */
const MIN_EPOCH_SECONDS = 1_000_000_000;
/** A partir daqui (≈2001-09-09 em ms) o número só pode ser milissegundos. */
const MIN_EPOCH_MILLIS = 1_000_000_000_000;

/**
 * Campo ÚNICO de instante: epoch (ms ou s) ou ISO 8601 com/sem offset.
 *
 * - epoch: a faixa decide a unidade; número fora das duas faixas é RECUSADO em
 *   vez de multiplicado no chute (um "1234" viraria 1970 e ninguém veria);
 * - ISO com `Z` ou `±hh:mm`: convertido para o instante absoluto e o offset
 *   assumido fica declarado no relatório;
 * - ISO sem offset: aceito como relógio de parede do arquivo, e o relatório diz
 *   exatamente isso — nunca se inventa o fuso da máquina que importou.
 *
 * Devolve null quando o campo não é nenhum dos dois (o chamador ainda tenta o
 * caminho data+hora antes de descartar a linha).
 */
function parseInstantField(raw: string): Instant | null {
  const cleaned = raw.trim().replace(/^"(.*)"$/, "$1");
  if (cleaned === "") return null;

  if (/^\d+$/.test(cleaned)) {
    const n = Number(cleaned);
    if (!Number.isFinite(n)) return null;
    if (n >= MIN_EPOCH_MILLIS) return { t: n, tz: "EPOCH" };
    if (n >= MIN_EPOCH_SECONDS) return { t: n * 1000, tz: "EPOCH" };
    return null;
  }

  const iso =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(Z|z|[+-]\d{2}:?\d{2})?$/.exec(
      cleaned,
    );
  if (!iso) return null;

  const y = Number(iso[1]);
  const mo = Number(iso[2]);
  const d = Number(iso[3]);
  const hh = Number(iso[4]);
  const mi = Number(iso[5]);
  const ss = iso[6] ? Number(iso[6]) : 0;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mi > 59 || ss > 59) return null;

  const base = Date.UTC(y, mo - 1, d, hh, mi, ss);
  const check = new Date(base);
  // Data inexistente (31/02) é recusada pelo round-trip, não "corrigida".
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
    return null;
  }

  const zone = iso[7];
  if (zone === undefined) return { t: base, tz: "SEM_DECLARACAO" };
  if (zone === "Z" || zone === "z") return { t: base, tz: "UTC" };

  const sign = zone.startsWith("-") ? -1 : 1;
  const semSinal = zone.slice(1).replace(":", "");
  const offHoras = Number(semSinal.slice(0, 2));
  const offMin = Number(semSinal.slice(2, 4));
  if (!Number.isFinite(offHoras) || !Number.isFinite(offMin) || offHoras > 14 || offMin > 59) {
    return null;
  }
  const offsetMinutos = sign * (offHoras * 60 + offMin);
  const label = `${sign < 0 ? "-" : "+"}${String(offHoras).padStart(2, "0")}:${String(offMin).padStart(2, "0")}`;
  // Instante absoluto = relógio de parede menos o offset declarado.
  return { t: base - offsetMinutos * 60_000, tz: "OFFSET", offset: label };
}

/** yyyy-mm-dd do instante, na MESMA grade em que o timestamp foi gravado. */
function utcDateKey(t: number): string {
  const d = new Date(t);
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dia = String(d.getUTCDate()).padStart(2, "0");
  return `${d.getUTCFullYear()}-${mo}-${dia}`;
}

/**
 * RELATÓRIO DE QUALIDADE DO DATASET — o que entrou, o que ficou de fora e por
 * quê. Existe porque "1.000 candles importados" não diz se o pregão está
 * inteiro, se o arquivo veio fora de ordem ou em que fuso os horários estão.
 */
export interface DatasetQuality {
  /** Linhas de dados lidas (sem cabeçalho e sem linhas em branco). */
  linhasLidas: number;
  /** Candles que sobreviveram a todas as validações. */
  linhasAproveitadas: number;
  /**
   * Descartes por MOTIVO — a soma bate com `linhasLidas - linhasAproveitadas`.
   * Nada some em silêncio.
   */
  descartadas: Record<string, number>;
  /** Primeiro e último instante aproveitados. null = nenhum candle. */
  periodo: { inicio: number; fim: number; inicioIso: string; fimIso: string } | null;
  /** Pregões distintos na grade do próprio arquivo. */
  pregoes: number;
  /**
   * O arquivo veio fora de ordem? Reordenar é PERMITIDO (o backtest exige
   * ordem cronológica), mas nunca calado.
   */
  reordenacao: { aplicada: boolean; linhasForaDeOrdem: number };
  /** Timestamps repetidos: a primeira ocorrência vence, as demais caem. */
  duplicatas: number;
  /** Intervalo dominante entre candles consecutivos (moda dos deltas). */
  intervaloBaseMs: number | null;
  /**
   * GAP NÃO É ERRO NO WIN: leilão, pausa e baixa liquidez produzem buracos
   * legítimos. Aqui eles são CONTADOS e reportados, nunca "corrigidos".
   * `entrePregoes` separa a virada de dia, que não é gap coisa nenhuma.
   */
  gaps: { total: number; maiorMs: number; entrePregoes: number };
  /** Fuso assumido, sempre declarado — inclusive quando não havia informação. */
  timezone: { assumido: string; detalhe: string };
}

/** Motivos canônicos de descarte — chaves estáveis para painel e log. */
const MOTIVO = {
  COLUNAS: "colunas_insuficientes",
  DATA: "data_hora_ilegivel",
  OHLC: "ohlc_nao_numerico",
  MAX_MIN: "maxima_menor_que_minima",
  FORA_INTERVALO: "abertura_fechamento_fora_do_intervalo",
  PRECO: "preco_nao_positivo",
  VOLUME_NEGATIVO: "volume_negativo",
  DUPLICADO: "timestamp_duplicado",
} as const;

function emptyQuality(motivo: string, detalhe: string): DatasetQuality {
  return {
    linhasLidas: 0,
    linhasAproveitadas: 0,
    descartadas: {},
    periodo: null,
    pregoes: 0,
    reordenacao: { aplicada: false, linhasForaDeOrdem: 0 },
    duplicatas: 0,
    intervaloBaseMs: null,
    gaps: { total: 0, maiorMs: 0, entrePregoes: 0 },
    timezone: { assumido: motivo, detalhe },
  };
}

/**
 * Parser tolerante de CSV de candles exportado do Profit/Nelogica.
 *
 * - separador (`;`, tab, `,`) e decimal (vírgula BR / ponto) detectados pela
 *   amostra — nunca configurados na fé;
 * - cabeçalho PT/EN obrigatório; sem ele NÃO se adivinha ordem de colunas
 *   (mapear na sorte é inventar dado);
 * - instante por `timestamp` único (epoch ms/s ou ISO, com ou sem offset) OU
 *   por `date` (+ `time`); offset declarado é NORMALIZADO e dito no relatório,
 *   ausência de fuso também é DITA — nunca resolvida em silêncio;
 * - linha inválida (data ilegível, OHLC não numérico, máxima < mínima, OHLC
 *   fora de [low, high], preço <= 0, volume negativo, colunas faltando) é
 *   descartada E contada POR MOTIVO em `quality.descartadas`;
 * - timestamp duplicado mantém a PRIMEIRA ocorrência e conta problema;
 * - saída sempre ordenada por `t` crescente; se o arquivo veio fora de ordem, a
 *   reordenação é declarada em `quality.reordenacao` (com quantas linhas);
 * - GAPS são contados e reportados, NUNCA tratados como erro: leilão, pausa e
 *   baixa liquidez produzem buraco legítimo no WIN;
 * - volume ausente/ilegível vira 0 — convenção do tipo `Candle` para volume
 *   desconhecido (a captura visual usa o mesmo 0) — e ilegível CONTA problema.
 */
export function parseCandlesCsvDetailed(text: string): {
  candles: Candle[];
  problems: string[];
  format: string;
  quality: DatasetQuality;
} {
  const problems: string[] = [];
  let omittedProblems = 0;
  const pushProblem = (msg: string): void => {
    if (problems.length < MAX_PROBLEM_DETAILS) problems.push(msg);
    else omittedProblems += 1;
  };
  /** Descartes por motivo canônico — contagem SEMPRE preservada, sem teto. */
  const descartadas: Record<string, number> = {};
  const descartar = (motivo: string, msg: string): void => {
    descartadas[motivo] = (descartadas[motivo] ?? 0) + 1;
    pushProblem(msg);
  };
  const finish = (candles: Candle[], format: string, quality: DatasetQuality) => {
    if (omittedProblems > 0) {
      problems.push(
        `+${omittedProblems} problema(s) adicionais omitidos do detalhe (contagem preservada)`,
      );
    }
    return { candles, problems, format, quality };
  };

  const entries = text
    .split(/\r\n|\r|\n/)
    .map((raw, i) => ({ raw, lineNo: i + 1 }))
    .filter((e) => e.raw.trim() !== "");

  if (entries.length === 0) {
    pushProblem("arquivo vazio — nenhuma linha para importar");
    return finish([], "DESCONHECIDO", emptyQuality("N/D", "arquivo vazio — nada a assumir"));
  }

  const headerEntry = entries[0]!;
  const sep = detectSeparator(headerEntry.raw);
  if (sep === null) {
    pushProblem(
      `linha ${headerEntry.lineNo}: separador não identificado (esperado ';', tab ou ',')`,
    );
    return finish(
      [],
      "DESCONHECIDO",
      emptyQuality("N/D", "separador não identificado — arquivo não foi lido"),
    );
  }

  // ---- Mapeamento do cabeçalho -------------------------------------------
  const headerCells = headerEntry.raw.split(sep).map(normalizeHeaderCell);
  const columns: Partial<Record<ColumnKey, number>> = {};
  let ptHits = 0;
  let enHits = 0;
  headerCells.forEach((cell, idx) => {
    for (const key of Object.keys(HEADER_ALIASES) as ColumnKey[]) {
      // Primeira coluna que casa vence; repetição do mesmo nome não sobrescreve.
      if (HEADER_ALIASES[key].includes(cell) && columns[key] === undefined) {
        columns[key] = idx;
      }
    }
    if (PT_HEADERS.has(cell)) ptHits += 1;
    else if (EN_HEADERS.has(cell)) enHits += 1;
  });

  // O instante entra por `timestamp` único OU por `date` (+ `time`). Sem
  // nenhum dos dois não existe candle — e adivinhar qual coluna é a data seria
  // inventar dado.
  const missing: string[] = [];
  if (columns.timestamp === undefined && columns.date === undefined) {
    missing.push("timestamp OU date");
  }
  for (const key of REQUIRED_PRICE_COLUMNS) {
    if (columns[key] === undefined) missing.push(key);
  }
  if (missing.length > 0) {
    pushProblem(
      `linha ${headerEntry.lineNo}: cabeçalho não reconhecido — faltam colunas [${missing.join(", ")}]; ` +
        "sem cabeçalho PT/EN o importador NÃO adivinha a ordem das colunas",
    );
    return finish(
      [],
      "DESCONHECIDO",
      emptyQuality("N/D", "cabeçalho não reconhecido — arquivo não foi lido"),
    );
  }

  const headerLang =
    ptHits > 0 && enHits === 0 ? "PT" : enHits > 0 && ptHits === 0 ? "EN" : "MISTO";
  const dataEntries = entries.slice(1);
  if (dataEntries.length === 0) {
    pushProblem("nenhuma linha de dados após o cabeçalho");
    return finish(
      [],
      "DESCONHECIDO",
      emptyQuality("N/D", "nenhuma linha de dados após o cabeçalho"),
    );
  }

  // ---- Detecção do decimal pela amostra ----------------------------------
  // Só colunas de PREÇO votam: volume costuma ser inteiro e não diz nada.
  // Separador vírgula FORÇA decimal ponto: vírgula decimal dentro de campo
  // separado por vírgula quebraria as colunas antes de chegar aqui.
  let decimal: "," | ".";
  if (sep === ",") {
    decimal = ".";
  } else {
    let brVotes = 0;
    let dotVotes = 0;
    const priceIdxs = [columns.open!, columns.high!, columns.low!, columns.close!];
    for (const entry of dataEntries.slice(0, 30)) {
      const cells = entry.raw.split(sep);
      for (const idx of priceIdxs) {
        const field = (cells[idx] ?? "").trim();
        if (/,\d+$/.test(field)) brVotes += 1;
        else if (/\.\d+$/.test(field)) dotVotes += 1;
      }
    }
    // Sem voto algum (tudo inteiro), o decimal é irrelevante para o parse;
    // assume-se a convenção do separador BR sem afirmar nada sobre os dados.
    decimal = brVotes > dotVotes ? "," : dotVotes > 0 ? "." : sep === ";" ? "," : ".";
  }

  // ---- Parse linha a linha ------------------------------------------------
  // Map por timestamp: a PRIMEIRA ocorrência vence; duplicata conta problema.
  const byTime = new Map<number, Candle>();
  const tsIdx = columns.timestamp;
  const dateIdx = columns.date;
  const timeIdx = columns.time;
  const volumeIdx = columns.volume;
  const maxRequiredIdx = Math.max(
    columns.open!,
    columns.high!,
    columns.low!,
    columns.close!,
    tsIdx ?? 0,
    dateIdx ?? 0,
    timeIdx ?? 0,
  );

  /** Fusos observados — o relatório declara TODOS, nunca escolhe um calado. */
  const tzKinds = new Set<TzKind>();
  const offsets = new Set<string>();
  let foraDeOrdem = 0;
  let duplicatas = 0;
  let ultimoT: number | null = null;

  for (const entry of dataEntries) {
    const cells = entry.raw.split(sep);
    if (cells.length <= maxRequiredIdx) {
      descartar(
        MOTIVO.COLUNAS,
        `linha ${entry.lineNo}: colunas insuficientes (${cells.length}) — descartada`,
      );
      continue;
    }

    /*
     * INSTANTE: `timestamp` único tem precedência (epoch ou ISO). Sem ele,
     * tenta-se primeiro ISO no campo de data (que pode trazer offset embutido)
     * e só então o caminho clássico data+hora, que NÃO declara fuso.
     */
    let instante: Instant | null = null;
    if (tsIdx !== undefined) {
      instante = parseInstantField(cells[tsIdx]!);
    } else {
      const dateField = cells[dateIdx!]!;
      const timeField = timeIdx !== undefined ? cells[timeIdx]!.trim() : "";
      instante = parseInstantField(timeField === "" ? dateField : `${dateField} ${timeField}`);
      if (instante === null) {
        const t = parseTimestamp(dateField, timeField);
        if (t !== null) instante = { t, tz: "SEM_DECLARACAO" };
      }
    }
    if (instante === null) {
      descartar(MOTIVO.DATA, `linha ${entry.lineNo}: data/hora ilegível — descartada`);
      continue;
    }
    const t = instante.t;
    tzKinds.add(instante.tz);
    if (instante.offset !== undefined) offsets.add(instante.offset);

    const o = parseNumber(cells[columns.open!]!, decimal);
    const h = parseNumber(cells[columns.high!]!, decimal);
    const l = parseNumber(cells[columns.low!]!, decimal);
    const c = parseNumber(cells[columns.close!]!, decimal);
    if ([o, h, l, c].some((v) => !Number.isFinite(v))) {
      descartar(MOTIVO.OHLC, `linha ${entry.lineNo}: OHLC não numérico — descartada`);
      continue;
    }
    if (h < l) {
      descartar(
        MOTIVO.MAX_MIN,
        `linha ${entry.lineNo}: máxima (${h}) menor que mínima (${l}) — descartada`,
      );
      continue;
    }
    // Preço não positivo não existe em futuro de índice: é campo zerado ou
    // sujeira de export, nunca um candle.
    if ([o, h, l, c].some((v) => v <= 0)) {
      descartar(MOTIVO.PRECO, `linha ${entry.lineNo}: preço menor ou igual a zero — descartada`);
      continue;
    }
    if (o < l || o > h || c < l || c > h) {
      descartar(
        MOTIVO.FORA_INTERVALO,
        `linha ${entry.lineNo}: abertura/fechamento fora do intervalo [mínima, máxima] — descartada`,
      );
      continue;
    }

    // Volume desconhecido vira 0 — convenção declarada do tipo Candle (a
    // captura visual usa o mesmo 0). Ilegível também vira 0, mas NUNCA em
    // silêncio: conta problema. Volume NEGATIVO é outra história: não é
    // "desconhecido", é candle corrompido — some com o candle inteiro.
    let v = 0;
    if (volumeIdx !== undefined && volumeIdx < cells.length) {
      const rawVol = cells[volumeIdx]!.trim();
      if (rawVol !== "") {
        const parsed = parseNumber(rawVol, decimal);
        if (Number.isFinite(parsed) && parsed < 0) {
          descartar(
            MOTIVO.VOLUME_NEGATIVO,
            `linha ${entry.lineNo}: volume negativo (${parsed}) — descartada`,
          );
          continue;
        }
        if (Number.isFinite(parsed)) v = parsed;
        else
          pushProblem(
            `linha ${entry.lineNo}: volume ilegível ("${rawVol}") — candle mantido com volume 0`,
          );
      }
    }

    if (byTime.has(t)) {
      duplicatas += 1;
      descartar(
        MOTIVO.DUPLICADO,
        `linha ${entry.lineNo}: timestamp duplicado — mantida a primeira ocorrência`,
      );
      continue;
    }
    // Ordem medida na ordem do ARQUIVO, antes do sort: reordenar é permitido,
    // fingir que o arquivo já veio ordenado não é.
    if (ultimoT !== null && t < ultimoT) foraDeOrdem += 1;
    ultimoT = t;
    byTime.set(t, { t, o, h, l, c, v });
  }

  const candles = [...byTime.values()].sort((a, b) => a.t - b.t);
  const sepLabel = sep === ";" ? "ponto-e-virgula" : sep === "\t" ? "tab" : "virgula";
  const decLabel = decimal === "," ? "virgula" : "ponto";
  const timezone = describeTimezone(tzKinds, offsets);
  const quality: DatasetQuality = {
    linhasLidas: dataEntries.length,
    linhasAproveitadas: candles.length,
    descartadas,
    periodo:
      candles.length > 0
        ? {
            inicio: candles[0]!.t,
            fim: candles[candles.length - 1]!.t,
            inicioIso: new Date(candles[0]!.t).toISOString(),
            fimIso: new Date(candles[candles.length - 1]!.t).toISOString(),
          }
        : null,
    pregoes: new Set(candles.map((candle) => utcDateKey(candle.t))).size,
    reordenacao: { aplicada: foraDeOrdem > 0, linhasForaDeOrdem: foraDeOrdem },
    duplicatas,
    ...measureGaps(candles),
    timezone,
  };

  return finish(
    candles,
    `sep=${sepLabel} decimal=${decLabel} cabecalho=${headerLang} tz=${timezone.assumido}`,
    quality,
  );
}

/**
 * Intervalo dominante e buracos da série.
 *
 * O intervalo base é a MODA dos deltas, não uma constante de 60 s: assumir 1
 * minuto transformaria um arquivo de 5 minutos em "tudo gap". Buraco na virada
 * de pregão é contado à parte — noite não é gap.
 */
function measureGaps(candles: Candle[]): {
  intervaloBaseMs: number | null;
  gaps: { total: number; maiorMs: number; entrePregoes: number };
} {
  if (candles.length < 2) {
    return { intervaloBaseMs: null, gaps: { total: 0, maiorMs: 0, entrePregoes: 0 } };
  }
  const contagem = new Map<number, number>();
  for (let i = 1; i < candles.length; i++) {
    const delta = candles[i]!.t - candles[i - 1]!.t;
    if (delta > 0) contagem.set(delta, (contagem.get(delta) ?? 0) + 1);
  }
  let intervaloBaseMs: number | null = null;
  let melhor = 0;
  for (const [delta, n] of contagem) {
    // Empate resolve pelo MENOR delta: a grade é o passo mais fino recorrente.
    if (n > melhor || (n === melhor && intervaloBaseMs !== null && delta < intervaloBaseMs)) {
      melhor = n;
      intervaloBaseMs = delta;
    }
  }
  if (intervaloBaseMs === null) {
    return { intervaloBaseMs: null, gaps: { total: 0, maiorMs: 0, entrePregoes: 0 } };
  }

  let total = 0;
  let maiorMs = 0;
  let entrePregoes = 0;
  for (let i = 1; i < candles.length; i++) {
    const anterior = candles[i - 1]!;
    const atual = candles[i]!;
    const delta = atual.t - anterior.t;
    if (delta <= intervaloBaseMs) continue;
    if (utcDateKey(anterior.t) !== utcDateKey(atual.t)) {
      entrePregoes += 1;
      continue;
    }
    total += 1;
    if (delta > maiorMs) maiorMs = delta;
  }
  return { intervaloBaseMs, gaps: { total, maiorMs, entrePregoes } };
}

/**
 * Declaração de fuso — o ponto em que o importador se recusa a ficar calado.
 * Sem informação no arquivo, o texto é literal: "sem timezone declarado".
 */
function describeTimezone(
  kinds: ReadonlySet<TzKind>,
  offsets: ReadonlySet<string>,
): { assumido: string; detalhe: string } {
  if (kinds.size === 0) {
    return { assumido: "N/D", detalhe: "nenhum instante lido — nada a assumir" };
  }
  if (kinds.size === 1) {
    if (kinds.has("EPOCH")) {
      return {
        assumido: "EPOCH",
        detalhe: "timestamp epoch — instante absoluto, sem ambiguidade de fuso",
      };
    }
    if (kinds.has("UTC")) {
      return { assumido: "UTC", detalhe: "ISO com sufixo Z — instante absoluto em UTC" };
    }
    if (kinds.has("OFFSET")) {
      const lista = [...offsets].sort().join(", ");
      return {
        assumido: `OFFSET ${lista}`,
        detalhe:
          offsets.size === 1
            ? `ISO com offset ${lista} declarado no arquivo — normalizado para instante absoluto`
            : `múltiplos offsets declarados (${lista}) — cada linha normalizada pelo próprio offset`,
      };
    }
    return {
      assumido: "LOCAL_DO_ARQUIVO",
      detalhe:
        "sem timezone declarado — assumido horário local do arquivo (grade usada como veio, " +
        "sem conversão; se o export estiver em outro fuso, os horários do relatório seguem o do arquivo)",
    };
  }
  const partes = [...kinds].sort();
  return {
    assumido: "MISTO",
    detalhe:
      `o arquivo mistura formas de instante (${partes.join(", ")})` +
      (offsets.size > 0 ? ` com offset(s) ${[...offsets].sort().join(", ")}` : "") +
      " — linhas sem offset ficaram no horário local do arquivo, as demais foram normalizadas",
  };
}

/**
 * Compatibilidade: assinatura ORIGINAL, usada pelo endpoint de importação.
 * O relatório de qualidade está em `parseCandlesCsvDetailed` — quem precisar
 * dele chama a versão detalhada; ninguém quebra por causa de um campo novo.
 */
export function parseCandlesCsv(text: string): {
  candles: Candle[];
  problems: string[];
  format: string;
} {
  const { candles, problems, format } = parseCandlesCsvDetailed(text);
  return { candles, problems, format };
}
