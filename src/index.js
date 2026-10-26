import { json, erro, agoraISO, uuid, bytesParaBase64, CORS_HEADERS } from "./util.js";
import { solicitarCodigo, verificarCodigo, autenticar } from "./auth.js";
import { avaliarEntitlement, consumirEntitlement, marcarEntregue } from "./entitlement.js";
import { criarCheckoutAssinatura, criarCheckoutAvulso, verificarAssinaturaWebhook } from "./stripe.js";
import { enviarEmail } from "./email.js";
import { blindarPdf } from "./pdfservice.js";

// Valores fechados na Seção 7 do escopo (01/10/2026) — franquia mais espaçada entre
// planos, substituindo o 6/12/24 original.
const FRANQUIA_POR_PLANO = { start: 6, pro: 12, expert: 24 };

// "Token" aqui é só apresentação pro usuário — NÃO é token de LLM/IA, e não muda o
// consumo real, que continua sendo por laudo inteiro (ver Seção 7.3 do escopo).
// Grandeza (01/10/2026): R$1,00 = TOKENS_POR_REAL tokens — puramente cosmético
// (faz o saldo parecer maior), não altera nenhuma regra de negócio.
const TOKENS_POR_REAL = 5;

// Base em reais: o valor ANUAL REAL do plano (o que o cliente de fato paga no ciclo),
// não o "preço por laudo" de marketing da Seção 7 (que usa mensalidade × 12, sem o
// desconto anual, só pra comparar com o Avulso na tela de preços). Usar o de marketing
// aqui inflaria tokens_totais_ciclo acima do que o cliente realmente pagou (ex.: Expert
// mostraria 4.860 em vez de 4.050) — bug corrigido nesta revisão, não só a mudança de
// grandeza pedida.
const PRECO_ANUAL_POR_PLANO = { start: 1788.0, pro: 2748.0, expert: 4188.0 };
const PRECO_AVULSO_REAIS = 299.0;

function resumoTokens(assinatura) {
  if (!assinatura) return null;
  const precoAnual = PRECO_ANUAL_POR_PLANO[assinatura.plano];
  if (!precoAnual) return null;
  const precoPorLaudoReais = precoAnual / assinatura.franquia_anual;
  const tokensTotais = Math.round(precoAnual * TOKENS_POR_REAL * 100) / 100;
  const tokensUsados = Math.round(assinatura.consumidos_no_ciclo * precoPorLaudoReais * TOKENS_POR_REAL * 100) / 100;
  return {
    preco_por_laudo_tokens: Math.round(precoPorLaudoReais * TOKENS_POR_REAL * 100) / 100,
    tokens_totais_ciclo: tokensTotais,
    tokens_usados_ciclo: tokensUsados,
    tokens_restantes_ciclo: Math.round((tokensTotais - tokensUsados) * 100) / 100,
    preco_avulso_tokens: Math.round(PRECO_AVULSO_REAIS * TOKENS_POR_REAL * 100) / 100,
  };
}

