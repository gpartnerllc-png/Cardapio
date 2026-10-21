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
          'Access-Control-Allow-Headers': 'Content-Type, X-Ambari-Token',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    const headers = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    };

    // ========== PROTEÇÃO OPCIONAL POR TOKEN ==========
    // Defina SYNC_TOKEN no Worker (wrangler secret put SYNC_TOKEN) para exigir
    // o token em todos os aparelhos. O webhook do Asaas usa o próprio token.
    const isAsaasWebhook = path === '/api/billing/webhook';
    const protectedApi = !isAsaasWebhook && (
      path === '/api/state' ||
      path.startsWith('/api/billing/') ||
      path === '/api/users' || path === '/api/pending' ||
      path === '/api/approve' || path === '/api/users/delete'
    );
    if (env.SYNC_TOKEN && protectedApi) {
      const token = request.headers.get('x-ambari-token') || url.searchParams.get('token') || '';
      if (!safeEqual(token, env.SYNC_TOKEN)) {
        return json({ error: 'Token da nuvem inválido ou ausente', code: 'UNAUTHORIZED' }, 401, headers);
      }
    }

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
          let storage = 'd1';
          try {
            await env.DB.prepare('SELECT revision FROM app_state WHERE id = 1').first();
          } catch (e) {
            if (env.AMBARI_KV) {
              state = 'D1 indisponível — usando KV';
              storage = 'kv';
            } else {
              state = env.DB ? 'sem-tabela: rode o schema.sql no D1' : 'sem D1 nem KV configurados';
              storage = 'nenhum';
            }
          }
          return json({
            ok: true,
            service: 'ambari',
            state,
            storage,
            auth: !!env.SYNC_TOKEN,
            billing: env.ASAAS_API_KEY ? 'Asaas Pix' : '',
            features: {
              d1: !!env.DB,
              kv: !!env.AMBARI_KV,
              billing: !!env.ASAAS_API_KEY,
              autoBilling: env.BILLING_AUTO === 'true',
              invoice: !!env.SPEDY_API_KEY
            }
          }, 200, headers);
        }

        // ========== APP NOVO: ESTADO COMPARTILHADO (D1 + KV) ==========
        if (path === '/api/state' && method === 'GET') {
          const since = Number(url.searchParams.get('since') || 0);
          const row = await readAppState(env);
          if (!row) return json({ upToDate: true }, 200, headers);
          if (since && Number(row.revision) <= since) return json({ upToDate: true }, 200, headers);
          let db = null;
          try { db = JSON.parse(row.data); } catch (e) { db = null; }
          return json({ revision: Number(row.revision), source: row.source, db }, 200, headers);
        }

        if (path === '/api/state' && method === 'PUT') {
          const body = await request.json().catch(() => null);
          const revision = Number(body && body.revision) || 0;
          const data = body && body.db != null
            ? (typeof body.db === 'string' ? body.db : JSON.stringify(body.db))
            : '';
          if (!revision || !data) return json({ error: 'Estado inválido' }, 400, headers);
          if (data.length > 950000) return json({ error: 'Estado muito grande para a nuvem' }, 413, headers);

          const current = await readAppState(env);
          if (current && Number(current.revision) > revision) {
            return json({ error: 'A nuvem já tem uma versão mais recente', revision: Number(current.revision) }, 409, headers);
          }
          const wrote = await writeAppState(env, revision, data);
          if (!wrote) {
            return json({ error: 'A nuvem não tem D1 nem KV disponíveis', code: 'NO_STORAGE' }, 503, headers);
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

        // ========== PAGAMENTOS PIX (PSP) — ANTI-FRAUDE ==========
        // O Banco Central/SPI só fala com PSP licenciado (Inter, Efi, Asaas...).
        // Este Worker é o único ponto que conversa com o PSP: o navegador nunca
        // recebe status confiável de "pago" — só o servidor, via webhook
        // autenticado (HMAC) ou consulta de status, confirma o recebimento.
        // Variáveis necessárias: PSP_API_KEY, PSP_BASE_URL, PSP_PIX_KEY,
        //                        PSP_WEBHOOK_SECRET
        if (path === '/api/payments/pix' && method === 'POST') {
          if (!env.PSP_API_KEY || !env.PSP_BASE_URL) {
            return json({ error: 'PSP não configurado no servidor', code: 'NOT_CONFIGURED' }, 409, headers);
          }
          const body = await request.json().catch(() => null);
          const amount = Number(body && body.amount);
          const mesa = String((body && body.mesa) || '');
          if (!Number.isFinite(amount) || amount <= 0 || amount > 100000) {
            return json({ error: 'Valor inválido' }, 400, headers);
          }
          const txid = `AMBARI${mesa.replace(/\D/g, '')}${Date.now().toString(36).toUpperCase()}${crypto.randomUUID().slice(0, 4).toUpperCase()}`.slice(0, 35);
          const expiresAt = new Date(Date.now() + 30 * 60000).toISOString();

          let pspRes;
          try {
            pspRes = await fetch(`${env.PSP_BASE_URL.replace(/\/+$/, '')}/cob`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.PSP_API_KEY}` },
              body: JSON.stringify({
                calendario: { expiracao: 1800 },
                valor: { original: amount.toFixed(2) },
                chave: env.PSP_PIX_KEY || '',
                solicitacaoPagador: `Ambari & Gastronomia - Mesa ${mesa}`,
                txid
              }),
            });
          } catch (e) {
            return json({ error: 'PSP indisponível', detail: e.message }, 502, headers);
          }
          if (!pspRes.ok) {
            const detail = await pspRes.text().catch(() => '');
            return json({ error: 'PSP recusou a cobrança', detail: detail.slice(0, 200) }, 502, headers);
          }
          const cob = await pspRes.json().catch(() => ({}));
          const existing = await env.DB.prepare('SELECT txid FROM payments_log WHERE txid = ?').bind(txid).first();
          if (existing) return json({ error: 'Cobrança duplicada', code: 'IDEMPOTENCY' }, 409, headers);
          await env.DB.prepare(
            `INSERT INTO payments_log (txid, kind, amount, status, ref, payload, created_at)
             VALUES (?, 'pix', ?, 'pendente', ?, ?, datetime('now'))`
          ).bind(txid, amount, mesa, JSON.stringify({ emv: cob.pixCopiaECola || cob.emv || '', location: cob.loc?.location || null })).run();
          return json({
            txid,
            emv: cob.pixCopiaECola || cob.emv || '',
            location: cob.loc?.location || null,
            expiresAt
          }, 200, headers);
        }

        if (path.startsWith('/api/payments/pix/') && method === 'GET') {
          const txid = decodeURIComponent(path.split('/')[4] || '');
          if (!txid) return json({ error: 'txid obrigatório' }, 400, headers);
          const row = await env.DB.prepare('SELECT * FROM payments_log WHERE txid = ?').bind(txid).first();
          if (!row) return json({ error: 'Cobrança não encontrada' }, 404, headers);
          if (row.status === 'pago') return json({ txid, status: 'pago', amount: row.amount, paidAt: row.paid_at }, 200, headers);
          if (!env.PSP_API_KEY || !env.PSP_BASE_URL) return json({ txid, status: row.status }, 200, headers);
          try {
            const pspRes = await fetch(`${env.PSP_BASE_URL.replace(/\/+$/, '')}/cob/${encodeURIComponent(txid)}`, {
              headers: { 'Authorization': `Bearer ${env.PSP_API_KEY}` },
            });
            if (pspRes.ok) {
              const cob = await pspRes.json().catch(() => ({}));
              const paid = cob.status === 'CONCLUIDA';
              if (paid) {
                const expected = Number(row.amount);
                const received = Number(cob.valor?.original);
                if (Math.abs(received - expected) > 0.01) {
                  await env.DB.prepare(`UPDATE payments_log SET status = 'divergente', payload = payload || ? WHERE txid = ?`)
                    .bind(JSON.stringify({ alerta: `valor divergente: esperado ${expected}, recebido ${received}` }), txid).run();
                  return json({ txid, status: 'divergente' }, 200, headers);
                }
                await env.DB.prepare(`UPDATE payments_log SET status = 'pago', paid_at = datetime('now') WHERE txid = ?`).bind(txid).run();
                return json({ txid, status: 'pago', amount: row.amount }, 200, headers);
              }
            }
          } catch (e) { /* mantém status atual */ }
          return json({ txid, status: row.status, expiresAt: null }, 200, headers);
        }

        if (path === '/api/payments/webhook' && method === 'POST') {
          const secret = env.PSP_WEBHOOK_SECRET;
          if (!secret) return json({ error: 'Webhook não configurado' }, 409, headers);
          const raw = await request.text();
          const signature = request.headers.get('x-webhook-signature') || '';
          const expected = await hmacSha256Hex(secret, raw);
          const safeEqual = signature.length === expected.length &&
            signature.split('').every((ch, i) => ch === expected[i]);
          if (!safeEqual) return json({ error: 'Assinatura inválida' }, 401, headers);

          let event;
          try { event = JSON.parse(raw); } catch (e) { return json({ error: 'JSON inválido' }, 400, headers); }
          const txid = String(event.txid || event.pix?.txid || '');
          if (!txid) return json({ error: 'txid ausente' }, 400, headers);
          const row = await env.DB.prepare('SELECT * FROM payments_log WHERE txid = ?').bind(txid).first();
          if (!row) return json({ error: 'Cobrança desconhecida' }, 404, headers);
          if (row.status === 'pago') return json({ ok: true, duplicate: true }, 200, headers);
          const received = Number(event.valor || event.amount || event.pix?.valor);
          if (!Number.isFinite(received) || Math.abs(received - Number(row.amount)) > 0.01) {
            return json({ error: 'Valor divergente — pagamento não confirmado' }, 422, headers);
          }
          await env.DB.prepare(`UPDATE payments_log SET status = 'pago', paid_at = datetime('now') WHERE txid = ?`).bind(txid).run();
          return json({ ok: true }, 200, headers);
        }

        // ========== ASSINATURAS MENSAIS (Asaas Pix) ==========
        // O valor é SEMPRE calculado no servidor pelo número de acessos.
        // O proprietário (CPF 342.599.988-54) nunca é cobrado.
        // Segredos: ASAAS_API_KEY, ASAAS_WEBHOOK_TOKEN, ASAAS_BASE_URL (opcional).
        if (path === '/api/billing/charge' && method === 'POST') {
          if (!env.ASAAS_API_KEY) {
            return json({ error: 'Cobrança Pix ainda não configurada no Worker', code: 'NOT_CONFIGURED' }, 409, headers);
          }
          if (!env.DB) return json({ error: 'Cobranças exigem o D1 configurado', code: 'NO_DB' }, 503, headers);
          const body = await request.json().catch(() => null);
          const accountId = String(body?.accountId || '').trim().slice(0, 80);
          const name = String(body?.name || '').trim().slice(0, 80);
          const email = String(body?.email || '').trim().slice(0, 120);
          const doc = onlyDigits(body?.doc);
          const seats = Math.max(1, Math.min(5000, Number(body?.seats) || 0));
          if (!accountId || !name) return json({ error: 'Conta inválida' }, 400, headers);
          if (doc === OWNER_DOC) return json({ error: 'Proprietário isento de cobrança', code: 'OWNER_EXEMPT' }, 400, headers);
          if (!isValidDoc(doc)) return json({ error: 'CPF/CNPJ inválido' }, 400, headers);
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'E-mail financeiro inválido' }, 400, headers);

          const period = billingPeriodNow();
          const existing = await env.DB.prepare(
            'SELECT * FROM billing_log WHERE account_id = ? AND period = ?'
          ).bind(accountId, period).first();
          if (existing) {
            if (existing.status === 'pago') {
              return json({ error: 'Mensalidade já paga neste mês', code: 'ALREADY_PAID', txid: existing.txid }, 409, headers);
            }
            if (existing.status === 'expirado' || existing.status === 'divergente') {
              try {
                const renewed = await createBillingCharge(env, { accountId, name, email, doc, seats }, period, existing);
                return json(renewed, 200, headers);
              } catch (err) {
                return json({ error: 'O Asaas não renovou a cobrança', detail: String(err.message || err).slice(0, 220) }, 502, headers);
              }
            }
            return json(billingView(existing), 200, headers);
          }
          try {
            const result = await createBillingCharge(env, { accountId, name, email, doc, seats }, period);
            return json(result, 200, headers);
          } catch (err) {
            return json({ error: 'O Asaas não gerou a cobrança', detail: String(err.message || err).slice(0, 220) }, 502, headers);
          }
        }

        if (path.startsWith('/api/billing/charge/') && method === 'GET') {
          const txid = decodeURIComponent(path.split('/')[4] || '');
          if (!txid) return json({ error: 'txid obrigatório' }, 400, headers);
          const row = await env.DB.prepare('SELECT * FROM billing_log WHERE txid = ?').bind(txid).first();
          if (!row) return json({ error: 'Cobrança não encontrada' }, 404, headers);
          if (row.status === 'pago') {
            return json({ txid, status: 'pago', amount: Number(row.amount), paidAt: row.paid_at }, 200, headers);
          }
          if (row.status === 'pendente' && row.provider_id && env.ASAAS_API_KEY) {
            try {
              const { res, data } = await asaasFetch(env, `/payments/${encodeURIComponent(row.provider_id)}`);
              if (res.ok && data) {
                const status = String(data.status || '').toUpperCase();
                if (['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'].includes(status)) {
                  if (Math.abs(Number(data.value) - Number(row.amount)) > 0.01) {
                    await env.DB.prepare(
                      "UPDATE billing_log SET status = 'divergente', payload = ? WHERE txid = ?"
                    ).bind(JSON.stringify({ ...parseJson(row.payload), alerta: 'valor divergente no PSP' }), txid).run();
                    return json({ txid, status: 'divergente', amount: Number(row.amount) }, 200, headers);
                  }
                  await env.DB.prepare(
                    "UPDATE billing_log SET status = 'pago', paid_at = datetime('now') WHERE txid = ? AND status != 'pago'"
                  ).bind(txid).run();
                  return json({ txid, status: 'pago', amount: Number(row.amount), paidAt: new Date().toISOString() }, 200, headers);
                }
                if (['OVERDUE', 'REFUNDED', 'CHARGEBACK_REQUESTED', 'CHARGEBACK_DISPUTE'].includes(status)) {
                  const next = status === 'OVERDUE' ? 'expirado' : 'divergente';
                  await env.DB.prepare('UPDATE billing_log SET status = ? WHERE txid = ?').bind(next, txid).run();
                  return json({ txid, status: next, amount: Number(row.amount) }, 200, headers);
                }
              }
            } catch (e) { /* mantém pendente */ }
          }
          return json({ txid, status: row.status, amount: Number(row.amount), paidAt: row.paid_at }, 200, headers);
        }

        if (path === '/api/billing/webhook' && method === 'POST') {
          const token = request.headers.get('asaas-access-token') || '';
          if (!env.ASAAS_WEBHOOK_TOKEN || !safeEqual(token, env.ASAAS_WEBHOOK_TOKEN)) {
            return json({ error: 'Token de webhook inválido' }, 401, headers);
          }
          const event = await request.json().catch(() => null);
          if (!event) return json({ error: 'JSON inválido' }, 400, headers);
          const payment = event.payment || event;
          const providerId = String(payment.id || payment.paymentId || '');
          const eventName = String(event.event || '');
          if (!providerId) return json({ ok: true, ignored: true }, 200, headers);
          if (!env.DB) return json({ error: 'D1 não configurado' }, 503, headers);
          const row = await env.DB.prepare('SELECT * FROM billing_log WHERE provider_id = ?').bind(providerId).first();
          if (!row) return json({ ok: true, ignored: true }, 200, headers);
          if (row.status === 'pago') return json({ ok: true, duplicate: true }, 200, headers);
          if (!['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED'].includes(eventName)) {
            return json({ ok: true, ignored: true, event: eventName || 'sem-confirmacao' }, 200, headers);
          }
          const value = Number(payment.value ?? payment.netValue);
          if (!Number.isFinite(value) || Math.abs(value - Number(row.amount)) > 0.01) {
            return json({ error: 'Valor divergente — pagamento não confirmado' }, 422, headers);
          }
          await env.DB.prepare(
            "UPDATE billing_log SET status = 'pago', paid_at = datetime('now') WHERE provider_id = ? AND status != 'pago'"
          ).bind(providerId).run();
          return json({ ok: true }, 200, headers);
        }

        if (path === '/api/billing/overview' && method === 'GET') {
          if (!env.DB) return json({ charges: [], provider: '' }, 200, headers);
          const month = String(url.searchParams.get('month') || billingPeriodNow()).slice(0, 7);
          const { results } = await env.DB.prepare(
            `SELECT txid, account_id, amount, plan, period, status, provider, created_at, paid_at
             FROM billing_log WHERE period = ? ORDER BY created_at DESC LIMIT 200`
          ).bind(month).all();
          return json({
            month,
            provider: env.ASAAS_API_KEY ? 'asaas' : '',
            charges: results.map((row) => ({
              txid: row.txid,
              accountId: row.account_id,
              amount: Number(row.amount),
              plan: row.plan,
              period: row.period,
              status: row.status,
              provider: row.provider,
              createdAt: row.created_at,
              paidAt: row.paid_at
            }))
          }, 200, headers);
        }

        // Emissão de NF (Spedy) — opcional, após configurar SPEDY_API_KEY.
        if (path === '/api/billing/invoice' && method === 'POST') {
          if (!env.SPEDY_API_KEY) {
            return json({ error: 'Emissão de NF não configurada', code: 'NOT_CONFIGURED' }, 409, headers);
          }
          const body = await request.json().catch(() => null);
          const orderId = String(body?.orderId || '').trim();
          if (!orderId) return json({ error: 'orderId do Spedy é obrigatório' }, 400, headers);
          const res = await fetch(`https://api.spedy.com.br/v1/orders/${encodeURIComponent(orderId)}/invoices/issue`, {
            method: 'POST',
            headers: { 'X-Api-Key': env.SPEDY_API_KEY, 'Content-Type': 'application/json-patch+json' },
            body: JSON.stringify({ effectiveDate: body.effectiveDate || new Date().toISOString() })
          });
          const text = await res.text();
          return new Response(text, { status: res.status, headers });
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

  // Cobrança mensal automática: rode com [triggers] crons no wrangler.toml.
  // Só executa se BILLING_AUTO = "true" e ASAAS_API_KEY estiver configurada.
  async scheduled(event, env, ctx) {
    if (env.BILLING_AUTO !== 'true' || !env.ASAAS_API_KEY || !env.DB) return;
    ctx.waitUntil(runMonthlyBilling(env));
  },
};

/* ==========================================================================
   Assinaturas — planos, Asaas Pix e isenção do proprietário
   ========================================================================== */
const OWNER_DOC = '34259998854';
const BILLING_PLANS = [
  { id: 'base', maxSeats: 30, price: 37.98 },
  { id: 'pro', maxSeats: 120, price: 59.9 },
  { id: 'enterprise', maxSeats: Infinity, price: 99.9 }
];

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers });
}

