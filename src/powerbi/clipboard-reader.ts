import type { Page } from "playwright";
import type { ExtractedRow } from "../types.js";
import { exactSafeMenuAction } from "../safety.js";
import { bestTableRoot } from "./table-reader.js";

export function parseClipboardTsv(raw: string): { headers: string[]; rows: ExtractedRow[] } {
  const lines = raw.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length < 2) throw new Error("Clipboard nao contem cabecalho e linhas de dados");
  const matrix = lines.map((line) => line.split("\t").map((cell) => cell.replace(/\u00a0/g, " ").trim()));
  const headers = matrix.shift() ?? [];
  if (headers.length < 2) throw new Error("Clipboard nao esta em formato TSV tabular");
  if (matrix.some((row) => row.length !== headers.length)) {
    throw new Error("Clipboard TSV possui linhas com larguras divergentes");
  }
  return { headers, rows: matrix.map((cells) => ({ cells })) };
}

export async function copySelectedRows(
  page: Page,
  configuredDataRows?: number
): Promise<{ headers: string[]; rows: ExtractedRow[] }> {
  const root = await bestTableRoot(page);
  const ariaRowCount = Number(await root.getAttribute("aria-rowcount"));
  const expectedDataRows = configuredDataRows ?? ariaRowCount - 2;
  if (!Number.isInteger(expectedDataRows) || expectedDataRows < 1) {
    throw new Error(`Nao foi possivel inferir linhas pelo aria-rowcount: ${ariaRowCount}`);
  }
  const firstRow = root.locator(".mid-viewport [role='row']").first();
  await firstRow.waitFor({ state: "visible", timeout: 30_000 });
  const firstCell = firstRow.locator("[role='gridcell'].cell-interactive").filter({ visible: true }).first();
  await firstCell.click();

  // Mantem Shift pressionado uma unica vez; metodo nativo auditado e resiliente.
  const selectionStartedAt = performance.now();
  await page.keyboard.down("Shift");
  try {
    for (let index = 1; index < expectedDataRows; index += 1) {
      await page.keyboard.press("ArrowDown");
    }
  } finally {
    await page.keyboard.up("Shift");
  }
  console.log(`[INFO] Selecao contigua: ${expectedDataRows} linhas em ${Math.round(performance.now() - selectionStartedAt)} ms`);

  await page.keyboard.press("Shift+F10");
  const copy = await exactSafeMenuAction(page, "Copiar");
  await copy.hover();
  await page.waitForTimeout(800);
  let copySelection;
  try {
    copySelection = await exactSafeMenuAction(page, "Copiar seleção");
  } catch {
    // Alguns relatórios só abrem o submenu após clique no item pai.
    await copy.click();
    await page.waitForTimeout(800);
    copySelection = await exactSafeMenuAction(page, "Copiar seleção");
  }
  await copySelection.click();

  const raw = await page.evaluate(async () => navigator.clipboard.readText());
  const parsed = parseClipboardTsv(raw);
  if (parsed.rows.length !== expectedDataRows) {
    throw new Error(`Clipboard incompleto: ${parsed.rows.length}/${expectedDataRows} linhas`);
  }
  return parsed;
}
