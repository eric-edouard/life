/* The made-up scenario turn by turn v3 plays (no real people), following the real flow
   (../2026-11-27-turn-by-turn-v2/2026-11-28-real-flow.md). Today is Wednesday 27 Nov, 9:41.
   Timings are the measured ones ÷ 2, so the prototype plays in half real time: `first` is the wait from his ask to the
   first step line (real median 5.7 s), each step's `ms` how long its line shows before the next replaces it; the whole
   answer arrives at once when the last step ends (real median 15 s for a plain question). Steps never say what they found.
   A day (`days`) is one standard format wherever it shows: its events, then what's waiting on him (owner, 28 Nov).
   The edits buttons (Warmer, Shorter) only show, they do nothing. A chat (`chat`) is drawn by CB.chat only: the messages that matter, the rest one quiet count. */
window.DATA=(function(){
  var face='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e3c48f"/><stop offset="1" stop-color="#a3345e"/></linearGradient></defs><rect width="96" height="96" fill="url(#g)"/><circle cx="48" cy="40" r="17" fill="#f6dcc4"/><path d="M29 38c0-14 9-22 19-22s19 8 19 22c-5-7-11-10-19-10s-14 3-19 10Z" fill="#3b2418"/><path d="M18 96c3-18 15-28 30-28s27 10 30 28Z" fill="#126e66"/></svg>');
  /* an item that waits on him, drawn as a card (an `items` block): a draft an agent or the main session asked (Send one
     tap, Sent after `sendMs`, real median 2.2 s; WhatsApp deletes for everyone, so Undo stays; Later puts it off) or a
     matter (who, what, its line, why, one wide action) */
  function item(o,sendMs){o.block='existing';o.kind='items';o.sendMs=sendMs;if(o.draft){o.sending='Sending…';o.undo='Undo';o.later='Later';}return o;}
  /* drafted by an agent when her message came in, before he asked: the answer brings it (his decision of 28 Nov) */
  var jade=item({t:'Reply to Jade',face:face,to:'Jade',app:'wa',sub:'Saturday dinner',when:'today',edits:['Warmer','Shorter'],
    chat:[{who:'Jade',t:'Saturday still on? I can book Mirabelle for 8 if you’re in.',at:'Tue 21:14'},
      {me:true,t:'Yes! Let me check with Sam and Ben',at:'Tue 21:30'},
      {unrelated:3},
      {who:'Jade',t:'Mirabelle at 8 works. Shall I book for four, with Sam and Ben?',at:'9:12'}],
    draft:'Yes please, four at 8. See you Saturday!',send:'Send to Jade',sent:'Sent to Jade · 9:42'},1100);
  var bill=item({who:'€',t:'Pay the electricity bill',sub:'€84',when:'Fri',why:'The bill came by mail this morning.',act:'I paid it',doing:'Recording…',ok:'Recorded'},900);
  var bank=item({who:'B',t:'Call the bank',sub:'Confirm your new card',when:'this week',why:'The card came yesterday; they confirm it by phone only.',act:'Done',doing:'Recording…',ok:'Recorded'},900);
  var lease=item({who:'N',t:'Sign the lease renewal',sub:'Nest Homes',when:'Mon',why:'They need it back signed by Monday.',act:'Signed',doing:'Recording…',ok:'Recorded'},900);
  return {
    now:{day:'Wednesday 27 Nov',time:'9:41'},
    days:{
      today:{lead:'Three things today.',
        events:[{block:'new',kind:'event',at:'10:15',t:'Dentist',where:'Clinique Rive'},
                {block:'new',kind:'event',at:'13:00',t:'Lunch with Sam',where:'Café Dalon'},
                {block:'new',kind:'event',at:'17:30',t:'House viewing',where:'8 Rue Vauban, with Ben'}],
        waiting:[jade,bill,lease]},
      tomorrow:{lead:'One thing tomorrow.',
        events:[{block:'new',kind:'event',at:'10:00',t:'Plumber',where:'At home'}],waiting:[]}},
    asks:{
      day:{ask:'What’s on today?',how:'typed',first:3000,
        steps:[{t:'Reading your day',ms:1800},{t:'Reading what waits on you',ms:1400}],day:'today'},
      /* held to talk in the app: his words show in the field as he speaks (real, with dictation on instant) */
      jade:{ask:'Did Jade answer?',how:'voice',first:3000,
        steps:[{t:'Looking up Jade',ms:1200},{t:'Reading Jade’s chat',ms:1600},{t:'Reading what waits on you',ms:1200}],
        answer:{lead:'Yes, Jade answered at 9:12. Here’s what she said.',card:jade}},
      /* he asks to send: one full turn of the main session ("Preparing an ask"), then its card, with no lead line;
         never sent on his words alone */
      tell:{ask:'Tell Ben I’ll be 10 minutes late',how:'typed',first:3000,
        steps:[{t:'Looking up Ben',ms:1300},{t:'Reading Ben’s chat',ms:1500},{t:'Preparing an ask',ms:2400}],
        answer:{card:item({t:'Tell Ben',to:'Ben',app:'wa',edits:['Warmer','Shorter'],
          chat:[{who:'Ben',t:'I’ll be downstairs at 17:30 for the viewing',at:'8:50'}],
          draft:'Running 10 minutes late, see you at 17:40!',send:'Send to Ben',sent:'Sent to Ben · 9:42'},1100)}}},
    /* while he is in the app, idle: an agent's card, delivered by the gate, comes into the thread from the inbox,
       quietly (no sound, no sheet), led by one line of why; `arriveMs` is when it shows in the scene */
    arrives:{arriveMs:3000,why:'Sam just texted that Café Dalon is closed today. Here’s your draft.',
      card:item({t:'Reply to Sam',to:'Sam',app:'wa',
        chat:[{me:true,t:'Lunch at Café Dalon at 1?',at:'Tue 19:02'},{who:'Sam',t:'Café Dalon is closed today. Pho Saigon instead?',at:'9:19'}],
        draft:'Pho Saigon works, see you at 1!',send:'Send to Sam',sent:'Sent to Sam · 9:42'},1100)},
    /* what waits on him, from the phone's own copy (instant, no turn): the count top left, the home's top 3, the list
       behind the count */
    waiting:[jade,bill,bank,lease],
    waitingAsk:'What’s waiting on me?',
    get waitingLead(){var w=this.waiting,n=w.length;return (['Nothing waits','One thing waits','Two things wait','Three things wait','Four things wait','Five things wait'][n]||n+' things wait')+' on you'+(n?', '+(w[0].to||w[0].who)+' first.':'.');},
    /* the pendant's page (App v4's pendant D): one status line and Pause */
    pendant:{recording:'Recording since 8:02',paused:'Paused · nothing is recorded'},
    /* one more ask, after the day's answer: the same day format */
    followUp:{ask:'And tomorrow?',how:'typed',first:2500,steps:[{t:'Reading your day',ms:1600}],day:'tomorrow'},
    /* a long turn (real ~45 s, so ~22 s here): the step line holds; after `stillAfter` ms the phone adds a second quiet line */
    slow:{ask:'Where is tonight’s viewing?',how:'typed',first:3000,stillAfter:10000,still:'Taking a little longer',
      steps:[{t:'Searching for “viewing”',ms:4000},{t:'Reading your mail',ms:9000},{t:'Searching for “Rue Vauban”',ms:6000}],
      answer:{lead:'8 Rue Vauban, third floor. Ben meets you downstairs at 17:30.',
        place:{block:'existing',kind:'place',name:'House viewing',address:'8 Rue Vauban, Lyon'}}},
    /* a read fails: the turn goes on, and the answer says so plainly (no retry promised: the session has no timer) */
    failure:{ask:'Did the landlord reply about the deposit?',how:'typed',first:3000,
      steps:[{t:'Searching for “deposit”',ms:1500},{t:'Reading your mail',ms:2200,fails:true},{t:'Reading your chats',ms:1300}],
      error:{t:'I couldn’t read your mail just now, so I can’t say. Nothing from him in your chats since Monday.'}},
    /* "hey Life" from the pendant, phone locked: nothing shows while he speaks; `heardMs` stands for the real minute
       (median 77 s) before the ask reaches Life; the push is replaced by `done` when the answer is ready */
    heyLife:{said:'Hey Life, what time is the viewing?',ask:'What time is the viewing?',heardMs:4000,heardAt:'9:43',answerMs:7500,
      heard:{title:'Life heard you',body:'On it.'},
      done:{title:'Life answered',body:'Open Life to read it.'},
      answer:{lead:'17:30, at 8 Rue Vauban. Ben meets you downstairs.'}},
    /* earlier turns, oldest first; the pager ends on today's latest */
    history:[
      {at:'Yesterday 18:40',ask:'Remind me to call the plumber tomorrow',answer:'Added: call the plumber, Thursday 10:00.'},
      {at:'Yesterday 21:05',ask:'When is the house viewing?',answer:'Today at 17:30, 8 Rue Vauban, with Ben.'},
      {at:'Today 8:02',ask:'Did the electricity bill come?',answer:'Yes, this morning. Pay it by Friday: €84.'},
      {at:'Today 9:30',ask:'What’s on today?',day:'today'}]};
})();
