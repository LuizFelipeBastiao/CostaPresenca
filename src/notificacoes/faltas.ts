import type { ColunasPresenca } from "./config.js";
import { indiceColuna, type CsvTabela } from "./csv.js";

export interface RegistroAluno {
  cgm: string;
  aluno: string;
  turma: string;
  faltas?: number;
  presencaGeral?: number;
  presencaSemana?: number;
}

export type CriterioFalta = "contagem-faltas" | "presenca-geral" | "presenca-semana";

export interface FaltaDetectada {
  cgm: string;
  aluno: string;
  turma: string;
  criterio: CriterioFalta;
  /** Quantidade de faltas novas, quando o CSV traz contagens. */
  novasFaltas?: number;
  presencaGeral?: number;
}

export interface Snapshot {
  data: string; // YYYY-MM-DD
  alunos: Map<string, RegistroAluno>;
}

/** Converte "85,5%", "85.5" ou "0,855" para pontos percentuais (0-100). */
export function parsePercentual(valor: string | undefined): number | undefined {
  if (valor === undefined) return undefined;
  const limpo = valor.replace("%", "").replace(",", ".").trim();
  if (limpo === "") return undefined;
  const num = Number(limpo);
  if (!Number.isFinite(num)) return undefined;
  // Sem "%" e entre 0 e 1: o Power BI devolveu fração decimal.
  return !valor.includes("%") && num > 0 && num <= 1 ? num * 100 : num;
}

export function parseInteiro(valor: string | undefined): number | undefined {
  if (valor === undefined) return undefined;
  const limpo = valor.replace(/\s/g, "").replace(",", ".");
  if (limpo === "") return undefined;
  const num = Number(limpo);
  return Number.isFinite(num) ? num : undefined;
}

export function normalizarCgm(valor: string): string {
  return valor.replace(/\D/g, "").replace(/^0+(?=\d)/, "");
}

export function lerSnapshot(data: string, tabela: CsvTabela, colunas: ColunasPresenca): Snapshot {
  const { headers, rows } = tabela;
  const idx = {
    cgm: indiceColuna(headers, colunas.cgm),
    aluno: indiceColuna(headers, colunas.aluno),
    turma: indiceColuna(headers, colunas.turma),
    faltas: indiceColuna(headers, colunas.faltas),
    presencas: indiceColuna(headers, colunas.presencas),
    aulas: indiceColuna(headers, colunas.aulas),
    presencaGeral: indiceColuna(headers, colunas.presencaGeral),
    presencaSemana: indiceColuna(headers, colunas.presencaSemana)
  };
  if (idx.cgm < 0) {
    throw new Error(`Coluna de CGM nao encontrada no CSV de ${data}. Colunas: ${headers.join(", ")}`);
  }

  const cel = (row: string[], i: number): string | undefined => (i >= 0 ? row[i] : undefined);
  const alunos = new Map<string, RegistroAluno>();

  for (const row of rows) {
    const cgm = normalizarCgm(cel(row, idx.cgm) ?? "");
    if (!cgm) continue;

    let faltas = parseInteiro(cel(row, idx.faltas));
    if (faltas === undefined) {
      const presencas = parseInteiro(cel(row, idx.presencas));
      const aulas = parseInteiro(cel(row, idx.aulas));
      if (presencas !== undefined && aulas !== undefined) faltas = aulas - presencas;
    }
    const presencaGeral = parsePercentual(cel(row, idx.presencaGeral));
    const presencaSemana = parsePercentual(cel(row, idx.presencaSemana));

    const registro: RegistroAluno = {
      cgm,
      aluno: (cel(row, idx.aluno) ?? "").trim(),
      turma: (cel(row, idx.turma) ?? "").trim()
    };
    if (faltas !== undefined) registro.faltas = faltas;
    if (presencaGeral !== undefined) registro.presencaGeral = presencaGeral;
    if (presencaSemana !== undefined) registro.presencaSemana = presencaSemana;
    alunos.set(cgm, registro);
  }

  return { data, alunos };
}

/** Segunda-feira (UTC) da semana da data, no formato YYYY-MM-DD. */
export function inicioDaSemana(data: string): string {
  const d = new Date(`${data}T00:00:00Z`);
  const diaSemana = (d.getUTCDay() + 6) % 7; // 0 = segunda
  d.setUTCDate(d.getUTCDate() - diaSemana);
  return d.toISOString().slice(0, 10);
}

export function diasEntre(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/**
 * Compara duas coletas e devolve os alunos que tiveram falta registrada entre elas.
 *
 * Ordem de preferência dos critérios:
 * 1. Contagem de faltas (ou Σ Aulas - Σ Presenças) aumentou.
 * 2. Percentual geral de presença caiu.
 * 3. Percentual da semana caiu (somente se as duas coletas são da mesma semana).
 *
 * Alunos que não existiam na coleta anterior são ignorados, pois não há base de comparação.
 */
export function detectarFaltas(
  anterior: Snapshot,
  atual: Snapshot,
  toleranciaPercentual: number
): FaltaDetectada[] {
  const mesmaSemana = inicioDaSemana(anterior.data) === inicioDaSemana(atual.data);
  const faltas: FaltaDetectada[] = [];

  for (const [cgm, agora] of atual.alunos) {
    const antes = anterior.alunos.get(cgm);
    if (!antes) continue;

    const base = { cgm, aluno: agora.aluno || antes.aluno, turma: agora.turma || antes.turma };
    const extra = agora.presencaGeral !== undefined ? { presencaGeral: agora.presencaGeral } : {};

    if (agora.faltas !== undefined && antes.faltas !== undefined) {
      const novas = agora.faltas - antes.faltas;
      if (novas > 0) faltas.push({ ...base, ...extra, criterio: "contagem-faltas", novasFaltas: novas });
      continue;
    }

    if (agora.presencaGeral !== undefined && antes.presencaGeral !== undefined) {
      if (antes.presencaGeral - agora.presencaGeral > toleranciaPercentual) {
        faltas.push({ ...base, ...extra, criterio: "presenca-geral" });
      }
      continue;
    }

    if (mesmaSemana && agora.presencaSemana !== undefined && antes.presencaSemana !== undefined) {
      if (antes.presencaSemana - agora.presencaSemana > toleranciaPercentual) {
        faltas.push({ ...base, ...extra, criterio: "presenca-semana" });
      }
    }
  }

  return faltas.sort((a, b) => a.turma.localeCompare(b.turma) || a.aluno.localeCompare(b.aluno));
}
