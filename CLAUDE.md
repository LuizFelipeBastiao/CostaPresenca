# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## O que é

CostaPresença: ferramenta local (Windows, Node ≥ 22, TypeScript rodado direto com `tsx`, sem build) para uma escola estadual do Paraná. Ela coleta relatórios do Power BI da SEED-PR, consolida indicadores, avisa responsáveis quando a frequência semanal do aluno **cai** e serve um painel web para a secretaria. Código, mensagens e identificadores são em português.

## Comandos

```bash
npm run check                                   # typecheck (tsc --noEmit); não há linter
npm test                                        # todos os testes (node:test via tsx)
node --import tsx --test tests/coleta.test.ts   # um arquivo de teste
node --import tsx --test --test-name-pattern "dataLocal" tests/coleta.test.ts   # um teste pelo nome
npm start                                       # painel web em http://localhost:3000 (PORT muda a porta)
npm run consolidate                             # lê os CSVs coletados e gera data/resumo_*.{json,csv}
npm run notificar                               # prévia dos avisos (não envia nada)
npm run cadastro -- bilhetes                     # códigos + bilhetes com QR (data/cadastros/bilhetes.html)
npm run bot -- --simular                        # receptor do webhook sem enviar respostas
```

Comandos que abrem o Edge e precisam do login institucional (`npm run login -- --config config/local.json`, com MFA feito pela pessoa): `collect:all` (exige `--execute`), `collect:presente-alunos`, `collect:pre-conselho`, `network:probe`, `inspect`. Não rode esses comandos, nem `notificar -- --execute` ou `npm run bot` sem `--simular`, sem a pessoa pedir: eles agem em sistemas reais. `CostaPresenca.bat` é o ponto de entrada do usuário final e encadeia coleta → consolidação → prévia → painel (`--painel`, `--coleta`, `--login`, `--agendar`, `--diagnostico`, `--bot`); ao abrir o painel ele também liga bot e ngrok minimizados (`:LIGAR_BOT`). A secretaria não usa terminal: `Entrar no Power BI.bat` e `Agendar atualizacao diaria.bat` são atalhos de duplo clique.

## Arquitetura

A esteira é feita de scripts independentes que conversam **só por arquivos em `data/`**:

1. **Coleta** (`src/cli.ts`, `src/extract-*.ts`, `src/powerbi/`): Playwright com perfil persistente do Edge (`.auth/powerbi-profile`, `headless: false`). A extração preferida intercepta as respostas `QueryExecutionService`/`querydata` do Power BI e decodifica o formato DSR (`dsr-decoder.ts` para tabelas; `matrix-decoder.ts` para matrizes aluno × disciplina × trimestre). Em `cli.ts`, o fallback é a área de transferência ("Mostrar como uma tabela" + "Copiar seleção") e depois o DOM virtualizado (`table-reader.ts`). Os relatórios vêm de `config/local.json` (schema zod em `src/config.ts`; `${ANO}`/`${NRE}`/`${ESCOLA}` são interpolados das variáveis de ambiente). Os extratores dedicados buscam relatórios por id fixo: `presente-estadual` e `aprendizagem-parana`.
2. **Gravação** (`src/storage.ts` e os próprios extratores): cada coleta grava um arquivo com timestamp, uma cópia em `data/historico/AAAA-MM-DD/` (data **local**, via `src/datas.ts`) e um ponteiro `<nome>-latest.csv`, que é o que os consumidores leem. `data/audit.jsonl` registra cada execução com hash SHA-256.
3. **Consolidação** (`src/consolidate.ts`): junta os `-latest` em `resumo_escola_total`, Pré-Conselho e Busca Ativa. Também espelha os resultados numa pasta irmã `DATA_HUB/data` fora do repositório, se ela existir. O servidor importa `consolidateMetrics`; a execução automática no fim do arquivo é protegida para rodar só quando o script é chamado direto. Mantenha esse padrão em qualquer script que também seja importado.
4. **Notificações** (`src/notificacoes/`): `presenca.ts` lê o CSV nominal (chave = **CGM**); `fontes.ts` junta os contatos (planilha CSV e/ou `CadastroStore` do bot); `regras.ts` decide quem avisar (queda semanal, amparo legal, matrícula, mensagem crítica < 75%); `planejar.ts` é a função pura que monta o plano; `senders/` implementa os canais `dry-run` (padrão), `whatsapp-cloud`, `webhook` e `smtp`; `historico.ts` evita reenvio e guarda só o hash do destino. A configuração fica em `config/notificacoes.json` + `.env` (`notificacoes/config.ts`).
5. **Painel** (`src/server.ts`): `node:http` puro, sem framework. As rotas `/api/*` e todo o HTML/JS do painel estão inline nesse arquivo. A aba Bilhetes usa `gerarBilhetes`/`resumoCadastros` de `cadastro/cli.ts` (rotas `/api/cadastro/resumo` e `/bilhetes`). Ele repete o fluxo de prévia e disparo de `src/notificar.ts`: uma mudança de regra ou de envio normalmente precisa ser feita nos dois.

6. **Bot de cadastro** (`src/bot-whatsapp.ts` + `src/cadastro/`): processo separado do painel, na porta `cadastro.porta` (3001), que escuta só em 127.0.0.1 e expõe apenas `/webhook` e `/saude`; é essa porta que vai para o túnel (ngrok/cloudflared). `webhook.ts` tem as partes puras (assinatura `X-Hub-Signature-256` com o App Secret, handshake do GET, extração das mensagens, deduplicação por id). `bot.ts` (`processarMensagem`) decide a resposta e grava em `CadastroStore` (`data/cadastros/cadastros.json`, com o telefone = `wa_id`). As respostas saem por `enviarTextoWhatsApp`. `cadastro/cli.ts` (`npm run cadastro`) gera os códigos e o `bilhetes.html` com QR (pacote `qrcode`, importado sob demanda) e aprova os pendentes. Os avisos só incluem esses pais quando `fonteContatos` é `cadastros` ou `ambos`.

## Convenções e armadilhas

- ESM com `module: NodeNext`: imports relativos usam a extensão `.js`, mesmo apontando para `.ts`.
- O tsconfig liga `noUncheckedIndexedAccess` e `exactOptionalPropertyTypes`: acesso a array devolve `T | undefined`, e propriedade opcional que pode receber `undefined` precisa declarar `?: T | undefined`.
- Segurança da coleta (`src/safety.ts`): só HTTPS em `allowedHosts`; itens de menu como "Excluir" e "Publicar na Web" são proibidos; cair no login da Microsoft gera `SessaoExpiradaError`. A coleta nunca preenche credenciais.
- Escopo da escola: `unlockBookmarkAndScope` (`powerbi/filters.ts`) aplica NRE + `context.escolaNome` e falha se o filtro ESCOLA não ficar só com a escola. `filtrarPelaEscola` ainda remove linhas de outras escolas. Não afrouxe isso: dado de outra escola salvo como desta é pior que uma coleta que falha.
- Datas: pastas de histórico usam `dataLocal()`; a semana de referência das notificações (`regras.ts`) é calculada em UTC (segunda 00:00).
- Dados pessoais de alunos e responsáveis (nomes, CGM, telefones) ficam em `data/`, `.auth/`, `.env`, `config/local.json` e `config/notificacoes.json`, todos fora do Git. Logs mascaram contatos (`mascararTelefone`/`mascararEmail`); mantenha isso em logs novos.
- Alguns testes (`dsr-decoder`, `matrix-decoder`) leem capturas reais em `data/` ou `artifacts/` e **passam sem checar nada** quando o arquivo não existe.
