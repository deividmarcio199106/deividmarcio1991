import { createHash } from "node:crypto";

/**
 * LIMITES DE TENTATIVA DO MEETLY.
 *
 * Janela deslizante em memória, com três garantias que a versão anterior não
 * tinha (achados da revisão de segurança):
 *  - chave de tamanho fixo (SHA-256): um e-mail de 300 KB no corpo não vira
 *    uma chave de 300 KB guardada por um minuto;
 *  - teto de chaves (as mais antigas saem primeiro): o mapa nunca cresce até
 *    derrubar o processo — que é o mesmo do analisador;
 *  - `isLimited` só LÊ e `hit` só ESCREVE: falhas são registradas depois da
 *    verificação, então requisição sem senha não custa nada a ninguém e uma
 *    vítima não é bloqueada por quem apenas sabe o e-mail dela.
 */
export class SlidingWindowLimiter {
  private readonly buckets = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly maxKeys = 50_000,
  ) {}

  private key(raw: string): string {
    return createHash("sha256").update(raw).digest("base64url");
  }

  private live(key: string, now: number): number[] {
    const hits = this.buckets.get(key);
    if (!hits) return [];
    const fresh = hits.filter((at) => now - at < this.windowMs);
    if (fresh.length === 0) this.buckets.delete(key);
    else if (fresh.length !== hits.length) this.buckets.set(key, fresh);
    return fresh;
  }

  /** Já atingiu o limite? Não registra nada. */
  isLimited(raw: string, now = Date.now()): boolean {
    return this.live(this.key(raw), now).length >= this.max;
  }

  /** Registra um evento (ex.: uma senha errada). */
  hit(raw: string, now = Date.now()): void {
    const key = this.key(raw);
    const hits = this.live(key, now);
    hits.push(now);
    // Reinsere para o fim: a ordem do Map vira "menos recente primeiro".
    this.buckets.delete(key);
    this.buckets.set(key, hits.slice(-this.max));
    while (this.buckets.size > this.maxKeys) {
      const oldest = this.buckets.keys().next().value;
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
  }

  /** Limite de volume: conta e responde se passou. Recusas não contam. */
  consume(raw: string, now = Date.now()): boolean {
    if (this.isLimited(raw, now)) return true;
    this.hit(raw, now);
    return false;
  }

  reset(raw: string): void {
    this.buckets.delete(this.key(raw));
  }

  clear(): void {
    this.buckets.clear();
  }

  get size(): number {
    return this.buckets.size;
  }
}

const MINUTE = 60_000;

export const meetlyLimits = {
  /** Toda chamada de auth (cadastro, login, troca de senha) por IP: limita o scrypt. */
  authVolumeByIp: new SlidingWindowLimiter(30, MINUTE),
  /** Contas novas por IP. */
  registerByIp: new SlidingWindowLimiter(10, 60 * MINUTE),
  /** Senhas erradas por par IP+e-mail: o limite apertado, que não afeta outros IPs. */
  loginFailByIpEmail: new SlidingWindowLimiter(10, 15 * MINUTE),
  /** Senhas erradas por IP, em qualquer conta (credential stuffing). */
  loginFailByIp: new SlidingWindowLimiter(30, 15 * MINUTE),
  /** Teto por conta, de todos os IPs somados: só um ataque distribuído chega aqui. */
  loginFailByEmail: new SlidingWindowLimiter(100, 60 * MINUTE),
  /** Senha atual errada na troca de senha, por usuário. */
  passwordFailByUser: new SlidingWindowLimiter(10, 15 * MINUTE),
  /** Convites por usuário: impede usar o convite como consulta em massa de e-mails. */
  inviteByUser: new SlidingWindowLimiter(30, 10 * MINUTE),
  /** Reuniões criadas por usuário. */
  createMeetingByUser: new SlidingWindowLimiter(20, 10 * MINUTE),
};

export function resetMeetlyLimits(): void {
  for (const limiter of Object.values(meetlyLimits)) limiter.clear();
}

const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/;
const IP_LIKE = /^[0-9a-fA-F:.]{2,45}$/;

/**
 * IP do cliente.
 *
 * Em produção o Nginx fala com o Node pelo loopback; só nesse caso os
 * cabeçalhos do proxy são aceitos. Vale o ÚLTIMO item do X-Forwarded-For —
 * o que o próprio Nginx acrescentou com `$proxy_add_x_forwarded_for` — e não o
 * primeiro, que o cliente escreve como quiser. Conexão direta (sem proxy) usa
 * o endereço do socket e ignora os cabeçalhos.
 */
export function clientIp(request: Request): string {
  const peerRaw = (request as unknown as { ip?: unknown }).ip;
  const peer = typeof peerRaw === "string" ? peerRaw : "";
  // Fixa o cabeçalho confiável quando se sabe como o Nginx está configurado
  // (ex.: MEETLY_CLIENT_IP_HEADER=x-real-ip com `proxy_set_header X-Real-IP $remote_addr`).
  const pinned = process.env["MEETLY_CLIENT_IP_HEADER"]?.trim().toLowerCase();
  if (pinned && (!peer || LOOPBACK.test(peer))) {
    const value = request.headers.get(pinned)?.split(",").pop()?.trim();
    return value && IP_LIKE.test(value) ? value : peer || "desconhecido";
  }
  if (!peer || LOOPBACK.test(peer)) {
    const forwarded = request.headers
      .get("x-forwarded-for")
      ?.split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .pop();
    if (forwarded && IP_LIKE.test(forwarded)) return forwarded;
    const real = request.headers.get("x-real-ip")?.trim();
    if (real && IP_LIKE.test(real)) return real;
  }
  return peer || "desconhecido";
}
