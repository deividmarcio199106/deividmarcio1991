# Atualizador T4 — deploy 1-clique

`Atualizar-T4.exe` atualiza o site na VPS sem terminal. Você altera o projeto,
dá dois cliques, e ele faz o resto — com rollback automático se algo falhar.

## Compilar

```cmd
updater\build.cmd
```

Usa o compilador C# que já vem no Windows (.NET Framework 4). **Nada a instalar.**
Gera `updater\Atualizar-T4.exe`.

## Configurar

Copie `updater.config.example.json` para `updater.config.json` (já vem pronto
na pasta), preencha e deixe-o **na mesma pasta do .exe**. O `updater.config.json`
está no `.gitignore` — ele carrega host, usuário e caminho da sua chave SSH, e
não deve ir para o repositório:

```json
{
  "host": "seu.servidor.com",
  "user": "deploy",
  "port": 22,
  "identityFile": "C:\\Users\\voce\\.ssh\\id_ed25519",
  "remotePath": "/var/www/analisador",
  "pm2App": "analisador",
  "healthUrl": "https://seu-dominio.com/api/health",
  "localProjectPath": "C:\\Users\\voce\\Desktop\\ANALISADOR_T4_RTD",
  "nodeInstall": "npm ci",
  "buildCommand": "npm run build",
  "keepReleases": 5
}
```

Trocar de servidor é trocar este arquivo — o executável não precisa ser recompilado.

## Preparar a VPS (uma vez)

```bash
sudo mkdir -p /var/www/analisador/{releases,shared/data}
sudo chown -R deploy:deploy /var/www/analisador
# .env de produção vive em shared/ e NUNCA é enviado pelo updater:
sudo -u deploy nano /var/www/analisador/shared/.env
```

O PM2 deve apontar para `current`:

```bash
cd /var/www/analisador/current && pm2 start npm --name analisador -- start && pm2 save
```

## Usar

Dois cliques no `.exe`, ou **arraste uma pasta / um `.zip` sobre o executável**
(ou sobre a janela aberta) para usá-lo como origem.

| Botão | O que faz |
|---|---|
| `ATUALIZAR SITE` | executa o deploy completo |
| `TESTAR CONEXÃO` | valida SSH, Node e PM2 na VPS, sem enviar nada |
| `REVERTER ÚLTIMA VERSÃO` | volta o `current` para o release anterior e recarrega o PM2 |
| `VER LOG` | abre `atualizador-t4.log` (ao lado do .exe) |

## O que acontece, na ordem

```
Conexão → Preparando → Backup → Enviando → Build → PM2 → Health Check → Concluído
```

1. Valida a configuração e confirma que a origem tem `package.json`.
2. Testa o SSH.
3. Empacota com `tar`, **excluindo** `node_modules`, `.git`, `.output`, `dist`,
   `data`, `.env*`, `*.sqlite*` e a própria pasta `updater`.
4. Envia por `scp` para `/tmp`.
5. Extrai em `releases/<timestamp>` — **nunca por cima da versão no ar**.
6. Liga `shared/.env` e `shared/data` dentro do release novo (link, não cópia).
7. Roda `npm ci` e `npm run build` **dentro do release novo**.
8. Só depois do build passar, troca o symlink `current` de forma atômica
   (`ln -sfn` + `mv -Tf`: nunca existe um instante sem `current`).
9. `pm2 reload` e healthcheck real (até 6 tentativas, 5s entre elas).
10. Se o health falhar: devolve o symlink ao release anterior, recarrega o PM2,
    e refaz o health para dizer se a versão anterior voltou saudável.
11. Poda releases antigos, mantendo `keepReleases`.

**A versão no ar continua servindo durante todo o processo.** Um build que
falha na VPS não chega nem a tocar no `current`.

## Segurança

- Autentica **só por chave SSH**. Não pede, não guarda e não transporta senha.
- Nenhuma chave de API é embutida no executável.
- `StrictHostKeyChecking=accept-new` e `BatchMode=yes`: sem prompt interativo,
  sem aceitar host trocado silenciosamente.
- Mutex global impede duas atualizações simultâneas disputando o mesmo symlink.
- Timeout em toda etapa (upload 15min, build 30min, PM2 5min).
- `.env`, banco e `data/` da VPS nunca são enviados nem sobrescritos.

## Requisitos

**Windows:** `ssh.exe`, `scp.exe` (OpenSSH, já vem no Windows 10+) e `tar.exe`
(também in-box). Verifique com `where ssh` e `where tar`.

**VPS:** `bash`, `tar`, `node`, `npm`, `pm2`, `curl`, `ln`, `readlink`.

## Auto-update do próprio updater

Não implementado. Um executável que se substitui sozinho precisa de assinatura
de código para não virar vetor de ataque — sem isso, prefiro que a atualização
do updater seja recompilar com `build.cmd`, que leva menos de um segundo.
