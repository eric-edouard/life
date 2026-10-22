using System.Diagnostics;
using Life.Core;

namespace Life.Tray;

/// Life's helper: the compiled binary shipped beside the tray (`helper\life.exe`, from scripts/helper.ts with its
/// resources), run with its files (`LIFE_ROOT`), the owner's data and Life's state under %LOCALAPPDATA%\Life, and every
/// secret Credential Manager holds for it. The tray never reads Life's files: it asks the helper (`app`, `settings`,
/// `init`, `pair`, `connect`), as Helper.swift does on the Mac.
static class Helper
{
    public static readonly string Home = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Life");
    public static readonly string Logs = Path.Combine(Home, "logs");
    static readonly string Folder = Path.Combine(AppContext.BaseDirectory, "helper");

    public static ProcessStartInfo StartInfo(IEnumerable<string> args)
    {
        Directory.CreateDirectory(Home);
        var info = new ProcessStartInfo(Path.Combine(Folder, "life.exe"))
        {
            WorkingDirectory = Home,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (var a in args) info.ArgumentList.Add(a);
        info.Environment["LIFE_ROOT"] = Path.Combine(Folder, "resources");
        info.Environment["LIFE_DATA"] = Path.Combine(Home, "data");
        info.Environment["LIFE_STATE"] = Path.Combine(Home, "state");
        foreach (var (name, value) in Secrets.All()) info.Environment.TryAdd(name, value);
        return info;
    }

    /// One command to its end: its exit code, what it printed (JSON for the tray's reads) and its errors apart.
    public static async Task<(int Code, string Out, string Err)> Run(params string[] args)
    {
        try
        {
            using var p = Process.Start(StartInfo(args))!;
            Supervisor.Job.Add(p);
            var output = p.StandardOutput.ReadToEndAsync();
            var errors = p.StandardError.ReadToEndAsync();
            await p.WaitForExitAsync();
            return (p.ExitCode, (await output).Trim(), (await errors).Trim());
        }
        catch (Exception e) when (e is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            return (-1, "", e.Message);
        }
    }

    /// What the tray shows (`life app`): null while the helper can't answer.
    public static async Task<Info?> Info() => Wire.Read<Info>((await Run("app")).Out);

    /// `life settings set '<json>'`: the helper validates and keeps it.
    public static async Task<string> Set(object parts)
    {
        var r = await Run("settings", "set", Wire.Write(parts));
        return r.Code == 0 ? "Saved." : r.Err;
    }
}
