// ============================================================================
// CLOUDFLARE WORKER UNIFICADO: SERVE O CRM (ASSETS) + API/WEBHOOK WA-AKG
// ============================================================================

const SUPABASE_URL = 'https://nrgllzzdemuuaigcjsht.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_Z1nBzTFVax9QWVbc3_gcwA_u8ZrHSc2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey'
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

async function checkRecent15Days({ phone, waConfig }) {
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

  // 3. Checagem opcional na API do WA-AKG
  if (waConfig?.baseUrl && waConfig?.historyEndpoint) {
    try {
      const cleanBase = waConfig.baseUrl.replace(/\/+$/, '');
      const cleanPath = waConfig.historyEndpoint
        .replace('{phone}', variants[0])
        .replace('{instance}', waConfig.instance || '');
      const url = cleanPath.startsWith('http') ? cleanPath : `${cleanBase}${cleanPath.startsWith('/') ? '' : '/'}${cleanPath}`;

      const headers = { 'Content-Type': 'application/json' };
      if (waConfig.apiKey) {
        headers['Authorization'] = `Bearer ${waConfig.apiKey}`;
        headers['apikey'] = waConfig.apiKey;
      }

      const waRes = await fetch(url, { method: 'GET', headers });
      if (waRes.ok) {
        const payload = await waRes.json();
        const messages = Array.isArray(payload)
          ? payload
          : payload?.messages || payload?.data || payload?.records || [];

        const cutoffTs = Date.now() - 15 * 24 * 60 * 60 * 1000;
        const foundRecent = messages.find(m => {
          const fromMe = m.fromMe === true || m.key?.fromMe === true || m.direction === 'outbound' || m.type === 'out';
          if (!fromMe) return false;
          const rawTs = m.messageTimestamp || m.timestamp || m.created_at || m.createdAt;
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

  return { recent: false };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Intercepta todas as rotas de API /api/wa/*
    if (pathname.startsWith('/api/wa/')) {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      const action = pathname.replace('/api/wa/', '');

      // 1. STATUS DO WA-AKG
      if (action === 'status' && request.method === 'POST') {
        try {
          const body = await request.json();
          const baseUrl = (body.baseUrl || 'https://wa.tottemtecnologia.com.br').replace(/\/+$/, '');
          const statusPath = (body.statusEndpoint || '/').replace('{instance}', body.instance || '');
          const targetUrl = statusPath.startsWith('http') ? statusPath : `${baseUrl}${statusPath.startsWith('/') ? '' : '/'}${statusPath}`;

          const headers = { 'Content-Type': 'application/json' };
          if (body.apiKey) {
            headers['Authorization'] = `Bearer ${body.apiKey}`;
            headers['apikey'] = body.apiKey;
          }

          const res = await fetch(targetUrl, { method: 'GET', headers });
          return jsonResponse({
            online: res.status < 500,
            httpStatus: res.status,
            url: targetUrl
          });
        } catch (err) {
          return jsonResponse({ online: false, error: err.message }, 200);
        }
      }

      // 2. VERIFICAÇÃO DE 15 DIAS
      if (action === 'check-15d' && request.method === 'POST') {
        try {
          const body = await request.json();
          const result = await checkRecent15Days({
            phone: body.phone,
            waConfig: body.waConfig
          });
          return jsonResponse(result);
        } catch (err) {
          return jsonResponse({ recent: false, error: err.message }, 200);
        }
      }

      // 3. ENVIO DE MENSAGEM VIA WA-AKG + ATUALIZAÇÃO NO SUPABASE
      if (action === 'send' && request.method === 'POST') {
        try {
          const body = await request.json();
          const { leadId, phone, message, check15Days, waConfig } = body;

          if (!phone || !message) {
            return jsonResponse({ success: false, error: 'Telefone e mensagem são obrigatórios.' }, 400);
          }

          if (check15Days) {
            const check = await checkRecent15Days({ phone, waConfig });
            if (check.recent) {
              return jsonResponse({
                success: false,
                skipped15d: true,
                reason: `Bloqueado pela regra de 15 dias (${check.source})`
              });
            }
          }

          const baseUrl = (waConfig?.baseUrl || 'https://wa.tottemtecnologia.com.br').replace(/\/+$/, '');
          const sendPath = (waConfig?.sendEndpoint || '/api/send-message').replace('{instance}', waConfig?.instance || '');
          const targetUrl = sendPath.startsWith('http') ? sendPath : `${baseUrl}${sendPath.startsWith('/') ? '' : '/'}${sendPath}`;

          const headers = { 'Content-Type': 'application/json' };
          if (waConfig?.apiKey) {
            headers['Authorization'] = `Bearer ${waConfig.apiKey}`;
            headers['apikey'] = waConfig.apiKey;
          }

          const cleanPhone = onlyDigits(phone);

          const outgoingPayload = {
            phone: cleanPhone,
            number: cleanPhone,
            to: cleanPhone,
            chatId: `${cleanPhone}@c.us`,
            message: message,
            text: message,
            textMessage: { text: message },
            instance: waConfig?.instance || undefined,
            simulateTyping: waConfig?.simulateTyping !== false
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
            parsedResp?.success !== false &&
            parsedResp?.error === undefined &&
            parsedResp?.status !== 'ERROR';

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
                  descricao: `Mensagem enviada via WA-AKG:\n"${message}"`
                })
              });
            }

            return jsonResponse({
              success: true,
              status: 'enviado',
              providerResponse: parsedResp
            });
          } else {
            const errorMsg =
              parsedResp?.detail ||
              parsedResp?.message ||
              parsedResp?.error ||
              `HTTP ${waRes.status} ao comunicar com WA-AKG`;

            if (leadId) {
              await supabaseFetch(`crm_leads?id=eq.${leadId}`, {
                method: 'PATCH',
                body: JSON.stringify({
                  status: 'erro',
                  motivo_erro: String(errorMsg).slice(0, 250)
                })
              });
            }

            return jsonResponse({
              success: false,
              status: 'erro',
              error: String(errorMsg)
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

      // 4. WEBHOOK RECEPTOR DO WA-AKG
      if (action === 'webhook' && request.method === 'POST') {
        try {
          const event = await request.json();
          const rawPhone =
            event?.phone ||
            event?.number ||
            event?.remoteJid ||
            event?.data?.key?.remoteJid ||
            event?.from ||
            '';

          const variants = getPhoneVariants(rawPhone);
          if (variants.length > 0) {
            const statusRaw = String(event?.status || event?.event || '').toLowerCase();
            const isFailed = statusRaw.includes('fail') || statusRaw.includes('error') || statusRaw.includes('invalid');
            const isDelivered = statusRaw.includes('sent') || statusRaw.includes('deliver') || statusRaw.includes('read') || statusRaw.includes('ack');

            if (isFailed || isDelivered) {
              const inFilter = `(${variants.join(',')})`;
              await supabaseFetch(`crm_leads?telefone=in.${encodeURIComponent(inFilter)}`, {
                method: 'PATCH',
                body: JSON.stringify({
                  status: isFailed ? 'erro' : 'enviado',
                  motivo_erro: isFailed ? (event?.reason || event?.error || 'Falha reportada pelo webhook WA-AKG') : null,
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

    // Para qualquer outra rota, entrega o front-end (public/index.html e public/app.js)
    return env.ASSETS.fetch(request);
  }
};
