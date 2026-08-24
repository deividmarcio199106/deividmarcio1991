/**
 * SAÚDE CONSOLIDADA DO SISTEMA — agregador PURO.
 *
 * RAZÃO DE EXISTIR: o operador precisa de UMA resposta para "dá para confiar no
 * que está na tela agora?". Antes disto a resposta estava espalhada em cards
 * independentes, cada um capaz de acender verde por conta própria, sem ninguém
 * responsável pelo conjunto.
 *
 * DUAS RESTRIÇÕES GOVERNAM ESTE MÓDULO:
 *
 *  1. NÃO MEDIDO NUNCA É OK. Ausência de medição vira DEGRADED com o motivo
 *     escrito. Um painel que fica verde porque não CONSEGUIU medir mente para o
 *     operador — e é pior que um painel vermelho, porque o vermelho ele
 *     investiga e o verde ele acredita. Toda porta de saída daqui obedece isso:
 *     `value: null` significa "não medido", jamais um zero disfarçado.
 *
 *  2. NADA DE I/O AQUI, E NENHUM RELÓGIO INTERNO. As leituras entram prontas e o
 *     instante entra por parâmetro (nunca `Date.now()` dentro do agregador). É
 *     isso que torna o diagnóstico reproduzível: mesma entrada ⇒ mesma saída,
 *     em teste e em produção.
 *
 * Quem faz o I/O é `src/lib/healthEndpoints.ts` (lado servidor) e a UI, para o
 * que só existe no navegador (captura, fila, última captura).
 */

export type HealthState = "OK" | "DEGRADED" | "ERROR";

export interface SubsystemHealth {
  /**
   * Identificador estável do subsistema. Em uso hoje:
   * "captura" | "ultima_captura" | "fila" | "ia" | "latencia" | "erros" |
   * "armazenamento" | "memoria" | "banco" | "aplicacao" | "setups" |
   * "pesquisa" | "shadow" | "ultimo_processamento".
   */
  id: string;
  /** Rótulo curto em PT, para a linha do painel. */
  label: string;
  state: HealthState;
  /** SEMPRE preenchido, em PT, dizendo o PORQUÊ do estado. */
  detail: string;
  /** Medida crua quando existe; null = não medido (nunca 0 disfarçado). */
  value: number | null;
  unit: string | null;
}

export interface SystemHealth {
  state: HealthState;
  subsystems: SubsystemHealth[];
  checkedAt: number;
  note: string;
}

/* ----------------------------------------------------------------- LIMIARES *
 * Todo número de decisão mora aqui, exportado e com o porquê escrito. Limiar
 * solto no meio de um `if` é número que ninguém consegue auditar depois.
 * ------------------------------------------------------------------------- */

/**
 * Latência do provedor de IA a partir da qual o estado cai para DEGRADED.
 * Listar modelos numa GPU saudável responde em centenas de milissegundos; 1,5 s
 * já indica túnel congestionado ou máquina sob carga.
 */
export const LATENCIA_DEGRADADA_MS = 1_500;

/**
 * Teto absoluto: é o mesmo valor do timeout do health do provedor
 * (DEFAULT_HEALTH_TIMEOUT_MS = 5 s em src/services/ai/config.ts — repetido aqui
 * de propósito, ver nota sobre pureza no cabeçalho). Medir uma latência nesse
 * patamar significa que a próxima chamada simplesmente aborta.
 */
export const LATENCIA_ERRO_MS = 5_000;

/**
 * Período do ciclo de captura. É o CAPTURE_PERIOD_MS de
 * src/lib/capture/marketMonitor.ts, repetido aqui porque aquele módulo é código
 * de NAVEGADOR (toca `document`/MediaStream) e este precisa continuar puro para
 * rodar no servidor e em teste.
 */
export const PERIODO_CAPTURA_MS = 60_000;

/**
 * Perder um minuto acontece (aba em segundo plano, coleta de lixo, análise
 * longa). Dois períodos sem print já é buraco na série que o operador precisa
 * ver antes de confiar na leitura.
 */
