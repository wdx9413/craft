using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

internal static class CraftLauncher
{
    private static string Quote(string value)
    {
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }

    private static int Run(string root, string node, string cli, string dataRoot, out string details)
    {
        ProcessStartInfo start = new ProcessStartInfo
        {
            FileName = node,
            Arguments = Quote(cli) + " gui",
            WorkingDirectory = root,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        if (!String.IsNullOrWhiteSpace(dataRoot)) start.EnvironmentVariables["CRAFT_DATA_DIR"] = dataRoot;
        using (Process child = Process.Start(start))
        {
            if (child == null) { details = "无法启动内置 Node runtime。"; return 1; }
            child.WaitForExit();
            details = (child.StandardError.ReadToEnd() + "\n" + child.StandardOutput.ReadToEnd()).Trim();
            return child.ExitCode;
        }
    }

    private static int Main()
    {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        string node = Path.Combine(root, "node.exe");
        string cli = Path.Combine(root, "app", "dist", "src", "cli.js");
        string details;
        int exitCode = Run(root, node, cli, null, out details);
        string explicitRoot = Environment.GetEnvironmentVariable("CRAFT_DATA_DIR");
        if (exitCode != 0 && String.IsNullOrWhiteSpace(explicitRoot) && details.IndexOf("database file", StringComparison.OrdinalIgnoreCase) >= 0)
        {
            string fallback = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Craft", "data");
            Directory.CreateDirectory(fallback);
            exitCode = Run(root, node, cli, fallback, out details);
        }
        if (exitCode != 0)
        {
            MessageBox.Show("Craft Workbench 启动失败。\n\n" + details + "\n\n如果数据目录不可写，请设置 CRAFT_DATA_DIR 到一个可写目录。", "Craft Workbench", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        return exitCode;
    }
}
