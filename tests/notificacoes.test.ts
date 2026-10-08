import test from "node:test";
import assert from "node:assert/strict";
import { parseNotificacaoConfig } from "../src/notificacoes/config.js";
import { parseCsv } from "../src/notificacoes/csv.js";
import { detectarFaltas, lerSnapshot, parsePercentual } from "../src/notificacoes/faltas.js";
import { lerContatos, normalizarTelefone } from "../src/notificacoes/contatos.js";
import { renderizarMensagem, variaveisMensagem } from "../src/notificacoes/mensagem.js";

const config = parseNotificacaoConfig({});

function snapshot(data: string, csv: string) {
  return lerSnapshot(data, parseCsv(csv), config.colunas);
}

test("parseCsv lida com BOM, CRLF e aspas", () => {
  const { headers, rows } = parseCsv('﻿"NomeAluno","cgm"\r\n"ANA ""BIA""","1"\r\n"LINHA\nQUEBRADA","2"\r\n');
  assert.deepEqual(headers, ["NomeAluno", "cgm"]);
  assert.deepEqual(rows, [['ANA "BIA"', "1"], ["LINHA\nQUEBRADA", "2"]]);
});

test("parsePercentual normaliza fração e vírgula", () => {
  assert.equal(parsePercentual("85,5%"), 85.5);
  assert.equal(parsePercentual("0.9"), 90);
  assert.equal(parsePercentual("1%"), 1);
  assert.equal(parsePercentual(""), undefined);
});

test("detecta falta pela queda na presença geral", () => {
  const cab = '"NomeAluno","cgm","Turma","(%) Presença Aluno MedGeral"\n';
  const anterior = snapshot("2026-10-06", `${cab}"ANA","001","6A","95,00%"\n"BRUNO","2","6A","90%"\n`);
  const atual = snapshot("2026-10-07", `${cab}"ANA","1","6A","94,40%"\n"BRUNO","2","6A","90,2%"\n"NOVO","3","6A","50%"\n`);
  const faltas = detectarFaltas(anterior, atual, config.toleranciaPercentual);
  assert.deepEqual(faltas.map((f) => [f.cgm, f.criterio]), [["1", "presenca-geral"]]);
});

test("prefere contagem de faltas quando disponível", () => {
  const cab = '"Aluno","CGM","Turma","Σ Aulas","Σ Presenças","(%) Presença Aluno MedGeral"\n';
  const anterior = snapshot("2026-10-06", `${cab}"ANA","1","6A","100","95","95%"\n`);
  const atual = snapshot("2026-10-07", `${cab}"ANA","1","6A","105","97","92%"\n`);
  const [falta] = detectarFaltas(anterior, atual, config.toleranciaPercentual);
  assert.equal(falta?.criterio, "contagem-faltas");
  assert.equal(falta?.novasFaltas, 3);
});

test("presença da semana só é comparada dentro da mesma semana", () => {
  const cab = '"NomeAluno","cgm","Turma","(%) Presença Aluno"\n';
  const sexta = snapshot("2026-10-09", `${cab}"ANA","1","6A","100%"\n`);
  const segunda = snapshot("2026-10-12", `${cab}"ANA","1","6A","0%"\n`);
  assert.equal(detectarFaltas(sexta, segunda, 0.01).length, 0);

  const terca = snapshot("2026-10-13", `${cab}"ANA","1","6A","50%"\n`);
  const quarta = snapshot("2026-10-14", `${cab}"ANA","1","6A","33%"\n`);
  assert.equal(detectarFaltas(terca, quarta, 0.01).length, 1);
});

test("lerContatos normaliza telefone e respeita autorização", () => {
  const csv = parseCsv(
    "CGM,Aluno,Responsavel,Telefone,Email,Autorizado\n" +
    "1,ANA,MAE,(45) 99999-0000,,sim\n" +
    "1,ANA,PAI,,pai@example.com,\n" +
    "2,BIA,MAE,45988880000,,não\n"
  );
  const contatos = lerContatos(csv, config.contatosColunas, "55");
  assert.equal(contatos.get("1")?.length, 2);
  assert.equal(contatos.get("1")?.[0]?.telefone, "5545999990000");
  assert.equal(contatos.has("2"), false);
  assert.equal(normalizarTelefone("123", "55"), undefined);
});

test("mensagem usa variáveis do aluno e responsável", () => {
  const texto = renderizarMensagem(
    "Olá, {responsavel}. {aluno} ({turma}) faltou em {data}. {desconhecida}",
    variaveisMensagem(
      { cgm: "1", aluno: "MARIA DA SILVA", turma: "6A", criterio: "presenca-geral" },
      { cgm: "1", aluno: "", responsavel: "JOANA DA SILVA" },
      "Escola",
      "2026-10-07"
    )
  );
  assert.equal(texto, "Olá, Joana da Silva. Maria da Silva (6A) faltou em 07/10/2026. {desconhecida}");
});
