import LifeConnector
import SwiftUI
import UIKit

/// The exact message he approves, as a strip of the chat it goes into (decision 82, `gen_drafts.py`): the chat's head,
/// its last messages in the platform's bubble shapes in Life's greys, then the draft in the platform's full sent colour
/// on a shadow, with "Not sent" where the ticks will be. Mail is a small mail sheet instead. Kit decides what
/// each line is (`chatLines`, `textRuns`, `DraftDelivery`); a reply, a reaction, mentions or a file show only when the
/// draft carries them, never by network. The look alone is the network's (`ChatLook`).
struct DraftBlock: View {
    let check: Check
    let draft: Check.Draft
    /// Where the send stands: the ticks spring in and the shadow fades as its steps pass.
    var delivery = DraftDelivery.notSent
    /// On paper of its own (the notification); in an ask it sits on the thing's `tile` with no box.
    var isBoxed = true

    @Environment(\.calendar) private var calendar

    init?(check: Check, delivery: DraftDelivery = .notSent, isBoxed: Bool = true) {
        guard let draft = check.draft else { return nil }
        (self.check, self.draft, self.delivery, self.isBoxed) = (check, draft, delivery, isBoxed)
    }

    private var look: ChatLook { ChatLook.of(draft.channel) }
    /// Life's steps say it went: the shadow fades. One that may have gone stays drafted.
    private var isSent: Bool { delivery == .handed || delivery == .sent }

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.xs) {
            ChatHead(check: check, draft: draft, look: look).padding(.bottom, Metrics.Spacing.s)
            if check.replaces != nil {
                // ponytail: the plain muted line until the final design pass draws it.
                Text("Replaces an older draft").font(.small).foregroundStyle(Palette.muted)
            }
            if draft.isMail { mail } else { chat }
        }
        .padding(isBoxed ? Metrics.Spacing.l : 0)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(isBoxed ? Palette.paper : .clear, in: .rect(cornerRadius: Metrics.Radius.passage))
        .motion(Motion.rise, value: delivery)
        .accessibilityElement(children: .combine)
    }

    // MARK: A chat

    @ViewBuilder private var chat: some View {
        let lines = draft.chatLines(calendar: calendar)
        ForEach(lines.indices, id: \.self) { i in line(lines[i]) }
        if let reaction = draft.reaction, let quoted = draft.quoted {
            // Nothing proves which of the last messages it is: the message reacted to shows apart, as Life stamped
            // it, the emoji on its corner.
            quote(quoted).padding(.top, Metrics.Spacing.s)
                .overlay(alignment: .bottomTrailing) {
                    Text(reaction).font(.note).padding(.horizontal, 7).padding(.vertical, 1)
                        .background(look.sent, in: .capsule)
                        .modifier(Drafted(isSent: isSent))
                        .offset(x: -Metrics.Spacing.s, y: Metrics.Spacing.m)
                }
                .padding(.bottom, Metrics.Spacing.m)
            status(isMine: false)
        } else {
            if look.isCaptionApart, let file = draft.file, draft.text != nil {
                side(isMine: true) { drafted(fileRow(file.name, size: file.size, glyph: file.glyph)) }
                side(isMine: true) { drafted(words) }
            } else {
                side(isMine: true) { drafted(draftContent) }
            }
            status(isMine: true)
        }
    }

    @ViewBuilder private func line(_ line: Check.Draft.ChatLine) -> some View {
        if let day = line.newDay {
            Text(day.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated)))
                .font(.small).foregroundStyle(Palette.muted).frame(maxWidth: .infinity)
                .padding(.vertical, Metrics.Spacing.xs)
        }
        if let sender = line.sender {
            Text(sender.name).font(.smallStrong).foregroundStyle(ChatLook.senders[sender.tone % ChatLook.senders.count])
                .padding(.leading, Metrics.Spacing.xs).padding(.top, Metrics.Spacing.xs)
        }
        side(isMine: line.isMine) {
            VStack(alignment: .leading, spacing: Metrics.Spacing.xs) {
                if let file = line.file {
                    fileRow(file.name, size: file.size, glyph: file.kind.glyph)
                }
                if let text = line.text { Text(text) }
            }
            .font(.note).foregroundStyle(Palette.fg)
            .padding(.horizontal, 11).padding(.vertical, 7)
            .background(line.isMine ? Color.pick : Color.fillTint, in: bubble(isMine: line.isMine))
        }
    }

    /// The draft's own bubble: its subject (a new issue's title), the message it replies to, its file, its words.
    private var draftContent: some View {
        VStack(alignment: .leading, spacing: 5) {
            if let subject = draft.subject { Text(subject).font(.bodyBold) }
            if let quoted = draft.quoted { quote(quoted) }
            if let file = draft.file { fileRow(file.name, size: file.size, glyph: file.glyph) }
            if draft.text != nil { words }
        }
    }

    /// The message a reply or a reaction is on, as Life stamped it: its sender as the network named them, one line of
    /// its words, in the platform's quote (WhatsApp's with its bar).
    private func quote(_ quoted: Check.Draft.Quoted) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(quoted.sender).font(.smallStrong).foregroundStyle(look.bar)
            Text(quoted.text).font(.small).lineLimit(1).opacity(0.9)
        }
        .padding(.horizontal, 9).padding(.vertical, 5).frame(maxWidth: .infinity, alignment: .leading)
        .background(look.quoteTint, in: .rect(cornerRadius: Metrics.Radius.tile))
        .overlay(alignment: .leading) { if look.hasQuoteBar { look.bar.frame(width: 3) } }
        .clipShape(.rect(cornerRadius: Metrics.Radius.tile))
    }

    /// His words, each mention the draft names drawn the platform's way.
    private var words: Text {
        draft.textRuns.reduce(Text(verbatim: "")) { all, run in
            let piece = run.isMention ? Text(run.text).bold().foregroundStyle(look.mention) : Text(run.text)
            return Text("\(all)\(piece)")
        }
    }

    /// A drafted bubble: the platform's full sent colour on a shadow until it is sent.
    private func drafted(_ content: some View) -> some View {
        content.font(.note).foregroundStyle(look.text)
            .padding(.horizontal, 11).padding(.vertical, 7)
            .background(look.sent, in: bubble(isMine: true))
            .modifier(Drafted(isSent: isSent))
    }

    private func bubble(isMine: Bool) -> UnevenRoundedRectangle {
        let (r, t) = (look.radius, look.tail)
        return UnevenRoundedRectangle(
            topLeadingRadius: r, bottomLeadingRadius: isMine ? r : t, bottomTrailingRadius: isMine ? t : r,
            topTrailingRadius: r)
    }

    /// One message on its side, leaving the other side's room open as the platform does.
    private func side(isMine: Bool, @ViewBuilder _ content: () -> some View) -> some View {
        HStack(spacing: 0) {
            if isMine { Spacer(minLength: Metrics.Spacing.xxl) }
            content()
            if !isMine { Spacer(minLength: Metrics.Spacing.xxl) }
        }
    }

    // MARK: Mail

    @ViewBuilder private var mail: some View {
        let sheet = check.mailSheet
        if let thread = sheet?.thread {
            let who = Text(thread.sender).foregroundStyle(Palette.fg).bold()
            let when = thread.at.map { " · " + $0.formatted(.dateTime.day().month(.abbreviated)) } ?? ""
            Text("\(who)\(when) · \(thread.text)").font(.note).foregroundStyle(Palette.muted).lineLimit(1)
        }
        VStack(alignment: .leading, spacing: 6) {
            ForEach(sheet?.fields ?? [], id: \.label) { field in
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Text(field.label).foregroundStyle(Palette.muted).frame(width: 52, alignment: .leading)
                    Text(field.value).fontWeight(field.isBold ? .semibold : nil)
                }
                .font(.note)
            }
            if draft.text != nil { words.font(.body15).padding(.top, 2) }
            if let file = draft.file {
                Label("\(file.name) · \(file.size.formatted(.byteCount(style: .file)))", systemImage: file.glyph)
                    .font(.note)
                    .padding(.horizontal, 10).padding(.vertical, 6)
                    .background(Color.fillTint, in: .rect(cornerRadius: Metrics.Radius.tile))
            }
        }
        .foregroundStyle(Palette.fg).padding(Metrics.Spacing.m).frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.pick, in: .rect(cornerRadius: Metrics.Radius.tile))
        .modifier(Drafted(isSent: isSent))
        status(isMine: true)
    }

    // MARK: Parts

    private func fileRow(_ name: String, size: Int?, glyph: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: glyph).frame(width: 36, height: 36)
                .background(look.quoteTint, in: .rect(cornerRadius: Metrics.Radius.tile))
            VStack(alignment: .leading, spacing: 0) {
                Text(name).fontWeight(.semibold)
                if let size { Text(size.formatted(.byteCount(style: .file))).font(.small).opacity(0.75) }
            }
        }
    }

    /// Where the ticks will be: "Not sent" and a clock; once handed, one tick; once in the chat, two; a call that never
    /// gave its answer, "May have gone".
    private func status(isMine: Bool) -> some View {
        HStack(spacing: 5) {
            switch delivery {
            case .notSent: Image(systemName: "clock")
            case .mayHaveGone: Image(systemName: "questionmark.circle")
            case .handed: Image(systemName: "checkmark").transition(.scale.combined(with: .opacity))
            case .sent:
                HStack(spacing: -7) {
                    Image(systemName: "checkmark")
                    Image(systemName: "checkmark")
                }
                .transition(.scale.combined(with: .opacity))
            }
            Text(statusWords)
        }
        .font(.small).foregroundStyle(Palette.muted)
        .frame(maxWidth: .infinity, alignment: isMine ? .trailing : .leading)
    }

    private var statusWords: String {
        switch delivery {
        case .notSent: "Not sent"
        case .handed: "Sending"
        case .sent: "Sent"
        case .mayHaveGone: "May have gone"
        }
    }
}

