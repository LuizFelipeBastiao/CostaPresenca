import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { carregarConfigNotificacoes, carregarEnv, type NotificacoesConfig } from "./notificacoes/config.js";
import { carregarContatos } from "./notificacoes/fontes.js";
import { localizarCsvMaisRecente, paraCsv } from "./notificacoes/csv.js";
import { HistoricoEnvios, hashDestino, type StatusEnvio } from "./notificacoes/historico.js";
import { planejar, type Plano } from "./notificacoes/planejar.js";
import { lerPresencaArquivo, type AlunoFrequencia } from "./notificacoes/presenca.js";
import { semanaDeReferencia } from "./notificacoes/regras.js";
import { criarSender } from "./notificacoes/senders/index.js";
import { normalizarTelefone, mascararTelefone } from "./notificacoes/contatos.js";
import { identificarCasosOrgaosCompetentes, gerarHtmlNotificacaoConselhoTutelar } from "./notificacoes/orgaos.js";
import { consolidateMetrics } from "./consolidate.js";

const PORTA = Number(process.env.PORT || 3000);

carregarEnv();

function obterCaminhoCsvPresenca(config: NotificacoesConfig): string {
  const dir = path.resolve(config.dataDirectory, config.fontePresenca);
  const arquivo = localizarCsvMaisRecente(dir, config.fontePresenca);
  if (!arquivo) throw new Error(`Nenhum CSV de presença em ${dir}.`);
  return arquivo;
}

function processarPlanoAtual(config: NotificacoesConfig) {
  const arquivoCsv = obterCaminhoCsvPresenca(config);
  const mtime = fs.statSync(arquivoCsv).mtime;
  const semana = semanaDeReferencia(mtime, config.regras.semanaReferencia);
  const alunos = lerPresencaArquivo(arquivoCsv);
  const { contatos, avisos, origem } = carregarContatos(config);
  const historico = HistoricoEnvios.carregar(config.saidaDirectory);
  const plano = planejar(alunos, contatos, config, semana, config.canal, historico);
  return { plano, semana, arquivoCsv, mtime, alunos, contatos, avisos, origem, historico };
}

