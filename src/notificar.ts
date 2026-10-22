import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { carregarConfigNotificacoes, carregarEnv, type Canal, type NotificacoesConfig } from "./notificacoes/config.js";
import { emailValido, mascararEmail, mascararTelefone, normalizarTelefone } from "./notificacoes/contatos.js";
import { carregarContatos } from "./notificacoes/fontes.js";
import { localizarCsvMaisRecente, paraCsv } from "./notificacoes/csv.js";
import { HistoricoEnvios, hashDestino, type StatusEnvio } from "./notificacoes/historico.js";
import { variaveisDesconhecidas } from "./notificacoes/modelo.js";
import { formatarPercentual } from "./notificacoes/percentual.js";
import { planejar, type ItemPlano, type Plano } from "./notificacoes/planejar.js";
import { lerPresencaArquivo, type AlunoFrequencia } from "./notificacoes/presenca.js";
import { semanaDeReferencia, type SemanaReferencia } from "./notificacoes/regras.js";
import { criarSender } from "./notificacoes/senders/index.js";

const AJUDA = `
Uso:
  npm run notificar                         Prévia: mostra quem receberia aviso (não envia nada)
  npm run notificar -- --execute            Envia pelo canal configurado
  npm run notificar -- --execute --destino-teste 45999998888
                                            Envia até 3 mensagens reais só para o número de teste
  npm run notificar -- modelo-contatos      Gera planilha com os alunos ainda sem contato cadastrado

Opções:
  --config <arquivo>          Padrão: config/notificacoes.json
  --csv <arquivo>             CSV de presença (padrão: o -latest da fonte configurada)
  --data-coleta AAAA-MM-DD    Data da coleta (padrão: data de modificação do CSV)
  --cgm <cgm>                 Processa só este aluno
  --cadastros <arquivo>       Usa outra base de cadastros (ex.: a do simulador). Só para prévia.
  --limite <n>                Máximo de envios nesta execução
`;

interface Opcoes {
  comando: "notificar" | "modelo-contatos" | "ajuda";
  config?: string;
  csv?: string;
  dataColeta?: string;
  cgm?: string;
  cadastros?: string;
  limite?: number;
  destinoTeste?: string;
  execute: boolean;
}

function lerArgs(argv: string[]): Opcoes {
  const o: Opcoes = { comando: "notificar", execute: false };
  const valor = (i: number, nome: string) => {
    const v = argv[i + 1];
    if (!v || v.startsWith("--")) throw new Error(`Opção ${nome} precisa de um valor.`);
    return v;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    switch (a) {
      case "modelo-contatos":
        o.comando = "modelo-contatos";
        break;
      case "--help":
      case "-h":
      case "ajuda":
        o.comando = "ajuda";
        break;
      case "--execute":
        o.execute = true;
        break;
      case "--config":
        o.config = valor(i++, a);
        break;
      case "--csv":
        o.csv = valor(i++, a);
        break;
      case "--data-coleta":
        o.dataColeta = valor(i++, a);
        break;
      case "--cadastros":
        o.cadastros = valor(i++, a);
        break;
      case "--cgm":
        o.cgm = valor(i++, a);
        break;
      case "--destino-teste":
        o.destinoTeste = valor(i++, a);
        break;
      case "--limite": {
        const n = Number.parseInt(valor(i++, a), 10);
        if (!Number.isInteger(n) || n <= 0) throw new Error("--limite precisa ser um inteiro positivo.");
        o.limite = n;
        break;
      }
      default:
        throw new Error(`Argumento desconhecido: ${a}\n${AJUDA}`);
    }
  }
  return o;
}

/** Data (dia) no fuso de São Paulo, como Date UTC à meia-noite. */
function diaLocal(d: Date): Date {
  const s = d.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }); // AAAA-MM-DD
  return new Date(`${s}T00:00:00Z`);
}

