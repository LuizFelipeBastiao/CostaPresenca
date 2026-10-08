import path from "node:path";
import { mkdir } from "node:fs/promises";
import { chromium, type BrowserContext } from "playwright";
import type { AppConfig } from "./config.js";

export async function launchAuthorizedContext(
  config: AppConfig,
  options: { blockServiceWorkers?: boolean } = {}
): Promise<BrowserContext> {
  const profile = path.resolve(config.profileDirectory);
  await mkdir(profile, { recursive: true });

  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    channel: "msedge",
    viewport: null,
    acceptDownloads: false,
    serviceWorkers: options.blockServiceWorkers ? "block" : "allow",
    locale: "pt-BR",
    args: ["--start-maximized"]
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: "https://app.powerbi.com"
  });
  return context;
}
