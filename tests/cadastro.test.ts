import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { processarMensagem } from "../src/cadastro/bot.js";
import { CadastroStore } from "../src/cadastro/store.js";
import { Deduplicador, assinar, assinaturaValida, extrairMensagens, respostaVerificacao } from "../src/cadastro/webhook.js";
import { executar, gerarBilhetes, htmlBilhetes, linkCadastro, resumoCadastros } from "../src/cadastro/cli.js";
import { criarServidorBot } from "../src/bot-whatsapp.js";
import { notificacoesConfigSchema } from "../src/notificacoes/config.js";
import { carregarContatos } from "../src/notificacoes/fontes.js";

const SECRET = "segredo-do-app";
const VERIFY = "token-de-verificacao";
const PAI = "5545999998888";

function ambiente(cadastro: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cadastro-"));
  const config = notificacoesConfigSchema.parse({
    escola: { nome: "Colégio Teste" },
    dataDirectory: dir,
    fonteContatos: "cadastros",
    cadastro: { arquivo: path.join(dir, "cadastros", "cadastros.json"), numeroWhatsappEscola: "(45) 99999-0000", ...cadastro }
  });
  const store = new CadastroStore(config.cadastro.arquivo);
  store.garantirCodigos([
    { cgm: "111", nome: "ANA PAULA DA SILVA", turmas: ["6º Série A Tarde - 2612063"] },
    { cgm: "222", nome: "BRUNO LIMA", turmas: ["7º Série B Manhã - 2612200"] }
  ]);
  const codigo = (cgm: string) => store.ler().codigos.find((c) => c.cgm === cgm)!.codigo;
  const ctx = { store, escola: config.escola.nome, cadastro: config.cadastro };
  return { dir, config, store, codigo, ctx };
}

test("bot: cadastra com o código do bilhete e o contato passa a receber avisos", () => {
  const { config, store, codigo, ctx } = ambiente();
  const c = codigo("111");
  const r = processarMensagem({ telefone: PAI, texto: `cadastrar ${c.slice(0, 3)}-${c.slice(3)}`, nomePerfil: "Maria" }, ctx);
  assert.equal(r.acao, "cadastrado");
  assert.match(r.texto, /Ana \(6º Série A Tarde\)/);
  assert.doesNotMatch(r.texto, /Paula/, "só o primeiro nome do aluno aparece na resposta");

  assert.equal(processarMensagem({ telefone: PAI, texto: `CADASTRAR ${c}` }, ctx).acao, "ja-cadastrado");
  // código solto, sem a palavra CADASTRAR, também vale
  assert.equal(processarMensagem({ telefone: PAI, texto: `bom dia ${codigo("222")}` }, ctx).acao, "cadastrado");

  const vinc = store.ler().vinculos;
  assert.deepEqual(vinc.map((v) => [v.cgm, v.status]), [["111", "ativo"], ["222", "ativo"]]);
  const { contatos } = carregarContatos(config);
  assert.equal(contatos.get("111")?.[0]?.telefone, PAI);
  assert.equal(contatos.get("111")?.[0]?.consentimento, true);
});

test("bot: código errado conta tentativas e bloqueia no limite", () => {
  const { ctx } = ambiente({ maxTentativasErradasPorDia: 2 });
  assert.equal(processarMensagem({ telefone: PAI, texto: "CADASTRAR AAA-AAA" }, ctx).acao, "codigo-nao-encontrado");
  assert.equal(processarMensagem({ telefone: PAI, texto: "CADASTRAR BBB-BBB" }, ctx).acao, "codigo-nao-encontrado");
  assert.equal(processarMensagem({ telefone: PAI, texto: "CADASTRAR CCC-CCC" }, ctx).acao, "bloqueado");
  assert.equal(processarMensagem({ telefone: PAI, texto: "CADASTRAR 12" }, ctx).acao, "codigo-invalido");
  assert.equal(processarMensagem({ telefone: PAI, texto: "oi" }, ctx).acao, "ajuda");
});

test("bot: aprovação manual, STATUS, limite de responsáveis e SAIR", () => {
  const { store, codigo, ctx } = ambiente({ aprovacaoManual: true, maxResponsaveisPorAluno: 1 });
  assert.equal(processarMensagem({ telefone: PAI, texto: `CADASTRAR ${codigo("111")}` }, ctx).acao, "pendente");
  assert.match(processarMensagem({ telefone: PAI, texto: "status" }, ctx).texto, /aguardando confirmação/);
  assert.equal(
    processarMensagem({ telefone: "5545988887777", texto: `CADASTRAR ${codigo("111")}` }, ctx).acao,
    "limite-responsaveis"
  );
  assert.equal(processarMensagem({ telefone: PAI, texto: "Sair" }, ctx).acao, "removido");
  assert.equal(store.ler().vinculos.length, 0);
  assert.equal(processarMensagem({ telefone: PAI, texto: "SAIR" }, ctx).acao, "nada-para-remover");
});

