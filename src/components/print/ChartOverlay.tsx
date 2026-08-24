import { Fragment, type CSSProperties } from "react";

import type { Annotation } from "@/lib/vision/printAnalysis";
import { ANNOTATION_COLOR, podeDesenharAnotacao } from "@/lib/vision/printAnalysis";

/**
 * MARCAÇÕES SOBRE O PRINT — em SVG, por cima, sem tocar na imagem.
 *
 * A imagem original é um `<img>` intacto. O overlay é um `<svg>` irmão, em
 * `viewBox="0 0 1 1"` com `preserveAspectRatio="none"`, ocupando exatamente a
 * mesma caixa. Como as coordenadas chegam normalizadas (0–1), cada traço cai
 * sobre o mesmo pixel do gráfico em qualquer largura de tela — desktop, mobile,
 * com zoom ou depois de redimensionar a janela.
 *
 * POR QUE NÃO DESENHAR NA IMAGEM: gerar um PNG novo com as marcações queimadas
 * destruiria a comparação original × analisado, impediria esconder camadas e
 * exigiria reprocessar a imagem a cada resize. Aqui o original nunca é alterado.
 *
 * A ESPESSURA É COMPENSADA. Num viewBox de 1×1, uma linha de `strokeWidth: 2`
 * ficaria 2 vezes a altura da imagem. Todo traço usa unidades relativas e
 * `vectorEffect="non-scaling-stroke"`, que mantém a espessura em pixels reais
 * independentemente da escala.
 *
 * DIVISÃO DE TRABALHO ENTRE AS DUAS CAMADAS: o SVG só desenha traços e áreas
 * (linhas, bandas, setas), porque `vectorEffect` compensa APENAS strokes — um
 * `<text>` ou um polígono preenchido dentro do viewBox 1×1 seria esticado de
 * forma não uniforme pelo `preserveAspectRatio="none"` e sairia distorcido.
 * Todo texto (pills de rótulo, etiquetas de preço) e o triângulo da entrada
 * vivem em `OverlayLabels`, camada HTML posicionada por porcentagem, onde a
 * geometria tem tamanho fixo em pixels e a fonte renderiza nítida.
 */

/** Lado da entrada sinalizada — vem de `analysis.direction`, nunca inventado. */
export type EntrySide = "COMPRA" | "VENDA";

export interface OverlayProps {
  annotations: Annotation[];
  /** Camadas escondidas pelo operador. */
  hidden?: Set<string>;
  onSelect?: (annotation: Annotation) => void;
  selected?: Annotation | null;
  /**
   * Lado da entrada CONFIRMADA. Null enquanto houver apenas viés — e é por
   * isso que o triângulo e o texto "ENTRADA COMPRA/VENDA" somem antes da
   * confirmação: sinalização de ordem sem ordem liberada é o defeito que a
   * separação viés × entrada existe para matar. A linha roxa continua,
   * porque ela diz ONDE entraria, não que se deve entrar.
   */
  entrySide?: EntrySide | null;
}

/** Fundo escuro semitransparente dos pills — #0b1220 a 0.85, legível sobre qualquer candle. */
const FUNDO_PILL = "rgba(11, 18, 32, 0.85)";
/** Vermelho de venda: a cor do kind ENTRY_* é verde, mas venda em verde confundiria o lado. */
const VERMELHO_VENDA = "#ef4444";
const VERDE_COMPRA = "#22c55e";
/** Pills truncam acima disto; o texto completo permanece no title=. */
const MAX_CHARS_PILL = 40;
/** Trecho numérico do label que vira etiqueta de preço na borda direita. */
const PRECO_RE = /\d{3}\.\d{3}|\d+[.,]\d+/;

