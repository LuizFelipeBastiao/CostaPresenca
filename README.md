# CostaPresença — Coletor e Notificador do BI Escolar

Solução auditável para automação do acompanhamento da frequência escolar, leitura dos relatórios oficiais do Power BI da SEED-PR, notificação personalizada de responsáveis via WhatsApp/e-mail e emissão de fichas para o Conselho Tutelar.

> 📘 **Configurando pela primeira vez?** Siga o [Guia de configuração](GUIA_DE_CONFIGURACAO.md): passo a passo do computador novo até o bot do WhatsApp respondendo.

---

## 🚀 Como Rodar Tudo de Uma Vez (1 único `.bat`)

Não é necessário decorar comandos no terminal nem abrir vários scripts separados. Todos os atalhos foram unificados em um único arquivo:

👉 **`CostaPresenca.bat`**

Com um **duplo clique** em `CostaPresenca.bat`, ele executa tudo em sequência automaticamente:
1. **Prepara o ambiente:** verifica Node.js, instala dependências na primeira execução (`npm install`) e cria os arquivos locais de configuração a partir dos modelos se ainda não existirem;
2. **Coleta dados do Power BI:** se `config/local.json` e o login institucional já estiverem configurados, coleta automaticamente os relatórios e a lista nominal de presença (caso contrário, segue com os CSVs locais);
3. **Consolida relatórios:** atualiza o resumo executivo e o Painel de Busca Ativa;
4. **Gera a prévia segura:** calcula as quedas semanais de frequência e prepara as mensagens (sem enviar nada automaticamente);
5. **Abre o Painel Web da Secretaria** automaticamente no navegador em `http://localhost:3000`, oferecendo:
   - **📊 Visão Geral:** Contadores de alunos lidos, quedas de frequência na semana, casos com infrequência crítica (< 75%) e mensagens prontas.
   - **💬 Prévia Interativa:** Lista dos alunos cuja frequência caiu, com a semana anterior, a semana atual, a queda em pontos e o texto exato da mensagem.
   - **🚀 Disparo em 1 Clique:** Envio seguro para os responsáveis (com opção de teste prévio no seu próprio celular).
   - **👥 Cadastro de Telefones:** Formulário rápido para adicionar o telefone de pais pendentes sem editar planilhas.
   - **🎟️ Bilhetes do WhatsApp:** Quantos alunos já têm responsável cadastrado pelo bot e o botão que abre os bilhetes (código + QR) para imprimir, por turma ou só de quem ainda falta.
   - **📋 Ficha do Conselho Tutelar:** Emissão e impressão da ficha oficial FICAI para alunos infrequentes com base na LDB e ECA.
   - **📜 Histórico Auditável:** Registro de todos os envios e confirmações de entrega.

### Opções extras do `CostaPresenca.bat` (via terminal, opcional)

| Comando | O que faz |
|:---|:---|
| `CostaPresenca.bat` | **Padrão (duplo clique):** roda tudo de uma vez e abre o Painel Web |
| `CostaPresenca.bat --painel` | Abre direto o Painel Web (`http://localhost:3000`) sem rodar a coleta |
| `CostaPresenca.bat --coleta` | Roda apenas coleta + consolidação + prévia e encerra (usado no agendamento) |
| `CostaPresenca.bat --agendar [HH:MM]` | Cria a tarefa agendada diária no Windows (padrão `17:30`) |
| `CostaPresenca.bat --login` | Abre o Edge para fazer login institucional e MFA no Power BI |
| `CostaPresenca.bat --diagnostico` | Confere credenciais, número e template da WhatsApp Cloud API |
| `CostaPresenca.bat --bot` | Liga só o bot que cadastra os pais pelo WhatsApp (porta 3001). O duplo clique normal já liga o bot e o túnel sozinho |
| `Entrar no Power BI.bat` | Duplo clique: abre o Edge para o login institucional (MFA) quando a sessão do Power BI expira |
| `Agendar atualizacao diaria.bat` | Duplo clique: cria a tarefa do Windows que coleta os dados todo dia (rodar uma vez por computador) |
| `CostaPresenca.bat --ajuda` | Mostra todas as opções disponíveis |

