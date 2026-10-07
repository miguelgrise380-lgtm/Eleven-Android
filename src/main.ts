import "./native"; // Capacitor: ajusta a URL da API antes de qualquer fetch
import "./style.css";
import { micErrorMessage, notify, requestNotifyPermission } from "./native";
import { setBrainContext, stopBrain, streamAnswer, type ToolSet } from "./brain";
import { parseTvCommand, runTv } from "./tv"; // [TV-SMARTTHINGS]
import { openPicker, parsePhotoCommand, photoContext, type Photo } from "./photo"; // [PHOTO]
import { isUnlocked, lock, promptTap, verifyBiometric } from "./biometric";
import { initReminders, runTool, toolDefs, type ToolContext } from "./tools";
import { farewellLine, parseCommand, type Command } from "./commands";
import { closePanel, mediaPanelOpen, pauseMedia, resumeMedia, showPanel, startPlayback } from "./panel";
import { buildPanel, finishResolve } from "./route";

type State = "off" | "idle" | "session" | "thinking" | "speaking" | "error";

interface DeepgramMessage {
  type?: string;
  is_final?: boolean;
  speech_final?: boolean;
  channel?: { alternatives?: { transcript?: string }[] };
}

interface ChatTurn {
  role: "user" | "model";
  text: string;
}

const WAKE_WORD = /\b(eleven|elevem|eleve|elévem)\b/i;
const WAKE_WORD_ALL = /\b(eleven|elevem|eleve|elévem)\b/gi;
// Despedidas: só valem em frases curtas, para não confundir com perguntas ("o que significa tchau?").
const FAREWELL =
  /\b(até mais|até logo|até amanhã|até a próxima|tchau|adeus|pode parar|encerrar|era só isso|só isso|por hoje é só|vou dormir)\b/i;
const FAREWELL_MAX_WORDS = 7;
// Sem ninguém falar por esse tempo, a conversa se encerra sozinha e volta a esperar "Eleven".
const SESSION_IDLE_MS = 5 * 60 * 1000;

const API_HEADERS = { "Content-Type": "application/json" };

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Elemento #${id} não encontrado`);
  return node as T;
}

const orb = el<HTMLDivElement>("orb");
const statusEl = el<HTMLParagraphElement>("status");
const captionEl = el<HTMLParagraphElement>("caption");
const toggleBtn = el<HTMLButtonElement>("toggle");
const progressEl = el<HTMLDivElement>("progress");

const STATUS_TEXT: Record<State, string> = {
  off: "Desligada",
  idle: "Aguardando — diga “Eleven”",
  session: "Conversando — diga “até mais” para encerrar",
  thinking: "Pensando…",
  speaking: "Falando…",
  error: "Algo deu errado",
};

let state: State = "off";
let ws: WebSocket | null = null;
let recorder: MediaRecorder | null = null;
let stream: MediaStream | null = null;
let keepAlive: number | undefined;
let sessionTimer: number | undefined;
let inSession = false;
let wakeLock: WakeLockSentinel | null = null;
let reconnectTimer: number | undefined;
let active = false;
let buffer = "";
let currentAudio: HTMLAudioElement | null = null;
let currentQueue: SpeechQueue | null = null;
const history: ChatTurn[] = [];

