import type { PanelData, YouTubeVideo } from "../shared/types";

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Elemento #${id} não encontrado`);
  return node as T;
}

const panelEl = byId<HTMLElement>("panel");
const titleEl = byId<HTMLHeadingElement>("panel-title");
const openEl = byId<HTMLAnchorElement>("panel-open");
const closeEl = byId<HTMLButtonElement>("panel-close");
const bodyEl = byId<HTMLDivElement>("panel-body");

let ytFrame: HTMLIFrameElement | null = null;
let currentVideoId = "";
let youtubeOpen = false;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function safeUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

const embedSrc = (id: string, autoplay: boolean): string =>
  `https://www.youtube-nocookie.com/embed/${id}?autoplay=${autoplay ? 1 : 0}&rel=0&playsinline=1&enablejsapi=1&origin=${encodeURIComponent(location.origin)}`;

function setHeader(title: string, openUrl: string | null): void {
  titleEl.textContent = title;
  const safe = openUrl ? safeUrl(openUrl) : null;
  openEl.hidden = !safe;
  if (safe) openEl.href = safe;
}

function linkButton(label: string, url: string): HTMLAnchorElement {
  const a = h("a", "btn", label);
  a.href = safeUrl(url) ?? "#";
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}

function renderYouTube(videos: YouTubeVideo[], autoplay: boolean): void {
  const valid = videos.filter((v) => /^[\w-]{11}$/.test(v.id));
  const first = valid[0];
  if (!first) {
    bodyEl.append(h("p", "note", "Nenhum vídeo encontrado."));
    return;
  }

  const frame = h("iframe", "player");
  frame.title = "Player do YouTube";
  frame.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
  frame.allowFullscreen = true;
  frame.src = embedSrc(first.id, autoplay);
  ytFrame = frame;
  currentVideoId = first.id;

  const nowPlaying = h("p", "video-title", first.title);
  const grid = h("div", "grid");
  const buttons: HTMLButtonElement[] = [];

  const select = (v: YouTubeVideo, btn: HTMLButtonElement): void => {
    currentVideoId = v.id;
    frame.src = embedSrc(v.id, true);
    nowPlaying.textContent = v.title;
    buttons.forEach((b) => b.removeAttribute("aria-current"));
    btn.setAttribute("aria-current", "true");
  };

  valid.forEach((v, i) => {
    const btn = h("button", "thumb");
    btn.type = "button";
    if (i === 0) btn.setAttribute("aria-current", "true");
    try {
      if (new URL(v.thumb).hostname.endsWith("ytimg.com")) {
        const img = h("img");
        img.src = v.thumb;
        img.alt = "";
        img.loading = "lazy";
        btn.append(img);
      }
    } catch {
      // miniatura inválida: segue sem imagem
    }
    btn.append(h("span", "thumb-title", v.title), h("span", "thumb-channel", v.channel));
    btn.addEventListener("click", () => select(v, btn));
    buttons.push(btn);
    grid.append(btn);
  });

  bodyEl.append(frame, nowPlaying, grid);
}

export function showPanel(d: PanelData): void {
  if (d.kind === "close") {
    closePanel();
    return;
  }

  bodyEl.replaceChildren();
  ytFrame = null;
  youtubeOpen = false;

  switch (d.kind) {
    case "youtube":
      setHeader(`YouTube · ${d.query}`, d.searchUrl);
      renderYouTube(d.videos, d.autoplay);
      youtubeOpen = true;
      break;

    case "search": {
      setHeader(`Pesquisa · ${d.query}`, d.searchUrl);
      if (d.summary) bodyEl.append(h("p", "summary", d.summary));
      if (d.sources.length > 0) {
        const list = h("ul", "sources");
        for (const s of d.sources) {
          const li = h("li");
          const a = h("a", "source", s.title);
          a.href = safeUrl(s.url) ?? "#";
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          li.append(a);
          list.append(li);
        }
        bodyEl.append(h("p", "label", "Fontes"), list);
      }
      bodyEl.append(linkButton("Ver todos os resultados no Google", d.searchUrl));
      break;
    }

    case "map": {
      setHeader(`Mapa · ${d.query}`, d.openUrl);
      const embed = safeUrl(d.embedUrl);
      if (embed && embed.startsWith("https://www.google.com/maps")) {
        const frame = h("iframe", "map");
        frame.title = `Mapa de ${d.query}`;
        frame.src = embed;
        frame.loading = "lazy";
        bodyEl.append(frame);
      } else {
        bodyEl.append(linkButton("Abrir no Google Maps", d.openUrl));
      }
      break;
    }

    case "image": {
      // [PHOTO]
      setHeader(d.title, null);
      const img = document.createElement("img");
      img.src = d.src;
      img.alt = d.title;
      img.style.cssText = "max-width:100%;max-height:50vh;border-radius:12px;display:block;margin:0 auto 12px";
      const box = h("p", "summary", d.text);
      box.style.whiteSpace = "pre-wrap";
      bodyEl.append(img, box);
      break;
    }

    case "text": {
      setHeader(d.title, null);
      const box = h("p", "summary", d.text);
      box.style.whiteSpace = "pre-wrap";
      const copy = h("button", "btn", "Copiar");
      copy.type = "button";
      copy.addEventListener("click", () => {
        void navigator.clipboard
          ?.writeText(d.text)
          .then(() => (copy.textContent = "Copiado!"))
          .catch(() => (copy.textContent = "Não consegui copiar"));
      });
      bodyEl.append(box, copy);
      break;
    }

    case "app":
      setHeader(d.name, d.url);
      bodyEl.append(
        h("p", "app-name", d.name),
        h("p", "note", d.note ?? "Use o botão para abrir em uma nova aba."),
        linkButton(`Abrir ${d.name}`, d.url),
      );
      break;
  }

  panelEl.hidden = false;
  document.body.classList.add("has-panel");
}

/** Começa a tocar o vídeo atual (usado depois que a Eleven termina de falar). */
export function startPlayback(): void {
  if (ytFrame && currentVideoId) ytFrame.src = embedSrc(currentVideoId, true);
}

const ytCommand = (func: "pauseVideo" | "playVideo"): void => {
  ytFrame?.contentWindow?.postMessage(JSON.stringify({ event: "command", func, args: [] }), "https://www.youtube-nocookie.com");
};

/** Pausa o vídeo atual (sem fechar o painel). */
export function pauseMedia(): void {
  ytCommand("pauseVideo");
}

/** Retoma o vídeo atual de onde parou. */
export function resumeMedia(): void {
  ytCommand("playVideo");
}

/** Com vídeo aberto, a Eleven só reage se ouvir o nome dela (o som do vídeo vai para o microfone). */
export function mediaPanelOpen(): boolean {
  return youtubeOpen;
}

export function closePanel(): void {
  panelEl.hidden = true;
  bodyEl.replaceChildren();
  ytFrame = null;
  currentVideoId = "";
  youtubeOpen = false;
  document.body.classList.remove("has-panel");
}

closeEl.addEventListener("click", closePanel);
