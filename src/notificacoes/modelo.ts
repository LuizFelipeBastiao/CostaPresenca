/** Variáveis aceitas em {chaves} nos modelos de mensagem. */
export const VARIAVEIS_MODELO = [
  "responsavel",
  "aluno",
  "primeiroNome",
  "turma",
  "escola",
  "telefoneEscola",
  "presencaSemana",
  "presencaSemanaAnterior",
  "presencaGeral",
  "dataReferencia"
] as const;

export type VariavelModelo = (typeof VARIAVEIS_MODELO)[number];
export type ValoresModelo = Record<VariavelModelo, string>;

/** Lista variáveis desconhecidas usadas no modelo (erro de digitação na configuração). */
export function variaveisDesconhecidas(modelo: string): string[] {
  const usadas = [...modelo.matchAll(/\{([A-Za-z]+)\}/g)].map((m) => m[1]!);
  return [...new Set(usadas.filter((v) => !(VARIAVEIS_MODELO as readonly string[]).includes(v)))];
}

export function renderizar(modelo: string, valores: ValoresModelo): string {
  return modelo.replace(/\{([A-Za-z]+)\}/g, (inteiro, chave: string) =>
    chave in valores ? valores[chave as VariavelModelo] : inteiro
  );
}

/** "MARIA DA SILVA SOUZA" → "Maria da Silva Souza" */
export function nomeProprio(nome: string): string {
  const minusculas = new Set(["da", "de", "do", "das", "dos", "e"]);
  return nome
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((p, i) => (i > 0 && minusculas.has(p) ? p : p.charAt(0).toUpperCase() + p.slice(1)))
    .join(" ");
}

/** "6º Série C Tarde - 2612125" → "6º Série C Tarde" (remove o código interno da turma). */
export function turmaLegivel(turma: string): string {
  return turma.replace(/\s*-\s*\d{5,}\s*$/, "").trim();
}
