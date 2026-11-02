"""Rodada delimitada: busca (treino) -> seleção -> validação -> congelamento -> teste final.

A rodada sempre termina: o laço de busca para no orçamento de experimentos, no orçamento
de tempo, na fila vazia ou em Ctrl+C. O que já terminou fica gravado no SQLite e a próxima
rodada continua do ponto em que parou (experimentos já feitos são pulados pelo hash).
"""

from __future__ import annotations

import json
import multiprocessing
import os
import signal
import statistics
import time
from collections import defaultdict
from concurrent.futures import FIRST_COMPLETED, ProcessPoolExecutor, wait
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import numpy as np
import pandas as pd

from . import gpu, ml
from .backtest import Market, daily_pnl, daily_trades, simulate
from .contracts import ContractSpec, spec_from_config
from .data import Dataset, load_dataset
from .features import build_features
from .metrics import monthly_table, summarize
from .quality import clean_bars, quality_report, roll_days_for
from .state import State, code_version, config_fingerprint, stable_hash, unblob
from .stats import bonferroni, deflated_sharpe, holm_adjust, stationary_bootstrap_pvalue
from .strategies import BY_NAME, available_strategies, ensemble_signal, features_dict, round_robin_queue
from .validation import split_description, split_masks, test_gates, train_filter, val_gates, walk_forward

Log = Callable[[str], None]


@dataclass
class Context:
    cfg: dict
    ds: Dataset
    spec: ContractSpec
    feat: pd.DataFrame
    F: dict
    market: Market
    masks: dict
    capabilities: set
    quality: dict
    version: str
    split_hash: str = ""

    @property
    def dataset_id(self) -> str:
        return self.ds.dataset_id

    @property
    def n_train(self) -> int:
        return int(self.masks["train"].sum())


def prepare(data_path: str | Path, cfg: dict, root: str | None = None) -> Context:
    ds = load_dataset(data_path, root_override=root)
    if ds.root is None:
        raise ValueError(f"não identifiquei WIN/WDO pelo símbolo {ds.symbol!r}; informe --root WIN ou --root WDO")
    if ds.timeframe_min is None:
        raise ValueError("o arquivo não parece intradiário (timeframe não inferido)")
    spec = spec_from_config(cfg, ds.root)
    clean, _ = clean_bars(ds, spec)
    days = sorted({d.date() for d in clean["ts"].dt.normalize().drop_duplicates()})
    rolls = set()
    if cfg["calendar"]["roll_mode"] == "calendar":
        rolls = roll_days_for(ds.root, days, int(cfg["calendar"]["roll_days_before"]))
    feat = build_features(clean, rolls)
    market = Market.from_features(feat, spec, cfg)
    masks = split_masks(market.n_days, cfg["split"])
    caps = set()
    if feat["vwap"].notna().any():
        caps.add("vwap")
    if feat["delta_ratio"].notna().any():
        caps.add("agressao")
    return Context(cfg=cfg, ds=ds, spec=spec, feat=feat, F=features_dict(feat, spec.tick_size), market=market,
                   masks=masks, capabilities=caps, quality=quality_report(ds, spec, int(cfg["calendar"]["roll_days_before"])),
                   version=f"{code_version()}-{config_fingerprint(cfg)}")


def experiment_id(ctx: Context, strategy: str, params: dict) -> str:
    return stable_hash({"dataset": ctx.dataset_id, "split": ctx.split_hash, "code": ctx.version,
                        "strategy": strategy, "params": params})[:20]


def run_config(ctx: Context, exp_id: str, strategy: str, params: dict) -> dict:
    s = BY_NAME[strategy]
    rec = {"id": exp_id, "dataset_id": ctx.dataset_id, "code_version": ctx.version, "family": s.family,
           "strategy": strategy, "params_json": json.dumps(params, sort_keys=True)}
    try:
        sig = s.fn(ctx.F, params)
        trades = simulate(ctx.market, sig, float(params["stop_atr"]), float(params["target_r"]), ctx.masks["pre"])
        pre = ctx.masks["pre"]
        rec.update(status="ok", train=summarize(ctx.market, trades, ctx.masks["train"]),
                   pre_pnl=daily_pnl(ctx.market, trades)[pre], pre_ntr=daily_trades(ctx.market, trades)[pre])
    except Exception as exc:  # noqa: BLE001 - erro de uma configuração não derruba a rodada
        rec.update(status="erro", error=f"{type(exc).__name__}: {exc}")
    return rec


