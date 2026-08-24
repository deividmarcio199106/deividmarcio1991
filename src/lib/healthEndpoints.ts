import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { checkAI, checkApp } from "@/services/ai";
import {
  aggregateHealth,
  medirArmazenamento,
  medirGravacoes,
  medirLatencia,
  medirMemoria,
  naoMedido,
  type HealthState,
  type SubsystemHealth,
  type SystemHealth,
} from "@/lib/health/systemHealth";
import { databaseInfo, listOpenSetups } from "@/server/tradingRepository";

/**
 * O MESMO diretório de dados que o repositório usa. Recalculado aqui em vez de
 * importado porque `dataDir` é interno ao repositório — e duplicar UMA
 * expressão de env é melhor que alargar a superfície pública dele só para um
 * health check ler um caminho.
 */
function dataDirPath(): string {
  return resolve(process.env["DATA_DIR"]?.trim() || "./data");
}

/**
 * Endpoints de saúde servidos ANTES do handler do TanStack Start
 * (ver `src/server.ts`).
 *
 * Ficam aqui, e não em rotas de arquivo, por três motivos práticos:
 *  - precisam responder mesmo que o SSR do aplicativo esteja quebrado — é assim
 *    que o `docker healthcheck` e o nginx descobrem que a aplicação subiu
 *    quebrada em vez de deixá-la "no ar" silenciosamente;
 *  - `curl`/monitoramento externo precisa de HTTP puro, não de server function;
 *  - não dependem da regeneração do routeTree.
 *
 * Nenhuma resposta expõe host, IP, token ou chave.
 */

export const HEALTH_PATHS = [
  "/api/health",
  "/api/health/ai",
  "/api/ai/health",
  "/api/health/ollama",
  /**
   * Saúde CONSOLIDADA dos subsistemas (captura, IA, banco, armazenamento,
   * memória, setups, pesquisa, shadow). Caminho NOVO e separado de propósito:
   * `/api/health` é o que o healthcheck do container consulta, e não pode
   * passar a devolver 503 por causa de um subsistema secundário — derrubar o
   * container por causa da GPU tiraria do ar o analisador, que funciona sem
   * ela. Aqui o diagnóstico é completo; lá continua sendo "a aplicação subiu?".
   */
  "/api/health/system",
] as const;

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // Monitoramento não pode receber resposta de cache.
      "cache-control": "no-store, no-cache, must-revalidate",
    },
  });
}

/**
 * Trata a requisição se ela for de health check; devolve `null` para que o
 * processamento normal do aplicativo continue.
 *
 * Códigos: 200 quando o ANALISADOR está de pé (mesmo com IA desligada ou
 * degradada — o analisador não depende de IA); 503 apenas quando o caminho
 * verificado está de fato quebrado.
 */
export async function handleHealthRequest(request: Request): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  const path = pathname.replace(/\/+$/, "") || "/";

  if (!(HEALTH_PATHS as readonly string[]).includes(path)) {
    return null;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ error: "Método não permitido — use GET." }, 405);
  }

  try {
    if (path === "/api/health") {
      const app = await checkApp();
      // 200 mesmo com a IA degradada: derrubar o container por causa da GPU
      // tiraria do ar o analisador, que funciona sem ela.
      return json(app, 200);
    }

    if (path === "/api/health/system") {
      const health = await checkSystem();
      // Sempre 200: este caminho é DIAGNÓSTICO, e um 503 aqui faria um
      // monitor externo confundir "subsistema degradado" com "aplicação fora".
      // O estado real vai no corpo, onde ele pode ser lido por inteiro.
      return json(health, 200);
    }

    // /api/ai/health e /api/health/ollama são aliases do mesmo check de IA —
    // o primeiro é o caminho validado no runbook de deploy; o segundo
    // permanece para instalações antigas.
    const ai = await checkAI();
    const httpStatus = ai.status === "falha" ? 503 : 200;
    return json(ai, httpStatus);
  } catch (e) {
    // Nunca "erro genérico": diz o que falhou e o que fazer.
    return json(
      {
        status: "falha",
        message: "O próprio health check falhou ao executar.",
        hint: "Verifique os logs do processo Node — provavelmente uma variável de ambiente inválida.",
        detail: e instanceof Error ? e.message : String(e),
      },
      503,
    );
  }
}

/* ------------------------------------------------------------------------- *
 * SAÚDE CONSOLIDADA DO SISTEMA
 *
 * Este bloco só COLETA números; todo o julgamento (limiares, o que é DEGRADED,
 * o que bloqueia sinal) mora em @/lib/health/systemHealth, que é puro e
 * testado. A separação existe para que a regra não fique escondida dentro de
 * um handler HTTP, onde ninguém consegue testá-la.
 *
 * O que NÃO dá para medir daqui é DECLARADO como não medido — nunca chutado
 * como saudável. Fila e última captura vivem no NAVEGADOR (o monitor de 60s é
 * um singleton do cliente), então o servidor não tem como afirmar nada sobre
 * elas: dizem-se ausentes, e a tela do operador preenche o que sabe.
 * ------------------------------------------------------------------------- */

