"""Relatórios: CSVs de resultados e um HTML autocontido."""

from __future__ import annotations

import html
import json
import time
from pathlib import Path

import pandas as pd

from .contracts import spec_from_config
from .data import load_dataset
from .quality import quality_report
from .runner import current_val_table
from .state import State

TRAIN_COLS = ["operacoes", "liquido_brl", "custos_brl", "pf", "sharpe_anual", "max_dd_brl",
              "pct_pregoes_positivos", "meses_positivos", "meses", "puladas_por_risco"]

CSS = """
:root{--bg:#ffffff;--fg:#1d2433;--muted:#5b6475;--line:#d9dee7;--head:#f2f4f8;--warn:#9a3412;--warnbg:#fff4e5;
--ok:#166534;--okbg:#e9f7ee;--bad:#991b1b;--badbg:#fdecec}
@media (prefers-color-scheme: dark){:root{--bg:#11151c;--fg:#e6e9ef;--muted:#9aa3b2;--line:#2a313d;--head:#1a2029;
--warn:#fdba74;--warnbg:#2b1d10;--ok:#86efac;--okbg:#10251a;--bad:#fca5a5;--badbg:#2a1414}}
body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;padding:24px 16px}
main{max-width:1100px;margin:0 auto}h1{font-size:1.6rem;margin:.2rem 0}h2{font-size:1.2rem;margin-top:2rem;
border-bottom:1px solid var(--line);padding-bottom:.3rem}.muted{color:var(--muted)}
.banner{border-radius:8px;padding:12px 14px;margin:12px 0}.warn{background:var(--warnbg);color:var(--warn)}
.ok{background:var(--okbg);color:var(--ok)}.bad{background:var(--badbg);color:var(--bad)}
.scroll{overflow-x:auto}table{border-collapse:collapse;font-size:13px;margin:8px 0;min-width:100%}
th,td{border:1px solid var(--line);padding:4px 8px;text-align:left;white-space:nowrap}th{background:var(--head)}
"""


def _readable_times(df: pd.DataFrame, cols: tuple[str, ...]) -> pd.DataFrame:
    for col in cols:
        if col in df:
            df[col] = (pd.to_datetime(df[col], unit="s", utc=True).dt.tz_convert("America/Sao_Paulo")
                       .dt.strftime("%Y-%m-%d %H:%M:%S"))
    return df


def _table(df: pd.DataFrame, empty: str = "nada a mostrar") -> str:
    if df is None or df.empty:
        return f'<p class="muted">{html.escape(empty)}</p>'
    return '<div class="scroll">' + df.to_html(index=False, escape=True, border=0) + "</div>"


