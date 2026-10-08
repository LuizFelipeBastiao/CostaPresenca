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
