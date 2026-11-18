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
let importMode = 'novo';
let parsedSheetRows = [];
let parsedSheetHeaders = [];
let activeTimelineTarget = { lead_id: null, pessoa_id: null };

// Estado de paginação dos Leads
let leadsPagination = {
  currentPage: 1,
  pageSize: 50
};

let reviewState = {
  activeTab: 'primary',
  toInsert: [],
  duplicates: [],
  matchedUpdates: [],
  unmatchedNew: []
};

// Estado do trabalhador em background para enriquecimento de CNPJ (Load Balance)
let bgEnrichWorker = {
  running: false,
  paused: false,
  cancelled: false,
  queue: [],
  processed: 0,
  success: 0,
  failed: 0,
  providerIndex: 0
};

// ============================================================================
// INICIALIZAÇÃO E AUTENTICAÇÃO
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
  const syncBadge = document.getElementById('db-sync-badge');
  if (syncBadge) {
    syncBadge.innerHTML = '<i class="fa-solid fa-spinner fa-spin text-sky-400"></i> Sincronizando...';
  }

  await Promise.all([loadLeads(), loadPessoas()]);

  if (syncBadge) {
    syncBadge.innerHTML = '<span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span> Conectado ao Supabase';
  }

  populateTagDropdowns();
  renderDashboard();
  renderLeadsTable();
  renderClientes();
}

// ============================================================================
// CARREGAMENTO DE DADOS (COM PAGINAÇÃO AUTOMÁTICA > 1.000 REGISTROS)
// ============================================================================
async function loadLeads() {
  let allLeads = [];
  let from = 0;
  const batchSize = 1000;
  let hasMore = true;

  while (hasMore) {
    const { data, error } = await sb
      .from('crm_leads')
      .select('*')
      .order('criado_em', { ascending: false })
      .range(from, from + batchSize - 1);

    if (error) {
      console.error('Erro ao carregar leads:', error);
      break;
    }

    if (data && data.length > 0) {
      allLeads = allLeads.concat(data);
      from += batchSize;
      if (data.length < batchSize) hasMore = false;
    } else {
      hasMore = false;
    }
  }

  leadsData = allLeads;
  document.getElementById('badge-leads').textContent = leadsData.length;
}

async function loadPessoas() {
  let allPessoas = [];
  let from = 0;
  const batchSize = 1000;
  let hasMore = true;

  while (hasMore) {
    const { data, error } = await sb
      .from('pessoas')
      .select('*')
      .order('criado_em', { ascending: false })
      .range(from, from + batchSize - 1);

    if (error) {
      console.error('Erro ao carregar pessoas:', error);
      break;
    }

    if (data && data.length > 0) {
      allPessoas = allPessoas.concat(data);
      from += batchSize;
      if (data.length < batchSize) hasMore = false;
    } else {
      hasMore = false;
    }
  }

  pessoasData = allPessoas;
  document.getElementById('badge-clientes').textContent = pessoasData.length;
}

