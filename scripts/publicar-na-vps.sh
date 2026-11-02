#!/usr/bin/env bash
# =============================================================================
# Publica na VPS as mudanças feitas no repositório do GitHub (Lovable).
#
# POR QUE ESTE SCRIPT EXISTE
#   O repositório do GitHub (deividmarcio199106/deividmarcio1991) NÃO tem o
#   mesmo histórico do bare repo da VPS (root@179.197.238.143:/var/repo/
#   analisador.git): ele nasceu de um zip (ANALISADOR_T4_RTD_bb247b8.zip).
#   Então não dá para simplesmente "git push" de um para o outro.
#
#   Este script pega o que mudou no GitHub desde o snapshot (commit BASE) e
#   aplica, arquivo por arquivo, no seu clone da VPS — mas SÓ se o arquivo no
#   seu clone ainda for igual ao do snapshot. Se alguém mexeu nele na VPS
#   depois, o script NÃO sobrescreve: arquivo de código aborta tudo; arquivo
#   de documentação é pulado com aviso. Nada é forçado (sem force-push).
#
# COMO USAR (Git Bash, na pasta do clone da VPS). O script fica FORA do clone,
# porque ele exige o clone sem arquivos soltos:
#   cd /c/Users/user/Desktop/projetos/ANALISADOR_T4_RTD
#   git fetch https://github.com/deividmarcio199106/deividmarcio1991.git claude/hopeful-mendel-sdzu75
#   git show FETCH_HEAD:scripts/publicar-na-vps.sh > ~/publicar-na-vps.sh
#   bash ~/publicar-na-vps.sh
#
# Variáveis opcionais:
#   GH_URL      repositório de origem   (padrão: GitHub deividmarcio1991)
#   GH_BRANCH   branch de origem        (padrão: claude/hopeful-mendel-sdzu75)
#   BASE        commit do snapshot      (padrão: 0931aae)
#   VPS_REMOTE  remote da VPS           (padrão: vps)
#   SSH_KEY     chave SSH da VPS        (padrão: ~/.ssh/t4_vps)
#   VPS_HOST    destino SSH             (padrão: o usuário@host do remote VPS_REMOTE)
#   DOMAIN      domínio do Meetly       (padrão: reuniao.dvdswap.com.br)
#   CERT_EMAIL  e-mail para o certificado HTTPS (opcional)
#   SKIP_DOMAIN=1  não configura o domínio (só publica o código)
#   YES=1       não pergunta antes do push
#   NO_PUSH=1   prepara o commit local e para (não publica)
# =============================================================================
set -euo pipefail

GH_URL="${GH_URL:-https://github.com/deividmarcio199106/deividmarcio1991.git}"
GH_BRANCH="${GH_BRANCH:-claude/hopeful-mendel-sdzu75}"
BASE="${BASE:-0931aae}"
VPS_REMOTE="${VPS_REMOTE:-vps}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/t4_vps}"
VPS_HOST="${VPS_HOST:-}"
DOMAIN="${DOMAIN:-reuniao.dvdswap.com.br}"
CERT_EMAIL="${CERT_EMAIL:-}"

# Lockfiles: os do GitHub foram restaurados do próprio snapshot da VPS. Nunca
# são trocados por aqui — quem manda neles é o repositório da VPS.
SKIP_ALWAYS=("bun.lock" "package-lock.json")

say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }
die() {
  printf '\033[1;31mXX %s\033[0m\n' "$*" >&2
  exit 1
}

# Conteúdo sem CR: compara ignorando CRLF x LF (Windows x Linux).
norm() { tr -d '\r'; }