function setState(next: State, message?: string): void {
  state = next;
  orb.dataset["state"] = next;
  statusEl.textContent = message ?? STATUS_TEXT[next];
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: API_HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Erro ${res.status}`);
  }
  return (await res.json()) as T;
}

let active_tts = 0;
const tts_waiters: (() => void)[] = [];

// Limita requisições simultâneas ao ElevenLabs (plano free aceita 2).
async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (active_tts >= 2) await new Promise<void>((r) => tts_waiters.push(r));
  active_tts++;
  try {
    return await fn();
  } finally {
    active_tts--;
    tts_waiters.shift()?.();
  }
}

async function fetchSpeech(text: string): Promise<Blob> {
  return limited(async () => {
    const res = await fetch("/.netlify/functions/speak", {
      method: "POST",
      headers: API_HEADERS,
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(err.error ?? `Erro ${res.status}`);
    }
    return res.blob();
  });
}

// Um único <audio>, "destravado" no toque do usuário: celulares só deixam tocar assim.
const player = new Audio();
const SILENT_WAV = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

function primeAudio(): void {
  player.src = SILENT_WAV;
  void player.play().catch(() => undefined);
}

let cancelPlay: (() => void) | null = null;

function playBlob(blob: Blob): Promise<void> {
  const url = URL.createObjectURL(blob);
  player.src = url;
  currentAudio = player;
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      URL.revokeObjectURL(url);
      if (currentAudio === player) currentAudio = null;
      cancelPlay = null;
    };
    cancelPlay = () => {
      player.pause();
      cleanup();
      resolve(); // libera a fila quando a fala é interrompida
    };
    player.onended = () => {
      cleanup();
      resolve();
    };
    player.onerror = () => {
      cleanup();
      reject(new Error("Falha ao tocar o áudio"));
    };
    player.play().catch((e: unknown) => {
      cleanup();
      reject(e instanceof Error ? e : new Error("Falha ao tocar o áudio"));
    });
  });
}

// Fila: baixa o áudio de cada frase assim que ela chega e toca na ordem certa.
class SpeechQueue {
  private chain: Promise<void> = Promise.resolve();
  private stopped = false;
  private playing = -1;
  private readonly sentences: string[] = [];
  interrupted = false;

  add(sentence: string, ready?: Promise<Blob>): void {
    const idx = this.sentences.push(sentence) - 1;
    const blob = ready ?? fetchSpeech(sentence);
    blob.catch(() => undefined);
    this.chain = this.chain.then(async () => {
      if (this.stopped) return;
      const data = await blob;
      if (this.stopped) return;
      this.playing = idx;
      await playBlob(data);
    });
    this.chain.catch(() => undefined);
  }

  done(): Promise<void> {
    return this.chain;
  }

  /** O que ela já falou (incluindo a frase em andamento). */
  heard(): string {
    return this.sentences.slice(0, this.playing + 1).join(" ");
  }

  /** O que faltou falar (a frase cortada volta inteira). */
  rest(): string {
    return this.sentences.slice(Math.max(this.playing, 0)).join(" ");
  }

  all(): string {
    return this.sentences.join(" ");
  }

  stop(byUser = false): void {
    this.stopped = true;
    if (byUser) this.interrupted = true;
    if (cancelPlay) cancelPlay();
    else currentAudio?.pause();
  }
}

function takeSentences(buf: string): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let rest = buf;
  for (;;) {
    let m = /[.!?…]+\s/.exec(rest);
    // Frase longa sem pontuação: corta numa vírgula para começar a falar logo.
    if (!m && rest.length > 110) m = /[,;:]\s(?!.*[,;:]\s)/.exec(rest);
    if (!m) break;
    const end = m.index + m[0].length;
    const sentence = rest.slice(0, end).trim();
    rest = rest.slice(end);
    if (sentence) sentences.push(sentence);
  }
  return { sentences, rest };
}

function resetSessionTimer(): void {
  window.clearTimeout(sessionTimer);
  sessionTimer = window.setTimeout(endSession, SESSION_IDLE_MS);
}

function startSession(): void {
  inSession = true;
  if (active) setState("session");
  resetSessionTimer();
}

function endSession(): void {
  inSession = false;
  pendingAction = null;
  pendingOpen = null;
  window.clearTimeout(sessionTimer);
  if (active && state !== "thinking" && state !== "speaking") setState("idle");
}

/** Fala uma frase pronta (confirmações e despedidas) usando a mesma fila de voz. */
async function sayLine(text: string): Promise<void> {
  const queue = new SpeechQueue();
  currentQueue = queue;
  setState("speaking");
  try {
    queue.add(text);
    await queue.done();
  } finally {
    if (currentQueue === queue) currentQueue = null;
  }
}

let pendingPlay = false;

// ---------- Resposta imediata ao nome + biometria ----------
const WAKE_ONLY = /^\W*(?:eleven|elevem|eleve|elévem)\W*$/i;
const ACKS = ["Sim?", "Pois não?", "Estou ouvindo.", "Diga."];
const LINE_VERIFY = "Confirme sua biometria.";
const LINE_READY = "Pronto, pode falar.";
const clips = new Map<string, Promise<Blob>>();
let ackTimer: number | undefined;
let wakeAcked = false;
let wakeBusy = false;
let ackPlaying = false;

/** Baixa as frases curtas uma vez, para tocarem na hora quando você chamar. */
function preloadClips(): void {
  for (const t of [...ACKS, LINE_VERIFY, LINE_READY]) {
    if (clips.has(t)) continue;
    const p = fetchSpeech(t);
    p.catch(() => clips.delete(t));
    clips.set(t, p);
  }
}

async function sayClip(text: string): Promise<void> {
  const queue = new SpeechQueue();
  currentQueue = queue;
  ackPlaying = true;
  setState("speaking");
  try {
    queue.add(text, clips.get(text));
    await queue.done();
  } finally {
    ackPlaying = false;
    if (currentQueue === queue) currentQueue = null;
  }
}

/** Pede a biometria; só retorna true quando liberado. */
async function unlockFlow(): Promise<boolean> {
  window.clearTimeout(sessionTimer);
  void sayClip(LINE_VERIFY);
  let r = await verifyBiometric();
  if (r === "denied") r = await promptTap();
  if (r === "ok" || r === "unsupported") return true;
  currentQueue?.stop();
  void sayLine("Não consegui confirmar a biometria.").then(() => {
    if (active) setState("idle");
  });
  return false;
}

/** Ouviu só o nome: responde na hora (biometria primeiro, se ainda não liberou). */
async function fastWake(): Promise<void> {
  if (wakeBusy) return;
  wakeBusy = true;
  wakeAcked = true;
  try {
    const wasLocked = !isUnlocked();
    if (wasLocked && !(await unlockFlow())) {
      wakeAcked = false;
      return;
    }
    buffer = "";
    startSession();
    await sayClip(wasLocked ? LINE_READY : (ACKS[Math.floor(Math.random() * ACKS.length)] ?? "Sim?"));
    if (active && !pendingOpen) startSession();
  } catch (e) {
    fail(e);
  } finally {
    wakeBusy = false;
  }
}

/** Disse um pedido junto com o nome, mas ainda não liberou a biometria. */
async function lockedFlow(utterance: string): Promise<void> {
  if (wakeBusy) return;
  wakeBusy = true;
  try {
    if (!(await unlockFlow())) return;
  } finally {
    wakeBusy = false;
  }
  handleUtterance(utterance);
}
let bargedIn = false;
let interruptedRest = "";
let mediaHold = false;
let holdTimer: number | undefined;

const norm = (t: string): string =>
  t.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
const CONTINUE =
  /^(?:(?:desculpa|desculpe|foi mal|opa)[,. ]*)?(?:pode\s+)?(?:continu\w*|segue|siga|prossig\w*|vai em frente|termina|pode falar|ok(?:ay)?|entendi|certo|beleza|aham|uhum)\b/i;
const PAUSE_VIDEO = /\b(?:paus[ae]r?|pause|p[aá]ra(?: o| de)?(?: v[ií]deo)?|deixa pausado|fica pausado)\b/i;
const RESUME_VIDEO = /\b(?:continu\w*|retom\w*|volta|despaus\w*|toca|solta)\b.*\bv[ií]deo\b|\bv[ií]deo\b.*\b(?:continu\w*|volta|toca)\b/i;

/** Eco: o que o microfone ouviu é (quase) só o que ela mesma está falando. */
function isEcho(text: string): boolean {
  const spoken = norm(currentQueue?.all() ?? "");
  const words = norm(text).split(" ").filter((w) => w.length > 2);
  if (words.length === 0) return true;
  return words.filter((w) => spoken.includes(w)).length / words.length >= 0.5;
}

/** Você falou por cima dela: para a voz na hora, guarda o que faltava e passa a ouvir. */
function interrupt(): void {
  const q = currentQueue;
  if (!q) return;
  bargedIn = true;
  interruptedRest = q.rest();
  q.stop(true);
  stopBrain();
  buffer = "";
  inSession = true;
  setState("session");
  resetSessionTimer();
}

/** Pausa o vídeo e deixa o painel "bloqueado" até a Eleven terminar de ouvir e responder. */
function holdMedia(): void {
  if (!mediaPanelOpen() || mediaHold) return;
  mediaHold = true;
  pauseMedia();
  window.clearTimeout(holdTimer);
  holdTimer = window.setTimeout(() => releaseMedia(), 15000);
}

function releaseMedia(): void {
  window.clearTimeout(holdTimer);
  if (!mediaHold) return;
  if (state === "thinking" || state === "speaking") {
    holdTimer = window.setTimeout(() => releaseMedia(), 3000);
    return;
  }
  mediaHold = false;
  if (mediaPanelOpen()) resumeMedia();
}

/** Limpa o que foi ouvido, exceto quando você acabou de interromper (essas palavras são o próximo pedido). */
function clearHeard(): void {
  if (bargedIn) {
    bargedIn = false;
    return;
  }
  buffer = "";
  captionEl.textContent = "";
}

async function continueSpeech(): Promise<void> {
  const text = interruptedRest;
  interruptedRest = "";
  window.clearTimeout(sessionTimer);
  setState("thinking");
  try {
    await sayLine(text);
    clearHeard();
    startSession();
    releaseMedia();
  } catch (e) {
    fail(e);
  }
}

async function keepPaused(): Promise<void> {
  window.clearTimeout(holdTimer);
  mediaHold = false; // continua pausado: só volta se você pedir
  window.clearTimeout(sessionTimer);
  setState("thinking");
  try {
    await sayLine("Pausado.");
    clearHeard();
    startSession();
  } catch (e) {
    fail(e);
  }
}

type Panel = Awaited<ReturnType<typeof buildPanel>>;
interface PendingOpen {
  panel: Panel;
  label: string;
}
let pendingOpen: PendingOpen | null = null;
let pendingAction: { label: string; run: () => Promise<string> } | null = null; // [PHOTO]

const YES = /^(?:(?:sim|pode(?: sim)?|claro|com certeza|isso(?: mesmo)?|ok(?:ay)?|beleza|positivo|uhum|aham|vai|faz|fa[cç]a|abre|abra|abrir|manda|por favor|quero|bora|t[aá] bom|tudo bem)\b)/i;
const NO = /\b(?:n[aã]o|cancel\w*|deixa|deixe|esquece|esque[cç]a|nada)\b/i;

const isYouTube = (url: string): boolean => {
  try {
    return /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
};

/** Só precisa de confirmação o que abre algo fora da Eleven (nova aba/rascunho). YouTube e painéis internos, não. */
function needsConfirm(panel: Panel): boolean {
  return panel.kind === "app" && !isYouTube(panel.url);
}

function labelFor(panel: Panel): string {
  if (panel.kind !== "app") return "isso";
  let host = "";
  try {
    host = new URL(panel.url).hostname;
  } catch {
    /* sem host */
  }
  if (host === "mail.google.com") return "o e-mail";
  if (host === "wa.me" || host.endsWith("whatsapp.com")) return "o WhatsApp com a mensagem";
  if (host === "calendar.google.com") return "o Google Agenda";
  return `o ${panel.name}`;
}

/** Mostra o painel pronto (e tenta abrir em nova aba se o site não couber nele). */
function presentPanel(panel: Panel): boolean {
  if (panel.kind === "youtube" && panel.autoplay) {
    showPanel({ ...panel, autoplay: false });
    return true; // o vídeo só começa quando ela terminar de falar
  }
  showPanel(panel);
  // O navegador pode bloquear abas abertas por voz; o botão do painel fica como reserva.
  if (panel.kind === "app" && /^https?:\/\//i.test(panel.url)) {
    const w = window.open(panel.url, "_blank");
    if (w) w.opener = null;
  }
  return false;
}

/** Caminho das ferramentas: abre na hora ou devolve ao modelo o aviso de que falta confirmar. */
async function openPage(cmd: Extract<Command, { kind: "page" }>): Promise<string | null> {
  const panel = await buildPanel(cmd);
  if (needsConfirm(panel)) {
    const label = labelFor(panel);
    pendingOpen = { panel, label };
    return `AINDA NÃO FOI ABERTO: aguardando o usuário confirmar. Pergunte apenas: "Posso abrir ${label}?" e nada mais.`;
  }
  if (presentPanel(panel)) pendingPlay = true;
  return null;
}

/** [PHOTO] Resposta do usuário ao "Posso ...?" de uma ação com permissão. */
async function answerAction(a: { label: string; run: () => Promise<string> }, yes: boolean): Promise<void> {
  window.clearTimeout(sessionTimer);
  setState("thinking");
  try {
    let msg = "Tudo bem, não fiz.";
    if (yes) {
      msg = await a.run().catch((e: unknown) => `Não consegui: ${e instanceof Error ? e.message : "falhou"}`);
    }
    const spoken = msg.replace(/[*_#`]/g, "").replace(/\s+/g, " ").trim().slice(0, 700);
    history.push({ role: "model", text: spoken });
    await sayLine(spoken);
    clearHeard();
    startSession();
    releaseMedia();
  } catch (e) {
    fail(e);
  }
}

