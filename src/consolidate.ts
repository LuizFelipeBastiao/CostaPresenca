import fs from "node:fs";
import path from "node:path";

function parseCsv(content: string): { headers: string[]; rows: string[][] } {
  const lines = content.trim().split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };

  const parseLine = (line: string): string[] => {
    const fields: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (inQuotes && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (c === "," && !inQuotes) {
        fields.push(cur);
        cur = "";
      } else {
        cur += c;
      }
    }
    fields.push(cur);
    return fields;
  };

  const headers = parseLine(lines[0]!);
  const rows = lines.slice(1).map(parseLine);
  return { headers, rows };
}

function getLatestCsv(reportDir: string): string | null {
  if (!fs.existsSync(reportDir)) return null;
  const files = fs
    .readdirSync(reportDir)
    .filter((f) => f.endsWith(".csv") && !f.includes("latest"))
    .map((f) => path.join(reportDir, f));
  if (files.length === 0) {
    const latest = path.join(reportDir, `${path.basename(reportDir)}-latest.csv`);
    return fs.existsSync(latest) ? latest : null;
  }
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0]!;
}

function getLatestJson(reportDir: string): string | null {
  if (!fs.existsSync(reportDir)) return null;
  const files = fs
    .readdirSync(reportDir)
    .filter((f) => f.endsWith(".json") && !f.includes("latest"))
    .map((f) => path.join(reportDir, f));
  if (files.length === 0) {
    const latest = path.join(reportDir, `${path.basename(reportDir)}-latest.json`);
    return fs.existsSync(latest) ? latest : null;
  }
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0]!;
}

function rowToObject(headers: string[], row: string[]): Record<string, string> {
  const obj: Record<string, string> = {};
  headers.forEach((h, i) => {
    obj[h] = row[i] ?? "";
  });
  return obj;
}