test("webhook: assinatura, handshake e extração das mensagens", () => {
  const corpo = Buffer.from('{"a":1}');
  assert.equal(assinaturaValida(corpo, assinar(corpo, SECRET), SECRET), true);
  assert.equal(assinaturaValida(corpo, assinar(corpo, "outro"), SECRET), false);
  assert.equal(assinaturaValida(Buffer.from('{"a":2}'), assinar(corpo, SECRET), SECRET), false);
  assert.equal(assinaturaValida(corpo, undefined, SECRET), false);
  assert.equal(assinaturaValida(corpo, "sha256=zz", SECRET), false);

  const p = (token: string) => new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": token, "hub.challenge": "42" });
  assert.equal(respostaVerificacao(p(VERIFY), VERIFY), "42");
  assert.equal(respostaVerificacao(p("errado"), VERIFY), null);

  const payload = {
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: "PNID" },
              contacts: [{ wa_id: PAI, profile: { name: "Maria" } }],
              messages: [
                { id: "w1", from: PAI, timestamp: "1795000000", type: "text", text: { body: "CADASTRAR K7P-4Q2" } },
                { id: "w2", from: PAI, type: "image", image: { caption: "CADASTRAR K7P 4Q2" } },
                { id: "w3", from: PAI, type: "audio", audio: {} }
              ]
            }
          },
          // só status de entrega: não é mensagem
          { field: "messages", value: { statuses: [{ id: "x", status: "read" }] } }
        ]
      }
    ]
  };
  const ms = extrairMensagens(payload);
  assert.deepEqual(ms.map((m) => [m.id, m.texto, m.nomePerfil, m.phoneNumberId]), [
    ["w1", "CADASTRAR K7P-4Q2", "Maria", "PNID"],
    ["w2", "CADASTRAR K7P 4Q2", "Maria", "PNID"],
    ["w3", "", "Maria", "PNID"]
  ]);
  assert.equal(ms[0]!.enviadaEm?.toISOString(), new Date(1795000000 * 1000).toISOString());
  assert.deepEqual(extrairMensagens({ object: "page" }), []);
  assert.deepEqual(extrairMensagens(null), []);

  const d = new Deduplicador(2);
  assert.equal(d.primeiraVez("a"), true);
  assert.equal(d.primeiraVez("a"), false);
  d.primeiraVez("b");
  d.primeiraVez("c"); // "a" sai da memória
  assert.equal(d.primeiraVez("a"), true);
});

