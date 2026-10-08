import type { ColunasContatos } from "./config.js";
import { indiceColuna, normalizarNome, type CsvTabela } from "./csv.js";
import { normalizarCgm } from "./faltas.js";

export interface ContatoResponsavel {
  cgm: string;
  aluno: string;
  responsavel: string;
  telefone?: string;
  email?: string;
}

const NEGATIVOS = new Set(["nao", "n", "false", "0", "no"]);

/** Mantém só dígitos e acrescenta o código do país quando o número vem no formato nacional (DDD + número). */
export function normalizarTelefone(valor: string, codigoPais: string): string | undefined {
  const digitos = valor.replace(/\D/g, "").replace(/^0+/, "");
  if (digitos.length === 10 || digitos.length === 11) return `${codigoPais}${digitos}`;
  if (digitos.length >= 12 && digitos.length <= 15) return digitos;
  return undefined;
}

/**
 * Lê o cadastro de responsáveis. Um aluno pode ter várias linhas (um responsável por linha).
 * Linhas com a coluna de autorização preenchida como "não" são descartadas.
 */
export function lerContatos(
  tabela: CsvTabela,
  colunas: ColunasContatos,
  codigoPais: string
): Map<string, ContatoResponsavel[]> {
  const { headers, rows } = tabela;
  const idx = {
    cgm: indiceColuna(headers, colunas.cgm),
    aluno: indiceColuna(headers, colunas.aluno),
    responsavel: indiceColuna(headers, colunas.responsavel),
    telefone: indiceColuna(headers, colunas.telefone),
    email: indiceColuna(headers, colunas.email),
    autorizado: indiceColuna(headers, colunas.autorizado)
  };
  if (idx.cgm < 0) throw new Error(`Cadastro de contatos sem coluna CGM. Colunas: ${headers.join(", ")}`);
  if (idx.telefone < 0 && idx.email < 0) {
    throw new Error("Cadastro de contatos precisa de uma coluna de telefone ou e-mail");
  }

  const cel = (row: string[], i: number): string => (i >= 0 ? (row[i] ?? "").trim() : "");
  const contatos = new Map<string, ContatoResponsavel[]>();

  for (const row of rows) {
    const cgm = normalizarCgm(cel(row, idx.cgm));
    if (!cgm) continue;
    if (idx.autorizado >= 0 && NEGATIVOS.has(normalizarNome(cel(row, idx.autorizado)))) continue;

    const contato: ContatoResponsavel = {
      cgm,
      aluno: cel(row, idx.aluno),
      responsavel: cel(row, idx.responsavel)
    };
    const telefone = normalizarTelefone(cel(row, idx.telefone), codigoPais);
    if (telefone) contato.telefone = telefone;
    const email = cel(row, idx.email);
    if (email.includes("@")) contato.email = email;
    if (!contato.telefone && !contato.email) continue;

    const lista = contatos.get(cgm) ?? [];
    lista.push(contato);
    contatos.set(cgm, lista);
  }

  return contatos;
}
