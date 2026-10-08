import { createInterface } from "node:readline/promises";
import { randomUUID } from "node:crypto";
import process from "node:process";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { loadConfig, getReport } from "./config.js";
import { launchAuthorizedContext } from "./browser.js";
import { assertAllowedUrl, assertExpectedPage, saveErrorDiagnostic } from "./safety.js";
import { openVisualAsTable } from "./powerbi/show-as-table.js";
import { readVirtualizedTable } from "./powerbi/table-reader.js";
import { applyConfiguredFilters, tryDismissMicrosoftPopups } from "./powerbi/filters.js";
import { copySelectedRows } from "./powerbi/clipboard-reader.js";
import { validateTable } from "./validation.js";
import { appendAudit, saveTable } from "./storage.js";
import type { ExtractedTable } from "./types.js";
import { startNetworkProbe } from "./powerbi/network-probe.js";
import { createQueryInterceptor } from "./powerbi/network-interceptor.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function pause(message: string): Promise<void> {
  const input = createInterface({ input: process.stdin, output: process.stdout });
  await input.question(`${message}\nPressione ENTER para continuar... `);
  input.close();
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const config = await loadConfig(argument("--config"));
  const context = await launchAuthorizedContext(config, {
    blockServiceWorkers: false
  });
  const pages = context.pages();
  const page = pages[0] ?? await context.newPage();
  const networkProbe = command === "network-probe"
    ? await startNetworkProbe(context, config.artifactDirectory)
    : undefined;

  try {
    if (command === "login") {
      await page.goto("https://app.powerbi.com/", { waitUntil: "domcontentloaded" });
      await pause("Conclua o login institucional e o MFA no navegador. Nao informe a senha ao programa.");
      assertAllowedUrl(page.url(), config.allowedHosts);
      console.log("Sessao institucional reconhecida. O perfil local permanece fora do Git.");
      return;
    }

    if (command === "collect") {
      if (!process.argv.includes("--execute")) {
        throw new Error("Coleta bloqueada: confirme explicitamente com --execute");
      }

      const runAll = process.argv.includes("--all");
      const reportId = argument("--report");

      if (!runAll && !reportId) {
        throw new Error("Informe --report <id> ou --all para coletar todos os relatorios habilitados");
      }

      const targetReports = runAll
        ? config.reports.filter((r) => r.enabled)
        : [getReport(config, reportId!)];

      if (targetReports.length === 0) {
        throw new Error("Nenhum relatorio habilitado encontrado para coleta");
      }

      console.log(`[INICIO] Coletando ${targetReports.length} relatorio(s) habilitado(s)...`);
      const results: any[] = [];

      for (const report of targetReports) {
        console.log(`\n------------------------------------------------------------`);
        console.log(`[COLETANDO] "${report.name}" (${report.id})`);
        try {
          const res = await collectReport(page, config, report);
          results.push(res);
          console.log(JSON.stringify(res, null, 2));
        } catch (err: any) {
          console.error(`[FALHA] Erro ao coletar "${report.id}":`, err?.message || err);
          results.push({
            reportId: report.id,
            status: "failed",
            error: err?.message || String(err)
          });
          if (!runAll) throw err;
        }
      }

      console.log(`\n============================================================`);
      console.log(`[RESUMO FINAL] ${results.filter((r) => !r.error).length}/${results.length} coletados com sucesso.`);
      return;
    }

    const reportId = argument("--report");
    if (!reportId) throw new Error("Informe --report <id>");
    const report = getReport(config, reportId);
    assertAllowedUrl(report.url, config.allowedHosts);
    await page.goto(report.url, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await page.waitForTimeout(config.settleMs);
    await assertExpectedPage(page, report.name, config.allowedHosts);

    if (command === "inspect") {
      console.log(JSON.stringify({
        reportId: report.id,
        title: await page.title(),
        url: page.url(),
        visualTitleConfigured: report.visualTitle,
        enabled: report.enabled
      }, null, 2));
      await pause("Inspecao concluida. Confira visualmente o relatorio antes de fechar.");
      return;
    }

    if (command === "network-probe") {
      await applyConfiguredFilters(page, report);
      await page.waitForTimeout(config.settleMs);
      if (report.extractionMode === "dom" && report.domZoomSteps > 0) {
        await page.keyboard.press("Control+0");
        for (let step = 0; step < report.domZoomSteps; step += 1) {
          await page.keyboard.press("Control+-");
        }
        await page.waitForTimeout(config.settleMs);
      }
      await openVisualAsTable(page, config, report);
      await page.waitForTimeout(config.settleMs * 2);
      const result = await networkProbe!.stop();
      const candidates = result.entries.filter((entry) => entry.candidate);
      console.log(JSON.stringify({
        status: "completed",
        requests: result.entries.length,
        candidates: candidates.length,
        capturedBodies: candidates.filter((entry) => entry.bodyFile).length,
        manifestPath: path.relative(process.cwd(), result.manifestPath)
      }, null, 2));
      return;
    }

    throw new Error("Comando valido: login, inspect, network-probe ou collect");
  } finally {
    await context.close();
  }
}