const LINHAS: Annotation["kind"][] = [
  "ENTRY_LINE",
  "STOP",
  "TARGET",
  "INVALIDATION",
  "SUPPORT",
  "RESISTANCE",
];
const ZONAS: Annotation["kind"][] = ["ENTRY_ZONE", "T4_PAST", "BREAKOUT", "PULLBACK"];
/** Zonas institucionais da leitura completa: banda de borda a borda quando têm altura. */
const BANDAS: Annotation["kind"][] = ["SUPPLY_ZONE", "DEMAND_ZONE", "ATTENTION_ZONE"];

/** y2 presente e diferente de y1 — sem altura, banda degrada para linha. */
function temAltura(a: Annotation): boolean {
  return a.y2 !== null && a.y2 !== a.y1;
}

/**
 * O que vira banda: as três zonas institucionais com altura, e também
 * SUPPORT/RESISTANCE quando chegam com y2 ≠ y1 (faixa estrutural, não nível).
 */
function ehBanda(a: Annotation): boolean {
  if (BANDAS.includes(a.kind)) return temAltura(a);
  return (a.kind === "SUPPORT" || a.kind === "RESISTANCE") && temAltura(a);
}

/**
 * Cor efetiva da marcação. Uma exceção à tabela ANNOTATION_COLOR:
 * — SCENARIO_ARROW segue o texto do próprio label: COMPRA verde, VENDA
 *   vermelho, senão o amarelo padrão do kind.
 *
 * A ENTRADA é sempre ROXA (§8 do operador): o roxo é a identidade da linha
 * "ENTRAR SE TOCAR AQUI" nos dois lados — quem diz o lado é o TRIÂNGULO
 * (▲ compra / ▼ venda) e o label, não a cor. A regra antiga (venda pinta a
 * entrada de vermelho) misturava a cor da entrada com a cor do stop.
 */
function corDe(a: Annotation, entrySide?: EntrySide | null): string {
  if (a.kind === "SCENARIO_ARROW") {
    const texto = a.label.toUpperCase();
    if (texto.includes("COMPRA")) return VERDE_COMPRA;
    if (texto.includes("VENDA")) return VERMELHO_VENDA;
  }
  // §7: a seta da confirmação é VERDE na compra e VERMELHA na venda — ela
  // anuncia a ORDEM liberada, e só aparece quando a entrada foi confirmada.
  if (a.kind === "CONFIRMATION_CANDLE" && entrySide) {
    return entrySide === "COMPRA" ? VERDE_COMPRA : VERMELHO_VENDA;
  }
  return ANNOTATION_COLOR[a.kind];
}

/**
 * SETA DO CANDLE DE CONFIRMAÇÃO — o "aqui confirmou", em cima do candle.
 *
 * Desenhada como traço vertical curto apontando para o candle: na compra sobe
 * de baixo para cima até o ponto, na venda desce. A ponta é montada em
 * OverlayLabels (polígono preenchido no viewBox 1×1 sairia distorcido).
 */
function ConfirmationMark({
  a,
  entrySide,
  ativo,
  onSelect,
}: {
  a: Annotation;
  entrySide?: EntrySide | null;
  ativo: boolean;
  onSelect?: () => void;
}) {
  const cor = corDe(a, entrySide);
  // Haste de ~8% da altura, do lado de fora do candle: compra vem de baixo.
  const comprimento = 0.08;
  const origem = entrySide === "VENDA" ? a.y1 - comprimento : a.y1 + comprimento;
  return (
    <g onClick={onSelect} style={{ cursor: onSelect ? "pointer" : "default" }}>
      <line
        x1={a.x1}
        y1={origem}
        x2={a.x1}
        y2={a.y1}
        stroke={cor}
        strokeWidth={ativo ? 5 : 4}
        vectorEffect="non-scaling-stroke"
      />
      {/* Halo: destaca a confirmação sem depender de filtro SVG. */}
      <line
        x1={a.x1}
        y1={origem}
        x2={a.x1}
        y2={a.y1}
        stroke={cor}
        strokeWidth={10}
        opacity={0.22}
        vectorEffect="non-scaling-stroke"
      />
    </g>
  );
}

