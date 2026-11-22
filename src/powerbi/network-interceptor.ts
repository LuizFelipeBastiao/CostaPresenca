import type { Page, Response } from "playwright";
import { decodeDsrPayload, type DsrTableResult } from "./dsr-decoder.js";

export interface NetworkInterceptorOptions {
  expectedColumns?: string[] | undefined;
  expectedRows?: number | undefined;
  timeoutMs?: number | undefined;
}

/**
 * Espera a lista de respostas capturadas parar de crescer: retorna quando ja ha pelo menos
 * `minimo` itens e nenhuma resposta nova chegou por `silencioMs`, ou quando estoura `timeoutMs`.
 * Substitui as esperas fixas (10 s, 15 s) que ora cortavam a resposta, ora esperavam a toa.
 */
export async function aguardarCapturas(
  page: Page,
  lista: readonly unknown[],
  { timeoutMs = 30_000, silencioMs = 4_000, minimo = 1 }: { timeoutMs?: number; silencioMs?: number; minimo?: number } = {}
): Promise<void> {
  const inicio = Date.now();
  let tamanho = lista.length;
  let ultimaMudanca = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    if (lista.length !== tamanho) {
      tamanho = lista.length;
      ultimaMudanca = Date.now();
    }
    if (lista.length >= minimo && Date.now() - ultimaMudanca >= silencioMs) return;
    await page.waitForTimeout(250);
  }
}

export function createQueryInterceptor(page: Page, options: NetworkInterceptorOptions = {}) {
  let capturedResult: DsrTableResult | null = null;
  // Resposta com as colunas certas, mas numero de linhas diferente do configurado.
  // So e usada se nenhuma resposta exata chegar ate o timeout.
  let partialResult: DsrTableResult | null = null;
  let resolveCapture: ((res: DsrTableResult) => void) | null = null;

  const promise = new Promise<DsrTableResult>((resolve) => {
    resolveCapture = resolve;
  });

  const handler = async (response: Response) => {
    const url = response.url();
    if (!url.includes("QueryExecutionService") && !url.includes("querydata") && !url.includes("public/query")) {
      return;
    }

    const request = response.request();
    if (request.method() !== "POST") return;

    try {
      const status = response.status();
      if (status !== 200) return;

      const bodyText = await response.text();
      const parsed = JSON.parse(bodyText);

      let reqPayload: any;
      const postData = request.postData();
      if (postData) {
        try {
          reqPayload = JSON.parse(postData);
        } catch {}
      }

      // Tenta decodificar o payload DSR com metadados de consulta dinamicos
      const decoded = decodeDsrPayload(parsed, reqPayload);
      if (decoded.rows.length === 0) return;

      // Valida se corresponde as colunas esperadas
      if (options.expectedColumns && options.expectedColumns.length > 0) {
        const hasAllCols = options.expectedColumns.every((c) =>
          decoded.headers.some((h) => h.toLowerCase().includes(c.toLowerCase()))
        );
        if (!hasAllCols) return; // Nao e a consulta deste visual
      }

      // Numero de linhas diferente do configurado: pode ser uma pagina parcial ou outro visual.
      // Guarda como reserva (a maior vista) e continua esperando a resposta exata.
      if (options.expectedRows && decoded.rows.length !== options.expectedRows) {
        if (!partialResult || decoded.rows.length > partialResult.rows.length) partialResult = decoded;
        return;
      }

      capturedResult = decoded;
      page.off("response", handler);
      if (resolveCapture) resolveCapture(decoded);
    } catch {
      // Ignora respostas de telemetria ou outras consultas auxiliares
    }
  };

  page.on("response", handler);

  return {
    async waitForTable(timeoutOverrideMs?: number): Promise<DsrTableResult> {
      if (capturedResult) return capturedResult;
      const timeoutMs = timeoutOverrideMs ?? options.timeoutMs ?? 60_000;
      let timer: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      });
      try {
        const result = await Promise.race([promise, timeoutPromise]);
        if (result) return result;
        const reserva = partialResult as DsrTableResult | null;
        if (reserva) {
          console.warn(
            `[AVISO] Nenhuma resposta com exatamente ${options.expectedRows} linhas; ` +
            `usando a maior encontrada (${reserva.rows.length} linhas). Confira expectedDataRows no config.`
          );
          return reserva;
        }
        throw new Error(`Timeout de ${timeoutMs} ms aguardando resposta de consulta de rede`);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    detach() {
      page.off("response", handler);
    }
  };
}
