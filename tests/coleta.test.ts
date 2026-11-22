import test from "node:test";
import assert from "node:assert/strict";
import { dataLocal } from "../src/datas.js";
import { statusPreConselho } from "../src/powerbi/matrix-decoder.js";
import { filtrarPelaEscola } from "../src/extract-presente-alunos.js";
import { canonico } from "../src/powerbi/filters.js";
import { assertAllowedUrl, SessaoExpiradaError } from "../src/safety.js";

test("dataLocal usa o dia do fuso local, nao o de UTC", () => {
  // 22h do dia 10 no horario local: em UTC (Brasil, -3) ja seria dia 11.
  assert.equal(dataLocal(new Date(2026, 10, 10, 22, 30)), "2026-11-10");
  assert.equal(dataLocal(new Date(2026, 0, 5, 0, 0)), "2026-01-05");
});

test("statusPreConselho considera os tres trimestres", () => {
  assert.equal(statusPreConselho({ tri1: 9, tri2: 8, tri3: 4 }), "EM RISCO (< 6.0)");
  assert.equal(statusPreConselho({ tri1: 9, tri2: null, tri3: 6.5 }), "ATENÇÃO (6.0 - 6.9)");
  assert.equal(statusPreConselho({ tri1: 7, tri2: 8, tri3: null }), "ADEQUADO / BOM");
});

test("statusPreConselho nao marca disciplina sem nota como boa", () => {
  assert.equal(statusPreConselho({ tri1: null, tri2: null, tri3: null }), "SEM NOTAS LANÇADAS");
});

test("canonico ignora acento e caixa", () => {
  assert.equal(canonico("Foz do Iguaçu"), canonico("FOZ DO IGUACU"));
});

test("filtrarPelaEscola remove linhas de outras escolas", () => {
  const tabela = {
    headers: ["Turma", "Escola"],
    rows: [
      { cells: ["1A", "C.E. ARTHUR DA COSTA E SILVA-EF M"] },
      { cells: ["1B", "ANCHIETA, C E PE-EF M"] }
    ]
  };
  const filtrada = filtrarPelaEscola(tabela, "Arthur da Costa e Silva");
  assert.deepEqual(filtrada.rows.map((r) => r.cells[0]), ["1A"]);
});

test("filtrarPelaEscola falha se nenhuma linha for da escola", () => {
  const tabela = { headers: ["Escola"], rows: [{ cells: ["ANCHIETA"] }] };
  assert.throws(() => filtrarPelaEscola(tabela, "ARTHUR DA COSTA E SILVA"), /Nenhuma linha da escola/);
});

test("filtrarPelaEscola nao mexe em tabela sem coluna de escola", () => {
  const tabela = { headers: ["Turma"], rows: [{ cells: ["1A"] }] };
  assert.equal(filtrarPelaEscola(tabela, "X"), tabela);
});

test("redirecionar para o login da Microsoft vira erro de sessao expirada", () => {
  assert.throws(
    () => assertAllowedUrl("https://login.microsoftonline.com/common/oauth2", ["app.powerbi.com"]),
    SessaoExpiradaError
  );
  assert.doesNotThrow(() => assertAllowedUrl("https://app.powerbi.com/groups/me", ["app.powerbi.com"]));
});
