import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext, Response, Route } from "playwright";

const ALLOWED_SUFFIXES = ["powerbi.com", "analysis.windows.net", "microsoft.com"];
const CANDIDATE_PATHS = [
  /querydata/i,
  /conceptualschema/i,
  /modelsAndExploration/i,
  /explore/i,
  /query/i,
  /executeQueries/i,
  /reports\/.*\/data/i
];
const MAX_BODY_BYTES = 50 * 1024 * 1024;
const SENSITIVE_KEY = /token|authorization|cookie|credential|password|secret/i;

interface NetworkEntry {
  timestamp: string;
  method: string;
  host: string;
  path: string;
  status: number;
  resourceType: string;
  contentType: string;
  contentLength?: number;
  candidate: boolean;
  requestBody?: string;
  bodyFile?: string;
  bodyHash?: string;
  dataMatch?: boolean;
  error?: string;
}

function allowedHost(host: string): boolean {
  return ALLOWED_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function safeUrl(raw: string): { host: string; path: string } | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || !allowedHost(url.hostname)) return undefined;
    return { host: url.hostname, path: url.pathname };
  } catch {
    return undefined;
  }
}

function sanitizedBody(body: Buffer): Buffer {
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    const redact = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(redact);
      if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, child]) =>
          [key, SENSITIVE_KEY.test(key) ? "[REDACTED]" : redact(child)]));
      }
      return value;
    };
    return Buffer.from(JSON.stringify(redact(parsed)), "utf8");
  } catch {
    return body;
  }
}

export async function startNetworkProbe(context: BrowserContext, artifactDirectory: string) {
  const directory = path.resolve(artifactDirectory, "network-probe", new Date().toISOString().replace(/[:.]/g, "-"));
  await mkdir(directory, { recursive: true });
  const entries: NetworkEntry[] = [];
  const pending = new Set<Promise<void>>();

  const handler = (response: Response) => {
    const task = (async () => {
      const safe = safeUrl(response.url());
      if (!safe) return;
      const request = response.request();
      const headers = await response.allHeaders();
      const contentType = headers["content-type"] ?? "";
      const contentLength = Number(headers["content-length"] ?? 0) || undefined;
      const candidate = CANDIDATE_PATHS.some((pattern) => pattern.test(safe.path));
      
      const postData = request.postData();
      let reqSnippet: string | undefined;
      if (postData) {
        try {
          const parsedReq = JSON.parse(postData);
          reqSnippet = JSON.stringify(parsedReq).slice(0, 500);
        } catch {
          reqSnippet = postData.slice(0, 300);
        }
      }

      const entry: NetworkEntry = {
        timestamp: new Date().toISOString(),
        method: request.method(),
        host: safe.host,
        path: safe.path,
        status: response.status(),
        resourceType: request.resourceType(),
        contentType,
        candidate,
        ...(reqSnippet ? { requestBody: reqSnippet } : {}),
        ...(contentLength === undefined ? {} : { contentLength })
      };
      entries.push(entry);

      if (candidate) {
        console.log(`[NETWORK PROBE] ${request.method()} ${safe.host}${safe.path} (status: ${response.status()})`);
      }

      if (!candidate || !/json|octet-stream/i.test(contentType)) return;
      if (contentLength && contentLength > MAX_BODY_BYTES) {
        entry.error = "body-too-large";
        return;
      }
      try {
        const rawBody = await response.body();
        const text = rawBody.toString("utf8");
        const hasDataTokens = text.includes("FOZ DO IGUACU") || text.includes("dsr") || text.includes("dataShape");
        entry.dataMatch = hasDataTokens;

        if (hasDataTokens) {
          console.log(`[DADOS IDENTIFICADOS NA REDE!] ${safe.path} contém dados da consulta/visual! Tamanho: ${rawBody.length} bytes`);
        }

        const body = sanitizedBody(rawBody);
        if (body.length > MAX_BODY_BYTES) {
          entry.error = "body-too-large";
          return;
        }
        const hash = createHash("sha256").update(body).digest("hex");
        const filename = `${String(entries.indexOf(entry)).padStart(4, "0")}-${hash.slice(0, 12)}.json`;
        await writeFile(path.join(directory, filename), body);
        entry.bodyFile = filename;
        entry.bodyHash = hash;
      } catch (error) {
        entry.error = error instanceof Error ? error.name : "UnknownError";
      }
    })();
    pending.add(task);
    void task.finally(() => pending.delete(task));
  };

  const noCache = (route: Route) => route.continue();
  await context.route("**/*", noCache);
  context.on("response", handler);
  return {
    async stop() {
      context.off("response", handler);
      await context.unroute("**/*", noCache);
      await Promise.allSettled([...pending]);
      const manifest = {
        createdAt: new Date().toISOString(),
        privacy: "No request headers or query strings recorded. Sensitive JSON keys are recursively redacted.",
        entries
      };
      const manifestPath = path.join(directory, "manifest.json");
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
      return { directory, manifestPath, entries };
    }
  };
}
