const express = require('express');
const { randomUUID } = require('node:crypto');
const PRESETS = {'CET-4':'Moderate vocabulary, short syntax, direct questions.', 'CET-6':'Natural academic English, longer syntax, moderate inference.', 'TEM-8':'Advanced vocabulary, dense information, subtle inference and distractors.'};
const TYPES = ['detail','inference','main_idea','speaker_attitude','purpose'];
function chatCompletionsUrl(value) {
  const url = new URL((value || 'https://api.deepseek.com/v1/chat/completions').trim());
  const pathname = url.pathname.replace(/\/+$/, '');
  if (pathname.endsWith('/chat/completions')) url.pathname = pathname;
  else if (pathname.endsWith('/v1')) url.pathname = pathname + '/chat/completions';
  else url.pathname = pathname + '/v1/chat/completions';
  return url;
}
function settingsOf(s) {
  if (!s || !Object.hasOwn(PRESETS,s.difficulty) || !Number.isInteger(s.question_count) || s.question_count<1 || s.question_count>4 || !Number.isInteger(s.target_wpm) || s.target_wpm<120 || s.target_wpm>220) throw Error('请选择有效难度、1–4 道题和 120–220 WPM。');
  if (s.topic !== undefined && (typeof s.topic !== 'string' || s.topic.length > 120)) throw Error('偏好主题最多 120 个字符。');
  return {difficulty:s.difficulty, question_count:s.question_count,target_wpm:s.target_wpm,topic:(s.topic || '').trim()};
}
function text(v,name,max=10000) { if(typeof v!=='string'||!v.trim()||v.length>max) throw Error('生成内容无效：'+name); return v.trim(); }
function validateQuestion(q,passage,id) {
  if(!q||!TYPES.includes(q.type)) throw Error('题型无效。');
  if(!Array.isArray(q.options)||q.options.length!==4) throw Error('每题必须有四个选项。');
  const options=q.options.map(v=>text(v,'选项',600));
  if(new Set(options.map(v=>v.toLowerCase().replace(/[\W_]+/g,''))).size!==4) throw Error('选项重复。');
  if(!Number.isInteger(q.correct_answer)||q.correct_answer<0||q.correct_answer>3) throw Error('答案索引无效。');
  const evidence=text(q.evidence,'证据',3000);
  if(!passage.includes(evidence)) throw Error('证据必须是原文连续引用。');
  return {id,type:q.type,question:text(q.question,'题干',600),options,correct_answer:q.correct_answer,evidence,explanation:text(q.explanation,'解析',3000)};
}
class CompatibleGenerator {
  constructor(){this.key=process.env.LISTENING_API_KEY;this.url=chatCompletionsUrl(process.env.LISTENING_API_URL);this.model=process.env.LISTENING_MODEL||'deepseek-chat';}
  async complete(system,user){
    if(!this.key) throw Error('请在服务端配置 LISTENING_API_KEY 并重启。');
    const r=await fetch(this.url,{method:'POST',signal:AbortSignal.timeout(60000),headers:{'Content-Type':'application/json',Authorization:'Bearer '+this.key},body:JSON.stringify({model:this.model,messages:[{role:'system',content:system},{role:'user',content:user}],temperature:0.6,max_tokens:4000,response_format:{type:'json_object'}})});
    const body=await r.text();
    if(!r.ok){
      let detail='';
      try{const upstream=JSON.parse(body);detail=upstream.error?.message||upstream.message||upstream.detail||'';}catch{}
      if(!detail&&!body.trimStart().startsWith('<')) detail=body.trim().slice(0,300);
      throw Error('模型服务请求失败（'+r.status+'）'+(detail?'：'+detail:'。')+' 请求地址：'+this.url);
    }
    let data;
    try{data=JSON.parse(body);}catch{throw Error('模型服务返回了非 JSON 响应，请检查 LISTENING_API_URL。');}
    try{return JSON.parse(data.choices[0].message.content);}catch{throw Error('模型返回无效 JSON。');}
  }
}
async function generate(settings,provider){
  let passage;
  for(let attempt=0;attempt<2;attempt++){
    try{const r=await provider.complete('Generate a fresh coherent English listening passage. If topic_preference is non-empty, make it the central topic; otherwise choose a topic and genre at random. Return JSON {"text":"..."}.',JSON.stringify({difficulty:PRESETS[settings.difficulty],target_words:70+settings.question_count*50,topic_preference:settings.topic,genre:'Choose narrative, interview, report, conversation, or mini lecture.'}));passage=text(r.text,'文章');break;}
    catch(e){if(attempt===1) throw e;}
  }
  const questions=[];
  for(let id=1;id<=settings.question_count;id++){
    let feedback='';
    for(let attempt=0;attempt<3;attempt++){
      try{
        const raw=await provider.complete('Generate ONE English comprehension question strictly based on passage. JSON {type,question,options:[four strings],correct_answer:0..3,evidence,explanation}. Types: detail,inference,main_idea,speaker_attitude,purpose. Exactly one defensible answer. Evidence is an exact continuous quote. Distinct plausible distractors of similar length; no wording clues, obscure trivia or common knowledge shortcuts. Vary question types. Explanation may be Chinese.',JSON.stringify({passage,difficulty:PRESETS[settings.difficulty],previous_questions:questions.map(q=>({question:q.question,type:q.type})),feedback}));
        const q=validateQuestion(raw,passage,id);
        if(questions.some(old=>old.question.toLowerCase()===q.question.toLowerCase())) throw Error('题干重复。');
        const verdict=await provider.complete('Independently audit the question based ONLY on passage: exactly one defensible answer, correct index, supporting evidence, plausible distinct distractors, no grammar/length clues, no trivia or common knowledge shortcuts. JSON {"valid":true/false,"reason":"..."}. Reject ambiguity.',JSON.stringify({passage,question:q}));
        if(verdict.valid!==true) throw Error(typeof verdict.reason==='string'?verdict.reason.slice(0,1000):'语义校验失败。');
        questions.push(q);break;
      }catch(e){feedback=e.message;if(attempt===2) throw Error('第 '+id+' 题生成或校验失败，请重试。');}
    }
  }
  return {id:randomUUID(),settings,passage:{text:passage},questions};
}
function publicSession(s){return {id:s.id,settings:s.settings,passage:s.passage,questions:s.questions.map(({id,question,options})=>({id,question,options}))};}
function score(s,answers){
  if(!answers||typeof answers!=='object'||Array.isArray(answers)||Object.keys(answers).length!==s.questions.length||s.questions.some(q=>!Number.isInteger(answers[q.id])||answers[q.id]<0||answers[q.id]>3)) throw Error('请为每题选择一个有效答案。');
  const results=s.questions.map(q=>({...q,selected_answer:answers[q.id],correct:answers[q.id]===q.correct_answer}));
  return {score:results.filter(q=>q.correct).length,total:results.length,results,passage:s.passage};
}
function createPracticeRouter({provider=new CompatibleGenerator(),ttl=3600000,capacity=100}={}){
  const router=express.Router(),sessions=new Map();let generating=0;
  function prune(){for(const [id,e] of sessions) if(e.expires<=Date.now()) sessions.delete(id);}
  router.use((req,res,next)=>{res.set('Cache-Control','no-store');prune();next();});
  router.post('/generate',async(req,res)=>{
    let settings;try{settings=settingsOf(req.body);}catch(e){return res.status(400).json({error:e.message});}
    if(generating>=2) return res.status(429).json({error:'生成任务较多，请稍后重试。'});
    generating++;
    try{const session=await generate(settings,provider);prune();while(sessions.size>=capacity)sessions.delete(sessions.keys().next().value);sessions.set(session.id,{session,expires:Date.now()+ttl,result:null});res.json(publicSession(session));}
    catch(e){res.status(502).json({error:e.name==='TimeoutError'?'模型请求超时，请重试。':e.message});}finally{generating--;}
  });
  router.get('/:id',(req,res)=>{const e=sessions.get(req.params.id);if(!e)return res.status(404).json({error:'练习已过期或服务已重启，请重新生成。'});res.json(publicSession(e.session));});
  router.post('/:id/submit',(req,res)=>{const e=sessions.get(req.params.id);if(!e)return res.status(404).json({error:'练习已过期或服务已重启，请重新生成。'});try{if(!e.result)e.result=score(e.session,req.body?.answers);res.json(e.result);}catch(err){res.status(400).json({error:err.message});}});
  return router;
}
module.exports={PRESETS,settingsOf,validateQuestion,generate,publicSession,score,createPracticeRouter,chatCompletionsUrl};
