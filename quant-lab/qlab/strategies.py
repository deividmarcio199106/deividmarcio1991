"""Famílias de estratégias com grades de parâmetros.

Cada estratégia gera, por barra, +1 (comprar), -1 (vender) ou 0, usando somente
indicadores causais da barra t. O motor executa na abertura de t+1. Saídas (stop em ATR,
alvo em múltiplos do risco, zeragem no horário) são parâmetros comuns.
"""

from __future__ import annotations

import itertools
import json
from dataclasses import dataclass, field
from typing import Callable

import numpy as np
import pandas as pd

EXIT_GRID = {"stop_atr": [1.0, 1.5], "target_r": [1.0, 2.0]}

FAMILIES = {
    "abertura_rompimento": "Abertura e rompimento",
    "reversao_media": "Reversão à média",
    "momentum": "Momentum",
    "volatilidade": "Volatilidade",
    "regimes": "Regimes de volatilidade",
    "vwap": "VWAP",
    "tendencia": "Tendência",
    "microestrutura": "Microestrutura (agressão)",
    "ml": "Modelo XGBoost",
    "ensemble": "Ensemble",
}

Features = dict[str, np.ndarray]


def _sig(long: np.ndarray, short: np.ndarray) -> np.ndarray:
    long = np.nan_to_num(long, nan=0).astype(bool)
    short = np.nan_to_num(short, nan=0).astype(bool)
    return long.astype(np.int8) - short.astype(np.int8)


def _gt(a: np.ndarray, b) -> np.ndarray:
    with np.errstate(invalid="ignore"):
        return np.greater(a, b)


def _lt(a: np.ndarray, b) -> np.ndarray:
    with np.errstate(invalid="ignore"):
        return np.less(a, b)


def _ge(a, b):
    with np.errstate(invalid="ignore"):
        return np.greater_equal(a, b)


def _le(a, b):
    with np.errstate(invalid="ignore"):
        return np.less_equal(a, b)


def sig_orb(F: Features, p: dict) -> np.ndarray:
    n = int(p["n"])
    buf = float(p["buffer_ticks"]) * F["_tick"][0]
    hi = F[f"or_high_{n}"] + buf
    lo = F[f"or_low_{n}"] - buf
    c, pc = F["close"], F["close_prev"]
    after = F["bar_idx"] >= n
    return _sig(after & _gt(c, hi) & _le(pc, hi), after & _lt(c, lo) & _ge(pc, lo))


def sig_gap_fade(F: Features, p: dict) -> np.ndarray:
    g = float(p["gap_atr"])
    first = F["bar_idx"] == 0
    return _sig(first & _lt(F["gap_atr"], -g), first & _gt(F["gap_atr"], g))


def sig_mean_reversion(F: Features, p: dict) -> np.ndarray:
    z = F[f"z_{int(p['window'])}"]
    k = float(p["k"])
    return _sig(_lt(z, -k), _gt(z, k))


def sig_momentum(F: Features, p: dict) -> np.ndarray:
    m = F[f"mom_{int(p['lag'])}"]
    th = float(p["mult"]) * F["atr"]
    return _sig(_gt(m, th), _lt(m, -th))


def sig_vol_breakout(F: Features, p: dict) -> np.ndarray:
    expand = _gt(F["tr"], float(p["mult"]) * F["atr_prev"])
    pos = float(p["close_pos"])
    up = _gt(F["close"], F["open"]) & _gt(F["close_pos"], pos)
    down = _lt(F["close"], F["open"]) & _lt(F["close_pos"], 1 - pos)
    return _sig(expand & up, expand & down)


def sig_regime(F: Features, p: dict) -> np.ndarray:
    vr = F["vol_regime"]
    calm = _lt(vr, float(p["threshold"]))
    agitated = _ge(vr, float(p["threshold"]))
    mr = sig_mean_reversion(F, {"window": 24, "k": 2.0})
    mo = sig_momentum(F, {"lag": 6, "mult": 1.0})
    return np.where(calm, mr, np.where(agitated, mo, 0)).astype(np.int8)


def sig_vwap_revert(F: Features, p: dict) -> np.ndarray:
    d = F["vwap_dist"]
    k = float(p["k"])
    return _sig(_lt(d, -k), _gt(d, k))


def sig_vwap_trend(F: Features, p: dict) -> np.ndarray:
    d, dp, slope = F["vwap_dist"], F["vwap_dist_prev"], F["trend_slope"]
    return _sig(_gt(d, 0) & _le(dp, 0) & _gt(slope, 0), _lt(d, 0) & _ge(dp, 0) & _lt(slope, 0))


def sig_trend_ema(F: Features, p: dict) -> np.ndarray:
    fast, slow = (int(x) for x in str(p["pair"]).split("-"))
    diff = F[f"ema_{fast}"] - F[f"ema_{slow}"]
    prev = np.concatenate([[np.nan], diff[:-1]])
    same_day = np.concatenate([[False], F["day_idx"][1:] == F["day_idx"][:-1]])
    up = _gt(diff, 0) & _le(prev, 0) & same_day & _gt(F["close"], F[f"ema_{slow}"])
    down = _lt(diff, 0) & _ge(prev, 0) & same_day & _lt(F["close"], F[f"ema_{slow}"])
    return _sig(up, down)


