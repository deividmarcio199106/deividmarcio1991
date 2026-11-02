"""Catalogação de CSV, ZIP e repositórios de estratégias em uma árvore de diretórios.

Só lê arquivos: ZIPs são inspecionados em memória, nunca extraídos em disco.
"""

from __future__ import annotations

import hashlib
import os
import re
import zipfile
from pathlib import Path

from .data import DataFormatError, infer_timeframe_min, parse_filename, read_bars

SKIP_DIRS = {".git", "node_modules", ".venv", "venv", "__pycache__", ".output", "dist", ".pytest_cache"}
CODE_EXT = {".py", ".ts", ".tsx", ".js", ".mjs", ".ipynb", ".r", ".mq5", ".ntsl", ".cs"}
STRATEGY_HINT = re.compile(r"(strateg|estrateg|setup|backtest|signal|sinal|t4|wyckoff|quant)", re.I)
MAX_CSV_BYTES = 200 * 1024 * 1024


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _csv_row(raw: bytes, name: str) -> dict:
    meta = parse_filename(name)
    row = {"simbolo": meta.get("symbol", ""), "timeframe_min": meta.get("timeframe_min", "")}
    try:
        bars, schema, issues = read_bars(raw, name)
    except DataFormatError as exc:
        row.update(ohlc="nao", observacao=f"não reconhecido como OHLC: {exc}")
        return row
    tf = infer_timeframe_min(bars["ts"])
    row.update(
        ohlc="sim",
        simbolo=schema.get("simbolo_no_arquivo") or row["simbolo"],
        timeframe_min=tf if tf is not None else "diario/indefinido",
        primeira_data=str(bars["ts"].iloc[0]) if len(bars) else "",
        ultima_data=str(bars["ts"].iloc[-1]) if len(bars) else "",
        linhas=len(bars),
        pregoes=int(bars["ts"].dt.normalize().nunique()) if len(bars) else 0,
        esquema=f"{schema['layout']} sep={schema['separador']!r} dec={schema['decimal']!r}",
        observacao="; ".join(issues),
    )
    return row


def scan(root: str | Path, exclude: set[Path] | None = None) -> list[dict]:
    root = Path(root).resolve()
    exclude = {p.resolve() for p in (exclude or set())}
    rows: list[dict] = []
    code_by_top: dict[str, int] = {}
    for dirpath, dirnames, filenames in os.walk(root):
        here = Path(dirpath)
        if ".git" in dirnames:
            rows.append({"caminho": str(here.relative_to(root)) or ".", "tipo": "repositorio_git",
                         "observacao": "repositório git"})
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and (here / d).resolve() not in exclude]
        for fn in filenames:
            path = here / fn
            rel = str(path.relative_to(root))
            ext = path.suffix.lower()
            if ext in CODE_EXT and STRATEGY_HINT.search(rel):
                top = rel.split(os.sep)[0]
                code_by_top[top] = code_by_top.get(top, 0) + 1
            if ext not in (".csv", ".zip"):
                continue
            size = path.stat().st_size
            base = {"caminho": rel, "tamanho_bytes": size, "sha256": _sha256_file(path)}
            if ext == ".csv":
                if size > MAX_CSV_BYTES:
                    rows.append({**base, "tipo": "csv", "observacao": "grande demais para inspeção automática"})
                else:
                    rows.append({**base, "tipo": "csv", **_csv_row(path.read_bytes(), fn)})
            else:
                rows.extend(_zip_rows(path, rel, base))
    for top, n in sorted(code_by_top.items()):
        rows.append({"caminho": top, "tipo": "codigo_estrategia",
                     "observacao": f"{n} arquivos de código com nome ligado a estratégia/backtest"})
    return rows


def _zip_rows(path: Path, rel: str, base: dict) -> list[dict]:
    rows = []
    try:
        with zipfile.ZipFile(path) as zf:
            infos = [i for i in zf.infolist() if not i.is_dir()]
            csvs = [i for i in infos if i.filename.lower().endswith(".csv")]
            code = [i for i in infos if Path(i.filename).suffix.lower() in CODE_EXT]
            strat = [i for i in code if STRATEGY_HINT.search(i.filename)]
            kind = "zip_repositorio" if code else "zip"
            rows.append({**base, "tipo": kind, "observacao":
                         f"{len(infos)} arquivos; {len(csvs)} CSV; {len(code)} de código "
                         f"({len(strat)} ligados a estratégia/backtest)"})
            for info in csvs:
                if info.file_size > MAX_CSV_BYTES:
                    rows.append({"caminho": f"{rel}!{info.filename}", "tipo": "csv_em_zip",
                                 "tamanho_bytes": info.file_size, "observacao": "grande demais"})
                    continue
                raw = zf.read(info)
                rows.append({"caminho": f"{rel}!{info.filename}", "tipo": "csv_em_zip",
                             "tamanho_bytes": info.file_size, "sha256": hashlib.sha256(raw).hexdigest(),
                             **_csv_row(raw, Path(info.filename).name)})
    except zipfile.BadZipFile:
        rows.append({**base, "tipo": "zip", "observacao": "ZIP inválido ou corrompido"})
    return rows


COLUMNS = ["caminho", "tipo", "ohlc", "simbolo", "timeframe_min", "primeira_data", "ultima_data", "linhas",
           "pregoes", "tamanho_bytes", "sha256", "esquema", "observacao"]
