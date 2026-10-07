import type { Command } from "./commands";
import { PHOTO_TOOLS } from "./photo"; // [PHOTO]

type PageCommand = Extract<Command, { kind: "page" }>;

/** O que as ferramentas precisam do app (painel e fala). */
export interface ToolContext {
  openPage(cmd: PageCommand): Promise<string | null>;
  showText(title: string, text: string): void;
  showImage(title: string, src: string, text: string): void; // [PHOTO]
  /** Pede permissão por voz; só executa `run` se o usuário disser sim. Devolve o aviso para o modelo. */
  confirm(label: string, run: () => Promise<string>): string; // [PHOTO]
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string> | string;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);
const enc = encodeURIComponent;
const obj = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: "object",
  properties,
  required,
});
const S = (description: string): Record<string, unknown> => ({ type: "string", description });

const page = (url: string, title: string): PageCommand => ({ kind: "page", url, title, spoken: "" });

// ---------- Lembretes e timers (guardados no aparelho) ----------
interface Reminder {
  id: string;
  due: number;
  text: string;
}
const REM_KEY = "eleven.reminders";
const ITEMS_KEY = "eleven.items";
let onReminder: (text: string) => void = () => undefined;
const timers = new Map<string, number>();

function load<T>(key: string): T[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "[]") as unknown;
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}
function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* sem armazenamento: segue só em memória */
  }
}

function arm(r: Reminder): void {
  const wait = Math.max(0, r.due - Date.now());
  timers.set(
    r.id,
    window.setTimeout(() => {
      timers.delete(r.id);
      save(REM_KEY, load<Reminder>(REM_KEY).filter((x) => x.id !== r.id));
      onReminder(r.text);
    }, Math.min(wait, 2_000_000_000)),
  );
}

/** Chamado uma vez ao abrir o app: define quem avisa e rearma os lembretes salvos. */
export function initReminders(cb: (text: string) => void): void {
  onReminder = cb;
  load<Reminder>(REM_KEY).forEach(arm);
}

const when = (ms: number): string =>
  new Date(ms).toLocaleString("pt-BR", { weekday: "long", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });

// ---------- Anotações e tarefas ----------
interface Item {
  kind: "nota" | "tarefa";
  text: string;
}
const kindOf = (v: unknown): "nota" | "tarefa" => (str(v) === "nota" ? "nota" : "tarefa");

