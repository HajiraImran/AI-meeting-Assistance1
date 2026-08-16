// The desktop app calls THIS, never a model provider directly. Keys stay here.
// Primary model: Gemini. If Gemini fails, it silently falls back to GPT.
// Supports both a normal JSON answer and a streamed (token-by-token) answer.
//
// Deploy:  supabase functions deploy ask
// Secrets: supabase secrets set GEMINI_API_KEY=your_gemini_key
//          supabase secrets set OPENAI_API_KEY=your_openai_key   (fallback)

const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY")!;
const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY") || "";
const GEMINI_MODEL = "gemini-3.6-flash";
const OPENAI_MODEL = "gpt-4o";
const GBASE = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}`;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const { question, context, stream, temperature, maxTokens } = await req.json();
    if (!question) return json({ error: "Missing 'question'." }, 400);
    const gen = { temperature, maxTokens };

    if (stream) return await streamAnswer(question, context, gen);
    return await fullAnswer(question, context, gen);
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});

// ---------- Streaming ----------
type Gen = { temperature?: number; maxTokens?: number };
async function streamAnswer(question: string, context?: string, gen?: Gen) {
  // Try Gemini first; if it errors, fall back to GPT — both as one text stream.
  let upstream = await geminiStream(question, context, gen);
  let parse = parseGeminiSse;
  if (!upstream || !upstream.ok || !upstream.body) {
    if (!OPENAI_KEY) return json({ error: "Gemini failed and no OpenAI fallback set." });
    upstream = await openaiStream(question, context, gen);
    parse = parseOpenaiSse;
    if (!upstream || !upstream.ok || !upstream.body) {
      return json({ error: "Both models failed to stream." });
    }
  }

  const enc = new TextEncoder();
  const out = new ReadableStream({
    async start(controller) {
      const reader = upstream!.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          const t = parse(line.trim());
          if (t) controller.enqueue(enc.encode(t));
        }
      }
      controller.close();
    },
  });
  return new Response(out, { headers: { ...cors, "Content-Type": "text/plain; charset=utf-8" } });
}

// ---------- Full (non-streaming) ----------
async function fullAnswer(question: string, context?: string, gen?: Gen) {
  const g = await geminiFull(question, context, gen);
  if (g.ok) return json({ answer: g.text });

  if (OPENAI_KEY) {
    const o = await openaiFull(question, context, gen);
    if (o.ok) return json({ answer: o.text });
    return json({ error: "Gemini: " + g.error + " | GPT: " + o.error });
  }
  return json({ error: "Gemini: " + g.error });
}

// ---------- Gemini ----------
function geminiBody(question: string, context?: string, gen?: Gen) {
  const body: Record<string, unknown> = { contents: [{ role: "user", parts: [{ text: question }] }] };
  if (context) body.systemInstruction = { parts: [{ text: context }] };
  const cfg: Record<string, unknown> = {};
  if (gen?.temperature !== undefined) cfg.temperature = gen.temperature;
  if (gen?.maxTokens !== undefined) cfg.maxOutputTokens = gen.maxTokens;
  if (Object.keys(cfg).length) body.generationConfig = cfg;
  return JSON.stringify(body);
}
async function geminiStream(question: string, context?: string, gen?: Gen) {
  try {
    return await fetch(`${GBASE}:streamGenerateContent?alt=sse`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
      body: geminiBody(question, context, gen),
    });
  } catch { return null; }
}
async function geminiFull(question: string, context?: string, gen?: Gen) {
  try {
    const res = await fetch(`${GBASE}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
      body: geminiBody(question, context, gen),
    });
    const data = await res.json();
    if (!res.ok || data.error) return { ok: false, error: data?.error?.message || `HTTP ${res.status}` };
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return { ok: false, error: data?.candidates?.[0]?.finishReason || "empty" };
    return { ok: true, text };
  } catch (e) { return { ok: false, error: String(e) }; }
}
function parseGeminiSse(line: string) {
  if (!line.startsWith("data:")) return "";
  const p = line.slice(5).trim();
  if (!p || p === "[DONE]") return "";
  try { return JSON.parse(p)?.candidates?.[0]?.content?.parts?.[0]?.text || ""; } catch { return ""; }
}

// ---------- OpenAI (fallback) ----------
function openaiBody(question: string, context: string | undefined, stream: boolean, gen?: Gen) {
  const messages = [];
  if (context) messages.push({ role: "system", content: context });
  messages.push({ role: "user", content: question });
  const b: Record<string, unknown> = { model: OPENAI_MODEL, messages, stream };
  if (gen?.temperature !== undefined) b.temperature = gen.temperature;
  if (gen?.maxTokens !== undefined) b.max_tokens = gen.maxTokens;
  return JSON.stringify(b);
}
async function openaiStream(question: string, context?: string, gen?: Gen) {
  try {
    return await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
      body: openaiBody(question, context, true, gen),
    });
  } catch { return null; }
}
async function openaiFull(question: string, context?: string, gen?: Gen) {
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
      body: openaiBody(question, context, false, gen),
    });
    const data = await res.json();
    if (!res.ok || data.error) return { ok: false, error: data?.error?.message || `HTTP ${res.status}` };
    const text = data?.choices?.[0]?.message?.content;
    if (!text) return { ok: false, error: "empty" };
    return { ok: true, text };
  } catch (e) { return { ok: false, error: String(e) }; }
}
function parseOpenaiSse(line: string) {
  if (!line.startsWith("data:")) return "";
  const p = line.slice(5).trim();
  if (!p || p === "[DONE]") return "";
  try { return JSON.parse(p)?.choices?.[0]?.delta?.content || ""; } catch { return ""; }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
