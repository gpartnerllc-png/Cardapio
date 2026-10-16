// Instruções rápidas de integração

// 1. Deploy o worker.js no Cloudflare Workers
// 2. Crie um D1 database e rode o schema SQL comentado no final do worker.js
// 3. Bind o D1 como "DB" no Worker
// 4. Substitua a constante API_BASE nos HTMLs pela URL do seu Worker
//    Ex: const API_BASE = 'https://ambari-api.seu-subdominio.workers.dev';

// No HTML do sistema principal (garçom/admin), troque localStorage por fetch:

async function handleRegister(e) {
  e.preventDefault();
  const body = {
    nome: document.getElementById('reg-nome').value.trim(),
    matricula: document.getElementById('reg-matricula').value.trim(),
    email: document.getElementById('reg-email').value.trim(),
    cargo: document.getElementById('reg-cargo').value
  };
  const res = await fetch(API_BASE + '/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  alert(data.message || data.error || 'Enviado');
  showLogin();
}

async function handleLogin(e) {
  e.preventDefault();
  if (!biometricOk) return alert('Confirme a biometria');
  const matricula = document.getElementById('login-matricula').value.trim();
  const res = await fetch(API_BASE + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ matricula })
  });
  if (!res.ok) return alert('Credencial inválida ou pendente');
  currentUser = await res.json();
  // ... resto igual (mostrar app, renderTabs etc)
}

// No cardápio do cliente, ao confirmar pedido:
async function enviarPedidoCliente() {
  if (!currentTable || !cart.length) return alert('Selecione mesa e adicione itens');
  const res = await fetch(API_BASE + '/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mesa: currentTable,
      posicao: document.getElementById('order-posicao')?.value || '',
      items: cart,
      obs: document.getElementById('order-obs')?.value || ''
    })
  });
  if (res.ok) {
    alert('Pedido enviado! O garçom irá confirmar e enviar para a cozinha/bar.');
    cart = [];
    updateCartUI();
  }
}

// Garçom busca pendentes a cada poucos segundos:
async function carregarPendentes() {
  const res = await fetch(API_BASE + '/api/orders/pending');
  const orders = await res.json();
  // renderizar lista com botões Aceitar e Mudar Mesa
}

// Relatório antes de cobrar:
async function verRelatorioMesa(mesa) {
  const res = await fetch(API_BASE + `/api/bill/${encodeURIComponent(mesa)}`);
  const bill = await res.json();
  // Mostrar modal detalhado: itens, subtotal, 10% taxa, total, hora, etc.
  console.log(bill);
}
