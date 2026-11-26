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
var UNDO=' · <span style="color:var(--fg);font-weight:650">Undo</span>';
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

/* voice cards */
var VH=['hero','ic:voice','Who is this voice?','Lunch · heard twice'];
var VDONE=[['row','ic:voice','Nora','Named in 2 conversations','ok'],['lead','Done: those lines are Nora’s now.']];
var VPEOPLE=[[NORA,'Nora','Your partner'],[LEA,'Lea Moreau','Fernway'],[MAX1,'Max Weber','Your landlord']];
var VNEW=[['then','After “Someone new”'],['lead','Who is it? A name, and who they are to you if you like.'],['bm','Tom, Nora’s brother'],['row','T/120','Tom','Nora’s brother · named in 2 conversations','ok']];
function clips(m){var b=CB.B;return ['raw',b.clip('Then let’s say Saturday at nine, I bring the big ladder','0:06',m,1)+b.clip('No, the blue one, it’s cheaper','0:03',m,4)];}
V['voice-guess']={
 A:{w:'The foot is gone; one why line; Later first, Don’t name lives under “Someone else…”',b:[VH,['why','It sounds like Nora, the same voice at both lunches.'],clips('wave'),['answers','Yes, Nora',['Later','Someone else…','TV or video']]],a:VDONE},
 B:{w:'One group of answers instead of two; no word count; Later added',b:[['hero',NORA,'Is this Nora?','Lunch · heard twice'],clips('pill'),['answers','Yes',['Later','Someone else…'],'row']],a:VDONE},
 C:{w:'Still the words to read, but a single list: Yes, then Later first among the rest',b:[VH,clips('text'),['answers','Yes, it’s Nora',['Later','Someone else…','TV or video'],'list']],a:VDONE}
};
V['voice-new']={
 A:{w:'Later first, no word count; the three ways out sit under the list as quiet pills',b:[VH,clips('wave'),['people',VPEOPLE,'rows','Who is it?'],['answers',null,['Later','TV or video','Don’t name']]],a:VNEW},
 B:{w:'Faces in a grid, no word count, Later added so he is never trapped',b:[VH,clips('pill'),['people',VPEOPLE,'grid'],['answers',null,['Later','TV or video','Don’t name']]],a:VNEW},
 C:{w:'Name chips under the words; Later first, one line of why instead of nothing',b:[VH,['why','Two lunches, no one I can place.'],clips('text'),['people',VPEOPLE,'chips'],['answers',null,['Later','TV or video','Don’t name']]],a:VNEW}
};

/* new matter */
V.newmatter={
 A:{w:'One box says what Start does, no foot repeating it; Later first, “Edit goal” goes (he can say it)',b:[NMH,['box',[['Then','Life writes to Kit for the inspection date, for your yes']]],NM_A],a:[['row',KIT,'Deposit back from Kit','Drafting the message to Kit','ring',.15]]},
 B:{w:'One sentence says it all; Start, Later and No side by side, the closing line goes',b:[NMH,['why','I can ask Kit for the date now and follow it until your 800 € is back.'],['answers','Start',['Later','No'],'row']],a:[['row',KIT,'Deposit back from Kit','Drafting the message to Kit','ring',.15]]},
 C:{w:'Kit’s own words as the why, one wide Start and Later; what Start leads to in one line',b:[NMH,KITQ,['foot','Life then drafts one message to Kit, for your yes.'],NM_A],a:[['row',KIT,'Deposit back from Kit','Drafting the message to Kit','ring',.15]]}
};

/* ending check */
V.ending={
 A:{w:'Same card, but the question is stated once and the settled step shows its Undo',b:[['step','Send Paul the photos of the leak','Yours · since Mon'],['quote','Got the photos, thanks! Coming Thursday','Paul · Wed',PAUL],['why','Is this done?'],['answers','Yes, done',['Not yet'],'row']],
  a:[['step','Send Paul the photos of the leak','Done · Wed'+UNDO,'struck'],['step','Let Paul in on Thursday','Yours · Thu']]},
 B:{w:'The question is written above the step, so the two round marks have a meaning; the settled step has its Undo',b:[['why','Paul’s message seems to show this done. Is it?'],['step','Send Paul the photos of the leak','Paul: “Got the photos, thanks” · Wed','ask'],['step','Let Paul in on Thursday','Yours · Thu']],
  a:[['step','Send Paul the photos of the leak','Done · Wed'+UNDO,'struck'],['step','Let Paul in on Thursday','Yours · Thu']]},
 C:{w:'Life’s reading is blue and says why; reopening is a quiet pill with its own word, Undo-like',b:[['step','Send Paul the photos of the leak','<span style="color:var(--ai)">Looks done</span>: Paul got them · Wed','struck'],['answers',null,['Not done yet']],['step','Let Paul in on Thursday','Yours · Thu']],
  a:[['step','Send Paul the photos of the leak','Reopened · Yours · since Mon'],['step','Let Paul in on Thursday','Yours · Thu']]}
};
})();
