// StudySaathi AI - SINGLE FILE app. No npm install needed (Node.js 18+ only).
// Run:  node studysaathi.js   -> it asks for your key in the terminal, checks Gemma, opens the browser.
// (Optional) skip the question by making a ".env" file next to this file: GEMINI_API_KEY=your_key_here
const http = require('http');
const fs = require('fs');
const path = require('path');

// Tiny .env loader (so no dotenv package is needed). Real env variables win over the file.
try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  });
} catch { /* no .env file: fine on hosts that set real environment variables */ }

const PORT = process.env.PORT || 3000;
const MODEL = (process.env.GEMMA_MODEL || 'gemma-4-26b-a4b-it').trim();
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MIN_CHARS = 50;
const MAX_CHARS = 12000;
const DAILY_LIMIT = parseInt(process.env.DAILY_LIMIT || '500', 10);

const getKey = () => (process.env.GEMINI_API_KEY || '').trim();
const keyConfigured = () => getKey() !== '' && getKey() !== 'your_api_key_here';

const hits = new Map();
setInterval(() => { const now = Date.now(); for (const [ip, l] of hits) if (!l.some((t) => now - t < 60000)) hits.delete(ip); }, 60000).unref();
let daily = { day: new Date().toDateString(), count: 0 };
const rateOk = (ip) => {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 60000);
  if (list.length >= 10) return false;
  list.push(now); hits.set(ip, list); return true;
};
const dailyOk = () => {
  const today = new Date().toDateString();
  if (daily.day !== today) daily = { day: today, count: 0 };
  if (daily.count >= DAILY_LIMIT) return false;
  daily.count++; return true;
};

// Calls Google; key goes in a header and is never logged or returned.
async function google(pathname, options = {}) {
  const r = await fetch(API_BASE + pathname, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': getKey() },
    signal: AbortSignal.timeout(90000),
  });
  let body = null;
  try { body = await r.json(); } catch { /* ignore */ }
  return { status: r.status, ok: r.ok, body };
}

function friendlyError(status, body) {
  const msg = (body && body.error && body.error.message) || '';
  if (status === 400 && /api key/i.test(msg)) return [401, 'Google rejected the API key. Check GEMINI_API_KEY in your .env file.'];
  if (status === 401 || status === 403) return [401, 'The API key is not allowed to use this model. Check the key and its permissions in Google AI Studio.'];
  if (status === 404) return [502, `Model "${MODEL}" was not found. Check GEMMA_MODEL against the official model list.`];
  if (status === 429) return [429, 'Google API quota or rate limit reached. Try again later.'];
  return [502, 'The AI service returned an error. Please try again.'];
}

const PROMPTS = {
  explain: (n) => `You are StudySaathi, a friendly tutor. Explain the student's notes in simple, clear English.
Use markdown with "## " headings, short paragraphs, bullet lists, and at least one concrete example. Do not add facts unrelated to the notes.

NOTES:
"""
${n}
"""`,
  summary: (n) => `You are StudySaathi, a study assistant. Summarize the notes using exactly these markdown sections:
## Summary (3-5 sentences)
## Key Concepts (bullet list)
## Important Takeaways (bullet list)

NOTES:
"""
${n}
"""`,
  quiz: (n) => `You are StudySaathi, a quiz writer. Based only on the notes, create exactly 5 multiple-choice questions.
Reply with ONLY valid JSON (no markdown, no code fences) in this shape:
{"questions":[{"question":"...","options":["A text","B text","C text","D text"],"answerIndex":0,"explanation":"one or two short sentences"}]}
Each question has exactly 4 options and answerIndex is 0-3.

NOTES:
"""
${n}
"""`,
};

function parseQuiz(text) {
  const clean = text.replace(/```json|```/g, '').trim();
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  const data = JSON.parse(clean.slice(start, end + 1));
  const qs = data.questions;
  if (!Array.isArray(qs) || qs.length !== 5) throw new Error('bad count');
  return qs.map((q) => {
    if (typeof q.question !== 'string' || !Array.isArray(q.options) || q.options.length !== 4 ||
        !Number.isInteger(q.answerIndex) || q.answerIndex < 0 || q.answerIndex > 3) throw new Error('bad shape');
    return {
      question: q.question,
      options: q.options.map(String),
      answerIndex: q.answerIndex,
      explanation: String(q.explanation || ''),
    };
  });
}


