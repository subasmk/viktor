"""VIKTOR voice PC control: "open X" / "close X" on Windows.

Safety contract:
- Once a command matches the open/close verb pattern, VIKTOR OWNS it: it never falls
  through to Hermes. A denied target gets an explicit refusal, an unresolved target gets
  "can't find it", an ambiguous one asks which. That way no guarded command can bypass
  these rules via a less careful path. Only commands that never matched the verb pattern
  fall through to Hermes.
- open launches the resolved absolute path with os.startfile - no shell, no command strings.
- close posts WM_CLOSE to the app's visible windows. That is the graceful path: the app
  keeps its own save prompt. No TerminateProcess, no taskkill, no force, ever.
- A denylist of system components plus VIKTOR's own install/voice processes can never be
  closed. Ambiguous matches ask which one instead of guessing.
- Every backend (discovery, window list, launch, close) is injectable for tests.
"""
import os, re, sys
from pathlib import Path

VOICE_HOME = os.environ.get("VIKTOR_VOICE_HOME", r"D:\viktor-voice")

_OPEN_RE = re.compile(r"^(?:please\s+)?(?:open|launch|start)\s+(.+?)\s*$", re.IGNORECASE)
_CLOSE_RE = re.compile(r"^(?:please\s+)?(?:close|quit|exit)\s+(.+?)\s*$", re.IGNORECASE)
_TRAIL = re.compile(r"\s+(?:app|application|please)$", re.IGNORECASE)
_LEAD = re.compile(r"^(?:my|the|a|an)\s+", re.IGNORECASE)

# image names that must never be closed from voice
DENY_STEMS = {
    "system", "registry", "smss", "csrss", "wininit", "winlogon", "services", "lsass",
    "svchost", "dwm", "explorer", "sihost", "taskhostw", "msmpeng", "searchhost",
    "startmenuexperiencehost", "shellexperiencehost", "runtimebroker", "securityhealthservice",
}


def parse_intent(command):
    """('open'|'close', target) or None. Verb-first only; target 2-60 chars."""
    if not command:
        return None
    for verb, rx in (("open", _OPEN_RE), ("close", _CLOSE_RE)):
        m = rx.match(command.strip())
        if m:
            target = _LEAD.sub("", _TRAIL.sub("", m.group(1)).strip()).strip()
            if 2 <= len(target) <= 60:
                return verb, target
    return None


def _norm(s):
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s]", " ", s.lower())).strip()


def _match(target, names):
    """Rank candidate names against the spoken target. Returns names in best-first order."""
    t = _norm(target)
    if not t:
        return []
    best, scored = [], []
    for n in names:
        c = _norm(n)
        if not c:
            continue
        if c == t:
            score = 0
        elif c.startswith(t) or t.startswith(c):
            score = 1
        elif t in c:
            score = 2
        else:
            continue
        scored.append((score, n))
    scored.sort(key=lambda x: (x[0], x[1]))
    seen = set()
    for _, n in scored:
        if n not in seen:
            seen.add(n)
            best.append(n)
    return best


# ---------- Windows backends (import-guarded; injected in tests) ----------

