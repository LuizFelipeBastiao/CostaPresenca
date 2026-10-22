import fs from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const MODELO_FALTA_PADRAO =
  "Olá, {responsavel}. Esta é uma mensagem de {escola}. Registramos que {aluno} ({turma}) teve presença de {presencaSemana} nas aulas da semana de referência ({dataReferencia}). " +
  "Se houver justificativa, por favor entre em contato com a secretaria: {telefoneEscola}. Contamos com a parceria da família para garantir a frequência escolar.";

const MODELO_CRITICA_PADRAO =
  "Olá, {responsavel}. Esta é uma mensagem de {escola}. Precisamos da sua atenção: {aluno} ({turma}) teve presença de {presencaSemana} na semana de referência ({dataReferencia}) " +
  "e a frequência geral no ano está em {presencaGeral}, abaixo do mínimo legal de 75%. Pedimos que procure a escola com urgência pelo telefone {telefoneEscola} para conversarmos.";

const regrasSchema = z.object({
  /** Dispara aviso quando a presença da semana atual ficou abaixo deste valor (100 = qualquer falta). */
  presencaSemanaAbaixoDe: z.number().min(0).max(100).default(100),
  /** Classifica como crítico quando a média geral do ano está abaixo deste valor. */
  presencaGeralCriticaAbaixoDe: z.number().min(0).max(100).default(75),
  /** Considera apenas matrículas com situação "Matriculado" quando a coluna existir. */
  somenteMatriculados: z.boolean().default(true),
  /**
   * Qual coluna de presença semanal usar: "atual" = "(%) Presença Aluno"
   * (semana em curso, pode estar parcial); "anterior" = "(%) Presença Aluno SemPassada".
   */
  semanaReferencia: z.enum(["atual", "anterior"]).default("atual"),
  /**
   * Não notifica quando o aluno tem Amparo Legal (falta justificada) com data
   * a partir de N dias antes da semana de referência. 0 desliga a regra.
   */
  ignorarAmparoLegalDias: z.number().int().min(0).max(365).default(14),
  /** Quando definido, ignora alunos com idade acima deste valor (ex.: 17 = só menores). */
  idadeMaxima: z.number().int().positive().max(120).optional()
});

const modelosSchema = z.object({
  assunto: z.string().min(1).default("Aviso de frequência escolar - {aluno}"),
  falta: z.string().min(1).default(MODELO_FALTA_PADRAO),
  critica: z.string().min(1).default(MODELO_CRITICA_PADRAO)
});

const whatsappCloudSchema = z.object({
  apiVersion: z.string().regex(/^v\d+\.\d+$/).default("v21.0"),
  phoneNumberIdEnv: z.string().min(1).default("WHATSAPP_PHONE_NUMBER_ID"),
  tokenEnv: z.string().min(1).default("WHATSAPP_TOKEN"),
  /**
   * Mensagens iniciadas pela escola fora da janela de 24h exigem um template
   * aprovado pela Meta. Quando configurado, os parâmetros do corpo são
   * preenchidos na ordem indicada com as variáveis da mensagem.
   */
  template: z
    .object({
      nome: z.string().min(1),
      idioma: z.string().min(2).default("pt_BR"),
      parametros: z.array(z.string().min(1)).default([])
    })
    .optional()
});

const smtpSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().positive().default(587),
  secure: z.boolean().default(false),
  userEnv: z.string().min(1).default("SMTP_USER"),
  passEnv: z.string().min(1).default("SMTP_PASS"),
  from: z.string().min(3)
});

const webhookSchema = z.object({
  url: z.string().url(),
  authHeaderEnv: z.string().min(1).default("WEBHOOK_TOKEN"),
  timeoutMs: z.number().int().positive().max(120_000).default(15_000)
});

const cadastroSchema = z.object({
  /** Base de códigos e vínculos responsável↔aluno feita pelo bot. */
  arquivo: z.string().min(1).default("data/cadastros/cadastros.json"),
  /** Número de WhatsApp da escola, impresso nos bilhetes (ex.: "(45) 99999-0000"). */
  numeroWhatsappEscola: z.string().default(""),
  /** true = cadastro fica "pendente" até a secretaria aprovar. */
  aprovacaoManual: z.boolean().default(false),
  maxResponsaveisPorAluno: z.number().int().positive().max(10).default(3),
  /** Tentativas com código errado por telefone em 24h antes de bloquear. */
  maxTentativasErradasPorDia: z.number().int().positive().max(50).default(5),
  porta: z.number().int().positive().max(65_535).default(3000),
  verifyTokenEnv: z.string().min(1).default("WHATSAPP_VERIFY_TOKEN"),
  appSecretEnv: z.string().min(1).default("WHATSAPP_APP_SECRET")
});

