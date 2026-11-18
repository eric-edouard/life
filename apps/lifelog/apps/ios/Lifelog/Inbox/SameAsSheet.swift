import LifeConnector
import SwiftUI

/// "Same as…": who this is, from the card's likely people, or typed: a new person where the card takes a new name (a
/// voice), else someone Life knows by that name.
struct SameAsSheet: View {
    let title: String
    let people: [Check.Person]
    /// The card takes a new person's name, not only someone Life knows.
    let takesNewName: Bool
    let choose: (Naming) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""

    private var typed: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                SheetHeader(title: title) { dismiss() }
                if !people.isEmpty {
                    Caps("Who it may be")
                    ForEach(people, id: \.person) { person in
                        Button(person.name) { pick(.person(person.person)) }.buttonStyle(.pill(.quiet, height: 48))
                    }
                }
                Caps(takesNewName ? "Someone else, by name" : "Someone Life knows, by name")
                TextField(takesNewName ? "Their name" : "Their name, as Life knows them", text: $name).font(.quote)
                    .foregroundStyle(Palette.fg)
                    .padding(16).background(Palette.card, in: .rect(cornerRadius: 20))
                Button("Use this name") { pick(.name(typed)) }.buttonStyle(.pill(.filled)).disabled(typed.isEmpty)
            }
            .padding(20)
            .readingWidth()
        }
        .scrollBounceBehavior(.basedOnSize)
        .background(Palette.sheet)
        .presentationDetents([.medium, .large])
    }

    private func pick(_ choice: Naming) {
        dismiss()
        choose(choice)
    }
}
