/**
 * Extração robusta de JSON (spec finalíssimo §92).
 *
 * Modelos às vezes devolvem o JSON envolto em cercas markdown, com texto
 * antes/depois, ou com prefixos de raciocínio. Este parser extrai o PRIMEIRO
 * objeto JSON balanceado da resposta — sem regex frágil — e devolve null
 * quando não há objeto válido (nunca um palpite).
 */
export function extractJsonObject(raw: string): unknown | null {
  if (typeof raw !== "string" || raw.length === 0) return null;

  // 1. Caminho feliz: a resposta inteira já é JSON.
  const trimmed = raw.trim();
  const direct = tryParse(trimmed);
  if (direct !== undefined) return direct;

  // 2. Cercas markdown ```json ... ``` (ou ``` ... ```).
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  if (fence?.[1]) {
    const fenced = tryParse(fence[1].trim());
    if (fenced !== undefined) return fenced;
  }

  // 3. Varredura balanceada: primeiro '{' até o '}' que fecha o mesmo nível,
  // respeitando strings e escapes.
  const start = raw.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const candidate = tryParse(raw.slice(start, i + 1));
        return candidate === undefined ? null : candidate;
      }
    }
  }
  return null;
}

function tryParse(text: string): unknown | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
