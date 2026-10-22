import fs from "node:fs";
import path from "node:path";

export interface CsvTable {
  headers: string[];
  rows: Record<string, string>[];
}

/**
 * Detecta o delimitador olhando apenas a primeira linha.
 * Planilhas salvas em Excel pt-BR costumam usar ";".
 */
export function detectarDelimitador(conteudo: string): string {
  const primeiraLinha = conteudo.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0] ?? "";
  const virgulas = (primeiraLinha.match(/,/g) ?? []).length;
  const pontoVirgulas = (primeiraLinha.match(/;/g) ?? []).length;
  return pontoVirgulas > virgulas ? ";" : ",";
}

/**
 * Parser CSV completo (RFC 4180): aspas, aspas duplicadas, quebras de linha
 * dentro de campos, CRLF e BOM.
 */
export function parseCsv(conteudo: string, delimitador?: string): CsvTable {
  const texto = conteudo.replace(/^\uFEFF/, "");
  const sep = delimitador ?? detectarDelimitador(texto);
  const registros: string[][] = [];
  let linha: string[] = [];
  let campo = "";
  let entreAspas = false;

  for (let i = 0; i < texto.length; i += 1) {
    const ch = texto[i]!;
    if (entreAspas) {
      if (ch === '"') {
        if (texto[i + 1] === '"') {
          campo += '"';
          i += 1;
        } else {
          entreAspas = false;
        }
      } else {
        campo += ch;
      }
      continue;
    }

    if (ch === '"') {
      entreAspas = true;
    } else if (ch === sep) {
      linha.push(campo);
      campo = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && texto[i + 1] === "\n") i += 1;
      linha.push(campo);
      campo = "";
      registros.push(linha);
      linha = [];
    } else {
      campo += ch;
    }
  }
  if (campo.length > 0 || linha.length > 0) {
    linha.push(campo);
    registros.push(linha);
  }

  const naoVazios = registros.filter((r) => !(r.length === 1 && r[0]!.trim() === ""));
  const headers = (naoVazios[0] ?? []).map((h) => h.trim());
  const rows = naoVazios.slice(1).map((celulas) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => {
      obj[h] = (celulas[idx] ?? "").trim();
    });
    return obj;
  });
  return { headers, rows };
}

/** Gera CSV com BOM. Use ";" para arquivos que serão abertos no Excel pt-BR. */
export function paraCsv(headers: string[], rows: string[][], delimitador = ","): string {
  const celula = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const linhas = [headers, ...rows].map((r) => r.map(celula).join(delimitador));
  return `\uFEFF${linhas.join("\r\n")}\r\n`;
}

/** Remove acentos, baixa a caixa e tira espaços/underscores para casar cabeçalhos. */
export function canonico(valor: string): string {
  return valor
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[\s_\-()%.]/g, "");
}

/**
 * Procura a primeira coluna cujo nome canônico bate com algum dos apelidos.
 * Retorna o nome original do cabeçalho ou null.
 */
export function localizarColuna(headers: string[], apelidos: string[]): string | null {
  const alvo = apelidos.map(canonico);
  for (const h of headers) {
    if (alvo.includes(canonico(h))) return h;
  }
  return null;
}

/**
 * Prioriza o ponteiro "<nome>-latest.csv"; na ausência, usa o CSV mais recente
 * por data de modificação dentro do diretório.
 */
export function localizarCsvMaisRecente(diretorio: string, nomeBase: string): string | null {
  const latest = path.join(diretorio, `${nomeBase}-latest.csv`);
  if (fs.existsSync(latest)) return latest;
  if (!fs.existsSync(diretorio)) return null;
  const arquivos = fs
    .readdirSync(diretorio)
    .filter((f) => f.toLowerCase().endsWith(".csv"))
    .map((f) => path.join(diretorio, f));
  if (arquivos.length === 0) return null;
  arquivos.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return arquivos[0]!;
}
