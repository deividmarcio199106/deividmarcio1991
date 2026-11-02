#!/usr/bin/env bash
# =============================================================================
# Publica na VPS as mudanças feitas no repositório do GitHub (Lovable) e
# configura o domínio do Meetly.
#
# POR QUE ESTE SCRIPT EXISTE
#   O repositório do GitHub (deividmarcio199106/deividmarcio1991) NÃO tem o
#   mesmo histórico do bare repo da VPS (/var/repo/analisador.git): ele nasceu
#   de um zip (ANALISADOR_T4_RTD_bb247b8.zip). Não dá para "git push" direto.
#
#   Este script pega o que mudou no GitHub desde a ÚLTIMA versão publicada
#   (gravada no trailer "GitHub-Source:" do commit; na primeira vez, o
#   snapshot 0931aae) e aplica arquivo por arquivo no clone da VPS — só se o
#   arquivo daqui ainda for igual ao da última publicação. Se alguém mexeu
#   nele na VPS, o script não sobrescreve: código aborta tudo, documentação é
#   pulada com aviso. Nada é forçado (sem force-push).
#
# COMO USAR (Git Bash, na pasta do clone da VPS). O script fica FORA do clone,
# porque ele exige o clone sem arquivos soltos:
#   cd /c/Users/user/Desktop/projetos/ANALISADOR_T4_RTD
#   git fetch https://github.com/deividmarcio199106/deividmarcio1991.git claude/hopeful-mendel-sdzu75
#   git show FETCH_HEAD:scripts/publicar-na-vps.sh > ~/publicar-na-vps.sh
#   bash ~/publicar-na-vps.sh
#
# Variáveis opcionais:
#   GH_URL       repositório de origem  (padrão: GitHub deividmarcio1991)
#   GH_BRANCH    branch de origem       (padrão: claude/hopeful-mendel-sdzu75)
#   BASE         força a base de comparação (padrão: automático)
#   VPS_REMOTE   remote da VPS          (padrão: vps)
#   SSH_KEY      chave SSH (se o clone não tiver core.sshCommand; padrão ~/.ssh/t4_vps)
#   VPS_HOST     destino SSH            (padrão: o do remote VPS_REMOTE)
#   DOMAIN       domínio do Meetly      (padrão: reuniao.dvdswap.com.br)
#   CERT_EMAIL   e-mail para o certificado HTTPS (opcional)
#   SKIP_DOMAIN=1  não configura o domínio (só publica o código)
#   YES=1        não pergunta antes do push
#   NO_PUSH=1    prepara o commit local e para (não publica)
# =============================================================================
set -euo pipefail

GH_URL="${GH_URL:-https://github.com/deividmarcio199106/deividmarcio1991.git}"
GH_BRANCH="${GH_BRANCH:-claude/hopeful-mendel-sdzu75}"
SNAPSHOT_BASE="0931aae"
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
same_as() { cmp -s <(git show "$1:$2" | norm) <(norm <"$2"); }