/** Resposta do usuário ao "Posso abrir...?". */
async function answerOpen(p: PendingOpen, yes: boolean): Promise<void> {
  window.clearTimeout(sessionTimer);
  setState("thinking");
  try {
    if (yes) {
      presentPanel(p.panel);
      await sayLine("Abrindo.");
    } else {
      await sayLine("Tudo bem, não abri.");
    }
    clearHeard();
    startSession();
    releaseMedia();
  } catch (e) {
    fail(e);
  }
}

const toolCtx: ToolContext = {
  openPage,
  showText: (title, text) => showPanel({ kind: "text", title, text }),
  showImage: (title, src, text) => showPanel({ kind: "image", title, src, text }), // [PHOTO]
  confirm: (label, run) => {
    pendingAction = { label, run };
    return `AINDA NÃO EXECUTADO: aguardando o usuário confirmar. Pergunte apenas: "Posso ${label}?" e nada mais.`;
  }, // [PHOTO]
};

// [PHOTO] início
/** A foto foi escolhida: confirma e fica ouvindo o que fazer com ela. */
function onPhotoChosen(p: Photo): void {
  showPanel({ kind: "image", title: "Sua foto", src: p.url, text: p.width ? `${p.file.name}\n${p.width}×${p.height}` : p.file.name });
  const q = "Recebi sua foto, o que você quer que eu faça com ela?";
  history.push({ role: "model", text: q });
  const speak = (): void => {
    if (!active) return;
    if (state === "speaking" || state === "thinking") {
      window.setTimeout(speak, 1500);
      return;
    }
    window.clearTimeout(sessionTimer);
    setState("thinking");
    void sayLine(q)
      .then(() => {
        buffer = "";
        captionEl.textContent = "";
        startSession();
      })
      .catch(fail);
  };
  speak();
}
// [PHOTO] fim
let toolUsed = false;
const tools: ToolSet = {
  defs: toolDefs,
  run: (name, args) => {
    toolUsed = true;
    return runTool(name, args, toolCtx);
  },
};

