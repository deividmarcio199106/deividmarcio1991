"""Família ML: XGBoost prevendo a direção do preço nas próximas barras do mesmo pregão.

- Rótulo da barra t: sinal de close[t+h] - open[t+1], só quando t+h está no mesmo pregão.
  O rótulo olha o futuro de propósito e é usado SOMENTE como alvo de treino.
- Treino apenas nos pregões de treino; parada antecipada nos últimos 20% do treino.
- Limiar de probabilidade calibrado na validação; modelo e limiar são congelados
  (arquivo + hash) antes do teste final.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

import numpy as np
import pandas as pd

from .features import ML_FEATURES


def make_labels(feat: pd.DataFrame, horizon: int) -> np.ndarray:
    day = feat["day_idx"].to_numpy()
    o = feat["raw_open"].to_numpy(dtype=float)
    c = feat["raw_close"].to_numpy(dtype=float)
    n = len(day)
    y = np.full(n, np.nan)
    t = np.arange(n)
    e = t + 1
    x = t + horizon
    ok = (x < n)
    ok[ok] &= (day[e[ok]] == day[t[ok]]) & (day[x[ok]] == day[t[ok]])
    fwd = np.full(n, np.nan)
    fwd[ok] = c[x[ok]] - o[e[ok]]
    y[ok] = (fwd[ok] > 0).astype(float)
    return y


def feature_matrix(feat: pd.DataFrame) -> np.ndarray:
    return feat[ML_FEATURES].to_numpy(dtype=np.float32)


def train_model(feat: pd.DataFrame, train_mask_days: np.ndarray, horizon: int, device: str, seed: int):
    import xgboost as xgb

    day = feat["day_idx"].to_numpy()
    y = make_labels(feat, horizon)
    X = feature_matrix(feat)
    train_days = np.flatnonzero(train_mask_days)
    cut = train_days[int(len(train_days) * 0.8)] if len(train_days) >= 5 else train_days[-1]
    in_train = train_mask_days[day] & np.isfinite(y)
    fit_rows = in_train & (day < cut)
    es_rows = in_train & (day >= cut)
    if fit_rows.sum() < 200 or es_rows.sum() < 50:
        raise ValueError("amostra de treino insuficiente para o XGBoost")
    params = {
        "objective": "binary:logistic", "eval_metric": "logloss", "max_depth": 3, "eta": 0.05,
        "subsample": 0.8, "colsample_bytree": 0.8, "min_child_weight": 5, "tree_method": "hist",
        "device": device, "seed": seed, "nthread": 1,
    }
    dfit = xgb.DMatrix(X[fit_rows], label=y[fit_rows])
    des = xgb.DMatrix(X[es_rows], label=y[es_rows])
    model = xgb.train(params, dfit, num_boost_round=400, evals=[(des, "parada")], early_stopping_rounds=30,
                      verbose_eval=False)
    info = {
        "linhas_treino": int(fit_rows.sum()),
        "linhas_parada": int(es_rows.sum()),
        "melhor_iteracao": _best_iteration(model),
        "device": device,
        "horizonte_barras": horizon,
    }
    return model, info


def save_model(model, path: Path) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    model.save_model(str(path))
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_model(path: Path, expected_sha256: str):
    import xgboost as xgb

    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != expected_sha256:
        raise RuntimeError(f"modelo congelado alterado: {path} (hash {digest[:12]} != {expected_sha256[:12]})")
    model = xgb.Booster()
    model.load_model(str(path))
    return model


def _best_iteration(model) -> int:
    attr = model.attr("best_iteration")
    return int(attr) if attr is not None else -1


def predict_proba(model, feat: pd.DataFrame) -> np.ndarray:
    import xgboost as xgb

    best = _best_iteration(model)
    rng = (0, best + 1) if best >= 0 else (0, 0)
    return model.predict(xgb.DMatrix(feature_matrix(feat)), iteration_range=rng)


def signal_from_proba(proba: np.ndarray, threshold: float) -> np.ndarray:
    return np.where(proba > threshold, 1, np.where(proba < 1 - threshold, -1, 0)).astype(np.int8)
