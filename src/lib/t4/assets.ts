/**
 * CONFIGURAÇÃO POR ATIVO — custo, sessão e permissão de operar.
 *
 * O QUE EXISTIA: um `Settings` único e GLOBAL, com um `tickSize` e um
 * `pointValue` para o sistema inteiro. Trocar o ativo no campo da tela trocava o
 * símbolo mas mantinha os parâmetros do anterior — WIN e WDO compartilhavam a
 * mesma configuração, e nada avisava. Um WDO analisado com o tick do WIN produz
 * stop, alvo e tamanho de posição errados, sem erro na tela.
 *
 * DUAS COISAS QUE ESTE ARQUIVO IMPEDE
 *
 * 1. REUSO SILENCIOSO DE PARÂMETRO. Cada ativo carrega os seus. Ativo sem
 *    configuração não herda a do vizinho: fica sem, e quem pergunta recebe null.
 *
 * 2. OPERAR ANTES DE VALIDAR. `VALIDATED_FOR_PRODUCTION` é por ativo, e por
 *    VERSÃO da técnica. Validar a T4 no WIN não valida no WDO — são mercados
 *    com liquidez, horário e comportamento diferentes, e a evidência histórica
 *    de um não descreve o outro.
 *
 * 3. PERDER A AUTORIZAÇÃO NO REINÍCIO — e, do outro lado, transformá-la em
 *    permissão eterna. A autorização é persistida pelo servidor, mas SEMPRE
 *    amarrada à versão sob a qual foi obtida e acompanhada da trilha (quem,
 *    quando, contra qual evidência). Subir a versão da técnica derruba toda
 *    autorização gravada sem ninguém precisar lembrar de revogar.
 *
 * CUSTO NÃO É DETALHE DE APRESENTAÇÃO. Uma técnica com expectância de +0,15R
 * bruta pode ser negativa depois de corretagem, emolumentos e slippage. Validar
 * ignorando custo é validar uma técnica que não existe.
 */

import { resolveInstrument, type Instrument } from "@/lib/engines/instruments";

export type AssetValidation = "VALIDATED_FOR_PRODUCTION" | "IN_VALIDATION" | "LAB_ONLY";

export interface AssetCosts {
  /** Corretagem por contrato, por perna (entrada e saída), em R$. */
  brokeragePerContract: number;
  /** Emolumentos + taxas da bolsa por contrato, por perna, em R$. */
  exchangeFeesPerContract: number;
  /** Spread médio pago na entrada, em ticks. */
  spreadTicks: number;
  /** Derrapagem esperada por perna, em ticks. */
  slippageTicks: number;
}

export interface AssetSession {
  /** Início do pregão regular, minutos desde a meia-noite (horário de mercado). */
  openMinute: number;
  closeMinute: number;
}

export interface AssetConfig {
  symbol: string;
  label: string;
  instrument: Instrument;
  costs: AssetCosts;
  session: AssetSession;
  validation: AssetValidation;
  /**
   * Versão da técnica sob a qual ESTE ativo foi validado. Quando a técnica de
   * produção sobe de versão, a validação do ativo deixa de valer — foi outra
   * técnica que se provou, não esta.
   */
  validatedVersion: string | null;
}

/**
 * TAXAS DA B3 por contrato e por perna: emolumentos + taxa de registro.
 *
 * R$ 0,77 é a soma cobrada pela bolsa em cada perna de cada mini contrato — ela
 * não depende da corretora, ao contrário da corretagem. Ficava embutida num
 * 0,27 que não correspondia a nenhuma linha de nota de corretagem: o número
 * batia com o TOTAL (0,50 + 0,27) por coincidência aritmética, e qualquer
 * mudança na corretagem teria quebrado a conta sem ninguém perceber.
 *
 * Separar as duas é o que permite auditar: corretagem se negocia, emolumento
 * não.
 */
export const B3_TAXAS_POR_CONTRATO_POR_PERNA = 0.77;

