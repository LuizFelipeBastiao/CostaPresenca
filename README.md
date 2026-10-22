# Coletor do BI Escolar

MVP auditável para coletar tabelas que um usuário autorizado consegue visualizar no Power BI. O coletor usa a própria interface **Mostrar como uma tabela** e não captura cookies, tokens ou senhas.

## Limites de segurança

- Funciona apenas nos hosts declarados em `allowedHosts`.
- Cada relatório e visual precisa ser habilitado explicitamente.
- A coleta exige a flag `--execute`.
- Os cliques usam texto e estrutura acessível; não escolhem itens por posição.
- `Incluir`, `Excluir`, `Remover` e `Publicar na Web` são ações proibidas.
- Não tenta resolver CAPTCHA, MFA ou bloqueios de acesso.
- Dados, perfil do navegador e diagnósticos ficam fora do Git.
- Use somente dados e contas formalmente autorizados pela instituição.

## Preparação

```powershell
npm install
npx playwright install chromium
Copy-Item config/reports.example.json config/local.json
```

Edite `config/local.json` com a URL autorizada, o nome exato do relatório e o título exato do visual. Mantenha `enabled: false` durante a inspeção.

## Login humano

```powershell
npm run login -- --config config/local.json
```

O navegador ficará aberto para o usuário concluir login e MFA. A aplicação não solicita nem armazena a senha.

## Inspeção sem coleta

```powershell
npm run inspect -- --config config/local.json --report presente-estadual
```

## Coleta autorizada

Depois de validar a configuração e alterar `enabled` para `true`:

```powershell
npm run collect -- --config config/local.json --report presente-estadual --execute
```

As saídas ficam em `data/<relatorio>/` nos formatos CSV UTF-8 e JSON. `data/audit.jsonl` registra somente metadados operacionais, contagens e hash SHA-256.

## Notificações aos responsáveis

Lê o CSV nominal de presença (`data/presente-alunos/presente-alunos-latest.csv`), cruza pelo **CGM** com a planilha de contatos e avisa os responsáveis de quem faltou na semana.

### 1. Configuração

```powershell
Copy-Item config/notificacoes.example.json config/notificacoes.json
Copy-Item .env.example .env
```

Em `config/notificacoes.json`, ajuste `escola.nome` e `escola.telefoneContato`. O canal começa como `dry-run`, que não envia nada.

### 2. Contatos dos responsáveis

O CSV de presença não traz telefones. Os contatos ficam em `data/cadastros/contatos_responsaveis.csv` (`;` ou `,`):

| cgm | responsavel | telefone | email | consentimento |
|-----|-------------|----------|-------|---------------|
| 123456789 | Maria Lima | (45) 99999-1111 | | sim |

- Pode haver várias linhas por CGM (pai e mãe) ou vários telefones na mesma célula separados por `/`.
- Só recebe mensagem quem tiver `consentimento = sim` (desligável com `exigirConsentimento: false`, mas mantenha ligado se não houver outra base legal formal).
- Para gerar a lista dos alunos que ainda estão sem contato: `npm run notificar:contatos`. O arquivo sai em `data/cadastros/contatos_pendentes.csv`.

### 3. Prévia (sempre rode antes)

```powershell
npm run notificar
```

Mostra o resumo e grava `data/notificacoes/previa-latest.csv` com cada aluno, o status e o texto exato da mensagem. Os status possíveis são:

- `pronto`: a mensagem será enviada.
- `ja-notificado`: o aviso já saiu nesta semana.
- `sem-contato`, `sem-consentimento` ou `sem-destino-no-canal`: falta completar o cadastro.

### 4. Envio

```powershell
# teste: manda até 3 mensagens reais apenas para o seu número
npm run notificar -- --execute --destino-teste 45999998888

# envio real
npm run notificar -- --execute
```

### Regras (`regras` na configuração)

| Opção | Padrão | Efeito |
|-------|--------|--------|
| `semanaReferencia` | `atual` | `atual` usa "(%) Presença Aluno"; `anterior` usa a semana passada fechada |
| `presencaSemanaAbaixoDe` | `100` | Avisa quem teve presença semanal abaixo disso (100 = qualquer falta) |
| `presencaGeralCriticaAbaixoDe` | `75` | Abaixo disso usa o modelo de mensagem **crítica** |
| `ignorarAmparoLegalDias` | `14` | Não avisa quem tem Amparo Legal recente (falta justificada) |
| `somenteMatriculados` | `true` | Ignora transferidos/desistentes |
| `idadeMaxima` | — | Ex.: `17` para avisar só responsáveis de menores |

Os textos ficam em `modelos.falta` e `modelos.critica`. As variáveis aceitas são:

`{responsavel}` `{aluno}` `{primeiroNome}` `{turma}` `{escola}` `{telefoneEscola}` `{presencaSemana}` `{presencaSemanaAnterior}` `{presencaGeral}` `{dataReferencia}`

### Canais

| `canal` | Destino | Segredos no `.env` |
|---------|---------|--------------------|
| `dry-run` | — | — |
| `whatsapp-cloud` | telefone | `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_TOKEN` |
| `smtp` | e-mail | `SMTP_USER`, `SMTP_PASS` + seção `smtp` |
| `webhook` | telefone ou e-mail | `WEBHOOK_TOKEN` (opcional) + seção `webhook` |

**WhatsApp Cloud (Meta):** mensagens iniciadas pela escola exigem um *template* aprovado pela Meta. Configure `whatsappCloud.template` com `nome`, `idioma` e a lista `parametros`, que são as variáveis acima na ordem do template. Sem template, a API só entrega texto livre para quem falou com a escola nas últimas 24h.

**Webhook:** faz um POST JSON `{destino, assunto, mensagem, tipo, cgm}` para qualquer gateway (Z-API, Evolution API, n8n, SMS etc.).

### Proteções

- **Sem `--execute`, nada é enviado.**
- Recusa envio real se o CSV de presença tiver mais de `maxIdadeDadosHoras` (padrão 48h), para não avisar faltas antigas.
- Não repete aviso para o mesmo aluno e destino na mesma semana nem dentro de `janelaReenvioDias`.
- Falhas não contam como enviadas e são tentadas de novo na próxima execução.
- Para depois de 5 falhas seguidas, por exemplo com token expirado.
- Respeita `maxEnviosPorExecucao` e `intervaloEntreEnviosMs`. Os casos críticos saem primeiro.
- `data/notificacoes/envios.jsonl` guarda só o **hash** do telefone/e-mail, nunca o número.
- Logs no console mascaram os telefones (`+55 45 9****-1111`).

## Estado atual

Implementados:

- Coleta de vários relatórios (`collect:all`), com filtros e leitura das consultas do Power BI.
- Extração nominal de presença (`collect:presente-alunos`) e pré-conselho.
- Consolidação (`consolidate`).
- Notificação aos responsáveis (`notificar`).

O PostgreSQL ainda não foi implementado.
