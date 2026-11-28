/* Turn by turn v3's shell, forked from v2's (needs edge.js, data.js, chat.js). Shell.mount({title, scenes:[{id,label,run}], onAsk})
   draws the phone and the side panel; Shell.run(id) plays a scene (also on postMessage({scene:id}) and on #scene=id); postMessage({vary:{topic:value}})
   hands the variations to opts.onVary, then plays the current scene again, with no reload.
   A scene is run(ctx), async, with ctx = {phone, stage, field, edge, wait, type, speak, cancelled, lock, notify}. Starting a scene
   cancels the running one: its pending ctx.wait rejects, the stage is emptied, the field and the edge are reset.
   Use only ctx.wait for time (never setTimeout), so a cancelled scene stops cleanly.
   ctx.lock(time) shows the phone locked at that time (ctx.lock(false) unlocks); ctx.notify({title, body}) shows Life's
   one notification on it, replacing the last (a push replaced by its outcome), and resolves when he taps it.
   App v4's two top controls stay on every screen: the "Waiting on you" count (a tap plays the scene 'waiting-list') and
   the pendant (a tap opens its page over whatever shows, ctx.pendant()). The count is worked out, never set: what waits
   on him (DATA.waiting) and every card drawn since, less what he settled.
   ctx.cards(items) makes the cards: one per item, side by side, swiped sideways. What a card holds is drawn here only
   (cardHtml; a draft's head and chat by chat.js), so it changes in one place; a variant places the row and may set --s-pad, --s-card-bg,
   --s-card-radius, --s-card-shadow. */
