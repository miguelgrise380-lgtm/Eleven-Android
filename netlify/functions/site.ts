const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

/** GET ?q=nome: descobre o endereço oficial de qualquer site/app web (usa a Groq). Devolve { url: string | null }. */
export default async (req: Request): Promise<Response> => {
  const name = (new URL(req.url).searchParams.get("q") ?? "").trim().slice(0, 120);
  const key = process.env["GROQ_API_KEY"];
  if (!name || !key) return json({ url: null });

  const model = process.env["GROQ_MODEL"] || "openai/gpt-oss-120b";
  const payload: Record<string, unknown> = {
    model,
    temperature: 0,
    max_tokens: 200,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          'Você converte o nome falado de um site, app web, serviço ou página em seu endereço oficial. Responda SOMENTE JSON: {"url":"https://..."}. Prefira a versão web em português do Brasil quando existir. Se o pedido não for um site ou serviço da internet, responda {"url":null}. Nunca invente endereços.',
      },
      { role: "user", content: name },
    ],
  };
  if (model.includes("gpt-oss")) {
    payload["reasoning_effort"] = "low";
    payload["include_reasoning"] = false;
  }

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return json({ url: null });
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const parsed = JSON.parse(data.choices?.[0]?.message?.content ?? "{}") as { url?: unknown };
    if (typeof parsed.url !== "string") return json({ url: null });
    const u = new URL(parsed.url);
    return json({ url: u.protocol === "https:" || u.protocol === "http:" ? u.href : null });
  } catch {
    return json({ url: null });
  }
};
