import test from "node:test";
import assert from "node:assert/strict";
import {
  buscarJanelasRestantes,
  cabecalhosReenviaveis,
  corpoComContinuacao,
  juntarTabelas,
  tokenDeContinuacao
} from "../src/powerbi/paginacao.js";

const resposta = (ic: boolean, rt?: unknown[]) => ({
  results: [{ result: { data: { dsr: { DS: [{ IC: ic, ...(rt ? { RT: rt } : {}), PH: [] }] } } } }]
});

const corpoOriginal = JSON.stringify({
  version: "1.0.0",
  queries: [
    {
      Query: {
        Commands: [
          {
            SemanticQueryDataShapeCommand: {
              Query: { From: [], Where: [{ escola: "ARTHUR" }] },
              Binding: { DataReduction: { DataVolume: 3, Primary: { Window: { Count: 500 } } } }
            }
          }
        ]
      }
    }
  ]
});

test("paginação: token de continuação só quando a resposta está incompleta", () => {
  assert.deepEqual(tokenDeContinuacao(resposta(false, [[false], ["'MANUELA'"]])), [[false], ["'MANUELA'"]]);
  assert.equal(tokenDeContinuacao(resposta(true, [[false], ["x"]])), null);
  assert.equal(tokenDeContinuacao(resposta(false)), null);
  assert.equal(tokenDeContinuacao({}), null);
});

test("paginação: reenvia a mesma consulta (com os filtros) e o RestartTokens", () => {
  const corpo = JSON.parse(corpoComContinuacao(corpoOriginal, [["'M'"]]));
  const cmd = corpo.queries[0].Query.Commands[0].SemanticQueryDataShapeCommand;
  assert.deepEqual(cmd.Binding.DataReduction.Primary.Window, { Count: 500, RestartTokens: [["'M'"]] });
  assert.deepEqual(cmd.Query.Where, [{ escola: "ARTHUR" }], "o filtro da escola continua na consulta");
  assert.throws(() => corpoComContinuacao(JSON.stringify({ queries: [] }), [["x"]]), /formato inesperado/);
});

test("paginação: busca janelas até a resposta vir completa", async () => {
  const pedidos: string[] = [];
  const fila = [resposta(false, [["'P'"]]), resposta(true)];
  const todas = await buscarJanelasRestantes(
    resposta(false, [["'M'"]]),
    { url: "https://x.analysis.windows.net/q", corpo: corpoOriginal, headers: { authorization: "Bearer t", "content-length": "9", ":authority": "x" } },
    async (_url, headers, corpo) => {
      assert.equal(headers.authorization, "Bearer t");
      assert.equal(headers["content-length"], undefined);
      pedidos.push(JSON.stringify(JSON.parse(corpo).queries[0].Query.Commands[0].SemanticQueryDataShapeCommand.Binding.DataReduction.Primary.Window.RestartTokens));
      return fila.shift();
    }
  );
  assert.equal(todas.length, 3);
  assert.deepEqual(pedidos, ['[["\'M\'"]]', '[["\'P\'"]]']);

  // completa de primeira: nenhum pedido extra
  const unica = await buscarJanelasRestantes(resposta(true), { url: "", corpo: "", headers: {} }, async () => {
    throw new Error("não deveria pedir");
  });
  assert.equal(unica.length, 1);
});

test("paginação: erro se o Power BI não avançar ou passar do limite", async () => {
  const consulta = { url: "https://x.analysis.windows.net/q", corpo: corpoOriginal, headers: {} };
  await assert.rejects(
    buscarJanelasRestantes(resposta(false, [["'M'"]]), consulta, async () => resposta(false, [["'M'"]])),
    /não avançou/
  );
  let n = 0;
  await assert.rejects(
    buscarJanelasRestantes(resposta(false, [[0]]), consulta, async () => resposta(false, [[++n]]), { maxJanelas: 3 }),
    /não terminou em 3 janelas/
  );
});

test("paginação: junta as janelas sem repetir linhas e exige as mesmas colunas", () => {
  const t1 = { headers: ["NomeAluno", "cgm"], rows: [{ cells: ["ANA", "1"] }, { cells: ["MARIA", "2"] }] };
  const t2 = { headers: ["NomeAluno", "cgm"], rows: [{ cells: ["MARIA", "2"] }, { cells: ["ZECA", "3"] }] };
  const junta = juntarTabelas([t1, t2] as any);
  assert.deepEqual(junta.rows.map((r) => r.cells[0]), ["ANA", "MARIA", "ZECA"]);
  assert.throws(() => juntarTabelas([t1, { headers: ["x"], rows: [] }] as any), /colunas diferentes/);
  assert.equal(cabecalhosReenviaveis({ RequestId: "a", Authorization: "b" }).authorization, "b");
});

test("paginação: janela de continuação herda o esquema da primeira", async () => {
  const { herdarSchema } = await import("../src/powerbi/paginacao.js");
  const S = [{ N: "G0" }];
  const primeira = { results: [{ result: { data: { dsr: { DS: [{ PH: [{ DM0: [{ S, C: ["a"] }] }] }] } } } }] };
  const seguinte = { results: [{ result: { data: { dsr: { DS: [{ PH: [{ DM0: [{ C: ["b"] }] }] }] } } } }] };
  const r: any = herdarSchema(seguinte, primeira);
  assert.deepEqual(r.results[0].result.data.dsr.DS[0].PH[0].DM0[0].S, S);
  assert.equal((seguinte as any).results[0].result.data.dsr.DS[0].PH[0].DM0[0].S, undefined, "não altera a original");
});
