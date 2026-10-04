const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const express = require('express');
const { settingsOf, validateTurns, validateQuestion, generate, publicSession, score, createPracticeRouter, chatCompletionsUrl } = require('./backend.cjs');

const settings = { difficulty: 'CET-6', question_count: 1, target_wpm: 170, topic: '', mode: 'monologue' };
const passageText = 'The research team moved the workshop to Friday because the laboratory was closed on Thursday. Maya used the extra time to revise the safety checklist and invite two visiting students. Although the delay was inconvenient, the final demonstration was clearer and better organized than the original plan. The team also compared the results with last year’s measurements, discussed several safety questions, and recorded practical advice for students who would repeat the experiment during the summer program. Before leaving, the members labeled every sample, backed up their notes, and agreed to meet again next month to evaluate the long term effects of the revised procedure.';
const passage = { text: passageText, turns: [{ speaker: 'narrator', text: passageText }] };
const question = { type: 'detail', question: 'Why was the workshop moved?', options: ['The laboratory was closed.', 'The teacher was travelling.', 'More students could attend.', 'The equipment had arrived.'], correct_answer: 0, evidence: [{ text: 'the laboratory was closed on Thursday', speaker: 'narrator', turn: 0 }], explanation: '实验室周四关闭，因此改到周五。' };
const dialogueTurns = [
  { speaker: 'male', text: 'I think the community garden plan is practical, but we need a clearer schedule for volunteers. The first draft should also explain how tools will be shared during busy afternoons.' },
  { speaker: 'female', text: 'I agree with the basic plan. I can contact the school and ask whether students want to help. Their teachers may suggest activities that connect the garden with ordinary science lessons.' },
  { speaker: 'male', text: 'That would solve our staffing problem. I will check the water system before the first meeting and make sure the storage area is secure for everyone.' },
  { speaker: 'female', text: 'Then I will prepare a short budget and explain how the garden could support science classes. I will also include a simple calendar so families can choose convenient days.' }
];

function provider({ questionValue = question, auditValid = true, onCall } = {}) {
  return { async complete(system, user) {
    onCall?.(system, user);
    if (system.startsWith('Generate a fresh')) return { turns: system.includes('only speakers male') ? dialogueTurns : passage.turns };
    if (system.startsWith('Audit whether')) return { valid: true, reason: '' };
    if (system.startsWith('Independently')) return { valid: auditValid, reason: auditValid ? '' : 'ambiguous' };
    return questionValue;
  } };
}

test('accepts provider URLs and normalizes the default mode', () => {
  assert.equal(chatCompletionsUrl('https://sub2api.example').toString(), 'https://sub2api.example/v1/chat/completions');
  assert.equal(chatCompletionsUrl('https://sub2api.example/v1').toString(), 'https://sub2api.example/v1/chat/completions');
  assert.equal(chatCompletionsUrl('https://sub2api.example/v1/chat/completions').toString(), 'https://sub2api.example/v1/chat/completions');
  assert.equal(settingsOf({ ...settings, mode: undefined }).mode, 'monologue');
  assert.throws(() => settingsOf({ ...settings, mode: 'stereo' }));
  assert.throws(() => settingsOf({ ...settings, extra: true }));
});

test('validates v2 turns, word ranges, roles and dialogue balance', () => {
  assert.deepEqual(validateTurns(passage.turns, 'monologue', settings), passage);
  assert.doesNotThrow(() => validateTurns([{ speaker: 'narrator', text: 'word '.repeat(201).trim() }], 'monologue', { ...settings, question_count: 3 }));
  assert.deepEqual(validateTurns(dialogueTurns, 'dialogue', settings), { text: dialogueTurns.map(turn => turn.text).join(' '), turns: dialogueTurns });
  assert.throws(() => validateTurns([{ speaker: 'male', text: passageText }], 'monologue', settings));
  assert.throws(() => validateTurns([{ speaker: 'narrator', text: passageText }], 'dialogue', settings));
  assert.throws(() => validateTurns([...dialogueTurns, { speaker: 'male', text: 'Man: repeated.' }], 'dialogue', settings));
  assert.throws(() => validateTurns([{ speaker: 'male', text: passageText }, { speaker: 'female', text: 'Short.' }, { speaker: 'male', text: 'Short.' }, { speaker: 'female', text: 'Short.' }], 'dialogue', settings));
});

