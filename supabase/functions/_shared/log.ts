import { db } from "./db.ts";

type Nivel = "info" | "aviso" | "erro";

/** 5527999554340 -> 5527*****4340 */
export function mascararTelefone(tel: string | null | undefined): string {
  if (!tel) return "";
  const d = tel.replace(/\D/g, "");
  return d.length <= 8 ? "****" : `${d.slice(0, 4)}${"*".repeat(d.length - 8)}${d.slice(-4)}`;
}

/** Remove qualquer coisa parecida com segredo antes de gravar. */
function limpar(detalhes: unknown): unknown {
  const texto = JSON.stringify(detalhes ?? null)
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "[chave]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [token]")
    .replace(/\b\d{12,13}\b/g, (m) => mascararTelefone(m));
  return JSON.parse(texto);
}

/** Grava no eventos_log e no console. Nunca lança erro. */
export async function log(nivel: Nivel, origem: string, evento: string, detalhes?: unknown) {
  const d = limpar(detalhes);
  const linha = JSON.stringify({ nivel, origem, evento, detalhes: d });
  if (nivel === "erro") console.error(linha); else console.log(linha);
  try {
    await db().from("eventos_log").insert({ nivel, origem, evento, detalhes: d });
  } catch (_) { /* log nunca derruba o fluxo */ }
}

/** Formato do payload sem os valores (para depuração sem dados pessoais). */
export function formato(obj: unknown, prof = 0): unknown {
  if (prof > 8) return "…";
  if (Array.isArray(obj)) return obj.length ? [formato(obj[0], prof + 1)] : [];
  if (obj && typeof obj === "object") {
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, formato(v, prof + 1)]));
  }
  return typeof obj;
}
