using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace Life.Core;

// What Life answers, as the Mac's app reads it (app/Sources/LifeApp/Helper.swift and Plate.swift): the helper's `app`
// (src/cli.ts) and the watcher's status reads (src/dashboard.ts). The shapes live there; these only decode them.

/// The helper's `app` answer, the parts the tray shows: whether Life is set up, its newest report, its sources, its
/// status reads.
public sealed record Info(bool Started, string? LastReport, IReadOnlyList<Source> Sources, Status Status);

/// One source: whether he turned it on, and what keeps it from being read now.
public sealed record Source(string Name, string Label, bool On, string? Missing);

/// The watcher's status reads on this machine and the local key that opens them.
public sealed record Status(string Url, string Key);

/// The plate (`snapshot`, src/plate.ts): every part of Life as a card in a group.
public sealed record Plate(
    IReadOnlyList<Card> Cards,
    IReadOnlyList<Group> Groups,
    DateTimeOffset ObservedAt,
    IReadOnlyList<Tick> Today,
    IReadOnlyList<string> Trouble,
    Tone Worst);

public sealed record Group(string Id, string Name);

/// A status colour: always shown with a word.
public enum Tone { Bad, Busy, Idle, Ok, Teal, Warn }

public sealed record Card(
    string Id,
    string Group,
    string Name,
    string Headline,
    Tone Tone,
    string Word,
    IReadOnlyList<Fact> Facts,
    DateTimeOffset? At = null,
    string? Ask = null,
    IReadOnlyList<string>? Content = null,
    IReadOnlyList<Station>? Stations = null);

public sealed record Fact(string Label, string? Value = null, DateTimeOffset? At = null);

public sealed record Station(string Name, string State);

/// One mark on the last 24 hours: a run, an email, a sleep (a band, not a run).
public sealed record Tick(DateTimeOffset At, string Label, Tone Tone, DateTimeOffset? End = null, bool? Sleep = null);

/// A card's history and raw log lines (`detail`, src/plate-detail.ts), each with where it goes on.
public sealed record Detail(IReadOnlyList<Entry> History, IReadOnlyList<string> Log, Next Next);

public sealed record Entry(string Title, Tone Tone, DateTimeOffset? At = null, string? Content = null, string? Run = null, string? Sub = null);

public sealed record Next(string? History, string? Log);

public static class Wire
{
    static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
    {
        // A field missing, or null where it may not be, is a shape the tray doesn't know: no answer, never a crash.
        RespectNullableAnnotations = true,
        RespectRequiredConstructorParameters = true,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase, allowIntegerValues: false) },
    };

    /// One answer decoded: null when it is not in the shape the tray knows (an update of one without the other).
    public static T? Read<T>(string json) where T : class
    {
        try
        {
            return JsonSerializer.Deserialize<T>(json, Options);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// `life settings` as an object to read and merge, empty when the helper didn't answer one.
    public static JsonObject Settings(string json)
    {
        try
        {
            return JsonNode.Parse(json) as JsonObject ?? [];
        }
        catch (JsonException)
        {
            return [];
        }
    }

    /// A settings change for `life settings set '<json>'`.
    public static string Write(object value) => JsonSerializer.Serialize(value, Options);
}