*(Se preferir abrir somente o painel pelo Node/npm: `npm start` ou `npm run ui`)*.

---

## 📋 Análise de Aderência e Requisitos

Para conferir a análise detalhada de todos os requisitos do *Sistema de Comunicação de Faltas com os Responsáveis*, consulte o documento:  
📄 **[ANALISE_SISTEMA_FALTAS.md](ANALISE_SISTEMA_FALTAS.md)**

---

## 🔒 Limites de Segurança e Privacidade (LGPD)

- Funciona apenas nos hosts autorizados declarados em `allowedHosts` (`app.powerbi.com`).
- A coleta do Power BI exige a flag `--execute`.
- **Sem senhas no código:** O login institucional utiliza o perfil persistente do Microsoft Edge (`npm run login`), respeitando MFA institucional.
- **Privacidade total (LGPD):** O histórico de disparos armazena apenas o **hash SHA-256** do telefone/e-mail, nunca o número em claro.
- Logs em console mascaram contatos (`+55 45 9****-8888`).
- Dados, perfil do navegador e segredos permanecem fora do controle de versão (Git).

---

## 🛠️ Instalação e Preparação Inicial

```powershell
# 1. Instalar as dependências
npm install

# 2. Instalar navegadores do Playwright (para coleta automatizada no Power BI)
npx playwright install chromium

# 3. Configurar os arquivos de ambiente
Copy-Item config/reports.example.json config/local.json
Copy-Item config/notificacoes.example.json config/notificacoes.json
Copy-Item .env.example .env
New-Item -ItemType Directory -Force data/cadastros
Copy-Item config/contatos_responsaveis.example.csv data/cadastros/contatos_responsaveis.csv
```

*(Observação: ao dar duplo clique em `CostaPresenca.bat`, os passos `npm install` e cópia de `local.json`, `notificacoes.json` e `.env` já são feitos automaticamente caso ainda não existam.)*

---

## 🌐 Automação da Coleta (Power BI SEED-PR)

### 1. Login Institucional

```powershell
npm run login -- --config config/local.json
```
O navegador abrirá para o operador realizar o login com a conta institucional e MFA. O perfil fica salvo localmente em `.auth/powerbi-profile`.

### 2. Coleta Nominal de Presença e Alunos

```powershell
# Coleta a lista nominal de alunos com CGM e presenças:
npm run collect:presente-alunos

# Coleta o painel de notas do Pré-Conselho:
npm run collect:pre-conselho

# Coleta todos os relatórios habilitados:
npm run collect:all

# Gera o resumo executivo e o painel de Busca Ativa:
npm run consolidate
```

*(Dica: você pode rodar a esteira completa de uma vez dando duplo clique em `CostaPresenca.bat`, ou sem abrir o navegador com `CostaPresenca.bat --coleta`).*

---

## 💬 Sistema de Notificações aos Responsáveis

**Quando o aviso sai:** apenas quando a frequência semanal do estudante **caiu** em relação à semana anterior. A verificação roda diariamente, mas um aluno cuja frequência está baixa e estável não gera mensagem repetida — só uma nova piora dispara novo aviso.

O sistema cruza a presença nominal (`data/presente-alunos/presente-alunos-latest.csv`) pelo **CGM** com a base de contatos dos pais (`data/cadastros/contatos_responsaveis.csv` ou cadastros via bot de WhatsApp).

### 1. Prévia das Mensagens (Modo Seguro)

```powershell
npm run notificar
```
Gera a conferência no terminal e grava `data/notificacoes/previa-latest.csv` para conferência no Excel antes de qualquer envio.

A prévia traz a presença da semana anterior, a da semana atual e a queda em pontos, lado a lado.

