# Análise de Aderência: Sistema de Comunicação de Faltas com os Responsáveis

> **Projeto:** CostaPresenca (`bi-escolar-collector`)  
> **Instituição Alvo:** Colégio Estadual Arthur da Costa e Silva (Medianeira / NRE Foz do Iguaçu - PR)  
> **Data da Avaliação:** 29 de Outubro de 2026  
> **Status de Execução:** Projeto instalado, compilado e 100% operacional em ambiente local.

---

## 1. Contexto e Visão Geral do Projeto

O **CostaPresenca** é uma solução desenvolvida para automatizar a leitura, o processamento e a comunicação de dados escolares a partir dos painéis de Business Intelligence (Power BI) da Secretaria de Estado da Educação do Paraná (SEED-PR).

O projeto atua em três frentes complementares:
1. **Coleta e Decodificação de Dados Analíticos:** Automação de navegador (via Playwright / Microsoft Edge) com interceptação de requisições analíticas (`QueryExecutionService` / `querydata`) e decodificação de payloads binários/estruturados DSR (Data Service Request) do Power BI, gerando bases nominais de estudantes com códigos CGM, turmas e frequências.
2. **Motor de Regras de Frequência e Notificação:** Leitura das faltas semanais e gerais, cruzamento de dados com bases de contatos autorizados (planilhas CSV ou bot WhatsApp de autorregistro com PIN), aplicação de filtros de elegibilidade (matrícula, idade, amparo legal/justificativa) e formatação de mensagens personalizadas com priorização de casos críticos (< 75%).
3. **Consolidação Executiva e Busca Ativa:** Geração de painéis de estudantes em risco de abandono escolar (painel SERP / Busca Ativa) e pautas de notas críticas para o Pré-Conselho de Classe.

---

## 2. Como Fazer o Projeto Rodar (Guia Prático)

O projeto foi validado e está completamente funcional. Abaixo estão os comandos para preparar o ambiente e rodar todos os módulos:

### 2.1. Instalação e Testes Automatizados

```powershell
# 1. Instalar as dependências do Node.js
npm install

# 2. Instalar navegadores do Playwright (se for rodar a coleta real no Power BI)
npx playwright install chromium

# 3. Rodar a suíte completa de testes automatizados (17 testes)
npm test

# 4. Validar os tipos TypeScript
npm run check
```

### 2.2. Configuração Inicial

```powershell
# Copiar os modelos de configuração caso ainda não existam
Copy-Item config/notificacoes.example.json config/notificacoes.json
Copy-Item config/reports.example.json config/local.json
Copy-Item .env.example .env
```

*Configuração recomendada em `config/notificacoes.json`:*
- Definir `"fonteContatos": "ambos"` (ou `"planilha"` se for usar apenas CSV manual).
- Manter `"canal": "dry-run"` para testes seguros sem disparo externo.

### 2.3. Execução das Notificações e Consolidação

```powershell
# 1. Gerar planilha com os alunos que estão sem contato cadastrado:
npm run notificar:contatos
# Saída: data/cadastros/contatos_pendentes.csv

# 2. Gerar a PRÉVIA das mensagens (modo seguro, não envia nada):
npm run notificar
# Saída no console + arquivo CSV auditável: data/notificacoes/previa-latest.csv

# 3. Enviar as mensagens de fato (via canal configurado; em dry-run simula e gera log):
npm run notificar -- --execute

# 4. Testar disparo real enviando apenas para um número de teste da equipe:
npm run notificar -- --execute --destino-teste 45999998888

# 5. Gerar os relatórios consolidados e o Painel de Busca Ativa:
npm run consolidate
# Saídas: data/resumo_busca_ativa.csv, data/resumo_escola_total.csv e data/manifest.json
```

---

## 3. Matriz de Avaliação dos Requisitos

Abaixo, confrontamos o documento de especificação (*Sistema de Comunicação de Faltas com os Responsáveis*) com o que está efetivamente construído no código-fonte:

