import test from "node:test";
import assert from "node:assert/strict";
import { identificarCasosOrgaosCompetentes, gerarHtmlNotificacaoConselhoTutelar } from "../src/notificacoes/orgaos.js";
import type { AlunoFrequencia } from "../src/notificacoes/presenca.js";
import type { ContatoResponsavel } from "../src/notificacoes/contatos.js";

test("identifica alunos com frequencia critica para encaminhamento ao Conselho Tutelar", () => {
  const alunos: AlunoFrequencia[] = [
    {
      cgm: "101",
      nome: "ALUNO FREQUENTE",
      turmas: ["6º Ano A"],
      idade: 12,
      situacao: "Matriculado",
      presencaSemanaAtual: 100,
      presencaSemanaAnterior: 100,
      presencaGeral: 95,
      amparoLegal: null
    },
    {
      cgm: "102",
      nome: "ALUNO CRITICO LEI",
      turmas: ["7º Ano B"],
      idade: 13,
      situacao: "Matriculado",
      presencaSemanaAtual: 40,
      presencaSemanaAnterior: 50,
      presencaGeral: 65, // < 75%
      amparoLegal: null
    },
    {
      cgm: "103",
      nome: "ALUNO QUEDA SEVERA",
      turmas: ["8º Ano C"],
      idade: 14,
      situacao: "Matriculado",
      presencaSemanaAtual: 20, // ausência severa na semana recente
      presencaSemanaAnterior: 80,
      presencaGeral: 78,
      amparoLegal: null
    }
  ];

  const contatosMap = new Map<string, ContatoResponsavel[]>([
    [
      "102",
      [
        {
          cgm: "102",
          responsavel: "MÃE TESTE",
          telefone: "5545999991111",
          email: null,
          consentimento: true,
          linha: 2
        }
      ]
    ]
  ]);

  const casos = identificarCasosOrgaosCompetentes(alunos, contatosMap, 75);

  assert.equal(casos.length, 2);
  assert.equal(casos[0]!.aluno.cgm, "102"); // menor frequencia primeiro
  assert.match(casos[0]!.motivos[0]!, /abaixo do teto legal de 75%/);
  assert.equal(casos[0]!.contatos.length, 1);
  assert.equal(casos[0]!.contatos[0]!.responsavel, "MÃE TESTE");

  assert.equal(casos[1]!.aluno.cgm, "103");
  assert.match(casos[1]!.motivos[0]!, /Ausência severa/);
});

test("gera HTML oficial para notificação ao Conselho Tutelar com fundamentação legal", () => {
  const html = gerarHtmlNotificacaoConselhoTutelar({
    escolaNome: "Colégio Estadual Arthur da Costa e Silva",
    telefoneContato: "(45) 3264-1000",
    municipio: "Medianeira - PR",
    dataGeracao: "29/10/2026",
    alunos: [
      {
        aluno: {
          cgm: "102",
          nome: "MARCOS SILVA",
          turmas: ["7º Ano B"],
          idade: 13,
          situacao: "Matriculado",
          presencaSemanaAtual: 30,
          presencaSemanaAnterior: 50,
          presencaGeral: 62.5,
          amparoLegal: null
        },
        contatos: [
          {
            cgm: "102",
            responsavel: "ANA SILVA",
            telefone: "5545988887777",
            email: null,
            consentimento: true,
            linha: 1
          }
        ],
        motivos: ["Frequência geral em 62,5% (abaixo do teto legal de 75%)"]
      }
    ]
  });

  assert.match(html, /COMUNICAÇÃO DE INFREQUÊNCIA ESCOLAR REITERADA AO CONSELHO TUTELAR/);
  assert.match(html, /Lei nº 9\.394\/1996 \(LDB\)/);
  assert.match(html, /Lei nº 8\.069\/1990 \(ECA\)/);
  assert.match(html, /MARCOS SILVA/);
  assert.match(html, /62,5%/);
  assert.match(html, /ANA SILVA/);
  assert.match(html, /Direção Escolar/);
});
