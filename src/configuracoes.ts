/**
 * Leitura e gravação das configurações editáveis pelo painel (aba Configurações).
 *
 * Só um subconjunto seguro de config/local.json e config/notificacoes.json é
 * exposto. O resto dos arquivos é preservado como está. Segredos do .env nunca
 * são lidos para a tela: o painel mostra apenas se cada variável está preenchida.
 */
import fs from "node:fs";
import path from "node:path";
import { ZodError } from "zod";
import { interpretarConfig } from "./config.js";
import { CANAIS, notificacoesConfigSchema, validarCanal, validarRegras, type Canal } from "./notificacoes/config.js";
import { normalizarTelefone } from "./notificacoes/contatos.js";

export const FONTES_CONTATOS = ["cadastros", "planilha", "ambos"] as const;
type FonteContatos = (typeof FONTES_CONTATOS)[number];

export interface Configuracoes {
  powerbi: {
    escolaNome: string;
    nre: string;
    municipio: string;
    anoLetivo: number;
    presente: { nome: string; url: string; coletaGenerica: boolean };
    /** url vazia = Pré-Conselho não configurado. */
    aprendizagem: { nome: string; url: string };
  };
  escola: { nome: string; telefoneContato: string; numeroWhatsappEscola: string };
  avisos: {
    canal: Canal;
    fonteContatos: FonteContatos;
    exigirConsentimento: boolean;
    quedaMinimaPontos: number;
    presencaGeralCriticaAbaixoDe: number;
    aprovacaoManual: boolean;
  };
}

export interface Situacao {
  arquivos: { localJson: boolean; notificacoesJson: boolean; env: boolean };
  loginPowerBi: boolean;
  ngrok: boolean;
  /** Nome da variável → preenchida ou não. Os valores nunca saem do servidor. */
  segredos: Record<string, boolean>;
  hostsPermitidos: string[];
}

export class ErroConfiguracao extends Error {}

const ID_PRESENTE = "presente-estadual";
const ID_APRENDIZAGEM = "aprendizagem-parana";
const NOME_APRENDIZAGEM_PADRAO = "Aprendizagem Paraná";
const MARCADOR_MODELO = "COLE-AQUI";

interface Caminhos {
  local: string;
  localModelo: string;
  notificacoes: string;
  notificacoesModelo: string;
  env: string;
}

function caminhos(raiz: string): Caminhos {
  return {
    local: path.join(raiz, "config", "local.json"),
    localModelo: path.join(raiz, "config", "reports.example.json"),
    notificacoes: path.join(raiz, "config", "notificacoes.json"),
    notificacoesModelo: path.join(raiz, "config", "notificacoes.example.json"),
    env: path.join(raiz, ".env")
  };
}

type Obj = Record<string, any>;

function lerJson(arquivo: string, modelo: string): Obj {
  const origem = fs.existsSync(arquivo) ? arquivo : modelo;
  if (!fs.existsSync(origem)) return {};
  const texto = fs.readFileSync(origem, "utf8").replace(/^﻿/, "");
  try {
    const obj: unknown = JSON.parse(texto);
    return obj && typeof obj === "object" && !Array.isArray(obj) ? (obj as Obj) : {};
  } catch {
    throw new ErroConfiguracao(`${path.basename(origem)} não é um JSON válido. Corrija o arquivo ou apague-o para recriar a partir do modelo.`);
  }
}

function texto(v: unknown, padrao = ""): string {
  return typeof v === "string" ? v : padrao;
}

function semModelo(url: string): string {
  return url.includes(MARCADOR_MODELO) ? "" : url;
}

function relatorio(local: Obj, id: string): Obj | undefined {
  const lista = Array.isArray(local.reports) ? (local.reports as Obj[]) : [];
  return lista.find((r) => r && r.id === id);
}

