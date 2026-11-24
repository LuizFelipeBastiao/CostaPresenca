import fs from "node:fs";
import path from "node:path";
import { dataLocal } from "./datas.js";
import { randomUUID } from "node:crypto";
import { loadConfig, getReport } from "./config.js";
import { launchAuthorizedContext } from "./browser.js";
import { assertAllowedUrl, assertExpectedPage, saveErrorDiagnostic } from "./safety.js";
import { appendAudit } from "./storage.js";
import {
  applyConfiguredFilters,
  canonico,
  clickBookmarkButton,
  tryDismissMicrosoftPopups,
  unlockBookmarkAndScope
} from "./powerbi/filters.js";
import { decodeDsrPayload, type DsrTableResult } from "./powerbi/dsr-decoder.js";
import { aguardarCapturas } from "./powerbi/network-interceptor.js";
import { buscarJanelasRestantes, herdarSchema, juntarTabelas, type ConsultaCapturada } from "./powerbi/paginacao.js";

/**
 * Última garantia de escopo: se a tabela tiver uma coluna de escola, mantém só as linhas
 * da escola configurada, mesmo que algum filtro da tela não tenha sido aplicado.
 */
export function filtrarPelaEscola(tabela: DsrTableResult, escolaNome: string): DsrTableResult {
  const exata = tabela.headers.findIndex((h) => canonico(h) === "ESCOLA");
  const coluna = exata >= 0 ? exata : tabela.headers.findIndex((h) => canonico(h).includes("ESCOLA"));
  if (coluna < 0) return tabela;

  const alvo = canonico(escolaNome);
  const rows = tabela.rows.filter((r) => canonico(r.cells[coluna] ?? "").includes(alvo));
  if (rows.length === 0) {
    throw new Error(
      `Nenhuma linha da escola "${escolaNome}" na tabela capturada (${tabela.rows.length} linhas de outras escolas).`
    );
  }
  if (rows.length < tabela.rows.length) {
    console.warn(`[AVISO] Removidas ${tabela.rows.length - rows.length} linha(s) de outras escolas.`);
  }
  return { headers: tabela.headers, rows };
}

/** Espera até passar `silencioMs` sem nenhuma consulta nova do Power BI (ou até `timeoutMs`). */
async function esperarSilencio(
  page: import("playwright").Page,
  ultima: () => number,
  { silencioMs, timeoutMs }: { silencioMs: number; timeoutMs: number }
): Promise<void> {
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs && Date.now() - ultima() < silencioMs) {
    await page.waitForTimeout(250);
  }
}

/** As consultas reenviadas só podem ir para o serviço de dados do próprio Power BI. */
function assertHostDeConsulta(url: string): void {
  const u = new URL(url);
  const host = u.hostname.toLowerCase();
  // *.pbidedicated.windows.net: capacidade Premium/Fabric da SEED, que atende a consulta em alguns computadores.
  const permitido =
    host.endsWith(".analysis.windows.net") ||
    host.endsWith(".pbidedicated.windows.net") ||
    host === "app.powerbi.com" ||
    host.endsWith(".powerbi.com");
  if (u.protocol !== "https:" || !permitido) {
    throw new Error(`Consulta do Power BI para um endereço inesperado (${host}); a paginação foi interrompida.`);
  }
}

