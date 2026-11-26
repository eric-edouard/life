/* v2 batch 3: link, event, apify, plan, context, doneseen, clip */
(function(){
var V=(window.V2=window.V2||{});
var KIT='K/30',PAUL='P/200',NORA='N/339';
var FLU=['hero','ic:link','Book your flu jab','Pharmacy · this week'];
var P1='Pharmacie du Centre, Thu 10:00',P2='Pharmacie de la Gare, Sat 9:00';
var BOOK=['answers','Book Pharmacie du Centre',['Later']];
var MAP=['link','Google Maps'];
V.link={
 A:{w:'The original’s choice: a line of why, the two pharmacies, a Google Maps link under each, Book on the right',b:[FLU,['why','I checked pharmacies near home. These two have a free slot.'],['option',1,P1,'4 min walk · takes your card',1],MAP,['option',0,P2,'12 min by bus · takes your card'],MAP,BOOK]},
 B:{w:'Same choice with no map links: the walk or bus time says where, so there is nothing to open',b:[FLU,['option',1,P1,'4 min walk · takes your card',1],['option',0,P2,'12 min by bus · takes your card'],BOOK]},
 C:{w:'No choice to make: Life’s pick in a sentence with its map; the other place is a quiet answer',b:[FLU,['pick',P1+', 4 min walk.'],MAP,['answers','Book Pharmacie du Centre',['Later',P2]]]}};
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
var STEPS=[{text:'Ask Kit for the inspection date',by:'agent',when:'today'},{text:'Be there for the inspection',by:'owner',when:'once Kit answers'},{text:'Remind Kit of the 14-day limit',by:'agent',when:'2 Dec, if he is silent'}];
var PH=['hero',KIT,'Get your deposit back','Kit, your landlord'];
V.plan={
 A:{w:'The list, trimmed: who does each step and when, nothing else; no source line, no foot',b:[PH,['plan',STEPS,'list'],['answers','Go ahead',['Later']]]},
 B:{w:'Steps stacked in time order as rings that tick off as they happen; your step is named, no who-icons',b:[PH,['step','Ask Kit for the inspection date','Today, by me',''],['step','Be there for the inspection','You, once Kit answers',''],['step','Remind Kit of the 14-day limit','2 Dec, by me, if he is silent',''],['answers','Go ahead',['Later']]]},
 C:{w:'No list at all: one sentence tells how it unfolds, ending on your part',b:[PH,['md','I ask Kit for the inspection date today. Once he answers, you go to the inspection. If he is silent by 2 Dec, I remind him of the 14-day limit.'],['answers','Go ahead',['Later']]]}};
var CH=['hero','ic:pin','Pick a clinic for the tattoo','For you and Nora · Tue'];
var NSRC=['source','wa','Nora','Mon'];
V.context={
 A:{w:'One sentence with its link, quote under; Later stays first',b:[CH,['md','**Dr. Ink** is 10 min by metro and does [her scars too](life:obs).\n> Can they do both of us the same day?\n*Nora · WhatsApp, Mon*'],['answers','Contact Dr. Ink',['Later']]]},
 B:{w:'One line kept; the word chip becomes Nora’s message as a mark, no label',b:[CH,['why','Dr. Ink does both, 10 min by metro.'],NSRC,['answers','Contact Dr. Ink',['Later']]]},
 C:{w:'Only the two facts that decide; quote kept with Nora’s face',b:[CH,['md','- Tattoos and scars\n- 10 min by metro\n> Can they do both of us the same day?\n*[Nora](life:person) · WhatsApp, Mon*'],['answers','Contact Dr. Ink',['Later']]]}};
var PH2=['hero',PAUL,'Pay Paul 240 €','For the leak · due Fri'];
var ROWS=[['To','Plomberie Garnier'],['IBAN','FR76 3000 6000 0112 3456 7890 189',1],['Reference','Invoice 2611-07']];
var PA=['answers','I paid it',['Later']];
V.doneseen={
 A:{w:'Status line kept; says up front he can skip the tap; the settled row has the proof',b:[PH2,['box',ROWS,'240,00 €'],['foot','I look in your bank, so you can skip I paid it.'],PA],a:[['row',PAUL,'Pay Paul 240 €','Looking in your bank…','spin'],['then','Wed 14:02'],['row',PAUL,'Pay Paul 240 €','Seen in your bank · Wed 14:02','ok']]},
 B:{w:'Badge kept; a still dot while nothing is paid yet (no spinner before it looks)',b:[PH2,['box',ROWS,'240,00 €'],['seen','waiting','I’ll see it in your bank','badge'],PA],a:[['row',PAUL,'Pay Paul 240 €','Seen in your bank · Wed 14:02','ok']]},
 C:{w:'Nothing to tap kept; says so, and the row alone settles in place (no second sentence)',b:[PH2,['box',ROWS,'240,00 €'],['foot','Pay it your way. I see it in your bank and close this.'],['answers',null,['Later']]],a:[['row',PAUL,'Pay Paul 240 €','✓ Seen in your bank · Wed 14:02','ok']]}};
var SH=['hero','ic:voice','Did Sam say 9 or 10?','This morning’s call'];
var W='Then let’s say Saturday at nine, I bring the big ladder';
V.clip={
 A:{w:'Title asks, the clip is only its words read along; 9:00 on the right',b:[SH,['readalong',W],['answers','9:00',['Later','10:00']]]},
 B:{w:'Same, with Life’s guess in blue under the words, so the cream answer is just agreeing',b:[SH,['readalong',W],['pick','nine.'],['answers','9:00',['Later','10:00']]]},
 C:{w:'Asked as a yes: the title names the guess, the answers are Yes and No',b:[['hero','ic:voice','Did Sam say nine?','This morning’s call'],['readalong',W],['answers','Yes, nine',['Later','No, ten']]]}};
})();

/* the fresh-eyes reviewer's best (26 Nov), recommended in the lab */
window.V2['link'].rec='B2';
window.V2['plan'].rec='C2';
window.V2['clip'].rec='C2';
