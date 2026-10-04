<script setup>
import { computed, onMounted, onBeforeUnmount, reactive, ref } from 'vue'
import { BrowserSpeechEngine, defaultVoicePreferences, loadVoicePreferences, saveVoicePreferences } from './speech.mjs'

const state = ref('SETUP')
const settings = reactive({ difficulty: 'CET-6', question_count: 3, target_wpm: 170, topic: '', mode: 'monologue' })
const presets = { 'CET-4': { wpm: 140, description: '基础词汇 · 直接理解' }, 'CET-6': { wpm: 170, description: '自然表达 · 适度推断' }, 'TEM-8': { wpm: 200, description: '信息密集 · 深层理解' } }
const session = ref(null), result = ref(null), answers = reactive({})
const error = ref(''), submitting = ref(false), supported = ref(false)
const voices = ref([]), voicePreferences = reactive(loadVoicePreferences()), checkingVoices = ref(false)
const audio = reactive({ paused: false, progress: 0, currentMs: 0, durationMs: 0, label: '准备播放' })
const fileInput = ref(null), importing = ref(false)
const copyState = ref('复制原文')
const generation = reactive({ stage: 'passage', finishing: false, completedSteps: 0, totalSteps: 1, percent: 0, displayPercent: 0, targetPercent: 0, progressVelocity: 0, elapsedMs: 0, question: 0, totalQuestions: 0, attempt: 1 })
const generationStages = {
  passage: { title: '正在生成听力材料', detail: '根据你的难度、模式和主题组织内容' },
  passage_audit: { title: '正在审核听力材料', detail: '检查文章是否符合主题和难度要求' },
  question_generate: { title: '正在设计理解题', detail: '让题目紧扣刚刚生成的听力材料' },
  question_audit: { title: '正在校验题目质量', detail: '核对答案依据和选项区分度' },
  retry: { title: '正在重试当前步骤', detail: '上一次结果未通过校验，正在重新生成' },
  finalizing: { title: '正在整理练习', detail: '马上就可以开始听音作答' }
}
let engine, controller
let generationTimer
let generationStartedAt = 0
const generating = computed(() => state.value === 'GENERATING')
const reviewing = computed(() => ['SUBMITTED', 'REVIEW'].includes(state.value))
const complete = computed(() => session.value && session.value.questions.every(q => Number.isInteger(answers[q.id])))
const answered = computed(() => Object.keys(answers).length)
const letters = ['A', 'B', 'C', 'D']
function updateVoices(next = []) { voices.value = next.filter(voice => /^en[-_]/i.test(voice.lang || '')) }
function chooseVoice(role, voiceURI) {
  const voice = voices.value.find(item => item.voiceURI === voiceURI)
  if (voice) { voicePreferences[role] = { voiceURI: voice.voiceURI || '', name: voice.name || '', lang: voice.lang || 'en-US' }; saveVoicePreferences(voicePreferences) }
}
function selectedVoiceValue(role) {
  const preference = voicePreferences[role]
  return voices.value.find(voice => (preference.voiceURI && voice.voiceURI === preference.voiceURI) || (preference.name && voice.name === preference.name && voice.lang === preference.lang))?.voiceURI || ''
}
function resetVoicePreferences() { Object.assign(voicePreferences, defaultVoicePreferences()); saveVoicePreferences(voicePreferences) }
function previewVoice(role) { if (!engine) return; checkingVoices.value = true; engine.setVoiceMap(voicePreferences); engine.preview(role, message => { error.value = message }); setTimeout(() => { checkingVoices.value = false }, 500) }
onMounted(() => {
  supported.value = 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window
  if (supported.value) { engine = new BrowserSpeechEngine(update => Object.assign(audio, update), updateVoices); updateVoices(engine.getVoices()) }
})
onBeforeUnmount(() => { engine?.destroy(); controller?.abort(); stopGenerationFeedback() })
function stopGenerationFeedback() {
  if (generationTimer) { clearInterval(generationTimer); generationTimer = undefined }
}
function startGenerationFeedback() {
  stopGenerationFeedback()
  const totalSteps = settings.question_count + 1
  const segmentSeconds = 2.2 + settings.question_count * 0.45
  Object.assign(generation, { stage: 'passage', finishing: false, completedSteps: 0, totalSteps, percent: 0, displayPercent: 0, targetPercent: 0, progressVelocity: 100 / totalSteps / segmentSeconds / 10, elapsedMs: 0, question: 0, totalQuestions: settings.question_count, attempt: 1 })
  generationStartedAt = Date.now()
  generationTimer = setInterval(() => {
    generation.elapsedMs = Date.now() - generationStartedAt
    generation.displayPercent = Math.min(generation.targetPercent, generation.displayPercent + generation.progressVelocity * 0.05)
  }, 50)
}
function applyGenerationProgress(event) {
  if (!generationStages[event.stage]) return
  const actualPercent = event.totalSteps ? event.completedSteps / event.totalSteps * 100 : 0
  const nextPercent = event.totalSteps ? Math.min(100, (event.completedSteps + 1) / event.totalSteps * 100) : 0
  const gap = Math.min(3, Math.max(0.8, (nextPercent - actualPercent) * 0.16))
  const finalComplete = event.stage === 'finalizing' && event.status === 'complete'
  const targetPercent = finalComplete ? 100 : event.status === 'complete' ? actualPercent : Math.max(actualPercent, nextPercent - gap)
  Object.assign(generation, event, {
    percent: Math.round(actualPercent),
    targetPercent: Math.max(generation.targetPercent, targetPercent),
    finishing: event.stage === 'finalizing' && event.status === 'complete'
  })
  if (finalComplete) generation.displayPercent = 100
  else if (event.status === 'complete') generation.displayPercent = actualPercent
}
function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.round(milliseconds / 1000))
  if (seconds < 60) return seconds + ' 秒'
  return Math.floor(seconds / 60) + ' 分 ' + String(seconds % 60).padStart(2, '0') + ' 秒'
}
async function streamGenerate(body, signal) {
  const timeoutController = new AbortController()
  const requestSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal
  let timedOut = false
  let connectionTimeout = setTimeout(() => { timedOut = true; timeoutController.abort() }, 30000)
  let response
  try {
    response = await fetch('/api/practice/generate/stream', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify(body), signal: requestSignal })
  } catch (error) {
    if (timedOut) throw new Error('生成连接超时，请确认后端服务仍在运行。')
    throw error
  } finally { clearTimeout(connectionTimeout) }
  if (!response.ok) {
    let data
    try { data = await response.json() } catch { throw new Error('服务返回异常，请确认本地后端已启动。') }
    throw new Error(data.error || '请求失败，请重试。')
  }
  if (!response.body) throw new Error('浏览器不支持流式进度，请重试。')
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let buffer = '', generatedSession
  const readChunk = async () => {
    let readTimeout
    try {
      return await Promise.race([
        reader.read(),
        new Promise((_, reject) => { readTimeout = setTimeout(() => { timedOut = true; timeoutController.abort(); reject(new Error('生成连接超时，请确认后端服务仍在运行。')) }, 30000) })
      ])
    } finally { clearTimeout(readTimeout) }
  }
  const consume = block => {
    let eventName = 'message', data = ''
    block.split(/\r?\n/).forEach(line => {
      if (line.startsWith('event:')) eventName = line.slice(6).trim()
      else if (line.startsWith('data:')) data += line.slice(5).trim()
    })
    if (!data) return
    let event
    try { event = JSON.parse(data) } catch { throw new Error('生成进度格式异常，请重试。') }
    if (eventName === 'progress') applyGenerationProgress(event)
    if (eventName === 'complete') generatedSession = event.session
    if (eventName === 'error') throw new Error(event.error || '生成失败，请重试。')
  }
  try {
    while (true) {
      const { value, done } = await readChunk()
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done })
      const blocks = buffer.split(/\r?\n\r?\n/)
      buffer = blocks.pop() || ''
      blocks.forEach(consume)
      if (done) break
    }
  } catch (error) {
    if (timedOut) throw new Error('生成连接超时，请确认后端服务仍在运行。')
    throw error
  }
  if (buffer.trim()) consume(buffer)
  if (!generatedSession) throw new Error('生成连接中断，请重试。')
  return generatedSession
}
async function request(path, body, signal) {
  const response = await fetch('/api/practice' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal })
  let data
  try { data = await response.json() } catch { throw new Error('服务返回异常，请确认本地后端已启动。') }
  if (!response.ok) throw new Error(data.error || '请求失败，请重试。')
  return data
}
async function generate() {
  engine?.stop(); error.value = ''; state.value = 'GENERATING'; startGenerationFeedback()
  session.value = null; result.value = null
  Object.keys(answers).forEach(key => delete answers[key])
  Object.assign(audio, { paused: false, progress: 0, currentMs: 0, durationMs: 0, label: '准备播放' })
  controller = new AbortController()
  try {
    const generatedSession = await streamGenerate({ ...settings }, controller.signal)
    generation.stage = 'finalizing'
    generation.finishing = true
    generation.targetPercent = 100
    await new Promise(resolve => setTimeout(resolve, 420))
    stopGenerationFeedback()
    if (state.value !== 'GENERATING') return
    session.value = generatedSession
    state.value = 'READY'
  } catch (e) {
    stopGenerationFeedback()
    if (e.name !== 'AbortError') error.value = /fetch failed|failed to fetch|networkerror/i.test(e.message || '') ? '无法连接到生成服务，请确认后端 API 正在运行。' : e.message
    state.value = 'SETUP'
  }
}
function cancelGeneration() { controller?.abort(); stopGenerationFeedback(); state.value = 'SETUP' }
function play() {
  if (!engine || !session.value) return
  error.value = ''
  const review = reviewing.value
  if (!review) state.value = 'PLAYING'
  engine.play(session.value, { voiceMap: voicePreferences, onDone: () => { if (!review) state.value = 'ANSWERING' }, onError: message => { error.value = message; if (!review) state.value = 'ANSWERING' } })
}
function togglePause() { audio.paused ? engine.resume() : engine.pause() }
function formatAudioTime(milliseconds) {
  const seconds = Math.max(0, Math.round(milliseconds / 1000))
  return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0')
}
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob), link = document.createElement('a')
  link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 0)
}
async function copyTranscript() {
  if (!result.value?.passage) return
  const content = result.value.passage.turns.map(turn => turn.text).join('\n\n')
  try { await navigator.clipboard?.writeText(content) } catch { try { const textarea = document.createElement('textarea'); textarea.value = content; textarea.setAttribute('readonly', ''); textarea.style.position = 'fixed'; textarea.style.opacity = '0'; document.body.appendChild(textarea); textarea.select(); document.execCommand?.('copy'); textarea.remove() } catch {} }
  copyState.value = '已复制'
  setTimeout(() => { copyState.value = '复制原文' }, 1600)
}
function openImport() { fileInput.value?.click() }
function exportPracticeData() {
  if (!session.value) return
  const payload = { format: 'listening-practice', version: 1, exportedAt: new Date().toISOString(), settings: { ...settings }, session: session.value, result: result.value, answers: { ...answers } }
  downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' }), 'listening-' + session.value.id + '.listening.json')
}
function validateImportedData(payload) {
  if (!payload || payload.format !== 'listening-practice' || payload.version !== 1) throw Error('不是有效的听力练习文件。')
  const importedSession = payload.session
  if (!importedSession || importedSession.schema_version !== 2 || typeof importedSession.id !== 'string' || !Array.isArray(importedSession.questions) || !importedSession.passage?.turns?.length) throw Error('练习文件内容不完整。')
  if (payload.result && (!Array.isArray(payload.result.results) || !payload.result.passage)) throw Error('练习结果内容不完整。')
  return importedSession
}
async function importPracticeFile(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return
  importing.value = true; error.value = ''
  try {
    const payload = JSON.parse(await file.text()), importedSession = validateImportedData(payload)
    session.value = importedSession; result.value = payload.result || null
    Object.keys(answers).forEach(key => delete answers[key])
    for (const [id, answer] of Object.entries(payload.answers || {})) if (importedSession.questions.some(question => String(question.id) === id) && Number.isInteger(answer)) answers[id] = answer
    const importedSettings = payload.settings || importedSession.settings
    Object.assign(settings, { difficulty: importedSettings.difficulty, question_count: importedSettings.question_count, target_wpm: importedSettings.target_wpm, topic: importedSettings.topic || '', mode: importedSettings.mode || 'monologue' })
    Object.assign(audio, { paused: false, progress: 0, currentMs: 0, durationMs: 0, label: '准备播放' })
    state.value = result.value ? 'REVIEW' : 'READY'
  } catch (e) { error.value = e.message || '导入失败，请选择听力练习导出的 JSON 文件。' }
  finally { importing.value = false }
}
async function submit() {
  if (!complete.value || submitting.value) return
  submitting.value = true; error.value = ''; engine?.stop()
  Object.assign(audio, { paused: false, progress: 0, currentMs: 0, durationMs: 0, label: '准备播放' })
  if (state.value === 'PLAYING') state.value = 'ANSWERING'
  try { result.value = await request('/' + session.value.id + '/submit', { answers: { ...answers } }); state.value = 'SUBMITTED' }
  catch (e) { error.value = e.message }
  finally { submitting.value = false }
}
</script>

