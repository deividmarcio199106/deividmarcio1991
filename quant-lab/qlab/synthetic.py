"""Gerador de série SINTÉTICA, só para testes automatizados e teste de encanamento.

Não representa o mercado e nunca pode virar resultado de pesquisa: o arquivo recebe o
prefixo SINTETICO_ e um arquivo .synthetic.json ao lado, e o runner nunca gera alerta
para dataset sintético.
"""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd

from . import calendar_b3 as cal

PROFILES = {
    "WIN": {"start_price": 128000.0, "tick": 5.0, "bar_vol": 60.0},
    "WDO": {"start_price": 5400.0, "tick": 0.5, "bar_vol": 3.0},
}


def generate(root: str, start: date, end: date, timeframe_min: int = 5, seed: int = 0,
             session: tuple[str, str] = ("09:00", "18:20")) -> pd.DataFrame:
    prof = PROFILES[root]
    rng = np.random.default_rng(seed)
    h0, m0 = (int(x) for x in session[0].split(":"))
    h1, m1 = (int(x) for x in session[1].split(":"))
    n_bars = ((h1 * 60 + m1) - (h0 * 60 + m0)) // timeframe_min + 1
    shape = 1.0 + 0.8 * np.cos(np.linspace(0, 2 * np.pi, n_bars)) ** 2
    price = prof["start_price"]
    rows = []
    for d in cal.business_days(start, end):
        day_vol = prof["bar_vol"] * float(np.exp(rng.normal(0, 0.3)))
        price += rng.normal(0, 4 * prof["bar_vol"])
        for k in range(n_bars):
            minutes = h0 * 60 + m0 + k * timeframe_min
            ts = pd.Timestamp(d) + pd.Timedelta(minutes=minutes)
            o = price
            path = o + np.cumsum(rng.normal(0, day_vol * shape[k] / 2, size=4))
            c = path[-1]
            hi, lo = max(o, c, path.max()), min(o, c, path.min())
            q = lambda x: round(x / prof["tick"]) * prof["tick"]  # noqa: E731
            o, hi, lo, c = q(o), q(hi), q(lo), q(c)
            hi, lo = max(hi, o, c), min(lo, o, c)
            qty = int(rng.integers(200, 5000))
            rows.append((ts, o, hi, lo, c, qty))
            price = c
    return pd.DataFrame(rows, columns=["ts", "open", "high", "low", "close", "qty"])


def write_profit_csv(df: pd.DataFrame, path: Path, symbol: str) -> None:
    """Escreve no layout do Profit (';', decimal ',', ordem decrescente), para exercitar o leitor."""
    path.parent.mkdir(parents=True, exist_ok=True)
    out = df.sort_values("ts", ascending=False)

    def fmt(x: float) -> str:
        return f"{x:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")

    lines = ["Ativo;Data;Hora;Abertura;Máximo;Mínimo;Fechamento;Volume;Quantidade"]
    for r in out.itertuples(index=False):
        vol = r.qty * r.close * (0.2 if symbol.startswith("WIN") else 10.0)
        lines.append(";".join([symbol, r.ts.strftime("%d/%m/%Y"), r.ts.strftime("%H:%M:%S"), fmt(r.open), fmt(r.high),
                               fmt(r.low), fmt(r.close), fmt(vol), str(r.qty)]))
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    sidecar = path.with_suffix(path.suffix + ".synthetic.json")
    sidecar.write_text(json.dumps({"sintetico": True, "aviso": "dados gerados aleatoriamente; não é mercado real"},
                                  ensure_ascii=False), encoding="utf-8")
