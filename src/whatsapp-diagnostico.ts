import { carregarConfigNotificacoes, carregarEnv, type NotificacoesConfig } from "./notificacoes/config.js";
import { mascararTelefone, normalizarTelefone } from "./notificacoes/contatos.js";
import { apiBase } from "./notificacoes/senders/index.js";

const AJUDA = `
Confere, passo a passo, se a integração com a WhatsApp Cloud API está de pé.
Não envia nada aos responsáveis: só fala com a API da Meta.

Uso:
  npm run whatsapp:diagnostico
  npm run whatsapp:diagnostico -- --enviar 45999998888   Manda UMA mensagem de teste para este número

Opções:
  --config <arquivo>     Padrão: config/notificacoes.json
  --enviar <telefone>    Dispara uma mensagem de teste (use o seu próprio celular)
`;

interface Opcoes {
  config?: string;
  enviar?: string;
  ajuda: boolean;
}

function lerArgs(argv: string[]): Opcoes {
  const o: Opcoes = { ajuda: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h" || a === "ajuda") o.ajuda = true;
    else if (a === "--config" || a === "--enviar") {
      const v = argv[i + 1];
      if (!v || v.startsWith("--")) throw new Error(`Opção ${a} precisa de um valor.`);
      if (a === "--config") o.config = v;
      else o.enviar = v;
      i += 1;
    } else throw new Error(`Argumento desconhecido: ${a}\n${AJUDA}`);
  }
  return o;
}

const OK = "  [ok]  ";
const FALHA = "  [--]  ";
const INFO = "        ";

interface ErroGraph {
  message?: string;
  code?: number;
  error_subcode?: number;
  type?: string;
}

/**
 * Traduz os erros que mais aparecem na estreia da Cloud API. O texto da Meta
 * costuma ser genérico ("Unsupported post request"), então a dica importa mais
 * que a mensagem original.
 */
function explicarErro(e: ErroGraph | undefined, status: number): string[] {
  const codigo = e?.code;
  const dicas: string[] = [];
  if (codigo === 190) {
    dicas.push("Token inválido ou expirado.");
    dicas.push("O token temporário do painel dura 24h. Para uso diário, gere um token permanente:");
    dicas.push("Business Settings → Users → System users → Add → atribua o app e a WABA → Generate new token.");
  } else if (codigo === 100 || status === 404) {
    dicas.push("A Meta não reconheceu esse identificador.");
    dicas.push("Confira se WHATSAPP_PHONE_NUMBER_ID é o 'Phone number ID' (um número longo),");
    dicas.push("e não o telefone em si nem o 'WhatsApp Business Account ID'.");
  } else if (codigo === 131047) {
    dicas.push("Passaram mais de 24h desde a última mensagem desse contato para a escola.");
    dicas.push("Fora dessa janela a Meta só entrega TEMPLATE aprovado — é o caso dos avisos de falta.");
    dicas.push("Configure whatsappCloud.template no config/notificacoes.json.");
  } else if (codigo === 131030) {
    dicas.push("Esse número não está na lista de destinatários permitidos.");
    dicas.push("O número de teste da Meta só entrega para até 5 números cadastrados no painel:");
    dicas.push("WhatsApp → API Setup → 'To' → Manage phone number list.");
  } else if (codigo === 131026) {
    dicas.push("Mensagem não entregável: o destino pode não ter WhatsApp ativo ou não aceitou receber.");
  } else if (codigo === 10 || codigo === 200) {
    dicas.push("O token não tem permissão sobre esse número.");
    dicas.push("Confirme que o System User tem acesso ao app E à conta WhatsApp Business (WABA).");
  } else if (status === 401 || status === 403) {
    dicas.push("A Meta recusou a credencial. Revise o token e as permissões do app.");
  }
  return dicas;
}

