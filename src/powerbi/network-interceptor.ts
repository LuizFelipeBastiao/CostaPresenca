import type { Page, Response } from "playwright";
import { decodeDsrPayload, type DsrTableResult } from "./dsr-decoder.js";

export interface NetworkInterceptorOptions {
  expectedColumns?: string[] | undefined;
  expectedRows?: number | undefined;
  timeoutMs?: number | undefined;
}

export function createQueryInterceptor(page: Page, options: NetworkInterceptorOptions = {}) {
  let capturedResult: DsrTableResult | null = null;
  let resolveCapture: ((res: DsrTableResult) => void) | null = null;
  let rejectCapture: ((err: Error) => void) | null = null;

  const promise = new Promise<DsrTableResult>((resolve, reject) => {
    resolveCapture = resolve;
    rejectCapture = reject;
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
      
      // Valida se corresponde as colunas esperadas
      if (options.expectedColumns && options.expectedColumns.length > 0) {
        const hasAllCols = options.expectedColumns.every((c) =>
          decoded.headers.some((h) => h.toLowerCase().includes(c.toLowerCase()))
        );
        if (!hasAllCols) return; // Nao e a consulta deste visual
      }

      // Valida se corresponde ao numero de linhas se configurado
      if (options.expectedRows && decoded.rows.length !== options.expectedRows) {
        // Pode ser consulta parcial de paginacao ou outro visual
        if (decoded.rows.length === 0) return;
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
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Timeout de ${timeoutMs} ms aguardando resposta de consulta de rede`));
        }, timeoutMs);
      });
      try {
        const result = await Promise.race([promise, timeoutPromise]);
        return result;
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    detach() {
      page.off("response", handler);
    }
  };
}
