// PaperToConcept - client-side question-PDF to worked-solutions-PDF pipeline.
// Everything runs in the browser; the only network calls are to Google's Gemini API
// with the user's own key.

import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.2.67/build/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.2.67/build/pdf.worker.min.mjs';

const $ = (id) => document.getElementById(id);
const LS_KEY = 'papertoconcept_run_v1';
const LS_APIKEY = 'papertoconcept_apikey';

const state = {
  fileName: null,
  pages: [],        // {n, kind: 'text'|'image', text?, image?}
  questions: [],    // {n, text, options[], answer?}
  solutions: {},    // n -> {topic, difficulty, concept, theory, steps[], answer, confidence, note?}
  flags: [],        // {n, kind, detail}
  verified: {},     // n -> true after second-pass check
  done: false,
};

// ---------- UI helpers ----------
function log(msg, cls) {
  const li = document.createElement('li');
  li.textContent = msg;
  if (cls) li.className = cls;
  $('log').appendChild(li);
  $('log').scrollTop = $('log').scrollHeight;
}
function setProgress(pct, text) {
  $('progressWrap').classList.remove('hidden');
  $('progressFill').style.width = pct + '%';
  if (text) $('progressText').textContent = text;
}
function saveRun() {
  try {
    const slim = { ...state, pages: [] }; // page images/texts are too big for localStorage
    localStorage.setItem(LS_KEY, JSON.stringify(slim));
  } catch (e) { /* quota - skip silently */ }
}
function loadRun() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
function clearRun() { localStorage.removeItem(LS_KEY); }

// ---------- Gemini ----------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function callGemini(parts, { maxRetries = 5, expectJson = true } = {}) {
  const key = $('apiKey').value.trim();
  const model = $('model').value;
  if (!key) throw new Error('Missing API key');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 8192 },
  };
  let attempt = 0;
  while (true) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body),
      });
    } catch (netErr) {
      attempt++;
      if (attempt > maxRetries) throw new Error('Network error: ' + netErr.message);
      const wait = 3000 * attempt;
      log(`Network hiccup, retrying in ${wait / 1000}s...`, 'warn');
      await sleep(wait);
      continue;
    }
    if (res.status === 429) {
      attempt++;
      if (attempt > maxRetries) throw new Error('Rate limit kept rejecting after retries. Free-tier daily quota may be exhausted - try Resume later.');
      const wait = Math.min(60000, 10000 * attempt);
      log(`Rate limited (429). Waiting ${wait / 1000}s before retry ${attempt}/${maxRetries}...`, 'warn');
      await sleep(wait);
      continue;
    }
    if (res.status >= 500) {
      attempt++;
      if (attempt > maxRetries) throw new Error('Gemini server error ' + res.status);
      await sleep(4000 * attempt);
      continue;
    }
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`Gemini error ${res.status}: ${t.slice(0, 300)}`);
    }
    const data = await res.json();
    const text = (data.candidates?.[0]?.content?.parts || [])
      .map(p => p.text || '').join('').trim();
    if (!text) throw new Error('Empty response from model');
    if (!expectJson) return text;
    return parseJsonLoose(text);
  }
}

function parseJsonLoose(text) {
  let t = text.replace(/```json|```/g, '').trim();
  const start = t.search(/[\[{]/);
  if (start > 0) t = t.slice(start);
  // try progressively: full, then trim to last closing bracket
  try { return JSON.parse(t); } catch (e) { /* fallthrough */ }
  const lastSq = t.lastIndexOf(']');
  const lastCu = t.lastIndexOf('}');
  const cut = Math.max(lastSq, lastCu);
  if (cut > 0) {
    const closer = t[cut];
    const openCount = [...t.slice(0, cut + 1)].filter(c => c === (closer === ']' ? '[' : '{')).length;
    const closeCount = [...t.slice(0, cut + 1)].filter(c => c === closer).length;
    let repaired = t.slice(0, cut + 1);
    for (let i = 0; i < openCount - closeCount; i++) repaired += closer;
    try { return JSON.parse(repaired); } catch (e) { /* fallthrough */ }
  }
  throw new Error('Model returned malformed JSON');
}

// ---------- PDF parsing ----------
async function readPdf(file) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    const text = tc.items.map(it => it.str).join(' ').replace(/\s+/g, ' ').trim();
    if (text.length >= 60) {
      pages.push({ n: i, kind: 'text', text });
    } else {
      const viewport = page.getViewport({ scale: 2 });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      let dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      if (dataUrl.length > 3_500_000) {
        const smaller = page.getViewport({ scale: 1.25 });
        canvas.width = smaller.width;
        canvas.height = smaller.height;
        await page.render({ canvasContext: canvas.getContext('2d'), viewport: smaller }).promise;
        dataUrl = canvas.toDataURL('image/jpeg', 0.8);
      }
      pages.push({ n: i, kind: 'image', image: dataUrl });
    }
  }
  return pages;
}

