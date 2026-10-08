import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { loadNotificacaoConfig } from "./notificacoes/config.js";
import { parseCsv, toCsv } from "./notificacoes/csv.js";
import { detectarFaltas, diasEntre, lerSnapshot, type FaltaDetectada } from "./notificacoes/faltas.js";
import { lerContatos, type ContatoResponsavel } from "./notificacoes/contatos.js";
import { renderizarMensagem, variaveisMensagem } from "./notificacoes/mensagem.js";
import { criarCanal } from "./notificacoes/canais.js";

const ARQUIVO_PRESENCA = "presente-alunos.csv";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/** Datas (YYYY-MM-DD) em data/historico que possuem a lista nominal de presença, em ordem crescente. */
async function datasComPresenca(dataDirectory: string): Promise<string[]> {
  const historico = path.resolve(dataDirectory, "historico");
  if (!existsSync(historico)) return [];
  const pastas = await readdir(historico);
  return pastas
    .filter((p) => /^\d{4}-\d{2}-\d{2}$/.test(p) && existsSync(path.join(historico, p, ARQUIVO_PRESENCA)))
    .sort();
}

function chaveEnvio(data: string, cgm: string, contato: ContatoResponsavel): string {
  const destino = contato.telefone ?? contato.email ?? "";
  // O registro guarda só um hash do destino, não o telefone/e-mail.
  return `${data}|${cgm}|${createHash("sha256").update(destino).digest("hex").slice(0, 16)}`;
}

