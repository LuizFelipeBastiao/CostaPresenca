/**
 * Data no fuso do computador (AAAA-MM-DD), usada para nomear as pastas de historico.
 * `toISOString()` usa UTC: depois das 21h em Brasilia ele ja devolve o dia seguinte.
 */
export function dataLocal(data: Date = new Date()): string {
  const ano = data.getFullYear();
  const mes = String(data.getMonth() + 1).padStart(2, "0");
  const dia = String(data.getDate()).padStart(2, "0");
  return `${ano}-${mes}-${dia}`;
}
