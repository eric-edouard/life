using System.Runtime.InteropServices;
using System.Text;

namespace Life.Tray;

/// The tray's few secrets in Windows Credential Manager, one generic credential per key, named "Life/<KEY>" (as the Mac
/// keeps them in the Keychain service "Life"). The helper takes them from its environment.
static class Secrets
{
    const string Prefix = "Life/";
    const int Generic = 1;
    const int PersistLocalMachine = 2;

    public static string? Read(string name)
    {
        if (!CredRead(Prefix + name, Generic, 0, out var p)) return null;
        try
        {
            return Value(Marshal.PtrToStructure<Credential>(p));
        }
        finally
        {
            CredFree(p);
        }
    }

    /// Every secret kept for Life, by name.
    public static Dictionary<string, string> All()
    {
        var all = new Dictionary<string, string>();
        if (!CredEnumerate(Prefix + "*", 0, out var count, out var list)) return all;
        try
        {
            for (var i = 0; i < count; i++)
            {
                var c = Marshal.PtrToStructure<Credential>(Marshal.ReadIntPtr(list, i * IntPtr.Size));
                all[c.TargetName[Prefix.Length..]] = Value(c);
            }
        }
        finally
        {
            CredFree(list);
        }
        return all;
    }

    /// Kept, or removed when empty: false when Credential Manager refused it.
    public static bool Write(string name, string value)
    {
        if (value.Length == 0)
        {
            // Refused only when there was nothing to remove.
            CredDelete(Prefix + name, Generic, 0);
            return true;
        }
        var blob = Encoding.UTF8.GetBytes(value);
        var p = Marshal.AllocHGlobal(blob.Length);
        try
        {
            Marshal.Copy(blob, 0, p, blob.Length);
            var c = new Credential
            {
                Type = Generic,
                TargetName = Prefix + name,
                CredentialBlobSize = blob.Length,
                CredentialBlob = p,
                Persist = PersistLocalMachine,
                UserName = "Life",
            };
            return CredWrite(ref c, 0);
        }
        finally
        {
            Marshal.FreeHGlobal(p);
        }
    }

    static string Value(Credential c)
    {
        var blob = new byte[c.CredentialBlobSize];
        if (blob.Length > 0) Marshal.Copy(c.CredentialBlob, blob, 0, blob.Length);
        return Encoding.UTF8.GetString(blob);
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct Credential
    {
        public int Flags;
        public int Type;
        public string TargetName;
        public string? Comment;
        public long LastWritten;
        public int CredentialBlobSize;
        public IntPtr CredentialBlob;
        public int Persist;
        public int AttributeCount;
        public IntPtr Attributes;
        public string? TargetAlias;
        public string? UserName;
    }

    [DllImport("advapi32", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CredRead(string target, int type, int flags, out IntPtr credential);

    [DllImport("advapi32", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CredWrite(ref Credential credential, int flags);

    [DllImport("advapi32", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CredDelete(string target, int type, int flags);

    [DllImport("advapi32", EntryPoint = "CredEnumerateW", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CredEnumerate(string filter, int flags, out int count, out IntPtr credentials);

    [DllImport("advapi32")]
    static extern void CredFree(IntPtr buffer);
}
