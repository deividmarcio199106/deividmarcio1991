"""Estatística para seleção: bootstrap estacionário, Holm, Deflated Sharpe Ratio."""

from __future__ import annotations

import math
from statistics import NormalDist

import numpy as np

EULER_GAMMA = 0.5772156649015329
_N = NormalDist()


def stationary_bootstrap_pvalue(pnl: np.ndarray, n_boot: int = 2000, mean_block: float = 5.0,
                                seed: int = 0) -> float:
    """p-valor unilateral de H0: média diária <= 0 (Politis & Romano, série centrada).

    Preserva dependência de curto prazo entre pregões reamostrando blocos de tamanho
    geométrico com média `mean_block`.
    """
    x = np.asarray(pnl, dtype=float)
    n = x.size
    if n < 5 or np.allclose(x, x[0]):
        return 1.0
    observed = x.mean()
    centered = x - observed
    rng = np.random.default_rng(seed)
    p_new = 1.0 / max(mean_block, 1.0)
    jumps = rng.random((n_boot, n)) < p_new
    jumps[:, 0] = True
    starts = rng.integers(n, size=(n_boot, n))
    pos = np.arange(n)
    last_jump = np.maximum.accumulate(np.where(jumps, pos, 0), axis=1)
    block_start = np.take_along_axis(starts, last_jump, axis=1)
    idx = (block_start + (pos - last_jump)) % n
    means = centered[idx].mean(axis=1)
    return float((np.sum(means >= observed) + 1) / (n_boot + 1))


def holm_adjust(pvalues: list[float]) -> list[float]:
    m = len(pvalues)
    if m == 0:
        return []
    order = np.argsort(pvalues)
    adjusted = np.empty(m)
    running = 0.0
    for rank, i in enumerate(order):
        val = min(1.0, (m - rank) * pvalues[i])
        running = max(running, val)
        adjusted[i] = running
    return adjusted.tolist()


def bonferroni(p: float, m: int) -> float:
    return min(1.0, p * max(m, 1))


def expected_max_sharpe(sr_variance: float, n_trials: int) -> float:
    if n_trials <= 1 or sr_variance <= 0:
        return 0.0
    a = _N.inv_cdf(1 - 1.0 / n_trials)
    b = _N.inv_cdf(1 - 1.0 / (n_trials * math.e))
    return math.sqrt(sr_variance) * ((1 - EULER_GAMMA) * a + EULER_GAMMA * b)


def deflated_sharpe(pnl: np.ndarray, n_trials: int, trial_sr_variance: float) -> dict:
    """DSR (Bailey & López de Prado, 2014) com Sharpe diário não anualizado."""
    x = np.asarray(pnl, dtype=float)
    t = x.size
    if t < 3 or np.std(x) == 0:
        return {"dsr": 0.0, "sr": 0.0, "sr0": 0.0, "n_trials": n_trials}
    sr = x.mean() / x.std(ddof=1)
    z = (x - x.mean()) / x.std(ddof=0)
    skew = float(np.mean(z ** 3))
    kurt = float(np.mean(z ** 4))
    sr0 = expected_max_sharpe(trial_sr_variance, n_trials)
    denom = 1 - skew * sr + (kurt - 1) / 4.0 * sr ** 2
    if denom <= 0:
        return {"dsr": 0.0, "sr": float(sr), "sr0": sr0, "n_trials": n_trials}
    stat = (sr - sr0) * math.sqrt(t - 1) / math.sqrt(denom)
    return {"dsr": float(_N.cdf(stat)), "sr": float(sr), "sr0": float(sr0), "n_trials": n_trials}