/**
 * Custos reais da B3 para mini contratos, por contrato e por perna.
 *
 * São ponto de partida verificável, não verdade imutável: a CORRETAGEM varia por
 * corretora e por volume. O que não pode acontecer é o backtest assumir ZERO.
 */
const MINI_COSTS: AssetCosts = {
  brokeragePerContract: 0.5,
  exchangeFeesPerContract: B3_TAXAS_POR_CONTRATO_POR_PERNA,
  spreadTicks: 1,
  slippageTicks: 1,
};

const CHEIO_COSTS: AssetCosts = {
  brokeragePerContract: 2.5,
  exchangeFeesPerContract: 1.35,
  spreadTicks: 1,
  slippageTicks: 1,
};

/**
 * PISO DE DERRAPAGEM declarado pelo operador: 1 tick na entrada e 1 tick no
 * stop. Nenhum ativo pode ser configurado abaixo disso — assumir execução no
 * preço exato é o mesmo erro de assumir custo zero, com outro nome.
 */
export const SLIPPAGE_MIN_TICKS_ENTRADA = 1;
export const SLIPPAGE_MIN_TICKS_SAIDA = 1;

/** 09:00–18:00 no horário do mercado. Usado para marcar candle fora de sessão. */
const B3_SESSION: AssetSession = { openMinute: 9 * 60, closeMinute: 18 * 60 };

interface AssetSeed {
  symbol: string;
  costs: AssetCosts;
  session: AssetSession;
  validation: AssetValidation;
  validatedVersion: string | null;
}

/**
 * Somente WINFUT chega a IN_VALIDATION: é o único com histórico observado neste
 * sistema. Todos os outros são LAB_ONLY até que alguém os valide de fato —
 * herdar a validação do WIN seria exatamente o reuso que este arquivo impede.
 */
const SEEDS: AssetSeed[] = [
  {
    symbol: "WINFUT",
    costs: MINI_COSTS,
    session: B3_SESSION,
    validation: "IN_VALIDATION",
    validatedVersion: null,
  },
  {
    symbol: "WDOFUT",
    costs: MINI_COSTS,
    session: B3_SESSION,
    validation: "LAB_ONLY",
    validatedVersion: null,
  },
  {
    symbol: "INDFUT",
    costs: CHEIO_COSTS,
    session: B3_SESSION,
    validation: "LAB_ONLY",
    validatedVersion: null,
  },
  {
    symbol: "DOLFUT",
    costs: CHEIO_COSTS,
    session: B3_SESSION,
    validation: "LAB_ONLY",
    validatedVersion: null,
  },
];

/**
 * TRILHA de uma autorização por ativo.
 *
 * Autorizar não é ligar um booleano. É afirmar que alguém MEDIU evidência, numa
 * data, sob uma versão específica da técnica. Sem os quatro campos —
 * quem, quando, qual versão, contra qual evidência — a autorização é
 * indistinguível de um valor esquecido numa constante, que é justamente o
 * defeito que este arquivo nasceu para impedir.
 *
 * `revokedAt` existe porque revogação é EVENTO, não apagamento: a trilha precisa
 * mostrar que a permissão existiu e quando deixou de existir.
 */
export interface AssetAuthorization {
  symbol: string;
  status: AssetValidation;
  /** Versão da técnica sob a qual a autorização foi obtida. */
  techniqueVersion: string | null;
  /** Id do relatório/execução que sustenta a concessão. */
  evidenceRef: string | null;
  /** Epoch em milissegundos da concessão. */
  grantedAt: number;
  /** Quem (ou o quê) concedeu. */
  grantedBy: string;
  /** Epoch em que este evento deixou de ser o vigente. */
  revokedAt: number | null;
}

/** Dados de auditoria exigidos para gravar uma autorização. */
export interface AssetAuthorizationAudit {
  evidenceRef?: string | null;
  grantedBy?: string;
  /** Epoch do evento. Injetável para que teste e replay não dependam do relógio. */
  at?: number;
}

