import path from "node:path";
import { CadastroStore } from "../cadastro/store.js";
import type { NotificacoesConfig } from "./config.js";
import { lerContatosArquivo, type ContatoResponsavel } from "./contatos.js";

export interface ContatosCarregados {
  contatos: Map<string, ContatoResponsavel[]>;
  avisos: string[];
  /** Quantos contatos vieram de cada fonte. */
  origem: { cadastros: number; planilha: number };
}

/**
 * Junta os contatos das fontes configuradas. Cadastros feitos pelo bot já
 * contam como consentimento: foi o próprio responsável quem pediu.
 * Vínculos "pendentes" (aguardando a secretaria) não recebem avisos.
 */
export function carregarContatos(config: NotificacoesConfig, arquivoCadastros?: string): ContatosCarregados {
  const contatos = new Map<string, ContatoResponsavel[]>();
  const avisos: string[] = [];
  const origem = { cadastros: 0, planilha: 0 };

  const adicionar = (c: ContatoResponsavel) => {
    const lista = contatos.get(c.cgm) ?? [];
    const duplicado = lista.some(
      (x) => (c.telefone && x.telefone === c.telefone) || (c.email && x.email === c.email && !c.telefone)
    );
    if (duplicado) return false;
    lista.push(c);
    contatos.set(c.cgm, lista);
    return true;
  };

  if (config.fonteContatos !== "planilha") {
    const store = new CadastroStore(arquivoCadastros ?? config.cadastro.arquivo);
    for (const v of store.ler().vinculos) {
      if (v.status !== "ativo") continue;
      const ok = adicionar({
        cgm: v.cgm,
        responsavel: v.responsavel,
        telefone: v.telefone,
        email: null,
        consentimento: true,
        linha: 0
      });
      if (ok) origem.cadastros += 1;
    }
  }

  if (config.fonteContatos !== "cadastros") {
    const planilha = lerContatosArquivo(path.resolve(config.contatosCsv));
    avisos.push(...planilha.avisos);
    for (const lista of planilha.contatos.values()) {
      for (const c of lista) if (adicionar(c)) origem.planilha += 1;
    }
  }
  return { contatos, avisos, origem };
}
