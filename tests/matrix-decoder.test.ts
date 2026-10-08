import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { decodeMatrixDsrPayload } from "../src/powerbi/matrix-decoder.js";

test("decodifica matriz esparsa DSR do Aprendizagem Paraná (MAPA)", () => {
  const artifactPath = path.resolve("artifacts/aprendizagem-mapa-q10.json");
  if (!fs.existsSync(artifactPath)) {
    return; // Pula caso não exista o arquivo de artefato de teste
  }

  const payload = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const result = decodeMatrixDsrPayload(payload);

  assert.equal(result.totalAlunos, 100);
  assert.equal(result.columns.length, 100);
  assert.ok(result.relacionalRows.length > 1000);

  // Validação do primeiro aluno
  const adielRows = result.relacionalRows.filter(r => r.cgm === "1007421024");
  assert.ok(adielRows.length > 10);

  const admRural = adielRows.find(r => r.disciplina.includes("ADM E ECONOMIA RURAL I"));
  assert.ok(admRural);
  assert.equal(admRural.tri1, 9.5);
  assert.equal(admRural.tri2, 10);
  assert.equal(admRural.total, 19.5);
  assert.equal(admRural.status, "ADEQUADO / BOM");

  // Validação de aluno com notas em risco
  const riscoRows = result.relacionalRows.filter(r => r.status === "EM RISCO (< 6.0)");
  assert.ok(riscoRows.length > 0);
});
