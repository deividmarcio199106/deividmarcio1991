"""Carregamento e validação da configuração (TOML)."""

from __future__ import annotations

import copy
import tomllib
from pathlib import Path
from typing import Any

DEFAULT_CONFIG_PATH = Path(__file__).resolve().parent.parent / "config" / "default.toml"


class ConfigError(ValueError):
    pass


def hhmm_to_min(value: str) -> int:
    """Converte "HH:MM" em minutos desde a meia-noite."""
    try:
        hours, minutes = value.strip().split(":")
        result = int(hours) * 60 + int(minutes)
    except Exception as exc:  # noqa: BLE001
        raise ConfigError(f"horário inválido: {value!r}") from exc
    if not 0 <= result < 24 * 60:
        raise ConfigError(f"horário fora do dia: {value!r}")
    return result


def _deep_merge(base: dict, extra: dict) -> dict:
    out = copy.deepcopy(base)
    for key, value in extra.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _deep_merge(out[key], value)
        else:
            out[key] = copy.deepcopy(value)
    return out


def load_config(path: str | Path | None = None, overrides: dict | None = None) -> dict[str, Any]:
    with open(DEFAULT_CONFIG_PATH, "rb") as fh:
        cfg = tomllib.load(fh)
    if path is not None:
        with open(path, "rb") as fh:
            cfg = _deep_merge(cfg, tomllib.load(fh))
    if overrides:
        cfg = _deep_merge(cfg, overrides)
    validate_config(cfg)
    return cfg


def validate_config(cfg: dict) -> None:
    split = cfg["split"]
    total = split["train"] + split["val"] + split["test"]
    if abs(total - 1.0) > 1e-9 or min(split.values()) <= 0:
        raise ConfigError("split deve ter train/val/test positivos somando 1.0")
    capital = cfg["capital"]
    if capital["capital_brl"] <= 0 or capital["max_contracts"] < 1:
        raise ConfigError("capital e max_contracts devem ser positivos")
    if not 0 < capital["risk_per_trade_frac"] <= 1:
        raise ConfigError("risk_per_trade_frac deve estar em (0, 1]")
    for root, spec in cfg["contracts"].items():
        for key in ("tick_size", "point_value"):
            if spec[key] <= 0:
                raise ConfigError(f"{root}.{key} deve ser positivo")
        hhmm_to_min(spec["session_start"])
        hhmm_to_min(spec["session_end"])
    ex = cfg["execution"]
    if hhmm_to_min(ex["last_entry_time"]) >= hhmm_to_min(ex["flat_time"]):
        raise ConfigError("last_entry_time deve ser anterior a flat_time")
    run = cfg["run"]
    if run["max_experiments"] < 0 or run["max_minutes"] <= 0:
        raise ConfigError("orçamento da rodada deve ser limitado e positivo")
    if run["device"] not in ("auto", "cpu", "cuda"):
        raise ConfigError("run.device deve ser auto, cpu ou cuda")
