// Claude via AWS Bedrock — an isolated, deletable alternative to callOpenAI().
// Selected only when LLM_PROVIDER=claude (see the toggle in llm.mjs's dispatch);
// normalizes the Bedrock Converse response into the same { parsed, usage } shape
// callOpenAI() returns, so no caller of callLLM() can tell which provider ran.
//
// To remove this path entirely: delete this file and revert the LLM_PROVIDER
// branch in the 'openai' case of callLLM() in llm.mjs — nothing else references it.

import { LLMError } from './llm.mjs';

const DEFAULT_REGION = 'us-east-1';
// ASSUMPTION — verify against the target AWS account before relying on this:
// default Bedrock model id/region; override via BEDROCK_MODEL_ID / BEDROCK_REGION.
const DEFAULT_MODEL_ID = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';

async function fetchConverse(url, apiKey, payload, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new LLMError(`network error: ${e.message}`, { retryable: true });
  } finally {
    clearTimeout(timer);
  }
  const body = await res.text();
  if (!res.ok) {
    const retryable = res.status === 429 || res.status >= 500;
    const quota = res.status === 429;
    const ra = res.headers.get('retry-after');
    let retryAfterMs = 0;
    if (ra) retryAfterMs = /^\d+$/.test(ra.trim()) ? parseInt(ra, 10) * 1000 : Math.max(0, new Date(ra).getTime() - Date.now());
    throw new LLMError(`${res.status} ${res.statusText}: ${body.slice(0, 300)}`, { status: res.status, retryable, quota, body: body.slice(0, 500), retryAfterMs });
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new LLMError(`malformed JSON from Bedrock: ${body.slice(0, 200)}`, { parse: true });
  }
}

// Forces structured output the same way callAnthropic() does against the native
// Anthropic API: a single tool with toolChoice pinned to it, so `input` is the
// already-parsed JSON matching `schema`.
export async function callClaudeBedrock({ system, user, schema, timeoutMs }) {
  const region = process.env.BEDROCK_REGION || DEFAULT_REGION;
  const modelId = process.env.BEDROCK_MODEL_ID || DEFAULT_MODEL_ID;
  const apiKey = process.env.CLAUDE_BEDROCK_API_KEY;
  if (!apiKey) throw new LLMError('LLM_PROVIDER=claude but CLAUDE_BEDROCK_API_KEY is not set.');

  const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(modelId)}/converse`;
  const payload = {
    messages: [{ role: 'user', content: [{ text: user }] }],
    system: [{ text: system }],
    inferenceConfig: { temperature: 0, maxTokens: 2048 },
    toolConfig: {
      tools: [{ toolSpec: { name: 'record_extraction', description: 'Record the structured extraction.', inputSchema: { json: schema } } }],
      toolChoice: { tool: { name: 'record_extraction' } },
    },
  };
  const data = await fetchConverse(url, apiKey, payload, timeoutMs);
  const blocks = data?.output?.message?.content || [];
  const toolUse = blocks.find((b) => b.toolUse)?.toolUse;
  if (!toolUse) throw new LLMError(`no tool_use in Bedrock response: ${JSON.stringify(data).slice(0, 200)}`, { parse: true });

  const u = data.usage || null;
  const usage = u ? { input_tokens: u.inputTokens, output_tokens: u.outputTokens } : null;
  return { parsed: toolUse.input, usage };
}
