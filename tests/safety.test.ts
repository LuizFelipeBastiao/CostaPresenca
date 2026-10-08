import test from "node:test";
import assert from "node:assert/strict";
import { assertAllowedUrl, FORBIDDEN_MENU_ACTIONS } from "../src/safety.js";

test("aceita somente host HTTPS permitido", () => {
  assert.doesNotThrow(() => assertAllowedUrl("https://app.powerbi.com/groups/me", ["app.powerbi.com"]));
  assert.throws(() => assertAllowedUrl("http://app.powerbi.com/", ["app.powerbi.com"]));
  assert.throws(() => assertAllowedUrl("https://example.com/", ["app.powerbi.com"]));
});

test("acoes destrutivas conhecidas permanecem bloqueadas", () => {
  assert.deepEqual([...FORBIDDEN_MENU_ACTIONS], ["Incluir", "Excluir", "Remover", "Publicar na Web"]);
});