async function chamarGraph(
  url: string,
  token: string
): Promise<{ ok: boolean; status: number; json: Record<string, unknown>; erro: ErroGraph | undefined }> {
  const resposta = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000)
  });
  const json = (await resposta.json().catch(() => ({}))) as Record<string, unknown>;
  const erro = (json as { error?: ErroGraph }).error;
  return { ok: resposta.ok && !erro, status: resposta.status, json, erro };
}

function imprimirFalha(titulo: string, e: ErroGraph | undefined, status: number): void {
  console.log(`${FALHA}${titulo}`);
  if (e?.message) console.log(`${INFO}Meta respondeu: ${e.message}${e.code ? ` (código ${e.code})` : ""}`);
  for (const dica of explicarErro(e, status)) console.log(`${INFO}${dica}`);
}

/** 1. As variáveis estão no .env? */
function conferirAmbiente(config: NotificacoesConfig): { phoneNumberId: string; token: string } | null {
  console.log("\n1. Credenciais no .env");
  const nomeId = config.whatsappCloud.phoneNumberIdEnv;
  const nomeToken = config.whatsappCloud.tokenEnv;
  const phoneNumberId = (process.env[nomeId] ?? "").trim();
  const token = (process.env[nomeToken] ?? "").trim();

  if (phoneNumberId === "") {
    console.log(`${FALHA}${nomeId} está vazia.`);
    console.log(`${INFO}Pegue em: Meta for Developers → seu app → WhatsApp → API Setup → "Phone number ID".`);
  } else if (!/^\d+$/.test(phoneNumberId)) {
    console.log(`${FALHA}${nomeId} não parece um Phone number ID (deveria ser só dígitos).`);
    console.log(`${INFO}Valor atual começa com "${phoneNumberId.slice(0, 4)}…". Não use o telefone com +55.`);
    return null;
  } else {
    console.log(`${OK}${nomeId} definida.`);
  }

  if (token === "") {
    console.log(`${FALHA}${nomeToken} está vazia.`);
    console.log(`${INFO}Pegue o token temporário na mesma tela (API Setup) para o primeiro teste.`);
  } else {
    console.log(`${OK}${nomeToken} definida (${token.length} caracteres).`);
  }
  if (phoneNumberId === "" || token === "") return null;
  return { phoneNumberId, token };
}

/** 2. O token enxerga o número? Mostra nome exibido e qualidade. */
async function conferirNumero(config: NotificacoesConfig, phoneNumberId: string, token: string): Promise<boolean> {
  console.log("\n2. Número remetente");
  const campos = "verified_name,display_phone_number,quality_rating,code_verification_status,platform_type";
  const url = `${apiBase()}/${config.whatsappCloud.apiVersion}/${encodeURIComponent(phoneNumberId)}?fields=${campos}`;
  const r = await chamarGraph(url, token);
  if (!r.ok) {
    imprimirFalha("Não consegui ler os dados do número.", r.erro, r.status);
    return false;
  }
  const j = r.json as {
    verified_name?: string;
    display_phone_number?: string;
    quality_rating?: string;
    code_verification_status?: string;
  };
  console.log(`${OK}Token válido para o número ${j.display_phone_number ?? "(sem telefone)"}.`);
  console.log(`${INFO}Nome exibido aos pais: ${j.verified_name ?? "(não definido)"}`);
  if (j.quality_rating) console.log(`${INFO}Qualidade do número: ${j.quality_rating}`);
  if (j.code_verification_status && j.code_verification_status !== "VERIFIED") {
    console.log(`${INFO}Atenção: verificação do número está "${j.code_verification_status}".`);
  }
  return true;
}

/**
 * 3. Existe template aprovado? Sem ele a Meta não entrega avisos de falta,
 * porque a escola inicia a conversa fora da janela de 24h.
 */