def build(db_path: str | Path, out_dir: str | Path, cfg: dict) -> dict:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    st = State(db_path)
    try:
        datasets = st.db.execute("SELECT * FROM datasets ORDER BY registered_at").fetchall()
        exp_rows, val_rows, test_rows, month_rows, wf_rows, quality_rows, split_rows = [], [], [], [], [], [], []
        for ds in datasets:
            dsid = ds["id"]
            for r in st.experiments(dsid):
                train = json.loads(r["train_json"] or "{}")
                exp_rows.append({"dataset": dsid, "simbolo": ds["symbol"], "tipo_dataset": ds["kind"], "experimento": r["id"],
                                 "familia": r["family"], "estrategia": r["strategy"], "parametros": r["params_json"],
                                 "codigo": r["code_version"], **{f"treino_{k}": train.get(k) for k in TRAIN_COLS}})
            for v in current_val_table(st, dsid, cfg):
                val_rows.append({"dataset": dsid, "tipo_dataset": ds["kind"], **v})
            frozen = {f["id"]: f for f in st.frozen(dsid)}
            for t in st.test_evals(dsid):
                m = json.loads(t["metrics_json"])
                gates = json.loads(t["gates_json"])
                payload = json.loads(frozen[t["frozen_id"]]["payload_json"]) if t["frozen_id"] in frozen else {}
                test_rows.append({"dataset": dsid, "simbolo": ds["symbol"], "tipo_dataset": ds["kind"],
                                  "congelado": t["frozen_id"], "tipo": payload.get("kind"),
                                  "estrategia": payload.get("strategy", payload.get("kind")),
                                  "parametros": json.dumps(payload.get("params", {k: payload.get(k) for k in
                                                                                  ("threshold", "members")}), ensure_ascii=False),
                                  "aprovado": bool(t["approved"]), **m,
                                  "falhas": ",".join(k for k, v in gates.items() if not v)})
                for mm in json.loads(t["monthly_json"]):
                    month_rows.append({"dataset": dsid, "congelado": t["frozen_id"], **mm})
            for w in st.db.execute("SELECT * FROM family_wf WHERE dataset_id=?", (dsid,)).fetchall():
                wf = json.loads(w["wf_json"])
                wf_rows.append({"dataset": dsid, "codigo": w["code_version"], "familia": w["family"],
                                **{k: wf.get(k) for k in ("dobras", "oos_liquido_brl", "oos_sharpe_diario", "dobras_positivas")}})
            sp = st.split(dsid)
            if sp:
                for phase, rng in json.loads(sp["ranges_json"]).items():
                    split_rows.append({"dataset": dsid, "fase": phase, **rng})
            if Path(ds["path"]).exists():
                try:
                    d = load_dataset(ds["path"])
                    q = quality_report(d, spec_from_config(cfg, ds["root"]), int(cfg["calendar"]["roll_days_before"]))
                    for c in q["checks"]:
                        quality_rows.append({"dataset": dsid, **c})
                except Exception as exc:  # noqa: BLE001
                    quality_rows.append({"dataset": dsid, "verificacao": "leitura", "status": "erro", "detalhe": str(exc)})
        rounds = _readable_times(pd.DataFrame([dict(r) for r in st.rounds()]), ("started_at", "finished_at"))
        alerts = _readable_times(pd.DataFrame([dict(a) for a in st.alerts()]), ("created_at",))
        frames = {
            "experimentos.csv": pd.DataFrame(exp_rows), "validacao.csv": pd.DataFrame(val_rows),
            "teste_final.csv": pd.DataFrame(test_rows), "mensal_teste.csv": pd.DataFrame(month_rows),
            "walk_forward.csv": pd.DataFrame(wf_rows), "qualidade_dados.csv": pd.DataFrame(quality_rows),
            "divisao_temporal.csv": pd.DataFrame(split_rows), "rodadas.csv": rounds, "alertas.csv": alerts,
        }
        for name, df in frames.items():
            df.to_csv(out / name, index=False)
        catalog = out / "catalogo_datasets.csv"
        catalog_df = pd.read_csv(catalog) if catalog.exists() else pd.DataFrame()
        html_path = out / "relatorio.html"
        html_path.write_text(_html(datasets, frames, catalog_df, cfg), encoding="utf-8")
        return {"html": str(html_path), "csv": sorted(frames)}
    finally:
        st.close()


