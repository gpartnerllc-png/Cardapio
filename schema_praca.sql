-- Âmbari & Gastronomia — Cloudflare D1 (schema completo)
-- Rode uma vez: npx wrangler d1 execute ambari-db --remote --file=schema.sql
-- (ou cole no D1 Studio do painel da Cloudflare)

-- ========== APP NOVO: estado compartilhado ==========
CREATE TABLE IF NOT EXISTS app_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ========== API LEGADA: cadastros ==========
CREATE TABLE IF NOT EXISTS pending_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  matricula TEXT NOT NULL,
  email TEXT NOT NULL,
  cargo TEXT NOT NULL,
  praca INTEGER,
  data TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  matricula TEXT NOT NULL,
  email TEXT NOT NULL,
  cargo TEXT NOT NULL,
  praca INTEGER,
  status TEXT NOT NULL DEFAULT 'aprovado',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ========== API LEGADA: pedidos ==========
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  mesa TEXT NOT NULL,
  posicao TEXT DEFAULT '',
  obs TEXT DEFAULT '',
  items TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pendente',
  praca INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  accepted_at TEXT
);

-- ============================================================
-- Se as tabelas antigas JÁ EXISTEM no seu banco (criadas antes
-- desta versão), os CREATE acima são ignorados. Nesse caso rode
-- os ALTERs abaixo para completá-las (erro "duplicate column"
-- significa que a coluna já existe e pode ser ignorado):
--
-- ALTER TABLE pending_users ADD COLUMN praca INTEGER;
-- ALTER TABLE users ADD COLUMN praca INTEGER;
-- ALTER TABLE orders ADD COLUMN praca INTEGER;
-- ALTER TABLE orders ADD COLUMN obs TEXT;
-- ============================================================
