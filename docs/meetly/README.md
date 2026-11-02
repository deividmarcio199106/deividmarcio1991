# Meetly (versão web)

Recriação web do app Android [vigneshshettyin/Meetly](https://github.com/vigneshshettyin/Meetly)
dentro deste projeto, em `/meetly`. O Analisador T4 não foi alterado; o Meetly aparece no
grupo **Apps** da barra lateral.

## Telas

| Rota                  | Equivale a (Android)               | O que faz                                                 |
| --------------------- | ---------------------------------- | --------------------------------------------------------- |
| `/meetly/entrar`      | `LoginActivity`                    | Login com e-mail e senha                                  |
| `/meetly/cadastro`    | `RegisterActivity`                 | Criação de conta (nome, e-mail, senha ≥ 6)                |
| `/meetly`             | `MainActivity` + `MeetingFilter`   | Minhas reuniões, busca por título, filtro por dia, "Hoje" |
| `/meetly/reuniao/:id` | `MeetingViewDetail`                | Detalhes, anfitrião, participantes, link, editar/excluir  |
| `/meetly/sala/:id`    | `JitsiMeetActivity`                | Videochamada Jitsi embutida (ou em nova aba)              |
| `/meetly/perfil`      | `UserProfile`                      | Foto, nome, telefone e troca de senha                     |
| `/meetly/sobre`       | `LibraryActivity` / `DevsActivity` | Sobre o app e créditos                                    |

## Domínio próprio (reuniao.dvdswap.com.br)

O mesmo processo serve o analisador e o Meetly. Com `MEETLY_HOSTS=reuniao.dvdswap.com.br` no
`.env`, quem entra por esse domínio vê **só o Meetly**:

- `/` e qualquer página do analisador redirecionam para `/meetly`;
- APIs que não são do Meetly respondem 404 (passam só `/api/meetly/*` e `/api/health`);
- a casca do NEXUS (barra lateral, status, `AnalyzerProvider`) não é montada — nenhuma sessão
  T4 nasce nesse domínio.

O Nginx precisa repassar o domínio (`proxy_set_header Host $host;`). Tudo isso é configurado
por `scripts/vps-configurar-reuniao.sh` (roda na VPS) — chamado pelo passo 7 de
`scripts/publicar-na-vps.sh`: confere o DNS, cria um server block só para o domínio (sem tocar
nos outros sites), emite o HTTPS com o certbot, acrescenta `MEETLY_HOSTS` ao `.env` (com
backup) e reinicia o PM2 carregando o `.env`.

## Backend

- API em `src/server/meetly/meetlyEndpoints.ts`, servida em `/api/meetly/*` antes do SSR.
- Banco SQLite próprio: `DATA_DIR/meetly.sqlite` (ou `MEETLY_DATABASE_PATH`), separado do
  banco do analisador.
- Senhas com scrypt; no banco fica só o SHA-256 do token de sessão.
- Sessão em cookie `HttpOnly; SameSite=Lax`. Com `NODE_ENV=production` (ou HTTPS) o cookie
  é `__Host-meetly_session` com `Secure`; o nome sem prefixo só vale em desenvolvimento.
  `MEETLY_INSECURE_COOKIE=1` desliga isso para testar o build por http numa rede local.
- Toda escrita exige o cabeçalho `x-requested-with: meetly` (proteção contra CSRF).
- Limites de tentativa (`src/server/meetly/meetlyRateLimit.ts`): só **falhas** de login
  contam, por par IP+e-mail (10 em 15 min), por IP (30) e por conta (100 por hora);
  cadastro 10 por hora por IP; convites 30 a cada 10 min por usuário. Quem só conhece o
  e-mail de alguém não consegue travar o login dessa pessoa.
- Páginas `/meetly*` saem com `X-Frame-Options: SAMEORIGIN` e `frame-ancestors 'self'`.

### Requisitos no Nginx / PM2

O IP do cliente só é confiável se o Nginx o informar. No `location` do analisador:

```nginx
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-Proto $scheme;
```

O código usa o **último** item do `X-Forwarded-For` (o que o Nginx acrescenta) e só aceita
esses cabeçalhos quando a conexão vem do loopback. Rode o Node com `NODE_ENV=production` e,
de preferência, `NITRO_HOST=127.0.0.1`, para a porta 8081 não ficar exposta sem o Nginx.

### Permissões

- Só participantes enxergam a reunião (os outros recebem 404).
- Só o anfitrião convida (por e-mail; a pessoa precisa ter conta), edita, exclui ou remove
  participantes. Os demais podem **sair** da reunião. Até 100 participantes por reunião.
- Remover alguém (ou sair) **troca a sala de vídeo**: no Jitsi público o nome da sala é a
  única credencial, então o link antigo deixa de valer.
- Fotos de perfil saem por `GET /api/meetly/users/:id/avatar`, só para o próprio usuário ou
  para quem divide uma reunião com ele.

No app original qualquer participante podia convidar e até excluir a reunião para todos;
aqui isso ficou restrito ao anfitrião.

## Videochamada

As salas usam Jitsi Meet. O nome da sala segue o app original: uma expressão em inglês +
`-r-` + 6 caracteres aleatórios (ex.: `break-a-leg-r-a8Kq2Z`).

| Variável              | Padrão        | Uso                                               |
| --------------------- | ------------- | ------------------------------------------------- |
| `MEETLY_JITSI_DOMAIN` | `meet.jit.si` | Servidor Jitsi (ex.: um self-hosted ou `8x8.vc`)  |
| `MEETLY_HOSTS`        | (vazio)       | Domínios que mostram só o Meetly (separe por `,`) |

O meet.jit.si público encerra chamadas **embutidas** em outros sites após alguns minutos e
pode pedir login para abrir a sala. A tela da sala tem o botão "Abrir em nova aba" para
contornar isso; para uso contínuo, configure um servidor Jitsi próprio.

O iframe da sala roda com `sandbox` (sem poder navegar a aba do Meetly), recebe só o nome do
usuário (o e-mail não é enviado ao Jitsi) e não é recriado quando o título muda.

## O que ficou de fora

- **Verificação de e-mail e "Esqueci minha senha"**: dependem de um serviço de envio de
  e-mail, que o projeto não tem. Há troca de senha no perfil. Consequência conhecida: quem
  cadastrar primeiro um e-mail fica com ele, e o cadastro responde 409 para e-mail já usado
  (com limite por IP).
- **Login com Google**: exige um Client ID OAuth do Google.
- **Canal de suporte e lista de desenvolvedores**: dependiam de APIs no Heroku que não
  existem mais.

## Licença do projeto original

```
MIT License

Copyright (c) 2021 Vignesh Shetty & Sriganesh Rao

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

O logo (`public/meetly/logo.png`), a paleta de cores das reuniões e a lista de nomes de
sala vêm do projeto original.