window.Shell=(function(){
  var MIC='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v3"/></svg>';
  var UP='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 14 6-6 6 6"/><path d="M12 8v10"/></svg>';
  var BACK='<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m14.5 5-7 7 7 7"/></svg>';
  var reduce=window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches;
  var CANCEL={cancelled:true},run=0,last='idle',scenes=[],opts,phone,stage,field,lock,count,pend,buttons={},kept=new WeakMap(),open=new Set();
  function esc(t){return String(t).replace(/[&<>"]/g,function(ch){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch];});}

  /* a card, as App v4 draws it: who (face or initial), what, its line, its one sentence of why, one wide action, then
     its outcome; a draft is its chat (chat.js: the head, the messages that matter, the draft), its quick edits, Later
     and Send side by side, Send on the right */
  function cardHtml(k){var draft=k.draft!=null;
    return '<article class="s-card">'+(draft?Chat.html(k):'<div class="s-hd"><span class="s-disc">'+(k.face?'<img alt="" src="'+k.face+'">':esc(k.who.charAt(0)))+'</span>'+
      '<span class="s-tx"><b>'+esc(k.t)+'</b><small>'+esc(k.sub+' · '+k.when)+'</small></span></div>'+(k.why?'<p class="s-why">'+esc(k.why)+'</p>':''))+
      (k.edits?'<div class="s-edits">'+k.edits.map(function(x){return '<button type="button">'+esc(x)+'</button>';}).join('')+'</div>':'')+
      '<div class="s-act" aria-live="polite"></div></article>';}
  /* its action's state is kept per item for the scene, so a card drawn again shows what he did */
  function paint(e,k,token){var act=e.querySelector('.s-act'),st=kept.get(k);e.classList.toggle('sent',st==='done');e.classList.toggle('undone',st==='undone');
    if(!st){act.innerHTML=(k.later?'<button type="button" class="s-later">'+esc(k.later)+'</button>':'')+'<button type="button" class="s-go">'+esc(k.send||k.act)+'</button>';
      var b=act.querySelector('.s-go'),l=act.querySelector('.s-later');
      if(l)l.onclick=function(){kept.set(k,'later');paint(e,k,token);};
      b.onclick=function(){if(b.disabled)return;b.disabled=true;b.textContent=k.sending||k.doing;if(l)l.disabled=true;
        setTimeout(function(){if(token!==run)return;kept.set(k,'done');open.delete(k);showCount();paint(e,k,token);Edge.set('landed');},k.sendMs);};return;}
    if(st==='later'){act.innerHTML='<div class="s-done s-off"><span>Later · tomorrow morning</span><button type="button">Undo</button></div>';
      act.querySelector('button').onclick=function(){kept.delete(k);paint(e,k,token);};return;}
    act.innerHTML='<div class="s-done"><span>'+esc(st==='undone'?'Deleted for both of you':k.sent||k.ok)+'</span>'+(st==='done'&&k.undo?'<button type="button">'+esc(k.undo)+'</button>':'')+'</div>';
    var u=act.querySelector('button');if(u)u.onclick=function(){kept.set(k,'undone');paint(e,k,token);};}
  function cards(items,token){var row=document.createElement('div'),list=document.createElement('div');row.className='s-cards';list.className='s-row';row.appendChild(list);
    items.forEach(function(k){if(!kept.has(k))open.add(k);var w=document.createElement('div');w.innerHTML=cardHtml(k);var e=w.firstChild;list.appendChild(e);paint(e,k,token);});
    if(items.length>1){row.classList.add('many');var dots=document.createElement('div');dots.className='s-dots';dots.setAttribute('aria-hidden','true');
      dots.innerHTML=items.map(function(){return '<i></i>';}).join('');row.appendChild(dots);
      var at=function(){var w=list.firstChild.offsetWidth+10,i=Math.round(list.scrollLeft/w);[].forEach.call(dots.children,function(d,j){d.classList.toggle('on',j===i);});};
      list.addEventListener('scroll',at,{passive:true});at();}
    showCount();
    /* a mouse drag pages by one card: a mouse has no sideways scroll, and the designs are mostly viewed with one (touch and
       trackpads scroll natively). Its pointerdown stays in the row, so variant A's reel never takes a card swipe as a shot's */
    var x0=null;
    list.addEventListener('pointerdown',function(e){e.stopPropagation();if(e.pointerType==='mouse')x0=e.clientX;});
    list.addEventListener('pointerup',function(e){if(x0===null)return;var dx=e.clientX-x0;x0=null;
      if(Math.abs(dx)>30)list.scrollBy({left:(dx<0?1:-1)*(list.firstChild.offsetWidth+10),behavior:reduce?'auto':'smooth'});});
    return row;}

  /* the pendant's page, as App v4 opens it: the page blurs, the pill's dot grows into the page's face, one status line
     and Pause; Back puts it away */
  function pendant(){if(phone.querySelector('.s-pov'))return;var paused=pend.classList.contains('paused');
    var o=document.createElement('div');o.className='s-pov';o.innerHTML='<div class="s-pblur"></div><button type="button" class="s-pback" aria-label="Back">'+BACK+'</button>'+
      '<div class="s-pav'+(paused?' off':'')+'"><i></i></div><div class="s-pbody"><div class="s-pname">Pendant</div><div class="s-pline"></div>'+
      '<div class="s-setb"><div class="s-setr"><span><b>Pause</b><small>Nothing is recorded while paused</small></span><button type="button" class="s-sw" role="switch" aria-label="Pause"></button></div></div></div>';
    phone.appendChild(o);var sw=o.querySelector('.s-sw'),line=o.querySelector('.s-pline'),av=o.querySelector('.s-pav');
    function show(p){pend.classList.toggle('paused',p);av.classList.toggle('off',p);sw.setAttribute('aria-checked',String(p));line.textContent=p?DATA.pendant.paused:DATA.pendant.recording;
      pend.setAttribute('aria-label',p?'Pendant, paused':'Pendant, recording');}
    show(paused);sw.onclick=function(){show(sw.getAttribute('aria-checked')!=='true');};
    requestAnimationFrame(function(){o.classList.add('on');});
    /* the face grows from the pill: both places read from the page, so shell.css alone says where they are */
    var k=phone.getBoundingClientRect().width/phone.offsetWidth,p=pend.getBoundingClientRect(),a=av.getBoundingClientRect();
    var pill='translate('+(p.left-a.left)/k+'px,'+(p.top-a.top)/k+'px) scale('+p.width/a.width+')';
    if(av.animate&&!reduce)av.animate([{transform:pill},{transform:'none'}],{duration:550,easing:'cubic-bezier(.2,.9,.22,1.06)'});
    o.querySelector('.s-pback').onclick=function(){o.classList.remove('on');
      if(av.animate&&!reduce)av.animate([{transform:'none'},{transform:pill,opacity:0}],{duration:380,easing:'cubic-bezier(.3,0,.2,1)',fill:'forwards'});
      setTimeout(function(){o.remove();},reduce?0:400);};}
  function showCount(){var n=open.size;count.textContent=n;count.setAttribute('aria-label',n+' waiting on you');count.style.visibility=n?'visible':'hidden';}

  function ctxFor(token){
    function alive(){if(token!==run)throw CANCEL;}
    function wait(ms){return new Promise(function(ok,no){setTimeout(function(){token===run?ok():no(CANCEL);},ms);});}
    return {phone:phone,stage:stage,field:field,edge:Edge,wait:wait,pendant:pendant,
      cards:function(items){return cards(items,token);},
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

  function reset(){kept=new WeakMap();open=new Set(DATA.waiting);showCount();phone.querySelectorAll('.s-pov').forEach(function(o){o.remove();});pend.classList.remove('paused');
    lock.hidden=true;lock.querySelector('.lk-n').hidden=true;stage.innerHTML='';field.clear();field.live(false);Edge.set('rest');Edge.level(1);}

  function start(id){var s=scenes.find(function(x){return x.id===id;});if(!s)return Promise.resolve();
    var token=++run;last=id;reset();Object.keys(buttons).forEach(function(k){buttons[k].setAttribute('aria-pressed',String(k===id));});
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
        '<div class="sbar"><span>9:41</span><span>●●● ▮</span></div>'+
        '<div class="s-top"><button type="button" class="s-count gl"></button><button type="button" class="s-pend gl" aria-label="Pendant, recording"><i></i></button></div><div class="stage"></div>'+
        '<div class="field gl"><input type="text" placeholder="Ask Life or hold to talk" aria-label="Ask Life" autocomplete="off"><span class="heard" aria-live="polite"></span>'+
        '<button type="button" class="k mic" aria-label="Talk (hold, or tap to start and stop)" aria-pressed="false">'+MIC+'</button><button type="button" class="k snd" aria-label="Send">'+UP+'</button></div>'+
        '<div class="lock" hidden><div class="lk-d"></div><div class="lk-t"></div><button type="button" class="lk-n gl" hidden></button></div><div class="home"></div></div></div><aside class="side"><h1></h1><p>Each scene starts from a clean screen. Click another to stop the one playing.</p><button type="button" class="play">Play all</button></aside></main>';
      phone=document.querySelector('.ph');stage=phone.querySelector('.stage');field=makeField(phone.querySelector('.field'));lock=phone.querySelector('.lock');
      count=phone.querySelector('.s-count');pend=phone.querySelector('.s-pend');count.onclick=function(){start('waiting-list');};pend.onclick=pendant;
      document.querySelector('.side h1').textContent=o.title;Edge.mount(phone);
      var side=document.querySelector('.side');scenes.forEach(function(s){var b=document.createElement('button');b.type='button';b.textContent=s.label;b.setAttribute('aria-pressed','false');b.onclick=function(){start(s.id);};buttons[s.id]=b;side.appendChild(b);});
      side.querySelector('.play').onclick=playAll;
      addEventListener('message',function(e){var d=e.data||{};if(d.vary&&opts.onVary){opts.onVary(d.vary);if(!d.scene)start(last);}if(d.scene)start(d.scene);});
      addEventListener('resize',fit);fit();
      var h=/scene=([\w-]+)/.exec(location.hash);start(h?h[1]:'idle');},
    run:start,
    get phone(){return phone;}};
})();