/**
 * PORTA de persistência da autorização.
 *
 * Este arquivo roda TAMBÉM no navegador — importar o SQLite aqui quebraria o
 * pacote do cliente. Por isso a persistência entra por injeção: o servidor liga
 * um store na inicialização, o cliente nunca liga nenhum. Sem store, o
 * comportamento é exatamente o de antes (mapa em memória), o que mantém a
 * decisão de bloqueio idêntica nos dois lados.
 */
export interface AssetValidationStore {
  /** Autorizações VIGENTES (uma por ativo). Lida na ligação e a cada reset. */
  readActive(): AssetAuthorization[];
  /** Acrescenta um evento à trilha. Nunca sobrescreve nem apaga o anterior. */
  append(authorization: AssetAuthorization): void;
}

/**
 * Cache das autorizações vigentes.
 *
 * A validação de um ativo é uma CONQUISTA: backtest, out-of-sample,
 * walk-forward e amostra mínima, naquela versão da técnica. Ela não pode ser um
 * literal no código — ficaria congelada e mentiria no primeiro bump de versão.
 *
 * O mapa continua sendo a fonte de leitura porque `assetConfig` é síncrono e
 * roda no caminho de decisão; ir ao banco a cada consulta é caro e, no cliente,
 * impossível. Com store ligado ele é escrita-através: toda concessão vai para o
 * banco no mesmo instante, e a releitura acontece na ligação e no reset.
 *
 * O QUE IMPEDE A PERMISSÃO ETERNA: o que se persiste é sempre o par
 * (autorização, VERSÃO da técnica). `validatedForProduction` continua exigindo
 * que a versão bata com a de produção — logo, subir a versão derruba sozinha
 * toda autorização gravada, sem ninguém precisar lembrar de revogar.
 */
const grants = new Map<string, AssetAuthorization>();

let store: AssetValidationStore | null = null;

/**
 * Liga (ou desliga, com `null`) a persistência das autorizações.
 *
 * Desligar zera o cache de propósito: sem store, a única verdade possível é a
 * semente do código, e manter em memória o que veio do banco seria afirmar uma
 * permissão que ninguém mais consegue auditar.
 */
export function setAssetValidationStore(next: AssetValidationStore | null): void {
  store = next;
  grants.clear();
  if (next) hydrateFrom(next);
}

function hydrateFrom(source: AssetValidationStore): void {
  for (const authorization of source.readActive()) {
    grants.set(authorization.symbol.trim().toUpperCase(), authorization);
  }
}

/**
 * Concede (ou revoga) a validação de um ativo para uma versão da técnica.
 *
 * Não valida nada por si: quem chama é o fluxo que MEDIU a evidência. A função
 * existe para que a permissão tenha um caminho explícito e auditável, em vez de
 * nascer de um valor esquecido numa constante.
 *
 * Com store ligado a concessão vira registro permanente, e por isso passa a
 * exigir trilha: sem referência de evidência e sem autor declarado a gravação é
 * RECUSADA. Sem store nada é gravado e nada é exigido — é o comportamento
 * anterior, preservado inteiro.
 */
