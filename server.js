const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const START_PORT = Number(process.env.PORT) || 3000;
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434/api/chat';
const MODEL = process.env.NOVA_MODEL || 'qwen2.5:1.5b-instruct';
const MAX_MESSAGES = 40;
const MAX_BODY_BYTES = 1_000_000;

const systemPrompt = `You are NOVA — a friendly, helpful, and concise general-purpose AI assistant.

Guidelines:
- Speak naturally and conversationally; handle casual language, slang, typos, and short messages.
- Prefer short, direct answers when appropriate and expand only for complex requests.
- Follow conversation context and resolve follow-ups; ask a single focused clarifying question only when needed.
- Be honest and precise. If uncertain, say so; never fabricate facts, sources, or tool results.
- Avoid repetition and robotic phrasing; vary acknowledgements and tone appropriately.
- For code or technical answers, provide correct, production-ready suggestions and briefly state assumptions.
- Keep responses useful, clear, and respectful.`;

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  response.end(body);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body is too large'));
        request.destroy();
        return;
      }
      body += chunk;
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter(message => message && ['user', 'assistant'].includes(message.role) && typeof message.content === 'string')
    .map(message => ({ role: message.role, content: message.content.trim().slice(0, 20_000) }))
    .filter(message => message.content)
    .slice(-MAX_MESSAGES);
}

async function chatWithModel(messages) {
  const upstream = await fetch(OLLAMA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, stream: false, messages: [{ role: 'system', content: systemPrompt }, ...messages] })
  });
  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) throw new Error(data.error || `Model request failed with status ${upstream.status}`);
  const reply = data.message?.content?.trim();
  if (!reply) throw new Error('The model returned an empty response');
  return reply;
}

async function generateReply(messages) {
  return { reply: await chatWithModel(messages), mode: 'ollama' };
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  if (request.method === 'OPTIONS') {
    response.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    response.end();
    return;
  }
  if (request.method === 'GET' && url.pathname === '/health') {
    sendJson(response, 200, { ok: true, model: MODEL, provider: 'ollama' });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/chat') {
    try {
      const payload = JSON.parse(await readBody(request) || '{}');
      const messages = normalizeMessages(payload.messages);
      if (!messages.length || messages.at(-1).role !== 'user') {
        sendJson(response, 400, { error: 'messages must contain a final user message' });
        return;
      }
      sendJson(response, 200, await generateReply(messages));
    } catch (error) {
      const status = error.message === 'Request body is too large' ? 413 : 502;
      sendJson(response, status, { error: error.message || 'Unable to generate a response', hint: `Make sure Ollama is running and the ${MODEL} model is installed.` });
    }
    return;
  }
  if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    fs.readFile(path.join(__dirname, 'index.html'), (error, content) => {
      if (error) { sendJson(response, 500, { error: 'Unable to load the application' }); return; }
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(content);
    });
    return;
  }
  sendJson(response, 404, { error: 'Not found' });
});

function startServer(port) {
  server.once('error', error => {
    if (error.code === 'EADDRINUSE' && port < START_PORT + 20) {
      console.warn(`Port ${port} is busy; trying ${port + 1}.`);
      startServer(port + 1);
      return;
    }
    throw error;
  });
  server.listen(port, () => console.log(`NOVA is running at http://localhost:${port} using model ${MODEL}`));
}

startServer(START_PORT);
