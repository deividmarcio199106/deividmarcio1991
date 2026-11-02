"""Motor de simulação intradiária.

Convenções (todas conservadoras):
- sinal no fechamento da barra t, entrada a mercado na abertura de t+1 (mesmo pregão);
- stop e alvo verificados barra a barra; se os dois cabem na mesma barra, o stop vem
  primeiro (a ordem real dentro da barra é desconhecida) e a operação é marcada ambígua;
- abertura além do stop executa no preço de abertura (pior), alvo nunca melhora;
- zeragem obrigatória no horário de zeragem, pelo fechamento daquela barra;
- custos = taxas por lado + slippage em ticks por lado, por contrato;
- contratos limitados por risco financeiro, margem e teto; operação que não cabe é pulada;
- capital fixo (sem reinvestimento), então cada pregão é independente dos outros.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from .config import hhmm_to_min
from .contracts import ContractSpec, contracts_for_trade

TRADE_FIELDS = (
    "day", "entry_idx", "exit_idx", "direction", "entry", "exit", "contracts",
    "pnl_points", "gross_brl", "cost_brl", "net_brl", "reason", "ambiguous",
)
REASONS = {0: "tempo", 1: "stop", 2: "alvo"}


@dataclass
class Market:
    spec: ContractSpec
    day_idx: np.ndarray
    bar_idx: np.ndarray
    tod: np.ndarray
    open: np.ndarray
    high: np.ndarray
    low: np.ndarray
    close: np.ndarray
    atr: np.ndarray
    days: np.ndarray  # datetime64[D] por índice de dia
    flat_last: np.ndarray  # por dia: último índice de barra com horário <= zeragem
    last_entry_min: int
    max_trades_day: int
    capital: float
    risk_frac: float
    max_contracts: int

    @property
    def n_days(self) -> int:
        return len(self.days)

    @classmethod
    def from_features(cls, feat: pd.DataFrame, spec: ContractSpec, cfg: dict) -> "Market":
        ex = cfg["execution"]
        cap = cfg["capital"]
        day_idx = feat["day_idx"].to_numpy()
        tod = feat["tod_min"].to_numpy()
        n_days = int(day_idx.max()) + 1 if len(day_idx) else 0
        flat_min = hhmm_to_min(ex["flat_time"])
        flat_last = np.full(n_days, -1, dtype=np.int64)
        idx = np.arange(len(day_idx))
        eligible = tod <= flat_min
        # último índice elegível de cada dia (as barras estão ordenadas)
        np.maximum.at(flat_last, day_idx[eligible], idx[eligible])
        days = feat.groupby("day_idx")["ts"].first().dt.normalize().to_numpy().astype("datetime64[D]")
        return cls(
            spec=spec,
            day_idx=day_idx,
            bar_idx=feat["bar_idx"].to_numpy(),
            tod=tod,
            open=feat["raw_open"].to_numpy(dtype=float),
            high=feat["raw_high"].to_numpy(dtype=float),
            low=feat["raw_low"].to_numpy(dtype=float),
            close=feat["raw_close"].to_numpy(dtype=float),
            atr=feat["atr"].to_numpy(dtype=float),
            days=days,
            flat_last=flat_last,
            last_entry_min=hhmm_to_min(ex["last_entry_time"]),
            max_trades_day=int(ex["max_trades_per_day"]),
            capital=float(cap["capital_brl"]),
            risk_frac=float(cap["risk_per_trade_frac"]),
            max_contracts=int(cap["max_contracts"]),
        )


def simulate(market: Market, signal: np.ndarray, stop_atr: float, target_r: float,
             allowed_days: np.ndarray) -> dict[str, np.ndarray]:
    spec = market.spec
    n = len(signal)
    out: dict[str, list] = {k: [] for k in TRADE_FIELDS}
    skipped = 0
    trades_per_day = np.zeros(market.n_days, dtype=np.int64)
    next_free = 0
    candidates = np.flatnonzero(signal != 0)
    day_idx, tod = market.day_idx, market.tod
    o, h, l, c, atr = market.open, market.high, market.low, market.close, market.atr
    for t in candidates:
        if t < next_free:
            continue
        d = day_idx[t]
        e = t + 1
        if not allowed_days[d] or e >= n or day_idx[e] != d:
            continue
        if tod[e] > market.last_entry_min or trades_per_day[d] >= market.max_trades_day:
            continue
        last = market.flat_last[d]
        if last < e:
            continue
        a = atr[t]
        if not np.isfinite(a) or a <= 0:
            continue
        stop_pts = max(spec.tick_size, spec.ceil_points_to_tick(stop_atr * a))
        contracts = contracts_for_trade(spec, stop_pts, market.capital, market.risk_frac, market.max_contracts)
        if contracts == 0:
            skipped += 1
            continue
        direction = int(signal[t])
        entry = o[e]
        stop_px = entry - direction * stop_pts
        target_px = entry + direction * spec.ceil_points_to_tick(stop_pts * target_r)
        seg_h, seg_l, seg_o = h[e:last + 1], l[e:last + 1], o[e:last + 1]
        if direction > 0:
            stop_hit, tgt_hit = seg_l <= stop_px, seg_h >= target_px
        else:
            stop_hit, tgt_hit = seg_h >= stop_px, seg_l <= target_px
        ks = int(np.argmax(stop_hit)) if stop_hit.any() else None
        kt = int(np.argmax(tgt_hit)) if tgt_hit.any() else None
        ambiguous = False
        if ks is None and kt is None:
            k, exit_px, reason = last - e, c[last], 0
        elif kt is None or (ks is not None and ks <= kt):
            k, reason = ks, 1
            ambiguous = kt is not None and ks == kt
            gap_through = k > 0 and ((direction > 0 and seg_o[k] < stop_px) or (direction < 0 and seg_o[k] > stop_px))
            exit_px = seg_o[k] if gap_through else stop_px
        else:
            k, exit_px, reason = kt, target_px, 2
        exit_idx = e + k
        pnl_pts = (exit_px - entry) * direction
        gross = pnl_pts * spec.point_value * contracts
        cost = spec.round_trip_cost(contracts)
        for key, val in zip(TRADE_FIELDS, (d, e, exit_idx, direction, entry, exit_px, contracts,
                                           pnl_pts, gross, cost, gross - cost, reason, ambiguous)):
            out[key].append(val)
        trades_per_day[d] += 1
        next_free = exit_idx
    res = {k: np.asarray(v) for k, v in out.items()}
    for k in ("day", "entry_idx", "exit_idx", "direction", "contracts", "reason"):
        res[k] = res[k].astype(np.int64) if res[k].size else np.zeros(0, dtype=np.int64)
    for k in ("entry", "exit", "pnl_points", "gross_brl", "cost_brl", "net_brl"):
        res[k] = res[k].astype(float) if res[k].size else np.zeros(0)
    res["ambiguous"] = res["ambiguous"].astype(bool) if res["ambiguous"].size else np.zeros(0, dtype=bool)
    res["skipped_risk"] = np.array([skipped])
    return res


def daily_pnl(market: Market, trades: dict) -> np.ndarray:
    return np.bincount(trades["day"], weights=trades["net_brl"], minlength=market.n_days).astype(float)


def daily_trades(market: Market, trades: dict) -> np.ndarray:
    return np.bincount(trades["day"], minlength=market.n_days).astype(np.int64)


def trades_frame(market: Market, trades: dict) -> pd.DataFrame:
    df = pd.DataFrame({k: trades[k] for k in TRADE_FIELDS})
    if df.empty:
        return df
    df["pregao"] = market.days[df["day"].to_numpy()]
    df["motivo"] = df["reason"].map(REASONS)
    return df


def filter_trades(trades: dict, day_mask: np.ndarray) -> dict:
    keep = day_mask[trades["day"]] if trades["day"].size else np.zeros(0, dtype=bool)
    out = {k: (v[keep] if k != "skipped_risk" else v) for k, v in trades.items()}
    return out
