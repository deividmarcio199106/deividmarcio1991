import type { CSSProperties } from "react";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import type { SetupStage, SetupUpdate, TrackedSetup } from "@/lib/print/setupTracker";
import {
  deriveEntryDecision,
  NAO_IDENTIFICADO,
  type PrintAnalysis,
} from "@/lib/vision/printAnalysis";
import { cn } from "@/lib/utils";

/**
 * CARD "SETUP T4" — o rosto da máquina de setup persistente (§5–§9).
 *
 * Responde às perguntas do operador na ordem em que ele decide: QUAL setup
 * (o id que atravessa os prints), EM QUE ESTÁGIO, o que FAZER AGORA (o
 * headline da máquina, nunca reescrito aqui), ONDE entrar (a linha roxa em
 * número — visível mesmo quando a régua não calibrou e a linha não pôde ser
 * desenhada no gráfico), QUANTO falta e com QUE margem (stop/alvo/R:R).
 *
 * REGRAS DE HONESTIDADE, as mesmas da máquina:
 * — cor de confirmação (bull) SÓ quando o estágio é CONFIRMADO de fato;
 * — R:R só com entrada, stop E alvo legíveis — dois números não fazem razão;
 * — distância ausente é NÃO IDENTIFICADO, nunca zero;
 * — confiança de ENTRADA abaixo de 60 aparece em bear com "→ AGUARDAR":
 *   contexto alto não compra entrada fraca (§12);
 * — auditor: null é "AUDITOR: NÃO RODOU" (ausência dita), reprovado aparece
 *   em bear com o primeiro motivo — carimbo verde sem auditoria real seria
 *   confirmação falsa.
 */

/** Roxo do §8 do operador — a mesma cor da linha de entrada no gráfico. */
const ROXO = "#a855f7";

/**
 * Tom do badge por estágio. Bull SÓ no CONFIRMED real; as saídas ruins
 * (INVALIDATED/EXPIRED/BREAKOUT_FAILED/RISK_REJECTED) em bear; os degraus do
 * rompimento em amber (atenção, não permissão); o resto neutro.
 */
const TOM_ESTAGIO: Record<SetupStage, string> = {
  CONFIRMED: "border-bull text-bull",
  INVALIDATED: "border-bear text-bear",
  EXPIRED: "border-bear text-bear",
  BREAKOUT_FAILED: "border-bear text-bear",
  RISK_REJECTED: "border-bear text-bear",
  BREAKOUT_CLOSED: "border-amber-500 text-amber-500",
  WAITING_SUSTAIN: "border-amber-500 text-amber-500",
  WAITING_BREAKOUT: "border-amber-500 text-amber-500",
  /*
   * A ESCADA DE APROXIMAÇÃO SOBE DE TOM, e não é enfeite: o operador
   * precisa distinguir de relance "olho nele" de "pode acontecer agora".
   * ARMED é âmbar como os degraus do rompimento — atenção, nunca
   * permissão. Nenhum destes três libera operação.
   */
  ARMED: "border-amber-500 text-amber-500",
  APPROACHING: "border-muted-foreground text-foreground",
  PRE_ALERT: "border-border text-muted-foreground",
  NONE: "border-border text-muted-foreground",
  DETECTED: "border-border text-muted-foreground",
  FORMING: "border-border text-muted-foreground",
  CLOSED: "border-border text-muted-foreground",
};

/** O rótulo humano de cada estágio — a máquina fala inglês, a tela fala com o operador. */
const ROTULO_ESTAGIO: Record<SetupStage, string> = {
  NONE: "SEM SETUP",
  DETECTED: "DETECTADO",
  FORMING: "EM FORMAÇÃO",
  PRE_ALERT: "NO RADAR",
  APPROACHING: "APROXIMANDO",
  ARMED: "ARMADO — AGUARDA FECHAMENTO",
  WAITING_BREAKOUT: "AGUARDANDO ROMPIMENTO",
  BREAKOUT_CLOSED: "ROMPIMENTO FECHADO",
  WAITING_SUSTAIN: "AGUARDANDO SUSTENTAÇÃO",
  CONFIRMED: "CONFIRMADO",
  BREAKOUT_FAILED: "ROMPIMENTO FALHOU",
  RISK_REJECTED: "RECUSADO PELO RISCO",
  CLOSED: "ENCERRADO",
  INVALIDATED: "INVALIDADO",
  EXPIRED: "EXPIRADO",
};

const ptBR = (n: number, opts?: Intl.NumberFormatOptions): string =>
  n.toLocaleString("pt-BR", opts);

