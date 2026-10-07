/**
 * Roteador de comandos por regras. Um modelo de 0,6B não é confiável para chamar
 * ferramentas, então pedidos como "abre o YouTube" ou "pesquisa X" são entendidos aqui,
 * de forma instantânea; todo o resto vai para a conversa com a Groq.
 */

export type Command =
  | { kind: "page"; url: string; title: string; spoken: string; external?: boolean; playFirstVideo?: boolean; videoId?: string }
  | { kind: "resolve"; name: string; spoken: string }
  | { kind: "close"; spoken: string };

interface AppDef {
  name: string;
  url: string;
  search?: string; // {q} é substituído pela busca
  external?: boolean; // streaming com DRM: abre no navegador do sistema
  aliases: string[];
}

const APPS: AppDef[] = [
  { name: "YouTube", url: "https://www.youtube.com", search: "https://www.youtube.com/results?search_query={q}", aliases: ["youtube", "yt", "iutube", "you tube"] },
  { name: "Google", url: "https://www.google.com", search: "https://www.google.com/search?q={q}", aliases: ["google", "googl"] },
  { name: "Gmail", url: "https://mail.google.com", aliases: ["gmail", "email", "e-mail"] },
  { name: "Google Drive", url: "https://drive.google.com", aliases: ["google drive", "drive"] },
  { name: "Google Agenda", url: "https://calendar.google.com", aliases: ["google agenda", "agenda", "calendario"] },
  { name: "Google Maps", url: "https://www.google.com/maps", search: "https://www.google.com/maps/search/?api=1&query={q}", aliases: ["google maps", "maps", "mapa", "mapas"] },
  { name: "Spotify", url: "https://open.spotify.com", search: "https://open.spotify.com/search/{q}", external: true, aliases: ["spotify", "espotifai"] },
  { name: "Netflix", url: "https://www.netflix.com", search: "https://www.netflix.com/search?q={q}", external: true, aliases: ["netflix"] },
  { name: "Prime Video", url: "https://www.primevideo.com", external: true, aliases: ["prime video", "amazon prime", "prime"] },
  { name: "Disney Plus", url: "https://www.disneyplus.com", external: true, aliases: ["disney plus", "disney+", "disney"] },
  { name: "Max", url: "https://www.max.com", external: true, aliases: ["hbo max", "max"] },
  { name: "Globoplay", url: "https://globoplay.globo.com", external: true, aliases: ["globoplay", "globo play"] },
  { name: "WhatsApp", url: "https://web.whatsapp.com", aliases: ["whatsapp", "whats app", "zap", "zapzap"] },
  { name: "Telegram", url: "https://web.telegram.org", aliases: ["telegram"] },
  { name: "Instagram", url: "https://www.instagram.com", aliases: ["instagram", "insta"] },
  { name: "Facebook", url: "https://www.facebook.com", aliases: ["facebook", "face"] },
  { name: "X", url: "https://x.com", search: "https://x.com/search?q={q}", aliases: ["twitter", "x"] },
  { name: "TikTok", url: "https://www.tiktok.com", search: "https://www.tiktok.com/search?q={q}", aliases: ["tiktok", "tik tok"] },
  { name: "LinkedIn", url: "https://www.linkedin.com", aliases: ["linkedin"] },
  { name: "Reddit", url: "https://www.reddit.com", search: "https://www.reddit.com/search/?q={q}", aliases: ["reddit"] },
  { name: "Twitch", url: "https://www.twitch.tv", search: "https://www.twitch.tv/search?term={q}", aliases: ["twitch"] },
  { name: "Discord", url: "https://discord.com/app", aliases: ["discord"] },
  { name: "GitHub", url: "https://github.com", search: "https://github.com/search?q={q}", aliases: ["github", "git hub"] },
  { name: "Wikipédia", url: "https://pt.wikipedia.org", search: "https://pt.wikipedia.org/w/index.php?search={q}", aliases: ["wikipedia", "wiki"] },
  { name: "Amazon", url: "https://www.amazon.com.br", search: "https://www.amazon.com.br/s?k={q}", aliases: ["amazon"] },
  { name: "Mercado Livre", url: "https://www.mercadolivre.com.br", search: "https://lista.mercadolivre.com.br/{q}", aliases: ["mercado livre", "mercadolivre"] },
  { name: "iFood", url: "https://www.ifood.com.br", aliases: ["ifood", "i food"] },
  { name: "g1", url: "https://g1.globo.com", aliases: ["g1", "globo"] },
  { name: "ChatGPT", url: "https://chatgpt.com", aliases: ["chatgpt", "chat gpt"] },
  { name: "Gemini", url: "https://gemini.google.com", aliases: ["gemini"] },
  { name: "Pinterest", url: "https://www.pinterest.com", search: "https://www.pinterest.com/search/pins/?q={q}", aliases: ["pinterest"] },
  { name: "Outlook", url: "https://outlook.live.com", aliases: ["outlook", "hotmail"] },
  { name: "Notion", url: "https://www.notion.so", aliases: ["notion"] },
];