/** Linha horizontal de preço: atravessa a imagem inteira na altura do nível. */
function PriceLine({
  a,
  onSelect,
  ativo,
  entrySide,
}: {
  a: Annotation;
  onSelect?: () => void;
  ativo: boolean;
  entrySide?: EntrySide | null;
}) {
  const cor = corDe(a, entrySide);
  const entrada = a.kind === "ENTRY_LINE";
  // Bandas sem altura degradam para linha e mantêm o caráter do traço:
  // ATTENTION_ZONE continua tracejada mesmo achatada em nível único.
  const tracejado =
    !entrada &&
    (a.kind === "INVALIDATION" ||
      a.kind === "SUPPORT" ||
      a.kind === "RESISTANCE" ||
      a.kind === "ATTENTION_ZONE");
  // ENTRADA é a linha mais importante do gráfico: mais grossa e sempre sólida.
  const espessura = entrada ? (ativo ? 5 : 4) : ativo ? 3 : 2;
  return (
    <g onClick={onSelect} style={{ cursor: onSelect ? "pointer" : "default" }}>
      {/* Faixa invisível larga: alvo de clique confortável mesmo no mobile. */}
      <line
        x1={0}
        y1={a.y1}
        x2={1}
        y2={a.y1}
        stroke="transparent"
        strokeWidth={12}
        vectorEffect="non-scaling-stroke"
      />
      {entrada && (
        // Glow: a mesma linha por baixo, grossa e translúcida. Halo sem filtro
        // SVG (filtros seriam esticados pelo preserveAspectRatio="none").
        <line
          x1={0}
          y1={a.y1}
          x2={1}
          y2={a.y1}
          stroke={cor}
          strokeWidth={9}
          opacity={0.25}
          vectorEffect="non-scaling-stroke"
        />
      )}
      <line
        x1={0}
        y1={a.y1}
        x2={1}
        y2={a.y1}
        stroke={cor}
        strokeWidth={espessura}
        strokeDasharray={tracejado ? "6 4" : undefined}
        vectorEffect="non-scaling-stroke"
        opacity={0.95}
      />
    </g>
  );
}

/**
 * Banda institucional: retângulo de borda a borda (x = 0..1) entre y1 e y2,
 * como no mockup da leitura completa. Oferta/demanda com borda sólida;
 * atenção e suporte/resistência em faixa mantêm o tracejado que já os
 * identifica como nível derivado, não zona de ordem.
 */
function Banda({
  a,
  onSelect,
  ativo,
  entrySide,
}: {
  a: Annotation;
  onSelect?: () => void;
  ativo: boolean;
  entrySide?: EntrySide | null;
}) {
  const cor = corDe(a, entrySide);
  const y = Math.min(a.y1, a.y2 ?? a.y1);
  const h = Math.abs((a.y2 ?? a.y1) - a.y1);
  const tracejada = a.kind === "ATTENTION_ZONE" || a.kind === "SUPPORT" || a.kind === "RESISTANCE";
  const opacidade =
    a.kind === "ATTENTION_ZONE"
      ? 0.1
      : a.kind === "SUPPORT" || a.kind === "RESISTANCE"
        ? 0.12
        : 0.14;
  return (
    <g onClick={onSelect} style={{ cursor: onSelect ? "pointer" : "default" }}>
      <rect
        x={0}
        y={y}
        width={1}
        height={h}
        fill={cor}
        fillOpacity={opacidade}
        stroke={cor}
        strokeWidth={ativo ? 3 : 2}
        strokeDasharray={tracejada ? "6 4" : undefined}
        vectorEffect="non-scaling-stroke"
      />
    </g>
  );
}

