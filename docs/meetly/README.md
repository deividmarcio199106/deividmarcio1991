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

## Backend

- API em `src/server/meetly/meetlyEndpoints.ts`, servida em `/api/meetly/*` antes do SSR.
- Banco SQLite próprio: `DATA_DIR/meetly.sqlite` (ou `MEETLY_DATABASE_PATH`), separado do
  banco do analisador.
- Senhas com scrypt; sessão em cookie `HttpOnly; SameSite=Lax` (e `Secure` em HTTPS); no
  banco fica só o SHA-256 do token.
- Toda escrita exige o cabeçalho `x-requested-with: meetly` (proteção contra CSRF).
- Limite de 10 tentativas por minuto em login/cadastro.

### Permissões

- Só participantes enxergam a reunião (os outros recebem 404).
- Qualquer participante pode convidar outra pessoa pelo e-mail (ela precisa ter conta).
- Só o anfitrião edita, exclui ou remove participantes. Os demais podem **sair** da reunião.

No app original qualquer participante podia excluir a reunião para todos; aqui isso ficou
restrito ao anfitrião.

## Videochamada

As salas usam Jitsi Meet. O nome da sala segue o app original: uma expressão em inglês +
`-r-` + 6 caracteres aleatórios (ex.: `break-a-leg-r-a8Kq2Z`).

| Variável              | Padrão        | Uso                                              |
| --------------------- | ------------- | ------------------------------------------------ |
| `MEETLY_JITSI_DOMAIN` | `meet.jit.si` | Servidor Jitsi (ex.: um self-hosted ou `8x8.vc`) |

O meet.jit.si público encerra chamadas **embutidas** em outros sites após alguns minutos e
pode pedir login para abrir a sala. A tela da sala tem o botão "Abrir em nova aba" para
contornar isso; para uso contínuo, configure um servidor Jitsi próprio.

## O que ficou de fora

- **Verificação de e-mail e "Esqueci minha senha"**: dependem de um serviço de envio de
  e-mail, que o projeto não tem. Há troca de senha no perfil.
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
