import type { AlunoFrequencia } from "./presenca.js";
import type { ContatoResponsavel } from "./contatos.js";
import { formatarPercentual } from "./percentual.js";
import { turmaLegivel } from "./modelo.js";

export interface AlunoOrgaoCompetente {
  aluno: AlunoFrequencia;
  contatos: ContatoResponsavel[];
  motivos: string[];
  totalFaltasAproximado?: number;
}

export interface DadosRelatorioConselho {
  escolaNome: string;
  telefoneContato: string;
  municipio: string;
  dataGeracao: string;
  alunos: AlunoOrgaoCompetente[];
}

/**
 * Filtra alunos que exigem comunicação aos órgãos de proteção (Conselho Tutelar / SERP / Ministério Público).
 * Critério legal: Infrequência crítica (abaixo de 75% conforme LDB Lei 9.394/96 Art. 12 e ECA Lei 8.069/90 Art. 56).
 */
export function identificarCasosOrgaosCompetentes(
  alunos: AlunoFrequencia[],
  contatosMap: Map<string, ContatoResponsavel[]>,
  limiteCritico = 75
): AlunoOrgaoCompetente[] {
  const casos: AlunoOrgaoCompetente[] = [];

  for (const aluno of alunos) {
    const motivos: string[] = [];
    if (aluno.presencaGeral !== null && aluno.presencaGeral < limiteCritico) {
      motivos.push(`Frequência geral em ${formatarPercentual(aluno.presencaGeral, 1)} (abaixo do teto legal de 75%)`);
    }

    if (aluno.presencaSemanaAtual !== null && aluno.presencaSemanaAtual <= 40) {
      motivos.push(`Ausência severa na semana recente (${formatarPercentual(aluno.presencaSemanaAtual)} de presença)`);
    }

    if (motivos.length > 0) {
      casos.push({
        aluno,
        contatos: contatosMap.get(aluno.cgm) ?? [],
        motivos
      });
    }
  }

  // Ordena pelos casos com menor frequência geral
  casos.sort((a, b) => (a.aluno.presencaGeral ?? 100) - (b.aluno.presencaGeral ?? 100));
  return casos;
}

/**
 * Gera documento HTML oficial para impressão da Ficha de Notificação / FICAI
 * destinada ao Conselho Tutelar e órgãos de proteção dos direitos da criança e do adolescente.
 */
