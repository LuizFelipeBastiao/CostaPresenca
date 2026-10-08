import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const colunasSchema = z.object({
  cgm: z.array(z.string()).default(["cgm", "CGM"]),
  aluno: z.array(z.string()).default(["NomeAluno", "Aluno", "Nome"]),
  turma: z.array(z.string()).default(["Turma"]),
  faltas: z.array(z.string()).default(["Faltas", "Σ Faltas", "Qtd Faltas", "Total Faltas"]),
  presencas: z.array(z.string()).default(["Σ Presenças", "Presenças", "Qtd Presenças"]),
  aulas: z.array(z.string()).default(["Σ Aulas", "Aulas", "Qtd Aulas"]),
  presencaGeral: z.array(z.string()).default(["(%) Presença Aluno MedGeral", "Média Geral de Presença"]),
  presencaSemana: z.array(z.string()).default(["(%) Presença Aluno", "(%) Presença na Semana Atual"])
}).prefault({});

const contatosColunasSchema = z.object({
  cgm: z.array(z.string()).default(["CGM", "cgm"]),
  aluno: z.array(z.string()).default(["Aluno", "NomeAluno"]),
  responsavel: z.array(z.string()).default(["Responsavel", "Responsável", "Nome Responsavel"]),
  telefone: z.array(z.string()).default(["Telefone", "Celular", "WhatsApp"]),
  email: z.array(z.string()).default(["Email", "E-mail"]),
  autorizado: z.array(z.string()).default(["Autorizado", "Autoriza Contato", "Consentimento"])
}).prefault({});

const canalSchema = z.discriminatedUnion("tipo", [
  z.object({ tipo: z.literal("simulacao") }),
  z.object({
    tipo: z.literal("webhook"),
    url: z.string().url(),
    /** Nome da variável de ambiente com o token Bearer (opcional). */
    tokenEnv: z.string().default("NOTIFICACAO_WEBHOOK_TOKEN")
  }),
  z.object({
    tipo: z.literal("whatsapp-cloud"),
    apiVersion: z.string().default("v21.0"),
    tokenEnv: z.string().default("WHATSAPP_TOKEN"),
    phoneNumberIdEnv: z.string().default("WHATSAPP_PHONE_NUMBER_ID"),
    /**
     * Template aprovado na Meta. Sem template, a API só entrega texto livre
     * para quem conversou com a escola nas últimas 24h.
     */
    template: z.string().min(1).optional(),
    idioma: z.string().default("pt_BR"),
    parametros: z.array(z.string()).default(["responsavel", "aluno", "turma", "data"])
  })
]);

const notificacaoConfigSchema = z.object({
  escola: z.string().min(1).default("Colégio Estadual Arthur da Costa e Silva"),
  dataDirectory: z.string().default("data"),
  contatosCsv: z.string().default("data/cadastros/contatos_responsaveis.csv"),
  codigoPaisPadrao: z.string().regex(/^\d{1,3}$/).default("55"),
  /** Queda mínima (em pontos percentuais) para considerar falta quando só há percentuais. */
  toleranciaPercentual: z.number().min(0).default(0.01),
  /** Ignora comparações entre coletas mais distantes que isto (evita avisos tardios). */
  maxDiasEntreColetas: z.number().int().positive().default(4),
  intervaloEnvioMs: z.number().int().min(0).default(1_000),
  mensagem: z.string().min(1).default(
    "Olá, {responsavel}. O {escola} informa que foi registrada ausência de {aluno} ({turma}) " +
    "nas aulas recentes (atualização de {data}). Em caso de dúvida ou para justificar a falta, " +
    "entre em contato com a secretaria da escola."
  ),
  canal: canalSchema.default({ tipo: "simulacao" }),
  colunas: colunasSchema,
  contatosColunas: contatosColunasSchema
});

export type NotificacaoConfig = z.infer<typeof notificacaoConfigSchema>;
export type ColunasPresenca = z.infer<typeof colunasSchema>;
export type ColunasContatos = z.infer<typeof contatosColunasSchema>;
export type CanalConfig = z.infer<typeof canalSchema>;

export function parseNotificacaoConfig(raw: unknown): NotificacaoConfig {
  return notificacaoConfigSchema.parse(raw);
}

export async function loadNotificacaoConfig(configPath?: string): Promise<NotificacaoConfig> {
  const filename = path.resolve(configPath ?? "config/notificacoes.json");
  let raw: unknown = {};
  try {
    raw = JSON.parse(await readFile(filename, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || configPath) throw error;
    console.warn(`[AVISO] ${filename} nao encontrado; usando configuracao padrao (canal: simulacao).`);
  }
  return parseNotificacaoConfig(raw);
}
