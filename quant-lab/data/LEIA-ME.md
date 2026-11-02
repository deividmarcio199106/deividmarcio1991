# Dados de entrada

Coloque aqui os históricos OHLC intradiários de WIN/WDO em CSV, por exemplo o arquivo da
Bolsa Quant Pro `WDOFUT_F_0_5min_01-01-2026_01-11-2026.csv`. Depois:

```bash
python -m qlab inspect data/NOME_DO_ARQUIVO.csv
```

Arquivos com prefixo `SINTETICO_` (ou com um `.synthetic.json` ao lado) são tratados como
dados de teste e nunca geram alerta.
