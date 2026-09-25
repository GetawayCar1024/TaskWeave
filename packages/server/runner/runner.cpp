// PolyForge runner: runs one program (or a solution + interactor pair) under Windows
// Job Objects and prints the result as JSON on stdout.
//
// The spec is read from stdin as UTF-8 `key=value` lines. Keys before any section apply
// to the program (or the solution in interactive mode); keys after `[interactor]` apply
// to the interactor. In interactive mode the solution's stdout is piped to the
// interactor's stdin and vice versa, so `stdin`/`stdout` are ignored for both.
//
//   cmd=<full command line>         required
//   cwd=<directory>
//   stdin=<file> stdout=<file> stderr=<file>   (default: NUL)
//   time_limit=<ms>                 CPU time limit, 0 = none
//   wall_limit=<ms>                 wall clock limit, 0 = none
//   memory_limit=<bytes>            per-process committed memory limit, 0 = none
//   output_limit=<bytes>            maximum size of the stdout file, 0 = none
//   process_limit=<n>               active processes in the job (default 1)
//   tsc_hz=<n>                      TSC frequency from `runner --calibrate` (measured if absent)
//
// CPU time comes from QueryProcessCycleTime / TSC frequency: the tick-sampled times of
// GetProcessTimes under-report a busy loop by 3-5x on modern (hybrid, tickless) CPUs.
//
// Result per process:
//   {"status":"OK|RE|TL|ML|OL|IE","exit_code":N,"time_ms":N,"wall_ms":N,"memory_kb":N,
//    "idle":bool,"error":"..."}
// Interactive: {"solution":{...},"interactor":{...}}

#ifndef UNICODE
#define UNICODE
#endif
#include <windows.h>
#include <intrin.h>

#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

namespace {

struct Spec {
  std::wstring cmd, cwd, in, out, err;
  long long timeLimit = 0, wallLimit = 0, memoryLimit = 0, outputLimit = 0;
  long long processLimit = 1;
  double tscHz = 0;
};

struct Result {
  std::string status = "IE";
  unsigned long exitCode = 0;
  long long timeMs = 0, wallMs = 0, memoryKb = 0;
  bool idle = false;
  std::string error;
};

struct Proc {
  Spec spec;
  Result res;
  HANDLE job = nullptr, process = nullptr, thread = nullptr, port = nullptr, outFile = nullptr;
  LARGE_INTEGER start{};
  bool running = false;
  bool killedTL = false, killedOL = false;
};

LARGE_INTEGER freq;

std::wstring widen(const std::string& s) {
  if (s.empty()) return {};
  int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0);
  std::wstring w(n, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), &w[0], n);
  return w;
}

std::string narrow(const std::wstring& w) {
  if (w.empty()) return {};
  int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), nullptr, 0, nullptr, nullptr);
  std::string s(n, '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), &s[0], n, nullptr, nullptr);
  return s;
}

std::string lastError(const char* what) {
  DWORD code = GetLastError();
  wchar_t* buf = nullptr;
  FormatMessageW(FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS, nullptr,
                 code, MAKELANGID(LANG_ENGLISH, SUBLANG_ENGLISH_US), (LPWSTR)&buf, 0, nullptr);
  std::string msg = std::string(what) + ": " + (buf ? narrow(buf) : std::to_string(code));
  if (buf) LocalFree(buf);
  while (!msg.empty() && (msg.back() == '\n' || msg.back() == '\r' || msg.back() == ' ')) msg.pop_back();
  return msg;
}

std::string jsonEscape(const std::string& s) {
  std::string o;
  for (unsigned char c : s) {
    if (c == '"' || c == '\\') {
      o += '\\';
      o += (char)c;
    } else if (c < 0x20) {
      char b[8];
      std::snprintf(b, sizeof b, "\\u%04x", c);
      o += b;
    } else {
      o += (char)c;
    }
  }
  return o;
}

std::string toJson(const Result& r) {
  char buf[256];
  std::snprintf(buf, sizeof buf, "\"exit_code\":%lu,\"time_ms\":%lld,\"wall_ms\":%lld,\"memory_kb\":%lld,\"idle\":%s",
                r.exitCode, r.timeMs, r.wallMs, r.memoryKb, r.idle ? "true" : "false");
  return "{\"status\":\"" + r.status + "\"," + buf + ",\"error\":\"" + jsonEscape(r.error) + "\"}";
}

