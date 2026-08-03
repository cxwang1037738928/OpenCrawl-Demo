/**
 * chat_models.js — which models the chat picker may offer, and validation.
 *
 * The list is env-driven (CHAT_MODELS) rather than hard-coded, because the
 * models a deployment can actually reach depend on its credentials: Gemini ids
 * need GEMINI_API_KEY, the Azure deployment needs the Foundry trio, and a local
 * Ollama tag needs an Ollama that this host can see (there is none on Render).
 * Editing a dashboard variable is a config change; editing a literal here would
 * be a deploy.
 *
 * Format: comma-separated, `id` or `id=Label`. Example:
 *   CHAT_MODELS=gemini/gemini-3.1-flash-lite=Flash Lite (fast),gemini/gemini-3.1-flash=Flash
 *
 * Unset, it falls back to whatever is actually configured — REASONING_MODEL
 * plus the Azure deployment if present — so the picker always offers at least
 * the model the server would have used anyway.
 *
 * The allowlist is a security boundary, not a convenience: the model id decides
 * which provider is called (see chatProvider in retriever.js), so an unchecked
 * id from the browser would let a visitor redirect the request.
 */

import 'dotenv/config';

/** A readable label for an id we were not given one for. */
function defaultLabel(id) {
  if (/^gemini[/-]/i.test(id)) return `${id.replace(/^gemini\//i, '')} (Google)`;
  if (id === (process.env.AZURE_DEPLOYMENT_NAME || '').trim()) return `${id} (Azure AI Foundry)`;
  return id;
}

export function chatModels() {
  const configured = (process.env.CHAT_MODELS || '').trim();

  const ids = configured
    ? configured.split(',').map((entry) => entry.trim()).filter(Boolean)
    : [
        (process.env.REASONING_MODEL || '').trim(),
        (process.env.AZURE_DEPLOYMENT_NAME || '').trim(),
      ].filter(Boolean);

  const seen = new Set();
  const models = [];
  for (const entry of ids) {
    const splitAt = entry.indexOf('=');
    const id = (splitAt === -1 ? entry : entry.slice(0, splitAt)).trim();
    const label = splitAt === -1 ? '' : entry.slice(splitAt + 1).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, name: label || defaultLabel(id) });
  }
  return models;
}

/** The model used when the request does not name one. */
export const defaultChatModel = () => {
  const configured = (process.env.REASONING_MODEL || '').trim();
  const allowed = chatModels();
  // REASONING_MODEL wins when it is offered; otherwise fall back to the first
  // entry so a CHAT_MODELS list that omits it still yields a usable default.
  return allowed.some((m) => m.id === configured) ? configured : (allowed[0]?.id ?? configured);
};

export const isAllowedChatModel = (id) => chatModels().some((model) => model.id === id);
