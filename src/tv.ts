/**
 * [TV-SMARTTHINGS] Comandos de voz para a TV Samsung (via função netlify/functions/tv.ts).
 * Módulo isolado: expõe só parseTvCommand() e runTv(). Remova este arquivo e os trechos
 * [TV-SMARTTHINGS] de src/main.ts para desligar a integração (veja docs/TV_SMARTTHINGS.md).
 */

export type TvAction =
  | "power_on"
  | "power_off"
  | "volume_up"
  | "volume_down"
  | "set_volume"
  | "mute"
  | "unmute"
  | "channel_up"
  | "channel_down"
  | "input"
  | "launch_app";

export interface TvIntent {
  action: TvAction;
  steps?: number;
  value?: number | string;
  /** Frase falada quando dá certo. */
  done: string;
  /** Só abre se o app estiver no catálogo (modo TV sem dizer "na TV"); senão o pedido segue o fluxo normal. */
  strict?: boolean;
  /** Ação local (sem rede), ex.: trocar o modo. */
  local?: () => void;
}

const MODE_KEY = "eleven.openTarget";
const tvMode = (): boolean => {
  try {
    return localStorage.getItem(MODE_KEY) === "tv";
  } catch {
    return false;
  }
};
const setMode = (mode: "tv" | "browser"): void => {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* sem armazenamento */
  }
};

const LAUNCH_VERB = /^(?:por favor\s+)?(?:abr\w+|inicia\w*|executa\w*|roda|coloca|poe|bota|liga|passa|vai)\s+/;
const TV_PHRASE = /\s*\b(?:(?:na|da|pra|para a|para|no|em|pela|pelo|de)\s+)?(?:a\s+)?(?:tv|televisao|tele)\b/;

/** "abre o youtube na tv", "abre netflix" (modo TV)... Devolve null se não for pedido de app. */
function parseLaunch(t: string, hasTv: boolean): TvIntent | null {
  if (!LAUNCH_VERB.test(t)) return null;
  if (!hasTv && !tvMode()) return null;
  const name = t
    .replace(TV_PHRASE, " ")
    .replace(LAUNCH_VERB, "")
    .replace(/^(?:o|a|os|as|um|uma)\s+/, "")
    .replace(/^(?:aplicativo|app|aplicacao|canal)\s+(?:do |da |de )?/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!name || name.length > 40) return null;
  const pretty = name.replace(/\b\w/g, (c) => c.toUpperCase());
  return { action: "launch_app", value: name, strict: !hasTv, done: `Abrindo ${pretty} na TV.` };
}

const KEY_STORAGE = "eleven.tvKey";

const norm = (t: string): string =>
  t
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const TV = /\b(tv|televisao|tele)\b/;
const VOLUME = /\bvolume\b/;