/** Lembrete chegou: notificação e, se a Eleven estiver ativa, fala em voz alta. */
function fireReminder(text: string): void {
  void notify("Eleven", text);
  navigator.vibrate?.([200, 100, 200]);
  if (!active) return;
  const speak = (): void => {
    if (state === "speaking" || state === "thinking") {
      window.setTimeout(speak, 2000);
      return;
    }
    void sayLine(`Lembrete: ${text}`).then(() => {
      if (active) setState("idle");
    });
  };
  speak();
}

async function runCommand(input: Command): Promise<void> {
  let playAfter = false;
  const cmd = input.kind === "resolve" ? await finishResolve(input) : input;

  if (cmd.kind === "close") {
    history.push({ role: "model", text: cmd.spoken });
    closePanel();
    await sayLine(cmd.spoken);
    return;
  }

  const panel = await buildPanel(cmd);
  if (needsConfirm(panel)) {
    const question = `Posso abrir ${labelFor(panel)}?`;
    pendingOpen = { panel, label: labelFor(panel) };
    history.push({ role: "model", text: question });
    await sayLine(question);
    return;
  }

  history.push({ role: "model", text: cmd.spoken });
  playAfter = presentPanel(panel);
  await sayLine(cmd.spoken);
  if (playAfter) startPlayback(); // o vídeo só começa quando ela terminar de falar
}

