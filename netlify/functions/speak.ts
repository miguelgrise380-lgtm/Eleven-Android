import { withCors } from "../../shared/cors";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const handler = async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return json({ error: "Método não permitido" }, 405);

  const apiKey = process.env["ELEVENLABS_API_KEY"];
  if (!apiKey) return json({ error: "ELEVENLABS_API_KEY não configurada" }, 500);

  let text = "";
  try {
    const body = (await req.json()) as { text?: unknown };
    if (typeof body.text === "string") text = body.text.trim().slice(0, 3000);
  } catch {
    return json({ error: "JSON inválido" }, 400);
  }
  if (!text) return json({ error: "Texto vazio" }, 400);

  const voiceId = process.env["ELEVENLABS_VOICE_ID"] ?? "JBFqnCBsd6RMkjVDRZzb";
  const modelId = process.env["ELEVENLABS_MODEL"] ?? "eleven_flash_v2_5";

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ text, model_id: modelId, language_code: "pt" }),
    },
  );

  if (!res.ok) {
    let detail = "";
    try {
      const err = (await res.json()) as { detail?: { status?: string; message?: string } | string };
      detail =
        typeof err.detail === "string"
          ? err.detail
          : [err.detail?.status, err.detail?.message].filter(Boolean).join(": ");
    } catch {
      // corpo sem JSON
    }
    return json({ error: `ElevenLabs ${res.status}${detail ? ` — ${detail}` : ""}` }, 502);
  }

  return new Response(await res.arrayBuffer(), {
    status: 200,
    headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" },
  });
};

export default withCors(handler);