const ALIAS_INDEX: { alias: string; app: AppDef }[] = APPS.flatMap((app) =>
  app.aliases.map((alias) => ({ alias, app })),
).sort((a, b) => b.alias.length - a.alias.length);

const FAREWELLS = [
  "Até mais! Pode me chamar quando precisar.",
  "Tchau! Estou por aqui se precisar de mim.",
  "Até logo! Foi um prazer conversar.",
  "Combinado, até a próxima!",
  "Certo, vou ficar quietinha. É só dizer meu nome.",
];

const pick = <T>(list: T[]): T => list[Math.floor(Math.random() * list.length)] as T;

export const farewellLine = (): string => pick(FAREWELLS);

/** Tira acentos sem mudar o tamanho do texto (os índices continuam valendo para o original). */
const fold = (s: string): string =>
  s.normalize("NFC").replace(/[\u00C0-\u00FF]/g, (c) => c.normalize("NFD").charAt(0)).toLowerCase();

interface Span {
  s: number;
  e: number;
}

const stripLead = (f: string, sp: Span, re: RegExp): void => {
  const m = re.exec(f.slice(sp.s, sp.e));
  if (m && m[0].length > 0) sp.s += m[0].length;
};
const stripTrail = (f: string, sp: Span, re: RegExp): void => {
  const m = re.exec(f.slice(sp.s, sp.e));
  if (m) sp.e = sp.s + m.index;
};

const POLITE = "(?:(?:por favor|pode|poderia|consegue|quero que voce|eu quero|quero|vou querer)\\s+)*";
const ARTICLES = "(?:(?:no|na|nos|nas|pro|pra|para o|para a|para|em|ao|o|a|os|as|ate o|ate a)\\s+)*";
const OPEN_RE = new RegExp(`^${POLITE}(?:abr(?:e|a|ir)|acess(?:a|ar|e)|entr(?:a|ar)|inici(?:a|ar)|execut(?:a|ar))\\s+${ARTICLES}(.+)$`, "d");
const PLAY_RE = new RegExp(`^${POLITE}(toca|tocar|toque|reproduz(?:ir|a)?|assist(?:ir|e|a)|poe|bota|coloca|colocar)\\s+(.+)$`, "d");
const SEARCH_RE = new RegExp(`^${POLITE}(?:pesquis(?:a|ar|e)|procur(?:a|ar|e)|busc(?:a|ar|e)|googl(?:a|ar|e))\\s+(.+)$`, "d");
const IMAGES_RE = new RegExp(`^${POLITE}(?:(?:me\\s+)?(?:mostra|mostre|procura|procure|pesquisa|pesquise|busca|busque)\\s+)?(?:imagens?|fotos?)\\s+(?:de|do|da|dos|das)\\s+(.+)$`, "d");
const CLOSE_RE = /^(?:pode\s+)?(?:fecha|feche|fechar|esconde|esconda)\b/;
const MAP_RES: RegExp[] = [
  /^(?:(?:mostra|mostre|abre|abra|abrir|ver)\s+)(?:o\s+|a\s+)?(.+?)\s+(?:no|nos)\s+(?:mapa|maps|google maps)$/d,
  /^(?:(?:abre|abra|abrir|mostra|mostre)\s+(?:o\s+)?)?(?:mapa|maps|google maps)\s+(?:de|do|da|em)\s+(.+)$/d,
  /^onde\s+(?:e\s+que\s+)?fica(?:m)?\s+(?:(?:o|a|os|as)\s+)?(.+)$/d,
];
const DIRECTIONS_RE = /^como\s+(?:eu\s+)?(?:chego|chegar|vou|ir)\s+(?:(?:em|ate|no|na|ao|a|para|pra)\s+)+(?:(?:o|a)\s+)?(.+)$/d;
const DOMAIN_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/\S*)?$/;
const YT_TRAIL = /\s+(?:no|pelo|do|na|em)\s+(?:o\s+)?(?:youtube|yt)$/;
const SEARCH_TRAIL = /\s+(?:no|na|pelo|pela|em)\s+(?:o\s+)?(?:google|internet|web|navegador)$/;

