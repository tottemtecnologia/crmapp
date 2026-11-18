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

  populateTagsDropdowns();
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

// Popula os filtros de TAG na aba Leads e no modal de Exportação
function populateTagsDropdowns() {
  const uniqueTags = Array.from(
    new Set(
      leadsData
        .map(l => (l.tag || '').trim().toUpperCase())
        .filter(Boolean)
    )
  ).sort();

  const filterSelect = document.getElementById('lead-filter-tag');
  const exportSelect = document.getElementById('exp-tag-filter');

  const currentFilterVal = filterSelect ? filterSelect.value : 'todas';

  if (filterSelect) {
    filterSelect.innerHTML =
      `<option value="todas">Todas as TAGs (Listas)</option>` +
      `<option value="sem_tag">Sem TAG definida</option>` +
      uniqueTags.map(t => `<option value="${t}">${t}</option>`).join('');
    filterSelect.value = uniqueTags.includes(currentFilterVal) || currentFilterVal === 'sem_tag' ? currentFilterVal : 'todas';
  }

  if (exportSelect) {
    exportSelect.innerHTML =
      `<option value="">Todas as TAGs</option>` +
      uniqueTags.map(t => `<option value="${t}">${t}</option>`).join('');
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
    if (!hasValidCnpj) return false;

    const hasRazao = Boolean((l.razao_social || '').trim());
    if (mode === 'forcar_todos') return true;
    if (hasRazao) return false;

    if (mode === 'sem_razao_todos') return true;
    return l.status === mode;
  });
}

