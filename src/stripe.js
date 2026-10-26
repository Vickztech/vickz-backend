// Chamadas REST direto na API da Stripe (sem SDK — o SDK oficial de Node não roda bem
// no runtime do Cloudflare Workers). Precisa dos secrets STRIPE_SECRET_KEY e
// STRIPE_WEBHOOK_SECRET, e dos Price IDs de cada plano (ver wrangler.toml).

const STRIPE_API = "https://api.stripe.com/v1";

function corpoFormUrlEncoded(obj) {
  const params = new URLSearchParams();
  for (const [chave, valor] of Object.entries(obj)) params.append(chave, valor);
  return params.toString();
}

async function chamarStripe(env, caminho, corpo) {
  const resp = await fetch(`${STRIPE_API}/${caminho}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: corpoFormUrlEncoded(corpo),
  });
  const dados = await resp.json();
  if (!resp.ok) throw new Error(`Stripe erro: ${JSON.stringify(dados)}`);
  return dados;
}

// Lançamento: só cobrança MENSAL. A franquia anual é liberada por fatura paga (ver
// liberadoNoCiclo em entitlement.js). Planos anuais ficam fora até decisão de preço.
const PRICE_POR_PLANO = (env) => ({
  start: env.STRIPE_PRICE_START,
  pro: env.STRIPE_PRICE_PRO,
  expert: env.STRIPE_PRICE_EXPERT,
});

export async function criarCheckoutAssinatura(env, profissional, plano) {
  const priceId = PRICE_POR_PLANO(env)[plano];
  if (!priceId) throw new Error(`Plano desconhecido: ${plano}`);

  return chamarStripe(env, "checkout/sessions", {
    mode: "subscription",
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": "1",
    customer_email: profissional.email,
    "metadata[profissional_id]": profissional.id,
    "metadata[plano]": plano,
    "metadata[intervalo]": "mensal",
    // index.html é uma SPA de arquivo único, sem rotas de servidor (ver Seção 12, Módulo 5 do
    // escopo — gap identificado e corrigido aqui). Em vez de um path que não existe, o retorno
    // da Stripe usa query params na própria raiz; o boot() do app lê isso e mostra o resultado.
    success_url: `${env.APP_BASE_URL}/?checkout=sucesso&tipo=assinatura`,
    cancel_url: `${env.APP_BASE_URL}/?checkout=cancelado&tipo=assinatura`,
  });
}

export async function criarCheckoutAvulso(env, profissional) {
  return chamarStripe(env, "checkout/sessions", {
    mode: "payment",
    "line_items[0][price]": env.STRIPE_PRICE_AVULSO,
    "line_items[0][quantity]": "1",
    customer_email: profissional.email,
    "metadata[profissional_id]": profissional.id,
    "metadata[tipo]": "avulso",
    success_url: `${env.APP_BASE_URL}/?checkout=sucesso&tipo=avulso`,
    cancel_url: `${env.APP_BASE_URL}/?checkout=cancelado&tipo=avulso`,
  });
}

// Verificação manual da assinatura do webhook (Stripe-Signature: t=...,v1=...)
export async function verificarAssinaturaWebhook(corpoTexto, headerAssinatura, segredo) {
  const partes = Object.fromEntries(
    headerAssinatura.split(",").map((p) => p.split("="))
  );
  const payload = `${partes.t}.${corpoTexto}`;
  const chave = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(segredo),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const assinaturaCalculada = await crypto.subtle.sign("HMAC", chave, new TextEncoder().encode(payload));
  const hex = [...new Uint8Array(assinaturaCalculada)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex === partes.v1;
}
