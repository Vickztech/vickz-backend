# VICKZ — backend (esqueleto, ainda não testado com credenciais reais)

Implementa a Seção 7 do escopo (`claude/escopo-estabilizacao-vickz.md`): contas, verificação de
assinatura/crédito avulso, checkout Stripe, webhook, entrega do laudo por e-mail.

**Atualização:** a blindagem do PDF (rasterização + marca d'água + QR de verificação + permissão
de PDF + hash) está implementada em `../vickz-pdf-service` (Python, testado de ponta a ponta,
inclusive provando empiricamente que a restrição de permissão é removível com `qpdf --decrypt`
sem senha — isso está documentado, não escondido). `/laudos/entregar` chama esse serviço antes de
mandar o e-mail. `/verificar/<laudo_id>` é a rota pública que confere o hash.

**Atualização (01/10/2026):** corrigidos 4 problemas bloqueantes encontrados em revisão:
CORS (sem isso o app não conseguia nem chamar a API de outro domínio), rate limiting no
login por código (sem isso o código de 6 dígitos era forçável por script), condição de
corrida no entitlement (duplo-clique podia conceder 2 grátis/avulsos em vez de 1 — agora
resolvido com escritas condicionais atômicas no D1, não checagem em duas etapas), e a
chave do `vickz-pdf-service` que ia na query string (agora vai no header `Authorization`).

**Atualização (01/10/2026) — ART obrigatória:** o app agora exige upload de uma ART/RRT
por empreendimento (cobre todos os vizinhos vistoriados ali, não uma por laudo) antes de
liberar qualquer laudo daquele empreendimento. **A VICKZ não confere a autenticidade da
ART** — isso é responsabilidade do profissional, que precisa aceitar isso explicitamente
no upload (`POST /art/upload`, campo `aceite_responsabilidade`). Pedido formal de API de
consulta será feito ao CONFEA e ao CAU, mas nenhum dos dois tem isso hoje (verificado em
01/10/2026 — ambos só oferecem consulta manual via site, não API). Enquanto isso não
existir, a conferência de legitimidade é humana, fora do sistema. Precisa do bucket R2
`vickz-arts` (ver passo 6 abaixo) pra guardar os PDFs enviados.

**Importante — o que isso NÃO faz ainda:**
- A montagem *inicial* do laudo continua no navegador (jsPDF, código já existente no
  `index.html`) — só a blindagem final é server-side. Um usuário técnico ainda pode guardar
  manualmente o PDF sem marca d'água que o próprio navegador dele montou antes do upload. Isso é
  um gap residual conhecido e aceito por ora: fecha o abuso em escala, não fecha o caso individual.
  Fechar 100% exige mover a montagem inicial pro servidor também — tarefa maior, ainda não feita.
- Não tem storage do PDF pro painel web ainda (o TODO está marcado no código — falta um bucket R2).
- Não foi implantado nem testado contra uma conta Stripe/Cloudflare real nesta sessão — revisar e
  testar em modo `sk_test_...` antes de qualquer coisa em produção.
- Login é só código de 6 dígitos por e-mail (sem senha) — mais simples de implementar com
  segurança razoável, e mantém o espírito de "login não trava" do app original.

## Estrutura
```
vickz-backend/
  wrangler.toml       # config do Cloudflare Worker + banco D1
  schema.sql          # tabelas (profissionais, assinaturas, créditos, laudos, sessões)
  src/
    index.js          # roteador principal
    auth.js           # login por código de e-mail
    entitlement.js     # a lógica de "pode gerar laudo?" — fonte única de verdade
    stripe.js          # checkout + verificação de webhook (REST direto, sem SDK)
    email.js           # envio via Resend
    util.js            # helpers (uuid, assinatura HMAC, etc.)
```

## Passo a passo pra colocar no ar

Isso não precisa de terminal pro dia a dia (GitHub Desktop continua cuidando do código), mas o
**primeiro setup** do Cloudflare exige alguns comandos, uma vez só. Se preferir, eu rodo isso com
você numa sessão dedicada.

1. **Conta Cloudflare isolada**: **já feito em 01/10/2026** — e-mail da conta migrado pra
   `vickztech@proton.me`, SecuX cadastrado como chave de segurança.
2. **Instalar a CLI da Cloudflare** (uma vez): `npm install -g wrangler` — **ou, se o
   ambiente não suportar o fluxo OAuth do `wrangler login` (ex: execução remota/headless),
   usar token de API da conta (`dash.cloudflare.com/profile/api-tokens`) direto na API REST
   da Cloudflare (`api.cloudflare.com/client/v4/...`), como foi feito em 01/10/2026.**
3. **Login**: `wrangler login` (abre o navegador, autoriza a conta Cloudflare acima) — ver
   nota do passo 2 se isso não for viável no seu ambiente.
