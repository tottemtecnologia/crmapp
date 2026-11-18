// ============================================================================
// CONFIGURAÇÃO SUPABASE (Insira as credenciais do seu projeto)
// ============================================================================
const SUPABASE_URL = 'https://nrgllzzdemuuaigcjsht.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_Z1nBzTFVax9QWVbc3_gcwA_u8ZrHSc2';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Estado global
let leadsData = [];
let pessoasData = [];
let currentUser = null;
let clientesViewMode = 'lista';
let importMode = 'novo'; // 'novo' | 'retorno'
let parsedSheetRows = [];
let parsedSheetHeaders = [];
let activeTimelineTarget = { lead_id: null, pessoa_id: null };

// ============================================================================
// INICIALIZAÇÃO E AUTENTICAÇÃO (Usa sua tabela usuarios_admin)
// ============================================================================
document.addEventListener('DOMContentLoaded', () => {
  const saved = localStorage.getItem('tottem_crm_user');
  if (saved) {
    currentUser = JSON.parse(saved);
    showApp();
  }

  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('login-email').value.trim();
    const senha = document.getElementById('login-senha').value.trim();
    const errEl = document.getElementById('login-error');
    errEl.classList.add('hidden');

    const { data, error } = await sb
      .from('usuarios_admin')
      .select('id, nome, email')
      .eq('email', email)
      .eq('senha', senha)
      .maybeSingle();

    if (error || !data) {
      errEl.textContent = 'E-mail ou senha inválidos.';
      errEl.classList.remove('hidden');
      return;
    }

    currentUser = data;
    localStorage.setItem('tottem_crm_user', JSON.stringify(data));
    showApp();
  });

  document.getElementById('lead-status').addEventListener('change', (e) => {
    document.getElementById('lead-erro-box').classList.toggle('hidden', e.target.value !== 'erro');
  });
});

function showApp() {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app-shell').classList.remove('hidden');
  document.getElementById('user-logged-name').textContent = currentUser.nome || currentUser.email;
  refreshAll();
}

function logout() {
  localStorage.removeItem('tottem_crm_user');
  location.reload();
}

async function refreshAll() {
  await Promise.all([loadLeads(), loadPessoas()]);
  renderDashboard();
  renderLeadsTable();
  renderClientes();
}

// ============================================================================
// CARREGAMENTO DE DADOS
// ============================================================================
async function loadLeads() {
  const { data, error } = await sb
    .from('crm_leads')
    .select('*')
    .order('criado_em', { ascending: false });

  if (!error) {
    leadsData = data || [];
    document.getElementById('badge-leads').textContent = leadsData.length;
  }
}

async function loadPessoas() {
  const { data, error } = await sb
    .from('pessoas')
    .select('*')
    .order('criado_em', { ascending: false });

  if (!error) {
    pessoasData = data || [];
    document.getElementById('badge-clientes').textContent = pessoasData.length;
  }
}

// ============================================================================
// NAVEGAÇÃO ENTRE ABAS
// ============================================================================
function switchTab(tabName) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
  document.getElementById(`tab-${tabName}`).classList.remove('hidden');

  document.querySelectorAll('.nav-btn').forEach(btn => {
    const active = btn.dataset.tab === tabName;
    btn.className = active
      ? 'nav-btn w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-sm font-medium transition bg-brandBlue text-white'
      : 'nav-btn w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-sm font-medium text-slate-300 hover:bg-bgInput transition';
  });

  const titles = {
    dashboard: 'Dashboard Geral',
    leads: 'Gestão de Leads & Disparos WhatsApp',
    clientes: 'Clientes & Funil de Conversão'
  };
  document.getElementById('page-title').textContent = titles[tabName];
}

// ============================================================================
// UTILITÁRIOS DE FORMATAÇÃO E LIMPEZA
// ============================================================================
function onlyDigits(str) {
  return String(str || '').replace(/\D/g, '');
}

function formatCNPJ(cnpj) {
  const d = onlyDigits(cnpj);
  if (d.length !== 14) return cnpj || '-';
  return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
}

function normalizePhone(phone) {
  let d = onlyDigits(phone);
  if (!d) return '';
  if (d.length === 10 || d.length === 11) d = '55' + d;
  return d;
}

function formatDateBR(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleDateString('pt-BR');
}

function getDiasTesteInfo(criadoEm) {
  const start = new Date(criadoEm);
  const now = new Date();
  const diffDays = Math.floor((now - start) / (1000 * 60 * 60 * 24));
  const restantes = 7 - diffDays;
  return { diffDays, restantes, vencido: restantes < 0 };
}

function normalizeStatusVenda(raw) {
  const s = (raw || '').toLowerCase().trim();
  if (s === 'comprou' || s === 'convertido') return 'comprou';
  if (s === 'nao_comprou' || s === 'não comprou' || s === 'perdido') return 'nao_comprou';
  return 'testando';
}