bool parseSpec(const std::string& text, Spec& sol, Spec& inter, bool& interactive) {
  Spec* cur = &sol;
  size_t pos = 0;
  while (pos < text.size()) {
    size_t eol = text.find('\n', pos);
    if (eol == std::string::npos) eol = text.size();
    std::string line = text.substr(pos, eol - pos);
    pos = eol + 1;
    if (!line.empty() && line.back() == '\r') line.pop_back();
    if (line.empty()) continue;
    if (line == "[interactor]") {
      interactive = true;
      cur = &inter;
      continue;
    }
    size_t eq = line.find('=');
    if (eq == std::string::npos) continue;
    std::string k = line.substr(0, eq), v = line.substr(eq + 1);
    if (k == "cmd") cur->cmd = widen(v);
    else if (k == "cwd") cur->cwd = widen(v);
    else if (k == "stdin") cur->in = widen(v);
    else if (k == "stdout") cur->out = widen(v);
    else if (k == "stderr") cur->err = widen(v);
    else if (k == "time_limit") cur->timeLimit = std::atoll(v.c_str());
    else if (k == "wall_limit") cur->wallLimit = std::atoll(v.c_str());
    else if (k == "memory_limit") cur->memoryLimit = std::atoll(v.c_str());
    else if (k == "output_limit") cur->outputLimit = std::atoll(v.c_str());
    else if (k == "process_limit") cur->processLimit = std::atoll(v.c_str());
    else if (k == "tsc_hz") sol.tscHz = inter.tscHz = std::atof(v.c_str());
  }
  return !sol.cmd.empty() && (!interactive || !inter.cmd.empty());
}

