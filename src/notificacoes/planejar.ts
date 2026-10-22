import type { Canal, NotificacoesConfig } from "./config.js";
import type { ContatoResponsavel } from "./contatos.js";
import { hashDestino, type HistoricoEnvios } from "./historico.js";
import { nomeProprio, renderizar, turmaLegivel, type ValoresModelo } from "./modelo.js";
import { formatarPercentual } from "./percentual.js";
import type { AlunoFrequencia } from "./presenca.js";
import { avaliarAluno, type MotivoIgnorado, type SemanaReferencia, type TipoAviso } from "./regras.js";
import { destinoParaCanal } from "./senders/index.js";

export type StatusPlano = "pronto" | "sem-contato" | "sem-consentimento" | "sem-destino-no-canal" | "ja-notificado";

export interface ItemPlano {
  status: StatusPlano;
  aluno: AlunoFrequencia;
  tipo: TipoAviso;
  presencaSemana: number;
  contato: ContatoResponsavel | null;
  destino: string | null;
  assunto: string;
  texto: string;
  valores: ValoresModelo;
}

export interface Plano {
  itens: ItemPlano[];
  totalAlunos: number;
  ignorados: Record<MotivoIgnorado, number>;
}

export function montarValores(
  aluno: AlunoFrequencia,
  contato: ContatoResponsavel | null,
  presencaSemana: number,
  config: NotificacoesConfig,
  semana: SemanaReferencia
): ValoresModelo {
  const nome = nomeProprio(aluno.nome);
  return {
    responsavel: contato?.responsavel ? nomeProprio(contato.responsavel) : "responsável",
    aluno: nome,
    primeiroNome: nome.split(" ")[0] ?? nome,
    turma: aluno.turmas.map(turmaLegivel).join(" / ") || "turma não informada",
    escola: config.escola.nome,
    telefoneEscola: config.escola.telefoneContato || "a secretaria da escola",
    presencaSemana: formatarPercentual(presencaSemana),
    presencaSemanaAnterior: formatarPercentual(aluno.presencaSemanaAnterior),
    presencaGeral: formatarPercentual(aluno.presencaGeral, 1),
    dataReferencia: semana.rotulo
  };
}

/**
 * Decide, sem efeitos colaterais, quem deve receber aviso e por quê.
 * Um item por (aluno com falta × contato). Alunos com falta e sem contato
 * aparecem uma vez com status "sem-contato" para a secretaria completar.
 */
export function planejar(
  alunos: AlunoFrequencia[],
  contatos: Map<string, ContatoResponsavel[]>,
  config: NotificacoesConfig,
  semana: SemanaReferencia,
  canal: Canal,
  historico: HistoricoEnvios | null,
  agora = new Date()
): Plano {
  const ignorados: Record<MotivoIgnorado, number> = {
    "presenca-ok": 0,
    "sem-dado-semana": 0,
    "nao-matriculado": 0,
    "amparo-legal": 0,
    "acima-idade-maxima": 0
  };
  const itens: ItemPlano[] = [];

  for (const aluno of alunos) {
    const decisao = avaliarAluno(aluno, config.regras, semana);
    if (!decisao.notificar) {
      ignorados[decisao.motivo] += 1;
      continue;
    }
    const modelo = decisao.tipo === "critica" ? config.modelos.critica : config.modelos.falta;
    const lista = contatos.get(aluno.cgm) ?? [];

    if (lista.length === 0) {
      const valores = montarValores(aluno, null, decisao.presencaSemana, config, semana);
      itens.push({
        status: "sem-contato",
        aluno,
        tipo: decisao.tipo,
        presencaSemana: decisao.presencaSemana,
        contato: null,
        destino: null,
        assunto: renderizar(config.modelos.assunto, valores),
        texto: renderizar(modelo, valores),
        valores
      });
      continue;
    }

    for (const contato of lista) {
      const valores = montarValores(aluno, contato, decisao.presencaSemana, config, semana);
      const destino = destinoParaCanal(canal, contato);
      let status: StatusPlano = "pronto";
      if (config.exigirConsentimento && !contato.consentimento) status = "sem-consentimento";
      else if (!destino) status = "sem-destino-no-canal";
      else if (historico?.jaNotificado(aluno.cgm, hashDestino(destino), semana.chave, config.janelaReenvioDias, agora))
        status = "ja-notificado";

      itens.push({
        status,
        aluno,
        tipo: decisao.tipo,
        presencaSemana: decisao.presencaSemana,
        contato,
        destino,
        assunto: renderizar(config.modelos.assunto, valores),
        texto: renderizar(modelo, valores),
        valores
      });
    }
  }

  // Casos críticos primeiro, depois menor presença: se o limite por execução
  // cortar a fila, os mais urgentes já foram avisados.
  itens.sort((a, b) => {
    if (a.tipo !== b.tipo) return a.tipo === "critica" ? -1 : 1;
    return a.presencaSemana - b.presencaSemana;
  });
  return { itens, totalAlunos: alunos.length, ignorados };
}
