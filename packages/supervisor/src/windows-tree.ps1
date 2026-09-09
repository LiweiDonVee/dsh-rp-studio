$ErrorActionPreference = 'Stop'
$request = [Console]::ReadLine() | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Runtime.InteropServices;
public static class SupervisorJob {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct Startup {
    public int cb; public string reserved, desktop, title;
    public int x, y, xSize, ySize, xChars, yChars, fill, flags;
    public short show, reservedSize; public IntPtr reservedPtr, input, output, error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process, thread; public int pid, tid; }
  [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
    public long processTime, jobTime; public uint flags; public UIntPtr min, max;
    public uint active; public UIntPtr affinity; public uint priority, scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit {
    public BasicLimit basic; public IoCounters io; public UIntPtr processMemory, jobMemory, peakProcess, peakJob;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long user, kernel, periodUser, periodKernel;
    public uint faults, total, active, terminated;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attr, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimit info, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, uint size, IntPtr length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref Startup startup, out ProcessInfo info);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
  static string Quote(string text) {
    var result = new StringBuilder("\""); int slashes = 0;
    foreach (char c in text) {
      if (c == '\\') { slashes++; continue; }
      if (c == '"') { result.Append('\\', slashes * 2 + 1); result.Append(c); slashes = 0; continue; }
      result.Append('\\', slashes); slashes = 0; result.Append(c);
    }
    result.Append('\\', slashes * 2); result.Append('"'); return result.ToString();
  }
  public static int Run(string executable, string[] args) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Exception("Cannot create supervisor job.");
    ProcessInfo process = new ProcessInfo(); bool assigned = false;
    try {
      var limits = new ExtendedLimit(); limits.basic.flags = 0x2000;
      if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits))) throw new Exception("Cannot configure supervisor job.");
      var startup = new Startup(); startup.cb = Marshal.SizeOf(startup); startup.flags = 0x100;
      startup.input = IntPtr.Zero; startup.output = GetStdHandle(-11); startup.error = GetStdHandle(-12);
      SetHandleInformation(startup.output, 1, 1); SetHandleInformation(startup.error, 1, 1);
      var cmd = new StringBuilder(Quote(executable)); foreach (string arg in args) cmd.Append(" ").Append(Quote(arg));
      if (!CreateProcess(executable, cmd, IntPtr.Zero, IntPtr.Zero, true, 0x08000004, IntPtr.Zero, null, ref startup, out process)) throw new Exception("Cannot create supervised runtime.");
      if (!AssignProcessToJobObject(job, process.process)) throw new Exception("Cannot contain supervised runtime.");
      assigned = true;
      if (ResumeThread(process.thread) == 0xffffffff) throw new Exception("Cannot resume supervised runtime.");
      var control = Task.Run(() => Console.ReadLine());
      while (WaitForSingleObject(process.process, 25) == 258 && !control.IsCompleted) {}
      uint code; GetExitCodeProcess(process.process, out code);
      if (!TerminateJobObject(job, 1)) throw new Exception("Cannot stop supervised job.");
      var deadline = DateTime.UtcNow.AddSeconds(10);
      for (;;) {
        Accounting accounting;
        if (!QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero)) throw new Exception("Cannot verify supervised job exit.");
        if (accounting.active == 0) break;
        if (DateTime.UtcNow > deadline) throw new Exception("Supervised job did not exit.");
        Thread.Sleep(10);
      }
      return control.IsCompleted ? 0 : (int)code;
    } finally {
      if (!assigned && process.process != IntPtr.Zero) TerminateProcess(process.process, 1);
      if (process.thread != IntPtr.Zero) CloseHandle(process.thread);
      if (process.process != IntPtr.Zero) CloseHandle(process.process);
      CloseHandle(job);
    }
  }
}
'@
try { exit [SupervisorJob]::Run($request.executable, [string[]]$request.args) }
catch { [Console]::Error.WriteLine('Supervised process containment failed.'); exit 1 }