is_essential() {
  case "$1" in
    src/* | public/* | package.json | vite.config.ts | tsconfig.json) return 0 ;;
    *) return 1 ;;
  esac
}

[ -d .git ] || die "Rode dentro da pasta do clone da VPS (ANALISADOR_T4_RTD)."
git remote get-url "$VPS_REMOTE" >/dev/null 2>&1 || die "Remote '$VPS_REMOTE' não existe aqui."
[ -z "$(git status --porcelain)" ] || die "Há mudanças não commitadas neste clone. Resolva antes."
[[ "$DOMAIN" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] ||
  die "DOMAIN inválido: $DOMAIN"

# --- SSH: o MESMO transporte que o git usa (core.sshCommand), com a porta do remote.
remote_url=$(git remote get-url "$VPS_REMOTE")
ssh_port=""
if [ -z "$VPS_HOST" ]; then
  case "$remote_url" in
    ssh://*)
      hostport=$(printf '%s' "${remote_url#ssh://}" | cut -d/ -f1)
      VPS_HOST="${hostport%%:*}"
      [ "$hostport" != "$VPS_HOST" ] && ssh_port="${hostport##*:}"
      ;;
    *@*:*) VPS_HOST="${remote_url%%:*}" ;;
    *) die "Não sei extrair o host SSH de '$remote_url'. Defina VPS_HOST=usuario@ip." ;;
  esac
fi
ssh_cmd=$(git config --get core.sshCommand || true)
if [ -n "$ssh_cmd" ]; then
  read -r -a SSH <<<"$ssh_cmd"
elif [ -f "$SSH_KEY" ]; then
  SSH=(ssh -i "$SSH_KEY")
else
  SSH=(ssh)
fi
SSH+=(-o ConnectTimeout=20)
[ -n "$ssh_port" ] && SSH+=(-p "$ssh_port")
SSH+=("$VPS_HOST")
echo "VPS: $VPS_HOST${ssh_port:+ (porta $ssh_port)}"

# ---------------------------------------------------------------------------
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

# Base = última versão do GitHub já publicada (trailer), senão o snapshot.
if [ -z "${BASE:-}" ]; then
  log=$(git log "$VPS_REMOTE/main" -n 300 --format=%B)
  BASE=$(printf '%s\n' "$log" | sed -n 's/^GitHub-Source: \([0-9a-f]\{40\}\)$/\1/p' | head -n 1)
  if [ -z "$BASE" ]; then
    # Formato antigo: "(claude/... @ abc1234) por scripts/publicar-na-vps.sh"
    BASE=$(printf '%s\n' "$log" | sed -n 's/.*@ \([0-9a-f]\{7,40\}\)) por scripts\/publicar-na-vps\.sh.*/\1/p' | head -n 1)
  fi
  BASE="${BASE:-$SNAPSHOT_BASE}"
fi
git cat-file -e "$BASE^{commit}" 2>/dev/null ||
  die "A base $BASE não está disponível (o branch do GitHub foi reescrito?). Defina BASE=<commit> à mão."
echo "base = $(git rev-parse --short "$BASE")"

# ---------------------------------------------------------------------------
say "3/7 Conferindo arquivo por arquivo"
APPLY=()
REMOVE=()
SKIPPED=()
CONFLICTS=()
while IFS=$'\t' read -r status path; do
  for skip in "${SKIP_ALWAYS[@]}"; do [ "$path" = "$skip" ] && continue 2; done

  if [ "$status" = "D" ]; then
    if [ ! -e "$path" ]; then
      continue
    elif same_as "$BASE" "$path"; then
      REMOVE+=("$path")
    else
      CONFLICTS+=("$path (removido no GitHub, mas mudou na VPS)")
    fi
    continue
  fi

  if [ -f "$path" ] && same_as "$SRC" "$path"; then
    continue # já está igual
  fi
  if [ "$status" = "A" ]; then
    if [ -e "$path" ]; then
      CONFLICTS+=("$path (já existe na VPS com outro conteúdo)")
    else
      APPLY+=("$path")
    fi
    continue
  fi
  # Modificado: só aplica se o arquivo daqui ainda é o da última publicação.
  if [ -f "$path" ] && same_as "$BASE" "$path"; then
    APPLY+=("$path")
  else
    CONFLICTS+=("$path (mudou na VPS depois da última publicação)")
  fi
done < <(git diff --no-renames --name-status "$BASE" "$SRC")

essential_conflict=0
for item in "${CONFLICTS[@]+"${CONFLICTS[@]}"}"; do
  if is_essential "${item%% (*}"; then
    warn "CONFLITO: $item"
    essential_conflict=1
  else
    SKIPPED+=("$item")
  fi
done
[ "$essential_conflict" = "0" ] ||
  die "Arquivos de código mudaram na VPS. Nada foi alterado. Faça o merge manual desses arquivos."
for item in "${SKIPPED[@]+"${SKIPPED[@]}"}"; do warn "pulado (documentação): $item"; done

if [ ${#APPLY[@]} -eq 0 ] && [ ${#REMOVE[@]} -eq 0 ]; then
  echo "Nenhum arquivo a aplicar: o clone já tem o código do GitHub."
else
  say "4/7 Aplicando e criando o commit local (${#APPLY[@]} arquivo(s), ${#REMOVE[@]} remoção(ões))"
  for path in "${APPLY[@]+"${APPLY[@]}"}"; do
    mkdir -p "$(dirname "$path")"
    git show "$SRC:$path" >"$path"
  done
  if [ ${#APPLY[@]} -gt 0 ]; then git add -- "${APPLY[@]}"; fi
  if [ ${#REMOVE[@]} -gt 0 ]; then git rm -q -- "${REMOVE[@]}"; fi
  git diff --cached --stat | tail -n 5
  git commit -q -F - <<MSG
feat(meetly): publica o Meetly e correções vindas do GitHub

Aplicado por scripts/publicar-na-vps.sh a partir de $GH_BRANCH,
somente em arquivos que não mudaram na VPS desde a última publicação.

GitHub-Source: $SRC
MSG
  echo "commit local = $(git rev-parse --short HEAD)"
fi

# ---------------------------------------------------------------------------
pending=$(git rev-list --count "$VPS_REMOTE/main..main")
if [ "$pending" -gt 0 ]; then
  if [ "${NO_PUSH:-0}" = "1" ]; then
    say "NO_PUSH=1: parei antes de publicar. Para desfazer: git reset --hard $VPS_REMOTE/main"
    exit 0
  fi
  if [ "${YES:-0}" != "1" ]; then
    printf '\nPublicar %s commit(s) na VPS agora (git push %s main)? [s/N] ' "$pending" "$VPS_REMOTE"
    read -r answer
    [ "$answer" = "s" ] || [ "$answer" = "S" ] || {
      echo "Cancelado. O commit ficou só local. Para desfazer: git reset --hard $VPS_REMOTE/main"
      exit 0
    }
  fi
  say "5/7 Publicando (o hook da VPS roda npm ci, typecheck, testes e build)"
  git push "$VPS_REMOTE" main
  git fetch -q "$VPS_REMOTE"
fi

say "6/7 Conferindo o que está no ar"
target=$(git rev-parse "$VPS_REMOTE/main")
deployed=""
for _ in $(seq 1 18); do
  deployed=$("${SSH[@]}" 'cat /var/www/analisador/.deployed-commit 2>/dev/null' || true)
  deployed=$(printf '%s\n' "$deployed" | tr -d '\r' | awk 'NF { print $1; exit }')
  if [ -n "$deployed" ] && [ "${target#"$deployed"}" != "$target" ]; then break; fi
  sleep 10
done
echo "no ar: ${deployed:-?} | esperado: ${target:0:7}"
if [ -z "$deployed" ] || [ "${target#"$deployed"}" = "$target" ]; then
  die "A VPS não está no commit esperado (o hook pode ter reprovado nos testes). Veja: ${SSH[*]} 'tail -n 80 /var/log/t4-autodeploy.log'"
fi
echo "health interno: $("${SSH[@]}" 'curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8081/api/health' || echo '?')"

if [ "${SKIP_DOMAIN:-0}" = "1" ]; then
  echo "SKIP_DOMAIN=1: domínio não configurado."
  exit 0
fi

# ---------------------------------------------------------------------------
say "7/7 Domínio $DOMAIN (Nginx + HTTPS + MEETLY_HOSTS)"
remote_env="DOMAIN=$(printf '%q' "$DOMAIN") CERT_EMAIL=$(printf '%q' "$CERT_EMAIL")"
git show "$SRC:scripts/vps-configurar-reuniao.sh" | "${SSH[@]}" "$remote_env bash -s"

say "Conferência pela internet"
echo "https://$DOMAIN/meetly/entrar → $(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "https://$DOMAIN/meetly/entrar" || echo '?')"
echo "Pronto: abra https://$DOMAIN"