// ============================================================================
// CONSULTA CNPJ (BRASILAPI + FALLBACK RECEITAWS + EXTRAÇÃO QSA)
// ============================================================================
async function fetchCNPJData(rawCnpj) {
  const cnpj = onlyDigits(rawCnpj);
  if (cnpj.length !== 14) {
    alert('Informe um CNPJ válido com 14 dígitos.');
    return null;
  }

  // 1. Tenta BrasilAPI primeiro
  try {
    const res = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`);
    if (res.ok) {
      const d = await res.json();
      const socioQSA = Array.isArray(d.qsa) && d.qsa.length > 0 ? d.qsa[0].nome_socio : '';
      return {
        cnpj: formatCNPJ(cnpj),
        razao_social: d.razao_social || '',
        nome_fantasia: d.nome_fantasia || socioQSA || '',
        socio_qsa: socioQSA,
        email: (d.email || '').toLowerCase(),
        telefone: normalizePhone(d.ddd_telefone_1 || ''),
        cep: onlyDigits(d.cep || ''),
        logradouro: d.logradouro || '',
        numero: d.numero || '',
        bairro: d.bairro || '',
        cidade: d.municipio || '',
        estado: d.uf || '',
        fonte: 'BrasilAPI'
      };
    }
  } catch (e) {
    console.warn('BrasilAPI falhou, tentando ReceitaWS...', e);
  }

  // 2. Fallback automático para ReceitaWS
  try {
    const resRW = await fetch(`https://www.receitaws.com.br/v1/cnpj/${cnpj}`);
    if (resRW.ok) {
      const d = await resRW.json();
      if (d.status !== 'ERROR') {
        const socioQSA = Array.isArray(d.qsa) && d.qsa.length > 0 ? d.qsa[0].nome : '';
        return {
          cnpj: formatCNPJ(cnpj),
          razao_social: d.nome || '',
          nome_fantasia: d.fantasia || socioQSA || '',
          socio_qsa: socioQSA,
          email: (d.email || '').toLowerCase(),
          telefone: normalizePhone((d.telefone || '').split('/')[0]),
          cep: onlyDigits(d.cep || ''),
          logradouro: d.logradouro || '',
          numero: d.numero || '',
          bairro: d.bairro || '',
          cidade: d.municipio || '',
          estado: d.uf || '',
          fonte: 'ReceitaWS'
        };
      }
    }
  } catch (e) {
    console.error('ReceitaWS também falhou:', e);
  }

  alert('Não foi possível consultar este CNPJ na BrasilAPI nem na ReceitaWS no momento.');
  return null;
}

async function consultarCNPJParaLead() {
  const cnpj = document.getElementById('lead-cnpj').value;
  const info = await fetchCNPJData(cnpj);
  if (!info) return;

  document.getElementById('lead-cnpj').value = info.cnpj;
  if (info.razao_social) document.getElementById('lead-razao').value = info.razao_social;
  if (info.socio_qsa) document.getElementById('lead-contato').value = info.socio_qsa;
  if (info.email && !document.getElementById('lead-email').value) document.getElementById('lead-email').value = info.email;
  if (info.telefone && !document.getElementById('lead-telefone').value) document.getElementById('lead-telefone').value = info.telefone;
}

async function consultarCNPJParaCliente() {
  const btn = document.getElementById('btn-busca-cnpj-cli');
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Buscando...';

  const cnpj = document.getElementById('cli-cnpj').value;
  const info = await fetchCNPJData(cnpj);

  btn.disabled = false;
  btn.innerHTML = '<i class="fa-solid fa-bolt"></i> Consultar CNPJ';

  if (!info) return;

  document.getElementById('cli-cnpj').value = info.cnpj;
  document.getElementById('cli-razao').value = info.razao_social;
  document.getElementById('cli-fantasia').value = info.nome_fantasia || info.socio_qsa;
  if (info.telefone && !document.getElementById('cli-telefone').value) document.getElementById('cli-telefone').value = info.telefone;
  if (info.email && !document.getElementById('cli-email').value) document.getElementById('cli-email').value = info.email;
  document.getElementById('cli-cep').value = info.cep;
  document.getElementById('cli-logradouro').value = info.logradouro;
  document.getElementById('cli-numero').value = info.numero;
  document.getElementById('cli-bairro').value = info.bairro;
  document.getElementById('cli-cidade').value = info.cidade;
  document.getElementById('cli-estado').value = info.estado;
}

// ============================================================================
// DASHBOARD
// ============================================================================
function renderDashboard() {
  const totalLeads = leadsData.length;
  const naoEnviados = leadsData.filter(l => l.status === 'nao_enviado').length;
  const enviados = leadsData.filter(l => l.status === 'enviado').length;
  const erros = leadsData.filter(l => l.status === 'erro').length;

  const testandoList = pessoasData.filter(p => normalizeStatusVenda(p.status_venda) === 'testando');
  const vencidosList = testandoList.filter(p => getDiasTesteInfo(p.criado_em).vencido);
  const comprouCount = pessoasData.filter(p => normalizeStatusVenda(p.status_venda) === 'comprou').length;
  const naoComprouCount = pessoasData.filter(p => normalizeStatusVenda(p.status_venda) === 'nao_comprou').length;

  const totalFinalizados = comprouCount + naoComprouCount;
  const taxa = totalFinalizados > 0 ? Math.round((comprouCount / totalFinalizados) * 100) : 0;

  document.getElementById('kpi-leads-total').textContent = totalLeads;
  document.getElementById('kpi-leads-pendentes').textContent = `${naoEnviados} não enviados`;
  document.getElementById('kpi-leads-enviados').textContent = enviados;
  document.getElementById('kpi-leads-erros').textContent = `${erros} com erro`;
  document.getElementById('kpi-testando').textContent = testandoList.length;
  document.getElementById('kpi-vencidos').textContent = vencidosList.length;
  document.getElementById('kpi-comprou').textContent = comprouCount;
  document.getElementById('kpi-taxa-conversao').textContent = `${taxa}% conversão`;
  document.getElementById('kpi-nao-comprou').textContent = naoComprouCount;

  // Lista de Testes Vencidos
  const vencidosEl = document.getElementById('dash-vencidos-list');
  if (vencidosList.length === 0) {
    vencidosEl.innerHTML = '<p class="text-slate-500 text-xs">Nenhum cliente com teste vencido.</p>';
  } else {
    vencidosEl.innerHTML = vencidosList.map(p => {
      const info = getDiasTesteInfo(p.criado_em);
      return `
        <div class="flex items-center justify-between bg-bgInput/60 border border-rose-500/20 rounded-lg px-3.5 py-2.5">
          <div>
            <div class="font-semibold text-white text-xs">${p.razao_social || p.cnpj}</div>
            <div class="text-[11px] text-slate-400">Vencido há ${Math.abs(info.restantes)} dia(s)</div>
          </div>
          <div class="flex gap-1.5">
            <button onclick="quickSetClienteStatus('${p.id}', 'comprou')" class="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded text-[11px] font-semibold">$ Comprou</button>
            <button onclick="quickSetClienteStatus('${p.id}', 'nao_comprou')" class="px-2.5 py-1 bg-slate-700 hover:bg-rose-600 text-white rounded text-[11px]">Perdido</button>
          </div>
        </div>
      `;
    }).join('');
  }

  // Performance por Cupom
  const cuponsMap = {};
  pessoasData.forEach(p => {
    const c = (p.cupom || 'SEM CUPOM').toUpperCase();
    if (!cuponsMap[c]) cuponsMap[c] = { total: 0, comprou: 0 };
    cuponsMap[c].total++;
    if (normalizeStatusVenda(p.status_venda) === 'comprou') cuponsMap[c].comprou++;
  });

  const cuponsEl = document.getElementById('dash-cupons-list');
  const entries = Object.entries(cuponsMap);
  if (entries.length === 0) {
    cuponsEl.innerHTML = '<p class="text-slate-500 text-xs">Nenhum cupom registrado.</p>';
  } else {
    cuponsEl.innerHTML = entries.map(([cupom, stats]) => `
      <div class="flex items-center justify-between bg-bgInput/60 border border-borderCard rounded-lg px-3.5 py-2">
        <span class="text-xs font-bold text-brandBlue bg-brandBlue/10 border border-brandBlue/30 px-2.5 py-0.5 rounded">${cupom}</span>
        <span class="text-xs text-slate-300"><strong>${stats.comprou}</strong> vendas de ${stats.total} clientes</span>
      </div>
    `).join('');
  }
}

