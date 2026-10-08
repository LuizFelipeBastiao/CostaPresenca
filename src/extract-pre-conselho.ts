import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig, getReport } from "./config.js";
import { launchAuthorizedContext } from "./browser.js";
import { assertAllowedUrl, assertExpectedPage, saveErrorDiagnostic } from "./safety.js";
import { appendAudit } from "./storage.js";
import { decodeMatrixDsrPayload } from "./powerbi/matrix-decoder.js";
import { clickBookmarkButton, unlockBookmarkAndScope, tryDismissMicrosoftPopups } from "./powerbi/filters.js";

export async function extractPreConselho(): Promise<{
  totalAlunos: number;
  totalLancamentos: number;
  csvPath: string;
  jsonPath: string;
}> {
  const config = await loadConfig();
  const report = getReport(config, "aprendizagem-parana");
  assertAllowedUrl(report.url, config.allowedHosts);

  const runId = randomUUID();
  await appendAudit(config.outputDirectory, {
    timestamp: new Date().toISOString(),
    runId,
    reportId: "pre-conselho-mapa",
    status: "started"
  });

  const context = await launchAuthorizedContext(config, { blockServiceWorkers: false });
  const page = (await context.pages())[0] ?? (await context.newPage());

  const capturedMatrixJson: any[] = [];
  const onResponse = async (response: import("playwright").Response) => {
    const url = response.url();
    if (
      (url.includes("QueryExecutionService") || url.includes("public/query") || url.includes("querydata")) &&
      response.request().method() === "POST"
    ) {
      try {
        const json = await response.json();
        const ds = json?.results?.[0]?.result?.data?.dsr?.DS?.[0];
        if (ds && ds.SH && ds.PH) {
          capturedMatrixJson.push(json);
        }
      } catch {}
    }
  };

  page.on("response", onResponse);

  try {
    console.log(`[1/5] Navegando para Aprendizagem Paraná...`);
    await page.goto(report.url, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await tryDismissMicrosoftPopups(page);
    await page.waitForTimeout(config.settleMs);
    await assertExpectedPage(page, report.name, config.allowedHosts);

    capturedMatrixJson.length = 0;
    console.log(`[2/4] Acessando aba MAPA dinamicamente...`);
    const clicked = await clickBookmarkButton(page, "MAPA");
    console.log(`[INFO] Botão MAPA acionado: ${clicked}`);
    await page.waitForTimeout(4_000);

    console.log(`[3/4] Aplicando escopo institucional dinâmico (${config.context.nre} / ${config.context.escolaNome})...`);
    await unlockBookmarkAndScope(page, config.context);

    console.log(`[4/4] Aguardando cálculo da matriz de estudantes e notas...`);
    for (let w = 0; w < 15; w++) {
      if (capturedMatrixJson.length > 0) break;
      await page.waitForTimeout(1_000);
    }

    if (capturedMatrixJson.length === 0) {
      throw new Error("Nenhum payload de matriz DSR foi capturado na rede.");
    }

    // Pega o maior payload DSR matricial capturado
    let bestMatrix = capturedMatrixJson[0];
    let maxAlunos = 0;
    for (const item of capturedMatrixJson) {
      try {
        const alCount = item.results[0].result.data.dsr.DS[0].PH[0]?.DM0?.length || 0;
        if (alCount > maxAlunos) {
          maxAlunos = alCount;
          bestMatrix = item;
        }
      } catch {}
    }

    const decoded = decodeMatrixDsrPayload(bestMatrix);
    const outDir = path.join(config.outputDirectory, "pre-conselho");
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const jsonPath = path.join(outDir, `${timestamp}-matriz-pre-conselho.json`);
    const csvPath = path.join(outDir, `${timestamp}-matriz-pre-conselho.csv`);
    const latestCsvPath = path.join(outDir, `matriz-pre-conselho-latest.csv`);

    // Serializa JSON
    fs.writeFileSync(jsonPath, JSON.stringify(decoded, null, 2), "utf8");

    // Serializa CSV
    const csvHeaders = ["Aluno", "CGM", "Disciplina", "1º Trimestre", "2º Trimestre", "3º Trimestre", "Total", "Status Pré-Conselho"];
    const csvLines = [
      csvHeaders.map(h => `"${h}"`).join(","),
      ...decoded.relacionalRows.map(r => {
        return [
          `"${r.aluno.replace(/"/g, '""')}"`,
          `"${r.cgm.replace(/"/g, '""')}"`,
          `"${r.disciplina.replace(/"/g, '""')}"`,
          r.tri1 !== null ? String(r.tri1) : "",
          r.tri2 !== null ? String(r.tri2) : "",
          r.tri3 !== null ? String(r.tri3) : "",
          r.total !== null ? String(r.total) : "",
          `"${r.status}"`
        ].join(",");
      })
    ];

    const csvContent = csvLines.join("\n");
    fs.writeFileSync(csvPath, csvContent, "utf8");
    fs.writeFileSync(latestCsvPath, csvContent, "utf8");

    // Partição histórica diária
    const dateFolder = new Date().toISOString().slice(0, 10);
    const dailyHistoryDir = path.resolve(config.outputDirectory, "historico", dateFolder);
    if (!fs.existsSync(dailyHistoryDir)) fs.mkdirSync(dailyHistoryDir, { recursive: true });
    fs.writeFileSync(path.join(dailyHistoryDir, "matriz-pre-conselho.csv"), csvContent, "utf8");
    fs.writeFileSync(path.join(dailyHistoryDir, "matriz-pre-conselho.json"), JSON.stringify(decoded, null, 2), "utf8");

    await appendAudit(config.outputDirectory, {
      timestamp: new Date().toISOString(),
      runId,
      reportId: "pre-conselho-mapa",
      status: "completed",
      rowCount: decoded.relacionalRows.length,
      columnCount: 8
    });

    console.log(`[SUCESSO] Matriz analítica do Pré-Conselho salva:`);
    console.log(` - Alunos: ${decoded.totalAlunos}`);
    console.log(` - Lançamentos Aluno x Disciplina: ${decoded.relacionalRows.length}`);
    console.log(` - Arquivo CSV: ${csvPath}`);
    console.log(` - Arquivo Latest: ${latestCsvPath}`);

    return {
      totalAlunos: decoded.totalAlunos,
      totalLancamentos: decoded.relacionalRows.length,
      csvPath,
      jsonPath
    };
  } catch (error) {
    await saveErrorDiagnostic(page, error, config.artifactDirectory);
    await appendAudit(config.outputDirectory, {
      timestamp: new Date().toISOString(),
      runId,
      reportId: "pre-conselho-mapa",
      status: "failed",
      errorCode: error instanceof Error ? error.name : "UnknownError"
    });
    throw error;
  } finally {
    page.off("response", onResponse);
    await context.close();
  }
}

// Execução direta via CLI
if (process.argv[1]?.includes("extract-pre-conselho")) {
  extractPreConselho()
    .then((res) => {
      console.log(`Concluído com êxito: ${res.totalLancamentos} notas processadas.`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(`Falha na extração do Pré-Conselho:`, err);
      process.exit(1);
    });
}
