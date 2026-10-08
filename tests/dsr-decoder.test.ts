import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { decodeDsrPayload } from "../src/powerbi/dsr-decoder.js";

test("decodifica payload DSR sintético com schema S, ValueDicts e bitmask R", () => {
  const mockDsr = {
    results: [
      {
        result: {
          data: {
            descriptor: {
              Select: [
                { Value: "D0", Name: "dTurmas.Turma" },
                { Value: "D1", Name: "dEscolas.Escola" },
                { Value: "D2", Name: "dMunicipios.Município" },
                { Value: "M0", Name: "_Medidas.Alunos Ativos" },
                { Value: "M1", Name: "_Medidas.(%) Presença" }
              ]
            },
            dsr: {
              DS: [
                {
                  N: "DS0",
                  ValueDicts: {
                    D0: ["1º Ano A - Matutino", "2º Ano B - Vespertino"],
                    D1: ["CE ARTHUR DA COSTA E SILVA"],
                    D2: ["MEDIANEIRA"]
                  },
                  PH: [
                    {
                      DM0: [
                        {
                          S: [
                            { N: "D0", T: 1 },
                            { N: "D1", T: 1 },
                            { N: "D2", T: 1 },
                            { N: "M0", T: 4 },
                            { N: "M1", T: 3 }
                          ],
                          C: [0, 0, 0, 32, 0.94]
                        },
                        {
                          R: 6, // Repete D1 e D2
                          C: [1, 28, 0.89]
                        }
                      ]
                    }
                  ]
                }
              ]
            }
          }
        }
      }
    ]
  };

  const result = decodeDsrPayload(mockDsr);

  assert.equal(result.headers.length, 5);
  assert.equal(result.rows.length, 2);
  assert.ok(result.headers.includes("Turma"));
  assert.ok(result.headers.includes("Escola"));
  assert.ok(result.headers.includes("Município"));
  assert.ok(result.headers.includes("Alunos Ativos"));
  assert.ok(result.headers.includes("(%) Presença"));

  // Primeira linha
  assert.equal(result.rows[0]?.cells[0], "1º Ano A - Matutino");
  assert.equal(result.rows[0]?.cells[1], "CE ARTHUR DA COSTA E SILVA");
  assert.equal(result.rows[0]?.cells[2], "MEDIANEIRA");
  assert.equal(result.rows[0]?.cells[3], "32");
  assert.equal(result.rows[0]?.cells[4], "94,00%");

  // Segunda linha (com repetição via bitmask R)
  assert.equal(result.rows[1]?.cells[0], "2º Ano B - Vespertino");
  assert.equal(result.rows[1]?.cells[1], "CE ARTHUR DA COSTA E SILVA");
  assert.equal(result.rows[1]?.cells[2], "MEDIANEIRA");
  assert.equal(result.rows[1]?.cells[3], "28");
  assert.equal(result.rows[1]?.cells[4], "89,00%");
});

test("decodifica payload DSR real capturado do Power BI se disponível em data/", () => {
  const presenteDir = path.resolve("data/presente-alunos");
  if (!fs.existsSync(presenteDir)) return;

  const files = fs.readdirSync(presenteDir).filter(f => f.endsWith(".json"));
  if (files.length === 0) return;

  const targetFile = path.join(presenteDir, files[0]!);
  const raw = fs.readFileSync(targetFile, "utf8");
  const parsed = JSON.parse(raw);

  const result = decodeDsrPayload(parsed);

  assert.ok(result.headers.length > 5);
  assert.ok(result.rows.length > 0);
  assert.ok(result.headers.some(h => h.toLowerCase().includes("aluno") || h.toLowerCase().includes("cgm")));
});