def discover_apps():
    """[(name, absolute_path)] from Start Menu shortcuts and registry App Paths."""
    apps = []
    if sys.platform != "win32":
        return apps
    for base in (os.environ.get("ProgramData", r"C:\ProgramData"),
                 os.environ.get("APPDATA", "")):
        d = Path(base) / "Microsoft" / "Windows" / "Start Menu" / "Programs"
        try:
            for lnk in d.rglob("*.lnk"):
                apps.append((lnk.stem, str(lnk)))
        except Exception:
            pass
    try:
        import winreg
        for hive in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
            try:
                with winreg.OpenKey(hive, r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths") as k:
                    i = 0
                    while True:
                        try:
                            sub = winreg.EnumKey(k, i)
                        except OSError:
                            break
                        i += 1
                        try:
                            with winreg.OpenKey(k, sub) as sk:
                                exe, _ = winreg.QueryValueEx(sk, None)
                            if exe and exe.lower().endswith(".exe"):
                                apps.append((Path(sub).stem, exe.strip('"')))
                        except OSError:
                            pass
            except OSError:
                pass
    except ImportError:
        pass
    return apps


def list_windows():
    """[(hwnd, pid, title, exe_stem, exe_path)] for visible top-level windows."""
    if sys.platform != "win32":
        return []
    import ctypes
    from ctypes import wintypes
    u32, k32 = ctypes.windll.user32, ctypes.windll.kernel32
    out = []
    EnumWindowsProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def cb(hwnd, _):
        if not u32.IsWindowVisible(hwnd):
            return True
        ln = u32.GetWindowTextLengthW(hwnd)
        if not ln:
            return True
        buf = ctypes.create_unicode_buffer(ln + 1)
        u32.GetWindowTextW(hwnd, buf, ln + 1)
        pid = wintypes.DWORD()
        u32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        path = ""
        h = k32.OpenProcess(0x1000, False, pid.value)  # PROCESS_QUERY_LIMITED_INFORMATION
        if h:
            pbuf = ctypes.create_unicode_buffer(512)
            sz = wintypes.DWORD(512)
            if k32.QueryFullProcessImageNameW(h, 0, pbuf, ctypes.byref(sz)):
                path = pbuf.value
            k32.CloseHandle(h)
        out.append((hwnd, pid.value, buf.value, Path(path).stem if path else "", path))
        return True

    u32.EnumWindows(EnumWindowsProc(cb), 0)
    return out


def _self_paths():
    roots = [Path(VOICE_HOME).resolve()]
    try:
        roots.append(Path(__file__).resolve().parents[1])  # repo/install root
    except Exception:
        pass
    return [str(r).lower() for r in roots]


def close_window(hwnd):
    """Graceful: WM_CLOSE only. The app keeps its save prompt."""
    import ctypes
    ctypes.windll.user32.PostMessageW(hwnd, 0x0010, 0, 0)  # WM_CLOSE


def launch(path):
    os.startfile(path)  # Windows stdlib shell-association launch; no command string


# ---------- intent handling ----------

def handle(command, *, discovery=discover_apps, windows=list_windows,
           launcher=launch, closer=close_window, log=lambda m: None):
    """Returns the sentence VIKTOR should speak, or None to fall through to Hermes."""
    intent = parse_intent(command)
    if not intent or sys.platform != "win32":
        return None
    verb, target = intent

    if _norm(target) in DENY_STEMS:
        log(f"pc-control: denied {verb} of system component '{target}'")
        return f"I won't {verb} {target} - Windows needs it running."

    if verb == "open":
        apps = discovery()
        names = {n: p for n, p in apps}
        hits = _match(target, list(names))
        if not hits:
            log(f"pc-control: open target '{target}' not found in discovered apps")
            return f"I can't find an app called {target}."
        exact = [n for n in hits if n.lower() == target.lower()]
        if exact:
            hits = exact[:1]     # raw-name exact wins over normalized collisions (Notepad vs NotePad++)
        if len(hits) > 1:
            show = hits[:4]
            log(f"pc-control: open '{target}' ambiguous: {show}")
            return "I found a few matches: " + ", ".join(show) + ". Which one?"
        name = hits[0]
        try:
            launcher(names[name])
        except Exception as e:
            log(f"pc-control: launch failed for {name}: {e}")
            return f"I found {name} but couldn't open it."
        log(f"pc-control: launch requested for {name} -> {names[name]}")
        return f"Telling {name} to open."

    # close: resolve against visible windows by exe stem or window title
    wins = windows()
    cands = {}
    for hwnd, pid, title, stem, path in wins:
        if not stem or _norm(stem) in DENY_STEMS:
            continue
        if pid == os.getpid():
            continue
        if path and any(str(path).lower().startswith(r) for r in _self_paths()):
            continue  # never close VIKTOR itself
        cands.setdefault(stem, []).append((hwnd, title))
    hits = _match(target, list(cands))
    if not hits:
        # no window; is it at least an installed app?
        names = {n: p for n, p in discovery()}
        installed = _match(target, list(names))
        if installed:
            return f"{installed[0]} doesn't look open right now."
        log(f"pc-control: close target '{target}' not found running or installed")
        return f"I can't find an app called {target}."
    exact = [s for s in hits if _norm(s) == _norm(target)]
    if exact:
        stem = exact[0]          # an exact name wins over fuzzy extras
    elif len(hits) == 1:
        stem = hits[0]
    else:
        show = hits[:4]
        log(f"pc-control: close '{target}' ambiguous: {show}")
        return "I see a few open apps that match: " + ", ".join(show) + ". Which one?"
    for hwnd, _t in cands[stem]:
        try:
            closer(hwnd)
        except Exception as e:
            log(f"pc-control: WM_CLOSE failed for {stem} (hwnd {hwnd}): {e}")
    log(f"pc-control: WM_CLOSE posted to {len(cands[stem])} window(s) of {stem}")
    return f"Close request sent to {stem}. If it asks about saving, choose there - I never force-close."
