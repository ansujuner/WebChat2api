#Requires -Version 5.1
# Shared launcher primitives. No desktop action occurs until Get-LocalDesktopShell.
function Initialize-LocalLaunchNative {
    if ('Chat2Api.LocalLaunchNative' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Principal;
namespace Chat2Api {
 public sealed class LaunchContext {
  public string UserSid;
  public int Integrity;
  public bool Elevated;
  public int SessionId;
 }
 public static class LocalLaunchNative {
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int id);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr data, int size, out int returned);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);
  [DllImport("user32.dll")] public static extern IntPtr GetShellWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out int id);
  public static LaunchContext Context(int id) {
   IntPtr process=OpenProcess(0x1000, false, id), token=IntPtr.Zero, data=IntPtr.Zero;
   if(process==IntPtr.Zero) throw new InvalidOperationException("process_identity_unavailable");
   try {
    if(!OpenProcessToken(process, 8, out token)) throw new InvalidOperationException("process_identity_unavailable");
    int length;
    GetTokenInformation(token,25,IntPtr.Zero,0,out length);
    if(length<=0) throw new InvalidOperationException("process_identity_unavailable");
    data=Marshal.AllocHGlobal(length);
    if(!GetTokenInformation(token,25,data,length,out length)) throw new InvalidOperationException("process_identity_unavailable");
    IntPtr sid=Marshal.ReadIntPtr(data);
    byte count=Marshal.ReadByte(GetSidSubAuthorityCount(sid));
    int integrity=Marshal.ReadInt32(GetSidSubAuthority(sid,(uint)(count-1)));
    Marshal.FreeHGlobal(data); data=Marshal.AllocHGlobal(4);
    if(!GetTokenInformation(token,20,data,4,out length)) throw new InvalidOperationException("process_identity_unavailable");
    using(var identity=new WindowsIdentity(token)) {
     return new LaunchContext { UserSid=identity.User.Value, Integrity=integrity,
      Elevated=Marshal.ReadInt32(data)!=0, SessionId=Process.GetProcessById(id).SessionId };
    }
   } finally { if(data!=IntPtr.Zero)Marshal.FreeHGlobal(data); if(token!=IntPtr.Zero)CloseHandle(token); CloseHandle(process); }
  }
 }
}
'@
}

function Get-LocalLauncherContext {
    param([int]$ProcessId = $PID)
    Initialize-LocalLaunchNative
    [Chat2Api.LocalLaunchNative]::Context($ProcessId)
}

function Get-LocalDesktopShell {
    param($ExpectedContext)
    Initialize-LocalLaunchNative
    $desktopHandle = [Chat2Api.LocalLaunchNative]::GetShellWindow()
    $desktopProcessId = 0
    if ($desktopHandle -eq [IntPtr]::Zero) { throw 'desktop_unavailable' }
    [void][Chat2Api.LocalLaunchNative]::GetWindowThreadProcessId($desktopHandle, [ref]$desktopProcessId)
    $desktop = Get-LocalLauncherContext -ProcessId $desktopProcessId
    $explorerPath = Join-Path $env:SystemRoot 'explorer.exe'
    $process = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $desktopProcessId"
    if (-not $process -or -not $process.ExecutablePath -or
        -not $process.ExecutablePath.Equals($explorerPath, [StringComparison]::OrdinalIgnoreCase) -or
        $desktop.UserSid -ne $ExpectedContext.UserSid -or $desktop.SessionId -ne $ExpectedContext.SessionId -or
        $desktop.Elevated -or $desktop.Integrity -lt 8192 -or $desktop.Integrity -ge 12288) { throw 'desktop_identity_unverified' }
    # Find the existing Explorer desktop rather than ShellExecute on a newly
    # created elevated Shell.Application object.
    $shellWindows = New-Object -ComObject Shell.Application
    $location = [object]0
    $root = [object]0
    $foundHandle = 0
    $desktopBrowser = $shellWindows.Windows().FindWindowSW([ref]$location, [ref]$root, 8, [ref]$foundHandle, 1)
    if (-not $desktopBrowser) { throw 'desktop_unavailable' }
    $foundProcessId = 0
    [void][Chat2Api.LocalLaunchNative]::GetWindowThreadProcessId([IntPtr]$foundHandle, [ref]$foundProcessId)
    if ($foundProcessId -ne $desktopProcessId) { throw 'desktop_identity_unverified' }
    return $desktopBrowser.Document.Application
}

function Assert-LocalLaunchedProcess {
    param([int]$ProcessId, [string]$ElectronPath, [string]$ProjectRoot, $ExpectedContext, [DateTime]$NotBeforeUtc)
    if ($ProcessId -le 0) { throw 'launch_identity_unverified' }
    $context = Get-LocalLauncherContext -ProcessId $ProcessId
    $process = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $ProcessId"
    # The fixed launcher passes exactly one quoted app-directory argument, with
    # no browser flags. Substring matches could accidentally accept another app.
    $expectedCommand = '"' + $ElectronPath + '" "' + $ProjectRoot + '"'
    $unquotedExecutable = $ElectronPath + ' "' + $ProjectRoot + '"'
    if (-not $process -or -not $process.ExecutablePath -or -not $process.CommandLine -or -not $process.CreationDate -or
        -not $process.ExecutablePath.Equals($ElectronPath, [StringComparison]::OrdinalIgnoreCase) -or
        ($process.CommandLine.Trim() -ine $expectedCommand -and $process.CommandLine.Trim() -ine $unquotedExecutable) -or
        ([DateTime]$process.CreationDate).ToUniversalTime() -lt $NotBeforeUtc -or
        $context.Elevated -or $context.Integrity -lt 8192 -or $context.Integrity -ge 12288 -or
        $context.UserSid -ne $ExpectedContext.UserSid -or $context.SessionId -ne $ExpectedContext.SessionId) {
        throw 'launch_identity_unverified'
    }
}