export const IDADE_CAPTURA_DEGRADADA_MS = 2 * PERIODO_CAPTURA_MS;

/**
 * Cinco minutos sem print: a leitura de mercado está cega. Qualquer coisa
 * exibida na tela descreve um mercado que já não existe.
 */
export const IDADE_CAPTURA_ERRO_MS = 5 * PERIODO_CAPTURA_MS;

/**
 * A fila do monitor tem UM slot por contrato (só o pendente mais recente
 * espera, ver marketMonitor). Mais de um pendente significa que o contrato
 * quebrou e prints velhos estão sendo analisados.
 */
export const FILA_MAX_PENDENTE = 1;

/**
 * Um print JPEG do gráfico gira em torno de 300 KB e o ciclo grava um por
 * minuto: ~145 MB por pregão de 8 h. 5 GB ≈ um mês inteiro sem a retenção
 * rodar — hora de olhar antes que o volume aperte.
 */
export const ARMAZENAMENTO_DEGRADADO_BYTES = 5 * 1024 * 1024 * 1024;

/**
 * ~4 meses de prints acumulados. Num volume típico de VPS isso enche o disco, e
 * disco cheio faz o SQLite parar de gravar no meio do pregão.
 */
export const ARMAZENAMENTO_ERRO_BYTES = 20 * 1024 * 1024 * 1024;

/**
 * Heap acima de 1 GB é o ponto em que vale investigar vazamento — mesmo número
 * já usado pelo MODO ENGENHEIRO (src/server/diagnosticsEndpoints.ts).
 */
export const HEAP_DEGRADADO_BYTES = 1024 * 1024 * 1024;

/**
 * Acima de 2 GB o processo entra na faixa em que o sistema operacional o mata,
 * derrubando a sessão no meio do pregão.
 */
export const HEAP_ERRO_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Um erro CRÍTICO aberto já pede leitura da Central de Erros; cinco significa
 * que alguma coisa está falhando em série e não foi tratada.
 */
export const ERROS_CRITICOS_DEGRADADO = 1;
export const ERROS_CRITICOS_ERRO = 5;

/**
 * Subsistemas cuja falha invalida qualquer sinal: sem captura não há leitura do
 * mercado, sem IA não há análise da imagem e sem banco não há evidência
 * gravada. `podeEmitirSinal` usa exatamente esta lista.
 */
export const SUBSISTEMAS_QUE_BLOQUEIAM_SINAL = ["captura", "ia", "banco"] as const;

/* ---------------------------------------------------------------- AGREGADOR */

const SEVERIDADE: Record<HealthState, number> = { OK: 0, DEGRADED: 1, ERROR: 2 };

function piorEstado(a: HealthState, b: HealthState): HealthState {
  return SEVERIDADE[b] > SEVERIDADE[a] ? b : a;
}

/**
 * Consolida as leituras num diagnóstico único.
 *
 * O estado geral é o PIOR dos subsistemas: um ERROR derruba tudo para ERROR, um
 * DEGRADED sem ERROR resulta em DEGRADED. Não existe média, não existe "maioria
 * está bem" — a peça quebrada é a que define se dá para operar.
 *
 * `at` entra por parâmetro justamente para o módulo não ter relógio próprio.
 */
export function aggregateHealth(readings: SubsystemHealth[], at: number): SystemHealth {
  const subsystems = [...readings];

  if (subsystems.length === 0) {
    // Lista vazia não é "tudo bem": é ausência total de medição, o caso que
    // esta camada existe para nunca deixar passar como verde.
    return {
      state: "ERROR",
      subsystems,
      checkedAt: at,
      note: "Nenhuma leitura chegou ao agregador — sem medição não existe saúde comprovada.",
    };
  }

  let state: HealthState = "OK";
  for (const subsystem of subsystems) state = piorEstado(state, subsystem.state);

  const ausentes = SUBSISTEMAS_QUE_BLOQUEIAM_SINAL.filter(
    (id) => !subsystems.some((subsystem) => subsystem.id === id),
  );
  // Crítico que nem foi enumerado também não foi medido: não pode render verde.
  if (ausentes.length > 0) state = piorEstado(state, "DEGRADED");

  const emErro = subsystems.filter((s) => s.state === "ERROR").map((s) => s.label);
  const degradados = subsystems.filter((s) => s.state === "DEGRADED").map((s) => s.label);
  const partes: string[] = [];
  if (emErro.length > 0) partes.push(`em ERRO: ${emErro.join(", ")}`);
  if (degradados.length > 0) partes.push(`degradado(s): ${degradados.join(", ")}`);
  if (ausentes.length > 0) partes.push(`crítico(s) sem leitura: ${ausentes.join(", ")}`);

  return {
    state,
    subsystems,
    checkedAt: at,
    note:
      partes.length === 0
        ? `${subsystems.length} subsistema(s) medido(s), todos saudáveis.`
        : `${partes.join(" · ")}.`,
  };
}

