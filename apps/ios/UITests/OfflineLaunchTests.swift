import XCTest

/// The demo library with every server request failing (`-offline`): the Library shows its rows anyway, and its
/// status says Offline. UI tests need XCTest; everything else uses Swift Testing.
final class OfflineLaunchTests: XCTestCase {
    @MainActor
    func testLibraryShowsRowsOffline() {
        // A fresh simulator asks for location, photos and notifications; none matters here.
        addUIInterruptionMonitor(withDescription: "Permission alerts") { alert in
            guard let button = ["Don’t Allow", "Not Now"].map({ alert.buttons[$0] }).first(where: \.exists) else {
                return false
            }
            button.tap()
            return true
        }
        let app = XCUIApplication()
        app.launchArguments = ["-fixtureLibrary", "-offline"]
        app.launch()
        app.tabBars.buttons["Library"].tap()
        // The demo library is seeded at launch; that wait is local.
        XCTAssertTrue(app.buttons["library.row"].firstMatch.waitForExistence(timeout: 20))
        XCTAssertEqual(app.buttons["connection.status"].label, "Offline")
    }
}