/** R:R do setup — null sem os TRÊS níveis legíveis ou com risco zero. */
export function rrDoSetup(setup: TrackedSetup | null): number | null {
  if (setup === null || setup.entryLevel === null || setup.stop === null || setup.target === null) {
    return null;
  }
  const risco = Math.abs(setup.entryLevel - setup.stop);
  if (risco <= 0) return null;
  return Math.abs(setup.target - setup.entryLevel) / risco;
}

/** Texto da entrada roxa: zona quando existe, senão nível, senão ausência dita. */
export function textoEntrada(setup: TrackedSetup | null): string {
  if (setup === null) return NAO_IDENTIFICADO;
  if (setup.entryZone !== null) {
    return `${ptBR(setup.entryZone.min)} – ${ptBR(setup.entryZone.max)}`;
  }
  if (setup.entryLevel !== null) return ptBR(setup.entryLevel);
  return NAO_IDENTIFICADO;
}

/** Linha rótulo→valor no padrão dos demais cards do painel. */
function LinhaSetup({
  label,
  value,
  tom,
  estilo,
}: {
  label: string;
  value: string;
  tom?: string;
  estilo?: CSSProperties;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="nexus-eyebrow shrink-0">{label}</span>
      <span className={cn("truncate font-mono text-xs", tom)} style={estilo} title={value}>
        {value}
      </span>
    </div>
  );
}

