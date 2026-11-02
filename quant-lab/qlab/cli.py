"""Interface de linha de comando: python -m qlab <comando>."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path

import pandas as pd

from . import catalog as catalog_mod
from . import gpu, report, synthetic
from .config import load_config
from .contracts import spec_from_config
from .data import SYNTHETIC_PREFIX, describe_json, load_dataset
from .quality import quality_report
from .runner import run_round
from .state import State

BASE = Path(__file__).resolve().parent.parent
DEFAULT_DB = BASE / "state" / "qlab.sqlite"
DEFAULT_RESULTS = BASE / "results"


def _cfg(args) -> dict:
    overrides: dict = {"run": {}}
    for key in ("max_experiments", "max_minutes", "workers", "device"):
        val = getattr(args, key, None)
        if val is not None:
            overrides["run"][key] = val
    return load_config(getattr(args, "config", None), overrides)


def cmd_catalog(args) -> int:
    rows = catalog_mod.scan(args.root, exclude={BASE / "state", BASE / ".venv", BASE / "results"})
    df = pd.DataFrame(rows).reindex(columns=catalog_mod.COLUMNS)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    df.to_csv(out / "catalogo_datasets.csv", index=False)
    ohlc = df[(df["ohlc"] == "sim")] if "ohlc" in df else df.iloc[0:0]
    print(f"{len(df)} itens catalogados em {args.root}; {len(ohlc)} CSV com OHLC reconhecido")
    for r in df.itertuples(index=False):
        print(f"  [{r.tipo}] {r.caminho} {'' if pd.isna(r.observacao) else '— ' + str(r.observacao)}")
    if ohlc.empty:
        print("Nenhum histórico OHLC encontrado: sem dados não há pesquisa a fazer.")
    return 0


def cmd_inspect(args) -> int:
    ds = load_dataset(args.file, root_override=args.root)
    print(describe_json(ds))
    return 0


def cmd_quality(args) -> int:
    cfg = load_config(args.config)
    ds = load_dataset(args.file, root_override=args.root)
    if ds.root is None:
        print("não identifiquei WIN/WDO; use --root", file=sys.stderr)
        return 2
    q = quality_report(ds, spec_from_config(cfg, ds.root), int(cfg["calendar"]["roll_days_before"]))
    print(json.dumps(q, ensure_ascii=False, indent=2, default=str))
    if args.out:
        out = Path(args.out)
        out.mkdir(parents=True, exist_ok=True)
        pd.DataFrame(q["checks"]).to_csv(out / f"qualidade_{ds.dataset_id}.csv", index=False)
    return 0


def cmd_gpu_check(_args) -> int:
    info = gpu.detect()
    print(json.dumps(info, ensure_ascii=False, indent=2))
    print("device escolhido em modo auto:", gpu.choose_device("auto", info))
    return 0


def cmd_gpu_bench(args) -> int:
    print(json.dumps(gpu.bench_xgboost(args.rows), ensure_ascii=False, indent=2))
    return 0


def cmd_run(args) -> int:
    cfg = _cfg(args)
    families = set(args.families.split(",")) if args.families else None
    if args.rounds < 1 or args.rounds > 100:
        print("--rounds deve ficar entre 1 e 100", file=sys.stderr)
        return 2
    summary = {"status": "nenhuma"}
    for i in range(args.rounds):
        summary = run_round(args.data, cfg, args.db, root=args.root, families=families, run_test=not args.no_test)
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        if summary["status"] in ("interrompida", "erro") or summary["experimentos"] == 0:
            if summary["experimentos"] == 0 and i > 0:
                print("fila esgotada: nada novo a testar com esta grade/código/configuração")
            break
    if args.report:
        info = report.build(args.db, args.report, cfg)
        print(f"relatório: {info['html']}")
    return 0 if summary["status"] != "erro" else 1


def cmd_status(args) -> int:
    if not Path(args.db).exists():
        print(f"sem estado em {args.db}")
        return 0
    st = State(args.db)
    try:
        for ds in st.db.execute("SELECT * FROM datasets").fetchall():
            n_exp = st.db.execute("SELECT COUNT(*) FROM experiments WHERE dataset_id=?", (ds["id"],)).fetchone()[0]
            n_val = len(st.val_evals(ds["id"]))
            n_frozen = len(st.frozen(ds["id"]))
            n_test = st.test_count(ds["id"])
            print(f"{ds['id']} {ds['symbol']} ({ds['kind']}): {n_exp} experimentos, {n_val} validados, "
                  f"{n_frozen} congelados, {n_test} avaliados no teste")
        for r in st.rounds():
            print(f"  rodada {r['id']}: {r['status']} ({r['n_done']} experimentos)")
        for a in st.alerts():
            print(f"  ALERTA: {a['message']}")
    finally:
        st.close()
    return 0


def cmd_report(args) -> int:
    info = report.build(args.db, args.out, load_config(args.config))
    print(f"relatório: {info['html']}")
    return 0


def cmd_make_synthetic(args) -> int:
    out = Path(args.out)
    if not out.name.upper().startswith(SYNTHETIC_PREFIX):
        out = out.with_name(SYNTHETIC_PREFIX + out.name)
    df = synthetic.generate(args.root, date.fromisoformat(args.start), date.fromisoformat(args.end), seed=args.seed)
    synthetic.write_profit_csv(df, out, f"{args.root}FUT")
    print(f"dados SINTÉTICOS gravados em {out} ({len(df)} barras) — só para testar o software")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="qlab", description="Laboratório quantitativo WIN/WDO (pesquisa, sem ordens)")
    sub = p.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser("catalog", help="cataloga CSV, ZIP e repositórios de estratégias")
    c.add_argument("--root", default=".")
    c.add_argument("--out", default=str(DEFAULT_RESULTS))
    c.set_defaults(fn=cmd_catalog)

    c = sub.add_parser("inspect", help="mostra o esquema detectado de um CSV")
    c.add_argument("file")
    c.add_argument("--root", choices=["WIN", "WDO"])
    c.set_defaults(fn=cmd_inspect)

    c = sub.add_parser("quality", help="verifica grade, horários, calendário B3 e rolagem")
    c.add_argument("file")
    c.add_argument("--root", choices=["WIN", "WDO"])
    c.add_argument("--config")
    c.add_argument("--out")
    c.set_defaults(fn=cmd_quality)

    c = sub.add_parser("gpu-check", help="detecta GPU/CUDA")
    c.set_defaults(fn=cmd_gpu_check)
    c = sub.add_parser("gpu-bench", help="compara XGBoost em CPU e CUDA")
    c.add_argument("--rows", type=int, default=200_000)
    c.set_defaults(fn=cmd_gpu_bench)

    c = sub.add_parser("run", help="executa UMA rodada delimitada (retoma de onde parou)")
    c.add_argument("--data", required=True)
    c.add_argument("--root", choices=["WIN", "WDO"])
    c.add_argument("--db", default=str(DEFAULT_DB))
    c.add_argument("--config")
    c.add_argument("--max-experiments", dest="max_experiments", type=int)
    c.add_argument("--max-minutes", dest="max_minutes", type=float)
    c.add_argument("--workers", type=int)
    c.add_argument("--device", choices=["auto", "cpu", "cuda"])
    c.add_argument("--families", help="lista separada por vírgula, ex.: momentum,ml")
    c.add_argument("--no-test", action="store_true", help="congela candidatos sem avaliar no teste final")
    c.add_argument("--rounds", type=int, default=1, help="rodadas seguidas (1-100); para antes se a fila esvaziar")
    c.add_argument("--report", help="diretório para gerar o relatório ao final")
    c.set_defaults(fn=cmd_run)

    c = sub.add_parser("status", help="resume o estado gravado")
    c.add_argument("--db", default=str(DEFAULT_DB))
    c.set_defaults(fn=cmd_status)

    c = sub.add_parser("report", help="gera CSVs e relatório HTML")
    c.add_argument("--db", default=str(DEFAULT_DB))
    c.add_argument("--out", default=str(DEFAULT_RESULTS))
    c.add_argument("--config")
    c.set_defaults(fn=cmd_report)

    c = sub.add_parser("make-synthetic", help="gera CSV SINTÉTICO só para testar o software")
    c.add_argument("--root", choices=["WIN", "WDO"], required=True)
    c.add_argument("--start", required=True)
    c.add_argument("--end", required=True)
    c.add_argument("--out", required=True)
    c.add_argument("--seed", type=int, default=0)
    c.set_defaults(fn=cmd_make_synthetic)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return int(args.fn(args) or 0)
