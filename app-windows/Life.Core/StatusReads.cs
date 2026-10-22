using System.Net.Http.Headers;

namespace Life.Core;

/// The watcher's status reads (src/dashboard.ts, the local port), opened with the local key as a bearer.
public sealed class StatusReads(Status status)
{
    static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(10) };

    /// One read, decoded: null while the watcher doesn't answer.
    async Task<T?> Read<T>(string path) where T : class
    {
        using var req = new HttpRequestMessage(HttpMethod.Get, status.Url + path);
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", status.Key);
        try
        {
            using var res = await Http.SendAsync(req);
            return res.IsSuccessStatusCode ? Wire.Read<T>(await res.Content.ReadAsStringAsync()) : null;
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException)
        {
            return null;
        }
    }

    public Task<Plate?> Plate() => Read<Plate>("status/snapshot");

    public Task<Detail?> Detail(string card, string? before = null) =>
        Read<Detail>($"status/card/{Uri.EscapeDataString(card)}" + (before is null ? "" : $"?before={Uri.EscapeDataString(before)}"));
}
