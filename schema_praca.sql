-- Adicionar coluna praca nas tabelas (rode no D1 Studio)
ALTER TABLE pending_users ADD COLUMN praca INTEGER;
ALTER TABLE users ADD COLUMN praca INTEGER;
ALTER TABLE orders ADD COLUMN praca INTEGER;

-- Se der erro de coluna já existe, ignore e continue
