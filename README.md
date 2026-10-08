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

## Estado atual

Este incremento implementa o coletor de uma única tabela. Filtros do Power BI, PostgreSQL, agendamento e regras de frequência serão adicionados depois que o primeiro visual for validado com dados anonimizados ou autorizados.

## Aviso de faltas aos responsáveis

`npm run notificar` compara as duas coletas mais recentes de `data/historico/<data>/presente-alunos.csv` e envia uma mensagem aos responsáveis dos alunos que tiveram falta registrada entre elas.

### Como a falta é detectada

O CSV nominal não tem uma coluna "faltou hoje", então a falta é inferida comparando a coleta atual com a anterior, por aluno (CGM):

1. **Contagem de faltas** (`Faltas`, ou `Σ Aulas − Σ Presenças`) aumentou, quando o relatório trouxer essas colunas;
2. senão, o **% de presença geral** (`(%) Presença Aluno MedGeral`) caiu;
3. senão, o **% de presença da semana** (`(%) Presença Aluno`) caiu, somente se as duas coletas forem da mesma semana.

Alunos novos (sem coleta anterior) são ignorados. Se as coletas estiverem a mais de `maxDiasEntreColetas` dias de distância, nada é enviado, para evitar avisos atrasados.

### Preparação

```powershell
Copy-Item config/notificacoes.example.json config/notificacoes.json
New-Item -ItemType Directory -Force data/cadastros
Copy-Item config/contatos_responsaveis.example.csv data/cadastros/contatos_responsaveis.csv
```

Preencha `data/cadastros/contatos_responsaveis.csv` (uma linha por responsável; colunas `CGM`, `Aluno`, `Responsavel`, `Telefone`, `Email`, `Autorizado`). Linhas com `Autorizado` = `não` são ignoradas. Esse arquivo fica fora do Git (pasta `data/`).

### Execução

```powershell
npm run notificar                    # simulação: nada é enviado
npm run notificar -- --enviar        # envio real pelo canal configurado
npm run notificar -- --data 2026-10-07 --anterior 2026-10-06
```

Sem `--enviar` as mensagens só são gravadas em `data/notificacoes/<data>/caixa-de-saida.jsonl` para conferência. Cada execução gera `data/notificacoes/<data>/faltas-notificadas.csv` com o status de cada aluno (`enviado`, `simulado`, `ja-enviado`, `sem-contato`, `falha`). Envios concluídos ficam em `data/notificacoes/registro-envios.jsonl` (CGM e hash do destino, sem telefone), e o mesmo responsável não recebe duas vezes o aviso da mesma coleta.

### Canais (`canal` em `config/notificacoes.json`)

- `{ "tipo": "simulacao" }`: padrão, não envia nada.
- `{ "tipo": "webhook", "url": "https://..." }`: faz POST JSON (`telefone`, `email`, `mensagem`, `aluno`, `turma`, ...) para um gateway próprio (n8n, Evolution API, provedor de SMS). Token opcional em `NOTIFICACAO_WEBHOOK_TOKEN`.
- `{ "tipo": "whatsapp-cloud", "template": "aviso_falta" }`: WhatsApp Business Cloud API da Meta. Credenciais em `WHATSAPP_TOKEN` e `WHATSAPP_PHONE_NUMBER_ID`. Mensagens iniciadas pela escola exigem um template aprovado; o corpo recebe `parametros` (padrão: responsável, aluno, turma, data).

O texto da mensagem é editável em `mensagem`, com as variáveis `{responsavel}`, `{aluno}`, `{primeiroNome}`, `{turma}`, `{data}`, `{escola}`, `{faltas}` e `{presencaGeral}`.

`executar_coleta.bat` chama `npm run notificar -- --enviar` como último passo. Enquanto o canal for `simulacao`, nenhuma mensagem real sai.
