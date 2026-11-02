#!/usr/bin/env bash
# =============================================================================
# Roda NA VPS (como root): publica o Meetly no domínio próprio.
#
#   ssh root@VPS 'DOMAIN=reuniao.dvdswap.com.br bash -s' < vps-configurar-reuniao.sh
#
# O que faz, nesta ordem, parando no primeiro problema:
#   1. Confere se o DNS do domínio aponta para ESTA VPS.
#   2. Confere se o analisador responde em 127.0.0.1:$PORT.
#   3. Cria um server block do Nginx SÓ para o domínio (nunca edita os blocos
#      existentes: valetech, vendas, loja, analisador...). Testa com nginx -t;
#      se falhar, apaga o que criou e não recarrega nada.
#   4. Emite o certificado HTTPS (certbot --nginx -d DOMAIN, só esse domínio).
#   5. Acrescenta o domínio em MEETLY_HOSTS no .env do analisador (com backup)
#      e reinicia o PM2 carregando o .env (procedimento do CLAUDE_CONTEXT).
#   6. Valida: / → /meetly e /meetly/entrar = 200 pelo domínio.
#
# Variáveis: DOMAIN (obrigatória), PORT (8081), APP_DIR (/var/www/analisador),
# PM2_APP (analisador), CERT_EMAIL (opcional), NGINX_DIR (/etc/nginx),
# SKIP_DNS_CHECK=1 (só se você souber o que está fazendo).
# =============================================================================
set -euo pipefail

DOMAIN="${DOMAIN:?Defina DOMAIN, ex.: DOMAIN=reuniao.dvdswap.com.br}"
PORT="${PORT:-8081}"
APP_DIR="${APP_DIR:-/var/www/analisador}"
PM2_APP="${PM2_APP:-analisador}"
NGINX_DIR="${NGINX_DIR:-/etc/nginx}"
LE_DIR="${LE_DIR:-/etc/letsencrypt}"
CERT_EMAIL="${CERT_EMAIL:-}"

