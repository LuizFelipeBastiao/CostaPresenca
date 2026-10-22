import fs from "node:fs";
import { canonico, localizarColuna, parseCsv } from "./csv.js";
import { parsePercentual } from "./percentual.js";

/** Um aluno do CSV nominal, já consolidado por CGM. */
export interface AlunoFrequencia {
  cgm: string;
  nome: string;
  turmas: string[];
  idade: number | null;
  situacao: string | null;
  /** Percentuais 0..100 ou null quando sem dado. */
  presencaSemanaAtual: number | null;
  presencaSemanaAnterior: number | null;
  presencaGeral: number | null;
  /** Data mais recente de Amparo Legal (falta justificada), se houver. */
  amparoLegal: Date | null;
}

export const COLUNAS_PRESENCA = {
  nome: ["NomeAluno", "Aluno", "Nome do Aluno", "Estudante", "Nome"],
  cgm: ["cgm", "CGM", "Código CGM"],
  turma: ["Turma"],
  idade: ["Idade"],
  situacao: ["descrsituacaomatricula", "Situação Matrícula", "Situação"],
  semanaAtual: ["(%) Presença Aluno", "% Presença Atual", "Presença Semana"],
  semanaAnterior: ["(%) Presença Aluno SemPassada", "% Presença Anterior", "Presença Semana Passada"],
  geral: ["(%) Presença Aluno MedGeral", "% Presença Geral", "Presença Geral"],
  amparo: ["Amparo Legal Aluno Data MAX", "Amparo Legal Data", "Data Amparo Legal"]
} as const;

/**
 * Converte a data do Power BI: epoch em ms ("1789084800000"),
 * "dd/mm/aaaa" ou ISO "aaaa-mm-dd". Retorna null quando vazio/inválido.
 */
export function parseDataPowerBi(bruto: string | undefined): Date | null {
  const texto = (bruto ?? "").trim();
  if (texto === "") return null;
  if (/^\d{11,14}$/.test(texto)) {
    const d = new Date(Number(texto));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const br = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(texto);
  if (br) {
    const d = new Date(Date.UTC(Number(br[3]), Number(br[2]) - 1, Number(br[1])));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(texto);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Menor valor entre dois percentuais, tratando null como "sem dado". */
function minimo(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

function maisRecente(a: Date | null, b: Date | null): Date | null {
  if (a === null) return b;
  if (b === null) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

/**
 * Lê o CSV nominal de presença e consolida linhas repetidas do mesmo CGM
 * (aluno matriculado em mais de uma turma/itinerário). Para presença, fica
 * o menor valor: uma falta em qualquer matrícula já gera aviso.
 */
export function lerPresenca(conteudo: string): AlunoFrequencia[] {
  const { headers, rows } = parseCsv(conteudo);
  const col = (apelidos: readonly string[]) => localizarColuna(headers, [...apelidos]);

  const cNome = col(COLUNAS_PRESENCA.nome);
  const cCgm = col(COLUNAS_PRESENCA.cgm);
  if (!cNome || !cCgm) {
    throw new Error(
      `CSV de presença sem as colunas obrigatórias de aluno e CGM. Cabeçalhos encontrados: ${headers.join(", ")}`
    );
  }
  const cTurma = col(COLUNAS_PRESENCA.turma);
  const cIdade = col(COLUNAS_PRESENCA.idade);
  const cSituacao = col(COLUNAS_PRESENCA.situacao);
  const cAtual = col(COLUNAS_PRESENCA.semanaAtual);
  const cAnterior = col(COLUNAS_PRESENCA.semanaAnterior);
  const cGeral = col(COLUNAS_PRESENCA.geral);
  const cAmparo = col(COLUNAS_PRESENCA.amparo);
  if (!cAtual && !cAnterior) {
    throw new Error("CSV de presença sem coluna de presença semanal (atual ou semana passada).");
  }

  const porCgm = new Map<string, AlunoFrequencia>();
  for (const row of rows) {
    const cgm = normalizarCgm(row[cCgm]);
    if (cgm === "") continue;
    const idadeNum = cIdade ? Number.parseInt(row[cIdade] ?? "", 10) : Number.NaN;
    const atual: AlunoFrequencia = {
      cgm,
      nome: (row[cNome] ?? "").trim(),
      turmas: cTurma && row[cTurma] ? [row[cTurma]!] : [],
      idade: Number.isNaN(idadeNum) ? null : idadeNum,
      situacao: cSituacao ? (row[cSituacao] ?? "").trim() || null : null,
      presencaSemanaAtual: cAtual ? parsePercentual(row[cAtual]) : null,
      presencaSemanaAnterior: cAnterior ? parsePercentual(row[cAnterior]) : null,
      presencaGeral: cGeral ? parsePercentual(row[cGeral]) : null,
      amparoLegal: cAmparo ? parseDataPowerBi(row[cAmparo]) : null
    };

    const existente = porCgm.get(cgm);
    if (!existente) {
      porCgm.set(cgm, atual);
      continue;
    }
    for (const t of atual.turmas) if (!existente.turmas.includes(t)) existente.turmas.push(t);
    existente.presencaSemanaAtual = minimo(existente.presencaSemanaAtual, atual.presencaSemanaAtual);
    existente.presencaSemanaAnterior = minimo(existente.presencaSemanaAnterior, atual.presencaSemanaAnterior);
    existente.presencaGeral = minimo(existente.presencaGeral, atual.presencaGeral);
    existente.amparoLegal = maisRecente(existente.amparoLegal, atual.amparoLegal);
    if (existente.idade === null) existente.idade = atual.idade;
    // Se qualquer linha estiver "Matriculado", o aluno segue ativo.
    if (atual.situacao && canonico(atual.situacao) === "matriculado") existente.situacao = atual.situacao;
  }
  return [...porCgm.values()];
}

export function lerPresencaArquivo(caminho: string): AlunoFrequencia[] {
  return lerPresenca(fs.readFileSync(caminho, "utf8"));
}

/** CGM só com dígitos e sem zeros à esquerda, para casar com a planilha de contatos. */
export function normalizarCgm(bruto: string | undefined): string {
  const digitos = (bruto ?? "").replace(/\D/g, "");
  return digitos.replace(/^0+(?=\d)/, "");
}
