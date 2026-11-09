import { db } from "./db.ts";
import { log, mascararTelefone } from "./log.ts";
import { enviarTexto, ErroEnvio } from "./uzapi.ts";

const MAX_TENTATIVAS = 4;

type Mensagem = {
  id: string;
  conversa_id: string;
  contato_id: string;
  conteudo: string | null;
  tipo: string;
  provedor_msg_id: string | null;
  tentativas: number;
  criada_em: string;
};

/** Resultado que o "cérebro" devolve para uma leva de mensagens. */
export type Resposta = {
  texto: string;
  resultado: "respondida" | "sem_resposta" | "pediu_contexto" | "encaminhada" | "limite" | "fora_escopo";
  modelo?: string;
  tokens_entrada?: number;
  tokens_saida?: number;
  tokens_cache_lidos?: number;
  tokens_cache_gravados?: number;
  custo_usd?: number;
  fontes?: unknown;
};

/**
 * Etapa 4 (teste sem IA): só confirma o recebimento.
 * Na etapa 5 esta função passa a chamar o Claude.
 */
async function gerarResposta(entradas: Mensagem[]): Promise<Resposta> {
  const textos = entradas.map((m) => m.conteudo ?? `[${m.tipo}]`).join(" / ");
  return {
    texto: `Oi! Recebi sua mensagem: "${textos.slice(0, 300)}"\n\nEstou em fase de testes e logo vou responder suas dúvidas de verdade.`,
    resultado: "respondida",
  };
}

/** Processa todas as mensagens pendentes de uma conversa (seguro contra execução dupla). */
export async function processarConversa(conversaId: string): Promise<void> {
  const inicio = Date.now();
  const { data: entradas, error } = await db().rpc("reservar_mensagens", { p_conversa_id: conversaId });
  if (error) {
    await log("erro", "processar", "reserva_falhou", { conversaId, erro: error.message });
    return;
  }
  if (!entradas?.length) return; // outra execução já pegou

  const msgs = entradas as Mensagem[];
  const ids = msgs.map((m) => m.id);

  try {
    const { data: conversa, error: e1 } = await db()
      .from("conversas")
      .select("id, modo, modo_humano_ate, contatos(telefone, bloqueado, tipo)")
      .eq("id", conversaId)
      .single();
    if (e1 || !conversa) throw new Error(`conversa não encontrada: ${e1?.message}`);
    // deno-lint-ignore no-explicit-any
    const contato = (conversa as any).contatos as { telefone: string; bloqueado: boolean; tipo: string };

    // Bot pausado (humano atendendo) ou contato bloqueado: registra e não responde
    const humanoAtivo = conversa.modo === "humano" &&
      (!conversa.modo_humano_ate || new Date(conversa.modo_humano_ate) > new Date());
    if (humanoAtivo || contato.bloqueado) {
      await db().from("mensagens")
        .update({ status: "ignorada", processada_em: new Date().toISOString() })
        .in("id", ids);
      return;
    }

    const resposta = await gerarResposta(msgs);
    // Em grupo, responde em cima da mensagem de quem perguntou
    const citar = contato.tipo === "grupo" ? msgs[msgs.length - 1].provedor_msg_id : null;
    await responder(conversaId, msgs, contato.telefone, resposta, Date.now() - inicio, citar);
  } catch (e) {
    await marcarErro(msgs, e as Error);
  }
}

async function responder(
  conversaId: string,
  entradas: Mensagem[],
  telefone: string,
  r: Resposta,
  latenciaGeracao: number,
  citar: string | null = null,
) {
  const ultima = entradas[entradas.length - 1];
  const { data: saida, error } = await db().from("mensagens").insert({
    conversa_id: conversaId,
    contato_id: ultima.contato_id,
    direcao: "saida",
    autor: "bot",
    conteudo: r.texto,
    status: "pendente",
    resultado: r.resultado,
    resposta_de: ultima.id,
    modelo: r.modelo,
    tokens_entrada: r.tokens_entrada,
    tokens_saida: r.tokens_saida,
    tokens_cache_lidos: r.tokens_cache_lidos,
    tokens_cache_gravados: r.tokens_cache_gravados,
    custo_usd: r.custo_usd,
    latencia_ms: latenciaGeracao,
    fontes: r.fontes ?? null,
  }).select("id").single();
  if (error) throw new Error(`gravar saída: ${error.message}`);

  try {
    const msgId = await enviarTexto(telefone, r.texto, citar);
    const agora = new Date().toISOString();
    await db().from("mensagens")
      .update({ status: "enviada", provedor_msg_id: msgId, processada_em: agora })
      .eq("id", saida.id);
    await db().from("mensagens")
      .update({ status: "respondida", resultado: r.resultado, processada_em: agora, erro: null })
      .in("id", entradas.map((m) => m.id));
    await log("info", "processar", "respondida", {
      telefone: mascararTelefone(telefone),
      mensagens: entradas.length,
      resultado: r.resultado,
    });
  } catch (e) {
    await db().from("mensagens")
      .update({ status: "falhou", erro: (e as Error).message.slice(0, 500) })
      .eq("id", saida.id);
    throw e;
  }
}

async function marcarErro(msgs: Mensagem[], e: Error) {
  const temporario = !(e instanceof ErroEnvio) || e.temporario;
  for (const m of msgs) {
    const esgotou = !temporario || m.tentativas >= MAX_TENTATIVAS;
    // nova tentativa em 30s, 1min, 2min, 4min
    const espera = 30_000 * 2 ** Math.max(0, m.tentativas - 1);
    await db().from("mensagens").update({
      status: "erro",
      erro: e.message.slice(0, 500),
      tentativas: esgotou ? MAX_TENTATIVAS : m.tentativas,
      proxima_tentativa_em: new Date(Date.now() + espera).toISOString(),
    }).eq("id", m.id);
  }
  await log("erro", "processar", "falha_processamento", {
    conversaId: msgs[0]?.conversa_id,
    erro: e.message.slice(0, 500),
    tentativas: msgs[0]?.tentativas,
  });
}
