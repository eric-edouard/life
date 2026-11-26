/* v2 batch 2: same, contacts, atorg, yourmove, payment, qr. Each v2 keeps its variant's idea and passes the rulebook's
   checklist: one cream answer on the right for a question (the likelier one), one cream button for an ask with Later
   first, no hairline, no word on a mark's place, a face that is the person, a line that says who and when, and a state
   line for every outcome. */
(function () {
var B = CB.B;
var NORA = 'N/339', KIT = 'K/30', PAUL = 'P/200', MAX1 = 'M/30', MAX2 = 'M/200', LEA = 'L/280', MALI = 'M/30';
var TODAY = '<span style="color:#f0896f">today</span>';
/* a question's two answers: equal pills, the likelier one cream and on the right (the lab's answers block puts cream on the left) */
function YN(no, yes) { return ['raw', '<div class="two cb-row"><button type="button" class="sec">' + no + '</button><button type="button" class="sec rec">' + yes + '</button></div>']; }
/* Life's own pick, in Life's blue */
function PICK(t) { return ['raw', '<div class="why"><b style="color:var(--ai);font-weight:650">Life’s pick</b> ' + t + '</div>']; }
var GUESS = '<span style="color:var(--ai)">Life’s guess</span>';

/* ---- same ---- */
var BEN_A = ['B', 'Ben Carter', 'WhatsApp', '+33 6 12 40 77 81'], BEN_B = ['B', 'Ben Carter', 'Mail', 'ben@fernway.co'];
var BEN_DONE = ['row', 'B', 'Ben Carter', 'Two Bens joined into one', 'ok'];
var same = {
 A: { w: 'Face is Ben’s initial, not a link mark; the likelier answer is cream on the right; a line says what Same person does',
  b: [['hero', 'B', 'One Ben, or two?', 'Same name on WhatsApp and in mail'], ['pair', BEN_A, BEN_B], ['foot', 'Same person: I join them. Different: I keep them apart.'], YN('Different', 'Same person')],
  a: [['lead', 'One Ben now. He said three things this week:'], BEN_DONE] },
 B: { w: 'An ask: Later first, Join them cream; the merged Ben stays and a line says what joining does; it ends in a state',
  b: [['hero', 'B', 'Join the two Bens?', 'Same name on WhatsApp and in mail'], ['pair', ['B', 'Ben Carter', 'WhatsApp +33 6 12 40 77 81'], ['B', '', 'Mail ben@fernway.co'], 'merged'], ['foot', 'Joined, they are one Ben in everything I show you.'], ['answers', 'Join them', ['Later', 'Keep apart']]],
  a: [BEN_DONE] },
 C: { w: 'Yes is cream on the right; the sentence carries the number so he can answer from it; a settled line added',
  b: [['bt', 'Is <b>Ben Carter</b> on WhatsApp (+33 6 12 40 77 81) the same Ben who mails you from Fernway?'], YN('No', 'Yes')],
  a: [BEN_DONE] }
};

/* ---- contacts ---- */
var MAXES = [[MAX1, 'Max Weber', 'Your landlord'], [MAX2, 'Max Ruiz', 'Climbing']];
var MAX_DONE = ['row', MAX1, 'Max Weber', 'Card linked to Max Weber', 'ok'];
var contacts = {
 A: { w: 'Life’s pick named in blue and listed first; the “tap the one” instruction goes (rows are tappable by themselves)',
  b: [['hero', 'M', 'Which Max is this?', 'Contacts card · +33 6 44 12 90 03'], PICK('Max Weber, your landlord'), ['people', MAXES, 'rows']],
  a: [MAX_DONE] },
 B: { w: 'Life’s guess named in blue; Yes is cream on the right; Someone else is the other equal pill; a settled line',
  b: [['hero', MAX1, 'Is this Max Weber?', GUESS + ' · your landlord, +33 6 44 12 90 03'], YN('Someone else', 'Yes')],
  a: [MAX_DONE] },
 C: { w: 'Still one line and chips; Life’s pick named under it so the chips are not a blind choice; a settled line',
  b: [['bt', '<b>Max</b>, +33 6 44 12 90 03, is in your Contacts. Who is it?'], PICK('Max Weber, your landlord'), ['people', [[MAX1, 'Max Weber', ''], [MAX2, 'Max Ruiz', '']], 'chips']],
  a: [MAX_DONE] }
};

/* ---- atorg ---- */
var ORG_DONE = ['row', 'F', 'Fernway', 'Lea added as designer', 'ok'];
var atorg = {
 A: { w: 'Face is Lea, not a generic building; the likelier answer is cream on the right; a line says what Yes does',
  b: [['hero', LEA, 'Is Lea at Fernway?', 'As designer · from her Contacts card'], ['foot', 'Yes: I list her under Fernway as designer.'], YN('No', 'Yes')],
  a: [ORG_DONE] },
 B: { w: 'Fernway’s own initial, not a generic mark; an ask with Later first, Add her cream; a settled line',
  b: [['hero', 'F', 'Add Lea to Fernway?', 'From her Contacts card'], ['row', 'B', 'Ben Carter', 'Founder'], ['row', LEA, 'Lea Moreau', 'Designer · new'], ['answers', 'Add her', ['Later', 'No']]],
  a: [ORG_DONE] },
 C: { w: 'The two marks stay (done, no) with the tick cream; Later added as the card’s way to leave; a settled line',
  b: [['step', 'Add Lea Moreau to Fernway as designer', 'From her Contacts card', 'ask'], ['answers', null, ['Later']]],
  a: [ORG_DONE] }
};

/* ---- yourmove ---- */
var MOVE_L = ['lead', 'This one is yours, due tomorrow:'];
var MOVE_H = ['hero', 'ic:car', 'Book the car’s service', 'Yours · Fri'];
var MOVE_BOX = ['box', [['Where', 'Garage Lemoine'], ['Phone', '+33 1 44 55 66 77', 1]]];
var MOVE_WHY = ['why', 'You wanted the car ready before the trip on the 12th.'];
var yourmove = {
 A: { w: 'Later is the first quiet pill; the line is who · when; one line says why; Mark as done stays the one cream',
  b: [MOVE_L, MOVE_H, MOVE_WHY, MOVE_BOX, ['answers', 'Mark as done', ['Later', 'Hand it to Life', 'Drop']]],
  a: [MOVE_L, ['row', 'ic:car', 'Book the car’s service', 'Done', 'ok']] },
 B: { w: 'Later first; the offer says what I will do and that it can be stopped; under way shows Undo',
  b: [MOVE_L, MOVE_H, MOVE_BOX, ['why', 'I can call the garage and book Friday morning.'], ['answers', 'Hand it to Life', ['Later', 'Mark as done', 'Drop']]],
  a: [MOVE_L, ['row', 'ic:car', 'Book the car’s service', 'Calling the garage · about 10 min · <b>Undo</b>', 'ring', .2]] },
 C: { w: 'The circle’s tick is the one cream mark and a cross drops it; the phone is kept; Later first, then Hand it to Life',
  b: [MOVE_L, ['step', 'Book the car’s service', 'Yours · Fri · Garage Lemoine', 'ask'], ['box', [['Phone', '+33 1 44 55 66 77', 1]]], ['answers', null, ['Later', 'Hand it to Life']]],
  a: [MOVE_L, ['step', 'Book the car’s service', 'Done', 'struck']] }
};

/* ---- payment ---- */
var PAY_H = ['hero', PAUL, 'Pay Paul 240 €', 'Paul, for the leak · Fri'];
var PAY_ROWS = [['To', 'Plomberie Garnier'], ['IBAN', 'FR76 3000 6000 0112 3456 7890 189', 1], ['Reference', 'Invoice 2611-07']];
var PAYA = ['answers', 'I paid it', ['Later']];
var PAY_FOOT = ['foot', 'I paid it: I look for the payment in your account and close this.'];
var PAY_DONE = ['row', PAUL, 'Pay Paul 240 €', 'Paid to Paul, 240 €', 'ok'];
/* the copy block draws a hairline between rows; the owner’s answer 4 says none anywhere */
var COPY = B.copyrows([['Amount', '240,00 €']].concat(PAY_ROWS)).replace(/class="cb-cr"/g, 'class="cb-cr" style="border-top:0"');
var SLIP = B.slip('<span>Send <b>240,00 €</b> to <b>Plomberie Garnier</b>, FR76 3000 6000 0112 3456 7890 189, reference <b>Invoice 2611-07</b>.</span>').replace('</svg>Copy</button>', '</svg></button>').replace('class="cb-mini"', 'class="cb-mini" aria-label="Copy"');
var payment = {
 A: { w: 'The line is who · when; a line says what I paid it leads to; a settled line; no hairline in the rows',
  b: [PAY_H, ['box', PAY_ROWS, '240,00 €'], ['link', 'your bank'], PAY_FOOT, PAYA],
  a: [PAY_DONE] },
 B: { w: 'Copy shown as a mark only, hairlines between the rows removed; a line says what I paid it leads to',
  b: [PAY_H, ['raw', COPY], PAY_FOOT, PAYA],
  a: [PAY_DONE] },
 C: { w: 'The Copy word on the button becomes a mark; a line says what I paid it leads to; a settled line',
  b: [PAY_H, ['raw', SLIP], PAY_FOOT, PAYA],
  a: [PAY_DONE] }
};

/* ---- qr ---- */
var QR_H = ['hero', MALI, 'Pay Mali 4,500 THB', 'Mali, for the cleaning · ' + TODAY];
var QR_A = ['answers', 'I paid it', ['Later']];
var QR_FOOT = ['foot', 'I paid it: I look for the payment in your account and close this.'];
var QR_DONE = ['row', MALI, 'Pay Mali 4,500 THB', 'Paid to Mali, 4,500 THB', 'ok'];
var QRGLYPH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><path d="M14 14h2v2h-2zM19 14v2M14 19h2M18 18h2v2"/></svg>';
var QR_HIDDEN = B.qr('4,500 THB', 'Mali’s message', 'hidden').replace('>Show the code</button>', ' aria-label="Show the code">' + QRGLYPH + '</button>');
var qr = {
 A: { w: 'Today is coral, the one place colour is allowed; who · when; a line says what I paid it leads to; a settled line',
  b: [QR_H, ['qr', '4,500 THB', 'Mali’s message', 'big'], QR_FOOT, QR_A],
  a: [QR_DONE] },
 B: { w: 'Today is coral; who · when; a line says what I paid it leads to; a settled line',
  b: [QR_H, ['qr', '4,500 THB', 'Mali’s message', 'thumb'], QR_FOOT, QR_A],
  a: [QR_DONE] },
 C: { w: 'The word button becomes a code mark; today is coral; a line says what I paid it leads to; a settled line',
  b: [QR_H, ['raw', QR_HIDDEN], QR_FOOT, QR_A],
  a: [QR_DONE] }
};

(window.V2 = window.V2 || {});
V2.same = same; V2.contacts = contacts; V2.atorg = atorg; V2.yourmove = yourmove; V2.payment = payment; V2.qr = qr;
})();
