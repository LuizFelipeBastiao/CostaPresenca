import type { Locator, Page } from "playwright";
import type { ExtractedRow } from "../types.js";

function normalize(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").trim();
}

export async function bestTableRoot(page: Page): Promise<Locator> {
  const dialog = page.getByRole("dialog").filter({ visible: true }).last();
  const scope = (await dialog.count()) > 0 ? dialog : page.locator("body");
  const candidates = scope.locator("table, [role='grid'], [role='treegrid']");
  const count = await candidates.count();
  if (count === 0) throw new Error("Tabela acessivel nao encontrada");

  let best = candidates.first();
  let bestRows = -1;
  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index);
    const rows = await candidate.locator("tr, [role='row']").count();
    if (rows > bestRows) {
      bestRows = rows;
      best = candidate;
    }
  }
  return best;
}

async function visibleRows(root: Locator): Promise<string[][]> {
  return root.locator("tr, [role='row']").evaluateAll((nodes) =>
    nodes.map((node) => {
      const cells = Array.from(
        node.querySelectorAll("th, td, [role='columnheader'], [role='rowheader'], [role='gridcell']")
      );
      if (cells.length > 0) return cells.map((cell) => (cell.textContent ?? "").trim());
      return (node.textContent ?? "").split(/\t|\n/).map((text) => text.trim()).filter(Boolean);
    }).filter((cells) => cells.length > 0)
  );
}

async function advanceScroll(root: Locator): Promise<boolean> {
  return root.evaluate((element) => {
    const innerViewport = element.querySelector<HTMLElement>(".mid-viewport");
    let current: HTMLElement | null = innerViewport ?? element as HTMLElement;
    while (current) {
      if (current.scrollHeight > current.clientHeight + 2) {
        const before = current.scrollTop;
        current.scrollTop = Math.min(
          current.scrollHeight - current.clientHeight,
          before + Math.max(120, Math.floor(current.clientHeight * 0.8))
        );
        current.dispatchEvent(new Event("scroll", { bubbles: true }));
        return current.scrollTop > before;
      }
      current = current.parentElement;
    }
    return false;
  });
}

type IndexedMatrix = Map<number, Map<number, string>>;