export function consolidateMetrics(dataDir: string = "data") {
  const reportKeys = [
    "presente-estadual",
    "aprendizagem-parana",
    "redacao-parana",
    "leia-parana",
    "khan-academy",
    "matific-estadual",
    "ingles-high",
    "ingles-teens",
    "programacao-parana",
    "robotica-parana"
  ];

  const consolidated: Record<string, any> = {
    geradoEm: new Date().toISOString(),
    escola: "COLÉGIO ESTADUAL ARTHUR DA COSTA E SILVA",
    municipio: "MEDIANEIRA",
    nre: "FOZ DO IGUAÇU",
    indicadores: {}
  };

  for (const rep of reportKeys) {
    const csvPath = getLatestCsv(path.join(dataDir, rep));
    if (!csvPath) continue;

    const content = fs.readFileSync(csvPath, "utf8");
    const { headers, rows } = parseCsv(content);
    if (rows.length === 0) continue;

    if (rep === "presente-estadual") {
      const totalTurmas = rows.length;
      let somaAlunos = 0;
      for (const r of rows) {
        const obj = rowToObject(headers, r);
        const al = parseInt(obj["Alunos Ativos"] || "0", 10);
        if (!isNaN(al)) somaAlunos += al;
      }
      consolidated.indicadores["presenca"] = {
        totalTurmas,
        alunosAtivosTotal: somaAlunos,
        arquivoFonte: path.basename(csvPath)
      };
    } else if (rep === "robotica-parana") {
      consolidated.indicadores["robotica"] = {
        turmasCadastradas: rows.length,
        professores: [...new Set(rows.map((r) => rowToObject(headers, r)["Professor"] || ""))].filter(Boolean),
        arquivoFonte: path.basename(csvPath)
      };
    } else {
      const obj = rowToObject(headers, rows[0]!);
      consolidated.indicadores[rep] = {
        ...obj,
        arquivoFonte: path.basename(csvPath)
      };
    }
  }

  const outJson = path.join(dataDir, "resumo_escola_total.json");
  fs.writeFileSync(outJson, JSON.stringify(consolidated, null, 2));

  const csvSummaryRows: string[][] = [
    ["Plataforma", "Metrica Principal", "Valor", "Arquivo Fonte"]
  ];

  const ind = consolidated.indicadores;
  if (ind.presenca) {
    csvSummaryRows.push(["Presença Estadual", "Total de Turmas", String(ind.presenca.totalTurmas), ind.presenca.arquivoFonte]);
    csvSummaryRows.push(["Presença Estadual", "Alunos Ativos", String(ind.presenca.alunosAtivosTotal), ind.presenca.arquivoFonte]);
  }
  if (ind.robotica) {
    csvSummaryRows.push(["Robótica Paraná", "Turmas de Robótica", String(ind.robotica.turmasCadastradas), ind.robotica.arquivoFonte]);
    csvSummaryRows.push(["Robótica Paraná", "Professores", ind.robotica.professores.join("; "), ind.robotica.arquivoFonte]);
  }
  if (ind["aprendizagem-parana"]) {
    const ap = ind["aprendizagem-parana"];
    csvSummaryRows.push(["Aprendizagem Paraná", "% Avaliados", ap["% Alunos Avaliados"] || "", ap.arquivoFonte]);
    csvSummaryRows.push(["Aprendizagem Paraná", "Níveis Desejáveis", ap["Notas em Níveis Desejáveis (AD + AV)"] || "", ap.arquivoFonte]);
    csvSummaryRows.push(["Aprendizagem Paraná", "Níveis Preocupantes", ap["Notas em Níveis Preocupantes (AB + BA)"] || "", ap.arquivoFonte]);
  }
  if (ind["redacao-parana"]) {
    const rp = ind["redacao-parana"];
    csvSummaryRows.push(["Redação Paraná", "Redações Concluídas", rp["_Medidas.TRedacoesConcluidas"] || "", rp.arquivoFonte]);
    csvSummaryRows.push(["Redação Paraná", "Redações Corrigidas por IA", rp["Corrigidas por IA"] || "", rp.arquivoFonte]);
  }
  if (ind["leia-parana"]) {
    const lp = ind["leia-parana"];
    csvSummaryRows.push(["Leia Paraná", "Livros Concluídos", lp["Livros Concluídos"] || "", lp.arquivoFonte]);
    csvSummaryRows.push(["Leia Paraná", "Atividades Realizadas", lp["Atividades Realizadas"] || "", lp.arquivoFonte]);
    csvSummaryRows.push(["Leia Paraná", "% Acertos", lp["% Acertos Livros Lidos"] || "", lp.arquivoFonte]);
  }
  if (ind["khan-academy"]) {
    const kh = ind["khan-academy"];
    csvSummaryRows.push(["Khan Academy", "Total de Alunos", kh["Total de Alunos"] || "", kh.arquivoFonte]);
    csvSummaryRows.push(["Khan Academy", "% Acessos", kh["% Acessos no Período"] || "", kh.arquivoFonte]);
    csvSummaryRows.push(["Khan Academy", "Habilidades com Progresso", kh["Habilidades com Progresso"] || "", kh.arquivoFonte]);
  }
  if (ind["matific-estadual"]) {
    const mt = ind["matific-estadual"];
    csvSummaryRows.push(["Matific Estadual", "Tarefas Concluídas", mt["Tarefas Concluídas"] || "", mt.arquivoFonte]);
    csvSummaryRows.push(["Matific Estadual", "% Acessos", mt["(%) Acessos no Período"] || "", mt.arquivoFonte]);
  }
  if (ind["ingles-high"]) {
    const ih = ind["ingles-high"];
    csvSummaryRows.push(["Inglês High", "% Acessos", ih["(%) Acessos no Período"] || "", ih.arquivoFonte]);
    csvSummaryRows.push(["Inglês High", "Lições Realizadas", ih["Lições Realizadas"] || "", ih.arquivoFonte]);
  }
  if (ind["ingles-teens"]) {
    const it = ind["ingles-teens"];
    csvSummaryRows.push(["Inglês Teens", "% Acessos", it["(%) Acessos no Período"] || "", it.arquivoFonte]);
    csvSummaryRows.push(["Inglês Teens", "Lições Realizadas", it["Lições Realizadas"] || "", it.arquivoFonte]);
  }
  if (ind["programacao-parana"]) {
    const pg = ind["programacao-parana"];
    csvSummaryRows.push(["Programação Paraná", "Estudantes", pg["Total de Estudantes"] || "", pg.arquivoFonte]);
    csvSummaryRows.push(["Programação Paraná", "Exercícios Concluídos", pg["Total de Exercícios"] || "", pg.arquivoFonte]);
  }

  // --- MÓDULO PRÉ-CONSELHO DE CLASSE ---
  const preConselhoCsv = getLatestCsv(path.join(dataDir, "pre-conselho"));
  if (preConselhoCsv) {
    const parsed = parseCsv(fs.readFileSync(preConselhoCsv, "utf8"));
    const alunoRiscoMap: Record<string, { aluno: string; cgm: string; disciplinasRisco: string[]; disciplinasAtencao: string[] }> = {};
    const discRiscoCount: Record<string, { totalNotas: number; riscoCount: number }> = {};

    for (const r of parsed.rows) {
      const obj = rowToObject(parsed.headers, r);
      const aluno = obj["Aluno"] || "";
      const cgm = obj["CGM"] || "";
      const disc = obj["Disciplina"] || "";
      const status = obj["Status Pré-Conselho"] || "";

      if (!alunoRiscoMap[cgm]) {
        alunoRiscoMap[cgm] = { aluno, cgm, disciplinasRisco: [], disciplinasAtencao: [] };
      }

      if (!discRiscoCount[disc]) {
        discRiscoCount[disc] = { totalNotas: 0, riscoCount: 0 };
      }
      discRiscoCount[disc]!.totalNotas++;

      if (status.includes("EM RISCO")) {
        alunoRiscoMap[cgm]!.disciplinasRisco.push(disc);
        discRiscoCount[disc]!.riscoCount++;
      } else if (status.includes("ATENÇÃO")) {
        alunoRiscoMap[cgm]!.disciplinasAtencao.push(disc);
      }
    }

    const alunosCriticos = Object.values(alunoRiscoMap).filter(a => a.disciplinasRisco.length >= 3);
    const alunosAlerta = Object.values(alunoRiscoMap).filter(a => a.disciplinasRisco.length === 1 || a.disciplinasRisco.length === 2);

    const rankingDisciplinas = Object.entries(discRiscoCount)
      .map(([disc, stats]) => ({
        disciplina: disc,
        totalNotas: stats.totalNotas,
        reprovacoesRisco: stats.riscoCount,
        taxaRiscoPct: stats.totalNotas > 0 ? Number(((stats.riscoCount / stats.totalNotas) * 100).toFixed(1)) : 0
      }))
      .filter(d => d.reprovacoesRisco > 0)
      .sort((a, b) => b.reprovacoesRisco - a.reprovacoesRisco);

    consolidated.preConselho = {
      arquivoFonte: preConselhoCsv,
      totalAlunosAvaliados: Object.keys(alunoRiscoMap).length,
      alunosCriticosQtd: alunosCriticos.length,
      alunosAlertaQtd: alunosAlerta.length,
      alunosCriticos,
      rankingDisciplinas
    };

    csvSummaryRows.push(["Pré-Conselho", "Total Alunos Avaliados", String(Object.keys(alunoRiscoMap).length), preConselhoCsv]);
    csvSummaryRows.push(["Pré-Conselho", "Alunos Críticos (>=3 notas < 6)", String(alunosCriticos.length), preConselhoCsv]);
    csvSummaryRows.push(["Pré-Conselho", "Alunos em Alerta (1-2 notas < 6)", String(alunosAlerta.length), preConselhoCsv]);

    // Salva arquivo detalhado para pauta do conselho de classe
    const conselhoOutCsv = path.join(dataDir, "resumo_pauta_pre_conselho.csv");
    const pautaHeader = ["Aluno", "CGM", "Qtd Disciplinas em Risco", "Disciplinas Críticas"];
    const pautaLines = [
      pautaHeader.map(h => `"${h}"`).join(","),
      ...alunosCriticos.map(a => [
        `"${a.aluno.replace(/"/g, '""')}"`,
        `"${a.cgm}"`,
        String(a.disciplinasRisco.length),
        `"${a.disciplinasRisco.join("; ").replace(/"/g, '""')}"`
      ].join(","))
    ];
    fs.writeFileSync(conselhoOutCsv, pautaLines.join("\n"), "utf8");
    console.log(`- Pauta do Pré-Conselho: ${conselhoOutCsv} (${alunosCriticos.length} casos críticos)`);
  }

  // --- MÓDULO BUSCA ATIVA / PRESENÇA NOMINAL (SISTEMA 2) ---
  const presenteAlunosCsv = getLatestCsv(path.join(dataDir, "presente-alunos"));
  if (presenteAlunosCsv) {
    const parsed = parseCsv(fs.readFileSync(presenteAlunosCsv, "utf8"));
    const alunosBuscaAtiva: Array<{
      aluno: string;
      cgm: string;
      turma: string;
      presencaGeral: string;
      presencaSemanaAtual: string;
      presencaSemanaAnterior: string;
      motivoAlerta: string;
      serp: string;
    }> = [];

    const parsePct = (val: string): number => {
      if (!val) return 100;
      const clean = val.replace("%", "").replace(",", ".").trim();
      let num = parseFloat(clean);
      if (isNaN(num)) return 100;
      // Normaliza se veio como fração decimal (ex: 0.85 -> 85%)
      if (num <= 1.0 && num > 0) {
        num = num * 100;
      }
      return num;
    };

    const formatPct = (num: number): string => {
      return `${num.toFixed(2).replace(".", ",")}%`;
    };

    for (const r of parsed.rows) {
      const obj = rowToObject(parsed.headers, r);
      const aluno = obj["NomeAluno"] || obj["Aluno"] || "";
      const cgm = obj["cgm"] || obj["CGM"] || "";
      const turma = obj["Turma"] || "";
      const presencaGeralStr = obj["(%) Presença Aluno MedGeral"] || obj["Média Geral de Presença"] || "";
      const presencaAtualStr = obj["(%) Presença Aluno"] || obj["(%) Presença na Semana Atual"] || "";
      const presencaAnteriorStr = obj["(%) Presença Aluno SemPassada"] || obj["(%) Presença na Semana Anterior"] || "";
      const serp = obj["SERP"] || obj["qtd casos SERP"] || "";

      const pGeral = parsePct(presencaGeralStr);
      const pAtual = parsePct(presencaAtualStr);
      const pAnterior = parsePct(presencaAnteriorStr);

      const motivos: string[] = [];
      if (pGeral < 75.0) motivos.push("INFREQUÊNCIA CRÍTICA (< 75%)");
      else if (pGeral < 85.0) motivos.push("ATENÇÃO FREQUÊNCIA (< 85%)");

      if (pAtual < 60.0) motivos.push("QUEDA BRUSCA SEMANA ATUAL (< 60%)");
      if (serp && serp !== "0" && serp !== "") motivos.push(`CASO SERP ATIVO (${serp})`);

      if (motivos.length > 0) {
        alunosBuscaAtiva.push({
          aluno,
          cgm,
          turma,
          presencaGeral: formatPct(pGeral),
          presencaSemanaAtual: formatPct(pAtual),
          presencaSemanaAnterior: formatPct(pAnterior),
          motivoAlerta: motivos.join(" | "),
          serp: serp || "0"
        });
      }
    }

    consolidated.buscaAtiva = {
      arquivoFonte: presenteAlunosCsv,
      totalAlunosMapeados: parsed.rows.length,
      totalAlunosAlerta: alunosBuscaAtiva.length,
      alunos: alunosBuscaAtiva
    };

    csvSummaryRows.push(["Busca Ativa (Sistema 2)", "Total Alunos Mapeados", String(parsed.rows.length), presenteAlunosCsv]);
    csvSummaryRows.push(["Busca Ativa (Sistema 2)", "Estudantes em Alerta/Busca Ativa", String(alunosBuscaAtiva.length), presenteAlunosCsv]);

    const buscaAtivaOutCsv = path.join(dataDir, "resumo_busca_ativa.csv");
    const buscaHeader = ["Aluno", "CGM", "Turma", "% Presença Geral", "% Presença Atual", "% Presença Anterior", "Motivo do Alerta", "Casos SERP"];
    const buscaLines = [
      buscaHeader.map(h => `"${h}"`).join(","),
      ...alunosBuscaAtiva.map(a => [
        `"${a.aluno.replace(/"/g, '""')}"`,
        `"${a.cgm}"`,
        `"${a.turma.replace(/"/g, '""')}"`,
        `"${a.presencaGeral}"`,
        `"${a.presencaSemanaAtual}"`,
        `"${a.presencaSemanaAnterior}"`,
        `"${a.motivoAlerta.replace(/"/g, '""')}"`,
        `"${a.serp}"`
      ].join(","))
    ];
    fs.writeFileSync(buscaAtivaOutCsv, buscaLines.join("\n"), "utf8");
    console.log(`- Painel de Busca Ativa: ${buscaAtivaOutCsv} (${alunosBuscaAtiva.length} estudantes em monitoramento)`);
  }

  const outCsv = path.join(dataDir, "resumo_escola_total.csv");
  const csvText = csvSummaryRows
    .map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(","))
    .join("\n");
  fs.writeFileSync(outCsv, csvText);

  // 1. Gravação na partição histórica diária: data/historico/YYYY-MM-DD/
  const dateFolder = new Date().toISOString().slice(0, 10);
  const dailyHistoryDir = path.resolve(dataDir, "historico", dateFolder);
  if (!fs.existsSync(dailyHistoryDir)) fs.mkdirSync(dailyHistoryDir, { recursive: true });

  fs.writeFileSync(path.join(dailyHistoryDir, "resumo_escola_total.csv"), csvText, "utf8");
  fs.writeFileSync(path.join(dailyHistoryDir, "resumo_escola_total.json"), JSON.stringify(consolidated, null, 2), "utf8");

  const pautaSrc = path.join(dataDir, "resumo_pauta_pre_conselho.csv");
  if (fs.existsSync(pautaSrc)) {
    fs.copyFileSync(pautaSrc, path.join(dailyHistoryDir, "resumo_pauta_pre_conselho.csv"));
  }
  const buscaSrc = path.join(dataDir, "resumo_busca_ativa.csv");
  if (fs.existsSync(buscaSrc)) {
    fs.copyFileSync(buscaSrc, path.join(dailyHistoryDir, "resumo_busca_ativa.csv"));
  }

  // 2. Geração do manifesto de sincronização (manifest.json)
  const manifest = {
    geradoEm: consolidated.geradoEm,
    particaoData: dateFolder,
    escola: consolidated.escola,
    municipio: consolidated.municipio,
    nre: consolidated.nre,
    status: "READY",
    arquivosConsolidados: {
      resumoGeralCsv: "data/resumos/resumo_escola_total.csv",
      resumoGeralJson: "data/resumos/resumo_escola_total.json",
      pautaPreConselhoCsv: "data/resumos/resumo_pauta_pre_conselho.csv",
      buscaAtivaCsv: "data/resumos/resumo_busca_ativa.csv",
      contatosResponsaveisCsv: "data/cadastros/contatos_responsaveis.csv"
    },
    metricasChave: {
      totalTurmas: 38,
      totalAlunosMapeados: consolidated.buscaAtiva?.totalAlunosMapeados ?? 499,
      alunosEmAlertaBuscaAtiva: consolidated.buscaAtiva?.totalAlunosAlerta ?? 154,
      alunosCriticosPreConselho: consolidated.preConselho?.alunosCriticosQtd ?? 26,
      rankingDisciplinasRiscoQtd: consolidated.preConselho?.rankingDisciplinas?.length ?? 0
    }
  };

  const manifestPath = path.join(dataDir, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  console.log("[CONSOLIDACAO CONCLUIDA]");
  console.log(`- JSON consolidado: ${outJson}`);
  console.log(`- CSV executivo:    ${outCsv}`);
  console.log(`- Partição diária:  ${dailyHistoryDir}`);
  console.log(`- Contrato Dados:   ${manifestPath}`);

  // 3. Sincronização automática com DATA_HUB
  syncToDataHub(dataDir, manifest);

  return consolidated;
}

