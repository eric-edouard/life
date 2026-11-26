/* v2 batch 5: edit-words, follows, handed, reaction, settings-1..3 */
(function () {
var B = CB.B, IC = CB.I, V = (window.V2 = window.V2 || {});
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
 A: { w: 'The ask is a quiet line above the reply, with no bar; the answer words are bold', b: [['raw', '<div class="bt"><div style="font-size:13px;color:var(--muted);margin-bottom:6px">' + ASK + '</div>' + R + '</div>']] },
 B: { w: 'It lands at the bottom, never inside the old thread; his old question gets Life’s 👍 in place', ctx: 'none', b: [T1, T2, T3, T4], a: [['bm', ASK, '👍'], T2, T3, T4, ['bt', R]] },
 C: { w: 'Plain reply with bold answer; the way back is its quiet line, nothing else moves', b: [['follows', ASK, R, 'goto']] }
};

var HT = 'Find me a physio who can see me this week', UND = ' · <b style="color:#fff8ea">Undo</b>';
var HROW = ['row', 'ic:pin', 'Find a physio for this week', 'About 20 min' + UND, 'ring', .1];
var HDONE = ['row', 'ic:pin', 'Find a physio for this week', 'Times found, below', 'ok'];
V.handed = {
 A: { w: 'The row is an item under way: estimate and Undo; one short sentence, 👀 then 👍 on his words', b: [['bm', HT, '👀'], ['lead', 'I’m on it. I’ll come back with the best times.'], HROW], a: [['bm', HT, '👍'], HDONE] },
 B: { w: 'No row, but the sentence carries Undo and settles in place, so it can be stopped like any item', b: [['bm', HT, '👀'], ['bt', B.ring(.1) + ' On it, about 20 minutes.' + UND]], a: [['bm', HT, '👍'], ['bt', '<span class="okt">' + IC.check + '</span> Times found, below']] },
 C: { w: 'Mark and row only, with Undo in the line and 👍 when done', b: [['bm', HT, '👀'], HROW], a: [['bm', HT, '👍'], HDONE] }
};

var MT = 'Remind me to call Mum on Sunday', MW = ['bt', 'Sunday at <b>10:00</b>.'];
V.reaction = {
 A: { w: 'Shows both moves, 👀 taken on then 👍 done, swapping on the corner; the time is bold', b: [['bm', MT, '👀']], a: [['bm', MT, '👍'], MW] },
 B: { w: 'Same swap in the tick’s place, and Life’s line says what was done; never his OK', b: [['bm', MT, '👀', 'tick']], a: [['bm', MT, '👍', 'tick'], MW] },
 C: { w: 'The mark leads Life’s own words under the bubble, no label word like “Done”', b: [['bm', MT], ['raw', '<div class="cb-rxw"><span class="cb-em">👀</span></div>']], a: [['bm', MT], ['raw', '<div class="cb-rxw"><span class="cb-em">👍</span>Sunday at <b style="color:#fff8ea">10:00</b></div>']] }
};

/* ---- settings ---- */
function ic(p, sw) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + (sw || 1.8) + '" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>'; }
var I = {
 back: ic('<path d="M15 5l-7 7 7 7"/>', 2), mic: ic('<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v3"/>', 1.6),
 check: ic('<path d="m5 12.5 4.5 4.5L19 7.5"/>', 2.4), pen: ic('<path d="M4 20h4L19 9l-4-4L4 16v4Z"/>'), x: ic('<path d="M6 6l12 12M18 6 6 18"/>', 2.2),
 bell: ic('<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>'), arrow: ic('<path d="M8 16 16 8M9.5 8H16v6.5"/>', 2),
 mac: ic('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>'), msg: ic('<path d="M21 12a8 8 0 0 1-11.5 7.2L4 21l1.8-5.5A8 8 0 1 1 21 12Z"/>'),
 bang: ic('<path d="M12 7v6M12 17h.01"/>', 2), mail: ic('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>'), face: ic('<path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2"/>')
};
var SB = '<div class="sb"><span>9:41</span><span>●●● ▮</span></div>', BAR = '<div class="bar"></div>';
var FIELD = '<div class="cmp">Ask Life or hold to talk<div class="mic">' + I.mic + '</div></div>';
var BACKP = '<div class="pills"><div class="pill">' + I.back + '</div><span style="width:40px"></span></div>';
var HOMEP = '<div class="pills"><div class="pill">5</div><div class="pill"><i></i></div></div>';
function scr(inner, cls) { return [['Screen', { sx: '<div class="' + (cls || 'ph') + '">' + inner + '</div>' }]]; }
function sw(on) { return '<span style="flex:none;width:51px;height:31px;border-radius:16px;position:relative;background:' + (on ? '#fff8ea' : 'rgba(255,248,234,.1)') + '"><i style="position:absolute;top:2px;left:' + (on ? 22 : 2) + 'px;width:27px;height:27px;border-radius:50%;background:' + (on ? '#000' : '#fff8ea') + '"></i></span>'; }
function tick() { return '<span style="display:inline-block;width:15px;height:15px;margin-left:6px;vertical-align:-2px;color:#30d158">' + I.check + '</span>'; }
function disc(c) { return '<div class="disc">' + c + '</div>'; }
function row(f, t, s, tr, st) { return '<div class="fr"' + (st ? ' style="' + st + '"' : '') + '>' + f + '<div class="tx"><b>' + t + '</b>' + (s ? '<small>' + s + '</small>' : '') + '</div>' + (tr || '') + '</div>'; }
function card(x) { return '<div style="background:#111214;border-radius:22px;padding:4px 16px;display:flex;flex-direction:column">' + x + '</div>'; }
function grp(t) { return '<div class="h4">' + t + '</div>'; }
function th(x, top) { return '<div class="th"' + (top ? ' style="top:' + top + 'px"' : '') + '>' + x + '</div>'; }
var WASH = 'margin:0 -16px;padding:16px;background:radial-gradient(120% 90% at 50% 0%,rgba(255,248,234,.07),transparent 70%);display:flex;flex-direction:column;gap:12px';
function hero(f, t, l) { return '<div style="display:flex;align-items:center;gap:14px"><div class="disc" style="width:48px;height:48px">' + f + '</div><div><div style="font-size:19px;font-weight:650;line-height:1.25">' + t + '</div><div style="font-size:14px;color:#8a867e">' + l + '</div></div></div>'; }
function why(t) { return '<div style="font-size:14.5px;color:#b9b4aa;line-height:1.4">' + t + '</div>'; }
function prim(t, a) { return '<div class="act" style="height:50px;border-radius:25px;font-size:16px">' + t + (a || '') + '</div>'; }
function later() { return '<div class="act soft" style="height:44px;font-weight:600">Later</div>'; }
var TODAY = '<span style="color:#f0896f">today</span>';

