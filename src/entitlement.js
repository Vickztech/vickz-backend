import { uuid, agoraISO } from "./util.js";

/**
 * Decide se um profissional PROVAVELMENTE pode gerar um laudo agora, e de qual
 * "bucket" ele sairia. É só preview informativo pro app mostrar na tela
 * (GET /laudos/entitlement) — NÃO É a autorização real. A autorização de verdade,
 * que efetivamente consome a vaga, é feita por consumirEntitlement() de forma atômica,
 * porque entre esta função rodar e o código decidir o que fazer, outra requisição
 * concorrente pode ter consumido a mesma vaga (duplo clique, retry de rede). Ver
 * comentário em consumirEntitlement.
 *
 * Ordem de prioridade (Seção 7 do escopo, redesenhado em 01/10/2026):
 *   1. Primeiro laudo grátis — só para quem TEM assinatura ativa, único por CPF na vida
 *      (não por profissional_id — ver comentário em jaUsouGratisPorCpf)
 *   2. Franquia da assinatura ativa, se ainda não esgotada no ciclo atual
 *   3. Crédito avulso comprado
 *   4. Nada disso -> negado
 */
export async function avaliarEntitlement(env, profissionalId) {
  const profissional = await env.DB.prepare(
    "SELECT cpf FROM profissionais WHERE id = ?"
  ).bind(profissionalId).first();

  const assinatura = await env.DB.prepare(
    "SELECT * FROM assinaturas WHERE profissional_id = ? AND status = 'ativa'"
  ).bind(profissionalId).first();

  if (assinatura && profissional?.cpf && !(await jaUsouGratisPorCpf(env, profissional.cpf))) {
    return { autorizado: true, tipo_consumo: "gratis", motivo: "Primeiro laudo grátis (assinante)" };
  }

  if (assinatura && assinatura.consumidos_no_ciclo < assinatura.franquia_anual) {
    return {
      autorizado: true,
      tipo_consumo: "franquia",
      motivo: `Franquia do plano ${assinatura.plano}`,
      restante_no_ciclo: assinatura.franquia_anual - assinatura.consumidos_no_ciclo - 1,
    };
  }

  const credito = await env.DB.prepare(
    "SELECT quantidade FROM creditos_avulso WHERE profissional_id = ?"
  ).bind(profissionalId).first();

  if (credito && credito.quantidade > 0) {
    return { autorizado: true, tipo_consumo: "avulso", motivo: "Crédito avulso disponível" };
  }

  return {
    autorizado: false,
    motivo: assinatura
      ? "Franquia do ciclo esgotada e sem crédito avulso"
      : "Sem assinatura ativa e sem crédito avulso",
    acao_sugerida: "Assinar um plano ou comprar avulso em vickz.com.br",
  };
}

/**
 * O laudo grátis é único por CPF, pra sempre — não por profissional_id. Gravado em
 * tabela própria (gratis_concedido_cpf), insert-only, separada de `profissionais`: se a
 * conta for excluída e recriada (novo profissional_id, mesmo CPF), esse registro
 * continua existindo e o grátis não é reconcedido. Ver schema.sql.
 */
async function jaUsouGratisPorCpf(env, cpf) {
  if (!cpf) return true; // sem CPF cadastrado, não há como conceder o grátis (trata como já usado)
  const linha = await env.DB.prepare(
    "SELECT 1 FROM gratis_concedido_cpf WHERE cpf = ? LIMIT 1"
  ).bind(cpf).first();
  return !!linha;
}

/**
 * Consome o entitlement de forma atômica o suficiente pro volume esperado:
 * reavalia e já grava a linha em `laudos`. Se for avulso, decrementa o crédito.
 * Retorna o laudo_id que o app usa depois em /laudos/entregar.
 */
/**
 * A ART cobre o EMPREENDIMENTO inteiro (todos os vizinhos vistoriados ali), não cada
 * laudo. O VICKZ não confere a autenticidade — só exige que o profissional tenha
 * enviado o arquivo e aceitado a responsabilidade por ela (Seção 1 do escopo).
 */
async function possuiArtValida(env, profissionalId, empreendimentoRef) {
  if (!empreendimentoRef) return false; // sem empreendimento identificado, não dá pra checar ART
  const art = await env.DB.prepare(
    `SELECT 1 FROM arts WHERE profissional_id = ? AND empreendimento_ref = ?
     AND aceite_responsabilidade = 1 AND arquivo_url IS NOT NULL LIMIT 1`
  ).bind(profissionalId, empreendimentoRef).first();
  return !!art;
}

/**
 * Autorização real, atômica. Em vez de "ler estado -> decidir -> gravar" (que tem
 * janela de corrida entre ler e gravar — dois cliques ou um retry de rede concorrentes
 * podiam conceder dois grátis, ou consumir dois créditos de uma vez), cada tentativa é
 * uma escrita condicional no próprio banco: ou ela grava porque a condição ainda era
 * verdadeira NAQUELE INSTANTE da escrita, ou falha porque outra requisição já tinha
 * consumido a vaga — sem essa janela.
 */