async function lerEnviosConcluidos(arquivo: string): Promise<Set<string>> {
  if (!existsSync(arquivo)) return new Set();
  const linhas = (await readFile(arquivo, "utf8")).split("\n").filter(Boolean);
  const chaves = new Set<string>();
  for (const linha of linhas) {
    const registro = JSON.parse(linha) as { chave: string; status: string };
    if (registro.status === "enviado") chaves.add(registro.chave);
  }
  return chaves;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const config = await loadNotificacaoConfig(argument("--config"));
  const enviarDeVerdade = process.argv.includes("--enviar");
  const historico = path.resolve(config.dataDirectory, "historico");

  // 1. Seleciona as duas coletas a comparar
  const datas = await datasComPresenca(config.dataDirectory);
  const dataAtual = argument("--data") ?? datas.at(-1);
  if (!dataAtual || !datas.includes(dataAtual)) {
    throw new Error(`Nenhuma coleta de presenca encontrada em ${historico}${dataAtual ? ` para ${dataAtual}` : ""}`);
  }
  const dataAnterior = argument("--anterior") ?? datas.filter((d) => d < dataAtual).at(-1);
  if (!dataAnterior || !datas.includes(dataAnterior)) {
    console.log(`[INFO] Nao ha coleta anterior a ${dataAtual} para comparar. Nada a notificar.`);
    return;
  }
  const intervalo = diasEntre(dataAnterior, dataAtual);
  if (intervalo > config.maxDiasEntreColetas) {
    console.warn(
      `[AVISO] Coletas ${dataAnterior} e ${dataAtual} estao ${intervalo} dias distantes ` +
      `(limite: ${config.maxDiasEntreColetas}). Notificacao cancelada para evitar avisos tardios.`
    );
    return;
  }

  const lerColeta = async (data: string) =>
    lerSnapshot(data, parseCsv(await readFile(path.join(historico, data, ARQUIVO_PRESENCA), "utf8")), config.colunas);
  const anterior = await lerColeta(dataAnterior);
  const atual = await lerColeta(dataAtual);

  // 2. Detecta faltas
  const faltas = detectarFaltas(anterior, atual, config.toleranciaPercentual);
  console.log(`[1/3] Comparando ${dataAnterior} -> ${dataAtual}: ${atual.alunos.size} alunos, ${faltas.length} com falta registrada.`);

  // 3. Cruza com o cadastro de responsáveis
  const contatosPath = path.resolve(config.contatosCsv);
  if (!existsSync(contatosPath)) {
    throw new Error(`Cadastro de responsaveis nao encontrado: ${contatosPath} (veja config/contatos_responsaveis.example.csv)`);
  }
  const contatos = lerContatos(parseCsv(await readFile(contatosPath, "utf8")), config.contatosColunas, config.codigoPaisPadrao);
  const semContato = faltas.filter((f) => !contatos.has(f.cgm));
  console.log(`[2/3] ${faltas.length - semContato.length} aluno(s) com responsavel cadastrado; ${semContato.length} sem contato.`);

  // 4. Envia
  const saida = path.resolve(config.dataDirectory, "notificacoes", dataAtual);
  await mkdir(saida, { recursive: true });
  const canalConfig = enviarDeVerdade ? config.canal : { tipo: "simulacao" as const };
  const canal = criarCanal(canalConfig, saida);
  const registroPath = path.resolve(config.dataDirectory, "notificacoes", "registro-envios.jsonl");
  const concluidos = await lerEnviosConcluidos(registroPath);
  if (canal.nome === "simulacao") await writeFile(path.join(saida, "caixa-de-saida.jsonl"), "", "utf8");

  console.log(`[3/3] Enviando pelo canal "${canal.nome}"${enviarDeVerdade ? "" : " (use --enviar para envio real)"}...`);

  const relatorio: string[][] = [];
  const contagem = { enviado: 0, simulado: 0, "ja-enviado": 0, "sem-contato": 0, falha: 0 };
  const registrar = (falta: FaltaDetectada, status: keyof typeof contagem, detalhe = "") => {
    contagem[status]++;
    relatorio.push([
      falta.aluno, falta.cgm, falta.turma, falta.criterio,
      falta.novasFaltas !== undefined ? String(falta.novasFaltas) : "", status, detalhe
    ]);
  };

  for (const falta of faltas) {
    const destinos = contatos.get(falta.cgm);
    if (!destinos) {
      registrar(falta, "sem-contato");
      continue;
    }
    for (const contato of destinos) {
      const chave = chaveEnvio(dataAtual, falta.cgm, contato);
      if (concluidos.has(chave)) {
        registrar(falta, "ja-enviado");
        continue;
      }
      const variaveis = variaveisMensagem(falta, contato, config.escola, dataAtual);
      const texto = renderizarMensagem(config.mensagem, variaveis);
      try {
        await canal.enviar({ contato, texto, variaveis });
        if (canal.nome === "simulacao") {
          registrar(falta, "simulado");
        } else {
          registrar(falta, "enviado");
          await appendFile(registroPath, `${JSON.stringify({
            chave, cgm: falta.cgm, canal: canal.nome, status: "enviado", timestamp: new Date().toISOString()
          })}\n`, "utf8");
          if (config.intervaloEnvioMs > 0) await sleep(config.intervaloEnvioMs);
        }
      } catch (error) {
        const motivo = error instanceof Error ? error.message : String(error);
        registrar(falta, "falha", motivo);
        console.error(`[FALHA] CGM ${falta.cgm}: ${motivo}`);
      }
    }
  }

  const relatorioPath = path.join(saida, "faltas-notificadas.csv");
  await writeFile(
    relatorioPath,
    toCsv(["Aluno", "CGM", "Turma", "Criterio", "Novas Faltas", "Status", "Detalhe"], relatorio),
    "utf8"
  );

  console.log(`\n[RESUMO] ${JSON.stringify(contagem)}`);
  console.log(`- Relatorio: ${path.relative(process.cwd(), relatorioPath)}`);
  if (canal.nome === "simulacao") {
    console.log(`- Mensagens simuladas: ${path.relative(process.cwd(), path.join(saida, "caixa-de-saida.jsonl"))}`);
  }
  if (contagem.falha > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[ERRO] ${message}`);
  process.exitCode = 1;
});