// ============================================================================
// CRUD E RENDERIZAÇÃO DE LEADS
// ============================================================================
function renderLeadsTable() {
  const term = document.getElementById('lead-search').value.toLowerCase();
  const statusFilter = document.getElementById('lead-filter-status').value;

  const filtered = leadsData.filter(l => {
    const matchText =
      (l.razao_social || '').toLowerCase().includes(term) ||
      (l.nome_contato || '').toLowerCase().includes(term) ||
      (l.telefone || '').includes(term) ||
      (l.cnpj || '').includes(term);

    if (!matchText) return false;
    if (statusFilter === 'todos') return true;
    if (statusFilter === 'convertido') return Boolean(l.pessoa_id);
    return l.status === statusFilter;
  });

  document.getElementById('leads-count-label').textContent = `Mostrando ${filtered.length} registros`;

  const tbody = document.getElementById('leads-table-body');
  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="py-8 text-center text-xs text-slate-500">Nenhum lead encontrado.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(l => {
    const statusBadges = {
      nao_enviado: '<span class="px-2.5 py-1 rounded-full text-[11px] font-medium bg-slate-800 text-slate-300 border border-slate-700">Não Enviado</span>',
      enviado: '<span class="px-2.5 py-1 rounded-full text-[11px] font-medium bg-sky-950 text-sky-400 border border-sky-700/50">Enviado</span>',
      erro: `<span class="px-2.5 py-1 rounded-full text-[11px] font-medium bg-rose-950 text-rose-400 border border-rose-700/50" title="${l.motivo_erro || ''}">Erro</span>`
    };

    const waUrl = `https://wa.me/${onlyDigits(l.telefone)}`;

    return `
      <tr class="hover:bg-bgInput/40 transition">
        <td class="py-3.5 px-4">
          <div class="font-semibold text-white text-xs">${l.razao_social || l.nome_contato || 'Sem Nome'}</div>
          ${l.nome_contato && l.razao_social ? `<div class="text-[11px] text-slate-400">Contato: ${l.nome_contato}</div>` : ''}
        </td>
        <td class="py-3.5 px-4 text-xs text-slate-300 font-mono">${l.cnpj || '-'}</td>
        <td class="py-3.5 px-4">
          <div class="text-xs text-slate-200 flex items-center gap-2">
            ${l.telefone}
            <a href="${waUrl}" target="_blank" title="Abrir WhatsApp" class="text-emerald-400 hover:text-emerald-300">
              <i class="fa-brands fa-whatsapp"></i>
            </a>
          </div>
          <div class="text-[11px] text-slate-400">${l.email || ''}</div>
        </td>
        <td class="py-3.5 px-4">
          ${l.cupom ? `<span class="text-[11px] font-bold bg-brandBlue/20 text-blue-300 border border-brandBlue/30 px-2 py-0.5 rounded">${l.cupom}</span>` : '-'}
        </td>
        <td class="py-3.5 px-4 space-y-1">
          <div>${statusBadges[l.status] || l.status}</div>
          ${l.pessoa_id ? '<div><span class="text-[10px] text-emerald-400 font-semibold"><i class="fa-solid fa-check"></i> Convertido p/ Teste</span></div>' : ''}
        </td>
        <td class="py-3.5 px-4 text-right space-x-1.5 whitespace-nowrap">
          ${l.status === 'enviado' && !l.pessoa_id ? `
            <button onclick="convertLeadToTest('${l.id}')"
              class="px-2.5 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-amber-300 text-[11px] font-semibold transition">
              <i class="fa-solid fa-flask mr-1"></i> Iniciar Teste
            </button>
          ` : ''}
          <button onclick="openTimeline({ lead_id: '${l.id}' }, '${(l.razao_social || l.telefone).replace(/'/g, '')}')" title="Notas"
            class="p-1.5 rounded-lg bg-bgInput hover:bg-slate-700 text-slate-300 text-xs">
            <i class="fa-regular fa-comment-dots"></i>
          </button>
          <button onclick="openLeadModal('${l.id}')" title="Editar"
            class="p-1.5 rounded-lg bg-bgInput hover:bg-slate-700 text-sky-400 text-xs">
            <i class="fa-solid fa-pen"></i>
          </button>
          <button onclick="deleteLead('${l.id}')" title="Excluir"
            class="p-1.5 rounded-lg bg-bgInput hover:bg-rose-950 text-rose-400 text-xs">
            <i class="fa-solid fa-trash"></i>
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

function openLeadModal(id = null) {
  document.getElementById('lead-form').reset();
  document.getElementById('lead-id').value = '';
  document.getElementById('lead-erro-box').classList.add('hidden');

  if (id) {
    const l = leadsData.find(x => x.id === id);
    if (!l) return;
    document.getElementById('lead-modal-title').textContent = 'Editar Lead';
    document.getElementById('lead-id').value = l.id;
    document.getElementById('lead-cnpj').value = l.cnpj || '';
    document.getElementById('lead-telefone').value = l.telefone || '';
    document.getElementById('lead-razao').value = l.razao_social || '';
    document.getElementById('lead-contato').value = l.nome_contato || '';
    document.getElementById('lead-email').value = l.email || '';
    document.getElementById('lead-cupom').value = l.cupom || '';
    document.getElementById('lead-status').value = l.status || 'nao_enviado';
    document.getElementById('lead-motivo-erro').value = l.motivo_erro || '';
    if (l.status === 'erro') document.getElementById('lead-erro-box').classList.remove('hidden');
  } else {
    document.getElementById('lead-modal-title').textContent = 'Novo Lead Manual';
  }

  openModal('modal-lead');
}

async function saveLead(e) {
  e.preventDefault();
  const id = document.getElementById('lead-id').value;
  const payload = {
    cnpj: document.getElementById('lead-cnpj').value.trim() ? formatCNPJ(document.getElementById('lead-cnpj').value) : null,
    telefone: normalizePhone(document.getElementById('lead-telefone').value),
    razao_social: document.getElementById('lead-razao').value.trim() || null,
    nome_contato: document.getElementById('lead-contato').value.trim() || null,
    email: document.getElementById('lead-email').value.trim().toLowerCase() || null,
    cupom: document.getElementById('lead-cupom').value.trim().toUpperCase() || null,
    status: document.getElementById('lead-status').value,
    motivo_erro: document.getElementById('lead-status').value === 'erro' ? document.getElementById('lead-motivo-erro').value.trim() : null
  };

  if (id) {
    await sb.from('crm_leads').update(payload).eq('id', id);
  } else {
    await sb.from('crm_leads').insert([payload]);
  }

  closeModal('modal-lead');
  await refreshAll();
}

async function deleteLead(id) {
  if (!confirm('Deseja realmente excluir este Lead?')) return;
  await sb.from('crm_leads').delete().eq('id', id);
  await refreshAll();
}

// ============================================================================
// CONVERSÃO DE LEAD ENVIADO -> TABELA PESSOAS (TESTANDO)
// ============================================================================
async function convertLeadToTest(leadId) {
  const lead = leadsData.find(l => l.id === leadId);
  if (!lead) return;

  openClienteModal(null, lead);
  if (lead.cnpj && onlyDigits(lead.cnpj).length === 14) {
    await consultarCNPJParaCliente();
  }
}

// ============================================================================
// CRUD E FUNIL DE CLIENTES (TABELA PESSOAS)
// ============================================================================
function setClientesView(mode) {
  clientesViewMode = mode;
  document.getElementById('clientes-view-lista').classList.toggle('hidden', mode !== 'lista');
  document.getElementById('clientes-view-kanban').classList.toggle('hidden', mode !== 'kanban');

  document.getElementById('btn-view-lista').className = mode === 'lista'
    ? 'px-3 py-1 rounded-md bg-brandBlue text-white font-medium'
    : 'px-3 py-1 rounded-md text-slate-400 hover:text-white font-medium';

  document.getElementById('btn-view-kanban').className = mode === 'kanban'
    ? 'px-3 py-1 rounded-md bg-brandBlue text-white font-medium'
    : 'px-3 py-1 rounded-md text-slate-400 hover:text-white font-medium';
}

function renderClientes() {
  const term = document.getElementById('cliente-search').value.toLowerCase();
  const statusFilter = document.getElementById('cliente-filter-status').value;

  const filtered = pessoasData.filter(p => {
    const st = normalizeStatusVenda(p.status_venda);
    if (statusFilter !== 'todos' && st !== statusFilter) return false;

    return (
      (p.razao_social || '').toLowerCase().includes(term) ||
      (p.nome_fantasia || '').toLowerCase().includes(term) ||
      (p.cnpj || '').includes(term) ||
      (p.motivo_perda || '').toLowerCase().includes(term)
    );
  });

  // Render Lista
  const tbody = document.getElementById('clientes-table-body');
  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="py-8 text-center text-xs text-slate-500">Nenhum cliente encontrado.</td></tr>`;
  } else {
    tbody.innerHTML = filtered.map(p => {
      const st = normalizeStatusVenda(p.status_venda);
      const dias = getDiasTesteInfo(p.criado_em);

      let badgeHtml = '';
      if (st === 'comprou') {
        badgeHtml = `<span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-950 text-emerald-400 border border-emerald-700/50">
          <i class="fa-regular fa-circle-check"></i> Comprou (Convertido)
        </span>`;
      } else if (st === 'nao_comprou') {
        badgeHtml = `<span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-rose-950 text-rose-400 border border-rose-700/50">
          <i class="fa-regular fa-circle-xmark"></i> Não Comprou
        </span>
        ${p.motivo_perda ? `<div class="text-[11px] text-slate-400 mt-1">Motivo: ${p.motivo_perda}</div>` : ''}`;
      } else {
        const label = dias.vencido ? `Vencido (+${Math.abs(dias.restantes)}d)` : `Em Teste (Restam ${dias.restantes}d)`;
        const colorCls = dias.vencido
          ? 'bg-rose-950 text-rose-400 border-rose-700/50'
          : 'bg-amber-950/80 text-amber-300 border-amber-600/40';
        badgeHtml = `<span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold border ${colorCls}">
          <i class="fa-regular fa-clock"></i> ${label}
        </span>`;
      }

      return `
        <tr class="hover:bg-bgInput/40 transition">
          <td class="py-4 px-4">
            <div class="font-bold text-white text-xs uppercase">${p.razao_social || 'Sem Razão Social'}</div>
            ${p.nome_fantasia ? `<div class="text-[11px] text-slate-400">${p.nome_fantasia}</div>` : ''}
          </td>
          <td class="py-4 px-4">
            <div class="text-xs text-slate-200 font-mono">${p.cnpj || '-'}</div>
            <div class="text-[11px] text-slate-400">${p.email || ''} ${p.telefone ? `| ${p.telefone}` : ''}</div>
          </td>
          <td class="py-4 px-4">
            ${p.cupom ? `<span class="text-[11px] font-bold bg-slate-800 text-slate-200 border border-slate-700 px-2.5 py-1 rounded-full">${p.cupom}</span>` : '-'}
          </td>
          <td class="py-4 px-4 text-xs text-slate-300">${formatDateBR(p.criado_em)}</td>
          <td class="py-4 px-4">${badgeHtml}</td>
          <td class="py-4 px-4 text-right space-x-1.5 whitespace-nowrap">
            ${st === 'testando' ? `
              <button onclick="quickSetClienteStatus('${p.id}', 'comprou')"
                class="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold transition">
                $ Comprou
              </button>
              <button onclick="quickSetClienteStatus('${p.id}', 'nao_comprou')"
                class="px-3 py-1.5 rounded-lg bg-bgInput hover:bg-rose-950 border border-borderCard text-slate-300 hover:text-rose-300 text-xs transition">
                ✕ Não Comprou
              </button>
            ` : ''}
            <button onclick="openTimeline({ pessoa_id: '${p.id}' }, '${(p.razao_social || p.cnpj).replace(/'/g, '')}')" title="Notas"
              class="p-1.5 rounded-lg bg-bgInput hover:bg-slate-700 text-slate-300 text-xs">
              <i class="fa-regular fa-comment-dots"></i>
            </button>
            <button onclick="openClienteModal('${p.id}')" title="Editar"
              class="p-1.5 rounded-lg bg-bgInput hover:bg-slate-700 text-sky-400 text-xs">
              <i class="fa-solid fa-pen"></i>
            </button>
            <button onclick="deleteCliente('${p.id}')" title="Excluir"
              class="p-1.5 rounded-lg bg-bgInput hover:bg-rose-950 text-rose-400 text-xs">
              <i class="fa-solid fa-trash"></i>
            </button>
          </td>
        </tr>
      `;
    }).join('');
  }

  // Render Kanban
  ['testando', 'comprou', 'nao_comprou'].forEach(col => {
    const items = filtered.filter(p => normalizeStatusVenda(p.status_venda) === col);
    document.getElementById(`kanban-count-${col}`).textContent = items.length;
    document.getElementById(`kanban-col-${col}`).innerHTML = items.map(p => {
      const dias = getDiasTesteInfo(p.criado_em);
      return `
        <div class="bg-bgInput/80 border border-borderCard hover:border-brandBlue/60 rounded-xl p-3.5 space-y-2.5 transition">
          <div class="flex justify-between items-start gap-2">
            <div class="font-bold text-xs text-white leading-snug">${p.razao_social || p.cnpj}</div>
            ${p.cupom ? `<span class="text-[10px] font-bold bg-brandBlue/20 text-blue-300 px-2 py-0.5 rounded shrink-0">${p.cupom}</span>` : ''}
          </div>
          <div class="text-[11px] text-slate-400 font-mono">${p.cnpj || ''}</div>
          ${col === 'testando' ? `
            <div class="text-[11px] font-semibold ${dias.vencido ? 'text-rose-400' : 'text-amber-300'}">
              <i class="fa-regular fa-clock mr-1"></i> ${dias.vencido ? `Vencido há ${Math.abs(dias.restantes)}d` : `Restam ${dias.restantes} dias`}
            </div>
          ` : ''}
          ${p.motivo_perda && col === 'nao_comprou' ? `<div class="text-[11px] text-rose-300/80">Motivo: ${p.motivo_perda}</div>` : ''}
          <div class="pt-2 border-t border-borderCard/60 flex items-center justify-between">
            <div class="flex gap-1">
              ${col !== 'comprou' ? `<button onclick="quickSetClienteStatus('${p.id}', 'comprou')" class="text-[10px] bg-emerald-600/80 hover:bg-emerald-600 text-white px-2 py-1 rounded">Comprou</button>` : ''}
              ${col !== 'nao_comprou' ? `<button onclick="quickSetClienteStatus('${p.id}', 'nao_comprou')" class="text-[10px] bg-slate-700 hover:bg-rose-600 text-white px-2 py-1 rounded">Não Comprou</button>` : ''}
            </div>
            <button onclick="openClienteModal('${p.id}')" class="text-xs text-slate-400 hover:text-white"><i class="fa-solid fa-pen"></i></button>
          </div>
        </div>
      `;
    }).join('');
  });
}

function toggleMotivoPerdaField() {
  const st = document.getElementById('cli-status').value;
  document.getElementById('cli-motivo-perda-box').classList.toggle('hidden', st !== 'nao_comprou');
}

function openClienteModal(id = null, fromLead = null) {
  document.getElementById('cliente-form').reset();
  document.getElementById('cliente-id').value = '';
  document.getElementById('cliente-from-lead-id').value = '';
  document.getElementById('cli-motivo-perda-box').classList.add('hidden');

  if (id) {
    const p = pessoasData.find(x => x.id === id);
    if (!p) return;
    document.getElementById('cliente-modal-title').textContent = 'Editar Cliente (Pessoas)';
    document.getElementById('cliente-id').value = p.id;
    document.getElementById('cli-cnpj').value = p.cnpj || '';
    document.getElementById('cli-status').value = normalizeStatusVenda(p.status_venda);
    document.getElementById('cli-razao').value = p.razao_social || '';
    document.getElementById('cli-fantasia').value = p.nome_fantasia || '';
    document.getElementById('cli-telefone').value = p.telefone || '';
    document.getElementById('cli-email').value = p.email || '';
    document.getElementById('cli-cupom').value = p.cupom || '';
    document.getElementById('cli-cep').value = p.cep || '';
    document.getElementById('cli-logradouro').value = p.logradouro || '';
    document.getElementById('cli-numero').value = p.numero || '';
    document.getElementById('cli-bairro').value = p.bairro || '';
    document.getElementById('cli-cidade').value = p.cidade || '';
    document.getElementById('cli-estado').value = p.estado || '';
    document.getElementById('cli-motivo-perda').value = p.motivo_perda || '';
    toggleMotivoPerdaField();
  } else if (fromLead) {
    document.getElementById('cliente-modal-title').textContent = 'Converter Lead para Teste (Pessoas)';
    document.getElementById('cliente-from-lead-id').value = fromLead.id;
    document.getElementById('cli-cnpj').value = fromLead.cnpj || '';
    document.getElementById('cli-razao').value = fromLead.razao_social || '';
    document.getElementById('cli-fantasia').value = fromLead.nome_contato || '';
    document.getElementById('cli-telefone').value = fromLead.telefone || '';
    document.getElementById('cli-email').value = fromLead.email || '';
    document.getElementById('cli-cupom').value = fromLead.cupom || '';
    document.getElementById('cli-status').value = 'testando';
  } else {
    document.getElementById('cliente-modal-title').textContent = 'Novo Cliente (Pessoas)';
  }

  openModal('modal-cliente');
}

async function saveCliente(e) {
  e.preventDefault();
  const id = document.getElementById('cliente-id').value;
  const fromLeadId = document.getElementById('cliente-from-lead-id').value;
  const cnpjFormatted = formatCNPJ(document.getElementById('cli-cnpj').value);
  const statusVenda = document.getElementById('cli-status').value;

  const payload = {
    cnpj: cnpjFormatted,
    razao_social: document.getElementById('cli-razao').value.trim(),
    nome_fantasia: document.getElementById('cli-fantasia').value.trim() || null,
    telefone: normalizePhone(document.getElementById('cli-telefone').value) || null,
    email: document.getElementById('cli-email').value.trim().toLowerCase() || null,
    cupom: document.getElementById('cli-cupom').value.trim().toUpperCase() || null,
    cep: document.getElementById('cli-cep').value.trim() || null,
    logradouro: document.getElementById('cli-logradouro').value.trim() || null,
    numero: document.getElementById('cli-numero').value.trim() || null,
    bairro: document.getElementById('cli-bairro').value.trim() || null,
    cidade: document.getElementById('cli-cidade').value.trim() || null,
    estado: document.getElementById('cli-estado').value.trim().toUpperCase() || null,
    status_venda: statusVenda,
    motivo_perda: statusVenda === 'nao_comprou' ? document.getElementById('cli-motivo-perda').value.trim() : null,
    atualizado_em: new Date().toISOString()
  };

  // Garante existência na tabela clientes caso a Foreign Key (pessoas.cnpj -> clientes.cnpj) exija
  await sb.from('clientes').upsert(
    { cnpj: cnpjFormatted, email: payload.email, telefone: payload.telefone, cupom: payload.cupom },
    { onConflict: 'cnpj' }
  );

  let savedPessoaId = id;
  if (id) {
    const { error } = await sb.from('pessoas').update(payload).eq('id', id);
    if (error) return alert('Erro ao atualizar cliente: ' + error.message);
  } else {
    const { data, error } = await sb.from('pessoas').insert([payload]).select('id').single();
    if (error) return alert('Erro ao cadastrar cliente: ' + error.message);
    savedPessoaId = data.id;
  }

  // Se veio da conversão de um Lead, vincula o pessoa_id no Lead
  if (fromLeadId && savedPessoaId) {
    await sb.from('crm_leads').update({ pessoa_id: savedPessoaId }).eq('id', fromLeadId);
    await sb.from('crm_interacoes').insert([{
      lead_id: fromLeadId,
      pessoa_id: savedPessoaId,
      tipo: 'conversao',
      descricao: 'Lead convertido para cliente em teste (7 dias).'
    }]);
  }

  closeModal('modal-cliente');
  await refreshAll();
}

async function quickSetClienteStatus(id, newStatus) {
  let motivo = null;
  if (newStatus === 'nao_comprou') {
    motivo = prompt('Informe o motivo da não compra (opcional):', 'Não respondeu após teste');
    if (motivo === null) return; // Usuário cancelou
  }

  await sb.from('pessoas').update({
    status_venda: newStatus,
    motivo_perda: newStatus === 'nao_comprou' ? motivo : null,
    atualizado_em: new Date().toISOString()
  }).eq('id', id);

  await sb.from('crm_interacoes').insert([{
    pessoa_id: id,
    tipo: 'status',
    descricao: `Status alterado para: ${newStatus.toUpperCase()}${motivo ? ` (${motivo})` : ''}`
  }]);

  await refreshAll();
}

async function deleteCliente(id) {
  if (!confirm('Deseja excluir este cliente da tabela pessoas?')) return;
  await sb.from('pessoas').delete().eq('id', id);
  await refreshAll();
}

// ============================================================================
// IMPORTAÇÃO VISUAL DE PLANILHAS & EXPORTAÇÃO P/ DISPARADOR
// ============================================================================
function openImportModal(mode) {
  importMode = mode;
  parsedSheetRows = [];
  parsedSheetHeaders = [];
  document.getElementById('import-file-input').value = '';
  document.getElementById('import-preview-container').classList.add('hidden');
  document.getElementById('btn-confirm-import').disabled = true;

  if (mode === 'novo') {
    document.getElementById('import-modal-title').textContent = 'Importar Planilha de Novos Leads';
    document.getElementById('import-cupom-wrapper').classList.remove('hidden');
  } else {
    document.getElementById('import-modal-title').textContent = 'Sincronizar Planilha de Retorno (Enviado / Erro)';
    document.getElementById('import-cupom-wrapper').classList.add('hidden');
  }

  openModal('modal-import');
}

function handleFileSelect(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    const data = new Uint8Array(e.target.result);
    const workbook = XLSX.read(data, { type: 'array' });
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
    const jsonRows = XLSX.utils.sheet_to_json(firstSheet, { defval: '' });

    if (!jsonRows.length) {
      alert('A planilha está vazia.');
      return;
    }

    parsedSheetRows = jsonRows;
    parsedSheetHeaders = Object.keys(jsonRows[0]);
    renderImportPreviewTable();
  };
  reader.readAsArrayBuffer(file);
}

