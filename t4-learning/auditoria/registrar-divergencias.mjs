/**
 * Registra no arquivo de hipoteses as divergencias entre o que o JSON auditado
 * afirma e o que o VIDEO mede. Regra do dono: video > evidencia extraida >
 * hipotese do Gemini > interpretacao do Claude. Divergencia nao se apaga: se
 * declara.
 *
 * Medicoes feitas com ffprobe (metadado do arquivo, nenhum frame lido — nenhum
 * lacre de TEST_FINAL foi tocado).
 */
import { readFileSync, writeFileSync } from "node:fs";

const caminho = "t4-learning/auditoria/hipoteses-exploratorias.json";
const h = JSON.parse(readFileSync(caminho, "utf8"));

h.medicoesDeVideo = {
  ferramenta: "ffprobe (somente metadado de duracao; nenhum frame decodificado)",
  "marco.mp4": { duracaoSeg: 1206.6333, pregoes: 22, segundosPorPregao: 54.85 },
  "maio.mp4": { duracaoSeg: 1206.7666, pregoes: null, segundosPorPregao: 54.85 },
  "fevereiro.mp4": { duracaoSeg: 561.1333, pregoes: null, segundosPorPregao: 54.85 },
};

h.divergenciasVideoXJson = [
  {
    id: "D-01",
    fonteQuePrevalece: "VIDEO",
    afirmacaoDoJson:
      "maio.mp4 possui mais de 2 minutos de rolagem continua cobrindo o final de abril e o mes de maio; amostragem cronologica de 8 eventos representativos.",
    medidoNoVideo:
      "maio.mp4 dura 1206.77 s (20 min 07 s). Os 8 eventos estao entre 00:05 e 02:00 — os primeiros 120 s, 9,9% do arquivo.",
    consequencia:
      "Na escala destes arquivos (marco.mp4: 1206.63 s para 22 pregoes = 54,85 s por pregao), 120 s equivalem a cerca de 2 pregoes. A amostra de maio cobre dois dias, nao o mes. Cai qualquer conclusao apoiada em representatividade mensal.",
    acao: "Rotular o lote MAIO como amostra de ~2 pregoes do inicio do arquivo; refazer amostragem ao longo dos 1206 s se quiser cobertura mensal.",
  },
  {
    id: "D-02",
    fonteQuePrevalece: "VIDEO",
    afirmacaoDoJson:
      "lote IMAGENS cobre de 27/fev a 30/mar, com timestampVideo indo de 00:01 a 00:08.",
    medidoNoVideo:
      "8 segundos de video, na escala de 54,85 s por pregao, sao menos de um sexto de um unico pregao.",
    consequencia:
      "Ou timestampVideo nao e segundo de video (e indice de captura), ou a cobertura declarada esta errada. Enquanto isso nao for resolvido, os eventos do lote IMAGENS nao sao localizaveis em video e nao podem ser conferidos frame a frame.",
    acao: "Pedir ao produtor do lote o mapeamento captura -> (arquivo, segundo) ou reextrair com timestamp real.",
  },
  {
    id: "D-03",
    fonteQuePrevalece: "VIDEO",
    afirmacaoDoJson: "avaliacao rigorosa dos 10 candles fechados apos a formacao do candidato.",
    medidoNoVideo:
      "54,85 s por pregao de ~660 min => ~12 min de mercado por segundo de video. 10 candles de 1 min ocupam ~0,83 s de video.",
    consequencia:
      "A janela de 10 candles cabe em menos de um segundo de rolagem. Ela e verificavel — basta comparar o frame t com o frame t+0,83 s — mas exige leitura de frame, nao existe no JSON, e nenhum dos 16 eventos traz o preco do fim da janela.",
    acao: "Ao conferir no video, extrair o par (t, t+0,83 s) e medir a amplitude em pontos, substituindo o rotulo por numero.",
  },
];

h.capacidadeDeVerificacao = {
  estado: "BLOQUEADO_POR_CAPACIDADE_E_POR_LACRE",
  motorDeVisaoAtivo: "ponte-claude (o proprio agente), ocupada servindo o baseline de marco",
  custoDaVerificacao:
    "16 eventos x 2 frames (candidato + fim da janela) = 32 leituras de visao, equivalente a cerca de um pregao inteiro do baseline",
  lacre:
    "maio.mp4 pertence ao conjunto TEST_FINAL (maio, julho, 8). Abrir frames de maio para pesquisa queima o lacre de maio de forma irreversivel; sobrariam julho.mp4 e 8.mp4.",
  decisaoPendenteDoDono: [
    "A) queimar o lacre de maio e conferir os 8 eventos de maio no video",
    "B) refazer a amostragem em fevereiro.mp4 (declarado dataset de DESCOBERTA) e conferir la",
    "C) esperar o baseline de marco fechar antes de gastar visao com verificacao",
  ],
};

writeFileSync(caminho, JSON.stringify(h, null, 2), "utf8");
console.log("divergencias D-01, D-02, D-03 registradas em", caminho);
