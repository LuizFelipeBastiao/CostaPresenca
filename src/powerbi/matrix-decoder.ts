export interface MatrixColumn {
  id: number;
  disciplina: string;
  periodo: string;
  fullName: string;
  isTotal: boolean;
}

export interface AlunoDisciplinaNota {
  aluno: string;
  cgm: string;
  disciplina: string;
  tri1: number | null;
  tri2: number | null;
  tri3: number | null;
  total: number | null;
  status: "EM RISCO (< 6.0)" | "ATENÇÃO (6.0 - 6.9)" | "ADEQUADO / BOM";
}

export interface MatrixDsrResult {
  totalAlunos: number;
  columns: MatrixColumn[];
  relacionalRows: AlunoDisciplinaNota[];
}

/**
 * Decodifica o payload DSR de uma matriz Power BI (DataShape com SH e PH)
 */
export function decodeMatrixDsrPayload(json: any): MatrixDsrResult {
  const ds = json?.results?.[0]?.result?.data?.dsr?.DS?.[0];
  if (!ds || !ds.SH || !ds.PH) {
    throw new Error("Payload DSR não contém estrutura de matriz válida (SH e PH ausentes)");
  }

  const vdicts = ds.ValueDicts || {};
  const d0Dict: string[] = vdicts.D0 || ["1ºTri", "2ºTri", "3ºTri"];

  // 1. Mapeia hierarquia secundária (colunas)
  const columns: MatrixColumn[] = [];
  let colId = 0;

  const dm1List = ds.SH[0]?.DM1 || [];
  for (const dm1 of dm1List) {
    const disc = dm1.G1 ?? "Indefinida";
    const measures = dm1.M || [];
    for (const m of measures) {
      if (m.DM3) {
        for (const dm3 of m.DM3) {
          const per = d0Dict[dm3.G2] ?? `Período ${dm3.G2}`;
          columns.push({
            id: colId++,
            disciplina: disc,
            periodo: per,
            fullName: `${disc} - ${per}`,
            isTotal: false
          });
        }
      }
      if (m.DM4) {
        columns.push({
          id: colId++,
          disciplina: disc,
          periodo: "Total",
          fullName: `${disc} - Total`,
          isTotal: true
        });
      }
    }
  }

  // 2. Itera sobre a hierarquia primária (alunos em DM0)
  const relacionalRows: AlunoDisciplinaNota[] = [];
  const dm0List = ds.PH[0]?.DM0 || [];

  for (const dm0 of dm0List) {
    const alunoRaw: string = dm0.G0 ?? "";
    const parts = alunoRaw.split(" - ");
    const nome = parts[0]?.trim() || alunoRaw;
    const cgm = parts[1]?.trim() || "";

    // Mapeamento esparso por índice de coluna
    const colValues: Record<number, number> = {};
    let currentCol = 0;

    if (Array.isArray(dm0.X)) {
      for (const x of dm0.X) {
        if (typeof x.I === "number") {
          currentCol = x.I;
        }
        if (Array.isArray(x.C) && x.C.length > 0 && typeof x.C[0] === "number") {
          colValues[currentCol] = x.C[0];
        }
        currentCol++;
      }
    }

    // Agrupa por disciplina
    const disciplinasMap: Record<
      string,
      { tri1: number | null; tri2: number | null; tri3: number | null; total: number | null }
    > = {};

    for (const col of columns) {
      if (colValues[col.id] !== undefined) {
        if (!disciplinasMap[col.disciplina]) {
          disciplinasMap[col.disciplina] = { tri1: null, tri2: null, tri3: null, total: null };
        }
        const val = colValues[col.id]!;
        if (col.periodo.includes("1º")) disciplinasMap[col.disciplina]!.tri1 = val;
        else if (col.periodo.includes("2º")) disciplinasMap[col.disciplina]!.tri2 = val;
        else if (col.periodo.includes("3º")) disciplinasMap[col.disciplina]!.tri3 = val;
        else if (col.periodo === "Total") disciplinasMap[col.disciplina]!.total = val;
      }
    }

    for (const [disc, notas] of Object.entries(disciplinasMap)) {
      const notasValidas = [notas.tri1, notas.tri2].filter((n): n is number => n !== null);
      const menor = notasValidas.length > 0 ? Math.min(...notasValidas) : 10;
      const status = menor < 6.0 ? "EM RISCO (< 6.0)" : menor < 7.0 ? "ATENÇÃO (6.0 - 6.9)" : "ADEQUADO / BOM";

      relacionalRows.push({
        aluno: nome,
        cgm,
        disciplina: disc,
        ...notas,
        status
      });
    }
  }

  return {
    totalAlunos: dm0List.length,
    columns,
    relacionalRows
  };
}
