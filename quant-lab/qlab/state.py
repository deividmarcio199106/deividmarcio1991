"""Estado persistente em SQLite: datasets, divisão, experimentos, congelamentos, teste e alertas.

Garantias implementadas aqui (não só documentadas):
- experimento repetido é ignorado (chave primária = hash de dataset+estratégia+parâmetros+
  divisão+versão do código);
- a divisão 60/20/20 de um dataset é gravada uma vez; outra divisão é recusada;
- cada candidato congelado é avaliado no teste no máximo uma vez (chave primária);
- o número total de avaliações no teste por dataset tem teto (orçamento de teste).
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import time
from pathlib import Path

import numpy as np

SCHEMA = """
CREATE TABLE IF NOT EXISTS datasets (
  id TEXT PRIMARY KEY, path TEXT, sha256 TEXT, symbol TEXT, root TEXT, timeframe_min INTEGER,
  kind TEXT, first_day TEXT, last_day TEXT, n_days INTEGER, registered_at REAL
);
CREATE TABLE IF NOT EXISTS splits (
  dataset_id TEXT PRIMARY KEY, spec_json TEXT, ranges_json TEXT, split_hash TEXT, created_at REAL
);
CREATE TABLE IF NOT EXISTS rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT, dataset_id TEXT, started_at REAL, finished_at REAL,
  status TEXT, budget_json TEXT, n_done INTEGER DEFAULT 0, note TEXT
);
CREATE TABLE IF NOT EXISTS experiments (
  id TEXT PRIMARY KEY, dataset_id TEXT, code_version TEXT, family TEXT, strategy TEXT, params_json TEXT,
  status TEXT, error TEXT, train_json TEXT, pre_pnl BLOB, pre_ntr BLOB, round_id INTEGER, created_at REAL
);
CREATE INDEX IF NOT EXISTS ix_exp_ds ON experiments(dataset_id, code_version);
CREATE TABLE IF NOT EXISTS val_evals (
  experiment_id TEXT PRIMARY KEY, dataset_id TEXT, kind TEXT, val_json TEXT, p_raw REAL,
  neighbor_frac REAL, evaluated_at REAL
);
CREATE TABLE IF NOT EXISTS frozen (
  id TEXT PRIMARY KEY, dataset_id TEXT, kind TEXT, payload_json TEXT, val_sharpe REAL, created_at REAL
);
CREATE TABLE IF NOT EXISTS test_evals (
  frozen_id TEXT PRIMARY KEY, dataset_id TEXT, metrics_json TEXT, monthly_json TEXT, gates_json TEXT,
  approved INTEGER, evaluated_at REAL
);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, frozen_id TEXT, dataset_id TEXT, message TEXT, created_at REAL
);
CREATE TABLE IF NOT EXISTS family_wf (
  dataset_id TEXT, code_version TEXT, family TEXT, wf_json TEXT, updated_at REAL,
  PRIMARY KEY (dataset_id, code_version, family)
);
"""


def stable_hash(obj) -> str:
    return hashlib.sha256(json.dumps(obj, sort_keys=True, separators=(",", ":"), default=str).encode()).hexdigest()


# Módulos cujo código muda o resultado de um experimento. Relatório, CLI e afins ficam de fora
# para que editar a apresentação não invalide experimentos já feitos.
RESULT_MODULES = ("backtest.py", "calendar_b3.py", "config.py", "contracts.py", "data.py", "features.py",
                  "metrics.py", "ml.py", "quality.py", "strategies.py")
# Seções da configuração que mudam o resultado de um experimento.
RESULT_CONFIG_SECTIONS = ("capital", "contracts", "calendar", "execution", "split", "ml")


def code_version() -> str:
    pkg = Path(__file__).resolve().parent
    h = hashlib.sha256()
    for name in RESULT_MODULES:
        h.update(name.encode())
        h.update((pkg / name).read_bytes())
    return h.hexdigest()[:12]


def config_fingerprint(cfg: dict) -> str:
    return stable_hash({k: cfg.get(k) for k in RESULT_CONFIG_SECTIONS})[:12]


class SplitMismatch(RuntimeError):
    pass


class State:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(self.path), timeout=30)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript(SCHEMA)
        self.db.commit()

    def close(self) -> None:
        self.db.close()

    # --- datasets e divisão -------------------------------------------------
    def register_dataset(self, ds, first_day: str, last_day: str, n_days: int) -> None:
        self.db.execute(
            "INSERT OR IGNORE INTO datasets VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (ds.dataset_id, ds.path, ds.sha256, ds.symbol, ds.root, ds.timeframe_min, ds.kind,
             first_day, last_day, n_days, time.time()),
        )
        self.db.commit()

    def dataset(self, dataset_id: str):
        return self.db.execute("SELECT * FROM datasets WHERE id=?", (dataset_id,)).fetchone()

    def ensure_split(self, dataset_id: str, spec: dict, ranges: dict) -> str:
        split_hash = stable_hash({"spec": spec, "ranges": ranges})
        row = self.db.execute("SELECT * FROM splits WHERE dataset_id=?", (dataset_id,)).fetchone()
        if row is None:
            self.db.execute("INSERT INTO splits VALUES (?,?,?,?,?)",
                            (dataset_id, json.dumps(spec), json.dumps(ranges), split_hash, time.time()))
            self.db.commit()
            return split_hash
        if row["split_hash"] != split_hash:
            raise SplitMismatch(
                "a divisão treino/validação/teste deste dataset já foi gravada com outros limites; "
                "mudar a divisão depois de ver resultados abriria o teste. Use outro --db para um estudo novo."
            )
        return split_hash

    def split(self, dataset_id: str):
        return self.db.execute("SELECT * FROM splits WHERE dataset_id=?", (dataset_id,)).fetchone()

    # --- rodadas ------------------------------------------------------------
    def start_round(self, dataset_id: str, budget: dict) -> int:
        self.db.execute("UPDATE rounds SET status='interrompida', finished_at=? WHERE status='executando'",
                        (time.time(),))
        cur = self.db.execute("INSERT INTO rounds(dataset_id, started_at, status, budget_json) VALUES (?,?,?,?)",
                              (dataset_id, time.time(), "executando", json.dumps(budget)))
        self.db.commit()
        return int(cur.lastrowid)

    def finish_round(self, round_id: int, status: str, n_done: int, note: str = "") -> None:
        self.db.execute("UPDATE rounds SET finished_at=?, status=?, n_done=?, note=? WHERE id=?",
                        (time.time(), status, n_done, note, round_id))
        self.db.commit()

    def rounds(self):
        return self.db.execute("SELECT * FROM rounds ORDER BY id").fetchall()

    # --- experimentos -------------------------------------------------------
    def done_ids(self, dataset_id: str, version: str) -> set[str]:
        rows = self.db.execute("SELECT id FROM experiments WHERE dataset_id=? AND code_version=?",
                               (dataset_id, version)).fetchall()
        return {r["id"] for r in rows}

    def save_experiment(self, rec: dict, round_id: int) -> None:
        self.db.execute(
            "INSERT OR IGNORE INTO experiments VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (rec["id"], rec["dataset_id"], rec["code_version"], rec["family"], rec["strategy"],
             rec["params_json"], rec["status"], rec.get("error"), json.dumps(rec.get("train")),
             _blob(rec.get("pre_pnl"), np.float32), _blob(rec.get("pre_ntr"), np.int16), round_id, time.time()),
        )

    def commit(self) -> None:
        self.db.commit()

    def experiments(self, dataset_id: str, version: str | None = None):
        if version:
            return self.db.execute("SELECT * FROM experiments WHERE dataset_id=? AND code_version=? AND status='ok'",
                                   (dataset_id, version)).fetchall()
        return self.db.execute("SELECT * FROM experiments WHERE dataset_id=? AND status='ok'", (dataset_id,)).fetchall()

    def count_trials(self, dataset_id: str) -> int:
        return int(self.db.execute("SELECT COUNT(*) FROM experiments WHERE dataset_id=? AND status='ok'",
                                   (dataset_id,)).fetchone()[0])

    # --- validação, congelamento e teste ------------------------------------
    def val_eval(self, experiment_id: str):
        return self.db.execute("SELECT * FROM val_evals WHERE experiment_id=?", (experiment_id,)).fetchone()

    def save_val(self, experiment_id: str, dataset_id: str, kind: str, val: dict, p_raw: float,
                 neighbor_frac: float | None) -> None:
        self.db.execute("INSERT OR IGNORE INTO val_evals VALUES (?,?,?,?,?,?,?)",
                        (experiment_id, dataset_id, kind, json.dumps(val), p_raw, neighbor_frac, time.time()))
        self.db.commit()

    def val_evals(self, dataset_id: str):
        return self.db.execute("SELECT * FROM val_evals WHERE dataset_id=? ORDER BY evaluated_at",
                               (dataset_id,)).fetchall()

    def freeze(self, dataset_id: str, kind: str, payload: dict, val_sharpe: float) -> str:
        frozen_id = stable_hash({"dataset": dataset_id, "kind": kind, "payload": payload})[:16]
        self.db.execute("INSERT OR IGNORE INTO frozen VALUES (?,?,?,?,?,?)",
                        (frozen_id, dataset_id, kind, json.dumps(payload, sort_keys=True), val_sharpe, time.time()))
        self.db.commit()
        return frozen_id

    def frozen(self, dataset_id: str):
        return self.db.execute("SELECT * FROM frozen WHERE dataset_id=? ORDER BY val_sharpe DESC, created_at",
                               (dataset_id,)).fetchall()

    def test_count(self, dataset_id: str) -> int:
        return int(self.db.execute("SELECT COUNT(*) FROM test_evals WHERE dataset_id=?", (dataset_id,)).fetchone()[0])

    def test_eval(self, frozen_id: str):
        return self.db.execute("SELECT * FROM test_evals WHERE frozen_id=?", (frozen_id,)).fetchone()

    def save_test(self, frozen_id: str, dataset_id: str, metrics: dict, monthly: list, gates: dict,
                  approved: bool) -> None:
        try:
            self.db.execute("INSERT INTO test_evals VALUES (?,?,?,?,?,?,?)",
                            (frozen_id, dataset_id, json.dumps(metrics), json.dumps(monthly), json.dumps(gates),
                             int(approved), time.time()))
        except sqlite3.IntegrityError as exc:
            raise RuntimeError(f"candidato {frozen_id} já foi avaliado no teste; reavaliar é proibido") from exc
        self.db.commit()

    def test_evals(self, dataset_id: str | None = None):
        if dataset_id:
            return self.db.execute("SELECT * FROM test_evals WHERE dataset_id=? ORDER BY evaluated_at",
                                   (dataset_id,)).fetchall()
        return self.db.execute("SELECT * FROM test_evals ORDER BY evaluated_at").fetchall()

    def add_alert(self, frozen_id: str, dataset_id: str, message: str) -> None:
        self.db.execute("INSERT INTO alerts(frozen_id, dataset_id, message, created_at) VALUES (?,?,?,?)",
                        (frozen_id, dataset_id, message, time.time()))
        self.db.commit()

    def alerts(self):
        return self.db.execute("SELECT * FROM alerts ORDER BY id").fetchall()

    def save_wf(self, dataset_id: str, version: str, family: str, wf: dict) -> None:
        self.db.execute("INSERT OR REPLACE INTO family_wf VALUES (?,?,?,?,?)",
                        (dataset_id, version, family, json.dumps(wf), time.time()))
        self.db.commit()

    def wf(self, dataset_id: str, version: str):
        return self.db.execute("SELECT * FROM family_wf WHERE dataset_id=? AND code_version=?",
                               (dataset_id, version)).fetchall()


def _blob(arr, dtype) -> bytes | None:
    if arr is None:
        return None
    return np.asarray(arr, dtype=dtype).tobytes()


def unblob(data: bytes | None, dtype) -> np.ndarray:
    if data is None:
        return np.zeros(0, dtype=dtype)
    return np.frombuffer(data, dtype=dtype).copy()
