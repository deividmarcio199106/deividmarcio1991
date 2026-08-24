#!/bin/bash
# Religa o tunel SSH VPS -> GPU Vast.ai e valida a ponte inteira.
# Uso: bash religar-gpu.sh <IP_DA_GPU> <PORTA_SSH>
set -euo pipefail

IP="${1:?informe o IP da GPU}"
PORTA="${2:?informe a porta SSH da instancia Vast}"
CHAVE=/root/.ssh/vast_gpu_ed25519
SERVICE=/etc/systemd/system/vast-gpu-tunnel.service

echo "=== 1/6 Testando SSH ate a GPU ($IP:$PORTA) ==="
if ! ssh -i "$CHAVE" -p "$PORTA" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -o BatchMode=yes "root@$IP" 'echo SSH_OK; nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null || echo "(nvidia-smi indisponivel)"'; then
  echo "FALHOU: a VPS nao conseguiu autenticar na GPU."
  echo "Confira se esta chave publica esta cadastrada na conta/instancia Vast:"
  cat /root/.ssh/vast_gpu_ed25519.pub
  exit 1
fi

echo
echo "=== 2/6 Ollama esta rodando na GPU? ==="
ssh -i "$CHAVE" -p "$PORTA" -o StrictHostKeyChecking=accept-new "root@$IP" \
  'curl -s --max-time 10 http://127.0.0.1:11434/api/tags >/dev/null && echo "ollama respondendo em 127.0.0.1:11434" || { echo "ollama NAO responde na GPU"; exit 1; }'

echo
echo "=== 3/6 Modelos instalados na GPU ==="
ssh -i "$CHAVE" -p "$PORTA" -o StrictHostKeyChecking=accept-new "root@$IP" \
  'curl -s --max-time 15 http://127.0.0.1:11434/api/tags | tr "," "\n" | grep -o "\"name\":\"[^\"]*\"" | cut -d: -f2 | tr -d "\"" || echo "(sem modelos)"'

echo
echo "=== 4/6 Atualizando o service do tunel ==="
cat > "$SERVICE" <<UNIT
[Unit]
Description=Tunel SSH Hostinger para GPU Vast.ai
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=root
ExecStart=/usr/bin/ssh -i $CHAVE -N -T -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o StrictHostKeyChecking=accept-new -L 127.0.0.1:11435:127.0.0.1:11434 -p $PORTA root@$IP
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable vast-gpu-tunnel >/dev/null 2>&1; systemctl restart vast-gpu-tunnel
sleep 4
systemctl is-active vast-gpu-tunnel && echo "tunel ativo" || { echo "tunel NAO subiu"; journalctl -u vast-gpu-tunnel -n 20 --no-pager; exit 1; }

echo
echo "=== 5/6 Ollama alcancavel pela porta local 11435 da VPS ==="
curl -s --max-time 15 http://127.0.0.1:11435/api/tags | head -c 400; echo

echo
echo "=== 6/6 Contrato do analisador ==="
printf 'api/health   : '; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8081/api/health
printf 'api/ai/health: '; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8081/api/ai/health
curl -s --max-time 20 http://127.0.0.1:8081/api/ai/health | head -c 500; echo
