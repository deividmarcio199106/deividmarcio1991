"""Indicadores causais por barra.

Regra: o valor de qualquer coluna na barra t depende apenas de barras <= t. A decisão é
tomada no fechamento de t e executada na abertura de t+1. Isso é verificado em
tests/test_no_lookahead.py truncando a série e comparando os valores.

Rolagem: em séries contínuas não ajustadas, o salto de abertura do dia de rolagem
contaminaria ATR, médias e retornos. Os indicadores usam um preço ajustado "para frente"
(subtrai os saltos de rolagem já ocorridos), que é causal. A execução usa o preço bruto.
"""

from __future__ import annotations

from datetime import date

import numpy as np
import pandas as pd

ATR_WINDOW = 14
EMA_SPANS = (9, 21, 50)
Z_WINDOWS = (12, 24, 48)
MOM_LAGS = (3, 6, 12)
OR_BARS = (3, 6, 12)
REGIME_WINDOW = 20
DELTA_WINDOW = 6


def build_features(bars: pd.DataFrame, roll_days: set[date] | frozenset = frozenset()) -> pd.DataFrame:
    ts = pd.to_datetime(bars["ts"]).reset_index(drop=True)
    df = pd.DataFrame({"ts": ts})
    for k in ("open", "high", "low", "close"):
        df[f"raw_{k}"] = bars[k].to_numpy(dtype=float)
    day = ts.dt.normalize()
    day_idx, _ = pd.factorize(day, sort=True)
    df["day_idx"] = day_idx
    df["bar_idx"] = df.groupby("day_idx").cumcount()
    df["tod_min"] = ts.dt.hour * 60 + ts.dt.minute

    # Ajuste "para frente" nos dias de rolagem previstos.
    first_bar = (df["bar_idx"] == 0).to_numpy()
    raw_open = df["raw_open"].to_numpy()
    raw_close = df["raw_close"].to_numpy()
    prev_close = np.concatenate([[np.nan], raw_close[:-1]])
    roll_set = {pd.Timestamp(d) for d in roll_days}
    is_roll_day = day.isin(roll_set).to_numpy()
    gap = np.where(first_bar & is_roll_day & np.isfinite(prev_close), raw_open - prev_close, 0.0)
    offset = np.cumsum(gap)
    df["roll_offset"] = offset
    for k in ("open", "high", "low", "close"):
        df[k] = df[f"raw_{k}"] - offset

    h, l, c = df["high"], df["low"], df["close"]
    pc = c.shift(1)
    tr = pd.concat([h - l, (h - pc).abs(), (l - pc).abs()], axis=1).max(axis=1)
    df["tr"] = tr
    df["atr"] = tr.rolling(ATR_WINDOW, min_periods=ATR_WINDOW).mean()
    df["atr_prev"] = df["atr"].shift(1)
    df["ret1"] = c / pc - 1.0
    same_day = df["day_idx"] == df["day_idx"].shift(1)
    df["close_prev"] = pc.where(same_day)
    for span in EMA_SPANS:
        df[f"ema_{span}"] = c.ewm(span=span, adjust=False).mean()
    for w in Z_WINDOWS:
        mean = c.rolling(w, min_periods=w).mean()
        std = c.rolling(w, min_periods=w).std(ddof=0)
        df[f"z_{w}"] = (c - mean) / std.where(std > 0)
    for k in MOM_LAGS:
        df[f"mom_{k}"] = c - c.shift(k)

    g = df.groupby("day_idx")
    cum_high = g["high"].cummax()
    cum_low = g["low"].cummin()
    for n in OR_BARS:
        at_n = df["bar_idx"] == n - 1
        df[f"or_high_{n}"] = cum_high.where(at_n).groupby(df["day_idx"]).ffill()
        df[f"or_low_{n}"] = cum_low.where(at_n).groupby(df["day_idx"]).ffill()

    weights = None
    for col in ("qty", "volume"):
        if col in bars and np.isfinite(bars[col].to_numpy(dtype=float)).any() and (bars[col] > 0).any():
            weights = pd.Series(bars[col].to_numpy(dtype=float)).fillna(0.0).clip(lower=0.0)
            break
    if weights is not None:
        tp = (h + l + c) / 3.0
        cum_pv = (tp * weights).groupby(df["day_idx"]).cumsum()
        cum_v = weights.groupby(df["day_idx"]).cumsum()
        df["vwap"] = cum_pv / cum_v.where(cum_v > 0)
        df["vwap_dist"] = (c - df["vwap"]) / df["atr"]
        df["vwap_dist_prev"] = df["vwap_dist"].shift(1).where(same_day)
    else:
        df["vwap"] = np.nan
        df["vwap_dist"] = np.nan
        df["vwap_dist_prev"] = np.nan

    if "buy_volume" in bars and "sell_volume" in bars:
        buy = pd.Series(bars["buy_volume"].to_numpy(dtype=float)).fillna(0.0)
        sell = pd.Series(bars["sell_volume"].to_numpy(dtype=float)).fillna(0.0)
        tot = (buy + sell).rolling(DELTA_WINDOW, min_periods=DELTA_WINDOW).sum()
        df["delta_ratio"] = (buy - sell).rolling(DELTA_WINDOW, min_periods=DELTA_WINDOW).sum() / tot.where(tot > 0)
    else:
        df["delta_ratio"] = np.nan

    df["day_open"] = g["open"].transform("first")
    day_last_close = g["close"].last()
    prev_day_close = day_last_close.shift(1)
    df["prev_day_close"] = df["day_idx"].map(prev_day_close)
    gap_atr = (df["day_open"] - df["prev_day_close"]) / df["atr"]
    df["gap_atr"] = gap_atr.where(~is_roll_day)

    day_rv = df.groupby("day_idx")["ret1"].std(ddof=0)
    prev_rv = day_rv.shift(1)
    regime = prev_rv.rolling(REGIME_WINDOW, min_periods=REGIME_WINDOW // 2).rank(pct=True)
    df["prev_day_rv"] = df["day_idx"].map(prev_rv)
    df["vol_regime"] = df["day_idx"].map(regime)

    rng = h - l
    df["close_pos"] = (c - l) / rng.where(rng > 0)
    df["tr_atr"] = tr / df["atr_prev"]
    df["trend_slope"] = (df["ema_21"] - df["ema_21"].shift(3)) / df["atr"]
    for k in MOM_LAGS:
        df[f"mom_{k}_atr"] = df[f"mom_{k}"] / df["atr"]
    df["dist_or_high_6"] = (c - df["or_high_6"]) / df["atr"]
    df["dist_or_low_6"] = (c - df["or_low_6"]) / df["atr"]
    return df


ML_FEATURES = [
    "ret1", "z_12", "z_24", "z_48", "mom_3_atr", "mom_6_atr", "mom_12_atr", "vwap_dist",
    "close_pos", "tr_atr", "trend_slope", "vol_regime", "bar_idx", "gap_atr",
    "dist_or_high_6", "dist_or_low_6",
]
