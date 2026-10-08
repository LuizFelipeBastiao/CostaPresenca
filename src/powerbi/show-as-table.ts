import type { Locator, Page } from "playwright";
import type { AppConfig, ReportConfig } from "../config.js";
import { exactSafeMenuAction, assertExpectedPage } from "../safety.js";

async function locateVisual(page: Page, anchorText: string): Promise<Locator> {
  const anchor = page.getByText(anchorText, { exact: true }).filter({ visible: true });
  try {
    await anchor.first().waitFor({ state: "visible", timeout: 120_000 });
  } catch {
    throw new Error(`Ancora do visual nao apareceu apos o carregamento: ${anchorText}`);
  }
  if ((await anchor.count()) !== 1) {
    throw new Error(`Ancora do visual nao e unica ou nao esta visivel: ${anchorText}`);
  }

  const visual = anchor.locator(
    "xpath=ancestor::*[@data-automation-type='visualContainer' or @data-testid='visual-container' or self::visual-container][1]"
  );
  if ((await visual.count()) !== 1) {
    throw new Error(`Container do visual nao encontrado pela ancora: ${anchorText}`);
  }
  return visual;
}

export async function openVisualAsTable(
  page: Page,
  app: AppConfig,
  report: ReportConfig
): Promise<void> {
  await assertExpectedPage(page, report.name, app.allowedHosts);
  const anchorText = report.visualAnchorText ?? report.visualTitle;
  const visual = await locateVisual(page, anchorText);
  await visual.scrollIntoViewIfNeeded();

  // Clica na propria ancora conhecida, sem coordenadas e sem selecionar dados.
  await visual.getByText(anchorText, { exact: true }).filter({ visible: true }).click({ button: "right" });
  const showAsTable = await exactSafeMenuAction(page, "Mostrar como uma tabela");
  await showAsTable.click();

  await page.waitForTimeout(app.settleMs);
  await page.getByText("Voltar ao relatório", { exact: true }).filter({ visible: true }).waitFor({
    state: "visible",
    timeout: 30_000
  });
}
