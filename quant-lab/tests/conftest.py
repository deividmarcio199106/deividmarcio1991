from __future__ import annotations

import sys
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from qlab import calendar_b3 as cal  # noqa: E402
from qlab import synthetic  # noqa: E402
from qlab.config import load_config  # noqa: E402


@pytest.fixture
def cfg():
    return load_config(overrides={"run": {"workers": 1, "max_minutes": 5.0},
                                  "selection": {"bootstrap_samples": 400}})


@pytest.fixture
def random_csv(tmp_path) -> Path:
    df = synthetic.generate("WIN", date(2025, 1, 2), date(2025, 6, 30), seed=3)
    path = tmp_path / "SINTETICO_WINFUT_5min.csv"
    synthetic.write_profit_csv(df, path, "WINFUT")
    return path


def planted_trend_bars(start: date, end: date, seed: int = 0) -> pd.DataFrame:
    """Série de teste com vantagem plantada: cada pregão tende numa direção do início ao fim.

    Rompimento da faixa de abertura a favor da tendência ganha quase todo dia. Serve para
    provar que o funil aprova quando existe vantagem real e estável.
    """
    rng = np.random.default_rng(seed)
    rows = []
    price = 120000.0
    for d in cal.business_days(start, end):
        direction = 1 if rng.random() < 0.5 else -1
        for k in range(110):
            ts = pd.Timestamp(d) + pd.Timedelta(minutes=9 * 60 + 5 * k)
            o = price
            c = o + direction * 20 + rng.normal(0, 4)
            hi = max(o, c) + abs(rng.normal(0, 3))
            lo = min(o, c) - abs(rng.normal(0, 3))
            q = lambda x: round(x / 5.0) * 5.0  # noqa: E731
            o, c, hi, lo = q(o), q(c), q(hi), q(lo)
            rows.append((ts, o, max(hi, o, c), min(lo, o, c), c, 1000))
            price = c
        price += rng.normal(0, 50)
    return pd.DataFrame(rows, columns=["ts", "open", "high", "low", "close", "qty"])


@pytest.fixture
def planted_csv(tmp_path) -> Path:
    """CSV com vantagem plantada e nome de arquivo REAL (para exercitar o caminho de alerta)."""
    df = planted_trend_bars(date(2025, 1, 2), date(2025, 10, 31), seed=5)
    path = tmp_path / "WINFUT_5min_vantagem_plantada.csv"
    synthetic.write_profit_csv(df, path, "WINFUT")
    path.with_suffix(path.suffix + ".synthetic.json").unlink()
    return path
