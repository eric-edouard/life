import LifeConnector
import SwiftUI

/// "Same as…": the person this is, from the card's likely people, or a name typed for someone new.
struct SameAsSheet: View {
    enum Choice { case person(String), name(String) }

    let people: [Check.Person]
    let choose: (Choice) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""

    private var typed: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                SheetHeader(title: "Same as…") { dismiss() }
                if !people.isEmpty {
                    Caps("Who it may be")
                    ForEach(people, id: \.person) { person in
                        Button(person.name) { pick(.person(person.person)) }.buttonStyle(.pill(.quiet, height: 48))
                    }
                }
                Caps("Someone else, by name")
                TextField("Their name", text: $name).font(.quote).foregroundStyle(Palette.fg)
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

    private func pick(_ choice: Choice) {
        dismiss()
        choose(choice)
    }
}