async function conferirTemplates(config: NotificacoesConfig, token: string): Promise<boolean> {
  console.log("\n3. Template de mensagem");
  const configurado = config.whatsappCloud.template?.nome;
  const wabaId = (process.env.WHATSAPP_WABA_ID ?? "").trim();

  if (!configurado) {
    console.log(`${FALHA}Nenhum template configurado em whatsappCloud.template.`);
    console.log(`${INFO}Sem template, a Meta só entrega para quem escreveu para a escola nas últimas 24h —`);
    console.log(`${INFO}ou seja, os avisos de falta não chegam. Veja o passo a passo no README.`);
    return false;
  }
  if (wabaId === "") {
    console.log(`${INFO}WHATSAPP_WABA_ID não definida: não dá para conferir a aprovação por aqui.`);
    console.log(`${INFO}Ela fica na MESMA tela do Phone number ID (WhatsApp → Configuração da API),`);
    console.log(`${INFO}logo abaixo dele, como "Identificação da conta do WhatsApp Business".`);
    console.log(`${INFO}Outro jeito: abra o WhatsApp Manager e copie o waba_id= da barra de endereço.`);
    console.log(`${INFO}Template configurado: "${configurado}". Por ora, confira o status em WhatsApp Manager → Modelos.`);
    return true;
  }

  const url = `${apiBase()}/${config.whatsappCloud.apiVersion}/${encodeURIComponent(wabaId)}/message_templates?fields=name,status,language,category&limit=100`;
  const r = await chamarGraph(url, token);
  if (!r.ok) {
    imprimirFalha("Não consegui listar os templates da conta.", r.erro, r.status);
    return false;
  }
  const lista = (r.json.data ?? []) as { name?: string; status?: string; language?: string; category?: string }[];
  const idioma = config.whatsappCloud.template?.idioma;
  const meus = lista.filter((t) => t.name === configurado);

  if (meus.length === 0) {
    console.log(`${FALHA}O template "${configurado}" não existe nesta conta.`);
    if (lista.length > 0) {
      console.log(`${INFO}Templates encontrados: ${lista.map((t) => `${t.name} (${t.status})`).join(", ")}`);
    } else {
      console.log(`${INFO}Nenhum template cadastrado ainda. Crie em WhatsApp Manager → Modelos de mensagem.`);
    }
    return false;
  }

  const noIdioma = meus.find((t) => t.language === idioma) ?? meus[0]!;
  if (noIdioma.language !== idioma) {
    console.log(`${FALHA}O template existe, mas no idioma "${noIdioma.language}" e a configuração pede "${idioma}".`);
    console.log(`${INFO}Ajuste whatsappCloud.template.idioma ou crie a versão no idioma configurado.`);
    return false;
  }
  if (noIdioma.status !== "APPROVED") {
    console.log(`${FALHA}Template "${configurado}" está ${noIdioma.status} (precisa ficar APPROVED).`);
    if (noIdioma.status === "PENDING") console.log(`${INFO}A análise da Meta costuma sair em minutos; às vezes leva até 24h.`);
    if (noIdioma.status === "REJECTED") console.log(`${INFO}Veja o motivo em WhatsApp Manager → Modelos e reenvie corrigido.`);
    return false;
  }
  console.log(`${OK}Template "${configurado}" (${noIdioma.language}) aprovado, categoria ${noIdioma.category ?? "?"}.`);
  if (noIdioma.category === "MARKETING") {
    console.log(`${INFO}Atenção: aviso de frequência deve ser UTILITY. MARKETING custa mais e exige opt-in mais rígido.`);
  }
  const params = config.whatsappCloud.template?.parametros ?? [];
  console.log(`${INFO}Parâmetros enviados, nesta ordem: ${params.length > 0 ? params.join(", ") : "(nenhum)"}`);
  return true;
}

