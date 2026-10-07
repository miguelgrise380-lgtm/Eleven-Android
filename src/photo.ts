/**
 * [PHOTO] Escolher uma foto por voz, ler os metadados (EXIF/GPS) e descrever a imagem.
 * Módulo isolado: remova este arquivo, netlify/functions/vision.ts e os trechos [PHOTO]
 * (main.ts, tools.ts, panel.ts, shared/types.ts, brain.ts) para tirar o recurso.
 */
import type { ToolContext, ToolDef } from "./tools";
import { ensureFileAccess, getPosition, isNative, saveImage, shareImage } from "./native";

export interface Photo {
  file: File;
  url: string;
  meta: Record<string, unknown>;
  gps: { latitude: number; longitude: number } | null;
  width: number;
  height: number;
}

interface ExifrLike {
  parse(input: Blob, opts?: unknown): Promise<Record<string, unknown> | undefined>;
  gps(input: Blob): Promise<{ latitude: number; longitude: number } | undefined>;
}

let photo: Photo | null = null;
let closePicker: (() => void) | null = null;

// Cópia de trabalho (editada), histórico para desfazer, últimas detecções e consentimento de envio à IA
let work: HTMLCanvasElement | null = null;
let workUrl: string | null = null;
const undoStack: HTMLCanvasElement[] = [];
let detections: { label: string; box: [number, number, number, number] }[] = [];
let edited = false;
let brief: string | null = null;
let briefState: "idle" | "loading" | "ready" | "error" = "idle";
let briefError = "";

const PICK_VERB = /\b(escolh\w+|selecion\w+|anex\w+|envi\w+|mand\w+|carreg\w+|upload|subir|troc\w+)\b.*\b(foto|imagem|figura|print|captura)\b/;
const PICK_EU = /\bdeix\w+\s+eu\b.*\b(foto|imagem|figura)\b/;
const PICK_GALLERY = /\b(foto|imagem)\b.*\b(da galeria|do celular|do computador|do meu)\b/;

const CAMERA = /\b(tir\w+|bat\w+|faz\w*|fot\w+)\b.*\b(foto|camera)\b|\b(abr\w+|usa\w*)\b.*\bcamera\b/;

/** "deixa eu escolher uma foto", "tira uma foto"... Devolve o tipo de pedido ou null. */
export function parsePhotoCommand(raw: string): "pick" | "camera" | null {
  const t = raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (CAMERA.test(t) && !/\b(escolh\w+|galeria)\b/.test(t)) return "camera";
  return PICK_VERB.test(t) || PICK_EU.test(t) || PICK_GALLERY.test(t) ? "pick" : null;
}

async function exif(): Promise<ExifrLike> {
  const mod = (await import("exifr")) as unknown as { default?: ExifrLike } & ExifrLike;
  return mod.default ?? mod;
}

/** Deixa só valores simples (texto, número, data) para caber na conversa. */
function clean(raw: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!raw) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (Object.keys(out).length >= 120) break;
    if (typeof v === "string") {
      if (v.length <= 200 && v.trim()) out[k] = v.trim();
    } else if (typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (v instanceof Date && !Number.isNaN(v.getTime())) out[k] = v.toISOString();
    else if (Array.isArray(v) && v.length <= 8 && v.every((x) => typeof x === "number")) out[k] = v.join(", ");
  }
  return out;
}

async function dimensions(url: string): Promise<{ width: number; height: number }> {
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { width: img.naturalWidth, height: img.naturalHeight };
  } catch {
    return { width: 0, height: 0 };
  }
}

async function loadPhoto(file: File): Promise<Photo> {
  if (photo) URL.revokeObjectURL(photo.url);
  if (workUrl) URL.revokeObjectURL(workUrl);
  work = null;
  workUrl = null;
  undoStack.length = 0;
  detections = [];
  edited = false;
  brief = null;
  briefState = "idle";
  briefError = "";
  const url = URL.createObjectURL(file);
  let meta: Record<string, unknown> = {};
  let gps: Photo["gps"] = null;
  try {
    const ex = await exif();
    const opts = { tiff: true, exif: true, gps: true, iptc: true, xmp: true, jfif: true, ihdr: true, icc: false, makerNote: false, mergeOutput: true };
    meta = clean(await ex.parse(file, opts).catch(() => undefined));
    const g = await ex.gps(file).catch(() => undefined);
    if (g && Number.isFinite(g.latitude) && Number.isFinite(g.longitude)) gps = { latitude: g.latitude, longitude: g.longitude };
  } catch {
    /* sem EXIF: segue só com o arquivo */
  }
  const { width, height } = await dimensions(url);
  photo = { file, url, meta, gps, width, height };
  void runBrief();
  return photo;
}

