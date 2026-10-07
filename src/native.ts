/**
 * Ponte com o Capacitor (Android/iOS). No navegador comum tudo aqui cai no comportamento web.
 *
 * - Endereço da API: no app o site roda em https://localhost, então "/.netlify/functions/..." precisa
 *   apontar para o Netlify (VITE_API_BASE). O fetch é ajustado uma vez, aqui, e o resto do código não muda.
 * - Microfone: o WebView do Capacitor pede RECORD_AUDIO sozinho no getUserMedia (precisa estar no Manifest).
 * - Arquivos/câmera/localização/notificações: pedidos pelos plugins oficiais.
 */
import { Capacitor } from "@capacitor/core";
import { Camera } from "@capacitor/camera";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { Geolocation } from "@capacitor/geolocation";
import { LocalNotifications } from "@capacitor/local-notifications";
import { Share } from "@capacitor/share";

export const isNative: boolean = Capacitor.isNativePlatform();

// ---------- API ----------

const API_BASE = ((import.meta.env["VITE_API_BASE"] as string | undefined) ?? "").replace(/\/+$/, "");

if (isNative) {
  if (!API_BASE) console.warn("VITE_API_BASE vazio: as funções do Netlify não vão responder dentro do app.");
  const webFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (API_BASE && typeof input === "string" && input.startsWith("/.netlify/")) return webFetch(API_BASE + input, init);
    return webFetch(input, init);
  };
}

// ---------- Microfone ----------

/** Texto amigável para falha ao abrir o microfone. */
export function micErrorMessage(e: unknown): string {
  if (e instanceof DOMException) {
    if (e.name === "NotAllowedError" || e.name === "SecurityError")
      return isNative
        ? "Microfone bloqueado. Abra Configurações › Apps › Eleven › Permissões e permita o Microfone."
        : "Microfone bloqueado. Permita o microfone nas configurações do site.";
    if (e.name === "NotFoundError") return "Nenhum microfone encontrado neste aparelho.";
    if (e.name === "NotReadableError") return "O microfone está em uso por outro app.";
  }
  return e instanceof Error ? e.message : "Não foi possível iniciar";
}

// ---------- Arquivos, fotos e câmera ----------

/** Pede acesso às fotos (e à câmera, se for tirar foto) antes de abrir o seletor. Nunca lança erro. */
export async function ensureFileAccess(camera: boolean): Promise<boolean> {
  if (!isNative) return true;
  try {
    const wanted = camera ? (["camera", "photos"] as const) : (["photos"] as const);
    const cur = await Camera.checkPermissions();
    const missing = wanted.filter((k) => cur[k] !== "granted" && cur[k] !== "limited");
    if (missing.length === 0) return true;
    const res = await Camera.requestPermissions({ permissions: [...missing] });
    return missing.every((k) => res[k] === "granted" || res[k] === "limited");
  } catch (e) {
    console.warn("Permissão de arquivos/câmera:", e);
    return false;
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(r.error ?? new Error("Falha ao ler o arquivo"));
    r.readAsDataURL(blob);
  });
}

/** Salva a imagem em Documentos/Eleven. Se o Android recusar, abre o compartilhamento para o usuário escolher onde guardar. */
export async function saveImage(blob: Blob, filename: string): Promise<string> {
  const data = await blobToBase64(blob);
  try {
    await Filesystem.writeFile({ path: `Eleven/${filename}`, data, directory: Directory.Documents, recursive: true });
    return `Salvei em Documentos, pasta Eleven, como ${filename}.`;
  } catch (e) {
    console.warn("Salvar em Documentos falhou:", e);
    await shareImage(blob, filename);
    return "Não consegui salvar direto, então abri o compartilhamento para você escolher onde guardar.";
  }
}

/** Abre a folha de compartilhamento do sistema com a imagem. */
export async function shareImage(blob: Blob, filename: string): Promise<void> {
  const data = await blobToBase64(blob);
  const { uri } = await Filesystem.writeFile({ path: filename, data, directory: Directory.Cache });
  await Share.share({ title: "Foto", files: [uri] }).catch(() => undefined);
}

// ---------- Localização ----------

export async function getPosition(): Promise<{ latitude: number; longitude: number }> {
  if (isNative) {
    const perm = await Geolocation.requestPermissions();
    if (perm.location !== "granted" && perm.coarseLocation !== "granted") throw new Error("Permissão de localização negada.");
    const p = await Geolocation.getCurrentPosition({ timeout: 15000, enableHighAccuracy: true });
    return { latitude: p.coords.latitude, longitude: p.coords.longitude };
  }
  const p = await new Promise<GeolocationPosition>((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, { timeout: 15000 }));
  return { latitude: p.coords.latitude, longitude: p.coords.longitude };
}

// ---------- Notificações ----------

export async function requestNotifyPermission(): Promise<void> {
  try {
    if (isNative) {
      const cur = await LocalNotifications.checkPermissions();
      if (cur.display === "prompt" || cur.display === "prompt-with-rationale") await LocalNotifications.requestPermissions();
    } else if ("Notification" in window && Notification.permission === "default") {
      await Notification.requestPermission();
    }
  } catch {
    /* sem notificação: o resto funciona */
  }
}

export async function notify(title: string, body: string): Promise<void> {
  try {
    if (isNative) {
      await LocalNotifications.schedule({ notifications: [{ id: Math.floor(Date.now() % 2147483000), title, body }] });
    } else if ("Notification" in window && Notification.permission === "granted") {
      new Notification(title, { body });
    }
  } catch {
    /* notificação indisponível */
  }
}
