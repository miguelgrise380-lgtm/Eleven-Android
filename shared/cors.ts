/**
 * CORS para o app Capacitor. O app roda em https://localhost (Android) ou capacitor://localhost (iOS),
 * então chamar as funções do Netlify é uma requisição entre origens e precisa destes cabeçalhos.
 * Origens extras: variável CORS_ORIGINS no Netlify (separadas por vírgula).
 */
const BASE_ORIGINS = [
  "https://localhost",
  "capacitor://localhost",
  "http://localhost",
  "http://localhost:5173",
  "http://localhost:8888",
];

function allowedOrigins(): Set<string> {
  const extra = (process.env["CORS_ORIGINS"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set([...BASE_ORIGINS, ...extra]);
}

type Handler = (req: Request) => Promise<Response> | Response;

export function withCors(handler: Handler): (req: Request) => Promise<Response> {
  return async (req) => {
    const origin = req.headers.get("origin") ?? "";
    const ok = origin !== "" && allowedOrigins().has(origin);

    if (req.method === "OPTIONS") {
      const h = new Headers({ Vary: "Origin" });
      if (ok) {
        h.set("Access-Control-Allow-Origin", origin);
        h.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        h.set("Access-Control-Allow-Headers", "Content-Type, x-tv-key");
        h.set("Access-Control-Max-Age", "86400");
      }
      return new Response(null, { status: 204, headers: h });
    }

    const res = await handler(req);
    if (!ok) return res;
    const headers = new Headers(res.headers);
    headers.set("Access-Control-Allow-Origin", origin);
    headers.append("Vary", "Origin");
    // res.body repassado como está: o stream (SSE) do /chat continua sem buffer.
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };
}
