/* The cards' variants, as data: every item (one use case), its three variants (which blocks, in which order), the
   thread around it and the matters. The Choose tab draws all of them; the prototype draws the one he chose. */
(function () {
var B=CB.B;
/* the thread around a card, as data: the same few moments reused */
var CTX={
 waiting:[['bm','What’s waiting on me?'],['lead','Three things. This one first:']],
 push:[['lead','Earlier today:'],['row','S','Reply to Sam about the hedge','Sent to Sam','ok']],
 lunch:[['row','J','Reply to Jade','Sent to Jade','ok'],['lead','A voice from lunch today, and I don’t know whose:']],
 ben:[['bm','What did Ben say this week?'],['lead','Before I answer: two Bens, maybe one.']],
 leak:[['matter','Kitchen leak','Paul · open since 12 Nov']],
 jade:[['lead','Jade asked about Saturday:']],
 hedge:[['lead','Sam asked about the hedge:'],['row','S','Reply to Sam about the hedge','Sent to Sam','ok']],
 lawyer:[['bm','Has the lawyer answered?'],['lead','Not yet. I’ll tell you when she does.'],['bm','What’s on today?'],['lead','Just the dentist at 16:00.']],
 physio:[['bm','Find me a physio who can see me this week']],
 none:null,
 mum:[['lead','Your passport renewal went through.']],
 five:[['bm','What’s waiting on me?']]
};
var W={five:'Tapped <b>the count</b>, top left',none:'Asked earlier, <b>the answer came later</b>',waiting:'Asked <b>“What’s waiting on me?”</b>',push:'Tapped <b>the notification</b>',lunch:'Tapped <b>the notification</b> after lunch',ben:'Asked <b>“What did Ben say this week?”</b>',leak:'Opened <b>the leak matter</b> from its row',jade:'Life brought <b>a draft</b> to the thread',hedge:'Right after <b>a reply went</b>',lawyer:'Asked earlier, <b>the answer came later</b>',physio:'Asked for <b>long work</b>',mum:'Said <b>“Remind me to call Mum on Sunday”</b>'};
/* shared content the variants reuse */
var NORA='N/339',KIT='K/30',PAUL='P/200',JADE='J/160',MAX1='M/30',MAX2='M/200',LEA='L/280';
var PAY_H=['hero',PAUL,'Pay Paul 240 €','For the leak · due Fri'],PAYA=['answers','I paid it',['Later']];
var PAY_ROWS=[['To','Plomberie Garnier'],['IBAN','FR76 3000 6000 0112 3456 7890 189',1],['Reference','Invoice 2611-07']];
var EV={title:'Parents’ meeting',day:'Thursday',time:'18:00',place:'Linden School, room 4',rem:['1 hour before','At 17:30'],around:[['17:00','Free',0],['18:00','Parents’ meeting',1],['19:30','Dinner with Jade',0]]};
var EV_H=['hero','ic:cal','Add the parents’ meeting?','From Ms Hale’s mail · Thu'];
var RUN={what:'Physios within 3 km, with their prices',est:1.2,cap:3,cur:'$',month:'50 €',left:'31 €'};
var RUN_H=['hero','ic:search','Look up the physios near home?','For your shoulder'];
var STEPS=[{text:'Ask Kit for the inspection date',by:'agent',when:'today, for your yes'},{text:'Be there for the inspection',by:'owner',when:'once Kit answers'},{text:'Remind Kit of the 14-day limit',by:'agent',when:'if nothing by 2 Dec'}];
var DRAFT='Yes, Saturday works. Book for 8, I’ll be there.',DRAFT2='Yes, Saturday works, I can’t wait! Book for 8 and I’ll be there.';
var VH=['hero','ic:voice','Who is this voice?','Heard at 2 lunches · 620 words'];
function VC(m){return ['raw',CB.B.clip('Then let’s say Saturday at nine, I bring the big ladder','0:06',m,1)+CB.B.clip('No, the blue one, it’s cheaper','0:03',m,4)];}
var VDONE=[['row','ic:voice','Nora','Named in 2 conversations','ok'],['lead','Done: those lines are Nora’s now.']];
var VPEOPLE=[[NORA,'Nora','Your partner'],[LEA,'Lea Moreau','Fernway'],[MAX1,'Max Weber','Your landlord']];
var VNEW=[['then','After “Someone new”'],['lead','Who is it? A name, and who they are to you if you like.'],['bm','Tom, Nora’s brother'],['row','T/120','Tom','Nora’s brother · named in 2 conversations','ok']];
var MOVE_L=['lead','This one is yours, due tomorrow:'],MOVE_H=['hero','ic:car','Book the car’s service','Yours · due Fri'],MOVE_BOX=['box',[['Where','Garage Lemoine'],['Phone','+33 1 44 55 66 77',1]]];
var JH=['hero',JADE,'Reply to Jade','Jade · today'],JA=['answers','Send to Jade',['Later']],JE=['Warmer','Shorter','In French'],JW='Make it warmer, and say I’ll bring wine';
var DRAFT3='Yes, Saturday works, I’m looking forward to it! Book for 8, and I’ll bring the wine.';
var NM_Q=[['hero',KIT,'Start on this?','New · from Kit’s message, Tue']],NM_BOX=['box',[['Next','Ask Kit for the inspection date']]],NM_FOOT=['foot','Start: I write to Kit for your yes. Nothing goes without you.'],NM_A=['answers','Start',['Edit goal','Not this']];
var JCHAT=[['Hey! Are we still on for dinner Saturday?','9:12'],['Should I book? 8 or 8:30?','9:40']];
var REPLY='The lawyer answered: the contract is fine, and she sends the signed copy Monday.';
var CLINIC_H=['hero','ic:pin','Pick a clinic for the tattoo','For you and Nora · Tue'];
var SAM_H=['hero','ic:voice','Did Sam say 9 or 10?','From this morning’s call'];
var CALL=['Then let’s say Saturday at nine, I bring the big ladder','0:06'];
var WAIT=[{f:'B',s:'Ben · tonight',t:'Send Ben the call recap',a:'Send both',b:[['mhead','Fernway'],['hero','B','Send Ben the call recap','Ben · tonight'],['why','He was promised the transcript on today’s call.'],['answers','Send both',['Recap only']]]},
 {f:'ic:pin',s:'Tattoo · Tue',t:'Pick a clinic for the tattoo',a:'Contact Dr. Ink',b:[['mhead','Tattoo removal'],CLINIC_H,['why','Dr. Ink, Riverside: about ฿1,000 per cm², 10 min by metro.'],['answers','Contact Dr. Ink',['Other clinic']]]},
 {f:PAUL,s:'Paul · Fri',t:'Pay Paul 240 €',a:'I paid it',b:[['mhead','Kitchen leak'],PAY_H,['box',PAY_ROWS,'240,00 €'],PAYA]},
 {f:'ic:bank',s:'Bank · this week',t:'Call the bank',a:'Done',b:[['mhead','New bank card'],['hero','ic:bank','Call the bank','Confirm your new card · this week'],['answers','Done',['Later']]]},
 {f:JADE,s:'Jade · today',t:'Reply to Jade',a:'Send to Jade',b:[['mhead','Saturday dinner with Jade'],JH,['chat','Jade',JCHAT,DRAFT],JA]}];

/* every item: its parts (what can be mixed), its default way in and thread, and three variants (blocks before, and after his tap) */
var MP={'Kitchen leak':{t:'Kitchen leak',g:'The leak fixed and paid for',status:'Paul fixed it on Thursday; his bill is the last thing left.',next:'Pay Paul 240 € by Friday',
  asks:[[PAUL,'Pay Paul 240 €','Paul · due Fri']],people:[[PAUL,'Paul'],[NORA,'Nora']],ending:['Send Paul the photos of the leak','Got the photos, thanks! Coming Thursday','Paul · Wed',PAUL],
  thread:[['Mon','out','We have a leak under the sink, can you come?'],['Mon','in','Send me photos please'],['Tue','step','You: send Paul the photos'],['Wed','in','Got the photos, thanks! Coming Thursday'],['Thu','done','Paul came and fixed it'],['Thu','in','Invoice attached, 240 €. Thanks!']]},
 'Saturday dinner with Jade':{t:'Saturday dinner with Jade',g:'A table for two, Saturday at 8',status:'Jade asked whether to book; your reply waits.',next:'Reply to Jade',asks:[[JADE,'Reply to Jade','Jade · today']],people:[[JADE,'Jade']],
  thread:[['9:12','in','Hey! Are we still on for dinner Saturday?'],['9:40','in','Should I book? 8 or 8:30?']]},
 'Deposit back from Kit':{t:'Deposit back from Kit',g:'800 € back after the inspection',status:'Kit said it comes back after the inspection; no date yet.',next:'Ask Kit for the inspection date',asks:[[KIT,'Start on this?','New · Tue']],people:[[KIT,'Kit']],
  thread:[['Tue','in','The deposit comes back after the inspection, I’ll tell you when']]}};
var ANAT=[['A draft',{t:'Saturday dinner with Jade',g:'A table for two, Saturday at 8'},[JH,['chat','Jade',JCHAT,DRAFT],JA]],
 ['A payment',{t:'Kitchen leak',g:'The leak fixed and paid for'},[PAY_H,['box',PAY_ROWS,'240,00 €'],PAYA]],
 ['A new matter',{t:'Deposit back from Kit',g:'800 € back after the inspection',dec:1},NM_Q.concat([NM_BOX,NM_FOOT,NM_A])]];
var ASK_LEAK=withMatter({m:{t:'Kitchen leak',g:'The leak fixed and paid for'}},[PAY_H,['box',PAY_ROWS,'240,00 €'],PAYA],'tap');
function anat(mode){return ANAT.map(function(x){return [x[0],withMatter({m:x[1]},x[2],mode==='C'?null:mode)];});}
var ITEMS=[
{g:'One rule for every ask',id:'anatomy',n:'How an ask shows its matter',d:'Every ask: which matter it belongs to, its goal where it helps, the question, the details, the answers. The same three asks under each rule; switch between them above the phone.',parts:['Header','Goal'],ctx:'waiting',rec:'C',v:{
 A:{w:'The matter’s title as one line; its goal opens on a tap',tabs:anat('tap')},
 B:{w:'Title and goal on every ask',tabs:anat('goal')},
 C:{w:'Title only; the goal only where it decides the answer',tabs:anat('C')}}},
{id:'matterpage',n:'Matter page',d:'A tap on an ask’s matter title pushes its page, like a profile. The field stays and asks about this matter; Back returns to the thread.',parts:['Header','Needs you','People','Thread'],ctx:'waiting',way:'Tapped <b>“Kitchen leak”</b> on Paul’s ask · Back returns to it',rec:'A',v:{
 A:{w:'Like a profile: sections, the ending check first',tabs:[['The ask',ASK_LEAK],['Its page',[['mpage',MP['Kitchen leak'],'A']]]]},
 B:{w:'Its thread first, as a chat; what needs him at the end',tabs:[['The ask',ASK_LEAK],['Its page',[['mpage',MP['Kitchen leak'],'B']]]]},
 C:{w:'A short summary; only the last few lines of its thread',tabs:[['The ask',ASK_LEAK],['Its page',[['mpage',MP['Kitchen leak'],'C']]]]}}},
{g:'The seven cards',id:'voice-guess',m:{t:'A voice at lunch',f:'ic:voice'},n:'Voice naming: Life has a guess',d:'A voice Life heard twice at lunch. It thinks it is Nora; he plays it and says yes, or who it is.',parts:['Clips','The guess','Answers'],ctx:'lunch',rec:'A',v:{
 A:{w:'Clips with their words; the guess is the big answer',b:[VH,VC('wave'),['answers','Yes, Nora',['Someone else…','Don’t name']],['foot','TV or radio? Say “not a person” and I stop asking.']],a:VDONE},
 B:{w:'Nora’s face as the question; short clips',b:[['hero',NORA,'Is this Nora?','Heard at 2 lunches · 620 words'],VC('pill'),['answers','Yes',['Someone else…'],'row'],['answers',null,['TV or video','Don’t name']]],a:VDONE},
 C:{w:'The words to read; every answer in a list',b:[VH,VC('text'),['answers','Yes, it’s Nora',['Someone else…','TV or video','Don’t name'],'list']],a:VDONE}}},
{id:'voice-new',m:{t:'A voice at lunch',f:'ic:voice'},n:'Voice naming: no guess, someone new',d:'Life has no guess; a few people it could be. It is someone new, so he names them.',parts:['Clips','Who it may be','Answers'],ctx:'lunch',rec:'A',v:{
 A:{w:'Clips with their words, then people as rows',b:[VH,VC('wave'),['people',VPEOPLE,'rows','Who is it?'],['answers',null,['TV or video','Don’t name']]],a:VNEW},
 B:{w:'Short clips, then faces in a grid',b:[VH,VC('pill'),['people',VPEOPLE,'grid'],['answers',null,['TV or video','Don’t name']]],a:VNEW},
 C:{w:'The words to read, then name chips',b:[VH,VC('text'),['people',VPEOPLE,'chips'],['answers',null,['TV or video','Don’t name']]],a:VNEW}}},
{id:'newmatter',n:'New matter: start, or not',d:'Life found something running in his life that it could move now. The same anatomy, with Start as its question; nothing leaves without his yes.',parts:['What it shows','Evidence','Answers'],ctx:'waiting',rec:'A',m:{t:'Deposit back from Kit',g:'800 € back after the inspection',dec:1},v:{
 A:{w:'Next step in a box; says what Start does',b:NM_Q.concat([NM_BOX,NM_FOOT,NM_A]),a:[['row',KIT,'Deposit back from Kit','Drafting the message to Kit','ring',.15]]},
 B:{w:'One sentence; Start and No side by side',b:NM_Q.concat([['why','I can ask Kit for the inspection date now, and follow it until your 800 € is back.'],['answers','Start',['No'],'row'],['foot','To change the goal, just say it.']])},
 C:{w:'Kit’s own words first, then Start',b:NM_Q.concat([['quote','The deposit comes back after the inspection, I’ll tell you when','Kit · WhatsApp, Tue',KIT],['answers','Start',['No'],'row']])}}},
{id:'ending',n:'“Is this done?”',d:'On its matter’s page only: a later message seems to show a step done.',parts:['Where it sits','Evidence','Answers'],ctx:'leak',rec:'A',v:{
 A:{w:'A small card on the step, with Paul’s words',b:[['step','Send Paul the photos of the leak','Yours · since Mon'],['quote','Got the photos, thanks! Coming Thursday','Paul · Wed',PAUL],['why','Is this done?'],['answers','Yes, done',['Not yet'],'row']],
  a:[['step','Send Paul the photos of the leak','Done · Wed','struck'],['step','Let Paul in on Thursday','Yours · Thu']]},
 B:{w:'Marks right on the step, evidence as its line',b:[['step','Send Paul the photos of the leak','Paul: “Got the photos, thanks” · Wed','ask'],['step','Let Paul in on Thursday','Yours · Thu']]},
 C:{w:'Shown done already; one tap reopens',b:[['step','Send Paul the photos of the leak','Looks done: Paul got them · Wed','struck'],['answers',null,['Not done yet']],['step','Let Paul in on Thursday','Yours · Thu']]}}},
{id:'same',m:{t:'Ben Carter',f:'B'},n:'Same person',d:'Two people with the same whole name. Join them, or keep them apart.',parts:['Layout','Evidence','Answers'],ctx:'ben',rec:'A',v:{
 A:{w:'Side by side, each with where you see them',b:[['hero','ic:link','One Ben, or two?','Same whole name; nothing else joins them'],['pair',['B','Ben Carter','WhatsApp','+33 6 12 40 77 81'],['B','Ben Carter','Mail','ben@fernway.co']],['answers','Same person',['Different'],'row']],
  a:[['lead','One Ben now. He said three things this week:']]},
 B:{w:'Shows the one person joining makes',b:[['hero','ic:link','Join the two Bens?','Same whole name'],['pair',['B','Ben Carter','WhatsApp +33 6 12 40 77 81'],['B','','Mail ben@fernway.co'],'merged'],['answers','Join them',['Keep apart']]]},
 C:{w:'One sentence, yes or no',b:[['bt','Is <b>Ben Carter</b> on WhatsApp the same Ben who mails you from Fernway?'],['answers','Yes',['No'],'row']]}}},
{id:'contacts',m:{t:'Max, in your Contacts',f:'M'},n:'Contacts card',d:'A card in his Contacts that could be one of several people.',parts:['The card','Who it may be','Answers'],ctx:'waiting',rec:'A',v:{
 A:{w:'The card, then who it may be; tap one',b:[['hero','M','Which Max is this?','Contacts card · +33 6 44 12 90 03'],['people',[[MAX1,'Max Weber','Your landlord'],[MAX2,'Max Ruiz','Climbing']],'rows','Tap the one it is']]},
 B:{w:'Life’s best guess, yes or someone else',b:[['hero',MAX1,'Is this Max Weber?','Your landlord · the card says +33 6 44 12 90 03'],['answers','Yes',['Someone else…'],'row']]},
 C:{w:'One line and chips',b:[['bt','<b>Max</b>, +33 6 44 12 90 03, in your Contacts. Who is it?'],['people',[[MAX1,'Max Weber',''],[MAX2,'Max Ruiz','']],'chips']]}}},
{id:'atorg',m:{t:'Lea Moreau',f:LEA},n:'At organization',d:'Is someone at an organization, with a role? From their Contacts card.',parts:['Question','Evidence','Answers'],ctx:'waiting',rec:'A',v:{
 A:{w:'The question with where it comes from',b:[['hero','ic:org','Is Lea at Fernway?','As designer · from her Contacts card'],['answers','Yes',['No'],'row']],a:[['row','ic:org','Fernway','Lea added as designer','ok']]},
 B:{w:'Fernway’s people, with Lea added',b:[['hero','ic:org','Add Lea to Fernway?','From her Contacts card'],['row','B','Ben Carter','Founder'],['row',LEA,'Lea Moreau','Designer · new'],['answers','Add her',['No']]]},
 C:{w:'A row with two marks',b:[['step','Lea Moreau, designer at Fernway','From her Contacts card','ask']]}}},
{id:'yourmove',m:{t:'Car service',g:'Car ready before the trip on the 12th',dec:1},n:'Your move',d:'A step that is his own, which Life could also do. Done, hand it over, later, or drop.',parts:['Step','Details','Answers'],ctx:'push',way:'Tapped <b>the notification</b> on Thursday',rec:'A',v:{
 A:{w:'The step with where; Mark as done first',b:[MOVE_L,MOVE_H,MOVE_BOX,['answers','Mark as done',['Hand it to Life','Later','Drop']]],a:[MOVE_L,['row','ic:car','Book the car’s service','Done','ok']]},
 B:{w:'Life’s offer first; done second',b:[MOVE_L,MOVE_H,MOVE_BOX,['why','I can call the garage and book Friday morning.'],['answers','Hand it to Life',['Mark as done','Later','Drop']]],a:[MOVE_L,['row','ic:car','Book the car’s service','Calling the garage · about 10 min','ring',.2]]},
 C:{w:'A checklist row: tap the circle when done',b:[MOVE_L,['step','Book the car’s service','Due Fri · Garage Lemoine · +33 1 44 55 66 77'],['answers',null,['Hand it to Life','Later','Drop']]],a:[MOVE_L,['step','Book the car’s service','Done','struck']]}}},
{g:'What a card shows so he can answer without leaving',id:'payment',m:{t:'Kitchen leak',g:'The leak fixed and paid for'},n:'A payment: amount and account',d:'What to pay, to whom, from where.',parts:['Amount','Account','Answers'],ctx:'waiting',rec:'A',v:{
 A:{w:'Big amount, the account as rows, bank link',b:[PAY_H,['box',PAY_ROWS,'240,00 €'],['link','your bank'],PAYA]},
 B:{w:'Each field with its own copy button',b:[PAY_H,['copyrows',[['Amount','240,00 €']].concat(PAY_ROWS)],PAYA]},
 C:{w:'One sentence to read or copy whole',b:[PAY_H,['slip','Send <b>240,00 €</b> to <b>Plomberie Garnier</b>, FR76 3000 6000 0112 3456 7890 189, reference <b>Invoice 2611-07</b>.'],PAYA]}}},
{id:'qr',m:{t:'House cleaning'},n:'A payment code',d:'A PromptPay code someone sent.',parts:['Code','Amount','Source'],ctx:'waiting',rec:'A',v:{
 A:{w:'The code large, ready to scan',b:[['hero','M/30','Pay Mali 4,500 THB','Cleaning · today'],['qr','4,500 THB','Mali’s message','big'],['answers','I paid it',['Later']]]},
 B:{w:'A small code beside the amount',b:[['hero','M/30','Pay Mali 4,500 THB','Cleaning · today'],['qr','4,500 THB','Mali’s message','thumb'],['answers','I paid it',['Later']]]},
 C:{w:'Amount first; the code on a tap',b:[['hero','M/30','Pay Mali 4,500 THB','Cleaning · today'],['qr','4,500 THB','Mali’s message','hidden'],['answers','I paid it',['Later']]]}}},
{id:'link',m:{t:'Flu jab'},n:'A link',d:'Where he does the step himself.',parts:['Link','Answers'],ctx:'waiting',rec:'B',v:{
 A:{w:'A plain “Open” line',b:[['hero','ic:link','Book your flu jab','Pharmacy · this week'],['link','Doctolib'],['answers','Done',['Later']]]},
 B:{w:'A preview of the page',b:[['hero','ic:link','Book your flu jab','Pharmacy · this week'],['link','Doctolib','doctolib.fr','Pharmacie du Centre · flu jabs','card'],['answers','Done',['Later']]]},
 C:{w:'Inside the sentence',b:[['hero','ic:link','Book your flu jab','Pharmacy · this week'],['link','Doctolib','','','inline'],['answers','Done',['Later']]]}}},
{id:'event',m:{t:'Maya’s school'},n:'An event, with its reminders',d:'What goes in his calendar on his yes.',parts:['Event','Reminders','Answers'],ctx:'waiting',rec:'A',v:{
 A:{w:'A box: when, where, reminders',b:[EV_H,['event',EV,'box'],['answers','Add to calendar',['No']]]},
 B:{w:'The slot among the rest of his day',b:[EV_H,['event',EV,'day'],['answers','Add to calendar',['No']]]},
 C:{w:'One line and its reminders',b:[EV_H,['event',EV,'line'],['answers','Add to calendar',['No']]]}}},
{id:'apify',m:{t:'Shoulder pain',g:'A physio this week'},n:'A paid search, with its estimate and cap',d:'A run that costs a little. What it gets, about how much, and the most it can cost.',parts:['What it gets','Cost','Answers'],ctx:'physio',way:'Asked for <b>a physio</b>',rec:'A',v:{
 A:{w:'Estimate and “never more than”',b:[RUN_H,['spend',RUN,'line'],['answers','Run it',['No']]]},
 B:{w:'A bar: estimate inside its cap',b:[RUN_H,['spend',RUN,'meter'],['answers','Run it',['No']]]},
 C:{w:'In words, against this month’s amount',b:[RUN_H,['spend',RUN,'month'],['answers','Run it',['No']]]}}},
{id:'plan',m:{t:'Deposit back from Kit',g:'800 € back after the inspection'},n:'A plan’s steps',d:'What happens after his yes, and which steps are his.',parts:['Steps','Source','Answers'],ctx:'waiting',rec:'A',v:{
 A:{w:'Each step with who and when',b:[['hero',KIT,'Get the deposit back','After your yes'],['plan',STEPS,'list','From the lease and Kit’s messages'],['answers','Go ahead',['Not now']]]},
 B:{w:'The chain in one glance; his step filled',b:[['hero',KIT,'Get the deposit back','After your yes'],['plan',STEPS,'chips','From the lease and Kit’s messages'],['answers','Go ahead',['Not now']]]},
 C:{w:'Only the first step; how many after',b:[['hero',KIT,'Get the deposit back','After your yes'],['plan',STEPS,'next','From the lease and Kit’s messages'],['answers','Go ahead',['Not now']]]}}},
{id:'context',m:{t:'Tattoo removal'},n:'Context, with links',d:'Why Life asks, with links to Life’s own things and a quote.',parts:['Text','Quote','Links'],ctx:'waiting',rec:'A',v:{
 A:{w:'Short paragraph, links in it, the quote under',b:[CLINIC_H,['md','**Dr. Ink** is 10 min by metro and does both. Nora asked for [her scars too](life:obs).\n> Can they do both of us the same day?\n*Nora · WhatsApp, Mon*'],['answers','Contact Dr. Ink',['Later']]]},
 B:{w:'One line; the rest behind a chip',b:[CLINIC_H,['why','Dr. Ink does both, 10 min by metro.'],['raw','<a class="cb-srcchip" href="#" onclick="return false">Why this one</a>'],['answers','Contact Dr. Ink',['Later']]]},
 C:{w:'Bullets, then the quote',b:[CLINIC_H,['md','- Tattoos and scars\n- 10 min by metro\n- About ฿1,000 per cm²\n> Can they do both of us the same day?\n*[Nora](life:person) · WhatsApp, Mon*'],['answers','Contact Dr. Ink',['Later']]]}}},
{id:'doneseen',m:{t:'Kitchen leak'},n:'Life sees it done',d:'Life watches his bank for the payment, so he need not tell it.',parts:['Before','While looking','When seen'],ctx:'waiting',rec:'C',v:{
 A:{w:'A status line: looking, then seen',b:[PAY_H,['box',PAY_ROWS,'240,00 €'],PAYA],a:[['row',PAUL,'Pay Paul 240 €','Looking in your bank…','spin'],['then','Wed 14:02'],['row',PAUL,'Pay Paul 240 €','Seen in your bank · Wed 14:02','ok']]},
 B:{w:'Says up front that Life will see it',b:[PAY_H,['box',PAY_ROWS,'240,00 €'],['seen','looking','I’ll see it in your bank','badge'],PAYA]},
 C:{w:'Nothing to tap: the ask closes itself',b:[PAY_H,['box',PAY_ROWS,'240,00 €'],['answers',null,['Later']]],a:[['row',PAUL,'Pay Paul 240 €','Paid · Wed 14:02','ok'],['lead','Paul’s 240 € went out Wed 14:02, so I closed it.']]}}},
{id:'clip',m:{t:'The hedge'},n:'A voice clip on a card',d:'When the answer rests on what was said.',parts:['Clip','Words','Answers'],ctx:'waiting',rec:'A',v:{
 A:{w:'Waveform and the words',b:[SAM_H,['clip',CALL[0],CALL[1],'wave',3],['answers','9:00',['10:00'],'row']]},
 B:{w:'A play pill, words left out',b:[SAM_H,['clip','',CALL[1],'pill',3],['answers','9:00',['10:00'],'row']]},
 C:{w:'The words, a small play',b:[SAM_H,['clip',CALL[0],CALL[1],'text'],['answers','9:00',['10:00'],'row']]}}},
{g:'Focused lists',id:'swipe',n:'Focused lists swipe sideways',d:'He taps the count: his 5 waiting matters. A focused, short list uses the thread’s horizontal axis, so the thread doesn’t grow long and he never scrolls to reach its end; long or open-ended lists stay vertical. Open question: which lists qualify (a count under about 7, all of one kind).',parts:['Card size','The sign there is more','Voice naming'],ctx:'five',rec:'A',v:{
 A:{w:'One full card a page, the next one peeking; dots and “1 of 5”',b:[['lead','Five things wait on you:'],['swipe',WAIT,'full']]},
 B:{w:'Compact cards two up, a third peeking',b:[['lead','Five things wait on you:'],['swipe',WAIT.map(function(c){return {b:[['row',c.f,c.t,c.s],['answers',c.a]]};}),'two']]},
 C:{w:'Faces and titles as a strip; the chosen one unfolds below. Voice naming uses it too',tabs:[['The 5 waiting',[['lead','Five things wait on you:'],['swipe',WAIT,'strip',0]]],
  ['Voice naming, the same pattern',[VH,VC('wave'),['swipe',VPEOPLE.map(function(p){return {f:p[0],s:p[1].split(' ')[0]};}).concat([{f:'ic:plus',s:'Someone new'}]),'strip',-1],['answers',null,['TV or video','Don’t name']]]]]}}},
{g:'Answers and what follows them',id:'adds',m:{t:'Maya’s school'},n:'Add to calendar',d:'His yes writes the event; the result says where it went.',parts:['Button','Result line'],ctx:'waiting',rec:'A',v:{
 A:{w:'Result as the row’s line, with Undo',b:[EV_H,['event',EV,'line'],['answers','Add to calendar',['No']]],a:[['row','ic:cal','Parents’ meeting','In your calendar · Thu 18:00 · <u>Undo</u>','ok']]},
 B:{w:'Result as the event itself, ticked',b:[EV_H,['event',EV,'box'],['answers','Add to calendar',['No']]],a:[['raw','<div class="box"><b><span class="okt">'+CB.I.check+'</span> In your calendar</b><div class="kv"><span>Thursday</span><b>18:00, Linden School</b></div></div>']]},
 C:{w:'Life says it in a sentence',b:[EV_H,['event',EV,'line'],['answers','Add to calendar',['No']]],a:[['row','ic:cal','Parents’ meeting','Added','ok'],['lead','Added for Thursday. I’ll remind you an hour before.']]}}},
{id:'runs',m:{t:'Shoulder pain'},n:'Run it',d:'His yes starts a paid search; then its result.',parts:['While running','Result'],ctx:'physio',way:'Asked for <b>a physio</b>',rec:'A',v:{
 A:{w:'A still ring with its estimate, then the count and cost',b:[RUN_H,['spend',RUN,'line'],['answers','Run it',['No']]],a:[['row','ic:search','Physios near home','Running · about 4 min','ring',.4],['then','4 minutes later'],['row','ic:search','Physios near home','38 found · cost $1.10','ok']]},
 B:{w:'Only the result, as Life’s line',b:[RUN_H,['spend',RUN,'line'],['answers','Run it',['No']]],a:[['lead','Done: 38 physios, $1.10. Two can see you Thursday.']]},
 C:{w:'The result is the next ask',b:[RUN_H,['spend',RUN,'line'],['answers','Run it',['No']]],a:[['row','ic:search','Physios near home','38 found · $1.10','ok'],['hero','ic:pin','Book a physio for your shoulder','Two can see you Thu'],['answers','Book Harbour Physio',['Later']]]}}},
{id:'looks',m:{t:'Kitchen leak'},n:'Looks done (I paid it)',d:'He says he did it; Life looks for proof.',parts:['Looking','Not found'],ctx:'waiting',rec:'A',v:{
 A:{w:'Row line: looking, then not found yet, keeps looking',b:[PAY_H,['box',PAY_ROWS,'240,00 €'],PAYA],a:[['row',PAUL,'Pay Paul 240 €','Looking in your bank…','spin'],['then','A minute later'],['row',PAUL,'Pay Paul 240 €','Not in your bank yet · I look again until Fri','']]},
 B:{w:'Taken at his word; checked tonight',b:[PAY_H,['box',PAY_ROWS,'240,00 €'],PAYA],a:[['row',PAUL,'Pay Paul 240 €','Paid · I check your bank tonight','ok']]},
 C:{w:'Life explains in a sentence',b:[PAY_H,['box',PAY_ROWS,'240,00 €'],PAYA],a:[['row',PAUL,'Pay Paul 240 €','Not seen yet',''],['lead','I don’t see it in your bank yet; a transfer can take a day. I’ll look until Friday.']]}}},
{id:'rate',n:'How am I doing?',d:'At most once a day, after something settled. Three marks and dismiss.',parts:['Placement','Marks'],ctx:'hedge',rec:'A',v:{
 A:{w:'A bar under the settled row',b:[['rate','bar']],a:[['raw','<div class="hd"><span class="q">Thanks</span></div>']]},
 B:{w:'Three small marks tucked under the row',b:[['rate','under']]},
 C:{w:'One question, two marks',b:[['rate','one']]}}},
{id:'edit-tap',m:{t:'Saturday dinner with Jade'},n:'Changing a draft by a tap',d:'He taps Warmer on a quick-edit chip; the draft changes.',parts:['Chips','Where the change shows'],ctx:'jade',rec:'A',v:{
 A:{w:'Chips under the draft; it changes in place, back arrow',b:[JH,['chat','Jade',JCHAT,DRAFT],['edits',JE],JA],a:[JH,['chat','Jade',JCHAT,DRAFT2],['edits',['back','Shorter','In French']],JA]},
 B:{w:'Chips inside the draft bubble',b:[JH,['chat','Jade',JCHAT,DRAFT+CB.B.edits(JE,'inside')],JA],a:[JH,['chat','Jade',JCHAT,DRAFT2+CB.B.edits(['Shorter','In French'],'inside')],JA]},
 C:{w:'Chips under the answers, with the field',b:[JH,['chat','Jade',JCHAT,DRAFT],JA,['edits',JE]],a:[JH,['chat','Jade',JCHAT,DRAFT2],JA,['edits',['back','Shorter','In French']]]}}},
{id:'edit-words',m:{t:'Saturday dinner with Jade'},n:'Changing a draft by words',d:'He types “Make it warmer, and say I’ll bring wine”; Life redrafts.',parts:['His words','The old draft','The new draft'],ctx:'jade',rec:'A',v:{
 A:{w:'Old card folds to a row; a new card lands below',b:[JH,['chat','Jade',JCHAT,DRAFT],JA],a:[['row',JADE,'Reply to Jade','Earlier draft','old'],['bm',JW],['chat','Jade',[],DRAFT3],JA]},
 B:{w:'Changed in place; his words as a line under it',b:[JH,['chat','Jade',JCHAT,DRAFT],JA],a:[['bm',JW],JH,['chat','Jade',JCHAT,DRAFT3],['foot','Changed: warmer, and you bring the wine.'],JA]},
 C:{w:'New card with the changed words marked',b:[JH,['chat','Jade',JCHAT,DRAFT],JA],a:[['row',JADE,'Reply to Jade','Earlier draft','old'],['bm',JW],['chat','Jade',[],'Yes, Saturday works<mark>, I’m looking forward to it!</mark> Book for 8, <mark>and I’ll bring the wine.</mark>'],JA]}}},
{id:'follows',n:'A late reply',d:'An answer that arrives after the thread moved on, tied to what he asked.',parts:['Tie to the ask','Reply'],ctx:'lawyer',rec:'A',v:{
 A:{w:'His ask quoted on top of the reply',b:[['follows','Has the lawyer answered?',REPLY]]},
 B:{w:'The reply lands under his old question, marked new',ctx:'none',b:[['bm','Has the lawyer answered?'],['lead','Not yet. I’ll tell you when she does.'],['follows','',REPLY+' <small class="cb-new">New</small>','thread'],['bm','What’s on today?'],['lead','Just the dentist at 16:00.']]},
 C:{w:'A plain reply with a way back',b:[['follows','Has the lawyer answered?',REPLY,'goto']]}}},
{id:'handed',n:'I’m on it, with an estimate',d:'Long work handed off: he keeps going, the result lands later.',parts:['Words','Progress'],ctx:'physio',rec:'A',v:{
 A:{w:'A sentence, then the row with a still ring',b:[['bm','Find me a physio who can see me this week','👀'],['lead','I’m on it. It takes a few calls; I’ll come back with the best times.'],['row','ic:pin','Find a physio for this week','About 20 min','ring',.1]]},
 B:{w:'The ring in Life’s sentence, no row',b:[['bm','Find me a physio who can see me this week','👀'],['bt',CB.B.ring(.1)+' On it, about 20 minutes. Carry on.']]},
 C:{w:'No words: the mark and the row',b:[['bm','Find me a physio who can see me this week','👀'],['row','ic:pin','Find a physio for this week','About 20 min','ring',.1]]}}},
{id:'reaction',n:'Life’s mark on his message',d:'👀 taken on, 👍 done. Never his OK for anything.',parts:['Mark'],ctx:'mum',rec:'A',v:{
 A:{w:'On the bubble’s corner',b:[['bm','Remind me to call Mum on Sunday','👍'],['lead','Sunday at 10:00.']]},
 B:{w:'Where a delivery tick sits',b:[['bm','Remind me to call Mum on Sunday','👍','tick'],['lead','Sunday at 10:00.']]},
 C:{w:'The mark with one word',b:[['bm','Remind me to call Mum on Sunday','👍','words'],['lead','Sunday at 10:00.']]}}}
];
/* the anatomy (2026-11-26-cards-design.md): the matter's title, its goal where it decides the answer, then the question.
   Until he picks, every ask uses the recommended rule, C. The header goes before the card's first block of its own. */
function withMatter(it,b,mode){var m=it.m;if(!m)return b;var i=0;while(i<b.length&&['lead','bm','then','matter'].indexOf(b[i][0])>=0)i++;
 return b.slice(0,i).concat([['mhead',m.t,m.g,mode||(m.dec?'goal':'title'),m.f]],b.slice(i));}
function viewsOf(it,v){return v.tabs||[['Before',withMatter(it,v.b)]].concat(v.a?[['After the tap',v.a]]:[]);}
/* the variant to draw for an item: his pick; else the first variant he ticked a part of (mixing parts needs the
   designer); else the recommended one. decided is false until he picked one whole. */
function chosen(CH,id){var it=ITEMS.filter(function(x){return x.id===id;})[0],c=CH&&CH[id]||{},m=Object.keys(c.mix||{});
 var V=window.V2&&window.V2[id];if(V)Object.keys(V).forEach(function(k){it.v[k+'2']=it.v[k+'2']||V[k];});
 return c.pick?{it:it,k:c.pick,decided:true}:{it:it,k:m.length?c.mix[m[0]]:it.rec,decided:false,mixed:m.length>0};}
window.CV={CTX:CTX,W:W,ITEMS:ITEMS,MP:MP,withMatter:withMatter,viewsOf:viewsOf,chosen:chosen};
})();
