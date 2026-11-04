// TaskWeave runner: runs one program (or a solution + interactor pair) under Windows
// a low-privilege AppContainer + Job Object and prints JSON on stdout.
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
//   read=<path> write=<path>         explicit per-run filesystem access
//   runtime=<directory>             trusted runtime, read/execute only
//   env=<name>=<value>               explicitly supplied child environment
//
// CPU time is Windows user + kernel accounting. Cycle counts must not be divided
// by TSC frequency: turbo scaling and hybrid cores make that conversion invalid.
// Very short runs can be below the OS accounting resolution; wall time is separate.
//
// Result per process:
//   {"status":"OK|RE|TL|ML|OL|IE","exit_code":N,"time_ms":N,"wall_ms":N,"memory_kb":N,
//    "idle":bool,"error":"..."}
// Interactive: {"solution":{...},"interactor":{...}}

#ifndef UNICODE
#define UNICODE
#endif
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0a00
#endif
#include <windows.h>
#include <aclapi.h>
#include <bcrypt.h>

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <memory>
#include <string>
#include <vector>

#ifndef PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY
#define PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY 0x0002000f
#endif
#ifndef PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT
#define PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT 0x01
#endif

namespace {

struct Spec {
  std::wstring cmd, cwd, in, out, err;
  std::vector<std::wstring> readPaths, writePaths, directories, runtimes, environment;
  long long timeLimit = 0, wallLimit = 0, memoryLimit = 0, outputLimit = 0;
  long long processLimit = 1;
};

struct Result {
  std::string status = "IE";
  unsigned long exitCode = 0;
  long long timeMs = 0, wallMs = 0, memoryKb = 0;
  bool idle = false;
  std::string error;
};

class Sandbox;
struct Proc {
  Spec spec;
  Result res;
  HANDLE job = nullptr, process = nullptr, thread = nullptr, port = nullptr, outFile = nullptr;
  LARGE_INTEGER start{};
  bool running = false;
  bool killedTL = false, killedOL = false;
  std::unique_ptr<Sandbox> sandbox;
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
    else if (k == "read") cur->readPaths.push_back(widen(v));
    else if (k == "write") cur->writePaths.push_back(widen(v));
    else if (k == "list") cur->directories.push_back(widen(v));
    else if (k == "runtime") cur->runtimes.push_back(widen(v));
    else if (k == "env") cur->environment.push_back(widen(v));
    else if (k == "time_limit") cur->timeLimit = std::atoll(v.c_str());
    else if (k == "wall_limit") cur->wallLimit = std::atoll(v.c_str());
    else if (k == "memory_limit") cur->memoryLimit = std::atoll(v.c_str());
    else if (k == "output_limit") cur->outputLimit = std::atoll(v.c_str());
    else if (k == "process_limit") cur->processLimit = std::atoll(v.c_str());
  }
  return !sol.cmd.empty() && (!interactive || !inter.cmd.empty());
}

// ACL changes use private per-run identities, never Everyone / ALL APPLICATION PACKAGES.
// Runtime capabilities only cover trusted installations and are read/execute-only.
class Sandbox {
  using CreateProfile = HRESULT(WINAPI*)(PCWSTR, PCWSTR, PCWSTR, PSID_AND_ATTRIBUTES, DWORD, PSID*);
  using DeleteProfile = HRESULT(WINAPI*)(PCWSTR);
  using DeriveCapability = BOOL(WINAPI*)(LPCWSTR, PSID**, DWORD*, PSID**, DWORD*);
  HMODULE userenv = nullptr;
  DeleteProfile deleteProfile = nullptr;
  PSID package = nullptr;
  std::wstring profile;
  std::vector<PSID> capabilities;
  std::vector<SID_AND_ATTRIBUTES> attributes;
  std::vector<std::wstring> privateGrants;
  std::vector<wchar_t> environmentBlock;
  SECURITY_CAPABILITIES security{};
  DWORD packagesPolicy = 0;

  struct Lock {
    HANDLE handle = CreateMutexW(nullptr, FALSE, L"Local\\TaskWeave.Sandbox.ACL.v1");
    DWORD result = handle ? WaitForSingleObject(handle, 120000) : WAIT_FAILED;
    bool acquired = result == WAIT_OBJECT_0 || result == WAIT_ABANDONED;
    ~Lock() { if (acquired) ReleaseMutex(handle); if (handle) CloseHandle(handle); }
  };