def _html(datasets, frames: dict, catalog_df: pd.DataFrame, cfg: dict) -> str:
    kinds = {d["kind"] for d in datasets}
    parts = ["<!doctype html><html lang='pt-BR'><head><meta charset='utf-8'>",
             "<meta name='viewport' content='width=device-width, initial-scale=1'>",
             f"<title>Laboratório WIN/WDO</title><style>{CSS}</style></head><body><main>",
             "<h1>Laboratório quantitativo WIN/WDO</h1>",
             f"<p class='muted'>Gerado em {time.strftime('%Y-%m-%d %H:%M')} · pesquisa apenas, sem execução de ordens.</p>"]
    if not datasets:
        parts.append("<div class='banner warn'><b>Nenhum dataset processado.</b> Não há resultados de pesquisa: "
                     "coloque um CSV OHLC intradiário de WIN ou WDO em <code>quant-lab/data/</code> e rode "
                     "<code>python -m qlab run --data ...</code>.</div>")
    if "sintetico" in kinds:
        parts.append("<div class='banner bad'><b>Contém dataset SINTÉTICO.</b> Esses números vêm de dados aleatórios "
                     "gerados para testar o software. Não são resultado de mercado e não podem ser usados para "
                     "escolher estratégia.</div>")
    test = frames["teste_final.csv"]
    approved = test[test["aprovado"]] if not test.empty and "aprovado" in test else pd.DataFrame()
    if approved.empty:
        parts.append("<div class='banner warn'><b>Nenhum candidato aprovado no teste final.</b> Nenhuma estratégia "
                     "deve ser tratada como vencedora.</div>")
    else:
        parts.append(f"<div class='banner ok'><b>{len(approved)} candidato(s) aprovado(s) no teste final</b> em dados "
                     "reais. Ainda é pesquisa: confirme custos, margem e execução antes de qualquer uso.</div>")
    t = cfg["targets"]
    parts.append("<h2>Metas de seleção</h2><ul>"
                 f"<li>Capital R$ {cfg['capital']['capital_brl']:.2f}, até {cfg['capital']['max_contracts']} contratos.</li>"
                 f"<li>≥ {t['min_pct_positive_days_month']:.0%} de pregões positivos (entre os operados) em cada mês do teste, "
                 f"com pelo menos {t['min_traded_days_month']} pregões operados por mês.</li>"
                 f"<li>{t['min_pct_positive_months']:.0%} dos meses do teste positivos; líquido após custos e slippage &gt; 0.</li>"
                 f"<li>Deflated Sharpe ≥ {t['min_dsr']}, bootstrap com Bonferroni pelo orçamento de teste, drawdown ≤ "
                 f"{cfg['capital']['max_drawdown_frac']:.0%} do capital, margem compatível.</li></ul>"
                 "<p class='muted'>Metas não garantem resultado. Custos e margens da configuração são suposições a confirmar.</p>")
    parts.append("<h2>Catálogo de dados</h2>" + _table(catalog_df, "catálogo não gerado (rode qlab catalog)"))
    parts.append("<h2>Qualidade dos dados</h2>" + _table(frames["qualidade_dados.csv"]))
    parts.append("<h2>Divisão temporal 60/20/20</h2>" + _table(frames["divisao_temporal.csv"]))
    parts.append("<h2>Rodadas</h2>" + _table(frames["rodadas.csv"]))
    parts.append("<h2>Walk-forward por família (pré-teste)</h2>" + _table(frames["walk_forward.csv"]))
    exp = frames["experimentos.csv"]
    if not exp.empty:
        exp = exp.sort_values("treino_sharpe_anual", ascending=False).head(25)
    parts.append("<h2>Melhores configurações no treino (top 25)</h2>"
                 "<p class='muted'>Ranking dentro da amostra de treino; não é evidência de desempenho futuro.</p>"
                 + _table(exp))
    parts.append("<h2>Validação</h2>" + _table(frames["validacao.csv"]))
    parts.append("<h2>Teste final (parâmetros congelados, avaliado uma vez)</h2>" + _table(test))
    parts.append("<h2>Resultado mensal no teste</h2>" + _table(frames["mensal_teste.csv"]))
    parts.append("<h2>Alertas</h2>" + _table(frames["alertas.csv"], "nenhum alerta: nenhum candidato superou a validação real"))
    parts.append("<h2>Limitações</h2><ul>"
                 "<li>Execução simulada em barras: ordem real dentro da barra desconhecida (stop primeiro quando ambíguo).</li>"
                 "<li>Sem livro de ofertas: microestrutura só roda se o CSV trouxer volume de agressão comprador/vendedor.</li>"
                 "<li>Calendário B3 derivado por regra; divergências com os dados aparecem em Qualidade.</li>"
                 "<li>Teste final curto (20% do histórico): poucos meses, pouca confiança estatística.</li></ul>")
    parts.append("</main></body></html>")
    return "\n".join(parts)