/**
 * Porta de segurança para a UI: falha de serviço NÃO pode virar sinal falso.
 *
 * Devolve false quando captura, IA ou banco estão em ERROR — e TAMBÉM quando
 * algum deles está ausente da lista, porque subsistema não enumerado é
 * subsistema não medido, e não medido nunca autoriza operar.
 *
 * Esta função apenas RESPONDE; ela não emite, não bloqueia e não conhece ordem.
 * Quem consome é a apresentação.
 */
export function podeEmitirSinal(health: SystemHealth): boolean {
  return SUBSISTEMAS_QUE_BLOQUEIAM_SINAL.every((id) => {
    const leitura = health.subsystems.find((subsystem) => subsystem.id === id);
    if (leitura === undefined) return false;
    return leitura.state !== "ERROR";
  });
}

/* ------------------------------------------------------------- CONSTRUTORES *
 * Cada construtor traduz UMA leitura crua em subsistema. Todo o julgamento do
 * sistema mora aqui, para que o endpoint e a UI só entreguem números.
 * ------------------------------------------------------------------------- */

const MARCA_NAO_MEDIDO = "não medido";

/**
 * Subsistema sem leitura: DEGRADED, `value` null e o motivo por escrito.
 *
 * RESTRIÇÃO: a explicação PRECISA dizer que não houve leitura. Se o chamador
 * esqueceu de dizer, a marca entra aqui — nunca sai deste módulo um estado sem
 * medição cujo texto sugira que alguma coisa foi verificada.
 */
export function naoMedido(id: string, label: string, motivo: string): SubsystemHealth {
  const detail = motivo.toLowerCase().includes(MARCA_NAO_MEDIDO)
    ? motivo
    : `${MARCA_NAO_MEDIDO} — ${motivo}`;
  return { id, label, state: "DEGRADED", detail, value: null, unit: null };
}

export function medirLatencia(latencyMs: number | null): SubsystemHealth {
  const label = "Latência da IA";
  if (latencyMs === null) {
    return naoMedido("latencia", label, "o provedor não devolveu tempo de resposta.");
  }
  if (latencyMs >= LATENCIA_ERRO_MS) {
    return {
      id: "latencia",
      label,
      state: "ERROR",
      detail: `${latencyMs} ms — no teto do timeout do health (${LATENCIA_ERRO_MS} ms): a próxima chamada aborta antes de responder.`,
      value: latencyMs,
      unit: "ms",
    };
  }
  if (latencyMs >= LATENCIA_DEGRADADA_MS) {
    return {
      id: "latencia",
      label,
      state: "DEGRADED",
      detail: `${latencyMs} ms — acima de ${LATENCIA_DEGRADADA_MS} ms; túnel congestionado ou máquina sob carga.`,
      value: latencyMs,
      unit: "ms",
    };
  }
  return {
    id: "latencia",
    label,
    state: "OK",
    detail: `${latencyMs} ms — dentro do esperado para a listagem de modelos.`,
    value: latencyMs,
    unit: "ms",
  };
}