async function ask(command: string, farewell = false): Promise<void> {
  window.clearTimeout(sessionTimer);
  setState("thinking");

  try {
    if (farewell) {
      await sayLine(farewellLine());
      buffer = "";
      captionEl.textContent = "";
      endSession();
      return;
    }

    history.push({ role: "user", text: command });

    // [PHOTO] início
    const photoCmd = parsePhotoCommand(command);
    if (photoCmd) {
      openPicker(onPhotoChosen, photoCmd === "camera");
      history.push({ role: "model", text: "Tá bom." });
      await sayLine("Tá bom.");
      clearHeard();
      startSession();
      releaseMedia();
      return;
    }
    // [PHOTO] fim

    // [TV-SMARTTHINGS] início
    const tvIntent = parseTvCommand(command);
    if (tvIntent) {
      const reply = await runTv(tvIntent);
      if (reply !== null) {
        history.push({ role: "model", text: reply });
        await sayLine(reply);
        clearHeard();
        startSession();
        releaseMedia();
        return;
      }
    }
    // [TV-SMARTTHINGS] fim

    const cmd = parseCommand(command);
    if (cmd) {
      await runCommand(cmd);
      clearHeard();
      startSession();
      releaseMedia();
      return;
    }
  } catch (e) {
    fail(e);
    return;
  }

  const queue = new SpeechQueue();
  currentQueue = queue;
  let rest = "";
  let full = "";

  try {
    pendingPlay = false;
    toolUsed = false;
    bargedIn = false;
    await streamAnswer(history.slice(-10), (chunk) => {
      full += chunk;
      rest += chunk;
      const { sentences, rest: remaining } = takeSentences(rest);
      rest = remaining;
      for (const sentence of sentences) {
        if (state === "thinking") setState("speaking");
        queue.add(sentence);
      }
    }, tools);
    if (rest.trim()) {
      if (state === "thinking") setState("speaking");
      queue.add(rest.trim());
    }
    if (!full.trim() && !toolUsed) throw new Error("Resposta vazia");
    if (queue.interrupted) history.push({ role: "model", text: `${queue.heard()} [interrompida pelo usuário]`.trim() });
    else if (full.trim()) history.push({ role: "model", text: full.trim() });
    await queue.done();
    if (pendingPlay && !queue.interrupted) {
      pendingPlay = false;
      startPlayback();
    }
  } catch (e) {
    queue.stop();
    fail(e);
    return;
  } finally {
    if (currentQueue === queue) currentQueue = null;
  }

  clearHeard();
  startSession();
  releaseMedia();
}

