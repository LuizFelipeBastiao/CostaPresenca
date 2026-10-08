import test from "node:test";
import assert from "node:assert/strict";
import { parseClipboardTsv } from "../src/powerbi/clipboard-reader.js";

test("interpreta TSV e preserva celulas vazias", () => {
  const parsed = parseClipboardTsv("-\tTurma\tAmparo\r\n1\tA\t\r\n1\tB\t6\r\n");
  assert.deepEqual(parsed.headers, ["-", "Turma", "Amparo"]);
  assert.deepEqual(parsed.rows.map((row) => row.cells), [["1", "A", ""], ["1", "B", "6"]]);
});

test("rejeita clipboard sem tabulacoes", () => {
  assert.throws(() => parseClipboardTsv("Turma\nA"));
});
