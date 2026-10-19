// Cloudflare Worker - Âmbari & Gastronomia + Praças + Proxy de Imagens

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, HEAD',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    const headers = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    };

    // ========== PROXY DE IMAGENS ==========
    if (path === '/img' && method === 'GET') {
      const original = url.searchParams.get('url');
      if (!original) return new Response('Missing url', { status: 400 });

      const cache = caches.default;
      const cacheKey = new Request(request.url, request);
      let response = await cache.match(cacheKey);

      if (!response) {
        try {
          const imgRes = await fetch(original, {
            headers: { 'User-Agent': 'Ambari-Cardapio/1.0' }
          });
          if (!imgRes.ok) return new Response('Image not found', { status: 404 });
          response = new Response(imgRes.body, imgRes);
          response.headers.set('Cache-Control', 'public, max-age=86400');
          response.headers.set('Access-Control-Allow-Origin', '*');
          ctx.waitUntil(cache.put(cacheKey, response.clone()));
        } catch (e) {
          return new Response('Error fetching image', { status: 500 });
        }
      }
      return response;
    }

    try {
      // ========== CADASTROS ==========
      if (path === '/api/register' && method === 'POST') {
        const body = await request.json();
        const { nome, matricula, email, cargo, praca } = body;
        if (!nome || !matricula || !email || !cargo) {
          return json({ error: 'Campos obrigatórios' }, 400, headers);
        }
        await env.DB.prepare(
          `INSERT INTO pending_users (nome, matricula, email, cargo, praca, data) VALUES (?, ?, ?, ?, ?, datetime('now'))`
        ).bind(nome, matricula, email, cargo, praca || null).run();
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
          `INSERT INTO users (nome, matricula, email, cargo, praca, status) VALUES (?, ?, ?, ?, ?, 'aprovado')`
        ).bind(pending.nome, pending.matricula, pending.email, pending.cargo, pending.praca).run();
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
        const { results } = await env.DB.prepare(`SELECT * FROM users ORDER BY id DESC`).all();
        return json(results, 200, headers);
      }

      if (path === '/api/users/delete' && method === 'POST') {
        const { matricula } = await request.json();
        await env.DB.prepare(`DELETE FROM users WHERE matricula = ?`).bind(matricula).run();
        return json({ success: true }, 200, headers);
      }

      // ========== PEDIDOS ==========
      if (path === '/api/orders' && method === 'POST') {
        const body = await request.json();
        const { mesa, posicao, items, obs } = body;
        if (!mesa || !items || !items.length) return json({ error: 'Mesa e itens obrigatórios' }, 400, headers);
        const id = crypto.randomUUID();
        // Extrai número da mesa para calcular praça
        const mesaNum = parseInt(mesa.replace(/\D/g, '')) || 0;
        const praca = Math.ceil(mesaNum / 50) || 1;
        await env.DB.prepare(
          `INSERT INTO orders (id, mesa, posicao, items, status, praca, created_at) VALUES (?, ?, ?, ?, 'pendente', ?, datetime('now'))`
        ).bind(id, mesa, posicao || '', JSON.stringify(items), praca).run();
        return json({ success: true, orderId: id, praca }, 200, headers);
      }

      if (path === '/api/orders/pending' && method === 'GET') {
        const praca = url.searchParams.get('praca');
        let query = `SELECT * FROM orders WHERE status = 'pendente'`;
        if (praca && praca !== 'all') {
          query += ` AND praca = ?`;
        }
        query += ` ORDER BY created_at DESC`;
        const stmt = env.DB.prepare(query);
        const { results } = praca && praca !== 'all' ? await stmt.bind(praca).all() : await stmt.all();
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
        const mesaNum = parseInt(newMesa.replace(/\D/g, '')) || 0;
        const praca = Math.ceil(mesaNum / 50) || 1;
        await env.DB.prepare(`UPDATE orders SET mesa = ?, praca = ? WHERE id = ?`).bind(newMesa, praca, id).run();
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
