// Cloudflare Worker - Âmbari & Gastronomia Backend
// Usa D1 (SQL) para usuários, pedidos e relatórios
// Opcional: KV para cache rápido de pedidos pendentes

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS
    if (method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    const headers = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    };

    try {
      // === AUTH / CADASTROS ===
      if (path === '/api/register' && method === 'POST') {
        const body = await request.json();
        const { nome, matricula, email, cargo } = body;
        if (!nome || !matricula || !email || !cargo) {
          return json({ error: 'Campos obrigatórios' }, 400, headers);
        }
        await env.DB.prepare(
          `INSERT INTO pending_users (nome, matricula, email, cargo, data) VALUES (?, ?, ?, ?, datetime('now'))`
        ).bind(nome, matricula, email, cargo).run();
        return json({ success: true, message: 'Solicitação enviada' }, 200, headers);
      }

      if (path === '/api/pending' && method === 'GET') {
        const { results } = await env.DB.prepare(`SELECT * FROM pending_users ORDER BY data DESC`).all();
        return json(results, 200, headers);
      }

      if (path === '/api/approve' && method === 'POST') {
        const { id } = await request.json();
        const pending = await env.DB.prepare(`SELECT * FROM pending_users WHERE id = ?`).bind(id).first();
        if (!pending) return json({ error: 'Não encontrado' }, 404, headers);
        await env.DB.prepare(
          `INSERT INTO users (nome, matricula, email, cargo, status) VALUES (?, ?, ?, ?, 'aprovado')`
        ).bind(pending.nome, pending.matricula, pending.email, pending.cargo).run();
        await env.DB.prepare(`DELETE FROM pending_users WHERE id = ?`).bind(id).run();
        return json({ success: true }, 200, headers);
      }

      if (path === '/api/login' && method === 'POST') {
        const { matricula } = await request.json();
        const user = await env.DB.prepare(
          `SELECT * FROM users WHERE matricula = ? AND status = 'aprovado'`
        ).bind(matricula).first();
        if (!user) return json({ error: 'Credencial não encontrada ou pendente' }, 401, headers);
        return json(user, 200, headers);
      }

      if (path === '/api/users' && method === 'GET') {
        const { results } = await env.DB.prepare(`SELECT * FROM users`).all();
        return json(results, 200, headers);
      }

      // === PEDIDOS (Cliente -> Garçom) ===
      if (path === '/api/orders' && method === 'POST') {
        // Cliente envia pedido pendente
        const body = await request.json();
        const { mesa, posicao, items, obs } = body;
        if (!mesa || !items || !items.length) return json({ error: 'Mesa e itens obrigatórios' }, 400, headers);
        const id = crypto.randomUUID();
        await env.DB.prepare(
          `INSERT INTO orders (id, mesa, posicao, items, status, created_at) VALUES (?, ?, ?, ?, 'pendente', datetime('now'))`
        ).bind(id, mesa, posicao || '', JSON.stringify(items), ).run();
        return json({ success: true, orderId: id }, 200, headers);
      }

      if (path === '/api/orders/pending' && method === 'GET') {
        const { results } = await env.DB.prepare(
          `SELECT * FROM orders WHERE status = 'pendente' ORDER BY created_at DESC`
        ).all();
        // Parse items JSON
        results.forEach(r => r.items = JSON.parse(r.items || '[]'));
        return json(results, 200, headers);
      }

      if (path.startsWith('/api/orders/') && path.endsWith('/accept') && method === 'POST') {
        const id = path.split('/')[3];
        await env.DB.prepare(`UPDATE orders SET status = 'aceito', accepted_at = datetime('now') WHERE id = ?`).bind(id).run();
        return json({ success: true }, 200, headers);
      }

      if (path.startsWith('/api/orders/') && path.endsWith('/change-table') && method === 'POST') {
        const id = path.split('/')[3];
        const { newMesa } = await request.json();
        await env.DB.prepare(`UPDATE orders SET mesa = ? WHERE id = ?`).bind(newMesa, id).run();
        return json({ success: true }, 200, headers);
      }

      if (path.startsWith('/api/bill/') && method === 'GET') {
        const mesa = decodeURIComponent(path.split('/')[3]);
        const { results } = await env.DB.prepare(
          `SELECT * FROM orders WHERE mesa = ? AND status IN ('aceito', 'pago') ORDER BY created_at`
        ).bind(mesa).all();
        results.forEach(r => r.items = JSON.parse(r.items || '[]'));
        const total = results.reduce((s, o) => s + o.items.reduce((si, i) => si + (i.price * (i.qty || 1)), 0), 0);
        return json({ mesa, orders: results, subtotal: total, taxa: total * 0.1, total: total * 1.1 }, 200, headers);
      }

      return json({ error: 'Rota não encontrada' }, 404, headers);
    } catch (err) {
      return json({ error: err.message }, 500, headers);
    }
  },
};

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers });
}

// Schema D1 (rode no console do Cloudflare):
/*
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT, matricula TEXT UNIQUE, email TEXT, cargo TEXT, status TEXT DEFAULT 'aprovado'
);
CREATE TABLE IF NOT EXISTS pending_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT, matricula TEXT, email TEXT, cargo TEXT, data TEXT
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  mesa TEXT,
  posicao TEXT,
  items TEXT, -- JSON
  status TEXT DEFAULT 'pendente', -- pendente, aceito, pago
  created_at TEXT,
  accepted_at TEXT
);
INSERT OR IGNORE INTO users (nome, matricula, email, cargo) VALUES ('Administrador Master', '323619', 'admin@droppfy.com', 'admin');
*/
