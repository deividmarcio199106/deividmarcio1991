"""Especificações de contrato (tick, valor do ponto, custos, margem) e dimensionamento."""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from .config import hhmm_to_min

SUPPORTED_ROOTS = ("WIN", "WDO")


@dataclass(frozen=True)
class ContractSpec:
    root: str
    tick_size: float
    point_value: float
    fee_per_side_brl: float
    slippage_ticks_per_side: float
    margin_daytrade_brl: float
    session_start_min: int
    session_end_min: int

    @property
    def tick_value(self) -> float:
        return self.tick_size * self.point_value

    def round_trip_cost(self, contracts: int) -> float:
        """Custo de ida e volta em R$: taxas dos dois lados + slippage dos dois lados."""
        per_contract = 2 * self.fee_per_side_brl + 2 * self.slippage_ticks_per_side * self.tick_value
        return contracts * per_contract

    def round_to_tick(self, price: float) -> float:
        return round(price / self.tick_size) * self.tick_size

    def ceil_points_to_tick(self, points: float) -> float:
        return math.ceil(points / self.tick_size - 1e-9) * self.tick_size

    def off_grid_fraction(self, prices: np.ndarray) -> float:
        prices = np.asarray(prices, dtype=float)
        prices = prices[np.isfinite(prices)]
        if prices.size == 0:
            return 0.0
        steps = prices / self.tick_size
        off = np.abs(steps - np.round(steps)) > 1e-6
        return float(off.mean())


def root_from_symbol(symbol: str | None) -> str | None:
    if not symbol:
        return None
    s = symbol.upper()
    for root in SUPPORTED_ROOTS:
        if s.startswith(root):
            return root
    return None


def spec_from_config(cfg: dict, root: str) -> ContractSpec:
    if root not in cfg["contracts"]:
        raise KeyError(f"contrato sem especificação na configuração: {root}")
    c = cfg["contracts"][root]
    return ContractSpec(
        root=root,
        tick_size=float(c["tick_size"]),
        point_value=float(c["point_value"]),
        fee_per_side_brl=float(c["fee_per_side_brl"]),
        slippage_ticks_per_side=float(c["slippage_ticks_per_side"]),
        margin_daytrade_brl=float(c["margin_daytrade_brl"]),
        session_start_min=hhmm_to_min(c["session_start"]),
        session_end_min=hhmm_to_min(c["session_end"]),
    )


def contracts_for_trade(
    spec: ContractSpec,
    stop_points: float,
    capital_brl: float,
    risk_frac: float,
    max_contracts: int,
) -> int:
    """Quantidade de contratos limitada por risco financeiro, margem e teto físico.

    Retorna 0 quando nem um contrato cabe no risco ou na margem: a operação deve ser
    pulada, nunca forçada para 1 contrato.
    """
    if stop_points <= 0:
        return 0
    risk_budget = capital_brl * risk_frac
    per_contract_risk = stop_points * spec.point_value + spec.round_trip_cost(1)
    by_risk = math.floor(risk_budget / per_contract_risk) if per_contract_risk > 0 else 0
    if spec.margin_daytrade_brl > 0:
        by_margin = math.floor(capital_brl / spec.margin_daytrade_brl)
    else:
        by_margin = max_contracts
    return max(0, min(int(max_contracts), by_risk, by_margin))