/* settings-1: how you want things */
V['settings-1'] = {
 A: { w: 'Each line is a switch (off is the undo, in place); no dates, no prose titles; Life’s guess in blue; one field', note: 'A choice you gave is a switch: turning it off undoes it where it is, with a green tick. What Life only noticed stays apart, in Life’s blue, with a cross to say it is wrong. The field is the only way to add.',
  views: scr(SB + BACKP + th(grp('What you said') + card(row(disc('S'), 'Draft for Sam after 3 hours', '', sw(1)) + row(disc('M'), 'Never draft for Mum', '', sw(1)) + row(disc('B'), 'Bank mail is urgent', '', sw(1)) + row(disc('G'), 'Nothing about the gym', '', sw(1))) + grp('What Life noticed') + row(disc('N'), '<span style="color:#9aa8ec">You answer Nora within the hour</span>', 'So drafts for her come sooner', '<div class="ib" aria-label="Wrong">' + I.x + '</div>')) + FIELD + BAR) },
 B: { w: 'His card is not removed: it stays, faded, with the reason; the confirmation is the setting’s own switch and its green tick', note: 'Telling Life in the thread changes the setting and shows it as its switch. Undo is the switch. Nothing vanishes: Sam’s card from this morning fades in place with why it is no longer needed.',
  views: scr(SB + HOMEP + th('<div class="sp"></div><div class="bm">Stop drafting for Sam, I’ll answer him myself</div>' + card(row(disc('S'), 'Draft for Sam after 3 hours' + tick(), '', sw(0))) + row(disc('S'), 'Reply to Sam', 'You’ll answer him yourself', '', 'opacity:.35') + '<div class="bm">What else have I told you about messages?</div><div class="md"><p>Four things:</p></div>' + card(row(disc('S'), 'Draft for Sam after 3 hours', '', sw(0)) + row(disc('M'), 'Never draft for Mum', '', sw(1)) + row(disc('B'), 'Bank mail is urgent', '', sw(1)) + row(disc('G'), 'Nothing about the gym', '', sw(1)))) + FIELD + BAR) },
 C: { w: 'Sam’s page: one switch with its green tick, the card he needs below with no Later (a reply), “tonight” in coral, the field', note: 'The choice sits on the person. The profile shows who they are, the one choice that applies, and what needs him, as the same row. Nothing else.',
  views: scr(SB + BACKP + th('<div style="display:flex;flex-direction:column;align-items:center;gap:6px;padding:4px 0 6px"><div class="disc" style="width:96px;height:96px;font-size:34px">S</div><b style="font-size:26px;font-weight:700">Sam</b><span class="muted" style="font-size:14px">Friend · climbing on Saturdays</span></div>' + card(row(disc(I.pen), 'Draft replies after 3 hours' + tick(), 'If you haven’t answered him', sw(1))) + grp('Needs you') + row(disc('S'), 'Reply to Sam about Saturday', 'Sam · <span style="color:#f0896f">tonight</span>')) + FIELD + BAR) }
};

