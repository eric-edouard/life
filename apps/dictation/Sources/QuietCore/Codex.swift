import Foundation

public enum LLMEngine: String, CaseIterable, Sendable {
    case claude, codex
}

extension LLMRequest {
    /// `claude -p` with no tools, settings, MCP servers or saved session. Recorded speech has no tools or rules.
    public var claudeArguments: [String] {
        [
            "-p", "--model", model, "--system-prompt", system, "--tools", "", "--strict-mcp-config",
            "--setting-sources", "", "--no-session-persistence", "--output-format", "json", "--json-schema", schema,
        ]
    }

    /// Runs with the helper's separate login, in an empty directory, at the effort the server asks. Recorded speech
    /// has no tools or rules.
    public func codexArguments(schema: String, output: String, directory: String) -> [String] {
        var arguments = [
            "--no-daemon", "exec", "-", "--ephemeral", "--ignore-user-config", "--ignore-rules",
            "--skip-git-repo-check",
            "-s", "read-only", "-C", directory, "-m", model,
            "-c", "developer_instructions=\(Self.tomlString(system))", "-c", "web_search=\"disabled\"",
            "-c", "skills.bundled.enabled=false", "--enable", "skip_host_skill_discovery",
            "--output-schema", schema, "-o", output, "--json",
        ]
        if let effort { arguments += ["-c", "model_reasoning_effort=\(Self.tomlString(effort))"] }
        for feature in [
            "shell_tool", "unified_exec", "plugins", "apps", "browser_use", "browser_use_external",
            "computer_use", "image_generation", "multi_agent", "hooks", "goals", "in_app_browser",
            "code_mode_host", "skill_search", "tool_suggest", "sleep_tool", "memories",
        ] {
            arguments += ["--disable", feature]
        }
        return arguments
    }

    /// JSON escapes such as `\/` aren't TOML escapes. Encode a TOML basic string explicitly.
    public static func tomlString(_ value: String) -> String {
        var result = "\""
        for scalar in value.unicodeScalars {
            switch scalar.value {
            case 34: result += "\\\""
            case 92: result += "\\\\"
            case 0...31, 127: result += String(format: "\\u%04X", scalar.value)
            default: result.unicodeScalars.append(scalar)
            }
        }
        return result + "\""
    }
}