/** Zona: retângulo semitransparente com borda. */
function Zone({
  a,
  onSelect,
  ativo,
  entrySide,
}: {
  a: Annotation;
  onSelect?: () => void;
  ativo: boolean;
  entrySide?: EntrySide | null;
}) {
  const cor = corDe(a, entrySide);
  const x = Math.min(a.x1, a.x2 ?? a.x1);
  const y = Math.min(a.y1, a.y2 ?? a.y1);
  const w = Math.abs((a.x2 ?? a.x1) - a.x1);
  const h = Math.abs((a.y2 ?? a.y1) - a.y1);
  return (
    <g onClick={onSelect} style={{ cursor: onSelect ? "pointer" : "default" }}>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        fill={cor}
        fillOpacity={a.kind === "T4_PAST" ? 0.16 : 0.12}
        stroke={cor}
        strokeWidth={ativo ? 3 : 2}
        vectorEffect="non-scaling-stroke"
      />
    </g>
  );
}

/** Seta de cenário — condicional, nunca uma previsão. */
function Arrow({ a, ativo }: { a: Annotation; ativo: boolean }) {
  const cor = corDe(a);
  const x2 = a.x2 ?? a.x1;
  const y2 = a.y2 ?? a.y1;
  const id = `seta-${a.label.replace(/\W/g, "")}-${Math.round(a.x1 * 1000)}`;
  return (
    <g>
      <defs>
        <marker
          id={id}
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill={cor} />
        </marker>
      </defs>
      <line
        x1={a.x1}
        y1={a.y1}
        x2={x2}
        y2={y2}
        stroke={cor}
        strokeWidth={ativo ? 4 : 3}
        strokeDasharray="5 4"
        markerEnd={`url(#${id})`}
        vectorEffect="non-scaling-stroke"
        opacity={0.9}
      />
    </g>
  );
}

export function ChartOverlay({ annotations, hidden, onSelect, selected, entrySide }: OverlayProps) {
  const visiveis = annotations.filter((a) => !hidden?.has(a.kind));

  return (
    <svg
      viewBox="0 0 1 1"
      preserveAspectRatio="none"
      className="pointer-events-auto absolute inset-0 h-full w-full"
      aria-label="Marcações da análise sobre o print"
    >
      {visiveis.map((a, i) => {
        const ativo = selected === a;
        const chave = `${a.kind}-${i}`;
        if (ehBanda(a)) {
          return (
            <Banda
              key={chave}
              a={a}
              ativo={ativo}
              entrySide={entrySide}
              onSelect={() => onSelect?.(a)}
            />
          );
        }
        // Bandas sem altura (y2 ausente ou igual a y1) degradam para linha.
        if (LINHAS.includes(a.kind) || BANDAS.includes(a.kind)) {
          return (
            <PriceLine
              key={chave}
              a={a}
              ativo={ativo}
              entrySide={entrySide}
              onSelect={() => onSelect?.(a)}
            />
          );
        }
        if (ZONAS.includes(a.kind)) {
          return (
            <Zone
              key={chave}
              a={a}
              ativo={ativo}
              entrySide={entrySide}
              onSelect={() => onSelect?.(a)}
            />
          );
        }
        if (a.kind === "SCENARIO_ARROW") return <Arrow key={chave} a={a} ativo={ativo} />;
        if (a.kind === "CONFIRMATION_CANDLE") {
          /*
           * A SETA SÓ EXISTE COM `entrySide` — que é, por contrato, "a entrada
           * foi confirmada". A marcação pode sobreviver na análise quando o
           * PRINT prova a confirmação mas a MÁQUINA de setup ainda não libera
           * (o preço não tocou a linha roxa) — e aí o gráfico não pode gritar
           * "✓ CONFIRMOU" enquanto o card diz AGUARDANDO. Diante da
           * contradição o operador obedece ao gráfico; então o gráfico cala.
           */
          if (!podeDesenharAnotacao(a, entrySide ?? null)) return null;
          return (
            <ConfirmationMark
              key={chave}
              a={a}
              ativo={ativo}
              entrySide={entrySide}
              onSelect={() => onSelect?.(a)}
            />
          );
        }
        return null;
      })}
    </svg>
  );
}

