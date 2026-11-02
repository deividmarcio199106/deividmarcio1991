"""Verificação de qualidade: grade de preços, horários, calendário B3, rolagem e OHLC."""

from __future__ import annotations

from datetime import date

import numpy as np
import pandas as pd

from . import calendar_b3 as cal
from .contracts import ContractSpec
from .data import Dataset


def _check(name: str, status: str, detail: str) -> dict:
    return {"verificacao": name, "status": status, "detalhe": detail}


def clean_bars(ds: Dataset, spec: ContractSpec) -> tuple[pd.DataFrame, dict]:
    """Remove barras com OHLC inconsistente ou fora do horário do pregão configurado."""
    bars = ds.bars
    o, h, l, c = (bars[k].to_numpy(dtype=float) for k in ("open", "high", "low", "close"))
    bad_ohlc = (h < np.maximum(o, c) - 1e-9) | (l > np.minimum(o, c) + 1e-9) | (l <= 0) | (h < l)
    tod = (bars["ts"].dt.hour * 60 + bars["ts"].dt.minute).to_numpy()
    out_session = (tod < spec.session_start_min) | (tod > spec.session_end_min)
    keep = ~bad_ohlc & ~out_session
    stats = {"ohlc_inconsistente": int(bad_ohlc.sum()), "fora_do_pregao": int((out_session & ~bad_ohlc).sum())}
    return bars.loc[keep].reset_index(drop=True), stats


def roll_days_for(ds_root: str, days: list[date], days_before: int) -> set[date]:
    if not days:
        return set()
    return set(cal.roll_dates(ds_root, days[0], days[-1], days_before))