// ---------- Datas para o Google Agenda ----------
const pad = (n: number): string => String(n).padStart(2, "0");
const gcal = (d: Date): string =>
  `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;

const TOOLS: ToolDef[] = [
  ...PHOTO_TOOLS, // [PHOTO]
  {
    name: "copy_text",
    description:
      "Copia um texto para a área de transferência do usuário (ex.: latitude e longitude, um metadado, um resultado). Passe exatamente o valor pedido, sem explicações.",
    parameters: obj({ text: S("Texto exato a copiar"), label: S("Nome curto do que foi copiado") }, ["text"]),
    run: async (a, ctx) => {
      const text = str(a["text"]);
      if (!text) return "Nada para copiar.";
      try {
        await navigator.clipboard.writeText(text);
        return "Copiado para a área de transferência.";
      } catch {
        ctx.showText(str(a["label"]) || "Copiar", text);
        return "O navegador bloqueou a cópia automática. O texto está no painel com o botão Copiar para o usuário tocar.";
      }
    },
  },
  {
    name: "set_reminder",
    description: "Cria lembrete ou timer que avisa por voz e notificação. Calcule os segundos a partir da data e hora atuais.",
    parameters: obj({ seconds: { type: "number", description: "Daqui a quantos segundos avisar" }, text: S("O que lembrar, curto") }, ["seconds", "text"]),
    run: async (a) => {
      const seconds = Math.max(1, Math.round(num(a["seconds"])));
      const r: Reminder = { id: `${Date.now()}${Math.random().toString(36).slice(2, 6)}`, due: Date.now() + seconds * 1000, text: str(a["text"]) || "Lembrete" };
      save(REM_KEY, [...load<Reminder>(REM_KEY), r]);
      arm(r);
      return `Lembrete criado para ${when(r.due)}.`;
    },
  },
  {
    name: "add_item",
    description: "Salva uma nota ou tarefa (lista de afazeres/compras) no aparelho.",
    parameters: obj({ kind: { type: "string", enum: ["nota", "tarefa"] }, text: S("Conteúdo") }, ["kind", "text"]),
    run: async (a) => {
      const items = load<Item>(ITEMS_KEY);
      items.push({ kind: kindOf(a["kind"]), text: str(a["text"]) });
      save(ITEMS_KEY, items);
      return "Salvo.";
    },
  },
  {
    name: "list_items",
    description: "Mostra no painel e devolve as notas ou tarefas salvas.",
    parameters: obj({ kind: { type: "string", enum: ["nota", "tarefa"] } }, ["kind"]),
    run: async (a, ctx) => {
      const kind = kindOf(a["kind"]);
      const list = load<Item>(ITEMS_KEY).filter((i) => i.kind === kind);
      if (list.length === 0) return kind === "tarefa" ? "Não há tarefas salvas." : "Não há notas salvas.";
      ctx.showText(kind === "tarefa" ? "Tarefas" : "Notas", list.map((i, n) => `${n + 1}. ${i.text}`).join("\n"));
      return list.map((i) => i.text).join("; ");
    },
  },
  {
    name: "remove_item",
    description: "Remove (ou conclui) uma nota/tarefa cujo texto contém o trecho dado.",
    parameters: obj({ contains: S("Trecho do texto do item") }, ["contains"]),
    run: async (a) => {
      const key = str(a["contains"]).toLowerCase();
      const items = load<Item>(ITEMS_KEY);
      const idx = items.findIndex((i) => i.text.toLowerCase().includes(key));
      if (idx < 0) return "Não encontrei esse item.";
      const [gone] = items.splice(idx, 1);
      save(ITEMS_KEY, items);
      return `Removido: ${gone?.text ?? ""}`;
    },
  },
  {
    name: "open_url",
    description: "Abre qualquer site ou link (YouTube, Facebook, etc.) no painel ou em nova aba.",
    parameters: obj({ url: S("Endereço completo https://...") }, ["url"]),
    run: async (a, ctx) => {
      const url = str(a["url"]);
      if (!/^https?:\/\//i.test(url)) return "Endereço inválido.";
      const hold = await ctx.openPage(page(url, new URL(url).hostname.replace(/^www\./, "")));
      if (hold) return hold;
      return "Aberto.";
    },
  },
  {
    name: "youtube",
    description: "Procura no YouTube e, se play=true, já toca o primeiro resultado.",
    parameters: obj({ query: S("Busca"), play: { type: "boolean" } }, ["query"]),
    run: async (a, ctx) => {
      const q = str(a["query"]);
      const hold = await ctx.openPage({ ...page(`https://www.youtube.com/results?search_query=${enc(q)}`, `YouTube · ${q}`), playFirstVideo: a["play"] === true });
      if (hold) return hold;
      return "Aberto no YouTube.";
    },
  },
  {
    name: "compose_email",
    description: "Abre um rascunho de e-mail pronto no Gmail (o usuário só confere e envia).",
    parameters: obj({ to: S("Destinatário, se souber"), subject: S("Assunto"), body: S("Texto completo do e-mail") }, ["subject", "body"]),
    run: async (a, ctx) => {
      const url = `https://mail.google.com/mail/?view=cm&fs=1&to=${enc(str(a["to"]))}&su=${enc(str(a["subject"]))}&body=${enc(str(a["body"]))}`;
      const hold = await ctx.openPage(page(url, "Rascunho de e-mail"));
      if (hold) return hold;
      return "Rascunho aberto no Gmail para o usuário revisar e enviar.";
    },
  },
  {
    name: "whatsapp_message",
    description: "Abre o WhatsApp com a mensagem pronta (o usuário só toca em enviar). Telefone com DDI+DDD, só números; se não souber, deixe vazio.",
    parameters: obj({ phone: S("Telefone, só números"), text: S("Mensagem") }, ["text"]),
    run: async (a, ctx) => {
      const phone = str(a["phone"]).replace(/\D/g, "");
      const hold = await ctx.openPage(page(`https://wa.me/${phone}?text=${enc(str(a["text"]))}`, "WhatsApp"));
      if (hold) return hold;
      return "WhatsApp aberto com a mensagem pronta.";
    },
  },
  {
    name: "calendar_event",
    description: "Cria um compromisso no Google Agenda (abre pronto para salvar). Datas locais no formato YYYY-MM-DDTHH:MM.",
    parameters: obj({ title: S("Título"), start: S("Início"), end: S("Fim, opcional"), details: S("Detalhes, opcional") }, ["title", "start"]),
    run: async (a, ctx) => {
      const start = new Date(str(a["start"]));
      if (Number.isNaN(start.getTime())) return "Data de início inválida.";
      const endRaw = new Date(str(a["end"]));
      const end = Number.isNaN(endRaw.getTime()) ? new Date(start.getTime() + 3_600_000) : endRaw;
      const url = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${enc(str(a["title"]))}&dates=${gcal(start)}/${gcal(end)}&details=${enc(str(a["details"]))}`;
      const hold = await ctx.openPage(page(url, "Google Agenda"));
      if (hold) return hold;
      return "Evento aberto no Google Agenda para salvar.";
    },
  },
  {
    name: "weather",
    description: "Previsão do tempo atual e dos próximos dias de uma cidade.",
    parameters: obj({ place: S("Cidade") }, ["place"]),
    run: async (a) => {
      const place = str(a["place"]);
      if (!place) return "Preciso saber a cidade.";
      const geo = (await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${enc(place)}&count=1&language=pt`)).json()) as {
        results?: { name: string; latitude: number; longitude: number; admin1?: string }[];
      };
      const g = geo.results?.[0];
      if (!g) return "Não encontrei essa cidade.";
      const f = await (
        await fetch(
          `https://api.open-meteo.com/v1/forecast?latitude=${g.latitude}&longitude=${g.longitude}&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code&timezone=auto&forecast_days=3`,
        )
      ).json();
      return JSON.stringify({ cidade: `${g.name}${g.admin1 ? `, ${g.admin1}` : ""}`, previsao: f, nota: "weather_code usa a tabela WMO; temperaturas em °C" });
    },
  },
  {
    name: "lookup",
    description: "Busca fatos na Wikipédia para responder com informação real.",
    parameters: obj({ query: S("Assunto") }, ["query"]),
    run: async (a) => {
      const res = await fetch(`/.netlify/functions/wiki?q=${enc(str(a["query"]))}`);
      const d = (await res.json()) as { summary?: string };
      return d.summary || "Nada encontrado.";
    },
  },
  {
    name: "calculate",
    description: "Faz contas. Use sempre que houver cálculo.",
    parameters: obj({ expression: S("Ex.: (12*3.5)+8/2") }, ["expression"]),
    run: async (a) => {
      const e = str(a["expression"]).replace(/,/g, ".").replace(/x/gi, "*");
      if (!/^[\d+\-*/().%\s]+$/.test(e)) return "Expressão inválida.";
      const v = new Function(`"use strict"; return (${e});`)() as unknown;
      return typeof v === "number" && Number.isFinite(v) ? String(v) : "Não consegui calcular.";
    },
  },
  {
    name: "show_text",
    description: "Mostra no painel um texto pronto (e-mail, carta, resumo, roteiro) com botão Copiar. Use quando o usuário pedir para escrever algo.",
    parameters: obj({ title: S("Título"), text: S("Texto completo") }, ["title", "text"]),
    run: async (a, ctx) => {
      ctx.showText(str(a["title"]) || "Texto", str(a["text"]));
      return "Texto mostrado no painel com botão de copiar.";
    },
  },
];

export const toolDefs = TOOLS.map((t) => ({
  type: "function",
  function: { name: t.name, description: t.description, parameters: t.parameters },
}));

export async function runTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return "Ferramenta desconhecida.";
  try {
    return await tool.run(args, ctx);
  } catch (e) {
    return `Erro: ${e instanceof Error ? e.message : "falhou"}`;
  }
}
