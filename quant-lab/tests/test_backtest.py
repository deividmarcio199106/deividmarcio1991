import numpy as np
import pandas as pd
import pytest

from qlab.backtest import Market, daily_pnl, simulate
from qlab.contracts import spec_from_config
from qlab.metrics import max_drawdown, monthly_table, summarize


def make_market(cfg, bars, atr=20.0, flat="17:50", last_entry="17:00"):
    """bars: lista de (dia, 'HH:MM', o, h, l, c)."""
    rows = []
    for day, hhmm, o, h, l, c in bars:
        rows.append({"ts": pd.Timestamp(f"{day} {hhmm}"), "raw_open": o, "raw_high": h, "raw_low": l, "raw_close": c})
    feat = pd.DataFrame(rows)
    feat["day_idx"], _ = pd.factorize(feat["ts"].dt.normalize(), sort=True)
    feat["bar_idx"] = feat.groupby("day_idx").cumcount()
    feat["tod_min"] = feat["ts"].dt.hour * 60 + feat["ts"].dt.minute
    feat["atr"] = atr
    cfg = {**cfg, "execution": {**cfg["execution"], "flat_time": flat, "last_entry_time": last_entry}}
    return Market.from_features(feat, spec_from_config(cfg, "WIN"), cfg)


def test_entry_next_open_target_hit(cfg):
    m = make_market(cfg, [
        ("2025-03-10", "10:00", 1000, 1005, 995, 1000),
        ("2025-03-10", "10:05", 1000, 1010, 995, 1005),  # entrada na abertura = 1000
        ("2025-03-10", "10:10", 1005, 1045, 1000, 1040),  # alvo 1000 + 40 (2R de stop 20)
        ("2025-03-10", "10:15", 1040, 1050, 1035, 1045),
    ])
    sig = np.array([1, 0, 0, 0], dtype=np.int8)
    tr = simulate(m, sig, stop_atr=1.0, target_r=2.0, allowed_days=np.array([True]))
    assert tr["entry"][0] == 1000 and tr["exit"][0] == 1040 and tr["reason"][0] == 2
    # stop 20 pts = R$4/contrato + R$3 de custos -> 60/7 = 8, limitado a 5 contratos
    assert tr["contracts"][0] == 5
    assert tr["net_brl"][0] == pytest.approx(40 * 0.2 * 5 - 5 * 3.0)


def test_stop_first_when_both_in_same_bar(cfg):
    m = make_market(cfg, [
        ("2025-03-10", "10:00", 1000, 1005, 995, 1000),
        ("2025-03-10", "10:05", 1000, 1050, 970, 1000),  # toca stop 980 e alvo 1040
        ("2025-03-10", "10:10", 1000, 1005, 995, 1000),
    ])
    tr = simulate(m, np.array([1, 0, 0], dtype=np.int8), 1.0, 2.0, np.array([True]))
    assert tr["reason"][0] == 1 and tr["exit"][0] == 980 and bool(tr["ambiguous"][0])


def test_gap_through_stop_fills_at_open(cfg):
    m = make_market(cfg, [
        ("2025-03-10", "10:00", 1000, 1005, 995, 1000),
        ("2025-03-10", "10:05", 1000, 1005, 990, 995),
        ("2025-03-10", "10:10", 950, 960, 940, 955),  # abre abaixo do stop 980
    ])
    tr = simulate(m, np.array([1, 0, 0], dtype=np.int8), 1.0, 2.0, np.array([True]))
    assert tr["exit"][0] == 950 and tr["reason"][0] == 1


def test_time_exit_at_flat_and_no_overnight(cfg):
    m = make_market(cfg, [
        ("2025-03-10", "17:40", 1000, 1002, 998, 1000),
        ("2025-03-10", "17:45", 1000, 1003, 999, 1001),
        ("2025-03-10", "17:50", 1001, 1004, 1000, 1003),
        ("2025-03-10", "17:55", 1003, 1100, 1000, 1090),  # depois da zeragem: ignorado
        ("2025-03-11", "09:00", 1200, 1300, 1100, 1250),
    ], last_entry="17:46")
    tr = simulate(m, np.array([1, 0, 0, 0, 0], dtype=np.int8), 1.0, 2.0, np.array([True, True]))
    assert tr["reason"][0] == 0 and tr["exit"][0] == 1003 and tr["day"][0] == 0


def test_no_entry_after_last_entry_time_or_on_blocked_day(cfg):
    bars = [("2025-03-10", "17:30", 1000, 1001, 999, 1000), ("2025-03-10", "17:35", 1000, 1001, 999, 1000)]
    m = make_market(cfg, bars, last_entry="17:00")
    assert simulate(m, np.array([1, 0], dtype=np.int8), 1.0, 2.0, np.array([True]))["day"].size == 0
    m2 = make_market(cfg, [("2025-03-10", "10:00", 1000, 1001, 999, 1000),
                           ("2025-03-10", "10:05", 1000, 1001, 999, 1000)])
    assert simulate(m2, np.array([1, 0], dtype=np.int8), 1.0, 2.0, np.array([False]))["day"].size == 0


def test_trade_skipped_when_risk_does_not_fit(cfg):
    m = make_market(cfg, [("2025-03-10", "10:00", 1000, 1001, 999, 1000),
                          ("2025-03-10", "10:05", 1000, 1001, 999, 1000)], atr=500.0)
    tr = simulate(m, np.array([1, 0], dtype=np.int8), 1.0, 2.0, np.array([True]))
    assert tr["day"].size == 0 and tr["skipped_risk"][0] == 1


def test_metrics_and_monthly(cfg):
    bars = []
    for day in ("2025-03-10", "2025-03-11", "2025-04-01"):
        bars += [(day, "10:00", 1000, 1005, 995, 1000), (day, "10:05", 1000, 1045, 995, 1040),
                 (day, "10:10", 1040, 1041, 1039, 1040)]
    m = make_market(cfg, bars)
    sig = np.zeros(len(bars), dtype=np.int8)
    sig[[0, 3, 6]] = 1
    allowed = np.array([True, True, True])
    tr = simulate(m, sig, 1.0, 2.0, allowed)
    s = summarize(m, tr, allowed)
    assert s["operacoes"] == 3 and s["pregoes_positivos"] == 3 and s["pct_pregoes_positivos"] == 1.0
    assert s["meses"] == 2 and s["meses_positivos"] == 2
    mt = monthly_table(m, tr, allowed)
    assert list(mt["mes"]) == ["2025-03", "2025-04"]
    assert daily_pnl(m, tr).sum() == pytest.approx(s["liquido_brl"])


def test_max_drawdown():
    assert max_drawdown(np.array([10, -5, -10, 20, -30])) == pytest.approx(30)  # pico 15 -> vale -15
    assert max_drawdown(np.array([-10, 5])) == pytest.approx(10)
