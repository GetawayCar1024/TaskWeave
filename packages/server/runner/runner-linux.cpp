// TaskWeave Linux runner. Same result contract as runner.cpp; argv is transported
// as repeated arg= lines and passed directly to execvp, without a shell.
// CPU and resident-memory accounting cover the observed process tree. Limits are
// checked every 5 ms; rlimits additionally bound CPU seconds and regular-file output.
// bubblewrap supplies per-process filesystem, network, IPC and PID namespaces.
// Sandbox setup failures are errors, never an unsandboxed fallback.

#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <dirent.h>
#include <fcntl.h>
#include <signal.h>
#include <unistd.h>
#include <sys/syscall.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <sched.h>
#include <cstddef>

#include <algorithm>
#include <cerrno>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <map>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

namespace {
using Clock = std::chrono::steady_clock;
volatile sig_atomic_t interrupted = 0;
void stop(int) { interrupted = 1; }

struct Spec {
  std::vector<std::string> argv;
  std::vector<std::string> readPaths, writePaths, runtimes, environment;
  std::string cwd, in, out, err;
  long long timeLimit = 0, wallLimit = 0, memoryLimit = 0, outputLimit = 0;
  long long processLimit = 1;
};
struct Result {
  std::string status = "IE", error;
  int exitCode = 0;
  long long timeMs = 0, wallMs = 0, memoryKb = 0;
  bool idle = false;
};
struct Proc {
  Spec spec;
  Result res;
  pid_t pid = -1;
  int gate = -1, errors = -1, output = -1, sandboxInfo = -1;
  pid_t sandboxPid = -1;
  std::string sandboxReport;
  std::map<pid_t, unsigned long long> members;
  std::map<pid_t, long long> cpuTicks;
  std::map<pid_t, long long> overheadTicks;
  std::string killed;
  Clock::time_point start;
  bool running = false;
};
void closeFd(int& fd) { if (fd >= 0) close(fd); fd = -1; }
long long elapsed(const Proc& p) { return std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - p.start).count(); }
std::string error(const char* what) { return std::string(what) + ": " + std::strerror(errno); }

std::string jsonEscape(const std::string& value) {
  std::string out;
  for (unsigned char c : value) {
    if (c == '"' || c == '\\') { out += '\\'; out += static_cast<char>(c); }
    else if (c < 32) { char escaped[8]; std::snprintf(escaped, sizeof escaped, "\\u%04x", c); out += escaped; }
    else out += static_cast<char>(c);
  }
  return out;
}
std::string toJson(const Result& r) {
  return "{\"status\":\"" + r.status + "\",\"exit_code\":" + std::to_string(r.exitCode) +
    ",\"time_ms\":" + std::to_string(r.timeMs) + ",\"wall_ms\":" + std::to_string(r.wallMs) +
    ",\"memory_kb\":" + std::to_string(r.memoryKb) + ",\"idle\":" + (r.idle ? "true" : "false") +
    ",\"error\":\"" + jsonEscape(r.error) + "\"}";
}
bool parseSpec(const std::string& text, Spec& sol, Spec& inter, bool& interactive) {
  Spec* current = &sol;
  std::istringstream stream(text);
  std::string line;
  while (std::getline(stream, line)) {
    if (line == "[interactor]") { interactive = true; current = &inter; continue; }
    const auto at = line.find('=');
    if (at == std::string::npos) continue;
    const auto key = line.substr(0, at), value = line.substr(at + 1);
    if (key == "arg") current->argv.push_back(value);
    else if (key == "cwd") current->cwd = value;
    else if (key == "stdin") current->in = value;
    else if (key == "stdout") current->out = value;
    else if (key == "stderr") current->err = value;
    else if (key == "read") current->readPaths.push_back(value);
    else if (key == "write") current->writePaths.push_back(value);
    else if (key == "runtime") current->runtimes.push_back(value);
    else if (key == "env") current->environment.push_back(value);
    else if (key == "time_limit") current->timeLimit = std::atoll(value.c_str());
    else if (key == "wall_limit") current->wallLimit = std::atoll(value.c_str());
    else if (key == "memory_limit") current->memoryLimit = std::atoll(value.c_str());
    else if (key == "output_limit") current->outputLimit = std::atoll(value.c_str());
    else if (key == "process_limit") current->processLimit = std::atoll(value.c_str());
  }
  return !sol.argv.empty() && !sol.argv[0].empty() && (!interactive || (!inter.argv.empty() && !inter.argv[0].empty()));
}
int openFile(const std::string& file, bool write) {
  return open(file.empty() ? "/dev/null" : file.c_str(), O_CLOEXEC | (write ? O_WRONLY | O_CREAT | O_TRUNC : O_RDONLY), 0600);
}

