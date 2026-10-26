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

// Verificação da assinatura do webhook (Stripe-Signature: t=...,v1=...[,v1=...]).
// - Rejeita evento com timestamp fora da janela de tolerância (contra replay).
// - Compara via crypto.subtle.verify (tempo constante).
// - Header malformado => false (o chamador responde 400). Secret ausente => erro de
//   configuração (500 com mensagem clara), nunca um "falso válido".
const TOLERANCIA_WEBHOOK_SEGUNDOS = 300;

function hexParaBytes(hex) {
  if (typeof hex !== "string" || hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

export async function verificarAssinaturaWebhook(corpoTexto, headerAssinatura, segredo, agoraSegundos = Math.floor(Date.now() / 1000)) {
  if (!segredo) throw new Error("STRIPE_WEBHOOK_SECRET não configurado neste ambiente");
  if (!headerAssinatura) return false;

  let t = null;
  const assinaturas = [];
  for (const parte of headerAssinatura.split(",")) {
    const i = parte.indexOf("=");
    if (i < 0) continue;
    const k = parte.slice(0, i).trim();
    const v = parte.slice(i + 1).trim();
    if (k === "t") t = v;
    else if (k === "v1") assinaturas.push(v);
  }
  if (!t || !/^\d+$/.test(t) || assinaturas.length === 0) return false;
  if (Math.abs(agoraSegundos - Number(t)) > TOLERANCIA_WEBHOOK_SEGUNDOS) return false;

  const chave = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(segredo),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const dados = new TextEncoder().encode(`${t}.${corpoTexto}`);
  // A Stripe pode mandar mais de um v1 durante a rotação do segredo: basta um bater.
  for (const hex of assinaturas) {
    const bytes = hexParaBytes(hex);
    if (!bytes) continue;
    if (await crypto.subtle.verify("HMAC", chave, bytes, dados)) return true;
  }
  return false;
}