Quem **não** entra na lista aparece no resumo com o motivo: `sem queda na semana` (faltou igual ou melhorou), `presença ok`, `amparo legal` (falta justificada), `sem semana anterior` (sem base de comparação), `não matriculado` e `acima da idade`.

Status possíveis:
- `pronto`: mensagem pronta para disparo.
- `ja-notificado`: o aviso já saiu nesta semana (respeita janela de reenvio).
- `sem-contato`: aluno sem telefone cadastrado.
- `sem-consentimento`: falta consentimento formal do responsável.

### 2. Gerar Lista de Contatos Pendentes

```powershell
npm run notificar:contatos
```
Gera a planilha `data/cadastros/contatos_pendentes.csv` com todos os alunos com queda de frequência que ainda não possuem telefone cadastrado.

### 3. Disparo das Notificações

```powershell
# Envio de teste (dispara até 3 mensagens apenas para o seu número):
npm run notificar -- --execute --destino-teste 45999998888

# Envio real para todos os responsáveis prontos:
npm run notificar -- --execute
```

---

## ⚙️ Regras de Negócio e Modelos

Configuradas em `config/notificacoes.json`:

| Opção | Padrão | Descrição |
|:---|:---:|:---|
| `exigirQuedaSemanal` | `true` | **Regra central:** só avisa quem teve a presença semanal **menor que a da semana anterior**. Quem faltou igual ou melhorou não recebe nova mensagem. |
| `quedaMinimaPontos` | `0` | Queda mínima, em pontos percentuais, para avisar. `0` = qualquer queda real; `10` = só quedas de 10 pontos ou mais. |
| `semanaReferencia` | `atual` | `atual` usa a semana em curso; `anterior` usa a semana fechada. Com `exigirQuedaSemanal` ligado só vale `atual` — a comparação usa a coluna da semana passada do mesmo CSV. |
| `presencaSemanaAbaixoDe` | `100` | Filtro adicional: além de ter caído, a presença precisa estar abaixo disso (100 = qualquer falta). |
| `presencaGeralCriticaAbaixoDe` | `75` | Abaixo disso (< 75% da LDB) usa o modelo de mensagem **crítica**. |
| `ignorarAmparoLegalDias` | `14` | Ignora quem tem Amparo Legal recente (falta justificada). |
| `somenteMatriculados` | `true` | Descarta alunos transferidos ou desistentes. |

Variáveis disponíveis para os textos das mensagens:  
`{responsavel}` `{aluno}` `{primeiroNome}` `{turma}` `{escola}` `{telefoneEscola}` `{presencaSemana}` `{presencaSemanaAnterior}` `{quedaSemana}` `{presencaGeral}` `{dataReferencia}`

---

## 🟢 Ligando a WhatsApp Cloud API (passo a passo)

> Confira cada etapa com `npm run whatsapp:diagnostico`. Ele fala com a API da Meta e diz exatamente o que falta — não envia nada aos responsáveis.

### 1. O número não pode estar em uso no WhatsApp comum

Um número que já está num celular com WhatsApp ou WhatsApp Business **não pode** ser usado na Cloud API enquanto estiver lá. Ou você apaga a conta dentro do app (Configurações → Conta → Apagar minha conta) e espera a liberação, ou usa um número novo — um chip só para isso, ou um fixo da escola que receba ligação de verificação.

### 2. Criar o app