export async function extractPresenteAlunos(): Promise<{
  totalAlunos: number;
  csvPath: string;
  jsonPath: string;
}> {
  const config = await loadConfig();
  const report = getReport(config, "presente-estadual");
  assertAllowedUrl(report.url, config.allowedHosts);

  const runId = randomUUID();
  await appendAudit(config.outputDirectory, {
    timestamp: new Date().toISOString(),
    runId,
    reportId: "presente-alunos-turma",
    status: "started"
  });

  const context = await launchAuthorizedContext(config, { blockServiceWorkers: false });
  const page = (await context.pages())[0] ?? (await context.newPage());

  const capturedAlunoPayloads: any[] = [];
  // Pedido que gerou cada payload acima (mesmo índice): é reenviado para buscar as janelas seguintes.
  const capturedAlunoConsultas: ConsultaCapturada[] = [];
  // Momento da última consulta do Power BI: serve para saber quando o relatório parou de carregar.
  let ultimaConsulta = Date.now();
  const onResponse = async (response: import("playwright").Response) => {
    const url = response.url();
    if (
      (url.includes("QueryExecutionService") || url.includes("public/query") || url.includes("querydata")) &&
      response.request().method() === "POST"
    ) {
      ultimaConsulta = Date.now();
      try {
        const json = await response.json();
        const bodyStr = JSON.stringify(json);
        if (bodyStr.includes("NomeAluno") && bodyStr.includes("cgm")) {
          const request = response.request();
          const consulta: ConsultaCapturada = {
            url,
            corpo: request.postData() ?? "",
            headers: await request.allHeaders()
          };
          capturedAlunoPayloads.push(json);
          capturedAlunoConsultas.push(consulta);
        }
      } catch {}
    }
  };

  page.on("response", onResponse);

  try {
    console.log(`[1/4] Navegando para 2026 Presente Estadual...`);
    await page.goto(report.url, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await tryDismissMicrosoftPopups(page);
    await page.waitForTimeout(config.settleMs);
    await assertExpectedPage(page, report.name, config.allowedHosts);

    if (report.filters.length > 0) {
      console.log(`[2/4] Aplicando ${report.filters.length} filtro(s) configurado(s)...`);
      await applyConfiguredFilters(page, report);
      await page.waitForTimeout(config.settleMs);
    } else {
      console.log(`[2/4] Nenhum filtro extra configurado para este relatório.`);
    }

    // Clicar no TURMA enquanto o relatório ainda carrega não tem efeito: o Power BI termina de
    // aplicar a visão padrão (REDE) por cima. Espera as consultas iniciais pararem antes.
    console.log(`[3/4] Aguardando o relatório terminar de carregar...`);
    await esperarSilencio(page, () => ultimaConsulta, { silencioMs: 5_000, timeoutMs: 90_000 });

    let turmaCarregou = false;
    for (let tentativa = 1; tentativa <= 3 && !turmaCarregou; tentativa += 1) {
      console.log(`[3/4] Clicando no botão TURMA (tentativa ${tentativa}/3)...`);
      capturedAlunoPayloads.length = 0;
      capturedAlunoConsultas.length = 0;
      if (!(await clickBookmarkButton(page, "TURMA"))) {
        throw new Error('Botão "TURMA" não encontrado no relatório Presente Estadual.');
      }
      // A visão TURMA dispara uma consulta com NomeAluno/cgm; sem ela, o clique não pegou.
      const limite = Date.now() + 25_000;
      while (Date.now() < limite && capturedAlunoPayloads.length === 0) await page.waitForTimeout(500);
      turmaCarregou = capturedAlunoPayloads.length > 0;
      if (!turmaCarregou) {
        console.warn(`[AVISO] A visão TURMA não carregou a lista de alunos; tentando de novo.`);
        await esperarSilencio(page, () => ultimaConsulta, { silencioMs: 3_000, timeoutMs: 30_000 });
      }
    }
    await page.waitForTimeout(config.settleMs);

    // O bookmark TURMA pode trazer filtros próprios; o escopo vem depois dele (como no Pré-Conselho).
    console.log(`[3/4] Aplicando escopo institucional (${config.context.nre} / ${config.context.escolaNome})...`);
    await unlockBookmarkAndScope(page, config.context);

    console.log(`[4/4] Aguardando interceptação da tabela nominal com CGM...`);
    // O escopo dispara consultas novas; só a última, já filtrada pela escola, vale.
    await esperarSilencio(page, () => ultimaConsulta, { silencioMs: 5_000, timeoutMs: 60_000 });
    await aguardarCapturas(page, capturedAlunoPayloads, { timeoutMs: 30_000, silencioMs: 4_000 });

    if (capturedAlunoPayloads.length === 0) {
      throw new Error("Nenhum payload analítico de alunos foi interceptado na resposta da aba TURMA.");
    }

    // A última resposta reflete o estado final dos filtros. Ela traz só a primeira janela
    // (~500 linhas); as seguintes são pedidas reenviando a mesma consulta com o token de continuação.
    const ultima = capturedAlunoPayloads.length - 1;
    const primeiraJanela = capturedAlunoPayloads[ultima]!;
    const consulta = capturedAlunoConsultas[ultima];
    let janelas: unknown[] = [primeiraJanela];
    if (consulta) {
      assertHostDeConsulta(consulta.url);
      janelas = await buscarJanelasRestantes(primeiraJanela, consulta, async (url, headers, corpo) => {
        const resposta = await page.request.post(url, { headers, data: corpo, timeout: 90_000 });
        if (!resposta.ok()) throw new Error(`O Power BI recusou a janela seguinte da lista (HTTP ${resposta.status()}).`);
        return resposta.json();
      });
      if (janelas.length > 1) console.log(`[4/4] Lista de alunos recebida em ${janelas.length} partes.`);
    } else if (JSON.stringify(primeiraJanela).includes('"IC":false')) {
      throw new Error("A lista de alunos veio incompleta e o pedido original não foi capturado para buscar o restante.");
    }
    const bestPayload = janelas.length === 1 ? primeiraJanela : janelas;
    const decoded = filtrarPelaEscola(
      juntarTabelas(janelas.map((j, i) => decodeDsrPayload(i === 0 ? j : herdarSchema(j, primeiraJanela)))),
      config.context.escolaNome
    );

    const outDir = path.join(config.outputDirectory, "presente-alunos");
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const jsonPath = path.join(outDir, `${timestamp}-presente-alunos.json`);
    const csvPath = path.join(outDir, `${timestamp}-presente-alunos.csv`);
    const latestCsvPath = path.join(outDir, `presente-alunos-latest.csv`);

    fs.writeFileSync(jsonPath, JSON.stringify(bestPayload, null, 2), "utf8");

    const csvLines = [
      decoded.headers.map(h => `"${h.replace(/"/g, '""')}"`).join(","),
      ...decoded.rows.map(r => r.cells.map(c => `"${c.replace(/"/g, '""')}"`).join(","))
    ];
    const csvContent = csvLines.join("\n");
    fs.writeFileSync(csvPath, csvContent, "utf8");
    fs.writeFileSync(latestCsvPath, csvContent, "utf8");

    // Partição histórica diária
    const dateFolder = dataLocal();
    const dailyHistoryDir = path.resolve(config.outputDirectory, "historico", dateFolder);
    if (!fs.existsSync(dailyHistoryDir)) fs.mkdirSync(dailyHistoryDir, { recursive: true });
    fs.writeFileSync(path.join(dailyHistoryDir, "presente-alunos.csv"), csvContent, "utf8");
    fs.writeFileSync(path.join(dailyHistoryDir, "presente-alunos.json"), JSON.stringify(bestPayload, null, 2), "utf8");

    await appendAudit(config.outputDirectory, {
      timestamp: new Date().toISOString(),
      runId,
      reportId: "presente-alunos-turma",
      status: "completed",
      rowCount: decoded.rows.length,
      columnCount: decoded.headers.length
    });

    console.log(`[SUCESSO] Lista nominal de estudantes e presenças salva com êxito:`);
    console.log(` - Alunos nominais: ${decoded.rows.length}`);
    console.log(` - Colunas capturadas: ${decoded.headers.length}`);
    console.log(` - Arquivo CSV: ${csvPath}`);
    console.log(` - Arquivo Latest: ${latestCsvPath}`);

    return {
      totalAlunos: decoded.rows.length,
      csvPath,
      jsonPath
    };
  } catch (error) {
    await saveErrorDiagnostic(page, error, config.artifactDirectory);
    await appendAudit(config.outputDirectory, {
      timestamp: new Date().toISOString(),
      runId,
      reportId: "presente-alunos-turma",
      status: "failed",
      errorCode: error instanceof Error ? error.name : "UnknownError"
    });
    throw error;
  } finally {
    page.off("response", onResponse);
    await context.close();
  }
}

if (process.argv[1]?.includes("extract-presente-alunos")) {
  extractPresenteAlunos()
    .then((res) => {
      console.log(`Concluído com êxito: ${res.totalAlunos} estudantes com dados nominais e CGM.`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(`Falha na extração de presença nominal:`, err);
      process.exit(1);
    });
}
