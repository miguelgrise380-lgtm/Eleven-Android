import { withCors } from "../../shared/cors";

interface DeepgramGrantResponse {
  access_token?: string;
  expires_in?: number;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

const handler = async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return json({ error: "Método não permitido" }, 405);

  const apiKey = process.env["DEEPGRAM_API_KEY"];
  if (!apiKey) return json({ error: "DEEPGRAM_API_KEY não configurada" }, 500);

  // Token temporário: a chave real nunca vai para o navegador.
  const res = await fetch("https://api.deepgram.com/v1/auth/grant", {
    method: "POST",
    headers: { Authorization: `Token ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ttl_seconds: 60 }),
  });

  if (!res.ok) return json({ error: `Deepgram respondeu ${res.status}` }, 502);

  const data = (await res.json()) as DeepgramGrantResponse;
  if (!data.access_token) return json({ error: "Token ausente na resposta" }, 502);

  return json({ token: data.access_token });
};

export default withCors(handler);