/**
 * Texto do pill: só dados que já chegaram — label, index e, na entrada,
 * o lado vindo de `analysis.direction`. Nada é inventado aqui.
 */
function textoDoPill(a: Annotation, entrySide?: EntrySide | null): string {
  let texto = a.label.trim();
  if (a.kind === "ENTRY_LINE" && entrySide) {
    // Pedido explícito do operador: a entrada se anuncia com o lado.
    // Um "ENTRADA" que já venha no label é absorvido para não duplicar.
    const resto = texto.replace(/^entrada\s*/i, "").trim();
    texto = resto.length > 0 ? `ENTRADA ${entrySide} · ${resto}` : `ENTRADA ${entrySide}`;
  }
  if (a.kind === "CONFIRMATION_CANDLE") {
    const resto = texto.replace(/^confirma\w*\s*/i, "").trim();
    const lado = entrySide ? ` ${entrySide}` : "";
    texto = resto.length > 0 ? `✓ CONFIRMOU${lado} · ${resto}` : `✓ CONFIRMOU${lado}`;
  }
  if (a.index !== null) texto = `T4 #${a.index} · ${texto}`;
  return texto;
}

/**
 * Rótulos em camada HTML, não SVG.
 *
 * Texto dentro de um viewBox 1×1 seria esticado junto com a imagem e ficaria
 * ilegível em telas largas (vectorEffect compensa strokes, não glifos — e o
 * mesmo vale para foreignObject). Em HTML posicionado por porcentagem, a fonte
 * tem tamanho real e constante. Pelo mesmo motivo o triângulo da entrada mora
 * aqui: um polígono preenchido no SVG sairia com proporção distorcida.
 *
 * Três elementos por marcação, todos condicionais aos dados:
 * — pill de rótulo (fundo #0b1220 a 0.85, texto na cor do kind), dentro da
 *   banda/zona à esquerda ou logo acima da linha; label vazio ⇒ sem pill;
 * — etiqueta de preço colada na borda direita quando o label contém número,
 *   como as etiquetas do eixo de preço do próprio Profit;
 * — triângulo sólido da entrada junto à borda esquerda: para cima na compra,
 *   para baixo na venda.
 */