function populateTagDropdowns() {
  const tagsSet = new Set();
  let hasSemTag = false;

  leadsData.forEach(l => {
    const t = (l.tag || '').trim().toUpperCase();
    if (t) tagsSet.add(t);
    else hasSemTag = true;
  });

  const sortedTags = Array.from(tagsSet).sort();

  const filterSelect = document.getElementById('lead-filter-tag');
  if (filterSelect) {
    const currentVal = filterSelect.value;
    filterSelect.innerHTML = `<option value="todas">Todas as TAGs (Listas)</option>` +
      sortedTags.map(t => `<option value="${t}">TAG: ${t}</option>`).join('') +
      (hasSemTag ? `<option value="sem_tag">Sem TAG definida</option>` : '');
    if (Array.from(filterSelect.options).some(o => o.value === currentVal)) {
      filterSelect.value = currentVal;
    }
  }

  const exportSelect = document.getElementById('exp-tag-filter');
  if (exportSelect) {
    exportSelect.innerHTML = `<option value="todas">Todas as TAGs</option>` +
      sortedTags.map(t => `<option value="${t}">${t}</option>`).join('') +
      (hasSemTag ? `<option value="sem_tag">Sem TAG</option>` : '');
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
// UTILITÁRIOS DE TELEFONE (9º DÍGITO), LOTES E FORMATAÇÃO
// ============================================================================
function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function onlyDigits(str) {
  return String(str || '').replace(/\D/g, '');
}

function formatCNPJ(cnpj) {
  const d = onlyDigits(cnpj);
  if (d.length !== 14) return cnpj || '';
  return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
}

function normalizePhone(phone) {
  let d = onlyDigits(phone);
  if (!d) return '';
  if (d.length === 10 || d.length === 11) d = '55' + d;
  return d;
}

function formatPhoneNinthDigit(rawPhone, mode = 'keep') {
  const norm = normalizePhone(rawPhone);
  if (!norm || mode === 'keep' || !norm.startsWith('55')) return norm;

  const local = norm.slice(2);
  if (mode === 'add9') {
    if (local.length === 10 && ['6', '7', '8', '9'].includes(local[2])) {
      return '55' + local.slice(0, 2) + '9' + local.slice(2);
    }
    return norm;
  }

  if (mode === 'remove9') {
    if (local.length === 11 && local[2] === '9') {
      return '55' + local.slice(0, 2) + local.slice(3);
    }
    return norm;
  }

  return norm;
}

function getPhoneMatchKeys(rawPhone) {
  const norm = normalizePhone(rawPhone);
  if (!norm) return [];
  const keys = new Set([norm]);

  if (norm.startsWith('55')) {
    const local = norm.slice(2);
    if (local.length === 11 && local[2] === '9') {
      keys.add('55' + local.slice(0, 2) + local.slice(3));
    } else if (local.length === 10 && ['6', '7', '8', '9'].includes(local[2])) {
      keys.add('55' + local.slice(0, 2) + '9' + local.slice(2));
    }
  }
  return Array.from(keys);
}

function buildLeadsLookupIndex() {
  const byPhoneKey = new Map();
  const byCnpj = new Map();

  leadsData.forEach(lead => {
    getPhoneMatchKeys(lead.telefone).forEach(k => {
      if (!byPhoneKey.has(k)) byPhoneKey.set(k, lead);
    });
    const cnpjDigits = onlyDigits(lead.cnpj);
    if (cnpjDigits.length === 14 && !byCnpj.has(cnpjDigits)) {
      byCnpj.set(cnpjDigits, lead);
    }
  });

  return { byPhoneKey, byCnpj };
}

function findMatchingLead(rawPhone, rawCnpj, lookupIndex) {
  const keys = getPhoneMatchKeys(rawPhone);
  for (const k of keys) {
    if (lookupIndex.byPhoneKey.has(k)) {
      const lead = lookupIndex.byPhoneKey.get(k);
      const exactNorm = normalizePhone(rawPhone) === normalizePhone(lead.telefone);
      return {
        lead,
        matchType: exactNorm ? 'Telefone Exato' : 'Telefone (Ajuste 9º dígito)'
      };
    }
  }

  const cnpjDigits = onlyDigits(rawCnpj);
  if (cnpjDigits.length === 14 && lookupIndex.byCnpj.has(cnpjDigits)) {
    return { lead: lookupIndex.byCnpj.get(cnpjDigits), matchType: 'CNPJ' };
  }
  return null;
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

function parseDisparoStatus(rawStatus) {
  const s = String(rawStatus || '').toLowerCase().trim();
  if (s.includes('enviado') || s === 'ok' || s === 'sucesso' || s === 'sent' || s === 'entregue' || s === 'concluido' || s === 'concluído') {
    return 'enviado';
  }
  if (s.includes('erro') || s.includes('falha') || s.includes('invalido') || s.includes('inválido') || s === 'error' || s === 'failed') {
    return 'erro';
  }
  return 'nao_enviado';
}

// ============================================================================
// LOAD BALANCE DE APIS DE CNPJ (BRASILAPI + MINHARECEITA + RECEITAWS)
// ============================================================================
const CNPJ_PROVIDERS = [
  {
    name: 'BrasilAPI',
    fetchFn: async (cnpj) => {
      const res = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`);
      if (res.status === 429) throw new Error('RATE_LIMIT');
      if (!res.ok) return null;
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
  },
  {
    name: 'MinhaReceita',
    fetchFn: async (cnpj) => {
      const res = await fetch(`https://minhareceita.org/${cnpj}`);
      if (res.status === 429) throw new Error('RATE_LIMIT');
      if (!res.ok) return null;
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
        fonte: 'MinhaReceita'
      };
    }
  },
  {
    name: 'ReceitaWS',
    fetchFn: async (cnpj) => {
      const res = await fetch(`https://www.receitaws.com.br/v1/cnpj/${cnpj}`);
      if (res.status === 429) throw new Error('RATE_LIMIT');
      if (!res.ok) return null;
      const d = await res.json();
      if (d.status === 'ERROR') return null;
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
];

async function fetchCNPJLoadBalanced(rawCnpj, preferredStartIdx = null) {
  const cnpj = onlyDigits(rawCnpj);
  if (cnpj.length !== 14) return null;

  const startIdx = preferredStartIdx !== null ? preferredStartIdx % CNPJ_PROVIDERS.length : 0;

  for (let attempt = 0; attempt < CNPJ_PROVIDERS.length; attempt++) {
    const idx = (startIdx + attempt) % CNPJ_PROVIDERS.length;
    const provider = CNPJ_PROVIDERS[idx];
    try {
      const result = await provider.fetchFn(cnpj);
      if (result && result.razao_social) {
        return result;
      }
    } catch (err) {
      console.warn(`[LoadBalance] ${provider.name} indisponível ou 429, alternando...`);
    }
  }
  return null;
}

async function consultarRazaoSocialNoModalLead() {
  const cnpj = document.getElementById('lead-cnpj').value;
  if (onlyDigits(cnpj).length !== 14) {
    return alert('Informe um CNPJ válido com 14 dígitos.');
  }

  const btn = document.getElementById('btn-modal-lead-cnpj');
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';

  const info = await fetchCNPJLoadBalanced(cnpj, bgEnrichWorker.providerIndex++);

  btn.disabled = false;
  btn.innerHTML = '<i class="fa-solid fa-magnifying-glass"></i> Razão';

  if (!info || !info.razao_social) {
    return alert('Não foi possível obter a Razão Social deste CNPJ no momento.');
  }

  document.getElementById('lead-cnpj').value = info.cnpj;
  document.getElementById('lead-razao').value = info.razao_social;
}

async function quickEnrichLeadRazao(leadId) {
  const lead = leadsData.find(l => l.id === leadId);
  if (!lead || onlyDigits(lead.cnpj).length !== 14) return;

  const btnEl = document.getElementById(`btn-enrich-row-${leadId}`);
  if (btnEl) {
    btnEl.disabled = true;
    btnEl.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
  }

  const info = await fetchCNPJLoadBalanced(lead.cnpj, bgEnrichWorker.providerIndex++);

  if (info && info.razao_social) {
    await sb.from('crm_leads').update({ razao_social: info.razao_social }).eq('id', leadId);
    lead.razao_social = info.razao_social;
    renderLeadsTable();
  } else {
    if (btnEl) {
      btnEl.disabled = false;
      btnEl.innerHTML = '<i class="fa-solid fa-bolt"></i>';
    }
    alert('Não foi possível consultar a Razão Social deste CNPJ agora.');
  }
}

// ============================================================================
// ENRIQUECIMENTO EM MASSA EM BACKGROUND (COM LOAD BALANCE ANTI-429)
// ============================================================================
function openBulkEnrichModal() {
  updateBulkEnrichCount();
  openModal('modal-bulk-enrich');
}

function getFilteredLeadsForBulkEnrich() {
  const mode = document.getElementById('bulk-enrich-filter').value;
  return leadsData.filter(l => {
    const hasValidCnpj = onlyDigits(l.cnpj).length === 14;
