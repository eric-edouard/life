import LifeConnector
import SwiftUI

/// Someone's face: their picture when Life gave one and it is on hand, else their initial. One size, a disc.
struct Face: View {
    let party: Party
    var size: CGFloat = 36
    @Environment(PictureCache.self) private var pictures

    var body: some View {
        Group {
            if let id = party.picture?.id, let data = pictures.shown[id], let image = UIImage(data: data) {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                Text(String(party.name.prefix(1))).font(.rowName).foregroundStyle(Palette.muted)
                    .frame(maxWidth: .infinity, maxHeight: .infinity).background(Color.fillTint)
            }
        }
        .frame(width: size, height: size).clipShape(party.kind == .organization ? AnyShape(.rect(cornerRadius: size / 5)) : AnyShape(.circle))
        .accessibilityLabel(party.name)
    }
}