export function SetupCard({ info, analise }: { info: SetupUpdate | null; analise: PrintAnalysis }) {
  // Caminhos em que a máquina não rodou (ex.: reabertura do histórico):
  // sem passo não há o que afirmar — nenhum card fingido.
  if (info === null) return null;

  /*
   * FONTE ÚNICA DA DIREÇÃO ATUAL.
   *
   * O card NÃO calcula viés: ele pergunta à mesma função que o painel de cima
   * usa (`deriveEntryDecision`), que já aplicou o veto do auditor. Enquanto
   * cada componente lia um campo diferente — o painel `analysis.direction`, o
   * card `setup.direction` —, a tela conseguia dizer NEUTRO e COMPRA ao mesmo
   * tempo sem que nenhum dos dois estivesse "errado".
   */
  const biasAtual = deriveEntryDecision(analise).bias;
  const setup = info.setup;
  const stage: SetupStage = setup?.stage ?? "NONE";
  const rr = rrDoSetup(setup);
  const distancia =
    info.distancePoints !== null
      ? `${ptBR(info.distancePoints)} pts${
          info.distancePercent !== null ? ` · ${ptBR(info.distancePercent)}%` : ""
        }`
      : NAO_IDENTIFICADO;

  // O headline segue o TOM do estágio real — nunca verde por otimismo.
  const tomHeadline =
    stage === "CONFIRMED"
      ? "text-bull"
      : stage === "INVALIDATED" ||
          stage === "EXPIRED" ||
          stage === "BREAKOUT_FAILED" ||
          stage === "RISK_REJECTED"
        ? "text-bear"
        : stage === "BREAKOUT_CLOSED" || stage === "WAITING_SUSTAIN" || info.preAlert
          ? "text-amber-500"
          : "text-muted-foreground";

  const entradaFraca = analise.confidences !== null && analise.confidences.entrada < 60;

  return (
    // Borda roxa: o card é o par da linha roxa do gráfico — mesmo assunto.
    <Card
      className="flex flex-col gap-2 bg-panel p-3"
      style={{ borderColor: "rgba(168, 85, 247, 0.5)" }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <p className="nexus-eyebrow" style={{ color: ROXO }}>
          SETUP T4
        </p>
        {setup !== null && (
          <span className="font-mono text-[10px] text-muted-foreground">{setup.setupId}</span>
        )}
        <Badge
          variant="outline"
          className={cn("ml-auto font-mono text-[10px]", TOM_ESTAGIO[stage])}
        >
          {ROTULO_ESTAGIO[stage]}
        </Badge>
      </div>

      {/* A INSTRUÇÃO DA VEZ — o headline vem pronto da máquina (§7). */}
      <p className={cn("font-mono text-xs font-bold leading-snug", tomHeadline)}>{info.headline}</p>

      {/*
       * §2 — AS TRÊS FRASES DO ROMPIMENTO FALHO, e a pausa do §4.
       *
       * Vêm prontas da máquina (`info.avisos`) e são exibidas literalmente. A
       * tela não reescreve nem resume: "ROMPIMENTO FALHOU / ENTRADA NÃO
       * CONFIRMADA / OPERAÇÃO BLOQUEADA" é o texto que o operador combinou, e
       * um sinônimo aqui reabriria a dúvida que essas frases fecham.
       */}
      {info.avisos.length > 0 && (
        <div className="flex flex-col gap-0.5 rounded border border-bear/60 bg-bear/10 px-2 py-1">
          {info.avisos.map((aviso) => (
            <p key={aviso} className="font-mono text-[11px] font-bold text-bear">
              {aviso}
            </p>
          ))}
        </div>
      )}

      {/*
       * §9 — as duas linhas que o operador lê antes de qualquer número.
       *
       * Separadas de propósito: "confirmada" é a prova técnica, "liberada" é a
       * permissão de operar. Elas coincidem por construção (a prova consulta o
       * mesmo gate de risco), e é a coincidência garantida por UMA fonte que
       * impede o painel de dizer sim numa linha e não na outra.
       */}
      <div className="grid grid-cols-2 gap-x-3 font-mono text-[10px]">
        <span className="text-muted-foreground">ENTRADA CONFIRMADA</span>
        <span className={info.entradaConfirmada ? "text-bull" : "text-bear"}>
          {info.entradaConfirmada ? "SIM" : "NÃO"}
        </span>
        <span className="text-muted-foreground">OPERAÇÃO LIBERADA</span>
        <span className={info.operacaoLiberada ? "text-bull" : "text-bear"}>
          {info.operacaoLiberada ? "SIM" : "NÃO"}
        </span>
      </div>

      {/* §8: enquanto não confirma, a tela DIZ que está aguardando. Silêncio
          aqui é o que fazia o operador ler viés como ordem. */}
      {!info.entradaConfirmada && setup !== null && (
        <p className="font-mono text-[11px] font-semibold text-amber-500">
          {biasAtual === setup.direction
            ? "AGUARDANDO CONFIRMAÇÃO"
            : "AGUARDANDO NOVA CONFIRMAÇÃO — o print atual não sustenta mais este lado"}
        </p>
      )}

      {info.preAlert && (
        <p className="rounded border border-amber-500/60 bg-amber-500/10 px-2 py-1 font-mono text-[11px] font-semibold text-amber-500">
          T4 PRÓXIMA — PREPARAR
        </p>
      )}

      {setup !== null && (
        <>
          <div className="flex flex-col gap-1">
            {/*
             * §8 — VIÉS ou AÇÃO, nunca os dois nomes para a mesma coisa.
             *
             * Sem entrada confirmada o rótulo é VIÉS e o valor sai em tom
             * NEUTRO: estrutura favorável não é ordem. Com a entrada
             * confirmada vira AÇÃO, aí sim em verde/vermelho — é a única
             * situação em que a tela pode dizer "COMPRA" como operação.
             */}
            {/*
             * DUAS DIREÇÕES SÓ APARECEM JUNTAS QUANDO SÃO DUAS DE VERDADE.
             *
             * O setup guarda o lado com que NASCEU; o print atual pode ter
             * outro — típico quando o auditor veta a direção e o viés volta a
             * NEUTRO. Exibir só o do setup fazia a tela dizer "VIÉS: COMPRA"
             * no card enquanto o painel de cima dizia "VIÉS: NEUTRO", e o
             * operador tinha de adivinhar qual valia.
             *
             * Quando batem, uma linha. Quando divergem, DUAS linhas rotuladas
             * — a do setup como histórico, a atual como o que vale agora.
             */}
            {biasAtual === setup.direction ? (
              <LinhaSetup
                label={info.entradaConfirmada ? "AÇÃO" : "VIÉS"}
                value={setup.direction}
                tom={
                  info.entradaConfirmada
                    ? setup.direction === "COMPRA"
                      ? "text-bull"
                      : "text-bear"
                    : "text-muted-foreground"
                }
              />
            ) : (
              <>
                <LinhaSetup
                  label="VIÉS DO SETUP"
                  value={`${setup.direction} (histórico)`}
                  tom="text-muted-foreground"
                />
                <LinhaSetup label="VIÉS ATUAL" value={biasAtual} tom="text-amber-500" />
              </>
            )}
            {/*
             * §9 — ENQUANTO NÃO CONFIRMA, O NÚMERO SE CHAMA GATILHO.
             *
             * "ENTRADA" numa tela que ainda não confirmou é a palavra que faz o
             * operador clicar. O nível é o mesmo; o nome muda com a permissão, e
             * é o nome que ele lê no meio do pregão.
             */}
            <LinhaSetup
              label={info.entradaConfirmada ? "ENTRADA CONFIRMADA" : "GATILHO"}
              value={textoEntrada(setup)}
              estilo={{ color: ROXO }}
            />
            {/* §9 — versão do gatilho: nível não muda em silêncio. */}
            {setup.trigger !== null && setup.triggerVersion > 1 && (
              <LinhaSetup
                label="GATILHO (VERSÃO)"
                value={`v${setup.triggerVersion} · ${ptBR(setup.trigger)} · ${setup.triggerHistory.length} registros`}
                tom="text-amber-500"
              />
            )}
            <LinhaSetup label="DISTÂNCIA" value={distancia} />
            <LinhaSetup
              label="STOP"
              value={setup.stop !== null ? ptBR(setup.stop) : NAO_IDENTIFICADO}
            />
            <LinhaSetup
              label="ALVO"
              value={setup.target !== null ? ptBR(setup.target) : NAO_IDENTIFICADO}
            />
            <LinhaSetup
              label="R:R"
              value={
                rr !== null
                  ? ptBR(rr, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                  : NAO_IDENTIFICADO
              }
            />
          </div>

          {/*
           * §1 — AS PERNAS DO ROMPIMENTO, UMA A UMA.
           *
           * Um "confirmado/não confirmado" único esconde QUAL prova faltou — e
           * foi exatamente essa opacidade que deixou um fechamento solitário
           * passar por entrada. Aqui o operador vê o que já tem e o que falta.
           */}
          {setup.breakout !== null && (
            <div className="flex flex-col gap-0.5 rounded border border-border/60 bg-background/50 p-2">
              <p className="nexus-eyebrow">ROMPIMENTO DO GATILHO {ptBR(setup.breakout.trigger)}</p>
              <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono text-[10px]">
                {(
                  [
                    ["Tocou o gatilho", setup.breakout.triggerTouched],
                    ["Fechou além", setup.breakout.breakoutClosed],
                    ["Sustentou", setup.breakout.breakoutSustained],
                    ["Reteste confirmado", setup.breakout.retestConfirmed],
                  ] as const
                ).map(([rotulo, ok]) => (
                  <span key={rotulo} className="contents">
                    <span className="text-muted-foreground">{rotulo}</span>
                    <span className={ok ? "text-bull" : "text-muted-foreground"}>
                      {ok ? "SIM" : "NÃO"}
                    </span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* O porquê do estágio — sempre presente na máquina, sempre dito aqui. */}
          <p className="text-[10px] leading-snug text-muted-foreground">{setup.reason}</p>
        </>
      )}

      {/* O QUE FALTA — enquanto não confirma, a lista é a instrução. */}
      {!info.entradaConfirmada && info.pendencias.length > 0 && (
        <div className="flex flex-col gap-0.5 rounded border border-border/60 bg-background/50 p-2">
          <p className="nexus-eyebrow">FALTA PARA CONFIRMAR</p>
          {info.pendencias.slice(0, 4).map((p, i) => (
            <p key={i} className="font-mono text-[10px] leading-snug text-muted-foreground">
              • {p}
            </p>
          ))}
        </div>
      )}

      {analise.confidences !== null && (
        <div className="flex flex-col gap-0.5">
          <p className="nexus-eyebrow">CONFIANÇA POR CAMADA</p>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono text-[11px]">
            <span className="text-muted-foreground">Contexto</span>
            <span>{analise.confidences.contexto}%</span>
            <span className="text-muted-foreground">Estrutura</span>
            <span>{analise.confidences.estrutura}%</span>
            <span className="text-muted-foreground">T4</span>
            <span>{analise.confidences.t4}%</span>
            <span className="text-muted-foreground">Entrada</span>
            {/* §12: entrada fraca não some no agregado — vira AGUARDAR dito. */}
            <span className={cn(entradaFraca && "text-bear")}>
              {analise.confidences.entrada}%{entradaFraca ? " → AGUARDAR" : ""}
            </span>
          </div>
        </div>
      )}

      {analise.audit === null ? (
        <p className="font-mono text-[10px] text-muted-foreground">AUDITOR: NÃO RODOU</p>
      ) : analise.audit.approved ? (
        <Badge variant="outline" className="w-fit border-bull font-mono text-[9px] text-bull">
          AUDITADO
        </Badge>
      ) : (
        <p className="font-mono text-[10px] text-bear">
          AUDITOR REPROVOU — {analise.audit.issues[0] ?? "motivo não informado"}
        </p>
      )}
    </Card>
  );
}
