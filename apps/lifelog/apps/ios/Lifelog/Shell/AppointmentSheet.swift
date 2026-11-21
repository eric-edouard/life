import LifeConnector
import SwiftUI

/// The event sheet of an appointment Life added to his calendar (`read_appointments`), one sheet wherever it opens from
/// (its push now): when, where, its meeting link, the message it came from, its matter, then Open in Calendar and Remove.
/// After Remove it stays, saying so, with Undo in Remove's place; one already removed opens that way.
struct AppointmentSheet: View {
    let key: AppointmentKey

    @Environment(LifeStore.self) private var life
    @Environment(AppRouter.self) private var router
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var read = ReadState<Appointment>()
    @State private var path: [LifeLinkTarget] = []

    var body: some View {
        NavigationStack(path: $path) {
            VStack(alignment: .leading, spacing: 0) {
                SheetHeader(title: read.value?.title) { dismiss() }
                    .padding(.horizontal, Metrics.gutter).padding(.vertical, Metrics.Spacing.l)
                ReadScreen(
                    shown: read.shown(), retry: load, loading: { Spinner().frame(maxWidth: .infinity) },
                    empty: { EmptyView() },
                    content: { appointment in
                        ScrollView { page(appointment).padding(.horizontal, Metrics.gutter).readingWidth() }
                            .scrollBounceBehavior(.basedOnSize)
                    })
            }
            .frame(maxHeight: .infinity, alignment: .top)
            .background(Palette.sheet)
            .navigationDestination(for: LifeLinkTarget.self) { LifeLinkPage(target: $0) { dismiss() } }
        }
        .presentationDetents([.medium, .large])
        .task { await load() }
    }

    private func load() async { await life.readAppointment(key) { read.apply($0) } }

    @ViewBuilder private func page(_ appointment: Appointment) -> some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.l) {
            RowGroup {
                Row(title: appointment.when(), icon: "clock") {}
                if let place = appointment.where {
                    Button {
                        appointment.mapsURL.map { openURL($0) }
                    } label: {
                        Row(title: place, icon: "mappin") { Image(systemName: "arrow.up.right") }
                    }.buttonStyle(.plain)
                }
                if let link = appointment.link.flatMap(URL.init(string:)) {
                    Button {
                        openURL(link)
                    } label: {
                        Row(title: link.host() ?? link.absoluteString, icon: "video") {
                            Image(systemName: "arrow.up.right")
                        }
                    }.buttonStyle(.plain)
                }
            }
            if let from = appointment.from { quote(from) }
            if let matter = appointment.matterId {
                InlinePill(name: matterName(matter)) {
                    dismiss()
                    router.open(matter: matter)
                }
            }
            actions(appointment)
        }
        .padding(.bottom, Metrics.Spacing.xl)
    }

    /// The message it came from, on `tile` as a context's quote: its words, then who and when in `muted`; a tap opens it
    /// (`fetch`).
    private func quote(_ from: Appointment.Source) -> some View {
        Button {
            path.append(LifeLinkTarget(ref: from.message, words: from.sender?.name ?? "Message", kind: .message))
        } label: {
            VStack(alignment: .leading, spacing: Metrics.Spacing.xs) {
                Text(from.text).font(.body15).foregroundStyle(Palette.fg).multilineTextAlignment(.leading)
                Text(
                    [from.sender?.name, from.at?.formatted(.dateTime.weekday().hour().minute())].compactMap(\.self)
                        .joined(separator: " · ")
                )
                .font(.small).foregroundStyle(Palette.muted)
            }
            .padding(Metrics.Spacing.m).frame(maxWidth: .infinity, alignment: .leading)
            .background(Palette.tile, in: .rect(cornerRadius: Metrics.Radius.tile))
        }
        .buttonStyle(.plain)
    }

    /// Open in Calendar, then Remove; removed, the words and Undo. His tap shows at once: busy, then Life's read again, or
    /// Life's reason.
    @ViewBuilder private func actions(_ appointment: Appointment) -> some View {
        let state = life.state(of: .appointment(appointment.id))
        VStack(spacing: Metrics.Spacing.s) {
            if appointment.isRemoved {
                Text(CalendarNotification.removed).font(.small).foregroundStyle(Palette.muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            // Remove is plain text, not coral (his word).
            HStack(spacing: Metrics.Spacing.s) {
                if let calendar = appointment.calendarURL, !appointment.isRemoved {
                    Button {
                        openURL(calendar)
                    } label: {
                        Label("Open in Calendar", systemImage: "calendar")
                    }
                    .buttonStyle(.pill(.quiet))
                }
                Button(appointment.isRemoved ? "Undo" : "Remove") {
                    Task {
                        guard
                            case .succeeded = await life.changeAppointment(appointment.id, isOn: appointment.isRemoved)
                        else { return }
                        await load()
                    }
                }
                .buttonStyle(.pill(.quiet, isBusy: state.isRunning))
            }
            if case .failed(let failure, _) = state {
                Text(failure.reason).font(.small).foregroundStyle(Palette.flag)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .motion(Motion.standard, value: appointment.isRemoved)
        .padding(.top, Metrics.Spacing.s)
    }

    /// The matter's name from the list Life last sent; its plain word until that list holds it.
    private func matterName(_ id: String) -> String {
        life.matters.value?.matters.first { $0.id == id }?.name ?? "The matter"
    }
}
