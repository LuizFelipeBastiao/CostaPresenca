import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig, getReport } from "./config.js";
import { launchAuthorizedContext } from "./browser.js";
import { assertAllowedUrl, assertExpectedPage, saveErrorDiagnostic } from "./safety.js";
import { appendAudit } from "./storage.js";
import { applyConfiguredFilters, clickBookmarkButton, tryDismissMicrosoftPopups } from "./powerbi/filters.js";
import { decodeDsrPayload } from "./powerbi/dsr-decoder.js";

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
  const onResponse = async (response: import("playwright").Response) => {
    const url = response.url();
    if (
      (url.includes("QueryExecutionService") || url.includes("public/query") || url.includes("querydata")) &&
      response.request().method() === "POST"
    ) {
      try {
        const json = await response.json();
        const bodyStr = JSON.stringify(json);
        if (bodyStr.includes("NomeAluno") && bodyStr.includes("cgm")) {
          capturedAlunoPayloads.push(json);
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

    console.log(`[2/4] Aplicando escopo de NRE (FOZ DO IGUACU)...`);
    await applyConfiguredFilters(page, report);
    await page.waitForTimeout(4_000);

    console.log(`[3/4] Clicando no botão analítico TURMA dinamicamente...`);
    capturedAlunoPayloads.length = 0;
    await clickBookmarkButton(page, "TURMA");

    console.log(`[4/4] Aguardando interceptação da tabela nominal com CGM...`);
    await page.waitForTimeout(10_000);

    if (capturedAlunoPayloads.length === 0) {
      throw new Error("Nenhum payload analítico de alunos foi interceptado na resposta da aba TURMA.");
    }

    // Decodifica a tabela
    const bestPayload = capturedAlunoPayloads[capturedAlunoPayloads.length - 1]!;
    const decoded = decodeDsrPayload(bestPayload);

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
    const dateFolder = new Date().toISOString().slice(0, 10);
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