export const CANAIS =["dry-run", "whatsapp-cloud", "smtp", "webhook"] as const;

export const notificacoesConfigSchema = z.object({
  dataDirectory: z.string().min(1).default("data"),
  /** Subpasta de data/ com o CSV nominal de presença. */
  fontePresenca: z.string().regex(/^[a-z0-9-]+$/).default("presente-alunos"),
  contatosCsv: z.string().min(1).default("data/cadastros/contatos_responsaveis.csv"),
  /**
   * De onde vêm os contatos: "cadastros" = só pais que se cadastraram pelo bot;
   * "planilha" = só o CSV manual; "ambos" = união dos dois.
   */
  fonteContatos: z.enum(["cadastros", "planilha", "ambos"]).default("cadastros"),
  cadastro: cadastroSchema.prefault({}),
  /** Pasta onde ficam o histórico de envios (envios.jsonl) e as prévias. */
  saidaDirectory: z.string().min(1).default("data/notificacoes"),
  /** Recusa envio real (--execute) se o CSV de presença for mais antigo que isso. */
  maxIdadeDadosHoras: z.number().int().positive().max(24 * 30).default(48),
  escola: z.object({
    nome: z.string().min(1),
    telefoneContato: z.string().default("")
  }),
  regras: regrasSchema.prefault({}),
  canal: z.enum(CANAIS).default("dry-run"),
  /** Só envia para responsáveis com consentimento registrado (LGPD). */
  exigirConsentimento: z.boolean().default(true),
  /** Não repete aviso para o mesmo responsável/aluno/semana dentro deste prazo. */
  janelaReenvioDias: z.number().int().min(0).max(365).default(7),
  intervaloEntreEnviosMs: z.number().int().min(0).max(60_000).default(1_500),
  maxEnviosPorExecucao: z.number().int().positive().max(5_000).default(300),
  modelos: modelosSchema.prefault({}),
  whatsappCloud: whatsappCloudSchema.prefault({}),
  smtp: smtpSchema.optional(),
  webhook: webhookSchema.optional()
});

export type NotificacoesConfig = z.infer<typeof notificacoesConfigSchema>;
export type RegrasFalta = z.infer<typeof regrasSchema>;
export type ConfigCadastro = z.infer<typeof cadastroSchema>;
export type Canal = (typeof CANAIS)[number];

export const CONFIG_PADRAO = "config/notificacoes.json";
export const CONFIG_EXEMPLO = "config/notificacoes.example.json";

/** Carrega variáveis de .env (sem sobrescrever o ambiente já definido). */
export function carregarEnv(arquivo = ".env"): void {
  const caminho = path.resolve(arquivo);
  if (!fs.existsSync(caminho)) return;
  const loader = (process as unknown as { loadEnvFile?: (p: string) => void }).loadEnvFile;
  if (typeof loader === "function") {
    loader.call(process, caminho);
    return;
  }
  for (const linha of fs.readFileSync(caminho, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(linha);
    if (!m) continue;
    const chave = m[1]!;
    if (process.env[chave] !== undefined) continue;
    process.env[chave] = m[2]!.replace(/^(['"])(.*)\1$/, "$2");
  }
}

export async function carregarConfigNotificacoes(configPath?: string): Promise<NotificacoesConfig> {
  const arquivo = path.resolve(configPath ?? CONFIG_PADRAO);
  if (!fs.existsSync(arquivo)) {
    throw new Error(
      `Configuração não encontrada: ${arquivo}. Copie ${CONFIG_EXEMPLO} para ${CONFIG_PADRAO} e ajuste os valores.`
    );
  }
  const bruto: unknown = JSON.parse(await readFile(arquivo, "utf8"));
  const config = notificacoesConfigSchema.parse(bruto);
  validarCanal(config);
  return config;
}

/** Garante que o canal escolhido tenha a seção de configuração correspondente. */
export function validarCanal(config: NotificacoesConfig): void {
  if (config.canal === "smtp" && !config.smtp) {
    throw new Error('Canal "smtp" exige a seção "smtp" na configuração.');
  }
  if (config.canal === "webhook" && !config.webhook) {
    throw new Error('Canal "webhook" exige a seção "webhook" na configuração.');
  }
}

/** Lê um segredo do ambiente, falhando com mensagem clara se ausente. */
export function segredo(nomeVariavel: string): string {
  const valor = process.env[nomeVariavel];
  if (!valor || valor.trim() === "") {
    throw new Error(`Variável de ambiente obrigatória ausente: ${nomeVariavel} (defina no .env ou no sistema).`);
  }
  return valor.trim();
}