/** Valores atuais, com os padrões dos schemas onde o arquivo não diz nada. */
function valoresDe(local: Obj, notif: Obj): Configuracoes {
  let contexto: Obj = {};
  try {
    contexto = interpretarConfig(JSON.stringify(local)).context;
  } catch {
    contexto = local.context ?? {};
  }
  const presente = relatorio(local, ID_PRESENTE) ?? {};
  const aprendizagem = relatorio(local, ID_APRENDIZAGEM);
  const n = notificacoesConfigSchema.safeParse(notif);
  const regras = n.success ? n.data.regras : (notif.regras ?? {});
  const cadastro = n.success ? n.data.cadastro : (notif.cadastro ?? {});
  return {
    powerbi: {
      escolaNome: texto(contexto.escolaNome),
      nre: texto(contexto.nre),
      municipio: texto(contexto.municipio),
      anoLetivo: Number(contexto.anoLetivo) || new Date().getFullYear(),
      presente: {
        nome: texto(presente.name, "2026 Presente Estadual"),
        url: semModelo(texto(presente.url)),
        coletaGenerica: presente.enabled === true
      },
      aprendizagem: {
        nome: texto(aprendizagem?.name, NOME_APRENDIZAGEM_PADRAO),
        url: aprendizagem ? semModelo(texto(aprendizagem.url)) : ""
      }
    },
    escola: {
      nome: texto(notif.escola?.nome),
      telefoneContato: texto(notif.escola?.telefoneContato),
      numeroWhatsappEscola: texto(cadastro.numeroWhatsappEscola)
    },
    avisos: {
      canal: (CANAIS as readonly string[]).includes(notif.canal) ? notif.canal : "dry-run",
      fonteContatos: (FONTES_CONTATOS as readonly string[]).includes(notif.fonteContatos) ? notif.fonteContatos : "cadastros",
      exigirConsentimento: notif.exigirConsentimento !== false,
      quedaMinimaPontos: Number(regras.quedaMinimaPontos ?? 0),
      presencaGeralCriticaAbaixoDe: Number(regras.presencaGeralCriticaAbaixoDe ?? 75),
      aprovacaoManual: cadastro.aprovacaoManual === true
    }
  };
}

function ngrokDisponivel(raiz: string): boolean {
  if (fs.existsSync(path.join(raiz, "ngrok.exe"))) return true;
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    if (fs.existsSync(path.join(dir, "ngrok.exe")) || fs.existsSync(path.join(dir, "ngrok"))) return true;
  }
  return false;
}

export function lerConfiguracoes(raiz: string): { valores: Configuracoes; situacao: Situacao } {
  const c = caminhos(raiz);
  const local = lerJson(c.local, c.localModelo);
  const notif = lerJson(c.notificacoes, c.notificacoesModelo);
  const n = notificacoesConfigSchema.safeParse(notif);
  const nomesSegredos = n.success
    ? [n.data.whatsappCloud.tokenEnv, n.data.whatsappCloud.phoneNumberIdEnv, n.data.cadastro.verifyTokenEnv, n.data.cadastro.appSecretEnv]
    : ["WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_VERIFY_TOKEN", "WHATSAPP_APP_SECRET"];
  const segredos: Record<string, boolean> = {};
  for (const nome of nomesSegredos) segredos[nome] = Boolean(process.env[nome]?.trim());
  return {
    valores: valoresDe(local, notif),
    situacao: {
      arquivos: { localJson: fs.existsSync(c.local), notificacoesJson: fs.existsSync(c.notificacoes), env: fs.existsSync(c.env) },
      loginPowerBi: fs.existsSync(path.resolve(raiz, texto(local.profileDirectory, ".auth/powerbi-profile"))),
      ngrok: ngrokDisponivel(raiz),
      segredos,
      hostsPermitidos: Array.isArray(local.allowedHosts) ? local.allowedHosts.map(String) : []
    }
  };
}

// ---------------------------------------------------------------- validação

function campoTexto(v: unknown, rotulo: string, opcional = false): string {
  if (v !== undefined && typeof v !== "string") throw new ErroConfiguracao(`${rotulo}: valor inválido.`);
  const s = (v ?? "").trim();
  if (s.length > 500) throw new ErroConfiguracao(`${rotulo}: texto longo demais.`);
  if (!opcional && !s) throw new ErroConfiguracao(`${rotulo}: preencha este campo.`);
  return s;
}

