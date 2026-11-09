// Diagnóstico da instância na uazapi: conexão e webhooks configurados.
// Por padrão só lê. Com corpo {"ligar_webhook": true}, liga o webhook que já aponta
// para o nosso robô (mantendo URL, eventos e filtros como estão).
// Protegido pelo segredo interno (x-internal-secret).
// Nunca devolve tokens nem o segredo do webhook: só se a URL bate com a nossa.

import { segredo as lerSegredo } from "../_shared/db.ts";
import { mascararTelefone } from "../_shared/log.ts";
import { tokenInstancia, urlBase } from "../_shared/uzapi.ts";

const NOSSA_FUNCAO = "lbnhzercupemlliueuyq.supabase.co/functions/v1/whatsapp-webhook";

async function chamar(caminho: string, corpo?: unknown) {
  try {
    const r = await fetch(`${urlBase()}${caminho}`, {
      method: corpo ? "POST" : "GET",
      headers: { token: tokenInstancia(), "Content-Type": "application/json" },
      body: corpo ? JSON.stringify(corpo) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const texto = await r.text();
    let json: unknown = null;
    try { json = JSON.parse(texto); } catch { /* não é json */ }
    return { http: r.status, json, inicio: json ? undefined : texto.slice(0, 200) };
  } catch (e) {
    return { http: 0, erro: (e as Error).message };
  }
}

Deno.serve(async (req) => {
  const interno = await lerSegredo("internal_secret").catch(() => "");
  if (!interno || req.headers.get("x-internal-secret") !== interno) {
    return new Response("não autorizado", { status: 401 });
  }
  const webhookSecret = await lerSegredo("webhook_secret").catch(() => "");

  const status = await chamar("/instance/status");
  // deno-lint-ignore no-explicit-any
  const s: any = status.json ?? {};
  const inst = s.instance ?? s;
  const resumoStatus = {
    http: status.http,
    erro: status.erro ?? (status.http !== 200 ? (s.error ?? status.inicio) : undefined),
    conectado: s.status?.connected ?? s.connected ?? null,
    estado: inst?.status ?? s.status?.state ?? null,
    nome: inst?.name ?? null,
    numero: mascararTelefone(String(inst?.owner ?? s.status?.jid ?? "")),
  };

  const pedido = await req.json().catch(() => ({}));
  let ligacao: unknown = undefined;
  if (pedido?.ligar_webhook === true) {
    const atual = await chamar("/webhook");
    const lista0 = Array.isArray(atual.json) ? atual.json : atual.json ? [atual.json] : [];
    // deno-lint-ignore no-explicit-any
    const nosso = lista0.find((w: any) => {
      try { const u = new URL(String(w?.url)); return (u.host + u.pathname).replace(/\/+$/, "") === NOSSA_FUNCAO; }
      catch { return false; }
    });
    if (!nosso) {
      ligacao = { ok: false, motivo: "nenhum webhook apontando para o robô" };
    } else {
      const r = await chamar("/webhook", {
        action: "update",
        id: nosso.id,
        enabled: true,
        url: nosso.url,
        events: nosso.events,
        excludeMessages: nosso.excludeMessages,
        addUrlEvents: nosso.addUrlEvents ?? false,
        addUrlTypesMessages: nosso.addUrlTypesMessages ?? false,
      });
      ligacao = { ok: r.http === 200, http: r.http, erro: r.http === 200 ? undefined : (r.erro ?? r.inicio ?? r.json) };
    }
  }

  const wh = await chamar("/webhook");
  const lista = Array.isArray(wh.json) ? wh.json : wh.json ? [wh.json] : [];
  // deno-lint-ignore no-explicit-any
  const webhooks = lista.map((w: any) => {
    const url = String(w?.url ?? "");
    let base = url, s = "";
    try { const u = new URL(url); base = u.host + u.pathname; s = u.searchParams.get("s") ?? ""; } catch { /* url inválida */ }
    const nosso = base.replace(/\/+$/, "") === NOSSA_FUNCAO;
    return {
      enabled: w?.enabled,
      aponta_para: nosso ? "nosso robô" : base, // URLs de terceiros: só host e caminho
      segredo_confere: nosso ? s === webhookSecret : null,
      tem_segredo_na_url: nosso ? s.length > 0 : null,
      events: w?.events,
      excludeMessages: w?.excludeMessages,
      addUrlEvents: w?.addUrlEvents,
      addUrlTypesMessages: w?.addUrlTypesMessages,
    };
  });

  return Response.json({
    servidor: urlBase(),
    ligacao,
    instancia: resumoStatus,
    webhook_http: wh.http,
    webhook_erro: wh.erro ?? (wh.http !== 200 ? wh.inicio ?? wh.json : undefined),
    webhooks,
  });
});
