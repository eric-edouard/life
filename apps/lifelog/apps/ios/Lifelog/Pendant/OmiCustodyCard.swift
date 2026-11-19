import PendantProtocol
import SwiftUI

/// An Omi whose firmware frees audio from the pendant as soon as the phone receives it (`OmiFirmware`): the owner
/// accepted the risk on Oct 22 and the user is told it plainly, with the update once one exists (`docs/pendant.md`).
struct OmiCustodyCard: View {
    let revision: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("This Omi deletes audio once it's sent").font(.bodyStrong).foregroundStyle(Palette.fg)
                .accessibilityIdentifier("pendant.card.omiCustody")
            Text(detail).font(.note).foregroundStyle(Palette.muted)
            if let revision { Text("Omi firmware \(revision)").font(.small).foregroundStyle(Palette.faint) }
        }
        .box()
    }

    private var detail: String {
        let risk =
            "Its firmware deletes audio from the Omi as soon as the phone receives it, before lifelog has saved it. If the phone dies or quits mid-transfer, that audio is lost."
        guard let fixed = OmiFirmware.custodyFixedIn else { return risk + " An Omi firmware update will fix this." }
        let version = fixed.map(String.init).joined(separator: ".")
        return risk + " Firmware \(version) fixes it: update it in the Omi app, under Device Settings."
    }
}
