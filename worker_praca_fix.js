/**
 * Âmbari & Gastronomia — Cloudflare Worker + D1 (integração completa)
 * -------------------------------------------------------------------------
 * Publica o app novo (index.html em public/) e mantém as rotas da API antiga.
 *
 * Duas APIs convivem neste Worker:
 *   • /api/state          → sincronização do app NOVO (estado completo).
 *                           O app detecta sozinho quando é aberto por este
 *                           endereço. É por aqui que login com CPF+senha,
 *                           aprovações, vouchers, quartos, pedidos e contas
 *                           do app novo trafegam.
 *   • /api/register, /api/pending, /api/approve, /api/login, /api/users,
 *     /api/users/delete, /api/orders, /api/orders/pending,
 *     /api/orders/{id}/accept, /api/orders/{id}/change-table, /api/bill/{mesa}
 *                         → API LEGADA (tabelas pending_users, users, orders),
 *                           mantida para as páginas antigas que já usavam.
 *
 * /img?url=... → proxy de imagens com cache de 1 dia.
 *
 * COMO PUBLICAR:
 *   1. npx wrangler login
 *   2. npx wrangler d1 create ambari-db
 *      → copie o "database_id" exibido para o wrangler.toml
 *   3. npx wrangler d1 execute ambari-db --remote --file=schema.sql
 *      (se as tabelas antigas já existirem SEM a coluna praca, rode também
 *       os ALTER TABLE comentados no final do schema.sql)
 *   4. npx wrangler deploy
 *   5. Abra https://ambari-gastronomia.<sua-conta>.workers.dev
 *
 * Para hospedar o HTML em outro lugar, defina no HTML:
 *   window.AMBARI_API_BASE = 'https://ambari-gastronomia.<sua-conta>.workers.dev';
 * -------------------------------------------------------------------------
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, HEAD',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
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
      if (!original || !/^https?:\/\//.test(original)) return new Response('Missing url', { status: 400 });

      const cache = caches.default;
      const cacheKey = new Request(url.toString(), { method: 'GET' });
      let response = await cache.match(cacheKey);

      if (!response) {
        try {
          const imgRes = await fetch(original, { headers: { 'User-Agent': 'Ambari-Cardapio/1.0' } });
          if (!imgRes.ok) return new Response('Image not found', { status: 404 });
          response = new Response(imgRes.body, imgRes);
          response.headers.set('Content-Type', imgRes.headers.get('Content-Type') || 'image/jpeg');
          response.headers.set('Cache-Control', 'public, max-age=86400');
          response.headers.set('Access-Control-Allow-Origin', '*');
          ctx.waitUntil(cache.put(cacheKey, response.clone()));
        } catch (e) {
          return new Response('Error fetching image', { status: 500 });
        }
      }
      return response;
    }

    if (path.startsWith('/api')) {
      try {
        // ========== SAÚDE ==========
        if (path === '/api/health' && method === 'GET') {
          let state = 'pronto';
          try {
            await env.DB.prepare('SELECT revision FROM app_state WHERE id = 1').first();
          } catch (e) {
            state = 'sem-tabela: rode o schema.sql no D1';
          }
          return json({ ok: true, service: 'ambari', state }, 200, headers);
        }

        // ========== APP NOVO: ESTADO COMPARTILHADO ==========
        if (path === '/api/state' && method === 'GET') {
          const since = Number(url.searchParams.get('since') || 0);
          const row = await env.DB.prepare('SELECT revision, data FROM app_state WHERE id = 1').first();
          if (!row) return json({ upToDate: true }, 200, headers);
          if (since && Number(row.revision) <= since) return json({ upToDate: true }, 200, headers);
          let db = null;
          try { db = JSON.parse(row.data); } catch (e) { db = null; }
          return json({ revision: Number(row.revision), db }, 200, headers);
        }

        if (path === '/api/state' && method === 'PUT') {
          const body = await request.json().catch(() => null);
          const revision = Number(body && body.revision) || 0;
          const data = body && body.db != null
            ? (typeof body.db === 'string' ? body.db : JSON.stringify(body.db))
            : '';
          if (!revision || !data) return json({ error: 'Estado inválido' }, 400, headers);
          if (data.length > 950000) return json({ error: 'Estado muito grande para o D1' }, 413, headers);

          const row = await env.DB.prepare('SELECT revision FROM app_state WHERE id = 1').first();
          if (row && Number(row.revision) > revision) {
            return json({ error: 'A nuvem já tem uma versão mais recente', revision: Number(row.revision) }, 409, headers);
          }
          if (row) {
            await env.DB.prepare(
              "UPDATE app_state SET revision = ?, data = ?, updated_at = datetime('now') WHERE id = 1"
            ).bind(revision, data).run();
          } else {
            await env.DB.prepare(
              "INSERT INTO app_state (id, revision, data, updated_at) VALUES (1, ?, ?, datetime('now'))"
            ).bind(revision, data).run();
          }
          return json({ ok: true, revision }, 200, headers);
        }

        // ========== API LEGADA: CADASTROS ==========
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

        // ========== API LEGADA: PEDIDOS ==========
        if (path === '/api/orders' && method === 'POST') {
          const body = await request.json();
          const { mesa, posicao, items, obs } = body;
          if (!mesa || !items || !items.length) return json({ error: 'Mesa e itens obrigatórios' }, 400, headers);
          const id = crypto.randomUUID();
          const mesaNum = parseInt(String(mesa).replace(/\D/g, '')) || 1;
          const praca = Math.max(1, Math.ceil(mesaNum / 50));
          await env.DB.prepare(
            `INSERT INTO orders (id, mesa, posicao, obs, items, status, praca, created_at) VALUES (?, ?, ?, ?, ?, 'pendente', ?, datetime('now'))`
          ).bind(id, String(mesa), posicao || '', obs || '', JSON.stringify(items), praca).run();
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
          const mesaNum = parseInt(String(newMesa).replace(/\D/g, '')) || 0;
          const praca = Math.ceil(mesaNum / 50) || 1;
          await env.DB.prepare(`UPDATE orders SET mesa = ?, praca = ? WHERE id = ?`).bind(String(newMesa), praca, id).run();
          return json({ success: true }, 200, headers);
        }

        if (path.startsWith('/api/bill/') && method === 'GET') {
          const mesa = decodeURIComponent(path.split('/')[3]);
          const { results } = await env.DB.prepare(
            `SELECT * FROM orders WHERE mesa = ? AND status IN ('aceito', 'pago') ORDER BY created_at`
          ).bind(mesa).all();
          results.forEach(r => r.items = JSON.parse(r.items || '[]'));
          const total = results.reduce((s, o) => s + o.items.reduce((si, i) => si + (Number(i.price) * (Number(i.qty) || 1)), 0), 0);
          return json({ mesa, orders: results, subtotal: total, taxa: total * 0.1, total: total * 1.1 }, 200, headers);
        }

        return json({ error: 'Rota não encontrada' }, 404, headers);
      } catch (err) {
        return json({ error: err.message }, 500, headers);
      }
    }

    // Qualquer outra rota cai nos arquivos estáticos (public/)
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Não encontrado', { status: 404 });
  },
};

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers });
}