function fail(e: unknown): void {
  const msg = e instanceof Error ? e.message : "Erro desconhecido";
  console.error(e);
  setState("error", msg);
  window.setTimeout(() => {
    if (active && state === "error") setState(inSession ? "session" : "idle");
  }, 4000);
  if (inSession) resetSessionTimer();
}

function handleUtterance(utterance: string): void {
  const hasWake = WAKE_WORD.test(utterance);

  // Fora da conversa, só reage ao nome. Com vídeo tocando, o som vaza no microfone,
  // então também exige o nome.
  if (!inSession && !hasWake) return;
  if (inSession && !hasWake && mediaPanelOpen() && !mediaHold) return;

  // Biometria antes de qualquer resposta (só na primeira vez; vale até desativar a Eleven).
  if (!isUnlocked()) {
    void lockedFlow(utterance);
    return;
  }

  const command = utterance
    .replace(WAKE_WORD_ALL, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/,\s*([.!?])/g, "$1")
    .replace(/^[\s,.:;!?-]+|[\s,:;-]+$/g, "")
    .trim();

  bargedIn = false;

  // Só o nome: resposta imediata com frase pronta (sem esperar a Groq).
  if (!command && hasWake) {
    window.clearTimeout(ackTimer);
    ackTimer = undefined;
    if (wakeAcked) wakeAcked = false;
    else void fastWake();
    return;
  }
  wakeAcked = false;

  // Vídeo: "pausa" mantém pausado; "continua o vídeo" retoma.
  if (mediaPanelOpen() && PAUSE_VIDEO.test(command) && /v[ií]deo|paus/i.test(command)) {
    interruptedRest = "";
    void keepPaused();
    return;
  }
  if (mediaPanelOpen() && RESUME_VIDEO.test(command)) {
    mediaHold = false;
    window.clearTimeout(holdTimer);
    resumeMedia();
  }

  // [PHOTO] Resposta a "Posso ...?" de ações com permissão
  if (pendingAction) {
    const a = pendingAction;
    pendingAction = null;
    if (inSession && NO.test(command)) {
      void answerAction(a, false);
      return;
    }
    if (inSession && YES.test(command)) {
      void answerAction(a, true);
      return;
    }
  }

  // Resposta a "Posso abrir...?": sim abre, não cancela; qualquer outra coisa cancela e segue normal.
  if (pendingOpen) {
    const p = pendingOpen;
    pendingOpen = null;
    if (inSession && NO.test(command)) {
      void answerOpen(p, false);
      return;
    }
    if (inSession && YES.test(command)) {
      void answerOpen(p, true);
      return;
    }
  }

  // Ela foi interrompida: "continua" (ou um "ok") retoma de onde parou; qualquer outra coisa é um pedido novo.
  if (interruptedRest) {
    const rest = interruptedRest;
    interruptedRest = "";
    if (CONTINUE.test(command) && command.split(/\s+/).length <= 6 && rest.trim()) {
      interruptedRest = rest;
      void continueSpeech();
      return;
    }
  }

  const words = command.split(/\s+/).filter(Boolean).length;
  const farewell = inSession && words <= FAREWELL_MAX_WORDS && FAREWELL.test(command);

  // Só o nome: o Gemini responde naturalmente, sem frase pronta.
  void ask(command || "Eleven.", farewell);
}

