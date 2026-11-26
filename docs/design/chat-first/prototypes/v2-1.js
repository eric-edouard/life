/* v2 batch 1: anatomy, matterpage, voice-guess, voice-new, newmatter, ending. Plain ES5. */
(function(){
var V=(window.V2=window.V2||{});
var NORA='N/339',KIT='K/30',PAUL='P/200',JADE='J/160',LEA='L/280',MAX1='M/30';
var JCHAT=[['Hey! Are we still on for dinner Saturday?','9:12'],['Should I book? 8 or 8:30?','9:40']];
var DRAFT='Yes, Saturday works. Book for 8, I’ll be there.';
var PAY_ROWS=[['To','Plomberie Garnier'],['IBAN','FR76 3000 6000 0112 3456 7890 189',1],['Reference','Invoice 2611-07']];
var JH=['hero',JADE,'Reply to Jade','Jade · today'],JA=['answers','Send to Jade',['Later']];
var PAY=[['hero',PAUL,'Pay Paul 240 €','For the leak · due Fri'],['box',PAY_ROWS,'240,00 €'],['answers','I paid it',['Later']]];
var DRAFTASK=[JH,['chat','Jade',JCHAT,DRAFT],JA];
var NMH=['hero',KIT,'Start on this?','Kit · Tue'];
var NM_A=['answers','Start',['Later','Not this']];
var UNDO=CB.undo();
var KITQ=['quote','The deposit comes back after the inspection, I’ll tell you when','Kit · WhatsApp, Tue',KIT];

/* anatomy: the matter's title as a quiet line above each ask (no chevron: a chevron promises another screen) */
function mh(t,g,mode){return ['mhead',t,g,mode];}
var LEAK=['Kitchen leak','The leak fixed and paid for'],DIN=['Saturday dinner with Jade','A table for two, Saturday at 8'],DEP=['Deposit back from Kit','800 € back after the inspection'];
var NMBOX=['box',[['Then','Life writes to Kit for the inspection date, for your yes']]];
function anat(mode){
 var g=mode==='goal'?'goal':'title';
 return [['A draft',[mh(DIN[0],DIN[1],g)].concat(DRAFTASK)],
  ['A payment',[mh(LEAK[0],LEAK[1],g)].concat(PAY)],
  ['A new matter',[mh(DEP[0],DEP[1],mode==='B'||mode==='C'?'goal':'title'),NMH,NMBOX,['foot','Nothing goes to Kit without your yes.'],NM_A]]];
}
var a1=anat('A'),a2=anat('goal'),a3=anat('C');
a1[2][1].splice(3,1); /* A: the foot goes: the box already says what Start does */
a2[0][1].splice(0,1,mh(DIN[0],DIN[1],'goal'));
a3[2][1].splice(3,1);
V.anatomy={
 A:{w:'No chevron (it promises a page): the title is a quiet line, its goal opens in place on a tap; Later on every ask',tabs:a1.concat([['Title tapped',[mh(LEAK[0],LEAK[1],'goal')].concat(PAY)]])},
 B:{w:'Goal under the title on every ask, but nothing repeated: one box says what Start does, Later is the first quiet pill',tabs:a2},
 C:{w:'Title only; the goal only on the new matter, where it decides the answer; one cream button and Later on each',tabs:a3}
};

/* matter page: the page shows what needs him first; the thread is only its last lines */
function mp(o){var m={t:'Kitchen leak',g:'The leak fixed and paid for',status:'Paul fixed it on Thursday; his bill is the last thing left.',next:'Pay Paul 240 € by Friday',
  asks:[[PAUL,'Pay Paul 240 €','Paul · due Fri']],people:[[PAUL,'Paul'],[NORA,'Nora']],ending:['Send Paul the photos of the leak','Got the photos, thanks! Coming Thursday','Paul · Wed',PAUL],
  thread:[['Mon','out','We have a leak under the sink, can you come?'],['Mon','in','Send me photos please'],['Tue','step','You: send Paul the photos'],['Wed','in','Got the photos, thanks! Coming Thursday'],['Thu','done','Paul came and fixed it'],['Thu','in','Invoice attached, 240 €. Thanks!']]};
 for(var k in o)m[k]=o[k];return m;}
var ASK=[mh('Kitchen leak','The leak fixed and paid for','tap')].concat(PAY);
var LAST=mp().thread.slice(-3);
V.matterpage={
 A:{w:'Sections like a profile, the ending check first; only the last three lines of its thread, the rest is one ask away',tabs:[['The ask',ASK],['Its page',[['mpage',mp({thread:LAST}),'A']]]]},
 B:{w:'Thread first as a chat, but cut to its last lines so what needs him is not buried under six bubbles',tabs:[['The ask',ASK],['Its page',[['mpage',mp({thread:LAST,status:'Paul fixed it; his bill is left.'}),'B']]]]},
 C:{w:'Summary and what needs him only; the people go (he can ask), the thread is its last three lines',tabs:[['The ask',ASK],['Its page',[['mpage',mp({thread:LAST,people:[]}),'C']]]]}
};

/* voice cards: the words read along; the question as plain as it can be */
var CLIPS=['readalong',['Then let’s say Saturday at nine, I bring the big ladder','No, the blue one, it’s cheaper']];
var VDONE=[['row',NORA,'Nora','Those lines are hers now','ok']];
var VPEOPLE=[[NORA,'Nora','Your partner'],[LEA,'Lea Moreau','Fernway'],[MAX1,'Max Weber','Your landlord']];
var VNEW=[['bm','Tom, Nora’s brother'],['row','T/120','Tom','Nora’s brother','ok']];
function two(b,a){return {tabs:[['Before',b],['After the tap',a]]};}
function mix(w,o){o.w=w;return o;}
V['voice-guess']={
 A:mix('One question with Nora’s face, the words to read, Yes on the right',two([['hero',NORA,'Is this Nora?',''],CLIPS,['answers','Yes, that’s her',['Later','Someone else…'],'row']],VDONE)),
 B:mix('Just the question in Life’s words, then the words to read',two([['bt','This sounds like <b>Nora</b>. Is it?'],CLIPS,['answers','Yes',['Later','Someone else…'],'row']],VDONE)),
 C:mix('Nora as a row he can tap, one wide Yes under the words',two([CLIPS,['row',NORA,'Nora','Your partner'],['answers','Yes, that’s her',['Later','Someone else…']]],VDONE))
};
V['voice-new']={
 A:mix('One question, the words to read, names as chips',two([['bt','<b>Who is this?</b>'],CLIPS,['people',VPEOPLE,'chips'],['answers',null,['Later','Not a person']]],VNEW)),
 B:mix('The words to read, then faces side by side',two([CLIPS,['people',VPEOPLE,'grid'],['answers',null,['Later','Not a person']]],VNEW)),
 C:mix('Only the words and who it may be; no title, the line above already asks',two([CLIPS,['people',VPEOPLE,'rows'],['answers',null,['Later']]],VNEW))
};

/* new matter: what it is and what is asked, in the title */
var NMDONE=[['row',KIT,'Deposit back from Kit','Writing to Kit','ring',.15]];
V.newmatter={
 A:mix('The title says it: get the deposit back from Kit; one line of what Life does',two([['hero',KIT,'Get your 800 € back from Kit?','Kit · Tue'],['why','I’ll ask Kit for the inspection date, and follow it until the money is back.'],['answers','Yes, handle it',['Later','No'],'row']],NMDONE)),
 B:mix('Kit’s own words as the reason, then the question under them',two([['quote','The deposit comes back after the inspection, I’ll tell you when','Kit · WhatsApp, Tue',KIT],['bt','Want me to get your <b>800 €</b> back from Kit?'],['answers','Yes, go ahead',['Later','No'],'row']],NMDONE)),
 C:mix('Plain sentences only: what Kit said and what Life offers',two([['bt','Kit says your <b>800 € deposit</b> comes back after the inspection. Shall I follow it up for you?'],['answers','Yes, follow it up',['Later','No'],'row']],NMDONE))
};

/* ending check: the matter’s name is already above (the page); then why Life thinks it is done, then the question */
var ENDONE=[['step','Send Paul the photos of the leak','Done · Wed'+UNDO,'struck'],['step','Let Paul in on Thursday','Yours · Thu']];
V.ending={
 A:mix('Plain words: why it looks done, Paul’s message, then the question',two([['bt','Paul wrote back, so I think <b>sending him the photos</b> is done.'],['quote','Got the photos, thanks! Coming Thursday','Paul · Wed',PAUL],['answers','Yes, it’s done',['Not yet'],'row']],ENDONE)),
 B:mix('One sentence only, with Paul’s words inside it; no card',two([['bt','Paul wrote “Got the photos, thanks!” on Wednesday. Is <b>sending him the photos</b> done?'],['answers','Yes, it’s done',['Not yet'],'row']],ENDONE)),
 C:mix('The step shown as done in Life’s blue, with the reason; Yes confirms it',two([['why','Life thinks this is done:'],['step','Send Paul the photos of the leak',CB.ai('Paul got them')+' · Wed','struck'],['answers','Yes, it’s done',['Not yet'],'row']],ENDONE))
};
})();

/* the fresh-eyes reviewer's best (26 Nov), recommended in the lab */
window.V2['voice-guess'].rec='A2';
window.V2['voice-new'].rec='A2';
window.V2['newmatter'].rec='C2';
window.V2['ending'].rec='B2';
