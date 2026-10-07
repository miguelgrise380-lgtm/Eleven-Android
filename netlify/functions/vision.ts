/** [PHOTO] Analisa uma imagem com um modelo de visão da Groq. POST { image, question, json?, thorough?, think? } */
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

// A Groq aposenta modelos com frequência (llama-4-scout saiu em 17/07/2026, qwen3.6-27b em 14/09/2026).
// Defina GROQ_VISION_MODEL no Netlify (pode ser uma lista separada por vírgula) para trocar sem mexer no código.
const DEFAULT_MODELS = "qwen/qwen3.8-27b";

interface GroqReply {
  choices?: { message?: { content?: string } }[];
  error?: { message?: string };
}

export default async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return json({ error: "Método não permitido" }, 405);
  const key = process.env["GROQ_API_KEY"];
  if (!key) return json({ error: "GROQ_API_KEY não configurada no Netlify." }, 500);

  let image = "";
  let question = "";
  let asJson = false;
  let thorough = false;
  let think = false;
  try {
    const b = (await req.json()) as { image?: string; question?: string; json?: boolean; thorough?: boolean; think?: boolean };
    image = typeof b.image === "string" ? b.image : "";
    question = typeof b.question === "string" ? b.question.slice(0, 1500) : "";
    asJson = b.json === true;
    thorough = b.thorough === true;
    think = b.think === true;
  } catch {
    return json({ error: "Requisição inválida" }, 400);
  }
  if (!/^data:image\/(?:jpeg|png|webp);base64,/.test(image) || image.length > 4_000_000) {
    return json({ error: "Imagem inválida ou grande demais" }, 400);
  }

  const prompt = asJson
    ? `${question}\nNão identifique pessoas reais pelo rosto.`
    : `${question || "Descreva o que aparece nesta foto."}\nResponda em português do Brasil, sem markdown. ${
        thorough ? "Seja completo, preciso e organizado." : "Seja breve (até 4 frases)."
      } Não identifique pessoas reais pelo rosto: descreva-as de forma geral (aparência, roupa, ação).`;

  const models = (process.env["GROQ_VISION_MODEL"] || DEFAULT_MODELS).split(",").map((m) => m.trim()).filter(Boolean);
  // Do mais específico ao mais simples: nem todo modelo aceita os parâmetros de raciocínio.
  const variants: Record<string, unknown>[] = think ? [{}, { reasoning_format: "hidden" }] : [{ reasoning_effort: "none" }, { reasoning_format: "hidden" }, {}];

  let lastError = "";
  for (const model of models) {
    for (const extra of variants) {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          temperature: asJson ? 0 : think ? 0.6 : 0.2,
          max_tokens: think ? 6000 : thorough || asJson ? 3000 : 1500,
          ...(asJson ? { response_format: { type: "json_object" } } : {}),
          ...extra,
          messages: [{ role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: image } }] }],
        }),
      });
      const data = (await res.json().catch(() => ({}))) as GroqReply;
      if (res.ok) {
        const text = (data.choices?.[0]?.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
        if (text) return json({ text, model });
        lastError = "resposta vazia";
        continue;
      }
      lastError = `Groq ${res.status}: ${(data.error?.message ?? "").slice(0, 160)}`;
      if (res.status !== 400 && res.status !== 404) break; // 400 = parâmetro não aceito (tenta o próximo); 404 = modelo aposentado
      if (res.status === 404) break;
    }
  }
  return json({ error: `${lastError || "A análise falhou."} (modelo(s): ${models.join(", ")}; se foi aposentado, troque GROQ_VISION_MODEL no Netlify)` }, 502);
};
