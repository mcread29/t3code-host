using System;
using System.Diagnostics;
using System.IO;
using System.Text;

internal static class CommandShim
{
    private static string Quote(string value)
    {
        if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '"' }) < 0)
        {
            return value;
        }

        var result = new StringBuilder("\"");
        var slashes = 0;
        foreach (var character in value)
        {
            if (character == '\\')
            {
                slashes++;
                continue;
            }
            if (character == '"')
            {
                result.Append('\\', slashes * 2 + 1);
                result.Append(character);
                slashes = 0;
                continue;
            }
            result.Append('\\', slashes);
            slashes = 0;
            result.Append(character);
        }
        result.Append('\\', slashes * 2);
        result.Append('"');
        return result.ToString();
    }

    private static int Main(string[] args)
    {
        var executable = Process.GetCurrentProcess().MainModule.FileName;
        var script = Path.ChangeExtension(executable, ".ps1");
        var shell = Environment.GetEnvironmentVariable("T3CODE_PWSH");
        if (String.IsNullOrEmpty(shell))
        {
            shell = "pwsh.exe";
        }

        var arguments = new StringBuilder();
        arguments.Append("-NoLogo -NoProfile -File ");
        arguments.Append(Quote(script));
        foreach (var argument in args)
        {
            arguments.Append(' ');
            arguments.Append(Quote(argument));
        }

        var start = new ProcessStartInfo(shell, arguments.ToString());
        start.UseShellExecute = false;
        var child = Process.Start(start);
        child.WaitForExit();
        return child.ExitCode;
    }
}
