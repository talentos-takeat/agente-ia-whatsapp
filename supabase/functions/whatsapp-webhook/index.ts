// Recebe os eventos da UZAPI (formato WhatsApp Cloud API).
// Segurança: o segredo vai na URL configurada no painel (?s=...). Sem ele, 401.
// Responde 200 rápido; o processamento roda em segundo plano.

import { config, configNumero, db, segredo as lerSegredo } from "../_shared/db.ts";
import { formato, log, mascararTelefone } from "../_shared/log.ts";
import { processarConversa } from "../_shared/processar.ts";
import { phoneNumberId } from "../_shared/uzapi.ts";

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
  delivered: "entregue",
  read: "lida",
  failed: "falhou",
};

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

  // Verificação no padrão Meta (GET com hub.challenge), caso a UZAPI faça
  if (req.method === "GET") {
    const token = url.searchParams.get("hub.verify_token") ?? recebido;
    const challenge = url.searchParams.get("hub.challenge");
    if (segredo && challenge && iguais(token, segredo)) return new Response(challenge);
    return new Response("ok", { status: segredo && iguais(recebido, segredo) ? 200 : 401 });
  }
  if (req.method !== "POST") return new Response("método não permitido", { status: 405 });

  if (!segredo || !iguais(recebido, segredo)) {
    await log("aviso", "webhook", "segredo_invalido", { ip: req.headers.get("x-forwarded-for") });
    return new Response("não autorizado", { status: 401 });
  }

  // deno-lint-ignore no-explicit-any
  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return new Response("json inválido", { status: 400 });
  }

  try {
    if ((await config())["registrar_formato_webhook"] === true) {
      await log("info", "webhook", "payload_formato", formato(payload));
    }

    const conversasParaProcessar = new Set<string>();

    for (const entry of payload?.entry ?? []) {
      for (const change of entry?.changes ?? []) {
        const v = change?.value ?? {};

        // Garante que o evento é do nosso número
        const pnid = v?.metadata?.phone_number_id;
        if (pnid && String(pnid) !== phoneNumberId()) {
          await log("aviso", "webhook", "outro_numero", { pnid });
          continue;
        }

        // Status das mensagens que enviamos
        for (const st of v?.statuses ?? []) {
          const novo = STATUS_SAIDA[st?.status];
          if (!novo || !st?.id) continue;
          await db().from("mensagens")
            .update({ status: novo, ...(novo === "falhou" ? { erro: JSON.stringify(st?.errors ?? []).slice(0, 500) } : {}) })
            .eq("provedor_msg_id", st.id)
            .eq("direcao", "saida");
        }

        // Mensagens recebidas
        const nomes = new Map<string, string>();
        for (const c of v?.contacts ?? []) if (c?.wa_id) nomes.set(String(c.wa_id), c?.profile?.name ?? null);

        for (const m of v?.messages ?? []) {
          const telefone = String(m?.from ?? "").replace(/\D/g, "");
          if (!telefone || !m?.id) continue;
          const id = await registrarEntrada(m, telefone, nomes.get(telefone) ?? null);
          if (id) conversasParaProcessar.add(id);
        }
      }
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
    // Mesmo com erro respondemos 200 para a UZAPI não reenviar em loop;
    // o que foi gravado será reprocessado pela rotina periódica.
    await log("erro", "webhook", "falha_ao_registrar", { erro: (e as Error).message });
  }

  return new Response("ok");
});

/** Grava a mensagem (ignorando duplicadas). Devolve o id da conversa se for nova. */
// deno-lint-ignore no-explicit-any
async function registrarEntrada(m: any, telefone: string, nome: string | null): Promise<string | null> {
  const tipo = String(m?.type ?? "desconhecido");
  const conteudo: string | null =
    m?.text?.body ??
    m?.button?.text ??
    m?.interactive?.button_reply?.title ??
    m?.interactive?.list_reply?.title ??
    m?.image?.caption ?? m?.video?.caption ?? m?.document?.caption ??
    null;

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

  const { error: e3 } = await db().from("mensagens").insert({
    conversa_id: conversa.id,
    contato_id: contato.id,
    direcao: "entrada",
    autor: "contato",
    provedor_msg_id: String(m.id),
    tipo,
    conteudo,
    status: "recebida",
    criada_em: m?.timestamp ? new Date(Number(m.timestamp) * 1000).toISOString() : undefined,
  });
  if (e3) {
    if (e3.code === "23505") { // já recebida antes: não processa de novo
      await log("info", "webhook", "duplicada_ignorada", { telefone: mascararTelefone(telefone) });
      return null;
    }
    throw new Error(`mensagem: ${e3.message}`);
  }
  await db().from("conversas").update({ atualizada_em: new Date().toISOString() }).eq("id", conversa.id);
  return conversa.id;
}
