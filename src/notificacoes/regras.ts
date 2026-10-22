import { canonico } from "./csv.js";
import type { RegrasFalta } from "./config.js";
import type { AlunoFrequencia } from "./presenca.js";

export type TipoAviso = "falta" | "critica";

export interface SemanaReferencia {
  /** Segunda-feira da semana (UTC, 00:00). */
  inicio: Date;
  /** Sexta-feira da semana, ou o dia da coleta se a semana ainda está em curso. */
  fim: Date;
  /** Chave ISO, ex.: "2026-W43". Usada para não repetir aviso. */
  chave: string;
  /** Texto para a mensagem, ex.: "19/10 a 22/10". */
  rotulo: string;
}

export type Decisao =
  | { notificar: true; tipo: TipoAviso; presencaSemana: number }
  | { notificar: false; motivo: MotivoIgnorado };

export type MotivoIgnorado =
  | "presenca-ok"
  | "sem-dado-semana"
  | "nao-matriculado"
  | "amparo-legal"
  | "acima-idade-maxima";

const DIA = 86_400_000;

function inicioDoDiaUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function ddmm(d: Date): string {
  return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Semana ISO 8601 (segunda a domingo) no formato AAAA-Www. */
export function chaveSemanaIso(d: Date): string {
  const data = inicioDoDiaUtc(d);
  const diaSemana = data.getUTCDay() || 7;
  data.setUTCDate(data.getUTCDate() + 4 - diaSemana); // quinta da mesma semana
  const ano = data.getUTCFullYear();
  const semana = Math.ceil(((data.getTime() - Date.UTC(ano, 0, 1)) / DIA + 1) / 7);
  return `${ano}-W${String(semana).padStart(2, "0")}`;
}

/**
 * Calcula a semana letiva de referência a partir da data da coleta.
 * Datas em UTC para não depender do fuso da máquina; a coleta já grava
 * a data local de São Paulo, então só o dia importa.
 */
export function semanaDeReferencia(dataColeta: Date, qual: "atual" | "anterior"): SemanaReferencia {
  const dia = inicioDoDiaUtc(dataColeta);
  const diaSemana = dia.getUTCDay() || 7; // 1=seg … 7=dom
  let inicio = new Date(dia.getTime() - (diaSemana - 1) * DIA);
  if (qual === "anterior") inicio = new Date(inicio.getTime() - 7 * DIA);
  const sexta = new Date(inicio.getTime() + 4 * DIA);
  const fim = qual === "atual" && dia.getTime() < sexta.getTime() ? dia : sexta;
  return { inicio, fim, chave: chaveSemanaIso(inicio), rotulo: `${ddmm(inicio)} a ${ddmm(fim)}` };
}

export function avaliarAluno(aluno: AlunoFrequencia, regras: RegrasFalta, semana: SemanaReferencia): Decisao {
  if (regras.somenteMatriculados && aluno.situacao !== null && canonico(aluno.situacao) !== "matriculado") {
    return { notificar: false, motivo: "nao-matriculado" };
  }
  if (regras.idadeMaxima !== undefined && aluno.idade !== null && aluno.idade > regras.idadeMaxima) {
    return { notificar: false, motivo: "acima-idade-maxima" };
  }

  const presenca = regras.semanaReferencia === "atual" ? aluno.presencaSemanaAtual : aluno.presencaSemanaAnterior;
  if (presenca === null) return { notificar: false, motivo: "sem-dado-semana" };
  // Tolerância de arredondamento: "99,999%" do Power BI conta como 100%.
  if (presenca >= regras.presencaSemanaAbaixoDe - 0.005) return { notificar: false, motivo: "presenca-ok" };

  if (regras.ignorarAmparoLegalDias > 0 && aluno.amparoLegal) {
    const limite = semana.inicio.getTime() - regras.ignorarAmparoLegalDias * DIA;
    if (aluno.amparoLegal.getTime() >= limite) return { notificar: false, motivo: "amparo-legal" };
  }

  const critica = aluno.presencaGeral !== null && aluno.presencaGeral < regras.presencaGeralCriticaAbaixoDe;
  return { notificar: true, tipo: critica ? "critica" : "falta", presencaSemana: presenca };
}