/** Abre o seletor de arquivos. Voz não conta como toque, então o navegador pode bloquear: o botão na tela é a reserva. */
export function openPicker(onPicked: (p: Photo) => void, camera = false): void {
  closePicker?.();
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  if (camera) input.setAttribute("capture", "environment");
  input.style.display = "none";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = camera ? "Abrir câmera" : "Escolher foto";
  btn.style.cssText =
    "position:fixed;left:50%;bottom:calc(env(safe-area-inset-bottom,0px) + 24px);transform:translateX(-50%);z-index:50;padding:16px 28px;border:0;border-radius:999px;font:600 16px system-ui,sans-serif;background:#0b57d0;color:#fff;box-shadow:0 6px 24px rgba(0,0,0,.35)";

  const timer = window.setTimeout(() => close(), 120000);
  const close = (): void => {
    window.clearTimeout(timer);
    input.remove();
    btn.remove();
    if (closePicker === close) closePicker = null;
  };
  closePicker = close;

  input.addEventListener("change", () => {
    const f = input.files?.[0];
    close();
    if (f) void loadPhoto(f).then(onPicked);
  });
  input.addEventListener("cancel", close);
  btn.addEventListener("click", () => input.click());
  document.body.append(input, btn);
  // No app (Capacitor) pede a permissão de fotos/câmera antes de abrir o seletor.
  void ensureFileAccess(camera).then(() => {
    try {
      input.click();
    } catch {
      /* bloqueado: o botão resolve */
    }
  });
}

const r6 = (n: number): number => Math.round(n * 1e6) / 1e6;
const MAIN_KEYS = [
  "Make", "Model", "LensModel", "Software", "DateTimeOriginal", "CreateDate", "ModifyDate", "OffsetTimeOriginal",
  "ExposureTime", "FNumber", "ISO", "FocalLength", "Flash", "Orientation", "ExifImageWidth", "ExifImageHeight",
  "GPSLatitudeRef", "GPSLongitudeRef", "GPSAltitude", "GPSAltitudeRef", "GPSImgDirection", "GPSSpeed", "GPSDateStamp",
];

