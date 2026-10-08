import type { ContatoResponsavel } from "./contatos.js";
import type { FaltaDetectada } from "./faltas.js";

export type VariaveisMensagem = Record<string, string>;

const PARTICULAS = new Set(["da", "de", "do", "das", "dos", "e"]);

export function capitalizar(nome: string): string {
  return nome
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((p, i) => (i > 0 && PARTICULAS.has(p) ? p : p[0]!.toUpperCase() + p.slice(1)))
    .join(" ");
}

export function formatarDataBr(data: string): string {
  const [ano, mes, dia] = data.split("-");
  return `${dia}/${mes}/${ano}`;
}

export function variaveisMensagem(
  falta: FaltaDetectada,
  contato: ContatoResponsavel,
  escola: string,
  dataReferencia: string
): VariaveisMensagem {
  const aluno = capitalizar(falta.aluno || contato.aluno);
  return {
    escola,
    aluno,
    primeiroNome: aluno.split(" ")[0] ?? aluno,
    turma: falta.turma,
    responsavel: contato.responsavel ? capitalizar(contato.responsavel) : "responsável",
    data: formatarDataBr(dataReferencia),
    faltas: falta.novasFaltas !== undefined ? String(falta.novasFaltas) : "",
    presencaGeral: falta.presencaGeral !== undefined ? `${falta.presencaGeral.toFixed(1).replace(".", ",")}%` : ""
  };
}

/** Substitui {variavel} pelo valor correspondente; variáveis desconhecidas ficam como estão. */
export function renderizarMensagem(modelo: string, variaveis: VariaveisMensagem): string {
  return modelo.replace(/\{(\w+)\}/g, (trecho, nome: string) => variaveis[nome] ?? trecho);
}
