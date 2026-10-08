import type { Locator, Page } from "playwright";

export const FORBIDDEN_MENU_ACTIONS = [
  "Incluir",
  "Excluir",
  "Remover",
  "Publicar na Web"
] as const;

export function assertAllowedUrl(rawUrl: string, allowedHosts: string[]): void {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:") throw new Error("Apenas HTTPS e permitido");
  if (!allowedHosts.includes(url.hostname)) {
    throw new Error(`Dominio nao autorizado: ${url.hostname}`);
  }
}

export async function assertExpectedPage(
  page: Page,
  expectedName: string,
  allowedHosts: string[]
): Promise<void> {
  assertAllowedUrl(page.url(), allowedHosts);
  try {
    await page.getByText(expectedName, { exact: false }).filter({ visible: true }).first().waitFor({
      state: "visible",
      timeout: 90_000
    });
  } catch {
    throw new Error(`Relatorio esperado nao encontrado apos aguardar carregamento: ${expectedName}`);
  }
  assertAllowedUrl(page.url(), allowedHosts);
}

export async function exactSafeMenuAction(page: Page, name: string): Promise<Locator> {
  if ((FORBIDDEN_MENU_ACTIONS as readonly string[]).includes(name)) {
    throw new Error(`Acao proibida pelo coletor: ${name}`);
  }

  const matches: Locator[] = [];
  for (const frame of page.frames()) {
    const candidates = frame.locator("button[role='menuitem'], [role='option'], .contextMenuItem");
    for (let index = 0; index < await candidates.count(); index += 1) {
      const candidate = candidates.nth(index);
      if (await candidate.isVisible() && ((await candidate.textContent()) ?? "").trim() === name) {
        matches.push(candidate);
      }
    }
  }
  if (matches.length !== 1) {
    const structures: unknown[] = [];
    for (const frame of page.frames()) {
      structures.push(...await frame.locator("*").evaluateAll((nodes, exactText) =>
        nodes.filter((node) => node.textContent?.trim() === exactText && (node as HTMLElement).offsetParent !== null)
          .slice(0, 12)
          .map((node) => ({
            tag: node.tagName.toLowerCase(),
            role: node.getAttribute("role"),
            className: node.getAttribute("class")
          })), name));
    }
    throw new Error(`Esperava exatamente uma opcao segura '${name}', encontrei ${matches.length}; estruturas=${JSON.stringify(structures)}`);
  }
  return matches[0]!;
}

/**
 * Captura diagnósticos atômicos em caso de falha (Screenshot + HTML Dump + Stack Trace)
 */
export async function saveErrorDiagnostic(
  page: Page | undefined,
  error: unknown,
  baseDir: string = "artifacts/diagnostics"
): Promise<string | null> {
  try {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const path = await import("node:path");

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const targetDir = path.resolve(baseDir, `error-${stamp}`);
    await mkdir(targetDir, { recursive: true });

    const errObj = error instanceof Error ? error : new Error(String(error));
    const currentUrl = page && !page.isClosed() ? page.url() : "N/A (página fechada ou indefinida)";

    const errorReport = [
      `Erro: ${errObj.name}`,
      `Mensagem: ${errObj.message}`,
      `Data/Hora: ${new Date().toISOString()}`,
      `URL Ativa: ${currentUrl}`,
      `------------------------------------------------------------`,
      `Stack Trace:`,
      errObj.stack ?? "Sem stack trace disponível"
    ].join("\n");

    await writeFile(path.join(targetDir, "error.txt"), errorReport, "utf8");

    if (page && !page.isClosed()) {
      try {
        const [html, screenshot] = await Promise.all([
          page.content().catch(() => "Erro ao extrair HTML"),
          page.screenshot({ fullPage: true, type: "png" }).catch(() => null)
        ]);

        await writeFile(path.join(targetDir, "dump.html"), html, "utf8");
        if (screenshot) {
          await writeFile(path.join(targetDir, "screenshot.png"), screenshot);
        }
      } catch {}
    }

    console.warn(`[DIAGNÓSTICO SALVO] Detalhes do erro preservados em: ${targetDir}`);
    return targetDir;
  } catch (diagError) {
    console.error("Falha ao gravar diagnósticos de erro:", diagError);
    return null;
  }
}

