# Guia de configuração do CostaPresença

Este guia leva um computador do zero até o sistema completo funcionando:

- coleta automática da frequência no Power BI da SEED;
- painel da secretaria;
- avisos de falta aos responsáveis pelo WhatsApp;
- bot que cadastra o telefone dos pais.

**Quem faz a configuração** precisa saber abrir um terminal (as etapas 1 a 6). **Quem usa no dia a dia** (a secretaria) só dá dois cliques em arquivos e usa o painel no navegador (etapa 7).

> Os nomes de menus da Meta mudam com frequência. Se algum caminho deste guia não bater com a tela, procure o nome do campo (ex.: "URL de callback") na busca do painel da Meta.

---

## Sumário

0. [O que você vai precisar](#0-o-que-você-vai-precisar)
1. [Instalar o CostaPresença no computador](#1-instalar-o-costapresença-no-computador)
2. [Coleta do Power BI](#2-coleta-do-power-bi)
3. [Dados da escola e regras dos avisos](#3-dados-da-escola-e-regras-dos-avisos)
4. [WhatsApp Cloud API (Meta)](#4-whatsapp-cloud-api-meta)
5. [Bot de cadastro dos pais](#5-bot-de-cadastro-dos-pais)
6. [Política de privacidade e publicação do app](#6-política-de-privacidade-e-publicação-do-app)
7. [Uso no dia a dia (secretaria)](#7-uso-no-dia-a-dia-secretaria)
8. [Pausar o bot e trocar o número](#8-pausar-o-bot-e-trocar-o-número)
9. [Problemas comuns](#9-problemas-comuns)
10. [Onde ficam os dados](#10-onde-ficam-os-dados)

---

## 0. O que você vai precisar

| Item | Para quê |
|:---|:---|
| Computador com **Windows** e **Microsoft Edge** | Roda tudo. Precisa ficar ligado para o bot responder e para a coleta diária. |
| **Node.js 22 ou mais novo** ([nodejs.org](https://nodejs.org)) | Executa o sistema. |
| Conta institucional da SEED com acesso ao Power BI (com MFA) | Coleta da frequência. |
| Conta no **Meta Business** da escola e acesso ao [Meta for Developers](https://developers.facebook.com) | WhatsApp Cloud API. |
| Um **número de telefone só para o WhatsApp da escola** | Ele **não pode** estar ativo no WhatsApp de nenhum celular (veja 4.1). |
| Conta gratuita no **[ngrok](https://ngrok.com)** | Liga o bot, que roda no PC da escola, à internet. |
| Conta Google da escola (opcional) | Publicar a política de privacidade (etapa 6). |

---

## 1. Instalar o CostaPresença no computador

1. Instale o **Node.js 22** (versão LTS) em [nodejs.org](https://nodejs.org), aceitando as opções padrão.
2. Baixe o projeto para uma pasta fixa, por exemplo `C:\CostaPresenca`:
   - com Git: `git clone https://github.com/LuizFelipeBastiao/CostaPresenca.git C:\CostaPresenca`;
   - sem Git: no GitHub, **Code → Download ZIP**, e extraia na pasta.
3. Dê **dois cliques em `CostaPresenca.bat`**. Na primeira vez ele:
   - instala as dependências (`npm install`, leva 1–2 minutos);
   - cria `config\notificacoes.json`, `config\local.json` e `.env` a partir dos modelos;
   - abre o painel em `http://localhost:3000` (ainda sem dados).

   Feche a janela preta para encerrar.

> Dica: crie atalhos na área de trabalho para `CostaPresenca.bat`, `Entrar no Power BI.bat` e `Agendar atualizacao diaria.bat` (botão direito → **Enviar para → Área de trabalho (criar atalho)**). A secretaria só vai precisar deles.

---

## 2. Coleta do Power BI

A coleta abre o Edge sozinha, entra no relatório **2026 Presente Estadual**, muda para a visão **TURMA**, filtra pela escola e salva a lista nominal de alunos com CGM e presença.

Os campos desta seção e da seção 3 também podem ser preenchidos pelo painel, na aba **⚙️ Configurações**: o painel confere cada campo antes de salvar e guarda uma cópia do arquivo anterior (`.bak`). Para abrir o painel antes de configurar a coleta, dê dois cliques no `CostaPresenca.bat`: ele pula a coleta e abre o painel no final. A aba só funciona no próprio computador do CostaPresença, não por outro computador da rede.

### 2.1 Endereço do relatório

1. No navegador, entre no Power BI com a conta da escola e abra o relatório **2026 Presente Estadual**.
2. Copie o endereço inteiro da barra do navegador. Ele começa com `https://app.powerbi.com/groups/...`.
3. Cole o endereço em **Configurações → Endereço do relatório Presente Estadual** e salve. (Sem o painel: abra `config\local.json` no Bloco de Notas e troque `https://app.powerbi.com/COLE-AQUI-A-URL-AUTORIZADA` pelo endereço copiado.)

Deixe desligada a opção **coleta genérica do Presente Estadual** (`"enabled": false`). A lista de alunos vem de outra etapa; ligada, ela só deixa a atualização uns 2 minutos mais lenta e termina em erro.

### 2.2 Nome da escola no filtro

O coletor precisa achar a escola no filtro **ESCOLA** do relatório. O Power BI usa o nome **abreviado**. Por exemplo: `ARTHUR DA C SILVA, C E C-M MAL-EF M P - 41077512`.

Em **Configurações → Nome da escola no filtro ESCOLA**, coloque um trecho desse nome. Sem o painel: em `config\local.json`, logo abaixo de `"settleMs": 1500,`, coloque:

```json
  "context": {
    "escolaNome": "ARTHUR DA C SILVA"
  },
```

Se a escola não for de Foz do Iguaçu, ajuste também o **NRE** (no arquivo, `"nre": "NOME DO NRE"` dentro de `context`).

> Esse filtro é uma trava de segurança. Se o coletor não conseguir deixar o filtro só com a sua escola, ele **para sem salvar nada**. É melhor uma coleta falhar do que salvar dados de outra escola como se fossem desta.

### 2.3 Login institucional

1. Dê dois cliques em **`Entrar no Power BI.bat`**.
2. No Edge que abrir, entre com a conta da SEED e faça o MFA.
3. Quando o Power BI carregar, **volte à janela preta e aperte ENTER**.

O login fica salvo em `.auth\powerbi-profile`. Só é preciso repetir quando a sessão expirar (veja a seção 9).

### 2.4 Primeira coleta

1. Dê dois cliques em **`CostaPresenca.bat`**.
2. O Edge abre sozinho. **Não clique nele nem o feche.** A coleta leva uns 2 minutos.
3. Na janela preta deve aparecer `[SUCESSO] Lista nominal de estudantes e presenças salva`, com o número de alunos.
4. No final, o painel abre no navegador.

Os arquivos ficam em `data\presente-alunos\` (o mais recente é `presente-alunos-latest.csv`).

### 2.5 Coleta diária automática

Dê dois cliques em **`Agendar atualizacao diaria.bat`** e aperte ENTER para aceitar 17:30, ou digite outro horário. Isso cria uma tarefa no Agendador de Tarefas do Windows que roda a coleta todo dia.

Para a tarefa rodar, o computador precisa estar **ligado e com o Windows logado** nesse horário.

---

## 3. Dados da escola e regras dos avisos

No painel, em **Configurações**, preencha os cartões **Escola** e **Avisos de falta** e salve. Sem o painel, abra `config\notificacoes.json` e ajuste:

```json
{
  "escola": {
    "nome": "Colégio Estadual Arthur da Costa e Silva",
    "telefoneContato": "(45) 3000-0000"
  },
  "canal": "dry-run",
  "fonteContatos": "ambos",
  "cadastro": {
    "numeroWhatsappEscola": "(45) 99999-0000"
  },
  ...
}
```

| Campo | O que é |
|:---|:---|
| `escola.nome` | Aparece nos avisos, nas respostas do bot e nos bilhetes. |
| `escola.telefoneContato` | Telefone da secretaria, citado nos avisos de falta. |
| `canal` | `dry-run` não envia nada (use até terminar a etapa 4). Depois, troque para `whatsapp-cloud`. |
| `fonteContatos` | De onde vêm os telefones dos pais: `cadastros` (só o bot), `planilha` (só o cadastro manual do painel) ou **`ambos`** (recomendado). |
| `cadastro.numeroWhatsappEscola` | Número do WhatsApp da escola **na API da Meta**. Vai impresso nos bilhetes e dentro do QR code. |

As regras de quando avisar (queda semanal, mínimo de 75% etc.) estão explicadas no [README](README.md), na seção "Regras de Negócio e Modelos". Os padrões já servem para a maioria das escolas.

---

## 4. WhatsApp Cloud API (Meta)

### 4.1 Escolher o número

O número da escola **não pode estar ativo no WhatsApp comum nem no WhatsApp Business** de nenhum aparelho. Escolha uma destas opções:

- um chip novo só para isso;
- o telefone fixo da secretaria, que é verificado por ligação de voz;
- um número que já tinha WhatsApp, apagando a conta no aplicativo antes (**Configurações → Conta → Apagar minha conta**).

### 4.2 Criar o app

1. Em [developers.facebook.com](https://developers.facebook.com), vá em **Meus apps → Criar app**.
2. Caso de uso: **Conectar-se com clientes pelo WhatsApp**. Vincule ao portfólio empresarial (Meta Business) da escola.
3. Em **Casos de uso → Personalizar → Configuração da API**, siga os passos para adicionar e verificar o número da escola.

### 4.3 Nome de exibição

Em **WhatsApp Manager → Números de telefone**, defina o **nome de exibição** como o nome da escola. É o nome que os pais veem na conversa, e a Meta analisa a troca antes de aprovar.

### 4.4 Credenciais no `.env`

Abra o `.env` no Bloco de Notas e preencha:

| Variável | Onde achar |
|:---|:---|
| `WHATSAPP_PHONE_NUMBER_ID` | **Configuração da API → Identificação do número de telefone**. É um número longo de identificação, **não** o telefone. |
| `WHATSAPP_TOKEN` | Token **permanente**: **Configurações do Meta Business → Usuários → Usuários do sistema → Adicionar** (perfil Admin) **→ Gerar novo token**. Escolha o app e marque `whatsapp_business_messaging` e `whatsapp_business_management`. A Meta mostra o token uma vez só. |
| `WHATSAPP_WABA_ID` | **Configuração da API → Identificação da conta do WhatsApp Business** (opcional, usado pelo diagnóstico). |

Escreva os valores sem aspas e sem espaços em volta do `=`.

### 4.5 Modelo de mensagem (template) dos avisos

Avisos iniciados pela escola exigem um modelo aprovado pela Meta. O passo a passo, com o texto e a ordem dos parâmetros, está no [README](README.md), na seção "Ligando a WhatsApp Cloud API", item 5 ("Template aprovado").

### 4.6 Forma de pagamento

Avisos de falta são **cobrados por mensagem** (categoria utilidade). Cadastre um cartão em **WhatsApp Manager → Configurações de pagamento**. Sem isso, os avisos não saem.

As respostas do bot de cadastro são gratuitas.

### 4.7 Conferir

No terminal, na pasta do projeto, rode `CostaPresenca.bat --diagnostico` (ou `npm run whatsapp:diagnostico`). O diagnóstico confere token, número e template e diz o que falta.

Para mandar uma mensagem de teste para o seu celular:

```
npm run whatsapp:diagnostico -- --enviar 45999998888
```

Com tudo certo, troque `"canal": "dry-run"` por `"canal": "whatsapp-cloud"` no `config\notificacoes.json`.

---

## 5. Bot de cadastro dos pais

O bot recebe a mensagem `CADASTRAR <código>` que o pai envia a partir do bilhete e grava o telefone dele junto ao aluno. Ele roda no PC da escola, e o **ngrok** cria um endereço público na internet para a Meta entregar as mensagens a ele.

### 5.1 Segredos do bot no `.env`

Acrescente ao `.env`:

```
WHATSAPP_VERIFY_TOKEN=uma-senha-que-voces-inventam
WHATSAPP_APP_SECRET=cole-aqui-a-chave-secreta
```

- **`WHATSAPP_VERIFY_TOKEN`**: qualquer senha sem espaços. Ela também vai no campo "Verificar token" na Meta (passo 5.4).
- **`WHATSAPP_APP_SECRET`**: na Meta, em **Configurações do app → Básico → Chave Secreta do Aplicativo → Mostrar**. São 32 letras e números. O bot usa essa chave para recusar mensagens que não vieram da Meta.

### 5.2 ngrok

1. Crie uma conta gratuita em [dashboard.ngrok.com/signup](https://dashboard.ngrok.com/signup).
2. Em **Getting Started → Setup & Installation**, baixe o ngrok para Windows e coloque o **`ngrok.exe` dentro da pasta do CostaPresença**.
3. Em [dashboard.ngrok.com/get-started/your-authtoken](https://dashboard.ngrok.com/get-started/your-authtoken), copie o comando `ngrok config add-authtoken ...` e rode-o uma vez no terminal, na pasta do projeto.
4. Em **Domains**, anote o seu domínio gratuito, algo como `nome-aleatorio.ngrok-free.dev`. Ele é fixo e não muda quando o PC reinicia.

### 5.3 Ligar o bot

Dê dois cliques em **`CostaPresenca.bat`**. Além do painel, ele abre duas janelas **minimizadas** na barra de tarefas:

- **CostaPresenca - Bot WhatsApp**: deve mostrar `Bot de cadastro ouvindo em http://127.0.0.1:3001/webhook`;
- **CostaPresenca - Tunel ngrok**: deve mostrar a linha `Forwarding https://<seu-dominio>.ngrok-free.dev -> http://localhost:3001`.

Para conferir, abra `http://localhost:3001/saude` no navegador: tem que aparecer `ok`.

Só a porta 3001 (bot) vai para a internet. O painel (porta 3000) não passa pelo túnel e não fica exposto na internet. Ele ainda não tem login, então pode ser aberto por outros computadores da rede da escola.

### 5.4 Webhook na Meta

1. No app da Meta: **Casos de uso → Personalizar → Configuração** (seção **Configurar webhooks**).
2. **URL de callback**: `https://<seu-dominio>.ngrok-free.dev/webhook`.
3. **Verificar token**: a mesma senha de `WHATSAPP_VERIFY_TOKEN`.
4. Clique em **Verificar e salvar**. Na janela do bot deve aparecer `verificacao-ok`.
5. Na lista de **campos do webhook**, confira se **messages** está **assinado** (botão azul).
6. Opcional: clique em **Teste** ao lado de `messages` e depois em **Enviar para servidor**. A Meta deve mostrar que o teste foi realizado com sucesso.

---

## 6. Política de privacidade e publicação do app

Enquanto o app estiver **"Em desenvolvimento"**, a Meta só entrega os webhooks de teste do painel. **Mensagens reais dos pais não chegam ao bot.** Para publicar, a Meta exige uma política de privacidade pública.

### 6.1 Publicar a política

1. Escreva a política, explicando:
   - o que o canal guarda (telefone, nome do perfil e vínculo com o aluno);
   - para que serve (só avisos de frequência);
   - por quanto tempo os dados ficam guardados;
   - como sair (`SAIR`).
2. No **Google Docs**, com a conta da escola: **Arquivo → Compartilhar → Publicar na Web → Publicar**. Copie o link que termina em `/pub`.

### 6.2 Publicar o app

1. Em **Configurações do app → Básico**, preencha **URL da Política de Privacidade** com o link `/pub`, escolha uma **Categoria** e clique em **Salvar alterações**.
2. No menu lateral, abra **Publicar** e clique em **Publicar**. A Meta confirma com "Seu app foi publicado com sucesso".

### 6.3 Teste real

De um celular qualquer, mande `oi` para o número da escola. O bot deve responder com as instruções de cadastro, e a janela do bot deve mostrar uma linha terminando em `ajuda`.

---

## 7. Uso no dia a dia (secretaria)

| Quando | O que fazer |
|:---|:---|
| Ao chegar | Dois cliques em **`CostaPresenca.bat`**. Ele atualiza os dados, abre o painel e liga o bot. Deixe as janelas abertas (podem ficar minimizadas). |
| Imprimir bilhetes | Painel → aba **🎟️ Bilhetes do WhatsApp** → escolha a turma → **Abrir bilhetes para imprimir** → **Imprimir**. São 8 bilhetes por folha A4. |
| Reimprimir só para quem falta | Na mesma aba, marque **"Só alunos que ainda não têm responsável"**. |
| Bilhete perdido | No terminal: `npm run cadastro -- novo-codigo <CGM>`. O código antigo deixa de valer; depois reimprima o bilhete da turma. |
| Ver quantos pais já se cadastraram | Painel → aba Bilhetes: "X de Y alunos". |
| Enviar avisos de falta | Painel → **💬 Notificações aos Pais**: confira a prévia, faça um envio de teste para o seu celular e então dispare. |
| A coleta avisou que o login expirou | Dois cliques em **`Entrar no Power BI.bat`**, faça o MFA, aperte ENTER e rode o `CostaPresenca.bat` de novo. |

**Como o pai se cadastra:** ele aponta a câmera para o QR do bilhete e toca em Enviar. Ou envia `CADASTRAR K7P-4Q2` (o código do bilhete) para o WhatsApp da escola. Depois disso:

- `STATUS` mostra de quais alunos ele recebe avisos;
- `SAIR` cancela o cadastro;
- cada aluno aceita até 3 responsáveis;
- quem tem vários filhos envia um código de cada vez.

---

## 8. Pausar o bot e trocar o número

### Pausar

- **Rápido:** feche as janelas "CostaPresenca - Bot WhatsApp" e "CostaPresenca - Tunel ngrok". O próximo duplo clique no `CostaPresenca.bat` liga as duas de novo.
- **Por um período:** na Meta, em **Configuração → Webhooks**, desligue a assinatura do campo **messages**. Nada chega ao bot, mesmo com as janelas abertas. Para voltar, ligue de novo.

Mensagens recebidas durante a pausa não são respondidas depois.

### Trocar o número do WhatsApp da escola

1. Adicione e verifique o número novo na Meta (4.1 e 4.2) e defina o nome de exibição (4.3).
2. No `.env`, troque **`WHATSAPP_PHONE_NUMBER_ID`** pelo ID do número novo. Se não trocar, o bot ignora as mensagens enviadas ao número novo.
3. No painel, em **Configurações → WhatsApp da escola**, coloque o número novo (no arquivo, é o **`cadastro.numeroWhatsappEscola`** do `config\notificacoes.json`).
4. Atualize o número na política de privacidade.
5. Feche as janelas do bot e dê dois cliques no `CostaPresenca.bat`.
6. Reimprima os bilhetes. **Os códigos continuam os mesmos**; só o número e o QR mudam.

O webhook não precisa ser refeito: ele é do app, não do número.

---

## 9. Problemas comuns

| Sintoma | Causa e solução |
|:---|:---|
| `Ancora do visual nao apareceu apos o carregamento: Turma` (etapa 1/5) | A coleta genérica está ligada. Desligue-a em **Configurações** (2.1); a lista de alunos vem da etapa 3/5. |
| `Relatorio esperado nao encontrado ... 2026 Presente Estadual` | O endereço em `config\local.json` está errado ou é o do modelo. Refaça a 2.1. |
| `Sessao do Power BI expirou` | Dois cliques em `Entrar no Power BI.bat` (2.3). |
| `Nao consegui deixar o filtro ESCOLA so com "..."` | O `escolaNome` em `config\local.json` não bate com o nome abreviado do filtro ESCOLA no Power BI. Veja como a escola aparece no filtro e ajuste (2.2). |
| `Nenhum payload analítico de alunos foi interceptado` | O relatório demorou ou a visão TURMA não abriu. Rode de novo sem mexer no Edge. Se persistir, veja a tela salva em `artifacts\error-...\screenshot.png`. |
| `Variável de ambiente obrigatória ausente: WHATSAPP_...` | Linha faltando ou vazia no `.env` (4.4 e 5.1). |
| `Porta 3001 já está em uso` | O bot já está aberto em outra janela. Feche a duplicada. |
| ngrok: `ERR_NGROK_4018` | Falta o authtoken. Rode o `ngrok config add-authtoken ...` (5.2). |
| `[AVISO] ngrok nao encontrado` | Coloque o `ngrok.exe` na pasta do projeto (5.2). |
| Bot não responde ninguém | Confira, nesta ordem: as duas janelas estão abertas? `http://localhost:3001/saude` mostra `ok`? O app está publicado (6.2)? O campo **messages** está assinado (5.4)? O `WHATSAPP_PHONE_NUMBER_ID` é o do número certo? |
| `assinatura-invalida` na janela do bot | `WHATSAPP_APP_SECRET` errado. Copie de novo (5.1). |
| A Meta recusa "Verificar e salvar" | O bot ou o ngrok estão desligados, ou o verify token é diferente do `.env`. |
| Bilhetes sem QR code | `cadastro.numeroWhatsappEscola` vazio ou inválido (seção 3). |
| Aba Bilhetes: "Ainda não há lista de alunos" | A coleta ainda não rodou com sucesso (2.4). |
| Avisos não saem com canal `whatsapp-cloud` | Template não aprovado (4.5), falta forma de pagamento (4.6) ou token expirado. Rode o diagnóstico (4.7). |

---

## 10. Onde ficam os dados

Tudo fica **só no computador da escola**. Nada disto vai para o Git:

| Arquivo ou pasta | Conteúdo |
|:---|:---|
| `.env` | Tokens e segredos do WhatsApp. |
| `config\local.json` | Endereço do relatório e nome da escola no Power BI. |
| `config\notificacoes.json` | Dados da escola e regras dos avisos. |
| `.auth\powerbi-profile` | Sessão do login institucional. |
| `data\presente-alunos\` | Listas nominais coletadas. |
| `data\cadastros\cadastros.json` | Códigos dos alunos e telefones cadastrados pelo bot. |
| `data\cadastros\bot.jsonl` | Registro das mensagens tratadas (telefone mascarado, sem o texto). |
| `data\notificacoes\` | Prévias e histórico de envios. |
| `artifacts\` | Diagnósticos de coletas que falharam (podem conter tela com dados de alunos). |

Para levar o sistema para outro computador, copie a pasta do projeto **incluindo** `.env`, `config\` e `data\cadastros\`. Sem `data\cadastros\`, os códigos dos bilhetes já entregues deixam de funcionar.
