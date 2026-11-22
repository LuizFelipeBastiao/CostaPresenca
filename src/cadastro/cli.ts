import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { carregarConfigNotificacoes, carregarEnv, type NotificacoesConfig } from "../notificacoes/config.js";
import { mascararTelefone, normalizarTelefone } from "../notificacoes/contatos.js";
import { canonico, localizarCsvMaisRecente } from "../notificacoes/csv.js";
import { nomeProprio, turmaLegivel } from "../notificacoes/modelo.js";
import { lerPresencaArquivo, normalizarCgm } from "../notificacoes/presenca.js";
import { CadastroStore, formatarCodigo, type CodigoAluno } from "./store.js";

/**
 * Comandos da secretaria para o bot de cadastro:
 *
 *   npm run cadastro -- bilhetes [--turma "6º Série A"] [--sem-cadastro]
 *   npm run cadastro -- novo-codigo <CGM>
 *   npm run cadastro -- pendentes
 *   npm run cadastro -- aprovar <CGM> | --todos
 *   npm run cadastro -- recusar <CGM>
 *   npm run cadastro -- resumo
 */

const AJUDA = `Uso: npm run cadastro -- <comando>

  bilhetes [--turma TEXTO] [--sem-cadastro]
      Gera (ou reaproveita) o código de cada aluno matriculado e grava
      data/cadastros/bilhetes.html para imprimir. --turma filtra pelo nome da
      turma; --sem-cadastro imprime só quem ainda não tem responsável cadastrado.
  novo-codigo <CGM>   Invalida o código de um bilhete perdido e mostra o novo.
  pendentes           Lista cadastros aguardando aprovação (aprovacaoManual).
  aprovar <CGM>       Aprova os cadastros pendentes do aluno (--todos: todos).
  recusar <CGM>       Apaga os cadastros pendentes do aluno.
  resumo              Quantos alunos já têm responsável recebendo avisos.

Opção comum: --config <arquivo> (padrão config/notificacoes.json).`;

function argumento(args: string[], nome: string): string | undefined {
  const i = args.indexOf(nome);
  return i >= 0 ? args[i + 1] : undefined;
}

