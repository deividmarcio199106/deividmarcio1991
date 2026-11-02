from datetime import date

import pytest

from qlab.data import DataFormatError, load_dataset, parse_filename, read_bars


def test_parse_bolsa_quant_pro_filename():
    meta = parse_filename("WDOFUT_F_0_5min_01-01-2026_01-11-2026.csv")
    assert meta["symbol"] == "WDOFUT"
    assert meta["timeframe_min"] == 5
    assert meta["start"] == date(2026, 1, 1)
    assert meta["end"] == date(2026, 11, 1)


def test_profit_semicolon_decimal_comma_descending():
    raw = (
        "Ativo;Data;Hora;Abertura;Máximo;Mínimo;Fechamento;Volume;Quantidade\n"
        "WDOFUT;02/01/2026;09:05:00;5.512,500;5.514,000;5.510,000;5.513,500;1.000.000,00;120\n"
        "WDOFUT;02/01/2026;09:00:00;5.510,000;5.513,000;5.509,500;5.512,500;2.000.000,00;300\n"
    ).encode("cp1252")
    bars, schema, _ = read_bars(raw)
    assert schema["decimal"] == "," and schema["ordem_original"] == "decrescente"
    assert list(bars["close"]) == [5512.5, 5513.5]
    assert str(bars["ts"].iloc[0]) == "2026-01-02 09:00:00"
    assert list(bars["qty"]) == [300, 120]


def test_iso_comma_separated_english_header():
    raw = (
        "datetime,open,high,low,close,volume\n"
        "2026-01-02 09:00:00,128455,128500,128400,128480,100\n"
        "2026-01-02 09:05:00,128480,128520,128450,128505,90\n"
    ).encode()
    bars, schema, _ = read_bars(raw)
    assert schema["separador"] == "," and schema["decimal"] == "."
    assert bars["high"].iloc[1] == 128520


def test_thousands_dot_without_decimals():
    raw = (
        "Data;Hora;Abertura;Maxima;Minima;Fechamento\n"
        "02/01/2026;09:00;128.455;128.500;128.400;128.480\n"
        "02/01/2026;09:05;128.480;128.520;128.450;128.505\n"
    ).encode()
    bars, _schema, _ = read_bars(raw)
    assert bars["open"].iloc[0] == 128455


def test_headerless_profit_layout():
    raw = (
        "WINFUT;02/01/2026;09:00:00;128.455,00;128.500,00;128.400,00;128.480,00;0;10\n"
        "WINFUT;02/01/2026;09:05:00;128.480,00;128.520,00;128.450,00;128.505,00;0;12\n"
    ).encode()
    bars, schema, issues = read_bars(raw)
    assert schema["layout"].startswith("profit_sem_cabecalho")
    assert issues and len(bars) == 2


def test_unrecognized_file_fails_loudly():
    with pytest.raises(DataFormatError):
        read_bars(b"a;b;c\n1;2;3\n4;5;6\n")


def test_duplicates_removed_and_reported():
    raw = (
        "Data;Hora;Abertura;Maxima;Minima;Fechamento\n"
        "02/01/2026;09:00;10,0;11,0;9,0;10,5\n"
        "02/01/2026;09:00;10,0;11,0;9,0;10,5\n"
        "02/01/2026;09:05;10,5;11,5;10,0;11,0\n"
    ).encode()
    bars, _schema, issues = read_bars(raw)
    assert len(bars) == 2 and any("duplicadas" in i for i in issues)


def test_synthetic_marker(random_csv):
    ds = load_dataset(random_csv)
    assert ds.kind == "sintetico" and ds.root == "WIN" and ds.timeframe_min == 5
