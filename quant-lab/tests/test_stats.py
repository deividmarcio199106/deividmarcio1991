import numpy as np
import pytest

from qlab.stats import bonferroni, deflated_sharpe, holm_adjust, stationary_bootstrap_pvalue


def test_holm_matches_reference():
    # exemplo clássico: p = [0.01, 0.04, 0.03, 0.005], m = 4
    adj = holm_adjust([0.01, 0.04, 0.03, 0.005])
    assert adj == pytest.approx([0.03, 0.06, 0.06, 0.02])


def test_bonferroni_caps_at_one():
    assert bonferroni(0.3, 10) == 1.0 and bonferroni(0.01, 5) == pytest.approx(0.05)


def test_bootstrap_detects_edge_and_rejects_noise():
    rng = np.random.default_rng(1)
    strong = rng.normal(50, 20, size=120)
    noise = rng.normal(0, 20, size=120)
    assert stationary_bootstrap_pvalue(strong, 500, 5, seed=2) < 0.01
    assert stationary_bootstrap_pvalue(noise, 500, 5, seed=2) > 0.05


def test_deflated_sharpe_penalizes_many_trials():
    rng = np.random.default_rng(3)
    pnl = rng.normal(5, 20, size=60)
    few = deflated_sharpe(pnl, n_trials=1, trial_sr_variance=0.01)["dsr"]
    many = deflated_sharpe(pnl, n_trials=1000, trial_sr_variance=0.01)["dsr"]
    assert few > many