test("servidor do bot: recebe o POST assinado, cadastra, responde uma vez só", async (t) => {
  const { config, store, codigo, dir } = ambiente();
  const enviadas: [string, string][] = [];
  const arquivoLog = path.join(dir, "bot.jsonl");
  const { server, ocioso } = criarServidorBot({
    config,
    appSecret: SECRET,
    verifyToken: VERIFY,
    phoneNumberId: "PNID",
    arquivoLog,
    responder: async (destino, texto) => {
      enviadas.push([destino, texto]);
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const verif = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=abc`);
  assert.equal(verif.status, 200);
  assert.equal(await verif.text(), "abc");
  assert.equal((await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=x&hub.challenge=abc`)).status, 403);
  assert.equal((await fetch(`${base}/api/previa`)).status, 404, "só /webhook e /saude existem nesta porta");

  const mensagem = (id: string, texto: string, pnid = "PNID") => ({
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: pnid },
              contacts: [{ wa_id: PAI, profile: { name: "Maria" } }],
              messages: [{ id, from: PAI, type: "text", text: { body: texto } }]
            }
          }
        ]
      }
    ]
  });
  const postar = (payload: unknown, segredo = SECRET) => {
    const corpo = JSON.stringify(payload);
    return fetch(`${base}/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hub-Signature-256": assinar(corpo, segredo) },
      body: corpo
    });
  };

  const p = mensagem("wamid.1", `CADASTRAR ${codigo("111")}`);
  assert.equal((await postar(p, "forjado")).status, 401);
  assert.equal((await postar(p)).status, 200);
  assert.equal((await postar(p)).status, 200); // reentrega da Meta
  assert.equal((await postar(mensagem("wamid.9", `CADASTRAR ${codigo("222")}`, "OUTRO_NUMERO"))).status, 200);
  await ocioso();

  assert.equal(enviadas.length, 1);
  assert.equal(enviadas[0]![0], PAI);
  assert.match(enviadas[0]![1], /Cadastro feito/);
  assert.deepEqual(store.ler().vinculos.map((v) => [v.cgm, v.telefone, v.responsavel]), [["111", PAI, "Maria"]]);

  const log = fs.readFileSync(arquivoLog, "utf8");
  assert.match(log, /"acao":"cadastrado"/);
  assert.doesNotMatch(log, new RegExp(PAI), "log não guarda o telefone completo");
});

test("bilhetes: código, link wa.me com o texto pronto e QR", async () => {
  const { config, store, dir } = ambiente();
  assert.equal(linkCadastro("(45) 99999-0000", "K7P4Q2"), "https://wa.me/5545999990000?text=CADASTRAR%20K7P-4Q2");
  assert.equal(linkCadastro("", "K7P4Q2"), null);

  const html = await htmlBilhetes(store.ler().codigos, config, async (t) => `<svg data-link="${t}"></svg>`);
  const c = store.ler().codigos[0]!;
  assert.match(html, new RegExp(`CADASTRAR ${c.codigo.slice(0, 3)}-${c.codigo.slice(3)}`));
  assert.match(html, /Ana Paula da Silva/);
  assert.match(html, /6º Série A Tarde</);
  assert.match(html, /data-link="https:\/\/wa.me\/5545999990000/);

  // comando completo, lendo o CSV de presença coletado
  fs.mkdirSync(path.join(dir, "presente-alunos"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "presente-alunos", "presente-alunos-latest.csv"),
    [
      '"NomeAluno","cgm","Turma","descrsituacaomatricula","(%) Presença Aluno"',
      '"ANA PAULA DA SILVA","111","6º Série A Tarde - 2612063","Matriculado","100,00%"',
      '"CAIO NOVO","333","8º Série C Tarde - 2612359","Matriculado","100,00%"',
      '"FABI ROCHA","666","9º Série B Manhã - 2612518","Transferido","0,00%"'
    ].join("\n")
  );
  const log = console.log;
  console.log = () => {};
  try {
    assert.equal(await executar(["bilhetes"], config), 0);
  } finally {
    console.log = log;
  }
  const saida = fs.readFileSync(path.join(path.dirname(config.cadastro.arquivo), "bilhetes.html"), "utf8");
  assert.match(saida, /Caio Novo/);
  assert.doesNotMatch(saida, /Fabi/, "transferido não ganha bilhete");
  assert.doesNotMatch(saida, /Bruno/, "aluno fora do CSV atual não é impresso");
  assert.match(saida, /<svg/, "QR code real gerado pelo pacote qrcode");
  assert.equal(store.ler().codigos.filter((x) => x.cgm === "111").length, 1, "código existente é reaproveitado");
});

test("painel: resumo dos cadastros e bilhetes filtrados por turma", async () => {
  const { config, store, codigo, ctx, dir } = ambiente();
  assert.equal(resumoCadastros(config).semListaDeAlunos, true);
  await assert.rejects(gerarBilhetes(config), /Ainda não há lista de alunos/);

  fs.mkdirSync(path.join(dir, "presente-alunos"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "presente-alunos", "presente-alunos-latest.csv"),
    [
      '"NomeAluno","cgm","Turma","descrsituacaomatricula","(%) Presença Aluno"',
      '"ANA PAULA DA SILVA","111","6º Série A Tarde - 2612063","Matriculado","100,00%"',
      '"BRUNO LIMA","222","7º Série B Manhã - 2612200","Matriculado","100,00%"'
    ].join("\n")
  );
  processarMensagem({ telefone: PAI, texto: `CADASTRAR ${codigo("111")}` }, ctx);

  const r = resumoCadastros(config);
  assert.deepEqual([r.alunos, r.alunosCobertos, r.responsaveisAtivos, r.semListaDeAlunos], [2, 1, 1, false]);
  assert.deepEqual(r.turmas, ["6º Série A Tarde", "7º Série B Manhã"]);

  const turma7 = await gerarBilhetes(config, { turma: "7º Série B Manhã", botaoImprimir: true });
  assert.equal(turma7.bilhetes, 1);
  assert.match(turma7.html, /Bruno Lima/);
  assert.match(turma7.html, /Imprimir/);
  const pendentes = await gerarBilhetes(config, { semCadastro: true });
  assert.equal(pendentes.bilhetes, 1, "Ana já tem responsável");
  assert.equal(store.ler().codigos.find((c) => c.cgm === "111")!.codigo, codigo("111"), "código não muda ao gerar de novo");
});
