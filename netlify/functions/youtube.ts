import type { YouTubeVideo } from "../../shared/types";
import { withCors } from "../../shared/cors";

interface YouTubeItem {
  id?: string | { videoId?: string };
  snippet?: { title?: string; channelTitle?: string; thumbnails?: { medium?: { url?: string } } };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

const decodeEntities = (s: string): string =>
  s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

/** GET ?q=termo busca vídeos; sem q, devolve os vídeos em alta no Brasil. */
const handler = async (req: Request): Promise<Response> => {
  const key = process.env["YOUTUBE_API_KEY"];
  if (!key) return json({ videos: [] });

  const query = (new URL(req.url).searchParams.get("q") ?? "").trim().slice(0, 200);
  const url = new URL(
    query ? "https://www.googleapis.com/youtube/v3/search" : "https://www.googleapis.com/youtube/v3/videos",
  );
  url.searchParams.set("part", "snippet");
  url.searchParams.set("maxResults", "8");
  url.searchParams.set("regionCode", "BR");
  url.searchParams.set("key", key);
  if (query) {
    url.searchParams.set("q", query);
    url.searchParams.set("type", "video");
    url.searchParams.set("videoEmbeddable", "true");
  } else {
    url.searchParams.set("chart", "mostPopular");
  }

  const res = await fetch(url);
  if (!res.ok) return json({ videos: [] });
  const data = (await res.json()) as { items?: YouTubeItem[] };

  const videos: YouTubeVideo[] = [];
  for (const item of data.items ?? []) {
    const id = typeof item.id === "string" ? item.id : item.id?.videoId;
    if (!id || !item.snippet) continue;
    videos.push({
      id,
      title: decodeEntities(item.snippet.title ?? "Vídeo"),
      channel: decodeEntities(item.snippet.channelTitle ?? ""),
      thumb: item.snippet.thumbnails?.medium?.url ?? "",
    });
  }
  return json({ videos });
};

export default withCors(handler);
