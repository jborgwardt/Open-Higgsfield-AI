// Any OpenAI-compatible chat endpoint (Ollama, LM Studio, llama.cpp, vLLM, OpenRouter, Groq, ApiMart…).
// Defaults to the "local LLM" settings; pass baseUrl/key to target another gateway.
import { getSettings } from '../store.js';
import { fetchJSON } from '../http.js';

export async function openaiChat({ model, messages, signal, baseUrl, key, provider = 'llm' }) {
  const s = getSettings();
  const base = (baseUrl || s.llmBaseUrl).replace(/\/$/, '');
  const auth = baseUrl ? key : s.llmKey;
  const r = await fetchJSON(provider, `${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
    body: JSON.stringify({ model: model || s.llmModel, messages, temperature: 0.7 }),
    signal: signal || AbortSignal.timeout(300000),
  });
  return r.choices?.[0]?.message?.content || '';
}

export async function openaiPing() {
  const s = getSettings();
  const r = await fetchJSON('llm', `${s.llmBaseUrl.replace(/\/$/, '')}/models`, {
    headers: s.llmKey ? { Authorization: `Bearer ${s.llmKey}` } : {},
    signal: AbortSignal.timeout(2500),
  });
  return (r.data || []).map((m) => m.id);
}
