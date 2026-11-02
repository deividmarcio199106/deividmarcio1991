"""Testes de ponta a ponta do funil: rodada delimitada, retomada, congelamento, teste único,
orçamento de teste, recusa de nova divisão e alertas."""

import json
import zipfile

import pandas as pd
import pytest

from qlab import catalog, report
from qlab.cli import main as cli_main
from qlab.runner import run_round
from qlab.state import SplitMismatch, State


def _quiet(_msg):
    pass


def test_random_data_nothing_survives(random_csv, cfg, tmp_path):
    db = tmp_path / "state" / "q.sqlite"
    out = run_round(random_csv, cfg, db, log=_quiet)
    assert out["status"] == "concluida"
    st = State(db)
    try:
        ds = st.db.execute("SELECT id FROM datasets").fetchone()["id"]
        assert st.count_trials(ds) > 100
        assert not st.alerts()
        assert all(not t["approved"] for t in st.test_evals(ds))
    finally:
        st.close()


def test_round_is_bounded_and_resumes_without_repeating(random_csv, cfg, tmp_path):
    db = tmp_path / "q.sqlite"
    small = {**cfg, "run": {**cfg["run"], "max_experiments": 25}}
    first = run_round(random_csv, small, db, families={"momentum", "tendencia"}, log=_quiet)
    assert first["status"] == "orcamento_experimentos" and first["experimentos"] == 25
    second = run_round(random_csv, small, db, families={"momentum", "tendencia"}, log=_quiet)
    assert second["experimentos"] <= 25
    st = State(db)
    try:
        ids = [r["id"] for r in st.db.execute("SELECT id FROM experiments").fetchall()]
        assert len(ids) == len(set(ids)), "experimento repetido"
        # 36 configurações de momentum + 12 de tendência: tudo feito em duas rodadas, sem repetir
        assert len(ids) == 48
        assert st.rounds()[0]["status"] == "orcamento_experimentos"
    finally:
        st.close()
    checkpoint = json.loads((tmp_path / "checkpoint.json").read_text())
    assert checkpoint["rodada"] == 2


def test_split_cannot_change_after_recorded(random_csv, cfg, tmp_path):
    db = tmp_path / "q.sqlite"
    small = {**cfg, "run": {**cfg["run"], "max_experiments": 5}}
    run_round(random_csv, small, db, families={"momentum"}, log=_quiet)
    other = {**small, "split": {"train": 0.5, "val": 0.25, "test": 0.25}}
    with pytest.raises(SplitMismatch):
        run_round(random_csv, other, db, families={"momentum"}, log=_quiet)


def test_planted_edge_passes_and_alerts_once(planted_csv, cfg, tmp_path):
    db = tmp_path / "q.sqlite"
    conf = {**cfg, "selection": {**cfg["selection"], "test_budget_per_dataset": 3}}
    run_round(planted_csv, conf, db, families={"abertura_rompimento"}, log=_quiet)
    st = State(db)
    try:
        ds = st.db.execute("SELECT id FROM datasets").fetchone()["id"]
        frozen = st.frozen(ds)
        tests = st.test_evals(ds)
        assert frozen, "a vantagem plantada deveria passar na validação e ser congelada"
        assert 1 <= len(tests) <= 3, "orçamento de teste respeitado"
        approved = [t for t in tests if t["approved"]]
        assert approved, "a vantagem plantada deveria passar no teste final"
        gates = json.loads(approved[0]["gates_json"])
        assert all(gates.values())
        assert len(st.alerts()) == len(approved)
        assert (tmp_path / "alertas.jsonl").exists()
        with pytest.raises(RuntimeError):
            st.save_test(approved[0]["frozen_id"], ds, {}, [], {}, True)
        n_tests = st.test_count(ds)
    finally:
        st.close()
    # Nova rodada não reavalia no teste o que já foi avaliado.
    run_round(planted_csv, conf, db, families={"abertura_rompimento"}, log=_quiet)
    st = State(db)
    try:
        assert st.test_count(ds) == n_tests
    finally:
        st.close()