/** Reconhece pedidos para a TV. Devolve null quando o texto não é sobre a TV (segue o fluxo normal). */
export function parseTvCommand(raw: string): TvIntent | null {
  const t = norm(raw);
  if (!t) return null;
  const hasTv = TV.test(t);

  // Modo: onde "abre o YouTube" deve abrir (TV ou aqui no navegador)
  if (/\bmodo (?:tv|televisao)\b/.test(t)) {
    return { action: "launch_app", done: "Modo TV ativado. Agora abro os aplicativos na TV.", local: () => setMode("tv") };
  }
  if (/\bmodo (?:normal|navegador|computador|celular)\b/.test(t)) {
    return { action: "launch_app", done: "Modo normal. Volto a abrir os sites aqui.", local: () => setMode("browser") };
  }

  // Aplicativos da TV (antes da energia, para "liga o Netflix na TV" não virar "liga a TV")
  const launch = parseLaunch(t, hasTv);
  if (launch) return launch;

  // Energia (exige a palavra TV para não confundir com outros "liga/desliga")
  if (hasTv && /\b(desliga|desligar|desligue|apaga|apague)\b/.test(t)) return { action: "power_off", done: "Desligando a TV." };
  if (hasTv && /\b(liga|ligar|ligue|acende|acenda)\b/.test(t)) return { action: "power_on", done: "Ligando a TV." };

  // Volume
  if (VOLUME.test(t)) {
    const num = /\b(\d{1,3})\b/.exec(t)?.[1];
    const up = /\b(aument\w+|sobe|subir|suba|eleva\w*|mais alto|maior|mais)\b/.test(t);
    const down = /\b(diminu\w+|abaix\w+|baix\w+|reduz\w*|menos|menor|mais baixo)\b/.test(t);
    const relative = /\b(em|mais|menos)\s+\d/.test(t);

    if (num && !((up || down) && relative)) {
      const value = Math.min(100, Number(num));
      return { action: "set_volume", value, done: `Volume em ${value}.` };
    }
    const steps = num ? Math.min(20, Number(num)) : /\b(bastante|muito|bem mais)\b/.test(t) ? 8 : /\b(pouco|pouquinho|tiquinho)\b/.test(t) ? 1 : 3;
    if (down) return { action: "volume_down", steps, done: "Diminuindo o volume." };
    if (up) return { action: "volume_up", steps, done: "Aumentando o volume." };
  }

  // Som
  if (/\b(desmuta|desmutar|unmute|volta o som|volta som|tira do mudo|reativa o som)\b/.test(t)) return { action: "unmute", done: "Som de volta." };
  if (/\b(muta|mutar|mute)\b/.test(t) || (hasTv && /\bsilencia\w*\b/.test(t))) return { action: "mute", done: "TV no mudo." };

  // Canal e entrada
  if (/\b(proximo canal|canal seguinte|passa o canal|muda de canal)\b/.test(t)) return { action: "channel_up", done: "Próximo canal." };
  if (/\b(canal anterior|volta o canal|canal de antes)\b/.test(t)) return { action: "channel_down", done: "Canal anterior." };
  const hdmi = /\bhdmi\s*(\d)\b/.exec(t)?.[1];
  if (hdmi && (hasTv || /\b(muda|troca|coloca|poe|entrada|fonte)\b/.test(t))) {
    return { action: "input", value: `HDMI${hdmi}`, done: `Entrada HDMI ${hdmi}.` };
  }

  return null;
}

function accessKey(): string | null {
  try {
    const saved = localStorage.getItem(KEY_STORAGE);
    if (saved) return saved;
    const typed = window.prompt("Digite a chave de acesso da TV (a mesma de TV_ACCESS_KEY no Netlify):")?.trim();
    if (typed) {
      localStorage.setItem(KEY_STORAGE, typed);
      return typed;
    }
  } catch {
    /* sem prompt/armazenamento */
  }
  return null;
}

/** Executa o pedido e devolve a frase que a Eleven deve falar. */
export async function runTv(intent: TvIntent): Promise<string | null> {
  if (intent.local) {
    intent.local();
    return intent.done;
  }
  const key = accessKey();
  if (!key) return "Preciso da chave de acesso da TV para continuar.";

  let res: Response;
  try {
    res = await fetch("/.netlify/functions/tv", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-tv-key": key },
      body: JSON.stringify({ action: intent.action, steps: intent.steps, value: intent.value, strict: intent.strict }),
    });
  } catch {
    return "Não consegui falar com o servidor da TV.";
  }

  if (res.ok) return intent.done;
  const info = (await res.json().catch(() => ({}))) as { error?: string; status?: number };
  const err = info.error;
  if (err === "unknown_app") return intent.strict ? null : "Não conheço esse aplicativo da TV.";
  if (info.status === 409) return "A TV precisa estar ligada para abrir aplicativos. Diga: liga a TV.";
  if (res.status === 401) {
    localStorage.removeItem(KEY_STORAGE);
    return "A chave da TV está incorreta. Vou pedir de novo no próximo comando.";
  }
  if (err === "not_configured" || res.status === 501) return "A integração com a TV ainda não está configurada.";
  if (err === "reauthorize") return "Preciso que você autorize a SmartThings de novo.";
  return "A TV não respondeu. Ela está conectada ao SmartThings?";
}
