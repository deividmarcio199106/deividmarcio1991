# Adaptações locais do Claude Advisor (agent-advisor)

Esta pasta é uma cópia de `platforms/claude/` do hub
[agent-advisor](https://github.com/toshon-jennings/agent-advisor) (MIT, autor Toshon
Jennings), que por sua vez adapta o [Sol Advisor](https://github.com/DannyMac180/sol-advisor)
de Daniel McAteer (MIT). A atribuição está em [ORIGIN.md](ORIGIN.md) e [LICENSE](LICENSE).

## O que foi mudado e por quê

| Mudança | Motivo |
|---|---|
| Plugin e marketplace renomeados de `claude-advisor` para `agent-advisor` | O Claude Code 2.1.316 recusa nomes de plugin de terceiros que começam com `claude-` (`claude plugin validate` falha). Os comandos passam a ser `/agent-advisor:opus` e `/agent-advisor:fable`; os agentes, `agent-advisor:implementer-bounded` etc. |
| Cadeira `opus` aponta para **Claude Opus 5.5** em vez de Opus 5 | As sessões deste projeto rodam em Opus 5.5; com o texto original a cadeira pararia sempre na checagem de modelo. |
| `scripts/verify.sh` acompanha o novo nome | As checagens estruturais (10/10) continuam as mesmas, só com o caminho e o prefixo novos. |
| `spoke.manifest`, `.github/` e `scripts/hooks/` não foram copiados | São infraestrutura de sincronização do hub; não fazem nada dentro deste repositório. |

Os pins de modelo dos agentes continuam como aliases (`sonnet`, `opus`), que o Claude Code
resolve para a versão mais nova de cada família.

## Como instalar (uma vez por máquina)

Na raiz do repositório, dentro do Claude Code:

```text
/plugin marketplace add ./.claude/agent-advisor
/plugin install agent-advisor@agent-advisor
```

Abra uma sessão nova depois de instalar: os componentes só aparecem em sessões iniciadas
depois da instalação.

Não há `.claude/settings.json` declarando o marketplace automaticamente porque, no teste
feito, o caminho relativo não foi resolvido pelo Claude Code ("plugin not found in
marketplace"); só o caminho absoluto funcionou, e ele seria diferente em cada máquina.

## Revisão cruzada (Codex)

As rotas `audit` e `full` exigem o revisor `reviewer-codex`, que roda o Codex CLI da
OpenAI (`gpt-5.6-sol`). Sem o Codex instalado e logado, o script sai com código 2 ou 3 e o
fluxo pede sua autorização para cair no revisor interno `reviewer-sonnet`. O Sol Advisor
original para o próprio Codex é instalado com:

```bash
codex plugin marketplace add DannyMac180/sol-advisor --ref main
```

```bash
codex plugin add sol-advisor@sol-advisor
```

Lembre que a revisão cruzada envia o código revisado para a OpenAI.

## Validar depois de editar

```bash
bash .claude/agent-advisor/scripts/verify.sh
```

```bash
claude plugin validate .claude/agent-advisor
```
