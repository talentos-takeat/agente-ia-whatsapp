// Cliente da uazapi (docs.uazapi.com).
// POST {UAZAPI_URL}/send/text  com header "token: {UZAPI_TOKEN}"  body {number, text}

export class ErroEnvio extends Error {
  constructor(msg: string, public status?: number, public temporario = true) {
    super(msg);
  }
}

const URL_PADRAO = "https://automate-takeat.uazapi.com";

function env(nome: string): string {
  const v = Deno.env.get(nome);
  if (!v) throw new ErroEnvio(`Secret ${nome} não configurado`, undefined, false);
  return v.trim();
}

export function urlBase(): string {
  return (Deno.env.get("UAZAPI_URL") ?? URL_PADRAO).trim().replace(/\/+$/, "");
}

export function tokenInstancia(): string {
  return env("UZAPI_TOKEN");
}

/** Envia texto e devolve o ID da mensagem no WhatsApp. */
export async function enviarTexto(para: string, texto: string): Promise<string | null> {
  let resp: Response;
  try {
    resp = await fetch(`${urlBase()}/send/text`, {
      method: "POST",
      headers: { "Content-Type": "application/json", token: tokenInstancia() },
      body: JSON.stringify({ number: para, text: texto, linkPreview: false }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new ErroEnvio(`Falha de rede ao enviar: ${(e as Error).message}`);
  }

  const corpo = await resp.text();
  if (!resp.ok) {
    // 4xx (exceto 429) = problema no pedido: não adianta tentar de novo igual
    const temporario = resp.status === 429 || resp.status >= 500;
    throw new ErroEnvio(`uazapi ${resp.status}: ${corpo.slice(0, 300)}`, resp.status, temporario);
  }
  try {
    const json = JSON.parse(corpo);
    // messageid = ID do WhatsApp (é o que volta nos eventos de status e de mensagem)
    return json?.messageid ?? json?.message?.messageid ?? json?.id ?? null;
  } catch {
    return null;
  }
}
