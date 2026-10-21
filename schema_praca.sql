-- Âmbari & Gastronomia — Cloudflare D1
-- Rode uma vez: npx wrangler d1 execute ambari-db --remote --file=schema.sql
-- (ou cole no D1 Studio do painel da Cloudflare)

CREATE TABLE IF NOT EXISTS app_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- As tabelas antigas (pending_users, users, orders) podem continuar no banco;
-- o app novo guarda tudo na tabela app_state acima e não depende delas.
