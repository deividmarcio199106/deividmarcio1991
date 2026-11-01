# Subir o analisador para a nuvem

Este guia complementa o `docs/DEPLOY.md` (VPS manual com PM2). Aqui o deploy
e automatico a partir do GitHub.

## O que vai e o que fica

| Componente | Onde roda | Motivo |
|---|---|---|
| Site + backend Node + SQLite (`src/`, `.output/`) | **Nuvem** | Ja e um servidor; o `Dockerfile` empacota tudo |
| Banco SQLite | **Nuvem**, num volume persistente (`DATA_DIR=/app/data`) | Sem volume os dados somem a cada deploy |
| Captura de tela do Profit | **Desktop** (navegador) | O Profit esta na sua maquina; o site na nuvem le a tela via `getDisplayMedia`, que exige HTTPS |
| `bridge-exe/`, `updater/` | **Desktop** (Windows) | Executaveis C# que conversam com o Profit/RTD |
| Ollama (IA opcional) | GPU propria via tunel SSH, ou GPU alugada | O backend fala com ele por `OLLAMA_BASE_URL`; nunca o navegador |

## Caminho 1 — GitHub Actions + sua VPS (recomendado, zero custo extra)

A cada push na `main`, o workflow `.github/workflows/deploy.yml`:

1. constroi a imagem Docker (rodando format, lint, typecheck, testes e build);
2. publica em `ghcr.io/deividmarcio199106/deividmarcio1991:latest`;
3. se os segredos abaixo existirem, entra na VPS por SSH e reinicia o container.

Segredos a criar em **Settings > Secrets and variables > Actions**:

| Segredo | Valor |
|---|---|
| `VPS_HOST` | IP ou dominio da VPS |
| `VPS_USER` | usuario SSH (precisa poder rodar `docker`) |
| `VPS_SSH_KEY` | chave privada SSH (conteudo completo) |
| `VPS_PORT` | opcional, padrao 22 |

Na VPS, uma unica vez:

```bash
sudo apt-get install -y docker.io
sudo usermod -aG docker "$USER"
```

O container sobe com `--network host` em `127.0.0.1:8081`, exatamente como o
`docker-compose.yml`, entao o bloco do Nginx de `docs/DEPLOY.md` continua
valido. Se o `analisador` antigo do PM2 ainda estiver na porta 8081, pare-o
antes (`pm2 delete analisador`).

Sem os segredos, o workflow apenas publica a imagem. Para usar a imagem
manualmente em qualquer servidor:

```bash
docker pull ghcr.io/deividmarcio199106/deividmarcio1991:latest
docker compose up -d
```

(`docker-compose.yml` ja aponta para a imagem `analisador-continuo:latest`;
troque `image:` pelo nome do GHCR ou mantenha o `build:` local.)

## Caminho 2 — Render (gerenciado, sem VPS)

1. Em https://render.com, **New > Blueprint**, escolha este repositorio.
2. O `render.yaml` cria o servico web Docker com disco de 2 GB em `/app/data`.
3. Preencha `OLLAMA_*` so se tiver uma GPU alcancavel pela internet; vazio
   desliga a IA e o analisador continua funcionando.

Plano `starter` (pago) e necessario por causa do disco persistente.

## Caminho 3 — Fly.io

```bash
fly launch --copy-config --no-deploy
fly volumes create analisador_data --size 2 --region gru
fly deploy
```

O `fly.toml` ja fixa regiao `gru` (Sao Paulo), porta 8080 e o volume.

## Verificacao pos-deploy (qualquer caminho)

```bash
curl -s https://SEU-DOMINIO/api/health
curl -s https://SEU-DOMINIO/api/trading/snapshot | grep -o '"status":"PRODUCTION"'
```

`/api/ai/health` responde 503 quando nao ha GPU: isso e sinalizacao, nao falha.

## Variaveis

Ver `.env.example`. As obrigatorias sao `PORT` e `DATA_DIR`; as `OLLAMA_*`
sao opcionais.
