import Foundation
import Testing

@testable import LifeConnector

private func row(
    _ id: String, agent: String = "a", status: String = "moving", needsYou: Bool = false, project: String? = nil
)
    -> MatterRow
{
    let project = project.map { #","project":{"id":"p","name":"P","status":"\#($0)"}"# } ?? ""
    let json =
        #"{"id":"\#(id)","name":"\#(id)","status":"\#(status)","agent":"\#(agent)","needsYou":\#(needsYou)\#(project)}"#
    return try! JSONDecoder().decode(MatterRow.self, from: Data(json.utf8))
}

@Test func anAgentsMattersFallIntoThreeGroupsAndItsWordsSaySo() {
    let rows = [
        row("m1", needsYou: true), row("m2", status: "waiting_on_someone"), row("m3"), row("m4", needsYou: true),
        row("other", agent: "b"), row("parked", needsYou: true, project: "parked"),
    ]
    let held = HeldMatters(of: "a", in: rows)
    #expect(held.needsYou.map { $0.id } == ["m1", "m4"])
    #expect(held.waiting.map { $0.id } == ["m2"])
    #expect(held.inWork.map { $0.id } == ["m3"])
    #expect(held.words == "2 need you · 1 waiting · 1 in work")
}

@Test func oneMatterNeedsYouAndNothingRunningHasNoWords() {
    #expect(HeldMatters(of: "a", in: [row("m1", needsYou: true)]).words == "1 needs you")
    #expect(HeldMatters(of: "a", in: [row("p", project: "parked")]).words == nil)
}
