/**
 * AI Gateway — superfície pública. Todo consumo de IA do sistema passa por
 * aqui; nenhum outro módulo monta URL de provedor textual fora do gateway.
 *
 * ATENÇÃO: só código de SERVIDOR pode importar deste diretório. O navegador
 * nunca conversa com a API externa e nunca recebe chaves ou URLs.
 */
export {
  aiConfig,
  isAIConfigured,
  normalizeAIBaseUrl,
  normalizeOllamaBaseUrl,
  publicAIConfig,
} from "./config";
export type { AIConfig, AIProvider } from "./config";
export { CircuitBreaker, CircuitOpenError } from "./circuitBreaker";
export type { BreakerState } from "./circuitBreaker";
export { generateAIText, aiBreaker, describeAIError } from "./gateway";
export type { AIMessage, AIRequest, AIResponse } from "./gateway";
export { readPriceScaleWithVision, selectBestScalePair } from "./vision";
export type { VisionScaleResult } from "./vision";
export { checkAI, checkOllama, checkApp } from "./health";
export type { AIHealth, AppHealth, HealthStatus, OllamaHealth } from "./health";
