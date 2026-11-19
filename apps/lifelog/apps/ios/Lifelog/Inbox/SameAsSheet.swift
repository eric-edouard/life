import LifeConnector
import SwiftUI

/// The people sheet (`AskPeople`) behind "Someone else…": a search field that also takes a typed name, "New person"
/// first where the card takes a new person's name, then the card's likely people, filtered as he types.
struct SameAsSheet: View {
    let people: [Check.Person]
    /// The card takes a new person's name, not only someone Life knows.
    let takesNewName: Bool
    let choose: (Naming) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @FocusState private var isTyping: Bool

    private var typed: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var shown: [Check.Person] {
        typed.isEmpty ? people : people.filter { $0.name.localizedCaseInsensitiveContains(typed) }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                SheetHeader(title: "Who?") { dismiss() }
                Field(prompt: "Search or type a name", text: $name, surface: .sheet, icon: "magnifyingglass")
                    .focused($isTyping).padding(.top, 4)
                VStack(spacing: 0) {
                    if takesNewName || !typed.isEmpty { newPerson }
                    ForEach(shown, id: \.person) { person in
                        row(initials: SaidWords.initials(person.name), name: person.name, line: person.line) {
                            pick(.person(person.person))
                        }
                    }
                }
            }
            .padding(.horizontal, 20).padding(.bottom, 20)
            .readingWidth()
        }
        .scrollBounceBehavior(.basedOnSize)
        .background(Palette.sheet)
        .presentationDetents([.large])
    }

    /// A typed name is a new person (or someone Life knows by that name); with nothing typed the row asks for the name.
    private var newPerson: some View {
        row(symbol: "plus", name: typed.isEmpty ? "New person" : "New person: \(typed)", line: nil) {
            if typed.isEmpty { isTyping = true } else { pick(.name(typed)) }
        }
    }

    private func row(
        initials: String? = nil, symbol: String? = nil, name: String, line: String?, action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Group {
                    if let symbol { Image(systemName: symbol).font(.smallStrong) } else { Text(initials ?? "").font(.smallStrong) }
                }
                .foregroundStyle(Palette.fg).frame(width: 36, height: 36).background(Color.fillTint, in: .circle)
                VStack(alignment: .leading, spacing: 1) {
                    Text(name).font(.rowName).foregroundStyle(Palette.fg)
                    if let line { Text(line).font(.small).foregroundStyle(Palette.muted) }
                }
                Spacer(minLength: 0)
            }
            .frame(minHeight: 52).contentShape(.rect)
        }
        .buttonStyle(.plain)
    }

    private func pick(_ choice: Naming) {
        dismiss()
        choose(choice)
    }
}