function responderJson(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function responderHtml(res: http.ServerResponse, status: number, html: string) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function lerBodyJson(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const pathname = url.pathname;
  const method = req.method || "GET";

  // CORS básico para permitir requisições locais
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    const config = await carregarConfigNotificacoes();

    // 1. Status Geral do Sistema
    if (pathname === "/api/status" && method === "GET") {
      let dadosPresentes = false;
      let totalAlunos = 0;
      let dataUltimaColeta = "";
      let mtimeStr = "";

      try {
        const arquivo = obterCaminhoCsvPresenca(config);
        dadosPresentes = true;
        const stat = fs.statSync(arquivo);
        mtimeStr = stat.mtime.toLocaleString("pt-BR");
        const alunos = lerPresencaArquivo(arquivo);
        totalAlunos = alunos.length;
        dataUltimaColeta = path.basename(arquivo);
      } catch {}

      const { contatos, origem } = carregarContatos(config);

      return responderJson(res, 200, {
        escola: config.escola.nome,
        telefone: config.escola.telefoneContato,
        canal: config.canal,
        dadosPresentes,
        totalAlunos,
        dataUltimaColeta: mtimeStr || "Não encontrada",
        arquivoFonte: dataUltimaColeta,
        contatosCadastrados: contatos.size,
        origemContatos: origem,
        regras: config.regras
      });
    }

    // 2. Prévia das Mensagens de Notificação
    if (pathname === "/api/previa" && method === "GET") {
      const { plano, semana, arquivoCsv, mtime } = processarPlanoAtual(config);
      const prontos = plano.itens.filter(i => i.status === "pronto");
      const criticos = plano.itens.filter(i => i.tipo === "critica");
      const semContato = plano.itens.filter(i => i.status === "sem-contato");
      const semConsentimento = plano.itens.filter(i => i.status === "sem-consentimento");

      return responderJson(res, 200, {
        semana: semana.rotulo,
        chaveSemana: semana.chave,
        dataColeta: mtime.toLocaleString("pt-BR"),
        totalAlunos: plano.totalAlunos,
        totalFaltas: plano.itens.length,
        prontosQtd: prontos.length,
        criticosQtd: criticos.length,
        semContatoQtd: semContato.length,
        semConsentimentoQtd: semConsentimento.length,
        ignorados: plano.ignorados,
        itens: plano.itens.map(i => ({
          cgm: i.aluno.cgm,
          aluno: i.valores.aluno,
          turma: i.valores.turma,
          tipo: i.tipo,
          status: i.status,
          presencaSemana: i.valores.presencaSemana,
          presencaGeral: i.valores.presencaGeral,
          responsavel: i.contato?.responsavel || "Não cadastrado",
          destino: i.destino,
          destinoMascarado: i.destino ? mascararTelefone(i.destino) : "-",
          assunto: i.assunto,
          mensagem: i.texto
        }))
      });
    }

    // 3. Execução dos Disparos
    if (pathname === "/api/notificar/executar" && method === "POST") {
      const body = await lerBodyJson(req);
      const destinoTeste = body.destinoTeste ? normalizarTelefone(body.destinoTeste) : null;
      const { plano, semana, historico, mtime } = processarPlanoAtual(config);

      const prontos = plano.itens.filter(i => i.status === "pronto");
      const limite = Math.min(destinoTeste ? 3 : config.maxEnviosPorExecucao, body.limite || 300);
      const fila = (destinoTeste ? plano.itens.filter(i => i.status !== "sem-contato") : prontos).slice(0, limite);

      if (fila.length === 0) {
        return responderJson(res, 200, { sucesso: true, enviados: 0, mensagem: "Nenhuma mensagem pendente para envio." });
      }

      const sender = criarSender(config);
      const runId = randomUUID();
      let enviados = 0;
      let falhas = 0;
      const resultados: any[] = [];

      for (const item of fila) {
        const destino = destinoTeste ?? item.destino!;
        let status: StatusEnvio;
        let erro: string | undefined;
        let idMensagem: string | undefined;

        try {
          const r = await sender.enviar({
            destino,
            assunto: item.assunto,
            texto: item.texto,
            valores: item.valores,
            cgm: item.aluno.cgm,
            tipo: item.tipo
          });
          idMensagem = r.idMensagem;
          status = destinoTeste ? "teste" : sender.canal === "dry-run" ? "simulado" : "enviado";
          enviados++;
        } catch (e) {
          status = "falhou";
          erro = e instanceof Error ? e.message : String(e);
          falhas++;
        }

        await historico.registrar({
          timestamp: new Date().toISOString(),
          runId,
          cgm: item.aluno.cgm,
          destinoHash: hashDestino(destino),
          canal: sender.canal,
          tipo: item.tipo,
          semana: semana.chave,
          status,
          ...(idMensagem ? { idMensagem } : {}),
          ...(erro ? { erro } : {})
        });

        resultados.push({
          cgm: item.aluno.cgm,
          aluno: item.valores.aluno,
          destino: mascararTelefone(destino),
          status,
          erro
        });
      }

      // Atualiza execuções
      const saidaDir = path.resolve(config.saidaDirectory);
      fs.mkdirSync(saidaDir, { recursive: true });
      fs.appendFileSync(
        path.join(saidaDir, "execucoes.jsonl"),
        `${JSON.stringify({
          timestamp: new Date().toISOString(),
          runId,
          canal: sender.canal,
          teste: destinoTeste !== null,
          semana: semana.chave,
          enviados,
          falhas
        })}\n`,
        "utf8"
      );

      return responderJson(res, 200, {
        sucesso: true,
        enviados,
        falhas,
        canal: sender.canal,
        resultados
      });
    }

    // 4. Busca Ativa & Alunos em Risco
    if (pathname === "/api/busca-ativa" && method === "GET") {
      const { alunos, contatos } = processarPlanoAtual(config);
      const casosOrgaos = identificarCasosOrgaosCompetentes(alunos, contatos, config.regras.presencaGeralCriticaAbaixoDe);

      return responderJson(res, 200, {
        totalCasos: casosOrgaos.length,
        alunos: casosOrgaos.map(c => ({
          cgm: c.aluno.cgm,
          nome: c.aluno.nome,
          turmas: c.aluno.turmas,
          presencaGeral: c.aluno.presencaGeral,
          presencaSemana: c.aluno.presencaSemanaAtual,
          motivos: c.motivos,
          responsaveis: c.contatos.map(x => `${x.responsavel} (${x.telefone ? mascararTelefone(x.telefone) : "sem fone"})`).join("; ")
        }))
      });
    }

    // 5. Salvar Novo Contato de Aluno
    if (pathname === "/api/contatos/salvar" && method === "POST") {
      const body = await lerBodyJson(req);
      const cgm = String(body.cgm || "").trim().replace(/\D/g, "");
      const responsavel = String(body.responsavel || "").trim();
      const telefoneBruto = String(body.telefone || "").trim();
      const telefone = normalizarTelefone(telefoneBruto);

      if (!cgm || !responsavel || !telefone) {
        return responderJson(res, 400, { erro: "CGM, Responsável e Telefone válido são obrigatórios." });
      }

      const arquivoContatos = path.resolve(config.contatosCsv);
      fs.mkdirSync(path.dirname(arquivoContatos), { recursive: true });

      if (!fs.existsSync(arquivoContatos)) {
        fs.writeFileSync(arquivoContatos, "cgm;aluno;responsavel;telefone;email;consentimento\n", "utf8");
      }

      const novaLinha = `${cgm};;${responsavel};${telefone};;sim\n`;
      fs.appendFileSync(arquivoContatos, novaLinha, "utf8");

      return responderJson(res, 200, { sucesso: true, mensagem: `Contato de ${responsavel} cadastrado com sucesso!` });
    }

    // 6. Notificação Oficial do Conselho Tutelar (HTML para Impressão)
    if (pathname === "/conselho-tutelar" && method === "GET") {
      const { alunos, contatos } = processarPlanoAtual(config);
      const casos = identificarCasosOrgaosCompetentes(alunos, contatos, config.regras.presencaGeralCriticaAbaixoDe);

      const html = gerarHtmlNotificacaoConselhoTutelar({
        escolaNome: config.escola.nome,
        telefoneContato: config.escola.telefoneContato,
        municipio: "Medianeira - PR",
        dataGeracao: new Date().toLocaleDateString("pt-BR"),
        alunos: casos
      });

      return responderHtml(res, 200, html);
    }

    // 7. Rodar Consolidação Geral
    if (pathname === "/api/consolidar" && method === "POST") {
      try {
        const resultado = consolidateMetrics(config.dataDirectory);
        return responderJson(res, 200, { sucesso: true, mensagem: "Consolidação e Busca Ativa geradas com êxito!", resumo: resultado });
      } catch (err: any) {
        return responderJson(res, 500, { erro: err?.message || String(err) });
      }
    }

    // 8. Histórico de Notificações
    if (pathname === "/api/historico" && method === "GET") {
      const arquivoExec = path.resolve(config.saidaDirectory, "execucoes.jsonl");
      const arquivoEnvios = path.resolve(config.saidaDirectory, "envios.jsonl");
      const execucoes: any[] = [];
      const envios: any[] = [];

      if (fs.existsSync(arquivoExec)) {
        const linhas = fs.readFileSync(arquivoExec, "utf8").split(/\r?\n/).filter(Boolean);
        for (const l of linhas.slice(-15).reverse()) {
          try { execucoes.push(JSON.parse(l)); } catch {}
        }
      }

      if (fs.existsSync(arquivoEnvios)) {
        const linhas = fs.readFileSync(arquivoEnvios, "utf8").split(/\r?\n/).filter(Boolean);
        for (const l of linhas.slice(-30).reverse()) {
          try { envios.push(JSON.parse(l)); } catch {}
        }
      }

      return responderJson(res, 200, { execucoes, envios });
    }

    // 9. Página Principal da Interface Gráfica (Dashboard SPA)
    if (pathname === "/" || pathname === "/index.html") {
      return responderHtml(res, 200, gerarHtmlDashboard());
    }

    responderJson(res, 404, { erro: "Rota não encontrada" });
  } catch (error: any) {
    responderJson(res, 500, { erro: error?.message || String(error) });
  }
});

