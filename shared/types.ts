export interface YouTubeVideo {
  id: string;
  title: string;
  channel: string;
  thumb: string;
}

export interface WebSource {
  title: string;
  url: string;
}

export type PanelData =
  | { kind: "youtube"; query: string; videos: YouTubeVideo[]; autoplay: boolean; searchUrl: string }
  | { kind: "search"; query: string; summary: string; sources: WebSource[]; searchUrl: string }
  | { kind: "map"; query: string; embedUrl: string; openUrl: string }
  | { kind: "app"; name: string; url: string; note?: string }
  | { kind: "text"; title: string; text: string }
  | { kind: "image"; title: string; src: string; text: string } // [PHOTO]
  | { kind: "close" };

/** Uma linha do stream NDJSON enviado por /chat. */
export interface StreamEvent {
  t?: string;
  e?: string;
}
