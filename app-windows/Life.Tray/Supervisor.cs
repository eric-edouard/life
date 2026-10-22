using System.Diagnostics;
using System.Runtime.InteropServices;
using Life.Core;

namespace Life.Tray;

/// What launchd does on the Mac, for the tray (Supervisor.swift): the archive and the watcher always running (started
/// again a few seconds after either stops), the nightly tick every 30 minutes (its own guard decides what is due), and
/// every process of Life's in one Job Object, so they end with the tray however it ends: never two watchers.
sealed class Supervisor
{
    static readonly string[][] Services = [["archive"], ["watch"]];
    static readonly TimeSpan TickEvery = TimeSpan.FromMinutes(30);

    readonly Dictionary<string, Process> services = [];
    readonly PeriodicTimer ticks = new(TickEvery);
    readonly PeriodicTimer looks = new(TimeSpan.FromSeconds(60));
    Process? nightly;
    bool ticking;

    /// The helper's last `app` answer: whether Life is set up, its sources, its newest report, its status reads.
    public Info? Info { get; private set; }

    /// The watcher's status reads, once the helper has said where they are.
    public StatusReads? Reads => Info is { } i ? new(i.Status) : null;

    /// A new report since the tray started: the notification's cue.
    public event Action<string>? Reported;

    public async Task Refresh()
    {
        var read = Info is not null;
        var before = Info?.LastReport;
        Info = await Helper.Info() ?? Info;
        // The report there when the tray starts is not new; the first one after it is.
        if (read && Info?.LastReport is { } now && now != before) Reported?.Invoke(now);
    }

    public async Task Start()
    {
        await Refresh();
        if (Info?.Started != true) return;
        lock (services)
        {
            if (services.Count == 0)
                foreach (var args in Services) Keep(args);
        }
        if (ticking) return;
        ticking = true;
        Tick();
        _ = Task.Run(async () =>
        {
            while (await ticks.WaitForNextTickAsync()) Tick();
        });
        // The helper's answer as of the last minute: a new report notifies on its own.
        _ = Task.Run(async () =>
        {
            while (await looks.WaitForNextTickAsync()) await Refresh();
        });
    }

    /// Settings changed: the helper reads them once per process, so each service starts again (a nightly running
    /// finishes on the settings it started with).
    public async Task Restart()
    {
        EndServices();
        await Start();
    }

    /// The tray quits: every process of Life's with it (the job would end them anyway).
    public void Stop()
    {
        ticks.Dispose();
        looks.Dispose();
        EndServices();
        End(nightly);
    }

    void EndServices()
    {
        lock (services)
        {
            foreach (var p in services.Values) End(p);
            services.Clear();
        }
    }

    static void End(Process? p)
    {
        try
        {
            if (p is { HasExited: false }) p.Kill(entireProcessTree: true);
        }
        catch (InvalidOperationException)
        {
            // Already gone.
        }
    }

    void Keep(string[] args)
    {
        var name = string.Join("-", args);
        var p = Launch(args, name);
        if (p is null) return;
        services[name] = p;
        p.EnableRaisingEvents = true;
        p.Exited += async (_, _) =>
        {
            await Task.Delay(TimeSpan.FromSeconds(5));
            lock (services)
            {
                if (services.TryGetValue(name, out var current) && current == p) Keep(args);
            }
        };
    }

    /// A nightly still running is left to finish (its own lock would refuse a second).
    void Tick()
    {
        if (nightly is { HasExited: false }) return;
        nightly = Launch(["memory", "nightly"], "memory-nightly");
    }

    /// A helper process, its output appended to %LOCALAPPDATA%\Life\logs\life-<name>.log, the log closed once the
    /// process and its output have ended. A log that can't be opened loses the output, never the process.
    static Process? Launch(string[] args, string name)
    {
        var log = Open(name);
        try
        {
            var p = Process.Start(Helper.StartInfo(args))!;
            Job.Add(p);
            p.OutputDataReceived += (_, e) => Write(log, e.Data);
            p.ErrorDataReceived += (_, e) => Write(log, e.Data);
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
            _ = p.WaitForExitAsync().ContinueWith(_ => Close(log), TaskScheduler.Default);
            return p;
        }
        catch (Exception e) when (e is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            Write(log, e.Message);
            Close(log);
            return null;
        }
    }

    static StreamWriter? Open(string name)
    {
        try
        {
            Directory.CreateDirectory(Helper.Logs);
            var file = new FileStream(Path.Combine(Helper.Logs, $"life-{name}.log"), FileMode.Append, FileAccess.Write, FileShare.ReadWrite);
            return new StreamWriter(file) { AutoFlush = true };
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    static void Write(StreamWriter? log, string? line)
    {
        if (log is null || line is null) return;
        lock (log)
        {
            try
            {
                log.WriteLine(line);
            }
            catch (Exception e) when (e is IOException or ObjectDisposedException)
            {
                // The disk is full or the log already closed: the line is lost, the service runs on.
            }
        }
    }

    static void Close(StreamWriter? log)
    {
        if (log is null) return;
        lock (log) log.Dispose();
    }

    /// One Job Object for the tray's lifetime, set to end every process in it when its last handle closes (the tray's
    /// exit, a crash included).
    public static class Job
    {
        static readonly IntPtr Handle = Create();

        public static void Add(Process p) => AssignProcessToJobObject(Handle, p.Handle);

        static IntPtr Create()
        {
            var job = CreateJobObject(IntPtr.Zero, null);
            var info = new ExtendedLimits { Basic = new BasicLimits { LimitFlags = KillOnJobClose } };
            var size = Marshal.SizeOf<ExtendedLimits>();
            var p = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(info, p, false);
                SetInformationJobObject(job, ExtendedLimitInformation, p, (uint)size);
            }
            finally
            {
                Marshal.FreeHGlobal(p);
            }
            return job;
        }

        const uint KillOnJobClose = 0x2000;
        const int ExtendedLimitInformation = 9;

        [StructLayout(LayoutKind.Sequential)]
        struct BasicLimits
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct ExtendedLimits
        {
            public BasicLimits Basic;
            public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
            public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
            public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
        }

        [DllImport("kernel32", CharSet = CharSet.Unicode)]
        static extern IntPtr CreateJobObject(IntPtr attributes, string? name);

        [DllImport("kernel32")]
        static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);

        [DllImport("kernel32")]
        static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    }
}
