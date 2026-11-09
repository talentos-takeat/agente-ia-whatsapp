// Chamada a cada minuto pelo pg_cron: reprocessa mensagens paradas ou com erro.
// Protegida por segredo interno (header x-internal-secret), que fica no Vault do banco.

import { db, segredo as lerSegredo } from "../_shared/db.ts";
import { log } from "../_shared/log.ts";
import { processarConversa } from "../_shared/processar.ts";

Deno.serve(async (req) => {
  const segredo = await lerSegredo("internal_secret").catch(() => "");
  if (!segredo || req.headers.get("x-internal-secret") !== segredo) {
    return new Response("não autorizado", { status: 401 });
  }

  const { data, error } = await db().rpc("conversas_pendentes", { p_idade_seg: 20 });
  if (error) {
    await log("erro", "processar-pendentes", "consulta_falhou", { erro: error.message });
    return new Response("erro", { status: 500 });
  }

  const conversas = (data ?? []) as { conversa_id: string }[];
  for (const c of conversas) await processarConversa(c.conversa_id);
  if (conversas.length) {
    await log("info", "processar-pendentes", "reprocessadas", { conversas: conversas.length });
  }
  return Response.json({ conversas: conversas.length });
});