function renderImportPreviewTable() {
  const fieldOptions = importMode === 'novo'
    ? [
        { value: 'ignore', label: '-- Ignorar Coluna --' },
        { value: 'telefone', label: 'Telefone WhatsApp *' },
        { value: 'cnpj', label: 'CNPJ' },
        { value: 'razao_social', label: 'Empresa / Razão Social' },
        { value: 'nome_contato', label: 'Nome do Contato' },
        { value: 'email', label: 'E-mail' },
        { value: 'cupom', label: 'Cupom' }
      ]
    : [
        { value: 'ignore', label: '-- Ignorar Coluna --' },
        { value: 'telefone', label: 'Telefone (Chave Cruzamento) *' },
        { value: 'cnpj', label: 'CNPJ (Chave Alternativa)' },
        { value: 'status', label: 'Status (enviado / erro) *' },
        { value: 'motivo_erro', label: 'Motivo do Erro' }
      ];

  // Auto-detecção inteligente pelo nome do cabeçalho
  const guessField = (header) => {
    const h = header.toLowerCase();
    if (h.includes('tel') || h.includes('cel') || h.includes('whats') || h.includes('fone')) return 'telefone';
    if (h.includes('cnpj')) return 'cnpj';
    if (h.includes('razao') || h.includes('empresa') || h.includes('fantasia')) return 'razao_social';
    if (h.includes('nome') || h.includes('contato') || h.includes('socio')) return 'nome_contato';
    if (h.includes('mail')) return 'email';
    if (h.includes('cupom')) return 'cupom';
    if (importMode === 'retorno' && h.includes('status')) return 'status';
    if (importMode === 'retorno' && (h.includes('erro') || h.includes('motivo'))) return 'motivo_erro';
    return 'ignore';
  };

  const theadHtml = `
    <thead class="bg-bgSidebar border-b border-borderCard">
      <tr>
        ${parsedSheetHeaders.map((h, idx) => {
          const guessed = guessField(h);
          return `
            <th class="p-2.5 min-w-[160px]">
              <div class="text-[10px] text-slate-400 mb-1 truncate" title="${h}">Coluna: ${h}</div>
              <select data-col-idx="${idx}" class="col-mapper w-full bg-bgInput border border-brandBlue/50 rounded px-2 py-1 text-xs text-white font-semibold">
                ${fieldOptions.map(opt => `<option value="${opt.value}" ${opt.value === guessed ? 'selected' : ''}>${opt.label}</option>`).join('')}
              </select>
            </th>
          `;
        }).join('')}
      </tr>
    </thead>
  `;

  const previewRows = parsedSheetRows.slice(0, 5);
  const tbodyHtml = `
    <tbody class="divide-y divide-borderCard/60">
      ${previewRows.map(row => `
        <tr>
          ${parsedSheetHeaders.map(h => `<td class="p-2.5 text-slate-300 truncate max-w-[200px]">${row[h]}</td>`).join('')}
        </tr>
      `).join('')}
    </tbody>
  `;

  document.getElementById('import-preview-table').innerHTML = theadHtml + tbodyHtml;
  document.getElementById('import-rows-summary').textContent = `${parsedSheetRows.length} linhas prontas para processar`;
  document.getElementById('import-preview-container').classList.remove('hidden');
  document.getElementById('btn-confirm-import').disabled = false;
}

