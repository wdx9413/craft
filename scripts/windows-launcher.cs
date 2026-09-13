using System;
using System.Diagnostics;
using System.IO;

internal static class CraftLauncher
{
    private static string Quote(string value)
    {
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }

    private static int Main()
    {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        string node = Path.Combine(root, "node.exe");
        string cli = Path.Combine(root, "app", "dist", "src", "cli.js");
        ProcessStartInfo start = new ProcessStartInfo
        {
            FileName = node,
            Arguments = Quote(cli) + " gui",
            WorkingDirectory = root,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden
        };
        using (Process child = Process.Start(start))
        {
            if (child == null) return 1;
            child.WaitForExit();
            return child.ExitCode;
        }
    }
}
