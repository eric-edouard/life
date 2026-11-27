/* v2 batch 4: swipe, adds, runs, looks, rate, edit-tap */
(function () {
var B = CB.B, V = (window.V2 = window.V2 || {});
var NORA = 'N/339', LEA = 'L/280', MAX1 = 'M/30', PAUL = 'P/200', JADE = 'J/160';
var PAY_H = ['hero', PAUL, 'Pay Paul 240 €', 'For the leak · due Fri'], PAYA = ['answers', 'I paid it', ['Later']];
var PAY_ROWS = [['To', 'Plomberie Garnier'], ['IBAN', 'FR76 3000 6000 0112 3456 7890 189', 1], ['Reference', 'Invoice 2611-07']];
var EV = { title: 'Parents’ meeting', day: 'Thursday', time: '18:00', place: 'Linden School, room 4', rem: ['1 hour before', 'At 17:30'], around: [['17:00', 'Free', 0], ['18:00', 'Parents’ meeting', 1], ['19:30', 'Dinner with Jade', 0]] };
var EV_H = ['hero', 'ic:cal', 'Add the parents’ meeting?', 'From Ms Hale’s mail · Thu'];
var EV_FOOT = ['foot', 'It goes in your calendar, with its two reminders.'];
var RUN = { what: 'Physios within 3 km, with their prices', est: 1.2, cap: 3, cur: '$', month: '50 €', left: '31 €' };
var RUN_H = ['hero', 'ic:search', 'Look up the physios near home?', 'For your shoulder'];
var JH = ['hero', JADE, 'Reply to Jade', 'Jade · today'], JA = ['answers', 'Send to Jade', ['Later']];
var JCHAT = [['Hey! Are we still on for dinner Saturday?', '9:12'], ['Should I book? 8 or 8:30?', '9:40']];
var DRAFT = 'Yes, Saturday works. Book for 8, I’ll be there.';
var DRAFT2 = 'Yes, Saturday works<mark>, I can’t wait!</mark> Book for 8 and I’ll be there.';
var JE = ['Warmer', 'Shorter', 'In French'];

/* swipe: the five waiting asks; Later is each card's first quiet pill, the bank shows its initial, no counts in words */
var W5 = [
 { f: 'B', s: 'Ben · tonight', t: 'Send Ben the call recap', b: [['mhead', 'Fernway'], ['hero', 'B', 'Send Ben the call recap', 'Ben · tonight'], ['why', 'He was promised the transcript on today’s call.'], ['answers', 'Send both', ['Later', 'Recap only']]] },
 { f: 'ic:pin', s: 'Tattoo · Tue', t: 'Pick a clinic for the tattoo', b: [['mhead', 'Tattoo removal'], ['hero', 'ic:pin', 'Pick a clinic for the tattoo', 'For you and Nora · Tue'], ['why', 'Dr. Ink, Riverside: about ฿1,000 per cm², 10 min by metro.'], ['foot', 'Life then drafts one booking message to the clinic, for your yes.'], ['answers', 'Contact Dr. Ink', ['Later', 'Other clinic']]] },
 { f: PAUL, s: 'Paul · Fri', t: 'Pay Paul 240 €', b: [['mhead', 'Kitchen leak'], PAY_H, ['box', PAY_ROWS, '240,00 €'], PAYA] },
 { f: 'N', s: 'Bank · this week', t: 'Call the bank', b: [['mhead', 'New bank card'], ['hero', 'N', 'Call the bank', 'Confirm your new card · this week'], ['answers', 'Done', ['Later']]] },
 { f: JADE, s: 'Jade · today', t: 'Reply to Jade', b: [['mhead', 'Saturday dinner with Jade'], JH, ['chat', 'Jade', JCHAT, DRAFT], JA] }];
var VH = ['hero', 'ic:voice', 'Who is this voice?', 'Heard at lunch, twice'];
var VC = ['readalong', ['Then let’s say Saturday at nine, I bring the big ladder', 'No, the blue one, it’s cheaper']];
var VP = [{ f: NORA, s: 'Nora' }, { f: LEA, s: 'Lea' }, { f: MAX1, s: 'Max' }, { f: 'ic:plus', s: 'Someone new' }];

V.swipe = {
 A: { w: 'Dots only, the “1 of 5” words gone; Later first on every card; the bank shows its initial, not a building', b: [['lead', 'Five things wait on you:'], ['swipe', W5, 'full']] },
 B: { w: 'Every compact card keeps its one cream answer and gains Later; no count in words', b: [['lead', 'Five things wait on you:'], ['swipe', W5.map(function (c) { return { b: [['row', c.f, c.t, c.s], ['answers', c.b[c.b.length - 1][1], ['Later']]] }; }), 'two']] },
 C: { w: 'Strip without “swipe for more” (it runs off the edge); Life’s guess is preselected and named, one cream answer', tabs: [['The 5 waiting', [['lead', 'Five things wait on you:'], ['swipe', W5, 'strip', 0]]],
  ['Voice naming, the same pattern', [VH, VC, ['lead', 'I think it’s Nora.'], ['swipe', VP, 'strip', 0], ['answers', 'It’s Nora', ['Later', 'TV or video', 'Don’t name']]]]] }
};

/* adds: the tap shows doing, then done, on the row itself; Undo stays on the line */
var ADD_DOING = ['row', 'ic:cal', 'Parents’ meeting', 'Adding to your calendar…', 'spin'];
V.adds = {
 A: { w: 'Doing then done on the row; says what the yes leads to; Later is the quiet pill', b: [EV_H, ['event', EV, 'line'], EV_FOOT, ['answers', 'Add it', ['Later']]], a: [ADD_DOING, ['then', 'A moment later'], ['row', 'ic:cal', 'Parents’ meeting', 'In your calendar · Thu 18:00' + CB.undo(), 'ok']] },
 B: { w: 'It folds to its row, ticked with Undo, and his Thursday shows the new slot; the box is no longer a second copy of the row', b: [EV_H, ['event', EV, 'box'], EV_FOOT, ['answers', 'Add it', ['Later']]], a: [ADD_DOING, ['then', 'A moment later'], ['row', 'ic:cal', 'Parents’ meeting', 'In your calendar' + CB.undo(), 'ok'], ['event', EV, 'day']] },
 C: { w: 'The row carries the result and Undo; Life’s sentence says only what is new (the reminders)', b: [EV_H, ['event', EV, 'line'], EV_FOOT, ['answers', 'Add it', ['Later']]], a: [ADD_DOING, ['then', 'A moment later'], ['row', 'ic:cal', 'Parents’ meeting', 'In your calendar · Thu 18:00' + CB.undo(), 'ok'], ['lead', 'I’ll remind you an hour before, and again at 17:30.']] }
};

/* runs: the answer names the act, shows doing, never a bare "No" */
var RUN_FOOT = ['foot', 'It costs about $1.20, never more than $3. Nothing else happens.'];
var RUN_DOING = ['row', 'ic:search', 'Physios near home', 'Looking up · about 4 min', 'ring', .4];
V.runs = {
 A: { w: 'Ring while it runs, then the result and what it found for him in the line; the answer names the act; Later first', b: [RUN_H, ['spend', RUN, 'line'], ['answers', 'Look them up', ['Later']]], a: [RUN_DOING, ['then', '4 minutes later'], ['row', 'ic:search', 'Physios near home', '38 found · $1.10 · two can see you Thu', 'ok']] },
 B: { w: 'The row shows it running first (it never goes silent), then Life says the result in a sentence', b: [RUN_H, ['spend', RUN, 'line'], RUN_FOOT, ['answers', 'Look them up', ['Later']]], a: [RUN_DOING, ['then', '4 minutes later'], ['row', 'ic:search', 'Physios near home', 'Done · $1.10', 'ok'], ['lead', 'I found 38. Two can see you Thursday.']] },
 C: { w: 'The result is the next ask, with Life’s pick named and why, and what the yes leads to; one cream answer', b: [RUN_H, ['spend', RUN, 'line'], ['answers', 'Look them up', ['Later']]], a: [RUN_DOING, ['then', '4 minutes later'], ['row', 'ic:search', 'Physios near home', '38 found · $1.10', 'ok'], ['hero', 'ic:pin', 'Book a physio for your shoulder', 'Two can see you Thu'], ['why', 'Harbour Physio: Thursday 9:30, 1.2 km away, the closest of the two.'], ['foot', 'Life then drafts one message to the clinic, for your yes.'], ['answers', 'Book Harbour Physio', ['Later']]] }
};

/* looks: every state is a line of the row, in place, with Undo */
V.looks = {
 A: { w: 'Looking, then waiting; the line says until when and carries Undo; nothing is called “not found”', b: [PAY_H, ['box', PAY_ROWS, '240,00 €'], PAYA], a: [['row', PAUL, 'Pay Paul 240 €', 'Looking in your bank…', 'spin'], ['then', 'A minute later'], ['row', PAUL, 'Pay Paul 240 €', 'Not in your bank yet · I look until Fri' + CB.undo(), '']] },
 B: { w: 'Shows the save, then “Marked paid” with when Life checks, and Undo; the tick is no longer a proof it was seen', b: [PAY_H, ['box', PAY_ROWS, '240,00 €'], PAYA], a: [['row', PAUL, 'Pay Paul 240 €', 'Marking it paid…', 'spin'], ['then', 'A moment later'], ['row', PAUL, 'Pay Paul 240 €', 'Marked paid · I check your bank tonight' + CB.undo(), 'ok']] },
 C: { w: 'The row says where it stands and Undo; Life’s sentence only adds why it can take time', b: [PAY_H, ['box', PAY_ROWS, '240,00 €'], PAYA], a: [['row', PAUL, 'Pay Paul 240 €', 'Looking in your bank · until Fri' + CB.undo(), 'spin'], ['lead', 'It isn’t there yet. A transfer can take a day, so I’ll keep looking.']] }
};

/* rate: a tap keeps its mark, the rest fade, “Thanks”; nothing follows, even after a thumb down */
V.rate = {
 A: { w: 'The tap keeps its mark and the line turns to “Thanks”; the cross and the other marks leave', b: [['rate', 'bar']], a: [['rate', 'bar', '👍']] },
 B: { w: 'Same marks, small; after a tap the mark stays with “Thanks”, so the tap shows its result', b: [['rate', 'under']], a: [['rate', 'under', '👍']] },
 C: { w: 'Two marks keep their question; the tap shows “Thanks” with the mark, and nothing follows a thumb down', b: [['rate', 'one']], a: [['rate', 'one', '👍']] }
};

/* edit-tap: chips under or in the draft, and the way back after a change; his own words answer too */
V['edit-tap'] = {
 A: { w: 'Changed words are marked where they changed; the back arrow undoes the tap', b: [JH, ['chat', 'Jade', JCHAT, DRAFT], ['edits', JE], JA], a: [JH, ['chat', 'Jade', JCHAT, DRAFT2], ['edits', ['back', 'Shorter', 'In French']], JA] },
 B: { w: 'Chips stay inside the draft’s outline, right-aligned, and gain the back arrow after a change', b: [JH, ['chat', 'Jade', JCHAT, DRAFT + B.edits(JE, 'inside')], JA], a: [JH, ['chat', 'Jade', JCHAT, DRAFT2 + B.edits(['back', 'Shorter', 'In French'], 'inside')], JA] },
 C: { w: 'Chips sit under the answers by his thumb, with the field so his own words answer too, and the back arrow after a change', b: [JH, ['chat', 'Jade', JCHAT, DRAFT], JA, ['edits', JE], ['field', 'Or tell me what to change']], a: [JH, ['chat', 'Jade', JCHAT, DRAFT2], JA, ['edits', ['back', 'Shorter', 'In French']], ['field', 'Or tell me what to change']] }
};
})();