export function medirIdadeUltimaCaptura(lastCaptureAt: number | null, at: number): SubsystemHealth {
  const label = "Última captura";
  if (lastCaptureAt === null) {
    return naoMedido("ultima_captura", label, "nenhum print foi registrado nesta sessão.");
  }
  const idade = at - lastCaptureAt;
  if (idade < 0) {
    // Relógio inconsistente: a medida existe mas não é confiável, então ela não
    // vira número — vira ausência declarada.
    return naoMedido(
      "ultima_captura",
      label,
      "instante de referência anterior à última captura — relógio inconsistente.",
    );
  }
  const segundos = Math.round(idade / 1000);
  if (idade >= IDADE_CAPTURA_ERRO_MS) {
    return {
      id: "ultima_captura",
      label,
      state: "ERROR",
      detail: `${segundos}s sem print — acima de ${IDADE_CAPTURA_ERRO_MS / 1000}s a leitura está cega.`,
      value: idade,
      unit: "ms",
    };
  }
  if (idade >= IDADE_CAPTURA_DEGRADADA_MS) {
    return {
      id: "ultima_captura",
      label,
      state: "DEGRADED",
      detail: `${segundos}s sem print — mais de ${IDADE_CAPTURA_DEGRADADA_MS / PERIODO_CAPTURA_MS} ciclos de ${PERIODO_CAPTURA_MS / 1000}s: há buraco na série.`,
      value: idade,
      unit: "ms",
    };
  }
  return {
    id: "ultima_captura",
    label,
    state: "OK",
    detail: `${segundos}s desde o último print — dentro do ciclo de ${PERIODO_CAPTURA_MS / 1000}s.`,
    value: idade,
    unit: "ms",
  };
}

export function medirFila(pendentes: number | null): SubsystemHealth {
  const label = "Fila de análise";
  if (pendentes === null) {
    return naoMedido("fila", label, "o estado da fila vive no navegador do operador.");
  }
  if (pendentes > FILA_MAX_PENDENTE) {
    return {
      id: "fila",
      label,
      state: "ERROR",
      detail: `${pendentes} análises pendentes — a fila tem ${FILA_MAX_PENDENTE} slot por contrato; prints velhos estão sendo analisados.`,
      value: pendentes,
      unit: "pendentes",
    };
  }
  return {
    id: "fila",
    label,
    state: "OK",
    detail:
      pendentes === 0
        ? "sem análise pendente."
        : `${pendentes} pendente — dentro do slot único do contrato.`,
    value: pendentes,
    unit: "pendentes",
  };
}

function emGb(bytes: number): string {
  return (bytes / (1024 * 1024 * 1024)).toFixed(2);
}

function emMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

/**
 * ARMAZENAMENTO — mede o que a RETENÇÃO governa, e só isso.
 *
 * Medir o DATA_DIR inteiro e chamar de "prints" foi um defeito real em
 * produção: o painel acusou 1 GB "em prints" quando os prints eram 33 MB e o
 * volume vinha das GRAVAÇÕES de replay, que a retenção não toca. Número certo
 * com rótulo errado manda consertar a coisa errada — pior que não medir.
 */
export function medirArmazenamento(bytesUsados: number | null): SubsystemHealth {
  const label = "Armazenamento de prints";
  if (bytesUsados === null) {
    return naoMedido("armazenamento", label, "não foi possível ler o diretório de dados.");
  }
  if (bytesUsados >= ARMAZENAMENTO_ERRO_BYTES) {
    return {
      id: "armazenamento",
      label,
      state: "ERROR",
      detail: `${emGb(bytesUsados)} GB em prints — acima de ${emGb(ARMAZENAMENTO_ERRO_BYTES)} GB o volume enche e o banco para de gravar.`,
      value: bytesUsados,
      unit: "bytes",
    };
  }
  if (bytesUsados >= ARMAZENAMENTO_DEGRADADO_BYTES) {
    return {
      id: "armazenamento",
      label,
      state: "DEGRADED",
      detail: `${emGb(bytesUsados)} GB em prints — acima de ${emGb(ARMAZENAMENTO_DEGRADADO_BYTES)} GB; verifique se a retenção está rodando.`,
      value: bytesUsados,
      unit: "bytes",
    };
  }
  return {
    id: "armazenamento",
    label,
    state: "OK",
    detail: `${emMb(bytesUsados)} MB em prints — folga em relação ao limite de ${emGb(ARMAZENAMENTO_DEGRADADO_BYTES)} GB.`,
    value: bytesUsados,
    unit: "bytes",
  };
}