function updateBulkEnrichCount() {
  const list = getFilteredLeadsForBulkEnrich();
  document.getElementById('bulk-enrich-queue-count').textContent = `${list.length} leads`;
  document.getElementById('btn-start-bulk-enrich').disabled = list.length === 0;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function startBackgroundEnrichment() {
  if (bgEnrichWorker.running) {
    return alert('Já existe um processamento em background em andamento.');
  }

  const targets = getFilteredLeadsForBulkEnrich();
  if (!targets.length) return;

  bgEnrichWorker = {
    running: true,
    paused: false,
    cancelled: false,
    queue: targets,
    processed: 0,
    success: 0,
    failed: 0,
    providerIndex: 0
  };

  closeModal('modal-bulk-enrich');
  const bar = document.getElementById('bg-enrichment-bar');
  bar.classList.remove('hidden');
  updateBgEnrichmentUI('Iniciando consultas...');

  for (let i = 0; i < bgEnrichWorker.queue.length; i++) {
    if (bgEnrichWorker.cancelled) break;

    while (bgEnrichWorker.paused && !bgEnrichWorker.cancelled) {
      updateBgEnrichmentUI('Pausado pelo usuário');
      await sleep(500);
    }
    if (bgEnrichWorker.cancelled) break;

    const lead = bgEnrichWorker.queue[i];
    const providerIdx = bgEnrichWorker.providerIndex % CNPJ_PROVIDERS.length;
    const providerName = CNPJ_PROVIDERS[providerIdx].name;
    bgEnrichWorker.providerIndex++;

    updateBgEnrichmentUI(`Consultando ${lead.cnpj} via ${providerName}...`);

    const info = await fetchCNPJLoadBalanced(lead.cnpj, providerIdx);
    bgEnrichWorker.processed++;

    if (info && info.razao_social) {
      await sb.from('crm_leads').update({ razao_social: info.razao_social }).eq('id', lead.id);
      lead.razao_social = info.razao_social;
      bgEnrichWorker.success++;
      if (bgEnrichWorker.success % 3 === 0) renderLeadsTable();
    } else {
      bgEnrichWorker.failed++;
    }

    updateBgEnrichmentUI(`Último: ${info?.fonte || providerName}`);

    if (i < bgEnrichWorker.queue.length - 1 && !bgEnrichWorker.cancelled) {
      await sleep(850);
    }
  }

  bgEnrichWorker.running = false;
  renderLeadsTable();

  document.getElementById('bg-enrich-title').textContent = bgEnrichWorker.cancelled
    ? 'Processamento interrompido.'
    : 'Enriquecimento de Razão Social concluído!';
  document.getElementById('bg-enrich-icon').className = 'fa-solid fa-circle-check text-emerald-400';

  setTimeout(() => {
    if (!bgEnrichWorker.running) {
      bar.classList.add('hidden');
      document.getElementById('bg-enrich-icon').className = 'fa-solid fa-server fa-beat-fade';
    }
  }, 6000);
}

function updateBgEnrichmentUI(apiStatusText) {
  const total = bgEnrichWorker.queue.length;
  const pct = total > 0 ? Math.round((bgEnrichWorker.processed / total) * 100) : 0;

  document.getElementById('bg-enrich-counter').textContent = `${bgEnrichWorker.processed} / ${total}`;
  document.getElementById('bg-enrich-progress').style.width = `${pct}%`;
  document.getElementById('bg-enrich-api-badge').textContent = apiStatusText;
  document.getElementById('bg-enrich-stats').textContent = `Sucesso: ${bgEnrichWorker.success} • Falhas: ${bgEnrichWorker.failed}`;
}

function toggleBackgroundEnrichmentPause() {
  bgEnrichWorker.paused = !bgEnrichWorker.paused;
  const btn = document.getElementById('btn-bg-pause');
  btn.innerHTML = bgEnrichWorker.paused
    ? '<i class="fa-solid fa-play mr-1"></i> Retomar'
    : '<i class="fa-solid fa-pause mr-1"></i> Pausar';
}

function stopBackgroundEnrichment() {
  bgEnrichWorker.cancelled = true;
  bgEnrichWorker.paused = false;
}

async function consultarCNPJParaCliente() {
  const btn = document.getElementById('btn-busca-cnpj-cli');
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Buscando...';

  const cnpj = document.getElementById('cli-cnpj').value;
  const info = await fetchCNPJLoadBalanced(cnpj, 0);

  btn.disabled = false;
  btn.innerHTML = '<i class="fa-solid fa-bolt"></i> Consultar CNPJ';

  if (!info) return alert('Não foi possível consultar este CNPJ no momento.');

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
// EXPORTAÇÃO PROFISSIONAL DE LEADS (STATUS + 9º DÍGITO + TAG + CUPOM)
// ============================================================================
function openExportModal() {
  document.getElementById('exp-cupom-filter').value = '';
  document.getElementById('exp-tag-filter').value = '';
  updateExportPreviewCount();
  openModal('modal-export');
}

function getLeadsToExport() {
  const checkedStatuses = Array.from(document.querySelectorAll('.exp-status-cb:checked')).map(cb => cb.value);
  const cupomFilter = document.getElementById('exp-cupom-filter').value.trim().toUpperCase();
  const tagFilter = document.getElementById('exp-tag-filter').value.trim().toUpperCase();

  return leadsData.filter(l => {
    if (!checkedStatuses.includes(l.status)) return false;
    if (cupomFilter && (l.cupom || '').toUpperCase() !== cupomFilter) return false;
    if (tagFilter && (l.tag || '').toUpperCase() !== tagFilter) return false;
    return true;
  });
}

function updateExportPreviewCount() {
  const list = getLeadsToExport();
  document.getElementById('exp-total-preview').textContent = `${list.length} contato(s)`;
  document.getElementById('btn-run-export').disabled = list.length === 0;
}

function executeProfessionalExport() {
  const list = getLeadsToExport();
  if (!list.length) return;

  const ninthDigitMode = document.querySelector('input[name="exp-ninth-digit"]:checked')?.value || 'keep';
  const fileFormat = document.getElementById('exp-file-format').value;
  const tagFilter = document.getElementById('exp-tag-filter').value.trim().toUpperCase();

  const rows = list.map(l => ({
    Telefone: formatPhoneNinthDigit(l.telefone, ninthDigitMode),
    Razao_Social: l.razao_social || '',
    Nome_Contato: l.nome_contato || l.razao_social || '',
    CNPJ: l.cnpj || '',
    TAG_Lista: l.tag || '',
    Cupom: l.cupom || '',
    Status_Atual: l.status,
    Status_Retorno: ''
  }));

  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Leads_Disparo');

  const dateTag = new Date().toISOString().slice(0, 10);
  const suffix9 = ninthDigitMode === 'add9' ? '_com9' : ninthDigitMode === 'remove9' ? '_sem9' : '';
  const suffixTag = tagFilter ? `_${tagFilter}` : '';
  const fileName = `leads_disparo${suffixTag}${suffix9}_${dateTag}.${fileFormat}`;

  XLSX.writeFile(wb, fileName, { bookType: fileFormat });
  closeModal('modal-export');
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
// PAGINAÇÃO, CRUD E RENDERIZAÇÃO DE LEADS
// ============================================================================
function onLeadFilterChange() {
  leadsPagination.currentPage = 1;
  renderLeadsTable();
}

function changeLeadsPageSize(newSize) {
  leadsPagination.pageSize = Number(newSize) || 50;
  leadsPagination.currentPage = 1;
  renderLeadsTable();
}

function goToLeadsPage(page) {
  leadsPagination.currentPage = page;
  renderLeadsTable();
}

function renderLeadsTable() {
  const term = document.getElementById('lead-search').value.toLowerCase();
  const statusFilter = document.getElementById('lead-filter-status').value;
  const tagFilter = document.getElementById('lead-filter-tag').value;

  const filtered = leadsData.filter(l => {
    const matchText =
      (l.razao_social || '').toLowerCase().includes(term) ||
      (l.nome_contato || '').toLowerCase().includes(term) ||
      (l.telefone || '').includes(term) ||
      (l.cnpj || '').includes(term) ||
      (l.tag || '').toLowerCase().includes(term);

    if (!matchText) return false;

    if (tagFilter === 'sem_tag' && (l.tag || '').trim() !== '') return false;
    if (tagFilter !== 'todas' && tagFilter !== 'sem_tag' && (l.tag || '').toUpperCase() !== tagFilter) return false;

    if (statusFilter === 'todos') return true;
    if (statusFilter === 'convertido') return Boolean(l.pessoa_id);
    if (statusFilter === 'sem_razao') return onlyDigits(l.cnpj).length === 14 && !(l.razao_social || '').trim();
    return l.status === statusFilter;
  });

  const totalFiltered = filtered.length;
  const pageSize = leadsPagination.pageSize;
  const totalPages = Math.max(1, Math.ceil(totalFiltered / pageSize));

  if (leadsPagination.currentPage > totalPages) {
    leadsPagination.currentPage = totalPages;
  }

  const startIdx = (leadsPagination.currentPage - 1) * pageSize;
  const endIdx = Math.min(startIdx + pageSize, totalFiltered);
  const pageItems = filtered.slice(startIdx, endIdx);

  document.getElementById('leads-count-label').textContent = totalFiltered === 0
    ? 'Mostrando 0 registros'
    : `Mostrando ${startIdx + 1}–${endIdx} de ${totalFiltered}`;

  document.getElementById('leads-pagination-info').textContent = `Página ${leadsPagination.currentPage} de ${totalPages} (${totalFiltered} filtrados)`;

  renderLeadsPaginationControls(leadsPagination.currentPage, totalPages);

  const tbody = document.getElementById('leads-table-body');
  if (pageItems.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="py-8 text-center text-xs text-slate-500">Nenhum lead encontrado.</td></tr>`;
    return;
  }

  tbody.innerHTML = pageItems.map(l => {
    const statusBadges = {
      nao_enviado: '<span class="px-2.5 py-1 rounded-full text-[11px] font-medium bg-slate-800 text-slate-300 border border-slate-700">Não Enviado</span>',
      enviado: '<span class="px-2.5 py-1 rounded-full text-[11px] font-medium bg-sky-950 text-sky-400 border border-sky-700/50">Enviado</span>',
      erro: `<span class="px-2.5 py-1 rounded-full text-[11px] font-medium bg-rose-950 text-rose-400 border border-rose-700/50" title="${l.motivo_erro || ''}">Erro</span>`
    };

    const waUrl = `https://wa.me/${onlyDigits(l.telefone)}`;
    const hasValidCnpj = onlyDigits(l.cnpj).length === 14;

    return `
      <tr class="hover:bg-bgInput/40 transition">
        <td class="py-3.5 px-4">
          <div class="font-semibold text-white text-xs">${l.razao_social || l.nome_contato || '<span class="text-slate-500 italic">Sem Razão Social</span>'}</div>
          ${l.nome_contato && l.razao_social ? `<div class="text-[11px] text-slate-400">Contato: ${l.nome_contato}</div>` : ''}
        </td>
        <td class="py-3.5 px-4 text-xs text-slate-300 font-mono">
          <div class="flex items-center gap-1.5">
            <span>${l.cnpj || '-'}</span>
            ${hasValidCnpj ? `
              <button id="btn-enrich-row-${l.id}" onclick="quickEnrichLeadRazao('${l.id}')" title="Buscar Razão Social deste CNPJ"
                class="px-1.5 py-0.5 rounded bg-amber-500/15 hover:bg-amber-500/30 border border-amber-500/30 text-amber-300 text-[10px] transition">
                <i class="fa-solid fa-bolt"></i>
              </button>
            ` : ''}
          </div>
        </td>
        <td class="py-3.5 px-4">
          <div class="text-xs text-slate-200 flex items-center gap-2">
            ${l.telefone}
            <a href="${waUrl}" target="_blank" title="Abrir WhatsApp" class="text-emerald-400 hover:text-emerald-300">
              <i class="fa-brands fa-whatsapp"></i>
            </a>
          </div>
          <div class="text-[11px] text-slate-400">${l.email || ''}</div>
        </td>
        <td class="py-3.5 px-4 space-y-1">
          ${l.tag ? `<div><span class="inline-flex items-center gap-1 text-[10px] font-bold bg-purple-950/90 text-purple-300 border border-purple-700/50 px-2 py-0.5 rounded"><i class="fa-solid fa-tag text-[9px]"></i> ${l.tag}</span></div>` : ''}
          ${l.cupom ? `<div><span class="text-[10px] font-bold bg-brandBlue/20 text-blue-300 border border-brandBlue/30 px-2 py-0.5 rounded">${l.cupom}</span></div>` : ''}
          ${!l.tag && !l.cupom ? '<span class="text-slate-500 text-xs">-</span>' : ''}
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

function renderLeadsPaginationControls(current, total) {
  const container = document.getElementById('leads-pagination-controls');
  if (total <= 1) {
    container.innerHTML = '';
    return;
  }

  let html = `
    <button onclick="goToLeadsPage(${current - 1})" ${current === 1 ? 'disabled' : ''}
      class="px-2.5 py-1 rounded-lg text-xs bg-bgInput hover:bg-slate-700 disabled:opacity-40 text-slate-200">
      <i class="fa-solid fa-chevron-left"></i> Anterior
    </button>
  `;

  const pages = new Set([1, total, current, current - 1, current + 1, current - 2, current + 2]);
  const sortedPages = Array.from(pages).filter(p => p >= 1 && p <= total).sort((a, b) => a - b);

  let prev = 0;
  for (const p of sortedPages) {
    if (prev && p - prev > 1) {
      html += `<span class="px-1.5 text-xs text-slate-500">...</span>`;
    }
    html += `
      <button onclick="goToLeadsPage(${p})"
        class="px-2.5 py-1 rounded-lg text-xs font-semibold transition ${p === current ? 'bg-brandBlue text-white' : 'bg-bgInput hover:bg-slate-700 text-slate-300'}">
        ${p}
      </button>
    `;
    prev = p;
  }

  html += `
    <button onclick="goToLeadsPage(${current + 1})" ${current === total ? 'disabled' : ''}
      class="px-2.5 py-1 rounded-lg text-xs bg-bgInput hover:bg-slate-700 disabled:opacity-40 text-slate-200">
      Próxima <i class="fa-solid fa-chevron-right"></i>
    </button>
  `;

  container.innerHTML = html;
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
    document.getElementById('lead-tag').value = l.tag || '';
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
    tag: document.getElementById('lead-tag').value.trim().toUpperCase() || null,
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
    if (motivo === null) return;
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
// IMPORTAÇÃO VISUAL + TAG DA LISTA + CRUZAMENTO 9º DÍGITO + REVISÃO EDITÁVEL
// ============================================================================
function openImportModal(mode) {
  importMode = mode;
  parsedSheetRows = [];
  parsedSheetHeaders = [];
  reviewState = { activeTab: 'primary', toInsert: [], duplicates: [], matchedUpdates: [], unmatchedNew: [] };

  document.getElementById('import-file-input').value = '';
  document.getElementById('import-list-tag').value = '';
  document.getElementById('import-default-cupom').value = '';
  document.getElementById('import-preview-container').classList.add('hidden');
  document.getElementById('btn-analyze-import').disabled = true;

  backToImportStep1();

  if (mode === 'novo') {
    document.getElementById('import-modal-title').textContent = 'Importar Planilha de Novos Leads';
    document.getElementById('import-cupom-wrapper').classList.remove('hidden');
  } else {
    document.getElementById('import-modal-title').textContent = 'Sincronizar Planilha de Retorno (Enviado / Erro)';
    document.getElementById('import-cupom-wrapper').classList.add('hidden');
  }

  openModal('modal-import');
}

function backToImportStep1() {
  document.getElementById('import-step-1').classList.remove('hidden');
  document.getElementById('import-step-2').classList.add('hidden');
  document.getElementById('btn-back-step-1').classList.add('hidden');
  document.getElementById('btn-analyze-import').classList.remove('hidden');
  document.getElementById('btn-confirm-import').classList.add('hidden');
}

function handleFileSelect(event) {
  const file = event.target.files[0];
  if (!file) return;

  // Sugere automaticamente uma TAG limpa baseada no nome do arquivo caso o usuário ainda não tenha digitado
  const tagInput = document.getElementById('import-list-tag');
  if (!tagInput.value.trim()) {
    const cleanName = file.name
      .replace(/\.[^/.]+$/, '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toUpperCase();
    tagInput.value = cleanName;
  }

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
        { value: 'tag', label: 'TAG da Lista (se houver coluna)' },
        { value: 'cupom', label: 'Cupom' }
      ]
    : [
        { value: 'ignore', label: '-- Ignorar Coluna --' },
        { value: 'telefone', label: 'Telefone WhatsApp *' },
        { value: 'cnpj', label: 'CNPJ' },
        { value: 'razao_social', label: 'Empresa / Razão Social' },
        { value: 'nome_contato', label: 'Nome do Contato' },
        { value: 'tag', label: 'TAG (p/ Novos não encontrados)' },
        { value: 'status', label: 'Status (enviado / erro) *' },
        { value: 'motivo_erro', label: 'Motivo do Erro' }
      ];

  const guessField = (header) => {
    const h = header.toLowerCase();
    if (h.includes('tel') || h.includes('cel') || h.includes('whats') || h.includes('fone')) return 'telefone';
    if (h.includes('cnpj')) return 'cnpj';
    if (h.includes('razao') || h.includes('razão') || h.includes('empresa') || h.includes('fantasia')) return 'razao_social';
    if (h.includes('nome') || h.includes('contato') || h.includes('socio')) return 'nome_contato';
    if (h.includes('mail')) return 'email';
    if (h === 'tag' || h.includes('tag_lista') || h.includes('lista')) return 'tag';
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
  document.getElementById('import-rows-summary').textContent = `${parsedSheetRows.length} linhas prontas para análise`;
  document.getElementById('import-preview-container').classList.remove('hidden');
  document.getElementById('btn-analyze-import').disabled = false;
}

function analyzeImportRows() {
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

  if (importMode === 'retorno' && !colMap.status) {
    return alert('Mapeie a coluna de Status para sincronizar o retorno.');
  }

  const defaultTag = document.getElementById('import-list-tag').value.trim().toUpperCase();
  if (importMode === 'novo' && !defaultTag && !colMap.tag) {
    return alert('Informe uma TAG de identificação para esta lista importada.');
  }

  const lookupIndex = buildLeadsLookupIndex();
  const seenInSheetKeys = new Set();

  reviewState.toInsert = [];
  reviewState.duplicates = [];
  reviewState.matchedUpdates = [];
  reviewState.unmatchedNew = [];
  reviewState.activeTab = 'primary';

  const defaultCupom = document.getElementById('import-default-cupom').value.trim().toUpperCase();

  parsedSheetRows.forEach((row, index) => {
    const rawPhone = colMap.telefone ? String(row[colMap.telefone] || '') : '';
    const normPhone = normalizePhone(rawPhone);
    const rawCnpj = colMap.cnpj ? String(row[colMap.cnpj] || '') : '';
    const formattedCnpj = onlyDigits(rawCnpj).length === 14 ? formatCNPJ(rawCnpj) : '';
    const razao = colMap.razao_social ? String(row[colMap.razao_social] || '').trim() : '';
    const contato = colMap.nome_contato ? String(row[colMap.nome_contato] || '').trim() : '';
    const email = colMap.email ? String(row[colMap.email] || '').trim().toLowerCase() : '';
    const rowTag = (colMap.tag && row[colMap.tag] ? String(row[colMap.tag]).trim().toUpperCase() : defaultTag) || '';
    const cupom = (colMap.cupom && row[colMap.cupom] ? String(row[colMap.cupom]).trim().toUpperCase() : defaultCupom) || '';

    if (!normPhone && !formattedCnpj) return;

    const match = findMatchingLead(normPhone, formattedCnpj, lookupIndex);

    if (importMode === 'novo') {
      const keys = getPhoneMatchKeys(normPhone);
      const isDuplicateInSheet = keys.some(k => seenInSheetKeys.has(k));
      keys.forEach(k => seenInSheetKeys.add(k));

      if (match || isDuplicateInSheet) {
        reviewState.duplicates.push({
          rowNum: index + 2,
          telefone: normPhone,
          cnpj: formattedCnpj,
          razao_social: razao || contato,
          motivo: match ? `Já existe no banco (${match.matchType})` : 'Duplicado na própria planilha'
        });
      } else {
        reviewState.toInsert.push({
          include: true,
          telefone: normPhone,
          cnpj: formattedCnpj,
          razao_social: razao,
          nome_contato: contato,
          email: email,
          tag: rowTag,
          cupom: cupom,
          status: 'nao_enviado'
        });
      }
    } else {
      const parsedStatus = parseDisparoStatus(row[colMap.status]);
      const motivoErro = colMap.motivo_erro ? String(row[colMap.motivo_erro] || '').trim() : '';

      if (match) {
        reviewState.matchedUpdates.push({
          include: true,
          lead_id: match.lead.id,
          lead_nome: match.lead.razao_social || match.lead.nome_contato || 'Sem Nome',
          lead_telefone: match.lead.telefone,
          sheet_telefone: normPhone,
          matchType: match.matchType,
          oldStatus: match.lead.status,
          newStatus: parsedStatus,
          motivo_erro: parsedStatus === 'erro' ? (motivoErro || 'Erro reportado pelo disparador') : ''
        });
      } else {
        reviewState.unmatchedNew.push({
          include: true,
          telefone: normPhone,
          cnpj: formattedCnpj,
          razao_social: razao,
          nome_contato: contato,
          tag: rowTag,
          cupom: cupom,
          status: parsedStatus,
          motivo_erro: parsedStatus === 'erro' ? (motivoErro || 'Erro reportado pelo disparador') : ''
        });
      }
    }
  });

  if (importMode === 'retorno' && reviewState.matchedUpdates.length === 0 && reviewState.unmatchedNew.length > 0) {
    reviewState.activeTab = 'secondary';
  }

  document.getElementById('import-step-1').classList.add('hidden');
  document.getElementById('import-step-2').classList.remove('hidden');
  document.getElementById('btn-back-step-1').classList.remove('hidden');
  document.getElementById('btn-analyze-import').classList.add('hidden');
  document.getElementById('btn-confirm-import').classList.remove('hidden');

  renderReviewScreen();
}

function setReviewTab(tab) {
  reviewState.activeTab = tab;
  renderReviewScreen();
}

function renderReviewScreen() {
  const cardsEl = document.getElementById('review-summary-cards');
  const tabsEl = document.getElementById('review-tabs-bar');
  const tableEl = document.getElementById('review-table');

  if (importMode === 'novo') {
    const activeInsertCount = reviewState.toInsert.filter(r => r.include).length;
    cardsEl.innerHTML = `
      <div class="bg-bgInput/80 border border-emerald-500/40 rounded-xl p-3">
        <div class="text-[11px] text-emerald-400 font-semibold">NOVOS PRONTOS P/ IMPORTAR</div>
        <div class="text-xl font-bold text-white mt-0.5">${activeInsertCount} <span class="text-xs font-normal text-slate-400">de ${reviewState.toInsert.length}</span></div>
      </div>
      <div class="bg-bgInput/80 border border-amber-500/30 rounded-xl p-3">
        <div class="text-[11px] text-amber-400 font-semibold">DUPLICADOS (COM/SEM 9º DÍGITO)</div>
        <div class="text-xl font-bold text-amber-300 mt-0.5">${reviewState.duplicates.length}</div>
      </div>
      <div class="bg-bgInput/80 border border-borderCard rounded-xl p-3">
        <div class="text-[11px] text-slate-400 font-semibold">TOTAL LIDO DA PLANILHA</div>
        <div class="text-xl font-bold text-slate-200 mt-0.5">${parsedSheetRows.length}</div>
      </div>
    `;

    tabsEl.innerHTML = `
      <button onclick="setReviewTab('primary')" class="px-3.5 py-1.5 rounded-lg text-xs font-semibold ${reviewState.activeTab === 'primary' ? 'bg-brandBlue text-white' : 'bg-bgInput text-slate-400'}">
        Novos Leads (${reviewState.toInsert.length})
      </button>
      <button onclick="setReviewTab('secondary')" class="px-3.5 py-1.5 rounded-lg text-xs font-semibold ${reviewState.activeTab === 'secondary' ? 'bg-amber-600 text-white' : 'bg-bgInput text-slate-400'}">
        Duplicados Ignorados (${reviewState.duplicates.length})
      </button>
    `;

    if (reviewState.activeTab === 'primary') {
      const visibleItems = reviewState.toInsert.slice(0, 300);
      tableEl.innerHTML = `
        <thead class="bg-bgSidebar border-b border-borderCard text-[11px] text-slate-400 uppercase">
          <tr>
            <th class="p-2.5 w-10 text-center">Usar</th>
            <th class="p-2.5">Telefone WhatsApp</th>
            <th class="p-2.5">Empresa / Razão Social</th>
            <th class="p-2.5">Contato</th>
            <th class="p-2.5">CNPJ</th>
            <th class="p-2.5">TAG Lista</th>
            <th class="p-2.5">Cupom</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-borderCard/60">
          ${visibleItems.map((item, idx) => `
            <tr class="${item.include ? '' : 'opacity-40'}">
              <td class="p-2 text-center">
                <input type="checkbox" ${item.include ? 'checked' : ''} onchange="reviewState.toInsert[${idx}].include = this.checked; renderReviewScreen();" />
              </td>
              <td class="p-2">
                <input type="text" value="${item.telefone}" onchange="reviewState.toInsert[${idx}].telefone = normalizePhone(this.value)"
                  class="w-36 bg-bgInput border border-borderCard rounded px-2 py-1 text-xs text-white font-mono" />
              </td>
              <td class="p-2">
                <input type="text" value="${item.razao_social}" onchange="reviewState.toInsert[${idx}].razao_social = this.value"
                  class="w-full bg-bgInput border border-borderCard rounded px-2 py-1 text-xs text-white" />
              </td>
              <td class="p-2">
                <input type="text" value="${item.nome_contato}" onchange="reviewState.toInsert[${idx}].nome_contato = this.value"
                  class="w-32 bg-bgInput border border-borderCard rounded px-2 py-1 text-xs text-white" />
              </td>
              <td class="p-2">
                <input type="text" value="${item.cnpj}" onchange="reviewState.toInsert[${idx}].cnpj = formatCNPJ(this.value)"
                  class="w-36 bg-bgInput border border-borderCard rounded px-2 py-1 text-xs text-white font-mono" />
              </td>
              <td class="p-2">
                <input type="text" value="${item.tag}" onchange="reviewState.toInsert[${idx}].tag = this.value.toUpperCase()"
                  class="w-36 bg-bgInput border border-purple-500/40 rounded px-2 py-1 text-xs text-purple-200 uppercase font-semibold" />
              </td>
              <td class="p-2">
                <input type="text" value="${item.cupom}" onchange="reviewState.toInsert[${idx}].cupom = this.value.toUpperCase()"
                  class="w-24 bg-bgInput border border-borderCard rounded px-2 py-1 text-xs text-white uppercase" />
              </td>
            </tr>
          `).join('')}
          ${reviewState.toInsert.length > 300 ? `<tr><td colspan="7" class="p-3 text-center text-xs text-sky-400 bg-bgSidebar/40">Exibindo os primeiros 300 registros na prévia. Todos os ${reviewState.toInsert.length} selecionados serão gravados em lotes ao confirmar.</td></tr>` : ''}
        </tbody>
      `;
    } else {
      tableEl.innerHTML = `
        <thead class="bg-bgSidebar border-b border-borderCard text-[11px] text-slate-400 uppercase">
          <tr>
            <th class="p-2.5">Linha</th>
            <th class="p-2.5">Telefone</th>
            <th class="p-2.5">Empresa / Contato</th>
            <th class="p-2.5">Motivo</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-borderCard/60">
          ${reviewState.duplicates.slice(0, 300).map(d => `
            <tr>
              <td class="p-2.5 text-slate-400">#${d.rowNum}</td>
              <td class="p-2.5 font-mono text-slate-300">${d.telefone}</td>
              <td class="p-2.5 text-slate-300">${d.razao_social || '-'}</td>
              <td class="p-2.5 text-amber-400">${d.motivo}</td>
            </tr>
          `).join('')}
        </tbody>
      `;
    }
  } else {
    const activeUpdates = reviewState.matchedUpdates.filter(r => r.include).length;
    const activeNewImports = reviewState.unmatchedNew.filter(r => r.include).length;

    cardsEl.innerHTML = `
      <div class="bg-bgInput/80 border border-sky-500/40 rounded-xl p-3">
        <div class="text-[11px] text-sky-400 font-semibold">ENCONTRADOS NO BANCO (ATUALIZAR STATUS)</div>
        <div class="text-xl font-bold text-white mt-0.5">${activeUpdates} <span class="text-xs font-normal text-slate-400">de ${reviewState.matchedUpdates.length}</span></div>
      </div>
      <div class="bg-bgInput/80 border border-amber-500/40 rounded-xl p-3">
        <div class="text-[11px] text-amber-400 font-semibold">NÃO ENCONTRADOS (NOVOS COM NOVA TAG)</div>
        <div class="text-xl font-bold text-amber-300 mt-0.5">${activeNewImports} <span class="text-xs font-normal text-slate-400">selecionados</span></div>
      </div>
      <div class="bg-bgInput/80 border border-borderCard rounded-xl p-3">
        <div class="text-[11px] text-slate-400 font-semibold">TOTAL LIDO DO RETORNO</div>
        <div class="text-xl font-bold text-slate-200 mt-0.5">${parsedSheetRows.length}</div>
      </div>
    `;

    tabsEl.innerHTML = `
      <button onclick="setReviewTab('primary')" class="px-3.5 py-1.5 rounded-lg text-xs font-semibold ${reviewState.activeTab === 'primary' ? 'bg-brandBlue text-white' : 'bg-bgInput text-slate-400'}">
        Encontrados p/ Atualizar Status (${reviewState.matchedUpdates.length})
      </button>
      <button onclick="setReviewTab('secondary')" class="px-3.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 ${reviewState.activeTab === 'secondary' ? 'bg-amber-600 text-white' : 'bg-bgInput text-amber-300 border border-amber-500/40'}">
        <i class="fa-solid fa-triangle-exclamation"></i> Não Encontrados — Novos c/ TAG (${reviewState.unmatchedNew.length})
      </button>
    `;

    if (reviewState.activeTab === 'primary') {
      tableEl.innerHTML = `
        <thead class="bg-bgSidebar border-b border-borderCard text-[11px] text-slate-400 uppercase">
          <tr>
            <th class="p-2.5 w-10 text-center">Aplicar</th>
            <th class="p-2.5">Lead no Banco</th>
            <th class="p-2.5">Tel. Banco vs Planilha</th>
            <th class="p-2.5">Cruzamento</th>
            <th class="p-2.5">Novo Status</th>
            <th class="p-2.5">Motivo Erro (se houver)</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-borderCard/60">
          ${reviewState.matchedUpdates.length === 0 ? `<tr><td colspan="6" class="p-6 text-center text-slate-500">Nenhum contato existente cruzou com a planilha. Veja a aba "Não Encontrados".</td></tr>` : ''}
          ${reviewState.matchedUpdates.slice(0, 300).map((item, idx) => `
            <tr class="${item.include ? '' : 'opacity-40'}">
              <td class="p-2 text-center">
                <input type="checkbox" ${item.include ? 'checked' : ''} onchange="reviewState.matchedUpdates[${idx}].include = this.checked; renderReviewScreen();" />
              </td>
              <td class="p-2 font-semibold text-white">${item.lead_nome}</td>
              <td class="p-2 font-mono text-[11px]">
                <div class="text-slate-200">${item.lead_telefone}</div>
                ${item.lead_telefone !== item.sheet_telefone ? `<div class="text-amber-400">Planilha: ${item.sheet_telefone}</div>` : ''}
              </td>
              <td class="p-2">
                <span class="px-2 py-0.5 rounded text-[10px] font-semibold ${item.matchType.includes('9º') ? 'bg-amber-500/20 text-amber-300' : 'bg-emerald-500/20 text-emerald-300'}">
                  ${item.matchType}
                </span>
              </td>
              <td class="p-2">
                <select onchange="reviewState.matchedUpdates[${idx}].newStatus = this.value"
                  class="bg-bgInput border border-borderCard rounded px-2 py-1 text-xs text-white font-semibold">
                  <option value="enviado" ${item.newStatus === 'enviado' ? 'selected' : ''}>Enviado</option>
                  <option value="erro" ${item.newStatus === 'erro' ? 'selected' : ''}>Erro</option>
                  <option value="nao_enviado" ${item.newStatus === 'nao_enviado' ? 'selected' : ''}>Não Enviado</option>
                </select>
              </td>
              <td class="p-2">
                <input type="text" value="${item.motivo_erro}" onchange="reviewState.matchedUpdates[${idx}].motivo_erro = this.value"
                  placeholder="Opcional" class="w-full bg-bgInput border border-borderCard rounded px-2 py-1 text-xs text-white" />
              </td>
            </tr>
          `).join('')}
        </tbody>
      `;
    } else {
      tableEl.innerHTML = `
        <thead class="bg-bgSidebar border-b border-borderCard text-[11px] text-slate-400 uppercase">
          <tr>
            <th class="p-2.5 w-10 text-center">Importar</th>
            <th class="p-2.5">Telefone (Ajustável)</th>
            <th class="p-2.5">Empresa / Razão Social</th>
            <th class="p-2.5">TAG Lista</th>
            <th class="p-2.5">Status (da Planilha)</th>
            <th class="p-2.5">Motivo Erro</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-borderCard/60">
          ${reviewState.unmatchedNew.length === 0 ? `<tr><td colspan="6" class="p-6 text-center text-slate-500">Todos os contatos da planilha foram encontrados no banco!</td></tr>` : ''}
          ${reviewState.unmatchedNew.slice(0, 300).map((item, idx) => `
            <tr class="${item.include ? '' : 'opacity-40'}">
              <td class="p-2 text-center">
                <input type="checkbox" ${item.include ? 'checked' : ''} onchange="reviewState.unmatchedNew[${idx}].include = this.checked; renderReviewScreen();" />
              </td>
              <td class="p-2">
                <input type="text" value="${item.telefone}" onchange="reviewState.unmatchedNew[${idx}].telefone = normalizePhone(this.value)"
                  class="w-36 bg-bgInput border border-amber-500/40 rounded px-2 py-1 text-xs text-white font-mono" />
              </td>
              <td class="p-2">
                <input type="text" value="${item.razao_social}" placeholder="Nome da empresa" onchange="reviewState.unmatchedNew[${idx}].razao_social = this.value"
                  class="w-full bg-bgInput border border-borderCard rounded px-2 py-1 text-xs text-white" />
              </td>
              <td class="p-2">
                <input type="text" value="${item.tag}" placeholder="TAG Lista" onchange="reviewState.unmatchedNew[${idx}].tag = this.value.toUpperCase()"
                  class="w-36 bg-bgInput border border-purple-500/40 rounded px-2 py-1 text-xs text-purple-200 uppercase font-semibold" />
              </td>
              <td class="p-2">
                <select onchange="reviewState.unmatchedNew[${idx}].status = this.value"
                  class="bg-bgInput border border-borderCard rounded px-2 py-1 text-xs text-white font-semibold">
                  <option value="enviado" ${item.status === 'enviado' ? 'selected' : ''}>Enviado</option>
                  <option value="erro" ${item.status === 'erro' ? 'selected' : ''}>Erro</option>
                  <option value="nao_enviado" ${item.status === 'nao_enviado' ? 'selected' : ''}>Não Enviado</option>
                </select>
              </td>
              <td class="p-2">
                <input type="text" value="${item.motivo_erro}" placeholder="Se erro..." onchange="reviewState.unmatchedNew[${idx}].motivo_erro = this.value"
                  class="w-36 bg-bgInput border border-borderCard rounded px-2 py-1 text-xs text-white" />
              </td>
            </tr>
          `).join('')}
        </tbody>
      `;
    }
  }
}

async function commitReviewedImport() {
  const btn = document.getElementById('btn-confirm-import');
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1"></i> Gravando lotes...';

  if (importMode === 'novo') {
    const selected = reviewState.toInsert
      .filter(r => r.include && r.telefone)
      .map(r => ({
        telefone: normalizePhone(r.telefone),
        cnpj: r.cnpj || null,
        razao_social: r.razao_social || null,
        nome_contato: r.nome_contato || null,
        email: r.email || null,
        tag: r.tag || null,
        cupom: r.cupom || null,
        status: 'nao_enviado'
      }));

    if (selected.length > 0) {
      const chunks = chunkArray(selected, 500);
      for (const batch of chunks) {
        const { error } = await sb.from('crm_leads').insert(batch);
        if (error) {
          alert('Erro ao importar lote de leads: ' + error.message);
          btn.disabled = false;
          btn.innerHTML = '<i class="fa-solid fa-check mr-1"></i> Confirmar e Gravar no Banco';
          return;
        }
      }
    }
    alert(`${selected.length} novos leads importados com sucesso!`);
  } else {
    // Atualiza APENAS o status (e motivo_erro) dos leads existentes, preservando a TAG original deles
    const toUpdate = reviewState.matchedUpdates.filter(r => r.include);
    const updateChunks = chunkArray(toUpdate, 25);
    for (const batch of updateChunks) {
      await Promise.all(
        batch.map(item =>
          sb.from('crm_leads').update({
            status: item.newStatus,
            motivo_erro: item.newStatus === 'erro' ? (item.motivo_erro || 'Erro no envio') : null
          }).eq('id', item.lead_id)
        )
      );
    }

    // Aplica a nova TAG somente nos contatos novos (não encontrados)
    const toInsertNew = reviewState.unmatchedNew
      .filter(r => r.include && r.telefone)
      .map(r => ({
        telefone: normalizePhone(r.telefone),
        cnpj: r.cnpj || null,
        razao_social: r.razao_social || null,
        nome_contato: r.nome_contato || null,
        tag: r.tag || null,
        cupom: r.cupom || null,
        status: r.status,
        motivo_erro: r.status === 'erro' ? (r.motivo_erro || 'Erro no envio') : null
      }));

    if (toInsertNew.length > 0) {
      const insertChunks = chunkArray(toInsertNew, 500);
      for (const batch of insertChunks) {
        const { error } = await sb.from('crm_leads').insert(batch);
        if (error) {
          alert('Erro ao importar contatos novos do retorno: ' + error.message);
        }
      }
    }

    alert(`Sincronização concluída!\n• ${toUpdate.length} leads existentes tiveram apenas o status atualizado.\n• ${toInsertNew.length} contatos novos importados com a nova TAG.`);
  }

  btn.disabled = false;
  btn.innerHTML = '<i class="fa-solid fa-check mr-1"></i> Confirmar e Gravar no Banco';
  closeModal('modal-import');
  await refreshAll();
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
