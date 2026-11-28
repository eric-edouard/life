/* The chat, drawn in this one place wherever a chat shows (philosophy, Drafts, 28 Nov): a draft card's head (the
   person's picture or initials, their name, the app's name, an arrow that opens the chat), then the messages that
   matter to the ask, unrelated ones as one quiet count, then the draft in the app's own sent-bubble colour with the
   dashed outline (it fades once sent: .sent on any ancestor). The log scrolls and opens at the bottom on the latest
   (column-reverse, no script). Chat.html(k) with k = {to, face?, app, chat:[{who,t,at} | {me,t,at} | {unrelated:n}], draft}.
   The app's colour is card-blocks' (CB.APPS); the open arrow is WhatsApp's mock link for every app. */
window.Chat=(function(){
  var ARROW='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7"/><path d="M8 7h9v9"/></svg>';
  var esc=CB.esc;
  /* the app's colour and name are card-blocks' (CB.APPS); only its link is here, a mock's: it opens no real chat */
  function appOf(k){return Object.keys(CB.APPS).map(function(i){return CB.APPS[i];}).filter(function(a){return a.n===k.app;})[0];}
  function initials(n){return n.split(' ').map(function(w){return w.charAt(0);}).join('').slice(0,2);}
  function head(k){
    return '<div class="c-hd"><span class="c-face">'+(k.face?'<img alt="" src="'+k.face+'">':esc(initials(k.to)))+'</span>'+
      '<span class="c-who"><b>'+esc(k.to)+'</b><small>'+esc(k.app)+'</small></span>'+
      '<a class="c-open" href="https://wa.me/" target="_blank" rel="noopener" aria-label="Open the chat in '+esc(k.app)+'">'+ARROW+'</a></div>';}
  function msg(m){if(m.unrelated)return '<div class="c-un">'+m.unrelated+' unrelated message'+(m.unrelated>1?'s':'')+'</div>';
    return '<div class="c-m '+(m.me?'c-out':'c-in')+'">'+esc(m.t)+'<span class="c-at">'+esc(m.at)+'</span></div>';}
  return {esc:esc,html:function(k){
    return '<div class="c" style="--app:'+appOf(k).rgb+'">'+head(k)+'<div class="c-log"><div class="c-list">'+(k.chat||[]).map(msg).join('')+
      (k.draft!=null?'<div class="c-m c-out c-draft">'+esc(k.draft)+'</div>':'')+'</div></div></div>';}};
})();