export async function consumirEntitlement(env, profissionalId, empreendimentoRef) {
  if (!(await possuiArtValida(env, profissionalId, empreendimentoRef))) {
    return {
      autorizado: false,
      laudo_id: null,
      motivo: "ART pendente para este empreendimento",
      acao_sugerida: "Realize upload da ART",
    };
  }

  // 1. Grátis: só para quem tem assinatura ativa (Seção 7, redesenho de 01/10/2026) e
  // ainda não usou — checado por CPF, não por profissional_id (ver jaUsouGratisPorCpf).
  // A PRIMARY KEY em gratis_concedido_cpf(cpf) é o que fecha a corrida: duas requisições
  // simultâneas pro mesmo CPF — a segunda recebe erro de constraint aqui, não concede
  // um segundo grátis. Precisa de assinatura ativa ANTES de tentar conceder: sem isso,
  // qualquer um sem assinar ainda ganharia o grátis.
  const profissional = await env.DB.prepare(
    "SELECT cpf FROM profissionais WHERE id = ?"
  ).bind(profissionalId).first();

  const assinaturaAtiva = await env.DB.prepare(
    "SELECT 1 FROM assinaturas WHERE profissional_id = ? AND status = 'ativa' LIMIT 1"
  ).bind(profissionalId).first();

  if (assinaturaAtiva && profissional?.cpf) {
    const laudoIdGratis = uuid();
    try {
      await env.DB.prepare(
        "INSERT INTO gratis_concedido_cpf (cpf, profissional_id) VALUES (?, ?)"
      ).bind(profissional.cpf, profissionalId).run();
      await env.DB.prepare(
        `INSERT INTO laudos (id, profissional_id, empreendimento_ref, tipo_consumo, autorizado_em)
         VALUES (?, ?, ?, 'gratis', ?)`
      ).bind(laudoIdGratis, profissionalId, empreendimentoRef || null, agoraISO()).run();
      return {
        autorizado: true,
        tipo_consumo: "gratis",
        motivo: "Primeiro laudo grátis (assinante)",
        laudo_id: laudoIdGratis,
      };
    } catch (e) {
      if (!String(e.message || e).includes("UNIQUE")) throw e; // erro diferente de "já usou" não deve ser engolido
      // já usou o grátis (outro profissional_id, mesmo CPF, inclusive) — cai pra franquia/avulso abaixo
    }
  }

  // 2. Franquia: UPDATE condicional em assinaturas.consumidos_no_ciclo. A cláusula
  // "< franquia_anual" só é satisfeita se, no exato momento desta escrita, ainda havia
  // vaga — o SQLite resolve isso atomicamente por linha, sem corrida possível.
  const agora = agoraISO();
  const incrementoFranquia = await env.DB.prepare(
    `UPDATE assinaturas SET consumidos_no_ciclo = consumidos_no_ciclo + 1, atualizado_em = ?
     WHERE profissional_id = ? AND status = 'ativa'
       AND ciclo_inicio <= ? AND ciclo_fim > ?
       AND consumidos_no_ciclo < franquia_anual`
  ).bind(agora, profissionalId, agora, agora).run();

  if (incrementoFranquia.meta?.changes > 0) {
    const laudoId = uuid();
    await env.DB.prepare(
      `INSERT INTO laudos (id, profissional_id, empreendimento_ref, tipo_consumo, autorizado_em)
       VALUES (?, ?, ?, 'franquia', ?)`
    ).bind(laudoId, profissionalId, empreendimentoRef || null, agora).run();
    return { autorizado: true, tipo_consumo: "franquia", motivo: "Franquia da assinatura", laudo_id: laudoId };
  }

  // 3. Avulso: UPDATE condicional em creditos_avulso.quantidade. "quantidade > 0" só é
  // satisfeita se, no exato momento da escrita, ainda havia crédito — mesma lógica.
  const decrementoAvulso = await env.DB.prepare(
    "UPDATE creditos_avulso SET quantidade = quantidade - 1, atualizado_em = ? WHERE profissional_id = ? AND quantidade > 0"
  ).bind(agora, profissionalId).run();

  if (decrementoAvulso.meta?.changes > 0) {
    const laudoId = uuid();
    await env.DB.prepare(
      `INSERT INTO laudos (id, profissional_id, empreendimento_ref, tipo_consumo, autorizado_em)
       VALUES (?, ?, ?, 'avulso', ?)`
    ).bind(laudoId, profissionalId, empreendimentoRef || null, agora).run();
    return { autorizado: true, tipo_consumo: "avulso", motivo: "Crédito avulso disponível", laudo_id: laudoId };
  }

  return {
    autorizado: false,
    laudo_id: null,
    motivo: "Franquia do ciclo esgotada e sem crédito avulso",
    acao_sugerida: "Assinar um plano ou comprar avulso em vickz.com.br",
  };
}

/** Marca um laudo já autorizado como entregue (por e-mail e/ou painel web). */
export async function marcarEntregue(env, laudoId, emailDestino, hashSha256) {
  await env.DB.prepare(
    "UPDATE laudos SET entregue = 1, entregue_em = ?, email_destino = ?, hash_sha256 = ? WHERE id = ?"
  ).bind(agoraISO(), emailDestino || null, hashSha256 || null, laudoId).run();
}