Em [developers.facebook.com](https://developers.facebook.com) → **Meus apps** → **Criar app**:
- Caso de uso: **Outro** → tipo **Empresa** (o caminho "Outro" é o que libera o produto WhatsApp).
- Vincule à conta do **Meta Business** da escola.
- Na tela do app, adicione o produto **WhatsApp**.

### 3. Pegar as credenciais

Em **WhatsApp → Configuração da API**, copie para o `.env`:

| Campo na tela da Meta | Variável no `.env` |
|:---|:---|
| Identificação do número de telefone | `WHATSAPP_PHONE_NUMBER_ID` |
| Token de acesso temporário | `WHATSAPP_TOKEN` |
| Identificação da conta do WhatsApp Business | `WHATSAPP_WABA_ID` |

⚠️ **O `PHONE_NUMBER_ID` não é o telefone.** É um número longo de identificação. O diagnóstico recusa o valor se você colar `+5545...` por engano.

Nessa tela a Meta já dá um **número de teste** e permite cadastrar até 5 destinatários — dá para validar o disparo hoje, antes de ter número próprio e template aprovado.

### 4. Token permanente

O token da tela de configuração **expira em 24 horas**. Para a rotina diária, gere um que não expira:

**Configurações do Meta Business → Usuários → Usuários do sistema → Adicionar** → perfil *Admin* → **Gerar novo token** → escolha o app → marque `whatsapp_business_messaging` e `whatsapp_business_management`. Guarde: a Meta mostra o token uma vez só.

### 5. Template aprovado (obrigatório para os avisos)

A escola inicia a conversa, então a Meta exige um **template** pré-aprovado. Em **WhatsApp Manager → Modelos de mensagem → Criar modelo**:
- Categoria: **Utilidade** (não Marketing — é mais caro e tem regras de opt-in mais duras).
- Nome: `aviso_frequencia` · Idioma: **Português (BR)**.
- Corpo, com os parâmetros nesta ordem exata:

```
Olá, {{1}}. Esta é uma mensagem de {{2}}.
A frequência de {{3}} ({{4}}) caiu de {{5}} na semana anterior para {{6}} na semana de {{7}}.
Se houver justificativa, entre em contato com a secretaria: {{8}}.
```

A ordem dos `{{n}}` precisa bater com `whatsappCloud.template.parametros` em `config/notificacoes.json`:

```json
"template": {
  "nome": "aviso_frequencia",
  "idioma": "pt_BR",
  "parametros": ["responsavel", "escola", "aluno", "turma", "presencaSemanaAnterior", "presencaSemana", "dataReferencia", "telefoneEscola"]
}
```

### 6. Conferir e disparar

```powershell
# Checa credenciais, número, template e explica o que estiver faltando:
npm run whatsapp:diagnostico

# Manda UMA mensagem de teste para o seu próprio celular:
npm run whatsapp:diagnostico -- --enviar 45999998888
```

Com tudo verde, mude `"canal": "whatsapp-cloud"` em `config/notificacoes.json` e siga o fluxo normal de prévia e disparo.

### 💰 O que é grátis e o que é cobrado

| Situação | Custo |
|:---|:---|
| Pai manda mensagem e a escola responde em até 24h | **Grátis** (conversa de atendimento, sem limite) |
| Bot de cadastro (`CADASTRAR K7P-4Q2` e a resposta) | **Grátis** — é o caso acima |
| Aviso de falta, iniciado pela escola fora da janela de 24h | **Cobrado por mensagem** (template de utilidade) |

Ou seja: o bot de cadastro cabe no limite gratuito; os avisos de falta não. Com ~200 avisos por semana, a tarifa de utilidade no Brasil costuma ficar na casa de poucos centavos por mensagem — **confirme o valor atual em WhatsApp Manager → Insights**, porque a Meta muda os preços periodicamente.

Contas sem verificação de empresa também têm um teto de **conversas iniciadas pela escola por dia**. Se a escola tiver mais responsáveis que esse teto, é preciso concluir a verificação do negócio no Meta Business.

---

## 🤖 Bot de Cadastro dos Pais pelo WhatsApp

O telefone do responsável entra no sistema **sem a secretaria digitar nada**: a escola entrega um bilhete com um código por aluno, o pai manda `CADASTRAR K7P-4Q2` para o WhatsApp da escola e o bot responde confirmando. A partir daí, aquele número recebe os avisos de queda de frequência daquele aluno.

- O código impede que alguém cadastre o próprio número no aluno de outra família. São 5 erros por dia por número; depois disso o número fica bloqueado até o dia seguinte.
- Cada aluno aceita até 3 responsáveis (`maxResponsaveisPorAluno`). Um responsável com vários filhos manda um código de cada vez.
- O pai pode mandar `STATUS` para ver os próprios cadastros e `SAIR` para parar de receber avisos.
- O número fica gravado **exatamente como o WhatsApp informa** (`wa_id`), que é o formato que a Meta aceita no envio. Isso evita o problema do 9º dígito dos celulares brasileiros.
- Com `"aprovacaoManual": true`, o cadastro fica pendente até a secretaria aprovar (`npm run cadastro -- pendentes` / `aprovar <CGM>`).

### 1. Configuração

Em `config/notificacoes.json`:

```json
"fonteContatos": "ambos",
"cadastro": {
  "numeroWhatsappEscola": "(45) 99999-0000",
  "aprovacaoManual": false
}
```

`fonteContatos: "ambos"` soma os pais cadastrados pelo bot aos telefones da planilha e do painel. O padrão (`"cadastros"`) usa **só** o bot.

No `.env`:

```
WHATSAPP_VERIFY_TOKEN=uma-senha-que-voces-inventam
WHATSAPP_APP_SECRET=valor de App settings > Basic > App Secret
```

`WHATSAPP_TOKEN` e `WHATSAPP_PHONE_NUMBER_ID` são os mesmos do envio de avisos.

### 2. Imprimir os bilhetes

**Pelo painel (sem comandos):** aba **🎟️ Bilhetes do WhatsApp** → escolha a turma (ou todas) → **Abrir bilhetes para imprimir** → **Imprimir**. Marque "Só alunos que ainda não têm responsável" para mandar de novo só para quem falta.

**Pelo terminal:**

```powershell
npm run cadastro -- bilhetes                       # todos os alunos matriculados
npm run cadastro -- bilhetes --turma "6º Série A"  # só uma turma
npm run cadastro -- bilhetes --sem-cadastro        # só quem ainda não tem responsável
```

O comando lê o CSV de presença mais recente, cria um código para cada aluno e reaproveita os que já existem. O resultado fica em `data/cadastros/bilhetes.html`: abra no navegador e imprima com Ctrl+P (são 8 bilhetes por folha A4). Cada bilhete tem um **QR code** que abre o WhatsApp com a mensagem já digitada; o pai só precisa tocar em Enviar.

Outros comandos da secretaria:

```powershell
npm run cadastro -- novo-codigo 123456789   # bilhete perdido: invalida o código antigo
npm run cadastro -- resumo                  # quantos alunos já têm responsável cadastrado
npm run cadastro -- pendentes               # (aprovacaoManual) quem aguarda aprovação
npm run cadastro -- aprovar 123456789       # ou: aprovar --todos
npm run cadastro -- recusar 123456789
```

### 3. Expor o bot na internet (túnel)

A Meta só entrega mensagens numa URL **HTTPS pública**. O bot roda no PC da escola e escuta apenas em `localhost:3001`. Um túnel publica **somente** essa porta; o painel (porta 3000) não passa pelo túnel e não fica exposto na internet (mas pode ser aberto por outros computadores da rede da escola, porque ainda não tem login).

Com o **ngrok**, a conta gratuita já vem com um endereço fixo (`algo.ngrok-free.dev`) que não muda ao reiniciar:

```powershell
ngrok config add-authtoken <seu token do painel do ngrok>
ngrok http 3001
```

Outra opção é o Cloudflare Tunnel. O modo rápido (`cloudflared tunnel --url http://localhost:3001`) gera um endereço novo a cada execução, e aí a Callback URL na Meta precisa ser atualizada toda vez. Para usar o Cloudflare de forma permanente, é preciso um *named tunnel* com domínio próprio.

### 4. Ligar o bot

O duplo clique no `CostaPresenca.bat` já liga o bot e o túnel ngrok em duas janelas minimizadas ("CostaPresenca - Bot WhatsApp" e "CostaPresenca - Tunel ngrok"), desde que `WHATSAPP_APP_SECRET` esteja no `.env` e o `ngrok.exe` esteja na pasta do projeto (ou instalado no PATH). Se já estiverem rodando, ele não abre de novo. Para ligar só o bot pelo terminal:

```powershell
npm run bot              # ou: CostaPresenca.bat --bot
npm run bot -- --simular # testa sem enviar respostas (mostra no terminal)
```

Deixe a janela aberta. O bot só responde enquanto o PC, o bot e o túnel estiverem ligados. Se estiverem desligados, a Meta reenvia a mensagem por algum tempo. Mas a resposta gratuita ao pai só é aceita em até 24h depois da mensagem dele, então mensagens mais antigas são cadastradas sem resposta (o erro aparece no log).

### 5. Configurar o webhook na Meta

Em **Meta for Developers → seu app → WhatsApp → Configuration** (em apps criados pelo caso de uso "Conectar com clientes pelo WhatsApp", fica em *Use cases → Customize → Configuration*):

1. **Callback URL:** `https://<endereço-do-túnel>/webhook`
2. **Verify token:** o mesmo valor de `WHATSAPP_VERIFY_TOKEN`
3. Clique em **Verify and save**. A Meta faz um GET no bot e o terminal mostra `verificacao-ok`.
4. Em **Webhook fields**, assine o campo **messages**. Sem essa assinatura, a verificação passa mas nenhuma mensagem chega.

Mande `oi` do seu celular para o número da escola: o bot deve responder com as instruções de cadastro.

**Se as mensagens não chegarem:**
- Confira se o app está publicado (modo *Live*). Em modo de desenvolvimento, só os números de teste cadastrados no app falam com o bot.
- A conta do WhatsApp Business (WABA) precisa estar inscrita no app:
  `curl -X POST "https://graph.facebook.com/v25.0/<WHATSAPP_WABA_ID>/subscribed_apps" -H "Authorization: Bearer <WHATSAPP_TOKEN>"`
- `assinatura-invalida` no terminal quer dizer que `WHATSAPP_APP_SECRET` está errado.

Cada mensagem tratada vira uma linha em `data/cadastros/bot.jsonl`, com o telefone mascarado e sem o texto da mensagem. A base de cadastros fica em `data/cadastros/cadastros.json`, fora do Git.

---

## 📱 Canais de Envio Suportados

| Canal | Destino | Configuração |
|:---|:---:|:---|
| `dry-run` | — | Modo de simulação seguro padrão (não gasta créditos e não envia nada). |
| `whatsapp-cloud` | Telefone | **WhatsApp Business Cloud API oficial (Meta)**. Requer `WHATSAPP_PHONE_NUMBER_ID` e `WHATSAPP_TOKEN` no `.env` e um template aprovado. Veja o passo a passo acima. |
| `webhook` | Telefone ou E-mail | Gateways de WhatsApp/SMS (Evolution API, Z-API, n8n). Requer URL em `config/notificacoes.json`. |
| `smtp` | E-mail | Envio por e-mail institucional via `nodemailer`. Requer credenciais no `.env`. |

---

## ⏰ Agendamento Automático no Windows

Para executar a coleta diária automaticamente (ex.: às 17:30 ao término do turno escolar):
```powershell
.\CostaPresenca.bat --agendar
# ou informando o horário direto:
.\CostaPresenca.bat --agendar 17:30
```
- O assistente criará uma tarefa no Agendador de Tarefas do Windows (`schtasks`) chamando `CostaPresenca.bat --coleta` todos os dias no horário configurado (sem abrir o navegador).

---

## 🧪 Testes Automatizados

Para executar os 23 testes automatizados do sistema:
```powershell
npm test
```
Para verificar os tipos estritos do TypeScript:
```powershell
npm run check
```
