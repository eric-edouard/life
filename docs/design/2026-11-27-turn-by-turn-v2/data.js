/* The made-up scenario every turn by turn variant plays (no real people), following the real flow
   (2026-11-28-real-flow.md). Today is Wednesday 27 Nov, 9:41.
   Timings are the measured ones ÷ 2, so a prototype plays in half real time: `first` is the wait from his ask to the
   first step line (real median 5.7 s), each step's `ms` how long its line shows before the next replaces it; the whole
   answer arrives at once when the last step ends (real median 15 s for a plain question). Steps never say what they found.
   Every piece an answer draws has `block`: 'existing' (one of today's 8 kinds, named in `kind`) or 'new' (proposed,
   to be built; mark it "new block" on screen). */
window.DATA=(function(){
  var face='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e3c48f"/><stop offset="1" stop-color="#a3345e"/></linearGradient></defs><rect width="96" height="96" fill="url(#g)"/><circle cx="48" cy="40" r="17" fill="#f6dcc4"/><path d="M29 38c0-14 9-22 19-22s19 8 19 22c-5-7-11-10-19-10s-14 3-19 10Z" fill="#3b2418"/><path d="M18 96c3-18 15-28 30-28s27 10 30 28Z" fill="#126e66"/></svg>');
  /* a draft card an agent or the main session asked: shown by an `items` block, its Send one tap; Sent after `sendMs`
     (real median 2.2 s); WhatsApp allows deleting for everyone, so Undo stays */
  function card(o){o.block='existing';o.kind='items';o.sendMs=1100;o.sending='Sending…';o.undo='Undo';return o;}
  /* drafted by an agent when her message came in, before he asked: the answer brings it (his decision of 28 Nov) */
  var jade=card({t:'Reply to Jade',face:face,made:'Drafted 25 min ago, when her message came in',to:'Jade',app:'WhatsApp',
    draft:'Yes please, four at 8. See you Saturday!',send:'Send to Jade',sent:'Sent to Jade · 9:42'});
  /* a matter that waits on him, as App v4's card shows it: who, what, its line, why, one wide action */
  function matter(o){o.block='existing';o.kind='items';o.sendMs=900;return o;}
  return {
    now:{day:'Wednesday 27 Nov',time:'9:41'},
    asks:{
      day:{ask:'What’s on today?',how:'typed',first:3000,
        steps:[{t:'Looking at your day',ms:1800},{t:'Reading what waits on you',ms:1400},{t:'Reading your payments',ms:1300}],
        answer:{
          lead:'Three things today, the dentist first at 10:15. Jade is waiting on you about Saturday.',
          events:[{block:'new',kind:'event',at:'10:15',t:'Dentist',where:'Clinique Rive'},
                  {block:'new',kind:'event',at:'13:00',t:'Lunch with Sam',where:'Café Lune'},
                  {block:'new',kind:'event',at:'17:30',t:'House viewing',where:'8 Rue Vauban, with Ben'}],
          place:{block:'existing',kind:'place',name:'Clinique Rive',address:'12 Rue des Saules, Lyon'},
          waiting:{block:'existing',kind:'items',who:'Jade',about:'Saturday dinner',last:'Saturday still on? I can book Mirabelle for 8 if you’re in.',at:'Yesterday 21:14'},
          payment:{block:'new',kind:'payment',t:'Electricity',amount:'€84',due:'Friday'}}},
      /* held to talk in the app: his words show in the field as he speaks (real, with dictation on instant) */
      jade:{ask:'Did Jade answer?',how:'voice',first:3000,
        steps:[{t:'Looking up Jade',ms:1200},{t:'Reading Jade’s chat',ms:1600},{t:'Reading what waits on you',ms:1200}],
        answer:{
          lead:'Yes, at 9:12: she can book Mirabelle for 8. A reply is ready.',
          who:{block:'new',kind:'face',name:'Jade',face:face},
          reply:{block:'new',kind:'quote',t:'Yes! Mirabelle at 8 works. Shall I book for four, with Sam and Ben?',at:'9:12',app:'WhatsApp'},
          card:jade}},
      /* he asks to send: one full turn of the main session ("Preparing an ask"), then its card; never sent on his words alone */
      tell:{ask:'Tell Ben I’ll be 10 minutes late',how:'typed',first:3000,
        steps:[{t:'Looking up Ben',ms:1300},{t:'Reading Ben’s chat',ms:1500},{t:'Preparing an ask',ms:2400}],
        answer:{
          lead:'Here it is, in how you write to Ben.',
          card:card({t:'Tell Ben',made:'Just now, on your words',to:'Ben',app:'WhatsApp',edits:['Warmer','Shorter'],
            draft:'Running 10 minutes late, see you at 17:40!',send:'Send to Ben',sent:'Sent to Ben · 9:42'})}}},
    /* while he is in the app, idle: an agent's card, delivered by the gate, comes into the thread from the inbox,
       quietly (no sound, no sheet); `arriveMs` is when it shows in the scene */
    arrives:{arriveMs:3000,
      card:card({t:'Reply to Sam',made:'Drafted 20 min ago, when Sam wrote',to:'Sam',app:'WhatsApp',
        context:{block:'new',kind:'quote',who:'Sam',t:'Café Lune is shut today 😩 Pho Saigon instead?',at:'9:19',app:'WhatsApp'},
        draft:'Pho Saigon works, see you at 1!',send:'Send to Sam',sent:'Sent to Sam · 9:42'})},
    /* what waits on him, from the phone's own copy (instant, no turn): the count top left, the home's top 3, the list
       behind the count (his words to Life, as App v4 shows them, then the cards) */
    waiting:[jade,
      matter({who:'E',t:'Pay the electricity bill',sub:'€84',when:'Fri',why:'The bill came by mail this morning.',act:'I paid it',doing:'Recording…',ok:'Recorded'}),
      matter({who:'B',t:'Call the bank',sub:'Confirm your new card',when:'this week',why:'The card came yesterday; they confirm it by phone only.',act:'Done',doing:'Recording…',ok:'Recorded'}),
      matter({who:'N',t:'Sign the lease renewal',sub:'Nest Homes',when:'Mon',why:'They need it back signed by Monday.',act:'Signed',doing:'Recording…',ok:'Recorded'})],
    waitingAsk:'What’s waiting on me?',waitingLead:'Four things wait on you, Jade first.',
    /* the pendant's page (App v4's pendant D): one status line and Pause */
    pendant:{recording:'Recording since 8:02',paused:'Paused · nothing is recorded'},
    /* one more ask, after the day's answer */
    followUp:{ask:'And tomorrow?',how:'typed',first:2500,steps:[{t:'Looking at your day',ms:1600}],
      answer:{lead:'Quieter: the plumber at 10:00, nothing after.'}},
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
       (median 77 s) before the ask reaches Life (the lock screen's clock moves on to `heardAt`); the push is replaced
       by `done` when the answer is ready (`answerMs`, real ~15 s), with none of its words */
    heyLife:{said:'Hey Life, what time is the viewing?',ask:'What time is the viewing?',heardMs:4000,heardAt:'9:43',answerMs:7500,
      heard:{title:'Life heard you',body:'On it.'},
      done:{title:'Life answered',body:'Open Life to read it.'},
      answer:{lead:'17:30, at 8 Rue Vauban. Ben meets you downstairs.'}},
    /* earlier turns, oldest first */
    history:[
      {at:'Yesterday 18:40',ask:'Remind me to call the plumber tomorrow',answer:'Added: call the plumber, Thursday 10:00.'},
      {at:'Yesterday 21:05',ask:'When is the house viewing?',answer:'Today at 17:30, 8 Rue Vauban, with Ben.'},
      {at:'Today 8:02',ask:'Did the electricity bill come?',answer:'Yes: €84, due Friday.'}]};
})();