/** 4. Envio real de uma mensagem, só para o número que o operador indicar. */
async function enviarTeste(config: NotificacoesConfig, destinoBruto: string): Promise<boolean> {
  console.log("\n4. Mensagem de teste");
  const destino = normalizarTelefone(destinoBruto);
  if (!destino) {
    console.log(`${FALHA}Telefone inválido: "${destinoBruto}". Use o formato 45999998888.`);
    return false;
  }
  const { criarSender } = await import("./notificacoes/senders/index.js");
  const sender = criarSender(config, "whatsapp-cloud");
  const valores = {
    responsavel: "Responsável",
    aluno: "Aluno de Teste",
    primeiroNome: "Aluno",
    turma: "Turma de Teste",
    escola: config.escola.nome,
    telefoneEscola: config.escola.telefoneContato || "a secretaria",
    presencaSemana: "60%",
    presencaSemanaAnterior: "100%",
    quedaSemana: "40 pontos",
    presencaGeral: "82,0%",
    dataReferencia: "teste"
  };
  try {
    const r = await sender.enviar({
      destino,
      assunto: "Teste de integração",
      texto: `Teste de integração do sistema de frequência de ${config.escola.nome}. Nenhum responsável foi avisado.`,
      valores,
      cgm: "000",
      tipo: "falta"
    });
    console.log(`${OK}Mensagem aceita pela Meta para ${mascararTelefone(destino)}.`);
    if (r.idMensagem) console.log(`${INFO}ID da mensagem: ${r.idMensagem}`);
    console.log(`${INFO}Aceita não é o mesmo que entregue — confira se chegou no aparelho.`);
    return true;
  } catch (e) {
    const texto = e instanceof Error ? e.message : String(e);
    console.log(`${FALHA}A Meta recusou o envio.`);
    console.log(`${INFO}${texto}`);
    const codigo = /código (\d+)/.exec(texto)?.[1];
    for (const dica of explicarErro(codigo ? { code: Number(codigo) } : undefined, 0)) console.log(`${INFO}${dica}`);
    return false;
  }
}

async function main(): Promise<number> {
  const opcoes = lerArgs(process.argv.slice(2));
  if (opcoes.ajuda) {
    console.log(AJUDA);
    return 0;
  }
  carregarEnv();
  const config = await carregarConfigNotificacoes(opcoes.config);

  console.log("Diagnóstico da WhatsApp Cloud API");
  console.log(`Escola: ${config.escola.nome} · canal configurado: ${config.canal}`);
  if (config.canal !== "whatsapp-cloud") {
    console.log(`${INFO}Observação: o canal em uso é "${config.canal}". Para enviar de verdade pelo WhatsApp,`);
    console.log(`${INFO}mude "canal" para "whatsapp-cloud" em config/notificacoes.json.`);
  }

  const credenciais = conferirAmbiente(config);
  if (!credenciais) {
    console.log("\nResultado: faltam credenciais. Preencha o .env e rode de novo.");
    return 1;
  }
  const numeroOk = await conferirNumero(config, credenciais.phoneNumberId, credenciais.token);
  const templateOk = numeroOk ? await conferirTemplates(config, credenciais.token) : false;
  const envioOk = opcoes.enviar ? await enviarTeste(config, opcoes.enviar) : null;

  console.log("\nResultado");
  if (numeroOk && templateOk && envioOk !== false) {
    console.log("  Integração pronta para os avisos de falta.");
    if (envioOk === null) console.log("  Para confirmar na prática: npm run whatsapp:diagnostico -- --enviar <seu telefone>");
    return 0;
  }
  if (!numeroOk) {
    console.log("  A Meta não aceitou as credenciais. Corrija o passo 2 antes de seguir.");
  } else if (!templateOk) {
    console.log("  O número responde, mas falta o template aprovado.");
    console.log("  Enquanto isso, a escola só consegue responder quem escreveu nas últimas 24h.");
  } else {
    console.log("  O envio de teste falhou. Veja o passo 4.");
  }
  return 1;
}

// Define o codigo de saida sem process.exit(): a conexao keep-alive com o
// Graph API ainda esta aberta e encerrar na marra trava o libuv no Windows.
main()
  .then((codigo) => {
    process.exitCode = codigo;
  })
  .catch((e) => {
    console.error(`Erro: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  });
