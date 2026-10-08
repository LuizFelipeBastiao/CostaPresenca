import type { ExtractedRow } from "../types.js";

interface SchemaEntry {
  N: string;
  T?: number;
  DN?: string;
}

interface ValueDicts {
  [dictKey: string]: string[];
}

interface DsrRowData {
  C?: (string | number | boolean | null)[];
  R?: number;
  [key: string]: unknown;
}

export interface DsrTableResult {
  headers: string[];
  rows: ExtractedRow[];
}

/**
 * Mapeamento de fallback semantico caso a resposta nao possua descriptor.Select
 */
const DEFAULT_FALLBACK_HEADERS: Record<string, string> = {
  D0: "Turma",
  D1: "Equivalência Seriação",
  D2: "Curso",
  D3: "Escola",
  D4: "Município",
  D5: "NRE",
  M0: "Rank",
  M1: "Alunos Ativos",
  M2: "(%) Presença",
  M3: "Σ Presenças",
  M4: "Σ Aulas",
  M5: "% Faltas Amparadas",
  M6: "Aulas Previstas",
  M7: "Aulas Dadas",
  M8: "(%) Aulas Dadas",
  M9: "Amparo Legal Qtde",
  M10: "01.23.Saldo Aulas Dadas"
};

/**
 * Constrói mapa dinâmico de nomes de coluna a partir de descriptor.Select
 */
function buildHeaderMapFromDescriptor(
  descriptorSelect: Array<{
    Value?: string;
    Name?: string;
    NativeReferenceName?: string;
    GroupKeys?: Array<{ Source?: { Property?: string } }>;
  }>,
  groupingsKeys?: Array<{ Source?: { Property?: string }; Select?: number }>
): Record<string, string> {
  const map: Record<string, string> = {};

  for (const item of descriptorSelect) {
    if (!item.Value) continue;
    let friendlyName = item.NativeReferenceName;
    if (!friendlyName && item.GroupKeys?.[0]?.Source?.Property) {
      friendlyName = item.GroupKeys[0].Source.Property;
    }
    if (!friendlyName && item.Name) {
      friendlyName = item.Name.split(".").pop() ?? item.Name;
    }
    if (friendlyName) {
      map[item.Value] = friendlyName;
    }
  }

  if (groupingsKeys && groupingsKeys.length > 0) {
    groupingsKeys.forEach((k, idx) => {
      const prop = k.Source?.Property;
      if (prop) {
        map[`G${idx}`] = prop;
        map[`D${idx}`] = prop;
      }
    });
  }

  return map;
}