function campoNumero(v: unknown, rotulo: string, min: number, max: number, inteiro = false): number {
  const n = typeof v === "number" ? v : Number(String(v ?? "").replace(",", "."));
  if (!Number.isFinite(n) || n < min || n > max || (inteiro && !Number.isInteger(n))) {
    throw new ErroConfiguracao(`${rotulo}: use um número de ${min} a ${max}.`);
  }
  return n;
}

function campoBool(v: unknown, rotulo: string): boolean {
  if (typeof v !== "boolean") throw new ErroConfiguracao(`${rotulo}: valor inválido.`);
  return v;
}

function campoOpcao<T extends string>(v: unknown, opcoes: readonly T[], rotulo: string): T {
  if (typeof v !== "string" || !(opcoes as readonly string[]).includes(v)) throw new ErroConfiguracao(`${rotulo}: opção inválida.`);
  return v as T;
}

function campoUrl(v: unknown, rotulo: string, hosts: string[], opcional: boolean): string {
  const s = campoTexto(v, rotulo, opcional);
  if (!s) return "";
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new ErroConfiguracao(`${rotulo}: cole o endereço completo, começando com https://`);
  }
  if (u.protocol !== "https:") throw new ErroConfiguracao(`${rotulo}: o endereço precisa começar com https://`);
  if (!hosts.includes(u.hostname)) {
    throw new ErroConfiguracao(`${rotulo}: o endereço precisa ser do Power BI (${hosts.join(", ") || "app.powerbi.com"}), não de ${u.hostname}.`);
  }
  if (s.includes(MARCADOR_MODELO)) throw new ErroConfiguracao(`${rotulo}: cole o endereço real do relatório.`);
  return s;
}

function campoTelefone(v: unknown, rotulo: string): string {
  const s = campoTexto(v, rotulo, true);
  if (s && !normalizarTelefone(s)) throw new ErroConfiguracao(`${rotulo}: telefone inválido. Use DDD + número, ex.: (45) 99999-0000.`);
  return s;
}

function objeto(v: unknown, rotulo: string): Obj {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new ErroConfiguracao(`${rotulo}: dados ausentes.`);
  return v as Obj;
}

/** Converte o corpo do POST num Configuracoes validado campo a campo. */
export function validarEntrada(entrada: unknown, hostsPermitidos: string[]): Configuracoes {
  const e = objeto(entrada, "Configurações");
  const p = objeto(e.powerbi, "Power BI");
  const pr = objeto(p.presente, "Presente Estadual");
  const ap = objeto(p.aprendizagem, "Aprendizagem Paraná");
  const es = objeto(e.escola, "Escola");
  const av = objeto(e.avisos, "Avisos");
  const hosts = hostsPermitidos.length ? hostsPermitidos : ["app.powerbi.com"];
  const urlAprendizagem = campoUrl(ap.url, "Endereço do Aprendizagem Paraná", hosts, true);
  return {
    powerbi: {
      escolaNome: campoTexto(p.escolaNome, "Nome da escola no Power BI"),
      nre: campoTexto(p.nre, "NRE"),
      municipio: campoTexto(p.municipio, "Município"),
      anoLetivo: campoNumero(p.anoLetivo, "Ano letivo", 2020, 2040, true),
      presente: {
        nome: campoTexto(pr.nome, "Nome do relatório Presente Estadual"),
        url: campoUrl(pr.url, "Endereço do Presente Estadual", hosts, false),
        coletaGenerica: campoBool(pr.coletaGenerica, "Coleta genérica")
      },
      aprendizagem: {
        nome: urlAprendizagem ? campoTexto(ap.nome, "Nome do relatório Aprendizagem Paraná") : campoTexto(ap.nome, "Nome", true) || NOME_APRENDIZAGEM_PADRAO,
        url: urlAprendizagem
      }
    },
    escola: {
      nome: campoTexto(es.nome, "Nome da escola nas mensagens"),
      telefoneContato: campoTelefone(es.telefoneContato, "Telefone da secretaria"),
      numeroWhatsappEscola: campoTelefone(es.numeroWhatsappEscola, "WhatsApp da escola")
    },
    avisos: {
      canal: campoOpcao(av.canal, CANAIS, "Canal de envio"),
      fonteContatos: campoOpcao(av.fonteContatos, FONTES_CONTATOS, "Origem dos contatos"),
      exigirConsentimento: campoBool(av.exigirConsentimento, "Exigir consentimento"),
      quedaMinimaPontos: campoNumero(av.quedaMinimaPontos, "Queda mínima", 0, 100),
      presencaGeralCriticaAbaixoDe: campoNumero(av.presencaGeralCriticaAbaixoDe, "Frequência crítica", 0, 100),
      aprovacaoManual: campoBool(av.aprovacaoManual, "Aprovação manual")
    }
  };
}

