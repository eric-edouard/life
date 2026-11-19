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
                    .focused($isTyping)
                VStack(spacing: 0) {
                    if takesNewName || !typed.isEmpty { newPerson }
                    ForEach(shown, id: \.person) { person in
                        Button {
                            pick(.person(person.person))
                        } label: {
                            FlatRow(lead: .person(person.name), detail: person.line) {
                                Text(person.name).font(.rowName)
                            } trailing: {
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .padding([.horizontal, .bottom], Metrics.gutter)
            .readingWidth()
        }
        .scrollBounceBehavior(.basedOnSize)
        .background(Palette.sheet)
        .presentationDetents([.large])
    }

    /// A typed name is a new person (or someone Life knows by that name); with nothing typed the row asks for the name.
    private var newPerson: some View {
        Button {
            if typed.isEmpty { isTyping = true } else { pick(.name(typed)) }
        } label: {
            FlatRow(lead: .symbol("plus")) {
                Text(typed.isEmpty ? "New person" : takesNewName ? "New person: \(typed)" : typed).font(.rowName)
            } trailing: {
            }
        }
        .buttonStyle(.plain)
    }

    private func pick(_ choice: Naming) {
        dismiss()
        choose(choice)
    }
}
