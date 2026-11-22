import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Peças puras do webhook da WhatsApp Cloud API (Meta), sem rede nem disco,
 * para o servidor do bot (src/bot-whatsapp.ts) e os testes usarem.
 */

export interface MensagemWebhook {
  /** id da mensagem (wamid...), usado para ignorar reentregas da Meta. */
  id: string;
  /** wa_id de quem enviou, só dígitos. */
  telefone: string;
  texto: string;
  nomePerfil?: string | undefined;
  /** Momento em que o pai enviou (campo timestamp da Meta). */
  enviadaEm?: Date | undefined;
  /** phone_number_id do número da escola que recebeu. */
  phoneNumberId?: string | undefined;
}

/**
 * Confere o cabeçalho X-Hub-Signature-256 ("sha256=<hex>"), que a Meta calcula
 * com o App Secret sobre o corpo bruto. Sem isso, qualquer pessoa que descubra
 * a URL do túnel poderia forjar mensagens e cadastrar números.
 */
export function assinaturaValida(corpoBruto: Buffer, cabecalho: string | undefined, appSecret: string): boolean {
  if (!cabecalho || !cabecalho.startsWith("sha256=")) return false;
  const recebida = Buffer.from(cabecalho.slice("sha256=".length), "hex");
  const esperada = createHmac("sha256", appSecret).update(corpoBruto).digest();
  return recebida.length === esperada.length && timingSafeEqual(recebida, esperada);
}

/** Assina um corpo como a Meta faz (usado nos testes e no simulador). */
export function assinar(corpoBruto: Buffer | string, appSecret: string): string {
  return `sha256=${createHmac("sha256", appSecret).update(corpoBruto).digest("hex")}`;
}

/**
 * Handshake do GET que a Meta faz ao salvar a Callback URL:
 * ?hub.mode=subscribe&hub.verify_token=<seu token>&hub.challenge=<eco>.
 * Devolve o challenge quando o token confere, ou null.
 */
export function respostaVerificacao(params: URLSearchParams, verifyToken: string): string | null {
  const modo = params.get("hub.mode");
  const token = params.get("hub.verify_token") ?? "";
  const challenge = params.get("hub.challenge");
  if (modo !== "subscribe" || challenge === null) return null;
  const a = Buffer.from(token);
  const b = Buffer.from(verifyToken);
  return a.length === b.length && timingSafeEqual(a, b) ? challenge : null;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);
const lista = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const texto = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Texto que o pai "disse", conforme o tipo da mensagem. Mídia vira "" (o bot responde com a ajuda). */
function textoDaMensagem(m: Json): string {
  switch (m.type) {
    case "text":
      return texto(obj(m.text)?.body) ?? "";
    case "button":
      return texto(obj(m.button)?.text) ?? texto(obj(m.button)?.payload) ?? "";
    case "interactive": {
      const i = obj(m.interactive);
      return texto(obj(i?.button_reply)?.title) ?? texto(obj(i?.list_reply)?.title) ?? "";
    }
    case "image":
    case "video":
    case "document":
      // Pai que manda foto do bilhete com legenda "CADASTRAR K7P-4Q2".
      return texto(obj(m[m.type])?.caption) ?? "";
    default:
      return "";
  }
}

/**
 * Extrai as mensagens recebidas de um POST do webhook. Ignora o resto do que a
 * Meta manda no mesmo endpoint (status de entrega "sent/delivered/read",
 * mudanças de template etc.).
 */
export function extrairMensagens(payload: unknown): MensagemWebhook[] {
  const raiz = obj(payload);
  if (!raiz || raiz.object !== "whatsapp_business_account") return [];
  const saida: MensagemWebhook[] = [];
  for (const entry of lista(raiz.entry)) {
    for (const change of lista(obj(entry)?.changes)) {
      const c = obj(change);
      if (c?.field !== "messages") continue;
      const value = obj(c.value);
      if (!value) continue;
      const phoneNumberId = texto(obj(value.metadata)?.phone_number_id);
      const nomes = new Map<string, string>();
      for (const contato of lista(value.contacts)) {
        const ct = obj(contato);
        const waId = texto(ct?.wa_id);
        const nome = texto(obj(ct?.profile)?.name);
        if (waId && nome) nomes.set(waId, nome);
      }
      for (const mensagem of lista(value.messages)) {
        const m = obj(mensagem);
        const id = texto(m?.id);
        const de = texto(m?.from)?.replace(/\D/g, "");
        if (!m || !id || !de) continue;
        const ts = Number(texto(m.timestamp));
        saida.push({
          id,
          telefone: de,
          texto: textoDaMensagem(m),
          nomePerfil: nomes.get(de),
          enviadaEm: Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000) : undefined,
          phoneNumberId
        });
      }
    }
  }
  return saida;
}

/**
 * Lembra os ids já processados. A Meta reentrega o mesmo evento quando não
 * recebe 200 a tempo; sem isso, um código errado contaria duas tentativas e o
 * pai receberia duas respostas.
 */
export class Deduplicador {
  private readonly vistos = new Set<string>();

  constructor(private readonly capacidade = 5_000) {}

  /** true na primeira vez que o id aparece. */
  primeiraVez(id: string): boolean {
    if (this.vistos.has(id)) return false;
    this.vistos.add(id);
    if (this.vistos.size > this.capacidade) {
      const maisAntigo = this.vistos.values().next().value;
      if (maisAntigo !== undefined) this.vistos.delete(maisAntigo);
    }
    return true;
  }
}
