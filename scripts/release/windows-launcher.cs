using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

internal static class CraftLauncher
{
    private static string Quote(string value)
    {
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }

    /// <summary>
    /// .NET Framework's ProcessStartInfo.EnvironmentVariables is a case-insensitive
    /// StringDictionary, so on a machine that exports both HTTP_PROXY and http_proxy
    /// its getter throws ArgumentException while copying the current environment and
    /// Process.Start can never run at all. Drop the case-duplicate keys up front so
    /// the child environment can be built. Only the launcher and its own children are
    /// affected, and Node resolves env lookups case-insensitively on Windows anyway.
    /// </summary>
    private static void DropCaseDuplicateVariables()
    {
        ArrayList seen = new ArrayList();
        foreach (DictionaryEntry entry in Environment.GetEnvironmentVariables())
        {
            string key = (string)entry.Key;
            bool duplicate = false;
            for (int index = 0; index < seen.Count; index += 1)
            {
                if (String.Equals((string)seen[index], key, StringComparison.OrdinalIgnoreCase))
                {
                    duplicate = true;
                    break;
                }
            }
            if (duplicate) Environment.SetEnvironmentVariable(key, null);
            else seen.Add(key);
        }
    }

    /// <summary>
    /// The Workbench prints "&lt;origin&gt;/#token=..." and the same process also
    /// serves Craft Studio at "&lt;origin&gt;/studio#token=...". Derive the Studio URL
    /// from that first line rather than waiting for a second stdout line, which
    /// would block forever on an older cli.js that only prints one.
    /// </summary>
    private static string StudioUrl(string workbench)
    {
        const string marker = "/#token=";
        if (workbench.IndexOf(marker, StringComparison.Ordinal) < 0) return workbench;
        return workbench.Replace(marker, "/studio#token=");
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
        error = "未找到 Microsoft Edge 或 Google Chrome，无法创建 Craft Studio 原生窗口。";
        return false;
    }

    private static int Run(string root, string node, string cli, string extra, string dataRoot, out string details)
    {
        DropCaseDuplicateVariables();
        ProcessStartInfo start = new ProcessStartInfo
        {
            FileName = node,
            Arguments = Quote(cli) + " gui" + extra,
            WorkingDirectory = root,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        if (!String.IsNullOrWhiteSpace(dataRoot)) start.EnvironmentVariables["CRAFT_DATA_DIR"] = dataRoot;
        start.EnvironmentVariables["CRAFT_NO_BROWSER"] = "1";
        // A key the user pasted into Studio is stored beside the settings file,
        // never in the process environment the user manages by hand. Injecting
        // it here is what makes "paste a key and it works" true on Windows.
        foreach (KeyValuePair<string, string> credential in ReadCredentials())
        {
            start.EnvironmentVariables[credential.Key] = credential.Value;
        }
        using (Process child = Process.Start(start))
        {
            if (child == null) { details = "无法启动内置 Node runtime。"; return 1; }
            Process window = null;
            string firstLine = child.StandardOutput.ReadLine();
            if (firstLine != null && firstLine.StartsWith("Craft Workbench: ", StringComparison.Ordinal))
            {
                string url = StudioUrl(firstLine.Substring("Craft Workbench: ".Length).Trim());
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
                child.WaitForExit();
                // Closing the app window is the normal way to quit. The child is
                // killed on purpose at that point, which yields a non-zero exit
                // code, so report success rather than a bogus failure dialog.
                details = "";
                return 0;
            }
            child.WaitForExit();
            details = (child.StandardError.ReadToEnd() + "\n" + child.StandardOutput.ReadToEnd()).Trim();
            return child.ExitCode;
        }
    }

    /// <summary>
    /// Reads the desktop credential file, if present, in the same
    /// `NAME=value` form that Craft's readCredentialFile understands.
    /// A missing or unreadable file is not fatal: the user may still have
    /// configured the variable globally, and Craft reports what is missing.
    /// </summary>
    private static List<KeyValuePair<string, string>> ReadCredentials()
    {
        List<KeyValuePair<string, string>> credentials = new List<KeyValuePair<string, string>>();
        try
        {
            string path = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Craft", "credentials.env");
            if (!File.Exists(path)) return credentials;
            foreach (string raw in File.ReadAllLines(path))
            {
                string line = raw.Trim();
                if (line.Length == 0 || line.StartsWith("#", StringComparison.Ordinal)) continue;
                int separator = line.IndexOf('=');
                if (separator <= 0) continue;
                string name = line.Substring(0, separator).Trim();
                string value = line.Substring(separator + 1).Trim();
                if (name.Length == 0 || value.Length == 0) continue;
                credentials.Add(new KeyValuePair<string, string>(name, value));
            }
        }
        catch (Exception)
        {
            // Never let an unreadable credential file stop Craft from starting.
        }
        return credentials;
    }

    private static int Main()
    {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        string node = Path.Combine(root, "node.exe");
        string cli = Path.Combine(root, "app", "dist", "src", "cli.js");
        // Forward our own arguments so `craft.exe --port 4174` works when the
        // default port is already taken by another Craft instance.
        string extra = "";
        string[] argv = Environment.GetCommandLineArgs();
        for (int index = 1; index < argv.Length; index += 1) extra += " " + Quote(argv[index]);
        string details;
        int exitCode = Run(root, node, cli, extra, null, out details);
        string explicitRoot = Environment.GetEnvironmentVariable("CRAFT_DATA_DIR");
        if (exitCode != 0 && String.IsNullOrWhiteSpace(explicitRoot) && details.IndexOf("database file", StringComparison.OrdinalIgnoreCase) >= 0)
        {
            string fallback = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Craft", "data");
            Directory.CreateDirectory(fallback);
            exitCode = Run(root, node, cli, extra, fallback, out details);
        }
        if (exitCode != 0)
        {
            MessageBox.Show("Craft Studio 启动失败。\n\n" + details + "\n\n如果数据目录不可写，请设置 CRAFT_DATA_DIR 到一个可写目录。", "Craft Studio", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        return exitCode;
    }
}