function flush(): void {
  const utterance = buffer.trim();
  buffer = "";
  captionEl.textContent = "";
  if (utterance) handleUtterance(utterance);
}

function onDeepgramMessage(raw: string): void {
  const data = JSON.parse(raw) as DeepgramMessage;

  const heard = data.type === "Results" ? (data.channel?.alternatives?.[0]?.transcript?.trim() ?? "") : "";

  // Vídeo tocando e você chamou a Eleven: pausa na hora para ela te ouvir sem o som do vídeo.
  if (heard && WAKE_WORD.test(heard) && mediaPanelOpen() && !mediaHold && state !== "speaking") holdMedia();

  // Ouviu só o nome (mesmo antes de terminar a frase): responde na hora, sem esperar o fim da fala.
  if (data.type === "Results" && heard && state !== "thinking" && state !== "speaking") {
    if (WAKE_ONLY.test(heard)) {
      if (ackTimer === undefined && !wakeAcked && !wakeBusy) {
        ackTimer = window.setTimeout(() => {
          ackTimer = undefined;
          void fastWake();
        }, 300);
      }
    } else if (ackTimer !== undefined) {
      window.clearTimeout(ackTimer); // veio mais coisa depois do nome: é um pedido, não só uma chamada
      ackTimer = undefined;
    }
  }

  // Enquanto ela pensa, ignora o microfone. Enquanto ela fala, só te escuta se for você mesmo (e não o eco dela).
  if (state === "thinking") {
    buffer = "";
    return;
  }
  if (state === "speaking") {
    const words = norm(heard).split(" ").filter((w) => w.length > 2).length;
    if (ackPlaying && WAKE_ONLY.test(heard)) {
      buffer = ""; // é o nome que acabou de chamar, não uma interrupção
      return;
    }
    const stopWord = /^(?:para|pera|espera|calma|chega|sil[eê]ncio|opa|ei|eleven)\b/i.test(heard);
    if (heard && (WAKE_WORD.test(heard) || stopWord || (words >= (ackPlaying ? 1 : 2) && !isEcho(heard)))) {
      if (mediaPanelOpen() && !mediaHold) holdMedia();
      interrupt();
    } else {
      buffer = "";
      return;
    }
  }

  if (data.type === "UtteranceEnd") {
    flush();
    return;
  }
  if (data.type !== "Results") return;

  const text = data.channel?.alternatives?.[0]?.transcript?.trim() ?? "";
  if (text) captionEl.textContent = text;
  if (data.is_final && text) buffer = `${buffer} ${text}`.trim();
  if (data.speech_final) flush();
}