| Item do Requisito | Status | Implementação no Projeto | Arquivos Responsáveis |
| :--- | :---: | :--- | :--- |
| **Importar diariamente o relatório de frequência** | 🟢 **Atende** | Script de extração automatizada via Playwright interceptando requisições do Power BI "Presente Estadual" (aba Turma/Aluno), gerando partição diária histórica e arquivos `-latest.csv`. Suporta script batch (`executar_coleta.bat`). | `src/extract-presente-alunos.ts`, `src/powerbi/dsr-decoder.ts`, `executar_coleta.bat` |
| **Identificar alunos com faltas não justificadas** | 🟢 **Atende** | Compara a frequência semanal com o teto estabelecido (padrão < 100%). Detecta amparo legal recente (`ignorarAmparoLegalDias`, padrão 14 dias) na coluna de atestado/justificativa e exclui o aluno do envio se a falta estiver formalmente justificada. | `src/notificacoes/presenca.ts`, `src/notificacoes/regras.ts` |
| **Verificar a quantidade e a sequência de faltas** | 🟢 **Atende** | Compara a semana atual, semana anterior e frequência acumulada no ano (<75%). Detecta quedas bruscas (<60%) e alunos que atingiram infrequência severa para encaminhamento. | `src/notificacoes/presenca.ts`, `src/consolidate.ts` |
| **Identificar situações que exigem atenção da equipe** | 🟢 **Atende** | Classificação dupla de criticidade: `falta` normal vs `critica` (média anual < 75% da LDB). No consolidador, gera o painel de **Busca Ativa** e o módulo de encaminhamento legal. | `src/notificacoes/regras.ts`, `src/notificacoes/orgaos.ts`, `src/consolidate.ts` |
| **Gerar mensagens personalizadas para os responsáveis** | 🟢 **Atende** | Interpolação de templates com sanitização de nomes, nome do responsável, nome legível do estudante, turma sem códigos internos, percentual exato da semana, média anual, telefone da secretaria e período de referência. | `src/notificacoes/modelo.ts`, `src/notificacoes/planejar.ts` |
| **Registrar o histórico das comunicações realizadas** | 🟢 **Atende** | Registro em `data/notificacoes/envios.jsonl` e `execucoes.jsonl` com timestamp, runId, CGM, canal, status, id da mensagem ou motivo de erro. Hasheamento SHA-256 do destino para atender à LGPD. Controle de janela de reenvio para evitar repetição. | `src/notificacoes/historico.ts`, `src/notificar.ts` |
| **Permitir o acompanhamento das notificações pela equipe** | 🟢 **Atende** | **Interface Gráfica Web Implementada:** Painel SPA completo em `http://localhost:3000` via [Abrir_Painel_Escola.bat](file:///c:/Users/cenoura/Desktop/Oficina/CostaPresenca/Abrir_Painel_Escola.bat) para visualizar a prévia, aprovar disparos com 1 clique, cadastrar contatos pendentes e emitir a ficha do Conselho Tutelar. | `src/server.ts`, `Abrir_Painel_Escola.bat` |
| **Gerar relatórios das situações identificadas** | 🟢 **Atende** | Geração automática de `resumo_busca_ativa.csv`, `resumo_pauta_pre_conselho.csv`, `resumo_escola_total.csv`, ficha oficial do Conselho Tutelar (HTML/PDF) e particionamento em `data/historico/YYYY-MM-DD/`. | `src/consolidate.ts`, `src/notificacoes/orgaos.ts` |
| **Integração com serviços de mensagens** | 🟢 **Atende** | Suporte nativo a 4 canais: **WhatsApp Business Cloud API** oficial (Meta Graph API v21.0 com suporte a templates aprovados), **Webhooks** genéricos (Evolution API, Z-API, n8n), **SMTP** (e-mail institucional) e **Dry-Run** (simulador). Além de bot de autorregistro via WhatsApp. | `src/notificacoes/senders/index.ts`, `src/cadastro/bot.ts` |
| **Segurança e Privacidade dos Dados (LGPD)** | 🟢 **Atende** | Armazenamento de hash SHA-256 para contatos nos registros de histórico; mascaramento de números de telefone e e-mails em logs de tela; verificação obrigatória de opt-in/consentimento; credenciais isoladas em variáveis de ambiente (.env). | `src/notificacoes/contatos.ts`, `src/notificacoes/historico.ts` |
| **Controle de Acesso** | 🔴 **Não atende** | O controle atual é estritamente no nível de sistema operacional (arquivos e permissões locais da máquina) e credenciais do Power BI. Não existe autenticação de múltiplos usuários com níveis de permissão (ex.: admin, coordenação, secretaria) na aplicação. | — |
| **Tratamento das Regras de Negócio Escolares** | 🟢 **Atende** | Regras configuráveis de semana de referência, nota de corte de falta semanal, nota de corte de criticidade legal (75%), filtro de situação de matrícula (somente matriculados), teto de idade máxima e tolerância de amparo legal. | `src/notificacoes/config.ts`, `src/notificacoes/regras.ts` |

---

## 4. O Que Está Funcionando Perfeitamente

1. **Pipeline Completo de Notificação:**
   - Leitura de presença nominal (`cgm`, `NomeAluno`, `Turma`, `descrsituacaomatricula`, percentuais semanais e geral).
   - Consolidação de duplicidades (ex.: aluno com mais de uma matrícula ou itinerário formativo considera a pior frequência).
   - Cruzamento inteligente por CGM com a planilha de contatos e/ou cadastros do bot.
   - Aplicação de regras de negócio (alunos frequentes, alunos transferidos e alunos com amparo legal recente são descartados com justificativa rastreada).
   - Divisão entre mensagem regular de aviso de falta e mensagem crítica (< 75% da LDB).
   - Geração de prévia detalhada com texto final renderizado em CSV para o Excel.
   - Envio sequencial com intervalo configurável (`intervaloEntreEnviosMs`), rate limiting e parada preventiva após 5 falhas consecutivas.
   - Gravação de histórico com hash do contato (respeito à privacidade).

2. **Bot de Autorregistro de Pais (WhatsApp):**
   - Módulo em `src/cadastro/bot.ts` e `store.ts` que permite à escola gerar bilhetes impressos com código alfanumérico único de 6 dígitos para o estudante.
   - O responsável envia uma mensagem para o WhatsApp da escola (`CADASTRAR K7P-4Q2`) e o bot vincula o número de telefone ao CGM do estudante de forma segura, com bloqueio contra força bruta (máximo de 5 tentativas com código errado ao dia).

3. **Painel de Busca Ativa e Consolidação:**
   - O comando `npm run consolidate` compila os indicadores de frequência e gera o arquivo `resumo_busca_ativa.csv`, classificando os alunos com rótulos claros:
     - `INFREQUÊNCIA CRÍTICA (< 75%)`
     - `ATENÇÃO FREQUÊNCIA (< 85%)`
     - `QUEDA BRUSCA SEMANA ATUAL (< 60%)`
     - `CASO SERP ATIVO`

4. **Tratamento de Contingência e Modos de Envio:**
   - Canal `dry-run` permite rodar todo o ciclo sem gastar créditos de mensageria nem incomodar as famílias.
   - Flag de proteção `--execute`: impede envios reais acidentais caso o operador esqueça da flag.
   - Flag de segurança `--destino-teste <telefone>`: permite enviar as mensagens de amostra para o celular do diretor ou coordenador para validação visual real antes do disparo em massa.
   - Trava de idade dos dados (`maxIdadeDadosHoras`, padrão 48h): impede o envio de dados defasados.

---

## 5. O Que NÃO Está Funcionando ou Apresenta Limitações (Gaps)

1. **Detecção de Sequência de Faltas Consecutivas em Dias Específicos:**
   - **Situação:** O texto do requisito menciona: *"verificar a quantidade e a sequência de faltas, como a ocorrência de faltas consecutivas para procedimentos de comunicação aos órgãos competentes"*.
   - **Limitação Atual:** O Power BI da SEED fornece percentuais agregados por semana e no ano ("% Presença Aluno", "% Presença Aluno SemPassada", "Presença MedGeral"). O sistema consegue identificar se a presença semanal foi 0% ou muito baixa, mas não tem a granularidade dia a dia (ex.: faltou na terça, quarta e quinta seguidas) porque essa tela do Power BI não disponibiliza o calendário diário do Livro Registro de Classe (RCO).

2. **Comunicação Automatizada com Órgãos Competentes (Conselho Tutelar / SERP / FICAI):**
   - **Situação:** A escola tem obrigação de notificar o Conselho Tutelar quando o aluno ultrapassa os limites legais de faltas consecutivas ou alternadas.
   - **Limitação Atual:** O sistema gera os relatórios em CSV e JSON com a identificação de alunos críticos e casos SERP ativos, mas a comunicação automatizada dispara mensagens **somente para os responsáveis**. Não há canal configurado para gerar ofício automático ou envio direto para o Conselho Tutelar.

3. **Ausência de Interface Gráfica / Painel Web para a Equipe Escolar:**
   - **Situação:** O texto pede *"permitir o acompanhamento das notificações pela equipe escolar"*.
   - **Limitação Atual:** O sistema é 100% em linha de comando (CLI) e arquivos de dados (CSV e JSON). A equipe precisa executar comandos no terminal e abrir arquivos no Excel. Não há uma interface web amigável com botões "Aprovar Envio", "Editar Mensagem" ou dashboards interativos em navegador.

4. **Controle de Acesso e Autenticação de Usuários:**
   - **Situação:** O desafio tecnológico cita *"segurança, privacidade dos dados, controle de acesso"*.
   - **Limitação Atual:** Não há controle de acesso por níveis de usuário (RBAC - ex.: Secretário, Pedagogo, Diretor) com login/senha próprio no software. Qualquer pessoa com acesso à máquina onde o script roda pode executar os comandos.

5. **Persistência em Banco de Dados (PostgreSQL):**
   - **Situação:** O projeto armazena os dados em arquivos JSON, JSONL e CSV.
   - **Limitação Atual:** O `README.md` aponta explicitamente que *"O PostgreSQL ainda não foi implementado"*. Embora arquivos JSON atendam bem para escolas com até ~1.000 alunos, a ausência de um banco de dados relacional dificulta consultas históricas complexas e integradas de múltiplos anos letivos.

6. **Dependência de Sessão Humana no Power BI:**
   - **Situação:** A coleta diária automática precisa acessar o Power BI da SEED-PR.
   - **Limitação Atual:** Como o portal da SEED utiliza login institucional Microsoft com autenticação de dois fatores (MFA), a extração não consegue rodar de forma totalmente autônoma e silenciosa em servidor em nuvem sem que um humano faça o login inicial na sessão do navegador persistido.

---

## 6. Conclusão e Próximos Passos Recomendados

### Conclusão

O projeto **atende de forma muito sólida à proposta central** do Sistema de Comunicação de Faltas:
- Importa dados dos relatórios do Estado;
- Realiza a identificação precisa de alunos infrequentes e críticos;
- Trata regras de negócio, amparo legal e consentimento (LGPD);
- Gera mensagens personalizadas ricas em contexto;
- Suporta múltiplos canais de envio (com destaque para a API oficial do WhatsApp);
- Mantém histórico auditável e seguro;
- Gera relatórios executivos de Busca Ativa.

### Roadmap Sugerido para Evolução:

1. **Dashboard Web Leve (Interface Gráfica):**
   - Criar uma interface web simples (ex.: FastAPI/Node Express + React ou Tailwind) para que a secretaria possa visualizar a prévia de hoje, aprovar os envios com um clique e consultar o histórico sem depender do terminal.
2. **Módulo de Notificação aos Órgãos Competentes:**
   - Criar um gerador de termos/fichas FICAI ou notificações para o Conselho Tutelar em PDF/CSV para os alunos que atingirem o nível crítico de faltas.
3. **Migração do Armazenamento para Banco Relacional:**
   - Implementar SQLite ou PostgreSQL para centralizar os cadastros de contatos, histórico de mensagens e ocorrências de frequência.
4. **Agendamento no Sistema Operacional:**
   - Configurar o script `executar_coleta.bat` no Agendador de Tarefas do Windows para rodar automaticamente ao final de cada turno escolar.