test('validates evidence against the exact turn and rejects ambiguity', () => {
  const context = { settings, passage };
  assert.deepEqual(validateQuestion(question, context, 1).evidence, question.evidence);
  assert.throws(() => validateQuestion({ ...question, evidence: [{ ...question.evidence[0], text: 'the' }] }, context, 1));
  assert.throws(() => validateQuestion({ ...question, evidence: [{ ...question.evidence[0], turn: 1 }] }, context, 1));
  assert.throws(() => validateQuestion({ ...question, evidence: 'the laboratory was closed on Thursday' }, context, 1));
  assert.throws(() => validateQuestion({ ...question, extra: true }, context, 1));
});

test('generation uses turns and mode, audits topic, and retries failed questions', async () => {
  let passages = 0, questions = 0, audits = 0, seenTurns = false;
  const generatedQuestion = { ...question, evidence: question.evidence };
  const session = await generate({ ...settings, topic: 'laboratory planning' }, { async complete(system, user) {
    if (system.startsWith('Generate a fresh')) { passages++; return { turns: passage.turns }; }
    if (system.startsWith('Audit whether')) { audits++; return { valid: true, reason: '' }; }
    if (system.startsWith('Generate ONE')) { questions++; seenTurns ||= JSON.parse(user).passage.turns?.length === 1; return generatedQuestion; }
    return { valid: true, reason: '' };
  }});
  assert.equal(passages, 1); assert.equal(audits, 1); assert.equal(questions, 1); assert.equal(seenTurns, true);
  assert.equal(session.schema_version, 2); assert.deepEqual(session.passage.turns, passage.turns);
  assert.equal(publicSession(session).questions[0].correct_answer, undefined);
});

test('question retries are capped and passage is not regenerated', async () => {
  let passages = 0, attempts = 0;
  await assert.rejects(() => generate(settings, { async complete(system) {
    if (system.startsWith('Generate a fresh')) { passages++; return { turns: passage.turns }; }
    if (system.startsWith('Generate ONE')) { attempts++; return { ...question, options: [] }; }
    return { valid: true, reason: '' };
  }}));
  assert.equal(passages, 1); assert.equal(attempts, 3);
});