function carimbo(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function mascarar(destino: string | null): string {
  if (!destino) return "-";
  return destino.includes("@") ? mascararEmail(destino) : mascararTelefone(destino);
}

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

function localizarPresenca(config: NotificacoesConfig, opcoes: Opcoes): string {
  if (opcoes.csv) {
    if (!fs.existsSync(opcoes.csv)) throw new Error(`CSV não encontrado: ${opcoes.csv}`);
    return opcoes.csv;
  }
  const dir = path.resolve(config.dataDirectory, config.fontePresenca);
  const arquivo = localizarCsvMaisRecente(dir, config.fontePresenca);
  if (!arquivo) {
    throw new Error(`Nenhum CSV de presença em ${dir}. Rode antes: npm run collect:presente-alunos`);
  }
  return arquivo;
}

function validarModelos(config: NotificacoesConfig): void {
  for (const [nome, texto] of Object.entries(config.modelos)) {
    const desconhecidas = variaveisDesconhecidas(texto);
    if (desconhecidas.length > 0) {
      throw new Error(`Modelo "${nome}" usa variáveis desconhecidas: ${desconhecidas.map((v) => `{${v}}`).join(", ")}`);
    }
  }
  const params = config.whatsappCloud.template?.parametros ?? [];
  const invalidos = params.filter((p) => variaveisDesconhecidas(`{${p}}`).length > 0);
  if (invalidos.length > 0) throw new Error(`whatsappCloud.template.parametros inválidos: ${invalidos.join(", ")}`);
}

async function gerarModeloContatos(
  alunos: AlunoFrequencia[],
  contatosExistentes: Set<string>,
  config: NotificacoesConfig
): Promise<void> {
  const pendentes = alunos.filter((a) => !contatosExistentes.has(a.cgm));
  const destino = path.resolve(path.dirname(config.contatosCsv), "contatos_pendentes.csv");
  await mkdir(path.dirname(destino), { recursive: true });
  const linhas = pendentes
    .sort((a, b) => (a.turmas[0] ?? "").localeCompare(b.turmas[0] ?? "") || a.nome.localeCompare(b.nome))
    .map((a) => [a.cgm, a.nome, a.turmas.join(" / "), "", "", "", ""]);
  await writeFile(
    destino,
    paraCsv(["cgm", "aluno", "turma", "responsavel", "telefone", "email", "consentimento"], linhas, ";"),
    "utf8"
  );
  console.log(`${pendentes.length} de ${alunos.length} alunos sem contato cadastrado.`);
  console.log(`Planilha para preencher: ${destino}`);
  console.log(`Depois de preencher, copie as linhas para ${path.resolve(config.contatosCsv)}.`);
  console.log(`Na coluna "consentimento" use "sim" apenas para quem autorizou receber mensagens.`);
}

/**
 * Grava a prévia em previa-latest.csv (sobrescrita a cada execução, para não
 * acumular cópias de dados pessoais). Envios reais guardam também uma cópia
 * com data/hora, como registro do que foi enviado.
 */
async function salvarPrevia(
  plano: Plano,
  config: NotificacoesConfig,
  semana: SemanaReferencia,
  manterCopia: boolean
): Promise<string> {
  const dir = path.resolve(config.saidaDirectory);
  await mkdir(dir, { recursive: true });
  const arquivo = path.join(dir, "previa-latest.csv");
  const linhas = plano.itens.map((i) => [
    i.status,
    i.tipo,
    i.aluno.cgm,
    i.aluno.nome,
    i.valores.turma,
    formatarPercentual(i.presencaSemana),
    formatarPercentual(i.aluno.presencaGeral, 1),
    i.contato?.responsavel ?? "",
    i.destino ?? "",
    i.texto
  ]);
  await writeFile(
    arquivo,
    paraCsv(
      ["status", "tipo", "cgm", "aluno", "turma", `presença semana ${semana.rotulo}`, "presença geral", "responsável", "destino", "mensagem"],
      linhas,
      ";"
    ),
    "utf8"
  );
  if (manterCopia) fs.copyFileSync(arquivo, path.join(dir, `${carimbo()}-enviados.csv`));
  return arquivo;
}

function contar(itens: ItemPlano[], status: ItemPlano["status"]): number {
  return itens.filter((i) => i.status === status).length;
}

function imprimirResumo(plano: Plano, semana: SemanaReferencia, canal: Canal, arquivoCsv: string): void {
  const alunosComFalta = new Set(plano.itens.map((i) => i.aluno.cgm)).size;
  const criticos = new Set(plano.itens.filter((i) => i.tipo === "critica").map((i) => i.aluno.cgm)).size;
  console.log(`\nFonte: ${arquivoCsv}`);
  console.log(`Semana de referência: ${semana.rotulo} (${semana.chave}) · canal: ${canal}`);
  console.log(`Alunos lidos: ${plano.totalAlunos}`);
  console.log(`Alunos com falta: ${alunosComFalta} (${criticos} com frequência geral crítica)`);
  console.log(`  ignorados — presença ok: ${plano.ignorados["presenca-ok"]}, amparo legal: ${plano.ignorados["amparo-legal"]}, ` +
    `sem dado: ${plano.ignorados["sem-dado-semana"]}, não matriculado: ${plano.ignorados["nao-matriculado"]}, ` +
    `acima da idade: ${plano.ignorados["acima-idade-maxima"]}`);
  console.log(`Mensagens prontas: ${contar(plano.itens, "pronto")}`);
  console.log(`  já avisados nesta semana: ${contar(plano.itens, "ja-notificado")}`);
  console.log(`  sem contato cadastrado: ${contar(plano.itens, "sem-contato")}`);
  console.log(`  sem consentimento: ${contar(plano.itens, "sem-consentimento")}`);
  console.log(`  contato sem ${canal === "smtp" ? "e-mail" : "telefone"}: ${contar(plano.itens, "sem-destino-no-canal")}`);
}

async function main(): Promise<number> {
  const opcoes = lerArgs(process.argv.slice(2));
  if (opcoes.comando === "ajuda") {
    console.log(AJUDA);
    return 0;
  }
  carregarEnv();
  const config = await carregarConfigNotificacoes(opcoes.config);
  validarModelos(config);

  if (config.canal === "whatsapp-cloud" && !config.whatsappCloud.template) {
    console.warn(
      "Atenção: sem whatsappCloud.template, a Meta só entrega avisos a quem mandou mensagem para a escola nas últimas 24h. " +
        "Cadastre e aprove um template de mensagem para os avisos de falta."
    );
  }
  const arquivoCsv = localizarPresenca(config, opcoes);
  const mtime = fs.statSync(arquivoCsv).mtime;
  const dataColeta = opcoes.dataColeta ? new Date(`${opcoes.dataColeta}T00:00:00Z`) : diaLocal(mtime);
  if (Number.isNaN(dataColeta.getTime())) throw new Error("--data-coleta inválida; use AAAA-MM-DD.");
  const semana = semanaDeReferencia(dataColeta, config.regras.semanaReferencia);

  let alunos = lerPresencaArquivo(arquivoCsv);
  if (opcoes.cadastros && opcoes.execute) {
    throw new Error("--cadastros serve só para prévia; envios reais usam a base configurada.");
  }
  const { contatos, avisos, origem } = carregarContatos(config, opcoes.cadastros);
  console.log(
    `Contatos (${config.fonteContatos}): ${origem.cadastros} cadastrados pelo WhatsApp, ${origem.planilha} da planilha.`
  );
  for (const a of avisos.slice(0, 20)) console.warn(`[contatos] ${a}`);
  if (avisos.length > 20) console.warn(`[contatos] … e mais ${avisos.length - 20} avisos.`);

  if (opcoes.comando === "modelo-contatos") {
    await gerarModeloContatos(alunos, new Set(contatos.keys()), config);
    return 0;
  }

  if (opcoes.cgm) {
    alunos = alunos.filter((a) => a.cgm === opcoes.cgm!.replace(/\D/g, "").replace(/^0+/, ""));
    if (alunos.length === 0) throw new Error(`CGM ${opcoes.cgm} não está no CSV de presença.`);
  }

  // Na prévia o canal só define qual dado (telefone/e-mail) seria usado.
  const historico = HistoricoEnvios.carregar(config.saidaDirectory);
  const plano = planejar(alunos, contatos, config, semana, config.canal, historico);
  const previa = await salvarPrevia(plano, config, semana, opcoes.execute && !opcoes.destinoTeste);
  imprimirResumo(plano, semana, config.canal, arquivoCsv);
  console.log(`\nPrévia completa (abre no Excel): ${previa}`);

  const prontos = plano.itens.filter((i) => i.status === "pronto");
  for (const i of prontos.slice(0, 5)) {
    console.log(`\n→ ${mascarar(i.destino)} · ${i.valores.aluno} (${i.tipo})\n  ${i.texto}`);
  }
  if (prontos.length > 5) console.log(`\n… e mais ${prontos.length - 5} mensagens (veja a prévia).`);

  if (!opcoes.execute) {
    console.log(`\nNada foi enviado. Para enviar: npm run notificar -- --execute`);
    return 0;
  }

  // ---------- Envio ----------
  let destinoTeste: string | null = null;
  if (opcoes.destinoTeste) {
    destinoTeste = config.canal === "smtp" ? emailValido(opcoes.destinoTeste) : normalizarTelefone(opcoes.destinoTeste);
    if (!destinoTeste) throw new Error(`--destino-teste inválido para o canal ${config.canal}.`);
  } else {
    const idadeHoras = (Date.now() - mtime.getTime()) / 3_600_000;
    if (idadeHoras > config.maxIdadeDadosHoras) {
      throw new Error(
        `O CSV de presença tem ${Math.round(idadeHoras)}h (máximo ${config.maxIdadeDadosHoras}h). ` +
          `Rode a coleta antes de enviar, para não avisar faltas desatualizadas.`
      );
    }
  }

  const limite = Math.min(destinoTeste ? 3 : config.maxEnviosPorExecucao, opcoes.limite ?? Number.POSITIVE_INFINITY);
  const fila = (destinoTeste ? plano.itens.filter((i) => i.status !== "sem-contato") : prontos).slice(0, limite);
  if (fila.length === 0) {
    console.log("\nNenhuma mensagem pendente para enviar.");
    return 0;
  }

  const sender = criarSender(config);
  const runId = randomUUID();
  let enviados = 0;
  let falhas = 0;
  let falhasSeguidas = 0;
  console.log(`\nEnviando ${fila.length} mensagem(ns) via ${sender.canal}${destinoTeste ? ` (TESTE → ${mascarar(destinoTeste)})` : ""}…`);

  for (const [n, item] of fila.entries()) {
    const destino = destinoTeste ?? item.destino!;
    let status: StatusEnvio;
    let erro: string | undefined;
    let idMensagem: string | undefined;
    try {
      const r = await sender.enviar({
        destino,
        assunto: item.assunto,
        texto: item.texto,
        valores: item.valores,
        cgm: item.aluno.cgm,
        tipo: item.tipo
      });
      idMensagem = r.idMensagem;
      status = destinoTeste ? "teste" : sender.canal === "dry-run" ? "simulado" : "enviado";
      enviados += 1;
      falhasSeguidas = 0;
    } catch (e) {
      status = "falhou";
      erro = e instanceof Error ? e.message.slice(0, 300) : String(e);
      falhas += 1;
      falhasSeguidas += 1;
    }
    await historico.registrar({
      timestamp: new Date().toISOString(),
      runId,
      cgm: item.aluno.cgm,
      destinoHash: hashDestino(destino),
      canal: sender.canal,
      tipo: item.tipo,
      semana: semana.chave,
      status,
      ...(idMensagem ? { idMensagem } : {}),
      ...(erro ? { erro } : {})
    });
    console.log(`[${n + 1}/${fila.length}] ${status.padEnd(8)} ${mascarar(destino)} · CGM ${item.aluno.cgm}${erro ? ` · ${erro}` : ""}`);

    if (falhasSeguidas >= 5) {
      console.error("\n5 falhas seguidas — interrompendo (verifique token, saldo ou configuração do canal).");
      break;
    }
    if (n < fila.length - 1 && config.intervaloEntreEnviosMs > 0) await dormir(config.intervaloEntreEnviosMs);
  }

  await mkdir(path.resolve(config.saidaDirectory), { recursive: true });
  await appendFile(
    path.resolve(config.saidaDirectory, "execucoes.jsonl"),
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      runId,
      canal: sender.canal,
      teste: destinoTeste !== null,
      semana: semana.chave,
      fonte: path.basename(arquivoCsv),
      alunosLidos: plano.totalAlunos,
      prontos: prontos.length,
      enviados,
      falhas,
      pendentesSemContato: contar(plano.itens, "sem-contato")
    })}\n`,
    "utf8"
  );
  console.log(`\nConcluído: ${enviados} enviada(s), ${falhas} falha(s).`);
  if (falhas > 0) console.log("As falhas serão tentadas de novo na próxima execução.");
  return falhas > 0 ? 2 : 0;
}

main()
  .then((codigo) => process.exit(codigo))
  .catch((e) => {
    console.error(`Erro: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