_WORKER: dict = {}


def _worker_init(data_path: str, cfg: dict, root: str | None, split_hash: str) -> None:
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    ctx = prepare(data_path, cfg, root)
    ctx.split_hash = split_hash
    _WORKER["ctx"] = ctx


def _worker_batch(batch: list[tuple[str, str, dict]]) -> list[dict]:
    ctx = _WORKER["ctx"]
    return [run_config(ctx, exp_id, name, params) for exp_id, name, params in batch]


def _write_checkpoint(path: Path, data: dict) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    os.replace(tmp, path)


def run_round(data_path: str | Path, cfg: dict, db_path: str | Path, root: str | None = None,
              families: set[str] | None = None, run_test: bool = True, log: Log = print) -> dict:
    run_cfg = cfg["run"]
    started = time.time()
    deadline = started + float(run_cfg["max_minutes"]) * 60.0
    max_exp = int(run_cfg["max_experiments"])
    workers = int(run_cfg["workers"]) or max(1, (os.cpu_count() or 2) - 1)
    db_path = Path(db_path)
    state_dir = db_path.parent
    models_dir = state_dir / "models"
    checkpoint = state_dir / "checkpoint.json"

    # Falha cedo se device=cuda foi exigido e não existe, antes de gastar a busca.
    device = gpu.choose_device(run_cfg["device"]) if (not families or "ml" in families) else "cpu"
    ctx = prepare(data_path, cfg, root)
    st = State(db_path)
    days = ctx.market.days
    st.register_dataset(ctx.ds, str(days[0]), str(days[-1]), ctx.market.n_days)
    ctx.split_hash = st.ensure_split(ctx.dataset_id, cfg["split"], split_description(days, ctx.masks))
    budget = {"max_experiments": max_exp, "max_minutes": run_cfg["max_minutes"], "workers": workers,
              "familias": sorted(families) if families else "todas"}
    round_id = st.start_round(ctx.dataset_id, budget)
    log(f"[rodada {round_id}] dataset {ctx.ds.symbol} ({ctx.ds.kind}) {ctx.dataset_id} | "
        f"{ctx.market.n_days} pregões | código {ctx.version}")
    if ctx.ds.kind != "real":
        log("AVISO: dataset sintético — serve só para testar o encanamento; nenhum resultado vale como pesquisa.")

    stop = {"flag": False}
    previous = {}

    def _handler(signum, _frame):
        stop["flag"] = True
        log(f"sinal {signum} recebido: terminando o lote atual e salvando o estado")

    for sig_num in (signal.SIGINT, signal.SIGTERM):
        try:
            previous[sig_num] = signal.signal(sig_num, _handler)
        except ValueError:  # fora da thread principal
            pass

    status = "concluida"
    n_done = 0
    try:
        strategies, skipped = available_strategies(ctx.capabilities)
        if families:
            strategies = [s for s in strategies if s.family in families]
        for name, why in skipped.items():
            log(f"  pulada: {name} — {why}")
        queue = round_robin_queue(strategies)
        done = st.done_ids(ctx.dataset_id, ctx.version)
        pending = [(experiment_id(ctx, n, p), n, p) for n, p in queue]
        pending = [item for item in pending if item[0] not in done]
        log(f"  fila: {len(queue)} configurações, {len(queue) - len(pending)} já feitas, {len(pending)} pendentes")

        def _stop_reason() -> str | None:
            if stop["flag"]:
                return "interrompida"
            if n_done >= max_exp:
                return "orcamento_experimentos"
            if time.time() >= deadline:
                return "orcamento_tempo"
            return None

        def _save(records: list[dict]) -> None:
            nonlocal n_done
            for rec in records:
                st.save_experiment(rec, round_id)
            st.commit()
            n_done += len(records)
            _write_checkpoint(checkpoint, {"rodada": round_id, "dataset": ctx.dataset_id, "feitos_na_rodada": n_done,
                                           "pendentes": max(0, len(pending) - n_done), "atualizado": time.time()})

        bs = max(1, int(run_cfg["batch_size"]))
        batches = [pending[i:i + bs] for i in range(0, len(pending), bs)]
        if workers > 1 and len(batches) > 1:
            mp_ctx = multiprocessing.get_context("spawn")
            with ProcessPoolExecutor(max_workers=workers, mp_context=mp_ctx, initializer=_worker_init,
                                     initargs=(str(data_path), cfg, root, ctx.split_hash)) as pool:
                in_flight, it = set(), iter(batches)
                submitted = 0
                while True:
                    while len(in_flight) < workers * 2 and _stop_reason() is None:
                        batch = next(it, None)
                        if batch is None:
                            break
                        batch = batch[: max(0, max_exp - submitted)]
                        if not batch:
                            break
                        in_flight.add(pool.submit(_worker_batch, batch))
                        submitted += len(batch)
                    if not in_flight:
                        break
                    finished, in_flight = wait(in_flight, return_when=FIRST_COMPLETED)
                    for fut in finished:
                        _save(fut.result())
        else:
            for batch in batches:
                if _stop_reason():
                    break
                batch = batch[: max(0, max_exp - n_done)]
                _save([run_config(ctx, *item) for item in batch])
        reason = _stop_reason()
        if reason == "interrompida":
            status = "interrompida"
        elif n_done < len(pending):
            status = reason or "orcamento_experimentos"
        log(f"  busca: {n_done} experimentos nesta rodada ({status})")

        if status != "interrompida" and (not families or "ml" in families):
            n_done += _xgb_stage(ctx, st, round_id, models_dir, device, log)

        if status != "interrompida":
            frozen_now = _select_validate_freeze(ctx, st, round_id, models_dir, log)
            log(f"  congelados nesta rodada: {frozen_now}")
            if run_test:
                _final_test(ctx, st, models_dir, log)
    except Exception:
        status = "erro"
        raise
    finally:
        st.finish_round(round_id, status, n_done)
        _write_checkpoint(checkpoint, {"rodada": round_id, "dataset": ctx.dataset_id, "status": status,
                                       "feitos_na_rodada": n_done, "atualizado": time.time()})
        for sig_num, handler in previous.items():
            signal.signal(sig_num, handler)
        st.close()
    return {"rodada": round_id, "status": status, "experimentos": n_done, "dataset": ctx.dataset_id,
            "segundos": round(time.time() - started, 1)}