// Texto obrigatório: a VICKZ não confere a legitimidade da ART. Enquanto não houver
// solução formal (pedido em andamento ao CONFEA/CAU), a verificação é humana, fora
// do sistema, e a responsabilidade é do profissional. Esse texto some no app (tela de
// upload) e no rodapé do PDF final — ver Seção 1 do escopo.
const AVISO_RESPONSABILIDADE_ART =
  "A VICKZ não verifica a autenticidade, validade ou regularidade da ART/RRT anexada. " +
  "A responsabilidade pela legitimidade deste documento é exclusiva do profissional que o enviou.";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const rota = `${request.method} ${url.pathname}`;

    // Preflight do CORS — o navegador manda isso antes de qualquer POST/Authorization
    // cross-origin. Sem responder aqui, a chamada real nem chega a sair do navegador.
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      // --- autenticação (sem senha, código por e-mail) ---
      if (rota === "POST /auth/solicitar-codigo") return solicitarCodigo(request, env);
      if (rota === "POST /auth/verificar-codigo") return verificarCodigo(request, env);

      // webhook da Stripe: sem sessão nossa, autenticidade vem da assinatura HMAC (Stripe-Signature)
      if (rota === "POST /billing/webhook") return tratarWebhookStripe(request, env);

      // verificação pública: qualquer pessoa que recebeu um laudo (síndico, seguradora,
      // perito) confere aqui se o documento é o que a VICKZ realmente emitiu. Não exige
      // login — é justamente pra terceiros que não têm conta.
      if (request.method === "GET" && url.pathname.startsWith("/verificar/")) {
        return verificarLaudoPublico(request, env, url.pathname.split("/verificar/")[1]);
      }

      // tudo abaixo exige sessão válida
      const profissional = await autenticar(request, env);
      if (!profissional) return erro("Não autenticado", 401);

      if (rota === "GET /me") {
        const entitlement = await avaliarEntitlement(env, profissional.id);
        const assinatura = await env.DB.prepare(
          "SELECT * FROM assinaturas WHERE profissional_id = ? AND status = 'ativa'"
        ).bind(profissional.id).first();
        return json({ profissional, entitlement, tokens: resumoTokens(assinatura) });
      }

      if (rota === "POST /me/completar-cadastro") {
        const { nome, cpf, tipo_registro, numero_registro, uf, empresa_nome, empresa_cnpj } = await request.json();
        if (!nome || !cpf || !tipo_registro || !numero_registro) {
          return erro("nome, cpf, tipo_registro (CREA/CAU) e numero_registro são obrigatórios");
        }
        if (!["CREA", "CAU"].includes(tipo_registro)) return erro("tipo_registro deve ser CREA ou CAU");

        // Só valida formato (11 dígitos) — dígito verificador não é checado aqui, isso é
        // um cadastro de uso, não uma validação de CPF de verdade (nem precisa: o CPF só
        // é usado internamente pra decidir o laudo grátis, não é enviado a nenhum órgão).
        const cpfLimpo = String(cpf).replace(/\D/g, "");
        if (cpfLimpo.length !== 11) return erro("cpf inválido — precisa ter 11 dígitos");

        try {
          await env.DB.prepare(
            `UPDATE profissionais
             SET nome = ?, cpf = ?, tipo_registro = ?, numero_registro = ?, uf = ?, empresa_nome = ?, empresa_cnpj = ?
             WHERE id = ?`
          ).bind(nome, cpfLimpo, tipo_registro, numero_registro, uf || null, empresa_nome || null, empresa_cnpj || null, profissional.id).run();
        } catch (e) {
          // Colide com idx_profissionais_cpf (UNIQUE parcial) — esse CPF já está em outra conta.
          if (String(e.message || e).includes("UNIQUE")) {
            return erro("Este CPF já está vinculado a outra conta VICKZ", 409);
          }
          throw e;
        }

        return json({ ok: true });
      }

      // --- entitlement: o app pergunta ANTES de deixar o usuário clicar em "Gerar laudo" ---
      if (rota === "GET /laudos/entitlement") {
        const entitlement = await avaliarEntitlement(env, profissional.id);
        const assinatura = await env.DB.prepare(
          "SELECT * FROM assinaturas WHERE profissional_id = ? AND status = 'ativa'"
        ).bind(profissional.id).first();
        return json({ ...entitlement, tokens: resumoTokens(assinatura) });
      }

      // o app chama isso no momento de gerar (consome grátis/franquia/avulso) e recebe um laudo_id
      if (rota === "POST /laudos/consumir") {
        const { empreendimento_ref } = await request.json().catch(() => ({}));
        const resultado = await consumirEntitlement(env, profissional.id, empreendimento_ref);
        return json(resultado, resultado.autorizado ? 200 : 402);
      }

      // o app manda o PDF já montado (client-side, reaproveitando o jsPDF existente) + o laudo_id
      // que recebeu em /laudos/consumir. O servidor confere que aquele laudo_id é real, pertence a
      // esse profissional e ainda não foi entregue; manda pro vickz-pdf-service pra rasterizar,
      // marcar d'água + QR de verificação e travar permissão; só então manda por e-mail.
      //
      // O que isso resolve: ninguém automatiza a geração em massa sem passar pelo entitlement
      // (isso já é garantido antes daqui, em /laudos/consumir). O que isso NÃO resolve: um usuário
      // técnico ainda pode guardar manualmente o PDF que o próprio navegador dele montou antes de
      // chegar aqui, e a restrição de permissão do PDF final é removível com `qpdf --decrypt`
      // (testado, ver vickz-pdf-service/blindar.py). A proteção que sobrevive a isso é o hash
      // gravado no banco e checável em /verificar/<laudo_id> — uma cópia editada não bate com o
      // hash oficial, então é identificável como não-íntegra por quem for confirmar.
      if (rota === "POST /laudos/entregar") {
        const { laudo_id, pdf_base64 } = await request.json();
        if (!laudo_id || !pdf_base64) return erro("laudo_id e pdf_base64 são obrigatórios");

        const laudo = await env.DB.prepare(
          "SELECT * FROM laudos WHERE id = ? AND profissional_id = ?"
        ).bind(laudo_id, profissional.id).first();
        if (!laudo) return erro("laudo_id inválido", 404);
        if (laudo.entregue) return erro("Este laudo já foi entregue", 409);

        // Defesa em profundidade: /laudos/consumir já bloqueia sem ART, mas checa de
        // novo aqui — entregar é um passo separado e pode ser chamado independentemente.
        const art = await env.DB.prepare(
          `SELECT arquivo_url FROM arts WHERE profissional_id = ? AND empreendimento_ref = ?
           AND aceite_responsabilidade = 1 LIMIT 1`
        ).bind(profissional.id, laudo.empreendimento_ref).first();
        if (!art) return erro("ART pendente para este empreendimento — realize upload da ART", 412);

        const artBytes = await (await env.ART_BUCKET.get(art.arquivo_url)).arrayBuffer();
        const artBase64 = bytesParaBase64(new Uint8Array(artBytes));

        const urlVerificacao = `${env.VERIFY_BASE_URL || env.APP_BASE_URL}/verificar/${laudo_id}`;
        const { pdf_base64: pdfBlindadoBase64, hash_sha256 } = await blindarPdf(env, {
          pdfBase64: pdf_base64,
          artBase64,
          textoRodape:
            "VICKZ — Cópia oficial. Não é válida se editada ou convertida. Verifique em " +
            urlVerificacao +
            " | " +
            AVISO_RESPONSABILIDADE_ART,
          urlVerificacao,
        });

        // TODO: subir pdfBlindadoBase64 pra um bucket R2 e guardar a URL, pra liberar no painel web.
        // Por ora, o e-mail com o PDF anexado já cumpre a entrega combinada na Seção 7 do escopo.
        await enviarEmail(env, {
          para: profissional.email,
          assunto: "Seu laudo VICKZ está pronto",
          texto: `Segue em anexo o laudo gerado no VICKZ. Verificação de autenticidade: ${urlVerificacao}`,
          anexoPdfBase64: pdfBlindadoBase64,
          nomeAnexo: `laudo-${laudo_id}.pdf`,
        });
        await marcarEntregue(env, laudo_id, profissional.email, hash_sha256);

        return json({ ok: true, url_verificacao: urlVerificacao, hash_sha256 });
      }

      // --- ART (uma por empreendimento, cobre todos os vizinhos vistoriados ali) ---
      // O VICKZ não confere a legitimidade do documento: só exige que exista e que o
      // profissional aceite explicitamente a responsabilidade por ela (Seção 1 do escopo).
      if (rota === "POST /art/upload") {
        const { empreendimento_ref, numero_art, arquivo_base64, aceite_responsabilidade } =
          await request.json();
        if (!empreendimento_ref || !arquivo_base64) {
          return erro("empreendimento_ref e arquivo_base64 são obrigatórios");
        }
        if (aceite_responsabilidade !== true) {
          return erro(
            `É necessário aceitar explicitamente a responsabilidade pela ART. ${AVISO_RESPONSABILIDADE_ART}`,
            400
          );
        }

        const chaveR2 = `arts/${profissional.id}/${empreendimento_ref}/${uuid()}.pdf`;
        const bytes = Uint8Array.from(atob(arquivo_base64), (c) => c.charCodeAt(0));
        await env.ART_BUCKET.put(chaveR2, bytes, {
          httpMetadata: { contentType: "application/pdf" },
        });

        await env.DB.prepare(
          `INSERT INTO arts (id, profissional_id, empreendimento_ref, arquivo_url, numero_art,
             aceite_responsabilidade, aceite_responsabilidade_em)
           VALUES (?, ?, ?, ?, ?, 1, ?)
           ON CONFLICT(profissional_id, empreendimento_ref) DO UPDATE SET
             arquivo_url = excluded.arquivo_url, numero_art = excluded.numero_art,
             aceite_responsabilidade = 1, aceite_responsabilidade_em = excluded.aceite_responsabilidade_em`
        ).bind(uuid(), profissional.id, empreendimento_ref, chaveR2, numero_art || null, agoraISO()).run();

        return json({ ok: true, aviso: AVISO_RESPONSABILIDADE_ART });
      }

      // --- cobrança ---
      if (rota === "POST /billing/checkout-assinatura") {
        const { plano } = await request.json();
        if (!FRANQUIA_POR_PLANO[plano]) return erro("Plano inválido");
        const sessao = await criarCheckoutAssinatura(env, profissional, plano);
        return json({ checkout_url: sessao.url });
      }

      if (rota === "POST /billing/checkout-avulso") {
        const sessao = await criarCheckoutAvulso(env, profissional);
        return json({ checkout_url: sessao.url });
      }

      return erro("Rota não encontrada", 404);
    } catch (e) {
      console.error(e);
      return erro("Erro interno: " + e.message, 500);
    }
  },
};