function escapar(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Link que abre o WhatsApp já com "CADASTRAR K7P-4Q2" digitado para o número da escola. */
export function linkCadastro(numeroEscola: string, codigo: string): string | null {
  const numero = normalizarTelefone(numeroEscola);
  if (!numero) return null;
  return `https://wa.me/${numero}?text=${encodeURIComponent(`CADASTRAR ${formatarCodigo(codigo)}`)}`;
}

type GeradorQr = (texto: string) => Promise<string>;

async function carregarGeradorQr(): Promise<GeradorQr> {
  try {
    const mod = (await import("qrcode")) as unknown as {
      default?: { toString: (t: string, o: object) => Promise<string> };
      toString: (t: string, o: object) => Promise<string>;
    };
    const qr = mod.default ?? mod;
    return (t) => qr.toString(t, { type: "svg", margin: 0, errorCorrectionLevel: "M" });
  } catch {
    throw new Error('Pacote "qrcode" não instalado. Rode "npm install" na pasta do projeto e tente de novo.');
  }
}

export async function htmlBilhetes(
  alunos: CodigoAluno[],
  config: NotificacoesConfig,
  gerarQr: GeradorQr | null,
  botaoImprimir = false
): Promise<string> {
  const escola = escapar(config.escola.nome);
  const numeroImpresso = escapar(config.cadastro.numeroWhatsappEscola);
  const cartoes: string[] = [];
  for (const a of alunos) {
    const codigo = formatarCodigo(a.codigo);
    const link = linkCadastro(config.cadastro.numeroWhatsappEscola, a.codigo);
    const qr = link && gerarQr ? await gerarQr(link) : "";
    const turma = a.turma.split(" / ").map(turmaLegivel).join(" / ");
    cartoes.push(`<section class="bilhete">
  <header>${escola}</header>
  <h2>Avisos de falta pelo WhatsApp</h2>
  <p class="aluno"><b>${escapar(nomeProprio(a.aluno))}</b><br>${escapar(turma)}</p>
  <div class="corpo">
    ${qr ? `<div class="qr">${qr}</div>` : ""}
    <ol>
      ${qr ? "<li>Aponte a câmera do celular para o quadrado e toque em <b>Enviar</b>.</li><li>Ou e" : "<li>E"}nvie para <b class="nowrap">${numeroImpresso || "o WhatsApp da escola"}</b> a mensagem:
        <div class="codigo">CADASTRAR ${codigo}</div></li>
    </ol>
  </div>
  <footer>Este código é só deste(a) aluno(a): guarde o bilhete. Ao se cadastrar, você autoriza a escola a enviar avisos de frequência para o seu número. Para parar, envie <b>SAIR</b>.</footer>
</section>`);
  }
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Bilhetes de cadastro — ${escola}</title>
<style>
  @page { size: A4; margin: 10mm; }
  body { font-family: Arial, sans-serif; margin: 0; color: #111; }
  .folha { display: grid; grid-template-columns: 1fr 1fr; gap: 0; }
  .bilhete { border: 1px dashed #999; padding: 4mm 5mm; height: 69mm; box-sizing: border-box; break-inside: avoid; overflow: hidden; display: flex; flex-direction: column; font-size: 9.5pt; line-height: 1.25; }
  header { font-size: 8pt; color: #555; }
  h2 { font-size: 11.5pt; margin: 0.5mm 0 1.5mm; }
  .aluno { margin: 0 0 2mm; }
  .corpo { display: flex; gap: 4mm; align-items: center; }
  .qr { width: 27mm; height: 27mm; flex: none; }
  .qr svg { width: 100%; height: 100%; }
  ol { margin: 0; padding-left: 4.5mm; }
  li { margin-bottom: 1mm; }
  .nowrap { white-space: nowrap; }
  .codigo { font: bold 12.5pt "Courier New", monospace; white-space: nowrap; margin-top: 0.5mm; }
  footer { font-size: 7pt; color: #444; margin-top: auto; }
  .barra { max-width: 190mm; margin: 0 auto 4mm; display: flex; gap: 12px; align-items: center; font-size: 14px; }
  .barra button { font: inherit; padding: 8px 16px; border: 0; border-radius: 6px; background: #2563eb; color: #fff; cursor: pointer; }
  @media screen { body { background: #eee; padding: 6mm 0; } .folha { background: #fff; max-width: 190mm; margin: 0 auto; } }
  @media print { .barra { display: none; } }
</style></head>
<body>${botaoImprimir ? `<div class="barra"><button onclick="window.print()">🖨️ Imprimir</button><span>${alunos.length} bilhete(s) · 8 por folha A4</span></div>` : ""}
${alunos.length === 0 ? '<p class="barra">Nenhum aluno para este filtro.</p>' : ""}<div class="folha">
${cartoes.join("\n")}
</div></body></html>
`;
}

export interface OpcoesBilhetes {
  /** Trecho do nome da turma (ex.: "6º Série A"). */
  turma?: string | undefined;
  /** Só alunos que ainda não têm nenhum responsável cadastrado. */
  semCadastro?: boolean | undefined;
  /** Mostra a barra com o botão Imprimir (usado pelo painel). */
  botaoImprimir?: boolean | undefined;
}

export interface ResultadoBilhetes {
  html: string;
  alunosNoCsv: number;
  codigosNovos: number;
  bilhetes: number;
  comQr: boolean;
  turmas: string[];
}

/** Lista de alunos matriculados do CSV de presença mais recente. */
function alunosAtuais(config: NotificacoesConfig) {
  const dir = path.resolve(config.dataDirectory, config.fontePresenca);
  const csv = localizarCsvMaisRecente(dir, config.fontePresenca);
  if (!csv) {
    throw new Error(
      "Ainda não há lista de alunos. Ela vem da coleta do Power BI: dê dois cliques no CostaPresenca.bat (ou aguarde a atualização agendada)."
    );
  }
  return lerPresencaArquivo(csv).filter(
    (a) => !config.regras.somenteMatriculados || a.situacao === null || canonico(a.situacao) === "matriculado"
  );
}

/**
 * Garante um código para cada aluno matriculado e monta o HTML dos bilhetes.
 * Usado pelo comando "bilhetes" e pela aba Bilhetes do painel.
 */
export async function gerarBilhetes(config: NotificacoesConfig, op: OpcoesBilhetes = {}): Promise<ResultadoBilhetes> {
  const store = new CadastroStore(config.cadastro.arquivo);
  const alunos = alunosAtuais(config);
  const codigosNovos = store.garantirCodigos(alunos.map((a) => ({ cgm: a.cgm, nome: a.nome, turmas: a.turmas })));
  const base = store.ler();
  const ativos = new Set(alunos.map((a) => a.cgm));
  const comCadastro = new Set(base.vinculos.map((v) => v.cgm));
  const filtroTurma = op.turma ? canonico(op.turma) : null;
  const daEscola = base.codigos.filter((c) => ativos.has(c.cgm));
  const selecionados = daEscola
    .filter((c) => !filtroTurma || canonico(c.turma).includes(filtroTurma))
    .filter((c) => !op.semCadastro || !comCadastro.has(c.cgm))
    .sort((a, b) => a.turma.localeCompare(b.turma, "pt-BR") || a.aluno.localeCompare(b.aluno, "pt-BR"));
  const comQr = normalizarTelefone(config.cadastro.numeroWhatsappEscola) !== null;
  const gerarQr = comQr ? await carregarGeradorQr() : null;
  const turmas = [...new Set(daEscola.flatMap((c) => c.turma.split(" / ").map(turmaLegivel)))].sort((a, b) =>
    a.localeCompare(b, "pt-BR", { numeric: true })
  );
  return {
    html: await htmlBilhetes(selecionados, config, gerarQr, op.botaoImprimir ?? false),
    alunosNoCsv: alunos.length,
    codigosNovos,
    bilhetes: selecionados.length,
    comQr,
    turmas
  };
}

export interface ResumoCadastros {
  alunos: number;
  alunosCobertos: number;
  responsaveisAtivos: number;
  pendentes: number;
  numeroWhatsappEscola: string;
  semListaDeAlunos: boolean;
  turmas: string[];
}

/** Números para a aba Bilhetes do painel: quantos alunos já têm responsável recebendo avisos. */
export function resumoCadastros(config: NotificacoesConfig): ResumoCadastros {
  const base = new CadastroStore(config.cadastro.arquivo).ler();
  let alunos: { cgm: string; turmas: string[] }[] = [];
  let semListaDeAlunos = false;
  try {
    alunos = alunosAtuais(config);
  } catch {
    semListaDeAlunos = true;
  }
  const matriculados = new Set(alunos.map((a) => a.cgm));
  const ativos = base.vinculos.filter((v) => v.status === "ativo");
  const cobertos = new Set(ativos.filter((v) => semListaDeAlunos || matriculados.has(v.cgm)).map((v) => v.cgm));
  const turmas = [...new Set(alunos.flatMap((a) => a.turmas.map(turmaLegivel)))].sort((a, b) =>
    a.localeCompare(b, "pt-BR", { numeric: true })
  );
  return {
    alunos: alunos.length,
    alunosCobertos: cobertos.size,
    responsaveisAtivos: ativos.length,
    pendentes: base.vinculos.length - ativos.length,
    numeroWhatsappEscola: config.cadastro.numeroWhatsappEscola,
    semListaDeAlunos,
    turmas
  };
}

function linhaVinculo(c: CodigoAluno | undefined, cgm: string, telefone: string, responsavel: string, em: string): string {
  const aluno = c ? `${nomeProprio(c.aluno)} (${c.turma.split(" / ").map(turmaLegivel)[0] ?? ""})` : "?";
  return `  CGM ${cgm.padEnd(10)} ${aluno} — ${mascararTelefone(telefone)}${responsavel ? ` "${responsavel}"` : ""} desde ${em.slice(0, 10)}`;
}

export async function executar(args: string[], config: NotificacoesConfig): Promise<number> {
  const store = new CadastroStore(config.cadastro.arquivo);
  const comando = args[0];

  switch (comando) {
    case "bilhetes": {
      const r = await gerarBilhetes(config, {
        turma: argumento(args, "--turma"),
        semCadastro: args.includes("--sem-cadastro")
      });
      if (!r.comQr) {
        console.warn(
          'Aviso: "cadastro.numeroWhatsappEscola" não está preenchido (ou é inválido) em config/notificacoes.json; os bilhetes saem sem QR code e sem o número.'
        );
      }
      const saida = path.resolve(path.dirname(path.resolve(config.cadastro.arquivo)), "bilhetes.html");
      fs.mkdirSync(path.dirname(saida), { recursive: true });
      fs.writeFileSync(saida, r.html, "utf8");
      console.log(`${r.alunosNoCsv} aluno(s) no CSV, ${r.codigosNovos} código(s) novo(s).`);
      console.log(`${r.bilhetes} bilhete(s) em ${saida} — abra no navegador e imprima (Ctrl+P).`);
      return 0;
    }

    case "novo-codigo": {
      const cgm = normalizarCgm(args[1]);
      if (!cgm) throw new Error("Informe o CGM: npm run cadastro -- novo-codigo 123456789");
      const c = store.novoCodigo(cgm);
      console.log(`Novo código de ${nomeProprio(c.aluno)}: ${formatarCodigo(c.codigo)} (o anterior não funciona mais).`);
      console.log("Rode \"npm run cadastro -- bilhetes --turma ...\" para reimprimir o bilhete.");
      return 0;
    }

    case "pendentes": {
      const base = store.ler();
      const pend = base.vinculos.filter((v) => v.status === "pendente");
      if (pend.length === 0) {
        console.log(
          config.cadastro.aprovacaoManual
            ? "Nenhum cadastro aguardando aprovação."
            : "Nenhum pendente (aprovacaoManual está desligada: os cadastros já entram ativos)."
        );
        return 0;
      }
      console.log(`${pend.length} cadastro(s) aguardando aprovação:`);
      for (const v of pend) {
        console.log(linhaVinculo(base.codigos.find((c) => c.cgm === v.cgm), v.cgm, v.telefone, v.responsavel, v.criadoEm));
      }
      console.log('\nAprove com: npm run cadastro -- aprovar <CGM>   (ou --todos)');
      return 0;
    }

    case "aprovar":
    case "recusar": {
      const todos = args.includes("--todos") && comando === "aprovar";
      const cgm = normalizarCgm(args[1]);
      if (!todos && !cgm) throw new Error(`Informe o CGM: npm run cadastro -- ${comando} 123456789`);
      const n = store.atualizar((base) => {
        const alvo = (v: (typeof base.vinculos)[number]) => v.status === "pendente" && (todos || v.cgm === cgm);
        const quantos = base.vinculos.filter(alvo).length;
        if (comando === "recusar") {
          base.vinculos = base.vinculos.filter((v) => !alvo(v));
        } else {
          const em = new Date().toISOString();
          for (const v of base.vinculos) if (alvo(v)) Object.assign(v, { status: "ativo", aprovadoEm: em });
        }
        return quantos;
      });
      console.log(`${n} cadastro(s) ${comando === "aprovar" ? "aprovado(s)" : "removido(s)"}.`);
      return 0;
    }

    case "resumo": {
      const base = store.ler();
      const ativos = base.vinculos.filter((v) => v.status === "ativo");
      const alunosComAviso = new Set(ativos.map((v) => v.cgm));
      console.log(`Códigos gerados:          ${base.codigos.length}`);
      console.log(`Responsáveis ativos:      ${ativos.length}`);
      console.log(`Aguardando aprovação:     ${base.vinculos.length - ativos.length}`);
      console.log(
        `Alunos cobertos:          ${alunosComAviso.size}` +
          (base.codigos.length ? ` de ${base.codigos.length} (${Math.round((100 * alunosComAviso.size) / base.codigos.length)}%)` : "")
      );
      return 0;
    }

    default:
      console.log(AJUDA);
      return comando && comando !== "ajuda" && comando !== "--help" ? 1 : 0;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  carregarEnv();
  carregarConfigNotificacoes(argumento(args, "--config"))
    .then((config) => executar(args, config))
    .then((codigo) => process.exit(codigo))
    .catch((e) => {
      console.error(`Erro: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    });
}
