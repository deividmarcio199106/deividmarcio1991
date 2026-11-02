"""Detecção de GPU/CUDA e escolha do dispositivo.

A GPU só é usada onde há ganho real: no treino do XGBoost (`device="cuda"`). A simulação
de estratégias é um laço por operação, limitado por CPU; ela é paralelizada em processos
(ver runner.py), não na GPU. `qlab gpu-bench` mede CPU x CUDA no XGBoost antes de você
decidir.
"""

from __future__ import annotations

import shutil
import subprocess
import time

import numpy as np


def detect() -> dict:
    info: dict = {"nvidia_smi": None, "gpus": [], "xgboost_cuda_build": None, "xgboost_cuda_ok": False,
                  "cupy": None}
    exe = shutil.which("nvidia-smi")
    info["nvidia_smi"] = exe
    if exe:
        try:
            out = subprocess.run(
                [exe, "--query-gpu=name,driver_version,memory.total", "--format=csv,noheader"],
                capture_output=True, text=True, timeout=20, check=False,
            )
            info["gpus"] = [ln.strip() for ln in out.stdout.splitlines() if ln.strip()]
        except (OSError, subprocess.SubprocessError) as exc:
            info["erro_nvidia_smi"] = str(exc)
    try:
        import xgboost as xgb

        info["xgboost_versao"] = xgb.__version__
        info["xgboost_cuda_build"] = bool(xgb.build_info().get("USE_CUDA"))
        if info["xgboost_cuda_build"] and info["gpus"]:
            info["xgboost_cuda_ok"] = _xgb_cuda_smoke()
    except ImportError:
        info["xgboost_versao"] = None
    try:
        import cupy  # noqa: F401

        info["cupy"] = "instalado"
    except ImportError:
        info["cupy"] = "ausente (opcional)"
    return info


def _xgb_cuda_smoke() -> bool:
    try:
        import xgboost as xgb

        rng = np.random.default_rng(0)
        X = rng.normal(size=(256, 4))
        y = (X[:, 0] > 0).astype(int)
        xgb.train({"device": "cuda", "tree_method": "hist", "objective": "binary:logistic"},
                  xgb.DMatrix(X, label=y), num_boost_round=5)
        return True
    except Exception:  # noqa: BLE001
        return False


def choose_device(preference: str, info: dict | None = None) -> str:
    if preference == "cpu":
        return "cpu"
    info = info or detect()
    available = bool(info.get("xgboost_cuda_ok"))
    if preference == "cuda" and not available:
        raise RuntimeError("device=cuda pedido, mas CUDA não está disponível para o XGBoost (rode `qlab gpu-check`)")
    return "cuda" if available else "cpu"


def bench_xgboost(n_rows: int = 200_000, n_features: int = 16, seed: int = 0) -> dict:
    import xgboost as xgb

    rng = np.random.default_rng(seed)
    X = rng.normal(size=(n_rows, n_features)).astype(np.float32)
    y = (X[:, 0] + 0.5 * rng.normal(size=n_rows) > 0).astype(int)
    out = {"linhas": n_rows, "colunas": n_features}
    info = detect()
    devices = ["cpu"] + (["cuda"] if info.get("xgboost_cuda_ok") else [])
    for dev in devices:
        start = time.perf_counter()
        xgb.train({"device": dev, "tree_method": "hist", "max_depth": 6, "objective": "binary:logistic"},
                  xgb.DMatrix(X, label=y), num_boost_round=200)
        out[f"segundos_{dev}"] = round(time.perf_counter() - start, 3)
    if "segundos_cuda" in out:
        out["recomendacao"] = "cuda" if out["segundos_cuda"] < out["segundos_cpu"] * 0.8 else "cpu"
    else:
        out["recomendacao"] = "cpu (CUDA indisponível)"
    return out
