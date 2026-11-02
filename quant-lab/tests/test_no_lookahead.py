"""Prova de ausência de lookahead: truncar a série no instante T não pode mudar nenhum
indicador ou sinal em barras <= T."""

from datetime import date

import numpy as np
import pandas as pd
import pytest

from qlab import synthetic
from qlab.features import ML_FEATURES, build_features
from qlab.ml import make_labels
from qlab.strategies import STRATEGIES, features_dict
from qlab.validation import split_masks


@pytest.fixture(scope="module")
def bars():
    df = synthetic.generate("WIN", date(2025, 1, 2), date(2025, 3, 31), seed=11)
    df["buy_volume"] = df["qty"] * 0.55
    df["sell_volume"] = df["qty"] * 0.45
    return df


ROLLS = {date(2025, 2, 11)}


def _compare(full: pd.DataFrame, part: pd.DataFrame, cols):
    n = len(part)
    for col in cols:
        a = full[col].to_numpy(dtype=float)[:n]
        b = part[col].to_numpy(dtype=float)
        assert np.allclose(a, b, equal_nan=True, rtol=1e-9, atol=1e-9), f"lookahead em {col}"


@pytest.mark.parametrize("cut_frac", [0.31, 0.5, 0.77])
def test_features_are_causal(bars, cut_frac):
    full = build_features(bars, ROLLS)
    cut = int(len(bars) * cut_frac)
    part = build_features(bars.iloc[:cut].reset_index(drop=True), ROLLS)
    cols = [c for c in full.columns if c not in ("ts",)]
    _compare(full, part, cols)


@pytest.mark.parametrize("cut_frac", [0.4, 0.83])
def test_strategy_signals_are_causal(bars, cut_frac):
    full = build_features(bars, ROLLS)
    cut = int(len(bars) * cut_frac)
    part = build_features(bars.iloc[:cut].reset_index(drop=True), ROLLS)
    Ff, Fp = features_dict(full, 5.0), features_dict(part, 5.0)
    for strat in STRATEGIES:
        for params in strat.configs()[:6]:
            a = strat.fn(Ff, params)[:cut]
            b = strat.fn(Fp, params)
            assert np.array_equal(a, b), f"lookahead no sinal de {strat.name} {params}"


def test_ml_features_exclude_future_label(bars):
    feat = build_features(bars, ROLLS)
    y = make_labels(feat, 6)
    for col in ML_FEATURES:
        assert "fwd" not in col and "label" not in col
    # o rótulo nunca cruza o fim do pregão
    day = feat["day_idx"].to_numpy()
    last_bars = np.flatnonzero(np.r_[day[1:] != day[:-1], True])
    assert np.isnan(y[last_bars]).all()


def test_split_is_chronological_and_disjoint():
    m = split_masks(100, {"train": 0.6, "val": 0.2, "test": 0.2})
    idx = np.arange(100)
    assert idx[m["train"]].max() < idx[m["val"]].min() < idx[m["val"]].max() < idx[m["test"]].min()
    assert not (m["train"] & m["val"]).any() and not (m["val"] & m["test"]).any()
    assert m["train"].sum() == 60 and m["val"].sum() == 20 and m["test"].sum() == 20


def test_roll_gap_removed_from_indicators(bars):
    shifted = bars.copy()
    roll_day = pd.Timestamp(date(2025, 2, 11))
    after = shifted["ts"] >= roll_day
    for k in ("open", "high", "low", "close"):
        shifted.loc[after, k] = shifted.loc[after, k] + 2000.0  # salto artificial de rolagem
    base = build_features(bars, ROLLS)
    moved = build_features(shifted, ROLLS)
    later = (base["ts"] > roll_day + pd.Timedelta(days=3)).to_numpy()
    assert np.allclose(base.loc[later, "atr"], moved.loc[later, "atr"], equal_nan=True)
    assert np.allclose(moved.loc[later, "raw_close"] - base.loc[later, "raw_close"], 2000.0)


def test_ensemble_vote_is_causal_and_tolerates_different_timing(bars):
    from qlab.strategies import BY_NAME, ensemble_signal

    full = build_features(bars, ROLLS)
    cut = int(len(bars) * 0.6)
    part = build_features(bars.iloc[:cut].reset_index(drop=True), ROLLS)
    members = [("orb", {"n": 3, "buffer_ticks": 0}), ("orb", {"n": 6, "buffer_ticks": 0}),
               ("momentum", {"lag": 6, "mult": 1.0})]

    def ens(feat):
        F = features_dict(feat, 5.0)
        return ensemble_signal([BY_NAME[n].fn(F, p) for n, p in members], F["day_idx"])

    assert np.array_equal(ens(full)[:cut], ens(part))
    day = np.array([0, 0, 0, 0, 1, 1])
    a = np.array([1, 0, 0, 0, 0, 0], dtype=np.int8)  # membro A compra cedo
    b = np.array([0, 0, 1, 0, 0, 0], dtype=np.int8)  # membro B compra depois
    out = ensemble_signal([a, b], day, min_votes=2)
    assert out.tolist() == [0, 0, 1, 0, 0, 0]  # entra quando os dois concordam; não atravessa o dia