async function executeImport() {
  const mappers = Array.from(document.querySelectorAll('.col-mapper'));
  const colMap = {};
  mappers.forEach(sel => {
    if (sel.value !== 'ignore') {
      colMap[sel.value] = parsedSheetHeaders[Number(sel.dataset.colIdx)];
    }
  });

  if (!colMap.telefone && !colMap.cnpj) {
    return alert('Mapeie pelo menos a coluna de Telefone (ou CNPJ).');
  }

  const btn = document.getElementById('btn-confirm-import');
  btn.disabled = true;
  btn.textContent = 'Processando...';

  if (importMode === 'novo') {
    const defaultCupom = document.getElementById('import-default-cupom').value.trim().toUpperCase();
    const existingPhones = new Set(leadsData.map(l => normalizePhone(l.telefone)));
    const toInsert = [];

    parsedSheetRows.forEach(row => {
      const phone = normalizePhone(row[colMap.telefone]);
      if (!phone || existingPhones.has(phone)) return;
      existingPhones.add(phone);

      toInsert.push({
        telefone: phone,
        cnpj: colMap.cnpj && row[colMap.cnpj] ? formatCNPJ(row[colMap.cnpj]) : null,
        razao_social: colMap.razao_social ? String(row[colMap.razao_social]).trim() : null,
        nome_contato: colMap.nome_contato ? String(row[colMap.nome_contato]).trim() : null,
        email: colMap.email ? String(row[colMap.email]).trim().toLowerCase() : null,
        cupom: (colMap.cupom && row[colMap.cupom] ? String(row[colMap.cupom]).trim().toUpperCase() : defaultCupom) || null,
        status: 'nao_enviado'
      });
    });

    if (toInsert.length > 0) {
      await sb.from('crm_leads').insert(toInsert);
    }
    alert(`${toInsert.length} novos leads importados com sucesso! (${parsedSheetRows.length - toInsert.length} duplicados/inválidos ignorados)`);
  } else {
    // Modo Retorno do Disparador
    if (!colMap.status) {
      btn.disabled = false;
      btn.textContent = 'Confirmar Importação';
      return alert('Mapeie a coluna de Status para sincronizar o retorno.');
    }

    let updatedCount = 0;
    for (const row of parsedSheetRows) {
      const phone = colMap.telefone ? normalizePhone(row[colMap.telefone]) : '';
      const rawStatus = String(row[colMap.status] || '').toLowerCase().trim();
      const motivoErro = colMap.motivo_erro ? String(row[colMap.motivo_erro] || '').trim() : '';

      let newStatus = null;
      if (rawStatus.includes('enviado') || rawStatus === 'ok' || rawStatus === 'sucesso') newStatus = 'enviado';
      else if (rawStatus.includes('erro') || rawStatus.includes('falha')) newStatus = 'erro';

      if (!newStatus || !phone) continue;

      const matchLead = leadsData.find(l => normalizePhone(l.telefone) === phone);
      if (matchLead) {
        await sb.from('crm_leads').update({
          status: newStatus,
          motivo_erro: newStatus === 'erro' ? (motivoErro || 'Erro reportado pelo disparador') : null
        }).eq('id', matchLead.id);
        updatedCount++;
      }
    }
    alert(`${updatedCount} leads atualizados com o retorno do disparador!`);
  }

  btn.textContent = 'Confirmar Importação';
  closeModal('modal-import');
  await refreshAll();
}

