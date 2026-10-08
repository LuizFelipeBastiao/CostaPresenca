import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { CanalConfig } from "./config.js";
import type { ContatoResponsavel } from "./contatos.js";
import type { VariaveisMensagem } from "./mensagem.js";

export interface EnvioMensagem {
  contato: ContatoResponsavel;
  texto: string;
  variaveis: VariaveisMensagem;
}

export interface Canal {
  nome: string;
  enviar(envio: EnvioMensagem): Promise<void>;
}

function env(nome: string): string {
  const valor = process.env[nome];
  if (!valor) throw new Error(`Variavel de ambiente ${nome} nao definida`);
  return valor;
}

async function verificarResposta(resposta: Response, canal: string): Promise<void> {
  if (resposta.ok) return;
  const corpo = (await resposta.text()).slice(0, 500);
  throw new Error(`${canal} respondeu HTTP ${resposta.status}: ${corpo}`);
}

/** Não envia nada: grava as mensagens em data/notificacoes/<data>/caixa-de-saida.jsonl para conferência. */
export function canalSimulacao(diretorioSaida: string): Canal {
  return {
    nome: "simulacao",
    async enviar({ contato, texto }) {
      await mkdir(diretorioSaida, { recursive: true });
      const linha = { cgm: contato.cgm, telefone: contato.telefone, email: contato.email, texto };
      await appendFile(path.join(diretorioSaida, "caixa-de-saida.jsonl"), `${JSON.stringify(linha)}\n`, "utf8");
    }
  };
}

/** POST JSON para um gateway próprio (n8n, Evolution API, Zenvia, Twilio via proxy etc.). */
export function canalWebhook(config: Extract<CanalConfig, { tipo: "webhook" }>): Canal {
  const token = process.env[config.tokenEnv];
  return {
    nome: "webhook",
    async enviar({ contato, texto, variaveis }) {
      const resposta = await fetch(config.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify({
          telefone: contato.telefone ?? null,
          email: contato.email ?? null,
          mensagem: texto,
          cgm: contato.cgm,
          ...variaveis
        }),
        signal: AbortSignal.timeout(30_000)
      });
      await verificarResposta(resposta, "Webhook");
    }
  };
}

/** WhatsApp Business Cloud API (Meta). */
export function canalWhatsAppCloud(config: Extract<CanalConfig, { tipo: "whatsapp-cloud" }>): Canal {
  const token = env(config.tokenEnv);
  const phoneNumberId = env(config.phoneNumberIdEnv);
  const url = `https://graph.facebook.com/${config.apiVersion}/${phoneNumberId}/messages`;

  return {
    nome: "whatsapp-cloud",
    async enviar({ contato, texto, variaveis }) {
      if (!contato.telefone) throw new Error("Contato sem telefone");
      const conteudo = config.template
        ? {
            type: "template",
            template: {
              name: config.template,
              language: { code: config.idioma },
              components: [{
                type: "body",
                parameters: config.parametros.map((p) => ({ type: "text", text: variaveis[p] || "-" }))
              }]
            }
          }
        : { type: "text", text: { body: texto } };

      const resposta = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ messaging_product: "whatsapp", to: contato.telefone, ...conteudo }),
        signal: AbortSignal.timeout(30_000)
      });
      await verificarResposta(resposta, "WhatsApp Cloud API");
    }
  };
}

export function criarCanal(config: CanalConfig, diretorioSaida: string): Canal {
  switch (config.tipo) {
    case "simulacao":
      return canalSimulacao(diretorioSaida);
    case "webhook":
      return canalWebhook(config);
    case "whatsapp-cloud":
      return canalWhatsAppCloud(config);
  }
}