def test_synthetic_never_alerts_even_if_it_passes(planted_csv, cfg, tmp_path):
    synth = tmp_path / "SINTETICO_planted.csv"
    synth.write_bytes(planted_csv.read_bytes())
    db = tmp_path / "s.sqlite"
    run_round(synth, cfg, db, families={"abertura_rompimento"}, log=_quiet)
    st = State(db)
    try:
        ds = st.db.execute("SELECT id, kind FROM datasets").fetchone()
        assert ds["kind"] == "sintetico"
        assert not st.alerts()
        assert all(not t["approved"] for t in st.test_evals(ds["id"]))
    finally:
        st.close()


def test_parallel_workers_match_sequential(random_csv, cfg, tmp_path):
    seq = {**cfg, "run": {**cfg["run"], "workers": 1}}
    par = {**cfg, "run": {**cfg["run"], "workers": 2, "batch_size": 4}}
    run_round(random_csv, seq, tmp_path / "a.sqlite", families={"momentum"}, run_test=False, log=_quiet)
    run_round(random_csv, par, tmp_path / "b.sqlite", families={"momentum"}, run_test=False, log=_quiet)

    def train_results(path):
        st = State(path)
        try:
            return {r["id"]: r["train_json"] for r in st.db.execute(
                "SELECT id, train_json FROM experiments WHERE strategy='momentum'").fetchall()}
        finally:
            st.close()

    a, b = train_results(tmp_path / "a.sqlite"), train_results(tmp_path / "b.sqlite")
    assert a and a == b


def test_report_and_cli(random_csv, cfg, tmp_path):
    db = tmp_path / "q.sqlite"
    run_round(random_csv, {**cfg, "run": {**cfg["run"], "max_experiments": 10}}, db, families={"momentum"}, log=_quiet)
    out = tmp_path / "results"
    info = report.build(db, out, cfg)
    html = (out / "relatorio.html").read_text(encoding="utf-8")
    assert "SINTÉTICO" in html and "Nenhum candidato aprovado" in html
    assert set(info["csv"]) >= {"experimentos.csv", "teste_final.csv", "mensal_teste.csv", "validacao.csv"}
    assert cli_main(["status", "--db", str(db)]) == 0


def test_catalog_finds_csv_zip_and_repos(tmp_path, random_csv):
    root = tmp_path / "arvore"
    (root / "sub").mkdir(parents=True)
    (root / "repo" / ".git").mkdir(parents=True)
    (root / "repo" / "estrategia_x.py").write_text("print(1)\n")
    (root / "sub" / "WDOFUT_F_0_5min_01-01-2026_01-11-2026.csv").write_bytes(random_csv.read_bytes())
    (root / "notas.csv").write_text("nome,idade\nana,3\n")
    with zipfile.ZipFile(root / "pacote.zip", "w") as zf:
        zf.writestr("dados/WINFUT_5min.csv", random_csv.read_bytes())
        zf.writestr("src/backtest.ts", "export {}")
    rows = pd.DataFrame(catalog.scan(root))
    kinds = dict(zip(rows["caminho"], rows["tipo"]))
    assert kinds["sub/WDOFUT_F_0_5min_01-01-2026_01-11-2026.csv"] == "csv"
    assert kinds["pacote.zip"] == "zip_repositorio"
    assert kinds["pacote.zip!dados/WINFUT_5min.csv"] == "csv_em_zip"
    pairs = set(zip(rows["caminho"], rows["tipo"]))
    assert ("repo", "repositorio_git") in pairs and ("repo", "codigo_estrategia") in pairs
    ohlc = rows.set_index("caminho")["ohlc"]
    assert ohlc["notas.csv"] == "nao" and ohlc["pacote.zip!dados/WINFUT_5min.csv"] == "sim"
