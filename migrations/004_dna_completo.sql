-- DNA T4 Completo: campos consultáveis para análise estatística granular
-- Cada setup vira dado mensurável, evitando overfitting e viés retrospectivo

-- VOCABULÁRIO ÚNICO: os valores gravados são os enums ASCII de
-- src/lib/t4/dna.ts — o mesmo vocabulário em toda a cadeia, sem acento e sem
-- variação de caixa, para segmentar por SQL sem normalizar texto depois.

-- Nota da T4 (classificação ANTES do resultado)
ALTER TABLE trades ADD COLUMN quality TEXT;
-- Valores: 'A_PLUS' | 'A' | 'B' | 'C' | 'DESCARTADA'

-- Tendência do mercado no momento da decisão, do ponto de vista do setup
ALTER TABLE trades ADD COLUMN trend_strength TEXT;
-- Valores: 'FORTE' | 'NORMAL' | 'LATERAL' | 'TRANSICAO' | 'CONTRA'

-- Posição relativa à tendência
ALTER TABLE trades ADD COLUMN position_vs_trend TEXT;
-- Valores: 'A_FAVOR' | 'CONTRA_TENDENCIA'

-- Tipo de pullback observado
ALTER TABLE trades ADD COLUMN pullback_type TEXT;
-- Valores: 'CURTO' | 'PROFUNDO' | 'LIMPO' | 'LATERAL' | 'AGRESSIVO' | 'FALSO_ROMPIMENTO' | 'NAO_IDENTIFICADO'

-- Força do impulso anterior em R (impulso ÷ distância do stop)
ALTER TABLE trades ADD COLUMN impulse_strength REAL;

-- Localização no gráfico
ALTER TABLE trades ADD COLUMN location TEXT;
-- Valores: 'SUPORTE' | 'RESISTENCIA' | 'VWAP' | 'MEDIA' | 'MAXIMA' | 'MINIMA' | 'ROMPIMENTO' | 'CONSOLIDACAO' | 'NAO_IDENTIFICADO'

-- Tipo de candle gatilho
ALTER TABLE trades ADD COLUMN trigger_candle TEXT;
-- Valores: 'FECHAMENTO' | 'ROMPIMENTO' | 'REJEICAO' | 'ENGOLFO' | 'FORCA' | 'RETESTE' | 'NAO_IDENTIFICADO'

-- Número da T4 no movimento (1ª, 2ª, 3ª ou posterior)
ALTER TABLE trades ADD COLUMN t4_number_in_move INTEGER;

-- Nível de volatilidade
ALTER TABLE trades ADD COLUMN volatility_level TEXT;
-- Valores: 'BAIXA' | 'NORMAL' | 'ALTA' | 'EXTREMA'

-- Distância do stop em PONTOS (em R ela é 1 por definição)
ALTER TABLE trades ADD COLUMN stop_distance_points REAL;

-- Resultado em R$ (além de R múltiplo)
ALTER TABLE trades ADD COLUMN result_brl REAL;

-- Custos totais em R$ (corretagem + emolumentos + spread + slippage)
ALTER TABLE trades ADD COLUMN costs_brl REAL;

-- Slippage em pontos (diferença entre preço planejado e executado)
ALTER TABLE trades ADD COLUMN slippage_points REAL;

-- URL ou path do print original vinculado
ALTER TABLE trades ADD COLUMN print_url TEXT;

-- Análise/overlay como texto estruturado
ALTER TABLE trades ADD COLUMN analysis_text TEXT;

-- Instante de MERCADO da classificação (= t da análise congelada; prova de
-- que a nota veio ANTES do resultado). Nunca Date.now().
ALTER TABLE trades ADD COLUMN classified_at INTEGER;

-- Vínculo com o registro de detecção em setup_dna (migration 005)
ALTER TABLE trades ADD COLUMN dna_id TEXT;

-- Índice para queries por qualidade
CREATE INDEX IF NOT EXISTS idx_trades_quality ON trades(quality);

-- Índice para segmentação por tendência
CREATE INDEX IF NOT EXISTS idx_trades_trend ON trades(trend_strength, position_vs_trend);

-- Índice para análise de pullback
CREATE INDEX IF NOT EXISTS idx_trades_pullback ON trades(pullback_type);

-- Índice para localização
CREATE INDEX IF NOT EXISTS idx_trades_location ON trades(location);

-- Índice para volatilidade
CREATE INDEX IF NOT EXISTS idx_trades_volatility ON trades(volatility_level);