function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 50 * 1024) { reject({ code: 413, error: 'Request too large.' }); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch { reject({ code: 400, error: 'Invalid request.' }); } });
    req.on('error', () => reject({ code: 400, error: 'Invalid request.' }));
  });
}
const clientIp = (req) => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';

async function handleTest(req, res) {
  if (!rateOk(clientIp(req))) return send(res, 429, { ok: false, error: 'Too many requests. Please wait a minute and try again.' });
  if (!keyConfigured()) return send(res, 503, { ok: false, error: 'No API key found. Add GEMINI_API_KEY to your .env file and restart the server.' });
  try {
    const r = await google(`/models/${encodeURIComponent(MODEL)}`);
    if (!r.ok) { const [code, error] = friendlyError(r.status, r.body); return send(res, code, { ok: false, error }); }
    const methods = r.body.supportedGenerationMethods || [];
    if (!methods.includes('generateContent')) return send(res, 502, { ok: false, error: `Model "${MODEL}" does not support generateContent.` });
    send(res, 200, { ok: true, model: r.body.name, displayName: r.body.displayName || MODEL, methods });
  } catch {
    send(res, 502, { ok: false, error: 'Could not reach Google. Check your internet connection.' });
  }
}

async function handleGenerate(req, res) {
  let body;
  try { body = await readJson(req); } catch (e) { return send(res, e.code || 400, { error: e.error || 'Invalid request.' }); }
  const { mode, notes } = body || {};
  if (!rateOk(clientIp(req))) return send(res, 429, { error: 'Too many requests. Please wait a minute and try again.' });
  if (!PROMPTS[mode]) return send(res, 400, { error: 'Unknown mode.' });
  if (typeof notes !== 'string') return send(res, 400, { error: 'Notes must be text.' });
  const text = notes.trim();
  if (text.length < MIN_CHARS) return send(res, 400, { error: `Please enter at least ${MIN_CHARS} characters of notes.` });
  if (text.length > MAX_CHARS) return send(res, 400, { error: `Notes are too long. Limit is ${MAX_CHARS} characters.` });
  if (!keyConfigured()) return send(res, 503, { error: 'Server has no API key. Open Settings for setup steps.' });
  if (!dailyOk()) return send(res, 429, { error: 'Daily usage limit reached. Please come back tomorrow.' });
  try {
    const r = await google(`/models/${encodeURIComponent(MODEL)}:generateContent`, {
      method: 'POST',
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: PROMPTS[mode](text) }] }], generationConfig: { temperature: 0.4, maxOutputTokens: 4096 } }),
    });
    if (!r.ok) { const [code, error] = friendlyError(r.status, r.body); return send(res, code, { error }); }
    const parts = (r.body.candidates && r.body.candidates[0] && r.body.candidates[0].content && r.body.candidates[0].content.parts) || [];
    const output = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('').trim();
    if (!output) return send(res, 502, { error: 'The model returned no text (it may have been blocked). Try different notes.' });
    if (mode === 'quiz') {
      try { return send(res, 200, { mode, quiz: parseQuiz(output), model: MODEL }); }
      catch { return send(res, 502, { error: 'The model did not return a valid quiz. Please try again.' }); }
    }
    send(res, 200, { mode, text: output, model: MODEL });
  } catch {
    send(res, 502, { error: 'Could not reach the AI service. Check your connection and try again.' });
  }
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  const url = req.url.split('?')[0];
  try {
    if (req.method === 'GET' && (url === '/' || url === '/index.html')) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(HTML); }
    if (req.method === 'GET' && url === '/api/health') return send(res, 200, { ok: true, service: 'StudySaathi AI', time: new Date().toISOString() });
    if (req.method === 'GET' && url === '/api/status') return send(res, 200, { keyConfigured: keyConfigured(), keyDisplay: keyConfigured() ? 'Configured on server (hidden)' : 'Not configured', model: MODEL });
    if (req.method === 'POST' && url === '/api/test') return await handleTest(req, res);
    if (req.method === 'POST' && url === '/api/generate') return await handleGenerate(req, res);
    send(res, 404, { error: 'Not found.' });
  } catch {
    if (!res.headersSent) send(res, 500, { error: 'Unexpected server error.' });
  }
});

