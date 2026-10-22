import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { notificacoesConfigSchema } from "../src/notificacoes/config.js";
import { lerContatos, normalizarTelefone, mascararTelefone } from "../src/notificacoes/contatos.js";
import { HistoricoEnvios, hashDestino } from "../src/notificacoes/historico.js";
import { renderizar, turmaLegivel, nomeProprio, variaveisDesconhecidas } from "../src/notificacoes/modelo.js";
import { planejar } from "../src/notificacoes/planejar.js";
import { lerPresenca, parseDataPowerBi } from "../src/notificacoes/presenca.js";
import { chaveSemanaIso, semanaDeReferencia } from "../src/notificacoes/regras.js";

const HEAD =
  '"NomeAluno","cgm","Turma","Idade","descrsituacaomatricula","(%) Presença Aluno MedGeral","(%) Presença Aluno","(%) Presença Aluno SemPassada","Amparo Legal Aluno Data MAX"';
const linha = (c: string[]) => c.map((v) => `"${v}"`).join(",");

const CSV_PRESENCA = [
  HEAD,
  linha(["ANA PAULA DA SILVA", "111", "6º Série A Tarde - 2612063", "12", "Matriculado", "95,26%", "100,00%", "100,00%", ""]),
  linha(["BRUNO LIMA", "222", "7º Série B Manhã - 2612200", "13", "Matriculado", "0.9", "0.66670000000000007", "100,00%", ""]),
  linha(["CARLA SOUZA", "333", "8º Série C Tarde - 2612359", "14", "Matriculado", "70,10%", "50,00%", "80,00%", ""]),
  // mesmo aluno em duas matrículas: a pior presença vale
  linha(["DANIEL REIS", "444", "1º Série A Manhã - 2612623", "15", "Matriculado", "90,00%", "100,00%", "100,00%", ""]),
  linha(["DANIEL REIS", "444", "Itinerário X - 2699999", "15", "Matriculado", "88,00%", "75,00%", "100,00%", ""]),
  // falta justificada com amparo legal recente
  linha(["EDU COSTA", "555", "9º Série B Manhã - 2612518", "14", "Matriculado", "85,00%", "0,00%", "100,00%", String(Date.UTC(2026, 9, 15))]),
  linha(["FABI ROCHA", "666", "9º Série B Manhã - 2612518", "14", "Transferido", "85,00%", "0,00%", "100,00%", ""])
].join("\n");

const CSV_CONTATOS = [
  "cgm;aluno;responsavel;telefone;email;consentimento",
  "222;BRUNO LIMA;MARIA LIMA;(45) 99999-1111;;sim",
  "333;CARLA SOUZA;JOSE SOUZA;45 98888-2222 / 45 3333-4444;;sim",
  "444;DANIEL REIS;RITA REIS;045997776666;;não",
  "777;FORA;X;123;;sim"
].join("\r\n");

function cfg(extra: Record<string, unknown> = {}) {
  return notificacoesConfigSchema.parse({ escola: { nome: "Escola Teste", telefoneContato: "(45) 3000-0000" }, ...extra });
}

test("normaliza telefones brasileiros", () => {
  assert.equal(normalizarTelefone("(45) 99999-8888"), "5545999998888");
  assert.equal(normalizarTelefone("045 99999-8888"), "5545999998888");
  assert.equal(normalizarTelefone("+55 45 9 9999-8888"), "5545999998888");
  assert.equal(normalizarTelefone("0 15 45 99999-8888"), "5545999998888");
  assert.equal(normalizarTelefone("(45) 3333-4444"), "554533334444");
  assert.equal(normalizarTelefone("55 99999-8888"), "5555999998888"); // DDD 55 (RS)
  assert.equal(normalizarTelefone("(45) 89999-8888"), null); // 9 dígitos sem 9 inicial
  assert.equal(normalizarTelefone("123"), null);
  assert.equal(mascararTelefone("5545999998888"), "+55 45 9****-8888");
});

test("lê presença consolidando CGM repetido e percentuais mistos", () => {
  const alunos = lerPresenca(CSV_PRESENCA);
  assert.equal(alunos.length, 6);
  const bruno = alunos.find((a) => a.cgm === "222")!;
  assert.ok(Math.abs(bruno.presencaSemanaAtual! - 66.67) < 0.01);
  assert.equal(bruno.presencaGeral, 90);
  const daniel = alunos.find((a) => a.cgm === "444")!;
  assert.equal(daniel.turmas.length, 2);
  assert.equal(daniel.presencaSemanaAtual, 75);
  assert.equal(daniel.presencaGeral, 88);
});

test("datas do Power BI", () => {
  assert.equal(parseDataPowerBi("1789084800000")?.toISOString().slice(0, 10), "2026-09-11");
  assert.equal(parseDataPowerBi("05/10/2026")?.toISOString().slice(0, 10), "2026-10-05");
  assert.equal(parseDataPowerBi(""), null);
});

