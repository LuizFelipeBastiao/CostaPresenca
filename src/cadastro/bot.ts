import type { ConfigCadastro } from "../notificacoes/config.js";
import { nomeProprio, turmaLegivel } from "../notificacoes/modelo.js";
import { formatarCodigo, normalizarCodigo, type CadastroStore, type CodigoAluno } from "./store.js";

export interface MensagemRecebida {
  /** wa_id de quem enviou (só dígitos). */
  telefone: string;
  texto: string;
  /** Nome do perfil do WhatsApp, quando disponível. */
  nomePerfil?: string | undefined;
  agora?: Date;
}

export interface ContextoBot {
  store: CadastroStore;
  escola: string;
  cadastro: ConfigCadastro;
}

export type AcaoBot =
  | "ajuda"
  | "cadastrado"
  | "pendente"
  | "ja-cadastrado"
  | "codigo-invalido"
  | "codigo-nao-encontrado"
  | "limite-responsaveis"
  | "bloqueado"
  | "removido"
  | "nada-para-remover"
  | "status";

export interface RespostaBot {
  acao: AcaoBot;
  texto: string;
}

const CMD_SAIR = /^(SAIR|PARAR|CANCELAR|DESCADASTRAR|REMOVER|STOP)\b/;
const CMD_STATUS = /^(STATUS|MEUS CADASTROS|MEUS|CADASTROS|SITUACAO)\b/;
const CMD_CADASTRAR = /^(CADASTRAR|CADASTRO|CADASTRA|CODIGO|COD)\b[\s:]*/;