// The whole web page (HTML + CSS + JS) lives in this one string.
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>StudySaathi AI</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Sora:wght@600;700&display=swap" rel="stylesheet">
<style>
:root{--bg:#0a1024;--bg2:#0f1733;--card:#121b3a;--line:#25305a;--text:#e8ecfb;--muted:#9aa6cf;--violet:#8b5cf6;--blue:#3b82f6;--ok:#34d399;--bad:#f87171;--radius:16px}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;font-family:Inter,system-ui,sans-serif;color:var(--text);line-height:1.6;min-height:100vh;
 background:radial-gradient(900px 500px at 85% -10%,rgba(139,92,246,.25),transparent),radial-gradient(800px 500px at -10% 10%,rgba(59,130,246,.2),transparent),var(--bg)}
.top{display:flex;justify-content:space-between;align-items:center;padding:18px clamp(16px,4vw,40px)}
.brand{display:flex;gap:12px;align-items:center}
.brand strong{font-family:Sora,sans-serif;font-size:1.1rem;display:block;line-height:1.2}
.brand small{color:var(--muted)}
.logo{width:40px;height:40px;border-radius:12px;display:grid;place-items:center;font-family:Sora;font-weight:700;background:linear-gradient(135deg,var(--violet),var(--blue));box-shadow:0 6px 20px rgba(139,92,246,.4)}
.icon-btn{background:var(--card);border:1px solid var(--line);color:var(--text);width:40px;height:40px;border-radius:12px;cursor:pointer;display:grid;place-items:center;transition:.2s}
.icon-btn:hover{border-color:var(--violet);transform:rotate(30deg)}
#closeSettings:hover{transform:none}
.wrap{max-width:900px;margin:0 auto;padding:0 clamp(16px,4vw,24px) 60px}
.hero{text-align:center;padding:28px 0 24px;animation:rise .6s ease both}
.hero h1{font-family:Sora,sans-serif;font-size:clamp(2rem,6vw,3.2rem);line-height:1.15;margin:0 0 10px}
.hero h1 span{background:linear-gradient(90deg,var(--violet),var(--blue));-webkit-background-clip:text;background-clip:text;color:transparent}
.hero p{color:var(--muted);margin:0}
.card{background:linear-gradient(180deg,var(--card),var(--bg2));border:1px solid var(--line);border-radius:var(--radius);padding:20px;box-shadow:0 10px 40px rgba(0,0,0,.3)}
.row{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:10px}
label,h2{font-weight:600;margin:0;font-size:1rem}
.link-btn{background:none;border:1px solid var(--line);color:var(--muted);padding:6px 12px;border-radius:10px;cursor:pointer;font:inherit;font-size:.85rem;transition:.2s}
.link-btn:hover{color:var(--text);border-color:var(--violet)}
textarea{width:100%;min-height:200px;resize:vertical;background:#0b1230;color:var(--text);border:1px solid var(--line);border-radius:12px;padding:14px;font:inherit;transition:.2s}
textarea:focus{outline:none;border-color:var(--violet);box-shadow:0 0 0 3px rgba(139,92,246,.2)}
.count{text-align:right;color:var(--muted);font-size:.8rem;margin-top:6px}
.features{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin:20px 0}
.feature{background:var(--card);border:1px solid var(--line);color:var(--text);border-radius:var(--radius);padding:18px;text-align:left;cursor:pointer;font:inherit;display:flex;flex-direction:column;gap:4px;transition:.25s}
.feature:hover{transform:translateY(-3px);border-color:var(--violet);box-shadow:0 12px 30px rgba(139,92,246,.2)}
.feature.active{border-color:var(--blue);background:linear-gradient(135deg,rgba(139,92,246,.18),rgba(59,130,246,.14))}
.feature:disabled{opacity:.6;cursor:wait;transform:none}
.ficon{font-size:1.5rem}.feature small{color:var(--muted)}
.empty{text-align:center;color:var(--muted);padding:30px 10px}.empty span{font-size:2rem}
.loading{display:flex;flex-direction:column;align-items:center;gap:10px;padding:30px;color:var(--muted)}
.spinner{width:36px;height:36px;border:3px solid var(--line);border-top-color:var(--violet);border-radius:50%;animation:spin .8s linear infinite}
.error{background:rgba(248,113,113,.1);border:1px solid rgba(248,113,113,.4);color:#fecaca;padding:12px 14px;border-radius:12px}
.output{animation:rise .4s ease both}
.output h2,.output h3{font-family:Sora,sans-serif;margin:18px 0 6px;font-size:1.1rem}
.output h2:first-child,.output h3:first-child{margin-top:0}
.output p{margin:8px 0}.output ul{padding-left:22px}
.output code{background:#0b1230;padding:2px 6px;border-radius:6px}
.q{border:1px solid var(--line);border-radius:14px;padding:16px;margin-bottom:14px;background:#0d1535}
.q p{font-weight:600;margin:0 0 10px}
.opt{display:block;width:100%;text-align:left;background:#121b3a;color:var(--text);border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin:6px 0;cursor:pointer;font:inherit;transition:.2s}
.opt:hover:not(:disabled){border-color:var(--violet)}
.opt.right{border-color:var(--ok);background:rgba(52,211,153,.12)}
.opt.wrong{border-color:var(--bad);background:rgba(248,113,113,.12)}
.expl{color:var(--muted);margin-top:8px;font-size:.92rem}
.overlay{position:fixed;inset:0;background:rgba(3,6,18,.6);backdrop-filter:blur(2px);z-index:10;animation:fade .2s}
.drawer{position:fixed;top:0;right:0;height:100%;width:min(380px,100%);background:var(--bg2);border-left:1px solid var(--line);z-index:11;padding:20px;overflow-y:auto;transform:translateX(100%);transition:transform .3s ease;visibility:hidden}
.drawer.open{transform:none;visibility:visible}
.panel{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;margin-bottom:14px}
.panel h3{margin:0 0 10px;font-size:.95rem}
.kv{display:flex;justify-content:space-between;gap:10px;margin:6px 0;font-size:.9rem;word-break:break-word}.kv span{color:var(--muted)}.kv b{text-align:right;font-weight:500}
.primary{width:100%;margin-top:8px;border:0;color:#fff;padding:11px;border-radius:12px;cursor:pointer;font:inherit;font-weight:600;background:linear-gradient(135deg,var(--violet),var(--blue));transition:.2s}
.primary:hover{filter:brightness(1.1)}.primary:disabled{opacity:.6;cursor:wait}
.hint{color:var(--muted);font-size:.85rem;margin:8px 0 0}
.steps{padding-left:20px;margin:0;font-size:.9rem}.steps li{margin:6px 0}
code{font-family:ui-monospace,Consolas,monospace;font-size:.85em}
.ok{color:var(--ok)}.bad{color:var(--bad)}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
@keyframes fade{from{opacity:0}to{opacity:1}}
@media(max-width:700px){.features{grid-template-columns:1fr}.brand small{display:none}}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}

/* v2: hero CTA, decorative background, GSAP helpers */
.bg{position:fixed;inset:0;overflow:hidden;pointer-events:none;z-index:-1}
.blob{position:absolute;border-radius:50%;filter:blur(90px);opacity:.35}
.b1{width:420px;height:420px;background:var(--violet);top:-120px;right:-80px}
.b2{width:380px;height:380px;background:var(--blue);bottom:-140px;left:-100px}
.hero{padding:44px 0 34px}
.cta{display:inline-block;margin-top:22px;padding:13px 28px;border-radius:999px;color:#fff;text-decoration:none;font-weight:600;background:linear-gradient(135deg,var(--violet),var(--blue));box-shadow:0 10px 30px rgba(99,102,241,.45)}
.cta:focus-visible,.feature:focus-visible,.link-btn:focus-visible,.primary:focus-visible,.icon-btn:focus-visible,.opt:focus-visible{outline:2px solid #a5b4fc;outline-offset:3px}
.btns{display:flex;gap:8px}
.card{backdrop-filter:blur(10px)}
.js-anim .drawer{transition:none}
.js-anim .feature:hover,.js-anim .icon-btn:hover{transform:none}
.js-anim .feature,.js-anim .link-btn,.js-anim .primary,.js-anim .cta{transition:border-color .2s,box-shadow .25s}
html{scroll-padding-top:20px}

[hidden]{display:none!important}
.foot{text-align:center;color:var(--muted);font-size:.85rem;padding:0 16px 32px}.foot strong{color:var(--text)}
body{background-attachment:fixed}
</style>
</head>
<body>
<div class="bg" aria-hidden="true"><i class="blob b1"></i><i class="blob b2"></i></div>
<header class="top">
  <div class="brand"><span class="logo">S</span><div><strong>StudySaathi AI</strong><small>Your smarter study companion.</small></div></div>
  <button id="openSettings" class="icon-btn" aria-label="Open settings" title="Settings">
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5h0a1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>
  </button>
</header>

<main class="wrap">
  <section class="hero">
    <h1>Turn your notes <span>into knowledge.</span></h1>
    <p>Paste your notes and get clear explanations, quick summaries, and practice quizzes.</p>
    <a class="cta" href="#workspace" id="cta">Start studying &rarr;</a>
  </section>

  <section class="card input-card" id="workspace">
    <div class="row"><label for="notes">Your notes</label><span class="btns"><button id="sampleBtn" class="link-btn" type="button">Use sample notes</button><button id="clearBtn" class="link-btn" type="button">Clear</button></span></div>
    <textarea id="notes" placeholder="Paste a chapter, lecture notes, or any topic you want to understand…" maxlength="12000"></textarea>
    <div class="count"><span id="count">0</span> / 12000</div>
  </section>

  <section class="features" id="features">
    <button class="feature" data-mode="explain"><span class="ficon">💡</span><strong>Explain Notes</strong><small>Simple explanations with examples</small></button>
    <button class="feature" data-mode="summary"><span class="ficon">📝</span><strong>Quick Summary</strong><small>Key concepts and takeaways</small></button>
    <button class="feature" data-mode="quiz"><span class="ficon">🎯</span><strong>Practice Quiz</strong><small>5 multiple-choice questions</small></button>
  </section>

  <section class="card output-card" aria-live="polite">
    <div class="row"><h2 id="outTitle">Output</h2><button id="copyBtn" class="link-btn" type="button" hidden>Copy</button></div>
    <div id="empty" class="empty"><span>✨</span><p>Your results will appear here.<br>Add some notes and choose a study mode.</p></div>
    <div id="loading" class="loading" hidden><div class="spinner"></div><p>Thinking…</p></div>
    <div id="error" class="error" role="alert" hidden></div>
    <div id="output" class="output" hidden></div>
  </section>
</main>
<footer class="foot">Built by <strong>Team Hackers</strong> &middot; Vishisht Viraj, Kundan Kumar, Ayush Raj, Krish Chand, Nelakurthi Vikranth</footer>

<div id="overlay" class="overlay" hidden></div>
<aside id="drawer" class="drawer" aria-hidden="true" aria-label="Settings">
  <div class="row"><h2>Settings</h2><button id="closeSettings" class="icon-btn" aria-label="Close settings">✕</button></div>
  <div class="panel">
    <h3>API connection</h3>
    <p class="kv"><span>Status</span><b id="connStatus">Not tested</b></p>
    <p class="kv"><span>API key</span><b id="keyStatus">Checking…</b></p>
    <button id="testBtn" class="primary" type="button">Test Connection</button>
    <p id="testResult" class="hint"></p>
  </div>
  <div class="panel">
    <h3>Model</h3>
    <p class="kv"><span>Model ID</span><b id="modelId">…</b></p>
    <p class="kv"><span>Provider</span><b>Google Gemini API</b></p>
  </div>
  <div class="panel">
    <h3>Set up your key</h3>
    <ol class="steps">
      <li>Copy <code>.env.example</code> to <code>.env</code> in the project folder.</li>
      <li>Set <code>GEMINI_API_KEY=your key</code> in that file.</li>
      <li>Restart the server (<code>npm start</code>).</li>
    </ol>
    <p class="hint">The key stays on the server and is never sent to your browser.</p>
  </div>
</aside>
<script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/ScrollTrigger.min.js"></script>
<script>
// StudySaathi AI frontend. It only talks to our own backend (/api/...). No keys here.
const $ = (id) => document.getElementById(id);
const notes = $('notes');
const SAMPLE = \`Photosynthesis is the process by which green plants, algae, and some bacteria convert light energy into chemical energy stored in glucose. It takes place mainly in the chloroplasts of leaf cells, which contain the green pigment chlorophyll. In the light-dependent reactions, chlorophyll absorbs sunlight and splits water molecules, releasing oxygen and producing ATP and NADPH. In the Calvin cycle (light-independent reactions), the plant uses ATP and NADPH to fix carbon dioxide from the air into glucose. The overall equation is 6CO2 + 6H2O + light energy -> C6H12O6 + 6O2. Factors that affect the rate include light intensity, carbon dioxide concentration, and temperature.\`;
const TITLES = { explain: 'Explanation', summary: 'Quick Summary', quiz: 'Practice Quiz' };
let lastCopyText = '';

// GSAP is optional: if it fails to load or the user prefers reduced motion, the app works without animation.
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const anim = typeof gsap !== 'undefined' && !reduceMotion;
if (typeof gsap === 'undefined') console.warn('GSAP did not load; animations are disabled.');
if (anim) document.documentElement.classList.add('js-anim');
let loadTween = null;

function show(which) {
  ['empty', 'loading', 'error', 'output'].forEach((id) => { $(id).hidden = id !== which; });
  $('copyBtn').hidden = which !== 'output';
  if (anim) {
    if (which === 'loading') loadTween = gsap.to('.spinner', { scale: 1.25, duration: 0.6, yoyo: true, repeat: -1, ease: 'sine.inOut' });
    else if (loadTween) { loadTween.kill(); gsap.set('.spinner', { clearProps: 'transform' }); loadTween = null; }
  }
}
function revealOutput() {
  if (anim) gsap.from('#output > *', { y: 14, opacity: 0, duration: 0.45, stagger: 0.07, ease: 'power2.out', clearProps: 'all' });
}
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const inline = (s) => esc(s).replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>').replace(/\`(.+?)\`/g, '<code>$1</code>').replace(/(^|\\W)\\*(?!\\s)(.+?)\\*(?=\\W|$)/g, '$1<em>$2</em>');

// Tiny, safe markdown renderer (escapes everything first).
function renderMarkdown(md) {
  const out = []; let inList = false;
  const close = () => { if (inList) { out.push('</ul>'); inList = false; } };
  md.split('\\n').forEach((line) => {
    const t = line.trim();
    let m;
    if (!t) { close(); return; }
    if ((m = t.match(/^#{1,6}\\s+(.*)/))) { close(); out.push(\`<h2>\${inline(m[1])}</h2>\`); }
    else if ((m = t.match(/^[-*•]\\s+(.*)/)) || (m = t.match(/^\\d+[.)]\\s+(.*)/))) { if (!inList) { out.push('<ul>'); inList = true; } out.push(\`<li>\${inline(m[1])}</li>\`); }
    else { close(); out.push(\`<p>\${inline(t)}</p>\`); }
  });
  close();
  return out.join('');
}

function renderQuiz(quiz) {
  const box = $('output'); box.innerHTML = '';
  const letters = ['A', 'B', 'C', 'D'];
  quiz.forEach((q, i) => {
    const div = document.createElement('div'); div.className = 'q';
    const p = document.createElement('p'); p.textContent = \`\${i + 1}. \${q.question}\`; div.appendChild(p);
    const expl = document.createElement('div'); expl.className = 'expl'; expl.hidden = true;
    expl.textContent = \`Answer: \${letters[q.answerIndex]}. \${q.explanation}\`;
    q.options.forEach((o, j) => {
      const b = document.createElement('button'); b.className = 'opt'; b.type = 'button';
      b.textContent = \`\${letters[j]}. \${o}\`;
      b.onclick = () => {
        div.querySelectorAll('.opt').forEach((x, k) => { x.disabled = true; if (k === q.answerIndex) x.classList.add('right'); });
        if (j !== q.answerIndex) b.classList.add('wrong');
        expl.hidden = false;
      };
      div.appendChild(b);
    });
    div.appendChild(expl); box.appendChild(div);
  });
  lastCopyText = quiz.map((q, i) => \`\${i + 1}. \${q.question}\\n\` + q.options.map((o, j) => \`   \${letters[j]}. \${o}\`).join('\\n') + \`\\n   Answer: \${letters[q.answerIndex]} - \${q.explanation}\`).join('\\n\\n');
}

async function run(mode) {
  const text = notes.value.trim();
  if (text.length < 50) { $('error').textContent = 'Please enter at least 50 characters of notes (or tap "Use sample notes").'; show('error'); return; }
  document.querySelectorAll('.feature').forEach((b) => { b.disabled = true; b.classList.toggle('active', b.dataset.mode === mode); });
  $('outTitle').textContent = TITLES[mode];
  show('loading');
  try {
    let r;
    try { r = await fetch('/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode, notes: text }) }); }
    catch { throw new Error('Cannot reach the StudySaathi server. Open the app at http://localhost:3000 (not by double-clicking the file or using Live Server) and make sure "npm start" is running.'); }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
    if (mode === 'quiz') renderQuiz(data.quiz);
    else { $('output').innerHTML = renderMarkdown(data.text); lastCopyText = data.text; }
    show('output'); revealOutput();
  } catch (e) {
    $('error').textContent = e.message || 'Something went wrong. Please try again.';
    show('error');
  } finally {
    document.querySelectorAll('.feature').forEach((b) => { b.disabled = false; });
  }
}

document.querySelectorAll('.feature').forEach((b) => b.addEventListener('click', () => run(b.dataset.mode)));
$('sampleBtn').onclick = () => { notes.value = SAMPLE; notes.dispatchEvent(new Event('input')); };
notes.addEventListener('input', () => { $('count').textContent = notes.value.length; });
$('copyBtn').onclick = async () => {
  try { await navigator.clipboard.writeText(lastCopyText); $('copyBtn').textContent = 'Copied!'; }
  catch { $('copyBtn').textContent = 'Copy failed'; }
  setTimeout(() => { $('copyBtn').textContent = 'Copy'; }, 1500);
};

// Settings drawer
const drawer = $('drawer'), overlay = $('overlay');
async function loadStatus() {
  try {
    const s = await (await fetch('/api/status')).json();
    $('keyStatus').textContent = s.keyDisplay; $('keyStatus').className = s.keyConfigured ? 'ok' : 'bad';
    $('modelId').textContent = s.model;
  } catch { $('keyStatus').textContent = 'Server unreachable'; $('keyStatus').className = 'bad'; }
}
function openDrawer() {
  if (anim) gsap.killTweensOf([drawer, overlay]);
  drawer.classList.add('open'); drawer.setAttribute('aria-hidden', 'false'); overlay.hidden = false; loadStatus(); $('closeSettings').focus();
  if (anim) { gsap.fromTo(drawer, { xPercent: 100 }, { xPercent: 0, duration: 0.45, ease: 'power3.out' }); gsap.fromTo(overlay, { opacity: 0 }, { opacity: 1, duration: 0.3 }); }
}
function closeDrawer() {
  const done = () => { drawer.classList.remove('open'); drawer.setAttribute('aria-hidden', 'true'); overlay.hidden = true; if (anim) gsap.set(drawer, { clearProps: 'transform' }); };
  $('openSettings').focus();
  if (anim) { gsap.killTweensOf([drawer, overlay]); gsap.to(drawer, { xPercent: 100, duration: 0.35, ease: 'power3.in', onComplete: done }); gsap.to(overlay, { opacity: 0, duration: 0.3 }); }
  else done();
}
$('openSettings').onclick = openDrawer; $('closeSettings').onclick = closeDrawer; overlay.onclick = closeDrawer;
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && drawer.classList.contains('open')) closeDrawer(); });
$('testBtn').onclick = async () => {
  const btn = $('testBtn'); btn.disabled = true; btn.textContent = 'Testing…'; $('testResult').textContent = '';
  try {
    const r = await fetch('/api/test', { method: 'POST' }); const d = await r.json();
    $('connStatus').textContent = d.ok ? 'Connected' : 'Failed'; $('connStatus').className = d.ok ? 'ok' : 'bad';
    $('testResult').textContent = d.ok ? \`Model verified: \${d.displayName} supports generateContent.\` : d.error;
  } catch { $('connStatus').textContent = 'Failed'; $('connStatus').className = 'bad'; $('testResult').textContent = 'Cannot reach the StudySaathi server.'; }
  btn.disabled = false; btn.textContent = 'Test Connection';
};
$('clearBtn').onclick = () => { notes.value = ''; $('count').textContent = '0'; $('output').innerHTML = ''; lastCopyText = ''; $('outTitle').textContent = 'Output'; document.querySelectorAll('.feature').forEach((b) => b.classList.remove('active')); show('empty'); notes.focus(); };
$('cta').addEventListener('click', () => setTimeout(() => notes.focus({ preventScroll: true }), 400));

function initAnimations() {
  if (!anim) return;
  try {
    const hasST = typeof ScrollTrigger !== 'undefined';
    if (hasST) gsap.registerPlugin(ScrollTrigger); else console.warn('ScrollTrigger did not load; using plain entrances.');
    gsap.timeline({ defaults: { ease: 'power3.out' } })
      .from('.top', { y: -20, opacity: 0, duration: 0.6 })
      .from('.hero h1', { y: 40, opacity: 0, duration: 0.8 }, '-=0.3')
      .from('.hero p, .cta', { y: 20, opacity: 0, stagger: 0.12, duration: 0.6 }, '-=0.4');
    const reveal = (sel, trig, extra = {}) => gsap.from(sel, { y: 40, opacity: 0, duration: 0.8, ease: 'power3.out', ...extra,
      ...(hasST ? { scrollTrigger: { trigger: trig, start: 'top 88%', once: true } } : { delay: 0.6 }) });
    reveal('.input-card', '.input-card', { scale: 0.98 });
    reveal('.feature', '#features', { stagger: 0.12, duration: 0.7 });
    reveal('.output-card', '.output-card');
    gsap.to('.blob', { x: 40, y: -30, scale: 1.1, duration: 9, repeat: -1, yoyo: true, ease: 'sine.inOut', stagger: 2 });
    document.querySelectorAll('.feature, .cta, .primary, .link-btn').forEach((el) => {
      const big = el.classList.contains('feature');
      el.addEventListener('mouseenter', () => { if (!el.disabled) gsap.to(el, { y: big ? -4 : -2, scale: big ? 1 : 1.03, duration: 0.25, overwrite: 'auto' }); });
      el.addEventListener('mouseleave', () => gsap.to(el, { y: 0, scale: 1, duration: 0.25, overwrite: 'auto' }));
    });
  } catch (e) { console.warn('Animations skipped:', e.message); }
}
initAnimations();
show('empty');

</script>
</body>
</html>
`;

const { exec } = require('child_process');
const readline = require('readline');

server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE'
    ? `\nPort ${PORT} is already in use. Close the other terminal running this app, or start with a different port:\n  PowerShell:  $env:PORT=3001; node studysaathi.js`
    : `\nServer error: ${e.message}`);
  process.exit(1);
});

// If no key was found, ask for it in the terminal. It is kept in memory only (never written to disk).
function askKey() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log('\nNo GEMINI_API_KEY found.');
    rl.question('Paste your Google AI Studio API key and press Enter: ', (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

(async () => {
  if (!keyConfigured() && process.stdin.isTTY) {
    const k = await askKey();
    if (k) process.env.GEMINI_API_KEY = k;
  }
  server.listen(PORT, async () => {
    const url = `http://localhost:${PORT}`;
    console.log(`\nStudySaathi AI running at ${url}`);
    console.log(`Model: ${MODEL}`);
    if (!keyConfigured()) {
      console.log('API key: NOT SET. Restart and paste a key, or create a .env file with GEMINI_API_KEY=your_key');
    } else {
      try {
        const r = await google(`/models/${encodeURIComponent(MODEL)}`);
        if (r.ok && (r.body.supportedGenerationMethods || []).includes('generateContent')) console.log('Check: Gemma connection OK - ready to use!');
        else console.log('Check FAILED: ' + (r.ok ? 'model does not support generateContent' : friendlyError(r.status, r.body)[1]));
      } catch { console.log('Check FAILED: could not reach Google (internet problem?)'); }
    }
    console.log('Press Ctrl+C to stop.\n');
    if (!process.env.NO_OPEN && Number.isInteger(Number(PORT))) {
      const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
      exec(cmd, () => {});
    }
  });
})();
process.on('SIGTERM', () => server.close(() => process.exit(0)));