// Página/JSON de verificação pública — sem dado sensível (sem e-mail, sem CPF/CNPJ),
// só o suficiente pra um terceiro confirmar que aquele laudo é o que a VICKZ emitiu.
async function verificarLaudoPublico(request, env, laudoId) {
  const laudo = await env.DB.prepare(
    `SELECT l.autorizado_em, l.entregue, l.empreendimento_ref, l.hash_sha256,
            p.nome, p.tipo_registro, p.numero_registro, p.uf
     FROM laudos l JOIN profissionais p ON p.id = l.profissional_id
     WHERE l.id = ?`
  ).bind(laudoId).first();

  if (!laudo || !laudo.entregue) {
    return json({ valido: false, motivo: "Laudo não encontrado ou não emitido" }, 404);
  }

  return json({
    valido: true,
    profissional: `${laudo.nome} — ${laudo.tipo_registro} ${laudo.numero_registro}/${laudo.uf}`,
    empreendimento: laudo.empreendimento_ref,
    emitido_em: laudo.autorizado_em,
    hash_sha256: laudo.hash_sha256,
    aviso: "Confronte o hash acima com o hash do arquivo em mãos (qualquer ferramenta de sha256sum). Se não bater, o documento foi alterado após a emissão.",
  });
}

// A Stripe moveu o campo da assinatura na fatura entre versões da API.
function subscriptionDaFatura(fatura) {
  return fatura?.subscription || fatura?.parent?.subscription_details?.subscription || null;
}

