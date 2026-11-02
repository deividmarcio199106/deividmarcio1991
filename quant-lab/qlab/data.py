"""Leitura robusta de históricos OHLC em CSV (Profit, Bolsa Quant Pro, exportações ISO).

O formato exato do CSV da Bolsa Quant Pro não estava disponível para conferência. O
leitor detecta separador, decimal, cabeçalho e formato de data, e falha com mensagem
clara quando não reconhece o arquivo, em vez de adivinhar colunas.
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import re
import unicodedata
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd

from .contracts import root_from_symbol


class DataFormatError(ValueError):
    pass


ALIASES: dict[str, set[str]] = {
    "symbol": {"ativo", "symbol", "ticker", "papel", "codigo", "asset", "instrumento"},
    "date": {"data", "date", "dia", "pregao"},
    "time": {"hora", "time", "horario"},
    "datetime": {"datetime", "data_hora", "datahora", "timestamp", "date_time", "dt", "data_e_hora"},
    "open": {"abertura", "open", "abert", "preco_abertura"},
    "high": {"maxima", "maximo", "max", "high", "preco_maximo"},
    "low": {"minima", "minimo", "min", "low", "preco_minimo"},
    "close": {"fechamento", "close", "ultimo", "fech", "last", "preco_fechamento"},
    "volume": {"volume", "vol", "volume_financeiro", "financeiro", "volume_brl"},
    "qty": {"quantidade", "qtd", "qty", "contratos", "volume_qtd", "quantity", "vol_qtd", "tickvol", "tick_volume"},
    "trades": {"negocios", "trades", "numero_de_negocios", "n_negocios", "num_trades"},
    "buy_volume": {"volume_comprador", "buy_volume", "agressao_compra", "vol_compra"},
    "sell_volume": {"volume_vendedor", "sell_volume", "agressao_venda", "vol_venda"},
}
REQUIRED = ("open", "high", "low", "close")
PROFIT_HEADERLESS_9 = ["symbol", "date", "time", "open", "high", "low", "close", "volume", "qty"]

FILENAME_RE = re.compile(
    r"(?P<symbol>(?:WIN|WDO|IND|DOL)[A-Z0-9$]*)[_-].*?(?P<tf>\d+)\s*min"
    r"(?:[_-](?P<d1>\d{2}-\d{2}-\d{4})[_-](?P<d2>\d{2}-\d{2}-\d{4}))?",
    re.IGNORECASE,
)
SYNTHETIC_PREFIX = "SINTETICO_"


def normalize_name(name: str) -> str:
    text = unicodedata.normalize("NFKD", str(name)).encode("ascii", "ignore").decode("ascii")
    text = text.strip().lower()
    text = re.sub(r"[\s./\\\-()]+", "_", text)
    return re.sub(r"_+", "_", text).strip("_")


def map_columns(header: list[str]) -> dict[str, int]:
    mapping: dict[str, int] = {}
    for idx, raw in enumerate(header):
        key = normalize_name(raw)
        for canon, names in ALIASES.items():
            if key in names and canon not in mapping:
                mapping[canon] = idx
                break
    return mapping


def parse_filename(name: str) -> dict:
    """Extrai símbolo, timeframe e intervalo de datas de nomes como
    WDOFUT_F_0_5min_01-01-2026_01-11-2026.csv (datas em dd-mm-aaaa)."""
    m = FILENAME_RE.search(Path(name).name)
    if not m:
        return {}
    out: dict = {"symbol": m.group("symbol").upper(), "timeframe_min": int(m.group("tf"))}
    for key in ("d1", "d2"):
        if m.group(key):
            dd, mm, yyyy = m.group(key).split("-")
            try:
                out["start" if key == "d1" else "end"] = date(int(yyyy), int(mm), int(dd))
            except ValueError:
                pass
    return out


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _decode(raw: bytes) -> str:
    for enc in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    raise DataFormatError("codificação de texto não reconhecida")


def _detect_sep(first_line: str) -> str:
    counts = {sep: first_line.count(sep) for sep in (";", "\t", ",")}
    sep = max(counts, key=lambda s: counts[s])
    if counts[sep] == 0:
        raise DataFormatError("não foi possível detectar o separador de colunas")
    return sep


def _detect_decimal(values: list[str]) -> tuple[str, bool]:
    """Retorna (separador decimal, '.' é separador de milhar)."""
    values = [v.strip() for v in values if v and v.strip()]
    both = [v for v in values if "," in v and "." in v]
    if both:
        v = both[0]
        return ("," if v.rfind(",") > v.rfind(".") else "."), True
    if any("," in v for v in values):
        return ",", False
    if values and all(re.fullmatch(r"\d{1,3}(\.\d{3})+", v) for v in values):
        # 128.455 sem casas decimais: o ponto é milhar (ex.: WIN 128455).
        return ",", True
    return ".", False


def _to_number(series: pd.Series, decimal: str) -> pd.Series:
    text = series.astype(str).str.strip()
    if decimal == ",":
        text = text.str.replace(".", "", regex=False).str.replace(",", ".", regex=False)
    else:
        text = text.str.replace(",", "", regex=False)
    return pd.to_numeric(text, errors="coerce")


def _parse_datetime(date_s: pd.Series, time_s: pd.Series | None) -> pd.Series:
    d = date_s.astype(str).str.strip()
    sample = d.iloc[0] if len(d) else ""
    if time_s is not None:
        t = time_s.astype(str).str.strip()
        t = t.where(t.str.count(":") >= 2, t + ":00")
        d = d + " " + t
    if re.match(r"^\d{4}-\d{2}-\d{2}", sample):
        ts = pd.to_datetime(d, format="ISO8601", errors="coerce")
    elif re.match(r"^\d{2}[/.\-]\d{2}[/.\-]\d{4}", sample):
        d = d.str.replace(r"^(\d{2})[.\-](\d{2})[.\-](\d{4})", r"\1/\2/\3", regex=True)
        fmt = "%d/%m/%Y %H:%M:%S" if (time_s is not None or ":" in sample) else "%d/%m/%Y"
        if time_s is None and ":" in sample and sample.count(":") == 1:
            fmt = "%d/%m/%Y %H:%M"
        ts = pd.to_datetime(d, format=fmt, errors="coerce")
    else:
        raise DataFormatError(f"formato de data não reconhecido: {sample!r}")
    if getattr(ts.dt, "tz", None) is not None:
        ts = ts.dt.tz_convert("America/Sao_Paulo").dt.tz_localize(None)
    return ts.astype("datetime64[ns]")


@dataclass
class Dataset:
    path: str
    sha256: str
    symbol: str
    root: str | None
    timeframe_min: int | None
    kind: str  # "real" | "sintetico"
    bars: pd.DataFrame
    schema: dict = field(default_factory=dict)
    issues: list[str] = field(default_factory=list)

    @property
    def dataset_id(self) -> str:
        return self.sha256[:16]


def read_bars(raw: bytes, name: str = "") -> tuple[pd.DataFrame, dict, list[str]]:
    """Lê bytes de um CSV e devolve (barras normalizadas, esquema detectado, avisos)."""
    text = _decode(raw)
    lines = [ln for ln in text.splitlines() if ln.strip()]
    if len(lines) < 2:
        raise DataFormatError("arquivo sem linhas de dados suficientes")
    sep = _detect_sep(lines[0])
    rows = list(csv.reader(io.StringIO("\n".join(lines)), delimiter=sep))
    header = rows[0]
    mapping = map_columns(header)
    issues: list[str] = []
    if sum(k in mapping for k in REQUIRED) >= 3:
        body = rows[1:]
        layout = "cabecalho"
    elif (
        len(header) == 9
        and re.fullmatch(r"[A-Za-z]{3,}[A-Za-z0-9$]*", header[0].strip())
        and re.match(r"^\d{2}/\d{2}/\d{4}$", header[1].strip())
    ):
        mapping = {k: i for i, k in enumerate(PROFIT_HEADERLESS_9)}
        body = rows
        layout = "profit_sem_cabecalho_9_colunas"
        issues.append("arquivo sem cabeçalho: assumido layout Profit Ativo;Data;Hora;Abertura;Máximo;Mínimo;Fechamento;Volume;Quantidade")
    else:
        raise DataFormatError(
            f"cabeçalho não reconhecido: {header!r}. Esperado colunas como "
            "Data, Hora, Abertura, Máxima, Mínima, Fechamento (ou date,time,open,high,low,close)."
        )
    missing = [k for k in REQUIRED if k not in mapping]
    if missing:
        raise DataFormatError(f"colunas obrigatórias ausentes: {missing}")
    if "datetime" not in mapping and "date" not in mapping:
        raise DataFormatError("coluna de data/hora ausente")

    width = max(mapping.values()) + 1
    body = [r for r in body if len(r) >= width]
    frame = pd.DataFrame(body)
    price_sample = [str(v) for v in frame[mapping["close"]].head(200).tolist()]
    decimal, thousands = _detect_decimal(price_sample)
    if sep == "," and decimal == ",":
        raise DataFormatError("separador ',' com decimal ',' é ambíguo")

    out = pd.DataFrame()
    if "datetime" in mapping:
        out["ts"] = _parse_datetime(frame[mapping["datetime"]], None)
    else:
        time_col = frame[mapping["time"]] if "time" in mapping else None
        out["ts"] = _parse_datetime(frame[mapping["date"]], time_col)
    for key in ("open", "high", "low", "close", "volume", "qty", "trades", "buy_volume", "sell_volume"):
        if key in mapping:
            out[key] = _to_number(frame[mapping[key]], decimal)
    symbol = None
    if "symbol" in mapping:
        symbols = frame[mapping["symbol"]].astype(str).str.strip().str.upper()
        symbol = symbols.mode().iloc[0] if not symbols.empty else None

    bad_ts = int(out["ts"].isna().sum())
    if bad_ts:
        issues.append(f"{bad_ts} linhas com data/hora inválida descartadas")
    out = out.dropna(subset=["ts", "open", "high", "low", "close"])
    descending = bool(len(out) > 1 and out["ts"].iloc[0] > out["ts"].iloc[-1])
    out = out.sort_values("ts", kind="stable")
    dup_exact = int(out.duplicated().sum())
    out = out.drop_duplicates()
    dup_ts = int(out["ts"].duplicated().sum())
    if dup_exact:
        issues.append(f"{dup_exact} linhas duplicadas idênticas removidas")
    if dup_ts:
        issues.append(f"{dup_ts} horários repetidos com valores diferentes: mantida a última ocorrência")
        out = out.drop_duplicates(subset=["ts"], keep="last")
    out = out.reset_index(drop=True)

    schema = {
        "layout": layout,
        "separador": sep,
        "decimal": decimal,
        "milhar_ponto": thousands,
        "colunas": {k: header[v] if layout == "cabecalho" else PROFIT_HEADERLESS_9[v] for k, v in mapping.items()},
        "ordem_original": "decrescente" if descending else "crescente",
        "simbolo_no_arquivo": symbol,
    }
    return out, schema, issues


def infer_timeframe_min(ts: pd.Series) -> int | None:
    if len(ts) < 3:
        return None
    days = ts.dt.normalize()
    diffs = ts.diff()[days == days.shift(1)].dropna()
    if diffs.empty:
        return None
    minutes = diffs.dt.total_seconds().median() / 60.0
    return int(round(minutes)) if minutes >= 1 else None


def is_synthetic(path: Path) -> bool:
    if path.name.upper().startswith(SYNTHETIC_PREFIX):
        return True
    sidecar = path.with_suffix(path.suffix + ".synthetic.json")
    return sidecar.exists()


def load_dataset(path: str | Path, root_override: str | None = None) -> Dataset:
    p = Path(path)
    raw = p.read_bytes()
    bars, schema, issues = read_bars(raw, p.name)
    meta = parse_filename(p.name)
    symbol = schema.get("simbolo_no_arquivo") or meta.get("symbol") or p.stem.upper()
    root = root_override or root_from_symbol(symbol) or root_from_symbol(meta.get("symbol"))
    tf = infer_timeframe_min(bars["ts"])
    if meta.get("timeframe_min") and tf and meta["timeframe_min"] != tf:
        issues.append(f"timeframe do nome ({meta['timeframe_min']} min) difere do observado ({tf} min)")
    schema["metadados_nome"] = {k: str(v) for k, v in meta.items()}
    return Dataset(
        path=str(p),
        sha256=sha256_bytes(raw),
        symbol=symbol,
        root=root,
        timeframe_min=tf,
        kind="sintetico" if is_synthetic(p) else "real",
        bars=bars,
        schema=schema,
        issues=issues,
    )


def describe(ds: Dataset) -> dict:
    ts = ds.bars["ts"]
    return {
        "arquivo": ds.path,
        "sha256": ds.sha256,
        "tipo": ds.kind,
        "simbolo": ds.symbol,
        "raiz": ds.root,
        "timeframe_min": ds.timeframe_min,
        "linhas": int(len(ds.bars)),
        "primeiro": str(ts.iloc[0]) if len(ts) else None,
        "ultimo": str(ts.iloc[-1]) if len(ts) else None,
        "pregoes": int(ts.dt.normalize().nunique()) if len(ts) else 0,
        "colunas_extras": [c for c in ("volume", "qty", "trades", "buy_volume", "sell_volume") if c in ds.bars],
        "esquema": ds.schema,
        "avisos": ds.issues,
    }


def describe_json(ds: Dataset) -> str:
    return json.dumps(describe(ds), ensure_ascii=False, indent=2, default=str)


def available_numeric(bars: pd.DataFrame, col: str) -> bool:
    return col in bars and bool(np.isfinite(bars[col].to_numpy(dtype=float)).any()) and bool((bars[col] > 0).any())