// ---------- Prompts ----------
const EXTRACT_PROMPT = `You are reading pages from an exam question paper.
Extract EVERY question on these pages as a JSON array. For each question return:
{"n": <question number as printed, integer>, "text": "<full question text, math in LaTeX with $...$>", "options": ["<option 1>", ...] or [], "answer": "<correct option/value ONLY if an answer key or marking is visibly printed, else null>"}
Rules:
- Preserve every question number exactly as printed. Do not invent questions.
- Use LaTeX ($...$) for all math. Keep units.
- If a diagram is essential and cannot be fully read, still extract the question and add "[diagram unclear]" in text.
- Return ONLY the JSON array, no prose.`;

const SOLVE_PROMPT = `You are an expert JEE/board exam tutor. Solve each question below.
Return a JSON array, one object per question, in the same order:
{"n": <question number>, "topic": "<short topic>", "difficulty": "E"|"M"|"H",
 "concept": "<one line: the key idea>",
 "theory": "<2-3 lines: formulas/facts needed, LaTeX in $...$>",
 "steps": ["<step 1>", "<step 2>", ...],
 "answer": "<final answer with the option number/letter if MCQ>",
 "confidence": "high"|"medium"|"low",
 "note": "<only if the question seems defective, ambiguous or depends on an unreadable diagram; else null>"}
Rules:
- Show real working in steps; no skipped algebra on multi-step problems.
- If you are not sure of the answer, give your best attempt but set confidence "low" - never fake certainty.
- Use LaTeX ($...$) for math inside all fields.
- Return ONLY the JSON array.

Questions:
`;

const VERIFY_PROMPT = `Check this worked solution for correctness. Recompute independently.
Question: %Q%
Proposed answer: %A%
Proposed steps: %S%
Return JSON only: {"correct": true|false, "fixedAnswer": "<corrected final answer or null>", "why": "<one line>"}`;

// ---------- Pipeline stages ----------
async function stageExtract(onProgress) {
  const qs = [];
  const textPages = state.pages.filter(p => p.kind === 'text');
  const imgPages = state.pages.filter(p => p.kind === 'image');

  // text pages: 3 pages per call
  for (let i = 0; i < textPages.length; i += 3) {
    const chunk = textPages.slice(i, i + 3);
    const payload = chunk.map(p => `--- page ${p.n} ---\n${p.text}`).join('\n');
    const res = await callGemini([{ text: EXTRACT_PROMPT + '\n\n' + payload }]);
    if (Array.isArray(res)) qs.push(...res);
    onProgress();
  }
  // image pages: 2 pages per call (vision)
  for (let i = 0; i < imgPages.length; i += 2) {
    const chunk = imgPages.slice(i, i + 2);
    const parts = [{ text: EXTRACT_PROMPT }];
    for (const p of chunk) {
      parts.push({ inline_data: { mime_type: 'image/jpeg', data: p.image.split(',')[1] } });
    }
    const res = await callGemini(parts);
    if (Array.isArray(res)) qs.push(...res);
    onProgress();
  }
  // de-dup by question number, keep first occurrence
  const seen = new Map();
  for (const q of qs) {
    if (q && q.n != null && !seen.has(Number(q.n))) seen.set(Number(q.n), q);
  }
  return [...seen.values()].sort((a, b) => Number(a.n) - Number(b.n));
}