/* settings-2: something broken comes first */
var LATER = '<div class="act soft" style="height:44px;font-weight:600">Later</div>';
V['settings-2'] = {
 A: { w: 'The card is a fix ask, unfolded on a wash, no coral outline: what broke as its face, an answer that says what it does, Later; Settings below says nothing is fine', note: 'At the top of Settings, a fix ask like any other: the face is what broke, one line why, one cream answer, Later. No coral edge. Below, only mode, devices and sending, with no “Running”.',
  views: scr(SB + BACKP + th('<div style="' + WASH + '">' + hero(I.bell, 'Turn Life’s notifications back on', 'Notifications · since 14:10') + why('Sam has waited 3 hours, and you wouldn’t know.') + prim('Turn them on ', I.arrow) + LATER + '</div>' + grp('Mode') + row(disc(I.msg), 'Your apps notify you', 'Life steps in when you haven’t answered') + grp('Devices') + row(disc(I.mac), 'Mac') + row(disc('<i style="width:9px;height:9px;border-radius:5px;background:#fff8ea;box-shadow:0 0 10px rgba(255,248,234,.5)"></i>'), 'Pendant', '64%') + grp('Sending') + row(disc(I.face), 'Face ID before Send', '', sw(1)), 100) + BAR) },
 B: { w: 'The count pill turns coral, and its tap plays “What’s waiting on me?” with the fix ask first, unfolded in the thread, not a sheet; away, the main answer is a reminder', note: 'Same idea, the pill is the warning. A tap opens the usual list, the fix ask on top, steps for where he is (away: a reminder as the main answer), the rest below.',
  views: scr(SB + '<div class="pills"><div class="pill" style="background:rgba(240,137,111,.18);color:#f0896f;box-shadow:none">' + I.bang + '</div><div class="pill"><i></i></div></div>' + th('<div class="sp"></div><div class="bm">What’s waiting on me?</div><div style="' + WASH + '">' + hero(I.mac, 'Check your Mac is on', 'Your Mac · since 14:10') + why('Nothing is read or sent until it’s back.') + '<div class="list" style="font-size:15px"><div class="fr"><div class="disc" style="width:28px;height:28px;font-size:13px">1</div><div class="tx">Ask someone at home to check it’s on</div></div><div class="fr"><div class="disc" style="width:28px;height:28px;font-size:13px">2</div><div class="tx">Meanwhile, turn WhatsApp’s notifications back on</div></div></div>' + prim('Remind me when I’m home') + LATER + '</div>' + row(disc('J'), 'Reply to Jade', 'Jade · ' + TODAY)) + FIELD + BAR) },
 C: { w: 'One notification per problem, in plain words, with its two answers; the mail is a quiet second path', note: 'When the Mac is off the phone says so itself: what is wrong, since when, what to do meanwhile, and the same two answers any fix ask has. The mail follows as a second path.',
  views: scr('<div class="sb"><span></span><span>●●● ▮</span></div><div class="clock"><div class="d">Tuesday 24 November</div><div class="t">14:32</div></div><div class="nots"><div class="nt"><div class="av"><div class="disc" style="color:#f0896f">' + I.mac + '</div></div><div class="bd"><div class="h"><b>Your Mac isn’t answering</b><span>now</span></div>Nothing is read or sent since 14:10. Until it’s back, turn your messaging apps’ notifications on.<div style="display:flex;gap:8px;margin-top:10px"><span style="height:32px;padding:0 13px;border-radius:16px;background:rgba(255,248,234,.14);display:flex;align-items:center;font-weight:600;font-size:13px">Remind me when I’m home</span><span style="height:32px;padding:0 13px;border-radius:16px;background:rgba(255,248,234,.14);display:flex;align-items:center;font-weight:600;font-size:13px">Later</span></div></div></div><div class="nt" style="opacity:.75"><div class="av"><div class="disc">' + I.mail + '</div></div><div class="bd"><div class="h"><b>Mail</b><span>14:31</span></div>Your Mac isn’t answering. What to do →</div></div></div>' + BAR, 'ph lock') }
};

