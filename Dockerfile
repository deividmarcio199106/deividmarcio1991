# =============================================================================
# Analisador por Observação Contínua — imagem de produção
# =============================================================================
# Multi-stage: o estágio de build carrega devDependencies e o toolchain; a
# imagem final só leva o servidor Node compilado.
#
# A IA é opcional e acessada somente pelo backend.
# =============================================================================

FROM oven/bun:1.3.7 AS build
WORKDIR /app

# Instala dependências primeiro para aproveitar cache de camada.
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile

COPY . .

# Falha o build se lint/typecheck/testes quebrarem: é isto que impede a
# aplicação de "subir silenciosamente quebrada".
RUN bun run format:check && bun run lint && bun run typecheck && bun run test && bun run build

# -----------------------------------------------------------------------------
FROM node:22-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

# `.output` é o bundle do Nitro (preset node-server).
COPY --from=build /app/.output ./.output

# Usuário sem privilégios.
RUN useradd --system --uid 10001 analyzer && mkdir -p /app/data && chown -R analyzer:analyzer /app
USER analyzer

EXPOSE 8080

# Valida tanto a API quanto a página principal renderizada pelo servidor.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "Promise.all(['/','/api/health'].map(p=>fetch('http://127.0.0.1:'+(process.env.PORT||8080)+p).then(r=>{if(!r.ok)throw new Error(p+' '+r.status)}))).then(()=>process.exit(0)).catch(()=>process.exit(1))"

CMD ["node", ".output/server/index.mjs"]
