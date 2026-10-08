export interface CsvTabela {
  headers: string[];
  rows: string[][];
}

/**
 * Parser CSV (RFC 4180) tolerante a BOM, CRLF e quebras de linha dentro de aspas.
 */
export function parseCsv(content: string): CsvTabela {
  const texto = content.replace(/^﻿/, "");
  const linhas: string[][] = [];
  let campo = "";
  let linha: string[] = [];
  let entreAspas = false;

  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (entreAspas) {
      if (c === '"') {
        if (texto[i + 1] === '"') {
          campo += '"';
          i++;
        } else {
          entreAspas = false;
        }
      } else {
        campo += c;
      }
    } else if (c === '"') {
      entreAspas = true;
    } else if (c === ",") {
      linha.push(campo);
      campo = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && texto[i + 1] === "\n") i++;
      linha.push(campo);
      linhas.push(linha);
      linha = [];
      campo = "";
    } else {
      campo += c;
    }
  }
  if (campo.length > 0 || linha.length > 0) {
    linha.push(campo);
    linhas.push(linha);
  }

  const naoVazias = linhas.filter((l) => l.some((v) => v.trim() !== ""));
  const [headers = [], ...rows] = naoVazias;
  return { headers: headers.map((h) => h.trim()), rows };
}

export function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function toCsv(headers: string[], rows: string[][]): string {
  return `﻿${[headers, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

export function normalizarNome(valor: string): string {
  return valor
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Retorna o índice da primeira coluna cujo nome coincide (ignorando acentos e caixa)
 * com algum dos candidatos, ou -1.
 */
export function indiceColuna(headers: string[], candidatos: string[]): number {
  const normalizados = headers.map(normalizarNome);
  for (const candidato of candidatos) {
    const idx = normalizados.indexOf(normalizarNome(candidato));
    if (idx >= 0) return idx;
  }
  return -1;
}