test('schema is strict and HTTP keeps solutions hidden until the locked submission', async () => {
  const schema = JSON.parse(fs.readFileSync(require('node:path').join(__dirname, 'practice-session.schema.json')));
  assert.equal(schema.properties.schema_version.const, 2); assert.equal(schema.additionalProperties, false);
  const app = express(); app.use(express.json()); app.use('/api/practice', createPracticeRouter({ provider: provider(), ttl: 200 }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port + '/api/practice';
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const response = await post('/generate', { ...settings, mode: undefined }); const session = await response.json();
    assert.equal(response.status, 200); assert.equal(session.schema_version, 2); assert.equal(session.questions[0].correct_answer, undefined); assert.equal(session.questions[0].evidence, undefined); assert.equal(session.passage.turns[0].speaker, 'narrator');
    const fresh = await (await fetch(base + '/' + session.id)).json(); assert.equal(fresh.questions[0].explanation, undefined);
    assert.equal((await post('/' + session.id + '/submit', { answers: { [session.questions[0].id]: 0 } })).status, 200);
    const result = await (await post('/' + session.id + '/submit', { answers: { [session.questions[0].id]: 3 } })).json();
    assert.equal(result.score, 1); assert.equal(result.results[0].evidence[0].speaker, 'narrator');
    await new Promise(resolve => setTimeout(resolve, 220)); assert.equal((await fetch(base + '/' + session.id)).status, 404);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('score validates answers and public data does not contain solutions', () => {
  const session = { schema_version: 2, id: 's', settings, passage, questions: [{ id: 1, ...question }] };
  assert.equal(score(session, { 1: 0 }).score, 1); assert.equal(score(session, { 1: 3 }).score, 0);
  for (const answers of [{}, { 1: 4 }, [], { 1: '0' }]) assert.throws(() => score(session, answers));
  const visible = JSON.stringify(publicSession(session));
  for (const key of ['correct_answer', 'evidence', 'explanation']) assert.equal(visible.includes(key), false);
});

test('speech maps ordered turns, falls back safely, and ignores stale callbacks', async () => {
  const { BrowserSpeechEngine, defaultVoicePreferences, loadVoicePreferences, resolveVoice } = await import('../../docs/.vitepress/theme/components/listening/speech.mjs');
  const oldWindow = global.window, oldUtterance = global.SpeechSynthesisUtterance;
  const voices = [{ voiceURI: 'a', name: 'English A', lang: 'en-US' }, { voiceURI: 'b', name: 'English B', lang: 'en-CA' }];
  const spoken = [], controls = { paused: 0, resumed: 0 };
  global.window = { speechSynthesis: { getVoices: () => voices, speak: utterance => spoken.push(utterance), cancel() {}, pause() { controls.paused++; }, resume() { controls.resumed++; }, addEventListener() {}, removeEventListener() {} } };
  global.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  try {
    const defaults = defaultVoicePreferences();
    assert.equal(defaults.narrator.name, 'Microsoft WilliamMultilingual Online (Natural) - English (Australia)');
    assert.equal(defaults.male.name, 'Microsoft Liam Online (Natural) - English (Canada)');
    assert.equal(defaults.female.name, 'Microsoft Clara Online (Natural) - English (Canada)');
    assert.equal(resolveVoice(voices, defaults.narrator).voiceURI, 'a');
    assert.equal(resolveVoice(voices, defaults.male).voiceURI, 'b');
    assert.equal(resolveVoice([], { voiceURI: 'missing', name: '', lang: 'en-US' }), null);
    assert.equal(loadVoicePreferences({ getItem: () => '{broken' }).version, 1);
    const engine = new BrowserSpeechEngine(() => {});
    const session = { settings: { target_wpm: 170 }, passage: { turns: [{ speaker: 'male', text: 'Male turn.' }, { speaker: 'female', text: 'Female turn.' }] }, questions: [{ id: 1, question: 'What happened?', options: ['one', 'two', 'three', 'four'] }] };
    engine.play(session, { voiceMap: { male: { voiceURI: 'b', name: 'English B', lang: 'en-CA' }, female: { voiceURI: 'missing', name: '', lang: 'en-US' }, narrator: { voiceURI: 'a', name: 'English A', lang: 'en-US' } } });
    assert.equal(spoken[0].text, 'Male turn.'); assert.equal(spoken[0].voice.voiceURI, 'b');
    spoken[0].onend(); clearTimeout(engine.timer); engine.timer = null; engine.pending();
    assert.equal(spoken[1].text, 'Female turn.'); assert.equal(spoken[1].voice.voiceURI, 'a');
    spoken[1].onend(); clearTimeout(engine.timer); engine.timer = null; engine.pending();
    assert.equal(spoken[2].text, 'Question 1. What happened?'); assert.equal(spoken.some(item => item.text === 'one'), false);
    const stale = spoken[2].onend; engine.stop(); stale(); assert.equal(engine.pending, null);
    engine.pause(); engine.resume(); assert.equal(controls.paused, 1); assert.equal(controls.resumed, 1); engine.destroy();
  } finally { global.window = oldWindow; global.SpeechSynthesisUtterance = oldUtterance; }
});