/* settings-3: direct or smart mode */
function opt(on, name, line, tag) { return '<div style="display:flex;gap:12px;align-items:flex-start;padding:14px 16px;border-radius:18px;background:' + (on ? '#1b1c20' : '#111214') + '"><span style="width:18px;height:18px;border-radius:9px;flex:none;margin-top:2px;box-shadow:inset 0 0 0 ' + (on ? 5 : 1.6) + 'px ' + (on ? '#fff8ea' : '#8a867e') + '"></span><div><b style="font-size:15.5px">' + name + '</b>' + (tag ? ' <span style="font-size:12px;font-weight:650;color:#9aa8ec;margin-left:6px">Life’s pick</span>' : '') + '<small style="display:block;font-size:13.5px;color:#b9b4aa;line-height:1.4;margin-top:2px">' + line + '</small></div></div>'; }
function app(l, name, line, tr) { return row(disc(l), name, line, tr); }
function ck(on) { return on ? '<div class="ck on">' + I.check + '</div>' : '<div class="ck"></div>'; }
V['settings-3'] = {
 A: { w: 'An ordinary ask: header, one pick preselected and named by its cream button, what follows, Later; the chosen card is only lighter', note: 'One decision. Life’s pick is already chosen and blue; the button names it. Nothing changes until he answers, and he can change it later by telling Life.',
  views: scr(SB + '<div class="pills"><div class="pill">1</div><div class="pill"><i></i></div></div>' + th('<div class="sp"></div><div style="' + WASH + '">' + hero(I.bell, 'Who should tell you about new messages?', 'Messages · no rush') + opt(1, 'Your apps', 'Life drafts only when you haven’t answered in your usual time.', 1) + opt(0, 'Life only', 'You turn your apps’ notifications off. Life tells you of each message, with a draft ready.') + '<div style="font-size:13.5px;color:#8a867e">You can change this any time by telling Life.</div>' + prim('Keep my apps') + LATER + '</div>') + FIELD + BAR) },
 B: { w: 'One list, no groups, so a tap never moves someone; each is a switch for “Life drafts for them”, with the green tick; no title', note: 'Life sorted people itself; he only fixes what is wrong. A switch per person, in place, nobody jumps between groups.',
  views: scr(SB + BACKP + th(grp('Life drafts replies for') + card(row(disc('S'), 'Sam', 'Plans, mostly', sw(1)) + row(disc('M'), 'Marc, plumber' + tick(), 'Times and visits', sw(1)) + row(disc('N'), 'Nora', 'Work', sw(1)) + row(disc('M'), 'Mum', 'You said so', sw(0)) + row(disc('J'), 'Jade', 'Close family', sw(0)))) + BAR) },
 C: { w: 'Round faces, no “Keep on” button: Signal is a line that says why; each row opens that app’s notifications, its tick is the one trailing mark; no title', note: 'Each app opens its own notification settings on tap; the tick is his. An app Life cannot read stays on, said in its line. When all are done, Life sends the test itself.',
  views: scr(SB + BACKP + th('<div class="md"><p><b>Turn off each app’s notifications.</b> Life can’t do it for you.</p></div>' + card(app('W', 'WhatsApp', 'Notifications off', ck(1)) + app('M', 'Messages', 'Notifications off', ck(1)) + app('L', 'LINE', 'Notifications off', ck(1)) + app('S', 'Signal', 'Life can’t read it, so it stays on')) + '<div class="nt" style="background:#1a1b20;margin-top:8px"><div class="av"><div class="disc">S</div></div><div class="bd"><div class="h"><b>Sam</b><span>WhatsApp · now</span></div>Test message: this is how Sam’s messages will look.</div></div>') + BAR) }
};
})();
