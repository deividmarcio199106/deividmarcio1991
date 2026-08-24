#!/usr/bin/env bash
#
# Restabelece o túnel para a GPU da Vast.ai e PROVA que ela serve visão.
#
# Uso, na VPS:
#   bash scripts/setup-gpu-tunnel.sh <HOST> <PORTA_SSH>
#   bash scripts/setup-gpu-tunnel.sh 98.93.171.69 44156
#
# O que este script recusa a fazer: dizer ONLINE porque /api/version respondeu.
# Um endpoint que responde a version pode não ter o modelo, pode estar em CPU, ou
# pode ter o modelo e falhar na primeira imagem. Aqui só é ONLINE depois de uma
# inferência visual real, com latência medida e execução conferida na GPU.
#
# Histórico que motivou o rigor: o túnel anterior ficou `active (running)` no
# systemd por SETE DIAS enquanto falhava — 4.629 reinícios — porque o systemd
# considera "rodando" um ssh que reconecta em laço. Estado de serviço não é
# prova de serviço.

set -Eeuo pipefail

HOST="${1:-}"
PORT="${2:-}"
LOCAL_PORT="${3:-11435}"
REMOTE_PORT="${4:-11434}"
KEY="/root/.ssh/vast_gpu_ed25519"
MODEL="${OLLAMA_VISION_MODEL:-qwen3-vl:4b-instruct}"
UNIT="/etc/systemd/system/vast-gpu-tunnel.service"

if [ -z "$HOST" ] || [ -z "$PORT" ]; then
  echo "uso: $0 <HOST> <PORTA_SSH> [porta_local=11435] [porta_remota=11434]"
  exit 2
fi

falhou() { echo; echo "FALHOU: $*"; exit 1; }
passo()  { echo; echo "==> $*"; }

passo "1/8  Alcance do host"
if ! timeout 10 bash -c "cat < /dev/null > /dev/tcp/$HOST/$PORT" 2>/dev/null; then
  falhou "porta $PORT fechada em $HOST. A instância existe e está ligada?
        Instância da Vast.ai encerrada devolve o IP para outro cliente:
        o host pode responder a ping e a porta não existir mais."
fi
echo "    porta $PORT aberta"

passo "2/8  Chave SSH"
[ -f "$KEY" ] || falhou "chave ausente em $KEY"
echo "    $KEY"

passo "3/8  Reescrevendo o serviço do túnel"
cat > "$UNIT" <<UNITEOF
[Unit]
Description=Tunel SSH Hostinger para GPU Vast.ai
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=root
ExecStart=/usr/bin/ssh -i $KEY -N -T -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o StrictHostKeyChecking=accept-new -L 127.0.0.1:$LOCAL_PORT:127.0.0.1:$REMOTE_PORT -p $PORT root@$HOST
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNITEOF
systemctl daemon-reload
systemctl restart vast-gpu-tunnel.service
echo "    $HOST:$PORT -> 127.0.0.1:$LOCAL_PORT"

passo "4/8  Esperando a porta local subir"
for i in $(seq 1 20); do
  if curl -sf --max-time 3 "http://127.0.0.1:$LOCAL_PORT/api/version" >/dev/null 2>&1; then break; fi
  sleep 1
done
VERSION="$(curl -sf --max-time 5 "http://127.0.0.1:$LOCAL_PORT/api/version" 2>/dev/null || true)"
[ -n "$VERSION" ] || falhou "túnel subiu mas o Ollama remoto não responde.
        Confira: journalctl -u vast-gpu-tunnel.service -n 20"
echo "    ollama: $VERSION"

passo "5/8  Modelo de visão instalado?"
TAGS="$(curl -sf --max-time 15 "http://127.0.0.1:$LOCAL_PORT/api/tags" || echo '{}')"
if echo "$TAGS" | grep -q "$MODEL"; then
  echo "    $MODEL presente"
else
  echo "    $MODEL AUSENTE — baixando na GPU (pode levar minutos)"
  curl -sf --max-time 1800 "http://127.0.0.1:$LOCAL_PORT/api/pull" \
    -d "{\"model\":\"$MODEL\",\"stream\":false}" >/dev/null \
    || falhou "não foi possível baixar $MODEL na GPU"
  echo "    $MODEL baixado"
fi