# --- XGBoost ----------------------------------------------------------------

def _xgb_stage(ctx: Context, st: State, round_id: int, models_dir: Path, device: str, log: Log) -> int:
    mlc = ctx.cfg["ml"]
    base = {"horizon": int(mlc["horizon_bars"]), "stop_atr": float(mlc["stop_atr"]), "target_r": float(mlc["target_r"])}
    model_key = stable_hash({"dataset": ctx.dataset_id, "split": ctx.split_hash, "code": ctx.version, "ml": base,
                             "seed": ctx.cfg["run"]["seed"]})[:16]
    thresholds = [float(t) for t in mlc["thresholds"]]
    ids = {th: experiment_id(ctx, "xgb", {**base, "threshold": th, "model": model_key}) for th in thresholds}
    done = st.done_ids(ctx.dataset_id, ctx.version)
    if all(i in done for i in ids.values()):
        return 0
    try:
        model, info = ml.train_model(ctx.feat, ctx.masks["train"], base["horizon"], device, int(ctx.cfg["run"]["seed"]))
    except ValueError as exc:
        log(f"  XGBoost pulado: {exc}")
        return 0
    model_file = f"xgb_{model_key}.json"
    sha = ml.save_model(model, models_dir / model_file)
    proba = ml.predict_proba(model, ctx.feat)
    pre = ctx.masks["pre"]
    count = 0
    for th in thresholds:
        if ids[th] in done:
            continue
        params = {**base, "threshold": th, "model": model_key, "model_file": model_file, "model_sha256": sha}
        sig = ml.signal_from_proba(proba, th)
        trades = simulate(ctx.market, sig, base["stop_atr"], base["target_r"], pre)
        train = summarize(ctx.market, trades, ctx.masks["train"])
        train["observacao"] = "métricas de treino do XGBoost são dentro da amostra (modelo treinado nesses pregões)"
        st.save_experiment({"id": ids[th], "dataset_id": ctx.dataset_id, "code_version": ctx.version, "family": "ml",
                            "strategy": "xgb", "params_json": json.dumps(params, sort_keys=True), "status": "ok",
                            "train": {**train, "modelo": info}, "pre_pnl": daily_pnl(ctx.market, trades)[pre],
                            "pre_ntr": daily_trades(ctx.market, trades)[pre]}, round_id)
        count += 1
    st.commit()
    log(f"  XGBoost treinado ({device}, {info['linhas_treino']} linhas); {count} limiares registrados")
    return count