/// A draft card's head: the network's mark, the chat's name (Life's guess of who with a "~", no more), and, when the
/// chat has a link of its network's, the arrow that opens it there.
private struct ChatHead: View {
    let check: Check
    let draft: Check.Draft
    let look: ChatLook

    @Environment(\.openURL) private var openURL

    var body: some View {
        let url = check.networkIdentity?.openUrl
        Button {
            if let url { openURL(url) }
        } label: {
            HStack(spacing: Metrics.Spacing.s) {
                NetworkMark(network: draft.channel)
                Text(name).font(.rowName).foregroundStyle(Palette.fg).lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if let people = draft.people, people > 1 {
                    Text("\(people) people").font(.small).foregroundStyle(Palette.muted)
                }
                if url != nil {
                    Image(systemName: "arrow.up.right").font(.smallStrong).foregroundStyle(Palette.fg)
                        .frame(width: 32, height: 32).background(Color.fillTint, in: .circle)
                }
            }
            .frame(minHeight: Metrics.tapTarget).contentShape(.rect)
        }
        .buttonStyle(.plain).disabled(url == nil)
    }

    private var network: String { check.head?.network ?? Channel.name(draft.channel) }

    private var name: String {
        if draft.isMail {
            return [network, draft.quoted?.subject ?? draft.subject].compactMap(\.self).joined(separator: " · ")
        }
        let name =
            check.isRecipientGuessed
            ? "~ " + (check.networkIdentity?.shownName ?? draft.to) : check.head?.name ?? draft.to
        return look.namesNetwork ? "\(name) · \(network)" : name
    }
}