function safeEqual(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

function onlyDigits(value) {
  return String(value ?? '').replace(/\D+/g, '');
}

function isValidCpf(value) {
  const cpf = onlyDigits(value);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  const digit = (base) => {
    let sum = 0;
    for (let i = 0; i < base.length; i++) sum += Number(base[i]) * (base.length + 1 - i);
    return String((sum * 10) % 11 % 10);
  };
  return digit(cpf.slice(0, 9)) === cpf[9] && digit(cpf.slice(0, 10)) === cpf[10];
}

function isValidCnpj(value) {
  const cnpj = onlyDigits(value);
  if (cnpj.length !== 14 || /^(\d)\1{13}$/.test(cnpj)) return false;
  const digit = (base) => {
    const weights = base.length === 12
      ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
      : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let sum = 0;
    for (let i = 0; i < base.length; i++) sum += Number(base[i]) * weights[i];
    const rest = sum % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  return digit(cnpj.slice(0, 12)) === Number(cnpj[12]) && digit(cnpj.slice(0, 13)) === Number(cnpj[13]);
}

function isValidDoc(doc) {
  const digits = onlyDigits(doc);
  if (digits.length === 14) return isValidCnpj(digits);
  return isValidCpf(digits);
}

function planForSeats(seats) {
  const count = Math.max(1, Number(seats) || 1);
  return BILLING_PLANS.find((plan) => count <= plan.maxSeats) || BILLING_PLANS[BILLING_PLANS.length - 1];
}

function billingPeriodNow() {
  const brt = new Date(Date.now() - 3 * 3600000);
  return `${brt.getUTCFullYear()}-${String(brt.getUTCMonth() + 1).padStart(2, '0')}`;
}

function asaasDueDate() {
  const brt = new Date(Date.now() - 3 * 3600000);
  return `${brt.getUTCFullYear()}-${String(brt.getUTCMonth() + 1).padStart(2, '0')}-${String(brt.getUTCDate()).padStart(2, '0')}`;
}

function parseJson(raw) {
  try { return JSON.parse(raw || '{}') || {}; } catch (e) { return {}; }
}

function billingView(row) {
  const payload = parseJson(row.payload);
  return {
    txid: row.txid,
    amount: Number(row.amount),
    period: row.period,
    plan: row.plan,
    status: row.status,
    provider: row.provider || 'asaas',
    emv: payload.emv || '',
    invoiceUrl: payload.invoiceUrl || '',
    expiresAt: payload.expiresAt || ''
  };
}

async function readAppState(env) {
  if (env.DB) {
    try {
      const row = await env.DB.prepare('SELECT revision, data FROM app_state WHERE id = 1').first();
      if (row && row.data != null) return { revision: Number(row.revision), data: row.data, source: 'd1' };
    } catch (e) { /* tenta o KV */ }
  }
  if (env.AMBARI_KV) {
    try {
      const raw = await env.AMBARI_KV.get('app_state');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.data != null) {
          return { revision: Number(parsed.revision) || 0, data: parsed.data, source: 'kv' };
        }
      }
    } catch (e) { /* sem nuvem */ }
  }
  return null;
}

