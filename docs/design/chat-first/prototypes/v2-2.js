/* v2 batch 2: same, contacts, atorg, yourmove, payment, qr. Each v2 keeps its variant's idea and passes the rulebook's
   checklist: one cream answer on the right for a question (the likelier one), one cream button for an ask with Later
   first, no hairline, no word on a mark's place, a face that is the person, a line that says who and when, and a state
   line for every outcome. */
(function () {
var B = CB.B;
var NORA = 'N/339', KIT = 'K/30', PAUL = 'P/200', MAX1 = 'M/30', MAX2 = 'M/200', LEA = 'L/280', MALI = 'M/30';
var GUESS = CB.ai('Life’s guess');

/* ---- same ---- */
var BEN_A = ['B', 'Ben Carter', 'WhatsApp', '+33 6 12 40 77 81'], BEN_B = ['B', 'Ben Carter', 'Mail', 'ben@fernway.co'];
var BEN_DONE = ['row', 'B', 'Ben Carter', 'Two Bens joined into one', 'ok'];
var same = {
 A: { w: 'Two rows, one per place Life sees a Ben, under one question; no marks between them; the likelier answer is cream on the right',
  b: [['hero', 'B', 'Is this one Ben Carter?', 'Same name in two places'], ['row', 'B', 'WhatsApp', '+33 6 12 40 77 81'], ['row', 'B', 'Mail', 'ben@fernway.co'], ['answers', 'Yes', ['No'], 'row']],
  a: [BEN_DONE] },
 B: { w: 'Shows the one Ben that joining makes, both places under his name; Yes is cream on the right',
  b: [['hero', 'B', 'Join these two Bens?', 'Same name on WhatsApp and in mail'], ['pair', ['B', 'Ben Carter', 'WhatsApp +33 6 12 40 77 81'], ['B', '', 'Mail ben@fernway.co'], 'merged'], ['answers', 'Yes', ['No'], 'row']],
  a: [BEN_DONE] },
 C: { w: 'Only the question: both places in its one line, nothing else drawn',
  b: [['hero', 'B', 'One Ben Carter, or two?', '+33 6 12 40 77 81 on WhatsApp · ben@fernway.co in mail'], ['answers', 'One', ['Two'], 'row']],
  a: [BEN_DONE] }
};

/* ---- contacts ---- */
var MAXES = [[MAX1, 'Max Weber', 'Your landlord'], [MAX2, 'Max Ruiz', 'Climbing']];
var MAX_DONE = ['row', MAX1, 'Max Weber', 'Card linked to Max Weber', 'ok'];
var contacts = {
 A: { w: 'Life’s guess as the question, with where it comes from; Yes is cream on the right',
  b: [['hero', MAX1, 'Is this Max Weber?', 'Your landlord · on a card in your Contacts'], ['answers', 'Yes', ['Someone else'], 'row']],
  a: [MAX_DONE] },
 B: { w: 'Each Max is an answer button, Life’s guess cream on top; the card’s number is in the question',
  b: [['bt', 'The card in your Contacts, <b>+33 6 44 12 90 03</b>, is which Max?'], ['answers', 'Max Weber', ['Max Ruiz', 'Someone else']]],
  a: [MAX_DONE] },
 C: { w: 'Chips with full names, Life’s guess named in blue above them; the question is one line',
  b: [['hero', 'M', 'Which Max is this?', 'A card in your Contacts · +33 6 44 12 90 03'], ['pick', 'Max Weber, your landlord'], ['people', MAXES, 'chips']],
  a: [MAX_DONE] }
};

/* ---- atorg ---- */
var ORG_DONE = ['row', 'org:Fernway', 'Fernway', 'Lea added as designer', 'ok'];
var atorg = {
 A: { w: 'Face is Lea, not a generic building; the likelier answer is cream on the right; a line says what Yes does',
  b: [['hero', LEA, 'Is Lea at Fernway?', 'As designer · from her Contacts card'], ['foot', 'Yes: I list her under Fernway as designer.'], ['answers', 'Yes', ['No'], 'row']],
  a: [ORG_DONE] },
 B: { w: 'Fernway’s own initial, not a generic mark; an ask with Later first, Add her cream; a settled line',
  b: [['hero', 'org:Fernway', 'Add Lea to Fernway?', 'From her Contacts card'], ['row', 'B', 'Ben Carter', 'Founder'], ['row', LEA, 'Lea Moreau', 'Designer · new'], ['answers', 'Add her', ['Later', 'No']]],
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
  a: [MOVE_L, ['row', 'ic:car', 'Book the car’s service', 'Calling the garage · about 10 min' + CB.undo(), 'ring', .2]] },
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
var COPY = ['copyrows', [['Amount', '240,00 €']].concat(PAY_ROWS)];
var SLIP = ['slip', '<span>Send <b>240,00 €</b> to <b>Plomberie Garnier</b>, FR76 3000 6000 0112 3456 7890 189, reference <b>Invoice 2611-07</b>.</span>'];
var payment = {
 A: { w: 'The line is who · when; a line says what I paid it leads to; a settled line; no hairline in the rows',
  b: [PAY_H, ['box', PAY_ROWS, '240,00 €'], ['link', 'your bank'], PAY_FOOT, PAYA],
  a: [PAY_DONE] },
 B: { w: 'Copy shown as a mark only, hairlines between the rows removed; a line says what I paid it leads to',
  b: [PAY_H, COPY, PAY_FOOT, PAYA],
  a: [PAY_DONE] },
 C: { w: 'The Copy word on the button becomes a mark; a line says what I paid it leads to; a settled line',
  b: [PAY_H, SLIP, PAY_FOOT, PAYA],
  a: [PAY_DONE] }
};

/* ---- qr ---- */
var QR_H = ['hero', MALI, 'Pay Mali 4,500 THB', 'Mali, for the cleaning · today'];
var QR_A = ['answers', 'I paid it', ['Later']];
var QR_FOOT = ['foot', 'I paid it: I look for the payment in your account and close this.'];
var QR_DONE = ['row', MALI, 'Pay Mali 4,500 THB', 'Paid to Mali, 4,500 THB', 'ok'];
var qr = {
 A: { w: 'Today is coral, the one place colour is allowed; who · when; a line says what I paid it leads to; a settled line',
  b: [QR_H, ['qr', '4,500 THB', 'Mali’s message', 'big'], QR_FOOT, QR_A],
  a: [QR_DONE] },
 B: { w: 'Today is coral; who · when; a line says what I paid it leads to; a settled line',
  b: [QR_H, ['qr', '4,500 THB', 'Mali’s message', 'thumb'], QR_FOOT, QR_A],
  a: [QR_DONE] },
 C: { w: 'The word button becomes a code mark; today is coral; a line says what I paid it leads to; a settled line',
  b: [QR_H, ['qr', '4,500 THB', 'Mali’s message', 'hidden'], QR_FOOT, QR_A],
  a: [QR_DONE] }
};

(window.V2 = window.V2 || {});
V2.same = same; V2.contacts = contacts; V2.atorg = atorg; V2.yourmove = yourmove; V2.payment = payment; V2.qr = qr;
})();

/* the fresh-eyes reviewer's best (26 Nov), recommended in the lab */
window.V2['same'].rec='C2';
window.V2['contacts'].rec='A2';