async function placeName(lat: number, lon: number): Promise<string | null> {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=16&accept-language=pt-BR&lat=${lat}&lon=${lon}`,
    );
    if (!res.ok) return null;
    return ((await res.json()) as { display_name?: string }).display_name ?? null;
  } catch {
    return null;
  }
}

// ---------- Canvas: cópia de trabalho e edição ----------

const MAX_SIDE = 4096;
const newCanvas = (w: number, h: number): HTMLCanvasElement => {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
};
const g2 = (c: HTMLCanvasElement): CanvasRenderingContext2D => {
  const x = c.getContext("2d", { willReadFrequently: true });
  if (!x) throw new Error("Canvas indisponível neste navegador.");
  return x;
};
const clone = (c: HTMLCanvasElement): HTMLCanvasElement => {
  const n = newCanvas(c.width, c.height);
  g2(n).drawImage(c, 0, 0);
  return n;
};

async function loadImg(url: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = url;
  await img.decode().catch(() => {
    throw new Error("Não consegui abrir essa imagem (formato não suportado pelo navegador).");
  });
  return img;
}

/** A imagem atual: a editada, ou o original desenhado em um canvas. */
async function current(): Promise<HTMLCanvasElement> {
  if (work) return work;
  if (!photo) throw new Error("Nenhuma foto escolhida.");
  const img = await loadImg(photo.url);
  const k = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const c = newCanvas(img.naturalWidth * k, img.naturalHeight * k);
  g2(c).drawImage(img, 0, 0, c.width, c.height);
  work = c;
  return c;
}

async function toBlob(c: HTMLCanvasElement, type = "image/png", quality = 0.92): Promise<Blob> {
  let src = c;
  if (type === "image/jpeg") {
    src = newCanvas(c.width, c.height);
    const x = g2(src);
    x.fillStyle = "#fff";
    x.fillRect(0, 0, src.width, src.height);
    x.drawImage(c, 0, 0);
  }
  return new Promise((resolve, reject) => src.toBlob((b) => (b ? resolve(b) : reject(new Error("Não consegui gerar a imagem."))), type, quality));
}

async function show(ctx: ToolContext, title: string, text: string): Promise<void> {
  const c = await current();
  const blob = await toBlob(c, "image/jpeg", 0.85);
  if (workUrl) URL.revokeObjectURL(workUrl);
  workUrl = URL.createObjectURL(blob);
  ctx.showImage(title, workUrl, `${text}\n${c.width}×${c.height}`.trim());
}

interface Op {
  op?: string;
  degrees?: number;
  direction?: string;
  amount?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  region?: string;
  text?: string;
  color?: string;
  size?: number;
  position?: string;
  maxSide?: number;
  percent?: number;
  shape?: string;
}

type Rect = { x: number; y: number; w: number; h: number };

const frac = (v: number | undefined, d: number): number => {
  const n = typeof v === "number" && Number.isFinite(v) ? v : d;
  return n > 1 ? n / 100 : n; // aceita 0-1 ou 0-100
};

function regions(op: Op, c: HTMLCanvasElement): Rect[] {
  if (op.region === "detected") {
    return detections.map((d) => ({
      x: d.box[0] * c.width,
      y: d.box[1] * c.height,
      w: (d.box[2] - d.box[0]) * c.width,
      h: (d.box[3] - d.box[1]) * c.height,
    }));
  }
  if (op.width !== undefined && op.height !== undefined) {
    return [{ x: frac(op.x, 0) * c.width, y: frac(op.y, 0) * c.height, w: frac(op.width, 1) * c.width, h: frac(op.height, 1) * c.height }];
  }
  return [{ x: 0, y: 0, w: c.width, h: c.height }];
}

function pixels(c: HTMLCanvasElement, fn: (d: Uint8ClampedArray) => void): HTMLCanvasElement {
  const out = clone(c);
  const x = g2(out);
  const img = x.getImageData(0, 0, out.width, out.height);
  fn(img.data);
  x.putImageData(img, 0, 0);
  return out;
}

const clamp8 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);

/** Desfoca a região (reduz e amplia; funciona em todos os navegadores). */
function blurRect(c: HTMLCanvasElement, r: Rect, amount: number): void {
  const k = Math.max(0.02, 1 / (1 + amount));
  const small = newCanvas(r.w * k, r.h * k);
  g2(small).drawImage(c, r.x, r.y, r.w, r.h, 0, 0, small.width, small.height);
  const x = g2(c);
  x.imageSmoothingEnabled = true;
  x.imageSmoothingQuality = "high";
  x.drawImage(small, 0, 0, small.width, small.height, r.x, r.y, r.w, r.h);
}

function pixelateRect(c: HTMLCanvasElement, r: Rect): void {
  const block = Math.max(8, Math.round(Math.min(r.w, r.h) / 10));
  const small = newCanvas(r.w / block, r.h / block);
  g2(small).drawImage(c, r.x, r.y, r.w, r.h, 0, 0, small.width, small.height);
  const x = g2(c);
  x.imageSmoothingEnabled = false;
  x.drawImage(small, 0, 0, small.width, small.height, r.x, r.y, r.w, r.h);
  x.imageSmoothingEnabled = true;
}

function applyOp(src: HTMLCanvasElement, op: Op): { c: HTMLCanvasElement; note: string } {
  const kind = String(op.op ?? "");
  const amt = typeof op.amount === "number" ? op.amount : undefined;
  switch (kind) {
    case "rotate": {
      const d = typeof op.degrees === "number" ? op.degrees : 90;
      const rad = (d * Math.PI) / 180;
      const cos = Math.abs(Math.cos(rad));
      const sin = Math.abs(Math.sin(rad));
      const out = newCanvas(src.width * cos + src.height * sin, src.width * sin + src.height * cos);
      const x = g2(out);
      x.translate(out.width / 2, out.height / 2);
      x.rotate(rad);
      x.drawImage(src, -src.width / 2, -src.height / 2);
      return { c: out, note: `girei ${d}°` };
    }
    case "flip": {
      const out = newCanvas(src.width, src.height);
      const x = g2(out);
      const vertical = op.direction === "vertical";
      x.translate(vertical ? 0 : out.width, vertical ? out.height : 0);
      x.scale(vertical ? 1 : -1, vertical ? -1 : 1);
      x.drawImage(src, 0, 0);
      return { c: out, note: vertical ? "espelhei na vertical" : "espelhei na horizontal" };
    }
    case "crop": {
      let r: Rect;
      if (op.shape === "square") {
        const s = Math.min(src.width, src.height);
        r = { x: (src.width - s) / 2, y: (src.height - s) / 2, w: s, h: s };
      } else r = regions(op, src)[0] ?? { x: 0, y: 0, w: src.width, h: src.height };
      const out = newCanvas(r.w, r.h);
      g2(out).drawImage(src, r.x, r.y, r.w, r.h, 0, 0, out.width, out.height);
      return { c: out, note: "recortei" };
    }
    case "resize": {
      const k = op.maxSide ? op.maxSide / Math.max(src.width, src.height) : (op.percent ?? 100) / 100;
      const out = newCanvas(src.width * k, src.height * k);
      const x = g2(out);
      x.imageSmoothingQuality = "high";
      x.drawImage(src, 0, 0, out.width, out.height);
      return { c: out, note: `redimensionei para ${out.width}×${out.height}` };
    }
    case "grayscale":
      return {
        c: pixels(src, (d) => {
          for (let i = 0; i < d.length; i += 4) {
            const g = 0.299 * (d[i] ?? 0) + 0.587 * (d[i + 1] ?? 0) + 0.114 * (d[i + 2] ?? 0);
            d[i] = d[i + 1] = d[i + 2] = g;
          }
        }),
        note: "preto e branco",
      };
    case "sepia":
      return {
        c: pixels(src, (d) => {
          for (let i = 0; i < d.length; i += 4) {
            const r = d[i] ?? 0, g = d[i + 1] ?? 0, b = d[i + 2] ?? 0;
            d[i] = clamp8(0.393 * r + 0.769 * g + 0.189 * b);
            d[i + 1] = clamp8(0.349 * r + 0.686 * g + 0.168 * b);
            d[i + 2] = clamp8(0.272 * r + 0.534 * g + 0.131 * b);
          }
        }),
        note: "sépia",
      };
    case "invert":
      return {
        c: pixels(src, (d) => {
          for (let i = 0; i < d.length; i += 4) {
            d[i] = 255 - (d[i] ?? 0);
            d[i + 1] = 255 - (d[i + 1] ?? 0);
            d[i + 2] = 255 - (d[i + 2] ?? 0);
          }
        }),
        note: "cores invertidas",
      };
    case "brightness": {
      const f = (amt ?? 120) / 100;
      return { c: pixels(src, (d) => { for (let i = 0; i < d.length; i += 4) for (let j = 0; j < 3; j++) d[i + j] = clamp8((d[i + j] ?? 0) * f); }), note: `brilho ${Math.round(f * 100)}%` };
    }
    case "contrast": {
      const f = (amt ?? 120) / 100;
      return { c: pixels(src, (d) => { for (let i = 0; i < d.length; i += 4) for (let j = 0; j < 3; j++) d[i + j] = clamp8(((d[i + j] ?? 0) - 128) * f + 128); }), note: `contraste ${Math.round(f * 100)}%` };
    }
    case "saturate": {
      const f = (amt ?? 130) / 100;
      return {
        c: pixels(src, (d) => {
          for (let i = 0; i < d.length; i += 4) {
            const r = d[i] ?? 0, g = d[i + 1] ?? 0, b = d[i + 2] ?? 0;
            const l = 0.299 * r + 0.587 * g + 0.114 * b;
            d[i] = clamp8(l + (r - l) * f);
            d[i + 1] = clamp8(l + (g - l) * f);
            d[i + 2] = clamp8(l + (b - l) * f);
          }
        }),
        note: `saturação ${Math.round(f * 100)}%`,
      };
    }
    case "blur": {
      const out = clone(src);
      for (const r of regions(op, out)) blurRect(out, r, amt ?? 8);
      return { c: out, note: op.region || op.width ? "desfoquei a área" : "desfoquei a imagem" };
    }
    case "censor": {
      const out = clone(src);
      const rs = regions(op, out);
      for (const r of rs) pixelateRect(out, r);
      return { c: out, note: `escondi ${rs.length} área(s) com pixelização` };
    }
    case "box": {
      const out = clone(src);
      const x = g2(out);
      x.strokeStyle = op.color || "#ff3b30";
      x.lineWidth = Math.max(3, out.width / 200);
      const rs = regions(op, out);
      rs.forEach((r, i) => {
        x.strokeRect(r.x, r.y, r.w, r.h);
        const label = op.region === "detected" ? detections[i]?.label : op.text;
        if (label) {
          x.font = `bold ${Math.max(14, out.height / 40)}px system-ui, sans-serif`;
          x.fillStyle = op.color || "#ff3b30";
          x.fillText(label, r.x + 4, Math.max(16, r.y - 6));
        }
      });
      return { c: out, note: `desenhei ${rs.length} caixa(s)` };
    }
    case "text": {
      const out = clone(src);
      const x = g2(out);
      const text = op.text ?? "";
      let px = (op.size ?? 0.06) > 1 ? (op.size as number) : (op.size ?? 0.06) * out.height;
      x.font = `bold ${px}px system-ui, sans-serif`;
      while (x.measureText(text).width > out.width * 0.92 && px > 10) {
        px -= 2;
        x.font = `bold ${px}px system-ui, sans-serif`;
      }
      x.textAlign = "center";
      x.textBaseline = "middle";
      const pos = op.position ?? "bottom";
      const cy = pos === "top" ? px : pos === "center" ? out.height / 2 : out.height - px;
      x.lineWidth = Math.max(2, px / 8);
      x.strokeStyle = "rgba(0,0,0,.85)";
      x.strokeText(text, out.width / 2, cy);
      x.fillStyle = op.color || "#ffffff";
      x.fillText(text, out.width / 2, cy);
      return { c: out, note: `escrevi "${text}"` };
    }
    default:
      throw new Error(`Operação desconhecida: ${kind}`);
  }
}

// ---------- Visão (IA), cores, códigos, localização ----------

async function callVision(c: HTMLCanvasElement, question: string, opts: { json?: boolean; thorough?: boolean; think?: boolean } = {}): Promise<string> {
  // Até 2048 px para enxergar detalhes pequenos (peças de xadrez, textos); reduz se passar de ~3,8 MB
  let side = 2048;
  let image = "";
  for (let i = 0; i < 4; i++) {
    const k = Math.min(1, side / Math.max(c.width, c.height));
    const small = newCanvas(c.width * k, c.height * k);
    g2(small).drawImage(c, 0, 0, small.width, small.height);
    image = small.toDataURL("image/jpeg", 0.9);
    if (image.length < 3_800_000) break;
    side = Math.round(side * 0.75);
  }
  const res = await fetch("/.netlify/functions/vision", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image, question, json: opts.json === true, thorough: opts.thorough === true, think: opts.think === true }),
  });
  const d = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
  if (!res.ok || !d.text) throw new Error(d.error ?? `A análise falhou (${res.status}).`);
  return d.text;
}

const BRIEF_PROMPT =
  "Analise esta imagem com o máximo de detalhe. 1) Descreva o que aparece (cena, objetos, pessoas de forma geral, cores, lugar). 2) Transcreva fielmente TODO texto visível. 3) Se houver tabuleiro de xadrez, escreva a posição completa: as peças brancas e pretas casa por casa e o FEN (diga de quem é a vez se estiver claro); se houver tabela, gráfico, fórmula, código ou diagrama, transcreva de forma estruturada. 4) Se houver um enunciado ou pergunta na imagem, copie-o por inteiro.";

/** Logo que a foto chega, a Eleven já olha a imagem para saber do que se trata. */
async function runBrief(): Promise<void> {
  const mine = photo;
  briefState = "loading";
  try {
    const text = await callVision(await current(), BRIEF_PROMPT, { thorough: true });
    if (photo !== mine) return;
    brief = text.slice(0, 3500);
    briefState = "ready";
  } catch (e) {
    if (photo !== mine) return;
    briefState = "error";
    briefError = e instanceof Error ? e.message : "falhou";
  }
}

/** Texto para o prompt da Eleven: o que ela está vendo na foto enviada. */
export function photoContext(): string {
  const p = photo;
  if (!p) return "";
  const date = typeof p.meta["DateTimeOriginal"] === "string" ? `, tirada em ${String(p.meta["DateTimeOriginal"])}` : "";
  const gps = p.gps ? `, GPS ${r6(p.gps.latitude)}, ${r6(p.gps.longitude)}` : ", sem GPS";
  const facts = `arquivo ${p.file.name}${p.width ? `, ${p.width}x${p.height}` : ""}${date}${gps}`;
  if (briefState === "ready") {
    return `FOTO ENVIADA PELO USUÁRIO: você CONSEGUE ver esta foto. Esta é a análise visual dela${edited ? " (a foto foi editada depois; use photo_describe para a versão atual)" : ""}: ${brief} | Dados do arquivo: ${facts}.`;
  }
  if (briefState === "error") {
    return `O usuário enviou uma foto (${facts}), mas a análise automática falhou (${briefError}). Chame photo_describe para tentar de novo; se também falhar, diga o erro real em vez de pedir para reenviar.`;
  }
  return `O usuário enviou uma foto (${facts}). A análise visual ainda está carregando: se perguntarem sobre a imagem, chame photo_describe.`;
}

function palette(c: HTMLCanvasElement, n: number): { cores: { hex: string; percentual: number }[]; brilho_medio: number } {
  const k = 64 / Math.max(c.width, c.height);
  const s = newCanvas(c.width * Math.min(1, k), c.height * Math.min(1, k));
  g2(s).drawImage(c, 0, 0, s.width, s.height);
  const d = g2(s).getImageData(0, 0, s.width, s.height).data;
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  let lum = 0;
  let total = 0;
  for (let i = 0; i < d.length; i += 4) {
    if ((d[i + 3] ?? 255) < 128) continue;
    const r = d[i] ?? 0, g = d[i + 1] ?? 0, b = d[i + 2] ?? 0;
    const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
    const e = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    e.n++;
    e.r += r;
    e.g += g;
    e.b += b;
    buckets.set(key, e);
    lum += 0.299 * r + 0.587 * g + 0.114 * b;
    total++;
  }
  const picked: { r: number; g: number; b: number; n: number }[] = [];
  for (const e of [...buckets.values()].sort((a, b) => b.n - a.n)) {
    const col = { r: e.r / e.n, g: e.g / e.n, b: e.b / e.n, n: e.n };
    if (picked.every((p) => Math.hypot(p.r - col.r, p.g - col.g, p.b - col.b) > 50)) picked.push(col);
    if (picked.length >= n) break;
  }
  const hex = (v: number): string => Math.round(v).toString(16).padStart(2, "0");
  return {
    cores: picked.map((p) => ({ hex: `#${hex(p.r)}${hex(p.g)}${hex(p.b)}`, percentual: Math.round((p.n / Math.max(1, total)) * 100) })),
    brilho_medio: Math.round(lum / Math.max(1, total)),
  };
}

