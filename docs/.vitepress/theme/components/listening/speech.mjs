const PREFERENCE_KEY = 'listening.voice-preferences.v1';
const ENGLISH = /^en[-_]/i;
const ROLES = ['narrator', 'male', 'female'];

export function defaultVoicePreferences() {
  return {
    version: 1,
    narrator: { voiceURI: '', name: 'Microsoft WilliamMultilingual Online (Natural) - English (Australia)', lang: 'en-AU' },
    male: { voiceURI: '', name: 'Microsoft Liam Online (Natural) - English (Canada)', lang: 'en-CA' },
    female: { voiceURI: '', name: 'Microsoft Clara Online (Natural) - English (Canada)', lang: 'en-CA' }
  };
}

function validPreference(value) {
  return value && typeof value === 'object' && typeof value.voiceURI === 'string' && typeof value.name === 'string' && typeof value.lang === 'string'
    ? { voiceURI: value.voiceURI, name: value.name, lang: value.lang }
    : null;
}

export function loadVoicePreferences(storage = globalThis.localStorage) {
  const defaults = defaultVoicePreferences();
  try {
    const parsed = JSON.parse(storage?.getItem(PREFERENCE_KEY) || 'null');
    if (!parsed || parsed.version !== 1) return defaults;
    for (const role of ROLES) if (validPreference(parsed[role])) defaults[role] = validPreference(parsed[role]);
  } catch { return defaults; }
  return defaults;
}

export function saveVoicePreferences(preferences, storage = globalThis.localStorage) {
  const defaults = defaultVoicePreferences();
  try {
    const value = { version: 1 };
    for (const role of ROLES) value[role] = validPreference(preferences?.[role]) || defaults[role];
    storage?.setItem(PREFERENCE_KEY, JSON.stringify(value));
    return value;
  } catch { return defaults; }
}

export function resolveVoice(voices, preference) {
  const english = (voices || []).filter(voice => ENGLISH.test(voice.lang || ''));
  if (!english.length) return null;
  const preferred = validPreference(preference);
  if (preferred?.voiceURI) {
    const byUri = english.find(voice => voice.voiceURI === preferred.voiceURI);
    if (byUri) return byUri;
  }
  if (preferred?.name && preferred?.lang) {
    const byName = english.find(voice => voice.name === preferred.name && voice.lang === preferred.lang);
    if (byName) return byName;
  }
  if (preferred?.lang) {
    const byLanguage = english.find(voice => voice.lang.toLowerCase() === preferred.lang.toLowerCase());
    if (byLanguage) return byLanguage;
  }
  return english[0];
}

export class BrowserSpeechEngine {
  constructor(onChange, onVoicesChanged) {
    this.onChange = onChange || (() => {}); this.onVoicesChanged = onVoicesChanged || (() => {});
    this.version = 0; this.timer = null; this.pending = null; this.paused = false; this.active = false; this.remaining = 0; this.voiceMap = defaultVoicePreferences();
    this.handleVoicesChanged = () => this.onVoicesChanged(this.getVoices());
    window.speechSynthesis?.addEventListener?.('voiceschanged', this.handleVoicesChanged);
  }
  getVoices() { return window.speechSynthesis?.getVoices?.() || []; }
  getAvailableVoices() { return this.getVoices().filter(voice => ENGLISH.test(voice.lang || '')); }
  setRate(wpm) { this.rate = Math.max(0.5, Math.min(2, wpm / 170)); }
  setVoiceMap(voiceMap) { this.voiceMap = { ...defaultVoicePreferences(), ...(voiceMap || {}) }; }
  selectVoice(speaker) { return resolveVoice(this.getVoices(), this.voiceMap[speaker] || this.voiceMap.narrator); }
  speak(segment, done, failed, version) {
    const voice = this.selectVoice(segment.speaker);
    if (!voice) { failed('未找到英语语音，请安装英语语音包后重试。'); return; }
    let utterance;
    try { utterance = new SpeechSynthesisUtterance(segment.text); utterance.lang = voice.lang || 'en-US'; utterance.voice = voice; utterance.rate = this.rate || 1; } catch { failed('当前浏览器无法创建语音播放。'); return; }
    utterance.onend = () => { if (version === this.version) done(); };
    utterance.onerror = event => { if (version === this.version) failed('语音播放失败：' + (event.error || 'unknown')); };
    try { window.speechSynthesis.speak(utterance); } catch { failed('语音播放失败，请重试。'); }
  }
  play(session, { voiceMap, onDone, onError } = {}) {
    this.stop(); const version = this.version; this.setRate(session.settings.target_wpm); this.setVoiceMap(voiceMap);
    const segments = session.passage.turns.map(turn => ({ type: 'passage', speaker: turn.speaker, text: turn.text }));
    for (const question of session.questions) segments.push({ type: 'question', speaker: 'narrator', text: 'Question ' + question.id + '. ' + question.question });
    let index = 0;
    const next = () => {
      if (version !== this.version) return;
      this.pending = null;
      if (index >= segments.length) { this.active = false; this.onChange({ paused: false, progress: 100, label: '播放完成' }); onDone?.(); return; }
      const segment = segments[index]; this.active = true;
      this.onChange({ paused: false, progress: index / segments.length * 100, label: segment.type === 'passage' ? '正在朗读文章' : '正在朗读第 ' + session.questions[index - session.passage.turns.length].id + ' 题' });
      this.speak(segment, () => {
        if (version !== this.version) return;
        index++;
        if (index >= segments.length) return next();
        this.remaining = segment.type === 'question' ? 5000 : (segments[index].type === 'question' ? 2000 : 250);
        this.pending = next; this.onChange({ label: this.remaining === 2000 ? '文章间隔' : this.remaining === 250 ? '角色切换' : '作答间隔' });
        if (!this.paused) this.schedule();
      }, message => { if (version === this.version) { this.stop(); onError?.(message); } }, version);
    };
    index = 0;
    next();
  }
  schedule() { clearTimeout(this.timer); this.started = Date.now(); this.timer = setTimeout(() => { this.timer = null; this.pending?.(); }, this.remaining); }
  pause() {
    this.paused = true; try { window.speechSynthesis?.pause?.(); } catch {}
    if (this.timer) { clearTimeout(this.timer); this.timer = null; this.remaining = Math.max(0, this.remaining - (Date.now() - this.started)); }
    this.onChange({ paused: true });
  }
  resume() {
    this.paused = false; try { window.speechSynthesis?.resume?.(); } catch {}
    if (this.pending && !this.timer) this.schedule(); this.onChange({ paused: false });
  }
  stop() { this.version++; clearTimeout(this.timer); this.timer = null; this.pending = null; this.paused = false; this.active = false; try { window.speechSynthesis?.cancel?.(); } catch {} }
  preview(speaker, onError) {
    this.stop();
    const version = this.version;
    this.speak({ speaker, text: speaker === 'narrator' ? 'This is a narrator voice preview.' : 'This is a ' + speaker + ' voice preview.' }, () => {}, message => onError?.(message), version);
  }
  destroy() { this.stop(); window.speechSynthesis?.removeEventListener?.('voiceschanged', this.handleVoicesChanged); }
}

export { PREFERENCE_KEY };
