import Foundation
import Testing

@testable import ServerAPI

@Test func aFailureShowsOnlyOnceItSurvivesARecheck() {
    var health = PullHealth()
    health.failed(URLError(.timedOut))
    #expect(health.hasFailed && !health.isEstablished)
    health.failed(URLError(.notConnectedToInternet))
    #expect(health.isEstablished)
    var other = PullHealth()
    other.failed(URLError(.badServerResponse))
    #expect(other.hasFailed)
}

@Test func callingAPollOffNeverClearsOrAddsAFailure() {
    var health = PullHealth()
    health.failed(URLError(.timedOut))
    health.failed(URLError(.timedOut))
    for _ in 0..<5 {
        health.failed(URLError(.cancelled))
        health.failed(CancellationError())
        #expect(health.isEstablished)
    }
    var fresh = PullHealth()
    fresh.failed(URLError(.cancelled))
    #expect(!fresh.hasFailed)
}

@Test func onlyASuccessClearsAnEstablishedFailure() {
    var health = PullHealth()
    health.failed(URLError(.timedOut), isAsked: true)
    #expect(health.isEstablished)
    health.succeeded()
    #expect(!health.hasFailed)
}
