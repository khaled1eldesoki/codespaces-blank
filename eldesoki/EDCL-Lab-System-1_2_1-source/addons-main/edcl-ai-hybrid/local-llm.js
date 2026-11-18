'use strict';
/* EDCL AI Hybrid - LOCAL model client (Ollama / LM Studio / OpenAI-compatible server on this PC or the laboratory network).
   Confidential EDCL data may be given to a local model, so the address is checked HERE (main process): loopback, private
   network ranges and plain laboratory host names only. A public address is refused before any request is made. */
const isLocalUrl = u => {
  let x; try { x = new URL(u); } catch (e) { return false; } if (!/^https?:$/.test(x.protocol) || x.username || x.password) return false;
  const h = x.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1' || /\.(local|lan|internal|intranet)$/.test(h) || (!h.includes('.') && !h.includes(':'))) return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h);
  const a = +m[1], b = +m[2]; return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
};
const create = (opts = {}) => {
  const fetchImpl = opts.fetchImpl || fetch;
  const base = url => { if (!isLocalUrl(url)) throw new Error('The model address must be on this PC or the laboratory network - not on the internet.'); return String(url).replace(/\/+$/, ''); };
  const call = async (url, init, ms) => { const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms || 180000); try { const r = await fetchImpl(url, { ...init, signal: ctl.signal }); if (!r.ok) throw new Error('The local model server answered HTTP ' + r.status); return await r.json(); } catch (e) { if (e.name === 'AbortError') throw new Error('The local model took too long to answer'); throw e; } finally { clearTimeout(t); } };
  const chat = async ({ backend, url, model, system, messages, timeoutMs }) => {
    const b = base(url); if (!model) throw new Error('No local model name is set'); const msgs = [{ role: 'system', content: String(system || '') }, ...(messages || []).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') }))];
    if (backend === 'ollama') { const j = await call(b + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages: msgs, stream: false, options: { temperature: 0.1 } }) }, timeoutMs); const t = j && j.message && j.message.content; if (!t) throw new Error('The local model returned no text'); return t; }
    if (backend === 'openai') { const j = await call(b + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages: msgs, temperature: 0.1 }) }, timeoutMs); const t = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content; if (!t) throw new Error('The local model returned no text'); return t; }
    throw new Error('Unknown local model type');
  };
  const models = async ({ backend, url }) => { const b = base(url); if (backend === 'ollama') { const j = await call(b + '/api/tags', {}, 15000); return (j.models || []).map(m => m.name); } const j = await call(b + '/v1/models', {}, 15000); return (j.data || []).map(m => m.id); };
  return { chat, models, isLocalUrl };
};
module.exports = { create, isLocalUrl };