struct Usage {
  unsigned long long started = 0;
  long long ticks = 0, memoryKb = 0;
};
bool usage(pid_t pid, Usage& out) {
  std::ifstream stat("/proc/" + std::to_string(pid) + "/stat");
  std::string line;
  if (!std::getline(stat, line)) return false;
  const auto at = line.rfind(')');
  if (at == std::string::npos) return false;
  std::istringstream fields(line.substr(at + 2));
  std::vector<std::string> values;
  for (std::string value; fields >> value;) values.push_back(value);
  if (values.size() < 22) return false;
  // Retain each process's own CPU after exit; adding waited-child CPU here
  // would double-count it while the child is still a visible zombie.
  for (int index : {11, 12}) out.ticks += std::atoll(values[index].c_str());
  out.started = std::strtoull(values[19].c_str(), nullptr, 10);
  out.memoryKb = std::max(0LL, std::atoll(values[21].c_str())) * sysconf(_SC_PAGESIZE) / 1024;
  return true;
}
void discover(Proc& p, pid_t pid) {
  DIR* tasks = opendir(("/proc/" + std::to_string(pid) + "/task").c_str());
  if (!tasks) return;
  while (auto* entry = readdir(tasks)) {
    if (entry->d_name[0] == '.') continue;
    std::ifstream children("/proc/" + std::to_string(pid) + "/task/" + entry->d_name + "/children");
    for (pid_t child; children >> child;) {
      if (p.members.count(child)) continue;
      Usage found;
      if (usage(child, found)) { p.members[child] = found.started; discover(p, child); }
    }
  }
  closedir(tasks);
}
void killTree(Proc& p) {
  if (p.pid <= 0) return;
  // Keep the root unreaped while killing its process group, so its PID cannot be reused.
  kill(-p.pid, SIGKILL);
  for (const auto& [pid, started] : p.members) {
    Usage now;
    if (usage(pid, now) && now.started == started) kill(pid, SIGKILL);
  }
}

[[noreturn]] void childError(int fd, const char* what) {
  const std::string message = error(what);
  const auto ignored = write(fd, message.data(), message.size()); (void)ignored;
  _exit(127);
}

int sandboxFilter(long long processLimit) {
#ifndef __x86_64__
  errno = ENOTSUP; return -1;
#else
  std::vector<sock_filter> rules;
  const auto statement = [&](unsigned short code, unsigned int value) { rules.push_back({code, 0, 0, value}); };
  const auto jump = [&](unsigned short code, unsigned int value, unsigned char yes, unsigned char no) { rules.push_back({code, yes, no, value}); };
  statement(BPF_LD | BPF_W | BPF_ABS, offsetof(seccomp_data, arch));
  jump(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0);
  statement(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS);
  statement(BPF_LD | BPF_W | BPF_ABS, offsetof(seccomp_data, nr));
  jump(BPF_JMP | BPF_JGE | BPF_K, 0x40000000, 0, 1); // Reject x32, not just int 0x80.
  statement(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS);
  const auto deny = [&](unsigned int call, int err = EPERM) {
    jump(BPF_JMP | BPF_JEQ | BPF_K, call, 0, 1);
    statement(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | static_cast<unsigned int>(err));
  };
  for (unsigned int call : {SYS_socket, SYS_ptrace, SYS_process_vm_readv, SYS_process_vm_writev,
       SYS_unshare, SYS_setns, SYS_mount, SYS_umount2, SYS_pivot_root, SYS_chroot,
       SYS_keyctl, SYS_add_key, SYS_request_key, SYS_perf_event_open, SYS_bpf,
       SYS_open_by_handle_at, SYS_userfaultfd, SYS_kexec_load}) deny(call);
  // clone3 / io_uring have extensible pointer arguments which a cBPF filter
  // cannot inspect. ENOSYS makes libc use the inspectable clone fallback.
  deny(435, ENOSYS); // clone3
  deny(425, ENOSYS); deny(426, ENOSYS); deny(427, ENOSYS); // io_uring
  jump(BPF_JMP | BPF_JEQ | BPF_K, SYS_clone, 0, processLimit <= 1 ? 5 : 3);
  statement(BPF_LD | BPF_W | BPF_ABS, offsetof(seccomp_data, args[0]));
  jump(BPF_JMP | BPF_JSET | BPF_K, CLONE_NEWUSER | CLONE_NEWNS | CLONE_NEWPID | CLONE_NEWNET | CLONE_NEWIPC | CLONE_NEWUTS | CLONE_NEWCGROUP, 0, 1);
  statement(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM);
  if (processLimit <= 1) {
    jump(BPF_JMP | BPF_JSET | BPF_K, CLONE_THREAD, 1, 0);
    statement(BPF_RET | BPF_K, SECCOMP_RET_TRAP);
  }
  statement(BPF_LD | BPF_W | BPF_ABS, offsetof(seccomp_data, nr));
  if (processLimit <= 1) for (unsigned int call : {SYS_fork, SYS_vfork}) {
    jump(BPF_JMP | BPF_JEQ | BPF_K, call, 0, 1);
    statement(BPF_RET | BPF_K, SECCOMP_RET_TRAP);
  }
  statement(BPF_RET | BPF_K, SECCOMP_RET_ALLOW);
  const int fd = static_cast<int>(syscall(SYS_memfd_create, "taskweave-seccomp", 0));
  if (fd < 0) return -1;
  const auto size = rules.size() * sizeof(sock_filter);
  if (write(fd, rules.data(), size) != static_cast<ssize_t>(size) || lseek(fd, 0, SEEK_SET) < 0) { close(fd); return -1; }
  return fd;
#endif
}

