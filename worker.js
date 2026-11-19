// ============================================================================
// CLOUDFLARE WORKER UNIFICADO: SERVE O CRM (ASSETS) + API/WEBHOOK WA-AKG
// ============================================================================

const SUPABASE_URL = 'https://nrgllzzdemuuaigcjsht.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_Z1nBzTFVax9QWVbc3_gcwA_u8ZrHSc2';
const SUPABASE_KEY = SUPABASE_ANON_KEY;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, X-API-Key'
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS
    }
  });
}

function onlyDigits(str) {
  return String(str || '').replace(/\D/g, '');
}

function toJid(rawPhone) {
  const clean = onlyDigits(rawPhone);
  return clean.includes('@') ? clean : `${clean}@s.whatsapp.net`;
}

function getPhoneVariants(rawPhone) {
  let d = onlyDigits(rawPhone);
  if (!d) return [];
  if (d.length === 10 || d.length === 11) d = '55' + d;
  const variants = new Set([d]);

  if (d.startsWith('55')) {
    const local = d.slice(2);
    if (local.length === 11 && local[2] === '9') {
      variants.add('55' + local.slice(0, 2) + local.slice(3));
    } else if (local.length === 10 && ['6', '7', '8', '9'].includes(local[2])) {
      variants.add('55' + local.slice(0, 2) + '9' + local.slice(2));
    }
  }
  return Array.from(variants);
}

// Garante que a URL base sempre termine com /api (padrão do WA-AKG)
function normalizeWaBaseUrl(rawBase) {
  let base = (rawBase || 'https://wa.tottemtecnologia.com.br/api').trim().replace(/\/+$/, '');
  base = base.replace(/\/dashboard(\/chat)?$/i, '');
  if (!base.endsWith('/api')) {
    base += '/api';
  }
  return base;
}

function buildWaHeaders(waConfig) {
  const headers = { 'Content-Type': 'application/json' };
  if (waConfig?.apiKey) {
    headers['X-API-Key'] = waConfig.apiKey.trim();
  }
  return headers;
}

