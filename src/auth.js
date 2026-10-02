import { uuid, agoraISO, codigoNumerico, json, erro } from "./util.js";
import { enviarEmail } from "./email.js";

const VALIDADE_CODIGO_MIN = 10;
const VALIDADE_SESSAO_DIAS = 30;
const MAX_CODIGOS_POR_JANELA = 3; // por e-mail, por JANELA_SOLICITACAO_MIN
const JANELA_SOLICITACAO_MIN = 15;
const MAX_TENTATIVAS_VERIFICACAO = 5; // antes de bloquear temporariamente
const BLOQUEIO_TENTATIVAS_MIN = 15;

// Passo 1: pede um código de 6 dígitos por e-mail. Sem senha — login não pode travar
// (era um requisito do app original) e senha é um problema de suporte que não precisamos
// carregar agora.
export async function solicitarCodigo(request, env) {
  const { email } = await request.json();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return erro("E-mail inválido");
  }
  const emailNorm = email.trim().toLowerCase();

  // Sem isso, qualquer um pode espetar o e-mail de alguém e gerar código repetidamente —
  // custa dinheiro (cada envio é cobrado pelo Resend) e enche a caixa de entrada da vítima.
  const janelaInicio = new Date(Date.now() - JANELA_SOLICITACAO_MIN * 60 * 1000).toISOString();
  const recentes = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM codigos_login WHERE email = ? AND criado_em > ?"
  ).bind(emailNorm, janelaInicio).first();
  if ((recentes?.n || 0) >= MAX_CODIGOS_POR_JANELA) {
    return erro(
      `Muitos códigos solicitados para este e-mail. Tente novamente em até ${JANELA_SOLICITACAO_MIN} minutos.`,
      429
    );
  }

  const codigo = codigoNumerico(6);
  const expiraEm = new Date(Date.now() + VALIDADE_CODIGO_MIN * 60 * 1000).toISOString();

  await env.DB.prepare(
    "INSERT INTO codigos_login (email, codigo, expira_em) VALUES (?, ?, ?)"
  ).bind(emailNorm, codigo, expiraEm).run();

  await enviarEmail(env, {
    para: emailNorm,
    assunto: "Seu código de acesso VICKZ",
    texto: `Seu código de acesso é: ${codigo}\n\nVale por ${VALIDADE_CODIGO_MIN} minutos. Se não foi você, ignore este e-mail.`,
  });

  return json({ ok: true, mensagem: "Código enviado por e-mail" });
}

// Passo 2: confirma o código, cria (ou reaproveita) o profissional, abre sessão.
export async function verificarCodigo(request, env) {
  const { email, codigo } = await request.json();
  if (!email || !codigo) return erro("E-mail e código são obrigatórios");
  const emailNorm = email.trim().toLowerCase();

  // Sem isto, o código de 6 dígitos (1 milhão de combinações) pode ser forçado por
  // script dentro da janela de validade de 10 min. Bloqueia depois de N tentativas erradas.
  const bloqueio = await env.DB.prepare(
    "SELECT tentativas, bloqueado_until FROM tentativas_login WHERE email = ?"
  ).bind(emailNorm).first();
  if (bloqueio?.bloqueado_until && bloqueio.bloqueado_until > agoraISO()) {
    return erro(
      `Muitas tentativas erradas. Tente novamente em até ${BLOQUEIO_TENTATIVAS_MIN} minutos.`,
      429
    );
  }

  const linha = await env.DB.prepare(
    `SELECT * FROM codigos_login
     WHERE email = ? AND codigo = ? AND usado = 0 AND expira_em > ?
     ORDER BY criado_em DESC LIMIT 1`
  ).bind(emailNorm, codigo, agoraISO()).first();

  if (!linha) {
    const tentativas = (bloqueio?.tentativas || 0) + 1;
    const bloqueadoUntil =
      tentativas >= MAX_TENTATIVAS_VERIFICACAO
        ? new Date(Date.now() + BLOQUEIO_TENTATIVAS_MIN * 60 * 1000).toISOString()
        : null;
    await env.DB.prepare(
      `INSERT INTO tentativas_login (email, tentativas, bloqueado_until) VALUES (?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET tentativas = excluded.tentativas, bloqueado_until = excluded.bloqueado_until`
    ).bind(emailNorm, tentativas, bloqueadoUntil).run();
    return erro("Código inválido ou expirado", 401);
  }

  // Sucesso: zera o contador de tentativas erradas.
  await env.DB.prepare(
    "INSERT INTO tentativas_login (email, tentativas, bloqueado_until) VALUES (?, 0, NULL) ON CONFLICT(email) DO UPDATE SET tentativas = 0, bloqueado_until = NULL"
  ).bind(emailNorm).run();

  await env.DB.prepare(
    "UPDATE codigos_login SET usado = 1 WHERE email = ? AND codigo = ?"
  ).bind(emailNorm, codigo).run();

  let profissional = await env.DB.prepare(
    "SELECT * FROM profissionais WHERE email = ?"
  ).bind(emailNorm).first();

  if (!profissional) {
    const id = uuid();
    await env.DB.prepare(
      "INSERT INTO profissionais (id, email) VALUES (?, ?)"
    ).bind(id, emailNorm).run();
    profissional = { id, email: emailNorm, nome: null };
  }

  const token = uuid() + uuid(); // token opaco, guardado no servidor — não é JWT, não precisa ser
  const expiraEm = new Date(Date.now() + VALIDADE_SESSAO_DIAS * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare(
    "INSERT INTO sessoes (token, profissional_id, expira_em) VALUES (?, ?, ?)"
  ).bind(token, profissional.id, expiraEm).run();

  return json({ ok: true, token, profissional_id: profissional.id, cadastro_completo: !!profissional.nome });
}

// Middleware simples: resolve o profissional a partir do header Authorization.
export async function autenticar(request, env) {
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return null;

  const sessao = await env.DB.prepare(
    "SELECT * FROM sessoes WHERE token = ? AND expira_em > ?"
  ).bind(token, agoraISO()).first();
  if (!sessao) return null;

  const profissional = await env.DB.prepare(
    "SELECT * FROM profissionais WHERE id = ?"
  ).bind(sessao.profissional_id).first();
  return profissional || null;
}