std::vector<std::string> sandboxCommand(const Spec& spec, int info, int filter) {
  std::vector<std::string> args = {"bwrap", "--unshare-all", "--unshare-user", "--die-with-parent", "--new-session",
    "--cap-drop", "ALL", "--clearenv", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    "--json-status-fd", std::to_string(info), "--seccomp", std::to_string(filter)};
  const auto bind = [&](const std::string& file, bool writable) {
    args.insert(args.end(), {writable ? "--bind" : "--ro-bind", file, file});
  };
  for (const char* file : {"/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc/ld.so.cache", "/etc/localtime", "/sys/devices/system/cpu"}) {
    if (access(file, F_OK) == 0) bind(file, false);
  }
  for (const auto& file : spec.runtimes) if (file != "/usr" && file.rfind("/usr/", 0) != 0 && file != "/bin" && file != "/lib" && file != "/lib64") bind(file, false);
  for (const auto& file : spec.readPaths) bind(file, false);
  for (const auto& file : spec.writePaths) bind(file, true);
  bind(spec.cwd, true);
  // Only explicit writable mounts remain writable. Otherwise empty ancestors
  // on the private root/tmp tmpfs could accept misleading shadow output files.
  args.insert(args.end(), {"--remount-ro", "/", "--remount-ro", "/tmp"});
  for (const auto* name : {"HOME", "TMPDIR"}) args.insert(args.end(), {"--setenv", name, spec.cwd});
  for (const auto& entry : spec.environment) {
    const auto split = entry.find('=');
    if (split != std::string::npos) args.insert(args.end(), {"--setenv", entry.substr(0, split), entry.substr(split + 1)});
  }
  args.insert(args.end(), {"--chdir", spec.cwd, "--"});
  args.insert(args.end(), spec.argv.begin(), spec.argv.end());
  return args;
}

std::string bubblewrapPath() {
  const char* environment = std::getenv("PATH");
  std::istringstream paths(environment ? environment : "/usr/bin:/bin");
  std::string directory;
  while (std::getline(paths, directory, ':')) {
    if (directory.empty() || directory[0] != '/') continue;
    const auto file = directory + "/bwrap";
    if (access(file.c_str(), X_OK) == 0) return file;
  }
  errno = ENOENT; return {};
}

