import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ErroConfiguracao, lerConfiguracoes, salvarConfiguracoes, type Configuracoes } from "../src/configuracoes.js";

const RAIZ_PROJETO = path.resolve(import.meta.dirname, "..");

function raizTemporaria(): string {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), "cp-config-"));
  fs.mkdirSync(path.join(raiz, "config"));
  for (const f of ["reports.example.json", "notificacoes.example.json"]) {
    fs.copyFileSync(path.join(RAIZ_PROJETO, "config", f), path.join(raiz, "config", f));
  }
  return raiz;
}

function entrada(raiz: string, mudar: (c: Configuracoes) => void): Configuracoes {
  const c = structuredClone(lerConfiguracoes(raiz).valores);
  c.powerbi.presente.url = "https://app.powerbi.com/groups/me/apps/abc/reports/def/ReportSection";
  mudar(c);
  return c;
}

const lerJson = (raiz: string, f: string) => JSON.parse(fs.readFileSync(path.join(raiz, "config", f), "utf8"));

test("configurações: sem local.json, mostra os valores do modelo sem o endereço de exemplo", () => {
  const raiz = raizTemporaria();
  const { valores, situacao } = lerConfiguracoes(raiz);
  assert.equal(valores.powerbi.presente.url, "");
  assert.equal(valores.powerbi.aprendizagem.url, "");
  assert.equal(valores.powerbi.presente.coletaGenerica, false);
  assert.equal(situacao.arquivos.localJson, false);
  assert.deepEqual(situacao.hostsPermitidos, ["app.powerbi.com"]);
  assert.ok(Object.values(situacao.segredos).every((v) => typeof v === "boolean"));
});

test("configurações: salva os campos editáveis e preserva o resto dos arquivos", () => {
  const raiz = raizTemporaria();
  const r = salvarConfiguracoes(
    raiz,
    entrada(raiz, (c) => {
      c.powerbi.escolaNome = "ARTHUR DA C SILVA";
      c.powerbi.aprendizagem.url = "https://app.powerbi.com/groups/me/reports/xyz";
      c.escola.nome = "Colégio Teste";
      c.escola.numeroWhatsappEscola = "(45) 99999-1234";
      c.avisos.fonteContatos = "planilha";
      c.avisos.quedaMinimaPontos = 10;
    })
  );
  assert.ok(r.alterados.includes("Nome da escola no Power BI"));
  assert.ok(r.alterados.includes("Queda mínima"));

  const local = lerJson(raiz, "local.json");
  assert.equal(local.context.escolaNome, "ARTHUR DA C SILVA");
  assert.equal(local.maxRows, 10000); // campo não editável continua lá
  assert.deepEqual(local.reports.map((x: any) => x.id), ["presente-estadual", "aprendizagem-parana"]);
  assert.equal(local.reports[1].enabled, false);

  const notif = lerJson(raiz, "notificacoes.json");
  assert.equal(notif.escola.nome, "Colégio Teste");
  assert.equal(notif.cadastro.numeroWhatsappEscola, "(45) 99999-1234");
  assert.equal(notif.regras.quedaMinimaPontos, 10);
  assert.ok(notif.modelos === undefined || typeof notif.modelos === "object");

  const relido = lerConfiguracoes(raiz).valores;
  assert.equal(relido.powerbi.escolaNome, "ARTHUR DA C SILVA");
  assert.equal(relido.avisos.fonteContatos, "planilha");
  assert.deepEqual(salvarConfiguracoes(raiz, relido).alterados, []);

  // Esvaziar o endereço do Aprendizagem Paraná desliga o Pré-Conselho.
  salvarConfiguracoes(raiz, { ...relido, powerbi: { ...relido.powerbi, aprendizagem: { nome: "", url: "" } } });
  assert.deepEqual(lerJson(raiz, "local.json").reports.map((x: any) => x.id), ["presente-estadual"]);
  assert.ok(fs.existsSync(path.join(raiz, "config", "local.json.bak")));
});

test("configurações: recusa valores inválidos sem gravar nenhum arquivo", () => {
  const raiz = raizTemporaria();
  const casos: Array<[string, (c: Configuracoes) => void, RegExp]> = [
    ["outro site", (c) => (c.powerbi.presente.url = "https://evil.example.com/x"), /precisa ser do Power BI/],
    ["http", (c) => (c.powerbi.presente.url = "http://app.powerbi.com/x"), /https/],
    ["endereço de exemplo", (c) => (c.powerbi.presente.url = "https://app.powerbi.com/COLE-AQUI-A-URL-AUTORIZADA"), /endereço real/],
    ["escola vazia", (c) => (c.powerbi.escolaNome = "  "), /preencha/],
    ["telefone", (c) => (c.escola.numeroWhatsappEscola = "123"), /telefone inválido/],
    ["percentual", (c) => (c.avisos.quedaMinimaPontos = 150), /0 a 100/],
    ["canal sem seção", (c) => (c.avisos.canal = "smtp"), /smtp/],
    ["opção desconhecida", (c) => ((c.avisos as any).fonteContatos = "tudo"), /opção inválida/]
  ];
  for (const [nome, mudar, erro] of casos) {
    assert.throws(() => salvarConfiguracoes(raiz, entrada(raiz, mudar)), (e: unknown) => e instanceof ErroConfiguracao && erro.test(e.message), nome);
  }
  assert.throws(() => salvarConfiguracoes(raiz, null), ErroConfiguracao);
  assert.equal(fs.existsSync(path.join(raiz, "config", "local.json")), false);
  assert.equal(fs.existsSync(path.join(raiz, "config", "notificacoes.json")), false);
});