  static DWORD daclFlags(PSECURITY_DESCRIPTOR descriptor) {
    SECURITY_DESCRIPTOR_CONTROL control = 0;
    DWORD revision = 0;
    if (!GetSecurityDescriptorControl(descriptor, &control, &revision)) return DACL_SECURITY_INFORMATION;
    return DACL_SECURITY_INFORMATION | ((control & SE_DACL_PROTECTED) ? PROTECTED_DACL_SECURITY_INFORMATION : UNPROTECTED_DACL_SECURITY_INFORMATION);
  }

  static bool hasGrant(PACL acl, PSID sid, DWORD rights) {
    if (!acl) return true;
    GENERIC_MAPPING mapping{FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_GENERIC_EXECUTE, FILE_ALL_ACCESS};
    DWORD remaining = rights;
    for (DWORD index = 0; index < acl->AceCount; ++index) {
      void* entry = nullptr;
      if (!GetAce(acl, index, &entry)) return false;
      const auto* header = static_cast<ACE_HEADER*>(entry);
      if (header->AceFlags & INHERIT_ONLY_ACE) continue;
      if (header->AceType != ACCESS_ALLOWED_ACE_TYPE && header->AceType != ACCESS_DENIED_ACE_TYPE) continue;
      const auto* ace = static_cast<ACCESS_ALLOWED_ACE*>(entry);
      if (!EqualSid(const_cast<DWORD*>(&ace->SidStart), sid)) continue;
      DWORD mask = ace->Mask;
      MapGenericMask(&mask, &mapping);
      if (header->AceType == ACCESS_DENIED_ACE_TYPE && (mask & remaining)) return false;
      if (header->AceType == ACCESS_ALLOWED_ACE_TYPE) remaining &= ~mask;
      if (!remaining) return true;
    }
    return false;
  }