function buildWaUrl(waConfig, pathTemplate, vars = {}) {
  const baseUrl = normalizeWaBaseUrl(waConfig?.baseUrl);
  let path = (pathTemplate || '').trim();
  if (path.startsWith('/api/')) path = path.slice(4);
  for (const [key, val] of Object.entries(vars)) {
    path = path.replaceAll(`{${key}}`, encodeURIComponent(String(val || '')));
  }
  return path.startsWith('http') ? path : `${baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
}

// Resolve o sessionId automaticamente via GET /api/sessions se não for informado
async function resolveSessionId(waConfig) {
  const configured = (waConfig?.instance || '').trim();
  if (configured && configured.toLowerCase() !== 'default') {
    return { sessionId: configured };
  }

  const sessionsUrl = buildWaUrl(waConfig, '/sessions');
  const res = await fetch(sessionsUrl, {
    method: 'GET',
    headers: buildWaHeaders(waConfig)
  });

  if (!res.ok) {
    const errText = await res.text();
    return { error: `HTTP ${res.status} ao buscar sessões em ${sessionsUrl}: ${errText.slice(0, 120)}` };
  }

  const sessions = await res.json();
  const list = Array.isArray(sessions) ? sessions : sessions?.data || [];
  if (list.length === 0) {
    return { error: 'Nenhuma sessão encontrada no WA-AKG. Crie e conecte uma sessão primeiro.' };
  }

  const connected = list.find(s => String(s.status).toLowerCase() === 'connected') || list[0];
  return {
    sessionId: connected.sessionId || connected.id,
    sessionObj: connected,
    allSessions: list
  };
}

async function supabaseFetch(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: options.prefer || 'return=representation',
      ...(options.headers || {})
    }
  });
  const text = await res.text();
  try {
    return { ok: res.ok, status: res.status, data: text ? JSON.parse(text) : null };
  } catch {
    return { ok: res.ok, status: res.status, data: text };
  }
}

// Verifica regra de 15 dias no Supabase + GET /api/chat/{sessionId}/{jid}
async function checkRecent15Days({ phone, waConfig, resolvedSessionId }) {
  const variants = getPhoneVariants(phone);
  if (variants.length === 0) return { recent: false };

  const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
  const inFilter = `(${variants.join(',')})`;

  // 1. Checagem no Supabase (crm_leads com status enviado nos últimos 15 dias)
  const leadCheck = await supabaseFetch(
    `crm_leads?telefone=in.${encodeURIComponent(inFilter)}&status=eq.enviado&ultimo_disparo_em=gte.${encodeURIComponent(fifteenDaysAgo)}&select=id,telefone,ultimo_disparo_em&limit=1`
  );

  if (leadCheck.ok && Array.isArray(leadCheck.data) && leadCheck.data.length > 0) {
    return {
      recent: true,
      source: 'CRM (Último disparo registrado)',
      date: leadCheck.data[0].ultimo_disparo_em
    };
  }

  // 2. Checagem na tabela de interações (crm_interacoes) nos últimos 15 dias
  const leadIdsRes = await supabaseFetch(
    `crm_leads?telefone=in.${encodeURIComponent(inFilter)}&select=id`
  );

  if (leadIdsRes.ok && Array.isArray(leadIdsRes.data) && leadIdsRes.data.length > 0) {
    const ids = leadIdsRes.data.map(l => l.id).join(',');
    const interRes = await supabaseFetch(
      `crm_interacoes?lead_id=in.(${ids})&tipo=eq.disparo_wa&criado_em=gte.${encodeURIComponent(fifteenDaysAgo)}&select=id,criado_em&limit=1`
    );
    if (interRes.ok && Array.isArray(interRes.data) && interRes.data.length > 0) {
      return {
        recent: true,
        source: 'Histórico de Disparos CRM',
        date: interRes.data[0].criado_em
      };
    }
  }

  // 3. Checagem no histórico real do chat WA-AKG: GET /api/chat/{sessionId}/{jid}
  const sessionId = resolvedSessionId || waConfig?.instance;
  if (sessionId && sessionId !== 'default') {
    const historyTemplate = waConfig?.historyEndpoint || '/chat/{sessionId}/{jid}';
    const headers = buildWaHeaders(waConfig);
    const cutoffTs = Date.now() - 15 * 24 * 60 * 60 * 1000;

    for (const variantPhone of variants) {
      try {
        const url = buildWaUrl(waConfig, historyTemplate, {
          sessionId,
          instance: sessionId,
          jid: toJid(variantPhone),
          phone: variantPhone
        });

        const waRes = await fetch(url, { method: 'GET', headers });
        if (waRes.ok) {
          const payload = await waRes.json();
          const messages = Array.isArray(payload)
            ? payload
            : payload?.messages || payload?.data || payload?.records || [];

          const foundRecent = messages.find(m => {
            const fromMe = m.fromMe === true || m.key?.fromMe === true;
            if (!fromMe) return false;
            const rawTs = m.timestamp || m.messageTimestamp || m.createdAt || m.created_at;
            if (!rawTs) return false;
            const tsMs = typeof rawTs === 'number' ? (rawTs < 1e12 ? rawTs * 1000 : rawTs) : Date.parse(rawTs);
            return !isNaN(tsMs) && tsMs >= cutoffTs;
          });

          if (foundRecent) {
            return {
              recent: true,
              source: 'Conversa WA-AKG (Últimos 15 dias)',
              date: new Date().toISOString()
            };
          }
        }
      } catch {}
    }
  }

  return { recent: false };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (pathname.startsWith('/api/wa/')) {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      const action = pathname.replace('/api/wa/', '');

      // 1. STATUS DA SESSÃO WA-AKG (GET /api/sessions ou GET /api/sessions/{id})
      if (action === 'status' && request.method === 'POST') {
        try {
          const body = await request.json();
          const resolved = await resolveSessionId(body);

          if (resolved.error) {
            return jsonResponse({ online: false, error: resolved.error }, 200);
          }

          const targetUrl = buildWaUrl(body, `/sessions/${encodeURIComponent(resolved.sessionId)}`);
          const res = await fetch(targetUrl, {
            method: 'GET',
            headers: buildWaHeaders(body)
          });

          const text = await res.text();
          let data = null;
          try { data = JSON.parse(text); } catch { data = text; }

          return jsonResponse({
            online: res.ok,
            httpStatus: res.status,
            detectedSessionId: resolved.sessionId,
            sessionStatus: data?.status || resolved.sessionObj?.status || 'Unknown',
            url: targetUrl,
            error: res.ok ? null : `HTTP ${res.status}: ${data?.message || data?.error || String(text).slice(0, 100)}`
          });
        } catch (err) {
          return jsonResponse({ online: false, error: err.message }, 200);
        }
      }

      // 2. VERIFICAÇÃO DE 15 DIAS
      if (action === 'check-15d' && request.method === 'POST') {
        try {
          const body = await request.json();
          const resolved = await resolveSessionId(body.waConfig || {});
          const result = await checkRecent15Days({
            phone: body.phone,
            waConfig: body.waConfig,
            resolvedSessionId: resolved.sessionId
          });
          return jsonResponse(result);
        } catch (err) {
          return jsonResponse({ recent: false, error: err.message }, 200);
        }
      }

      // 3. ENVIO DE MENSAGEM VIA WA-AKG: POST /api/messages/{sessionId}/{jid}/send
      if (action === 'send' && request.method === 'POST') {
        try {
          const body = await request.json();
          const { leadId, phone, message, check15Days, waConfig } = body;

          if (!phone || !message) {
            return jsonResponse({ success: false, error: 'Telefone e mensagem são obrigatórios.' }, 400);
          }

          const resolved = await resolveSessionId(waConfig || {});
          if (resolved.error) {
            return jsonResponse({ success: false, status: 'erro', error: resolved.error }, 200);
          }
          const sessionId = resolved.sessionId;

          // Etapa A: Validação de 15 dias (CRM + GET /api/chat/{sessionId}/{jid})
          if (check15Days) {
            const check = await checkRecent15Days({
              phone,
              waConfig,
              resolvedSessionId: sessionId
            });
            if (check.recent) {
              return jsonResponse({
                success: false,
                skipped15d: true,
                reason: `Bloqueado pela regra de 15 dias (${check.source})`
              });
            }
          }

          const headers = buildWaHeaders(waConfig);
          const cleanPhone = onlyDigits(phone);
          const jid = toJid(cleanPhone);

          // Etapa B: Simulação de digitação: POST /api/chat/{sessionId}/{jid}/presence
          if (waConfig?.simulateTyping !== false) {
            try {
              const presenceUrl = buildWaUrl(waConfig, '/chat/{sessionId}/{jid}/presence', {
                sessionId,
                jid
              });
              await fetch(presenceUrl, {
                method: 'POST',
                headers,
                body: JSON.stringify({ presence: 'composing' })
              });
              await new Promise(r => setTimeout(r, 1200));
            } catch {}
          }

          // Etapa C: Disparo exato conforme schema do Swagger:
          // POST /api/messages/{sessionId}/{jid}/send
          // Body: { "jid": "5562...@s.whatsapp.net", "message": { "text": "..." } }
          const sendTemplate = waConfig?.sendEndpoint || '/messages/{sessionId}/{jid}/send';
          const targetUrl = buildWaUrl(waConfig, sendTemplate, {
            sessionId,
            instance: sessionId,
            jid,
            phone: cleanPhone
          });

          const outgoingPayload = {
            jid: jid,
            message: {
              text: message
            }
          };

          const waRes = await fetch(targetUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(outgoingPayload)
          });

          const rawResponseText = await waRes.text();
          let parsedResp = null;
          try {
            parsedResp = JSON.parse(rawResponseText);
          } catch {
            parsedResp = { raw: rawResponseText };
          }

          const isSuccess =
            waRes.ok &&
            parsedResp?.status !== false &&
            parsedResp?.success !== false;

          const nowIso = new Date().toISOString();

          if (isSuccess) {
            if (leadId) {
              await supabaseFetch(`crm_leads?id=eq.${leadId}`, {
                method: 'PATCH',
                body: JSON.stringify({
                  status: 'enviado',
                  motivo_erro: null,
                  ultimo_disparo_em: nowIso
                })
              });

              await supabaseFetch('crm_interacoes', {
                method: 'POST',
                body: JSON.stringify({
                  lead_id: leadId,
                  tipo: 'disparo_wa',
                  descricao: `Mensagem enviada via WA-AKG (Sessão ${sessionId}):\n"${message}"`
                })
              });
            }

            return jsonResponse({
              success: true,
              status: 'enviado',
              sessionIdUsed: sessionId,
              providerResponse: parsedResp
            });
          } else {
            const detailMsg =
              parsedResp?.message ||
              parsedResp?.error ||
              rawResponseText;

            const errorMsg = `HTTP ${waRes.status}: ${String(detailMsg || 'Erro desconhecido').slice(0, 220)}`;

            if (leadId) {
              await supabaseFetch(`crm_leads?id=eq.${leadId}`, {
                method: 'PATCH',
                body: JSON.stringify({
                  status: 'erro',
                  motivo_erro: errorMsg
                })
              });
            }

            return jsonResponse({
              success: false,
              status: 'erro',
              error: errorMsg
            });
          }
        } catch (err) {
          return jsonResponse({
            success: false,
            status: 'erro',
            error: `Falha de rede no Worker Cloudflare: ${err.message}`
          });
        }
      }

      // 4. WEBHOOK RECEPTOR DO WA-AKG (Eventos: message.sent, message.status, etc.)
      if (action === 'webhook' && request.method === 'POST') {
        try {
          const event = await request.json();
          const rawPhone =
            event?.jid ||
            event?.data?.jid ||
            event?.data?.key?.remoteJid ||
            event?.phone ||
            event?.number ||
            '';

          const variants = getPhoneVariants(rawPhone);
          if (variants.length > 0) {
            const evName = String(event?.event || event?.status || '').toLowerCase();
            const isFailed = evName.includes('fail') || evName.includes('error') || evName.includes('invalid');
            const isDelivered =
              evName === 'message.sent' ||
              evName === 'message.status' ||
              evName.includes('sent') ||
              evName.includes('deliver') ||
              evName.includes('read');

            if (isFailed || isDelivered) {
              const inFilter = `(${variants.join(',')})`;
              await supabaseFetch(`crm_leads?telefone=in.${encodeURIComponent(inFilter)}`, {
                method: 'PATCH',
                body: JSON.stringify({
                  status: isFailed ? 'erro' : 'enviado',
                  motivo_erro: isFailed ? (event?.error || event?.message || 'Falha reportada pelo webhook WA-AKG') : null,
                  ...(isDelivered ? { ultimo_disparo_em: new Date().toISOString() } : {})
                })
              });
            }
          }

          return jsonResponse({ received: true });
        } catch (err) {
          return jsonResponse({ received: false, error: err.message }, 400);
        }
      }

      return jsonResponse({ error: 'Rota WA-AKG não encontrada.' }, 404);
    }

    return env.ASSETS.fetch(request);
  }
};
