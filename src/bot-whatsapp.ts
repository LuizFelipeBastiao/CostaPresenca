import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { processarMensagem } from "./cadastro/bot.js";
import { CadastroStore } from "./cadastro/store.js";
import { Deduplicador, assinaturaValida, extrairMensagens, respostaVerificacao, type MensagemWebhook } from "./cadastro/webhook.js";
import { carregarConfigNotificacoes, carregarEnv, segredo, type NotificacoesConfig } from "./notificacoes/config.js";
import { mascararTelefone } from "./notificacoes/contatos.js";
import { enviarTextoWhatsApp } from "./notificacoes/senders/index.js";

/**
 * Receptor do webhook da WhatsApp Cloud API para o bot de cadastro dos pais.
 *
 * Roda num processo separado do painel (porta própria, só /webhook e /saude),
 * porque esta porta fica exposta na internet pelo túnel e o painel não pode ficar.
 *
 *   npm run bot                 # responde de verdade pelo WhatsApp
 *   npm run bot -- --simular    # processa e grava, mas só mostra a resposta no terminal
 */

const LIMITE_CORPO = 512 * 1024;

export interface OpcoesBot {
  config: NotificacoesConfig;
  appSecret: string;
  verifyToken: string;
  /** Envia a resposta ao pai. Em produção, enviarTextoWhatsApp. */
  responder: (destino: string, texto: string) => Promise<void>;
  /** phone_number_id da escola: mensagens para outro número da mesma conta são ignoradas. */
  phoneNumberId?: string | undefined;
  /** Arquivo .jsonl com uma linha por mensagem tratada (telefone mascarado, sem o texto). */
  arquivoLog?: string | undefined;
  agora?: () => Date;
}

export interface ServidorBot {
  server: http.Server;
  /** Resolve quando todas as mensagens recebidas até agora foram respondidas. */
  ocioso: () => Promise<void>;
}

function lerCorpoBruto(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const partes: Buffer[] = [];
    let total = 0;
    req.on("data", (p: Buffer) => {
      total += p.length;
      if (total > LIMITE_CORPO) {
        reject(new Error("corpo grande demais"));
        req.destroy();
        return;
      }
      partes.push(p);
    });
    req.on("end", () => resolve(Buffer.concat(partes)));
    req.on("error", reject);
  });
}

function escrever(res: http.ServerResponse, status: number, corpo = ""): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(corpo);
}