  bool privateTree(const std::wstring& path, std::string& error, int depth = 0) {
    if (depth > 128) { error = "Sandbox directory nesting is too deep"; return false; }
    WIN32_FIND_DATAW entry{};
    HANDLE search = FindFirstFileW((path + L"\\*").c_str(), &entry);
    if (search == INVALID_HANDLE_VALUE) {
      if (GetLastError() == ERROR_FILE_NOT_FOUND) return true;
      error = lastError("Inspect sandbox directory"); return false;
    }
    bool ok = true;
    do {
      if (std::wstring(entry.cFileName) == L"." || std::wstring(entry.cFileName) == L"..") continue;
      const auto file = path + L"\\" + entry.cFileName;
      if (entry.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) { error = "Sandbox directories must not contain reparse points: " + narrow(file); ok = false; break; }
      if (entry.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) { if (!privateTree(file, error, depth + 1)) { ok = false; break; } }
      else {
        HANDLE handle = CreateFileW(file.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
        BY_HANDLE_FILE_INFORMATION info{};
        if (handle == INVALID_HANDLE_VALUE || !GetFileInformationByHandle(handle, &info) || info.nNumberOfLinks != 1) { error = "Sandbox directories must contain only regular private files: " + narrow(file); ok = false; }
        if (handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
        if (!ok) break;
      }
    } while (FindNextFileW(search, &entry));
    FindClose(search); return ok;
  }

  bool grant(const std::wstring& path, PSID sid, bool write, bool runtime, std::string& error, bool listOnly = false) {
    HANDLE file = CreateFileW(path.c_str(), READ_CONTROL | WRITE_DAC | FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    bool canEdit = file != INVALID_HANDLE_VALUE;
    if (!canEdit) file = CreateFileW(path.c_str(), READ_CONTROL | FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    if (file == INVALID_HANDLE_VALUE) { error = lastError(("sandbox resource " + narrow(path)).c_str()); return false; }
    BY_HANDLE_FILE_INFORMATION info{};
    if (!GetFileInformationByHandle(file, &info) || (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) ||
      (!runtime && !(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) && info.nNumberOfLinks != 1)) {
      error = "Sandbox resources must not be symbolic links, reparse points or hard links: " + narrow(path);
      CloseHandle(file); return false;
    }
    if (!runtime && !listOnly && (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) && !privateTree(path, error)) { CloseHandle(file); return false; }
    PACL acl = nullptr;
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    DWORD code = GetSecurityInfo(file, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, &acl, nullptr, &descriptor);
    if (code != ERROR_SUCCESS || !acl) {
      error = "Cannot read a private sandbox resource ACL: " + narrow(path);
      if (descriptor) LocalFree(descriptor);
      CloseHandle(file); return false;
    }
    const DWORD rights = FILE_GENERIC_READ | FILE_GENERIC_EXECUTE | (write ? FILE_GENERIC_WRITE | DELETE : 0);
    bool already = hasGrant(acl, sid, rights);
    // LPAC deliberately opts out of ALL APPLICATION PACKAGES. Only the restricted
    // package identity can supply pre-existing system/runtime access.
    if (runtime && !already) {
      PSID restricted = nullptr;
      SID_IDENTIFIER_AUTHORITY authority = SECURITY_APP_PACKAGE_AUTHORITY;
      if (AllocateAndInitializeSid(&authority, 2, SECURITY_APP_PACKAGE_BASE_RID, 2, 0, 0, 0, 0, 0, 0, &restricted)) {
        already = hasGrant(acl, restricted, rights);
        FreeSid(restricted);
      }
    }
    if (runtime && !already && packagesPolicy == 0) {
      PSID allPackages = nullptr;
      SID_IDENTIFIER_AUTHORITY authority = SECURITY_APP_PACKAGE_AUTHORITY;
      if (AllocateAndInitializeSid(&authority, 2, SECURITY_APP_PACKAGE_BASE_RID, 1, 0, 0, 0, 0, 0, 0, &allPackages)) {
        already = hasGrant(acl, allPackages, rights);
        FreeSid(allPackages);
      }
    }
    if (!already) {
      if (!canEdit) error = "Cannot authorize sandbox access to " + narrow(path) + ". Use a user-owned runtime installation; isolation was not disabled.";
      else {
        EXPLICIT_ACCESSW entry{};
        entry.grfAccessPermissions = rights;
        entry.grfAccessMode = GRANT_ACCESS;
        entry.grfInheritance = !listOnly && (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) ? SUB_CONTAINERS_AND_OBJECTS_INHERIT : NO_INHERITANCE;
        BuildTrusteeWithSidW(&entry.Trustee, sid);
        PACL updated = nullptr;
        code = SetEntriesInAclW(1, &entry, acl, &updated);
        if (code == ERROR_SUCCESS) code = SetSecurityInfo(file, SE_FILE_OBJECT, daclFlags(descriptor), nullptr, nullptr, updated, nullptr);
        if (updated) LocalFree(updated);
        if (code != ERROR_SUCCESS) error = "Cannot authorize sandbox resource (Windows error " + std::to_string(code) + "): " + narrow(path);
        else if (!runtime) privateGrants.push_back(path);
      }
    }
    LocalFree(descriptor); CloseHandle(file);
    return error.empty();
  }

  void revoke(const std::wstring& path) {
    HANDLE file = CreateFileW(path.c_str(), READ_CONTROL | WRITE_DAC, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    if (file == INVALID_HANDLE_VALUE) return;
    PACL acl = nullptr;
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    if (GetSecurityInfo(file, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, &acl, nullptr, &descriptor) == ERROR_SUCCESS && acl) {
      bool changed = false;
      for (DWORD i = acl->AceCount; i > 0; --i) {
        void* entry = nullptr;
        if (!GetAce(acl, i - 1, &entry)) continue;
        const auto* ace = static_cast<ACCESS_ALLOWED_ACE*>(entry);
        if (ace->Header.AceType == ACCESS_ALLOWED_ACE_TYPE && EqualSid(const_cast<DWORD*>(&ace->SidStart), package)) {
          DeleteAce(acl, i - 1); changed = true;
        }
      }
      if (changed) SetSecurityInfo(file, SE_FILE_OBJECT, daclFlags(descriptor), nullptr, nullptr, acl, nullptr);
    }
    if (descriptor) LocalFree(descriptor);
    CloseHandle(file);
  }

  static std::wstring runtimeName(const std::wstring& path) {
    // SHA-256 avoids capability collisions between trusted runtime installations.
    BCRYPT_ALG_HANDLE algorithm = nullptr;
    BCRYPT_HASH_HANDLE hash = nullptr;
    unsigned char digest[32]{};
    if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) return {};
    DWORD size = 0, returned = 0;
    BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&size), sizeof size, &returned, 0);
    std::vector<unsigned char> object(size);
    bool ok = BCryptCreateHash(algorithm, &hash, object.data(), size, nullptr, 0, 0) >= 0 &&
      BCryptHashData(hash, reinterpret_cast<PUCHAR>(const_cast<wchar_t*>(path.data())), static_cast<ULONG>(path.size() * sizeof(wchar_t)), 0) >= 0 &&
      BCryptFinishHash(hash, digest, sizeof digest, 0) >= 0;
    if (hash) BCryptDestroyHash(hash);
    BCryptCloseAlgorithmProvider(algorithm, 0);
    if (!ok) return {};
    std::wstring name = L"TaskWeave.Runtime.v1.";
    for (unsigned char byte : digest) { name += L"0123456789abcdef"[byte >> 4]; name += L"0123456789abcdef"[byte & 15]; }
    return name;
  }

  PSID capability(const std::wstring& name, std::string& error) {
    const auto derive = reinterpret_cast<DeriveCapability>(GetProcAddress(GetModuleHandleW(L"kernelbase.dll"), "DeriveCapabilitySidsFromName"));
    if (!derive || name.empty()) { error = "Windows sandbox capability APIs are unavailable"; return nullptr; }
    PSID* groups = nullptr; PSID* sids = nullptr;
    DWORD groupCount = 0, sidCount = 0;
    const BOOL ok = derive(name.c_str(), &groups, &groupCount, &sids, &sidCount);
    PSID sid = ok && sidCount ? sids[0] : nullptr;
    for (DWORD i = 0; i < groupCount; ++i) LocalFree(groups[i]);
    for (DWORD i = 1; i < sidCount; ++i) LocalFree(sids[i]);
    LocalFree(groups); LocalFree(sids);
    if (!sid) { error = lastError("DeriveCapabilitySidsFromName"); return nullptr; }
    capabilities.push_back(sid); attributes.push_back({sid, SE_GROUP_ENABLED});
    return sid;
  }
  bool runtime(const std::wstring& path, std::string& error) {
    PSID sid = capability(runtimeName(path), error);
    if (!sid) return false;
    return grant(path, sid, false, true, error);
  }

public:
  ~Sandbox() {
    if (package) {
      Lock lock;
      if (lock.acquired) for (auto path = privateGrants.rbegin(); path != privateGrants.rend(); ++path) revoke(*path);
      if (deleteProfile) deleteProfile(profile.c_str());
      FreeSid(package);
    }
    for (PSID sid : capabilities) LocalFree(sid);
    if (userenv) FreeLibrary(userenv);
  }

  bool prepare(const Spec& spec, std::string& error) {
    // Windows does not let an LPAC use ordinary CreateProcess for descendants,
    // and third-party interpreters can require standard package-access DLLs.
    // Toolchains/interpreters use AppContainer, never an unrestricted token.
    packagesPolicy = spec.processLimit > 1 || !spec.runtimes.empty() ? 0 : PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT;
    userenv = LoadLibraryW(L"userenv.dll");
    const auto createProfile = userenv ? reinterpret_cast<CreateProfile>(GetProcAddress(userenv, "CreateAppContainerProfile")) : nullptr;
    deleteProfile = userenv ? reinterpret_cast<DeleteProfile>(GetProcAddress(userenv, "DeleteAppContainerProfile")) : nullptr;
    if (!createProfile || !deleteProfile) { error = "Windows 10 or newer is required for execution isolation"; return false; }
    unsigned char nonce[16];
    if (BCryptGenRandom(nullptr, nonce, sizeof nonce, BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0) { error = "Cannot create a private sandbox identity"; return false; }
    profile = L"TaskWeave.Run.";
    for (unsigned char byte : nonce) { profile += L"0123456789abcdef"[byte >> 4]; profile += L"0123456789abcdef"[byte & 15]; }
    const HRESULT code = createProfile(profile.c_str(), profile.c_str(), L"TaskWeave isolated execution", nullptr, 0, &package);
    if (FAILED(code)) { error = "CreateAppContainerProfile failed: " + std::to_string(static_cast<unsigned long>(code)); return false; }
    // Windows redirects GetTempPath for AppContainers below LOCALAPPDATA.
    // Prepare that private tree before launching compilers/interpreters.
    std::wstring temporary = spec.cwd;
    for (const auto& segment : {std::wstring(L"Packages"), profile, std::wstring(L"AC"), std::wstring(L"Temp")}) {
      temporary += L"\\" + segment;
      if (!CreateDirectoryW(temporary.c_str(), nullptr) && GetLastError() != ERROR_ALREADY_EXISTS) {
        error = lastError("Create sandbox temporary directory"); return false;
      }
    }
    {
      Lock lock;
      if (!lock.acquired) { error = "Cannot acquire the sandbox permissions lock"; return false; }
      if (spec.cwd.empty() || !grant(spec.cwd, package, true, false, error)) return false;
      for (const auto& path : spec.readPaths) if (!grant(path, package, false, false, error)) return false;
      for (const auto& path : spec.directories) if (!grant(path, package, false, false, error, true)) return false;
      for (const auto& path : spec.writePaths) if (!grant(path, package, true, false, error)) return false;
      for (const auto& path : spec.runtimes) if (!runtime(path, error)) return false;
    }
    std::vector<std::wstring> environment;
    for (const auto* name : {L"SystemRoot", L"WINDIR", L"SystemDrive", L"NUMBER_OF_PROCESSORS", L"PROCESSOR_ARCHITECTURE"}) {
      wchar_t value[32768];
      const DWORD size = GetEnvironmentVariableW(name, value, 32768);
      if (size && size < 32768) environment.emplace_back(std::wstring(name) + L"=" + value);
    }
    environment.push_back(L"TEMP=" + spec.cwd); environment.push_back(L"TMP=" + spec.cwd);
    environment.push_back(L"LOCALAPPDATA=" + spec.cwd); environment.push_back(L"USERPROFILE=" + spec.cwd);
    environment.insert(environment.end(), spec.environment.begin(), spec.environment.end());
    std::sort(environment.begin(), environment.end(), [](const auto& a, const auto& b) { return _wcsicmp(a.c_str(), b.c_str()) < 0; });
    for (const auto& item : environment) { environmentBlock.insert(environmentBlock.end(), item.begin(), item.end()); environmentBlock.push_back(0); }
    environmentBlock.push_back(0);
    security = {package, attributes.data(), static_cast<DWORD>(attributes.size()), 0};
    return true;
  }

  bool configure(LPPROC_THREAD_ATTRIBUTE_LIST list) {
    return UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, &security, sizeof security, nullptr, nullptr) &&
      UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY, &packagesPolicy, sizeof packagesPolicy, nullptr, nullptr);
  }
  void* environment() { return environmentBlock.data(); }
};

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

long long cpuMs(HANDLE process) {
  FILETIME created, exited, kernel, user;
  if (!GetProcessTimes(process, &created, &exited, &kernel, &user)) return 0;
  ULARGE_INTEGER k, u;
  k.LowPart = kernel.dwLowDateTime; k.HighPart = kernel.dwHighDateTime;
  u.LowPart = user.dwLowDateTime; u.HighPart = user.dwHighDateTime;
  return (long long)((k.QuadPart + u.QuadPart + 9999) / 10000);
}

// Create `p` suspended with the given std handles. Only these handles are inherited,
// which matters for pipes: a stray inherited write end would keep the reader from ever
// seeing EOF. The process runs (and its clock starts) only in resume(), because
// CreateProcess itself can take seconds when an antivirus scans a new executable.
bool create(Proc& p, HANDLE hin, HANDLE hout, HANDLE herr) {
  p.sandbox = std::make_unique<Sandbox>();
  if (!p.sandbox->prepare(p.spec, p.res.error)) return false;
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
  JOBOBJECT_BASIC_UI_RESTRICTIONS ui{};
  ui.UIRestrictionsClass = JOB_OBJECT_UILIMIT_DESKTOP | JOB_OBJECT_UILIMIT_DISPLAYSETTINGS | JOB_OBJECT_UILIMIT_EXITWINDOWS |
    JOB_OBJECT_UILIMIT_GLOBALATOMS | JOB_OBJECT_UILIMIT_HANDLES | JOB_OBJECT_UILIMIT_READCLIPBOARD |
    JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS | JOB_OBJECT_UILIMIT_WRITECLIPBOARD;
  if (!SetInformationJobObject(p.job, JobObjectBasicUIRestrictions, &ui, sizeof ui)) { p.res.error = lastError("Sandbox UI restrictions"); return false; }
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
  InitializeProcThreadAttributeList(nullptr, 3, 0, &size);
  std::vector<char> attrBuf(size);
  auto attrs = (LPPROC_THREAD_ATTRIBUTE_LIST)attrBuf.data();
  if (!InitializeProcThreadAttributeList(attrs, 3, 0, &size)) {
    p.res.error = lastError("ProcThreadAttributeList");
    return false;
  }
  if (!UpdateProcThreadAttribute(attrs, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, list, n * sizeof(HANDLE), nullptr, nullptr) || !p.sandbox->configure(attrs)) {
    p.res.error = lastError("Sandbox process attributes");
    DeleteProcThreadAttributeList(attrs); return false;
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
                           CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT, p.sandbox->environment(),
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

  LARGE_INTEGER outputSize{};
  const bool outputHit = p.spec.outputLimit > 0 && p.outFile && GetFileSizeEx(p.outFile, &outputSize) && outputSize.QuadPart > p.spec.outputLimit;
  if (p.killedTL || (p.spec.timeLimit > 0 && p.res.timeMs > p.spec.timeLimit)) p.res.status = "TL";
  else if (p.killedOL || outputHit) p.res.status = "OL";
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

int main() {
  SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
  QueryPerformanceFrequency(&freq);

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
