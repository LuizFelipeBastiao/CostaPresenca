import nodemailer, { type Transporter } from "nodemailer";
import type { Canal, NotificacoesConfig } from "../config.js";
import { segredo } from "../config.js";
import type { ContatoResponsavel } from "../contatos.js";
import type { ValoresModelo } from "../modelo.js";

export interface MensagemPreparada {
  destino: string;
  assunto: string;
  texto: string;
  valores: ValoresModelo;
  cgm: string;
  tipo: "falta" | "critica";
}

export interface ResultadoEnvio {
  idMensagem?: string;
}

export interface Sender {
  readonly canal: Canal;
  /** Qual dado do contato este canal usa como destino (telefone ou e-mail). */
  destinoDe(contato: ContatoResponsavel): string | null;
  enviar(msg: MensagemPreparada): Promise<ResultadoEnvio>;
}

/** Permite apontar para um servidor de teste; em produção fica no Graph API da Meta. */
function apiBase(): string {
  return (process.env.WHATSAPP_API_BASE ?? "https://graph.facebook.com").replace(/\/$/, "");
}

/** Destino padrão: telefone, ou e-mail quando não há telefone. */
function telefoneOuEmail(c: ContatoResponsavel): string | null {
  return c.telefone ?? c.email;
}

class DryRunSender implements Sender {
  readonly canal = "dry-run" as const;
  destinoDe = telefoneOuEmail;
  async enviar(): Promise<ResultadoEnvio> {
    return {};
  }
}

/** WhatsApp Business Cloud API (Meta). */
class WhatsAppCloudSender implements Sender {
  readonly canal = "whatsapp-cloud" as const;
  private readonly url: string;
  private readonly token: string;

  constructor(private readonly cfg: NotificacoesConfig["whatsappCloud"]) {
    const phoneNumberId = segredo(cfg.phoneNumberIdEnv);
    this.token = segredo(cfg.tokenEnv);
    this.url = `${apiBase()}/${cfg.apiVersion}/${encodeURIComponent(phoneNumberId)}/messages`;
  }

  destinoDe(c: ContatoResponsavel): string | null {
    return c.telefone;
  }

  async enviar(msg: MensagemPreparada): Promise<ResultadoEnvio> {
    const t = this.cfg.template;
    const corpo = t
      ? {
          messaging_product: "whatsapp",
          to: msg.destino,
          type: "template",
          template: {
            name: t.nome,
            language: { code: t.idioma },
            components:
              t.parametros.length > 0
                ? [
                    {
                      type: "body",
                      parameters: t.parametros.map((p) => ({
                        type: "text",
                        text: (msg.valores as Record<string, string>)[p] ?? ""
                      }))
                    }
                  ]
                : []
          }
        }
      : { messaging_product: "whatsapp", to: msg.destino, type: "text", text: { body: msg.texto } };

    return chamarApiWhatsApp(this.url, this.token, corpo);
  }
}

async function chamarApiWhatsApp(url: string, token: string, corpo: unknown): Promise<ResultadoEnvio> {
  const resposta = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(corpo),
    signal: AbortSignal.timeout(20_000)
  });
  const json = (await resposta.json().catch(() => ({}))) as {
    messages?: { id?: string }[];
    error?: { message?: string; code?: number };
  };
  if (!resposta.ok || json.error) {
    const e = json.error;
    throw new Error(`WhatsApp HTTP ${resposta.status}${e?.code ? ` (código ${e.code})` : ""}: ${e?.message ?? "erro desconhecido"}`);
  }
  const id = json.messages?.[0]?.id;
  return id ? { idMensagem: id } : {};
}

/**
 * Responde com texto livre. Só funciona dentro da janela de 24h após a última
 * mensagem do contato — exatamente o caso das respostas do bot de cadastro.
 */
export async function enviarTextoWhatsApp(
  cfg: NotificacoesConfig["whatsappCloud"],
  destino: string,
  texto: string
): Promise<ResultadoEnvio> {
  const phoneNumberId = segredo(cfg.phoneNumberIdEnv);
  const url = `${apiBase()}/${cfg.apiVersion}/${encodeURIComponent(phoneNumberId)}/messages`;
  return chamarApiWhatsApp(url, segredo(cfg.tokenEnv), {
    messaging_product: "whatsapp",
    to: destino,
    type: "text",
    text: { body: texto }
  });
}

class SmtpSender implements Sender {
  readonly canal = "smtp" as const;
  private readonly transporte: Transporter;
  private readonly from: string;

  constructor(cfg: NonNullable<NotificacoesConfig["smtp"]>) {
    this.from = cfg.from;
    this.transporte = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: { user: segredo(cfg.userEnv), pass: segredo(cfg.passEnv) }
    });
  }

  destinoDe(c: ContatoResponsavel): string | null {
    return c.email;
  }

  async enviar(msg: MensagemPreparada): Promise<ResultadoEnvio> {
    const info = await this.transporte.sendMail({ from: this.from, to: msg.destino, subject: msg.assunto, text: msg.texto });
    return info.messageId ? { idMensagem: String(info.messageId) } : {};
  }
}

/**
 * Webhook genérico: integra com qualquer gateway de SMS/WhatsApp (Z-API,
 * Evolution API, n8n, Twilio via função etc.) que aceite um POST JSON.
 */
class WebhookSender implements Sender {
  readonly canal = "webhook" as const;
  private readonly token: string | undefined;

  constructor(private readonly cfg: NonNullable<NotificacoesConfig["webhook"]>) {
    this.token = process.env[cfg.authHeaderEnv]?.trim() || undefined;
  }

  destinoDe = telefoneOuEmail;

  async enviar(msg: MensagemPreparada): Promise<ResultadoEnvio> {
    const resposta = await fetch(this.cfg.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {})
      },
      body: JSON.stringify({
        destino: msg.destino,
        assunto: msg.assunto,
        mensagem: msg.texto,
        tipo: msg.tipo,
        cgm: msg.cgm
      }),
      signal: AbortSignal.timeout(this.cfg.timeoutMs)
    });
    if (!resposta.ok) {
      const corpo = (await resposta.text().catch(() => "")).slice(0, 200);
      throw new Error(`Webhook HTTP ${resposta.status}: ${corpo}`);
    }
    const json = (await resposta.json().catch(() => ({}))) as { id?: unknown };
    return typeof json.id === "string" ? { idMensagem: json.id } : {};
  }
}

export function criarSender(config: NotificacoesConfig, canal: Canal = config.canal): Sender {
  switch (canal) {
    case "dry-run":
      return new DryRunSender();
    case "whatsapp-cloud":
      return new WhatsAppCloudSender(config.whatsappCloud);
    case "smtp":
      if (!config.smtp) throw new Error('Canal "smtp" exige a seção "smtp".');
      return new SmtpSender(config.smtp);
    case "webhook":
      if (!config.webhook) throw new Error('Canal "webhook" exige a seção "webhook".');
      return new WebhookSender(config.webhook);
  }
}

/** Destino do canal configurado, sem instanciar (para a prévia não exigir segredos). */
export function destinoParaCanal(canal: Canal, c: ContatoResponsavel): string | null {
  if (canal === "whatsapp-cloud") return c.telefone;
  if (canal === "smtp") return c.email;
  return telefoneOuEmail(c);
}
