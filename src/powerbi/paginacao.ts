import { randomUUID } from "node:crypto";
import type { DsrTableResult } from "./dsr-decoder.js";

/**
 * Paginação das respostas de consulta do Power BI.
 *
 * Tabelas grandes chegam em janelas (~500 linhas). A resposta da primeira janela vem com
 * `DS[0].IC === false` ("is complete") e um token `DS[0].RT`. O relatório só pede a próxima
 * janela quando alguém rola a tabela; aqui repetimos a mesma consulta (já com os filtros da
 * escola) acrescentando `RestartTokens`, até a resposta vir completa.
 */

export interface ConsultaCapturada {
  url: string;
  corpo: string;
  headers: Record<string, string>;
}

export type EnviarConsulta = (url: string, headers: Record<string, string>, corpo: string) => Promise<unknown>;

function ds0(payload: any): any {
  return payload?.results?.[0]?.result?.data?.dsr?.DS?.[0];
}

/** Token para pedir a próxima janela, ou null quando a resposta já está completa. */
export function tokenDeContinuacao(payload: unknown): unknown[] | null {
  const ds = ds0(payload);
  if (!ds || ds.IC !== false) return null;
  return Array.isArray(ds.RT) && ds.RT.length > 0 ? ds.RT : null;
}

/** O mesmo corpo de consulta, pedindo a janela que começa depois de `rt`. */
export function corpoComContinuacao(corpo: string, rt: unknown[]): string {
  const json = JSON.parse(corpo);
  const comando = json?.queries?.[0]?.Query?.Commands?.find((c: any) => c?.SemanticQueryDataShapeCommand)
    ?.SemanticQueryDataShapeCommand;
  const janela = comando?.Binding?.DataReduction?.Primary?.Window;
  if (!janela || typeof janela !== "object") {
    throw new Error("Consulta do Power BI em formato inesperado: sem Binding.DataReduction.Primary.Window.");
  }
  janela.RestartTokens = rt;
  return JSON.stringify(json);
}

/** Cabeçalhos da consulta original que podem ser reenviados (sem os controlados pelo cliente HTTP). */
export function cabecalhosReenviaveis(headers: Record<string, string>): Record<string, string> {
  const fora = new Set(["content-length", "host", "connection", "accept-encoding", "cookie", "origin", "referer"]);
  const saida: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const nome = k.toLowerCase();
    if (nome.startsWith(":") || nome.startsWith("sec-") || fora.has(nome)) continue;
    saida[nome] = v;
  }
  if ("requestid" in saida) saida.requestid = randomUUID();
  return saida;
}

/**
 * Busca as janelas que faltam a partir da primeira resposta. Devolve todas as respostas, na ordem.
 * Lança erro se a lista continuar incompleta: dado parcial salvo como completo deixaria alunos
 * sem aviso e sem bilhete sem ninguém perceber.
 */
export async function buscarJanelasRestantes(
  primeira: unknown,
  consulta: ConsultaCapturada,
  enviar: EnviarConsulta,
  { maxJanelas = 60 }: { maxJanelas?: number } = {}
): Promise<unknown[]> {
  const respostas: unknown[] = [primeira];
  let rt = tokenDeContinuacao(primeira);
  while (rt) {
    if (respostas.length >= maxJanelas) {
      throw new Error(`A lista de alunos não terminou em ${maxJanelas} janelas do Power BI.`);
    }
    const corpo = corpoComContinuacao(consulta.corpo, rt);
    const resposta = await enviar(consulta.url, cabecalhosReenviaveis(consulta.headers), corpo);
    const proximo = tokenDeContinuacao(resposta);
    if (proximo && JSON.stringify(proximo) === JSON.stringify(rt)) {
      throw new Error("O Power BI devolveu o mesmo token de continuação; a lista não avançou.");
    }
    if (!ds0(resposta)) throw new Error("Resposta de continuação do Power BI sem dados (DS[0]).");
    respostas.push(resposta);
    rt = proximo;
  }
  return respostas;
}

/** Junta as janelas decodificadas numa tabela só, sem repetir linhas idênticas. */
export function juntarTabelas(tabelas: DsrTableResult[]): DsrTableResult {
  const primeira = tabelas[0];
  if (!primeira) throw new Error("Nenhuma tabela para juntar.");
  const vistas = new Set<string>();
  const rows: DsrTableResult["rows"] = [];
  for (const t of tabelas) {
    if (t.headers.join("\u0001") !== primeira.headers.join("\u0001")) {
      throw new Error("As janelas do Power BI vieram com colunas diferentes; a junção foi interrompida.");
    }
    for (const r of t.rows) {
      const chave = r.cells.join("\u0001");
      if (vistas.has(chave)) continue;
      vistas.add(chave);
      rows.push(r);
    }
  }
  return { headers: primeira.headers, rows };
}

/**
 * Janelas de continuação podem vir sem o esquema de colunas (`S`) na primeira linha.
 * Devolve uma cópia da janela com o esquema da primeira janela onde faltar.
 */
export function herdarSchema(janela: unknown, primeira: unknown): unknown {
  const alvo = ds0(janela);
  const origem = ds0(primeira);
  if (!alvo || !origem || !Array.isArray(alvo.PH) || !Array.isArray(origem.PH)) return janela;
  const copia = JSON.parse(JSON.stringify(janela));
  const ph = ds0(copia).PH as any[];
  ph.forEach((bloco, i) => {
    for (const chave of Object.keys(bloco)) {
      const linhas = bloco[chave];
      const schema = origem.PH[i]?.[chave]?.[0]?.S;
      if (chave.startsWith("DM") && Array.isArray(linhas) && linhas[0] && !linhas[0].S && schema) linhas[0].S = schema;
    }
  });
  return copia;
}