def sig_micro_delta(F: Features, p: dict) -> np.ndarray:
    d = F["delta_ratio"]
    k = float(p["k"])
    return _sig(_gt(d, k), _lt(d, -k))


@dataclass(frozen=True)
class StrategyDef:
    name: str
    family: str
    entry_grid: dict
    fn: Callable[[Features, dict], np.ndarray]
    requires: tuple[str, ...] = field(default_factory=tuple)

    def configs(self) -> list[dict]:
        grid = {**self.entry_grid, **EXIT_GRID}
        keys = list(grid)
        return [dict(zip(keys, vals)) for vals in itertools.product(*(grid[k] for k in keys))]

    def neighbors(self, params: dict) -> list[dict]:
        """Configurações que diferem em um parâmetro por um passo na grade."""
        grid = {**self.entry_grid, **EXIT_GRID}
        out = []
        for key, values in grid.items():
            if key not in params or params[key] not in values:
                continue
            i = values.index(params[key])
            for j in (i - 1, i + 1):
                if 0 <= j < len(values):
                    out.append({**params, key: values[j]})
        return out


STRATEGIES: list[StrategyDef] = [
    StrategyDef("orb", "abertura_rompimento", {"n": [3, 6, 12], "buffer_ticks": [0, 2]}, sig_orb),
    StrategyDef("gap_fade", "abertura_rompimento", {"gap_atr": [0.5, 1.0, 2.0]}, sig_gap_fade),
    StrategyDef("mean_reversion", "reversao_media", {"window": [12, 24, 48], "k": [1.5, 2.0, 2.5]}, sig_mean_reversion),
    StrategyDef("momentum", "momentum", {"lag": [3, 6, 12], "mult": [0.5, 1.0, 1.5]}, sig_momentum),
    StrategyDef("vol_breakout", "volatilidade", {"mult": [1.5, 2.0, 2.5], "close_pos": [0.7, 0.8]}, sig_vol_breakout),
    StrategyDef("regime_switch", "regimes", {"threshold": [0.3, 0.5, 0.7]}, sig_regime),
    StrategyDef("vwap_revert", "vwap", {"k": [1.0, 1.5, 2.0]}, sig_vwap_revert, ("vwap",)),
    StrategyDef("vwap_trend", "vwap", {}, sig_vwap_trend, ("vwap",)),
    StrategyDef("trend_ema", "tendencia", {"pair": ["9-21", "9-50", "21-50"]}, sig_trend_ema),
    StrategyDef("micro_delta", "microestrutura", {"k": [0.2, 0.3]}, sig_micro_delta, ("agressao",)),
]
BY_NAME = {s.name: s for s in STRATEGIES}


def available_strategies(capabilities: set[str]) -> tuple[list[StrategyDef], dict[str, str]]:
    """Separa estratégias executáveis das que exigem dados ausentes."""
    ok, skipped = [], {}
    for s in STRATEGIES:
        missing = [r for r in s.requires if r not in capabilities]
        if missing:
            skipped[s.name] = f"requer dados ausentes: {', '.join(missing)}"
        else:
            ok.append(s)
    return ok, skipped


def round_robin_queue(strategies: list[StrategyDef]) -> list[tuple[str, dict]]:
    """Fila determinística que alterna famílias, para que rodadas curtas cubram todas."""
    per = [[(s.name, cfg) for cfg in s.configs()] for s in strategies]
    out: list[tuple[str, dict]] = []
    for group in itertools.zip_longest(*per):
        out.extend(item for item in group if item is not None)
    return out


def params_key(params: dict) -> str:
    return json.dumps(params, sort_keys=True, separators=(",", ":"))


def features_dict(feat_df, tick_size: float) -> Features:
    F = {col: feat_df[col].to_numpy(dtype=float) for col in feat_df.columns if col != "ts"}
    F["bar_idx"] = feat_df["bar_idx"].to_numpy()
    F["day_idx"] = feat_df["day_idx"].to_numpy()
    F["_tick"] = np.array([tick_size])
    return F


def ensemble_signal(signals: list[np.ndarray], day_idx: np.ndarray, min_votes: int | None = None) -> np.ndarray:
    """Voto majoritário por estado: cada membro mantém a direção do seu último sinal dentro do
    pregão (sem atravessar o dia); o ensemble sinaliza quando a maioria passa a concordar.

    Só olha sinais <= t, então continua causal.
    """
    need = min_votes if min_votes is not None else (len(signals) // 2 + 1)
    day = pd.Series(day_idx)
    states = []
    for sig in signals:
        held = pd.Series(sig.astype(float)).replace(0.0, np.nan).groupby(day).ffill().fillna(0.0)
        states.append(held.to_numpy())
    total = np.sum(states, axis=0)
    vote = np.where(total >= need, 1, np.where(total <= -need, -1, 0))
    prev = np.concatenate([[0], vote[:-1]])
    new_day = np.concatenate([[True], day_idx[1:] != day_idx[:-1]])
    prev = np.where(new_day, 0, prev)
    return np.where((vote != 0) & (vote != prev), vote, 0).astype(np.int8)
