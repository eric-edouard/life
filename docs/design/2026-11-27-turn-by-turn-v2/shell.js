/* The turn by turn prototypes' shared shell (needs edge.js, data.js). Shell.mount({title, scenes:[{id,label,run}], onAsk})
   draws the phone and the side panel; Shell.run(id) plays a scene (also on postMessage({scene:id}) and on #scene=id).
   A scene is run(ctx), async, with ctx = {phone, stage, field, edge, wait, type, speak, cancelled, lock, notify}. Starting a scene
   cancels the running one: its pending ctx.wait rejects, the stage is emptied, the field and the edge are reset.
   Use only ctx.wait for time (never setTimeout), so a cancelled scene stops cleanly.
   ctx.lock(time) shows the phone locked at that time (ctx.lock(false) unlocks); ctx.notify({title, body}) shows Life's
   one notification on it, replacing the last (a push replaced by its outcome), and resolves when he taps it. */
window.Shell=(function(){
  var MIC='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v3"/></svg>';
  var UP='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 14 6-6 6 6"/><path d="M12 8v10"/></svg>';
  var reduce=window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches;
  var CANCEL={cancelled:true},run=0,scenes=[],opts,phone,stage,field,lock,buttons={};

  function ctxFor(token){
    function alive(){if(token!==run)throw CANCEL;}
    function wait(ms){return new Promise(function(ok,no){setTimeout(function(){token===run?ok():no(CANCEL);},ms);});}
    return {phone:phone,stage:stage,field:field,edge:Edge,wait:wait,
      cancelled:function(){return token!==run;},
      lock:function(time){lock.hidden=time===false;if(time!==false){lock.querySelector('.lk-t').textContent=time||DATA.now.time;lock.querySelector('.lk-d').textContent=DATA.now.day;}},
      notify:function(n){var b=lock.querySelector('.lk-n');b.hidden=false;b.innerHTML='<small>LIFE · now</small><b></b><span></span>';
        b.querySelector('b').textContent=n.title;b.querySelector('span').textContent=n.body;b.animate&&!reduce&&b.animate([{opacity:0,transform:'translateY(-8px)'},{opacity:1,transform:'none'}],320);
        return new Promise(function(ok){b.onclick=function(){if(token===run)ok();};});},
      /* types text into an input or an element, a character at a time */
      type:async function(el,text){var v='value' in el&&el.tagName!=='BUTTON';
        if(reduce){v?el.value=text:el.textContent=text;field.sync();return;}
        for(var i=1;i<=text.length;i++){alive();v?el.value=text.slice(0,i):el.textContent=text.slice(0,i);field.sync();await wait(38);}},
      /* his voice: the field listens, the edge's pool follows a made-up level, the words arrive as heard */
      speak:async function(text){var words=text.split(' ');field.live(true);Edge.set('listen');
        for(var i=0;i<words.length;i++){alive();field.heard.textContent=words.slice(0,i+1).join(' ');
          for(var j=0;j<6;j++){Edge.level(.45+.55*Math.random());await wait(55);}}
        Edge.level(1);await wait(300);field.live(false);}};}

  function reset(){lock.hidden=true;lock.querySelector('.lk-n').hidden=true;stage.innerHTML='';field.clear();field.live(false);Edge.set('rest');Edge.level(1);}

  function start(id){var s=scenes.find(function(x){return x.id===id;});if(!s)return Promise.resolve();
    var token=++run;reset();Object.keys(buttons).forEach(function(k){buttons[k].setAttribute('aria-pressed',String(k===id));});
    return Promise.resolve().then(function(){return s.run(ctxFor(token));}).catch(function(e){if(e!==CANCEL)throw e;});}

  /* every scene in order; any other scene started meanwhile stops it */
  async function playAll(){for(var i=0;i<scenes.length;i++){var p=start(scenes[i].id),t=run;await p;if(t!==run)return;
    await new Promise(function(ok){setTimeout(ok,1500);});if(t!==run)return;}}

  function makeField(el){var input=el.querySelector('input'),mic=el.querySelector('.mic'),snd=el.querySelector('.snd'),heard=el.querySelector('.heard'),held=0,down=0;
    var f={el:el,input:input,mic:mic,send:snd,heard:heard,
      sync:function(){snd.disabled=!input.value.trim();},
      clear:function(){input.value='';heard.textContent='';f.sync();},
      live:function(on){el.classList.toggle('live',on);mic.setAttribute('aria-pressed',String(on));}};
    function ask(text,how){if(!text)return;f.clear();(opts.onAsk||function(t,h){start(h==='voice'?'voice-send':'type-send');})(text,how);}
    input.addEventListener('keydown',function(e){if(e.key==='Enter')ask(input.value.trim(),'typed');});
    input.addEventListener('input',f.sync);
    snd.addEventListener('click',function(){ask(input.value.trim(),'typed');});
    /* the mic: hold to talk (release sends), or tap to start and tap again to send */
    function stop(){var t=heard.textContent;clearInterval(held);held=0;f.live(false);Edge.level(1);Edge.set('rest');ask(t||DATA.asks.jade.ask,'voice');}
    mic.addEventListener('pointerdown',function(e){e.preventDefault();if(held){stop();return;}run++;down=performance.now();f.live(true);heard.textContent='';Edge.set('listen');
      var words=DATA.asks.jade.ask.split(' '),n=0;held=setInterval(function(){Edge.level(.45+.55*Math.random());if(++n%6===0&&n/6<=words.length)heard.textContent=words.slice(0,n/6).join(' ');},55);});
    mic.addEventListener('pointerup',function(){if(held&&performance.now()-down>350)stop();});
    mic.addEventListener('pointercancel',function(){if(held)stop();});
    f.sync();return f;}

  function fit(){var box=phone.parentNode,embedded=document.documentElement.classList.contains('embedded');
    if(innerWidth<=500){box.style.width=box.style.height='';phone.style.transform='';return;}
    var side=embedded?0:320,k=Math.min((innerHeight-(embedded?16:40))/844,(innerWidth-side-(embedded?16:40))/390);
    phone.style.transform='scale('+k+')';box.style.width=390*k+'px';box.style.height=844*k+'px';}

  return {
    mount:function(o){opts=o;scenes=o.scenes;if(window.self!==window.top)document.documentElement.classList.add('embedded');
      document.title=o.title;
      document.body.innerHTML='<main class="shell"><div class="fit"><div class="ph">'+
        '<div class="sbar"><span>9:41</span><span>●●● ▮</span></div><div class="stage"></div>'+
        '<div class="field gl"><input type="text" placeholder="Ask Life or hold to talk" aria-label="Ask Life" autocomplete="off"><span class="heard" aria-live="polite"></span>'+
        '<button type="button" class="k mic" aria-label="Talk (hold, or tap to start and stop)" aria-pressed="false">'+MIC+'</button><button type="button" class="k snd" aria-label="Send">'+UP+'</button></div>'+
        '<div class="lock" hidden><div class="lk-d"></div><div class="lk-t"></div><button type="button" class="lk-n gl" hidden></button></div><div class="home"></div></div></div><aside class="side"><h1></h1><p>Each scene starts from a clean screen. Click another to stop the one playing.</p><button type="button" class="play">Play all</button></aside></main>';
      phone=document.querySelector('.ph');stage=phone.querySelector('.stage');field=makeField(phone.querySelector('.field'));lock=phone.querySelector('.lock');
      document.querySelector('.side h1').textContent=o.title;Edge.mount(phone);
      var side=document.querySelector('.side');scenes.forEach(function(s){var b=document.createElement('button');b.type='button';b.textContent=s.label;b.setAttribute('aria-pressed','false');b.onclick=function(){start(s.id);};buttons[s.id]=b;side.appendChild(b);});
      side.querySelector('.play').onclick=playAll;
      addEventListener('message',function(e){if(e.data&&e.data.scene)start(e.data.scene);});
      addEventListener('resize',fit);fit();
      var h=/scene=([\w-]+)/.exec(location.hash);start(h?h[1]:'idle');},
    run:start,
    get phone(){return phone;}};
})();
