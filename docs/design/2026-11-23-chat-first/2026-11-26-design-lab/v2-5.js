/* v2 batch 5: edit-words, follows, handed, reaction, settings-1..3 */
(function () {
var B = CB.B, I = CB.I, V = (window.V2 = window.V2 || {});
var JADE = 'J/160', JH = ['hero', JADE, 'Reply to Jade', 'Jade · today'], JA = ['answers', 'Send to Jade', ['Later']];
var JCHAT = [['Hey! Are we still on for dinner Saturday?', '9:12'], ['Should I book? 8 or 8:30?', '9:40']];
var DRAFT = 'Yes, Saturday works. Book for 8, I’ll be there.', JW = 'Make it warmer, and say I’ll bring wine';
var DRAFT3 = 'Yes, Saturday works, I’m looking forward to it! Book for 8, and I’ll bring the wine.';
var OLD = ['row', JADE, 'Reply to Jade', 'Earlier draft', 'old'];

V['edit-words'] = {
 A: { w: 'The new card keeps its header, so it is the same ask again; the old one stays as a faded row', b: [JH, ['chat', 'Jade', JCHAT, DRAFT], JA], a: [OLD, ['bm', JW], JH, ['chat', 'Jade', JCHAT, DRAFT3], JA] },
 B: { w: 'Changed where it is, with the back arrow so the old words are never lost; one quiet line says what changed', b: [JH, ['chat', 'Jade', JCHAT, DRAFT], JA], a: [JH, ['chat', 'Jade', JCHAT, DRAFT3], ['edits', ['back']], JA, ['bm', JW], ['foot', 'Warmer, and you bring the wine.']] },
 C: { w: 'Old card folds to a faded row, new card has its header and Life’s own changes in blue', b: [JH, ['chat', 'Jade', JCHAT, DRAFT], JA], a: [OLD, ['bm', JW], JH, ['chat', 'Jade', JCHAT, 'Yes, Saturday works<mark>, I’m looking forward to it!</mark> Book for 8, <mark>and I’ll bring the wine.</mark>'], JA] }
};

var R = 'The lawyer answered: <b>the contract is fine</b>, and she sends the signed copy <b>Monday</b>.';
var ASK = 'Has the lawyer answered?';
var T1 = ['bm', ASK], T2 = ['lead', 'Not yet. I’ll tell you when she does.'], T3 = ['bm', 'What’s on today?'], T4 = ['lead', 'Just the dentist at 16:00.'];
V.follows = {
 A: { w: 'The ask is a quiet line above the reply, with no bar; the answer words are bold', b: [['follows', ASK, R]] },
 B: { w: 'It lands at the bottom, never inside the old thread; his old question gets Life’s 👍 in place', ctx: 'none', b: [T1, T2, T3, T4], a: [['bm', ASK, '👍'], T2, T3, T4, ['bt', R]] },
 C: { w: 'Plain reply with bold answer; the way back is its quiet line, nothing else moves', b: [['follows', ASK, R, 'goto']] }
};

var HT = 'Find me a physio who can see me this week', UND = CB.undo();
var HROW = ['row', 'ic:pin', 'Find a physio for this week', 'About 20 min' + UND, 'ring', .1];
var HDONE = ['row', 'ic:pin', 'Find a physio for this week', 'Times found, below', 'ok'];
V.handed = {
 A: { w: 'The row is an item under way: estimate and Undo; one short sentence, 👀 then 👍 on his words', b: [['bm', HT, '👀'], ['lead', 'I’m on it. I’ll come back with the best times.'], HROW], a: [['bm', HT, '👍'], HDONE] },
 B: { w: 'No row, but the sentence carries Undo and settles in place, so it can be stopped like any item', b: [['bm', HT, '👀'], ['bt', B.ring(.1) + ' On it, about 20 minutes.' + UND]], a: [['bm', HT, '👍'], ['bt', 'Times found, below' + CB.saved()]] },
 C: { w: 'Mark and row only, with Undo in the line and 👍 when done', b: [['bm', HT, '👀'], HROW], a: [['bm', HT, '👍'], HDONE] }
};

var MT = 'Remind me to call Mum on Sunday', MW = ['bt', 'Sunday at <b>10:00</b>.'];
V.reaction = {
 A: { w: 'Shows both moves, 👀 taken on then 👍 done, swapping on the corner; the time is bold', b: [['bm', MT, '👀']], a: [['bm', MT, '👍'], MW] },
 B: { w: 'Same swap in the tick’s place, and Life’s line says what was done; never his OK', b: [['bm', MT, '👀', 'tick']], a: [['bm', MT, '👍', 'tick'], MW] },
 C: { w: 'The mark leads Life’s own words under the bubble, no label word like “Done”', b: [['bm', MT, '👀', 'words', '']], a: [['bm', MT, '👍', 'words', 'Sunday at <b>10:00</b>']] }
};

/* ---- settings: the screen's chrome is the lab's phone; everything on it is a part ---- */
var SB = '<div class="sb"><span>9:41</span><span>●●● ▮</span></div>', BAR = '<div class="bar"></div>';
var FIELD = '<div class="cmp">Ask Life or hold to talk<div class="mic">' + I.mic + '</div></div>';
var BACKP = '<div class="pills"><div class="pill">' + I.chev + '</div><span style="width:40px"></span></div>';
var HOMEP = '<div class="pills"><div class="pill">5</div><div class="pill"><i></i></div></div>';
function scr(inner, cls) { return [['Screen', { sx: '<div class="' + (cls || 'ph') + '">' + inner + '</div>' }]]; }
function grp(t) { return '<div class="h4">' + t + '</div>'; }
function th(x, top) { return '<div class="th"' + (top ? ' style="top:' + top + 'px"' : '') + '><div class="cbf" style="min-height:100%">' + x + '</div></div>'; }
var SP = '<div class="sp" style="margin-top:auto"></div>';
/* an unfolded ask on its wash */
var WASH = 'margin:0 -16px;padding:16px;background:radial-gradient(120% 90% at 50% 0%,rgba(255,248,234,.07),transparent 70%)';
function ask(x) { return '<div class="cbf" style="' + WASH + '">' + CB.draw(x) + '</div>'; }
function set(rows) { return B.settings(rows); }
function on(t, f, more) { var o = { f: f }; for (var k in more) o[k] = more[k]; return [t, true, 0, o]; }
function off(t, f, more) { var r = on(t, f, more); r[1] = false; return r; }
function said(t, f, line) { return [t, null, 0, { f: f, line: line }]; }

/* settings-1: how you want things */
V['settings-1'] = {
 A: { w: 'Each line is a switch (off is the undo, in place); no dates, no prose titles; Life’s guess in blue; one field', note: 'A choice you gave is a switch: turning it off undoes it where it is, with a green tick. What Life only noticed stays apart, in Life’s blue, with a cross to say it is wrong. The field is the only way to add.',
  views: scr(SB + BACKP + th(grp('What you said') + set([on('Draft for Sam after 3 hours', 'S'), on('Never draft for Mum', 'M'), on('Bank mail is urgent', 'B'), on('Nothing about the gym', 'G')]) + grp('What Life noticed') + set([[CB.ai('You answer Nora within the hour'), null, 0, { f: 'N', line: 'So drafts for her come sooner', wrong: 1 }]])) + FIELD + BAR) },
 B: { w: 'His card is not removed: it stays, faded, with the reason; the confirmation is the setting’s own switch and its green tick', note: 'Telling Life in the thread changes the setting and shows it as its switch. Undo is the switch. Nothing vanishes: Sam’s card from this morning fades in place with why it is no longer needed.',
  views: scr(SB + HOMEP + th(SP + B.bm('Stop drafting for Sam, I’ll answer him myself') + set([off('Draft for Sam after 3 hours', 'S', { saved: 1 })]) + B.row('S', 'Reply to Sam', 'You’ll answer him yourself', 'old') + B.bm('What else have I told you about messages?') + B.lead('Four things:') + set([off('Draft for Sam after 3 hours', 'S'), on('Never draft for Mum', 'M'), on('Bank mail is urgent', 'B'), on('Nothing about the gym', 'G')])) + FIELD + BAR) },
 C: { w: 'Sam’s page: one switch with its green tick, the card he needs below with no Later (a reply), “tonight” in coral, the field', note: 'The choice sits on the person. The profile shows who they are, the one choice that applies, and what needs him, as the same row. Nothing else.',
  views: scr(SB + BACKP + th('<div style="display:flex;flex-direction:column;align-items:center;gap:6px;padding:4px 0 6px">' + CB.face('S', 'xl') + '<b style="font-size:26px;font-weight:700">Sam</b><span class="muted" style="font-size:14px">Friend · climbing on Saturdays</span></div>' + set([on('Draft replies after 3 hours', I.pen, { line: 'If you haven’t answered him', saved: 1 })]) + grp('Needs you') + B.row('S', 'Reply to Sam about Saturday', 'Sam · tonight')) + FIELD + BAR) }
};

/* settings-2: something broken comes first */
var PENDANT = '<i style="width:9px;height:9px;border-radius:5px;background:#fff8ea;box-shadow:0 0 10px rgba(255,248,234,.5)"></i>';
V['settings-2'] = {
 A: { w: 'The card is a fix ask, unfolded on a wash, no coral outline: what broke as its face, an answer that says what it does, Later; Settings below says nothing is fine', note: 'At the top of Settings, a fix ask like any other: the face is what broke, one line why, one cream answer, Later. No coral edge. Below, only mode, devices and sending, with no “Running”.',
  views: scr(SB + BACKP + th(ask([['hero', 'ic:bell', 'Turn Life’s notifications back on', 'Notifications · since 14:10'], ['why', 'Sam has waited 3 hours, and you wouldn’t know.'], ['answers', 'Turn them on', ['Later']]]) + grp('Mode') + set([said('Your apps notify you', I.msg, 'Life steps in when you haven’t answered')]) + grp('Devices') + set([said('Mac', I.mac), said('Pendant', PENDANT, '64%')]) + grp('Sending') + set([on('Face ID before Send', I.faceid)]), 100) + BAR) },
 B: { w: 'The count pill turns coral, and its tap plays “What’s waiting on me?” with the fix ask first, unfolded in the thread, not a sheet; away, the main answer is a reminder', note: 'Same idea, the pill is the warning. A tap opens the usual list, the fix ask on top, steps for where he is (away: a reminder as the main answer), the rest below.',
  views: scr(SB + '<div class="pills"><div class="pill" style="background:rgba(240,137,111,.18);color:#f0896f;box-shadow:none">' + I.bang + '</div><div class="pill"><i></i></div></div>' + th(SP + B.bm('What’s waiting on me?') + ask([['hero', 'ic:mac', 'Check your Mac is on', 'Your Mac · since 14:10'], ['why', 'Nothing is read or sent until it’s back.'], ['plan', [{ text: 'Ask someone at home to check it’s on', by: 'owner' }, { text: 'Meanwhile, turn WhatsApp’s notifications back on', by: 'owner' }]], ['answers', 'Remind me when I’m home', ['Later']]]) + B.row('J', 'Reply to Jade', 'Jade · today')) + FIELD + BAR) },
 C: { w: 'One notification per problem, in plain words, with its two answers; the mail is a quiet second path', note: 'When the Mac is off the phone says so itself: what is wrong, since when, what to do meanwhile, and the same two answers any fix ask has. The mail follows as a second path.',
  views: scr('<div class="sb"><span></span><span>●●● ▮</span></div><div class="clock"><div class="d">Tuesday 24 November</div><div class="t">14:32</div></div><div class="nots"><div class="nt"><div class="av">' + CB.face(I.mac) + '</div><div class="bd"><div class="h"><b>Your Mac isn’t answering</b><span>now</span></div>Nothing is read or sent since 14:10. Until it’s back, turn your messaging apps’ notifications on.<div class="cbf" style="margin-top:10px">' + B.answers('Remind me when I’m home', ['Later']) + '</div></div></div><div class="nt" style="opacity:.75"><div class="av">' + CB.face(I.mail) + '</div><div class="bd"><div class="h"><b>Mail</b><span>14:31</span></div>Your Mac isn’t answering. What to do →</div></div></div>' + BAR, 'ph lock') }
};

/* settings-3: direct or smart mode */
V['settings-3'] = {
 A: { w: 'An ordinary ask: header, one pick preselected and named by its cream button, what follows, Later; the chosen card is only lighter', note: 'One decision. Life’s pick is already chosen and blue; the button names it. Nothing changes until he answers, and he can change it later by telling Life.',
  views: scr(SB + '<div class="pills"><div class="pill">1</div><div class="pill"><i></i></div></div>' + th(SP + ask([['hero', 'ic:bell', 'Who should tell you about new messages?', 'Messages · no rush'], ['option', 1, 'Your apps', 'Life drafts only when you haven’t answered in your usual time.', 1], ['option', 0, 'Life only', 'You turn your apps’ notifications off. Life tells you of each message, with a draft ready.'], ['foot', 'You can change this any time by telling Life.'], ['answers', 'Keep my apps', ['Later']]])) + FIELD + BAR) },
 B: { w: 'One list, no groups, so a tap never moves someone; each is a switch for “Life drafts for them”, with the green tick; no title', note: 'Life sorted people itself; he only fixes what is wrong. A switch per person, in place, nobody jumps between groups.',
  views: scr(SB + BACKP + th(grp('Life drafts replies for') + set([on('Sam', 'S', { line: 'Plans, mostly' }), on('Marc, plumber', 'M', { line: 'Times and visits', saved: 1 }), on('Nora', 'N', { line: 'Work' }), off('Mum', 'M', { line: 'You said so' }), off('Jade', 'J', { line: 'Close family' })])) + BAR) },
 C: { w: 'Round faces, no “Keep on” button: Signal is a line that says why; each row opens that app’s notifications, its tick is the one trailing mark; no title', note: 'Each app opens its own notification settings on tap; the tick is his. An app Life cannot read stays on, said in its line. When all are done, Life sends the test itself.',
  views: scr(SB + BACKP + th(B.bt('<b>Turn off each app’s notifications.</b> Life can’t do it for you.') + set([['WhatsApp', null, 0, { f: 'W', line: 'Notifications off', check: 1 }], ['Messages', null, 0, { f: 'M', line: 'Notifications off', check: 1 }], ['LINE', null, 0, { f: 'L', line: 'Notifications off', check: 1 }], said('Signal', 'S', 'Life can’t read it, so it stays on')]) + '<div class="nt" style="background:#1a1b20;margin-top:8px"><div class="av">' + CB.face('S') + '</div><div class="bd"><div class="h"><b>Sam</b><span>WhatsApp · now</span></div>Test message: this is how Sam’s messages will look.</div></div>') + BAR) }
};
})();
