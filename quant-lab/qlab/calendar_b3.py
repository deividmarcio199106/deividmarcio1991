"""Calendário B3 aproximado, vencimentos e rolagem de WIN/WDO.

O calendário é uma regra derivada (feriados nacionais + datas móveis + dias sem pregão
de fim de ano). Ele serve como verificação cruzada contra os dados: dias presentes nos
dados que o calendário considera feriado, e dias úteis ausentes, são reportados pelo
relatório de qualidade em vez de descartados em silêncio.

Pontos a confirmar com o calendário oficial da B3:
- 25/01 (aniversário de SP) e 09/07 (feriado estadual) são tratados como dias COM pregão.
- 20/11 é tratado como feriado só a partir de 2024 (Lei 14.759/2023).
- Quarta-feira de Cinzas é dia útil com abertura tardia (13h).
"""

from __future__ import annotations

from datetime import date, timedelta
from functools import lru_cache

MONTH_CODES = "FGHJKMNQUVXZ"


def easter(year: int) -> date:
    """Domingo de Páscoa (algoritmo gregoriano anônimo)."""
    a = year % 19
    b, c = divmod(year, 100)
    d, e = divmod(b, 4)
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = divmod(c, 4)
    l = (32 + 2 * e + 2 * i - h - k) % 7  # noqa: E741
    m = (a + 11 * h + 22 * l) // 451
    month, day = divmod(h + l - 7 * m + 114, 31)
    return date(year, month, day + 1)


@lru_cache(maxsize=None)
def b3_holidays(year: int) -> dict[date, str]:
    e = easter(year)
    hol = {
        date(year, 1, 1): "Confraternização Universal",
        e - timedelta(days=48): "Carnaval (segunda)",
        e - timedelta(days=47): "Carnaval (terça)",
        e - timedelta(days=2): "Sexta-feira Santa",
        date(year, 4, 21): "Tiradentes",
        date(year, 5, 1): "Dia do Trabalho",
        e + timedelta(days=60): "Corpus Christi",
        date(year, 9, 7): "Independência",
        date(year, 10, 12): "Nossa Senhora Aparecida",
        date(year, 11, 2): "Finados",
        date(year, 11, 15): "Proclamação da República",
        date(year, 12, 24): "Véspera de Natal (sem pregão)",
        date(year, 12, 25): "Natal",
        date(year, 12, 31): "Último dia do ano (sem pregão)",
    }
    if year >= 2024:
        hol[date(year, 11, 20)] = "Dia da Consciência Negra"
    return hol


def partial_sessions(year: int) -> dict[date, str]:
    return {easter(year) - timedelta(days=46): "Quarta-feira de Cinzas (abertura às 13h)"}


def is_business_day(d: date) -> bool:
    return d.weekday() < 5 and d not in b3_holidays(d.year)


def holiday_name(d: date) -> str | None:
    if d.weekday() >= 5:
        return "fim de semana"
    return b3_holidays(d.year).get(d)


def business_days(start: date, end: date) -> list[date]:
    out = []
    d = start
    while d <= end:
        if is_business_day(d):
            out.append(d)
        d += timedelta(days=1)
    return out


def next_business_day(d: date, inclusive: bool = True) -> date:
    cur = d if inclusive else d + timedelta(days=1)
    while not is_business_day(cur):
        cur += timedelta(days=1)
    return cur


def previous_business_day(d: date, n: int = 1) -> date:
    cur = d
    count = 0
    while count < n:
        cur -= timedelta(days=1)
        if is_business_day(cur):
            count += 1
    return cur


def win_expiry(year: int, month: int) -> date:
    """WIN vence na quarta-feira mais próxima do dia 15 dos meses pares.

    Se essa quarta não for dia útil, o vencimento passa para o próximo dia útil.
    """
    if month % 2:
        raise ValueError("WIN só tem vencimentos em meses pares")
    wednesdays = []
    d = date(year, month, 1)
    while d.month == month:
        if d.weekday() == 2:
            wednesdays.append(d)
        d += timedelta(days=1)
    best = min(wednesdays, key=lambda w: abs(w.day - 15))
    return next_business_day(best)


def wdo_expiry(year: int, month: int) -> date:
    """WDO vence no primeiro dia útil do mês de referência do contrato."""
    return next_business_day(date(year, month, 1))


def expiries(root: str, start: date, end: date) -> list[tuple[date, str]]:
    out = []
    y, m = start.year, start.month
    while (y, m) <= (end.year + 1, end.month):
        if root == "WIN" and m % 2 == 0:
            exp = win_expiry(y, m)
        elif root == "WDO":
            exp = wdo_expiry(y, m)
        else:
            exp = None
        if exp is not None and start <= exp <= end:
            out.append((exp, f"{root}{MONTH_CODES[m - 1]}{y % 100:02d}"))
        m += 1
        if m == 13:
            y, m = y + 1, 1
    return out


def roll_dates(root: str, start: date, end: date, days_before: int = 1) -> list[date]:
    """Primeiro pregão negociado no contrato seguinte, pela regra de rolagem configurada.

    Com days_before=1, a série troca de contrato no pregão anterior ao vencimento; o dia
    devolvido é esse pregão, onde o salto de preço da rolagem aparece na abertura.
    """
    out = []
    for exp, _code in expiries(root, start, end + timedelta(days=40)):
        roll = previous_business_day(exp, days_before) if days_before > 0 else exp
        if start <= roll <= end:
            out.append(roll)
    return out