<template>
  <main class="listening">
    <header class="hero">
      <span class="eyebrow">LISTEN · UNDERSTAND · REVIEW</span>
      <h1>英语听力练习</h1>
      <p>听懂一段故事，再做出你的判断。</p>
    </header>
    <div class="workspace">
      <aside class="panel setup">
        <h2>练习设置</h2>
        <fieldset :disabled="generating || submitting">
          <label for="listening-level">难度</label>
          <select id="listening-level" v-model="settings.difficulty" @change="settings.target_wpm = presets[settings.difficulty].wpm">
            <option v-for="(_, key) in presets" :key="key">{{ key }}</option>
          </select>
          <p class="muted">{{ presets[settings.difficulty].description }}</p>
          <label for="listening-mode">材料模式</label>
          <select id="listening-mode" v-model="settings.mode">
            <option value="monologue">独白 · narrator</option>
            <option value="dialogue">对话 · male / female</option>
          </select>
          <p class="muted">对话按原始发言顺序播放和复盘。</p>
          <label for="listening-count">题目数量</label>
          <select id="listening-count" v-model.number="settings.question_count">
            <option v-for="n in 4" :key="n" :value="n">{{ n }} 道题</option>
          </select>
          <label for="listening-topic">偏好主题 <span class="muted">选填</span></label>
          <input id="listening-topic" v-model.trim="settings.topic" type="text" maxlength="120" placeholder="如：太空探索、城市生活">
          <p class="muted">留空则随机选择主题。</p>
          <label for="listening-speed">目标语速 <strong>{{ settings.target_wpm }} WPM</strong></label>
          <input id="listening-speed" v-model.number="settings.target_wpm" type="range" min="120" max="220" step="5">
          <div class="range-label"><span>120 · 从容</span><span>220 · 挑战</span></div>
          <details class="voice-check">
            <summary>校对音色</summary>
            <div class="voice-heading"><label>播放音色</label><button type="button" class="text-button" @click="resetVoicePreferences">恢复默认</button></div>
            <p v-if="!voices.length" class="muted">暂未发现英语音色，浏览器会在准备就绪后更新。</p>
            <div v-for="role in ['narrator', 'male', 'female']" :key="role" class="voice-row">
              <label :for="'voice-' + role">{{ role }}</label>
              <select :id="'voice-' + role" :value="selectedVoiceValue(role)" @change="chooseVoice(role, $event.target.value)">
                <option value="">自动选择英语音色</option>
                <option v-for="voice in voices" :key="voice.voiceURI || voice.name" :value="voice.voiceURI">{{ voice.name }} · {{ voice.lang }}</option>
              </select>
              <button type="button" class="icon-button" :aria-label="'试听 ' + role + ' 音色'" @click="previewVoice(role)">▶</button>
            </div>
            <p class="muted">播放固定短句，音色由设备提供，仅供主观确认。</p>
          </details>
        </fieldset>
        <p class="muted">浏览器语速为近似值。设置应用于下一轮练习。</p>
        <button class="primary" :disabled="generating || submitting || !supported" @click="generate">{{ generating ? '正在生成与校验…' : session ? '生成新练习' : '生成练习' }}</button>
        <button v-if="generating" class="secondary" @click="cancelGeneration">取消等待</button>
        <input ref="fileInput" class="data-file" type="file" accept="application/json,.json,.listening.json" aria-label="导入听力练习文件" @change="importPracticeFile">
        <button class="secondary" :disabled="generating || submitting || importing" @click="openImport">{{ importing ? '正在导入…' : '导入练习文件' }}</button>
        <p class="muted">文章、题干和答案解析会在提交后开放。作答期间请依靠音频理解。</p>
        <a href="/vocabulary">继续练习词汇 →</a>
      </aside>

      <section class="practice" aria-label="听力练习">
        <p v-if="!supported" role="alert" class="notice">当前浏览器不支持语音合成，请使用支持 SpeechSynthesis 的浏览器。</p>
        <p v-if="error" role="alert" class="notice">{{ error }}</p>
        <div v-if="!session" class="panel empty" :aria-busy="generating">
          <template v-if="generating">
            <div class="generation-icon" aria-hidden="true"><span></span><span></span><span></span></div>
            <div class="generation-heading"><h2>正在准备你的练习</h2><span class="generation-live">{{ generation.finishing ? '100% · 即将完成' : generation.completedSteps + ' / ' + generation.totalSteps + ' 个阶段' }}</span></div>
            <div class="generation-progress" :class="{ finishing: generation.finishing }" role="progressbar" aria-label="练习生成进度" :aria-valuenow="Math.round(generation.displayPercent)" aria-valuemin="0" aria-valuemax="100" :aria-valuetext="generation.finishing ? '即将完成' : generation.completedSteps + ' / ' + generation.totalSteps + ' 个阶段已完成'"><span :style="{ width: Math.max(4, generation.displayPercent) + '%' }"></span></div>
            <div class="generation-message" aria-live="polite"><strong>{{ generationStages[generation.stage].title }}</strong><span>{{ generationStages[generation.stage].detail }}</span></div>
            <div class="generation-meta"><span>已用时 {{ formatDuration(generation.elapsedMs) }}</span><span v-if="generation.question">第 {{ generation.question }} / {{ generation.totalQuestions }} 题 · 第 {{ generation.attempt }} 次尝试</span></div>
          </template>
          <template v-else>
            <span class="headphones" aria-hidden="true">♫</span>
            <h2>给自己几分钟，专注聆听</h2>
            <p>选择难度、题数和语速，生成一段全新的英语材料。</p>
          </template>
        </div>

        <template v-else>
          <div class="panel player">
            <div class="player-title"><h2>{{ reviewing ? '练习已提交' : '听音作答' }}</h2><span>{{ session.settings.difficulty }} · {{ session.settings.target_wpm }} WPM · {{ session.questions.length }} 题</span></div>
            <div class="player-status"><p aria-live="polite">{{ audio.label }}{{ audio.paused ? ' · 已暂停' : '' }}</p><span>{{ formatAudioTime(audio.currentMs) }} / {{ formatAudioTime(audio.durationMs) }}</span></div>
            <div class="audio-progress" role="progressbar" aria-label="音频播放进度" :aria-valuenow="Math.round(audio.progress)" aria-valuemin="0" aria-valuemax="100" :aria-valuetext="Math.round(audio.progress) + '%'"><span :style="{ width: audio.progress + '%' }"></span></div>
            <div class="audio-meta"><span>播放进度</span><strong>{{ Math.round(audio.progress) }}%</strong></div>
            <div class="controls">
              <button class="primary" :disabled="!supported || submitting" @click="play">{{ state === 'READY' ? '▶ 开始播放' : '↻ 从头重播' }}</button>
              <button v-if="state === 'PLAYING' || (reviewing && audio.progress < 100 && audio.label !== '准备播放')" class="secondary" @click="togglePause">{{ audio.paused ? '继续' : '暂停' }}</button>
              <span class="muted">先读文章，再读题干 · 每题留出 5 秒</span>
            </div>
          </div>

          <template v-if="!reviewing">
            <div v-for="q in session.questions" :key="q.id" class="panel question">
              <fieldset :disabled="submitting"><legend>第 {{ q.id }} 题</legend>
                <label v-for="(option, i) in q.options" :key="i" class="option" :class="{ selected: answers[q.id] === i }">
                  <input v-model="answers[q.id]" type="radio" :name="'listening-' + q.id" :value="i">
                  <span class="letter">{{ letters[i] }}</span><span lang="en">{{ option }}</span>
                </label>
              </fieldset>
            </div>
            <div class="submit"><span class="muted">已作答 {{ answered }} / {{ session.questions.length }}</span><button class="primary" :disabled="!complete || submitting" @click="submit">{{ submitting ? '正在评分…' : '提交答案' }}</button></div>
          </template>

          <template v-else>
            <div class="panel result" aria-live="polite"><span class="eyebrow">本轮成绩</span><h2>{{ result.score }} <small>/ {{ result.total }}</small></h2><p>正确率 {{ Math.round(result.score / result.total * 100) }}%</p><div class="result-actions"><button class="secondary" @click="exportPracticeData">保存本页数据</button><button v-if="state === 'SUBMITTED'" class="primary" @click="state = 'REVIEW'">查看原文与解析</button></div><p class="download-note">保存文件包含本轮题目、原文、答案和解析，之后可通过“导入练习文件”恢复。</p></div>
            <template v-if="state === 'REVIEW'">
              <details class="panel transcript"><summary>查看完整原文</summary><div class="transcript-toolbar"><button class="secondary" type="button" @click.stop="copyTranscript">{{ copyState }}</button><span class="muted" aria-live="polite">{{ copyState === '已复制' ? '原文已复制到剪贴板' : '' }}</span></div><div v-for="(turn, index) in result.passage.turns" :key="index" class="transcript-turn"><span class="speaker">{{ turn.speaker }}</span><p lang="en">{{ turn.text }}</p></div></details>
              <article v-for="q in result.results" :key="q.id" class="panel review">
                <h3>第 {{ q.id }} 题 · {{ q.correct ? '✓ 回答正确' : '回答错误' }}</h3>
                <p lang="en">{{ q.question }}</p>
                <p class="muted">你的答案：{{ letters[q.selected_answer] }} · 正确答案：{{ letters[q.correct_answer] }}</p>
                <ol type="A"><li v-for="(option, i) in q.options" :key="i" :class="{ correct: i === q.correct_answer }" lang="en">{{ option }}</li></ol>
                <blockquote lang="en"><p v-for="(evidence, index) in q.evidence" :key="index">{{ evidence.text }}</p></blockquote><p>{{ q.explanation }}</p>
              </article>
            </template>
          </template>
        </template>
      </section>
    </div>
  </main>