const haversine = (a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number => {
  const R = 6371;
  const rad = (v: number): number => (v * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

/** Alguns recursos do navegador só liberam com um toque: mostra um botão. */
function tapButton(label: string, fn: () => Promise<void> | void): void {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = label;
  btn.style.cssText =
    "position:fixed;left:50%;bottom:calc(env(safe-area-inset-bottom,0px) + 24px);transform:translateX(-50%);z-index:50;padding:16px 28px;border:0;border-radius:999px;font:600 16px system-ui,sans-serif;background:#0b57d0;color:#fff;box-shadow:0 6px 24px rgba(0,0,0,.35)";
  const timer = window.setTimeout(() => btn.remove(), 60000);
  btn.addEventListener("click", () => {
    window.clearTimeout(timer);
    btn.remove();
    void Promise.resolve(fn());
  });
  document.body.append(btn);
}

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

// ---------- Ferramentas para a Groq ----------

const S = (description: string): Record<string, unknown> => ({ type: "string", description });
const NUM = (description: string): Record<string, unknown> => ({ type: "number", description });
const object = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({ type: "object", properties, required });

export const PHOTO_TOOLS: ToolDef[] = [
  {
    name: "photo_info",
    description:
      "Metadados da foto escolhida: câmera, data e hora, dimensões, GPS (latitude e longitude) e local aproximado. Use quando perguntarem de onde/quando/com o que foi tirada ou pedirem qualquer metadado.",
    parameters: object({}),
    run: async (_a, ctx) => {
      if (!photo) return "Nenhuma foto foi escolhida ainda. Peça para o usuário escolher uma foto.";
      const p = photo;
      const main: Record<string, unknown> = {};
      for (const k of MAIN_KEYS) if (p.meta[k] !== undefined) main[k] = p.meta[k];
      const rest: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(p.meta)) if (!(k in main) && Object.keys(rest).length < 40) rest[k] = v;

      let gps: unknown = "sem GPS: a foto não tem localização, ou o app/navegador removeu (WhatsApp e redes sociais removem; no Android é preciso permitir o acesso à localização da mídia ao escolher o arquivo)";
      let local: string | null = null;
      if (p.gps) {
        const lat = r6(p.gps.latitude);
        const lon = r6(p.gps.longitude);
        local = await placeName(lat, lon);
        gps = { latitude: lat, longitude: lon, para_copiar: `${lat}, ${lon}`, google_maps: `https://www.google.com/maps?q=${lat},${lon}` };
      }
      const lines = [
        p.file.name,
        p.width ? `${p.width}×${p.height}` : "",
        typeof main["DateTimeOriginal"] === "string" ? `Data: ${String(main["DateTimeOriginal"])}` : "",
        main["Model"] ? `Câmera: ${String(main["Make"] ?? "")} ${String(main["Model"])}`.trim() : "",
        p.gps ? `GPS: ${r6(p.gps.latitude)}, ${r6(p.gps.longitude)}` : "GPS: não encontrado",
        local ? `Local: ${local}` : "",
      ].filter(Boolean);
      ctx.showImage("Sua foto", p.url, lines.join("\n"));
      return JSON.stringify({
        arquivo: { nome: p.file.name, tipo: p.file.type, tamanho_kb: Math.round(p.file.size / 1024), modificado_em: new Date(p.file.lastModified).toISOString() },
        dimensoes: p.width ? `${p.width}x${p.height}` : "desconhecidas",
        principais: main,
        gps,
        local_aproximado: local,
        outros_metadados: rest,
      }).slice(0, 5500);
    },
  },
  {
    name: "photo_describe",
    description:
      "Olha a foto e responde qualquer pergunta sobre o conteúdo visual: o que é, identificar objetos/animais/plantas/marcas/lugares, ler textos (OCR), contar coisas, descrever cores, cenário, emoções, etc. Use thorough=true para 'identifique tudo' ou listas completas. Nunca identifica pessoas pelo nome.",
    parameters: object({
      question: S("Pergunta ou pedido COMPLETO sobre a imagem"),
      thorough: { type: "boolean", description: "Resposta completa e detalhada" },
      think: { type: "boolean", description: "Raciocínio profundo olhando a imagem (xadrez, matemática, lógica, gráficos); mais lento" },
    }),
    run: async (a) => {
      if (!photo) return "Nenhuma foto foi escolhida ainda.";
      const q = typeof a["question"] === "string" ? a["question"] : "";
      return callVision(await current(), q, { thorough: a["thorough"] === true, think: a["think"] === true });
    },
  },
  {
    name: "photo_detect",
    description:
      "Localiza objetos na foto (ex.: 'rostos', 'carros', 'placas', 'tudo') e desenha caixas aproximadas. As detecções ficam guardadas: depois dá para esconder (photo_edit com op censor/blur e region 'detected') ou recortar.",
    parameters: object({ what: S("O que procurar; vazio = principais objetos"), draw: { type: "boolean", description: "Desenhar as caixas (padrão sim)" } }),
    run: async (a, ctx) => {
      if (!photo) return "Nenhuma foto foi escolhida ainda.";
      const what = typeof a["what"] === "string" && a["what"].trim() ? a["what"].trim() : "os principais objetos";
      return (async () => {
        const c = await current();
        const raw = await callVision(
          c,
          `Localize na imagem: ${what}. Responda SOMENTE JSON no formato {"objects":[{"label":"nome curto","box":[x1,y1,x2,y2]}]} com coordenadas inteiras de 0 a 1000 (canto superior esquerdo e inferior direito, relativas ao tamanho da imagem). Sem pessoas identificadas pelo nome.`,
          { json: true },
        );
        let list: { label?: unknown; box?: unknown }[] = [];
        try {
          list = ((JSON.parse(raw) as { objects?: unknown }).objects as typeof list) ?? [];
        } catch {
          /* resposta fora do formato */
        }
        detections = list
          .map((o) => {
            const b = Array.isArray(o.box) ? o.box.map(Number) : [];
            if (b.length !== 4 || b.some((n) => !Number.isFinite(n))) return null;
            const scale = b.every((n) => n <= 1) ? 1 : 1000;
            const [x1, y1, x2, y2] = b.map((n) => Math.min(1, Math.max(0, n / scale))) as [number, number, number, number];
            return x2 > x1 && y2 > y1 ? { label: String(o.label ?? "objeto").slice(0, 40), box: [x1, y1, x2, y2] as [number, number, number, number] } : null;
          })
          .filter((d): d is NonNullable<typeof d> => d !== null);
        if (detections.length === 0) return `Não encontrei ${what} na imagem.`;
        if (a["draw"] !== false) {
          undoStack.push(clone(c));
          work = applyOp(c, { op: "box", region: "detected" }).c;
          edited = true;
          await show(ctxRef(ctx), "Detecções", detections.map((d) => d.label).join(", "));
        }
        const counts = new Map<string, number>();
        for (const d of detections) counts.set(d.label, (counts.get(d.label) ?? 0) + 1);
        return `Encontrei: ${[...counts].map(([l, n]) => `${n} ${l}`).join(", ")}. As caixas são aproximadas.`;
      })();
    },
  },
  {
    name: "photo_edit",
    description:
      "Edita a foto (cópia de trabalho; o original não muda). Operações em ordem: rotate(degrees), flip(direction horizontal|vertical), crop(shape 'square' ou x,y,width,height em 0-1), resize(maxSide px ou percent), grayscale, sepia, invert, brightness/contrast/saturate(amount, 100 = normal), blur(amount; com region), censor(pixeliza; region 'detected' ou x,y,width,height), box(desenha caixa), text(text, position top|center|bottom, color, size 0-1).",
    parameters: object(
      {
        operations: {
          type: "array",
          description: "Lista de operações aplicadas em ordem",
          items: object(
            {
              op: { type: "string", enum: ["rotate", "flip", "crop", "resize", "grayscale", "sepia", "invert", "brightness", "contrast", "saturate", "blur", "censor", "box", "text"] },
              degrees: NUM("rotate"),
              direction: { type: "string", enum: ["horizontal", "vertical"] },
              amount: NUM("intensidade"),
              x: NUM("0-1"),
              y: NUM("0-1"),
              width: NUM("0-1"),
              height: NUM("0-1"),
              region: { type: "string", enum: ["detected"] },
              shape: { type: "string", enum: ["square"] },
              maxSide: NUM("px"),
              percent: NUM("%"),
              text: S("texto"),
              color: S("cor CSS"),
              size: NUM("tamanho do texto 0-1"),
              position: { type: "string", enum: ["top", "center", "bottom"] },
            },
            ["op"],
          ),
        },
      },
      ["operations"],
    ),
    run: async (a, ctx) => {
      if (!photo) return "Nenhuma foto foi escolhida ainda.";
      let ops: Op[] = [];
      const raw = a["operations"];
      try {
        ops = (typeof raw === "string" ? JSON.parse(raw) : raw) as Op[];
      } catch {
        return "Operações inválidas.";
      }
      if (!Array.isArray(ops) || ops.length === 0) return "Nenhuma operação informada.";
      const before = await current();
      let c = before;
      const notes: string[] = [];
      for (const op of ops.slice(0, 12)) {
        const r = applyOp(c, op);
        c = r.c;
        notes.push(r.note);
      }
      undoStack.push(clone(before));
      if (undoStack.length > 6) undoStack.shift();
      work = c;
      edited = true;
      await show(ctx, "Foto editada", notes.join(", "));
      return `Feito: ${notes.join(", ")}. A imagem editada está no painel; para guardar, peça para salvar.`;
    },
  },
  {
    name: "photo_undo",
    description: "Desfaz a última edição, ou volta ao original com reset=true.",
    parameters: object({ reset: { type: "boolean" } }),
    run: async (a, ctx) => {
      if (!photo) return "Nenhuma foto foi escolhida ainda.";
      if (a["reset"] === true) {
        work = null;
        undoStack.length = 0;
        detections = [];
        await show(ctx, "Foto original", "");
        return "Voltei ao original.";
      }
      const prev = undoStack.pop();
      if (!prev) return "Não há edição para desfazer.";
      work = prev;
      await show(ctx, "Edição desfeita", "");
      return "Desfeito.";
    },
  },
  {
    name: "photo_colors",
    description: "Cores dominantes da foto (hex e percentual) e brilho médio. Use para paleta de cores ou 'que cor é predominante'.",
    parameters: object({ count: NUM("Quantas cores (padrão 5)") }),
    run: async (a) => {
      if (!photo) return "Nenhuma foto foi escolhida ainda.";
      return JSON.stringify(palette(await current(), Math.min(10, Math.max(1, Math.round(Number(a["count"]) || 5)))));
    },
  },
  {
    name: "photo_scan_codes",
    description: "Lê QR codes e códigos de barras na foto (no aparelho, sem enviar nada).",
    parameters: object({}),
    run: async () => {
      if (!photo) return "Nenhuma foto foi escolhida ainda.";
      const BD = (window as unknown as { BarcodeDetector?: new () => { detect(i: CanvasImageSource): Promise<{ rawValue: string; format: string }[]> } }).BarcodeDetector;
      if (!BD) return "Este navegador não tem leitor de QR/código de barras.";
      const found = await new BD().detect(await current());
      return found.length ? JSON.stringify(found.map((f) => ({ tipo: f.format, conteudo: f.rawValue }))) : "Nenhum código encontrado.";
    },
  },
  {
    name: "photo_distance_from_me",
    description: "Calcula a distância entre a localização atual do usuário e o ponto onde a foto foi tirada (pede a permissão de localização do navegador).",
    parameters: object({}),
    run: (_a, ctx) => {
      const p = photo;
      if (!p) return "Nenhuma foto foi escolhida ainda.";
      if (!p.gps) return "A foto não tem GPS, então não dá para calcular a distância.";
      const gps = p.gps;
      return ctx.confirm("usar a sua localização para calcular a distância", async () => {
        const pos = await getPosition();
        const km = haversine(pos, gps);
        return km < 1 ? `Você está a cerca de ${Math.round(km * 1000)} metros de onde a foto foi tirada.` : `Você está a cerca de ${km.toFixed(1).replace(".", ",")} quilômetros de onde a foto foi tirada.`;
      });
    },
  },
  {
    name: "photo_save",
    description:
      "Salva, copia, compartilha ou imprime a foto (editada, se houver edição) em png, jpeg ou webp. Exportar pelo canvas remove os metadados (EXIF/GPS). Sempre pede confirmação ao usuário.",
    parameters: object(
      {
        action: { type: "string", enum: ["download", "copy", "share", "print"] },
        format: { type: "string", enum: ["png", "jpeg", "webp"] },
        quality: NUM("0-1 para jpeg/webp"),
        filename: S("Nome do arquivo sem extensão"),
      },
      ["action"],
    ),
    run: (a, ctx) => {
      const p = photo;
      if (!p) return "Nenhuma foto foi escolhida ainda.";
      const action = String(a["action"]);
      const type = a["format"] === "jpeg" ? "image/jpeg" : a["format"] === "webp" ? "image/webp" : "image/png";
      const q = typeof a["quality"] === "number" ? Math.min(1, Math.max(0.1, a["quality"])) : 0.92;
      const base = (typeof a["filename"] === "string" && a["filename"].trim() ? a["filename"].trim() : p.file.name.replace(/\.[^.]+$/, "") + "-eleven").replace(/[^\w.-]+/g, "_");
      const label = { download: "salvar a foto no seu aparelho", copy: "copiar a imagem", share: "compartilhar a foto", print: "imprimir a foto" }[action];
      if (!label) return "Ação desconhecida.";
      return ctx.confirm(label, async () => {
        const c = await current();
        if (action === "copy") {
          const png = await toBlob(c, "image/png");
          try {
            await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
            return "Imagem copiada.";
          } catch {
            tapButton("Copiar imagem", async () => navigator.clipboard.write([new ClipboardItem({ "image/png": png })]));
            return "O navegador pediu um toque: toque no botão Copiar imagem.";
          }
        }
        const blob = await toBlob(c, type, q);
        const file = new File([blob], `${base}.${EXT[type] ?? "png"}`, { type });
        if (action === "download") {
          if (isNative) return saveImage(blob, file.name);
          const url = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = url;
          link.download = file.name;
          document.body.append(link);
          link.click();
          link.remove();
          window.setTimeout(() => URL.revokeObjectURL(url), 30000);
          return `Salvei como ${file.name}.`;
        }
        if (action === "share") {
          if (isNative) {
            await shareImage(blob, file.name);
            return "Abri o compartilhamento.";
          }
          tapButton("Compartilhar foto", async () => {
            if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: "Foto" }).catch(() => undefined);
          });
          return "Toque no botão Compartilhar foto que apareceu na tela.";
        }
        tapButton("Imprimir foto", () => {
          const url = URL.createObjectURL(blob);
          const f = document.createElement("iframe");
          f.style.cssText = "position:fixed;width:0;height:0;border:0";
          document.body.append(f);
          const doc = f.contentDocument;
          if (!doc) return;
          doc.write(`<img src="${url}" style="max-width:100%">`);
          doc.close();
          window.setTimeout(() => {
            f.contentWindow?.print();
            window.setTimeout(() => f.remove(), 60000);
          }, 400);
        });
        return "Toque no botão Imprimir foto que apareceu na tela.";
      });
    },
  },
];

/** Atalho de tipo: show() recebe o mesmo contexto das ferramentas. */
function ctxRef(ctx: ToolContext): ToolContext {
  return ctx;
}
