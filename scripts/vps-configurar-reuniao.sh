#!/usr/bin/env bash
# =============================================================================
# Roda NA VPS (como root): publica o Meetly no domínio próprio.
#
#   ssh root@VPS 'DOMAIN=reuniao.dvdswap.com.br bash -s' < vps-configurar-reuniao.sh
#
# Ordem pensada para NUNCA deixar o domínio servindo o analisador:
#   1. DNS do domínio (A e AAAA) aponta para ESTA VPS?
#   2. Analisador no ar com o Meetly em 127.0.0.1:$PORT?
#   3. Nenhum outro site do Nginx já usa o domínio? (senão para: o certbot
#      mexeria no certificado daquele site)
#   4. MEETLY_HOSTS no .env (com backup) + reinício do PM2 carregando o .env;
#      confere que o app JÁ trata o domínio como "só Meetly". Se o app não
#      voltar, restaura o .env e reinicia de novo.
#   5. Só então cria o server block do domínio — e ele mesmo só deixa passar
#      os caminhos do Meetly (o resto vira 302 para /meetly), mesmo que um dia
#      o app suba sem MEETLY_HOSTS. nginx -t antes de recarregar; desfaz se falhar.
#   6. HTTPS com certbot (só este domínio, --cert-name próprio).
#   7. Validação pelo domínio.
#
# Variáveis: DOMAIN (obrigatória), PORT (8081), APP_DIR (/var/www/analisador),
# PM2_APP (analisador), CERT_EMAIL (opcional), NGINX_DIR (/etc/nginx),
# LE_DIR (/etc/letsencrypt), SKIP_DNS_CHECK=1 (só se souber o que faz).
# =============================================================================
set -euo pipefail

DOMAIN="${DOMAIN:?Defina DOMAIN, ex.: DOMAIN=reuniao.dvdswap.com.br}"
PORT="${PORT:-8081}"
APP_DIR="${APP_DIR:-/var/www/analisador}"
PM2_APP="${PM2_APP:-analisador}"
NGINX_DIR="${NGINX_DIR:-/etc/nginx}"
LE_DIR="${LE_DIR:-/etc/letsencrypt}"
CERT_EMAIL="${CERT_EMAIL:-}"
MARKER="# Meetly — criado por scripts/vps-configurar-reuniao.sh"

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
http_code() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@" || true; }

[[ "$DOMAIN" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] ||
  die "DOMAIN inválido: $DOMAIN"
[[ "$PORT" =~ ^[0-9]{2,5}$ ]] || die "PORT inválida: $PORT"
for bin in nginx curl getent pm2 certbot; do
  command -v "$bin" >/dev/null || die "Falta '$bin' na VPS (certbot: apt install certbot python3-certbot-nginx)."
done

# ---------------------------------------------------------------------------
say "1/7 DNS de $DOMAIN"
domain_v4=$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ' || true)
domain_v6=$(getent ahostsv6 "$DOMAIN" 2>/dev/null | awk '{print $1}' | grep -v '^::ffff:' | sort -u | tr '\n' ' ' || true)
public_ip=$(curl -s --max-time 10 https://api.ipify.org || true)
local_ips=$(hostname -I 2>/dev/null || true)
echo "A: ${domain_v4:-nenhum} | AAAA: ${domain_v6:-nenhum} | IP público: ${public_ip:-?} | locais: ${local_ips:-?}"
if [ "${SKIP_DNS_CHECK:-0}" != "1" ]; then
  [ -n "$domain_v4" ] || die "$DOMAIN não resolve. Crie o registro A apontando para ${public_ip:-esta VPS}."
  for ip in $domain_v4; do
    case " $public_ip $local_ips " in *" $ip "*) ;; *)
      die "$DOMAIN aponta para $ip, mas esta VPS é ${public_ip:-?}. Corrija o registro A (ou rode na VPS certa)." ;;
    esac
  done
  for ip in $domain_v6; do
    case " $local_ips " in *" $ip "*) ;; *)
      die "$DOMAIN tem AAAA $ip, que não é desta VPS: o HTTPS falharia por IPv6. Apague ou corrija o AAAA." ;;
    esac
  done
fi

