# CostaPresença — Coletor e Notificador do BI Escolar

Solução auditável para automação do acompanhamento da frequência escolar, leitura dos relatórios oficiais do Power BI da SEED-PR, notificação personalizada de responsáveis via WhatsApp/e-mail e emissão de fichas para o Conselho Tutelar.

---

## 🚀 Como Iniciar com 2 Cliques (Interface Gráfica)

Não é necessário usar comandos no terminal para a rotina diária da escola.

Basta dar um duplo clique em:
👉 **`Abrir_Painel_Escola.bat`**

O servidor local será iniciado e abrirá automaticamente o navegador em `http://localhost:3000`, oferecendo:
- **📊 Visão Geral:** Contadores de alunos lidos, faltas da semana, casos com infrequência crítica (< 75%) e mensagens prontas.
- **💬 Prévia Interativa:** Lista completa dos alunos com faltas e o texto exato da mensagem que será enviada.
- **🚀 Disparo em 1 Clique:** Envio seguro para os responsáveis (com opção de teste prévio no seu próprio celular).
- **👥 Cadastro de Telefones:** Formulário rápido para adicionar o telefone de pais pendentes sem editar planilhas.
- **📋 Ficha do Conselho Tutelar:** Emissão e impressão da ficha oficial FICAI para alunos infrequentes com base na LDB e ECA.
- **📜 Histórico Auditável:** Registro de todos os envios e confirmações de entrega.

*(Se preferir abrir pelo terminal: `npm start` ou `npm run ui`)*.

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
```

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

*(Dica: você pode rodar a esteira completa com um duplo clique no arquivo `executar_coleta.bat`).*

---

## 💬 Sistema de Notificações aos Responsáveis

O sistema cruza a presença nominal (`data/presente-alunos/presente-alunos-latest.csv`) pelo **CGM** com a base de contatos dos pais (`data/cadastros/contatos_responsaveis.csv` ou cadastros via bot de WhatsApp).

### 1. Prévia das Mensagens (Modo Seguro)

```powershell
npm run notificar
```
Gera a conferência no terminal e grava `data/notificacoes/previa-latest.csv` para conferência no Excel antes de qualquer envio.

Status possíveis:
- `pronto`: mensagem pronta para disparo.
- `ja-notificado`: o aviso já saiu nesta semana (respeita janela de reenvio).
- `sem-contato`: aluno sem telefone cadastrado.
- `sem-consentimento`: falta consentimento formal do responsável.

### 2. Gerar Lista de Contatos Pendentes

```powershell
npm run notificar:contatos
```
Gera a planilha `data/cadastros/contatos_pendentes.csv` com todos os alunos com falta que ainda não possuem telefone cadastrado.

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
| `semanaReferencia` | `atual` | `atual` usa a semana em curso; `anterior` usa a semana fechada. |
| `presencaSemanaAbaixoDe` | `100` | Avisa quem teve presença semanal abaixo disso (100 = qualquer falta). |
| `presencaGeralCriticaAbaixoDe` | `75` | Abaixo disso (< 75% da LDB) usa o modelo de mensagem **crítica**. |
| `ignorarAmparoLegalDias` | `14` | Ignora quem tem Amparo Legal recente (falta justificada). |
| `somenteMatriculados` | `true` | Descarta alunos transferidos ou desistentes. |

Variáveis disponíveis para os textos das mensagens:  
`{responsavel}` `{aluno}` `{primeiroNome}` `{turma}` `{escola}` `{telefoneEscola}` `{presencaSemana}` `{presencaGeral}` `{dataReferencia}`

---

## 📱 Canais de Envio Suportados

| Canal | Destino | Configuração |
|:---|:---:|:---|
| `dry-run` | — | Modo de simulação seguro padrão (não gasta créditos e não envia nada). |
| `whatsapp-cloud` | Telefone | **WhatsApp Business Cloud API oficial (Meta)**. Requer `WHATSAPP_PHONE_NUMBER_ID` e `WHATSAPP_TOKEN` no `.env`. |
| `webhook` | Telefone ou E-mail | Gateways de WhatsApp/SMS (Evolution API, Z-API, n8n). Requer URL em `config/notificacoes.json`. |
| `smtp` | E-mail | Envio por e-mail institucional via `nodemailer`. Requer credenciais no `.env`. |

---

## ⏰ Agendamento Automático no Windows

Para executar a coleta diária automaticamente (ex.: às 17:30 ao término do turno escolar):
- Dê um duplo clique em **`agendar_tarefa_diaria.bat`**.
- O assistente criará uma tarefa no Agendador de Tarefas do Windows (`schtasks`) para executar a coleta todos os dias úteis.

---

## 🧪 Testes Automatizados

Para executar os 19 testes automatizados do sistema:
```powershell
npm test
```
Para verificar os tipos estritos do TypeScript:
```powershell
npm run check
```