export function decodeDsrPayload(dsrData: any, requestPayload?: any): DsrTableResult {
  const firstResult = dsrData?.results?.[0]?.result?.data;
  const ds = firstResult?.dsr?.DS?.[0];
  if (!ds) throw new Error("Payload DSR nao contem estrutura DS[0]");

  const vdicts: ValueDicts = ds.ValueDicts ?? {};
  
  // Localiza de forma agnostica a matriz DM principal (com maior cardinalidade schema*rows) em PH
  let rowMatrix: DsrRowData[] | undefined;
  let bestScore = -1;
  if (Array.isArray(ds.PH)) {
    for (const ph of ds.PH) {
      for (const key of Object.keys(ph)) {
        if (key.startsWith("DM") && Array.isArray(ph[key]) && ph[key].length > 0 && ph[key][0]?.S) {
          const score = ph[key].length * ((ph[key][0].S as SchemaEntry[]).length || 1);
          if (score > bestScore) {
            bestScore = score;
            rowMatrix = ph[key];
          }
        }
      }
    }
  }

  if (!rowMatrix || rowMatrix.length === 0) {
    throw new Error("Payload DSR nao contem matriz DM com schema S de linhas");
  }

  const firstRow = rowMatrix[0];
  if (!firstRow || !firstRow.S) {
    throw new Error("Payload DSR nao contem schema S na primeira linha da matriz");
  }

  const schema: SchemaEntry[] = (firstRow.S as SchemaEntry[]) ?? [];
  if (schema.length === 0) throw new Error("Schema S ausente na matriz de dados");

  // Constroi mapa dinamico a partir do descriptor do response
  const descriptorSelect = firstResult?.descriptor?.Select;
  const groupingsKeys = firstResult?.descriptor?.Expressions?.Primary?.Groupings?.[0]?.Keys;
  let dynamicHeaderMap: Record<string, string> = {};

  if (Array.isArray(descriptorSelect) && descriptorSelect.length > 0) {
    dynamicHeaderMap = buildHeaderMapFromDescriptor(descriptorSelect, groupingsKeys);
  }

  // Enriquece com dados do requestPayload se fornecido
  const requestSelect = requestPayload?.queries?.[0]?.Query?.Commands?.[0]?.SemanticQueryDataShapeCommand?.Query?.Select;
  if (Array.isArray(requestSelect) && Array.isArray(descriptorSelect)) {
    for (const dItem of descriptorSelect) {
      if (!dItem.Value || !dItem.Name) continue;
      const reqMatch = requestSelect.find((r: any) => r.Name === dItem.Name);
      if (reqMatch && (reqMatch.NativeReferenceName || reqMatch.Name)) {
        dynamicHeaderMap[dItem.Value] = reqMatch.NativeReferenceName || reqMatch.Name;
      }
    }
  }

  // Mapeia cabecalhos dando prioridade a s.N (identificador do Select), depois s.DN e fallbacks
  const headers = schema.map((s) => {
    if (dynamicHeaderMap[s.N]) return dynamicHeaderMap[s.N]!;
    if (s.DN && dynamicHeaderMap[s.DN]) return dynamicHeaderMap[s.DN]!;
    if (s.DN && DEFAULT_FALLBACK_HEADERS[s.DN]) return DEFAULT_FALLBACK_HEADERS[s.DN]!;
    if (DEFAULT_FALLBACK_HEADERS[s.N]) return DEFAULT_FALLBACK_HEADERS[s.N]!;
    return s.DN ?? s.N;
  });

  const rows: ExtractedRow[] = [];
  let prevRow: string[] = new Array(schema.length).fill("");

  for (const rowData of rowMatrix) {
    const c = rowData.C ?? [];
    const rMask = typeof rowData.R === "number" ? rowData.R : 0;
    
    // Identifica o bitmask de nulos (chave especial diferente de C, R, S)
    let nullMask = 0;
    for (const key of Object.keys(rowData)) {
      if (key !== "C" && key !== "R" && key !== "S" && typeof rowData[key] === "number") {
        nullMask = rowData[key] as number;
        break;
      }
    }

    const currentRow: string[] = new Array(schema.length).fill("");
    let cIdx = 0;

    for (let colIdx = 0; colIdx < schema.length; colIdx += 1) {
      if ((rMask & (1 << colIdx)) !== 0) {
        currentRow[colIdx] = prevRow[colIdx] ?? "";
      } else if ((nullMask & (1 << colIdx)) !== 0) {
        currentRow[colIdx] = "";
      } else {
        if (cIdx < c.length) {
          let val = c[cIdx];
          cIdx += 1;
          const colSchema = schema[colIdx];
          const dictKey = colSchema?.DN ?? colSchema?.N;
          if (dictKey && vdicts[dictKey] && typeof val === "number") {
            val = vdicts[dictKey]![val] ?? String(val);
          }
          if (typeof val === "number") {
            const h = headers[colIdx];
            if (h && (h.includes("(%)") || h.includes("%"))) {
              currentRow[colIdx] = `${(val * 100).toFixed(2).replace(".", ",")}%`;
            } else {
              currentRow[colIdx] = String(val);
            }
          } else {
            currentRow[colIdx] = val !== null && val !== undefined ? String(val) : "";
          }
        } else {
          currentRow[colIdx] = "";
        }
      }
    }

    rows.push({ cells: currentRow });
    prevRow = currentRow;
  }

  return { headers, rows };
}
