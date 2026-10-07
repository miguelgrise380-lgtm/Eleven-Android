import type { PanelData, WebSource, YouTubeVideo } from "../shared/types";
import { googleSearch, type Command } from "./commands";

type PageCommand = Extract<Command, { kind: "page" }>;

async function getJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`/.netlify/functions/${path}`);
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

const enc = encodeURIComponent;

/** Para "abre X" com X fora da lista: pede o endereço à Groq; se não achar, pesquisa no Google. */
export async function finishResolve(cmd: Extract<Command, { kind: "resolve" }>): Promise<PageCommand> {
  const data = await getJson<{ url: string | null }>(`site?q=${enc(cmd.name)}`);
  if (data?.url) {
    const host = new URL(data.url).hostname.replace(/^www\./, "");
    return { kind: "page", url: data.url, title: host, spoken: `Abrindo ${cmd.name}.` };
  }
  return {
    kind: "page",
    url: googleSearch(cmd.name),
    title: `Pesquisa · ${cmd.name}`,
    spoken: `Não achei o site de ${cmd.name}, então pesquisei no Google.`,
  };
}

/** Transforma um comando ("abre X", "pesquisa Y"...) no conteúdo do painel da página. */
export async function buildPanel(cmd: PageCommand): Promise<PanelData> {
  const u = new URL(cmd.url);
  const host = u.hostname.replace(/^www\./, "");

  // Vídeo específico do YouTube (link direto)
  if (cmd.videoId) {
    return {
      kind: "youtube",
      query: "vídeo",
      videos: [{ id: cmd.videoId, title: "Vídeo do YouTube", channel: "YouTube", thumb: "" }],
      autoplay: true,
      searchUrl: cmd.url,
    };
  }

  // YouTube (resultados ou página inicial/em alta)
  if (host === "youtube.com" && (u.pathname === "/results" || u.pathname === "/")) {
    const q = u.searchParams.get("search_query") ?? "";
    const data = await getJson<{ videos: YouTubeVideo[] }>(`youtube?q=${enc(q)}`);
    if (data && data.videos.length > 0) {
      return {
        kind: "youtube",
        query: q || "Em alta",
        videos: data.videos,
        autoplay: Boolean(cmd.playFirstVideo),
        searchUrl: cmd.url,
      };
    }
    return {
      kind: "app",
      name: "YouTube",
      url: cmd.url,
      note: "A busca de vídeos dentro da página não está disponível agora. Use o botão para abrir.",
    };
  }

  // Mapas
  if (host === "google.com" && u.pathname.startsWith("/maps")) {
    const destination = u.searchParams.get("destination");
    const query = destination ?? u.searchParams.get("query") ?? "";
    if (query) {
      return {
        kind: "map",
        query,
        embedUrl: destination
          ? `https://www.google.com/maps?daddr=${enc(destination)}&output=embed`
          : `https://www.google.com/maps?q=${enc(query)}&output=embed`,
        openUrl: cmd.url,
      };
    }
  }

  // Pesquisa (Google não pode ser exibido dentro da página: resumo da Wikipédia + botão)
  if (host === "google.com" && u.pathname === "/search") {
    const q = u.searchParams.get("q") ?? "";
    let summary = "";
    let sources: WebSource[] = [];
    if (u.searchParams.get("tbm") !== "isch") {
      const data = await getJson<{ summary: string; sources: WebSource[] }>(`wiki?q=${enc(q)}`);
      if (data) {
        summary = data.summary;
        sources = data.sources;
      }
    }
    return { kind: "search", query: q, summary, sources, searchUrl: cmd.url };
  }

  return {
    kind: "app",
    name: cmd.title,
    url: cmd.url,
    note: cmd.external
      ? "Esse serviço usa conteúdo protegido e não abre dentro da página. Use o botão para abrir em uma nova aba."
      : "Tentei abrir em uma nova aba. Se não abriu, use o botão abaixo (o navegador às vezes bloqueia abas abertas por voz).",
  };
}
