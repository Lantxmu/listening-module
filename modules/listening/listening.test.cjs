const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const {settingsOf,validateQuestion,generate,publicSession,score,createPracticeRouter}=require('./backend.cjs');
const passage='Maya moved the workshop to Friday because the laboratory was closed on Thursday.';
const question={type:'detail',question:'Why was the workshop moved?',options:['The laboratory was closed.','The teacher was travelling.','More students could attend.','The equipment had arrived.'],correct_answer:0,evidence:'the laboratory was closed on Thursday',explanation:'实验室周四关闭，因此改到周五。'};
const settings={difficulty:'CET-6',question_count:1,target_wpm:170};
function provider(){return {async complete(system){if(system.startsWith('Generate a fresh'))return {text:passage};if(system.startsWith('Independently'))return {valid:true};return {...question};}};}
test('reject invalid settings and malformed or unsupported questions',()=>{
  for(const s of [{...settings,question_count:0},{...settings,question_count:5},{...settings,target_wpm:221},{...settings,difficulty:'__proto__'}])assert.throws(()=>settingsOf(s));
  for(const q of [{...question,options:['one']},{...question,options:['Same','same!','x','y']},{...question,correct_answer:4},{...question,correct_answer:'0'},{...question,evidence:'Invented quote'},{...question,question:''}])assert.throws(()=>validateQuestion(q,passage,1));
});
test('generation retries failed question without regenerating passage',async()=>{
  let passages=0,questions=0,audits=0;
  const p={async complete(system){if(system.startsWith('Generate a fresh')){passages++;return {text:passage};}if(system.startsWith('Independently')){audits++;return {valid:audits>1,reason:'ambiguous'};}questions++;return question;}};
  const session=await generate(settings,p);
  assert.equal(passages,1);assert.equal(questions,2);assert.equal(session.questions.length,1);
});
test('optional topic is normalized and passed to passage generation',async()=>{
  assert.equal(settingsOf({...settings}).topic,'');
  assert.equal(settingsOf({...settings,topic:'  Space exploration  '}).topic,'Space exploration');
  assert.throws(()=>settingsOf({...settings,topic:'x'.repeat(121)}));
  let promptContext;
  const p={async complete(system,user){if(system.startsWith('Generate a fresh')){assert.match(system,/topic_preference is non-empty/);promptContext=JSON.parse(user);return {text:passage};}if(system.startsWith('Independently'))return {valid:true};return question;}};
  await generate({...settings,topic:'Space exploration'},p);
  assert.equal(promptContext.topic_preference,'Space exploration');
});
test('invalid JSON recovery, retry limits and scoring',async()=>{
  let calls=0;
  const p=provider();const original=p.complete;
  p.complete=async system=>{if(calls++===0)throw Error('invalid JSON');return original(system);};
  const s=await generate(settings,p);
  const visible=JSON.stringify(publicSession(s));
  for(const key of ['correct_answer','evidence','explanation'])assert.equal(visible.includes(key),false);
  assert.equal(score(s,{'1':0}).score,1);assert.equal(score(s,{'1':3}).score,0);
  for(const answers of [{},{'1':4},{'1':0,'2':0},[],{'1':'0'}])assert.throws(()=>score(s,answers));
  let attempts=0;
  await assert.rejects(()=>generate(settings,{async complete(system){if(system.startsWith('Generate a fresh'))return {text:passage};attempts++;return {...question,options:[]};}}));
  assert.equal(attempts,3);
});
test('requested question counts 1–4 and unique IDs',async()=>{
  for(let count=1;count<=4;count++){
    let id=0;const p=provider(),original=p.complete;
    p.complete=async system=>system.startsWith('Generate ONE')?{...question,question:question.question+' '+(++id)}:original(system);
    const s=await generate({...settings,question_count:count},p);
    assert.equal(s.questions.length,count);assert.deepEqual(s.questions.map(q=>q.id),Array.from({length:count},(_,i)=>i+1));
  }
});
test('HTTP loop hides solutions, validates submission, locks first score and expires',async()=>{
  const app=express();app.use(express.json());app.use('/api/practice',createPracticeRouter({provider:provider(),ttl:200}));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const base='http://127.0.0.1:'+server.address().port+'/api/practice';
  const post=(path,body)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  try{
    assert.equal((await post('/generate',{...settings,question_count:9})).status,400);
    const response=await post('/generate',settings);assert.equal(response.headers.get('cache-control'),'no-store');const session=await response.json();
    assert.equal(session.questions[0].correct_answer,undefined);
    const fresh=await (await fetch(base+'/'+session.id)).json();assert.equal(fresh.questions[0].evidence,undefined);
    assert.equal((await post('/'+session.id+'/submit',{answers:{}})).status,400);
    const result=await (await post('/'+session.id+'/submit',{answers:{'1':0}})).json();assert.equal(result.score,1);assert.equal(result.results[0].evidence,question.evidence);
    const again=await (await post('/'+session.id+'/submit',{answers:{'1':3}})).json();assert.equal(again.score,1);
    await new Promise(resolve=>setTimeout(resolve,220));assert.equal((await fetch(base+'/'+session.id)).status,404);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
test('speech sequence omits options, supports pause and cancels stale callbacks',async()=>{
  const {BrowserSpeechEngine}=await import('../../docs/.vitepress/theme/components/listening/speech.mjs');
  const spoken=[];let paused=0,resumed=0;
  global.window={speechSynthesis:{getVoices:()=>[{lang:'en-US'}],speak:u=>spoken.push(u),cancel(){},pause(){paused++},resume(){resumed++}}};
  global.SpeechSynthesisUtterance=class{constructor(text){this.text=text;}};
  const engine=new BrowserSpeechEngine(()=>{}),session={settings,passage:{text:passage},questions:[{id:1,...question}]};
  let finished=0;
  engine.play(session,()=>finished++,assert.fail);
  assert.equal(spoken[0].text,passage);
  engine.pause();engine.resume();assert.equal(paused,1);assert.equal(resumed,1);
  const stale=spoken[0].onend;engine.stop();stale();assert.equal(engine.timer,null);
  engine.play(session,()=>finished++,assert.fail);
  spoken.at(-1).onend();engine.pause();assert.equal(engine.timer,null);
  engine.resume();clearTimeout(engine.timer);engine.timer=null;engine.pending();
  assert.equal(spoken.at(-1).text,'Question 1. '+question.question);
  assert.equal(spoken.some(u=>u.text.includes(question.options[0])),false);
  spoken.at(-1).onend();clearTimeout(engine.timer);engine.timer=null;engine.pending();assert.equal(finished,1);
  engine.stop();delete global.window;delete global.SpeechSynthesisUtterance;
});
