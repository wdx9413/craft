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

    private static bool OpenNativeWindow(string url, out Process window, out string error)
    {
        string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        string programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        string programFilesX86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
        string[] candidates = new string[]
        {
            Path.Combine(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
            Path.Combine(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
            Path.Combine(local, "Microsoft", "Edge", "Application", "msedge.exe"),
            Path.Combine(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
            Path.Combine(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
            Path.Combine(local, "Google", "Chrome", "Application", "chrome.exe")
        };
        foreach (string candidate in candidates)
        {
            if (!File.Exists(candidate)) continue;
            ProcessStartInfo start = new ProcessStartInfo
            {
                FileName = candidate,
                Arguments = "--app=" + Quote(url) + " --new-window",
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };
            window = Process.Start(start);
            if (window != null) { error = ""; return true; }
        }
        window = null;
        error = "未找到 Microsoft Edge 或 Google Chrome，无法创建 Workbench 原生窗口。";
        return false;
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
        start.EnvironmentVariables["CRAFT_NO_BROWSER"] = "1";
        using (Process child = Process.Start(start))
        {
            if (child == null) { details = "无法启动内置 Node runtime。"; return 1; }
            Process window = null;
            string firstLine = child.StandardOutput.ReadLine();
            if (firstLine != null && firstLine.StartsWith("Craft Workbench: ", StringComparison.Ordinal))
            {
                string url = firstLine.Substring("Craft Workbench: ".Length).Trim();
                string windowError;
                if (!OpenNativeWindow(url, out window, out windowError))
                {
                    if (!child.HasExited) child.Kill();
                    child.WaitForExit();
                    details = windowError + "\n" + child.StandardError.ReadToEnd();
                    return 1;
                }
                window.WaitForExit();
                if (!child.HasExited) child.Kill();
            }
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