HANDLE openFile(const std::wstring& path, bool write) {
  SECURITY_ATTRIBUTES sa{sizeof sa, nullptr, TRUE};
  const wchar_t* p = path.empty() ? L"NUL" : path.c_str();
  if (write) return CreateFileW(p, GENERIC_WRITE, FILE_SHARE_READ, &sa, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  return CreateFileW(p, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
}

long long elapsedMs(const LARGE_INTEGER& start) {
  LARGE_INTEGER now;
  QueryPerformanceCounter(&now);
  return (now.QuadPart - start.QuadPart) * 1000 / freq.QuadPart;
}

double calibrateTsc(DWORD ms) {
  LARGE_INTEGER a, b;
  QueryPerformanceCounter(&a);
  unsigned long long t0 = __rdtsc();
  Sleep(ms);
  QueryPerformanceCounter(&b);
  unsigned long long t1 = __rdtsc();
  return (double)(t1 - t0) * (double)freq.QuadPart / (double)(b.QuadPart - a.QuadPart);
}

double tscHz = 0;

long long cpuMs(HANDLE process) {
  ULONG64 cycles = 0;
  if (!QueryProcessCycleTime(process, &cycles)) return 0;
  return (long long)((double)cycles / tscHz * 1000.0);
}

// Create `p` suspended with the given std handles. Only these handles are inherited,
// which matters for pipes: a stray inherited write end would keep the reader from ever
// seeing EOF. The process runs (and its clock starts) only in resume(), because
// CreateProcess itself can take seconds when an antivirus scans a new executable.
bool create(Proc& p, HANDLE hin, HANDLE hout, HANDLE herr) {
  p.job = CreateJobObjectW(nullptr, nullptr);
  if (!p.job) {
    p.res.error = lastError("CreateJobObject");
    return false;
  }
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION li{};
  li.BasicLimitInformation.LimitFlags =
      JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
  li.BasicLimitInformation.ActiveProcessLimit = (DWORD)(p.spec.processLimit > 0 ? p.spec.processLimit : 1);
  if (p.spec.memoryLimit > 0) {
    li.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_PROCESS_MEMORY;
    li.ProcessMemoryLimit = (SIZE_T)p.spec.memoryLimit;
  }
  if (!SetInformationJobObject(p.job, JobObjectExtendedLimitInformation, &li, sizeof li)) {
    p.res.error = lastError("SetInformationJobObject");
    return false;
  }
  // Completion port receives JOB_OBJECT_MSG_PROCESS_MEMORY_LIMIT, which also catches
  // allocations that were refused (the peak alone would stay below the limit).
  p.port = CreateIoCompletionPort(INVALID_HANDLE_VALUE, nullptr, 0, 1);
  if (p.port) {
    JOBOBJECT_ASSOCIATE_COMPLETION_PORT acp{p.job, p.port};
    SetInformationJobObject(p.job, JobObjectAssociateCompletionPortInformation, &acp, sizeof acp);
  }

  HANDLE list[3];
  int n = 0;
  for (HANDLE h : {hin, hout, herr}) {
    bool dup = false;
    for (int i = 0; i < n; i++) dup |= list[i] == h;
    if (!dup) list[n++] = h;
  }
  SIZE_T size = 0;
  InitializeProcThreadAttributeList(nullptr, 1, 0, &size);
  std::vector<char> attrBuf(size);
  auto attrs = (LPPROC_THREAD_ATTRIBUTE_LIST)attrBuf.data();
  if (!InitializeProcThreadAttributeList(attrs, 1, 0, &size) ||
      !UpdateProcThreadAttribute(attrs, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, list, n * sizeof(HANDLE), nullptr, nullptr)) {
    p.res.error = lastError("ProcThreadAttributeList");
    return false;
  }

  STARTUPINFOEXW si{};
  si.StartupInfo.cb = sizeof si;
  si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  si.StartupInfo.hStdInput = hin;
  si.StartupInfo.hStdOutput = hout;
  si.StartupInfo.hStdError = herr;
  si.lpAttributeList = attrs;

  PROCESS_INFORMATION pi{};
  std::vector<wchar_t> cmd(p.spec.cmd.begin(), p.spec.cmd.end());
  cmd.push_back(L'\0');
  BOOL ok = CreateProcessW(nullptr, cmd.data(), nullptr, nullptr, TRUE,
                           CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT, nullptr,
                           p.spec.cwd.empty() ? nullptr : p.spec.cwd.c_str(), &si.StartupInfo, &pi);
  DeleteProcThreadAttributeList(attrs);
  if (!ok) {
    p.res.error = lastError("CreateProcess");
    return false;
  }
  if (!AssignProcessToJobObject(p.job, pi.hProcess)) {
    p.res.error = lastError("AssignProcessToJobObject");
    TerminateProcess(pi.hProcess, 1);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    return false;
  }
  p.process = pi.hProcess;
  p.thread = pi.hThread;
  return true;
}

void finish(Proc& p);

void resume(Proc& p) {
  QueryPerformanceCounter(&p.start);
  p.running = true;
  ResumeThread(p.thread);
  CloseHandle(p.thread);
  p.thread = nullptr;
}

// Kill a created-but-unresumed or running process and record the result.
void abandon(Proc& p) {
  if (!p.process) return;
  if (!p.running) {
    QueryPerformanceCounter(&p.start);
    p.running = true;
  }
  TerminateJobObject(p.job, 1);
  WaitForSingleObject(p.process, 1000);
  finish(p);
  if (p.res.status == "RE") p.res.status = "IE";
}

void finish(Proc& p) {
  p.running = false;
  p.res.wallMs = elapsedMs(p.start);
  GetExitCodeProcess(p.process, &p.res.exitCode);
  // Kill anything the process may have left behind in its job.
  TerminateJobObject(p.job, 1);
  p.res.timeMs = cpuMs(p.process);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION li{};
  if (QueryInformationJobObject(p.job, JobObjectExtendedLimitInformation, &li, sizeof li, nullptr)) {
    p.res.memoryKb = (long long)(li.PeakProcessMemoryUsed / 1024);
  }
  bool memHit = false;
  if (p.port) {
    DWORD msg;
    ULONG_PTR key;
    LPOVERLAPPED ov;
    while (GetQueuedCompletionStatus(p.port, &msg, &key, &ov, 0)) {
      if (msg == JOB_OBJECT_MSG_PROCESS_MEMORY_LIMIT || msg == JOB_OBJECT_MSG_JOB_MEMORY_LIMIT) memHit = true;
    }
  }
  if (p.spec.memoryLimit > 0 && p.res.memoryKb * 1024 > p.spec.memoryLimit) memHit = true;

  if (p.killedTL) p.res.status = "TL";
  else if (p.killedOL) p.res.status = "OL";
  else if (memHit) p.res.status = "ML";
  else if (p.res.exitCode != 0) p.res.status = "RE";
  else p.res.status = "OK";
  if (p.killedTL && p.spec.timeLimit > 0 && p.res.timeMs < p.spec.timeLimit) p.res.idle = true;
}

// Kill the process tree if it exceeds its time or output limit.
void checkLimits(Proc& p) {
  long long cpu = cpuMs(p.process);
  long long wall = elapsedMs(p.start);
  if ((p.spec.timeLimit > 0 && cpu > p.spec.timeLimit) || (p.spec.wallLimit > 0 && wall > p.spec.wallLimit)) {
    p.killedTL = true;
    TerminateJobObject(p.job, 1);
    return;
  }
  if (p.spec.outputLimit > 0 && p.outFile) {
    LARGE_INTEGER sz;
    if (GetFileSizeEx(p.outFile, &sz) && sz.QuadPart > p.spec.outputLimit) {
      p.killedOL = true;
      TerminateJobObject(p.job, 1);
    }
  }
}

void runAll(std::vector<Proc*> procs) {
  for (;;) {
    std::vector<HANDLE> hs;
    for (Proc* p : procs)
      if (p->running) hs.push_back(p->process);
    if (hs.empty()) break;
    WaitForMultipleObjects((DWORD)hs.size(), hs.data(), FALSE, 10);
    for (Proc* p : procs) {
      if (!p->running) continue;
      if (WaitForSingleObject(p->process, 0) == WAIT_OBJECT_0) finish(*p);
      else checkLimits(*p);
    }
  }
}

}  // namespace

int main(int argc, char** argv) {
  SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
  QueryPerformanceFrequency(&freq);
  if (argc > 1 && std::string(argv[1]) == "--calibrate") {
    std::printf("%.0f\n", calibrateTsc(300));
    return 0;
  }

  std::string text;
  char buf[4096];
  size_t n;
  while ((n = std::fread(buf, 1, sizeof buf, stdin)) > 0) text.append(buf, n);

  Proc sol, inter;
  bool interactive = false;
  if (!parseSpec(text, sol.spec, inter.spec, interactive)) {
    std::printf("{\"status\":\"IE\",\"exit_code\":0,\"time_ms\":0,\"wall_ms\":0,\"memory_kb\":0,\"idle\":false,"
                "\"error\":\"invalid spec\"}\n");
    return 2;
  }
  tscHz = sol.spec.tscHz > 0 ? sol.spec.tscHz : calibrateTsc(20);

  if (!interactive) {
    HANDLE hin = openFile(sol.spec.in, false);
    if (hin == INVALID_HANDLE_VALUE) sol.res.error = lastError(("open stdin " + narrow(sol.spec.in)).c_str());
    HANDLE hout = openFile(sol.spec.out, true);
    if (hout == INVALID_HANDLE_VALUE) sol.res.error = lastError(("open stdout " + narrow(sol.spec.out)).c_str());
    HANDLE herr = openFile(sol.spec.err, true);
    if (herr == INVALID_HANDLE_VALUE) sol.res.error = lastError(("open stderr " + narrow(sol.spec.err)).c_str());
    if (sol.res.error.empty()) {
      sol.outFile = hout;
      if (create(sol, hin, hout, herr)) {
        resume(sol);
        runAll({&sol});
      }
    }
    std::printf("%s\n", toJson(sol.res).c_str());
    return 0;
  }

  // Interactive: solution.stdout -> interactor.stdin, interactor.stdout -> solution.stdin.
  SECURITY_ATTRIBUTES sa{sizeof sa, nullptr, TRUE};
  HANDLE s2iRead, s2iWrite, i2sRead, i2sWrite;
  if (!CreatePipe(&s2iRead, &s2iWrite, &sa, 1 << 16) || !CreatePipe(&i2sRead, &i2sWrite, &sa, 1 << 16)) {
    sol.res.error = inter.res.error = lastError("CreatePipe");
  } else {
    HANDLE solErr = openFile(sol.spec.err, true);
    HANDLE intErr = openFile(inter.spec.err, true);
    bool ok = create(inter, s2iRead, i2sWrite, intErr) && create(sol, i2sRead, s2iWrite, solErr);
    // Close our copies so each side sees EOF when the other exits.
    CloseHandle(s2iRead);
    CloseHandle(s2iWrite);
    CloseHandle(i2sRead);
    CloseHandle(i2sWrite);
    if (ok) {
      resume(inter);
      resume(sol);
      runAll({&sol, &inter});
    } else {
      abandon(inter);
      abandon(sol);
    }
  }
  std::printf("{\"solution\":%s,\"interactor\":%s}\n", toJson(sol.res).c_str(), toJson(inter.res).c_str());
  return 0;
}
