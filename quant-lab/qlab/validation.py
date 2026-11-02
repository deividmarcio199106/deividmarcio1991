"""Divisão temporal 60/20/20, walk-forward e critérios de aprovação."""

from __future__ import annotations

import numpy as np
import pandas as pd

from .metrics import sharpe_daily


def split_masks(n_days: int, fractions: dict) -> dict[str, np.ndarray]:
    """Divide os pregões em ordem cronológica: treino, validação, teste (sem embaralhar)."""
    n_train = int(round(n_days * fractions["train"]))
    n_val = int(round(n_days * fractions["val"]))
    n_test = n_days - n_train - n_val
    if min(n_train, n_val, n_test) < 1:
        raise ValueError(f"pregões insuficientes para dividir 60/20/20: {n_days}")
    idx = np.arange(n_days)
    train = idx < n_train
    val = (idx >= n_train) & (idx < n_train + n_val)
    test = idx >= n_train + n_val
    return {"train": train, "val": val, "test": test, "pre": train | val}


def split_description(days: np.ndarray, masks: dict[str, np.ndarray]) -> dict:
    out = {}
    for name in ("train", "val", "test"):
        sel = days[masks[name]]
        out[name] = {"inicio": str(sel[0]), "fim": str(sel[-1]), "pregoes": int(sel.size)}
    return out


def walk_forward(pre_pnl: dict[str, np.ndarray], pre_ntr: dict[str, np.ndarray], n_folds: int,
                 min_trades: int = 10) -> dict:
    """Walk-forward ancorado sobre os pregões pré-teste (treino+validação).

    Em cada dobra, escolhe a configuração de maior Sharpe na janela anterior e mede a
    seguinte, que ela não viu. Avalia o PROCEDIMENTO de seleção da família, não um
    conjunto de parâmetros. O teste final não participa.
    """
    if not pre_pnl:
        return {"dobras": 0}
    n = len(next(iter(pre_pnl.values())))
    first = n // 2
    edges = np.linspace(first, n, n_folds + 1).astype(int)
    oos_parts, folds = [], []
    for k in range(n_folds):
        lo, hi = edges[k], edges[k + 1]
        if hi <= lo:
            continue
        best, best_sr = None, -np.inf
        for key, pnl in pre_pnl.items():
            if pre_ntr[key][:lo].sum() < min_trades:
                continue
            sr = sharpe_daily(pnl[:lo])
            if sr > best_sr:
                best, best_sr = key, sr
        if best is None:
            folds.append({"dobra": k + 1, "escolhida": None, "oos_brl": 0.0})
            oos_parts.append(np.zeros(hi - lo))
            continue
        oos = pre_pnl[best][lo:hi]
        oos_parts.append(oos)
        folds.append({"dobra": k + 1, "escolhida": best, "sharpe_janela": round(float(best_sr), 4),
                      "oos_brl": round(float(oos.sum()), 2)})
    oos_all = np.concatenate(oos_parts) if oos_parts else np.zeros(0)
    return {
        "dobras": len(folds),
        "oos_liquido_brl": round(float(oos_all.sum()), 2),
        "oos_sharpe_diario": round(sharpe_daily(oos_all), 4),
        "dobras_positivas": int(sum(1 for f in folds if f["oos_brl"] > 0)),
        "detalhe": folds,
    }


def train_filter(m: dict, cfg: dict) -> bool:
    s = cfg["selection"]
    return m["operacoes"] >= s["min_trades_train"] and m["liquido_brl"] > 0 and m["pf"] > 1.0


def val_gates(m: dict, p_adj: float, neighbor_frac: float | None, cfg: dict) -> dict[str, bool]:
    s = cfg["selection"]
    return {
        "liquido_positivo": m["liquido_brl"] > 0,
        "pf_minimo": m["pf"] >= s["min_pf_val"],
        "operacoes_minimas": m["operacoes"] >= s["min_trades_val"],
        "bootstrap_holm": p_adj < s["alpha"],
        "sensibilidade_vizinhos": neighbor_frac is not None and neighbor_frac >= s["min_neighbor_positive_frac"],
    }


def test_gates(m: dict, monthly: pd.DataFrame, dsr: float, p_adj: float, cfg: dict) -> dict[str, bool]:
    t, s, cap = cfg["targets"], cfg["selection"], cfg["capital"]
    months_ok = len(monthly) > 0
    if months_ok:
        enough_days = bool((monthly["pregoes_operados"] >= t["min_traded_days_month"]).all())
        pct_days = bool((monthly["pct_positivos_operados"] >= t["min_pct_positive_days_month"]).all())
        pct_months = float((monthly["liquido_brl"] > 0).mean()) >= t["min_pct_positive_months"]
    else:
        enough_days = pct_days = pct_months = False
    return {
        "liquido_apos_custos_positivo": m["liquido_brl"] > 0,
        "operacoes_minimas": m["operacoes"] >= s["min_trades_test"],
        "pregoes_operados_por_mes": enough_days,
        "pct_pregoes_positivos_mes": pct_days,
        "meses_positivos": pct_months,
        "drawdown_maximo": m["max_dd_brl"] <= cap["max_drawdown_frac"] * cap["capital_brl"],
        "margem_compativel": m["margem_max_brl"] <= cap["capital_brl"],
        "deflated_sharpe": dsr >= t["min_dsr"],
        "bootstrap_bonferroni": p_adj < s["alpha"],
    }