async function resetVerticalScroll(root: Locator): Promise<void> {
  await root.evaluate((element) => {
    const viewport = element.querySelector<HTMLElement>(".mid-viewport");
    if (!viewport) return;
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
}

async function captureIndexed(root: Locator, matrix: IndexedMatrix): Promise<number> {
  const captured = await root.locator("[role='row'][aria-rowindex]").evaluateAll((rows) =>
    rows.map((row) => ({
      row: Number(row.getAttribute("aria-rowindex")),
      cells: Array.from(row.querySelectorAll<HTMLElement>(
        "[role='gridcell'][aria-colindex], [role='columnheader'][aria-colindex], [role='rowheader'][aria-colindex]"
      )).map((cell) => ({
        col: Number(cell.getAttribute("aria-colindex")),
        text: (() => {
          const clone = cell.cloneNode(true) as HTMLElement;
          clone.querySelectorAll(".visually-hidden, [aria-hidden='true'], label").forEach((node) => node.remove());
          const visibleText = clone.textContent?.trim() ?? "";
          if (visibleText) return visibleText;
          return cell.querySelector("svg[aria-label]")?.getAttribute("aria-label") ?? "";
        })()
      }))
    })).filter((row) => Number.isInteger(row.row) && row.cells.length > 0)
  );

  let additions = 0;
  for (const row of captured) {
    const target = matrix.get(row.row) ?? new Map<number, string>();
    matrix.set(row.row, target);
    for (const cell of row.cells) {
      if (!Number.isInteger(cell.col)) continue;
      const value = normalize(cell.text);
      if (!target.has(cell.col)) additions += 1;
      target.set(cell.col, value);
    }
  }
  return additions;
}

async function advanceHorizontal(root: Locator): Promise<boolean> {
  return root.evaluate((element) => {
    const scope = element.parentElement ?? element;
    const button = scope.querySelector<HTMLButtonElement>("button.scrollRight");
    if (!button || button.disabled) return false;
    button.click();
    return true;
  });
}

async function readIndexedTable(
  page: Page,
  root: Locator,
  maxRows: number,
  maxScrolls: number,
  settleMs: number
): Promise<{ headers: string[]; rows: ExtractedRow[] } | undefined> {
  const rowCount = Number(await root.getAttribute("aria-rowcount"));
  const colCount = Number(await root.getAttribute("aria-colcount"));
  if (!Number.isInteger(rowCount) || !Number.isInteger(colCount) || rowCount < 2 || colCount < 2) {
    return undefined;
  }

  const matrix: IndexedMatrix = new Map();
  let unchangedHorizontal = 0;
  const horizontalLimit = Math.min(colCount * 3, 200);

  for (let horizontal = 0; horizontal < horizontalLimit; horizontal += 1) {
    await resetVerticalScroll(root);
    await page.waitForTimeout(Math.min(settleMs, 500));
    let verticalUnchanged = 0;
    for (let vertical = 0; vertical < maxScrolls; vertical += 1) {
      const added = await captureIndexed(root, matrix);
      verticalUnchanged = added === 0 ? verticalUnchanged + 1 : 0;
      if (verticalUnchanged >= 2 || !(await advanceScroll(root))) break;
      await page.waitForTimeout(Math.min(settleMs, 500));
    }

    const before = [...matrix.values()].reduce((sum, cells) => sum + cells.size, 0);
    if (matrix.size >= rowCount && [...matrix.values()].every((cells) => cells.size >= colCount)) break;
    if (!(await advanceHorizontal(root))) break;
    await page.waitForTimeout(Math.min(settleMs, 500));
    await captureIndexed(root, matrix);
    const after = [...matrix.values()].reduce((sum, cells) => sum + cells.size, 0);
    unchangedHorizontal = after === before ? unchangedHorizontal + 1 : 0;
    if (unchangedHorizontal >= 3) break;
  }

  const headerCells = matrix.get(1);
  if (!headerCells) return undefined;
  const allColumns = [...headerCells.keys()].sort((a, b) => a - b);
  const selectedColumns = allColumns.filter((column) =>
    normalize(headerCells.get(column) ?? "").toLocaleLowerCase("pt-BR") !== "seleção de linha");
  const headers = selectedColumns.map((column) => normalize(headerCells.get(column) ?? ""));
  const rows = [...matrix.entries()]
    .filter(([row]) => row > 1 && row <= Math.min(rowCount, maxRows + 1))
    .sort(([left], [right]) => left - right)
    .map(([, cells]) => ({ cells: selectedColumns.map((column) => normalize(cells.get(column) ?? "")) }));

  const technicalColumns = allColumns.length - selectedColumns.length;
  if (allColumns.length < colCount || headers.length !== colCount - technicalColumns) {
    throw new Error(`DOM horizontal incompleto: ${allColumns.length}/${colCount} colunas logicas`);
  }
  if (rows.length === 0) throw new Error("DOM indexado nao retornou linhas");
  return { headers, rows };
}

export async function readVirtualizedTable(
  page: Page,
  maxRows: number,
  maxScrolls: number,
  settleMs: number
): Promise<{ headers: string[]; rows: ExtractedRow[] }> {
  const root = await bestTableRoot(page);
  const indexed = await readIndexedTable(page, root, maxRows, maxScrolls, settleMs);
  if (indexed) return indexed;
  const unique = new Map<string, string[]>();
  let unchanged = 0;

  for (let iteration = 0; iteration < maxScrolls && unique.size < maxRows; iteration += 1) {
    const before = unique.size;
    for (const rawCells of await visibleRows(root)) {
      const cells = rawCells.map(normalize);
      if (cells.some((cell) => cell.length > 0)) unique.set(JSON.stringify(cells), cells);
    }
    unchanged = unique.size === before ? unchanged + 1 : 0;
    if (unchanged >= 3 || !(await advanceScroll(root))) break;
    await page.waitForTimeout(Math.min(settleMs, 1_000));
  }

  const allRows = [...unique.values()].slice(0, maxRows);
  if (allRows.length === 0) throw new Error("A tabela foi aberta, mas nenhuma linha foi lida");
  const headers = allRows.shift() ?? [];
  return { headers, rows: allRows.map((cells) => ({ cells })) };
}
