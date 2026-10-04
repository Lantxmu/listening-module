<script setup>
import { computed, onMounted, onBeforeUnmount, reactive, ref } from 'vue'
import { BrowserSpeechEngine } from './speech.mjs'

const state = ref('SETUP')
const settings = reactive({ difficulty: 'CET-6', question_count: 3, target_wpm: 170, topic: '' })
const presets = { 'CET-4': { wpm: 140, description: '基础词汇 · 直接理解' }, 'CET-6': { wpm: 170, description: '自然表达 · 适度推断' }, 'TEM-8': { wpm: 200, description: '信息密集 · 深层理解' } }
const session = ref(null), result = ref(null), answers = reactive({})
const error = ref(''), submitting = ref(false), supported = ref(false)
const audio = reactive({ paused: false, progress: 0, label: '准备播放' })
let engine, controller
const generating = computed(() => state.value === 'GENERATING')
const reviewing = computed(() => ['SUBMITTED', 'REVIEW'].includes(state.value))
const complete = computed(() => session.value && session.value.questions.every(q => Number.isInteger(answers[q.id])))
const answered = computed(() => Object.keys(answers).length)
const letters = ['A', 'B', 'C', 'D']
onMounted(() => {
  supported.value = 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window
  if (supported.value) engine = new BrowserSpeechEngine(update => Object.assign(audio, update))
})
onBeforeUnmount(() => { engine?.stop(); controller?.abort() })
async function request(path, body, signal) {
  const response = await fetch('/api/practice' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal })
  let data
  try { data = await response.json() } catch { throw new Error('服务返回异常，请确认本地后端已启动。') }
  if (!response.ok) throw new Error(data.error || '请求失败，请重试。')
  return data
}
async function generate() {
  engine?.stop(); error.value = ''; state.value = 'GENERATING'
  session.value = null; result.value = null
  Object.keys(answers).forEach(key => delete answers[key])
  Object.assign(audio, { paused: false, progress: 0, label: '准备播放' })
  controller = new AbortController()
  try { session.value = await request('/generate', { ...settings }, controller.signal); state.value = 'READY' }
  catch (e) { if (e.name !== 'AbortError') error.value = e.message; state.value = 'SETUP' }
}
function cancelGeneration() { controller?.abort(); state.value = 'SETUP' }
function play() {
  if (!engine || !session.value) return
  error.value = ''
  const review = reviewing.value
  if (!review) state.value = 'PLAYING'
  engine.play(session.value, () => { if (!review) state.value = 'ANSWERING' }, message => { error.value = message; if (!review) state.value = 'ANSWERING' })
}
function togglePause() { audio.paused ? engine.resume() : engine.pause() }
async function submit() {
  if (!complete.value || submitting.value) return
  submitting.value = true; error.value = ''; engine?.stop()
  Object.assign(audio, { paused: false, progress: 0, label: '准备播放' })
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
        </fieldset>
        <p class="muted">浏览器语速为近似值。设置应用于下一轮练习。</p>
        <button class="primary" :disabled="generating || submitting || !supported" @click="generate">{{ generating ? '正在生成与校验…' : session ? '生成新练习' : '生成练习' }}</button>
        <button v-if="generating" class="secondary" @click="cancelGeneration">取消等待</button>
        <p class="muted">文章、题干和答案解析会在提交后开放。作答期间请依靠音频理解。</p>
        <a href="/vocabulary">继续练习词汇 →</a>
      </aside>

      <section class="practice" aria-label="听力练习">
        <p v-if="!supported" role="alert" class="notice">当前浏览器不支持语音合成，请使用支持 SpeechSynthesis 的浏览器。</p>
        <p v-if="error" role="alert" class="notice">{{ error }}</p>
        <div v-if="!session" class="panel empty" aria-live="polite">
          <span class="headphones" aria-hidden="true">♫</span>
          <h2>{{ generating ? '正在准备你的练习' : '给自己几分钟，专注聆听' }}</h2>
          <p>{{ generating ? '生成文章、设计题目，并逐题检查答案依据。可能需要几分钟。' : '选择难度、题数和语速，生成一段全新的英语材料。' }}</p>
        </div>

        <template v-else>
          <div class="panel player">
            <div class="player-title"><h2>{{ reviewing ? '练习已提交' : '听音作答' }}</h2><span>{{ session.settings.difficulty }} · {{ session.settings.target_wpm }} WPM · {{ session.questions.length }} 题</span></div>
            <p aria-live="polite">{{ audio.label }}{{ audio.paused ? ' · 已暂停' : '' }}</p>
            <progress :value="audio.progress" max="100" aria-label="音频段落进度"></progress>
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
            <div class="panel result" aria-live="polite"><span class="eyebrow">本轮成绩</span><h2>{{ result.score }} <small>/ {{ result.total }}</small></h2><p>正确率 {{ Math.round(result.score / result.total * 100) }}%</p><button v-if="state === 'SUBMITTED'" class="secondary" @click="state = 'REVIEW'">查看原文与解析</button></div>
            <template v-if="state === 'REVIEW'">
              <details class="panel transcript"><summary>查看完整原文</summary><p lang="en">{{ result.passage.text }}</p></details>
              <article v-for="q in result.results" :key="q.id" class="panel review">
                <h3>第 {{ q.id }} 题 · {{ q.correct ? '✓ 回答正确' : '回答错误' }}</h3>
                <p lang="en">{{ q.question }}</p>
                <p class="muted">你的答案：{{ letters[q.selected_answer] }} · 正确答案：{{ letters[q.correct_answer] }}</p>
                <ol type="A"><li v-for="(option, i) in q.options" :key="i" :class="{ correct: i === q.correct_answer }" lang="en">{{ option }}</li></ol>
                <blockquote lang="en">{{ q.evidence }}</blockquote><p>{{ q.explanation }}</p>
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
.listening{max-width:1160px;margin:0 auto;padding:48px 24px 72px;color:var(--vp-c-text-1)}.hero{margin-bottom:32px}.eyebrow{font-size:12px;letter-spacing:2px;color:var(--vp-c-brand-1);font-weight:700}.hero h1{font-size:36px;font-weight:700;line-height:1.3;margin:12px 0}.hero p,.muted{color:var(--vp-c-text-2);font-size:14px;line-height:1.7}.workspace{display:grid;grid-template-columns:280px minmax(0,1fr);gap:24px;align-items:start}.panel{border:1px solid var(--vp-c-divider);background:var(--vp-c-bg-soft);border-radius:18px;padding:24px;margin-bottom:18px}.setup{position:sticky;top:88px}.panel h2{font-size:18px;font-weight:700;margin:0 0 16px}.setup label{display:block;margin:20px 0 8px;font-size:14px}.setup label strong{float:right}.setup select{width:100%;padding:10px;border:1px solid var(--vp-c-divider);border-radius:8px;background:var(--vp-c-bg);font:inherit}.setup input[type=range]{width:100%;accent-color:var(--vp-c-brand-1)}fieldset{border:0;padding:0;margin:0;min-width:0}.range-label{display:flex;justify-content:space-between;font-size:12px;color:var(--vp-c-text-2)}button{padding:10px 18px;border-radius:10px;font-weight:600;cursor:pointer;line-height:1.6}.primary{background:var(--vp-c-brand-1);color:var(--vp-c-white)}.secondary{border:1px solid var(--vp-c-divider);background:var(--vp-c-bg)}button:disabled{opacity:.45;cursor:not-allowed}.setup button{width:100%;margin-top:12px}.setup a{display:inline-block;font-size:14px;color:var(--vp-c-brand-1);margin-top:16px}.empty{text-align:center;min-height:360px;display:flex;flex-direction:column;align-items:center;justify-content:center}.headphones{font-size:64px;color:var(--vp-c-brand-1);margin-bottom:24px}.empty p{max-width:400px;color:var(--vp-c-text-2)}.notice{padding:16px;background:var(--vp-c-danger-soft);border-radius:10px;margin-bottom:18px}.player-title{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}.player-title span{font-size:12px;color:var(--vp-c-text-2)}progress{width:100%;height:8px;accent-color:var(--vp-c-brand-1);margin:16px 0}.controls{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.question legend{font-weight:700;margin-bottom:14px}.option{display:flex;gap:12px;align-items:center;padding:14px;border:1px solid var(--vp-c-divider);border-radius:10px;margin:8px 0;background:var(--vp-c-bg);cursor:pointer}.option.selected{border-color:var(--vp-c-brand-1);background:var(--vp-c-brand-soft)}.option input{accent-color:var(--vp-c-brand-1)}.letter{font-weight:700;color:var(--vp-c-brand-1)}.submit{display:flex;align-items:center;justify-content:space-between}.result h2{font-size:56px;color:var(--vp-c-brand-1);margin:16px 0}.result small{font-size:24px;color:var(--vp-c-text-2)}.review h3{font-size:17px;font-weight:700}.review p,.transcript p{line-height:1.9;margin:16px 0;white-space:pre-wrap}.review ol{list-style:upper-alpha;padding-left:28px}.review li{padding:5px}.correct{color:var(--vp-c-brand-1);font-weight:650}.review blockquote{border-left:3px solid var(--vp-c-brand-1);padding:8px 16px;margin:16px 0;background:var(--vp-c-bg)}summary{cursor:pointer;font-weight:700}button:focus-visible,select:focus-visible,.option:focus-within{outline:2px solid var(--vp-c-brand-1);outline-offset:3px}@media(max-width:760px){.listening{padding:28px 16px}.workspace{grid-template-columns:1fr}.setup{position:static}.hero h1{font-size:28px}.panel{padding:18px}}
</style>
