// Cliente da UZAPI Business. A API segue o formato da WhatsApp Cloud API (Meta):
// POST https://api.uzapi.com.br/{username}/v1/{phone_number_id}/messages
// Authorization: Bearer {token}

export class ErroEnvio extends Error {
  constructor(msg: string, public status?: number, public temporario = true) {
    super(msg);
  }
}

function env(nome: string): string {
  const v = Deno.env.get(nome);
  if (!v) throw new ErroEnvio(`Secret ${nome} não configurado`, undefined, false);
  return v.trim();
}

export function phoneNumberId(): string {
  return env("UZAPI_PHONE_NUMBER_ID");
}

/** Envia texto e devolve o ID da mensagem no WhatsApp. */
export async function enviarTexto(para: string, texto: string): Promise<string | null> {
  const url = `https://api.uzapi.com.br/${env("UZAPI_USERNAME")}/v1/${phoneNumberId()}/messages`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env("UZAPI_TOKEN")}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: para,
        type: "text",
        text: { body: texto },
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new ErroEnvio(`Falha de rede ao enviar: ${(e as Error).message}`);
  }

  const corpo = await resp.text();
  if (!resp.ok) {
    // 4xx (exceto 429) = problema no pedido: não adianta tentar de novo igual
    const temporario = resp.status === 429 || resp.status >= 500;
    throw new ErroEnvio(`UZAPI ${resp.status}: ${corpo.slice(0, 300)}`, resp.status, temporario);
  }
  try {
    const json = JSON.parse(corpo);
    return json?.messages?.[0]?.id ?? json?.id ?? json?.messageId ?? null;
  } catch {
    return null;
  }
}