export function OverlayLabels({
  annotations,
  hidden,
  onSelect,
  entrySide,
}: {
  annotations: Annotation[];
  hidden?: Set<string>;
  onSelect?: (a: Annotation) => void;
  entrySide?: EntrySide | null;
}) {
  const visiveis = annotations.filter(
    // Mesma lei do overlay: sem entrada confirmada, nada de rótulo "✓ CONFIRMOU"
    // nem ponta de seta — a camada de texto não pode afirmar o que o traço cala.
    (a) => !hidden?.has(a.kind) && podeDesenharAnotacao(a, entrySide ?? null),
  );
  return (
    <div className="pointer-events-none absolute inset-0">
      {visiveis.map((a, i) => {
        const cor = corDe(a, entrySide);
        const banda = ehBanda(a);
        // Bandas degradadas (sem altura) se comportam como linha também aqui.
        const linha = !banda && (LINHAS.includes(a.kind) || BANDAS.includes(a.kind));
        const zona = !banda && !linha && ZONAS.includes(a.kind);
        const yTopo = Math.min(a.y1, a.y2 ?? a.y1);
        const yCentro = (a.y1 + (a.y2 ?? a.y1)) / 2;

        const cheio = textoDoPill(a, entrySide);
        // Requisito D: a entrada anuncia o lado mesmo que o label venha vazio.
        const mostraPill = cheio.length > 0;
        const curto =
          cheio.length > MAX_CHARS_PILL ? `${cheio.slice(0, MAX_CHARS_PILL - 1)}…` : cheio;

        // Etiqueta de preço na borda direita: só o trecho numérico do label,
        // e só para linhas e bandas (níveis que atravessam o gráfico).
        const preco = linha || banda ? (PRECO_RE.exec(a.label)?.[0] ?? null) : null;

        // Posição do pill: dentro da banda/zona (canto superior esquerdo) ou
        // logo acima da linha. NOTE e afins ficam centrados no ponto, como antes.
        const estiloPill: CSSProperties = linha
          ? {
              // A entrada com lado sinalizado abre espaço para o triângulo.
              left: a.kind === "ENTRY_LINE" && entrySide ? "22px" : "1.2%",
              top: `${a.y1 * 100}%`,
              transform: "translateY(calc(-100% - 3px))",
            }
          : banda
            ? { left: "1%", top: `${yTopo * 100}%`, marginTop: "3px" }
            : zona
              ? {
                  left: `${Math.max(Math.min(a.x1, a.x2 ?? a.x1), 0.005) * 100}%`,
                  top: `${yTopo * 100}%`,
                  marginTop: "3px",
                }
              : {
                  left: `${a.x1 * 100}%`,
                  top: `${a.y1 * 100}%`,
                  transform: "translateY(-50%)",
                };

        return (
          <Fragment key={`${a.kind}-label-${i}`}>
            {mostraPill && (
              <button
                type="button"
                onClick={() => onSelect?.(a)}
                className="pointer-events-auto absolute whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-medium leading-tight backdrop-blur-[2px]"
                style={{
                  ...estiloPill,
                  color: cor,
                  backgroundColor: FUNDO_PILL,
                  border: `1px solid ${cor}`,
                }}
                title={a.reason ? `${cheio} — ${a.reason}` : cheio}
              >
                {curto}
              </button>
            )}
            {preco !== null && (
              <span
                className="absolute whitespace-nowrap px-1 py-px font-mono text-[9px] font-semibold leading-tight"
                style={{
                  right: 0,
                  top: `${(banda ? yCentro : a.y1) * 100}%`,
                  transform: "translateY(-50%)",
                  // Etiqueta estilo Profit: fundo sólido na cor do nível,
                  // texto escuro, cantos retos do lado colado ao eixo.
                  backgroundColor: cor,
                  color: "#0b1220",
                  borderRadius: "3px 0 0 3px",
                }}
              >
                {preco}
              </span>
            )}
            {a.kind === "ENTRY_LINE" && entrySide && (
              // Triângulo da entrada: sólido, junto à borda esquerda, sobre a
              // linha. Para cima = compra (verde); para baixo = venda (vermelho).
              <span
                aria-hidden
                className="absolute"
                style={{
                  left: "3px",
                  top: `${a.y1 * 100}%`,
                  transform: "translateY(-50%)",
                  width: 0,
                  height: 0,
                  borderLeft: "7px solid transparent",
                  borderRight: "7px solid transparent",
                  ...(entrySide === "COMPRA"
                    ? { borderBottom: `12px solid ${cor}` }
                    : { borderTop: `12px solid ${cor}` }),
                }}
              />
            )}
            {a.kind === "CONFIRMATION_CANDLE" && (
              // Ponta da seta encostando no candle que confirmou: aponta para
              // CIMA na compra (a haste sobe por baixo) e para BAIXO na venda.
              <span
                aria-hidden
                className="absolute"
                style={{
                  left: `${a.x1 * 100}%`,
                  top: `${a.y1 * 100}%`,
                  transform: "translate(-50%, -50%)",
                  width: 0,
                  height: 0,
                  borderLeft: "8px solid transparent",
                  borderRight: "8px solid transparent",
                  ...(entrySide === "VENDA"
                    ? { borderTop: `14px solid ${cor}` }
                    : { borderBottom: `14px solid ${cor}` }),
                }}
              />
            )}
          </Fragment>
        );
      })}
    </div>
  );
}
