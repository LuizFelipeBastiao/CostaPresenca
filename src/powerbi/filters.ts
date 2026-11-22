import type { Locator, Page } from "playwright";
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

/** Compara textos ignorando acentos, maiusculas e espacos extras (IGUACU == IGUAÇU). */
export function canonico(texto: string): string {
  return texto.normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/\s+/g, " ").trim().toUpperCase();
}

const ITENS_DROPDOWN = ".slicer-dropdown-popup:visible .slicerItemContainer, .slicerItemContainer:visible";

/** Fecha o dropdown aberto sem clicar em coordenadas fixas da tela. */
async function fecharDropdown(page: Page, combo: Locator): Promise<void> {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  if ((await page.locator(".slicer-dropdown-popup:visible").count()) > 0) {
    // Clicar no proprio combobox alterna o dropdown para fechado.
    await combo.click();
    await page.waitForTimeout(500);
  }
}

/** Abre o combobox, clica no item cujo texto contem `alvo` e fecha. Devolve false se o item nao apareceu. */
async function clicarItemDoCombo(page: Page, combo: Locator, alvo: string): Promise<boolean> {
  await combo.click();
  await page.waitForTimeout(1_200);

  const encontrarItem = async (): Promise<Locator | undefined> => {
    for (const item of await page.locator(ITENS_DROPDOWN).all()) {
      if (canonico(await item.innerText()).includes(canonico(alvo))) return item;
    }
    return undefined;
  };

  let item = await encontrarItem();
  if (!item) {
    // Listas longas sao virtualizadas: usa a busca do proprio filtro, se existir.
    const busca = page.locator(".slicer-dropdown-popup:visible input").first();
    if ((await busca.count()) > 0) {
      await busca.fill(alvo);
      await page.waitForTimeout(1_500);
      item = await encontrarItem();
    }
  }

  if (item) {
    await item.click();
    await page.waitForTimeout(1_500);
  }
  await fecharDropdown(page, combo);
  return item !== undefined;
}

/**
 * Desbloqueia o bookmark padrão da SEED e aplica o escopo institucional (NRE + escola).
 * Lança erro se existir um filtro ESCOLA e não for possível deixá-lo só com a escola configurada,
 * para nunca salvar dados de outra escola como se fossem desta.
 */
export async function unlockBookmarkAndScope(
  page: Page,
  context: Partial<SchoolContext> = {}
): Promise<void> {
  const nreAlvo = context.nre ?? "FOZ DO IGUACU";
  const escolaAlvo = context.escolaNome ?? "ARTHUR DA COSTA E SILVA";
  const escolaExcluir = context.escolaExcluirDefault ?? "ANCHIETA";

  const escolaCombo = () => page.getByRole("combobox", { name: "ESCOLA", exact: true }).filter({ visible: true });

  // 1. Desmarca a escola padrão do bookmark se presente (ex: ANCHIETA)
  if ((await escolaCombo().count()) > 0) {
    const textAtual = await escolaCombo().innerText();
    if (canonico(textAtual).includes(canonico(escolaExcluir))) {
      await clicarItemDoCombo(page, escolaCombo(), escolaExcluir);
    }
  }

  // 2. Seleciona o NRE desejado (ex: FOZ DO IGUACU)
  const nreCombo = page
    .getByRole("combobox", { name: "NRE", exact: true })
    .or(page.getByRole("combobox", { name: "NRE, MUNICÍPIO", exact: true }))
    .filter({ visible: true });

  if ((await nreCombo.count()) > 0) {
    const textAtual = await nreCombo.innerText();
    if (!canonico(textAtual).includes(canonico(nreAlvo))) {
      const achou = await clicarItemDoCombo(page, nreCombo, nreAlvo);
      if (!achou) console.warn(`[AVISO] NRE "${nreAlvo}" nao apareceu na lista do filtro NRE.`);
    }
  }

  // 3. Seleciona a escola configurada (a lista de escolas depende do NRE, por isso vem depois)
  if ((await escolaCombo().count()) === 0) {
    console.warn(`[AVISO] Filtro ESCOLA nao encontrado; assumindo que a conta so enxerga a propria escola.`);
    return;
  }

  if (!canonico(await escolaCombo().innerText()).includes(canonico(escolaAlvo))) {
    await clicarItemDoCombo(page, escolaCombo(), escolaAlvo);
  }

  const textoFinal = await escolaCombo().innerText();
  if (!canonico(textoFinal).includes(canonico(escolaAlvo))) {
    throw new Error(
      `Nao consegui deixar o filtro ESCOLA so com "${escolaAlvo}" (o filtro mostra: "${textoFinal.trim()}"). ` +
      `Confira o nome em context.escolaNome no config/local.json.`
    );
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
  // Nunca mexe na tela de login: só os avisos dentro do Power BI.
  if (new URL(page.url()).hostname !== "app.powerbi.com") return;
  const dismissSelectors = [
    "#onetrust-accept-btn-handler",
    "#acceptButton",
    "#bnp_btn_accept",
    "button:has-text('Aceitar todos')",
    "button:has-text('Aceitar')",
    "button:has-text('Accept')",
    // Os botoes da tela de login da Microsoft (#idSIButton9, "Sim"/"Yes") ficam de fora de proposito:
    // login e com a pessoa (npm run login); se a sessao expirar, a coleta para com SessaoExpiradaError.
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

