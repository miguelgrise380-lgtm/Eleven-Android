interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: unknown;
  tool_call_id?: string;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

/** POST { messages }: repassa para a Groq e devolve o stream (SSE) sem expor a chave no navegador. */
export default async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return json({ error: "Método não permitido" }, 405);

  const key = process.env["GROQ_API_KEY"];
  if (!key) return json({ error: "GROQ_API_KEY não configurada no Netlify." }, 500);

  let messages: ChatMessage[];
  let tools: unknown[] | undefined;
  let effort: "low" | "medium" | "high" = "low";
  try {
    const body = (await req.json()) as { messages?: ChatMessage[]; tools?: unknown; effort?: string };
    if (body.effort === "medium" || body.effort === "high") effort = body.effort;
    messages = (body.messages ?? [])
      .filter((m) => m && ["system", "user", "assistant", "tool"].includes(m.role))
      .slice(-40)
      .map((m) => {
        const out: ChatMessage = { role: m.role, content: typeof m.content === "string" ? m.content.slice(0, 8000) : null };
        if (m.tool_calls) out.tool_calls = m.tool_calls;
        if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
        return out;
      });
    if (Array.isArray(body.tools) && body.tools.length > 0) tools = body.tools.slice(0, 24);
  } catch {
    return json({ error: "Requisição inválida" }, 400);
  }
  if (messages.length === 0) return json({ error: "Sem mensagens" }, 400);

  const model = process.env["GROQ_MODEL"] || "openai/gpt-oss-120b";
  const payload: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    temperature: 0.7,
    top_p: 0.9,
    max_tokens: effort === "low" ? 800 : 2500,
  };
  if (tools) {
    payload["tools"] = tools;
    payload["tool_choice"] = "auto";
  }
  // Modelos gpt-oss "pensam" antes de responder: raciocínio mínimo e escondido deixa a voz rápida.
  if (model.includes("gpt-oss")) {
    payload["reasoning_effort"] = effort;
    payload["include_reasoning"] = false;
  }

  const upstream = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    let reason = detail.slice(0, 200);
    try {
      reason = (JSON.parse(detail) as { error?: { message?: string } }).error?.message ?? reason;
    } catch {
      /* mantém o texto cru */
    }
    return json({ error: `Groq ${upstream.status}: ${reason}` }, 502);
  }

  return new Response(upstream.body, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" },
  });
};
