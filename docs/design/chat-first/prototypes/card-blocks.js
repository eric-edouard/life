/* Life's design system for the lab: every part of the app, written once, in the Swift app's hierarchy and names
   (apps/lifelog/apps/ios/Lifelog/DesignSystem, Items). A card is data (which blocks, in which order, in which mode),
   never hand-written markup; shell.html and design-lab.html both draw from here. Dark only (the owner's answer 11).
   COMPONENTS.md has the tree; the lab and Swift share these names.

   1. Tokens     T, APPS                         Swift Palette (tokens.css); ChatLook's network colours
   2. Atoms      Icon (I)                        SF Symbols
                 Face                            Items/Face.swift Face
                 NetworkMark                     NetworkMark.swift NetworkMark
                 Button (filled, quiet)          Pieces.swift PillStyle (.filled, .quiet)
                 Switch, Check                   Pieces.swift RowSwitch; StateMark
                 Spinner, StillRing              Pieces.swift Spinner; ThreadComponents.swift StillRing
                 ReactionMark                    ThreadComponents.swift ReactionMark
                 LifesWords (blue), Due (coral), Saved (green tick), Undo     Palette.ai, .flag, .ok; SentLine's Undo
   3. Molecules  PartyLine (face, title, line)   AskCard's header, ThreadItemRow's header
                 Row                             ThreadItemRow
                 Source (mark, name, Open app)   DraftBlock's ChatHead
                 Quote (a message and its Source) DraftBlock's quote
                 Answers (cream on the right)    AskComponents.swift AnswerPills, QuestionBlock
                 LifesPick, Option               missing in Swift (QuietChip iconTint ai)
                 ReadAlong (a voice clip)        missing in Swift
                 DraftBlock (chat), EditChips    DraftBlock.swift DraftBlock; AskComponents.swift EditChips
                 HisBubble, RatingRow            ThreadComponents.swift HisBubble, RatingRow
                 SettingsBlock                   AskComponents.swift SettingsBlock, SettingSwitchRow, SettingValueRow
                 RoundButton, Markdown           ThreadComponents.swift RoundButton; LifeWords.swift MarkdownView
   4. The ask    the blocks B, drawn in order     AskComponents.swift AskCard
   Rules every part keeps: no hairlines; one cream fill per card, on the right; each fact once. */