const enc = encodeURIComponent;
export const googleSearch = (q: string): string => `https://www.google.com/search?q=${enc(q)}`;

function matchApp(target: string): { app: AppDef; rest: string } | null {
  for (const { alias, app } of ALIAS_INDEX) {
    if (target === alias) return { app, rest: "" };
    if (target.startsWith(`${alias} `)) return { app, rest: target.slice(alias.length + 1).trim() };
  }
  return null;
}


function appResult(app: AppDef, query: string, wantsPlay: boolean): Command {
  if (query && app.search) {
    return {
      kind: "page",
      url: app.search.replace("{q}", enc(query)),
      title: `${app.name} · ${query}`,
      external: app.external ?? false,
      playFirstVideo: app.name === "YouTube" && wantsPlay,
      spoken: `Abrindo ${app.name} com ${query}.`,
    };
  }
  return {
    kind: "page",
    url: app.url,
    title: app.name,
    external: app.external ?? false,
    spoken: app.external
      ? pick([`Abrindo o ${app.name} no seu navegador.`, `Certo, o ${app.name} vai abrir no navegador.`])
      : pick([`Abrindo o ${app.name}.`, `Pronto, ${app.name} aberto.`, `Certo, abrindo o ${app.name}.`]),
  };
}

/** "... na amazon" / "... no mercado livre": devolve o app com busca e corta o final do texto. */
function trailingApp(f: string, sp: Span): AppDef | null {
  const text = f.slice(sp.s, sp.e);
  for (const { alias, app } of ALIAS_INDEX) {
    if (!app.search || alias.length < 3) continue;
    const m = new RegExp(`\\s+(?:no|na|em|pelo|pela)\\s+(?:o\\s+|a\\s+)?${alias.replace(/[+.]/g, "\\$&")}$`).exec(text);
    if (m) {
      sp.e = sp.s + m.index;
      return app;
    }
  }
  return null;
}

const TLDS = "com|net|org|br|io|tv|gov|edu|app|dev|co|me|ly|be|gg|ai|info|xyz|site|online|ws|fm";
const URL_RE = new RegExp(`(?:https?:\\/\\/|www\\.)[^\\s]+|\\b[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.(?:${TLDS})(?:\\/[^\\s]*)?`, "i");
const OPEN_VERB = /^(?:por favor\s+)?(?:pode\s+)?(?:abr(?:e|a|ir)|acess(?:a|ar|e)|entr(?:a|ar)|v[aá]\s+(?:para|pra)|vai\s+(?:para|pra)|ir\s+(?:para|pra)|carreg(?:a|ar)|toca|tocar|assist(?:e|ir)|reproduz(?:ir|a)?)\b/i;

const youtubeId = (u: URL): string | null => {
  const host = u.hostname.replace(/^(?:www|m|music)\./, "");
  let id: string | null = null;
  if (host === "youtu.be") id = u.pathname.slice(1).split("/")[0] ?? null;
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    id = u.searchParams.get("v");
    const m = /^\/(?:shorts|embed|live|v)\/([\w-]{11})/.exec(u.pathname);
    if (!id && m) id = m[1] ?? null;
  }
  return id && /^[\w-]{11}$/.test(id) ? id : null;
};

