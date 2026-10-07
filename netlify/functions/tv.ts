/**
 * [TV-SMARTTHINGS] Controle da TV Samsung via SmartThings.
 * Módulo isolado: para remover a integração, apague este arquivo, src/tv.ts, docs/TV_SMARTTHINGS.md
 * e os trechos marcados com [TV-SMARTTHINGS] em src/main.ts (veja o docs).
 *
 * Segurança: o token da SmartThings e o ID da TV ficam só aqui no servidor. O navegador precisa
 * enviar a chave TV_ACCESS_KEY (cabeçalho x-tv-key) e só ações da lista abaixo são aceitas.
 */
import { timingSafeEqual } from "node:crypto";
import { getStore } from "@netlify/blobs";
import { withCors } from "../../shared/cors";

const API = "https://api.smartthings.com/v1";
const TOKEN_URLS = ["https://api.smartthings.com/v1/oauth/token", "https://api.smartthings.com/oauth/token"];

interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

interface StCommand {
  component: "main";
  capability: string;
  command: string;
  arguments?: unknown[];
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

// ---------- Aplicativos da TV ----------
// A SmartThings não lista os apps instalados, então há um catálogo de IDs conhecidos (comunidade).
// Para adicionar outros, use a variável TV_APPS_JSON, ex.: {"max":"ID_DO_APP","pluto tv":"ID"}.
interface AppTarget {
  id?: string;
  name?: string;
}
const BUILTIN_APPS: Record<string, AppTarget> = {
  youtube: { id: "111299001912" },
  "you tube": { id: "111299001912" },
  netflix: { id: "3201907018807" },
  "prime video": { id: "3201910019365" },
  prime: { id: "3201910019365" },
  "amazon prime": { id: "3201910019365" },
  "amazon prime video": { id: "3201910019365" },
  "disney plus": { id: "3201901017640" },
  disney: { id: "3201901017640" },
  spotify: { id: "3201606009684" },
  "apple tv": { id: "3201807016597" },
  globoplay: { id: "3201908019022" },
  "globo play": { id: "3201908019022" },
  telecine: { id: "3201604009182" },
  "samsung tv plus": { id: "3201710015037" },
  tubi: { id: "3201504001965" },
  peacock: { id: "3202006020991" },
  smartthings: { id: "3201710015016" },
  "google meet": { id: "3202008021439" },
  internet: { name: "Internet" },
  navegador: { name: "Internet" },
  browser: { name: "Internet" },
};

const normName = (t: string): string =>
  t
    .toLowerCase()
    .replace(/\+/g, " plus")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function customApps(): Record<string, AppTarget> {
  try {
    const raw = JSON.parse(env("TV_APPS_JSON") || "{}") as Record<string, unknown>;
    const out: Record<string, AppTarget> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === "string" && /^[A-Za-z0-9._-]{1,40}$/.test(v)) out[normName(k)] = { id: v };
    }
    return out;
  } catch {
    return {};
  }
}

/** Catálogo (+ extras do usuário) e, se permitido, abre pelo nome falado como último recurso. */
function appCommand(spoken: string, strict: boolean): StCommand[] | null {
  const key = normName(spoken);
  if (!key) return null;
  const target = customApps()[key] ?? BUILTIN_APPS[key];
  if (target?.id) return [cmd("custom.launchapp", "launchApp", [target.id])];
  if (target?.name) return [cmd("custom.launchapp", "launchApp", ["", target.name])];
  if (strict || !/^[\p{L}\p{N} .+&'-]{1,40}$/u.test(spoken)) return null;
  return [cmd("custom.launchapp", "launchApp", ["", spoken])];
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

const env = (name: string): string => (process.env[name] ?? "").trim();
const cmd = (capability: string, command: string, args?: unknown[]): StCommand => ({
  component: "main",
  capability,
  command,
  ...(args ? { arguments: args } : {}),
});
const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, Math.round(n)));

/** Lista fechada de ações: nada fora dela chega à SmartThings. */
function buildCommands(action: string, value: unknown, steps: unknown): StCommand[] | null {
  const n = clamp(Number(steps) || 1, 1, 20);
  switch (action) {
    case "power_on":
      return [cmd("switch", "on")];
    case "power_off":
      return [cmd("switch", "off")];
    case "volume_up":
      return Array.from({ length: n }, () => cmd("audioVolume", "volumeUp"));
    case "volume_down":
      return Array.from({ length: n }, () => cmd("audioVolume", "volumeDown"));
    case "set_volume":
      return [cmd("audioVolume", "setVolume", [clamp(Number(value), 0, 100)])];
    case "mute":
      return [cmd("audioMute", "mute")];
    case "unmute":
      return [cmd("audioMute", "unmute")];
    case "channel_up":
      return [cmd("tvChannel", "channelUp")];
    case "channel_down":
      return [cmd("tvChannel", "channelDown")];
    case "input":
      return typeof value === "string" && /^[A-Za-z0-9]{1,16}$/.test(value) ? [cmd("mediaInputSource", "setInputSource", [value])] : null;
    default:
      return null;
  }
}

// ---------- Autenticação com a SmartThings ----------

function tokenStore(): { get(): Promise<Tokens | null>; set(t: Tokens): Promise<void> } | null {
  try {
    const store = getStore("smartthings");
    return {
      get: async () => ((await store.get("tokens", { type: "json" })) as Tokens | null) ?? null,
      set: async (t) => {
        await store.setJSON("tokens", t);
      },
    };
  } catch {
    return null; // fora do Netlify (ex.: teste local sem `netlify dev`)
  }
}

async function refresh(refreshToken: string): Promise<Tokens | null> {
  const id = env("SMARTTHINGS_CLIENT_ID");
  const secret = env("SMARTTHINGS_CLIENT_SECRET");
  for (const url of TOKEN_URLS) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${id}:${secret}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: id, refresh_token: refreshToken }),
    });
    if (res.status === 404) continue; // endereço antigo/novo
    if (!res.ok) return null;
    const d = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!d.access_token || !d.refresh_token) return null;
    return { access_token: d.access_token, refresh_token: d.refresh_token, expires_at: Date.now() + (d.expires_in ?? 86_000) * 1000 };
  }
  return null;
}

