/**
 * O Power BI exporta percentuais ora formatados ("95,26%"), ora como fração
 * decimal ("0.80290000000000006"). Normaliza ambos para 0..100.
 * Retorna null quando não há dado.
 */
export function parsePercentual(bruto: string | undefined | null): number | null {
  if (bruto === undefined || bruto === null) return null;
  const texto = bruto.trim();
  if (texto === "") return null;
  const temPorcento = texto.includes("%");
  const numero = Number.parseFloat(texto.replace("%", "").replace(/\s/g, "").replace(",", "."));
  if (Number.isNaN(numero)) return null;
  if (temPorcento) return numero;
  return numero <= 1 ? numero * 100 : numero;
}

export function formatarPercentual(valor: number | null, casas = 0): string {
  if (valor === null) return "sem dado";
  return `${valor.toFixed(casas).replace(".", ",")}%`;
}
