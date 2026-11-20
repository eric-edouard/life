import LifeConnector
import SwiftUI

/// The people sheet (`AskPeople`) behind "Someone else…": a search field that also takes a typed name, "Create “<name>”"
/// first where the card takes a new person's name (what he typed, else the card's name), then the card's likely people,
/// filtered as he types.
struct SameAsSheet: View {
    let people: [Party]
    /// The card takes a new person's name, not only someone Life knows.
    let takesNewName: Bool
    /// A new name opens the create sheet (a name card's); elsewhere it is the answer as typed (a voice's).
    let createsBySheet: Bool
    /// The name the card asks about, which "Create" offers until he types another.
    let cardName: String?
    let choose: (Naming) -> Void
    /// Opens the create sheet with that name.
    let create: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @FocusState private var isTyping: Bool

    private var typed: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var shown: [Party] {
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
                    ForEach(shown, id: \.ref) { person in
                        Button {
                            pick(.person(person.ref))
                        } label: {
                            PartyRow(person).frame(minHeight: Metrics.FlatRow.personRow).contentShape(.rect)
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
        .presentationDragIndicator(.visible)
    }

    /// Where the card takes a new person's name, "Create “<name>”" opens the create sheet with it; with no name yet the
    /// row asks for one. Elsewhere a typed name is someone Life knows by it.
    private var newPerson: some View {
        let name = typed.isEmpty ? cardName ?? "" : typed
        return Button {
            if name.isEmpty {
                isTyping = true
            } else if createsBySheet {
                create(name)
            } else {
                pick(.name(name))
            }
        } label: {
            FlatRow(lead: .symbol("plus"), slotSize: Metrics.FlatRow.personSlot) {
                Text(name.isEmpty ? "Create a person" : takesNewName ? "Create “\(name)”" : name).font(.rowName)
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