4. **Criar o banco D1**: `wrangler d1 create vickz-db` — copiar o `database_id` que aparece e
   colar no `wrangler.toml` (linha `database_id = "PREENCHER_APOS..."`) — **já feito em
   01/10/2026**, database_id `88d8fb32-2279-41b7-b40c-d47fe02ab0aa`.
5. **Criar as tabelas**: `wrangler d1 execute vickz-db --file=schema.sql` — **já feito em
   01/10/2026**. Se o schema for alterado depois (ex: nova coluna), rodar de novo — os
   `CREATE TABLE IF NOT EXISTS` não duplicam o que já existe, mas uma coluna nova numa
   tabela já criada precisa de `ALTER TABLE`, não reexecução direta do arquivo todo.
6. **Criar o bucket R2 pra ARTs**: `wrangler r2 bucket create vickz-arts` — guarda os PDFs
   de ART enviados pelos profissionais (ver seção ART acima). Sem isso, `POST /art/upload`
   falha.
7. **Conta Stripe**: criar 4 produtos, com 7 Prices no total (Start/Pro/Expert têm Price mensal
   **e** Price anual; Avulso só tem um Price, pagamento único):
   - Start: R$289/mês (recorrente mensal) **e** R$2.890/ano (recorrente anual, = 2 meses grátis)
   - Pro: R$397/mês **e** R$3.970/ano
   - Expert: R$697/mês **e** R$6.970/ano
   - Avulso: R$690 (pagamento único, sem opção recorrente)
   Copiar os 7 Price IDs. **Preço em revisão em 01/10/2026** — discussão de elevar ticket
   médio pra ~R$500 (justificativa: ART dá responsabilidade técnica formal, comparável a
   laudo pericial tradicional de R$13k+) ainda não finalizada, valores acima são os
   últimos confirmados.
8. **Conta Resend** (ou outro provedor de e-mail transacional): criar conta, verificar o domínio
   `vickz.com.br`, copiar a API key.
10. **Publicar o vickz-pdf-service primeiro** (ver `../vickz-pdf-service/README.md`) — ele não
    roda no Cloudflare Worker, precisa de um host com Python real. Anote a URL e a chave dele.
11. **Configurar os segredos** (cada comando pede o valor e guarda criptografado, nunca vai pro
    GitHub — lista completa, incluindo 3 que faltavam aqui antes de 01/10/2026):
    ```
    wrangler secret put STRIPE_SECRET_KEY
    wrangler secret put STRIPE_WEBHOOK_SECRET
    wrangler secret put STRIPE_PRICE_START
    wrangler secret put STRIPE_PRICE_START_ANUAL
    wrangler secret put STRIPE_PRICE_PRO
    wrangler secret put STRIPE_PRICE_PRO_ANUAL
    wrangler secret put STRIPE_PRICE_EXPERT
    wrangler secret put STRIPE_PRICE_EXPERT_ANUAL
    wrangler secret put STRIPE_PRICE_AVULSO
    wrangler secret put RESEND_API_KEY
    wrangler secret put APP_BASE_URL      # https://vickz.com.br
    wrangler secret put TOKEN_SECRET      # string aleatória longa, gerar uma vez
    wrangler secret put PDF_SERVICE_URL   # URL do vickz-pdf-service, do passo 10
    wrangler secret put PDF_SERVICE_KEY   # mesma chave do VICKZ_PDF_SERVICE_KEY do serviço
    ```
12. **Publicar**: `wrangler deploy` — devolve a URL do Worker (algo como
    `vickz-backend.<sua-conta>.workers.dev`), que depois você aponta pro domínio real.
13. **Webhook da Stripe**: no painel da Stripe, criar um endpoint de webhook apontando para
    `https://<sua-url>/billing/webhook`, eventos: `checkout.session.completed`,
    `customer.subscription.deleted`, `invoice.payment_failed`. A Stripe mostra o
    `STRIPE_WEBHOOK_SECRET` na hora de criar — é o valor do passo 11.

## Onde isso mora no GitHub
Recomendo repositório **separado** do `vickz-app` (`vickz-backend`, mesma conta `Vickztech`) —
mesma lógica da Seção 3 do escopo: um repositório, um propósito, sem misturar histórico de
frontend com histórico de backend. Você revisa esta pasta, e se aprovar, cria o repositório novo
no GitHub Desktop e adiciona estes arquivos como primeiro commit.

## Próximos passos técnicos (não incluídos ainda)
- Endpoint pro app consultar `GET /me` no login e mostrar franquia restante na tela.
- Storage do PDF blindado em R2 + endpoint de listagem pro painel web (item "acessível somente
  na web") — hoje só vai por e-mail.
- Decidir se/quando mover a montagem *inicial* do laudo (não só a blindagem final) pro servidor —
  fecharia o gap residual de alguém guardar manualmente o PDF sem marca d'água antes do upload.
- Endpoint de cancelamento/portal do cliente Stripe (pra ele gerenciar a própria assinatura sem
  vocês terem que fazer manualmente).
