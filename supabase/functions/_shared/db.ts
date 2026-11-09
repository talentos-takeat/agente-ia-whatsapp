import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.49.4";

let cliente: SupabaseClient | null = null;

/** Cliente com service_role: só roda no servidor (Edge Functions). */
export function db(): SupabaseClient {
  if (!cliente) {
    cliente = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );
  }
  return cliente;
}

const cacheSegredos = new Map<string, string>();

/** Lê um segredo interno do Vault do banco (webhook_secret, internal_secret). */
export async function segredo(nome: string): Promise<string> {
  const emCache = cacheSegredos.get(nome);
  if (emCache) return emCache;
  const { data, error } = await db().rpc("ler_segredo", { p_nome: nome });
  if (error || !data) throw new Error(`segredo ${nome} indisponível`);
  cacheSegredos.set(nome, data as string);
  return data as string;
}

let cacheConfig: { valores: Record<string, unknown>; em: number } | null = null;

/** Lê config_agente com cache de 60s (mudanças no banco valem em até 1 minuto). */
export async function config(): Promise<Record<string, unknown>> {
  if (cacheConfig && Date.now() - cacheConfig.em < 60_000) return cacheConfig.valores;
  const { data, error } = await db().from("config_agente").select("chave, valor");
  if (error) throw new Error(`config_agente: ${error.message}`);
  const valores = Object.fromEntries((data ?? []).map((r) => [r.chave, r.valor]));
  cacheConfig = { valores, em: Date.now() };
  return valores;
}

export async function configNumero(chave: string, padrao: number): Promise<number> {
  const v = Number((await config())[chave]);
  return Number.isFinite(v) ? v : padrao;
}
