const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createPracticeRouter } = require('./backend.cjs');

(async () => {
  let number = 0;
  const passage = 'The laboratory was closed on Thursday. ' + 'Maya tests data. Team logs work. '.repeat(28) + 'The team met again.';
  const app = express();
  app.use(express.json());
  app.use('/api/practice', createPracticeRouter({provider:{async complete(system){
    if(system.startsWith('Generate a fresh')) {number=0;return {turns:[{speaker:'narrator',text:passage}]};}
    if(system.startsWith('Independently')) return {valid:true,reason:''};
    return {type:'detail',question:'Why was workshop '+(++number)+' moved?',options:['The laboratory was closed.','The teacher was travelling.','More students could attend.','The equipment had arrived.'],correct_answer:0,evidence:[{text:'laboratory was closed on Thursday',speaker:'narrator',turn:0}],explanation:'实验室周四关闭，因此改到周五。'};
  }}}));
  const dist=path.resolve(__dirname,'../../docs/.vitepress/dist');
  app.use(express.static(dist,{extensions:['html']}));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  let browser;
  try {
    browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
    const page=await browser.newPage({viewport:{width:1440,height:1000}});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(()=>{
      window.__spoken=[];
      Object.defineProperty(window,'speechSynthesis',{value:{getVoices:()=>[{lang:'en-US'}],speak:u=>window.__spoken.push(u.text),cancel(){},pause(){},resume(){}}});
      window.SpeechSynthesisUtterance=class{constructor(text){this.text=text;}};
    });
    await page.goto('http://127.0.0.1:'+server.address().port+'/listening');
    await page.locator('details.voice-check').waitFor();
    assert.equal(await page.locator('details.voice-check').count(), 1);
    await page.getByText('校对音色', { exact: true }).click();
    assert.equal(await page.locator('.voice-check .voice-row').count(), 3);
    assert.equal(await page.locator('.voice-check .voice-row').first().isVisible(), true);
    assert.equal(await page.locator('.voice-row .icon-button').count(), 3);
    await page.getByRole('button',{name:'生成练习',exact:true}).click();
    await page.locator('.question').first().waitFor();
    assert.equal(await page.locator('.question').count(),3);
    assert.equal(await page.locator('.option').count(),12);
    assert.equal(await page.getByRole('button',{name:'提交答案',exact:true}).isDisabled(),true);
    assert.equal((await page.locator('.listening').innerText()).includes(passage),false);
    assert.equal((await page.locator('.listening').innerText()).includes('Why was workshop'),false);
    await page.getByRole('button',{name:'▶ 开始播放',exact:true}).click();
    assert.deepEqual(await page.evaluate(()=>window.__spoken),[passage]);
    await page.getByRole('button',{name:'暂停',exact:true}).click();
    await page.getByRole('button',{name:'继续',exact:true}).click();
    for(let i=0;i<3;i++) await page.locator('.question').nth(i).locator('input[type=radio]').first().check();
    await page.getByRole('button',{name:'提交答案',exact:true}).click();
    await page.getByRole('button',{name:'查看原文与解析',exact:true}).click();
    await page.getByText('查看完整原文', { exact: true }).click();
    assert.equal(await page.locator('.review').count(),3);
    assert.equal(await page.locator('.transcript p').innerText(),passage);
    assert.equal(await page.locator('blockquote').first().innerText(), 'laboratory was closed on Thursday');
    assert.equal((await page.locator('blockquote').first().innerText()).includes('speaker'), false);
    assert.match(await page.locator('.result').innerText(),/100%/);
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
    if(process.env.LISTENING_SCREENSHOT) await page.screenshot({path:process.env.LISTENING_SCREENSHOT,fullPage:true});
    await page.getByRole('button',{name:'生成新练习',exact:true}).click();
    await page.locator('.question').first().waitFor();
    assert.equal(await page.locator('.review').count(),0);
    assert.equal(await page.locator('.question input:checked').count(),0);
    await page.route('**/api/practice/generate',route=>route.fulfill({status:502,contentType:'application/json',body:JSON.stringify({error:'模拟生成失败，请重试。'})}));
    await page.getByRole('button',{name:'生成新练习',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'模拟生成失败'}).waitFor();
    assert.equal(await page.getByRole('button',{name:'生成练习',exact:true}).isEnabled(),true);
    assert.deepEqual(errors,[]);
    console.log('Browser loop passed: hidden text, audio controls, server score, review, mobile layout, regeneration, generation error.');
  } finally { await browser?.close();await new Promise(resolve=>server.close(resolve)); }
})().catch(error=>{console.error(error);process.exitCode=1;});
