// Recebe os eventos da uazapi (eventos "messages" e "messages_update").
// Segurança: o segredo vai na URL configurada no painel (?s=...). Sem ele, 401.
// Responde 200 rápido; o processamento roda em segundo plano.

import { config, configNumero, db, segredo as lerSegredo } from "../_shared/db.ts";
import { formato, log, mascararTelefone } from "../_shared/log.ts";
import { processarConversa } from "../_shared/processar.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

function iguais(a: string, b: string): boolean {
  // comparação em tempo constante
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let dif = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) dif |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return dif === 0;
}

const STATUS_SAIDA: Record<string, string> = {
  sent: "enviada",
  serverack: "enviada",
  delivered: "entregue",
  deliveryack: "entregue",
  read: "lida",
  played: "lida",
  failed: "falhou",
  error: "falhou",
};

// deno-lint-ignore no-explicit-any
type Qualquer = any;

Deno.serve(async (req) => {
  const url = new URL(req.url);
  let segredo = "";
  try {
    segredo = await lerSegredo("webhook_secret");
  } catch (e) {
    await log("erro", "webhook", "segredo_indisponivel", { erro: (e as Error).message });
    return new Response("indisponível", { status: 503 });
  }
  const recebido = url.searchParams.get("s") ?? req.headers.get("x-webhook-secret") ?? "";

  if (req.method === "GET") {
    return new Response("ok", { status: iguais(recebido, segredo) ? 200 : 401 });
  }
  if (req.method !== "POST") return new Response("método não permitido", { status: 405 });

  if (!iguais(recebido, segredo)) {
    await log("aviso", "webhook", "segredo_invalido", { ip: req.headers.get("x-forwarded-for") });
    return new Response("não autorizado", { status: 401 });
  }

  let payload: Qualquer;
  try {
    payload = await req.json();
  } catch {
    return new Response("json inválido", { status: 400 });
  }

  // Se a uazapi mandar o token da instância no corpo, confere que é a nossa
  const tokenNoCorpo = typeof payload?.token === "string" ? payload.token : "";
  const nossoToken = (Deno.env.get("UZAPI_TOKEN") ?? "").trim();
  if (tokenNoCorpo && nossoToken && !iguais(tokenNoCorpo, nossoToken)) {
    await log("aviso", "webhook", "outra_instancia", {});
    return new Response("ok");
  }

  try {
    if ((await config())["registrar_formato_webhook"] === true) {
      await log("info", "webhook", "payload_formato", formato(payload));
    }

    const tipoEvento = String(payload?.EventType ?? (typeof payload?.event === "string" ? payload.event : "") ?? "")
      .toLowerCase();

    if (tipoEvento.includes("update")) {
      await atualizarStatus(payload);
      return new Response("ok");
    }

    const lista: Qualquer[] = Array.isArray(payload?.message)
      ? payload.message
      : payload?.message ? [payload.message] : Array.isArray(payload?.messages) ? payload.messages : [];

    const conversasParaProcessar = new Set<string>();
    for (const m of lista) {
      const id = await tratarMensagem(m, payload);
      if (id) conversasParaProcessar.add(id);
    }

    // Espera alguns segundos para juntar mensagens seguidas e responde de uma vez
    if (conversasParaProcessar.size) {
      const janela = await configNumero("janela_agrupamento_seg", 5);
      EdgeRuntime.waitUntil((async () => {
        await new Promise((r) => setTimeout(r, janela * 1000));
        for (const c of conversasParaProcessar) await processarConversa(c);
      })());
    }
  } catch (e) {
    // Mesmo com erro respondemos 200 para a uazapi não reenviar em loop;
    // o que foi gravado será reprocessado pela rotina periódica.
    await log("erro", "webhook", "falha_ao_registrar", { erro: (e as Error).message });
  }

  return new Response("ok");
});

/** Extrai só os dígitos de um ID de WhatsApp de pessoa (ignora @lid, que não é telefone). */
function telefoneDe(...candidatos: unknown[]): string {
  for (const c of candidatos) {
    if (typeof c !== "string" || !c) continue;
    if (c.includes("@lid") || c.includes("@g.us") || c.includes("@newsletter")) continue;
    const d = c.split("@")[0].split(":")[0].replace(/\D/g, "");
    if (d.length >= 10 && d.length <= 15) return d;
  }
  return "";
}

