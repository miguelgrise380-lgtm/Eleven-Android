import type { WebSource } from "../../shared/types";
import { withCors } from "../../shared/cors";

interface WikiPage {
  title?: string;
  fullurl?: string;
  extract?: string;
  index?: number;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

/** GET ?q=termo: resumo e links da Wikipédia (sem chave) para mostrar no painel de pesquisa. */
const handler = async (req: Request): Promise<Response> => {
  const query = (new URL(req.url).searchParams.get("q") ?? "").trim().slice(0, 200);
  if (!query) return json({ summary: "", sources: [] });

  const url = new URL("https://pt.wikipedia.org/w/api.php");
  const params: Record<string, string> = {
    action: "query",
    format: "json",
    generator: "search",
    gsrsearch: query,
    gsrlimit: "4",
    prop: "extracts|info",
    exintro: "1",
    explaintext: "1",
    exsentences: "4",
    inprop: "url",
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  try {
    const res = await fetch(url, { headers: { "User-Agent": "Eleven-Assistant/1.0" } });
    if (!res.ok) return json({ summary: "", sources: [] });
    const data = (await res.json()) as { query?: { pages?: Record<string, WikiPage> } };
    const pages = Object.values(data.query?.pages ?? {}).sort((a, b) => (a.index ?? 99) - (b.index ?? 99));

    const sources: WebSource[] = pages
      .filter((p) => p.title && p.fullurl)
      .map((p) => ({ title: `${p.title ?? ""} — Wikipédia`, url: p.fullurl ?? "" }));
    const summary = (pages.find((p) => p.extract)?.extract ?? "").trim();
    return json({ summary, sources });
  } catch {
    return json({ summary: "", sources: [] });
  }
};

export default withCors(handler);
