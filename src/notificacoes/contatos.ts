import fs from "node:fs";
import { canonico, localizarColuna, parseCsv } from "./csv.js";
import { normalizarCgm } from "./presenca.js";

export interface ContatoResponsavel {
  cgm: string;
  responsavel: string;
  /** Telefone em formato E.164 sem "+", ex.: 5545999998888. */
  telefone: string | null;
  email: string | null;
  consentimento: boolean;
  /** Linha do CSV (1 = cabeçalho), para mensagens de erro. */
  linha: number;
}

export interface ResultadoContatos {
  contatos: Map<string, ContatoResponsavel[]>;
  avisos: string[];
}

export const COLUNAS_CONTATOS = {
  cgm: ["cgm", "CGM", "Código CGM"],
  aluno: ["aluno", "NomeAluno", "Nome do Aluno", "Estudante"],
  responsavel: ["responsavel", "responsável", "Nome do Responsável", "Nome Responsavel", "Responsável Legal"],
  telefone: ["telefone", "celular", "whatsapp", "fone", "Telefone do Responsável", "Celular do Responsável", "Contato"],
  email: ["email", "e-mail", "E-mail do Responsável"],
  consentimento: ["consentimento", "autorizado", "autoriza", "opt-in", "optin", "aceite"]
} as const;

const VERDADEIRO = new Set(["sim", "s", "x", "1", "true", "verdadeiro", "yes", "y", "ok", "autorizado"]);

export function lerConsentimento(bruto: string | undefined): boolean {
  return VERDADEIRO.has(canonico(bruto ?? ""));
}

/**
 * Normaliza telefone brasileiro para 55 + DDD + número.
 * Aceita "(45) 99999-8888", "045999998888", "+55 45 9 9999-8888" etc.
 * Retorna null se não parecer um telefone válido.
 */
export function normalizarTelefone(bruto: string | undefined): string | null {
  let d = (bruto ?? "").replace(/\D/g, "");
  if (d === "") return null;
  const temDdi = d.startsWith("00") || (d.startsWith("55") && (d.length === 12 || d.length === 13));
  if (temDdi) {
    d = d.replace(/^00/, "");
    if (!d.startsWith("55") || (d.length !== 12 && d.length !== 13)) return null;
  } else {
    d = d.replace(/^0+/, ""); // "045..." (prefixo de longa distância)
    // "0 15 45 99999-8888": código de operadora antes do DDD
    if (d.length === 12 || d.length === 13) d = d.slice(2);
    if (d.length !== 10 && d.length !== 11) return null;
    d = `55${d}`;
  }
  const ddd = Number(d.slice(2, 4));
  if (ddd < 11 || ddd > 99) return null;
  // Celular com 9 dígitos precisa começar com 9.
  if (d.length === 13 && d[4] !== "9") return null;
  return d;
}

export function emailValido(bruto: string | undefined): string | null {
  const e = (bruto ?? "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

/** Mascara para logs: 5545999998888 → +55 45 9****-8888 */
export function mascararTelefone(tel: string): string {
  if (tel.length < 8) return "****";
  return `+${tel.slice(0, 2)} ${tel.slice(2, 4)} ${tel.slice(4, 5)}****-${tel.slice(-4)}`;
}

export function mascararEmail(email: string): string {
  const [u, dominio] = email.split("@");
  if (!u || !dominio) return "****";
  return `${u.slice(0, 2)}***@${dominio}`;
}

/**
 * Lê a planilha de contatos. Pode haver várias linhas por CGM (mais de um
 * responsável) e vários telefones na mesma célula separados por "/", ";" ou "|".
 */
export function lerContatos(conteudo: string): ResultadoContatos {
  const { headers, rows } = parseCsv(conteudo);
  const col = (apelidos: readonly string[]) => localizarColuna(headers, [...apelidos]);
  const cCgm = col(COLUNAS_CONTATOS.cgm);
  const cResp = col(COLUNAS_CONTATOS.responsavel);
  const cTel = col(COLUNAS_CONTATOS.telefone);
  const cEmail = col(COLUNAS_CONTATOS.email);
  const cConsent = col(COLUNAS_CONTATOS.consentimento);

  if (!cCgm) throw new Error(`Planilha de contatos sem coluna CGM. Cabeçalhos: ${headers.join(", ")}`);
  if (!cTel && !cEmail) throw new Error("Planilha de contatos precisa de uma coluna de telefone ou e-mail.");

  const contatos = new Map<string, ContatoResponsavel[]>();
  const avisos: string[] = [];
  const vistos = new Set<string>();

  rows.forEach((row, idx) => {
    const linha = idx + 2;
    const cgm = normalizarCgm(row[cCgm]);
    if (cgm === "") return;
    const responsavel = cResp ? (row[cResp] ?? "").trim() : "";
    // Sem coluna de consentimento: trata como não consentido (o envio é bloqueado
    // se exigirConsentimento=true).
    const consentimento = cConsent ? lerConsentimento(row[cConsent]) : false;
    const email = cEmail ? emailValido(row[cEmail]) : null;
    if (cEmail && row[cEmail]?.trim() && !email) avisos.push(`Linha ${linha}: e-mail inválido ignorado.`);

    const telefonesBrutos = cTel ? (row[cTel] ?? "").split(/[/;|,]| ou /i).filter((t) => t.trim() !== "") : [];
    const telefones: (string | null)[] = [];
    for (const t of telefonesBrutos) {
      const n = normalizarTelefone(t);
      if (n) telefones.push(n);
      else avisos.push(`Linha ${linha}: telefone inválido ignorado ("${t.trim().slice(0, 3)}…").`);
    }
    if (telefones.length === 0) telefones.push(null);

    for (const telefone of telefones) {
      if (!telefone && !email) continue;
      const chave = `${cgm}|${telefone ?? ""}|${email ?? ""}`;
      if (vistos.has(chave)) continue;
      vistos.add(chave);
      const lista = contatos.get(cgm) ?? [];
      lista.push({ cgm, responsavel, telefone, email, consentimento, linha });
      contatos.set(cgm, lista);
    }
  });
  return { contatos, avisos };
}

export function lerContatosArquivo(caminho: string): ResultadoContatos {
  if (!fs.existsSync(caminho)) return { contatos: new Map(), avisos: [`Planilha de contatos não encontrada: ${caminho}`] };
  return lerContatos(fs.readFileSync(caminho, "utf8"));
}