function exportLeadsForSender() {
  const pendentes = leadsData.filter(l => l.status === 'nao_enviado');
  if (pendentes.length === 0) {
    return alert('Não há leads com status "nao_enviado" para exportar.');
  }

  const rows = pendentes.map(l => ({
    Telefone: l.telefone,
    Nome: l.nome_contato || l.razao_social || '',
    Empresa: l.razao_social || '',
    CNPJ: l.cnpj || '',
    Status: ''
  }));

  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Disparo_WhatsApp');
  XLSX.writeFile(wb, `leads_para_disparo_${new Date().toISOString().slice(0, 10)}.xlsx`);
}

// ============================================================================
// TIMELINE / NOTAS (crm_interacoes)
// ============================================================================
async function openTimeline(target, title) {
  activeTimelineTarget = { lead_id: target.lead_id || null, pessoa_id: target.pessoa_id || null };
  document.getElementById('timeline-title').textContent = title;
  document.getElementById('timeline-subtitle').textContent = target.lead_id ? 'Histórico do Lead' : 'Histórico do Cliente';
  document.getElementById('drawer-timeline').classList.remove('hidden');
  document.getElementById('drawer-timeline').classList.add('flex');
  await loadTimelineNotes();
}

function closeTimeline() {
  document.getElementById('drawer-timeline').classList.add('hidden');
  document.getElementById('drawer-timeline').classList.remove('flex');
}