</template>

<style scoped>
.setup input[type=text]{width:100%;padding:10px;border:1px solid var(--vp-c-divider);border-radius:8px;background:var(--vp-c-bg);font:inherit}
.listening{max-width:1160px;margin:0 auto;padding:48px 24px 72px;color:var(--vp-c-text-1)}.hero{margin-bottom:32px}.eyebrow{font-size:12px;letter-spacing:2px;color:var(--vp-c-brand-1);font-weight:700}.hero h1{font-size:36px;font-weight:700;line-height:1.3;margin:12px 0}.hero p,.muted{color:var(--vp-c-text-2);font-size:14px;line-height:1.7}.workspace{display:grid;grid-template-columns:280px minmax(0,1fr);gap:24px;align-items:start}.panel{border:1px solid var(--vp-c-divider);background:var(--vp-c-bg-soft);border-radius:18px;padding:24px;margin-bottom:18px}.setup{position:sticky;top:88px}.panel h2{font-size:18px;font-weight:700;margin:0 0 16px}.setup label{display:block;margin:20px 0 8px;font-size:14px}.setup label strong{float:right}.setup select{width:100%;padding:10px;border:1px solid var(--vp-c-divider);border-radius:8px;background:var(--vp-c-bg);font:inherit}.setup input[type=range]{width:100%;accent-color:var(--vp-c-brand-1)}fieldset{border:0;padding:0;margin:0;min-width:0}.range-label{display:flex;justify-content:space-between;font-size:12px;color:var(--vp-c-text-2)}button{padding:10px 18px;border-radius:10px;font-weight:600;cursor:pointer;line-height:1.6}.primary{background:var(--vp-c-brand-1);color:var(--vp-c-white)}.secondary{border:1px solid var(--vp-c-divider);background:var(--vp-c-bg)}button:disabled{opacity:.45;cursor:not-allowed}.setup button{width:100%;margin-top:12px}.setup a{display:inline-block;font-size:14px;color:var(--vp-c-brand-1);margin-top:16px}.empty{text-align:center;min-height:360px;display:flex;flex-direction:column;align-items:center;justify-content:center}.headphones{font-size:64px;color:var(--vp-c-brand-1);margin-bottom:24px}.empty p{max-width:400px;color:var(--vp-c-text-2)}.generation-icon{height:52px;display:flex;align-items:flex-end;gap:7px;margin-bottom:24px}.generation-icon span{display:block;width:8px;height:22px;border-radius:6px;background:var(--vp-c-brand-1);animation:generation-bars 1.05s ease-in-out infinite}.generation-icon span:nth-child(2){height:36px;animation-delay:.16s}.generation-icon span:nth-child(3){height:28px;animation-delay:.32s}.generation-heading,.generation-progress,.generation-message{width:min(100%,440px)}.generation-heading{display:flex;align-items:baseline;justify-content:space-between;gap:16px}.generation-heading h2{margin-bottom:0}.generation-heading strong{font-variant-numeric:tabular-nums;color:var(--vp-c-brand-1)}.generation-progress{height:9px;margin:18px 0 14px;border-radius:999px;background:var(--vp-c-divider);overflow:hidden}.generation-progress span{display:block;height:100%;border-radius:inherit;background:var(--vp-c-brand-1);transition:width .7s ease;position:relative;overflow:hidden}.generation-progress span::after{content:'';position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(255,255,255,.55),transparent);animation:generation-shimmer 1.5s linear infinite}.generation-message{display:flex;justify-content:space-between;align-items:baseline;gap:20px;text-align:left;font-size:13px}.generation-message strong{color:var(--vp-c-text-1);white-space:nowrap}.generation-message span{color:var(--vp-c-text-2);text-align:right}.notice{padding:16px;background:var(--vp-c-danger-soft);border-radius:10px;margin-bottom:18px}.player-title{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}.player-title span{font-size:12px;color:var(--vp-c-text-2)}progress{width:100%;height:8px;accent-color:var(--vp-c-brand-1);margin:16px 0}.controls{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.question legend{font-weight:700;margin-bottom:14px}.option{display:flex;gap:12px;align-items:center;padding:14px;border:1px solid var(--vp-c-divider);border-radius:10px;margin:8px 0;background:var(--vp-c-bg);cursor:pointer}.option.selected{border-color:var(--vp-c-brand-1);background:var(--vp-c-brand-soft)}.option input{accent-color:var(--vp-c-brand-1)}.letter{font-weight:700;color:var(--vp-c-brand-1)}.submit{display:flex;align-items:center;justify-content:space-between}.result h2{font-size:56px;color:var(--vp-c-brand-1);margin:16px 0}.result small{font-size:24px;color:var(--vp-c-text-2)}.review h3{font-size:17px;font-weight:700}.review p,.transcript p{line-height:1.9;margin:16px 0;white-space:pre-wrap}.review ol{list-style:upper-alpha;padding-left:28px}.review li{padding:5px}.correct{color:var(--vp-c-brand-1);font-weight:650}.review blockquote{border-left:3px solid var(--vp-c-brand-1);padding:8px 16px;margin:16px 0;background:var(--vp-c-bg)}summary{cursor:pointer;font-weight:700}button:focus-visible,select:focus-visible,.option:focus-within{outline:2px solid var(--vp-c-brand-1);outline-offset:3px}@keyframes generation-bars{0%,100%{transform:scaleY(.55);opacity:.6}50%{transform:scaleY(1);opacity:1}}@keyframes generation-shimmer{from{transform:translateX(-100%)}to{transform:translateX(100%)}}@media(max-width:760px){.listening{padding:28px 16px}.workspace{grid-template-columns:1fr}.setup{position:static}.hero h1{font-size:28px}.panel{padding:18px}.generation-message{align-items:flex-start;flex-direction:column;gap:4px}.generation-message span{text-align:left}}
.voice-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}.voice-heading label{flex:0 0 auto;margin:0;white-space:nowrap}.text-button{width:auto!important;flex:0 0 auto;padding:0;border:0;background:transparent;color:var(--vp-c-brand-1);font-size:12px;line-height:1.4;white-space:nowrap}.voice-row{display:grid;grid-template-columns:58px minmax(0,1fr) 34px;gap:6px;align-items:center;margin:8px 0}.voice-row label{margin:0;font-size:12px;color:var(--vp-c-text-2)}.voice-row select{min-width:0;padding:7px;font-size:12px}.icon-button{padding:5px;border:1px solid var(--vp-c-divider);background:var(--vp-c-bg);font-size:12px}.voice-check{margin-top:14px;border-top:1px solid var(--vp-c-divider);padding-top:12px}.voice-check button{padding:6px 8px;margin:4px 4px 0 0;font-size:12px}.speaker{display:inline-block;min-width:68px;font-size:12px;font-weight:700;letter-spacing:.5px;color:var(--vp-c-brand-1);text-transform:uppercase}.transcript-turn{display:flex;gap:12px;align-items:flex-start}.transcript-turn p{flex:1;margin-top:0}
.generation-live{font-size:12px;color:var(--vp-c-text-2);font-variant-numeric:tabular-nums}.generation-progress span{transition:none}.generation-progress.finishing span{transition:none}.generation-progress.finishing span::after{animation:none;opacity:0}.generation-meta{width:min(100%,440px);display:flex;gap:12px;flex-wrap:wrap;margin-top:10px;color:var(--vp-c-text-2);font-size:12px;font-variant-numeric:tabular-nums}
.data-file{display:none}.player-status{display:flex;align-items:baseline;justify-content:space-between;gap:16px;margin-top:20px}.player-status p{margin:0;color:var(--vp-c-text-2);font-size:14px}.player-status span,.audio-meta{font-size:12px;color:var(--vp-c-text-2);font-variant-numeric:tabular-nums}.audio-progress{height:10px;margin:12px 0 8px;border-radius:999px;background:var(--vp-c-divider);overflow:hidden}.audio-progress span{display:block;height:100%;border-radius:inherit;background:var(--vp-c-brand-1);transition:width .18s linear}.audio-meta{display:flex;justify-content:space-between;margin-bottom:18px}.audio-meta strong{color:var(--vp-c-brand-1);font-weight:700}.result-actions{display:flex;gap:10px;flex-wrap:wrap}.result-actions button{margin:0}.transcript-toolbar{display:flex;align-items:center;gap:12px;margin:18px 0 8px}.transcript-toolbar button{margin:0}.download-note{font-size:12px!important;color:var(--vp-c-text-2);margin:12px 0 0!important}@media(max-width:760px){.player-status{align-items:flex-start;flex-direction:column;gap:4px}.result-actions button{flex:1 1 140px}.transcript-toolbar{align-items:flex-start;flex-direction:column;gap:6px}}
</style>
