// Python run over stdin: transcripts reach 60MB+, past what $.fs.read takes.
// Each mode prints one JSON value on stdout:
// Runs on macOS and Windows; stdout stays ASCII (JSON escapes) so a Windows
// console code page cannot break it.
//   index <projects> <cache>          {rows, live, platform, apps}
//   search <projects> <query>         ContentHit[]
//   rename <path> <id> <title>        {ok}
//   trash <path>                      {ok, msg}
//   open <app> <cwd> <command>        {ok, msg}
//   focus <app> <tty>                 {ok, msg}
//   pickdir                           {ok, path}
export const SCANNER = String.raw`
import json, os, shutil, subprocess, sys, time

WIN = sys.platform == "win32"

def texts(content):
    if isinstance(content, str):
        return [content]
    out = []
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                out.append(block.get("text") or "")
    return out

def prompt_of(o):
    if o.get("isMeta") or o.get("isSidechain"):
        return None
    msg = o.get("message") or {}
    if msg.get("role") != "user":
        return None
    joined = " ".join(texts(msg.get("content"))).strip()
    if not joined or joined.startswith("<"):
        return None
    return " ".join(joined.split())

def files(root):
    for proj in sorted(os.listdir(root)):
        d = os.path.join(root, proj)
        if not os.path.isdir(d):
            continue
        for name in os.listdir(d):
            p = os.path.join(d, name)
            if name.endswith(".jsonl") and os.path.isfile(p) and os.path.getsize(p) > 0:
                yield p

def scan(p):
    row = {"id": os.path.basename(p)[:-6], "path": p, "cwd": "", "title": "",
           "firstPrompt": "", "lastPrompt": "", "branch": "", "started": "", "prompts": 0}
    custom = ai = ""
    with open(p, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            head = line[:300]
            if '"custom-title"' in head or '"ai-title"' in head:
                try:
                    o = json.loads(line)
                except Exception:
                    continue
                custom = o.get("customTitle") or custom
                ai = o.get("aiTitle") or ai
                continue
            if '"type":"user"' not in line:
                continue
            try:
                o = json.loads(line)
            except Exception:
                continue
            if o.get("type") != "user":
                continue
            if not row["cwd"] and o.get("cwd"):
                row["cwd"] = o["cwd"]
                row["branch"] = o.get("gitBranch") or ""
                row["started"] = o.get("timestamp") or ""
            text = prompt_of(o)
            if text:
                row["prompts"] += 1
                if not row["firstPrompt"]:
                    row["firstPrompt"] = text[:300]
                row["lastPrompt"] = text[:300]
    row["title"] = custom or ai or row["firstPrompt"][:80] or "(untitled)"
    return row

def ps(pid, field):
    r = subprocess.run(["ps", "-o", field + "=", "-p", str(pid)], capture_output=True, text=True)
    return r.stdout.strip()

def alive(pid):
    if WIN:
        # os.kill(pid, 0) terminates the process on Windows: ask the kernel instead.
        import ctypes
        k32 = ctypes.windll.kernel32
        h = k32.OpenProcess(0x1000, False, int(pid))  # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            return False
        code = ctypes.c_ulong()
        ok = k32.GetExitCodeProcess(h, ctypes.byref(code))
        k32.CloseHandle(h)
        return bool(ok) and code.value == 259  # STILL_ACTIVE
    try:
        os.kill(int(pid), 0)
        return True
    except Exception:
        return False

def host_app(pid):
    if WIN:
        return "Windows Terminal" if os.environ.get("WT_SESSION") else "Console"
    # Walk up the parents to the terminal app the session runs in.
    for _ in range(12):
        pid = ps(pid, "ppid")
        if not pid or pid in ("0", "1"):
            return ""
        comm = ps(pid, "comm")
        for app in ("Warp", "iTerm", "Terminal"):
            if "/%s.app/" % app in comm or "/%s2.app/" % app in comm:
                return app
    return ""

def apps():
    if WIN:
        return ["Windows Terminal"] if shutil.which("wt") else ["Console"]
    found = [a for a, path in (("Warp", "/Applications/Warp.app"), ("iTerm", "/Applications/iTerm.app"))
             if os.path.isdir(path)]
    return found + ["Terminal"]

def live():
    out = {}
    d = os.path.expanduser("~/.claude/sessions")
    if not os.path.isdir(d):
        return out
    for name in os.listdir(d):
        if not name.endswith(".json"):
            continue
        try:
            with open(os.path.join(d, name), encoding="utf-8") as f:
                o = json.load(f)
        except Exception:
            continue
        if not alive(o.get("pid", 0)):
            continue
        tty = "" if WIN else ps(o["pid"], "tty")
        out[o["sessionId"]] = {"pid": o["pid"], "tty": "" if tty in ("", "??") else "/dev/" + tty,
                               "status": o.get("status") or "", "kind": o.get("kind") or "",
                               "name": o.get("name") or "", "app": host_app(o["pid"]),
                               "jobId": o.get("jobId") or ""}
    return out

def index(root, cache_path):
    try:
        with open(cache_path) as f:
            cache = json.load(f)
    except Exception:
        cache = {}
    rows, fresh = [], {}
    for p in files(root):
        st = os.stat(p)
        key = "%d:%d" % (st.st_size, int(st.st_mtime))
        hit = cache.get(p)
        row = hit["row"] if hit and hit.get("key") == key else scan(p)
        row["updated"] = int(st.st_mtime * 1000)
        row["size"] = st.st_size
        fresh[p] = {"key": key, "row": row}
        if row["cwd"]:
            rows.append(row)
    try:
        os.makedirs(os.path.dirname(cache_path), exist_ok=True)
        with open(cache_path, "w") as f:
            json.dump(fresh, f)
    except Exception:
        pass
    rows.sort(key=lambda r: -r["updated"])
    print(json.dumps({"rows": rows, "live": live(), "platform": "win" if WIN else "mac", "apps": apps()}))

def search(root, query):
    q = query.casefold()
    out = []
    for p in files(root):
        hits, snippet = 0, ""
        with open(p, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                if '"type":"user"' not in line and '"type":"assistant"' not in line:
                    continue
                if q not in line.casefold():
                    continue
                try:
                    o = json.loads(line)
                except Exception:
                    continue
                if o.get("type") not in ("user", "assistant") or o.get("isSidechain"):
                    continue
                for t in texts((o.get("message") or {}).get("content")):
                    i = t.casefold().find(q)
                    if i < 0:
                        continue
                    hits += 1
                    if not snippet:
                        s = " ".join(t[max(0, i - 40): i + len(q) + 80].split())
                        snippet = ("\u2026" if i > 40 else "") + s
        if hits:
            out.append({"id": os.path.basename(p)[:-6], "hits": hits, "snippet": snippet})
    print(json.dumps(out))

def rename(path, sid, title):
    # The same record /rename appends; the newest custom title wins.
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps({"type": "custom-title", "customTitle": title, "sessionId": sid},
                           ensure_ascii=False) + "\n")
    print(json.dumps({"ok": True}))

def powershell(script, env=None):
    r = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-STA", "-Command", script],
                       capture_output=True, text=True, env=dict(os.environ, **(env or {})))
    return r.returncode == 0, (r.stdout or r.stderr).strip()

def trash(path):
    sid = os.path.basename(path)[:-6]
    targets = [t for t in (path, os.path.join(os.path.dirname(path), sid)) if os.path.exists(t)]
    if WIN:
        # The Recycle Bin, through .NET; paths ride in env vars, never in the script.
        for t in targets:
            kind = "DeleteDirectory" if os.path.isdir(t) else "DeleteFile"
            ok, msg = powershell("Add-Type -AssemblyName Microsoft.VisualBasic; "
                                 "[Microsoft.VisualBasic.FileIO.FileSystem]::%s($env:SM_PATH, "
                                 "'OnlyErrorDialogs', 'SendToRecycleBin')" % kind, {"SM_PATH": t})
            if not ok:
                print(json.dumps({"ok": False, "msg": msg}))
                return
    else:
        bin_ = os.path.expanduser("~/.Trash")
        stamp = time.strftime("%Y%m%d-%H%M%S")
        for t in targets:
            os.rename(t, os.path.join(bin_, "%s.%s.claude" % (os.path.basename(t), stamp)))
    print(json.dumps({"ok": bool(targets), "msg": "moved %d item(s) to the trash" % len(targets)}))

def osa(lines):
    args = ["osascript"]
    for line in lines:
        args += ["-e", line]
    r = subprocess.run(args, capture_output=True, text=True)
    return r.returncode == 0, (r.stderr or r.stdout).strip()

def q(s):
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'

def open_in(app, cwd, command):
    cwd = os.path.expanduser(cwd)
    if not os.path.isdir(cwd):
        print(json.dumps({"ok": False, "msg": "no such folder: " + cwd}))
        return
    words = command.split()
    if WIN:
        # cmd /k resolves claude.cmd or claude.exe on PATH and keeps the tab open.
        if app == "Windows Terminal" and shutil.which("wt"):
            r = subprocess.run(["wt", "-w", "0", "new-tab", "-d", cwd, "cmd", "/k"] + words,
                               capture_output=True, text=True)
        else:
            r = subprocess.run(["cmd", "/c", "start", "", "/D", cwd, "cmd", "/k"] + words,
                               capture_output=True, text=True)
        ok, msg = r.returncode == 0, r.stderr.strip()
    elif app == "Warp":
        d = os.path.expanduser("~/.warp/launch_configurations")
        os.makedirs(d, exist_ok=True)
        cfg = {"name": "claude-session", "windows": [{"tabs": [{"title": command,
               "layout": {"cwd": cwd, "commands": [{"exec": command}]}}]}]}
        with open(os.path.join(d, "claude-session.yaml"), "w", encoding="utf-8") as f:
            f.write("---\n" + json.dumps(cfg) + "\n")
        r = subprocess.run(["open", "warp://launch/claude-session.yaml"], capture_output=True, text=True)
        ok, msg = r.returncode == 0, r.stderr.strip()
    else:
        shell = "cd '" + cwd.replace("'", "'\\''") + "' && " + command
        if app == "iTerm":
            ok, msg = osa(['tell application "iTerm"', "activate",
                           "set w to (create window with default profile)",
                           "tell current session of w to write text " + q(shell), "end tell"])
        else:
            ok, msg = osa(['tell application "Terminal"', "activate", "do script " + q(shell),
                           "try", "set number of columns of selected tab of front window to 170",
                           "set number of rows of selected tab of front window to 48", "end try",
                           "end tell"])
    print(json.dumps({"ok": ok, "msg": msg}))

def focus(app, tty):
    if WIN:
        # Windows Terminal cannot be told which tab holds a process.
        print(json.dumps({"ok": False, "msg": "app-only"}))
        return
    if app == "Terminal" and tty:
        ok, msg = osa(['tell application "Terminal"', "repeat with w in windows",
                       "repeat with t in tabs of w", "if tty of t is " + q(tty) + " then",
                       "set selected of t to true", "set index of w to 1", "activate",
                       'return "found"', "end if", "end repeat", "end repeat", 'return "missing"',
                       "end tell"])
        ok = ok and msg == "found"
    elif app == "iTerm" and tty:
        ok, msg = osa(['tell application "iTerm"', "repeat with w in windows",
                       "repeat with t in tabs of w", "repeat with s in sessions of t",
                       "if tty of s is " + q(tty) + " then", "select w", "select t", "select s",
                       "activate", 'return "found"', "end if", "end repeat", "end repeat",
                       "end repeat", 'return "missing"', "end tell"])
        ok = ok and msg == "found"
    else:
        r = subprocess.run(["open", "-a", app or "Terminal"], capture_output=True, text=True)
        ok, msg = r.returncode == 0, "app-only"
    print(json.dumps({"ok": ok, "msg": msg}))

def pickdir():
    if WIN:
        # An unseen, topmost owner keeps the dialog in front of the terminal.
        ok, msg = powershell("Add-Type -AssemblyName System.Windows.Forms; "
                             "$o = New-Object System.Windows.Forms.Form -Property @{TopMost=$true; ShowInTaskbar=$false}; "
                             "$d = New-Object System.Windows.Forms.FolderBrowserDialog; "
                             "$d.Description = 'Folder for the new session'; "
                             "if ($d.ShowDialog($o) -eq 'OK') { $d.SelectedPath }")
        ok = ok and bool(msg)
    else:
        ok, msg = osa(['POSIX path of (choose folder with prompt "Folder for the new session")'])
        msg = msg.rstrip("/")
    print(json.dumps({"ok": ok, "path": msg if ok else ""}))

mode, args = sys.argv[1], sys.argv[2:]
if mode == "index":
    index(os.path.expanduser(args[0]), os.path.expanduser(args[1]))
elif mode == "search":
    search(os.path.expanduser(args[0]), args[1])
elif mode == "rename":
    rename(*args)
elif mode == "trash":
    trash(args[0])
elif mode == "open":
    open_in(*args)
elif mode == "focus":
    focus(*args)
elif mode == "pickdir":
    pickdir()
`