bool create(Proc& p, int input, int output, int stderrFd) {
  int gate[2] = {-1, -1}, errors[2] = {-1, -1}, sandboxInfo[2] = {-1, -1};
  if (pipe2(gate, O_CLOEXEC) || pipe2(errors, O_CLOEXEC | O_NONBLOCK) || pipe2(sandboxInfo, O_CLOEXEC | O_NONBLOCK)) {
    p.res.error = error("pipe2");
    for (int fd : {gate[0], gate[1], errors[0], errors[1], sandboxInfo[0], sandboxInfo[1]}) if (fd >= 0) close(fd);
    return false;
  }
  const pid_t parent = getpid();
  p.pid = fork();
  if (p.pid == 0) {
    close(gate[1]); close(errors[0]); close(sandboxInfo[0]);
    if (prctl(PR_SET_PDEATHSIG, SIGKILL) || setpgid(0, 0)) childError(errors[1], "process setup");
    if (getppid() != parent) _exit(127);
    signal(SIGINT, SIG_DFL); signal(SIGTERM, SIG_DFL); signal(SIGPIPE, SIG_DFL);
    if (dup2(input, STDIN_FILENO) < 0 || dup2(output, STDOUT_FILENO) < 0 || dup2(stderrFd, STDERR_FILENO) < 0) childError(errors[1], "redirect");
    if (!p.spec.cwd.empty() && chdir(p.spec.cwd.c_str())) childError(errors[1], "chdir");
    rlimit core{0, 0}; if (setrlimit(RLIMIT_CORE, &core)) childError(errors[1], "core limit");
    rlimit stack{};
    if (getrlimit(RLIMIT_STACK, &stack) == 0 && stack.rlim_cur != RLIM_INFINITY && stack.rlim_cur < 256ULL * 1024 * 1024) {
      stack.rlim_cur = stack.rlim_max == RLIM_INFINITY ? 256ULL * 1024 * 1024 : std::min<rlim_t>(stack.rlim_max, 256ULL * 1024 * 1024);
      if (setrlimit(RLIMIT_STACK, &stack)) childError(errors[1], "stack limit");
    }
    if (p.spec.timeLimit > 0) {
      const rlim_t seconds = static_cast<rlim_t>((p.spec.timeLimit + 999) / 1000);
      rlimit cpu{seconds, seconds + 1}; if (setrlimit(RLIMIT_CPU, &cpu)) childError(errors[1], "CPU limit");
    }
    if (p.spec.outputLimit > 0) {
      const auto limit = static_cast<rlim_t>(p.spec.outputLimit);
      rlimit size{limit, limit}; if (setrlimit(RLIMIT_FSIZE, &size)) childError(errors[1], "output limit");
    }
    char start;
    ssize_t got;
    do { got = read(gate[0], &start, 1); } while (got < 0 && errno == EINTR);
    if (got != 1) _exit(127);
    close(gate[0]);
    const int filter = sandboxFilter(p.spec.processLimit);
    if (filter < 0 || fcntl(sandboxInfo[1], F_SETFD, 0) < 0) childError(errors[1], "sandbox filter");
    auto command = sandboxCommand(p.spec, sandboxInfo[1], filter);
    command[0] = bubblewrapPath();
    if (command[0].empty()) childError(errors[1], "bubblewrap is required (install bubblewrap)");
    // The namespace's trusted PID 1 helper must not retain the host environment
    // either: /proc is visible inside the sandbox, even before app exec.
    clearenv();
    if (setenv("PATH", "/usr/bin:/bin", 1)) childError(errors[1], "sandbox environment");
    std::vector<char*> argv;
    for (auto& arg : command) argv.push_back(arg.data());
    argv.push_back(nullptr);
    execvp(argv[0], argv.data());
    childError(errors[1], "execvp bubblewrap (install bubblewrap; isolation is required)");
  }
  close(gate[0]); close(errors[1]); close(sandboxInfo[1]);
  if (p.pid < 0) { p.res.error = error("fork"); close(gate[1]); close(errors[0]); close(sandboxInfo[0]); return false; }
  setpgid(p.pid, p.pid);
  p.gate = gate[1]; p.errors = errors[0]; p.sandboxInfo = sandboxInfo[0];
  Usage initial;
  if (usage(p.pid, initial)) p.members[p.pid] = initial.started;
  return true;
}
void resume(Proc& p) {
  p.start = Clock::now(); p.running = true;
  const char start = 1; const auto ignored = write(p.gate, &start, 1); (void)ignored;
  closeFd(p.gate);
}
void readErrors(Proc& p) {
  if (p.errors < 0) return;
  char buffer[2048];
  for (;;) {
    const auto n = read(p.errors, buffer, sizeof buffer);
    if (n > 0) { if (p.res.error.size() < 4096) p.res.error.append(buffer, n); }
    else { if (!n) closeFd(p.errors); break; }
  }
}
void readSandboxInfo(Proc& p) {
  char buffer[1024];
  while (p.sandboxInfo >= 0) {
    const auto n = read(p.sandboxInfo, buffer, sizeof buffer);
    if (n <= 0) { if (!n) closeFd(p.sandboxInfo); break; }
    if (p.sandboxReport.size() < 16384) p.sandboxReport.append(buffer, n);
  }
  if (p.sandboxPid > 0) return;
  const auto key = p.sandboxReport.find("\"child-pid\"");
  if (key == std::string::npos) return;
  const auto colon = p.sandboxReport.find(':', key);
  if (colon == std::string::npos) return;
  p.sandboxPid = static_cast<pid_t>(std::atoi(p.sandboxReport.c_str() + colon + 1));
  if (p.sandboxPid > 0) p.start = Clock::now();
}
void measure(Proc& p) {
  // Forks may originate on any thread. Also revisit known children whose parent exited.
  discover(p, p.pid);
  for (auto it = p.members.begin(); it != p.members.end(); ++it) if (it->first != p.pid) discover(p, it->first);
  long long ticks = 0, memory = 0, processes = 0;
  for (const auto& [pid, started] : p.members) {
    Usage now;
    if (usage(pid, now) && now.started == started) {
      // The outer monitor and namespace PID 1 are trusted bubblewrap helpers.
      if (pid == p.pid || pid == p.sandboxPid) { p.overheadTicks[pid] = std::max(p.overheadTicks[pid], now.ticks); continue; }
      p.cpuTicks[pid] = std::max(p.cpuTicks[pid], now.ticks); memory += now.memoryKb; ++processes;
    }
  }
  for (const auto& [pid, used] : p.cpuTicks) ticks += used;
  if (p.sandboxPid <= 0) {
    if (elapsed(p) > 10000) { p.killed = "IE"; p.res.error = "Sandbox preparation timed out (bubblewrap / user namespaces are required)"; }
    return;
  }
  p.res.timeMs = std::max(p.res.timeMs, ticks * 1000 / sysconf(_SC_CLK_TCK));
  p.res.memoryKb = std::max(p.res.memoryKb, memory);
  if (!p.killed.empty()) return;
  if (p.spec.timeLimit > 0 && p.res.timeMs > p.spec.timeLimit) p.killed = "TL";
  else if (p.spec.wallLimit > 0 && elapsed(p) > p.spec.wallLimit) { p.killed = "TL"; p.res.idle = p.spec.timeLimit > 0 && p.res.timeMs < p.spec.timeLimit; }
  else if (p.spec.memoryLimit > 0 && memory * 1024 > p.spec.memoryLimit) p.killed = "ML";
  else if (processes > std::max(1LL, p.spec.processLimit)) { p.killed = "RE"; p.res.error = "process limit exceeded"; }
  if (p.spec.outputLimit > 0 && p.output >= 0) {
    struct stat file{};
    if (fstat(p.output, &file) == 0 && file.st_size > p.spec.outputLimit) p.killed = "OL";
  }
}
void finish(Proc& p) {
  Usage wrapper;
  if (usage(p.pid, wrapper)) p.overheadTicks[p.pid] = std::max(p.overheadTicks[p.pid], wrapper.ticks);
  long long overheadTicks = 0;
  for (const auto& [pid, ticks] : p.overheadTicks) overheadTicks += ticks;
  const long long overhead = overheadTicks * 1000 / sysconf(_SC_CLK_TCK);
  killTree(p);
  int status = 0; rusage used{};
  while (wait4(p.pid, &status, 0, &used) < 0 && errno == EINTR) {}
  readErrors(p);
  readSandboxInfo(p);
  p.res.wallMs = elapsed(p);
  const auto micros = (used.ru_utime.tv_sec + used.ru_stime.tv_sec) * 1000000LL + used.ru_utime.tv_usec + used.ru_stime.tv_usec;
  p.res.timeMs = std::max(p.res.timeMs, std::max(0LL, (micros + 999) / 1000 - overhead));
  p.res.memoryKb = std::max(p.res.memoryKb, static_cast<long long>(used.ru_maxrss));
  p.res.exitCode = WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
  if (p.res.exitCode == 128 + SIGSYS && p.res.error.empty()) p.res.error = "process limit exceeded or forbidden system call";
  if (p.sandboxPid <= 0 && p.res.error.empty()) p.res.error = "Sandbox could not start; install bubblewrap and enable unprivileged user namespaces. See program stderr.";
  if (!p.killed.empty()) p.res.status = p.killed;
  else if (p.res.exitCode == 128 + SIGSYS) p.res.status = "RE";
  else if (!p.res.error.empty()) p.res.status = "IE";
  else if (p.res.exitCode == 128 + SIGXCPU) p.res.status = "TL";
  else if (p.res.exitCode == 128 + SIGXFSZ) p.res.status = "OL";
  else if (p.spec.timeLimit > 0 && p.res.timeMs > p.spec.timeLimit) p.res.status = "TL";
  else if (p.spec.memoryLimit > 0 && p.res.memoryKb * 1024 > p.spec.memoryLimit) p.res.status = "ML";
  else p.res.status = p.res.exitCode ? "RE" : "OK";
  p.running = false; closeFd(p.errors); closeFd(p.output); closeFd(p.sandboxInfo);
}
void runAll(const std::vector<Proc*>& procs) {
  for (;;) {
    bool running = false;
    for (Proc* p : procs) {
      if (!p->running) continue;
      readErrors(*p); readSandboxInfo(*p); measure(*p);
      if (interrupted) { p->killed = "IE"; p->res.error = "runner cancelled"; }
      if (!p->killed.empty()) killTree(*p);
      siginfo_t info{};
      if (waitid(P_PID, p->pid, &info, WEXITED | WNOHANG | WNOWAIT) == 0 && info.si_pid) finish(*p);
      else running = true;
    }
    if (!running) break;
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  // Reap orphaned descendants after cancelling or finishing their parent.
  for (int i = 0; i < 100; ++i) {
    int status; pid_t pid = waitpid(-1, &status, WNOHANG);
    if (pid < 0 && errno == ECHILD) break;
    if (pid == 0) std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
}
void abandon(Proc& p) {
  if (p.pid <= 0) return;
  p.start = Clock::now(); p.running = true; p.killed = "IE";
  closeFd(p.gate); killTree(p);
}
} // namespace

int main() {
  signal(SIGTERM, stop); signal(SIGINT, stop); signal(SIGPIPE, SIG_IGN);
  prctl(PR_SET_CHILD_SUBREAPER, 1);
  std::string text;
  char buffer[4096];
  for (size_t n; (n = std::fread(buffer, 1, sizeof buffer, stdin)) > 0;) text.append(buffer, n);
  Proc sol, inter; bool interactive = false;
  if (!parseSpec(text, sol.spec, inter.spec, interactive)) {
    sol.res.error = "invalid spec"; std::printf("%s\n", toJson(sol.res).c_str()); return 2;
  }
  if (!interactive) {
    int input = openFile(sol.spec.in, false), output = openFile(sol.spec.out, true), stderrFd = openFile(sol.spec.err, true);
    if (input < 0 || output < 0 || stderrFd < 0) sol.res.error = error("open redirection");
    else if (create(sol, input, output, stderrFd)) {
      if (!sol.spec.out.empty()) sol.output = fcntl(output, F_DUPFD_CLOEXEC, 3);
      closeFd(input); closeFd(output); closeFd(stderrFd);
      resume(sol); runAll({&sol});
    }
    closeFd(input); closeFd(output); closeFd(stderrFd);
    std::printf("%s\n", toJson(sol.res).c_str());
    return 0;
  }
  int s2i[2] = {-1, -1}, i2s[2] = {-1, -1};
  int solErr = openFile(sol.spec.err, true), intErr = openFile(inter.spec.err, true);
  if (solErr < 0 || intErr < 0 || pipe2(s2i, O_CLOEXEC) || pipe2(i2s, O_CLOEXEC)) sol.res.error = inter.res.error = error("interactive pipes");
  else {
    const bool ok = create(inter, s2i[0], i2s[1], intErr) && create(sol, i2s[0], s2i[1], solErr);
    for (int& fd : s2i) closeFd(fd);
    for (int& fd : i2s) closeFd(fd);
    closeFd(solErr); closeFd(intErr);
    if (ok) { resume(inter); resume(sol); }
    else { abandon(inter); abandon(sol); }
    runAll({&sol, &inter});
  }
  for (int& fd : s2i) closeFd(fd);
  for (int& fd : i2s) closeFd(fd);
  closeFd(solErr); closeFd(intErr);
  std::printf("{\"solution\":%s,\"interactor\":%s}\n", toJson(sol.res).c_str(), toJson(inter.res).c_str());
  return 0;
}
