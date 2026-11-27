/* App v4's edge, driven frame by frame exactly as v4 drives it (its frame() and applyAura() with the default aura:
   Life blue, colour only while working). Edge.mount(phone) once; Edge.set(state) glides to a state:
   rest, listen, work, landed (rest with v4's arrival pulse), still (v4's look while Life can't be reached).
   Edge.level(0..1) scales the voice pool while listening (1 = v4); Edge.speed(k) scales the tides' speed (1 = v4). */
window.Edge=(function(){
  var GOALS={
    still:{spd:.02,bo:.05,tide:.2,blue:0,pool:0,blur:15,col:0},
    rest:{spd:1,bo:.3,tide:.9,blue:0,pool:0,blur:10,col:0},
    listen:{spd:2,bo:.45*.53,tide:1,blue:0,pool:1,blur:15,col:0},
    work:{spd:1,bo:0,tide:0,blue:1,pool:0,blur:19,col:1}};
  var CREAM=[255,248,234],AURA=[154,168,236]; // v4's aura colour, Life blue
  var LAYERS='<i class="base"></i><i class="ai"></i><i class="t1"></i><i class="t2"></i><i class="up"></i><i class="down"></i><i class="arc"></i><i class="pool"></i>';
  var reduce=window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches;
  var el=null,state='rest',goal=GOALS.rest,cur={spd:1,bo:.14,tide:.9,blue:0,pool:0,blur:20,col:0};
  var a1=0,a2=120,a3=240,ph2=0,pulse=0,lvl=1,k=1,last=performance.now();
  function paint(st,col){var c=CREAM.map(function(x,i){return Math.round(x+(AURA[i]-x)*col);});
    st.setProperty('--cc',c.join(','));st.setProperty('--cl',c.map(function(x){return Math.round(x+(255-x)*.3);}).join(','));st.setProperty('--cd',c.map(function(x){return Math.round(x*.85);}).join(','));}
  function frame(now){var dt=Math.min(.05,(now-last)/1000);last=now;var t=now/1000,f=1-Math.exp(-dt/.45);
    for(var key in cur)cur[key]+=(goal[key]-cur[key])*f;pulse*=Math.exp(-dt/.5);var m=reduce?0:1;
    a1+=m*dt*cur.spd*k*360/16;a2-=m*dt*cur.spd*k*360/24;a3+=m*dt*360/9;ph2+=m*dt/3.8;
    var su=14+164*(.5-.5*Math.cos(Math.PI*ph2)),sd=14+164*(.5+.5*Math.cos(Math.PI*ph2));
    var breath=m?(.65+.35*(.5-.5*Math.cos(2*Math.PI*t/7))):.8,aib=m?(.35+.25*(.5-.5*Math.cos(2*Math.PI*t/2.4))):.5;
    var flick=m?(.72+.28*Math.abs(Math.sin(t*9.1)*Math.sin(t*5.3+1))):1,st=el.style;
    st.setProperty('--j1',a1+'deg');st.setProperty('--j2',a2+'deg');st.setProperty('--j3',a3+'deg');st.setProperty('--su',su+'deg');st.setProperty('--sd',sd+'deg');
    st.setProperty('--o-base',Math.min(1,cur.bo*breath+pulse*.8));st.setProperty('--o-ai',cur.blue*aib);st.setProperty('--o-tide',cur.tide);st.setProperty('--o-blue',cur.blue);st.setProperty('--o-pool',cur.pool*flick*lvl);st.setProperty('--blur',cur.blur+'px');paint(st,cur.col);
    requestAnimationFrame(frame);}
  return {
    mount:function(phone){if(el)return el;el=document.createElement('div');el.className='edge s-rest';el.setAttribute('aria-hidden','true');
      el.innerHTML='<div class="gw">'+LAYERS+'</div><div class="cr">'+LAYERS+'</div>';phone.appendChild(el);requestAnimationFrame(frame);return el;},
    set:function(s){if(s==='landed'){pulse=1;s='rest';}if(!GOALS[s])throw new Error('Edge state: '+s);state=s;goal=GOALS[s];if(el)el.className='edge s-'+s;},
    level:function(v){lvl=Math.max(0,Math.min(1,v));},
    speed:function(v){k=v;},
    get state(){return state;}};
})();