is_essential() {
  case "$1" in
    src/* | public/*) return 0 ;;
    *) return 1 ;;
  esac
}

[ -d .git ] || die "Rode dentro da pasta do clone da VPS (ANALISADOR_T4_RTD)."
git remote get-url "$VPS_REMOTE" >/dev/null 2>&1 || die "Remote '$VPS_REMOTE' não existe aqui."
[ -z "$(git status --porcelain)" ] || die "Há mudanças não commitadas neste clone. Resolva antes."

# Destino SSH = o mesmo do remote (ex.: root@179.197.238.143:/var/repo/analisador.git).
if [ -z "$VPS_HOST" ]; then
  remote_url=$(git remote get-url "$VPS_REMOTE")
  case "$remote_url" in
    ssh://*) VPS_HOST=$(printf '%s' "${remote_url#ssh://}" | cut -d/ -f1 | sed 's/:[0-9]*$//') ;;
    *@*:*) VPS_HOST="${remote_url%%:*}" ;;
    *) die "Não sei extrair o host SSH de '$remote_url'. Defina VPS_HOST=usuario@ip." ;;
  esac
fi
SSH=(ssh -i "$SSH_KEY" -o BatchMode=yes "$VPS_HOST")
echo "VPS: $VPS_HOST"

say "1/7 Atualizando o main a partir da VPS"
git fetch "$VPS_REMOTE"
git checkout -q main
git merge --ff-only "$VPS_REMOTE/main" ||
  die "O main local divergiu de $VPS_REMOTE/main. Resolva manualmente antes de publicar."
echo "main = $(git rev-parse --short HEAD)"

say "2/7 Buscando as mudanças do GitHub ($GH_BRANCH)"
git fetch "$GH_URL" "$GH_BRANCH"
SRC=$(git rev-parse FETCH_HEAD)
echo "origem = ${SRC:0:7}"
git cat-file -e "$BASE^{commit}" 2>/dev/null || die "Commit BASE $BASE não veio no fetch."

say "3/7 Conferindo arquivo por arquivo"
APPLY=()
SKIPPED=()
CONFLICTS=()
while IFS=$'\t' read -r status path; do
  for skip in "${SKIP_ALWAYS[@]}"; do [ "$path" = "$skip" ] && continue 2; done
  [ "$status" = "D" ] && die "Remoção não suportada pelo script: $path"

  new_blob="$SRC:$path"
  if [ -f "$path" ] && cmp -s <(git show "$new_blob" | norm) <(norm <"$path"); then
    continue # já está igual (rodada anterior)
  fi

  if [ "$status" = "A" ]; then
    if [ -e "$path" ]; then
      CONFLICTS+=("$path (já existe na VPS com outro conteúdo)")
    else
      APPLY+=("$path")
    fi
    continue
  fi

  # Modificado: só aplica se o arquivo daqui ainda é o do snapshot.
  if [ -f "$path" ] && cmp -s <(git show "$BASE:$path" | norm) <(norm <"$path"); then
    APPLY+=("$path")
  else
    CONFLICTS+=("$path (mudou na VPS depois do snapshot)")
  fi
done < <(git diff --no-renames --name-status "$BASE" "$SRC")

for item in "${CONFLICTS[@]+"${CONFLICTS[@]}"}"; do
  path="${item%% (*}"
  if is_essential "$path"; then
    printf '\n'
    for c in "${CONFLICTS[@]}"; do is_essential "${c%% (*}" && warn "CONFLITO: $c"; done
    die "Arquivos de código mudaram na VPS depois do snapshot. Nada foi alterado. Faça o merge manual desses arquivos."
  fi
  SKIPPED+=("$item")
done

if [ ${#APPLY[@]} -eq 0 ]; then
  echo "Nada novo a aplicar — a VPS já tem o código."
  NOTHING_NEW=1
else
  NOTHING_NEW=0
  echo "Serão aplicados ${#APPLY[@]} arquivo(s)."
fi
for item in "${SKIPPED[@]+"${SKIPPED[@]}"}"; do warn "pulado (documentação): $item"; done

publish_code() {
  say "4/7 Aplicando e criando o commit local"
  for path in "${APPLY[@]}"; do
    mkdir -p "$(dirname "$path")"
    git show "$SRC:$path" >"$path"
  done
  git add -- "${APPLY[@]}"
  git diff --cached --stat | tail -n 5
  git commit -q -m "feat(meetly): módulo Meetly + correções de build, lint e modo dev

Aplicado a partir do GitHub ($GH_BRANCH @ ${SRC:0:7}) por scripts/publicar-na-vps.sh,
somente em arquivos que não mudaram na VPS desde o snapshot bb247b8."
  NEW=$(git rev-parse --short HEAD)
  echo "commit local = $NEW"

  if [ "${NO_PUSH:-0}" = "1" ]; then
    say "NO_PUSH=1: parei antes de publicar. Para desfazer: git reset --hard $VPS_REMOTE/main"
    exit 0
  fi
  if [ "${YES:-0}" != "1" ]; then
    printf '\nPublicar %s na VPS agora (git push %s main)? [s/N] ' "$NEW" "$VPS_REMOTE"
    read -r answer
    [ "$answer" = "s" ] || [ "$answer" = "S" ] || {
      echo "Cancelado. O commit ficou só local. Para desfazer: git reset --hard $VPS_REMOTE/main"
      exit 0
    }
  fi

  say "5/7 Publicando (o hook da VPS roda npm ci, typecheck, testes e build)"
  git push "$VPS_REMOTE" main

  say "6/7 Conferindo a produção"
  local full deployed=""
  full=$(git rev-parse HEAD)
  for _ in $(seq 1 60); do
    deployed=$("${SSH[@]}" 'cat /var/www/analisador/.deployed-commit 2>/dev/null' || true)
    case "$deployed" in "$full"* | "$NEW"*) break ;; esac
    sleep 10
  done
  echo ".deployed-commit = ${deployed:-?}"
  case "$deployed" in
    "$full"* | "$NEW"*) echo "OK: a VPS está no commit novo." ;;
    *) die "A VPS não confirmou o commit novo. Veja: ${SSH[*]} 'tail -n 80 /var/log/t4-autodeploy.log'" ;;
  esac
  echo "health interno: $("${SSH[@]}" 'curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8081/api/health' || echo '?')"
}

if [ "$NOTHING_NEW" = "0" ]; then
  publish_code
fi

if [ "${SKIP_DOMAIN:-0}" = "1" ]; then
  echo "SKIP_DOMAIN=1: domínio não configurado."
  exit 0
fi

say "7/7 Domínio $DOMAIN (Nginx + HTTPS + MEETLY_HOSTS)"
git show "$SRC:scripts/vps-configurar-reuniao.sh" |
  "${SSH[@]}" "DOMAIN='$DOMAIN' CERT_EMAIL='$CERT_EMAIL' bash -s"

say "Conferência pela internet"
echo "https://$DOMAIN/meetly/entrar → $(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "https://$DOMAIN/meetly/entrar" || echo '?')"
echo "Pronto: abra https://$DOMAIN"
