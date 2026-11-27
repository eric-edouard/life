/* v3 pages (26 Nov): the pendant's own screen and the matter page reworked, from his feedback
   (2026-11-26-lab-feedback.md). Composed from card-blocks.js only; the lab reads window.EXTRA_ITEMS. */
(function () {
var esc = CB.esc, draw = CB.draw;
var PAUL = 'P/200', NORA = 'N/339', BEN = 'B/30';
/* a page's head, as the profile opens: its face, its name, one line (no part draws it yet: a missing PageHead) */
function head(f, title, line) { return ['raw', (f ? '<div class="cb-pf">' + CB.face(f, 'lg') + '</div>' : '') + '<div class="cb-mph c"><b>' + esc(title) + '</b><small>' + line + '</small></div>']; }
/* a profile's section: a small muted heading over its blocks */
function sec(t, blocks) { return ['raw', '<section class="cb-ps"><h4>' + esc(t) + '</h4>' + draw(blocks) + '</section>']; }
function page(views) { return views.map(function (v) { return [v[0], { blocks: v[1], top: 'page' }]; }); }
function item(id, n, d, rec, v) { var o = {}; Object.keys(v).forEach(function (k) { o[k] = { w: v[k][0], way: v[k][1], views: page(v[k][2]) }; }); return { id: id, area: 'pages', n: n, d: d, rec: rec, v: o }; }

/* ---- the pendant ---- */
var LIT = '<i class="cb-rdot"></i>', OFF = CB.ring(0);
var P_ON = head(LIT, 'Pendant', 'Recording since 8:02'), P_OFF = head(OFF, 'Pendant', 'Not recording since 11:02');
var PAUSE = ['settings', [['Pause', false]]];
var FIX = [['why', 'It lost your phone. It starts again by itself once they are close.'], ['answers', 'It’s next to my phone', ['When I find it'], 'row']];
var HEARD = [['row', NORA, 'Lunch with Nora', '12:10', 'ok'], ['row', BEN, 'Call with Ben', '9:30', 'ok']];
var WAY = 'Tapped <b>the pendant’s dot</b>, top right';
var pendant = item('v3-pendant', 'The pendant’s screen', 'A tap on the pendant’s dot opens its own page, like a profile: whether it records, whether it needs him, and pause. Before (the old Pendant sheet): the state word and since when, a battery tile with time left, a storage ring, “All on your Mac” or a catch-up bar, each problem with what to do, Pair or Replace.', 'A', {
 A: ['Like a profile: one line, where things stand, pause at the end', WAY, [
  ['All well', [P_ON, sec('Where things stand', [['md', 'Battery for about 2 days. Everything it heard is on your Mac.']]), PAUSE]],
  ['Needs you', [P_OFF, sec('Needs you', FIX), sec('Last known', [['md', 'Its battery was fine at 11:02, and what it heard before is on your Mac.']])]]]],
 B: ['Its facts as rows, pause first', WAY, [
  ['All well', [P_ON, ['settings', [['Pause', false], ['Battery', null, null, { line: 'About 2 days left' }], ['On your Mac', null, null, { line: 'Everything it heard', saved: 1 }]]]]],
  ['Needs you', [P_OFF].concat(FIX, [['settings', [['Battery', null, null, { line: 'Fine at 11:02' }], ['On your Mac', null, null, { line: 'Everything up to 11:02', saved: 1 }]]]])]]],
 C: ['Life says it in a sentence, then what it heard today', WAY, [
  ['All well', [P_ON, ['md', 'Battery for about 2 days. Everything it heard is on your Mac.'], sec('Today', HEARD), PAUSE]],
  ['Needs you', [P_OFF].concat(FIX, [sec('Before 11:02', HEARD.slice(1))])]]],
 D: ['Fresh eyes: one status line and pause; when lost, only the fix', WAY, [
  ['All well', [P_ON, PAUSE]],
  ['Needs you', [P_OFF, ['why', 'It lost your phone. Bring them close and it starts again.'], ['answers', 'It’s next to my phone', ['Later'], 'row']]]]]
});

/* ---- the matter page: the kitchen leak ---- */
var PAY_ROWS = [['To', 'Plomberie Garnier'], ['IBAN', 'FR76 3000 6000 0112 3456 7890 189', 1], ['Reference', 'Invoice 2611-07']];
var PAID = ['answers', 'I paid it', ['Later'], 'row'];
var DONE3 = [['step', 'Ask Paul to come', 'Mon', 'struck'], ['step', 'Send Paul the photos', 'Tue', 'struck'], ['step', 'Paul fixes the leak', 'Thu', 'struck']];
var CHAT = [['We have a leak under the sink, can you come?', 'Mon', 1], ['Send me photos please', 'Mon'], ['Got the photos, thanks! Coming Thursday', 'Wed'], ['Invoice attached. Thanks!', 'Thu']];
var MWAY = 'Tapped <b>“Kitchen leak”</b> in the thread';
var matter = item('v3-matter', 'Matter page: the kitchen leak', 'His feedback: confusing. Reworked so it reads at a glance: what it is, where it stands, what needs him, if anything. Each fact once: no goal beside the status, no Next that repeats the ask, no done-check on an old step, no one he doesn’t need.', 'A', {
 A: ['Its steps: what is done is struck, the one left is his, open', MWAY, [
  ['Needs you', [head(null, 'Kitchen leak', 'With Paul, the plumber')].concat(DONE3, [['step', 'Pay Paul 240 €', 'Yours · due Fri'], ['box', PAY_ROWS], PAID])],
  ['After he paid', [head(null, 'Kitchen leak', 'Done · nothing left')].concat(DONE3, [['step', 'Pay Paul 240 €', 'Fri', 'struck']])]]],
 B: ['Like a profile: where it stands in one sentence, then what needs him', MWAY, [
  ['Needs you', [head(null, 'Kitchen leak', 'With Paul, the plumber'), sec('Where things stand', [['md', 'Paul fixed the leak on Thursday. His bill is the last thing left.']]), sec('Needs you', [['row', PAUL, 'Pay Paul 240 €', 'due Fri']]), sec('Last from Paul', [['quote', 'Invoice attached. Thanks!', 'Paul · WhatsApp, Thu']])]],
  ['After he paid', [head(null, 'Kitchen leak', 'With Paul, the plumber'), sec('Where things stand', [['md', 'Paul fixed the leak on Thursday and you paid him on Friday. Nothing is left.']])]]]],
 C: ['Life’s reading on top, the payment ready, the chat as proof', MWAY, [
  ['Needs you', [head(null, 'Kitchen leak', CB.ai('Fixed Thursday; only Paul’s bill is left')), ['box', PAY_ROWS, '240,00 €'], PAID, ['chat', 'Paul', CHAT]]],
  ['After he paid', [head(null, 'Kitchen leak', CB.ai('Fixed and paid; nothing left')), ['chat', 'Paul', CHAT]]]]],
 D: ['Fresh eyes: one plain line, the payment ready; closed, one sentence', MWAY, [
  ['Needs you', [head(null, 'Kitchen leak', 'Fixed Thursday; only Paul’s bill is left'), ['box', PAY_ROWS, '240,00 €'], PAID, ['source', 'wa', 'Paul', 'Thu']]],
  ['After he paid', [head(null, 'Kitchen leak', 'With Paul, the plumber'), ['md', 'Paul fixed the leak on Thursday and you paid him on Friday. Nothing is left.']]]]]
});

pendant.rec = 'D'; matter.rec = 'D'; /* the fresh-eyes reviewer's best (26 Nov): 8/7 and 8/9 */
window.EXTRA_ITEMS = (window.EXTRA_ITEMS || []).concat([pendant, matter]);
})();
