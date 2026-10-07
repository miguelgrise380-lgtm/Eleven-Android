import { Cleaner } from "./cleaner";

/**
 * Cérebro da Eleven: Groq (Llama) via função do Netlify (/.netlify/functions/chat).
 * A chave fica no servidor; o navegador só recebe o texto em streaming.
 */

export interface Turn {
  role: "user" | "model";
  text: string;
}

let controller: AbortController | null = null;

/** Contexto extra para o prompt (ex.: a foto que o usuário enviou). */
let contextFn: () => string = () => "";
export function setBrainContext(fn: () => string): void {
  contextFn = fn;
}

/** Não há mais nada para baixar: o cérebro está sempre pronto. */
export const brainReady = (): boolean => true;

function systemPrompt(): string {
  const now = new Date().toLocaleString("pt-BR", { dateStyle: "full", timeStyle: "short" });
  return [
    "Você é Eleven, uma assistente de voz simpática, esperta e com um toque de humor, inspirada no Jarvis.",
    "Responda SEMPRE em português do Brasil.",
    "Quando falar de si mesma, diga apenas que é a Eleven, uma assistente. Nunca use as expressões inteligência artificial, IA, modelo de linguagem ou chatbot; use a palavra assistente.",
    "Você não é só para conversar: você TRABALHA para o usuário e executa tarefas de verdade usando suas ferramentas (lembretes e timers, notas e tarefas, abrir qualquer site ou link, YouTube, rascunho de e-mail, mensagem de WhatsApp, compromisso na agenda, previsão do tempo, pesquisa de fatos, contas e textos prontos).",
    "Quando o pedido puder ser resolvido com uma ferramenta, use a ferramenta imediatamente, sem pedir permissão e sem perguntar o que dá para deduzir. Só pergunte se faltar algo essencial. Depois de agir, confirme em uma frase curta o que foi feito.",
    "Abrir e-mail, WhatsApp, agenda ou sites exige confirmação do usuário: se o resultado da ferramenta disser que aguarda confirmação, apenas faça a pergunta indicada (ex.: Posso abrir o e-mail?), sem dizer que já abriu. YouTube abre direto, sem confirmação.",
    "Você CONSEGUE ver fotos: o conteúdo da foto enviada vem no trecho FOTO ENVIADA ou pela ferramenta photo_describe. NUNCA diga que não consegue ver a imagem nem peça para reenviar sem antes chamar photo_describe; se uma ferramenta falhar, diga o erro real. Problemas difíceis na imagem (xadrez, matemática, lógica, gráficos, tabelas): chame photo_describe com a pergunta COMPLETA, thorough=true e think=true (o modelo de visão raciocina olhando a imagem) e depois resuma a resposta falando em até 5 frases. Também dá para: metadados e GPS (photo_info), localizar objetos com caixas (photo_detect), editar (photo_edit: girar, cortar, filtros, esconder rostos ou placas, escrever texto), desfazer, cores dominantes, ler QR code, distância até onde foi tirada, salvar, copiar, compartilhar ou imprimir (photo_save) e copiar qualquer valor com copy_text (ex.: \"-12.97, -38.50\"). Ações que gravam, enviam ou usam permissões pedem confirmação: se o resultado disser que aguarda confirmação, apenas faça a pergunta indicada. Nunca identifique pessoas reais pelo rosto.",
    "Para e-mails, mensagens e textos, escreva você mesma o conteúdo completo e deixe pronto. Para fatos e contas, use as ferramentas em vez de chutar.",
    `Data e hora atuais: ${now}.`,
    "Suas respostas serão faladas em voz alta: escreva só texto corrido, sem markdown, listas, emojis, símbolos ou URLs.",
    "Seja direta: comece com uma frase curta. Perguntas simples e papo casual merecem 1 ou 2 frases; perguntas complexas, no máximo 5 frases.",
    "Se não souber algo, diga que não sabe e sugira pedir para você pesquisar. Nunca invente fatos.",
    "Se o usuário apenas chamar seu nome, responda com uma saudação curta e variada.",
    contextFn(),
  ]
    .filter(Boolean)
    .join(" ");
}

export interface ToolSet {
  defs: unknown[];
  run(name: string, args: Record<string, unknown>): Promise<string>;
}

interface ApiMessage {
  role: string;
  content: string | null;
  tool_calls?: unknown;
  tool_call_id?: string;
}

interface PendingCall {
  id: string;
  name: string;
  args: string;
}

/** Uma ida à Groq: fala o texto em streaming e devolve as ferramentas pedidas (se houver). */
async function oneRound(
  messages: ApiMessage[],
  tools: unknown[] | undefined,
  onText: (chunk: string) => void,
  signal: AbortSignal,
): Promise<PendingCall[]> {
  const res = await fetch("/.netlify/functions/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, tools, effort: contextFn() ? "medium" : "low" }),
    signal,
  });
  if (!res.ok || !res.body) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? "Falha ao falar com o cérebro da Eleven.");
  }

  const cleaner = new Cleaner();
  const calls = new Map<number, PendingCall>();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const delta = (
          JSON.parse(data) as {
            choices?: { delta?: { content?: string; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[];
          }
        ).choices?.[0]?.delta;
        if (delta?.content) {
          const text = cleaner.push(delta.content);
          if (text) onText(text);
        }
        for (const tc of delta?.tool_calls ?? []) {
          const i = tc.index ?? 0;
          const cur = calls.get(i) ?? { id: "", name: "", args: "" };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          calls.set(i, cur);
        }
      } catch {
        /* linha parcial ou inválida: ignora */
      }
    }
  }
  const tail = cleaner.flush();
  if (tail) onText(tail);
  return [...calls.values()].filter((c) => c.name);
}

/** Gera a resposta em streaming, executando ferramentas quando a Groq pedir (até 4 rodadas). */
export async function streamAnswer(history: Turn[], onText: (chunk: string) => void, tools?: ToolSet): Promise<void> {
  const messages: ApiMessage[] = [
    { role: "system", content: systemPrompt() },
    ...history.map((t) => ({ role: t.role === "model" ? "assistant" : "user", content: t.text })),
  ];

  controller?.abort();
  const ctrl = new AbortController();
  controller = ctrl;

  try {
    for (let round = 0; round < 4; round++) {
      const useTools = tools && round < 3 ? tools.defs : undefined;
      const calls = await oneRound(messages, useTools, onText, ctrl.signal);
      if (calls.length === 0 || !tools) return;

      messages.push({
        role: "assistant",
        content: null,
        tool_calls: calls.map((c, i) => ({
          id: c.id || `call_${round}_${i}`,
          type: "function",
          function: { name: c.name, arguments: c.args || "{}" },
        })),
      });
      for (const [i, c] of calls.entries()) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(c.args || "{}") as Record<string, unknown>;
        } catch {
          /* argumentos inválidos: segue vazio */
        }
        const result = await tools.run(c.name, args);
        messages.push({ role: "tool", tool_call_id: c.id || `call_${round}_${i}`, content: result.slice(0, 6000) });
      }
    }
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") return;
    throw e;
  } finally {
    if (controller === ctrl) controller = null;
  }
}

export function stopBrain(): void {
  controller?.abort();
  controller = null;
}