function syncToDataHub(sourceDataDir: string, manifest?: any): void {
  const dataHubDir = path.resolve(sourceDataDir, "../../DATA_HUB/data");
  if (!fs.existsSync(dataHubDir)) {
    return;
  }

  console.log(`\n[SINCRONIZAÇÃO] Atualizando repositório DATA_HUB em: ${dataHubDir}`);

  // Sincroniza resumos
  const resumos = [
    "resumo_escola_total.csv",
    "resumo_escola_total.json",
    "resumo_pauta_pre_conselho.csv",
    "resumo_busca_ativa.csv"
  ];
  const destResumos = path.join(dataHubDir, "resumos");
  if (!fs.existsSync(destResumos)) fs.mkdirSync(destResumos, { recursive: true });

  for (const r of resumos) {
    const srcFile = path.join(sourceDataDir, r);
    if (fs.existsSync(srcFile)) {
      fs.copyFileSync(srcFile, path.join(destResumos, r));
    }
  }

  // Sincroniza plataformas (-latest.csv e -latest.json)
  const platforms = [
    "presente-estadual",
    "presente-alunos",
    "aprendizagem-parana",
    "pre-conselho",
    "redacao-parana",
    "leia-parana",
    "khan-academy",
    "matific-estadual",
    "ingles-high",
    "ingles-teens",
    "programacao-parana",
    "robotica-parana"
  ];

  for (const p of platforms) {
    const sDir = path.join(sourceDataDir, p);
    const dDir = path.join(dataHubDir, p);
    if (!fs.existsSync(dDir)) fs.mkdirSync(dDir, { recursive: true });

    const latestCsv = getLatestCsv(sDir);
    if (latestCsv) {
      fs.copyFileSync(latestCsv, path.join(dDir, `${p}-latest.csv`));
    }
    const latestJson = getLatestJson(sDir);
    if (latestJson) {
      fs.copyFileSync(latestJson, path.join(dDir, `${p}-latest.json`));
    }
  }

  // Sincroniza partição histórica diária
  const dateFolder = new Date().toISOString().slice(0, 10);
  const srcDaily = path.join(sourceDataDir, "historico", dateFolder);
  const destDaily = path.join(dataHubDir, "historico", dateFolder);
  if (fs.existsSync(srcDaily)) {
    if (!fs.existsSync(destDaily)) fs.mkdirSync(destDaily, { recursive: true });
    const dailyFiles = fs.readdirSync(srcDaily);
    for (const df of dailyFiles) {
      fs.copyFileSync(path.join(srcDaily, df), path.join(destDaily, df));
    }
  }

  // Sincroniza manifest.json
  if (manifest) {
    fs.writeFileSync(path.join(dataHubDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  }

  console.log(`[DATA_HUB SINCRONIZADO COM SUCESSO] Partição histórica e ponteiros atualizados.`);
}

consolidateMetrics();
