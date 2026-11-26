import SwiftUI

/// A link looks like where it goes (owner, 26 Nov 2026: link B v2): the site's mark in its colour, its plain name, the
/// key fact large and what is there under it, so he knows where the tap lands before he taps. A site Life does not know
/// shows its host under its initial, no brand. The key fact is the server's to send (it sends none yet); without it the
/// card is the name and its line.
struct LinkCard: View {
    let url: URL
    /// What is there ("Rue des Lilas 14").
    var line: String?
    /// The one fact he came for ("Thu 9:30"); nil until the server sends it.
    var keyFact: String?

    /// One row of the table: the hosts it answers to, its name, and its mark's colours and letter.
    private struct Kind {
        let hosts: [String]
        let name: String
        let background: UInt32
        let foreground: UInt32
        let letter: String
    }

    private static let kinds: [Kind] = [
        Kind(
            hosts: ["maps.app.goo.gl", "maps.google.", "google.com/maps", "goo.gl/maps"], name: "Google Maps",
            background: 0x34A853, foreground: 0xFFFFFF, letter: "G"),
        Kind(hosts: ["maps.apple.com"], name: "Apple Maps", background: 0xFFFFFF, foreground: 0x0A84FF, letter: "A"),
        Kind(hosts: ["doctolib."], name: "Doctolib", background: 0x107ACA, foreground: 0xFFFFFF, letter: "d"),
        Kind(hosts: ["calendly.com"], name: "Calendly", background: 0x006BFF, foreground: 0xFFFFFF, letter: "C"),
        Kind(hosts: ["planity.com"], name: "Planity", background: 0x000000, foreground: 0xFFFFFF, letter: "P"),
        Kind(
            hosts: ["paypal.com", "paypal.me"], name: "PayPal", background: 0x003087, foreground: 0xFFFFFF, letter: "P"),
        Kind(
            hosts: ["lydia-app.com", "lydia.me"], name: "Lydia", background: 0x0080FF, foreground: 0xFFFFFF, letter: "L"
        ),
        Kind(
            hosts: ["revolut.com", "revolut.me"], name: "Revolut", background: 0xFFFFFF, foreground: 0x000000,
            letter: "R"),
        Kind(hosts: ["wise.com"], name: "Wise", background: 0x9FE870, foreground: 0x163300, letter: "W"),
        Kind(
            hosts: ["tmn.app.link", "truemoney.com"], name: "TrueMoney", background: 0xFF6A13, foreground: 0xFFFFFF,
            letter: "T"),
        Kind(hosts: ["dhl."], name: "DHL", background: 0xFFCC00, foreground: 0xD40511, letter: "D"),
        Kind(hosts: ["fedex.com"], name: "FedEx", background: 0x4D148C, foreground: 0xFFFFFF, letter: "F"),
        Kind(hosts: ["meet.google.com"], name: "Google Meet", background: 0x00AC47, foreground: 0xFFFFFF, letter: "M"),
        Kind(hosts: ["zoom.us"], name: "Zoom", background: 0x0B5CFF, foreground: 0xFFFFFF, letter: "Z"),
        Kind(
            hosts: ["drive.google.com", "docs.google.com"], name: "Google Drive", background: 0xFFBA00,
            foreground: 0x0066DA, letter: "D"),
        Kind(hosts: ["airbnb."], name: "Airbnb", background: 0xFF385C, foreground: 0xFFFFFF, letter: "a"),
        Kind(hosts: ["booking.com"], name: "Booking.com", background: 0x003580, foreground: 0xFFFFFF, letter: "B"),
        Kind(
            hosts: ["instagram.com", "ig.me"], name: "Instagram", background: 0xD62976, foreground: 0xFFFFFF,
            letter: "I"),
        Kind(
            hosts: ["youtube.com", "youtu.be"], name: "YouTube", background: 0xFF0000, foreground: 0xFFFFFF, letter: "Y"
        ),
        Kind(
            hosts: ["testflight.apple.com", "apps.apple.com"], name: "App Store", background: 0x0D84FF,
            foreground: 0xFFFFFF, letter: "A"),
        Kind(
            hosts: ["ride.bolt.eu", "bolt.eu"], name: "Bolt", background: 0x34D186, foreground: 0xFFFFFF, letter: "B"),
        Kind(hosts: ["grab.com"], name: "Grab", background: 0x00B14F, foreground: 0xFFFFFF, letter: "G"),
    ]

    private var kind: Kind {
        let text = url.absoluteString.lowercased()
        if let known = Self.kinds.first(where: { $0.hosts.contains { text.contains($0) } }) { return known }
        let host = (url.host() ?? text).replacingOccurrences(of: "www.", with: "")
        return Kind(
            hosts: [], name: host, background: 0x2A2B31, foreground: 0xFFF8EA, letter: host.prefix(1).uppercased())
    }

    var body: some View {
        let kind = kind
        Link(destination: url) {
            HStack(spacing: Metrics.Spacing.m) {
                Text(kind.letter).font(.bodyBold).foregroundStyle(Color(hex: kind.foreground))
                    .frame(width: Metrics.disc, height: Metrics.disc)
                    .background(Color(hex: kind.background), in: .circle).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(kind.name).font(.meta).foregroundStyle(Palette.muted)
                    if let keyFact { Text(keyFact).font(.header) }
                    if let line { Text(line).font(.line).foregroundStyle(Palette.muted) }
                }
                Spacer(minLength: 0)
                Image(systemName: "arrow.up.right").font(.lineStrong).foregroundStyle(Palette.muted)
                    .accessibilityHidden(true)
            }
            .padding(Metrics.Spacing.m).frame(maxWidth: .infinity, alignment: .leading)
            .background(Palette.tile, in: .rect(cornerRadius: Metrics.Radius.block))
            .contentShape(.rect)
        }
        .buttonStyle(.plain).accessibilityLabel("Open \(kind.name)")
    }
}

private extension Color {
    init(hex: UInt32) {
        self.init(
            red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255)
    }
}
