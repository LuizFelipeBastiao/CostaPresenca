import type { Page } from "playwright";
import type { ReportConfig, SchoolContext } from "../config.js";

/**
 * Clica dinamicamente em um botão de bookmark ou ação no Power BI (ex: TURMA, MAPA, REDE, ESCOLA)
 */
export async function clickBookmarkButton(page: Page, buttonText: string, timeoutMs: number = 15_000): Promise<boolean> {
  const regex = new RegExp(`^\\s*${buttonText}\\s*$`, "i");
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    for (const frame of page.frames()) {
      // 1. Tenta classe padrão de botões do Power BI
      const btn = frame.locator(".ui-role-button-text").filter({ hasText: regex }).first();
      if ((await btn.count()) > 0 && (await btn.isVisible())) {
        await btn.click({ force: true });
        return true;
      }

      // 2. Tenta visual-container ou botões com papel de ação
      const visualBtn = frame.locator("visual-container, .visual-actionButton, [role='button']").filter({ hasText: regex }).first();
      if ((await visualBtn.count()) > 0 && (await visualBtn.isVisible())) {
        await visualBtn.click({ force: true });
        return true;
      }

      // 3. Fallback genérico por texto
      const textBtn = frame.locator(`text=${buttonText}`).filter({ visible: true }).first();
      if ((await textBtn.count()) > 0 && (await textBtn.isVisible())) {
        await textBtn.click({ force: true });
        return true;
      }
    }
    await page.waitForTimeout(500);
  }

  return false;
}

/**
 * Desbloqueia o bookmark padrão da SEED e aplica o escopo institucional semântico
 */
export async function unlockBookmarkAndScope(
  page: Page,
  context: Partial<SchoolContext> = {}
): Promise<void> {
  const nreAlvo = context.nre ?? "FOZ DO IGUACU";
  const escolaExcluir = context.escolaExcluirDefault ?? "ANCHIETA";

  // 1. Desmarca a escola padrão do bookmark se presente (ex: ANCHIETA)
  const escolaCombo = page.getByRole("combobox", { name: "ESCOLA", exact: true }).filter({ visible: true });
  if ((await escolaCombo.count()) > 0) {
    const textAtual = await escolaCombo.innerText();
    if (textAtual.toUpperCase().includes(escolaExcluir.toUpperCase())) {
      await escolaCombo.click();
      await page.waitForTimeout(1_200);

      const itemExcluir = page
        .locator(".slicer-dropdown-popup:visible .slicerItemContainer, .slicerItemContainer:visible")
        .filter({ hasText: new RegExp(escolaExcluir, "i") })
        .first();

      if ((await itemExcluir.count()) > 0) {
        await itemExcluir.click();
        await page.waitForTimeout(1_000);
      }
      // Fecha clicando no cabeçalho neutro
      await page.mouse.click(300, 220);
      await page.waitForTimeout(1_200);
    }
  }

  // 2. Seleciona o NRE desejado (ex: FOZ DO IGUACU)
  const nreCombo = page
    .getByRole("combobox", { name: "NRE", exact: true })
    .or(page.getByRole("combobox", { name: "NRE, MUNICÍPIO", exact: true }))
    .filter({ visible: true });

  if ((await nreCombo.count()) > 0) {
    const textAtual = await nreCombo.innerText();
    if (!textAtual.toUpperCase().includes(nreAlvo.toUpperCase())) {
      await nreCombo.click();
      await page.waitForTimeout(1_500);

      const itemNre = page
        .locator(".slicer-dropdown-popup:visible .slicerItemContainer, .slicerItemContainer:visible")
        .filter({ hasText: new RegExp(nreAlvo, "i") })
        .first();

      if ((await itemNre.count()) > 0) {
        await itemNre.click();
        await page.waitForTimeout(2_000);
      }
      await page.mouse.click(300, 220);
      await page.waitForTimeout(1_500);
    }
  }
}

/**
 * Aplica os filtros genéricos configurados no relatório
 */
export async function applyConfiguredFilters(page: Page, report: ReportConfig): Promise<void> {
  for (const filter of report.filters) {
    const combo = page.getByRole("combobox", { name: filter.label, exact: true }).filter({ visible: true });
    await combo.waitFor({ state: "visible", timeout: 120_000 });
    if ((await combo.count()) !== 1) {
      throw new Error(`Filtro nao e unico: ${filter.label}`);
    }

    if ((await combo.innerText()).includes(filter.value)) continue;
    await combo.click();

    const option = page
      .getByRole("treeitem", { name: filter.value, exact: true })
      .filter({ visible: true })
      .or(page.getByRole("option", { name: filter.value, exact: true }).filter({ visible: true }));

    await option.first().waitFor({ state: "visible", timeout: 30_000 });
    if ((await option.count()) !== 1) {
      throw new Error(`Opcao de filtro nao e unica: ${filter.label} = ${filter.value}`);
    }
    await option.click();
    await page.waitForFunction(
      ({ label, value }) => {
        const combos = [...document.querySelectorAll<HTMLElement>("[role='combobox']")];
        const target = combos.find((node) => node.getAttribute("aria-label") === label && node.offsetParent !== null);
        return target?.innerText.includes(value) ?? false;
      },
      filter,
      { timeout: 30_000 }
    );
  }
}

/**
 * Tenta dispensar silenciosamente modais, banners de consentimento e avisos do Power BI / Microsoft
 */
export async function tryDismissMicrosoftPopups(page: Page): Promise<void> {
  const dismissSelectors = [
    "#onetrust-accept-btn-handler",
    "#acceptButton",
    "#bnp_btn_accept",
    "button:has-text('Aceitar todos')",
    "button:has-text('Aceitar')",
    "button:has-text('Accept')",
    "#idSIButton9",
    "input[type='submit'][value='Sim']",
    "input[type='submit'][value='Yes']",
    "button[aria-label='Fechar']",
    "button[aria-label='Close']",
    "button[aria-label='Ignorar']",
    "button:has-text('Entendi')",
    "button:has-text('Got it')",
    ".ms-Dialog-action button",
    ".pbi-dialog-action-btn"
  ];

  for (const selector of dismissSelectors) {
    try {
      const el = page.locator(selector).first();
      if ((await el.count()) > 0 && (await el.isVisible())) {
        await el.click({ timeout: 1_000, force: true });
        await page.waitForTimeout(300);
      }
    } catch {
      // Ignora silenciosamente se o elemento desaparecer ou não for interagível
    }
  }
}