/// A drafted part's mark: a soft shadow, gone once it is sent (no outline: nothing here is drawn with one).
private struct Drafted: ViewModifier {
    let isSent: Bool

    func body(content: Content) -> some View {
        content
            .shadow(color: .black.opacity(isSent ? 0 : 0.28), radius: 6, y: 2)
            .animation(Motion.undrafted, value: isSent)
    }
}

/// A platform's look in a draft's chat, keyed by the draft's channel: a style token table (decision 82), never what a
/// chat can do. Its colours are the platforms' own, dark then light, the one colour-literal exception besides the
/// pendant's drawing (`apps/ios/AGENTS.md`); a network it doesn't know takes Life's filled look.
struct ChatLook {
    var sent: AnyShapeStyle
    var text: Color
    var quoteTint: Color
    /// The quoted sender's colour, and the bar at the quote's left where the platform draws one.
    var bar: Color
    var hasQuoteBar = false
    var mention: Color
    var radius: CGFloat
    /// The corner on his side's foot, a tail.
    var tail: CGFloat
    /// A file then its words as a second bubble, as it will really arrive (Messages.app).
    var isCaptionApart = false
    /// The head names the network ("iMessage"), where its bubble alone doesn't.
    var namesNetwork = false

    /// A group's sender colours, in the order they first wrote.
    static let senders = [
        Palette.token(dark: 0xffb162, light: 0xb5640a), Palette.token(dark: 0x7bc8f6, light: 0x0f6fa8),
        Palette.token(dark: 0xe28fd1, light: 0xa23c8f),
    ]

