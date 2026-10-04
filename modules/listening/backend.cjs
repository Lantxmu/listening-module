const express = require('express');
const { randomUUID } = require('node:crypto');

const PRESETS = {
  'CET-4': 'Moderate vocabulary, short syntax, direct questions.',
  'CET-6': 'Natural academic English, longer syntax, moderate inference.',
  'TEM-8': 'Advanced vocabulary, dense information, subtle inference and distractors.'
};
const TYPES = ['detail', 'inference', 'main_idea', 'speaker_attitude', 'purpose'];
const MODES = ['monologue', 'dialogue'];
const SPEAKERS = ['narrator', 'male', 'female'];
const WORD_PATTERN = /[A-Za-z]+(?:['-][A-Za-z]+)*/g;
function rejectUnknown(value, allowed, name) { if (!value || typeof value !== 'object' || Array.isArray(value)) return; const unknown = Object.keys(value).filter(key => !allowed.includes(key)); if (unknown.length) throw Error(name + '包含未知字段。'); }

function chatCompletionsUrl(value) {
  const url = new URL((value || 'https://api.deepseek.com/v1/chat/completions').trim());
  const pathname = url.pathname.replace(/\/+$/, '');
  if (pathname.endsWith('/chat/completions')) url.pathname = pathname;
  else if (pathname.endsWith('/v1')) url.pathname = pathname + '/chat/completions';
  else url.pathname = pathname + '/v1/chat/completions';
  return url;
}

function settingsOf(s = {}) {
  rejectUnknown(s, ['difficulty', 'question_count', 'target_wpm', 'topic', 'mode'], '设置');
  if (!s || !Object.hasOwn(PRESETS, s.difficulty) || !Number.isInteger(s.question_count) || s.question_count < 1 || s.question_count > 4 || !Number.isInteger(s.target_wpm) || s.target_wpm < 120 || s.target_wpm > 220) throw Error('请选择有效难度、1–4 道题和 120–220 WPM。');
  if (s.topic !== undefined && (typeof s.topic !== 'string' || s.topic.length > 120)) throw Error('偏好主题最多 120 个字符。');
  const mode = s.mode === undefined ? 'monologue' : s.mode;
  if (!MODES.includes(mode)) throw Error('练习模式无效。');
  return { difficulty: s.difficulty, question_count: s.question_count, target_wpm: s.target_wpm, topic: (s.topic || '').trim(), mode };
}

function text(value, name, max = 10000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw Error('生成内容无效：' + name);
  return value.trim();
}

function wordCount(value) { return (value.match(WORD_PATTERN) || []).length; }
function targetWordRange(settings) { const target = 70 + settings.question_count * 50; return { min: Math.ceil(target * 0.8), max: Math.floor(target * 1.25) }; }
function containsRolePrefix(value) { return /(?:^|\s)(?:man|woman|male|female)\s*:/i.test(value); }

function validateTurns(turns, mode, settings) {
  if (!Array.isArray(turns) || turns.length === 0) throw Error('文章必须包含台词段落。');
  if (mode === 'monologue' && (turns.length !== 1 || turns[0]?.speaker !== 'narrator')) throw Error('独白必须只有一个 narrator 段落。');
  if (mode === 'dialogue' && (turns.length < 4 || turns.length > 24)) throw Error('对话必须包含 4–24 个段落。');
  const normalized = turns.map((turn, index) => {
    rejectUnknown(turn, ['speaker', 'text'], '台词');
    if (!turn || !SPEAKERS.includes(turn.speaker)) throw Error('第 ' + (index + 1) + ' 段角色无效。');
    if (mode === 'dialogue' && turn.speaker === 'narrator') throw Error('对话不能包含 narrator。');
    const value = text(turn.text, '第 ' + (index + 1) + ' 段台词', mode === 'dialogue' ? 1000 : 10000);
    if (containsRolePrefix(value)) throw Error('台词正文不能包含角色前缀。');
    return { speaker: turn.speaker, text: value };
  });
  const passageText = normalized.map(turn => turn.text).join(' ');
  if (passageText.length > 10000) throw Error('文章长度超出限制。');
  const { min, max } = targetWordRange(settings);
  const words = wordCount(passageText);
  if (words < min || words > max) throw Error('文章词数不符合练习目标。');
  if (mode === 'dialogue') {
    const male = normalized.filter(turn => turn.speaker === 'male');
    const female = normalized.filter(turn => turn.speaker === 'female');
    if (male.length < 2 || female.length < 2) throw Error('对话必须让 male 和 female 各发言至少两次。');
    for (let i = 2; i < normalized.length; i++) if (normalized[i - 2].speaker === normalized[i - 1].speaker && normalized[i - 1].speaker === normalized[i].speaker) throw Error('同一角色不能连续发言三次。');
    if (wordCount(male.map(turn => turn.text).join(' ')) / words < 0.3 || wordCount(female.map(turn => turn.text).join(' ')) / words < 0.3) throw Error('对话双方各自必须占文章至少 30% 的词数。');
  }
  return { text: passageText, turns: normalized };
}

function countOccurrences(value, needle) {
  let count = 0, offset = 0;
  while (true) { const found = value.indexOf(needle, offset); if (found < 0) return count; count++; offset = found + 1; }
}

function validateQuestion(q, passage, id) {
  rejectUnknown(q, ['id', 'type', 'question', 'options', 'correct_answer', 'evidence', 'explanation'], '题目');
  if (!q || !TYPES.includes(q.type)) throw Error('题型无效。');
  if (!Array.isArray(q.options) || q.options.length !== 4) throw Error('每题必须有四个选项。');
  const options = q.options.map(value => text(value, '选项', 600));
  if (new Set(options.map(value => value.toLowerCase().replace(/[\W_]+/g, ''))).size !== 4) throw Error('选项重复。');
  if (!Number.isInteger(q.correct_answer) || q.correct_answer < 0 || q.correct_answer > 3) throw Error('答案索引无效。');
  const question = text(q.question, '题干', 600);
  if (passage.settings.mode === 'dialogue' && /\b(?:who|which speaker|speaker)\b/i.test(question) && !/\b(?:male|female)\b/i.test(question)) throw Error('涉及说话人的题干必须明确写出 male 或 female。');
  if (!Array.isArray(q.evidence) || q.evidence.length < 1) throw Error('证据必须是数组。');
  const evidenceKeys = new Set();
  const evidence = q.evidence.map(item => {
    rejectUnknown(item, ['text', 'speaker', 'turn'], '证据');
    if (!item || !Number.isInteger(item.turn) || item.turn < 0 || item.turn >= passage.passage.turns.length || !SPEAKERS.includes(item.speaker)) throw Error('证据定位无效。');
    const value = text(item.text, '证据', 3000), turn = passage.passage.turns[item.turn];
    const evidenceKey = item.turn + '\u0000' + value;
    if (evidenceKeys.has(evidenceKey)) throw Error('证据不能重复。');
    evidenceKeys.add(evidenceKey);
    if (turn.speaker !== item.speaker || countOccurrences(turn.text, value) !== 1) throw Error('证据必须唯一匹配指定 turn 的连续原文。');
    return { text: value, speaker: item.speaker, turn: item.turn };
  });
  return { id, type: q.type, question, options, correct_answer: q.correct_answer, evidence, explanation: text(q.explanation, '解析', 3000) };
}

function validateAuditResult(value) { rejectUnknown(value, ['valid', 'reason'], '审核结果'); if (!value || typeof value.valid !== 'boolean' || typeof value.reason !== 'string') throw Error('模型审核结果无效。'); return value; }

function parseModelContent(content) {
  if (content && typeof content === 'object' && !Array.isArray(content)) return content;
  if (Array.isArray(content)) content = content.map(part => typeof part === 'string' ? part : part?.type === 'text' ? part.text : '').join('');
  if (typeof content !== 'string') throw Error('模型返回无效 JSON。');
  const value = content.trim(), fenced = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  try { return JSON.parse(fenced ? fenced[1] : value); } catch { throw Error('模型返回无效 JSON。'); }
}

function validateSession(session) {
  rejectUnknown(session, ['schema_version', 'id', 'settings', 'passage', 'questions'], '会话');
  if (!session || session.schema_version !== 2 || typeof session.id !== 'string') throw Error('会话结构无效。');
  rejectUnknown(session.passage, ['text', 'turns'], '文章');
  const settings = settingsOf(session.settings), passage = validateTurns(session.passage?.turns, settings.mode, settings);
  if (session.passage.text !== passage.text) throw Error('文章全文必须由 turns 拼接生成。');
  if (!Array.isArray(session.questions) || session.questions.length !== settings.question_count) throw Error('题目数量无效。');
  for (let i = 0; i < session.questions.length; i++) validateQuestion(session.questions[i], { settings, passage: session.passage }, i + 1);
  return true;
}

class CompatibleGenerator {
  constructor() { this.key = process.env.LISTENING_API_KEY; this.url = chatCompletionsUrl(process.env.LISTENING_API_URL); this.model = process.env.LISTENING_MODEL || 'deepseek-chat'; }
  async complete(system, user, options = {}) {
    if (!this.key) throw Error('请在服务端配置 LISTENING_API_KEY 并重启。');
    const timeoutSignal = AbortSignal.timeout(60000);
    const signal = options.signal ? AbortSignal.any([timeoutSignal, options.signal]) : timeoutSignal;
    const r = await fetch(this.url, { method: 'POST', signal, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + this.key }, body: JSON.stringify({ model: this.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0.6, max_tokens: 4000, response_format: { type: 'json_object' } }) });
    const body = await r.text();
    if (!r.ok) {
      let detail = '';
      try { const upstream = JSON.parse(body); detail = upstream.error?.message || upstream.message || upstream.detail || ''; } catch {}
      if (!detail && !body.trimStart().startsWith('<')) detail = body.trim().slice(0, 300);
      throw Error('模型服务请求失败（' + r.status + '）' + (detail ? '：' + detail : '。') + ' 请求地址：' + this.url);
    }
    let data; try { data = JSON.parse(body); } catch { throw Error('模型服务返回了非 JSON 响应，请检查 LISTENING_API_URL。'); }
    return parseModelContent(data?.choices?.[0]?.message?.content);
  }
}

async function generate(settings, provider, options = {}) {
  const started = Date.now(), budget = options.budgetMs || 180000;
  const totalSteps = settings.question_count + 1;
  let completedSteps = 0;
  const notify = (event) => {
    if (typeof options.onProgress !== 'function') return;
    const elapsedMs = Date.now() - started;
    try { options.onProgress({ ...event, completedSteps, totalSteps, elapsedMs }); } catch {}
  };
  const ensureBudget = () => {
    if (options.signal?.aborted) { const error = Error('生成已取消。'); error.name = 'AbortError'; throw error; }
    if (Date.now() - started >= budget) throw Error('生成时间过长，请重试。');
  };
  let passage, passageFeedback = '';
  const passageAttempts = options.passageAttempts || 3;
  for (let attempt = 0; attempt < passageAttempts; attempt++) {
    try {
      ensureBudget();
      notify({ stage: 'passage', status: 'running', detail: '正在生成听力材料。', attempt: attempt + 1 });
      const modeInstruction = settings.mode === 'dialogue' ? 'Return 4-24 alternating dialogue turns using only speakers male and female. Each speaker must appear at least twice, no speaker may appear three times in a row, and each speaker must contribute at least 30% of the words.' : 'Return exactly one turn using speaker narrator.';
      const raw = await provider.complete('Generate a fresh coherent English listening passage. ' + modeInstruction + ' Do not put Man:, Woman:, Male:, or Female: prefixes in turn text. Return JSON {"turns":[{"speaker":"narrator|male|female","text":"..."}]}. If retry_feedback is present, fix that specific problem.', JSON.stringify({ mode: settings.mode, difficulty: PRESETS[settings.difficulty], target_words: 70 + settings.question_count * 50, topic_preference: settings.topic, genre: 'Choose narrative, interview, report, conversation, or mini lecture.', retry_feedback: passageFeedback }), { signal: options.signal });
      const generated = validateTurns(raw.turns, settings.mode, settings); passage = { text: generated.text, turns: generated.turns };
      if (settings.topic) { ensureBudget(); notify({ stage: 'passage_audit', status: 'running', detail: '正在审核文章主题和难度。', attempt: attempt + 1 }); const verdict = validateAuditResult(await provider.complete('Audit whether the passage clearly centers the requested topic, is coherent, and matches the requested difficulty. Return JSON {"valid":true/false,"reason":"..."}.', JSON.stringify({ mode: settings.mode, difficulty: PRESETS[settings.difficulty], topic: settings.topic, passage }), { signal: options.signal })); if (!verdict.valid) throw Error('文章主题或难度审核未通过：' + (verdict.reason.trim().slice(0, 1000) || '审核模型未提供原因。')); }
      completedSteps++;
      notify({ stage: 'passage', status: 'complete', detail: '听力材料已准备好。' });
      break;
    } catch (error) { if (error.name === 'AbortError') throw error; passageFeedback = String(error.message || error).slice(0, 1000); notify({ stage: 'retry', status: 'retrying', detail: '文章未通过校验，正在重试。', attempt: attempt + 1 }); if (attempt === passageAttempts - 1) throw error; }
  }
  const questions = [], questionPassage = { settings, passage };
  for (let id = 1; id <= settings.question_count; id++) {
    let feedback = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        ensureBudget();
        notify({ stage: 'question_generate', status: 'running', detail: '正在生成第 ' + id + ' / ' + settings.question_count + ' 道题。', question: id, totalQuestions: settings.question_count, attempt: attempt + 1 });
        const raw = await provider.complete('Generate ONE English comprehension question strictly based on the passage and its ordered turns. JSON {type,question,options:[four strings],correct_answer:0..3,evidence:[{"text":"exact quote","speaker":"narrator|male|female","turn":0}],explanation}. Types: detail,inference,main_idea,speaker_attitude,purpose. Exactly one defensible answer. Evidence must be one or more exact continuous quotes from the specified turns. If a question involves a speaker, explicitly write male or female. Distinct plausible distractors of similar length; no wording clues, obscure trivia or common knowledge shortcuts. Vary question types. Explanation may be Chinese. If feedback is present, fix that specific problem.', JSON.stringify({ mode: settings.mode, passage, difficulty: PRESETS[settings.difficulty], previous_questions: questions.map(q => ({ question: q.question, type: q.type })), feedback: feedback.slice(0, 1000) }), { signal: options.signal });
        const q = validateQuestion(raw, questionPassage, id); if (questions.some(old => old.question.toLowerCase() === q.question.toLowerCase())) throw Error('题干重复。');
        ensureBudget(); notify({ stage: 'question_audit', status: 'running', detail: '正在审核第 ' + id + ' / ' + settings.question_count + ' 道题。', question: id, totalQuestions: settings.question_count, attempt: attempt + 1 }); const verdict = validateAuditResult(await provider.complete('Independently audit the question based ONLY on the ordered passage turns: exactly one defensible answer, correct index, supporting evidence, plausible distinct distractors, no grammar/length clues, no trivia or common knowledge shortcuts. Reject ambiguity. Return JSON {"valid":true/false,"reason":"..."}.', JSON.stringify({ mode: settings.mode, passage, question: q }), { signal: options.signal })); if (verdict.valid !== true) throw Error(verdict.reason.slice(0, 1000) || '语义校验失败。');
        questions.push(q); completedSteps++; notify({ stage: 'question_audit', status: 'complete', detail: '第 ' + id + ' / ' + settings.question_count + ' 道题已校验。', question: id, totalQuestions: settings.question_count }); break;
      } catch (error) { if (error.name === 'AbortError') throw error; feedback = String(error.message || error).slice(0, 1000); notify({ stage: 'retry', status: 'retrying', detail: '第 ' + id + ' 题未通过校验，正在重试。', question: id, totalQuestions: settings.question_count, attempt: attempt + 1 }); if (attempt === 2) throw Error('第 ' + id + ' 题生成或校验失败，请重试。'); }
    }
  }
  notify({ stage: 'finalizing', status: 'running', detail: '正在整理练习。' });
  const session = { schema_version: 2, id: randomUUID(), settings, passage, questions }; validateSession(session); notify({ stage: 'finalizing', status: 'complete', detail: '练习已经准备好。' }); return session;
}

