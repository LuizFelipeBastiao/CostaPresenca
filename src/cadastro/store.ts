import fs from "node:fs";
import path from "node:path";
import { randomInt } from "node:crypto";

/** Código impresso no bilhete do aluno. Sem 0/O, 1/I/L para evitar confusão. */
export const ALFABETO_CODIGO = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export interface CodigoAluno {
  codigo: string; // "K7P4Q2" (sem hífen; exibido como K7P-4Q2)
  cgm: string;
  aluno: string;
  turma: string;
  criadoEm: string;
}

export type StatusVinculo = "ativo" | "pendente";

export interface Vinculo {
  /** Número exatamente como o WhatsApp informa (wa_id), só dígitos. */
  telefone: string;
  cgm: string;
  /** Nome do perfil do WhatsApp de quem se cadastrou (pode ser vazio). */
  responsavel: string;
  status: StatusVinculo;
  criadoEm: string;
  aprovadoEm?: string;
}

export interface TentativaErrada {
  telefone: string;
  em: string;
}

export interface BaseCadastros {
  versao: 1;
  codigos: CodigoAluno[];
  vinculos: Vinculo[];
  tentativasErradas: TentativaErrada[];
}

export function formatarCodigo(codigo: string): string {
  return `${codigo.slice(0, 3)}-${codigo.slice(3)}`;
}

/** Aceita "k7p-4q2", "K7P 4Q2", "k7p4q2". Retorna null se não for um código válido. */
export function normalizarCodigo(texto: string): string | null {
  const c = texto.toUpperCase().replace(/[\s\-._]/g, "");
  if (c.length !== 6) return null;
  for (const ch of c) if (!ALFABETO_CODIGO.includes(ch)) return null;
  return c;
}

export function gerarCodigo(existentes: Set<string>): string {
  for (let i = 0; i < 1000; i += 1) {
    let c = "";
    for (let j = 0; j < 6; j += 1) c += ALFABETO_CODIGO[randomInt(ALFABETO_CODIGO.length)];
    if (!existentes.has(c)) return c;
  }
  throw new Error("Não foi possível gerar código único.");
}

function baseVazia(): BaseCadastros {
  return { versao: 1, codigos: [], vinculos: [], tentativasErradas: [] };
}

/**
 * Base em um arquivo JSON. Cada operação relê o arquivo e grava de forma
 * atômica (arquivo temporário + rename), para o bot e os comandos da
 * secretaria poderem rodar ao mesmo tempo sem corromper os dados.
 * Operações são síncronas: dentro de um processo não há intercalação.
 */
export class CadastroStore {
  readonly arquivo: string;

  constructor(arquivo: string) {
    this.arquivo = path.resolve(arquivo);
  }

  ler(): BaseCadastros {
    if (!fs.existsSync(this.arquivo)) return baseVazia();
    const bruto = JSON.parse(fs.readFileSync(this.arquivo, "utf8")) as Partial<BaseCadastros>;
    return {
      versao: 1,
      codigos: bruto.codigos ?? [],
      vinculos: bruto.vinculos ?? [],
      tentativasErradas: bruto.tentativasErradas ?? []
    };
  }

  atualizar<T>(fn: (base: BaseCadastros) => T): T {
    const base = this.ler();
    const resultado = fn(base);
    // Limpa tentativas com mais de 2 dias para o arquivo não crescer.
    const limite = Date.now() - 2 * 86_400_000;
    base.tentativasErradas = base.tentativasErradas.filter((t) => new Date(t.em).getTime() >= limite);
    fs.mkdirSync(path.dirname(this.arquivo), { recursive: true });
    const tmp = `${this.arquivo}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(base, null, 2), "utf8");
    fs.renameSync(tmp, this.arquivo);
    return resultado;
  }

  /** Garante um código para cada aluno informado. Retorna quantos foram criados. */
  garantirCodigos(alunos: { cgm: string; nome: string; turmas: string[] }[]): number {
    return this.atualizar((base) => {
      const porCgm = new Map(base.codigos.map((c) => [c.cgm, c]));
      const usados = new Set(base.codigos.map((c) => c.codigo));
      let criados = 0;
      for (const a of alunos) {
        const turma = a.turmas.join(" / ");
        const existente = porCgm.get(a.cgm);
        if (existente) {
          // mantém nome/turma atualizados (troca de turma no meio do ano)
          existente.aluno = a.nome;
          existente.turma = turma;
          continue;
        }
        const codigo = gerarCodigo(usados);
        usados.add(codigo);
        const novo = { codigo, cgm: a.cgm, aluno: a.nome, turma, criadoEm: new Date().toISOString() };
        base.codigos.push(novo);
        porCgm.set(a.cgm, novo);
        criados += 1;
      }
      return criados;
    });
  }

  /** Invalida o código antigo (bilhete perdido) e cria outro. Vínculos existentes continuam. */
  novoCodigo(cgm: string): CodigoAluno {
    return this.atualizar((base) => {
      const atual = base.codigos.find((c) => c.cgm === cgm);
      if (!atual) throw new Error(`CGM ${cgm} não tem código. Rode "npm run cadastro -- bilhetes" primeiro.`);
      atual.codigo = gerarCodigo(new Set(base.codigos.map((c) => c.codigo)));
      atual.criadoEm = new Date().toISOString();
      return { ...atual };
    });
  }
}