/**
 * Modo recomendado (OAuth): renova sozinho o token de 24 h e guarda o novo refresh token (uso único) no Netlify Blobs.
 * Modo simples: SMARTTHINGS_TOKEN (PAT), que a Samsung faz expirar em 24 h — só para testes.
 */
async function accessToken(force = false): Promise<string> {
  const oauth = env("SMARTTHINGS_CLIENT_ID") && env("SMARTTHINGS_CLIENT_SECRET");
  if (!oauth) {
    const pat = env("SMARTTHINGS_TOKEN");
    if (pat) return pat;
    throw new HttpError(501, "not_configured");
  }

  const store = tokenStore();
  const saved = await store?.get();
  if (!force && saved && saved.expires_at - Date.now() > 300_000) return saved.access_token;

  const candidates = [...new Set([saved?.refresh_token, env("SMARTTHINGS_REFRESH_TOKEN")].filter((t): t is string => !!t))];
  for (const rt of candidates) {
    const fresh = await refresh(rt);
    if (fresh) {
      await store?.set(fresh);
      return fresh.access_token;
    }
  }
  throw new HttpError(502, "reauthorize");
}

async function st(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
  const token = await accessToken(!retry);
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (res.status === 401 && retry) return st(path, init, false);
  return res;
}

// ---------- Handler ----------

const same = (a: string, b: string): boolean => {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const handler = async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return json({ error: "method" }, 405);

  const key = env("TV_ACCESS_KEY");
  const device = env("SMARTTHINGS_DEVICE_ID");
  if (!key || !device) return json({ error: "not_configured" }, 501);
  if (!same(req.headers.get("x-tv-key") ?? "", key)) return json({ error: "unauthorized" }, 401);

  let body: { action?: string; value?: unknown; steps?: unknown; strict?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  const action = String(body.action ?? "");

  try {
    if (action === "status") {
      const res = await st(`/devices/${encodeURIComponent(device)}/status`);
      if (!res.ok) return json({ error: "smartthings", status: res.status }, 502);
      const m = ((await res.json()) as { components?: { main?: Record<string, Record<string, { value?: unknown }>> } }).components?.main ?? {};
      return json({
        ok: true,
        power: m["switch"]?.["switch"]?.value ?? null,
        volume: m["audioVolume"]?.["volume"]?.value ?? null,
        muted: m["audioMute"]?.["mute"]?.value ?? null,
        input: m["mediaInputSource"]?.["inputSource"]?.value ?? null,
      });
    }

    if (action === "launch_app") {
      const launch = appCommand(typeof body.value === "string" ? body.value.trim() : "", body.strict === true);
      if (!launch) return json({ error: "unknown_app" }, 404);
      const res = await st(`/devices/${encodeURIComponent(device)}/commands`, {
        method: "POST",
        body: JSON.stringify({ commands: launch }),
      });
      if (!res.ok) return json({ error: "smartthings", status: res.status }, 502);
      return json({ ok: true });
    }

    const commands = buildCommands(action, body.value, body.steps);
    if (!commands) return json({ error: "unknown_action" }, 400);

    const res = await st(`/devices/${encodeURIComponent(device)}/commands`, {
      method: "POST",
      body: JSON.stringify({ commands }),
    });
    if (!res.ok) return json({ error: "smartthings", status: res.status }, 502);
    return json({ ok: true });
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.code }, e.status);
    return json({ error: "failed" }, 502);
  }
};

export default withCors(handler);
