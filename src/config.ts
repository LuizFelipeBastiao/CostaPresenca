import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const reportSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  url: z.string().url(),
  visualTitle: z.string().min(1),
  visualAnchorText: z.string().min(1).optional(),
  preClickSelector: z.string().min(1).optional(),
  filters: z.array(z.object({
    label: z.string().min(1),
    value: z.string().min(1)
  })).default([]),
  expectedColumns: z.array(z.string().min(1)).default([]),
  expectedDataRows: z.number().int().positive().optional(),
  extractionMode: z.enum(["auto", "clipboard", "dom", "network"]).default("auto"),
  domZoomSteps: z.number().int().min(0).max(6).default(0),
  outputName: z.string().regex(/^[a-z0-9-]+$/),
  enabled: z.boolean().default(false)
});

const contextSchema = z.object({
  anoLetivo: z.number().int().min(2020).max(2040).default(new Date().getFullYear()),
  periodo: z.string().default("Todos"),
  nre: z.string().default("FOZ DO IGUACU"),
  municipio: z.string().default("MEDIANEIRA"),
  escolaNome: z.string().default("ARTHUR DA COSTA E SILVA"),
  escolaExcluirDefault: z.string().default("ANCHIETA"),
  dataHubDirectory: z.string().default("../DATA_HUB/data")
}).default({
  anoLetivo: new Date().getFullYear(),
  periodo: "Todos",
  nre: "FOZ DO IGUACU",
  municipio: "MEDIANEIRA",
  escolaNome: "ARTHUR DA COSTA E SILVA",
  escolaExcluirDefault: "ANCHIETA",
  dataHubDirectory: "../DATA_HUB/data"
});

const configSchema = z.object({
  allowedHosts: z.array(z.string().min(1)).min(1),
  profileDirectory: z.string().min(1),
  outputDirectory: z.string().min(1),
  artifactDirectory: z.string().min(1),
  diagnostics: z.boolean().default(false),
  maxRows: z.number().int().positive().max(100_000).default(10_000),
  maxScrolls: z.number().int().positive().max(2_000).default(250),
  settleMs: z.number().int().min(250).max(30_000).default(1_500),
  context: contextSchema,
  reports: z.array(reportSchema).min(1)
});

export type AppConfig = z.infer<typeof configSchema>;
export type ReportConfig = z.infer<typeof reportSchema>;
export type SchoolContext = z.infer<typeof contextSchema>;

export async function loadConfig(configPath?: string): Promise<AppConfig> {
  const filename = path.resolve(configPath ?? "config/local.json");
  let rawContent = await readFile(filename, "utf8");

  // Interpolação dinâmica de variáveis de ambiente e padrões
  const ano = process.env.ANO_LETIVO ?? "2026";
  const nre = process.env.NRE ?? "FOZ DO IGUACU";
  const escola = process.env.ESCOLA_NOME ?? "ARTHUR DA COSTA E SILVA";

  rawContent = rawContent
    .replace(/\$\{ANO\}/g, ano)
    .replace(/\$\{NRE\}/g, nre)
    .replace(/\$\{ESCOLA\}/g, escola);

  const parsed: unknown = JSON.parse(rawContent);
  return configSchema.parse(parsed);
}

export function getReport(config: AppConfig, reportId: string): ReportConfig {
  const report = config.reports.find((item) => item.id === reportId);
  if (!report) throw new Error(`Relatorio nao configurado: ${reportId}`);
  return report;
}