function semAcento(s: string): string {
  return s.normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

/** Só o primeiro nome do aluno nas respostas: quem acertar um código por acaso não vê o nome completo. */
function identificacao(c: CodigoAluno): string {
  const primeiro = nomeProprio(c.aluno).split(" ")[0] ?? "o(a) aluno(a)";
  const turma = c.turma.split(" / ").map(turmaLegivel)[0];
  return turma ? `${primeiro} (${turma})` : primeiro;
}

function ajuda(escola: string): string {
  return (
    `Olá! Este é o canal de avisos de frequência de ${escola}.\n\n` +
    `Para receber um aviso quando seu filho(a) faltar, envie a palavra CADASTRAR seguida do código que está no bilhete da escola. Exemplo:\n` +
    `CADASTRAR K7P-4Q2\n\n` +
    `Outros comandos:\n` +
    `STATUS – ver seus cadastros\n` +
    `SAIR – parar de receber avisos`
  );
}

/**
 * Processa uma mensagem recebida e devolve o texto de resposta.
 * Todo o efeito colateral fica na base de cadastros.
 */
export function processarMensagem(msg: MensagemRecebida, ctx: ContextoBot): RespostaBot {
  const agora = msg.agora ?? new Date();
  const texto = semAcento(msg.texto ?? "").toUpperCase().trim();
  const { store, escola, cadastro } = ctx;

  if (CMD_SAIR.test(texto)) {
    const removidos = store.atualizar((base) => {
      const meus = base.vinculos.filter((v) => v.telefone === msg.telefone);
      base.vinculos = base.vinculos.filter((v) => v.telefone !== msg.telefone);
      return meus.map((v) => base.codigos.find((c) => c.cgm === v.cgm)).filter((c): c is CodigoAluno => !!c);
    });
    if (removidos.length === 0) {
      return { acao: "nada-para-remover", texto: "Este número não tem nenhum cadastro de avisos." };
    }
    return {
      acao: "removido",
      texto:
        `Pronto. Você não vai mais receber avisos de falta de ${removidos.map(identificacao).join(", ")}.\n` +
        `Se quiser voltar, envie CADASTRAR e o código do bilhete.`
    };
  }

  if (CMD_STATUS.test(texto)) {
    const base = store.ler();
    const meus = base.vinculos.filter((v) => v.telefone === msg.telefone);
    if (meus.length === 0) {
      return { acao: "status", texto: `Este número ainda não tem cadastro.\n\n${ajuda(escola)}` };
    }
    const linhas = meus.map((v) => {
      const c = base.codigos.find((x) => x.cgm === v.cgm);
      const quem = c ? identificacao(c) : "aluno(a)";
      return `• ${quem}: ${v.status === "ativo" ? "recebendo avisos" : "aguardando confirmação da escola"}`;
    });
    return { acao: "status", texto: `Seus cadastros:\n${linhas.join("\n")}\n\nEnvie SAIR para parar de receber.` };
  }

  // Procura um código na mensagem (com ou sem a palavra CADASTRAR).
  const temComando = CMD_CADASTRAR.test(texto);
  const resto = texto.replace(CMD_CADASTRAR, "");
  // Primeiro trecho "XXX-XXX"/"XXXXXX" que seja um código válido (pula palavras como "BOM DIA").
  let codigo: string | null = null;
  for (const m of ` ${resto}`.matchAll(/(?<=^|[^A-Z0-9])([A-Z0-9]{3})[\s\-.]?([A-Z0-9]{3})(?=$|[^A-Z0-9])/g)) {
    codigo = normalizarCodigo(`${m[1]}${m[2]}`);
    if (codigo) break;
  }

  if (!codigo) {
    if (temComando) {
      return {
        acao: "codigo-invalido",
        texto:
          "Não encontrei o código na sua mensagem. Ele tem 6 letras/números, como no exemplo:\nCADASTRAR K7P-4Q2\n\n" +
          "Se perdeu o bilhete, peça um novo na secretaria."
      };
    }
    return { acao: "ajuda", texto: ajuda(escola) };
  }

  return store.atualizar((base): RespostaBot => {
    const desde = agora.getTime() - 86_400_000;
    const erros = base.tentativasErradas.filter(
      (t) => t.telefone === msg.telefone && new Date(t.em).getTime() >= desde
    ).length;
    if (erros >= cadastro.maxTentativasErradasPorDia) {
      return {
        acao: "bloqueado",
        texto: "Muitas tentativas com código errado. Tente de novo amanhã ou procure a secretaria da escola."
      };
    }

    const aluno = base.codigos.find((c) => c.codigo === codigo);
    if (!aluno) {
      base.tentativasErradas.push({ telefone: msg.telefone, em: agora.toISOString() });
      const restantes = cadastro.maxTentativasErradasPorDia - erros - 1;
      return {
        acao: "codigo-nao-encontrado",
        texto:
          `O código ${formatarCodigo(codigo)} não foi encontrado. Confira as letras e números no bilhete` +
          (restantes > 0 ? ` (restam ${restantes} tentativa${restantes > 1 ? "s" : ""} hoje).` : ".")
      };
    }

    const existente = base.vinculos.find((v) => v.telefone === msg.telefone && v.cgm === aluno.cgm);
    if (existente) {
      return {
        acao: "ja-cadastrado",
        texto:
          existente.status === "ativo"
            ? `Este número já recebe os avisos de ${identificacao(aluno)}.`
            : `Seu cadastro para ${identificacao(aluno)} já foi recebido e aguarda confirmação da escola.`
      };
    }

    const doAluno = base.vinculos.filter((v) => v.cgm === aluno.cgm).length;
    if (doAluno >= cadastro.maxResponsaveisPorAluno) {
      return {
        acao: "limite-responsaveis",
        texto: `${identificacao(aluno)} já tem ${doAluno} responsáveis cadastrados, que é o máximo. Procure a secretaria se precisar trocar algum número.`
      };
    }

    const status = cadastro.aprovacaoManual ? "pendente" : "ativo";
    base.vinculos.push({
      telefone: msg.telefone,
      cgm: aluno.cgm,
      responsavel: (msg.nomePerfil ?? "").trim().slice(0, 80),
      status,
      criadoEm: agora.toISOString(),
      ...(status === "ativo" ? { aprovadoEm: agora.toISOString() } : {})
    });

    if (status === "pendente") {
      return {
        acao: "pendente",
        texto: `Recebemos seu cadastro para ${identificacao(aluno)}. Assim que a escola confirmar, os avisos de falta começam a chegar aqui.`
      };
    }
    return {
      acao: "cadastrado",
      texto:
        `Cadastro feito! ✅ A partir de agora você recebe aqui os avisos de falta de ${identificacao(aluno)}, de ${escola}.\n\n` +
        `Tem mais filhos na escola? Envie o código de cada um.\nPara parar de receber, envie SAIR.`
    };
  });
}