async function tratarMensagem(m: Qualquer, payload: Qualquer): Promise<string | null> {
  const chatid = String(m?.chatid ?? payload?.chat?.wa_chatid ?? "");
  if (m?.isGroup === true || chatid.endsWith("@g.us") || chatid.endsWith("@newsletter")) return null;
  if (m?.wasSentByApi === true) return null; // enviada pelo próprio robô

  const msgId = String(m?.messageid ?? m?.id ?? "");
  const telefone = telefoneDe(chatid, m?.sender_pn, payload?.chat?.phone, m?.sender);
  if (!msgId || !telefone) {
    await log("aviso", "webhook", "mensagem_sem_id_ou_telefone", { temId: !!msgId, chatid: chatid.split("@")[1] ?? "" });
    return null;
  }

  const conteudo: string | null =
    (typeof m?.text === "string" && m.text) ||
    m?.content?.text ||
    (typeof m?.content === "string" ? m.content : null) ||
    m?.content?.caption ||
    m?.content?.selectedDisplayText ||
    null;
  const tipo = String(m?.messageType ?? m?.type ?? "desconhecido");
  let ts = Number(m?.messageTimestamp ?? 0);
  if (ts && ts < 1e12) ts *= 1000; // veio em segundos
  const criadaEm = ts ? new Date(ts).toISOString() : undefined;

  const fromMe = m?.fromMe === true;
  const nome = fromMe ? null : (m?.senderName ?? payload?.chat?.name ?? null);
  const { contatoId, conversaId } = await obterConversa(telefone, nome);

  if (fromMe) {
    // Mensagem enviada pelo número da Takeat, mas não pelo robô:
    // alguém respondeu pelo WhatsApp Web. O robô pausa nessa conversa.
    await registrarRespostaHumana(contatoId, conversaId, msgId, tipo, conteudo, criadaEm, telefone);
    return null;
  }

  const { error } = await db().from("mensagens").insert({
    conversa_id: conversaId,
    contato_id: contatoId,
    direcao: "entrada",
    autor: "contato",
    provedor_msg_id: msgId,
    tipo,
    conteudo,
    status: "recebida",
    criada_em: criadaEm,
  });
  if (error) {
    if (error.code === "23505") { // já recebida antes: não processa de novo
      await log("info", "webhook", "duplicada_ignorada", { telefone: mascararTelefone(telefone) });
      return null;
    }
    throw new Error(`mensagem: ${error.message}`);
  }
  await db().from("conversas").update({ atualizada_em: new Date().toISOString() }).eq("id", conversaId);
  return conversaId;
}

async function obterConversa(telefone: string, nome: string | null) {
  const { data: contato, error: e1 } = await db().from("contatos")
    .upsert(
      { telefone, ...(nome ? { nome } : {}), ultimo_contato_em: new Date().toISOString() },
      { onConflict: "telefone" },
    )
    .select("id").single();
  if (e1) throw new Error(`contato: ${e1.message}`);

  await db().from("conversas")
    .upsert({ contato_id: contato.id }, { onConflict: "contato_id", ignoreDuplicates: true });
  const { data: conversa, error: e2 } = await db().from("conversas")
    .select("id").eq("contato_id", contato.id).single();
  if (e2) throw new Error(`conversa: ${e2.message}`);
  return { contatoId: contato.id as string, conversaId: conversa.id as string };
}

async function registrarRespostaHumana(
  contatoId: string,
  conversaId: string,
  msgId: string,
  tipo: string,
  conteudo: string | null,
  criadaEm: string | undefined,
  telefone: string,
) {
  // Proteção extra: se for o eco de uma resposta recente do robô, ignora
  if (conteudo) {
    const { data: eco } = await db().from("mensagens").select("id")
      .eq("conversa_id", conversaId).eq("autor", "bot").eq("conteudo", conteudo)
      .gte("criada_em", new Date(Date.now() - 5 * 60_000).toISOString()).limit(1);
    if (eco?.length) return;
  }

  const { error } = await db().from("mensagens").insert({
    conversa_id: conversaId,
    contato_id: contatoId,
    direcao: "saida",
    autor: "humano",
    provedor_msg_id: msgId,
    tipo,
    conteudo,
    status: "enviada",
    criada_em: criadaEm,
  });
  if (error?.code === "23505") return; // já registrada (ou é a própria resposta do robô)
  if (error) throw new Error(`mensagem humana: ${error.message}`);

  const horas = await configNumero("horas_modo_humano", 24);
  await db().from("conversas").update({
    modo: "humano",
    modo_humano_ate: new Date(Date.now() + horas * 3_600_000).toISOString(),
    atualizada_em: new Date().toISOString(),
  }).eq("id", conversaId);
  await log("info", "webhook", "humano_assumiu", { telefone: mascararTelefone(telefone), horas });
}

async function atualizarStatus(payload: Qualquer) {
  const ev = typeof payload?.event === "object" && payload.event ? payload.event : {};
  const m = Array.isArray(payload?.message) ? payload.message[0] : payload?.message;
  const ids: string[] = (ev.MessageIDs ?? ev.messageIds ?? ev.MessageIds ?? (m?.messageid ? [m.messageid] : []))
    .map(String);
  const bruto = String(ev.Type ?? ev.type ?? payload?.state ?? m?.status ?? "").toLowerCase();
  const novo = STATUS_SAIDA[bruto];
  if (!novo || !ids.length) return;
  await db().from("mensagens")
    .update({ status: novo, ...(novo === "falhou" ? { erro: `status ${bruto}` } : {}) })
    .in("provedor_msg_id", ids)
    .eq("direcao", "saida")
    .eq("autor", "bot");
}