// ---------------------------------------------------------------- gravação

function aplicarLocal(local: Obj, v: Configuracoes["powerbi"]): Obj {
  const novo: Obj = structuredClone(local);
  novo.context = { ...(novo.context ?? {}), escolaNome: v.escolaNome, nre: v.nre, municipio: v.municipio, anoLetivo: v.anoLetivo };
  const lista: Obj[] = Array.isArray(novo.reports) ? novo.reports : [];
  const presente = lista.find((r) => r?.id === ID_PRESENTE);
  if (presente) {
    presente.name = v.presente.nome;
    presente.url = v.presente.url;
    presente.enabled = v.presente.coletaGenerica;
  } else {
    lista.unshift({
      id: ID_PRESENTE,
      name: v.presente.nome,
      url: v.presente.url,
      visualTitle: "Turma",
      visualAnchorText: "Turma",
      filters: [],
      expectedColumns: [],
      extractionMode: "auto",
      domZoomSteps: 0,
      outputName: ID_PRESENTE,
      enabled: v.presente.coletaGenerica
    });
  }
  const iAprendizagem = lista.findIndex((r) => r?.id === ID_APRENDIZAGEM);
  if (!v.aprendizagem.url) {
    // Sem endereço, o Pré-Conselho fica desligado: o CostaPresenca.bat pula a etapa quando o id não existe.
    if (iAprendizagem >= 0) lista.splice(iAprendizagem, 1);
  } else if (iAprendizagem >= 0) {
    lista[iAprendizagem]!.name = v.aprendizagem.nome;
    lista[iAprendizagem]!.url = v.aprendizagem.url;
  } else {
    lista.push({
      id: ID_APRENDIZAGEM,
      name: v.aprendizagem.nome,
      url: v.aprendizagem.url,
      visualTitle: "Mapa de notas",
      filters: [],
      expectedColumns: [],
      extractionMode: "network",
      domZoomSteps: 0,
      outputName: ID_APRENDIZAGEM,
      enabled: false
    });
  }
  novo.reports = lista;
  return novo;
}

function aplicarNotificacoes(notif: Obj, v: Configuracoes): Obj {
  const novo: Obj = structuredClone(notif);
  novo.escola = { ...(novo.escola ?? {}), nome: v.escola.nome, telefoneContato: v.escola.telefoneContato };
  novo.cadastro = { ...(novo.cadastro ?? {}), numeroWhatsappEscola: v.escola.numeroWhatsappEscola, aprovacaoManual: v.avisos.aprovacaoManual };
  novo.canal = v.avisos.canal;
  novo.fonteContatos = v.avisos.fonteContatos;
  novo.exigirConsentimento = v.avisos.exigirConsentimento;
  novo.regras = {
    ...(novo.regras ?? {}),
    quedaMinimaPontos: v.avisos.quedaMinimaPontos,
    presencaGeralCriticaAbaixoDe: v.avisos.presencaGeralCriticaAbaixoDe
  };
  return novo;
}