async function stageSolve(onProgress) {
  const BATCH = 5;
  const todo = state.questions.filter(q => !state.solutions[q.n]);
  for (let i = 0; i < todo.length; i += BATCH) {
    const chunk = todo.slice(i, i + BATCH);
    const qtext = chunk.map(q => {
      let s = `Q${q.n}: ${q.text}`;
      if (q.options?.length) s += '\nOptions: ' + q.options.map((o, k) => `(${k + 1}) ${o}`).join('  ');
      return s;
    }).join('\n\n');
    const res = await callGemini([{ text: SOLVE_PROMPT + qtext }]);
    if (Array.isArray(res)) {
      for (const sol of res) {
        if (sol && sol.n != null) state.solutions[Number(sol.n)] = sol;
      }
    }
    onProgress(chunk.length);
    saveRun();
  }
}

async function stageVerify(onProgress) {
  const hasKey = $('hasAnswers').checked;
  const targets = [];
  for (const q of state.questions) {
    const sol = state.solutions[q.n];
    if (!sol) continue;
    const keyAns = (q.answer || '').toString().trim();
    if (hasKey && keyAns) {
      const a = normAns(sol.answer), k = normAns(keyAns);
      if (a && k && a !== k) {
        state.flags.push({ n: q.n, kind: 'mismatch', detail: `Model answer ${sol.answer} vs printed key ${keyAns}` });
        targets.push(q);
        continue;
      }
    }
    if ((sol.confidence || '').toLowerCase() === 'low') targets.push(q);
  }
  for (const q of targets) {
    if (state.verified[q.n]) { onProgress(); continue; }
    const sol = state.solutions[q.n];
    try {
      const prompt = VERIFY_PROMPT
        .replace('%Q%', q.text + (q.options?.length ? ' Options: ' + q.options.join(' | ') : ''))
        .replace('%A%', sol.answer)
        .replace('%S%', (sol.steps || []).join(' -> '));
      const res = await callGemini([{ text: prompt }]);
      state.verified[q.n] = true;
      if (res && res.correct === false) {
        state.flags.push({ n: q.n, kind: 'recheck-failed', detail: `Second-pass check disagrees${res.fixedAnswer ? '; suggests ' + res.fixedAnswer : ''}. ${res.why || ''}` });
        if (res.fixedAnswer) sol.note = (sol.note ? sol.note + ' ' : '') + `Recheck suggested: ${res.fixedAnswer}`;
      }
    } catch (e) {
      log(`Verify skipped for Q${q.n}: ${e.message}`, 'warn');
    }
    onProgress();
    saveRun();
  }
  // notes from the solver become flags too
  for (const q of state.questions) {
    const sol = state.solutions[q.n];
    if (sol?.note && !state.flags.some(f => f.n === q.n && f.kind === 'solver-note')) {
      state.flags.push({ n: q.n, kind: 'solver-note', detail: sol.note });
    }
  }
}

function normAns(s) {
  const m = String(s).match(/\(?([1-4A-Da-d])\)?/);
  return m ? m[1].toUpperCase().replace(/^([1-4])$/, '$1') : String(s).replace(/[^0-9a-zA-Z.+\-\/^]/g, '').toLowerCase();
}

