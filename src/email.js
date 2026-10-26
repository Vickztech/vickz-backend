// Envio de e-mail via Resend (troque por outro provedor se preferir — é só este arquivo).
// Precisa do secret RESEND_API_KEY (wrangler secret put RESEND_API_KEY).

export async function enviarEmail(env, { para, assunto, texto, anexoPdfBase64, nomeAnexo }) {
  if (!env.RESEND_API_KEY) {
    console.warn("RESEND_API_KEY não configurada — e-mail não enviado (modo dev):", { para, assunto });
    return { ok: false, motivo: "sem chave de e-mail configurada" };
  }

  const corpo = {
    from: "VICKZ <contato@notificacoes.vickz.com.br>",
    to: [para],
    subject: assunto,
    text: texto,
  };
  if (anexoPdfBase64) {
    corpo.attachments = [{ filename: nomeAnexo || "laudo-vickz.pdf", content: anexoPdfBase64 }];
  }

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(corpo),
  });

  if (!resp.ok) {
    const detalhe = await resp.text();
    console.error("Falha ao enviar e-mail:", resp.status, detalhe);
    return { ok: false, motivo: detalhe };
  }
  return { ok: true };
}