function gerarHtmlDashboard(): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sistema de Frequência Escolar | CostaPresença</title>
  <style>
    :root {
      --primary: #1e40af;
      --primary-hover: #1d4ed8;
      --bg: #f8fafc;
      --surface: #ffffff;
      --text: #0f172a;
      --text-muted: #64748b;
      --border: #e2e8f0;
      --success: #15803d;
      --warning: #b45309;
      --danger: #b91c1c;
      --radius: 10px;
      --shadow: 0 4px 6px -1px rgb(0 0 0 / 0.07), 0 2px 4px -2px rgb(0 0 0 / 0.07);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: "Segoe UI", system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--text); line-height: 1.5; }
    
    header { background: #0f172a; color: #fff; padding: 16px 28px; display: flex; justify-content: space-between; align-items: center; }
    .brand { display: flex; align-items: center; gap: 12px; }
    .brand h1 { font-size: 18px; font-weight: 700; letter-spacing: -0.3px; }
    .brand span { font-size: 12px; background: #334155; padding: 3px 8px; border-radius: 999px; }
    .badge-canal { background: #0369a1; padding: 4px 10px; border-radius: 6px; font-size: 12px; font-weight: 600; text-transform: uppercase; }

    nav { background: #ffffff; border-bottom: 1px solid var(--border); padding: 0 28px; display: flex; gap: 24px; }
    .nav-btn { background: none; border: none; padding: 14px 4px; font-size: 14px; font-weight: 600; color: var(--text-muted); cursor: pointer; border-bottom: 3px solid transparent; }
    .nav-btn.active { color: var(--primary); border-bottom-color: var(--primary); }

    main { max-width: 1350px; margin: 24px auto; padding: 0 20px; }
    .tab-content { display: none; }
    .tab-content.active { display: block; }

    /* Cards */
    .metrics-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 18px; margin-bottom: 24px; }
    .metric-card { background: var(--surface); padding: 20px; border-radius: var(--radius); border: 1px solid var(--border); box-shadow: var(--shadow); }
    .metric-title { font-size: 13px; color: var(--text-muted); font-weight: 600; text-transform: uppercase; }
    .metric-val { font-size: 28px; font-weight: 800; margin-top: 6px; color: var(--text); }
    .metric-sub { font-size: 12px; color: var(--text-muted); margin-top: 4px; }

    /* Barra de Ações */
    .action-bar { background: var(--surface); padding: 16px 20px; border-radius: var(--radius); border: 1px solid var(--border); margin-bottom: 20px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; }
    .btn { padding: 9px 16px; border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer; border: none; display: inline-flex; align-items: center; gap: 8px; transition: 0.15s ease; }
    .btn-primary { background: var(--primary); color: #fff; }
    .btn-primary:hover { background: var(--primary-hover); }
    .btn-success { background: var(--success); color: #fff; }
    .btn-success:hover { background: #166534; }
    .btn-outline { background: transparent; border: 1px solid var(--border); color: var(--text); }
    .btn-outline:hover { background: #f1f5f9; }

    /* Tabelas */
    .table-container { background: var(--surface); border-radius: var(--radius); border: 1px solid var(--border); overflow-x: auto; box-shadow: var(--shadow); }
    table { width: 100%; border-collapse: collapse; text-align: left; font-size: 13.5px; }
    th { background: #f8fafc; padding: 12px 16px; border-bottom: 1px solid var(--border); color: #475569; font-weight: 700; text-transform: uppercase; font-size: 12px; }
    td { padding: 12px 16px; border-bottom: 1px solid var(--border); }
    tr:hover { background: #f8fafc; }

    .tag { display: inline-block; padding: 3px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; text-transform: uppercase; }
    .tag-falta { background: #fef3c7; color: #92400e; }
    .tag-critica { background: #fee2e2; color: #991b1b; }
    .tag-pronto { background: #dcfce7; color: #166534; }
    .tag-sem-contato { background: #f1f5f9; color: #475569; }
    .tag-sem-consent { background: #fef3c7; color: #b45309; }

    /* Modal */
    .modal-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.5); align-items: center; justify-content: center; z-index: 100; }
    .modal-overlay.active { display: flex; }
    .modal-box { background: #fff; border-radius: 12px; padding: 24px; width: 90%; max-width: 520px; box-shadow: 0 20px 25px -5px rgb(0 0 0 / 0.2); }
    .modal-box h3 { margin-bottom: 12px; font-size: 18px; }
    .form-group { margin-bottom: 14px; }
    .form-group label { display: block; font-size: 12px; font-weight: 600; margin-bottom: 4px; color: #475569; }
    .form-group input, .form-group select { width: 100%; padding: 8px 12px; border: 1px solid var(--border); border-radius: 6px; font-size: 14px; }

    .toast { position: fixed; bottom: 20px; right: 20px; background: #0f172a; color: #fff; padding: 12px 20px; border-radius: 8px; font-size: 14px; box-shadow: var(--shadow); display: none; z-index: 200; }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <h1>CostaPresença</h1>
      <span id="headerEscola">Carregando...</span>
    </div>
    <div style="display: flex; gap: 10px; align-items: center;">
      <span class="badge-canal" id="headerCanal">Modo: Carregando</span>
    </div>
  </header>

  <nav>
    <button class="nav-btn active" onclick="trocarAba('aba-visao')">📊 Visão Geral</button>
    <button class="nav-btn" onclick="trocarAba('aba-notificacoes')">💬 Notificações aos Pais</button>
    <button class="nav-btn" onclick="trocarAba('aba-busca-ativa')">🚨 Busca Ativa / Conselho</button>
    <button class="nav-btn" onclick="trocarAba('aba-contatos')">👥 Cadastro de Telefones</button>
    <button class="nav-btn" onclick="trocarAba('aba-historico')">📜 Histórico de Disparos</button>
  </nav>

  <main>
    <!-- ABA 1: VISÃO GERAL -->
    <section id="aba-visao" class="tab-content active">
      <div class="metrics-grid">
        <div class="metric-card">
          <div class="metric-title">Alunos Monitorados</div>
          <div class="metric-val" id="cardTotalAlunos">-</div>
          <div class="metric-sub" id="cardDataColeta">Carregando dados...</div>
        </div>
        <div class="metric-card">
          <div class="metric-title">Faltas na Semana</div>
          <div class="metric-val" id="cardFaltasSemana" style="color: #b45309;">-</div>
          <div class="metric-sub">Abaixo de 100% no período</div>
        </div>
        <div class="metric-card">
          <div class="metric-title">Infrequência Crítica (&lt;75%)</div>
          <div class="metric-val" id="cardCriticos" style="color: #b91c1c;">-</div>
          <div class="metric-sub">Abaixo do limite legal da LDB</div>
        </div>
        <div class="metric-card">
          <div class="metric-title">Mensagens Prontas</div>
          <div class="metric-val" id="cardProntos" style="color: #15803d;">-</div>
          <div class="metric-sub">Com contato e consentimento</div>
        </div>
      </div>

      <div class="action-bar">
        <div>
          <h2 style="font-size: 16px;">Operações Rápidas da Secretaria</h2>
          <p style="font-size: 13px; color: var(--text-muted);">Execute as rotinas sem precisar abrir comandos no terminal.</p>
        </div>
        <div style="display: flex; gap: 10px;">
          <button class="btn btn-outline" onclick="recarregarPrevia()">🔄 Atualizar Prévia</button>
          <button class="btn btn-primary" onclick="abrirModalDisparo()">🚀 Disparar Mensagens aos Pais</button>
          <a class="btn btn-outline" href="/conselho-tutelar" target="_blank">📋 Emitir Ficha do Conselho Tutelar</a>
        </div>
      </div>
    </section>

    <!-- ABA 2: NOTIFICAÇÕES -->
    <section id="aba-notificacoes" class="tab-content">
      <div class="action-bar">
        <div style="display: flex; gap: 12px; align-items: center;">
          <h2 style="font-size: 16px;">Prévia das Notificações</h2>
          <span id="rotuloSemana" style="font-size: 13px; font-weight: 600; color: #475569;"></span>
        </div>
        <div style="display: flex; gap: 10px;">
          <button class="btn btn-outline" onclick="recarregarPrevia()">🔄 Recarregar</button>
          <button class="btn btn-success" onclick="abrirModalDisparo()">🚀 Enviar Mensagens aos Responsáveis</button>
        </div>
      </div>

      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>Tipo</th>
              <th>Estudante</th>
              <th>Turma</th>
              <th>Presença Sem.</th>
              <th>Presença Geral</th>
              <th>Responsável</th>
              <th>Telefone</th>
              <th>Ações</th>
            </tr>
          </thead>
          <tbody id="corpoTabelaPrevia">
            <tr><td colspan="9" style="text-align: center; padding: 20px;">Carregando prévia...</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- ABA 3: BUSCA ATIVA & CONSELHO -->
    <section id="aba-busca-ativa" class="tab-content">
      <div class="action-bar">
        <div>
          <h2 style="font-size: 16px;">Painel de Busca Ativa & Encaminhamentos</h2>
          <p style="font-size: 13px; color: var(--text-muted);">Estudantes que demandam intervenção pedagógica ou notificação ao Conselho Tutelar.</p>
        </div>
        <div>
          <a class="btn btn-primary" href="/conselho-tutelar" target="_blank">🖨️ Imprimir Ficha FICAI / Conselho Tutelar</a>
        </div>
      </div>

      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Estudante</th>
              <th>CGM</th>
              <th>Turma</th>
              <th>Presença Geral</th>
              <th>Motivos de Alerta</th>
              <th>Contatos Registrados</th>
            </tr>
          </thead>
          <tbody id="corpoTabelaBuscaAtiva">
            <tr><td colspan="6" style="text-align: center; padding: 20px;">Carregando casos...</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- ABA 4: GERENCIAR CONTATOS -->
    <section id="aba-contatos" class="tab-content">
      <div class="action-bar">
        <div>
          <h2 style="font-size: 16px;">Cadastrar Telefone de Responsável</h2>
          <p style="font-size: 13px; color: var(--text-muted);">Cadastre o telefone do pai/mãe diretamente para incluir nos avisos de falta.</p>
        </div>
        <button class="btn btn-primary" onclick="abrirModalNovoContato()">➕ Novo Contato</button>
      </div>

      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>CGM</th>
              <th>Estudante</th>
              <th>Turma</th>
              <th>Falta na Semana</th>
              <th>Status do Contato</th>
              <th>Ação</th>
            </tr>
          </thead>
          <tbody id="corpoTabelaContatosPendentes">
            <tr><td colspan="6" style="text-align: center; padding: 20px;">Carregando pendências...</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- ABA 5: HISTÓRICO -->
    <section id="aba-historico" class="tab-content">
      <div class="action-bar">
        <h2 style="font-size: 16px;">Registro Auditável de Execuções</h2>
        <button class="btn btn-outline" onclick="carregarHistorico()">🔄 Atualizar</button>
      </div>

      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Data/Hora</th>
              <th>Canal</th>
              <th>Semana</th>
              <th>Enviados</th>
              <th>Falhas</th>
              <th>Tipo</th>
            </tr>
          </thead>
          <tbody id="corpoTabelaHistorico">
            <tr><td colspan="6" style="text-align: center; padding: 20px;">Carregando histórico...</td></tr>
          </tbody>
        </table>
      </div>
    </section>
  </main>

  <!-- MODAL DE DISPARO -->
  <div class="modal-overlay" id="modalDisparo">
    <div class="modal-box">
      <h3>Confirmar Disparo de Mensagens</h3>
      <p style="font-size: 14px; margin-bottom: 16px; color: #475569;">
        Você está prestes a enviar as mensagens aos responsáveis dos alunos com falta.
      </p>
      <div class="form-group">
        <label>Número para Teste Prévio (Opcional):</label>
        <input type="text" id="inputDestinoTeste" placeholder="Ex.: 45999998888 (manda apenas para este número)">
        <small style="color: #64748b; font-size: 11px;">Se preenchido, apenas 3 mensagens de teste serão enviadas para o seu celular.</small>
      </div>
      <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px;">
        <button class="btn btn-outline" onclick="fecharModalDisparo()">Cancelar</button>
        <button class="btn btn-primary" onclick="executarDisparo()">Confirmar e Disparar</button>
      </div>
    </div>
  </div>

  <!-- MODAL DE NOVO CONTATO -->
  <div class="modal-overlay" id="modalNovoContato">
    <div class="modal-box">
      <h3>Cadastrar Contato do Responsável</h3>
      <div class="form-group">
        <label>CGM do Estudante:</label>
        <input type="text" id="cadCgm" placeholder="Ex.: 1009">
      </div>
      <div class="form-group">
        <label>Nome do Responsável (Pai/Mãe):</label>
        <input type="text" id="cadResponsavel" placeholder="Ex.: Maria de Fátima">
      </div>
      <div class="form-group">
        <label>Telefone / WhatsApp com DDD:</label>
        <input type="text" id="cadTelefone" placeholder="Ex.: (45) 99999-8888">
      </div>
      <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px;">
        <button class="btn btn-outline" onclick="fecharModalNovoContato()">Cancelar</button>
        <button class="btn btn-success" onclick="salvarNovoContato()">Salvar Contato</button>
      </div>
    </div>
  </div>

  <!-- TOAST -->
  <div class="toast" id="toast"></div>

  <script>
    let previaGlobal = null;

    function toast(msg) {
      const t = document.getElementById("toast");
      t.innerText = msg;
      t.style.display = "block";
      setTimeout(() => { t.style.display = "none"; }, 4000);
    }

    function trocarAba(abaId) {
      document.querySelectorAll(".tab-content").forEach(el => el.classList.remove("active"));
      document.querySelectorAll(".nav-btn").forEach(el => el.classList.remove("active"));
      document.getElementById(abaId).classList.add("active");
      event.target.classList.add("active");
      if (abaId === "aba-busca-ativa") carregarBuscaAtiva();
      if (abaId === "aba-historico") carregarHistorico();
    }

    async function carregarStatus() {
      try {
        const res = await fetch("/api/status");
        const s = await res.json();
        document.getElementById("headerEscola").innerText = s.escola || "Escola";
        document.getElementById("headerCanal").innerText = "Canal: " + s.canal;
        document.getElementById("cardTotalAlunos").innerText = s.totalAlunos || 0;
        document.getElementById("cardDataColeta").innerText = "Atualizado em: " + s.dataUltimaColeta;
      } catch (e) {
        console.error(e);
      }
    }

    async function recarregarPrevia() {
      try {
        const res = await fetch("/api/previa");
        const p = await res.json();
        previaGlobal = p;

        document.getElementById("cardFaltasSemana").innerText = p.totalFaltas || 0;
        document.getElementById("cardCriticos").innerText = p.criticosQtd || 0;
        document.getElementById("cardProntos").innerText = p.prontosQtd || 0;
        document.getElementById("rotuloSemana").innerText = "Semana: " + (p.semana || "");

        const tbody = document.getElementById("corpoTabelaPrevia");
        if (!p.itens || p.itens.length === 0) {
          tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; padding: 20px;">Nenhuma falta registrada para a semana selecionada.</td></tr>';
          return;
        }

        tbody.innerHTML = p.itens.map(i => {
          const tagTipo = i.tipo === "critica" ? '<span class="tag tag-critica">Crítica (&lt;75%)</span>' : '<span class="tag tag-falta">Falta</span>';
          const tagStatus = i.status === "pronto" 
            ? '<span class="tag tag-pronto">Pronto</span>' 
            : i.status === "sem-contato"
            ? '<span class="tag tag-sem-contato">Sem Contato</span>'
            : '<span class="tag tag-sem-consent">' + i.status + '</span>';

          return \`
            <tr>
              <td>\${tagStatus}</td>
              <td>\${tagTipo}</td>
              <td><strong>\${i.aluno}</strong><br><small style="color: #64748b;">CGM: \${i.cgm}</small></td>
              <td>\${i.turma}</td>
              <td style="font-weight: 700;">\${i.presencaSemana}</td>
              <td style="font-weight: 700; color: \${i.tipo === "critica" ? "#b91c1c" : "inherit"};">\${i.presencaGeral}</td>
              <td>\${i.responsavel}</td>
              <td>\${i.destinoMascarado}</td>
              <td>
                <button class="btn btn-outline" style="padding: 4px 8px; font-size: 12px;" onclick="verMensagem('\${i.cgm}')">👁️ Ver Texto</button>
              </td>
            </tr>
          \`;
        }).join("");

        // Atualiza tabela de pendentes
        const semCont = p.itens.filter(x => x.status === "sem-contato");
        const tbodyPend = document.getElementById("corpoTabelaContatosPendentes");
        if (semCont.length === 0) {
          tbodyPend.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 20px;">Todos os alunos com falta já possuem contato cadastrado!</td></tr>';
        } else {
          tbodyPend.innerHTML = semCont.map(x => \`
            <tr>
              <td><strong>\${x.cgm}</strong></td>
              <td>\${x.aluno}</td>
              <td>\${x.turma}</td>
              <td>\${x.presencaSemana}</td>
              <td><span class="tag tag-sem-contato">Sem Telefone</span></td>
              <td>
                <button class="btn btn-primary" style="padding: 4px 10px; font-size: 12px;" onclick="preencherCadastro('\${x.cgm}')">➕ Cadastrar Fone</button>
              </td>
            </tr>
          \`).join("");
        }

      } catch (e) {
        toast("Erro ao carregar prévia: " + e.message);
      }
    }

    async function carregarBuscaAtiva() {
      try {
        const res = await fetch("/api/busca-ativa");
        const d = await res.json();
        const tbody = document.getElementById("corpoTabelaBuscaAtiva");
        if (!d.alunos || d.alunos.length === 0) {
          tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 20px;">Nenhum estudante em busca ativa.</td></tr>';
          return;
        }
        tbody.innerHTML = d.alunos.map(a => \`
          <tr>
            <td><strong>\${a.nome}</strong></td>
            <td>\${a.cgm}</td>
            <td>\${a.turmas.join(", ")}</td>
            <td style="font-weight: 800; color: #b91c1c;">\${a.presencaGeral ? (a.presencaGeral + "%") : "-"}</td>
            <td>\${a.motivos.join("<br>")}</td>
            <td style="font-size: 12px;">\${a.responsaveis || "Nenhum"}</td>
          </tr>
        \`).join("");
      } catch (e) {
        console.error(e);
      }
    }

    async function carregarHistorico() {
      try {
        const res = await fetch("/api/historico");
        const d = await res.json();
        const tbody = document.getElementById("corpoTabelaHistorico");
        if (!d.execucoes || d.execucoes.length === 0) {
          tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 20px;">Nenhum histórico registrado ainda.</td></tr>';
          return;
        }
        tbody.innerHTML = d.execucoes.map(e => \`
          <tr>
            <td>\${new Date(e.timestamp).toLocaleString("pt-BR")}</td>
            <td><strong>\${e.canal}</strong></td>
            <td>\${e.semana}</td>
            <td style="color: #15803d; font-weight: 700;">\${e.enviados}</td>
            <td style="color: #b91c1c; font-weight: 700;">\${e.falhas}</td>
            <td>\${e.teste ? '<span class="tag tag-falta">Teste</span>' : '<span class="tag tag-pronto">Produção</span>'}</td>
          </tr>
        \`).join("");
      } catch (e) {
        console.error(e);
      }
    }

    function verMensagem(cgm) {
      if (!previaGlobal) return;
      const item = previaGlobal.itens.find(x => x.cgm === cgm);
      if (!item) return;
      alert("MENSAGEM AO RESPONSÁVEL (" + item.aluno + "):\\n\\n" + item.mensagem);
    }

    function abrirModalDisparo() { document.getElementById("modalDisparo").classList.add("active"); }
    function fecharModalDisparo() { document.getElementById("modalDisparo").classList.remove("active"); }

    async function executarDisparo() {
      const destinoTeste = document.getElementById("inputDestinoTeste").value.trim();
      fecharModalDisparo();
      toast("Disparando notificações... Aguarde.");
      try {
        const res = await fetch("/api/notificar/executar", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ destinoTeste })
        });
        const r = await res.json();
        if (r.sucesso) {
          toast("Concluído: " + r.enviados + " enviadas, " + r.falhas + " falhas (" + r.canal + ").");
          recarregarPrevia();
        } else {
          toast("Erro: " + (r.erro || "Falha"));
        }
      } catch (e) {
        toast("Erro ao disparar: " + e.message);
      }
    }

    function abrirModalNovoContato() { document.getElementById("modalNovoContato").classList.add("active"); }
    function fecharModalNovoContato() { document.getElementById("modalNovoContato").classList.remove("active"); }

    function preencherCadastro(cgm) {
      document.getElementById("cadCgm").value = cgm;
      abrirModalNovoContato();
    }

    async function salvarNovoContato() {
      const cgm = document.getElementById("cadCgm").value.trim();
      const responsavel = document.getElementById("cadResponsavel").value.trim();
      const telefone = document.getElementById("cadTelefone").value.trim();

      if (!cgm || !responsavel || !telefone) {
        alert("Preencha todos os campos.");
        return;
      }

      try {
        const res = await fetch("/api/contatos/salvar", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cgm, responsavel, telefone })
        });
        const r = await res.json();
        if (r.sucesso) {
          toast(r.mensagem);
          fecharModalNovoContato();
          document.getElementById("cadCgm").value = "";
          document.getElementById("cadResponsavel").value = "";
          document.getElementById("cadTelefone").value = "";
          recarregarPrevia();
        } else {
          alert("Erro: " + r.erro);
        }
      } catch (e) {
        alert("Erro: " + e.message);
      }
    }

    carregarStatus();
    recarregarPrevia();
  </script>
</body>
</html>`;
}

server.listen(PORTA, () => {
  console.log(`\n============================================================`);
  console.log(`  PAINEL COSTA PRESENCA PRONTO E OPERACIONAL!`);
  console.log(`  Acesse no navegador: http://localhost:${PORTA}`);
  console.log(`============================================================\n`);
});
