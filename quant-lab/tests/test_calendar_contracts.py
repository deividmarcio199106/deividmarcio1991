from datetime import date

import numpy as np
import pytest

from qlab import calendar_b3 as cal
from qlab.contracts import contracts_for_trade, root_from_symbol, spec_from_config


def test_easter_known_dates():
    assert cal.easter(2024) == date(2024, 3, 31)
    assert cal.easter(2025) == date(2025, 4, 20)
    assert cal.easter(2026) == date(2026, 4, 5)


def test_holidays_and_business_days():
    assert not cal.is_business_day(date(2026, 2, 16))  # Carnaval segunda
    assert not cal.is_business_day(date(2026, 2, 17))  # Carnaval terça
    assert cal.is_business_day(date(2026, 2, 18))  # Cinzas: pregão à tarde
    assert not cal.is_business_day(date(2026, 4, 3))  # Sexta-feira Santa
    assert not cal.is_business_day(date(2026, 6, 4))  # Corpus Christi
    assert not cal.is_business_day(date(2025, 11, 20))  # Consciência Negra (nacional desde 2024)
    assert not cal.is_business_day(date(2025, 12, 24))
    assert not cal.is_business_day(date(2025, 12, 31))
    assert cal.is_business_day(date(2026, 1, 2))


def test_win_expiry_is_wednesday_closest_to_15th():
    assert cal.win_expiry(2025, 2) == date(2025, 2, 12)
    assert cal.win_expiry(2025, 6) == date(2025, 6, 18)
    assert cal.win_expiry(2025, 12) == date(2025, 12, 17)
    assert cal.win_expiry(2026, 6) == date(2026, 6, 17)
    with pytest.raises(ValueError):
        cal.win_expiry(2026, 3)


def test_wdo_expiry_first_business_day():
    assert cal.wdo_expiry(2026, 1) == date(2026, 1, 2)
    assert cal.wdo_expiry(2026, 2) == date(2026, 2, 2)
    assert cal.wdo_expiry(2026, 4) == date(2026, 4, 1)


def test_roll_dates_one_business_day_before_expiry():
    rolls = cal.roll_dates("WDO", date(2026, 1, 1), date(2026, 3, 31), days_before=1)
    assert date(2026, 1, 30) in rolls  # véspera útil de 02/02
    assert date(2026, 2, 27) in rolls  # véspera útil de 02/03


def test_contract_specs(cfg):
    win = spec_from_config(cfg, "WIN")
    wdo = spec_from_config(cfg, "WDO")
    assert win.tick_value == pytest.approx(1.0)
    assert wdo.tick_value == pytest.approx(5.0)
    assert win.round_trip_cost(2) == pytest.approx(2 * (2 * 0.5 + 2 * 1.0))
    assert wdo.off_grid_fraction(np.array([5400.0, 5400.5, 5400.3])) == pytest.approx(1 / 3)
    assert root_from_symbol("WDOFUT") == "WDO" and root_from_symbol("WINZ25") == "WIN"
    assert root_from_symbol("PETR4") is None


def test_sizing_limited_by_risk_margin_and_cap(cfg):
    win = spec_from_config(cfg, "WIN")
    wdo = spec_from_config(cfg, "WDO")
    # risco R$60; WIN stop 100 pts = R$20 + R$3 de custos por contrato -> 2 contratos
    assert contracts_for_trade(win, 100, 2000, 0.03, 5) == 2
    # stop curto: limitado pelo teto de 5 contratos
    assert contracts_for_trade(win, 10, 2000, 0.03, 5) == 5
    # WDO stop 6 pts = R$60 + custos > R$60: não cabe, operação deve ser pulada
    assert contracts_for_trade(wdo, 6, 2000, 0.03, 5) == 0
    # margem: R$2000 / R$300 = 6 contratos; com risco folgado, o teto de 5 vale
    assert contracts_for_trade(wdo, 0.5, 2000, 1.0, 5) == 5
    assert contracts_for_trade(wdo, 0.5, 500, 1.0, 5) == 1