async function writeAppState(env, revision, data) {
  let wrote = false;
  if (env.DB) {
    try {
      const row = await env.DB.prepare('SELECT revision FROM app_state WHERE id = 1').first();
      if (row) {
        await env.DB.prepare(
          "UPDATE app_state SET revision = ?, data = ?, updated_at = datetime('now') WHERE id = 1"
        ).bind(revision, data).run();
      } else {
        await env.DB.prepare(
          "INSERT INTO app_state (id, revision, data, updated_at) VALUES (1, ?, ?, datetime('now'))"
        ).bind(revision, data).run();
      }
      wrote = true;
    } catch (e) { /* espelho no KV abaixo */ }
  }
  if (env.AMBARI_KV) {
    try {
      await env.AMBARI_KV.put('app_state', JSON.stringify({ revision, data, updatedAt: new Date().toISOString() }));
      wrote = true;
    } catch (e) { /* somente D1 */ }
  }
  return wrote;
}

function asaasEndpoint(env, path) {
  let base = String(env.ASAAS_BASE_URL || 'https://api-sandbox.asaas.com').replace(/\/+$/, '');
  if (!/\/v3$/i.test(base)) base += '/v3';
  return `${base}${path}`;
}

async function asaasFetch(env, path, options = {}) {
  const res = await fetch(asaasEndpoint(env, path), {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Ambari/1.0',
      access_token: env.ASAAS_API_KEY,
      ...(options.headers || {})
    },
    body: options.body
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

function asaasError(data) {
  const first = data && Array.isArray(data.errors) ? data.errors[0] : null;
  return first ? String(first.description || first.code || '').slice(0, 200) : '';
}

async function createBillingCharge(env, account, period, existingRow = null) {
  const doc = onlyDigits(account.doc);
  const seats = Math.max(1, Math.min(5000, Number(account.seats) || 0));
  const plan = planForSeats(seats);
  const amount = plan.price;

  let existing = existingRow;
  if (!existing) {
    existing = await env.DB.prepare(
      'SELECT * FROM billing_log WHERE account_id = ? AND period = ?'
    ).bind(account.accountId, period).first();
    if (existing) return billingView(existing);
  }

  let customerId = existing && existing.customer_id ? String(existing.customer_id) : '';
  if (!customerId) {
    const last = await env.DB.prepare(
      "SELECT customer_id FROM billing_log WHERE account_id = ? AND customer_id IS NOT NULL AND customer_id != '' ORDER BY created_at DESC LIMIT 1"
    ).bind(account.accountId).first();
    if (last) customerId = String(last.customer_id);
  }
  if (!customerId) {
    const { res, data } = await asaasFetch(env, '/customers', {
      method: 'POST',
      body: JSON.stringify({
        name: account.name,
        email: account.email,
        cpfCnpj: doc,
        externalReference: account.accountId,
        notificationDisabled: false
      })
    });
    if (!res.ok || !data.id) throw new Error(asaasError(data) || 'cliente não criado no Asaas');
    customerId = data.id;
  }

  const { res: payRes, data: payment } = await asaasFetch(env, '/payments', {
    method: 'POST',
    body: JSON.stringify({
      customer: customerId,
      billingType: 'PIX',
      value: Number(amount.toFixed(2)),
      dueDate: asaasDueDate(),
      description: `Assinatura Âmbari · ${account.name} · ${period}`,
      externalReference: `${account.accountId}|${period}`
    })
  });
  if (!payRes.ok || !payment.id) throw new Error(asaasError(payment) || 'cobrança não criada no Asaas');

  let emv = '';
  let expiresAt = '';
  const { res: qrRes, data: qr } = await asaasFetch(env, `/payments/${encodeURIComponent(payment.id)}/pixQrCode`);
  if (qrRes.ok && qr) {
    emv = qr.payload || '';
    expiresAt = qr.expirationDate || '';
  }

  const txid = existing ? existing.txid : `BIL${crypto.randomUUID().replace(/-/g, '').slice(0, 24).toUpperCase()}`;
  const payload = JSON.stringify({ emv, expiresAt, invoiceUrl: payment.invoiceUrl || '', customerId });
  if (existing) {
    await env.DB.prepare(
      `UPDATE billing_log
         SET doc = ?, name = ?, seats = ?, amount = ?, plan = ?, provider = 'asaas',
             provider_id = ?, customer_id = ?, status = 'pendente', payload = ?,
             created_at = datetime('now'), paid_at = NULL
       WHERE txid = ?`
    ).bind(doc, account.name, seats, amount, plan.id, payment.id, customerId, payload, txid).run();
  } else {
    try {
      await env.DB.prepare(
        `INSERT INTO billing_log
           (txid, account_id, doc, name, seats, amount, plan, period, provider, provider_id, customer_id, status, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'asaas', ?, ?, 'pendente', ?, datetime('now'))`
      ).bind(txid, account.accountId, doc, account.name, seats, amount, plan.id, period, payment.id, customerId, payload).run();
    } catch (err) {
      const again = await env.DB.prepare(
        'SELECT * FROM billing_log WHERE account_id = ? AND period = ?'
      ).bind(account.accountId, period).first();
      if (again) return billingView(again);
      throw err;
    }
  }

  return {
    txid, amount, period, plan: plan.id, status: 'pendente', provider: 'asaas',
    emv, expiresAt, invoiceUrl: payment.invoiceUrl || ''
  };
}

async function runMonthlyBilling(env) {
  const state = await readAppState(env);
  if (!state || !state.data) return;
  let parsed;
  try { parsed = JSON.parse(state.data); } catch (e) { return; }
  const accounts = Array.isArray(parsed?.billing?.accounts) ? parsed.billing.accounts : [];
  const period = billingPeriodNow();
  for (const account of accounts) {
    if (!account || account.active === false) continue;
    const doc = onlyDigits(account.doc);
    if (!doc || doc === OWNER_DOC || account.exempt) continue;
    if (!isValidDoc(doc) || !account.name || !account.email) continue;
    const existing = await env.DB.prepare(
      'SELECT txid FROM billing_log WHERE account_id = ? AND period = ?'
    ).bind(account.id, period).first();
    if (existing) continue;
    try {
      await createBillingCharge(env, {
        accountId: account.id, name: account.name, email: account.email, doc, seats: account.seats
      }, period);
    } catch (err) { /* segue para o próximo cliente */ }
  }
}

async function hmacSha256Hex(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
