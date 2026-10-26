// Cliente HTTP pro vickz-pdf-service (Python, roda fora do Worker — ver README desse
// serviço pra motivo e onde hospedar). Faz uma coisa: manda o PDF bruto, recebe de volta
// a versão rasterizada + com QR + com permissão restrita + o hash SHA-256.

export async function blindarPdf(env, { pdfBase64, artBase64, textoRodape, urlVerificacao }) {
  if (!env.PDF_SERVICE_URL || !env.PDF_SERVICE_KEY) {
    throw new Error("Serviço de PDF (blindagem) não configurado neste ambiente");
  }
  const resp = await fetch(`${env.PDF_SERVICE_URL}/processar`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Chave vai no header, não na query string — query string vaza em logs de
      // acesso/CDN/proxy. Header de autenticação não fica logado por padrão.
      Authorization: `Bearer ${env.PDF_SERVICE_KEY}`,
    },
    body: JSON.stringify({
      pdf_base64: pdfBase64,
      art_base64: artBase64 || null, // PDF da ART a ser anexado ao final do laudo, se houver
      texto_rodape: textoRodape,
      url_verificacao: urlVerificacao,
    }),
  });
  if (!resp.ok) {
    throw new Error(`vickz-pdf-service falhou (${resp.status}): ${await resp.text()}`);
  }
  return resp.json(); // { pdf_base64, hash_sha256 }
}
