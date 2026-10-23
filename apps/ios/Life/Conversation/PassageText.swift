import Library
import SwiftUI
import Timeline
import UIKit

/// Words someone said, in a read-only `UITextView`, because SwiftUI `Text` selects all or nothing: here the owner can
/// select and copy any range, across words and sentences. A tap reports itself; a tap while text is selected only
/// clears the selection, and selecting never seeks or scrolls. The word being spoken (`lit`) is white on red, the
/// one highlight of a transcript and of a clip. Colors change in place, so a selection survives playback moving on,
/// and nothing is laid out again.
struct PassageText: UIViewRepresentable {
    let text: String
    let color: Color
    /// The word being spoken.
    var lit: NSRange?
    /// In Newsreader, as a clip's quote (`Font.spokenQuote`); else the body face.
    var quote = false
    /// `nil`: the words can't be touched, and whatever holds them takes the tap.
    var tap: (() -> Void)?
    /// The owner selected some text.
    var select: () -> Void = {}

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> UITextView {
        let view = PassageTextView()
        view.isEditable = false
        view.isSelectable = true
        view.isScrollEnabled = false
        view.showsVerticalScrollIndicator = false
        view.showsHorizontalScrollIndicator = false
        view.backgroundColor = .clear
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.isUserInteractionEnabled = tap != nil
        view.delegate = context.coordinator
        let tap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.tapped(_:)))
        tap.delegate = context.coordinator
        // A double tap selects a word: it must not seek first.
        for other in view.gestureRecognizers ?? [] {
            if let double = other as? UITapGestureRecognizer, double.numberOfTapsRequired == 2 {
                tap.require(toFail: double)
            }
        }
        view.addGestureRecognizer(tap)
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        let coordinator = context.coordinator
        coordinator.parent = self
        let traits = UITraitCollection(
            preferredContentSizeCategory: UIContentSizeCategory(context.environment.dynamicTypeSize))
        let font =
            quote
            ? UIFontMetrics(forTextStyle: .body).scaledFont(
                for: UIFont(name: "Newsreader", size: 18) ?? .preferredFont(forTextStyle: .body), compatibleWith: traits
            )
            : UIFont.preferredFont(forTextStyle: .body, compatibleWith: traits)
        // Replacing the text clears a selection, so only new words or a new size do it.
        if coordinator.text != text || coordinator.font != font {
            (coordinator.text, coordinator.font, coordinator.color, coordinator.lit) = (text, font, nil, nil)
            view.attributedText = Self.attributed(text, font: font)
        }
        guard coordinator.color != color || coordinator.lit != lit else { return }
        let storage = view.textStorage
        let all = NSRange(location: 0, length: storage.length)
        func paint(_ range: NSRange?, _ color: Color) {
            guard let range = range.map({ NSIntersectionRange($0, all) }), range.length > 0 else { return }
            storage.addAttribute(.foregroundColor, value: UIColor(color), range: range)
        }
        paint(coordinator.color == color ? coordinator.lit : all, color)
        paint(lit, Palette.textOnRed)
        (coordinator.color, coordinator.lit) = (color, lit)
        (view as? PassageTextView)?.lit = lit
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextView, context: Context) -> CGSize? {
        guard let width = proposal.width, width.isFinite else { return nil }
        let fitting = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        return CGSize(width: width, height: fitting.height.rounded(.up))
    }

    static func attributed(_ text: String, font: UIFont) -> NSAttributedString {
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = 4
        return NSAttributedString(string: text, attributes: [.font: font, .paragraphStyle: paragraph])
    }

    private final class PassageTextView: UITextView {
        /// Red behind the word being spoken, under the text: a jump from word to word, so nothing moves under Reduce
        /// Motion either.
        private let glow = UIView()
        var lit: NSRange? {
            didSet { if lit != oldValue { setNeedsLayout() } }
        }

        override func layoutSubviews() {
            super.layoutSubviews()
            if glow.superview == nil {
                glow.backgroundColor = UIColor(Palette.redFill)
                glow.layer.cornerRadius = 5
                glow.layer.cornerCurve = .continuous
                glow.isUserInteractionEnabled = false
                insertSubview(glow, at: 0)
            }
            glow.isHidden = true
            guard let lit, let layout = textLayoutManager, let content = layout.textContentManager,
                let from = content.location(content.documentRange.location, offsetBy: lit.location),
                let to = content.location(from, offsetBy: lit.length), let range = NSTextRange(location: from, end: to)
            else { return }
            layout.ensureLayout(for: range)
            // A word wrapped across two lines lights its first.
            layout.enumerateTextSegments(in: range, type: .standard, options: .rangeNotRequired) { _, frame, _, _ in
                self.glow.frame = frame.insetBy(dx: -4, dy: 0)
                self.glow.isHidden = false
                return false
            }
        }

        /// Accessibility treats a text view as a scroll view and built its path from NaN on every query (hundreds of
        /// CoreGraphics errors per page). The passage around it is the accessibility element; its frame is enough.
        override var accessibilityPath: UIBezierPath? {
            get { nil }
            set {}
        }
    }

    final class Coordinator: NSObject, UITextViewDelegate, UIGestureRecognizerDelegate {
        var parent: PassageText?
        var text: String?
        var font: UIFont?
        var color: Color?
        var lit: NSRange?
        /// Whether text was selected when the touch began; such a tap only clears it.
        private var selectedAtTouch = false
        /// When the touch began: a press held longer is selecting, not tapping.
        private var touchedAt = Date.distantPast

        @objc func tapped(_ recognizer: UITapGestureRecognizer) {
            parent?.tap?()
        }

        func gestureRecognizer(_ recognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
            selectedAtTouch = ((recognizer.view as? UITextView)?.selectedRange.length ?? 0) > 0
            touchedAt = .now
            return true
        }

        /// Only a quick tap on unselected text seeks: never a long press, and never one that selected something.
        func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
            let selected = ((recognizer.view as? UITextView)?.selectedRange.length ?? 0) > 0
            return !selectedAtTouch && !selected && Date.now.timeIntervalSince(touchedAt) < 0.35
        }

        func gestureRecognizer(
            _ recognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
        ) -> Bool { true }

        func textViewDidChangeSelection(_ view: UITextView) {
            if view.selectedRange.length > 0 { parent?.select() }
        }
    }
}
