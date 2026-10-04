export class BrowserSpeechEngine {
  constructor(onChange){this.onChange=onChange;this.version=0;this.timer=null;this.paused=false;}
  getAvailableVoices(){return window.speechSynthesis?.getVoices().filter(v=>/^en[-_]/i.test(v.lang))||[];}
  setRate(wpm){this.rate=Math.max(0.5,Math.min(2,wpm/170));}
  speak(text,done,failed){
    const u=new SpeechSynthesisUtterance(text);u.lang='en-US';u.rate=this.rate||1;
    const voice=this.getAvailableVoices()[0];if(!voice){failed('未找到英语语音，请安装英语语音包后重试。');return;}
    u.voice=voice;u.onend=done;u.onerror=e=>failed('语音播放失败：'+e.error);window.speechSynthesis.speak(u);
  }
  play(session,onDone,onError){
    this.stop();const version=this.version;this.setRate(session.settings.target_wpm);
    const segments=[session.passage.text,...session.questions.map(q=>'Question '+q.id+'. '+q.question)];let index=0;
    const next=()=>{
      if(version!==this.version)return;
      this.pending=null;
      if(index===segments.length){this.onChange({paused:false,progress:100,label:'播放完成'});onDone();return;}
      this.onChange({paused:false,progress:index/segments.length*100,label:index===0?'正在朗读文章':'正在朗读第 '+index+' 题'});
      this.speak(segments[index++],()=>{
        if(version!==this.version)return;
        this.remaining=index===1?2000:5000;this.pending=next;
        this.onChange({label:index===1?'文章间隔':'作答间隔'});if(!this.paused)this.schedule();
      },message=>{if(version===this.version){this.stop();onError(message);}});
    };next();
  }
  schedule(){this.started=Date.now();this.timer=setTimeout(()=>{this.timer=null;this.pending();},this.remaining);}
  pause(){this.paused=true;window.speechSynthesis.pause();if(this.timer){clearTimeout(this.timer);this.timer=null;this.remaining=Math.max(0,this.remaining-(Date.now()-this.started));}this.onChange({paused:true});}
  resume(){this.paused=false;window.speechSynthesis.resume();if(this.pending&&!this.timer)this.schedule();this.onChange({paused:false});}
  stop(){this.version++;clearTimeout(this.timer);this.timer=null;this.pending=null;this.paused=false;window.speechSynthesis?.cancel();}
}