export function criarServidorBot(op: OpcoesBot): ServidorBot {
  const store = new CadastroStore(op.config.cadastro.arquivo);
  const dedup = new Deduplicador();
  const agora = op.agora ?? (() => new Date());
  // Uma mensagem por vez: a base é um JSON e a ordem das respostas importa
  // (pai que manda "CADASTRAR ..." e logo depois "STATUS").
  let fila: Promise<void> = Promise.resolve();

  const registrar = (linha: Record<string, unknown>) => {
    const registro = { em: agora().toISOString(), ...linha };
    console.log(
      `[bot] ${registro.em} ${String(linha.telefone ?? "")} ${String(linha.acao ?? linha.evento ?? "")}` +
        (linha.erro ? ` — ERRO: ${String(linha.erro)}` : "")
    );
    if (!op.arquivoLog) return;
    try {
      fs.mkdirSync(path.dirname(op.arquivoLog), { recursive: true });
      fs.appendFileSync(op.arquivoLog, `${JSON.stringify(registro)}\n`, "utf8");
    } catch {
      // log é só auditoria; não derruba o bot
    }
  };

  const tratar = async (m: MensagemWebhook) => {
    const telefone = mascararTelefone(m.telefone);
    let resposta;
    try {
      resposta = processarMensagem(
        { telefone: m.telefone, texto: m.texto, nomePerfil: m.nomePerfil, agora: agora() },
        { store, escola: op.config.escola.nome, cadastro: op.config.cadastro }
      );
    } catch (e) {
      registrar({ telefone, evento: "falha-processar", erro: e instanceof Error ? e.message : String(e) });
      return;
    }
    try {
      await op.responder(m.telefone, resposta.texto);
      registrar({ telefone, acao: resposta.acao });
    } catch (e) {
      // O cadastro já foi gravado; só a resposta falhou (ex.: fora da janela de 24h).
      registrar({ telefone, acao: resposta.acao, erro: e instanceof Error ? e.message : String(e) });
    }
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/saude" && req.method === "GET") return escrever(res, 200, "ok");
    if (url.pathname !== "/webhook") return escrever(res, 404);

    if (req.method === "GET") {
      const challenge = respostaVerificacao(url.searchParams, op.verifyToken);
      if (challenge === null) {
        registrar({ evento: "verificacao-recusada" });
        return escrever(res, 403);
      }
      registrar({ evento: "verificacao-ok" });
      return escrever(res, 200, challenge);
    }

    if (req.method !== "POST") return escrever(res, 405);

    let corpo: Buffer;
    try {
      corpo = await lerCorpoBruto(req);
    } catch {
      return escrever(res, 413);
    }
    if (!assinaturaValida(corpo, req.headers["x-hub-signature-256"] as string | undefined, op.appSecret)) {
      registrar({ evento: "assinatura-invalida" });
      return escrever(res, 401);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(corpo.toString("utf8"));
    } catch {
      return escrever(res, 400);
    }

    // Responde 200 logo: a Meta reenvia se demorar, e a resposta ao pai sai depois.
    escrever(res, 200);

    for (const m of extrairMensagens(payload)) {
      if (op.phoneNumberId && m.phoneNumberId && m.phoneNumberId !== op.phoneNumberId) continue;
      if (!dedup.primeiraVez(m.id)) continue;
      fila = fila.then(() => tratar(m));
    }
  });

  return { server, ocioso: () => fila };
}

function argumento(nome: string): string | undefined {
  const i = process.argv.indexOf(nome);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  carregarEnv();
  const config = await carregarConfigNotificacoes(argumento("--config"));
  const simular = process.argv.includes("--simular");
  const verifyToken = segredo(config.cadastro.verifyTokenEnv);
  const appSecret = segredo(config.cadastro.appSecretEnv);

  let responder: OpcoesBot["responder"];
  if (simular) {
    responder = async (destino, texto) => {
      console.log(`\n[simulação] resposta para ${mascararTelefone(destino)}:\n${texto}\n`);
    };
  } else {
    // Falha já na partida se faltar credencial, em vez de na primeira mensagem.
    segredo(config.whatsappCloud.phoneNumberIdEnv);
    segredo(config.whatsappCloud.tokenEnv);
    responder = async (destino, texto) => {
      await enviarTextoWhatsApp(config.whatsappCloud, destino, texto);
    };
  }

  const porta = Number(argumento("--porta") ?? process.env.BOT_PORT ?? config.cadastro.porta);
  // Só localhost: quem fala com a internet é o túnel (cloudflared/ngrok), não a rede da escola.
  const host = process.env.BOT_HOST ?? "127.0.0.1";
  const { server } = criarServidorBot({
    config,
    appSecret,
    verifyToken,
    responder,
    phoneNumberId: process.env[config.whatsappCloud.phoneNumberIdEnv]?.trim() || undefined,
    arquivoLog: path.join(path.dirname(path.resolve(config.cadastro.arquivo)), "bot.jsonl")
  });

  server.listen(porta, host, () => {
    console.log(`Bot de cadastro ouvindo em http://${host}:${porta}/webhook${simular ? " (simulação: não envia respostas)" : ""}`);
    console.log(`Base de cadastros: ${path.resolve(config.cadastro.arquivo)}`);
    console.log(`Na Meta, a Callback URL é https://<endereço-do-túnel>/webhook e o Verify token é o valor de ${config.cadastro.verifyTokenEnv}.`);
  });
  server.on("error", (e: NodeJS.ErrnoException) => {
    console.error(e.code === "EADDRINUSE" ? `Porta ${porta} já está em uso. Use --porta ou BOT_PORT.` : `Erro: ${e.message}`);
    process.exit(1);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error(`Erro: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
