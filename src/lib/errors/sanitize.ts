/**
 * Sanitização automática de segredos (comando §3/§18).
 *
 * NUNCA registrar password, API key, token, cookie, authorization header nem
 * conteúdo de .env — nem na Central de Erros, nem nos logs enviados ao Claude.
 * A redação roda ANTES de qualquer persistência ou envio.
 */

const PATTERNS: Array<[RegExp, string]> = [
  // Chaves Anthropic/OpenAI-like e bearer tokens.
  [/sk-[a-zA-Z0-9_-]{8,}/g, "[REDACTED_KEY]"],
  [/bearer\s+[a-zA-Z0-9._~+/-]{8,}=*/gi, "Bearer [REDACTED_TOKEN]"],
  // Headers sensíveis inteiros — consome até o fim da linha (ex.: "Basic xxx").
  [
    /(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-admin-token)\s*[:=][^\n]*/gi,
    "$1: [REDACTED]",
  ],
  // Campos comuns em JSON/query string.
  [
    /("?(?:password|senha|token|secret|api_?key|apikey|access_?key|private_?key|credential)s?"?\s*[:=]\s*)"[^"]*"/gi,
    '$1"[REDACTED]"',
  ],
  [/((?:password|senha|token|secret|api_?key|apikey)=)[^&\s]+/gi, "$1[REDACTED]"],
  // Linhas de .env com nomes sensíveis.
  [/^([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL)[A-Z0-9_]*)=.*$/gm, "$1=[REDACTED]"],
  // Chaves privadas PEM.
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    "[REDACTED_PRIVATE_KEY]",
  ],
];

export function sanitizeSecrets(input: string): string {
  let output = input;
  for (const [pattern, replacement] of PATTERNS) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

export function sanitizeUnknown(value: unknown, maxLength = 4_000): string {
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  return sanitizeSecrets(text ?? "").slice(0, maxLength);
}