async function loadTimelineNotes() {
  let query = sb.from('crm_interacoes').select('*').order('criado_em', { ascending: false });
  if (activeTimelineTarget.lead_id) query = query.eq('lead_id', activeTimelineTarget.lead_id);
  if (activeTimelineTarget.pessoa_id) query = query.eq('pessoa_id', activeTimelineTarget.pessoa_id);

  const { data } = await query;
  const listEl = document.getElementById('timeline-list');

  if (!data || data.length === 0) {
    listEl.innerHTML = '<p class="text-xs text-slate-500 text-center py-8">Nenhuma anotação registrada ainda.</p>';
    return;
  }

  listEl.innerHTML = data.map(item => `
    <div class="bg-bgInput/70 border border-borderCard rounded-xl p-3 space-y-1">
      <div class="flex justify-between items-center text-[10px] text-slate-400">
        <span class="uppercase font-bold text-brandBlue">${item.tipo}</span>
        <span>${new Date(item.criado_em).toLocaleString('pt-BR')}</span>
      </div>
      <p class="text-xs text-slate-200 leading-relaxed">${item.descricao}</p>
    </div>
  `).join('');
}

async function addTimelineNote(e) {
  e.preventDefault();
  const input = document.getElementById('timeline-note-input');
  const text = input.value.trim();
  if (!text) return;

  await sb.from('crm_interacoes').insert([{
    lead_id: activeTimelineTarget.lead_id,
    pessoa_id: activeTimelineTarget.pessoa_id,
    tipo: 'nota',
    descricao: text
  }]);

  input.value = '';
  await loadTimelineNotes();
}

// ============================================================================
// CONTROLE DE MODAIS
// ============================================================================
function openModal(id) {
  const el = document.getElementById(id);
  el.classList.remove('hidden');
  el.classList.add('flex');
}

function closeModal(id) {
  const el = document.getElementById(id);
  el.classList.add('hidden');
  el.classList.remove('flex');
}