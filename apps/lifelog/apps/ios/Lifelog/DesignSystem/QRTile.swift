import CoreImage.CIFilterBuiltins
import Photos
import SwiftUI

/// A QR drawn from its text by Core Image's generator: dark on white in both themes, the picture he saves; once saved
/// to his photos, a check on its corner.
struct QRTile: View {
    let image: CGImage?
    var isSaved = false

    init(payload: String, isSaved: Bool = false) {
        image = QRPicture.modules(payload)
        self.isSaved = isSaved
    }

    var body: some View {
        Group {
            if let image { Image(decorative: image, scale: 1).interpolation(.none).resizable().scaledToFit() }
        }
        .padding(Metrics.Spacing.l)
        .frame(width: 208, height: 208)
        .background(Palette.qrPaper, in: .rect(cornerRadius: Metrics.Radius.passage))
        .accessibilityElement().accessibilityLabel(isSaved ? "QR code, saved to your photos" : "QR code")
        .overlay(alignment: .bottomTrailing) {
            if isSaved {
                Image(systemName: "checkmark").font(.system(size: 14, weight: .bold)).foregroundStyle(Palette.on)
                    .frame(width: 24, height: 24).background(Palette.ok, in: .circle).offset(x: 12, y: 12)
                    .accessibilityHidden(true).appears()
            }
        }
    }
}

/// The code as a picture, and its save to his photos (add only: Life never reads his library for it).
enum QRPicture {
    /// One pixel per module.
    static func modules(_ payload: String) -> CGImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(payload.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        return CIContext().createCGImage(output, from: output.extent)
    }

    /// Saves the code, 16 pixels a module with four modules of white around it, so his bank app reads it from Photos.
    /// Gives his words for why it did not go, nil when saved.
    static func save(_ payload: String) async -> String? {
        guard let image = modules(payload) else { return "This QR can't be drawn." }
        guard await PHPhotoLibrary.requestAuthorization(for: .addOnly) == .authorized else {
            return "Not saved: allow adding to Photos in Settings."
        }
        let module: CGFloat = 16
        let side = CGFloat(image.width + 8) * module
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let picture = UIGraphicsImageRenderer(size: CGSize(width: side, height: side), format: format).image {
            context in
            UIColor(Palette.qrPaper).setFill()
            context.fill(CGRect(x: 0, y: 0, width: side, height: side))
            context.cgContext.interpolationQuality = .none
            UIImage(cgImage: image).draw(
                in: CGRect(x: 0, y: 0, width: side, height: side).insetBy(dx: 4 * module, dy: 4 * module))
        }
        do {
            try await PHPhotoLibrary.shared().performChanges {
                PHAssetChangeRequest.creationRequestForAsset(from: picture)
            }
            return nil
        } catch {
            return "Not saved to your photos."
        }
    }
}