async function getToken(): Promise<string> {
  const { token } = await postJson<{ token: string }>("/.netlify/functions/deepgram-token", {});
  return token;
}

async function connectDeepgram(): Promise<void> {
  const token = await getToken();
  const params = new URLSearchParams({
    model: "nova-3",
    language: "pt-BR",
    smart_format: "true",
    interim_results: "true",
    endpointing: "300",
    utterance_end_ms: "1000",
    vad_events: "true",
  });
  const socket = new WebSocket(`wss://api.deepgram.com/v1/listen?${params.toString()}&keyterm=Eleven`, [
    "bearer",
    token,
  ]);
  ws = socket;

  socket.onopen = () => {
    if (!stream) return;
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "";
    const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    recorder = rec;
    rec.ondataavailable = (ev: BlobEvent) => {
      if (ev.data.size > 0 && socket.readyState === WebSocket.OPEN) socket.send(ev.data);
    };
    rec.start(250);
    keepAlive = window.setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "KeepAlive" }));
    }, 5000);
    if (state === "off" || state === "error") setState("idle");
  };

  socket.onmessage = (ev: MessageEvent<string>) => {
    try {
      onDeepgramMessage(ev.data);
    } catch (e) {
      console.error(e);
    }
  };

  socket.onclose = () => {
    window.clearInterval(keepAlive);
    if (recorder && recorder.state !== "inactive") recorder.stop();
    recorder = null;
    if (active) {
      reconnectTimer = window.setTimeout(() => {
        connectDeepgram().catch(fail);
      }, 1000);
    }
  };

  socket.onerror = () => console.error("Erro no WebSocket do Deepgram");
}

async function keepScreenOn(): Promise<void> {
  try {
    if ("wakeLock" in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => {
        wakeLock = null;
      });
    }
  } catch {
    // sem suporte ou negado: segue normalmente
  }
}

function releaseScreen(): void {
  void wakeLock?.release().catch(() => undefined);
  wakeLock = null;
}

// O navegador solta o bloqueio quando a aba some; pede de novo ao voltar.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && active) void keepScreenOn();
});

async function start(): Promise<void> {
  toggleBtn.disabled = true;
  primeAudio(); // dentro do toque do usuário
  void requestNotifyPermission();
  try {
    // Pede o microfone primeiro, ainda dentro do gesto do usuário.
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    active = true;
    void keepScreenOn();
    toggleBtn.dataset["on"] = "true";

    toggleBtn.textContent = "Desativar";
    setState("off", "Conectando…");
    await connectDeepgram();
    preloadClips();
  } catch (e) {
    const msg = micErrorMessage(e);
    console.error(e);
    stop();
    setState("off", msg);
  } finally {
    toggleBtn.disabled = false;
  }
}

function stop(): void {
  active = false;
  lock();
  window.clearTimeout(ackTimer);
  ackTimer = undefined;
  wakeAcked = false;
  wakeBusy = false;
  stopBrain();
  progressEl.hidden = true;
  releaseScreen();
  window.clearTimeout(sessionTimer);
  inSession = false;
  closePanel();
  window.clearTimeout(reconnectTimer);
  window.clearInterval(keepAlive);
  currentQueue?.stop();
  currentQueue = null;
  currentAudio?.pause();
  currentAudio = null;
  if (recorder && recorder.state !== "inactive") recorder.stop();
  recorder = null;
  ws?.close();
  ws = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  buffer = "";
  captionEl.textContent = "";
  toggleBtn.textContent = "Ativar Eleven";
  toggleBtn.dataset["on"] = "false";
  setState("off");
}

toggleBtn.addEventListener("click", () => {
  if (active) stop();
  else void start();
});

initReminders(fireReminder);

setBrainContext(photoContext); // [PHOTO]
