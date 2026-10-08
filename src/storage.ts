import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AuditEvent, ExtractedTable } from "./types.js";

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function contentHash(table: ExtractedTable): string {
  return createHash("sha256")
    .update(JSON.stringify({ headers: table.headers, rows: table.rows }))
    .digest("hex");
}

export async function saveTable(
  outputDirectory: string,
  outputName: string,
  table: ExtractedTable
): Promise<{ jsonPath: string; csvPath: string; latestCsvPath: string; hash: string }> {
  const directory = path.resolve(outputDirectory, outputName);
  await mkdir(directory, { recursive: true });

  const collectedDate = table.source.collectedAt ? new Date(table.source.collectedAt) : new Date();
  const dateFolder = collectedDate.toISOString().slice(0, 10); // YYYY-MM-DD
  const stamp = table.source.collectedAt.replace(/[:.]/g, "-");
  const base = path.join(directory, `${stamp}-${randomUUID().slice(0, 8)}`);
  const hash = contentHash(table);

  const jsonContent = JSON.stringify({ ...table, contentHash: hash }, null, 2);
  const csvRows = [table.headers, ...table.rows.map((row) => row.cells)]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n");
  const csvContent = `\uFEFF${csvRows}\r\n`;

  // 1. Gravação do arquivo bruto com timestamp
  await writeFile(`${base}.json`, jsonContent, "utf8");
  await writeFile(`${base}.csv`, csvContent, "utf8");

  // 2. Gravação na partição histórica diária: data/historico/YYYY-MM-DD/
  const dailyHistoryDir = path.resolve(outputDirectory, "historico", dateFolder);
  await mkdir(dailyHistoryDir, { recursive: true });
  await writeFile(path.join(dailyHistoryDir, `${outputName}.csv`), csvContent, "utf8");
  await writeFile(path.join(dailyHistoryDir, `${outputName}.json`), jsonContent, "utf8");

  // 3. Atualização atômica do ponteiro de consumo (-latest.csv / -latest.json)
  const latestCsvPath = path.join(directory, `${outputName}-latest.csv`);
  const latestJsonPath = path.join(directory, `${outputName}-latest.json`);
  await writeFile(latestCsvPath, csvContent, "utf8");
  await writeFile(latestJsonPath, jsonContent, "utf8");

  return { jsonPath: `${base}.json`, csvPath: `${base}.csv`, latestCsvPath, hash };
}

export async function appendAudit(outputDirectory: string, event: AuditEvent): Promise<void> {
  const directory = path.resolve(outputDirectory);
  await mkdir(directory, { recursive: true });
  await appendFile(path.join(directory, "audit.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
}
