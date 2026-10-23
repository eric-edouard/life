import Foundation
import QuietCore
import Testing

// What a call's output means is the server's (apps/voice/src/mac-llm.test.ts); the helper runs it and reports it raw.

@Test func parsesAnLLMMessage() throws {
    let message = """
        {"type":"llm","id":"a1","engine":"claude","model":"claude-opus-5-5","system":"Be brief.","prompt":"Hi","maxTokens":16000,
         "timeoutMs":170000,"schema":{"type":"object","required":["title"],"properties":{"title":{"type":"string"}}}}
        """
    let request = try #require(LLMRequest(message: message))
    #expect(request.id == "a1" && request.system == "Be brief." && request.prompt == "Hi" && request.maxTokens == 16000)
    #expect(request.engine == .claude && request.model == "claude-opus-5-5" && request.timeout == 170)
    #expect(
        LLMRequest(message: message.replacingOccurrences(of: #""model":"claude-opus-5-5","#, with: "")) == nil,
        "the server always names the model")
    #expect(
        LLMRequest(message: message.replacingOccurrences(of: #""timeoutMs":170000,"#, with: "")) == nil,
        "and the timeout")
    #expect(request.schema == #"{"properties":{"title":{"type":"string"}},"required":["title"],"type":"object"}"#)
}

@Test func ignoresOtherMessages() {
    #expect(LLMRequest(message: #"{"type":"hello"}"#) == nil)
    #expect(
        LLMRequest(message: #"{"type":"llm","id":"a1","system":"s","prompt":"p","maxTokens":1,"timeoutMs":1}"#) == nil,
        "no schema")
    #expect(LLMRequest(message: "not json") == nil)
}

@Test func reportsTheOutputRaw() {
    #expect(
        LLMOutput.ran(id: "a1", stdout: "{}", stderr: "", final: nil, status: 0, timedOut: false).message
            == #"{"id":"a1","status":0,"stderr":"","stdout":"{}","timedOut":false,"type":"llm.output"}"#)
    #expect(
        LLMOutput.ran(id: "a1", stdout: "", stderr: "x", final: "{}", status: 1, timedOut: true).message
            == #"{"final":"{}","id":"a1","status":1,"stderr":"x","stdout":"","timedOut":true,"type":"llm.output"}"#)
    #expect(
        LLMOutput.unrun(id: "a1", signedOut: true, why: "no claudeToken").message
            == #"{"id":"a1","signedOut":true,"type":"llm.unrun","unrun":"no claudeToken"}"#)
}

@Test func modelCallsRunWithoutToolsAtTheServersEffort() throws {
    let request = try #require(
        LLMRequest(
            message:
                #"{"type":"llm","id":"a","engine":"codex","model":"gpt-6.1-sol","effort":"medium","system":"Quote \"hello\"\nhttps://example.com/","prompt":"hi","schema":{},"maxTokens":16000,"timeoutMs":170000}"#
        ))
    #expect(request.engine == .codex)
    let args = request.codexArguments(schema: "/schema", output: "/output", directory: "/empty")
    #expect(args.contains("model_reasoning_effort=\"medium\""))
    #expect(args.contains("--ignore-user-config") && args.contains("--ignore-rules") && args.contains("--ephemeral"))
    #expect(args.contains("web_search=\"disabled\""))
    #expect(args.contains("skip_host_skill_discovery") && args.contains("skills.bundled.enabled=false"))
    #expect(args.contains("shell_tool") && args.contains("unified_exec") && args.contains("plugins"))
    var plain = request
    plain.effort = nil
    #expect(!plain.codexArguments(schema: "/s", output: "/o", directory: "/e").contains { $0.contains("effort") })
    let claude = request.claudeArguments
    for flag in ["--tools", "--setting-sources"] {
        #expect(claude.firstIndex(of: flag).map { claude[$0 + 1] } == "", "\(flag) is empty")
    }
    #expect(claude.contains("--strict-mcp-config") && claude.contains("--no-session-persistence"))
    #expect(LLMRequest.tomlString(request.system) == #""Quote \"hello\"\u000Ahttps://example.com/""#)
    #expect(LLMRequest.tomlString("\t\\\u{7f}") == #""\u0009\\\u007F""#)
}