// ---------- Rendering ----------
function esc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function buildDocHtml() {
  const title = $('paperTitle').value.trim() || state.fileName || 'Question paper';
  const diffName = { E: 'Easy', M: 'Medium', H: 'Hard' };
  let html = `<div class="sol-doc">
  <h1 class="doctitle">${esc(title)}</h1>
  <div class="docmeta">Generated by PaperToConcept - ${state.questions.length} questions.
  Difficulty: E = easy, M = medium, H = hard. Flagged items are listed at the end and marked in place.
  AI-generated solutions can be wrong; verify flagged items by hand.</div>`;

  for (const q of state.questions) {
    const sol = state.solutions[q.n];
    if (!sol) continue;
    const qflags = state.flags.filter(f => f.n === q.n);
    html += `<div class="sol-q">
      <h3>Q${q.n} - ${esc(sol.topic || 'General')} (${esc(sol.difficulty || '?')})</h3>
      <div class="qbody"><span class="qlabel">Question:</span> ${esc(q.text)}`;
    if (q.options?.length) {
      html += '<div class="qbody">' + q.options.map((o, k) => `(${k + 1}) ${esc(o)}`).join(' &nbsp; ') + '</div>';
    }
    html += `</div>
      <div class="solblock"><span class="lbl">Concept:</span> ${esc(sol.concept || '')}</div>
      <div class="solblock"><span class="lbl">Theory:</span> ${esc(sol.theory || '')}</div>
      <div class="solblock"><span class="lbl">Solution:</span>
        <ol class="steps">${(sol.steps || []).map(s => `<li>${esc(s)}</li>`).join('')}</ol>
      </div>
      <div class="answer">Answer: ${esc(sol.answer || '')}${sol.confidence && sol.confidence !== 'high' ? ` <small>(confidence: ${esc(sol.confidence)})</small>` : ''}</div>`;
    for (const f of qflags) {
      html += `<div class="qflag">FLAG (${esc(f.kind)}): ${esc(f.detail)}</div>`;
    }
    html += '</div>';
  }

  if (state.flags.length) {
    html += `<div class="sol-flags"><h2>Flag summary - check these by hand</h2><ul>`;
    for (const f of state.flags) {
      html += `<li><b>Q${f.n}</b> [${esc(f.kind)}]: ${esc(f.detail)}</li>`;
    }
    html += '</ul></div>';
  }
  html += '</div>';
  return html;
}

function renderMath(container) {
  if (window.renderMathInElement) {
    renderMathInElement(container, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '$', right: '$', display: false },
      ],
      throwOnError: false,
    });
  }
}

// ---------- Orchestration ----------
let running = false;

async function runPipeline(resume = false) {
  if (running) return;
  running = true;
  $('startBtn').disabled = true;
  $('resumeBtn').disabled = true;
  try {
    if (!resume) {
      state.questions = []; state.solutions = {}; state.flags = [];
      state.verified = {}; state.done = false;
    }

    if (!state.questions.length) {
      if (!state.pages.length) throw new Error('Choose a PDF first');
      log(`Extracting questions from ${state.pages.length} pages...`);
      let donePages = 0;
      const totalCalls = Math.ceil(state.pages.filter(p => p.kind === 'text').length / 3)
        + Math.ceil(state.pages.filter(p => p.kind === 'image').length / 2);
      state.questions = await stageExtract(() => {
        donePages++;
        setProgress(5 + 30 * donePages / Math.max(1, totalCalls), `Extracting... (${donePages}/${totalCalls} batches)`);
      });
      if (!state.questions.length) throw new Error('No questions could be extracted from this PDF');
      log(`Extracted ${state.questions.length} questions (Q${state.questions[0].n}-Q${state.questions[state.questions.length - 1].n}).`);
      saveRun();
    } else {
      log(`Resuming with ${state.questions.length} extracted questions.`);
    }

    log('Solving...');
    const totalQ = state.questions.length;
    let solvedCount = Object.keys(state.solutions).length;
    await stageSolve((n) => {
      solvedCount += n;
      setProgress(35 + 45 * solvedCount / totalQ, `Solved ${Math.min(solvedCount, totalQ)}/${totalQ}`);
    });
    log('All questions solved.');

    log('Verifying flagged and low-confidence answers...');
    await stageVerify(() => {});
    setProgress(92, 'Rendering...');

    const html = buildDocHtml();
    $('exportRoot').innerHTML = html;
    renderMath($('exportRoot'));
    $('preview').innerHTML = html;
    renderMath($('preview'));

    const chips = $('flagsSummary');
    chips.innerHTML = '';
    if (state.flags.length) {
      for (const f of state.flags) {
        const c = document.createElement('span');
        c.className = 'flagchip';
        c.textContent = `Q${f.n}: ${f.kind}`;
        chips.appendChild(c);
      }
      log(`${state.flags.length} item(s) flagged - see flag summary in the PDF.`, 'warn');
    } else {
      log('No flags raised.');
    }

    state.done = true;
    saveRun();
    setProgress(100, 'Done');
    $('result').classList.remove('hidden');
    log('Ready. Use Download solutions PDF.');
  } catch (e) {
    log('Stopped: ' + e.message, 'err');
    saveRun();
  } finally {
    running = false;
    $('startBtn').disabled = false;
    refreshResumeUI();
  }
}

