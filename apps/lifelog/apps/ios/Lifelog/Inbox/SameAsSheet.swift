import LifeConnector
import SwiftUI

/// The people sheet (`AskPeople`) behind "Someone else…": a search field that also takes a typed name, "Create “<name>”"
/// first where the card takes a new person's name (what he typed, else the card's name), then the card's likely people
/// and everyone else he knows (`Check.peopleToPick`), filtered as he types.
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

    private var typed: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var shown: [Party] {
        typed.isEmpty ? people : people.filter { $0.name.localizedCaseInsensitiveContains(typed) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Field(
                prompt: takesNewName ? "Search, or type a new name" : "Search or type a name", text: $name,
                surface: .sheet, icon: "magnifyingglass")
            VStack(spacing: 0) {
                if !newName.isEmpty { newPerson }
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
        .readingWidth()
        .sheetScroll { SheetHeader(title: "Who?") { dismiss() } }
        .background(Palette.sheet)
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
    }

    /// What "Create" offers: what he typed, else the card's name; none until there is one (the field says to type it).
    private var newName: String { typed.isEmpty ? cardName ?? "" : typed }

    /// Where the card takes a new person's name, "Create “<name>”" opens the create sheet with it (a name card's) or
    /// answers with it (a voice's). Elsewhere a typed name is someone Life knows by it.
    private var newPerson: some View {
        let name = newName
        return Button {
            if createsBySheet {
                create(name)
            } else {
                pick(.name(name))
            }
        } label: {
            FlatRow(lead: .symbol("plus"), slotSize: Metrics.FlatRow.personSlot) {
                Text(takesNewName ? "Create “\(name)”" : name).font(.rowName)
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
