// Helpers pequenos, sem dependência externa (Cloudflare Workers não usa Node.js puro).

export function uuid() {
  return crypto.randomUUID();
}

export function agoraISO() {
  return new Date().toISOString();
}

// Sem isso, o navegador bloqueia toda chamada do app (vickz.com.br) pro Worker (outro
// domínio) — CORS não é opcional aqui, é pré-requisito pra qualquer coisa funcionar.
// "*" é seguro neste caso porque a API usa Bearer token (não cookie de sessão), então
// não há CSRF a proteger por origem.
export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export function json(dados, status = 200, headersExtra = {}) {
  return new Response(JSON.stringify(dados), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS, ...headersExtra },
  });
}

export function erro(mensagem, status = 400) {
  return json({ erro: mensagem }, status);
}

// HMAC-SHA256 em base64url — usado pra assinar token de sessão e validar webhook da Stripe.
async function chaveHmac(segredo) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(segredo),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export async function assinar(payload, segredo) {
  const chave = await chaveHmac(segredo);
  const assinatura = await crypto.subtle.sign("HMAC", chave, new TextEncoder().encode(payload));
  return base64url(new Uint8Array(assinatura));
}

export async function verificarAssinatura(payload, assinaturaBase64url, segredo) {
  const chave = await chaveHmac(segredo);
  const bytesAssinatura = base64urlParaBytes(assinaturaBase64url);
  return crypto.subtle.verify("HMAC", chave, bytesAssinatura, new TextEncoder().encode(payload));
}

function base64url(bytes) {
  let binario = "";
  for (const b of bytes) binario += String.fromCharCode(b);
  return btoa(binario).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlParaBytes(str) {
  const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const binario = atob(base64);
  const bytes = new Uint8Array(binario.length);
  for (let i = 0; i < binario.length; i++) bytes[i] = binario.charCodeAt(i);
  return bytes;
}

// crypto.getRandomValues, não Math.random — este código autentica login, precisa ser
// imprevisível de verdade, não só "parece aleatório".
export function codigoNumerico(digitos = 6) {
  const max = 10 ** digitos;
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  const n = bytes[0] % max;
  return String(n).padStart(digitos, "0");
}