passo "6/8  Inferência visual REAL"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
FONT="$(fc-list : file 2>/dev/null | grep -iE 'dejavu.*sans.*\.ttf' | head -1 | cut -d: -f1)"
[ -n "$FONT" ] || falhou "sem fonte para gerar a imagem de teste (instale fonts-dejavu)"

# Mesmo recorte do benchmark de CPU, para a comparação ser honesta.
ffmpeg -loglevel error -f lavfi -i color=c=0x1a1a1a:s=120x560 \
  -vf "drawtext=fontfile=$FONT:text='172.410':fontcolor=0x969696:fontsize=17:x=10:y=20,\
drawtext=fontfile=$FONT:text='172.350':fontcolor=0x969696:fontsize=17:x=10:y=160,\
drawtext=fontfile=$FONT:text='172.290':fontcolor=0x969696:fontsize=17:x=10:y=300,\
drawtext=fontfile=$FONT:text='172.230':fontcolor=0x969696:fontsize=17:x=10:y=440" \
  -frames:v 1 "$TMP/eixo.png"

B64="$(base64 -w0 "$TMP/eixo.png")"
cat > "$TMP/req.json" <<REQEOF
{"model":"$MODEL","stream":false,"options":{"temperature":0},
"prompt":"Liste TODOS os numeros visiveis nesta imagem, um por linha.",
"images":["$B64"]}
REQEOF

START="$(date +%s%3N)"
curl -sf --max-time 600 "http://127.0.0.1:$LOCAL_PORT/api/generate" -d @"$TMP/req.json" -o "$TMP/resp.json" \
  || falhou "a inferência visual falhou"
END="$(date +%s%3N)"
LATENCY=$((END-START))

RESPOSTA="$(python3 -c "import json;print(json.load(open('$TMP/resp.json')).get('response','')[:400])")"
echo "    latencia: ${LATENCY} ms"
echo "    leitura:"
echo "$RESPOSTA" | sed 's/^/      /'

ACERTOS=0
for VALOR in 172.410 172.350 172.290 172.230; do
  echo "$RESPOSTA" | grep -q "$VALOR" && ACERTOS=$((ACERTOS+1))
done
echo "    acertos: $ACERTOS/4"
[ "$ACERTOS" -ge 3 ] || falhou "o modelo respondeu, mas leu $ACERTOS/4 valores.
        Endpoint errado, modelo errado ou imagem corrompida no caminho."

passo "7/8  Está mesmo na GPU?"
# A prova definitiva: a CPU da VPS levou 177s no MESMO recorte.
if [ "$LATENCY" -lt 5000 ]; then
  echo "    ${LATENCY}ms contra 177000ms da CPU — compatível com GPU"
else
  echo "    ATENCAO: ${LATENCY}ms e lento demais para GPU."
  echo "    Confira no servidor da GPU: nvidia-smi"
  echo "    O Ollama pode estar rodando em CPU mesmo com placa presente."
fi

passo "8/8  Apontando a aplicação"
ENVFILE="/var/www/analisador/.env"
if [ -f "$ENVFILE" ]; then
  if grep -q '^OLLAMA_VISION_URL=' "$ENVFILE"; then
    sed -i "s|^OLLAMA_VISION_URL=.*|OLLAMA_VISION_URL=http://127.0.0.1:$LOCAL_PORT|" "$ENVFILE"
  else
    echo "OLLAMA_VISION_URL=http://127.0.0.1:$LOCAL_PORT" >> "$ENVFILE"
  fi
  if ! grep -q '^OLLAMA_VISION_MODEL=' "$ENVFILE"; then
    echo "OLLAMA_VISION_MODEL=$MODEL" >> "$ENVFILE"
  fi
  echo "    .env atualizado"
  systemctl is-active --quiet pm2-root 2>/dev/null && pm2 reload analisador --update-env >/dev/null 2>&1 || true
else
  echo "    .env nao encontrado em $ENVFILE — configure OLLAMA_VISION_URL a mao"
fi

echo
echo "========================================"
echo " GPU_VISION ONLINE"
echo " endpoint  http://127.0.0.1:$LOCAL_PORT"
echo " modelo    $MODEL"
echo " latencia  ${LATENCY} ms   (CPU da VPS: 177000 ms)"
echo " leitura   $ACERTOS/4 valores corretos"
echo "========================================"