/** Soma recursiva dos bytes de um diretório. Null quando ele nem existe. */
function tamanhoDoDiretorio(dir: string): number | null {
  if (!existsSync(dir)) return null;
  let total = 0;
  const pilha: string[] = [dir];
  while (pilha.length > 0) {
    const atual = pilha.pop()!;
    for (const entrada of readdirSync(atual, { withFileTypes: true })) {
      const caminho = join(atual, entrada.name);
      if (entrada.isDirectory()) pilha.push(caminho);
      else if (entrada.isFile()) total += statSync(caminho).size;
    }
  }
  return total;
}

export async function checkSystem(at: number = Date.now()): Promise<SystemHealth> {
  const leituras: SubsystemHealth[] = [];

  // IA: o check já existente devolve estado e latência reais.
  try {
    const ai = await checkAI();
    const estado: HealthState =
      ai.status === "falha" ? "ERROR" : ai.status === "ok" ? "OK" : "DEGRADED";
    leituras.push({
      id: "ia",
      label: "IA / GPU",
      state: estado,
      detail: ai.message,
      value: ai.latencyMs ?? null,
      unit: ai.latencyMs === null ? null : "ms",
    });
    leituras.push(medirLatencia(ai.latencyMs ?? null));
  } catch (problema) {
    leituras.push({
      id: "ia",
      label: "IA / GPU",
      state: "ERROR",
      detail: `o próprio check de IA falhou: ${problema instanceof Error ? problema.message : String(problema)}`,
      value: null,
      unit: null,
    });
    leituras.push(naoMedido("latencia", "LATÊNCIA", "check de IA não respondeu"));
  }

  // Banco: abrir e ler a versão do esquema é a prova de que ele responde.
  try {
    const info = databaseInfo();
    leituras.push({
      id: "banco",
      label: "BANCO",
      state: "OK",
      detail: `esquema v${info.schemaVersion} acessível`,
      value: info.schemaVersion,
      unit: null,
    });
  } catch (problema) {
    leituras.push({
      id: "banco",
      label: "BANCO",
      state: "ERROR",
      detail: `banco inacessível: ${problema instanceof Error ? problema.message : String(problema)}`,
      value: null,
      unit: null,
    });
  }

  // Setups em aberto: mede o acompanhamento automático dos desfechos.
  try {
    const abertos = listOpenSetups().length;
    leituras.push({
      id: "setups",
      label: "SETUPS ATIVOS",
      state: "OK",
      detail: abertos === 0 ? "nenhum setup em aberto" : `${abertos} setup(s) em acompanhamento`,
      value: abertos,
      unit: null,
    });
  } catch (problema) {
    leituras.push(
      naoMedido(
        "setups",
        "SETUPS ATIVOS",
        `consulta falhou: ${problema instanceof Error ? problema.message : String(problema)}`,
      ),
    );
  }

  /*
   * Armazenamento medido POR DIRETÓRIO, não em bloco.
   *
   * Somar o DATA_DIR inteiro e chamar de "prints" mentiu em produção: o painel
   * acusou 1 GB "em prints" quando os prints eram 33 MB e o volume vinha das
   * gravações de replay — que a retenção nem toca. Cada número agora tem o
   * dono certo, e a limpeza que ele sugere é a limpeza que resolve.
   */
  try {
    leituras.push(medirArmazenamento(tamanhoDoDiretorio(join(dataDirPath(), "prints"))));
  } catch {
    leituras.push(naoMedido("armazenamento", "ARMAZENAMENTO", "leitura do disco falhou"));
  }
  try {
    leituras.push(medirGravacoes(tamanhoDoDiretorio(join(dataDirPath(), "recordings"))));
  } catch {
    leituras.push(naoMedido("gravacoes", "GRAVAÇÕES", "leitura do disco falhou"));
  }
  leituras.push(medirMemoria(process.memoryUsage().heapUsed));

  /*
   * O monitor de 60s é um singleton do NAVEGADOR: o servidor não observa a
   * captura nem a fila. Afirmar "OK" aqui seria inventar medição — e é
   * exatamente o modo de falha que o agregador existe para impedir.
   */
  leituras.push(
    naoMedido("captura", "CAPTURA 60s", "o monitor roda no navegador do operador"),
    naoMedido("ultima_captura", "ÚLTIMA CAPTURA", "medida no cliente"),
    naoMedido("fila", "FILA DE ANÁLISE", "medida no cliente"),
    naoMedido("erros", "ERROS", "painel de erros consultado por endpoint próprio"),
    naoMedido("pesquisa", "PESQUISA", "sem execução em andamento neste processo"),
    naoMedido("shadow", "SHADOW", "nenhuma comparação em curso"),
    naoMedido("ultimo_processamento", "ÚLTIMO PROCESSAMENTO", "medido no cliente"),
  );

  return aggregateHealth(leituras, at);
}