# ---------------------------------------------------------------------------
say "2/7 Analisador em 127.0.0.1:$PORT"
[ "$(http_code "http://127.0.0.1:$PORT/api/health")" = "200" ] ||
  die "/api/health não respondeu 200. O app precisa estar no ar antes."
[ "$(http_code "http://127.0.0.1:$PORT/meetly/entrar")" = "200" ] ||
  die "/meetly/entrar não respondeu 200: a versão com o Meetly ainda não está no ar."

# ---------------------------------------------------------------------------
say "3/7 Nenhum outro site usa $DOMAIN"
if [ -d "$NGINX_DIR/sites-available" ] && [ -d "$NGINX_DIR/sites-enabled" ]; then
  conf="$NGINX_DIR/sites-available/$DOMAIN"
  link="$NGINX_DIR/sites-enabled/$DOMAIN"
else
  conf="$NGINX_DIR/conf.d/$DOMAIN.conf"
  link=""
fi
# Configuração EFETIVA (nginx -T), arquivo por arquivo: quem menciona o domínio?
others=$(nginx -T 2>/dev/null | awk -v d="$DOMAIN" -v mine="$conf" -v mine2="${link:-$conf}" '
  /^# configuration file / { file = $4; sub(/:$/, "", file); next }
  {
    line = $0; sub(/#.*/, "", line)
    n = split(line, words, /[[:space:];]+/)
    for (i = 1; i <= n; i++) if (words[i] == d && file != mine && file != mine2) { print file; break }
  }' | sort -u | tr '\n' ' ' || true)
[ -z "$others" ] ||
  die "$DOMAIN já aparece na configuração de outro site: $others. Não vou mexer (o certbot trocaria o certificado desse site). Revise à mão."
own_exists=0
if [ -f "$conf" ]; then
  grep -qF "$MARKER" "$conf" || die "$conf existe e não foi criado por este script. Revise à mão."
  own_exists=1
fi

# ---------------------------------------------------------------------------
say "4/7 MEETLY_HOSTS no $APP_DIR/.env e reinício do PM2"
env_file="$APP_DIR/.env"
[ -f "$env_file" ] || die "Não achei $env_file."
current=$(grep -E '^MEETLY_HOSTS=' "$env_file" | tail -n 1 | cut -d= -f2- | tr -d "\"' \r" || true)
backup=""
case ",$current," in
  *",$DOMAIN,"*) echo "MEETLY_HOSTS já contém $DOMAIN." ;;
  *)
    backup="$env_file.backup-meetly-$(date +%Y%m%d-%H%M%S)"
    cp -p "$env_file" "$backup"
    value="${current:+$current,}$DOMAIN"
    tmp=$(mktemp)
    awk -v v="$value" '
      /^MEETLY_HOSTS=/ { if (!done) { print "MEETLY_HOSTS=\"" v "\""; done = 1 } next }
      { print }
      END { if (!done) print "MEETLY_HOSTS=\"" v "\"" }' "$env_file" >"$tmp"
    cat "$tmp" >"$env_file" # mantém dono e permissões do .env
    rm -f "$tmp"
    echo "MEETLY_HOSTS=\"$value\" (backup: $backup)"
    ;;
esac

restart_app() {
  (
    cd "$APP_DIR"
    # .env de produção pode ter valores que quebram `set -u` (ex.: um $ numa
    # senha); o procedimento manual também carrega sem esses modos.
    set +eu
    set -a
    # shellcheck disable=SC1091
    . ./.env
    set +a
    set -e
    pm2 restart "$PM2_APP" --update-env
    pm2 save
  )
  for _ in $(seq 1 24); do
    [ "$(http_code "http://127.0.0.1:$PORT/api/health")" = "200" ] && return 0
    sleep 5
  done
  return 1
}

if ! restart_app; then
  if [ -n "$backup" ]; then
    cp -p "$backup" "$env_file"
    restart_app || true
    die "O app não voltou depois do reinício. Restaurei o .env anterior e reiniciei. Veja: pm2 logs $PM2_APP"
  fi
  die "O app não voltou depois do reinício. Veja: pm2 logs $PM2_APP"
fi
gate=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 10 \
  -H "Host: $DOMAIN" "http://127.0.0.1:$PORT/api/trading/snapshot" || true)
case "$gate" in
  404*) echo "OK: o app já trata $DOMAIN como só Meetly." ;;
  *) die "O app não ativou o modo Meetly para $DOMAIN (resposta: $gate). O domínio NÃO foi ligado no Nginx." ;;
esac

# ---------------------------------------------------------------------------
say "5/7 Nginx: server block próprio para $DOMAIN"
if [ "$own_exists" = "1" ]; then
  echo "$conf já existe (criado por este script) — mantido."
else
  cat >"$conf" <<NGINX
$MARKER
# Só os caminhos do Meetly vão para o app; qualquer outro vira 302 para /meetly.
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    client_max_body_size 1m;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header X-Forwarded-Host \$host;
    proxy_read_timeout 120s;

    location = / { return 302 /meetly; }
    location = /meetly { proxy_pass http://127.0.0.1:$PORT; }
    location ^~ /meetly/ { proxy_pass http://127.0.0.1:$PORT; }
    location ^~ /api/meetly/ { proxy_pass http://127.0.0.1:$PORT; }
    location = /api/health { proxy_pass http://127.0.0.1:$PORT; }
    location ^~ /assets/ { proxy_pass http://127.0.0.1:$PORT; }
    location = /robots.txt { proxy_pass http://127.0.0.1:$PORT; }
    location / { return 302 /meetly; }
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

# ---------------------------------------------------------------------------
say "6/7 Certificado HTTPS"
email_args=(--register-unsafely-without-email)
[ -n "$CERT_EMAIL" ] && email_args=(-m "$CERT_EMAIL")
if ! certbot --nginx -d "$DOMAIN" --cert-name "$DOMAIN" --non-interactive --agree-tos \
  --keep-until-expiring --redirect "${email_args[@]}"; then
  die "O certbot falhou. O domínio segue só em http, servindo apenas o Meetly. Veja /var/log/letsencrypt/letsencrypt.log e rode de novo."
fi
nginx -t

# ---------------------------------------------------------------------------
say "7/7 Validação"
root=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 10 \
  --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/" || true)
page=$(http_code --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/meetly/entrar")
api=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 10 \
  --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/trading/snapshot" || true)
echo "https://$DOMAIN/              → $root (esperado 302 .../meetly)"
echo "https://$DOMAIN/meetly/entrar → $page (esperado 200)"
echo "https://$DOMAIN/api/trading/… → $api (esperado 302 para /meetly: bloqueado no Nginx)"
case "$root" in 302*/meetly) ;; *) die "A raiz não redirecionou para /meetly." ;; esac
[ "$page" = "200" ] || die "/meetly/entrar não respondeu 200 pelo domínio."
case "$api" in 2*) die "Uma API do analisador respondeu pelo domínio do Meetly: $api" ;; esac
echo "OK: https://$DOMAIN está no ar."
