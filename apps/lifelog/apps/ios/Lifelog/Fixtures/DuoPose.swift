#if DEBUG
    import SwiftUI
    import UIKit

    /// The iPhone Duo open, drawn without the hardware: the app at 951 x 669 (wide) or 669 x 951 (upright) with regular size
    /// classes, shrunk to fit whatever screen it runs on. `-fixturePose wide|upright` on launch (a preview has no stores to read).
    /// The fold and the vertical bar are the system's and are not drawn: this shows the layout the size class chooses.
    struct DuoPose<Content: View>: View {
        let size: CGSize
        let content: Content

        static var requested: CGSize? {
            let arguments = ProcessInfo.processInfo.arguments
            guard let at = arguments.firstIndex(of: "-fixturePose"), arguments.indices.contains(at + 1) else {
                return nil
            }
            return arguments[at + 1] == "upright" ? CGSize(width: 669, height: 951) : CGSize(width: 951, height: 669)
        }

        var body: some View {
            GeometryReader { proxy in
                Host(content: content)
                    .frame(width: size.width, height: size.height)
                    .scaleEffect(
                        min(proxy.size.width / size.width, proxy.size.height / size.height), anchor: .topLeading)
            }
            .ignoresSafeArea()
        }

        private struct Host: UIViewControllerRepresentable {
            let content: Content
            func makeUIViewController(context: Context) -> UIHostingController<Content> {
                let controller = UIHostingController(rootView: content)
                controller.traitOverrides.horizontalSizeClass = .regular
                controller.traitOverrides.verticalSizeClass = .regular
                return controller
            }
            func updateUIViewController(_ controller: UIHostingController<Content>, context: Context) {
                controller.rootView = content
            }
        }
    }
#endif
