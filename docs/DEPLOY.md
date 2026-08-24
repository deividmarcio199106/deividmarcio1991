# Deploy na VPS

> **Escopo fixo desta VPS:** o analisador vive em `/var/www/analisador`, roda
> sob PM2 com o nome `analisador` na porta `8081`, atrás do Nginx existente.
> **Não tocar** nos demais sites da máquina (valetech, vendas, loja) — nem
> nos seus diretórios, nem nos seus blocos de Nginx, nem nos seus processos.

## Pré-requisitos

- Node.js 22.5+ (SQLite nativo) — ou Docker;
- HTTPS no domínio para permitir compartilhamento de tela;
- diretório persistente gravável para SQLite (`/var/lib/analisador`);
- túnel GPU ativo apenas quando a análise por Ollama for necessária.

## Variáveis (produção)

```env
PORT=8081
DATA_DIR=/var/lib/analisador
OLLAMA_BASE_URL=http://127.0.0.1:11435
OLLAMA_TEXT_MODEL=qwen3.5:35b
OLLAMA_VISION_MODEL=qwen3.5:35b
```

`OLLAMA_VISION_MODEL=qwen3.5:35b` vale porque o qwen3.5:35b instalado na GPU
expõe `capability=vision` (ver `.env.example`). Se a GPU trocar de modelo,
confirme a capacidade multimodal antes de preencher — nunca presuma.

## Passo a passo (PM2, sem Docker)

```bash
# 1. Código
cd /var/www/analisador
# (atualize o conteúdo desta pasta com a versão validada — git pull ou rsync do zip)

# 2. Dados persistentes
sudo mkdir -p /var/lib/analisador
sudo chown "$(whoami)" /var/lib/analisador   # dono = usuário que roda o PM2

# 3. Build validado (não pule os gates)
bun install          # ou: npm install
bun run typecheck    # precisa sair 0
bun run test         # precisa sair 0 (227 testes)
bun run build        # precisa sair 0

# 4. Processo PM2 (nome fixo: analisador)
PORT=8081 DATA_DIR=/var/lib/analisador \
OLLAMA_BASE_URL=http://127.0.0.1:11435 \
OLLAMA_TEXT_MODEL=qwen3.5:35b OLLAMA_VISION_MODEL=qwen3.5:35b \
NODE_ENV=production \
pm2 start .output/server/index.mjs --name analisador --update-env
pm2 save
```

Se o processo `analisador` já existir: `pm2 restart analisador --update-env`
(com as mesmas variáveis exportadas no shell) em vez de `pm2 start`.

## Validação obrigatória pós-deploy

```bash
curl -s http://127.0.0.1:8081/api/health            # esperado: HTTP 200, analyzer ok
curl -s http://127.0.0.1:8081/api/ai/health         # 200 com túnel ativo; 503 se a GPU estiver fora
curl -s http://127.0.0.1:8081/api/trading/snapshot | grep -o '"status":"PRODUCTION"'
```

O snapshot deve mostrar `productionTechnique.version = "T4.0.0"` com
`status = "PRODUCTION"`, 3 contratos e RR mínimo 3. `/api/health` responde 200
mesmo com a IA fora do ar (o analisador não depende dela); só `/api/ai/health`
retorna 503 nesse caso — isso é sinalização, não falha do deploy.

Teste direto do túnel GPU (na VPS, quando a GPU estiver ligada):

```bash
curl http://127.0.0.1:11435/api/tags
```

## Nginx

Mantenha o domínio/SSL existentes e encaminhe apenas o server block do
analisador para `http://127.0.0.1:8081` (`proxy_pass`). Não altere os blocos
de valetech/vendas/loja. Nunca exponha a porta do Ollama (11435) ao navegador
ou à internet — ela é alcançável somente pelo backend via túnel SSH.