export function medirMemoria(heapUsedBytes: number | null): SubsystemHealth {
  const label = "Memória do processo";
  if (heapUsedBytes === null) {
    return naoMedido("memoria", label, "o runtime não expôs o consumo de heap.");
  }
  if (heapUsedBytes >= HEAP_ERRO_BYTES) {
    return {
      id: "memoria",
      label,
      state: "ERROR",
      detail: `heap em ${emMb(heapUsedBytes)} MB — acima de ${emMb(HEAP_ERRO_BYTES)} MB o processo entra na faixa em que o sistema o mata.`,
      value: heapUsedBytes,
      unit: "bytes",
    };
  }
  if (heapUsedBytes >= HEAP_DEGRADADO_BYTES) {
    return {
      id: "memoria",
      label,
      state: "DEGRADED",
      detail: `heap em ${emMb(heapUsedBytes)} MB — acima de ${emMb(HEAP_DEGRADADO_BYTES)} MB vale investigar vazamento.`,
      value: heapUsedBytes,
      unit: "bytes",
    };
  }
  return {
    id: "memoria",
    label,
    state: "OK",
    detail: `heap em ${emMb(heapUsedBytes)} MB — abaixo do limite de ${emMb(HEAP_DEGRADADO_BYTES)} MB.`,
    value: heapUsedBytes,
    unit: "bytes",
  };
}

export function medirErrosCriticosAbertos(criticos: number | null): SubsystemHealth {
  const label = "Erros críticos abertos";
  if (criticos === null) {
    return naoMedido("erros", label, "a Central de Erros não respondeu.");
  }
  if (criticos >= ERROS_CRITICOS_ERRO) {
    return {
      id: "erros",
      label,
      state: "ERROR",
      detail: `${criticos} erros críticos abertos — ${ERROS_CRITICOS_ERRO} ou mais indicam falha em série sem tratamento.`,
      value: criticos,
      unit: "erros",
    };
  }
  if (criticos >= ERROS_CRITICOS_DEGRADADO) {
    return {
      id: "erros",
      label,
      state: "DEGRADED",
      detail: `${criticos} erro(s) crítico(s) aberto(s) — leia a Central de Erros antes de operar.`,
      value: criticos,
      unit: "erros",
    };
  }
  return {
    id: "erros",
    label,
    state: "OK",
    detail: "nenhum erro crítico aberto.",
    value: criticos,
    unit: "erros",
  };
}

/**
 * Gravações de replay crescem SEM política de retenção.
 *
 * Elas são evidência que o operador pediu para guardar — apagá-las sozinho
 * seria destruir material de auditoria. Por isso aqui o papel é AVISAR: o
 * volume aparece com dono e nome próprios, em vez de inflar o número dos
 * prints e mandar consertar a retenção errada.
 */
export const GRAVACOES_DEGRADADO_BYTES = 2 * 1024 * 1024 * 1024;
export const GRAVACOES_ERRO_BYTES = 10 * 1024 * 1024 * 1024;

export function medirGravacoes(bytesUsados: number | null): SubsystemHealth {
  const label = "Gravações de replay";
  if (bytesUsados === null) {
    return naoMedido("gravacoes", label, "não foi possível ler o diretório de gravações.");
  }
  const estado: HealthState =
    bytesUsados >= GRAVACOES_ERRO_BYTES
      ? "ERROR"
      : bytesUsados >= GRAVACOES_DEGRADADO_BYTES
        ? "DEGRADED"
        : "OK";
  const nota =
    estado === "OK"
      ? "dentro do esperado."
      : "sem política de retenção automática — a limpeza é decisão do operador.";
  return {
    id: "gravacoes",
    label,
    state: estado,
    detail: `${emGb(bytesUsados)} GB em gravações de replay — ${nota}`,
    value: bytesUsados,
    unit: "bytes",
  };
}
