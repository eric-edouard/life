/* The made-up scenario every turn by turn variant plays (no real people). Today is Wednesday 27 Nov, 9:41.
   asks.day is typed, asks.jade is spoken; each has Life's working steps (ms: how long each shows), then its answer. */
window.DATA=(function(){
  var face='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e3c48f"/><stop offset="1" stop-color="#a3345e"/></linearGradient></defs><rect width="96" height="96" fill="url(#g)"/><circle cx="48" cy="40" r="17" fill="#f6dcc4"/><path d="M29 38c0-14 9-22 19-22s19 8 19 22c-5-7-11-10-19-10s-14 3-19 10Z" fill="#3b2418"/><path d="M18 96c3-18 15-28 30-28s27 10 30 28Z" fill="#126e66"/></svg>');
  return {
    now:{day:'Wednesday 27 Nov',time:'9:41'},
    asks:{
      day:{ask:'What’s on today?',how:'typed',
        steps:[{t:'Reading your calendar',d:'3 events today',ms:1400},{t:'Looking at your chats',d:'Jade is waiting on you',ms:1300},
               {t:'Checking Friday’s payments',d:'Electricity, €84',ms:1200},{t:'Checking the weather',d:'Lyon',ms:900}],
        answer:{
          lead:'A busy morning: leave for the dentist in 20 minutes.',
          events:[{at:'10:15',t:'Dentist',where:'Clinique Rive, 12 Rue des Saules',leave:'Leave by 9:55, 18 min by bike'},
                  {at:'13:00',t:'Lunch with Sam',where:'Café Lune'},
                  {at:'17:30',t:'House viewing',where:'8 Rue Vauban, with Ben'}],
          waiting:{who:'Jade',about:'Saturday dinner',last:'Saturday still on? I can book Mirabelle for 8 if you’re in.',at:'Yesterday 21:14'},
          payment:{t:'Electricity',amount:'€84',due:'Friday'},
          weather:'Sunny, 14° by noon, rain from 18:00: take a jacket to the viewing.'}},
      jade:{ask:'Did Jade answer about Saturday?',how:'voice',
        steps:[{t:'Looking at Jade’s chat',d:'WhatsApp',ms:1300},{t:'Reading her reply from 9:12',ms:1100},{t:'Drafting an answer in your words',ms:1500}],
        answer:{
          lead:'Yes, this morning. She can book for 8.',
          who:{name:'Jade',face:face},
          reply:{t:'Yes! Mirabelle at 8 works. Shall I book for four, with Sam and Ben?',at:'9:12',app:'WhatsApp'},
          draft:'Yes please, four at 8. See you Saturday!',
          send:'Send to Jade',sent:'Sent to Jade · 9:42'}}},
    /* one more ask, after the day's answer */
    followUp:{ask:'When do I need to leave?',how:'typed',steps:[{t:'Checking the route to Clinique Rive',ms:1200}],
      answer:{lead:'At 9:55: 18 minutes by bike, the bridge is closed so it’s the long way.'}},
    /* a step that takes long: Life says so while it waits */
    slow:{ask:'Where is tonight’s viewing?',how:'typed',
      steps:[{t:'Reading your calendar',ms:1000},{t:'Searching your mail for the viewing’s address',d:'Still looking: your mail goes back years',ms:9000,slow:true}],
      answer:{lead:'8 Rue Vauban, third floor. Ben meets you downstairs at 17:30.'}},
    /* a step that fails: Life says what, and what it does next */
    failure:{ask:'Is there enough on my account for Friday’s bill?',how:'typed',
      steps:[{t:'Checking Friday’s payments',ms:1400},{t:'Reaching your bank',ms:2200,fails:true}],
      error:{t:'Couldn’t reach your bank: I’ll check again at 18:00.',retry:'18:00'}},
    /* earlier turns, oldest first */
    history:[
      {at:'Yesterday 18:40',ask:'Remind me to call the plumber tomorrow',answer:'Added: call the plumber, Thursday 10:00.'},
      {at:'Yesterday 21:05',ask:'When is the house viewing?',answer:'Today at 17:30, 8 Rue Vauban, with Ben.'},
      {at:'Today 8:02',ask:'Did the electricity bill come?',answer:'Yes: €84, due Friday.'}]};
})();