# --- seleção, validação e congelamento --------------------------------------

def _val_slice(ctx: Context, pre_values: np.ndarray) -> np.ndarray:
    return pre_values[ctx.n_train:]


def _neighbor_frac(ctx: Context, st: State, round_id: int, strategy: str, params: dict,
                   by_id: dict) -> float | None:
    s = BY_NAME[strategy]
    neigh = s.neighbors(params)
    if not neigh:
        return None
    positives = 0
    for nb in neigh:
        nb_id = experiment_id(ctx, strategy, nb)
        row = by_id.get(nb_id)
        if row is None:
            rec = run_config(ctx, nb_id, strategy, nb)
            st.save_experiment(rec, round_id)
            st.commit()
            if rec["status"] != "ok":
                continue
            pnl = np.asarray(rec["pre_pnl"], dtype=float)
        else:
            pnl = unblob(row["pre_pnl"], np.float32).astype(float)
        positives += int(_val_slice(ctx, pnl).sum() > 0)
    return positives / len(neigh)


def _signal_for(ctx: Context, payload: dict, models_dir: Path):
    kind = payload["kind"]
    if kind == "estrategia":
        p = payload["params"]
        return BY_NAME[payload["strategy"]].fn(ctx.F, p), float(p["stop_atr"]), float(p["target_r"])
    if kind == "ensemble":
        sigs = [BY_NAME[m["strategy"]].fn(ctx.F, m["params"]) for m in payload["members"]]
        return ensemble_signal(sigs, ctx.F["day_idx"], payload["min_votes"]), float(payload["stop_atr"]), float(payload["target_r"])
    if kind == "xgb":
        model = ml.load_model(models_dir / payload["model_file"], payload["model_sha256"])
        proba = ml.predict_proba(model, ctx.feat)
        return ml.signal_from_proba(proba, float(payload["threshold"])), float(payload["stop_atr"]), float(payload["target_r"])
    raise ValueError(f"tipo congelado desconhecido: {kind}")


def _evaluate(ctx: Context, payload: dict, models_dir: Path, mask_name: str):
    sig, stop_atr, target_r = _signal_for(ctx, payload, models_dir)
    mask = ctx.masks[mask_name]
    trades = simulate(ctx.market, sig, stop_atr, target_r, mask)
    pnl = daily_pnl(ctx.market, trades)[mask]
    return summarize(ctx.market, trades, mask), monthly_table(ctx.market, trades, mask), pnl