function mensagemZod(err: unknown, arquivo: string): string {
  if (err instanceof ZodError) {
    const i = err.issues[0];
    return `${arquivo} ficaria inválido (${i?.path.join(".") || "raiz"}: ${i?.message ?? "erro"}). Nada foi salvo.`;
  }
  return `${arquivo}: ${err instanceof Error ? err.message : String(err)} Nada foi salvo.`;
}

/** Grava com cópia de segurança (.bak) e troca atômica, para não deixar arquivo pela metade. */
function gravar(arquivo: string, obj: Obj): void {
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  if (fs.existsSync(arquivo)) fs.copyFileSync(arquivo, `${arquivo}.bak`);
  const tmp = `${arquivo}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, arquivo);
}

const ROTULOS: Array<[string, (c: Configuracoes) => unknown]> = [
  ["Nome da escola no Power BI", (c) => c.powerbi.escolaNome],
  ["NRE", (c) => c.powerbi.nre],
  ["Município", (c) => c.powerbi.municipio],
  ["Ano letivo", (c) => c.powerbi.anoLetivo],
  ["Presente Estadual (nome)", (c) => c.powerbi.presente.nome],
  ["Presente Estadual (endereço)", (c) => c.powerbi.presente.url],
  ["Coleta genérica", (c) => c.powerbi.presente.coletaGenerica],
  ["Aprendizagem Paraná (nome)", (c) => (c.powerbi.aprendizagem.url ? c.powerbi.aprendizagem.nome : "")],
  ["Aprendizagem Paraná (endereço)", (c) => c.powerbi.aprendizagem.url],
  ["Nome da escola nas mensagens", (c) => c.escola.nome],
  ["Telefone da secretaria", (c) => c.escola.telefoneContato],
  ["WhatsApp da escola", (c) => c.escola.numeroWhatsappEscola],
  ["Canal de envio", (c) => c.avisos.canal],
  ["Origem dos contatos", (c) => c.avisos.fonteContatos],
  ["Exigir consentimento", (c) => c.avisos.exigirConsentimento],
  ["Queda mínima", (c) => c.avisos.quedaMinimaPontos],
  ["Frequência crítica", (c) => c.avisos.presencaGeralCriticaAbaixoDe],
  ["Aprovação manual", (c) => c.avisos.aprovacaoManual]
];

/**
 * Valida tudo antes de gravar qualquer arquivo: ou os dois arquivos mudam, ou nenhum.
 * Devolve os rótulos dos campos que mudaram.
 */
export function salvarConfiguracoes(raiz: string, entrada: unknown): { alterados: string[] } {
  const c = caminhos(raiz);
  const local = lerJson(c.local, c.localModelo);
  const notif = lerJson(c.notificacoes, c.notificacoesModelo);
  const hosts = Array.isArray(local.allowedHosts) ? local.allowedHosts.map(String) : [];
  const v = validarEntrada(entrada, hosts);
  const antes = valoresDe(local, notif);

  const novoLocal = aplicarLocal(local, v.powerbi);
  const novoNotif = aplicarNotificacoes(notif, v);
  try {
    interpretarConfig(JSON.stringify(novoLocal));
  } catch (err) {
    throw new ErroConfiguracao(mensagemZod(err, "config/local.json"));
  }
  try {
    const n = notificacoesConfigSchema.parse(novoNotif);
    validarCanal(n);
    validarRegras(n);
  } catch (err) {
    throw new ErroConfiguracao(mensagemZod(err, "config/notificacoes.json"));
  }

  const depois = valoresDe(novoLocal, novoNotif);
  const alterados = ROTULOS.filter(([, f]) => f(antes) !== f(depois)).map(([r]) => r);
  const mudouLocal = JSON.stringify(novoLocal) !== JSON.stringify(local) || !fs.existsSync(c.local);
  const mudouNotif = JSON.stringify(novoNotif) !== JSON.stringify(notif) || !fs.existsSync(c.notificacoes);
  if (mudouLocal) gravar(c.local, novoLocal);
  if (mudouNotif) gravar(c.notificacoes, novoNotif);
  return { alterados };
}