export function gerarHtmlNotificacaoConselhoTutelar(dados: DadosRelatorioConselho): string {
  const linhasTabela = dados.alunos.map((item, idx) => {
    const contatosStr = item.contatos.length > 0
      ? item.contatos.map(c => `<b>${c.responsavel || "Responsável"}:</b> ${c.telefone || c.email || "Sem telefone"}`).join("<br>")
      : "<i>Nenhum contato cadastrado</i>";

    return `
      <tr>
        <td style="text-align: center;">${idx + 1}</td>
        <td><strong>${item.aluno.nome}</strong><br><small style="color: #555;">CGM: ${item.aluno.cgm}</small></td>
        <td>${item.aluno.turmas.map(turmaLegivel).join(", ") || "-"}</td>
        <td style="text-align: center; font-weight: bold; color: #b91c1c;">
          ${formatarPercentual(item.aluno.presencaGeral, 1)}
        </td>
        <td style="font-size: 13px;">${item.motivos.join("<br>")}</td>
        <td style="font-size: 13px;">${contatosStr}</td>
      </tr>
    `;
  }).join("");

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <title>Notificação ao Conselho Tutelar - FICAI / Infrequência Escolar</title>
  <style>
    @page { size: A4 portrait; margin: 15mm; }
    body { font-family: "Segoe UI", Arial, sans-serif; color: #111; line-height: 1.4; margin: 0; padding: 20px; font-size: 14px; }
    .header { text-align: center; border-bottom: 2px solid #333; padding-bottom: 12px; margin-bottom: 20px; }
    .header h1 { font-size: 18px; text-transform: uppercase; margin: 0 0 4px 0; }
    .header h2 { font-size: 15px; font-weight: normal; margin: 0 0 4px 0; color: #444; }
    .header p { font-size: 12px; margin: 0; color: #666; }
    .fundamentacao { background: #f8fafc; border-left: 4px solid #2563eb; padding: 10px 14px; margin-bottom: 20px; font-size: 12px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 25px; }
    th, td { border: 1px solid #cbd5e1; padding: 8px 10px; text-align: left; }
    th { background: #f1f5f9; font-size: 12px; text-transform: uppercase; color: #334155; }
    .footer { margin-top: 40px; page-break-inside: avoid; }
    .signatures { display: flex; justify-content: space-between; margin-top: 60px; }
    .sig-box { width: 45%; text-align: center; border-top: 1px solid #000; padding-top: 6px; font-size: 13px; }
    .no-print { margin-bottom: 15px; }
    .btn-print { background: #1e40af; color: #fff; border: none; padding: 10px 18px; font-size: 14px; font-weight: 600; border-radius: 6px; cursor: pointer; }
    .btn-print:hover { background: #1d4ed8; }
    @media print {
      .no-print { display: none !important; }
      body { padding: 0; }
    }
  </style>
</head>
<body>
  <div class="no-print">
    <button class="btn-print" onclick="window.print()">🖨️ Imprimir / Salvar como PDF</button>
    <span style="margin-left: 10px; color: #555; font-size: 13px;">Dica: use a impressora nativa do navegador para salvar em PDF.</span>
  </div>

  <div class="header">
    <h1>ESTADO DO PARANÁ - SECRETARIA DE ESTADO DA EDUCAÇÃO</h1>
    <h2>${dados.escolaNome} - ${dados.municipio}</h2>
    <p>Telefone de Contato: ${dados.telefoneContato} | Data de Emissão: ${dados.dataGeracao}</p>
    <h3 style="margin-top: 14px; font-size: 16px; color: #991b1b;">
      COMUNICAÇÃO DE INFREQUÊNCIA ESCOLAR REITERADA AO CONSELHO TUTELAR
    </h3>
  </div>

  <div class="fundamentacao">
    <strong>Fundamentação Legal:</strong><br>
    • <em>Lei nº 9.394/1996 (LDB), Art. 12, VIII:</em> Obrigação de notificar ao Conselho Tutelar e à autoridade competente a relação dos alunos que apresentem quantidade de faltas acima de 30% do percentual permitido em lei.<br>
    • <em>Lei nº 8.069/1990 (ECA), Art. 56, II:</em> Os dirigentes de estabelecimentos de ensino comunicarão ao Conselho Tutelar os casos de reiteração de faltas injustificadas e de evasão escolar, esgotados os recursos escolares.
  </div>

  <p>
    Vimos por meio deste encaminhar a relação de estudantes matriculados nesta instituição que atingiram índices críticos de faltas não justificadas e infrequência severa, após esgotadas as notificações aos responsáveis legais e as tentativas de busca ativa escolar:
  </p>

  <table>
    <thead>
      <tr>
        <th style="width: 4%;">Nº</th>
        <th style="width: 25%;">Estudante / CGM</th>
        <th style="width: 16%;">Turma</th>
        <th style="width: 12%; text-align: center;">Presença Geral</th>
        <th style="width: 23%;">Situação Identificada</th>
        <th style="width: 20%;">Contatos Registrados</th>
      </tr>
    </thead>
    <tbody>
      ${linhasTabela || '<tr><td colspan="6" style="text-align: center; padding: 20px;">Nenhum aluno em situação de infrequência crítica registrado no período.</td></tr>'}
    </tbody>
  </table>

  <p style="font-size: 12px; color: #475569;">
    Solicitamos a intervenção protetiva deste respeitável órgão para a garantia do direito fundamental à educação e à convivência escolar regular, nos termos da legislação vigente.
  </p>

  <div class="footer">
    <div class="signatures">
      <div class="sig-box">
        Coordenação Pedagógica / Equipe de Busca Ativa
      </div>
      <div class="sig-box">
        Direção Escolar
      </div>
    </div>
  </div>
</body>
</html>`;
}
