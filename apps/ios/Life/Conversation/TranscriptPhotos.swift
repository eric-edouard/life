import Library
import Photos
import SwiftUI
import Timeline
import UIKit

/// Reads the owner's photo library on demand.
nonisolated enum PhotoLibrary {
    /// Photos and screenshots taken inside `range`, in time order. Asks for access the first time; full or limited
    /// access both work, and anything else finds nothing.
    static func photos(in range: Range<CaptureInstant>) async -> [TranscriptPhoto] {
        var status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        if status == .notDetermined { status = await PHPhotoLibrary.requestAuthorization(for: .readWrite) }
        guard status == .authorized || status == .limited else { return [] }
        let options = PHFetchOptions()
        options.predicate = NSPredicate(
            format: "creationDate >= %@ AND creationDate < %@", range.lowerBound.date as NSDate,
            range.upperBound.date as NSDate)
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: true)]
        let assets = PHAsset.fetchAssets(with: .image, options: options)
        return assets.objects(at: IndexSet(integersIn: 0..<assets.count)).compactMap { asset in
            asset.creationDate.map {
                TranscriptPhoto(
                    id: asset.localIdentifier, taken: CaptureInstant($0),
                    isScreenshot: asset.mediaSubtypes.contains(.photoScreenshot))
            }
        }
    }

    /// The image at about `size` pixels, from iCloud if need be. Kept only by the view showing it.
    static func image(_ id: String, size: CGSize, fill: Bool) async -> UIImage? {
        guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil).firstObject else { return nil }
        let options = PHImageRequestOptions()
        options.deliveryMode = .highQualityFormat
        options.resizeMode = .fast
        options.isNetworkAccessAllowed = true
        // `highQualityFormat` answers exactly once.
        return await withCheckedContinuation { done in
            PHImageManager.default().requestImage(
                for: asset, targetSize: size, contentMode: fill ? .aspectFill : .aspectFit, options: options
            ) { image, _ in done.resume(returning: image) }
        }
    }
}

/// The photos taken during one turn, as a small row of thumbnails under it. Tapping one opens the viewer.
struct PhotoStrip: View {
    let photos: [TranscriptPhoto]
    /// The conversation's start, to say when each was taken.
    let origin: CaptureInstant
    /// Opens the viewer.
    let store: ConversationStore

    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 6) {
                ForEach(photos) { photo in
                    Button {
                        store.viewing = photo
                    } label: {
                        PhotoThumbnail(id: photo.id)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(
                        "\(photo.isScreenshot ? "Screenshot" : "Photo"), \(PlayerClock.spoken(origin.distance(to: photo.taken)))"
                    )
                    .accessibilityHint("Shows it full screen")
                    .accessibilityIdentifier("transcript.photo")
                }
            }
            .padding(.horizontal, 12)
        }
        .scrollIndicators(.hidden)
        .padding(.vertical, 4)
    }
}

private struct PhotoThumbnail: View {
    let id: String

    @State private var image: UIImage?
    @Environment(\.displayScale) private var displayScale

    var body: some View {
        RoundedRectangle(cornerRadius: Metrics.Radius.tile)
            .fill(Palette.surface2)
            .overlay {
                if let image {
                    Image(uiImage: image).resizable().scaledToFill()
                }
            }
            .frame(width: 56, height: 56)
            .clipShape(.rect(cornerRadius: Metrics.Radius.tile))
            .task(id: id) {
                let side = 56 * displayScale
                image = await PhotoLibrary.image(id, size: CGSize(width: side, height: side), fill: true)
            }
    }
}

/// The conversation's photos full screen: swipe between them, pinch or double-tap to zoom.
struct PhotoViewer: View {
    let photos: [TranscriptPhoto]

    @State private var selection: String
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    init(photos: [TranscriptPhoto], start: TranscriptPhoto) {
        self.photos = photos
        selection = start.id
    }

    var body: some View {
        NavigationStack {
            TabView(selection: $selection) {
                ForEach(photos) { photo in
                    ZoomablePhoto(id: photo.id).tag(photo.id)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: photos.count > 1 ? .always : .never))
            .background(.black)
            .ignoresSafeArea()
            .navigationTitle(
                photos.first { $0.id == selection }?.taken.date.formatted(date: .omitted, time: .shortened) ?? ""
            )
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close", systemImage: "xmark") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    // iOS has no public way to open one photo in Photos; this opens the app where the owner left it.
                    Button("Open Photos", systemImage: "photo.on.rectangle") {
                        if let url = URL(string: "photos-redirect://") { openURL(url) }
                    }
                    .labelStyle(.titleAndIcon)
                    .accessibilityHint("Opens the Photos app, not this photo")
                }
            }
        }
        .preferredColorScheme(.dark)
    }
}

private struct ZoomablePhoto: View {
    let id: String

    @State private var image: UIImage?

    var body: some View {
        ZStack {
            if let image {
                ZoomableImage(image: image)
            } else {
                ProgressView()
            }
        }
        .task(id: id) { image = await PhotoLibrary.image(id, size: CGSize(width: 2400, height: 2400), fill: false) }
    }
}

/// UIKit's scroll view zoom: pinch, pan while zoomed, and double-tap to zoom in or out.
private struct ZoomableImage: UIViewRepresentable {
    let image: UIImage

    func makeUIView(context: Context) -> UIScrollView {
        let scroll = UIScrollView()
        scroll.delegate = context.coordinator
        scroll.maximumZoomScale = 5
        scroll.showsVerticalScrollIndicator = false
        scroll.showsHorizontalScrollIndicator = false
        // Not `UIImageView(image:)`, which sizes itself to the image: it follows the scroll view's size instead.
        let view = UIImageView()
        view.image = image
        view.contentMode = .scaleAspectFit
        view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        scroll.addSubview(view)
        let doubleTap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.zoom))
        doubleTap.numberOfTapsRequired = 2
        scroll.addGestureRecognizer(doubleTap)
        return scroll
    }

    func updateUIView(_ scroll: UIScrollView, context: Context) {
        (scroll.subviews.first as? UIImageView)?.image = image
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, UIScrollViewDelegate {
        func viewForZooming(in scroll: UIScrollView) -> UIView? { scroll.subviews.first as? UIImageView }

        @objc func zoom(_ tap: UITapGestureRecognizer) {
            guard let scroll = tap.view as? UIScrollView else { return }
            if scroll.zoomScale > 1 {
                scroll.setZoomScale(1, animated: true)
            } else {
                let point = tap.location(in: scroll.subviews.first)
                let size = CGSize(width: scroll.bounds.width / 3, height: scroll.bounds.height / 3)
                scroll.zoom(
                    to: CGRect(origin: CGPoint(x: point.x - size.width / 2, y: point.y - size.height / 2), size: size),
                    animated: true)
            }
        }
    }
}