# SSH não interativo não carrega o PATH do Node/PM2 instalado por nvm.
for dir in /usr/local/bin /root/.nvm/versions/node/*/bin; do
  [ -d "$dir" ] && case ":$PATH:" in *":$dir:"*) ;; *) PATH="$PATH:$dir" ;; esac
done
export PATH

say() { printf '\n== %s\n' "$*"; }
die() {
  printf 'XX %s\n' "$*" >&2
  exit 1
}

[[ "$DOMAIN" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] ||
  die "DOMAIN inválido: $DOMAIN"
for bin in nginx curl getent pm2; do command -v "$bin" >/dev/null || die "Falta '$bin' na VPS."; done

say "1/6 DNS de $DOMAIN"
domain_ips=$(getent ahostsv4 "$DOMAIN" | awk '{print $1}' | sort -u | tr '\n' ' ')
public_ip=$(curl -s --max-time 10 https://api.ipify.org || true)
local_ips=$(hostname -I 2>/dev/null || true)
echo "DNS: ${domain_ips:-nenhum} | IP público desta VPS: ${public_ip:-?} | IPs locais: ${local_ips:-?}"
if [ "${SKIP_DNS_CHECK:-0}" != "1" ]; then
  [ -n "$domain_ips" ] || die "$DOMAIN não resolve. Crie o registro A apontando para ${public_ip:-esta VPS}."
  match=0
  for ip in $domain_ips; do
    case " $public_ip $local_ips " in *" $ip "*) match=1 ;; esac
  done
  [ "$match" = "1" ] ||
    die "$DOMAIN aponta para $domain_ips, mas esta VPS é ${public_ip:-?}. Corrija o registro A do DNS (ou rode este script na VPS certa)."
fi

say "2/6 Analisador em 127.0.0.1:$PORT"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:$PORT/api/health" || true)
[ "$code" = "200" ] || die "/api/health respondeu '$code'. O app precisa estar no ar antes."
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:$PORT/meetly/entrar" || true)
[ "$code" = "200" ] || die "/meetly/entrar respondeu '$code'. A versão com o Meetly ainda não está no ar."

say "3/6 Nginx: server block próprio para $DOMAIN"
existing=$(grep -rlE "server_name[^;]*[[:space:]]$DOMAIN([[:space:];]|$)" "$NGINX_DIR" 2>/dev/null || true)
if [ -n "$existing" ]; then
  echo "Já existe configuração para $DOMAIN em: $existing — não vou mexer."
else
  if [ -d "$NGINX_DIR/sites-available" ] && [ -d "$NGINX_DIR/sites-enabled" ]; then
    conf="$NGINX_DIR/sites-available/$DOMAIN"
    link="$NGINX_DIR/sites-enabled/$DOMAIN"
  else
    conf="$NGINX_DIR/conf.d/$DOMAIN.conf"
    link=""
  fi
  cat >"$conf" <<NGINX
# Meetly — criado por scripts/vps-configurar-reuniao.sh
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    client_max_body_size 1m;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;
    }
}
NGINX
  [ -n "$link" ] && ln -sfn "$conf" "$link"
  if ! nginx -t; then
    rm -f "$conf"
    [ -n "$link" ] && rm -f "$link"
    die "nginx -t falhou com o bloco novo; removi o arquivo e não recarreguei nada."
  fi
  systemctl reload nginx 2>/dev/null || nginx -s reload
  echo "Criado: $conf"
fi

say "4/6 Certificado HTTPS"
if [ -d "$LE_DIR/live/$DOMAIN" ]; then
  echo "Certificado de $DOMAIN já existe."
fi
command -v certbot >/dev/null ||
  die "certbot não está instalado. Instale (apt install certbot python3-certbot-nginx) e rode de novo."
email_args=(--register-unsafely-without-email)
[ -n "$CERT_EMAIL" ] && email_args=(-m "$CERT_EMAIL")
if [ -n "$(ls -A "$LE_DIR/accounts" 2>/dev/null || true)" ]; then email_args=(); fi
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --keep-until-expiring --redirect \
  "${email_args[@]+"${email_args[@]}"}"
nginx -t

say "5/6 MEETLY_HOSTS no $APP_DIR/.env e reinício do PM2"
env_file="$APP_DIR/.env"
[ -f "$env_file" ] || die "Não achei $env_file."
current=$(grep -E '^MEETLY_HOSTS=' "$env_file" | tail -n 1 | cut -d= -f2- | tr -d '"' || true)
case ",$current," in
  *",$DOMAIN,"*) echo "MEETLY_HOSTS já contém $DOMAIN." ;;
  *)
    cp -p "$env_file" "$env_file.backup-meetly-$(date +%Y%m%d-%H%M%S)"
    if [ -n "$current" ]; then
      sed -i "s|^MEETLY_HOSTS=.*|MEETLY_HOSTS=$current,$DOMAIN|" "$env_file"
    else
      printf '\nMEETLY_HOSTS=%s\n' "$DOMAIN" >>"$env_file"
    fi
    echo "MEETLY_HOSTS agora: $(grep -E '^MEETLY_HOSTS=' "$env_file" | tail -n 1 | cut -d= -f2-)"
    ;;
esac
(
  cd "$APP_DIR"
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
  pm2 restart "$PM2_APP" --update-env
  pm2 save
)

say "6/6 Validação"
for _ in $(seq 1 12); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:$PORT/api/health" || true)
  [ "$code" = "200" ] && break
  sleep 5
done
root=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 10 \
  --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/" || true)
page=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
  --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/meetly/entrar" || true)
api=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
  --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/trading/snapshot" || true)
echo "https://$DOMAIN/              → $root (esperado 302 .../meetly)"
echo "https://$DOMAIN/meetly/entrar → $page (esperado 200)"
echo "https://$DOMAIN/api/trading/… → $api (esperado 404: o analisador não aparece neste domínio)"
case "$root" in 302*/meetly) ;; *) die "A raiz não redirecionou para /meetly. MEETLY_HOSTS foi carregado no PM2?" ;; esac
[ "$page" = "200" ] || die "/meetly/entrar não respondeu 200 pelo domínio."
echo "OK: https://$DOMAIN está no ar."
