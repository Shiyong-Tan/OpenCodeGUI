// Windows OS primitive for OpenCodeServerProcess. One bounded request per process.
// No background manager, task scheduler, port scanning, or process-name matching.
using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

class ServiceJob {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup { public int cb; public string reserved,desktop,title; public uint x,y,xSize,ySize,xChars,yChars,fill,flags; public short show,reservedSize; public IntPtr reservedPtr,stdin,stdout,stderr; }
  [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup startup; public IntPtr attributes; }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process,thread; public uint pid,tid; }
  [StructLayout(LayoutKind.Sequential)] struct Security { public int length; public IntPtr descriptor; public int inherit; }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr sa,string name);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr OpenJobObject(uint access,bool inherit,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool member);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out long created,out long exit,out long kernel,out long user);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int type,IntPtr data,uint size,out uint returned);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool DuplicateHandle(IntPtr sourceProcess,IntPtr source,IntPtr targetProcess,out IntPtr target,uint access,bool inherit,uint flags);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint ms);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,uint flags,ref IntPtr size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr processSecurity,IntPtr threadSecurity,bool inherit,uint flags,IntPtr env,string cwd,ref StartupEx startup,out ProcessInfo info);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFile(string name,uint access,uint share,ref Security security,uint disposition,uint flags,IntPtr template);
  static readonly JavaScriptSerializer Json=new JavaScriptSerializer {MaxJsonLength=32768};
  static IntPtr pendingJob=IntPtr.Zero;
  static bool committed;
  static readonly object Gate=new object();
  static void Check(bool ok) { if(!ok)throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static void Emit(object value) { Console.WriteLine(Json.Serialize(value));Console.Out.Flush(); }
  static Dictionary<string,object> Read() { string line=Console.ReadLine();if(line==null||line.Length>32768)throw new InvalidOperationException("input");return Json.Deserialize<Dictionary<string,object>>(line); }
  static string Text(Dictionary<string,object> req,string key) { var value=req[key] as string;if(String.IsNullOrEmpty(value)||value.Length>8192)throw new InvalidOperationException("field");return value; }
  static string Identity(Dictionary<string,object> req,string key) { string value=Text(req,key);if(value.Length!=64||!System.Text.RegularExpressions.Regex.IsMatch(value,"^[a-f0-9]{64}$"))throw new InvalidOperationException("identity");return value; }
  static string JobName(Dictionary<string,object> req) { return "Local\\OpenCodeGUI.Service."+Identity(req,"serviceId"); }
  static long Created(IntPtr process) { long c,e,k,u;Check(GetProcessTimes(process,out c,out e,out k,out u));return c; }
  static string Quote(string text) { var b=new StringBuilder("\"");int slashes=0;foreach(char c in text){if(c=='\\'){slashes++;continue;}b.Append('\\',c=='"'?slashes*2+1:slashes);b.Append(c);slashes=0;}b.Append('\\',slashes*2);return b.Append('"').ToString(); }
  static uint Active(IntPtr job) {
    IntPtr data=Marshal.AllocHGlobal(48);
    try {uint returned;Check(QueryInformationJobObject(job,1,data,48,out returned));return unchecked((uint)Marshal.ReadInt32(data,40));}
    finally {Marshal.FreeHGlobal(data);}
  }
  static void Start(Dictionary<string,object> req) {
    string serviceId=Identity(req,"serviceId");
    IntPtr job=CreateJobObject(IntPtr.Zero,JobName(req));Check(job!=IntPtr.Zero);
    if(Marshal.GetLastWin32Error()==183){CloseHandle(job);throw new InvalidOperationException("job_exists");}
    lock(Gate){pendingJob=job;}
    IntPtr list=IntPtr.Zero,jobs=IntPtr.Zero,handles=IntPtr.Zero,input=IntPtr.Zero,output=IntPtr.Zero;
    ProcessInfo pi=new ProcessInfo();bool initialized=false;
    try {
      var sa=new Security {length=Marshal.SizeOf(typeof(Security)),inherit=1};
      input=CreateFile("NUL",0x80000000,3,ref sa,3,0,IntPtr.Zero);Check(input!=new IntPtr(-1));
      output=CreateFile("NUL",0x40000000,3,ref sa,3,0,IntPtr.Zero);Check(output!=new IntPtr(-1));
      IntPtr size=IntPtr.Zero;InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref size);list=Marshal.AllocHGlobal(size);
      Check(InitializeProcThreadAttributeList(list,2,0,ref size));initialized=true;
      jobs=Marshal.AllocHGlobal(IntPtr.Size);Marshal.WriteIntPtr(jobs,job);
      Check(UpdateProcThreadAttribute(list,0,new IntPtr(0x2000D),jobs,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero));
      handles=Marshal.AllocHGlobal(IntPtr.Size*2);Marshal.WriteIntPtr(handles,0,input);Marshal.WriteIntPtr(handles,IntPtr.Size,output);
      Check(UpdateProcThreadAttribute(list,0,new IntPtr(0x20002),handles,new IntPtr(IntPtr.Size*2),IntPtr.Zero,IntPtr.Zero));
      var si=new StartupEx();si.startup.cb=Marshal.SizeOf(typeof(StartupEx));si.startup.flags=0x100;si.startup.stdin=input;si.startup.stdout=output;si.startup.stderr=output;si.attributes=list;
      string executable=Path.GetFullPath(Text(req,"executable"));var command=new StringBuilder(Quote(executable));
      foreach(object arg in (IEnumerable)req["args"])command.Append(' ').Append(Quote((string)arg));
      Check(CreateProcess(executable,command,IntPtr.Zero,IntPtr.Zero,true,0x80000|0x08000000|4,IntPtr.Zero,Path.GetFullPath(Text(req,"cwd")),ref si,out pi));
      bool member;Check(IsProcessInJob(pi.process,job,out member));if(!member)throw new InvalidOperationException("membership");
      long created=Created(pi.process);IntPtr remote;
      Check(DuplicateHandle(GetCurrentProcess(),job,pi.process,out remote,0,false,2));
      Emit(new {ok=true,stage="prepared",serviceId,pid=pi.pid,creationFileTime=created.ToString()});
      var ack=Read();if(Text(ack,"op")!="commit"||Identity(ack,"serviceId")!=serviceId)throw new InvalidOperationException("commit");
      lock(Gate){Check(ResumeThread(pi.thread)!=uint.MaxValue);committed=true;}
      Emit(new {ok=true,stage="running",serviceId,pid=pi.pid,creationFileTime=created.ToString()});
    } finally {
      lock(Gate){if(!committed)TerminateJobObject(job,1223);pendingJob=IntPtr.Zero;}
      if(pi.thread!=IntPtr.Zero)CloseHandle(pi.thread);if(pi.process!=IntPtr.Zero)CloseHandle(pi.process);
      foreach(var h in new[]{input,output})if(h!=IntPtr.Zero&&h!=new IntPtr(-1))CloseHandle(h);
      if(initialized)DeleteProcThreadAttributeList(list);if(list!=IntPtr.Zero)Marshal.FreeHGlobal(list);if(jobs!=IntPtr.Zero)Marshal.FreeHGlobal(jobs);if(handles!=IntPtr.Zero)Marshal.FreeHGlobal(handles);
      CloseHandle(job);
    }
  }
  static void Inspect(Dictionary<string,object> req,bool stop) {
    uint pid=Convert.ToUInt32(req["pid"]);long created=Int64.Parse(Text(req,"creationFileTime"));
    IntPtr job=OpenJobObject(4|(stop?8u:0u),false,JobName(req));int jobError=Marshal.GetLastWin32Error();
    IntPtr process=OpenProcess(0x1000|0x100000,false,pid);int processError=Marshal.GetLastWin32Error();
    try {
      bool rootEnded=process==IntPtr.Zero?processError==87:Created(process)!=created||WaitForSingleObject(process,0)==0;
      if(job==IntPtr.Zero){if(jobError==2&&rootEnded){Emit(new{ok=true,state="stopped",rootExited=true,activeProcesses=0});return;}throw new InvalidOperationException("identity_unknown");}
      uint active=Active(job);
      if(rootEnded&&active==0){Emit(new{ok=true,state="stopped",rootExited=true,activeProcesses=0});return;}
      if(process==IntPtr.Zero||Created(process)!=created)throw new InvalidOperationException("root_identity_unknown");
      bool member;Check(IsProcessInJob(process,job,out member));if(!member)throw new InvalidOperationException("membership");
      if(!stop){Emit(new{ok=true,state=rootEnded?"root_exited_members_active":"running",rootExited=rootEnded,activeProcesses=active});return;}
      Check(TerminateJobObject(job,1223));
      var watch=System.Diagnostics.Stopwatch.StartNew();
      do {active=Active(job);rootEnded=WaitForSingleObject(process,0)==0;if(active==0&&rootEnded)break;Thread.Sleep(25);} while(watch.ElapsedMilliseconds<5000);
      Emit(new{ok=true,state=active==0&&rootEnded?"stopped":"stop_unknown",rootExited=rootEnded,activeProcesses=active});
    } finally {if(process!=IntPtr.Zero)CloseHandle(process);if(job!=IntPtr.Zero)CloseHandle(job);}
  }
  static void MutexLease(Dictionary<string,object> req) {
    using(var mutex=new Mutex(false,"Local\\OpenCodeGUI.Operation."+Identity(req,"workspaceKey"))) {
      bool owned=false;try {try{owned=mutex.WaitOne(2000);}catch(AbandonedMutexException){owned=true;}
        if(!owned){Emit(new{ok=false,error="operation_busy"});return;}
        Emit(new{ok=true,stage="locked"});Read();
      } finally {if(owned)mutex.ReleaseMutex();}
    }
  }
  public static int Main() {
    // The deadline bounds a single primitive, including a GUI dying before commit.
    using(var deadline=new Timer(_=>{lock(Gate){if(pendingJob!=IntPtr.Zero&&!committed)TerminateJobObject(pendingJob,1223);}Environment.Exit(72);},null,60000,Timeout.Infinite)) {
      try {var req=Read();string op=Text(req,"op");if(op=="start")Start(req);else if(op=="inspect"||op=="stop")Inspect(req,op=="stop");else if(op=="lock")MutexLease(req);else throw new InvalidOperationException("operation");return 0;}
      catch(Exception e){Emit(new{ok=false,error=e is Win32Exception?"os_operation_failed":"identity_or_protocol_rejected",nativeCode=e is Win32Exception?((Win32Exception)e).NativeErrorCode:0});return 1;}
    }
  }
}
