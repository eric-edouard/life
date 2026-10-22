using Life.Core;
using System.Text.Json.Nodes;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.Win32;

namespace Life.Tray;

/// Settings, and the first run's setup (SettingsView in LifeApp.swift): every value goes through the helper
/// (`life settings set`), secrets to Credential Manager.
sealed class SettingsWindow : Window
{
    const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    static readonly (string Tag, string Label)[] Engines =
    [
        ("claude", "Claude (your subscription)"), ("codex", "ChatGPT (your subscription, Codex)"),
        ("anthropic", "Anthropic API key"), ("openai", "OpenAI API key"),
    ];

    readonly Supervisor supervisor;
    readonly TextBlock status = Ui.Caption("");

    public SettingsWindow(Supervisor supervisor)
    {
        this.supervisor = supervisor;
        Title = "Life settings";
        AppWindow.Resize(new(560, 760));
        _ = Load();
    }

    async Task Load()
    {
        await supervisor.Refresh();
        StackPanel page;
        if (supervisor.Info?.Started == true)
        {
            var r = await Helper.Run("settings");
            page = Settings(Wire.Settings(r.Out));
            // The helper didn't answer: the form shows, and says why its values are missing.
            if (r.Code != 0) status.Text = $"Life's settings can't be read now: {r.Err}";
        }
        else
        {
            page = Setup();
        }
        page.Children.Add(status);
        Content = new ScrollViewer
        {
            Background = Ui.Brush("Page"),
            Content = new Border { Child = page, Padding = new Thickness(24) },
        };
    }

    static TextBox Field(string header, string? text = "") => new() { Header = header, Text = text ?? "" };

    StackPanel Setup()
    {
        var name = Field("Your name");
        var email = Field("Your email");
        return Ui.Column(12, Ui.Label("Who you are"), name, email, Ui.Button("Start Life", async () =>
        {
            if (name.Text.Length == 0) return;
            string[] args = email.Text.Length == 0 ? ["init", "--name", name.Text] : ["init", "--name", name.Text, "--email", email.Text];
            var r = await Helper.Run(args);
            await supervisor.Start();
            await Load();
            status.Text = r.Code == 0 ? "Life is set up." : r.Err;
        }, primary: true));
    }

    StackPanel Settings(JsonObject saved)
    {
        var engine = new ComboBox { Header = "Engine", ItemsSource = Engines.Select(e => e.Label).ToList(), HorizontalAlignment = HorizontalAlignment.Stretch };
        engine.SelectedIndex = Math.Max(0, Array.FindIndex(Engines, e => e.Tag == ((string?)saved["engine"] ?? "claude")));
        string Engine() => Engines[Math.Max(0, engine.SelectedIndex)].Tag;
        string KeyName() => Engine() == "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
        var key = new PasswordBox { Header = "API key", Password = Secrets.Read(KeyName()) ?? "" };
        // Each key under its own name: a switch shows the new engine's, never carries the old one over.
        engine.SelectionChanged += (_, _) => key.Password = Secrets.Read(KeyName()) ?? "";

        var sources = Ui.Column(4);
        foreach (var s in supervisor.Info?.Sources ?? [])
        {
            var toggle = new ToggleSwitch { Header = s.Label, IsOn = s.On };
            toggle.Toggled += async (_, _) =>
            {
                var on = (supervisor.Info?.Sources ?? []).Where(x => x.On && x.Name != s.Name).Select(x => x.Name).ToList();
                if (toggle.IsOn) on.Add(s.Name);
                status.Text = await Helper.Set(new { sources = on });
                // The helper reads its settings once: the archive and the watcher start again on the new sources.
                await supervisor.Restart();
            };
            sources.Children.Add(toggle);
            if (s.On && s.Missing is { } why) sources.Children.Add(Ui.Caption(why));
        }
        var lifelogUrl = Field("lifelog address", (string?)saved["lifelog"]?["url"]);
        var lifelogToken = new PasswordBox { Header = "lifelog token", Password = Secrets.Read("LIFELOG_TOKEN") ?? "" };

        var agent = saved["agent"] as JsonObject ?? [];
        var agentName = Field("Its name (\"hey …\" wakes it)", (string?)agent["name"]);
        var wake = Field("Wake word, as heard", (string?)agent["wake"]?[0]);
        var transport = new ComboBox { Header = "It gets your asks", ItemsSource = new[] { "Pushed to it (ChatGPT)", "When it checks in (Claude)" } };
        transport.SelectedIndex = (string?)agent["transport"] == "pull" ? 1 : 0;

        var origin = (string?)saved["connector"]?["origin"];
        var login = new ToggleSwitch { Header = "Open Life at login", IsOn = Registry.CurrentUser.OpenSubKey(RunKey)?.GetValue("Life") is not null };
        login.Toggled += (_, _) =>
        {
            using var run = Registry.CurrentUser.CreateSubKey(RunKey);
            if (login.IsOn) run.SetValue("Life", $"\"{Environment.ProcessPath}\"");
            else run.DeleteValue("Life", throwOnMissingValue: false);
        };

        async Task Save()
        {
            // In order, stopping at the first refusal, so "nothing saved" is true.
            var kept = (Engine() is not ("anthropic" or "openai") || Secrets.Write(KeyName(), key.Password))
                && Secrets.Write("LIFELOG_TOKEN", lifelogToken.Password);
            if (!kept)
            {
                status.Text = "Credential Manager refused a secret: nothing saved.";
                return;
            }
            var parts = new JsonObject { ["engine"] = Engine() };
            if (agentName.Text.Length > 0)
            {
                // The agent as saved, so a save keeps what this form doesn't show.
                var a = (JsonObject)agent.DeepClone();
                a["name"] = agentName.Text;
                a["wake"] = new JsonArray(wake.Text.Length == 0 ? agentName.Text.ToLowerInvariant() : wake.Text);
                a["transport"] = transport.SelectedIndex == 1 ? "pull" : "mcp-event";
                parts["agent"] = a;
            }
            if (lifelogUrl.Text.Length > 0) parts["lifelog"] = new JsonObject { ["url"] = lifelogUrl.Text };
            status.Text = await Helper.Set(parts);
            await supervisor.Restart();
        }

        async Task Connect(bool publicToo)
        {
            var r = await Helper.Run(publicToo ? ["connect", "--public"] : ["connect"]);
            if (r.Code == 0)
            {
                await supervisor.Restart();
                await Load();
            }
            status.Text = r.Code == 0 ? r.Out : r.Err;
        }

        return Ui.Column(12,
            Ui.Label("Thinking"), engine, key,
            Ui.Label("Sources"), sources, lifelogUrl, lifelogToken,
            Ui.Label("Your agent"), agentName, wake, transport,
            Ui.Label("Reaching Life"),
            Ui.Text(origin is null ? "Not on your tailnet yet" : $"{origin}/mcp", 13, mono: true),
            Ui.Row(8, Ui.Button("On my tailnet", () => _ = Connect(false)), Ui.Button("Public, for ChatGPT and Claude.ai", () => _ = Connect(true))),
            login,
            Ui.Button("Save", () => _ = Save(), primary: true));
    }
}
