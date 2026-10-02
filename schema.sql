-- VICKZ backend — schema D1 (SQLite)
-- Rode com: wrangler d1 execute vickz-db --file=schema.sql

CREATE TABLE IF NOT EXISTS profissionais (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  nome TEXT,
  -- CPF do profissional, pessoa física. Nulo até completar o cadastro (criado só com
  -- e-mail no primeiro login). Usado pra decidir o laudo grátis por CPF (Seção 7 do
  -- escopo) — não pelo id interno, porque um cadastro novo (mesma pessoa, conta
  -- recriada) não pode reabrir o direito ao grátis.
  cpf TEXT,
  tipo_registro TEXT CHECK(tipo_registro IN ('CREA','CAU')),
  numero_registro TEXT,
  uf TEXT,
  empresa_nome TEXT,
  empresa_cnpj TEXT,
  stripe_customer_id TEXT,
  criado_em TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Único por CPF quando preenchido (parcial: permite múltiplos NULL enquanto o cadastro
-- não foi completado, mas nunca dois profissionais ativos com o mesmo CPF).
CREATE UNIQUE INDEX IF NOT EXISTS idx_profissionais_cpf
  ON profissionais(cpf) WHERE cpf IS NOT NULL;

-- login sem senha: código de 6 dígitos por e-mail, de uso único
CREATE TABLE IF NOT EXISTS codigos_login (
  email TEXT NOT NULL,
  codigo TEXT NOT NULL,
  expira_em TEXT NOT NULL,
  usado INTEGER DEFAULT 0,
  criado_em TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_codigos_login_email ON codigos_login(email);

-- Contador de tentativas erradas por e-mail. Sem isso, o código de 6 dígitos (1 milhão
-- de combinações) pode ser atacado por força bruta dentro da janela de 10 min de validade.
CREATE TABLE IF NOT EXISTS tentativas_login (
  email TEXT PRIMARY KEY,
  tentativas INTEGER NOT NULL DEFAULT 0,
  bloqueado_until TEXT
);

CREATE TABLE IF NOT EXISTS sessoes (
  token TEXT PRIMARY KEY,
  profissional_id TEXT NOT NULL,
  criado_em TEXT DEFAULT CURRENT_TIMESTAMP,
  expira_em TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assinaturas (
  id TEXT PRIMARY KEY,
  profissional_id TEXT NOT NULL UNIQUE,
  stripe_subscription_id TEXT,
  plano TEXT CHECK(plano IN ('start','pro','expert')),
  status TEXT CHECK(status IN ('ativa','inadimplente','cancelada')) DEFAULT 'cancelada',
  franquia_anual INTEGER DEFAULT 0,
  -- Contador atômico do ciclo atual. Existe pra permitir UPDATE condicional
  -- ("só incrementa se ainda não esgotou") em vez de contar linhas de `laudos` em duas
  -- etapas (ler, decidir, gravar) — isso é o que evita o laudo duplicado em corrida.
  consumidos_no_ciclo INTEGER NOT NULL DEFAULT 0,
  ciclo_inicio TEXT,
  ciclo_fim TEXT,
  atualizado_em TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS creditos_avulso (
  profissional_id TEXT PRIMARY KEY,
  quantidade INTEGER NOT NULL DEFAULT 0,
  atualizado_em TEXT DEFAULT CURRENT_TIMESTAMP
);

-- cada laudo autorizado (grátis, dentro da franquia, ou avulso) gera 1 linha aqui.
-- é essa tabela que decide se o profissional já usou o grátis e quantos laudos
-- já consumiu no ciclo atual da assinatura — nunca o app cliente.
CREATE TABLE IF NOT EXISTS laudos (
  id TEXT PRIMARY KEY,
  profissional_id TEXT NOT NULL,
  empreendimento_ref TEXT,
  tipo_consumo TEXT CHECK(tipo_consumo IN ('gratis','franquia','avulso')),
  autorizado_em TEXT DEFAULT CURRENT_TIMESTAMP,
  entregue INTEGER DEFAULT 0,
  entregue_em TEXT,
  email_destino TEXT,
  hash_sha256 TEXT
);
CREATE INDEX IF NOT EXISTS idx_laudos_profissional ON laudos(profissional_id);

-- Registro insert-only de quem já usou o laudo grátis, por CPF (não por profissional_id
-- — ver comentário em `profissionais.cpf`). Deliberadamente numa tabela própria, separada
-- de `profissionais`: se a conta for excluída e recriada, esse registro continua existindo
-- e o grátis não é reconcedido. A PRIMARY KEY em cpf é o que fecha a corrida: duas
-- requisições simultâneas tentando conceder o grátis pro mesmo CPF — a segunda recebe
-- erro de constraint, não um segundo grátis.
CREATE TABLE IF NOT EXISTS gratis_concedido_cpf (
  cpf TEXT PRIMARY KEY,
  profissional_id TEXT NOT NULL,
  concedido_em TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Uma ART/RRT cobre o empreendimento inteiro (todos os vizinhos vistoriados ali),
-- não cada laudo individual. O VICKZ NÃO confere a autenticidade do documento —
-- isso é responsabilidade do profissional que faz o upload (ver aceite_responsabilidade).
-- Enquanto não houver pedido formal de API de consulta ao CONFEA/CAU atendido, essa
-- verificação continua sendo humana, fora do sistema (ver escopo, Seção 1).
CREATE TABLE IF NOT EXISTS arts (
  id TEXT PRIMARY KEY,
  profissional_id TEXT NOT NULL,
  empreendimento_ref TEXT NOT NULL,
  arquivo_url TEXT NOT NULL,
  numero_art TEXT,
  aceite_responsabilidade INTEGER NOT NULL DEFAULT 0,
  aceite_responsabilidade_em TEXT,
  criado_em TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(profissional_id, empreendimento_ref)
);