test("semana de referência", () => {
  const quinta = new Date(Date.UTC(2026, 9, 22));
  const atual = semanaDeReferencia(quinta, "atual");
  assert.equal(atual.rotulo, "19/10 a 22/10");
  assert.equal(atual.chave, "2026-W43");
  const anterior = semanaDeReferencia(quinta, "anterior");
  assert.equal(anterior.rotulo, "12/10 a 16/10");
  assert.equal(semanaDeReferencia(new Date(Date.UTC(2026, 9, 25)), "atual").rotulo, "19/10 a 23/10"); // domingo
  assert.equal(chaveSemanaIso(new Date(Date.UTC(2027, 0, 1))), "2026-W53");
});

test("contatos: vários telefones, consentimento e inválidos", () => {
  const { contatos, avisos } = lerContatos(CSV_CONTATOS);
  assert.equal(contatos.get("333")?.length, 2);
  assert.equal(contatos.get("222")?.[0]?.consentimento, true);
  assert.equal(contatos.get("444")?.[0]?.consentimento, false);
  assert.equal(contatos.has("777"), false);
  assert.ok(avisos.some((a) => a.includes("Linha 5")));
});

test("planeja avisos com regras, consentimento e histórico", async () => {
  const alunos = lerPresenca(CSV_PRESENCA);
  const { contatos } = lerContatos(CSV_CONTATOS);
  const semana = semanaDeReferencia(new Date(Date.UTC(2026, 9, 22)), "atual");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "notif-"));
  const historico = HistoricoEnvios.carregar(dir);

  const plano = planejar(alunos, contatos, cfg(), semana, "whatsapp-cloud", historico);
  assert.equal(plano.ignorados["presenca-ok"], 1); // Ana
  assert.equal(plano.ignorados["amparo-legal"], 1); // Edu
  assert.equal(plano.ignorados["nao-matriculado"], 1); // Fabi

  const status = (cgm: string) => plano.itens.filter((i) => i.aluno.cgm === cgm).map((i) => i.status);
  assert.deepEqual(status("222"), ["pronto"]);
  assert.deepEqual(status("333"), ["pronto", "pronto"]);
  assert.deepEqual(status("444"), ["sem-consentimento"]);

  // Carla tem geral 70% → crítica, e vem primeiro na fila
  assert.equal(plano.itens[0]!.aluno.cgm, "333");
  assert.equal(plano.itens[0]!.tipo, "critica");
  const bruno = plano.itens.find((i) => i.aluno.cgm === "222")!;
  assert.equal(bruno.tipo, "falta");
  assert.match(bruno.texto, /Maria Lima/);
  assert.match(bruno.texto, /Bruno Lima \(7º Série B Manhã\)/);
  assert.match(bruno.texto, /67%/);
  assert.match(bruno.texto, /19\/10 a 22\/10/);

  // Depois de enviado, não repete na mesma semana
  await historico.registrar({
    timestamp: new Date(Date.UTC(2026, 9, 22, 12)).toISOString(),
    runId: "r",
    cgm: "222",
    destinoHash: hashDestino("5545999991111"),
    canal: "whatsapp-cloud",
    tipo: "falta",
    semana: semana.chave,
    status: "enviado"
  });
  const recarregado = HistoricoEnvios.carregar(dir);
  const plano2 = planejar(alunos, contatos, cfg(), semana, "whatsapp-cloud", recarregado, new Date(Date.UTC(2026, 9, 23)));
  assert.deepEqual(plano2.itens.filter((i) => i.aluno.cgm === "222").map((i) => i.status), ["ja-notificado"]);

  // Sem exigir consentimento, Daniel fica pronto
  const plano3 = planejar(alunos, contatos, cfg({ exigirConsentimento: false }), semana, "whatsapp-cloud", null);
  assert.deepEqual(plano3.itens.filter((i) => i.aluno.cgm === "444").map((i) => i.status), ["pronto"]);
  // Canal e-mail: contatos sem e-mail não têm destino
  const plano4 = planejar(alunos, contatos, cfg(), semana, "smtp", null);
  assert.ok(plano4.itens.filter((i) => i.aluno.cgm === "222").every((i) => i.status === "sem-destino-no-canal"));
});

test("aluno com falta e sem contato aparece como pendente", () => {
  const alunos = lerPresenca(CSV_PRESENCA);
  const semana = semanaDeReferencia(new Date(Date.UTC(2026, 9, 22)), "atual");
  const plano = planejar(alunos, new Map(), cfg(), semana, "dry-run", null);
  assert.ok(plano.itens.every((i) => i.status === "sem-contato"));
  assert.equal(plano.itens.length, 3);
});

test("modelos", () => {
  assert.deepEqual(variaveisDesconhecidas("Oi {responsavel}, {alunoo}"), ["alunoo"]);
  assert.equal(turmaLegivel("6º Série C Tarde - 2612125"), "6º Série C Tarde");
  assert.equal(nomeProprio("MARIA DAS DORES E SILVA"), "Maria das Dores e Silva");
  const v = Object.fromEntries(["responsavel", "aluno", "primeiroNome", "turma", "escola", "telefoneEscola", "presencaSemana", "presencaSemanaAnterior", "presencaGeral", "dataReferencia"].map((k) => [k, k.toUpperCase()]));
  assert.equal(renderizar("{aluno}-{x}", v as never), "ALUNO-{x}");
});
