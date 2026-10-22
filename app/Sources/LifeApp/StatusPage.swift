import SwiftUI
import WebKit

/// The status page itself, as the watcher serves it on this Mac (`dashboard.ts`), opened with the local key in its
/// cookie: one page for the browser and the app, never a second rendering.
struct StatusPage: NSViewRepresentable {
  let status: Status

  func makeNSView(context: Context) -> WKWebView {
    let view = WKWebView()
    guard let url = URL(string: status.url),
      let cookie = HTTPCookie(properties: [
        .domain: url.host ?? "127.0.0.1", .path: "/", .name: "life_local", .value: status.key,
      ])
    else { return view }
    view.configuration.websiteDataStore.httpCookieStore.setCookie(cookie) {
      view.load(URLRequest(url: url))
    }
    return view
  }

  func updateNSView(_ view: WKWebView, context: Context) {}
}