def quality_report(ds: Dataset, spec: ContractSpec, roll_days_before: int = 1) -> dict:
    checks: list[dict] = []
    bars = ds.bars
    if bars.empty:
        return {"checks": [_check("dados", "erro", "nenhuma barra lida")], "resumo": {}}
    clean, stats = clean_bars(ds, spec)

    if stats["ohlc_inconsistente"]:
        checks.append(_check("ohlc", "alerta", f"{stats['ohlc_inconsistente']} barras com OHLC inconsistente descartadas"))
    else:
        checks.append(_check("ohlc", "ok", "máxima/mínima coerentes com abertura/fechamento"))
    if stats["fora_do_pregao"]:
        checks.append(_check("horario", "alerta", f"{stats['fora_do_pregao']} barras fora de "
                             f"{spec.session_start_min // 60:02d}:{spec.session_start_min % 60:02d}-"
                             f"{spec.session_end_min // 60:02d}:{spec.session_end_min % 60:02d} descartadas"))
    else:
        checks.append(_check("horario", "ok", "todas as barras dentro do horário configurado"))

    prices = clean[["open", "high", "low", "close"]].to_numpy(dtype=float).ravel()
    off = spec.off_grid_fraction(prices)
    checks.append(_check(
        "grade_de_precos",
        "ok" if off == 0 else ("alerta" if off < 0.05 else "erro"),
        f"{off:.2%} dos preços fora da grade de {spec.tick_size} pontos"
        + ("" if off == 0 else " (série ajustada? custos e stops usam a grade do contrato)"),
    ))

    if ds.timeframe_min is None:
        checks.append(_check("timeframe", "erro", "não foi possível inferir o timeframe intradiário"))
    else:
        checks.append(_check("timeframe", "ok", f"{ds.timeframe_min} min"))

    days_ts = clean["ts"].dt.normalize()
    data_days = sorted({d.date() for d in days_ts.drop_duplicates()})
    bars_per_day = clean.groupby(days_ts).size()
    median_bars = float(bars_per_day.median()) if len(bars_per_day) else 0.0
    short_days = bars_per_day[bars_per_day < 0.6 * median_bars]
    partial_known = {d for y in {x.year for x in data_days} for d in cal.partial_sessions(y)}
    unexpected_short = [d.date() for d in short_days.index if d.date() not in partial_known]
    checks.append(_check(
        "pregoes_incompletos",
        "ok" if not unexpected_short else "alerta",
        f"mediana {median_bars:.0f} barras/pregão; {len(unexpected_short)} pregões com menos de 60% "
        f"(ex.: {', '.join(str(d) for d in unexpected_short[:5])})" if unexpected_short else
        f"mediana {median_bars:.0f} barras/pregão; nenhum pregão anormalmente curto",
    ))

    on_holiday = [(d, cal.holiday_name(d)) for d in data_days if not cal.is_business_day(d)]
    checks.append(_check(
        "calendario_feriados",
        "ok" if not on_holiday else "alerta",
        "nenhum pregão em feriado/fim de semana" if not on_holiday else
        "dados em dias que o calendário trata como sem pregão: "
        + "; ".join(f"{d} ({n})" for d, n in on_holiday[:8]) + " — confirme o calendário oficial",
    ))
    if data_days:
        expected = cal.business_days(data_days[0], data_days[-1])
        missing = sorted(set(expected) - set(data_days))
        checks.append(_check(
            "calendario_faltantes",
            "ok" if not missing else "alerta",
            "nenhum dia útil ausente" if not missing else
            f"{len(missing)} dias úteis sem dados (ex.: {', '.join(str(d) for d in missing[:8])})",
        ))

    root = ds.root or spec.root
    exp_list = cal.expiries(root, data_days[0], data_days[-1]) if data_days else []
    rolls = sorted(roll_days_for(root, data_days, roll_days_before))
    first_open = clean.groupby(days_ts)["open"].first()
    last_close = clean.groupby(days_ts)["close"].last()
    gaps = (first_open - last_close.shift(1)).abs().dropna()
    med_gap = float(gaps.median()) if len(gaps) else float("nan")
    roll_gap_txt = []
    for r in rolls:
        key = pd.Timestamp(r)
        if key in gaps.index:
            roll_gap_txt.append(f"{r}: salto {gaps.loc[key]:.1f} pts")
    big_gaps = gaps[gaps > 5 * med_gap] if med_gap and np.isfinite(med_gap) else gaps.iloc[0:0]
    big_off_roll = [d.date() for d in big_gaps.index if d.date() not in set(rolls)]
    checks.append(_check(
        "vencimentos_rolagem",
        "ok" if not big_off_roll else "alerta",
        f"vencimentos no período: {', '.join(f'{c} {d}' for d, c in exp_list) or 'nenhum'}; "
        f"rolagens previstas: {'; '.join(roll_gap_txt) or 'nenhuma'}; salto mediano entre pregões {med_gap:.1f} pts"
        + (f"; saltos grandes fora da rolagem prevista em {', '.join(map(str, big_off_roll[:6]))}" if big_off_roll else ""),
    ))

    tod = clean["ts"].dt.hour * 60 + clean["ts"].dt.minute
    first_bar = tod.groupby(days_ts).min()
    last_bar = tod.groupby(days_ts).max()
    resumo = {
        "linhas_lidas": int(len(bars)),
        "linhas_validas": int(len(clean)),
        "pregoes": len(data_days),
        "inicio": str(data_days[0]) if data_days else None,
        "fim": str(data_days[-1]) if data_days else None,
        "barras_por_pregao_mediana": median_bars,
        "primeira_barra_mais_comum": _fmt_min(first_bar.mode().iloc[0]) if len(first_bar) else None,
        "ultima_barra_mais_comum": _fmt_min(last_bar.mode().iloc[0]) if len(last_bar) else None,
        "fora_da_grade": off,
        "dias_rolagem": [str(d) for d in rolls],
        "vencimentos": [f"{c} {d}" for d, c in exp_list],
        "volume_disponivel": bool("qty" in clean or "volume" in clean),
        "agressao_disponivel": bool("buy_volume" in clean and "sell_volume" in clean),
    }
    for issue in ds.issues:
        checks.append(_check("leitura", "alerta", issue))
    return {"checks": checks, "resumo": resumo}


def _fmt_min(m: float) -> str:
    m = int(m)
    return f"{m // 60:02d}:{m % 60:02d}"