async function collectReport(
  page: import("playwright").Page,
  config: import("./config.js").AppConfig,
  report: import("./config.js").ReportConfig
) {
  if (!report.enabled) throw new Error("Relatorio desabilitado na configuracao");
  assertAllowedUrl(report.url, config.allowedHosts);

  const runId = randomUUID();
  await appendAudit(config.outputDirectory, {
    timestamp: new Date().toISOString(), runId, reportId: report.id, status: "started"
  });

  try {
    let method: "clipboard" | "dom" | "network" = "dom";
    let data: { headers: string[]; rows: ExtractedTable["rows"] } | undefined;

    // Se o relatório não possui filtros, arma o interceptor ANTES da navegação
    // para capturar as consultas analíticas disparadas no carregamento inicial da página
    let interceptor: ReturnType<typeof createQueryInterceptor> | undefined;
    if (report.filters.length === 0 && (report.extractionMode === "network" || report.extractionMode === "auto")) {
      interceptor = createQueryInterceptor(page, {
        expectedColumns: report.expectedColumns,
        expectedRows: report.expectedDataRows,
        timeoutMs: 30_000
      });
    }

    await page.goto(report.url, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await tryDismissMicrosoftPopups(page);
    await page.waitForTimeout(config.settleMs);
    await assertExpectedPage(page, report.name, config.allowedHosts);

    // Se configurado seletor de pre-clique/portal (ex: botao para sair da tela inicial)
    if (report.preClickSelector) {
      console.log(`[INFO] [${report.id}] Acionando preClickSelector: "${report.preClickSelector}"`);
      await page.waitForSelector(report.preClickSelector, { timeout: 20_000 });
      await page.click(report.preClickSelector);
      await page.waitForTimeout(config.settleMs);
    }

    // Se possui filtros, aplica os filtros configurados
    if (report.filters.length > 0) {
      if (!interceptor && (report.extractionMode === "network" || report.extractionMode === "auto")) {
        interceptor = createQueryInterceptor(page, {
          expectedColumns: report.expectedColumns,
          expectedRows: report.expectedDataRows,
          timeoutMs: 30_000
        });
      }
      await applyConfiguredFilters(page, report);
      await page.waitForTimeout(config.settleMs);
    }

    // Se configurada ancora de visual e necessario, abre visual como tabela
    if (report.visualAnchorText) {
      await openVisualAsTable(page, config, report);
    }

    // Tenta obter dados da rede
    if (interceptor) {
      try {
        const networkData = await interceptor.waitForTable(20_000);
        data = networkData;
        method = "network";
        console.log(`[SUCESSO] [${report.id}] Dados capturados diretamente da rede (${data.rows.length} linhas, ${data.headers.length} colunas)`);
      } catch (networkError) {
        if (report.extractionMode === "network") throw networkError;
        const reason = networkError instanceof Error ? networkError.message : String(networkError);
        console.warn(`[AVISO] [${report.id}] Interceptacao de rede nao capturou a tabela; recorrendo a fallback: ${reason}`);
      } finally {
        interceptor.detach();
      }
    }

    // Fallbacks para DOM ou clipboard se a rede não capturou
    if (!data) {
      if (report.extractionMode === "dom" && report.domZoomSteps > 0) {
        await page.keyboard.press("Control+0");
        for (let step = 0; step < report.domZoomSteps; step += 1) {
          await page.keyboard.press("Control+-");
        }
        await page.waitForTimeout(config.settleMs);
      }

      if (report.extractionMode !== "dom") {
        try {
          data = await copySelectedRows(page, report.expectedDataRows);
          method = "clipboard";
        } catch (clipboardError) {
          if (report.extractionMode === "clipboard") throw clipboardError;
          const reason = clipboardError instanceof Error ? clipboardError.message : String(clipboardError);
          console.warn(`[AVISO] [${report.id}] Clipboard indisponivel; usando DOM: ${reason}`);
          data = await readVirtualizedTable(page, config.maxRows, config.maxScrolls, config.settleMs);
          method = "dom";
        }
      } else {
        data = await readVirtualizedTable(page, config.maxRows, config.maxScrolls, config.settleMs);
        method = "dom";
      }
    }

    const table: ExtractedTable = {
      ...data,
      source: {
        reportId: report.id,
        reportName: report.name,
        visualTitle: report.visualTitle,
        method,
        url: report.url,
        collectedAt: new Date().toISOString()
      }
    };
    validateTable(table, report.expectedColumns);
    const saved = await saveTable(config.outputDirectory, report.outputName, table);
    await appendAudit(config.outputDirectory, {
      timestamp: new Date().toISOString(), runId, reportId: report.id, status: "completed",
      rowCount: table.rows.length, columnCount: table.headers.length, contentHash: saved.hash
    });

    return {
      status: "completed",
      reportId: report.id,
      name: report.name,
      method,
      rows: table.rows.length,
      columns: table.headers.length,
      contentHash: saved.hash,
      jsonPath: path.relative(process.cwd(), saved.jsonPath),
      csvPath: path.relative(process.cwd(), saved.csvPath)
    };
  } catch (error) {
    await saveErrorDiagnostic(page, error, config.artifactDirectory);
    await mkdir(path.resolve(config.artifactDirectory), { recursive: true });
    if (config.diagnostics) {
      await page.screenshot({
        path: path.resolve(config.artifactDirectory, `${runId}.png`),
        fullPage: false
      });
    }
    await appendAudit(config.outputDirectory, {
      timestamp: new Date().toISOString(), runId, reportId: report.id, status: "failed",
      errorCode: error instanceof Error ? error.name : "UnknownError"
    });
    throw error;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[ERRO] ${message}`);
  process.exitCode = 1;
});