/** Endereço completo (colado ou falado: "youtube ponto com barra ...") em qualquer lugar do texto. */
function parseUrlCommand(raw: string): Command | null {
  let text = raw.trim();
  if (/\bponto\s+(?:com|net|org|br|io|tv|gov|edu|app|dev|me|ly|be|gg|ai)\b/i.test(text)) {
    text = text.replace(/\s+ponto\s+/gi, ".").replace(/\s+barra\s+/gi, "/");
  }
  const m = URL_RE.exec(text);
  if (!m) return null;
  const found = m[0].replace(/[.,;:!?)]+$/, "");
  const startsWithVerb = OPEN_VERB.test(text);
  if (!startsWithVerb && found.length < text.length * 0.5) return null;

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(found) ? found : `https://${found}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./, "");
  const id = youtubeId(url);
  if (id) {
    return { kind: "page", url: url.href, title: "YouTube", videoId: id, playFirstVideo: true, spoken: "Certo, abrindo o vídeo do YouTube." };
  }
  return { kind: "page", url: url.href, title: host, spoken: `Abrindo ${host.replace(/\./g, " ponto ")}.` };
}

const ytSearchUrl = (q: string): string => `https://www.youtube.com/results?search_query=${enc(q)}`;

export function parseCommand(text: string): Command | null {
  const raw = text.trim();
  const f = fold(raw);
  const trimmed = f.replace(/[.!?,;\s]+$/g, "");
  if (!trimmed) return null;
  const end = trimmed.length;
  const slice = (sp: Span): string => raw.slice(sp.s, sp.e).replace(/^[\s,.:;!?-]+|[\s,;:-]+$/g, "").trim();

  // 1) Fechar painel
  if (CLOSE_RE.test(trimmed)) {
    return { kind: "close", spoken: pick(["Fechei.", "Pronto, fechei o painel.", "Certo, painel fechado."]) };
  }

  // 1.5) Endereços (YouTube, Facebook, qualquer site)
  const byUrl = parseUrlCommand(raw);
  if (byUrl) return byUrl;

  // 2) Mapas
  for (const re of MAP_RES) {
    const m = re.exec(trimmed);
    const idx = m?.indices?.[1];
    if (idx) {
      const q = slice({ s: idx[0], e: idx[1] });
      if (q) {
        return {
          kind: "page",
          url: `https://www.google.com/maps/search/?api=1&query=${enc(q)}`,
          title: `Mapa · ${q}`,
          spoken: pick([`Mostrando ${q} no mapa.`, `Certo, aqui está ${q} no mapa.`]),
        };
      }
    }
  }
  const dir = DIRECTIONS_RE.exec(trimmed)?.indices?.[1];
  if (dir) {
    const q = slice({ s: dir[0], e: dir[1] });
    if (q) {
      return {
        kind: "page",
        url: `https://www.google.com/maps/dir/?api=1&destination=${enc(q)}`,
        title: `Rota · ${q}`,
        spoken: pick([`Traçando a rota até ${q}.`, `Certo, mostrando como chegar em ${q}.`]),
      };
    }
  }

  // 3) Imagens
  const img = IMAGES_RE.exec(trimmed)?.indices?.[1];
  if (img) {
    const q = slice({ s: img[0], e: img[1] });
    if (q) {
      return {
        kind: "page",
        url: `${googleSearch(q)}&tbm=isch`,
        title: `Imagens · ${q}`,
        spoken: pick([`Aqui estão imagens de ${q}.`, `Certo, procurando imagens de ${q}.`]),
      };
    }
  }

  // 4) Tocar / assistir
  const play = PLAY_RE.exec(trimmed);
  const playIdx = play?.indices?.[2];
  const playVerb = play?.[1] ?? "";
  if (play && playIdx) {
    const sp: Span = { s: playIdx[0], e: playIdx[1] };
    const mentionsYt = YT_TRAIL.test(trimmed);
    const soft = ["poe", "bota", "coloca", "colocar"].includes(playVerb);
    const musical = /\b(youtube|musica|video|clipe|som|cancao)\b/.test(trimmed);
    if (!soft || mentionsYt || musical) {
      stripTrail(f, sp, YT_TRAIL);
      const whole = f.slice(sp.s, sp.e).trim();
      const asApp = matchApp(whole);
      if (asApp && !asApp.rest && asApp.app.name !== "YouTube") return appResult(asApp.app, "", false);
      {
        const before = sp.s;
        stripLead(f, sp, /^(?:uma?|a|o|as|os|umas|uns)\s+(?:musica|video|clipe|som|cancao)\s+(?:de|do|da|dos|das)\s+/);
        if (sp.s === before) stripLead(f, sp, /^(?:uma?|a|o|as|os|umas|uns)\s+/);
        const q = slice(sp);
        if (q) {
          return {
            kind: "page",
            url: ytSearchUrl(q),
            title: `YouTube · ${q}`,
            playFirstVideo: true,
            spoken: pick([`Certo, colocando ${q} no YouTube.`, `Pode deixar, vou tocar ${q}.`, `Tocando ${q} agora.`]),
          };
        }
      }
    }
  }

  // 5) Pesquisar
  const search = SEARCH_RE.exec(trimmed);
  const sIdx = search?.indices?.[1];
  if (search && sIdx) {
    const sp: Span = { s: sIdx[0], e: sIdx[1] };
    const inYoutube = YT_TRAIL.test(trimmed);
    stripTrail(f, sp, YT_TRAIL);
    stripTrail(f, sp, SEARCH_TRAIL);
    stripLead(f, sp, /^(?:(?:por|sobre|a respeito de|no google|na internet|na web|pra mim|para mim|ai|isso)\s+)+/);
    stripLead(f, sp, /^(?:o|a|os|as)\s+(?=\S+\s+\S)/);
    const viaApp = inYoutube ? null : trailingApp(f, sp);
    const q = slice(sp);
    if (q) {
      if (viaApp) return appResult(viaApp, q, false);
      if (inYoutube) {
        return { kind: "page", url: ytSearchUrl(q), title: `YouTube · ${q}`, spoken: `Certo, procurando ${q} no YouTube.` };
      }
      return {
        kind: "page",
        url: googleSearch(q),
        title: `Pesquisa · ${q}`,
        spoken: pick([`Certo, pesquisando ${q}.`, `Aqui está o que encontrei sobre ${q}.`, `Pode deixar, procurando ${q}.`]),
      };
    }
  }

  // 6) Abrir app/site
  const open = OPEN_RE.exec(trimmed);
  const oIdx = open?.indices?.[1];
  if (open && oIdx) {
    const target = f.slice(oIdx[0], end).trim();
    const found = matchApp(target);
    if (found) {
      const { app, rest } = found;
      let query = "";
      let wantsPlay = false;
      if (rest) {
        const m = /^(?:e\s+)?(pesquis\w+|procur\w+|busc\w+|toc\w+)\s+(.+)$/d.exec(rest);
        const qi = m?.indices?.[2];
        if (m && qi) {
          const base = oIdx[0] + target.length - rest.length;
          query = slice({ s: base + qi[0], e: base + qi[1] });
          wantsPlay = (m[1] ?? "").startsWith("toc");
        }
      }
      return appResult(app, query, wantsPlay);
    }

    // "abre o video X no youtube"
    if (YT_TRAIL.test(target)) {
      const sp: Span = { s: oIdx[0], e: oIdx[1] };
      stripTrail(f, sp, YT_TRAIL);
      const q = slice(sp);
      if (q) return { kind: "page", url: ytSearchUrl(q), title: `YouTube · ${q}`, spoken: `Certo, procurando ${q} no YouTube.` };
    }

    // Site por endereço ("abre github ponto com")
    const domain = target.replace(/\s+ponto\s+/g, ".").replace(/\s/g, "");
    if (DOMAIN_RE.test(domain)) {
      return { kind: "page", url: `https://${domain}`, title: domain, spoken: `Abrindo ${domain.replace(/\./g, " ponto ")}.` };
    }

    // Site/app que não está na lista: a Groq descobre o endereço (com pesquisa no Google como reserva).
    const sp: Span = { s: oIdx[0], e: oIdx[1] };
    const q = slice(sp);
    if (q) return { kind: "resolve", name: q, spoken: `Procurando ${q}.` };
  }

  return null;
}
