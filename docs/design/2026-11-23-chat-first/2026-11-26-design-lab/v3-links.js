/* Links, by where they go (26 Nov): one LinkCard (card-blocks.js) drawn on the eight kinds of link his chats, mail and
   agents' cards hold most (scratchpad census), each in an ask as it would arrive. Made-up people, places and links.
   Composed from card-blocks.js only; the lab reads window.EXTRA_ITEMS. */
(function () {
var draw = CB.draw;
var NORA = 'N/339', SAM = 'S/30', BEN = 'B/200', MIA = 'M/160', KIT = 'K/280';
/* the eight asks: hero, why, the link [url, line, key], answers (recommended cream on the right) */
var ASKS = [
  [['hero', NORA, 'Lunch with Nora', 'Thu 12:30'], 'She sent the place. I can add it to your calendar.', ['https://maps.app.goo.gl/x1', 'Rue des Lilas 14', 'Café Lune'], ['Add it', ['Later']]],
  [['hero', 'ic:cal', 'Book the dentist cleaning', 'this week'], 'One free slot before your trip.', ['https://www.doctolib.fr/dentiste/x', 'Dr Vale, Rue Haute 3', 'Thu 9:30'], ['I booked it', ['Later']]],
  [['hero', SAM, 'Pay Sam back', 'Fri'], 'He covered your concert ticket.', ['https://www.paypal.com/request/x', 'Payment request', '42,00 €'], ['I paid it', ['Later']]],
  [['hero', 'ic:car', 'Be home for the parcel', 'today'], 'It needs your signature at the door.', ['https://www.dhl.com/track?x', 'Out for delivery', '14:00 to 16:00'], ['I’ll be home', ['Move it']]],
  [['hero', BEN, 'Call with Ben', 'Tue'], 'He sent a call link for the budget review.', ['https://meet.google.com/abc-defg-hij', '30 minutes', '15:00'], ['Add it', ['Later']]],
  [['hero', 'org:Pont Homes', 'Check the lease', 'Pont Homes · Fri'], 'They made changes and need your OK.', ['https://docs.google.com/document/d/x', 'Two lines changed', 'Lease draft'], ['It’s fine', ['Not yet']]],
  [['hero', MIA, 'Confirm the Lisbon dates', 'Sun'], 'Mia found a flat for the four of you.', ['https://www.airbnb.com/rooms/x', 'Casa Azul, 2 bedrooms', '12 to 15 Mar'], ['They work', ['Other dates']]],
  [['hero', KIT, 'Reply to Kit', 'today'], 'She asked if you’re coming to this opening.', ['https://www.instagram.com/p/x', 'lumen.gallery', 'Opening, Sat 19:00'], ['I’ll come', ['Not this time']]]
];
/* a site with no kind: its host under its initial, no brand */
var PLAIN = [['hero', 'ic:org', 'Order the birthday cake', 'for Sat'], 'The bakery takes orders until Thursday.', ['https://fernway-bakery.fr/order', 'Lemon tart for 8', null], ['I ordered it', ['Later']]];
function card(a, mode) {
  return ['raw', '<div class="lk-ask">' + draw([a[0], ['why', a[1]], ['linkcard', a[2][0], a[2][1], mode, a[2][2]], ['answers', a[3][0], a[3][1], 'row']]) + '</div>'];
}
/* every kind in the table, as rows, to check the marks */
var EVERY = ['https://maps.app.goo.gl/x', 'https://maps.apple.com/?q=x', 'https://www.doctolib.fr/x', 'https://calendly.com/x', 'https://www.planity.com/x', 'https://www.paypal.com/x', 'https://lydia-app.com/x', 'https://revolut.me/x', 'https://wise.com/pay/x', 'https://tmn.app.link/x', 'https://www.dhl.com/x', 'https://www.fedex.com/x', 'https://meet.google.com/x', 'https://zoom.us/j/x', 'https://drive.google.com/x', 'https://www.airbnb.com/x', 'https://www.booking.com/x', 'https://www.instagram.com/p/x', 'https://youtu.be/x', 'https://testflight.apple.com/x', 'https://ride.bolt.eu/x', 'https://www.grab.com/x', 'tel:+33600000000', 'mailto:hello@example.com', 'https://fernway-bakery.fr/x'];
function every(mode) { return ['raw', '<div class="lk-every">' + draw(EVERY.map(function (u) { return ['linkcard', u, 'What is there', mode, mode === 'preview' ? 'The key fact' : null]; })) + '</div>']; }
var st = document.createElement('style');
st.textContent = '.lk-ask{display:flex;flex-direction:column;gap:12px;padding:16px;border-radius:22px;background:#0b0c0e}.lk-every{display:flex;flex-direction:column;gap:8px}';
document.head.appendChild(st);
function views(mode) {
  return [['Eight kinds, in asks', { blocks: ASKS.map(function (a) { return card(a, mode); }).concat([card(PLAIN, mode)]), top: 'page' }], ['Every kind in the table', { blocks: [every(mode)], top: 'page' }]];
}
var links = { id: 'v3-links', area: 'details', n: 'Links, by where they go', d: 'A link looks like where it goes, the way app v4 draws its Google Maps link: the place’s mark in its colour, its plain name, and one line of what is there, so he knows where the tap lands before he taps. The eight kinds his chats, mail and agents’ cards hold most; a site Life doesn’t know shows its host under its initial.', rec: 'B', v: {
  A: { w: 'A compact chip, like app v4’s Google Maps link', views: views('row') },
  B: { w: 'A preview: the key fact large, what is there under it', views: views('preview') }
} };
window.EXTRA_ITEMS = (window.EXTRA_ITEMS || []).concat([links]);
})();
