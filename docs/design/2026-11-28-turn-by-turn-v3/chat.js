/* The chat, drawn in this one place wherever a chat shows (philosophy, Drafts, 28 Nov): a draft card's head (the
   person's picture or initials, their name, the app's name, an arrow that opens the chat), then the messages that
   matter to the ask, unrelated ones as one quiet count, then the draft in the app's own sent-bubble colour with the
   dashed outline (it fades once sent: .sent on any ancestor). The log scrolls and opens at the bottom on the latest
   (column-reverse, no script). Chat.html(k) with k = {to, face?, app, chat:[{who,t,at} | {me,t,at} | {unrelated:n}], draft}.
   Only WhatsApp is drawn here; another app adds its row to APPS. */
window.Chat=(function(){
  var ARROW='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7"/><path d="M8 7h9v9"/></svg>';
  var APPS={WhatsApp:{link:'https://wa.me/',cls:'c-wa'}};
  function esc(t){return String(t).replace(/[&<>"]/g,function(ch){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch];});}
  function initials(n){return n.split(' ').map(function(w){return w.charAt(0);}).join('').slice(0,2);}
  function head(k){var a=APPS[k.app];
    return '<div class="c-hd"><span class="c-face">'+(k.face?'<img alt="" src="'+k.face+'">':esc(initials(k.to)))+'</span>'+
      '<span class="c-who"><b>'+esc(k.to)+'</b><small>'+esc(k.app)+'</small></span>'+
      '<a class="c-open" href="'+a.link+'" target="_blank" rel="noopener" aria-label="Open the chat in '+esc(k.app)+'">'+ARROW+'</a></div>';}
  function msg(m){if(m.unrelated)return '<div class="c-un">'+m.unrelated+' unrelated message'+(m.unrelated>1?'s':'')+'</div>';
    return '<div class="c-m '+(m.me?'c-out':'c-in')+'">'+esc(m.t)+'<span class="c-at">'+esc(m.at)+'</span></div>';}
  return {html:function(k){
    return '<div class="c '+APPS[k.app].cls+'">'+head(k)+'<div class="c-log"><div class="c-list">'+(k.chat||[]).map(msg).join('')+
      (k.draft!=null?'<div class="c-m c-out c-draft">'+esc(k.draft)+'</div>':'')+'</div></div></div>';}};
})();