function refreshResumeUI() {
  const saved = loadRun();
  const has = !!(saved && (saved.questions?.length || Object.keys(saved.solutions || {}).length));
  $('resumeBtn').classList.toggle('hidden', !has);
  $('clearBtn').classList.toggle('hidden', !has);
}

async function downloadPdf() {
  const title = ($('paperTitle').value.trim() || 'solutions').replace(/[^\w\- ]+/g, '').trim() || 'solutions';
  const opt = {
    margin: [10, 10, 14, 10],
    filename: title.replace(/\s+/g, '_') + '_solutions.pdf',
    image: { type: 'jpeg', quality: 0.95 },
    html2canvas: { scale: 2, useCORS: true },
    jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
    pagebreak: { mode: ['css', 'legacy'] },
  };
  await html2pdf().set(opt).from($('exportRoot')).save();
}

// ---------- Wiring ----------
window.addEventListener('DOMContentLoaded', () => {
  $('apiKey').value = localStorage.getItem(LS_APIKEY) || '';
  $('rememberKey').checked = !!localStorage.getItem(LS_APIKEY);
  $('rememberKey').addEventListener('change', () => {
    if ($('rememberKey').checked) {
      localStorage.setItem(LS_APIKEY, $('apiKey').value.trim());
    } else {
      localStorage.removeItem(LS_APIKEY);
    }
  });
  $('apiKey').addEventListener('change', () => {
    if ($('rememberKey').checked) localStorage.setItem(LS_APIKEY, $('apiKey').value.trim());
  });
  $('toggleKey').addEventListener('click', () => {
    $('apiKey').type = $('apiKey').type === 'password' ? 'text' : 'password';
  });

  const dz = $('dropzone');
  const fi = $('fileInput');
  $('pickFile').addEventListener('click', () => fi.click());
  fi.addEventListener('change', () => fi.files[0] && acceptFile(fi.files[0]));
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz.addEventListener('drop', (e) => {
    e.preventDefault(); dz.classList.remove('drag');
    const f = e.dataTransfer.files[0];
    if (f) acceptFile(f);
  });

  $('startBtn').addEventListener('click', () => runPipeline(false));
  $('resumeBtn').addEventListener('click', () => {
    const saved = loadRun();
    if (!saved) return;
    Object.assign(state, saved, { pages: state.pages });
    runPipeline(true);
  });
  $('clearBtn').addEventListener('click', () => { clearRun(); refreshResumeUI(); log('Saved run discarded.'); });
  $('downloadBtn').addEventListener('click', downloadPdf);
  $('previewBtn').addEventListener('click', () => $('preview').classList.toggle('hidden'));

  refreshResumeUI();
});

async function acceptFile(file) {
  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    log('That is not a PDF.', 'err');
    return;
  }
  $('fileInfo').classList.remove('hidden');
  $('fileInfo').textContent = `Reading ${file.name} (${(file.size / 1048576).toFixed(1)} MB)...`;
  try {
    state.pages = await readPdf(file);
    state.fileName = file.name.replace(/\.pdf$/i, '');
    state.questions = []; state.solutions = {}; state.flags = []; state.verified = {}; state.done = false;
    const imgCount = state.pages.filter(p => p.kind === 'image').length;
    $('fileInfo').textContent = `${file.name}: ${state.pages.length} pages (${imgCount} scanned/image, ${state.pages.length - imgCount} text). Ready.`;
    log(`Loaded ${state.pages.length} pages.`);
  } catch (e) {
    $('fileInfo').textContent = 'Could not read this PDF: ' + e.message;
    log('PDF read failed: ' + e.message, 'err');
  }
}