export function setAssetValidation(
  asset: string,
  status: AssetValidation,
  techniqueVersion: string | null,
  audit: AssetAuthorizationAudit = {},
): void {
  const symbol = asset.trim().toUpperCase();
  if (status === "VALIDATED_FOR_PRODUCTION" && !techniqueVersion) {
    throw new Error("Validar para produção exige a versão da técnica sob a qual foi validado.");
  }

  const evidenceRef = audit.evidenceRef?.trim() || null;
  const grantedBy = audit.grantedBy?.trim() || "";

  if (store) {
    if (status === "VALIDATED_FOR_PRODUCTION" && !evidenceRef) {
      throw new Error(
        `Autorizar ${symbol} para produção exige a referência da evidência (id do relatório ou da execução): permissão gravada sem prova não é auditável.`,
      );
    }
    if (!grantedBy) {
      throw new Error(
        `Gravar autorização de ${symbol} exige declarar quem concedeu — trilha sem autor não responde "quem liberou".`,
      );
    }
  }

  const authorization: AssetAuthorization = {
    symbol,
    status,
    techniqueVersion,
    evidenceRef,
    grantedAt: audit.at ?? Date.now(),
    grantedBy,
    revokedAt: null,
  };

  /*
   * Grava ANTES de refletir no cache: se o banco recusar (CHECK da tabela, disco
   * cheio), a tela não pode ficar dizendo que o ativo está liberado enquanto o
   * registro que sustenta essa afirmação não existe.
   */
  store?.append(authorization);
  grants.set(symbol, authorization);
}

/**
 * Volta ao estado semeado. Usado por teste e por troca de sessão.
 *
 * Com store ligado, "semeado" não é mais o literal do código: a verdade é o
 * banco, e por isso o cache é RELIDO em vez de esvaziado. Esvaziar faria a tela
 * bloquear um ativo que o registro autoriza — divergência silenciosa entre o que
 * o sistema mostra e o que ele tem gravado.
 */
export function resetAssetValidations(): void {
  grants.clear();
  if (store) hydrateFrom(store);
}

/** Trilha vigente do ativo, para o painel de auditoria. `null` = nunca concedida. */
export function assetAuthorization(asset: string): AssetAuthorization | null {
  return grants.get(asset.trim().toUpperCase()) ?? null;
}

/**
 * Configuração completa do ativo, ou `null` quando ele não é conhecido.
 *
 * Devolver null é deliberado: o chamador precisa mostrar "ativo não configurado"
 * em vez de operar com o tick de outro contrato.
 */
export function assetConfig(
  asset: string,
  overrides: Partial<AssetCosts> = {},
): AssetConfig | null {
  const symbol = asset.trim().toUpperCase();
  const instrument = resolveInstrument(symbol);
  if (!instrument) return null;

  const seed = SEEDS.find((s) => symbol === s.symbol || symbol.startsWith(s.symbol.slice(0, 3)));
  if (!seed) return null;

  const grant = grants.get(symbol);
  return {
    symbol,
    label: instrument.label,
    instrument,
    costs: { ...seed.costs, ...overrides },
    session: seed.session,
    validation: grant?.status ?? seed.validation,
    validatedVersion: grant ? grant.techniqueVersion : seed.validatedVersion,
  };
}

/**
 * O ativo pode liberar sinal REAL nesta versão da técnica?
 *
 * Exige as duas coisas: marca de validação E a versão sob a qual ela foi obtida.
 * Uma validação sem versão é uma afirmação sobre um sistema que não existe mais.
 */
export function validatedForProduction(
  config: AssetConfig | null,
  techniqueVersion: string,
): boolean {
  if (config === null) return false;
  return (
    config.validation === "VALIDATED_FOR_PRODUCTION" && config.validatedVersion === techniqueVersion
  );
}

/** Frase para o painel quando o ativo não pode operar. */
export function validationBlockReason(
  config: AssetConfig | null,
  asset: string,
  techniqueVersion: string,
): string | null {
  if (config === null) return `${asset}: ativo não configurado — tick e valor do ponto ausentes.`;
  if (config.validation === "LAB_ONLY") {
    return `${config.symbol}: LAB ONLY — sem validação para produção. Sinal não liberado.`;
  }
  if (config.validation === "IN_VALIDATION") {
    return `${config.symbol}: EM VALIDAÇÃO — evidência ainda sendo construída. Sinal não liberado.`;
  }
  if (config.validatedVersion !== techniqueVersion) {
    return `${config.symbol}: validado na técnica ${config.validatedVersion ?? "—"}, produção está em ${techniqueVersion}. Revalidar.`;
  }
  return null;
}