function publicSession(session) { return { schema_version: 2, id: session.id, settings: session.settings, passage: session.passage, questions: session.questions.map(({ id, question, options, type }) => ({ id, type, question, options })) }; }

function score(session, answers) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers) || Object.keys(answers).length !== session.questions.length || session.questions.some(q => !Number.isInteger(answers[q.id]) || answers[q.id] < 0 || answers[q.id] > 3)) throw Error('请为每题选择一个有效答案。');
  const results = session.questions.map(q => ({ ...q, selected_answer: answers[q.id], correct: answers[q.id] === q.correct_answer }));
  return { score: results.filter(q => q.correct).length, total: results.length, results, passage: session.passage };
}

function createPracticeRouter({ provider = new CompatibleGenerator(), ttl = 3600000, capacity = 100, generationBudgetMs = 180000 } = {}) {
  const router = express.Router(), sessions = new Map(); let generating = 0;
  function prune() { for (const [id, entry] of sessions) if (entry.expires <= Date.now()) sessions.delete(id); }
  function saveSession(session) { prune(); while (sessions.size >= capacity) sessions.delete(sessions.keys().next().value); sessions.set(session.id, { session, expires: Date.now() + ttl, result: null }); return publicSession(session); }
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); prune(); next(); });
  router.post('/generate/stream', async (req, res) => {
    let settings; try { settings = settingsOf(req.body); } catch (error) { return res.status(400).json({ error: error.message }); }
    if (generating >= 2) return res.status(429).json({ error: '生成任务较多，请稍后重试。' }); generating++;
    const abortController = new AbortController(); let closed = false;
    const send = (event) => { if (!closed && !res.writableEnded) res.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n'); };
    res.status(200).set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' }); res.flushHeaders?.();
    const heartbeat = setInterval(() => { if (!closed && !res.writableEnded) res.write(': keep-alive\n\n'); }, 15000);
    res.on('close', () => { closed = true; abortController.abort(); clearInterval(heartbeat); });
    try {
      const session = await generate(settings, provider, { budgetMs: generationBudgetMs, signal: abortController.signal, onProgress: event => send({ type: 'progress', ...event }) });
      if (!closed) { send({ type: 'complete', session: saveSession(session) }); res.end(); }
    } catch (error) {
      if (!closed) { send({ type: 'error', error: error.name === 'TimeoutError' ? '模型请求超时，请重试。' : error.message }); res.end(); }
    } finally { clearInterval(heartbeat); generating--; }
  });
  router.post('/generate', async (req, res) => {
    let settings; try { settings = settingsOf(req.body); } catch (error) { return res.status(400).json({ error: error.message }); }
    if (generating >= 2) return res.status(429).json({ error: '生成任务较多，请稍后重试。' }); generating++;
    try { const session = await generate(settings, provider, { budgetMs: generationBudgetMs }); res.json(saveSession(session)); }
    catch (error) { res.status(502).json({ error: error.name === 'TimeoutError' ? '模型请求超时，请重试。' : error.message }); }
    finally { generating--; }
  });
  router.get('/:id', (req, res) => { const entry = sessions.get(req.params.id); if (!entry) return res.status(404).json({ error: '练习已过期或服务已重启，请重新生成。' }); res.json(publicSession(entry.session)); });
  router.post('/:id/submit', (req, res) => { const entry = sessions.get(req.params.id); if (!entry) return res.status(404).json({ error: '练习已过期或服务已重启，请重新生成。' }); try { if (!entry.result) entry.result = score(entry.session, req.body?.answers); res.json(entry.result); } catch (error) { res.status(400).json({ error: error.message }); } });
  return router;
}

module.exports = { PRESETS, settingsOf, wordCount, targetWordRange, validateTurns, validateQuestion, validateAuditResult, validateSession, generate, publicSession, score, createPracticeRouter, chatCompletionsUrl, parseModelContent };