// Webhook da Stripe fica fora do fluxo autenticado (a Stripe não manda Authorization: Bearer
// da nossa sessão — a autenticidade vem da assinatura HMAC verificada abaixo).
async function tratarWebhookStripe(request, env) {
  const corpoTexto = await request.text();
  const assinaturaHeader = request.headers.get("Stripe-Signature") || "";
  const valido = await verificarAssinaturaWebhook(corpoTexto, assinaturaHeader, env.STRIPE_WEBHOOK_SECRET);
  if (!valido) return erro("Assinatura do webhook inválida", 400);

  const evento = JSON.parse(corpoTexto);
  const obj = evento.data?.object;

  if (evento.type === "checkout.session.completed") {
    const profissionalId = obj.metadata?.profissional_id;
    if (!profissionalId) return json({ ok: true }); // evento sem metadata nossa, ignora

    if (obj.metadata?.tipo === "avulso") {
      await env.DB.prepare(
        `INSERT INTO creditos_avulso (profissional_id, quantidade, atualizado_em)
         VALUES (?, 1, ?)
         ON CONFLICT(profissional_id) DO UPDATE SET quantidade = quantidade + 1, atualizado_em = ?`
      ).bind(profissionalId, agoraISO(), agoraISO()).run();
    } else if (obj.metadata?.plano && obj.payment_status === "paid") {
      const plano = obj.metadata.plano;
      if (!FRANQUIA_POR_PLANO[plano]) return json({ ok: true });
      const agora = new Date();
      const fimCiclo = new Date(agora);
      fimCiclo.setFullYear(fimCiclo.getFullYear() + 1);
      fimCiclo.setDate(fimCiclo.getDate() + 15); // folga p/ a 13ª fatura renovar o ciclo

      // Cria/reativa a assinatura com 0 faturas contadas: quem conta é o invoice.paid
      // (idempotente por invoice_id). Reentrega do MESMO evento não zera contadores.
      await env.DB.prepare(
        `INSERT INTO assinaturas (id, profissional_id, stripe_subscription_id, plano, status, franquia_anual, consumidos_no_ciclo, faturas_pagas, ciclo_inicio, ciclo_fim, atualizado_em)
         VALUES (?, ?, ?, ?, 'ativa', ?, 0, 0, ?, ?, ?)
         ON CONFLICT(profissional_id) DO UPDATE SET
           consumidos_no_ciclo = CASE WHEN assinaturas.stripe_subscription_id = excluded.stripe_subscription_id THEN assinaturas.consumidos_no_ciclo ELSE 0 END,
           faturas_pagas = CASE WHEN assinaturas.stripe_subscription_id = excluded.stripe_subscription_id THEN assinaturas.faturas_pagas ELSE 0 END,
           ciclo_inicio = CASE WHEN assinaturas.stripe_subscription_id = excluded.stripe_subscription_id THEN assinaturas.ciclo_inicio ELSE excluded.ciclo_inicio END,
           ciclo_fim = CASE WHEN assinaturas.stripe_subscription_id = excluded.stripe_subscription_id THEN assinaturas.ciclo_fim ELSE excluded.ciclo_fim END,
           stripe_subscription_id = excluded.stripe_subscription_id,
           plano = excluded.plano, status = 'ativa',
           franquia_anual = excluded.franquia_anual,
           atualizado_em = excluded.atualizado_em`
      ).bind(
        crypto.randomUUID(), profissionalId, obj.subscription, plano,
        FRANQUIA_POR_PLANO[plano], agora.toISOString(), fimCiclo.toISOString(), agoraISO()
      ).run();
    }
  }

  // Cada fatura mensal paga libera mais 1/12 da franquia (idempotente por invoice_id).
  if (evento.type === "invoice.paid") {
    const subId = subscriptionDaFatura(obj);
    if (!subId) return json({ ok: true });
    const assinatura = await env.DB.prepare(
      "SELECT faturas_pagas FROM assinaturas WHERE stripe_subscription_id = ?"
    ).bind(subId).first();
    // Fatura chegou antes do checkout.session.completed: 500 faz a Stripe reenviar.
    if (!assinatura) return erro("Assinatura ainda não registrada, reenviar", 500);

    try {
      await env.DB.prepare("INSERT INTO faturas_processadas (invoice_id) VALUES (?)").bind(obj.id).run();
    } catch (e) {
      if (String(e.message || e).includes("UNIQUE")) return json({ ok: true }); // já contada
      throw e;
    }

    if (assinatura.faturas_pagas >= 12) {
      // 13ª fatura = novo ciclo anual: zera contadores
      const agora = new Date();
      const fim = new Date(agora);
      fim.setFullYear(fim.getFullYear() + 1);
      fim.setDate(fim.getDate() + 15);
      await env.DB.prepare(
        `UPDATE assinaturas SET faturas_pagas = 1, consumidos_no_ciclo = 0, status = 'ativa',
         ciclo_inicio = ?, ciclo_fim = ?, atualizado_em = ? WHERE stripe_subscription_id = ?`
      ).bind(agora.toISOString(), fim.toISOString(), agoraISO(), subId).run();
    } else {
      await env.DB.prepare(
        `UPDATE assinaturas SET faturas_pagas = faturas_pagas + 1, status = 'ativa', atualizado_em = ?
         WHERE stripe_subscription_id = ?`
      ).bind(agoraISO(), subId).run();
    }
  }

  if (evento.type === "customer.subscription.deleted") {
    await env.DB.prepare(
      "UPDATE assinaturas SET status = 'cancelada', atualizado_em = ? WHERE stripe_subscription_id = ?"
    ).bind(agoraISO(), obj.id).run();
  }

  if (evento.type === "invoice.payment_failed") {
    await env.DB.prepare(
      "UPDATE assinaturas SET status = 'inadimplente', atualizado_em = ? WHERE stripe_subscription_id = ?"
    ).bind(agoraISO(), subscriptionDaFatura(obj)).run();
  }

  return json({ ok: true });
}
