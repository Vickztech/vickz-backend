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

// Cada plano tem 2 Price IDs na Stripe: mensal e anual (2 meses grátis, ver Seção 7 do
// escopo — a franquia anual de laudos é a mesma nos dois casos, só muda o ciclo de cobrança).
const PRICE_POR_PLANO = (env) => ({
  start: { mensal: env.STRIPE_PRICE_START, anual: env.STRIPE_PRICE_START_ANUAL },
  pro: { mensal: env.STRIPE_PRICE_PRO, anual: env.STRIPE_PRICE_PRO_ANUAL },
  expert: { mensal: env.STRIPE_PRICE_EXPERT, anual: env.STRIPE_PRICE_EXPERT_ANUAL },
});

export async function criarCheckoutAssinatura(env, profissional, plano, intervalo = "mensal") {
  if (!["mensal", "anual"].includes(intervalo)) throw new Error(`Intervalo desconhecido: ${intervalo}`);
  const priceId = PRICE_POR_PLANO(env)[plano]?.[intervalo];
  if (!priceId) throw new Error(`Plano/intervalo desconhecido: ${plano}/${intervalo}`);

  return chamarStripe(env, "checkout/sessions", {
    mode: "subscription",
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": "1",
    customer_email: profissional.email,
    "metadata[profissional_id]": profissional.id,
    "metadata[plano]": plano,
    "metadata[intervalo]": intervalo,
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