def _select_validate_freeze(ctx: Context, st: State, round_id: int, models_dir: Path, log: Log) -> int:
    cfg = ctx.cfg
    sel = cfg["selection"]
    seed = int(cfg["run"]["seed"])
    rows = st.experiments(ctx.dataset_id, ctx.version)
    by_id = {r["id"]: r for r in rows}

    # Walk-forward por família, só com pregões pré-teste.
    fam_rows = defaultdict(list)
    for r in rows:
        fam_rows[r["family"]].append(r)
    for fam, frs in fam_rows.items():
        pnl = {r["id"]: unblob(r["pre_pnl"], np.float32).astype(float) for r in frs}
        ntr = {r["id"]: unblob(r["pre_ntr"], np.int16).astype(int) for r in frs}
        st.save_wf(ctx.dataset_id, ctx.version, fam, walk_forward(pnl, ntr, int(sel["wf_folds"])))

    # 1) Ranking no TREINO; só os melhores de cada família vão para a validação.
    ranked = defaultdict(list)
    for r in rows:
        if r["strategy"] == "xgb":
            continue
        train = json.loads(r["train_json"])
        if train_filter(train, cfg):
            ranked[r["family"]].append((train["sharpe_diario"], r))
    candidates = []
    for items in ranked.values():
        items.sort(key=lambda x: -x[0])
        candidates.extend(r for _, r in items[: int(sel["top_per_family"])])

    payloads: dict[str, dict] = {}
    for r in candidates:
        params = json.loads(r["params_json"])
        payloads[r["id"]] = {"kind": "estrategia", "strategy": r["strategy"], "family": r["family"], "params": params,
                             "experiment_id": r["id"], "code_version": ctx.version, "split_hash": ctx.split_hash}
        if st.val_eval(r["id"]):
            continue
        m, _monthly, pnl = _evaluate(ctx, payloads[r["id"]], models_dir, "val")
        p_raw = stationary_bootstrap_pvalue(pnl, int(sel["bootstrap_samples"]), float(sel["bootstrap_mean_block"]), seed)
        nfrac = _neighbor_frac(ctx, st, round_id, r["strategy"], params, by_id)
        st.save_val(r["id"], ctx.dataset_id, "estrategia", m, p_raw, nfrac)

    # 2) XGBoost: limiar calibrado na validação (conjunto permitido), um candidato.
    xgb_rows = [r for r in rows if r["strategy"] == "xgb"]
    if xgb_rows:
        val_net = {r["id"]: float(_val_slice(ctx, unblob(r["pre_pnl"], np.float32).astype(float)).sum()) for r in xgb_rows}
        best = max(xgb_rows, key=lambda r: val_net[r["id"]])
        params = json.loads(best["params_json"])
        payloads[best["id"]] = {"kind": "xgb", "model_file": params["model_file"], "model_sha256": params["model_sha256"],
                                "threshold": params["threshold"], "horizon": params["horizon"],
                                "stop_atr": params["stop_atr"], "target_r": params["target_r"],
                                "experiment_id": best["id"], "code_version": ctx.version, "split_hash": ctx.split_hash}
        if not st.val_eval(best["id"]):
            m, _monthly, pnl = _evaluate(ctx, payloads[best["id"]], models_dir, "val")
            p_raw = stationary_bootstrap_pvalue(pnl, int(sel["bootstrap_samples"]), float(sel["bootstrap_mean_block"]), seed)
            ths = sorted(json.loads(r["params_json"])["threshold"] for r in xgb_rows)
            i = ths.index(params["threshold"])
            adj = [t for j, t in enumerate(ths) if abs(j - i) == 1]
            adj_pos = [val_net[r["id"]] > 0 for r in xgb_rows if json.loads(r["params_json"])["threshold"] in adj]
            nfrac = (sum(adj_pos) / len(adj_pos)) if adj_pos else None
            st.save_val(best["id"], ctx.dataset_id, "xgb", m, p_raw, nfrac)

    # 3) Holm sobre TODAS as avaliações de validação já feitas neste dataset.
    gates_by_id = _current_val_gates(ctx, st)
    passing = [eid for eid, g in gates_by_id.items() if all(g.values()) and eid in payloads]

    # 4) Ensemble dos aprovados na validação (voto majoritário).
    strat_pass = [eid for eid in passing if payloads[eid]["kind"] == "estrategia"]
    if len(strat_pass) >= 2:
        members = [{"strategy": payloads[e]["strategy"], "params": payloads[e]["params"]} for e in sorted(strat_pass)]
        ens = {"kind": "ensemble", "members": members, "min_votes": len(members) // 2 + 1,
               "stop_atr": statistics.median(m["params"]["stop_atr"] for m in members),
               "target_r": statistics.median(m["params"]["target_r"] for m in members),
               "code_version": ctx.version, "split_hash": ctx.split_hash}
        ens_id = "ens_" + stable_hash(ens)[:16]
        payloads[ens_id] = ens
        if not st.val_eval(ens_id):
            m, _monthly, pnl = _evaluate(ctx, ens, models_dir, "val")
            p_raw = stationary_bootstrap_pvalue(pnl, int(sel["bootstrap_samples"]), float(sel["bootstrap_mean_block"]), seed)
            loo = []
            for k in range(len(members)):
                rest = members[:k] + members[k + 1:]
                sub = {**ens, "members": rest, "min_votes": len(rest) // 2 + 1}
                _m, _mm, sub_pnl = _evaluate(ctx, sub, models_dir, "val")
                loo.append(sub_pnl.sum() > 0)
            st.save_val(ens_id, ctx.dataset_id, "ensemble", m, p_raw, sum(loo) / len(loo))
        gates_by_id = _current_val_gates(ctx, st)
        if all(gates_by_id.get(ens_id, {"x": False}).values()):
            passing.append(ens_id)

    frozen = 0
    for eid in passing:
        val = json.loads(st.val_eval(eid)["val_json"])
        st.freeze(ctx.dataset_id, payloads[eid]["kind"], payloads[eid], float(val["sharpe_diario"]))
        frozen += 1
    return frozen


def _current_val_gates(ctx: Context, st: State) -> dict[str, dict]:
    evals = st.val_evals(ctx.dataset_id)
    adjusted = holm_adjust([e["p_raw"] for e in evals])
    out = {}
    for e, p_adj in zip(evals, adjusted):
        m = json.loads(e["val_json"])
        out[e["experiment_id"]] = val_gates(m, p_adj, e["neighbor_frac"], ctx.cfg)
    return out


def current_val_table(st: State, dataset_id: str, cfg: dict) -> list[dict]:
    evals = st.val_evals(dataset_id)
    adjusted = holm_adjust([e["p_raw"] for e in evals])
    rows = []
    for e, p_adj in zip(evals, adjusted):
        m = json.loads(e["val_json"])
        gates = val_gates(m, p_adj, e["neighbor_frac"], cfg)
        rows.append({"experimento": e["experiment_id"], "tipo": e["kind"], **m, "p_bootstrap": round(e["p_raw"], 4),
                     "p_holm": round(p_adj, 4), "vizinhos_positivos": e["neighbor_frac"],
                     "aprovado_validacao": all(gates.values()),
                     "falhas": ",".join(k for k, v in gates.items() if not v)})
    return rows


# --- teste final ------------------------------------------------------------

def _final_test(ctx: Context, st: State, models_dir: Path, log: Log) -> None:
    cfg = ctx.cfg
    sel = cfg["selection"]
    budget = int(sel["test_budget_per_dataset"])
    used = st.test_count(ctx.dataset_id)
    trials = st.experiments(ctx.dataset_id)
    n_trials = max(1, len(trials))
    srs = [json.loads(r["train_json"]).get("sharpe_diario", 0.0) for r in trials]
    sr_var = float(np.var(srs, ddof=1)) if len(srs) > 1 else 0.0
    for fr in st.frozen(ctx.dataset_id):
        if st.test_eval(fr["id"]):
            continue
        if used >= budget:
            log(f"  orçamento de teste esgotado ({used}/{budget}); candidatos restantes ficam sem teste")
            break
        payload = json.loads(fr["payload_json"])
        m, monthly, pnl = _evaluate(ctx, payload, models_dir, "test")
        dsr = deflated_sharpe(pnl, n_trials, sr_var)
        p_raw = stationary_bootstrap_pvalue(pnl, int(sel["bootstrap_samples"]), float(sel["bootstrap_mean_block"]),
                                            int(cfg["run"]["seed"]))
        p_adj = bonferroni(p_raw, budget)
        gates = test_gates(m, monthly, dsr["dsr"], p_adj, cfg)
        passed = all(gates.values())
        approved = passed and ctx.ds.kind == "real"
        metrics = {**m, "dsr": round(dsr["dsr"], 4), "sr0_esperado": round(dsr["sr0"], 4), "tentativas": n_trials,
                   "p_bootstrap": round(p_raw, 4), "p_bonferroni": round(p_adj, 4), "tipo_dataset": ctx.ds.kind}
        st.save_test(fr["id"], ctx.dataset_id, metrics, monthly.to_dict("records"), gates, approved)
        used += 1
        name = payload.get("strategy") or payload["kind"]
        if approved:
            msg = (f"CANDIDATO APROVADO NO TESTE FINAL: {name} {fr['id']} em {ctx.ds.symbol} — "
                   f"líquido R$ {m['liquido_brl']:.2f}, {m['operacoes']} operações. Pesquisa, não recomendação.")
            st.add_alert(fr["id"], ctx.dataset_id, msg)
            alerts_file = st.path.parent / "alertas.jsonl"
            with alerts_file.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps({"frozen_id": fr["id"], "mensagem": msg, "metricas": metrics}, ensure_ascii=False) + "\n")
            log("  *** " + msg)
        else:
            failed = [k for k, v in gates.items() if not v]
            extra = " (dataset sintético: nunca gera alerta)" if passed else ""
            log(f"  teste final {name} {fr['id']}: NÃO aprovado{extra} — falhou em {', '.join(failed) or 'nenhum critério'}")
