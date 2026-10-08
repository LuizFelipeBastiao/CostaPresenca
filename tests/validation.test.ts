import test from "node:test";
import assert from "node:assert/strict";
import { validateTable } from "../src/validation.js";
import type { ExtractedTable } from "../src/types.js";

function table(headers: string[], rows: string[][]): ExtractedTable {
  return {
    headers,
    rows: rows.map((cells) => ({ cells })),
    source: {
      reportId: "teste",
      reportName: "Teste",
      visualTitle: "Tabela",
      url: "https://app.powerbi.com/teste",
      collectedAt: new Date(0).toISOString()
    }
  };
}

test("valida colunas ignorando acentos e caixa", () => {
  assert.doesNotThrow(() => validateTable(table(["Aluno", "Frequência"], [["A1", "90%"]]), ["frequencia"]));
});

test("rejeita tabela sem coluna esperada", () => {
  assert.throws(() => validateTable(table(["Aluno"], [["A1"]]), ["Turma"]));
});
