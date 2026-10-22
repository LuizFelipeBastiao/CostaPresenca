import fs from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Canal } from "./config.js";
import type { TipoAviso } from "./regras.js";

export type StatusEnvio = "enviado" | "falhou" | "simulado" | "teste";

/**
 * Registro de envio. Guarda só o hash do destino (telefone/e-mail), nunca o
 * número em claro, para o histórico não virar mais uma cópia de dados pessoais.
 */
export interface RegistroEnvio {
  timestamp: string;
  runId: string;
  cgm: string;
  destinoHash: string;
  canal: Canal;
  tipo: TipoAviso;
  semana: string;
  status: StatusEnvio;
  idMensagem?: string;
  erro?: string;
}

export function hashDestino(destino: string): string {
  return createHash("sha256").update(destino.trim().toLowerCase()).digest("hex").slice(0, 32);
}

export class HistoricoEnvios {
  private readonly enviados: RegistroEnvio[] = [];

  private constructor(private readonly arquivo: string) {}

  static carregar(diretorio: string): HistoricoEnvios {
    const arquivo = path.resolve(diretorio, "envios.jsonl");
    const h = new HistoricoEnvios(arquivo);
    if (fs.existsSync(arquivo)) {
      for (const linha of fs.readFileSync(arquivo, "utf8").split(/\r?\n/)) {
        if (linha.trim() === "") continue;
        try {
          const r = JSON.parse(linha) as RegistroEnvio;
          if (r.status === "enviado") h.enviados.push(r);
        } catch {
          // linha corrompida (ex.: execução interrompida) não impede o resto
        }
      }
    }
    return h;
  }

  /**
   * Já houve envio bem-sucedido para este aluno+destino na mesma semana,
   * ou dentro da janela de reenvio?
   */
  jaNotificado(cgm: string, destinoHash: string, semana: string, janelaDias: number, agora = new Date()): boolean {
    const limite = agora.getTime() - janelaDias * 86_400_000;
    return this.enviados.some(
      (r) =>
        r.cgm === cgm &&
        r.destinoHash === destinoHash &&
        (r.semana === semana || new Date(r.timestamp).getTime() >= limite)
    );
  }

  async registrar(registro: RegistroEnvio): Promise<void> {
    await mkdir(path.dirname(this.arquivo), { recursive: true });
    await appendFile(this.arquivo, `${JSON.stringify(registro)}\n`, "utf8");
    if (registro.status === "enviado") this.enviados.push(registro);
  }
}
