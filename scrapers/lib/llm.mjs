// LLM adapters — provider-agnostic structured-JSON calls. One entry point,
// callLLM(), dispatches to Gemini / OpenAI / Anthropic (native strict-JSON modes)
// or a deterministic offline `mock`. Errors are typed so the orchestrator can
// distinguish "retry" (429 / 5xx) from "malformed output" (retry once then NA).

import { RESPONSE_SCHEMA, toGeminiSchema, PARAMS } from './qualitative.mjs';

export class LLMError extends Error {
  constructor(message, { status = 0, retryable = false, quota = false, parse = false } = {}) {
    super(message);
    this.name = 'LLMError';
    this.status = status;
    this.retryable = retryable;
    this.quota = quota;
    this.parse = parse;
  }
}

async function fetchJSON(url, options, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { ...options, signal: ctrl.signal });
  } catch (e) {
    throw new LLMError(`network error: ${e.message}`, { retryable: true });
  } finally {
    clearTimeout(timer);
  }
  const body = await res.text();
  if (!res.ok) {
    const retryable = res.status === 429 || res.status >= 500;
    const quota = res.status === 429 && /quota|exhaust|exceed|rate/i.test(body);
    throw new LLMError(`${res.status} ${res.statusText}: ${body.slice(0, 300)}`, { status: res.status, retryable, quota });
  }
  return body;
}

function parseStrict(text) {
  // Tolerate a fenced ```json block if a model wraps its output.
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new LLMError(`malformed JSON from model: ${cleaned.slice(0, 200)}`, { parse: true });
  }
}

// ---- Gemini (generativelanguage v1beta) -----------------------------------
async function callGemini({ model, apiKey, system, user, timeoutMs }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`;
  const payload = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: toGeminiSchema(RESPONSE_SCHEMA),
    },
  };
  const body = await fetchJSON(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }, timeoutMs);
  const data = parseStrict(body);
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? '';
  if (!text) throw new LLMError(`empty Gemini response: ${body.slice(0, 200)}`, { parse: true });
  return { parsed: parseStrict(text), usage: data.usageMetadata || null };
}

// ---- OpenAI (chat completions, strict json_schema) ------------------------
async function callOpenAI({ model, apiKey, system, user, timeoutMs }) {
  const url = 'https://api.openai.com/v1/chat/completions';
  const payload = {
    model,
    temperature: 0,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'qualitative', strict: true, schema: RESPONSE_SCHEMA },
    },
  };
  const body = await fetchJSON(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(payload),
  }, timeoutMs);
  const data = parseStrict(body);
  const text = data?.choices?.[0]?.message?.content ?? '';
  if (!text) throw new LLMError(`empty OpenAI response: ${body.slice(0, 200)}`, { parse: true });
  return { parsed: parseStrict(text), usage: data.usage || null };
}

// ---- Anthropic (messages, forced tool-use) --------------------------------
async function callAnthropic({ model, apiKey, system, user, timeoutMs }) {
  const url = 'https://api.anthropic.com/v1/messages';
  const tool = { name: 'record_qualitative', description: 'Record the own-document qualitative read.', input_schema: RESPONSE_SCHEMA };
  const payload = {
    model,
    max_tokens: 2048,
    temperature: 0,
    system,
    messages: [{ role: 'user', content: user }],
    tools: [tool],
    tool_choice: { type: 'tool', name: tool.name },
  };
  const body = await fetchJSON(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(payload),
  }, timeoutMs);
  const data = parseStrict(body);
  const block = (data?.content || []).find((b) => b.type === 'tool_use');
  if (!block) throw new LLMError(`no tool_use in Anthropic response: ${body.slice(0, 200)}`, { parse: true });
  return { parsed: block.input, usage: data.usage || null };
}

// ---- Mock (offline, deterministic, clearly synthetic) ----------------------
function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

export function mockAnswer(user) {
  const h = hash(user);
  const pick = (arr, salt) => arr[(h + salt) % arr.length];
  const out = {};
  PARAMS.forEach((p, i) => {
    const verdict = pick(p.verdicts.filter((v) => v !== 'NA').length ? p.verdicts : p.verdicts, i * 7);
    out[p.key] = {
      verdict,
      value: verdict === 'NA' ? '' : '[MOCK]',
      note: '[MOCK] synthetic output — set GEMINI_API_KEY for real extraction.',
      confidence: pick(['high', 'medium', 'low'], i * 3),
    };
  });
  return out;
}

// ---- Dispatch --------------------------------------------------------------
export async function callLLM({ provider, model, apiKey, system, user, timeoutMs = 60000 }) {
  switch (provider) {
    case 'gemini':
      return callGemini({ model, apiKey, system, user, timeoutMs });
    case 'openai':
      return callOpenAI({ model, apiKey, system, user, timeoutMs });
    case 'anthropic':
      return callAnthropic({ model, apiKey, system, user, timeoutMs });
    case 'mock':
      return { parsed: mockAnswer(user), usage: { mock: true } };
    default:
      throw new LLMError(`unknown provider '${provider}'`);
  }
}
