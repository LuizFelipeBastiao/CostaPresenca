import type { ExtractedTable } from "./types.js";

function canonical(value: string): string {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();
}

export function validateTable(table: ExtractedTable, expectedColumns: string[]): void {
  if (table.headers.length === 0) throw new Error("Cabecalho vazio");
  if (table.rows.length === 0) throw new Error("Nenhuma linha de dados");

  const headers = table.headers.map(canonical);
  const missing = expectedColumns.filter(
    (expected) => !headers.some((header) => header.includes(canonical(expected)))
  );
  if (missing.length > 0) throw new Error(`Colunas esperadas ausentes: ${missing.join(", ")}`);

  const width = table.headers.length;
  const malformed = table.rows.filter((row) => row.cells.length !== width);
  if (malformed.length > Math.max(2, Math.floor(table.rows.length * 0.05))) {
    throw new Error(`Muitas linhas com largura divergente: ${malformed.length}/${table.rows.length}`);
  }
}