(function () {
  var S = 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
  function svg(p, w) { return '<svg viewBox="0 0 24 24" ' + S + (w ? ' stroke-width="' + w + '"' : '') + ' aria-hidden="true">' + p + '</svg>'; }
  var I = {
    play: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z"/></svg>',
    check: svg('<path d="m5 12.5 4.5 4.5L19 7.5"/>', 2.4), x: svg('<path d="M6 6l12 12M18 6 6 18"/>', 2),
    cal: svg('<rect x="4" y="5.5" width="16" height="14" rx="2.5"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>'),
    pin: svg('<path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11Z"/><circle cx="12" cy="10" r="2.3"/>'),
    open: svg('<path d="M8 16 16 8M9.5 8H16v6.5"/>'), copy: svg('<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>'),
    plus: svg('<path d="M12 5v14M5 12h14"/>', 2), mic: svg('<path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z"/><path d="M19 11a7 7 0 0 1-14 0"/>'),
    bell: svg('<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>'),
    search: svg('<circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/>'), back: svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>'),
    link: svg('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'),
    org: svg('<path d="M4 20V6l8-3v17M12 9h8v11M7 8h2M7 12h2M7 16h2M15 13h2M15 17h2"/>'),
    bank: svg('<path d="M3 10 12 4l9 6M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18"/>'),
    later: svg('<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>'), drop: svg('<path d="M5 7h14M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
    voice: svg('<path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2"/>'), phone: svg('<path d="M5 4h3.5l1.5 4-2.2 1.4a11 11 0 0 0 6.8 6.8L16 14l4 1.5V19a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2Z"/>'),
    mail: svg('<rect x="3.5" y="5.5" width="17" height="13" rx="2.5"/><path d="m4 7 8 6 8-6"/>'), car: svg('<path d="M5 16h14v-4l-2-5H7l-2 5z"/><circle cx="8" cy="16.5" r="1.5"/><circle cx="16" cy="16.5" r="1.5"/>'),
    wa: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#25D366" d="M12 1.8A10.2 10.2 0 0 0 3.2 17.2L1.8 22.2l5.2-1.4A10.2 10.2 0 1 0 12 1.8Z"/><path fill="#fff" d="M8.6 6.9c-.2-.5-.5-.5-.7-.5h-.6c-.2 0-.6.1-.9.4-.3.3-1.1 1.1-1.1 2.7s1.2 3.2 1.3 3.4c.2.2 2.3 3.6 5.6 4.9 2.8 1.1 3.3.9 3.9.8.6-.1 1.9-.8 2.2-1.5.3-.8.3-1.4.2-1.5l-.6-.4-2.1-1c-.3-.1-.5-.2-.7.2l-1 1.2c-.2.2-.4.2-.7.1-.3-.2-1.3-.5-2.5-1.6-.9-.8-1.5-1.8-1.7-2.1-.2-.3 0-.5.1-.6l.5-.6.3-.5c.1-.2.1-.4 0-.5l-1-2.6Z"/></svg>'
  };
  function esc(t) { return String(t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  I.pen = svg('<path d="M4 20h4L19 9l-4-4L4 16v4Z"/>'); I.mac = svg('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>');
  I.msg = svg('<path d="M21 12a8 8 0 0 1-11.5 7.2L4 21l1.8-5.5A8 8 0 1 1 21 12Z"/>'); I.bang = svg('<path d="M12 7v6M12 17h.01"/>', 2);
  I.faceid = svg('<path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2"/>');
  I.chev = svg('<path d="M15 5l-7 7 7 7"/>', 2);
  I.qr = svg('<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><path d="M14 14h2v2h-2zM19 14v2M14 19h2M18 18h2v2"/>');
  I.imessage = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="1" y="1" width="22" height="22" rx="6" fill="#34C759"/><path fill="#fff" d="M12 5.5c-4.1 0-7.5 2.7-7.5 6.1 0 1.9 1 3.6 2.7 4.7-.1 1-.6 1.9-1.3 2.6 1.5 0 2.8-.6 3.7-1.3.8.2 1.6.3 2.4.3 4.1 0 7.5-2.7 7.5-6.2S16.1 5.5 12 5.5Z"/></svg>';

  /* ---- 1. Tokens ---- */
  var T = { fg: '#fff8ea', muted: '#8a867e', tint: 'rgba(255,248,234,.1)', tile: '#111214', card: '#0b0c0e', ok: '#30d158', ai: '#9aa8ec', flag: '#f0896f' };
  /* a network's own mark and colour: rgb for its fills, ink for words on them; one with no mark of its own keeps a line glyph */
  var APPS = {
    wa: { n: 'WhatsApp', rgb: '37,211,102', ink: '#4fdc8a', mark: 'wa' },
    imessage: { n: 'Messages', rgb: '10,132,255', ink: '#64b0ff', mark: 'imessage' },
    mail: { n: 'Mail', rgb: '255,248,234', ink: T.fg, mark: 'mail', line: 1 }
  };
  function appOf(k) { return APPS[k] || APPS.wa; }
  /* the app a source line names ("Kit · WhatsApp, Tue"), else WhatsApp */
  function appIn(s) { return /iMessage|Messages/.test(s) ? 'imessage' : /\bMail\b/.test(s) ? 'mail' : 'wa'; }

  /* ---- 2. Atoms ---- */
  /* Face: always a full circle. A person's initial on their hue ("N/339"); an organization's picture, else its initials
     ("org:Fern Way"); a mark only when there is no one to show ("ic:cal"); or ready markup. Sizes xs 22, sm 28, 40, lg 56, xl 96 */
  function Face(f, size) {
    f = f || 'L'; var inner, st = '';
    if (f.charAt(0) === '<') inner = f;
    else if (f.indexOf('ic:') === 0) inner = I[f.slice(3)];
    else if (f.indexOf('org:') === 0) inner = esc(f.slice(4).split(/\s+/).map(function (w) { return w.charAt(0); }).join('').slice(0, 2));
    else { var p = f.split('/'); inner = esc(p[0]); if (p[1]) st = ' style="background:hsl(' + p[1] + ' 22% 22%);color:hsl(' + p[1] + ' 60% 82%)"'; }
    return '<span class="disc' + (size ? ' ' + size : '') + '"' + st + '>' + inner + '</span>';
  }
  function NetworkMark(app) { var a = appOf(app); return '<span class="cb-nm' + (a.line ? ' line' : '') + '">' + I[a.mark] + '</span>'; }
  /* a button: its words, or a mark by its icon key (then VoiceOver gets the key) */
  function btn(label, cls, data) { var ic = label && I[label]; return '<button type="button" class="' + cls + '"' + (data || '') + (ic ? ' aria-label="' + label + '"' : '') + '>' + (ic || esc(label)) + '</button>'; }
  function Button(label, kind) { return btn(label, kind === 'filled' ? 'sec rec' : 'sec'); }
  function Switch(on, saved) { return '<span class="cb-sw' + (on ? ' on' : '') + '" role="switch" aria-checked="' + !!on + '"><i></i></span>' + (saved ? Saved() : ''); }
  function Check(on) { return '<span class="cb-box' + (on ? ' on' : '') + '">' + (on ? I.check : '') + '</span>'; }
  function Saved() { return '<span class="cb-saved" aria-label="Saved">' + I.check + '</span>'; }
  function Spinner() { return '<span class="spin sm"></span>'; }
  function StillRing(p) { var c = 37.7; return '<svg class="pie" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-opacity=".28" stroke-width="2.2"/><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-dasharray="' + (c * p).toFixed(1) + ' ' + c + '" transform="rotate(-90 8 8)" stroke-linecap="round"/></svg>'; }
  function ReactionMark(m) { return '<span class="cb-em">' + m + '</span>'; }
  /* Life's own reading or pick, in Life's blue; never anything else */
  function LifesWords(t) { return '<span class="cb-ai">' + t + '</span>'; }
  /* "· Undo" at the end of a line, with its limit when it has one */
  function Undo(until) { return ' · <b class="cb-undo">Undo' + (until ? ' until ' + esc(until) : '') + '</b>'; }
  /* today and tonight are urgent: coral, until the line is settled */
  function Due(line) { return String(line).replace(/\b(today|tonight)\b/g, '<em class="cb-td">$1</em>'); }

  /* ---- 3. Molecules ---- */
  /* the line under a title says who and when, each once: a name the title already says goes ("Reply to Jade" over
     "Jade · today" reads "today"; "Pay Paul 240 €" over "Paul, for the leak · Fri" reads "for the leak · Fri") */
  function lineOf(title, line, settled) {
    line = String(line || ''); var m = /^([A-Z][a-z]+)(, | · |$)/.exec(line);
    if (m && new RegExp('\\b' + m[1] + '\\b').test(title)) line = line.slice(m[0].length);
    return settled ? line : Due(line);
  }
  function PartyLine(f, title, line) { return '<div class="hero">' + Face(f) + '<div><div class="htitle">' + esc(title) + '</div><div class="hline">' + lineOf(title, line) + '</div></div></div>'; }
  /* a thread row in one state: ok, ring (with its fill), spin, plain, old */
  function Row(f, title, line, state, fill) {
    var g = state === 'ok' ? '<span class="okt">' + I.check + '</span>' : state === 'ring' ? StillRing(fill || .3) : state === 'spin' ? Spinner() : '';
    return '<div class="fr' + (state === 'old' ? ' cb-old' : '') + '">' + Face(f) + '<span class="tx"><b>' + esc(title) + '</b><small>' + g + lineOf(title, line, state === 'ok' || state === 'old') + '</small></span></div>';
  }
  /* where a message came from, as its app shows it: the app's mark, who, when, and "Open <app>" in the app's colour */
  function Source(app, who, when) {
    var a = appOf(app);
    return '<a class="cb-source" href="#" onclick="return false" style="--app:' + a.rgb + ';--appink:' + a.ink + '">' + NetworkMark(app) + '<b>' + who + '</b>' + (when ? '<small>' + esc(when) + '</small>' : '') + '<span class="cb-open">Open ' + a.n + ' ' + I.open + '</span></a>';
  }
  /* "Kit · WhatsApp, Tue" → who Kit, when Tue, app WhatsApp */
  function srcOf(s) { var p = String(s).split(' · '); return { who: p[0], when: (p[1] || '').replace(/^(WhatsApp|iMessage|Messages|Mail),?\s*/, ''), app: appIn(s) }; }
  /* a quoted message: its Source, then the message in their bubble (the Source names them, so no face) */
  function Quote(text, src) { var s = srcOf(src); return '<div class="cb-q">' + Source(s.app, esc(s.who), s.when) + '<div class="cm in">' + text + '</div></div>'; }
  /* Life's Markdown with life: links: **bold**, [words](life:ref), "> quote" then "*who · app, when*", "- " bullets */
  function Markdown(t) {
    var inl = function (s) { return esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\[(.+?)\]\(life:[^)]+\)/g, '<a class="cb-ll" href="#" onclick="return false">$1</a>').replace(/\*(.+?)\*/g, '<i>$1</i>'); };
    var out = '', list = false, q = null;
    var flush = function () { if (q !== null) { out += '<div class="cb-q"><div class="cm in">' + q + '</div></div>'; q = null; } };
    t.split('\n').forEach(function (l) {
      if (/^\*.+\*$/.test(l) && q !== null) { var s = srcOf(l.slice(1, -1).replace(/\[(.+?)\]\([^)]*\)/g, '$1')); out += '<div class="cb-q">' + Source(s.app, esc(s.who), s.when) + '<div class="cm in">' + q + '</div></div>'; q = null; return; }
      flush();
      if (/^- /.test(l)) { if (!list) { out += '<ul>'; list = true; } out += '<li>' + inl(l.slice(2)) + '</li>'; return; }
      if (list) { out += '</ul>'; list = false; }
      if (/^> /.test(l)) q = inl(l.slice(2));
      else if (/^\*.+\*$/.test(l)) out += '<p class="cb-src">' + inl(l.slice(1, -1)) + '</p>';
      else if (l) out += '<p>' + inl(l) + '</p>';
    });
    flush();
    return '<div class="cb-md">' + out + (list ? '</ul>' : '') + '</div>';
  }
  /* an ask's answers. stack: the recommended one cream and full width, the rest quiet two to a row (AnswerPills);
     row: a question's equal pills, the recommended one cream and on the right (QuestionBlock); list: one per row;
     marks: round marks, the recommended one cream and last; no recommended one: quiet pills only */
  function Answers(prim, pills, mode) {
    pills = pills || [];
    if (!prim) return '<div class="two cb-row">' + pills.map(function (p) { return Button(p); }).join('') + '</div>';
    if (mode === 'row') return '<div class="two cb-row">' + pills.map(function (p) { return Button(p); }).join('') + Button(prim, 'filled') + '</div>';
    if (mode === 'list') return '<div class="cb-list">' + [prim].concat(pills).map(function (p, i) { return btn(p, 'cb-li' + (i ? '' : ' rec')); }).join('') + '</div>';
    if (mode === 'marks') return '<div class="cb-marks">' + pills.concat([prim]).map(function (p, i) { return btn(p, 'cb-mk' + (i === pills.length ? ' rec' : '')); }).join('') + '</div>';
    return '<div class="answers inl">' + btn(prim, 'prim') + (pills.length ? '<div class="two">' + pills.map(function (p) { return Button(p); }).join('') + '</div>' : '') + '</div>';
  }
  function LifesPick(t) { return '<div class="why"><b class="cb-ai">Life’s pick</b> ' + t + '</div>'; }
  /* a pick's option: a radio, the name, Life's pick in blue, one line */
  function Option(on, name, line, isPick) { return '<button type="button" class="cb-opt' + (on ? ' on' : '') + '"><span class="cb-radio"></span><span><b>' + esc(name) + '</b>' + (isPick ? '<b class="cb-ai cb-tag">Life’s pick</b>' : '') + '<small>' + esc(line) + '</small></span></button>'; }
  /* a voice clip, read not drawn: the words dim, each turning white as it is spoken after play (which loads first);
     no waveform, no duration. Several clips stack. */
  function ReadAlong(words) {
    return [].concat(words).map(function (w) { return '<div class="cb-ra">' + btn('play', 'cb-play') + '<span class="cb-raw">' + esc(w).split(' ').map(function (x) { return '<i>' + x + '</i>'; }).join(' ') + '</span></div>'; }).join('');
  }
  /* the older clip looks (variants A, B, C before the 26 Nov rule): wave, pill, text */
  function wave(n, seed) { var h = ''; for (var i = 0; i < n; i++) { var v = 5 + Math.round(Math.abs(Math.sin(i * 1.7 + seed) * Math.cos(i * .43 + seed)) * 17); h += '<i style="height:' + v + 'px"></i>'; } return '<span class="cb-wave">' + h + '</span>'; }
  function Clip(words, dur, mode, seed) {
    if (mode === 'read') return ReadAlong(words);
    if (mode === 'pill') return '<div class="cb-clip pill">' + btn('play', 'cb-play') + wave(18, seed || 1) + '<span class="cb-dur">' + dur + '</span></div>';
    if (mode === 'text') return '<div class="cb-clip text">' + btn('play', 'cb-play sm') + '<span>“' + esc(words) + '”<small>' + dur + '</small></span></div>';
    return '<div class="cb-clip">' + btn('play', 'cb-play') + '<div class="cb-cw">' + wave(30, seed || 1) + '<div class="cb-words">“' + esc(words) + '”</div><small>' + dur + '</small></div></div>';
  }
  /* the chat a draft goes into: its Source, its last lines, the draft in the app's colour (dashed until sent) */
  function DraftBlock(name, items, draft, mode, app) {
    var a = appOf(app), h = '<div class="chat cb-chat" style="--app:' + a.rgb + '">' + Source(app, esc(name));
    items.forEach(function (it) { h += '<div class="cm ' + (it[2] ? 'out' : 'in') + '">' + esc(it[0]) + '<span class="tm">' + it[1] + '</span></div>'; });
    return h + (draft ? '<div class="cm out draft' + (mode ? ' ' + mode : '') + '">' + draft + '</div>' : '') + '</div>';
  }
  /* quick edits: chips under the draft (or inside it), "back" is the round way back to the last version */
  function EditChips(list, mode) {
    var chip = function (e) { return e === 'back' ? '<button type="button" class="qe ic" aria-label="Back to the last version">' + I.back + '</button>' : '<button type="button" class="qe">' + esc(e) + '</button>'; };
    return '<div class="' + (mode === 'inside' ? 'cb-edin' : 'qes') + '">' + list.map(chip).join('') + '</div>';
  }
  /* his bubble, with Life's mark: corner (on the bubble), tick (where a delivery tick would be), words (a line under:
     its own words, or none) */
  function HisBubble(t, mark, mode, words) {
    if (!mark) return '<div class="bm">' + esc(t) + '</div>';
    if (mode === 'tick') return '<div class="bm">' + esc(t) + '<div class="q">' + ReactionMark(mark) + '</div></div>';
    if (mode === 'words') return '<div class="bm">' + esc(t) + '</div><div class="cb-rxw">' + ReactionMark(mark) + (words === undefined ? (mark === '👍' ? 'Done' : 'On it') : words) + '</div>';
    return '<div class="bm has-rx">' + esc(t) + '<span class="rx"><span>' + mark + '</span></span></div>';
  }
  /* "How am I doing?": bar, under (small marks under the settled row), one (a thumb and a cross); with `kept`, the
     settled state: his mark stays and the words become "Thanks" */
  function RatingRow(mode, kept) {
    var m = [['👎', 'Not good'], ['👍', 'Good'], ['🤩', 'Great']];
    var x = '<button type="button" class="x" aria-label="Not now">' + I.x + '</button>';
    if (kept) return mode === 'under' ? '<div class="cb-rateu"><span class="cb-km">' + ReactionMark(kept) + '</span><span class="cb-thx">Thanks</span></div>' : '<div class="hd"><span class="q">Thanks</span><span class="m">' + ReactionMark(kept) + '</span></div>';
    if (mode === 'under') return '<div class="cb-rateu">' + m.map(function (r) { return '<button type="button" aria-label="' + r[1] + '">' + ReactionMark(r[0]) + '</button>'; }).join('') + x + '</div>';
    if (mode === 'one') return '<div class="hd"><span class="q">Was this right?</span><button type="button" class="m" aria-label="Yes">' + ReactionMark('👍') + '</button><button type="button" class="m" aria-label="No">' + ReactionMark('👎') + '</button>' + x + '</div>';
    return '<div class="hd"><span class="q">How am I doing?</span>' + m.map(function (r) { return '<button type="button" class="m" aria-label="' + r[1] + '">' + ReactionMark(r[0]) + '</button>'; }).join('') + x + '</div>';
  }
  /* Life's settings, no page: rows spaced, no hairline. A row is [title, value, chosen, more]: value true/false is a
     Switch, a list is value pills (the chosen one cream), null is nothing; more = {f: a face, line, saved: the green
     tick of a change that went through, wrong: a cross to say Life's reading is wrong, check: his tick, done or not} */
  function SettingsBlock(rows) {
    return '<div class="cb-set">' + rows.map(function (r) {
      var o = r[3] || {}, v = r[1];
      var tr = typeof v === 'boolean' ? Switch(v) : v ? '<span class="cb-vals">' + v.map(function (x, i) { return '<span class="cb-v' + (i === r[2] ? ' on' : '') + '">' + esc(x) + '</span>'; }).join('') + '</span>' : '';
      return '<div class="cb-setr">' + (o.f ? Face(o.f) : '') + '<span class="cb-sl"><b>' + r[0] + (o.saved ? Saved() : '') + '</b>' + (o.line ? '<small>' + o.line + '</small>' : '') + '</span>' + tr + (o.wrong ? btn('x', 'cb-ic') : '') + (o.check !== undefined ? Check(o.check) : '') + '</div>';
    }).join('') + '</div>';
  }
  function RoundButton(m) { return '<span class="cb-rb">' + (m === 'dot' ? '<i class="cb-rdot"></i>' : I[m] || esc(m)) + '</span>'; }

  /* ---- 4. The ask: its blocks, by the key a card's data names them ---- */
  var B = {
    raw: function (h) { return h; },
    lead: function (t) { return '<div class="bt">' + esc(t) + '</div>'; },
    bt: function (t) { return '<div class="bt">' + t + '</div>'; },
    then: function (t) { return '<div class="cb-then">' + esc(t || 'After the tap') + '</div>'; },
    /* which matter an ask belongs to (or, with none, its subject): its title; its goal by mode: title, goal, tap (opens on a tap) */
    mhead: function (t, goal, mode, f) { return '<div class="cb-mh" data-mt="' + esc(t) + '">' + (f ? Face(f, 'xs') : '') + '<span><b>' + esc(t) + (mode === 'tap' && goal ? '<i class="cb-chev">›</i>' : '') + '</b>' + (goal && mode === 'goal' ? '<small>' + esc(goal) + '</small>' : '') + '</span></div>'; },
    /* a matter's page, pushed like a profile: A sections like a profile; B its thread first; C a short summary, the thread's last lines */
    mpage: function (m, mode) {
      var sec = function (t, body) { return body ? '<section class="cb-ps"><h4>' + t + '</h4>' + body + '</section>' : ''; };
      var faces = '<div class="cb-faces">' + m.people.map(function (p) { return '<button type="button" class="cb-pf">' + Face(p[0]) + '<span>' + esc(p[1]) + '</span></button>'; }).join('') + '</div>';
      var end = m.ending ? '<div class="cb-endc">' + B.step(m.ending[0], 'Yours', '') + Quote(esc(m.ending[1]), m.ending[2]) + '<div class="why">Is this done?</div>' + Answers('Yes, done', ['Not yet'], 'row') + '</div>' : '';
      var asks = m.asks.map(function (a) { return Row(a[0], a[1], a[2]); }).join('');
      var line = function (t) { return /^(in|out)$/.test(t[1]) ? '<div class="cm ' + t[1] + '">' + esc(t[2]) + '<span class="tm">' + t[0] + '</span></div>' : '<div class="cb-tst">' + (t[1] === 'done' ? '<span class="okt">' + I.check + '</span>' : '<span class="cb-dot2"></span>') + '<span>' + esc(t[2]) + '</span><small>' + t[0] + '</small></div>'; };
      /* the next step shows only when no open ask already says it */
      var next = m.asks.length ? '' : m.next;
      var thread = function (list) { return '<div class="chat">' + list.map(line).join('') + '</div>'; };
      if (mode === 'B') return '<div class="cb-mp"><div class="cb-mph"><b>' + esc(m.t) + '</b><small>' + esc(m.g) + '</small></div><div class="cb-st">' + esc(m.status) + '</div>' + faces + thread(m.thread) + end + asks + (next ? '<div class="nx"><small class="sec">Next</small><div>' + esc(next) + '</div></div>' : '') + '</div>';
      if (mode === 'C') return '<div class="cb-mp"><div class="cb-mph"><b>' + esc(m.t) + '</b><small>' + esc(m.g) + '</small></div><div class="cb-st">' + esc(m.status) + (next ? ' Next: ' + esc(next) + '.' : '') + '</div>' + sec('Needs you', end + asks) + faces + sec('Lately', '<button type="button" class="cb-mini">Show earlier</button>' + thread(m.thread.slice(-3))) + '</div>';
      return '<div class="cb-mp a"><div class="cb-mph c"><b>' + esc(m.t) + '</b><small>' + esc(m.g) + '</small><div class="cb-st">' + esc(m.status) + '</div></div>' + sec('Needs you', end + asks) + sec('Next', next && '<div class="cb-nx1">' + esc(next) + '</div>') + sec('Who', faces) + sec('What happened', thread(m.thread)) + '</div>';
    },
    hero: PartyLine,
    why: function (t) { return '<div class="why">' + t + '</div>'; },
    pick: LifesPick,
    option: Option,
    md: Markdown,
    quote: function (text, src) { return Quote(esc(text), src); },
    source: function (app, who, when) { return Source(app, esc(who), when); },
    clip: Clip,
    readalong: ReadAlong,
    /* people to pick from: rows, grid (faces) or chips; the last is always someone new */
    people: function (list, mode, note) {
      var all = list.concat([['ic:plus', 'Someone new', 'Type their name']]);
      if (mode === 'grid') return '<div class="cb-grid">' + all.map(function (p) { return '<button type="button" class="cb-gp">' + Face(p[0]) + '<span>' + esc(p[0].indexOf('ic:') ? p[1].split(' ')[0] : p[1]) + '</span></button>'; }).join('') + '</div>';
      if (mode === 'chips') return '<div class="cb-chips">' + all.map(function (p) { return '<button type="button" class="cb-chip">' + Face(p[0], 'xs') + esc(p[1]) + '</button>'; }).join('') + '</div>';
      return (note ? '<div class="sec">' + esc(note) + '</div>' : '') + '<div class="cb-rows">' + all.map(function (p) { return '<button type="button" class="fr" data-cbans>' + Face(p[0]) + '<span class="tx"><b>' + esc(p[1]) + '</b><small>' + esc(p[2]) + '</small></span></button>'; }).join('') + '</div>';
    },
    /* two people: side by side, or the one person they would become */
    pair: function (a, b, mode) {
      if (mode === 'merged') return '<div class="box cb-merge">' + Face(a[0], 'lg') + '<b>' + esc(a[1]) + '</b>' + a.slice(2).concat(b.slice(2)).map(function (h) { return '<div class="cb-h">' + h + '</div>'; }).join('') + '</div>';
      var one = function (p) { return '<div class="cb-side">' + Face(p[0]) + '<b>' + esc(p[1]) + '</b>' + p.slice(2).map(function (h) { return '<small>' + h + '</small>'; }).join('') + '</div>'; };
      return '<div class="cb-pair">' + one(a) + '<span class="cb-eq">=?</span>' + one(b) + '</div>';
    },
    box: function (rows, amt) { return '<div class="box">' + (amt ? '<div class="amt">' + esc(amt) + '</div>' : '') + rows.map(function (r) { return '<div class="kv"><span>' + esc(r[0]) + '</span><b' + (r[2] ? ' class="mono"' : '') + '>' + esc(r[1]) + '</b></div>'; }).join('') + '</div>'; },
    copyrows: function (rows) { return '<div class="cb-copy">' + rows.map(function (r) { return '<div class="cb-cr"><span><small>' + esc(r[0]) + '</small><b' + (r[2] ? ' class="mono"' : '') + '>' + esc(r[1]) + '</b></span>' + btn('copy', 'cb-ic') + '</div>'; }).join('') + '</div>'; },
    slip: function (t) { return '<div class="cb-slip">' + t + btn('copy', 'cb-mini') + '</div>'; },
    qr: function (amt, src, mode) {
      var code = '<span class="cb-qr' + (mode === 'thumb' ? ' sm' : '') + '" aria-label="Payment code"></span>', from = Source(appIn(src), esc(src));
      if (mode === 'thumb') return '<div class="cb-qrrow">' + code + '<div><div class="amt sm">' + esc(amt) + '</div>' + from + '</div></div>';
      if (mode === 'hidden') return '<div class="box"><div class="amt">' + esc(amt) + '</div>' + from + btn('qr', 'cb-mini wide') + '</div>';
      return '<div class="box cb-qrbig">' + code + '<div class="amt sm">' + esc(amt) + '</div>' + from + '</div>';
    },
    link: function (vendor, domain, title, mode) {
      if (mode === 'card') return '<a class="cb-lcard" href="#" onclick="return false"><span class="cb-lv">' + esc(vendor[0]) + '</span><span><b>' + esc(title) + '</b><small>' + esc(domain) + '</small></span>' + I.open + '</a>';
      if (mode === 'inline') return '<div class="why">Book on <a class="cb-ll" href="#" onclick="return false">' + esc(vendor) + '</a>, it takes a minute.</div>';
      return '<a class="ext" href="#" onclick="return false">Open ' + esc(vendor) + ' ' + I.open + '</a>';
    },
    /* an event: box (rows), day (the slot among his day), line (one sentence and its reminders) */
    event: function (e, mode) {
      var rem = '<div class="cb-rem">' + I.bell + e.rem.map(function (r) { return '<span>' + esc(r) + '</span>'; }).join('') + '</div>';
      if (mode === 'day') return '<div class="box cb-day"><div class="cb-dh">' + esc(e.day) + '</div>' + e.around.map(function (s) { return '<div class="cb-slot' + (s[2] ? ' new' : '') + '"><span>' + esc(s[0]) + '</span><b>' + esc(s[1]) + '</b></div>'; }).join('') + rem + '</div>';
      if (mode === 'line') return '<div class="cb-evl">' + I.cal + '<span><b>' + esc(e.title) + '</b>, ' + esc(e.day) + ' ' + esc(e.time) + '<small>' + esc(e.place) + '</small></span></div>' + rem;
      return '<div class="box"><b>' + esc(e.title) + '</b><div class="kv"><span>When</span><b>' + esc(e.day + ', ' + e.time) + '</b></div><div class="kv"><span>Where</span><b>' + esc(e.place) + '</b></div>' + rem + '</div>';
    },
    /* a paid run: line (estimate, never more than), meter (estimate inside its cap), month (of his monthly amount) */
    spend: function (s, mode) {
      if (mode === 'meter') return '<div class="box"><b>' + esc(s.what) + '</b><div class="cb-meter"><i style="width:' + Math.round(s.est / s.cap * 100) + '%"></i></div><div class="kv"><span>About ' + esc(s.cur + s.est.toFixed(2)) + '</span><span>never more than ' + esc(s.cur + s.cap) + '</span></div></div>';
      if (mode === 'month') return '<div class="why">' + esc(s.what) + '. About ' + esc(s.cur + s.est.toFixed(2)) + ', inside this month’s ' + esc(s.month) + ' (' + esc(s.left) + ' left).</div>';
      return '<div class="cb-spend"><span>' + esc(s.what) + '</span><b>About ' + esc(s.cur + s.est.toFixed(2)) + '</b><small>Never more than ' + esc(s.cur + s.cap) + '</small></div>';
    },
    /* a plan's steps: list (each with who and when), chips (the chain), next (the first, then how many after) */
    plan: function (steps, mode, gathered) {
      var who = function (s) { return s.by === 'owner' ? '<span class="cb-you">You</span>' : Face('L', 'xs life'); };
      var g = gathered ? '<span class="cb-gath">' + I.search + esc(gathered) + '</span>' : '';
      if (mode === 'chips') return '<div class="cb-chain">' + steps.map(function (s) { return '<span class="cb-link' + (s.by === 'owner' ? ' you' : '') + '">' + esc(s.text) + '</span>'; }).join('<i>›</i>') + '</div>' + g;
      if (mode === 'next') return '<div class="nx"><small class="sec">First</small><div>' + esc(steps[0].text) + '</div><small class="cb-more">then ' + (steps.length - 1) + ' more, ' + (steps.filter(function (s) { return s.by === 'owner'; }).length ? 'one is yours' : 'all mine') + '</small></div>' + g;
      return '<ol class="cb-plan">' + steps.map(function (s) { return '<li>' + who(s) + '<span><b>' + esc(s.text) + '</b>' + (s.when ? '<small>' + esc(s.when) + '</small>' : '') + '</span></li>'; }).join('') + '</ol>' + g;
    },
    /* how Life sees a step done: line (status under the card), badge (on the answer), none */
    seen: function (state, text, mode) {
      var g = state === 'seen' ? '<span class="okt">' + I.check + '</span>' : state === 'looking' ? Spinner() : '<span class="cb-dot"></span>';
      return '<div class="' + (mode === 'badge' ? 'cb-badge ' + state : 'cb-seen') + '">' + g + esc(text) + '</div>';
    },
    answers: Answers,
    foot: function (t) { return '<div class="foot">' + esc(t) + '</div>'; },
    chat: DraftBlock,
    edits: EditChips,
    field: function (t) { return '<div class="cb-field">' + esc(t) + '<span class="k">' + I.mic + '</span></div>'; },
    row: Row,
    /* a matter's step on its page; ask: his two marks, the cross then the cream tick on the right */
    step: function (text, line, mode) {
      if (mode === 'struck') return '<div class="cb-step done">' + Check(1) + '<span><s>' + esc(text) + '</s><small>' + line + '</small></span></div>';
      return '<div class="cb-step">' + Check(0) + '<span><b>' + esc(text) + '</b><small>' + line + '</small></span>' + (mode === 'ask' ? '<span class="cb-yn">' + btn('x', 'cb-mk') + btn('check', 'cb-mk rec') + '</span>' : '') + '</div>';
    },
    matter: function (name, line) { return '<div class="cb-matter"><b>' + esc(name) + '</b><small>' + esc(line) + '</small></div>'; },
    bm: HisBubble,
    rate: RatingRow,
    /* a late reply under the ask it follows: quote (the ask as a quiet line atop), thread (hung under the old bubble), goto (a link back) */
    follows: function (ask, reply, mode) {
      if (mode === 'thread') return (ask ? '<div class="bm cb-faded">' + esc(ask) + '</div>' : '') + '<div class="cb-hang">' + reply + '</div>';
      if (mode === 'goto') return '<div class="bt">' + reply + '<div class="cb-goto">' + I.back + 'You asked this at 10:12</div></div>';
      return '<div class="bt"><div class="cb-fq">' + esc(ask) + '</div>' + reply + '</div>';
    },
    ring: StillRing,
    settings: SettingsBlock,
    rounds: function (list) { return '<div class="cb-rounds">' + list.map(RoundButton).join('') + '</div>'; },
    /* a focused, short list on the thread's horizontal axis: one card a page with the next peeking ('full'), two up
       ('two'), or a strip of faces whose chosen one unfolds below ('strip'); dots under it, never a count in words */
    swipe: function (cards, mode, open) {
      var dots = '<div class="cb-swn" aria-hidden="true">' + cards.map(function (c, i) { return '<i' + (i ? '' : ' class="on"') + '></i>'; }).join('') + '</div>';
      if (mode === 'strip') return '<div class="cb-swp strip">' + cards.map(function (c, i) { return '<button type="button" class="cb-sf' + (i === (open || 0) ? ' on' : '') + '">' + Face(c.f) + '<span>' + esc(c.s || c.t) + '</span></button>'; }).join('') + '</div>' + cards.map(function (c, i) { return c.b ? '<div class="cb-swc"' + (i === (open || 0) ? '' : ' hidden') + '>' + draw(c.b) + '</div>' : ''; }).join('');
      return '<div class="cb-swp ' + (mode || 'full') + '">' + cards.map(function (c) { return '<div class="cb-swc">' + draw(c.b) + '</div>'; }).join('') + '</div>' + dots;
    }
  };
  /* draw a card from its config: [[block, ...args], ...] */
  function draw(cfg) { return cfg.map(function (c) { return B[c[0]].apply(null, c.slice(1)); }).join(''); }

  /* ReadAlong plays: the button loads, then each word turns white in turn */
  if (typeof document !== 'undefined') document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('.cb-ra .cb-play'); if (!b || b.classList.contains('busy')) return;
    var ws = b.parentNode.querySelectorAll('.cb-raw i'), i = 0;
    Array.prototype.forEach.call(ws, function (w) { w.classList.remove('on'); });
    b.classList.add('busy');
    setTimeout(function () { b.classList.remove('busy'); var t = setInterval(function () { if (i >= ws.length) return clearInterval(t); ws[i++].classList.add('on'); }, 240); }, 700);
  });

  /* BASE: the shell's own parts, for pages that are not the shell (shell.html has them already). NEW: the card blocks. */
  var BASE = '.cbf{--fg:#fff8ea;--muted:#8a867e;--card:#0b0c0e;--tile:#111214;--tint:rgba(255,248,234,.1);--flag:#f0896f;--ok:#30d158;--ai:#9aa8ec;color:var(--fg);font-size:16px;line-height:1.42;font-weight:450;display:flex;flex-direction:column;gap:12px}' +
    '.cbf *{box-sizing:border-box}:where(.cbf) button{font:inherit;color:inherit;border:0;background:none;padding:0;margin:0;cursor:pointer}' +
    '.cbf .bt{font-size:15.5px;line-height:1.45}.cbf .bm{align-self:flex-end;max-width:300px;padding:8px 12px;border-radius:18px 18px 6px 18px;background:var(--tint);font-size:15px;position:relative}.cbf .bm .q{display:flex;justify-content:flex-end;gap:4px;font-size:11.5px;color:var(--muted);margin-top:3px}' +
    '.cbf .disc{width:40px;height:40px;border-radius:50%;background:#24252b;color:var(--muted);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:16px;flex:none}.cbf .disc svg{width:20px;height:20px}' +
    '.cbf .hero{display:flex;gap:14px;align-items:center}.cbf .hero .disc{width:48px;height:48px;border-radius:50%;font-size:19px}.cbf .htitle{font-size:19px;font-weight:650;line-height:1.25}.cbf .hline{font-size:14px;color:var(--muted)}' +
    '.cbf .why{font-size:14.5px;line-height:1.45;color:#b9b4aa}.cbf .sec{font-size:13px;font-weight:600;color:var(--muted)}.cbf .foot{font-size:13px;color:var(--muted)}.cbf .nx{padding:12px 14px;border-radius:16px;background:#131416;font-size:15px}' +
    '.cbf .box{background:var(--tile);border-radius:18px;padding:14px 16px;display:flex;flex-direction:column;gap:10px}.cbf .kv{display:flex;justify-content:space-between;gap:12px;font-size:14.5px}.cbf .kv span{color:var(--muted)}.cbf .kv b{font-weight:600;text-align:right}' +
    '.cbf .mono{font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:13px;letter-spacing:.02em}.cbf .amt{font-size:34px;font-weight:700;letter-spacing:-.02em}.cbf .ext{display:inline-flex;align-items:center;gap:5px;font-size:13.5px;font-weight:650;color:var(--fg);text-decoration:none;opacity:.8}.cbf .ext svg{width:14px;height:14px}' +
    '.cbf .answers{display:flex;flex-direction:column;gap:8px}.cbf .prim{width:100%;height:48px;border-radius:24px;background:var(--fg);color:#000;font-weight:650;font-size:15.5px;display:flex;align-items:center;justify-content:center;gap:8px}.cbf .prim svg{width:18px;height:18px}' +
    '.cbf .two{display:flex;gap:8px}.cbf .two .sec{flex:1;height:48px;border-radius:24px;background:var(--tint);font-size:14.5px;font-weight:600;color:var(--fg);display:flex;align-items:center;justify-content:center}.cbf .two .sec.rec{background:var(--fg);color:#000}' +
    '.cbf .fr{display:flex;align-items:center;gap:14px;padding:7px 0;text-align:left;width:100%}.cbf .tx{flex:1;min-width:0}.cbf .tx b{display:block;font-size:16px;font-weight:650}.cbf .tx small{display:flex;align-items:center;gap:5px;font-size:13.5px;color:var(--muted)}' +
    '.cbf .okt{display:inline-flex;color:var(--ok)}.cbf .okt svg{width:13px;height:13px}.cbf .pie{width:14px;height:14px}.cbf .spin{width:11px;height:11px;border-radius:50%;border:1.6px solid currentColor;border-right-color:transparent;display:inline-block;animation:cbspin .8s linear infinite}' +
    '.cbf .chat{display:flex;flex-direction:column;gap:6px}' +
    '.cbf .cm{max-width:80%;padding:8px 12px 7px;border-radius:16px;font-size:15px;line-height:1.4}.cbf .cm.in{align-self:flex-start;background:#17181c;border-top-left-radius:5px}.cbf .cm.out{align-self:flex-end;background:#1f3a2e;border-top-right-radius:5px}.cbf .cm .tm{margin-left:8px;font-size:11px;color:var(--muted)}.cbf .cm.draft{background:none;outline:1.5px dashed rgba(255,248,234,.45);outline-offset:-1.5px}' +
    '.cbf .qes{display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap}.cbf .qe{height:30px;padding:0 12px;border-radius:15px;background:var(--tint);font-size:13px;font-weight:600;color:#b9b4aa;display:inline-flex;align-items:center}.cbf .qe.ic{width:30px;padding:0;justify-content:center}.cbf .qe svg{width:15px;height:15px}' +
    '.cbf .hd{display:flex;align-items:center;gap:6px;padding:5px 4px 5px 16px;border-radius:24px;background:var(--card)}.cbf .hd .q{flex:1;font-size:14.5px;color:#b9b4aa}.cbf .hd .m,.cbf .hd .x{width:40px;height:40px;border-radius:20px;display:flex;align-items:center;justify-content:center;font-size:20px;color:var(--muted)}.cbf .hd .x svg{width:16px;height:16px}' +
    '.cbf .rx{position:absolute;bottom:-12px;left:-6px;height:24px;min-width:24px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:13px;background:#2a2b31;box-shadow:0 0 0 2.5px #000}.cbf .rx>span{filter:grayscale(1) brightness(1.1);opacity:.85}';
  var NEW = '.cb-set{background:var(--card);border-radius:18px;padding:0 16px}.cb-setr{display:flex;align-items:center;gap:12px;min-height:52px;padding:4px 0}.cb-sl{flex:1;min-width:0}.cb-setr b{display:block;font-size:16px;font-weight:650}.cb-setr small{display:block;font-size:13px;color:#8a867e}' +
    '.cb-sw{width:51px;height:31px;border-radius:16px;background:var(--tint);position:relative;flex:none}.cb-sw i{position:absolute;top:2px;left:2px;width:27px;height:27px;border-radius:50%;background:var(--fg)}.cb-sw.on{background:var(--fg)}.cb-sw.on i{left:22px;background:#000}' +
    '.cb-vals{display:flex;gap:4px}.cb-v{height:32px;padding:0 12px;border-radius:16px;background:var(--tint);font-size:13.5px;font-weight:600;display:flex;align-items:center}.cb-v.on{background:var(--fg);color:#000}' +
    '.cb-rounds{display:flex;gap:10px}.cb-rb{width:44px;height:44px;border-radius:50%;background:rgba(255,248,234,.14);display:flex;align-items:center;justify-content:center;font-weight:650}.cb-rb svg{width:18px;height:18px}.cb-rdot{width:9px;height:9px;border-radius:50%;background:var(--fg)}' +
    '.cb-swp{display:flex;align-items:flex-start;gap:10px;overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-width:none;overscroll-behavior-x:contain;margin:0 -16px;padding:0 16px;scroll-padding:0 16px}.cb-swp::-webkit-scrollbar{display:none}.cb-swp>*{flex:0 0 86%;scroll-snap-align:start}.cb-swp.two>*{flex-basis:calc(46% - 5px)}.cb-swp.two .htitle{font-size:16px}' +
    '.cb-swc{background:var(--tile);border-radius:18px;padding:14px;display:flex;flex-direction:column;gap:12px}.cb-swn{display:flex;justify-content:center;align-items:center;gap:6px;font-size:11.5px;color:var(--muted)}.cb-swn i{width:6px;height:6px;border-radius:50%;background:var(--tint)}.cb-swn i.on{background:var(--fg)}.cb-swn span{margin-left:6px}' +
    '.cb-swp.strip>*{flex:0 0 auto}.cb-sf{display:flex;flex-direction:column;align-items:center;gap:6px;width:72px;font-size:11.5px;color:var(--muted);text-align:center;line-height:1.25}.cb-sf{opacity:.5}.cb-sf.on{opacity:1;color:var(--fg)}' +
    '.cb-em{filter:grayscale(1) brightness(1.1);opacity:.85}.cb-then{align-self:center;font-size:11.5px;color:var(--muted);padding:2px 10px;border-radius:10px;background:rgba(255,248,234,.06)}' +
    '.disc.sm{width:28px;height:28px;font-size:12px}.disc.xs{width:22px;height:22px;font-size:10px}.disc.lg{width:56px;height:56px;font-size:22px}.disc.life{background:#9aa8ec;color:#000}' +
    '.cb-md{font-size:14.5px;line-height:1.5;color:#d9d4ca}.cb-md p,.cb-md ul{margin:0 0 6px}.cb-md ul{padding-left:18px}.cb-md .cb-src,.cb-qs{font-size:12.5px;color:var(--muted)}.cb-ll{color:var(--fg);text-decoration:underline;text-decoration-color:rgba(255,248,234,.35);text-underline-offset:3px}' +
    '.cb-q{display:flex;flex-direction:column;gap:4px;margin:4px 0}.cb-q .cm{align-self:flex-start;max-width:92%;color:var(--fg)}' +
    '.cb-clip{display:flex;gap:12px;align-items:flex-start}.cb-clip.pill{align-items:center;padding:6px 14px 6px 6px;border-radius:24px;background:var(--tint);align-self:flex-start}.cb-clip.text{align-items:center;font-size:15px}.cb-clip small,.cb-dur{display:block;font-size:12px;color:var(--muted)}' +
    '.cb-play{width:40px;height:40px;border-radius:20px;background:var(--fg);color:#000;display:flex;align-items:center;justify-content:center;flex:none}.cb-play svg{width:18px;height:18px}.cb-play.sm{width:30px;height:30px}.cb-play.sm svg{width:14px;height:14px}' +
    '.cb-cw{flex:1;min-width:0}.cb-wave{display:flex;align-items:center;gap:2px;height:24px}.cb-wave i{width:3px;border-radius:2px;background:rgba(255,248,234,.55)}.cb-words{font-size:14.5px;margin-top:4px}' +
    '.cb-rows{display:flex;flex-direction:column}.cb-rows .fr{text-align:left;width:100%}.cb-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}.cb-gp{display:flex;flex-direction:column;align-items:center;gap:6px;font-size:12.5px;color:var(--muted)}.cb-gp .disc{width:54px;height:54px;font-size:20px}' +
    '.cb-chips{display:flex;flex-wrap:wrap;gap:6px}.cb-chip{height:34px;padding:0 12px 0 6px;border-radius:17px;background:var(--tint);display:inline-flex;align-items:center;gap:7px;font-size:13.5px;font-weight:600}' +
    '.cb-pair{display:flex;align-items:stretch;gap:8px}.cb-side{flex:1;min-width:0;display:flex;flex-direction:column;align-items:center;gap:4px;padding:14px 8px;border-radius:18px;background:var(--tile);text-align:center}.cb-side small{font-size:12px;color:var(--muted);overflow-wrap:anywhere}.cb-eq{align-self:center;color:var(--muted);font-weight:700}' +
    '.cb-merge{align-items:center;text-align:center}.cb-h{font-size:13px;color:var(--muted)}' +
    '.cb-copy{display:flex;flex-direction:column;border-radius:18px;background:var(--tile);padding:4px 6px 4px 16px}.cb-cr{display:flex;align-items:center;gap:10px;padding:8px 0}.cb-cr span{flex:1;min-width:0}.cb-cr small{display:block;font-size:12px;color:var(--muted)}.cb-cr b{font-weight:600}' +
    '.cb-ic{width:40px;height:40px;border-radius:20px;display:flex;align-items:center;justify-content:center;color:var(--muted)}.cb-ic svg{width:18px;height:18px}' +
    '.cb-slip{font-size:16px;line-height:1.5;padding:14px 16px;border-radius:18px;background:var(--tile);display:flex;flex-direction:column;gap:10px}.cb-slip b{font-weight:650}' +
    '.cb-mini{align-self:flex-start;height:32px;padding:0 12px;border-radius:16px;background:var(--tint);display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:650}.cb-mini svg{width:14px;height:14px}.cb-mini.wide{align-self:stretch;justify-content:center;height:40px}' +
    '.cb-qr{width:168px;height:168px;border-radius:10px;background-color:#fff;background-image:repeating-conic-gradient(#000 0 25%,#fff 0 50%);background-size:24px 24px;box-shadow:inset 0 0 0 10px #fff;align-self:center}.cb-qr.sm{width:84px;height:84px;background-size:12px 12px;box-shadow:inset 0 0 0 6px #fff}' +
    '.cb-qrbig{align-items:center}.cb-qrrow{display:flex;gap:14px;align-items:center}.amt.sm{font-size:24px}' +
    '.cb-gath{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px 0 6px;border-radius:14px;background:var(--tint);font-size:12.5px;font-weight:600;color:var(--fg);text-decoration:none;align-self:flex-start}.cb-gath svg{width:16px;height:16px}' +
    '.cb-lcard{display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:18px;background:var(--tile);color:var(--fg);text-decoration:none}.cb-lcard span:nth-child(2){flex:1;min-width:0}.cb-lcard b{display:block;font-size:15px;font-weight:650}.cb-lcard small{font-size:12.5px;color:var(--muted)}.cb-lcard svg{width:16px;height:16px;color:var(--muted)}' +
    '.cb-lv{width:36px;height:36px;border-radius:50%;background:#2a2b31;display:flex;align-items:center;justify-content:center;font-weight:700}' +
    '.cb-rem{display:flex;align-items:center;gap:6px;flex-wrap:wrap;color:var(--muted)}.cb-rem svg{width:15px;height:15px}.cb-rem span{height:28px;padding:0 10px;border-radius:14px;background:var(--tint);color:var(--fg);font-size:12.5px;font-weight:600;display:inline-flex;align-items:center}' +
    '.cb-dh{font-size:13px;font-weight:650;color:var(--muted)}.cb-slot{display:flex;gap:12px;padding:8px 10px;border-radius:10px;font-size:14px;color:var(--muted)}.cb-slot span{width:44px;font-variant-numeric:tabular-nums}.cb-slot.new{background:rgba(154,168,236,.16);color:var(--fg)}.cb-slot b{font-weight:600}' +
    '.cb-evl{display:flex;gap:12px;align-items:flex-start;font-size:15.5px}.cb-evl svg{width:22px;height:22px;flex:none;margin-top:1px}.cb-evl small{display:block;font-size:13.5px;color:var(--muted)}' +
    '.cb-spend{display:grid;grid-template-columns:1fr auto;gap:2px 12px;padding:12px 16px;border-radius:18px;background:var(--tile);font-size:14.5px}.cb-spend b{font-weight:650}.cb-spend small{grid-column:2;text-align:right;font-size:12.5px;color:var(--muted)}' +
    '.cb-meter{height:8px;border-radius:4px;background:var(--tint);overflow:hidden}.cb-meter i{display:block;height:100%;border-radius:4px;background:var(--fg)}' +
    '.cb-plan{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:12px}.cb-plan li{display:flex;gap:12px;align-items:flex-start}.cb-plan b{display:block;font-size:15px;font-weight:600}.cb-plan small{display:block;font-size:13px;color:var(--muted)}' +
    '.cb-you{height:22px;padding:0 7px;border-radius:11px;background:var(--fg);color:#000;font-size:11px;font-weight:700;display:inline-flex;align-items:center;flex:none}' +
    '.cb-chain{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:13.5px}.cb-chain i{font-style:normal;color:var(--muted)}.cb-link{padding:6px 10px;border-radius:12px;background:var(--tile)}.cb-link.you{background:var(--fg);color:#000;font-weight:650}.cb-more{display:block;margin-top:4px;color:var(--muted);font-size:13px}' +
    '.cb-seen{display:flex;align-items:center;gap:6px;font-size:13.5px;color:var(--muted)}.cb-dot{width:7px;height:7px;border-radius:4px;background:#f0896f;display:inline-block}' +
    '.cb-badge{align-self:center;display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 12px;border-radius:14px;background:var(--tint);font-size:12.5px;font-weight:600}.cb-badge.seen{color:var(--ok)}' +
    '.cb-row .sec{height:48px}.cb-list{display:flex;flex-direction:column;gap:6px}.cb-li{height:46px;border-radius:23px;background:var(--tint);font-weight:600;font-size:15px}.cb-li.rec{background:var(--fg);color:#000;font-weight:650}' +
    '.cb-marks{display:flex;gap:10px;justify-content:center}.cb-mk{width:52px;height:52px;border-radius:26px;background:var(--tint);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:650}.cb-mk svg{width:22px;height:22px}.cb-mk.rec{background:var(--fg);color:#000}' +
    '.cm mark{background:rgba(154,168,236,.28);color:inherit;border-radius:3px;padding:0 1px}.cb-mh{display:flex;align-items:center;gap:8px;margin-bottom:-4px}.cb-mh b{display:flex;align-items:center;gap:4px;font-size:13px;font-weight:650;color:var(--muted)}.cb-mh small{display:block;font-size:13.5px;color:#d9d4ca}.cb-chev{font-style:normal;font-size:16px;line-height:1}.cb-mh[data-mt]{cursor:pointer}.cb-mp{display:flex;flex-direction:column;gap:16px}.cb-mph b{display:block;font-size:22px;font-weight:700;letter-spacing:-.015em}.cb-mph small{display:block;font-size:14.5px;color:#d9d4ca}.cb-mph.c{text-align:center}.cb-mph.c b{font-size:26px}.cb-st{font-size:14.5px;color:var(--muted);margin-top:4px}.cb-ps{display:flex;flex-direction:column;gap:6px}.cb-ps h4{margin:0;font-size:13px;font-weight:650;color:var(--muted)}.cb-nx1{font-size:15.5px;font-weight:600}.cb-faces{display:flex;gap:14px}.cb-pf{display:flex;flex-direction:column;align-items:center;gap:4px;font-size:12.5px;color:var(--muted)}.cb-endc{display:flex;flex-direction:column;gap:8px;padding:10px 12px 12px;border-radius:18px;background:rgba(255,248,234,.05)}.cb-tst{display:flex;align-items:center;gap:8px;font-size:13.5px;color:var(--muted);padding:2px 0}.cb-tst span:nth-child(2){flex:1}.cb-tst small{font-size:11.5px}.cb-dot2{width:6px;height:6px;border-radius:3px;background:var(--muted);margin:0 3.5px}.cb-edin{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}' +
    '.cb-field{display:flex;align-items:center;justify-content:space-between;height:48px;padding:0 6px 0 18px;border-radius:24px;background:rgba(26,27,32,.9);color:var(--muted);font-size:15.5px}.cb-field .k{width:36px;height:36px;border-radius:18px;background:var(--tint);display:flex;align-items:center;justify-content:center;color:var(--fg)}.cb-field svg{width:18px;height:18px}' +
    '.cb-old{opacity:.4}.cb-step{display:flex;gap:12px;align-items:flex-start;padding:8px 0}.cb-step>span:nth-child(2){flex:1;min-width:0}.cb-step b,.cb-step s{display:block;font-size:15.5px;font-weight:600}.cb-step small{display:block;font-size:13px;color:var(--muted)}.cb-step.done s{color:var(--muted)}' +
    '.cb-box{width:24px;height:24px;border-radius:12px;box-shadow:inset 0 0 0 1.8px rgba(255,248,234,.4);flex:none;margin-top:1px;display:flex;align-items:center;justify-content:center}.cb-box.on{background:var(--ok);box-shadow:none;color:#000}.cb-box svg{width:14px;height:14px}' +
    '.cb-yn{display:flex;gap:6px}.cb-yn .cb-mk{width:36px;height:36px}.cb-yn .cb-mk svg{width:16px;height:16px}' +
    '.cb-matter{padding-bottom:4px}.cb-matter b{display:block;font-size:19px;font-weight:650}.cb-matter small{font-size:13.5px;color:var(--muted)}' +
    '.cb-rxw{align-self:flex-end;display:flex;gap:6px;align-items:center;font-size:12.5px;color:var(--muted);margin-top:-6px}' +
    '.cb-rateu{display:flex;gap:2px;align-items:center;margin:-6px 0 0 58px}.cb-rateu button{width:34px;height:34px;border-radius:17px;font-size:16px;color:var(--muted);display:flex;align-items:center;justify-content:center}.cb-rateu svg{width:14px;height:14px}' +
    '.cb-faded{opacity:.5}.cb-new{display:inline-block;margin-left:6px;font-size:11px;font-weight:700;color:#000;background:var(--ai,#9aa8ec);border-radius:8px;padding:1px 6px;vertical-align:1px}.cb-hang{margin-left:34px;font-size:15.5px;line-height:1.45}' +
    '.cb-fq{font-size:13px;color:var(--muted);margin-bottom:6px}.cb-goto{display:flex;align-items:center;gap:5px;margin-top:6px;font-size:12.5px;color:var(--muted)}.cb-goto svg{width:13px;height:13px}';

  /* the parts added on 26 Nov: Source, Life's blue, coral, Undo, Saved, ReadAlong, Option, Thanks */
  NEW += '@keyframes cbspin{to{transform:rotate(360deg)}}.cb-td{font-style:normal;color:#f0896f}.cb-ai{color:#9aa8ec}b.cb-ai{font-weight:650}.cb-tag{font-size:12px;margin-left:6px}.cb-undo{color:#fff8ea;font-weight:650}' +
    '.cb-saved{display:inline-flex;width:15px;height:15px;margin-left:6px;vertical-align:-2px;color:#30d158}.cb-saved svg{width:15px;height:15px}.disc.xl{width:96px;height:96px;font-size:34px}' +
    '.cb-nm{width:24px;height:24px;flex:none;display:flex;align-items:center;justify-content:center}.cb-nm svg{width:24px;height:24px}.cb-nm.line{color:#8a867e}.cb-nm.line svg{width:20px;height:20px}' +
    '.cb-source{display:flex;align-items:center;gap:8px;min-height:32px;color:#fff8ea;text-decoration:none}.cb-source b{font-size:14.5px;font-weight:650;white-space:nowrap}.cb-source small{font-size:12.5px;color:#8a867e}' +
    '.cb-open{margin-left:auto;height:30px;padding:0 10px 0 12px;border-radius:15px;background:rgba(var(--app),.12);color:var(--appink);font-size:12.5px;font-weight:650;display:flex;align-items:center;gap:4px;white-space:nowrap}.cb-open svg{width:14px;height:14px}' +
    '.cb-chat .cm.out{background:rgba(var(--app),.16)}.cb-chat .cm.draft{background:rgba(var(--app),.08);outline:1.5px dashed rgba(var(--app),.55);outline-offset:-1.5px}' +
    '.cb-ra{display:flex;gap:12px;align-items:flex-start}.cb-raw{flex:1;font-size:15.5px;line-height:1.45;padding-top:9px}.cb-raw i{font-style:normal;color:rgba(255,248,234,.36);transition:color .25s}.cb-raw i.on{color:#fff8ea}' +
    '.cb-play.busy svg{display:none}.cb-play.busy::after{content:"";width:16px;height:16px;border-radius:50%;border:2px solid rgba(0,0,0,.2);border-top-color:#000;animation:cbspin .8s linear infinite}@media (prefers-reduced-motion:reduce){.cb-raw i{transition:none}}' +
    '.cb-opt{display:flex;gap:12px;align-items:flex-start;width:100%;padding:14px 16px;border-radius:18px;background:#111214;text-align:left}.cb-opt.on{background:#1b1c20}.cb-radio{width:18px;height:18px;border-radius:9px;flex:none;margin-top:2px;box-shadow:inset 0 0 0 1.6px #8a867e}.cb-opt.on .cb-radio{box-shadow:inset 0 0 0 5px #fff8ea}.cb-opt b{font-size:15.5px;font-weight:650}.cb-opt small{display:block;font-size:13.5px;color:#b9b4aa;line-height:1.4;margin-top:2px}' +
    '.cb-thx{font-size:13px;color:#8a867e;margin-left:6px}.cb-km{width:34px;height:34px;display:flex;align-items:center;justify-content:center;font-size:16px}.hd .m .cb-em{display:inline-block;transform:scale(1.1)}';
  window.CB = { B: B, I: I, T: T, APPS: APPS, draw: draw, esc: esc, face: Face, ring: StillRing, ai: LifesWords, undo: Undo, saved: Saved, sw: Switch, check: Check, css: { base: BASE, cards: NEW } };
})();