    static func of(_ channel: String?) -> ChatLook {
        switch channel {
        case "whatsapp":
            solid(
                Palette.token(dark: 0x005c4b, light: 0xd9fdd3), text: Palette.token(dark: 0xe9edef, light: 0x111b21),
                shade: (0.22, 0.07), bar: Palette.token(dark: 0x06cf9c, light: 0x1fa855),
                mention: Palette.token(dark: 0x53bdeb, light: 0x027eb5), radius: 12, tail: 3, hasQuoteBar: true)
        case "imessage":
            solid(
                Palette.token(dark: 0x0b84ff, light: 0x0b84ff), shade: (0.18, 0.14),
                bar: Palette.token(dark: 0xcfe6ff, light: 0xe6f2ff), radius: 18, tail: 6, isCaptionApart: true,
                namesNetwork: true)
        case "line":
            solid(
                Palette.token(dark: 0x06c755, light: 0x06c755), shade: (0.16, 0.12),
                bar: Palette.token(dark: 0xe6ffef, light: 0xe6ffef), radius: 16, tail: 4)
        case "telegram":
            solid(
                Palette.token(dark: 0x2b5278, light: 0xeffdde), text: Palette.token(dark: 0xffffff, light: 0x000000),
                shade: (0.2, 0.06), bar: Palette.token(dark: 0x6ab3f3, light: 0x3a8e26),
                mention: Palette.token(dark: 0x8ecbff, light: 0x168acd), radius: 14, tail: 4)
        case "messenger":
            solid(
                Palette.token(dark: 0x0866ff, light: 0x0866ff), shade: (0.18, 0.14),
                bar: Palette.token(dark: 0xdbe8ff, light: 0xe6efff), radius: 18, tail: 5)
        case "instagram":
            ChatLook(
                sent: AnyShapeStyle(
                    LinearGradient(
                        colors: [
                            Palette.token(dark: 0x7a3cf7, light: 0x7a3cf7),
                            Palette.token(dark: 0x2f6bff, light: 0x2f6bff),
                        ],
                        startPoint: .topLeading, endPoint: .bottomTrailing)),
                text: .white, quoteTint: shade(0.18, 0.14), bar: Palette.token(dark: 0xe8dcff, light: 0xefe6ff),
                mention: .white, radius: 20, tail: 6)
        default:
            solid(
                Palette.fg, text: Palette.on, shade: (0.22, 0.08), bar: Palette.on, mention: Palette.on, radius: 16,
                tail: 4)
        }
    }

    private static func solid(
        _ sent: Color, text: Color = .white, shade tint: (dark: Double, light: Double), bar: Color,
        mention: Color = .white, radius: CGFloat, tail: CGFloat, hasQuoteBar: Bool = false,
        isCaptionApart: Bool = false, namesNetwork: Bool = false
    ) -> ChatLook {
        ChatLook(
            sent: AnyShapeStyle(sent), text: text, quoteTint: shade(tint.dark, tint.light), bar: bar,
            hasQuoteBar: hasQuoteBar, mention: mention, radius: radius, tail: tail,
            isCaptionApart: isCaptionApart, namesNetwork: namesNetwork)
    }

    /// Black at a strength for dark and one for light: a quote's inset on the bubble.
    /// Nonisolated, as `Palette`'s: SwiftUI resolves the colour on its render thread.
    private nonisolated static func shade(_ dark: Double, _ light: Double) -> Color {
        Color(uiColor: UIColor { UIColor(white: 0, alpha: $0.userInterfaceStyle == .light ? light : dark) })
    }
}

extension FileKind {
    /// Its glyph in a chat's file bubble.
    fileprivate var glyph: String {
        switch self {
        case .photo: "photo"
        case .video: "video"
        case .audio: "waveform"
        case .pdf, .document, .unknown: "doc"
        }
    }
}

extension Check.Draft.File {
    fileprivate var glyph: String { isPhoto ? "photo" : "doc" }
}
