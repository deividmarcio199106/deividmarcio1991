"""Métricas por fase: mensal, pregões positivos, PF, Sharpe, drawdown, custos."""

from __future__ import annotations

import math

import numpy as np
import pandas as pd

from .backtest import Market, daily_pnl, daily_trades, filter_trades

TRADING_DAYS_YEAR = 252


def max_drawdown(pnl: np.ndarray) -> float:
    if pnl.size == 0:
        return 0.0
    equity = np.cumsum(pnl)
    peak = np.maximum.accumulate(np.concatenate([[0.0], equity]))[1:]
    return float(np.max(peak - equity))


def sharpe_daily(pnl: np.ndarray) -> float:
    """Sharpe por pregão (não anualizado), sobre todos os pregões da fase."""
    if pnl.size < 2:
        return 0.0
    sd = float(np.std(pnl, ddof=1))
    return float(np.mean(pnl) / sd) if sd > 0 else 0.0


def monthly_table(market: Market, trades: dict, day_mask: np.ndarray) -> pd.DataFrame:
    days = market.days[day_mask]
    if days.size == 0:
        return pd.DataFrame(columns=["mes", "liquido_brl", "operacoes", "pregoes", "pregoes_operados",
                                     "pregoes_positivos", "pct_positivos_operados", "custos_brl"])
    pnl = daily_pnl(market, trades)[day_mask]
    ntr = daily_trades(market, trades)[day_mask]
    costs = np.bincount(trades["day"], weights=trades["cost_brl"], minlength=market.n_days)[day_mask]
    frame = pd.DataFrame({
        "mes": pd.to_datetime(days).strftime("%Y-%m"),
        "pnl": pnl, "ntr": ntr, "cost": costs,
    })
    rows = []
    for mes, g in frame.groupby("mes", sort=True):
        traded = g[g["ntr"] > 0]
        positive = int((traded["pnl"] > 0).sum())
        rows.append({
            "mes": mes,
            "liquido_brl": round(float(g["pnl"].sum()), 2),
            "operacoes": int(g["ntr"].sum()),
            "pregoes": int(len(g)),
            "pregoes_operados": int(len(traded)),
            "pregoes_positivos": positive,
            "pct_positivos_operados": round(positive / len(traded), 4) if len(traded) else 0.0,
            "custos_brl": round(float(g["cost"].sum()), 2),
        })
    return pd.DataFrame(rows)


def summarize(market: Market, trades: dict, day_mask: np.ndarray) -> dict:
    tr = filter_trades(trades, day_mask)
    pnl = daily_pnl(market, tr)[day_mask]
    ntr = daily_trades(market, tr)[day_mask]
    net = tr["net_brl"]
    wins, losses = net[net > 0].sum(), -net[net < 0].sum()
    monthly = monthly_table(market, tr, day_mask)
    traded_days = int((ntr > 0).sum())
    positive_days = int(((ntr > 0) & (pnl > 0)).sum())
    sd = sharpe_daily(pnl)
    mdd = max_drawdown(pnl)
    max_contracts = int(tr["contracts"].max()) if tr["contracts"].size else 0
    return {
        "pregoes": int(day_mask.sum()),
        "pregoes_operados": traded_days,
        "pregoes_positivos": positive_days,
        "pct_pregoes_positivos": round(positive_days / traded_days, 4) if traded_days else 0.0,
        "operacoes": int(net.size),
        "liquido_brl": round(float(net.sum()), 2),
        "bruto_brl": round(float(tr["gross_brl"].sum()), 2),
        "custos_brl": round(float(tr["cost_brl"].sum()), 2),
        "pf": round(float(wins / losses), 4) if losses > 0 else (math.inf if wins > 0 else 0.0),
        "acerto": round(float((net > 0).mean()), 4) if net.size else 0.0,
        "media_operacao_brl": round(float(net.mean()), 2) if net.size else 0.0,
        "sharpe_diario": round(sd, 4),
        "sharpe_anual": round(sd * math.sqrt(TRADING_DAYS_YEAR), 4),
        "max_dd_brl": round(mdd, 2),
        "max_dd_frac": round(mdd / market.capital, 4) if market.capital else 0.0,
        "meses": int(len(monthly)),
        "meses_positivos": int((monthly["liquido_brl"] > 0).sum()) if len(monthly) else 0,
        "min_pct_positivos_mes": float(monthly["pct_positivos_operados"].min()) if len(monthly) else 0.0,
        "min_pregoes_operados_mes": int(monthly["pregoes_operados"].min()) if len(monthly) else 0,
        "contratos_max": max_contracts,
        "margem_max_brl": round(max_contracts * market.spec.margin_daytrade_brl, 2),
        "ambiguas_stop_primeiro": int(tr["ambiguous"].sum()),
        "puladas_por_risco": int(trades["skipped_risk"][0]),
    }
