/* v2 batch 3: link, event, apify, plan, context, doneseen, clip */
(function(){
var V=(window.V2=window.V2||{});
var KIT='K/30',PAUL='P/200',NORA='N/339';
var FLU=['hero','ic:link','Book your flu jab','Pharmacy · this week'];
V.link={
 A:{w:'Adds one line of why and what Done leads to; Later stays first',b:[FLU,['why','Free slots at your pharmacy until Friday.'],['link','Doctolib'],['foot','Tap Done once it is booked; I tick it off.'],['answers','Done',['Later']]]},
 B:{w:'Same preview; adds the why and what Done does, so the page itself can be skipped',b:[FLU,['why','Free slots at your pharmacy until Friday.'],['link','Doctolib','doctolib.fr','Pharmacie du Centre · flu jabs','card'],['foot','Tap Done once it is booked; I tick it off.'],['answers','Done',['Later']]]},
 C:{w:'The sentence is the why; adds what Done does',b:[FLU,['link','Doctolib','','','inline'],['foot','Tap Done once it is booked; I tick it off.'],['answers','Done',['Later']]]}};
var EV={title:'Parents’ meeting',day:'Thursday',time:'18:00',place:'Linden School, room 4',rem:['1 hour before','At 17:30'],around:[['17:00','Free',0],['18:00','Parents’ meeting',1],['19:30','Dinner with Jade',0]]};
var EH=['hero','ic:cal','Add the parents’ meeting?','From Ms Hale’s mail · Thu'];
var EF=['foot','Add: it goes in your calendar with these two reminders.'];
V.event={
 A:{w:'Box kept; Later first, and a line saying what Add does',b:[EH,['event',EV,'box'],EF,['answers','Add to calendar',['Later']]]},
 B:{w:'Day kept; only the slot and its free neighbours, plus what Add does',b:[EH,['event',EV,'day'],EF,['answers','Add to calendar',['Later']]]},
 C:{w:'One line kept; adds what Add does; Later replaces No',b:[EH,['event',EV,'line'],EF,['answers','Add to calendar',['Later']]]}};
var RUN={what:'Physios within 3 km, with their prices',est:1.2,cap:3,cur:'$',month:'50 €',left:'31 €'};
var RH=['hero','ic:search','Look up the physios near home?','For your shoulder'];
var RF=['foot','Look them up: I search once and stop at $3.'];
V.apify={
 A:{w:'Estimate and cap kept; button says what it does; Later first; one line on the limit',b:[RH,['spend',RUN,'line'],RF,['answers','Look them up',['Later']]]},
 B:{w:'Bar kept; same button words, Later first, and the limit said once',b:[RH,['spend',RUN,'meter'],RF,['answers','Look them up',['Later']]]},
 C:{w:'Sentence kept (the month’s amount); button names the act, Later first',b:[RH,['spend',RUN,'month'],['foot','Look them up: I search once and stop at $3.'],['answers','Look them up',['Later']]]}};
var STEPS=[{text:'Ask Kit for the inspection date',by:'agent',when:'today, for your yes'},{text:'Be there for the inspection',by:'owner',when:'once Kit answers'},{text:'Remind Kit of the 14-day limit',by:'agent',when:'if nothing by 2 Dec'}];
var PH=['hero',KIT,'Get the deposit back','After your yes'];
var PF=['foot','Go ahead: I write to Kit first; nothing goes without your yes.'];
V.plan={
 A:{w:'List kept; Later replaces Not now; what Go ahead starts is said',b:[PH,['plan',STEPS,'list','From the lease and Kit’s messages'],PF,['answers','Go ahead',['Later']]]},
 B:{w:'Chain kept (his step filled); adds what Go ahead starts; Later first',b:[PH,['plan',STEPS,'chips','From the lease and Kit’s messages'],PF,['answers','Go ahead',['Later']]]},
 C:{w:'First step kept; adds what Go ahead starts; Later first',b:[PH,['plan',STEPS,'next','From the lease and Kit’s messages'],PF,['answers','Go ahead',['Later']]]}};
var CH=['hero','ic:pin','Pick a clinic for the tattoo','For you and Nora · Tue'];
var NSRC='<a class="cb-srcchip" href="#" onclick="return false">'+CB.I.wa+'Nora</a>';
V.context={
 A:{w:'One sentence with its link, quote under; Later stays first',b:[CH,['md','**Dr. Ink** is 10 min by metro and does [her scars too](life:obs).\n> Can they do both of us the same day?\n*Nora · WhatsApp, Mon*'],['answers','Contact Dr. Ink',['Later']]]},
 B:{w:'One line kept; the word chip becomes Nora’s message as a mark, no label',b:[CH,['why','Dr. Ink does both, 10 min by metro.'],['raw',NSRC],['answers','Contact Dr. Ink',['Later']]]},
 C:{w:'Only the two facts that decide; quote kept with Nora’s face',b:[CH,['md','- Tattoos and scars\n- 10 min by metro\n> Can they do both of us the same day?\n*[Nora](life:person) · WhatsApp, Mon*'],['answers','Contact Dr. Ink',['Later']]]}};
var PH2=['hero',PAUL,'Pay Paul 240 €','For the leak · due Fri'];
var ROWS=[['To','Plomberie Garnier'],['IBAN','FR76 3000 6000 0112 3456 7890 189',1],['Reference','Invoice 2611-07']];
var PA=['answers','I paid it',['Later']];
V.doneseen={
 A:{w:'Status line kept; says up front he can skip the tap; the settled row has the proof',b:[PH2,['box',ROWS,'240,00 €'],['foot','I look in your bank, so you can skip I paid it.'],PA],a:[['row',PAUL,'Pay Paul 240 €','Looking in your bank…','spin'],['then','Wed 14:02'],['row',PAUL,'Pay Paul 240 €','Seen in your bank · Wed 14:02','ok']]},
 B:{w:'Badge kept; a still dot while nothing is paid yet (no spinner before it looks)',b:[PH2,['box',ROWS,'240,00 €'],['seen','waiting','I’ll see it in your bank','badge'],PA],a:[['row',PAUL,'Pay Paul 240 €','Seen in your bank · Wed 14:02','ok']]},
 C:{w:'Nothing to tap kept; says so, and the row alone settles in place (no second sentence)',b:[PH2,['box',ROWS,'240,00 €'],['foot','Pay it your way. I see it in your bank and close this.'],['answers',null,['Later']]],a:[['row',PAUL,'Pay Paul 240 €','✓ Seen in your bank · Wed 14:02','ok']]}};
var SH=['hero','ic:voice','Did Sam say 9 or 10?','From this morning’s call'];
var W='Then let’s say Saturday at nine, I bring the big ladder';
V.clip={
 A:{w:'Wave and words kept; one line of what Life heard; Later as a quiet pill; 9:00 is the one cream',b:[SH,['why','I heard nine. Listen to be sure.'],['clip',W,'0:06','wave',3],['answers','9:00',['Later','10:00']]]},
 B:{w:'Play pill kept; Life’s answer put in words so the pill is not the only proof',b:[SH,['why','I heard “nine”. Listen to be sure.'],['clip','','0:06','pill',3],['answers','9:00',['Later','10:00']]]},
 C:{w:'Words kept with their small play; Later added; the answer is one cream, not a row',b:[SH,['clip',W,'0:06','text'],['answers','9:00',['Later','10:00']]]}};
})();
