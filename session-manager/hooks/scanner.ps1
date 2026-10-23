# The scanner of scanner.ts in Windows PowerShell 5.1, for a Windows machine with
# no Python (often only the Store stub of it): the same modes, arguments and JSON
# on stdout, kept ASCII (\u escapes) so the console code page cannot break it.
#   index <projects> <cache>          {rows, live, platform, apps}
#   search <projects> <query>         ContentHit[]
#   rename <path> <id> <title>        {ok}
#   trash <path>                      {ok, msg}
#   open <app> <cwd> <command>        {ok, msg}
#   focus <app> <tty>                 {ok, msg}
#   pickdir                           {ok, path}
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Web.Extensions
$json = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$json.MaxJsonLength = [int]::MaxValue
$json.RecursionLimit = 1000
$utf8 = New-Object System.Text.UTF8Encoding($false)

function ConvertTo-Ascii([string]$s) {
    [regex]::Replace($s, '[^\x00-\x7f]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })
}

# Values out of a PowerShell function come wrapped in a PSObject, which the
# serializer walks as an object of its own: hand it the plain values beneath.
function ConvertTo-Plain($value) {
    if ($null -eq $value) { return $null }
    if ($value -is [System.Management.Automation.PSObject]) { $value = $value.psobject.BaseObject }
    if ($value -is [System.Collections.IDictionary]) {
        $out = [ordered]@{}
        foreach ($key in $value.Keys) { $out[[string]$key] = ConvertTo-Plain $value[$key] }
        return $out
    }
    if ($value -is [System.Collections.IEnumerable] -and $value -isnot [string]) {
        return , [object[]]@(foreach ($item in $value) { ConvertTo-Plain $item })
    }
    $value
}

function ConvertTo-JsonText($value) { ConvertTo-Ascii $json.Serialize((ConvertTo-Plain $value)) }

function Write-Json($value) { [Console]::Out.Write((ConvertTo-JsonText $value)) }

function Expand-Home([string]$path) {
    if ($path -eq '~' -or $path.StartsWith('~/') -or $path.StartsWith('~\')) {
        $path = $env:USERPROFILE + $path.Substring(1)
    }
    [System.IO.Path]::GetFullPath($path)
}

function Get-Field($o, [string]$key) {
    # Parsed JSON is a Dictionary[string, object]; our own records are Hashtables.
    if ($o -is [System.Collections.IDictionary] -and $o.ContainsKey($key)) { $o[$key] }
}

# Cut to n UTF-16 units without leaving half of a surrogate pair.
function Get-Head([string]$s, [int]$n) {
    if ($s.Length -le $n) { return $s }
    if ([char]::IsHighSurrogate($s[$n - 1])) { $n-- }
    $s.Substring(0, $n)
}

function Get-Words([string]$s) { [regex]::Replace($s.Trim(), '\s+', ' ') }

function Read-Json([string]$line) {
    try { $json.DeserializeObject($line) } catch { $null }
}

# Each line of a transcript Claude Code may be writing to as we read.
function Get-Lines([string]$path) {
    $stream = New-Object System.IO.FileStream($path, 'Open', 'Read', 'ReadWrite, Delete')
    $reader = New-Object System.IO.StreamReader($stream, $utf8)
    try {
        while ($null -ne ($line = $reader.ReadLine())) { $line }
    } finally {
        $reader.Dispose()
    }
}

# Emits each text of a message's content, one string at a time.
function Get-Texts($content) {
    if ($content -is [string]) { return $content }
    if ($content -is [System.Array]) {
        foreach ($block in $content) {
            if ((Get-Field $block 'type') -eq 'text') { [string](Get-Field $block 'text') }
        }
    }
}

function Get-Prompt($o) {
    if ((Get-Field $o 'isMeta') -or (Get-Field $o 'isSidechain')) { return $null }
    $msg = Get-Field $o 'message'
    if ((Get-Field $msg 'role') -ne 'user') { return $null }
    $joined = (@(Get-Texts (Get-Field $msg 'content')) -join ' ').Trim()
    if (-not $joined -or $joined.StartsWith('<')) { return $null }
    Get-Words $joined
}

function Get-Transcripts([string]$root) {
    if (-not (Test-Path -LiteralPath $root -PathType Container)) { return }
    foreach ($proj in Get-ChildItem -LiteralPath $root -Directory -Force | Sort-Object Name) {
        foreach ($f in Get-ChildItem -LiteralPath $proj.FullName -File -Filter '*.jsonl' -Force) {
            if ($f.Length -gt 0) { $f }
        }
    }
}

function Get-Row([System.IO.FileInfo]$file) {
    $row = @{ id = $file.BaseName; path = $file.FullName; cwd = ''; title = ''; firstPrompt = ''
              lastPrompt = ''; branch = ''; started = ''; prompts = 0 }
    $custom = ''; $ai = ''
    foreach ($line in Get-Lines $file.FullName) {
        $head = Get-Head $line 300
        if ($head.Contains('"custom-title"') -or $head.Contains('"ai-title"')) {
            $o = Read-Json $line
            if ($o) {
                if (Get-Field $o 'customTitle') { $custom = Get-Field $o 'customTitle' }
                if (Get-Field $o 'aiTitle') { $ai = Get-Field $o 'aiTitle' }
            }
            continue
        }
        if (-not $line.Contains('"type":"user"')) { continue }
        $o = Read-Json $line
        if ((Get-Field $o 'type') -ne 'user') { continue }
        if (-not $row.cwd -and (Get-Field $o 'cwd')) {
            $row.cwd = Get-Field $o 'cwd'
            $row.branch = [string](Get-Field $o 'gitBranch')
            $row.started = [string](Get-Field $o 'timestamp')
        }
        $text = Get-Prompt $o
        if ($text) {
            $row.prompts++
            if (-not $row.firstPrompt) { $row.firstPrompt = Get-Head $text 300 }
            $row.lastPrompt = Get-Head $text 300
        }
    }
    $row.title = if ($custom) { $custom } elseif ($ai) { $ai } elseif ($row.firstPrompt) { Get-Head $row.firstPrompt 80 } else { '(untitled)' }
    $row
}

function Get-Apps {
    if (Get-Command wt -ErrorAction SilentlyContinue) { , @('Windows Terminal') } else { , @('Console') }
}

function Get-Live {
    $out = @{}
    $dir = Expand-Home '~/.claude/sessions'
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) { return $out }
    $app = if ($env:WT_SESSION) { 'Windows Terminal' } else { 'Console' }
    foreach ($f in Get-ChildItem -LiteralPath $dir -File -Filter '*.json') {
        $o = Read-Json ([System.IO.File]::ReadAllText($f.FullName, $utf8))
        $sid = Get-Field $o 'sessionId'
        $procId = Get-Field $o 'pid'
        if (-not $sid -or -not $procId) { continue }
        if (-not (Get-Process -Id $procId -ErrorAction SilentlyContinue)) { continue }
        $out[$sid] = @{ pid = $procId; tty = ''; status = [string](Get-Field $o 'status')
                        kind = [string](Get-Field $o 'kind'); name = [string](Get-Field $o 'name'); app = $app
                        jobId = [string](Get-Field $o 'jobId') }
    }
    $out
}

function Invoke-Index([string]$root, [string]$cachePath) {
    $cache = $null
    try { $cache = $json.DeserializeObject([System.IO.File]::ReadAllText($cachePath, $utf8)) } catch {}
    $rows = New-Object System.Collections.Generic.List[object]
    $fresh = @{}
    $epoch = [DateTime]::new(1970, 1, 1, 0, 0, 0, [DateTimeKind]::Utc)
    foreach ($f in Get-Transcripts $root) {
        $ms = [long][Math]::Floor(($f.LastWriteTimeUtc - $epoch).TotalMilliseconds)
        $key = '{0}:{1}' -f $f.Length, [long][Math]::Floor($ms / 1000)
        $hit = Get-Field $cache $f.FullName
        $row = if ((Get-Field $hit 'key') -eq $key) { Get-Field $hit 'row' } else { Get-Row $f }
        $row['updated'] = $ms
        $row['size'] = $f.Length
        $fresh[$f.FullName] = @{ key = $key; row = $row }
        if ($row['cwd']) { $rows.Add($row) }
    }
    try {
        [void][System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($cachePath))
        [System.IO.File]::WriteAllText($cachePath, (ConvertTo-JsonText $fresh), $utf8)
    } catch {}
    $sorted = @($rows | Sort-Object { - $_['updated'] })
    Write-Json @{ rows = $sorted; live = (Get-Live); platform = 'win'; apps = (Get-Apps) }
}

function Invoke-Search([string]$root, [string]$query) {
    $out = New-Object System.Collections.Generic.List[object]
    $ci = [StringComparison]::OrdinalIgnoreCase
    foreach ($f in Get-Transcripts $root) {
        $hits = 0; $snippet = ''
        foreach ($line in Get-Lines $f.FullName) {
            if (-not $line.Contains('"type":"user"') -and -not $line.Contains('"type":"assistant"')) { continue }
            if ($line.IndexOf($query, $ci) -lt 0) { continue }
            $o = Read-Json $line
            if ((Get-Field $o 'type') -notin 'user', 'assistant' -or (Get-Field $o 'isSidechain')) { continue }
            foreach ($t in Get-Texts (Get-Field (Get-Field $o 'message') 'content')) {
                $i = $t.IndexOf($query, $ci)
                if ($i -lt 0) { continue }
                $hits++
                if (-not $snippet) {
                    $from = [Math]::Max(0, $i - 40)
                    $s = Get-Words $t.Substring($from, [Math]::Min($t.Length, $i + $query.Length + 80) - $from)
                    $snippet = $(if ($i -gt 40) { [string][char]0x2026 } else { '' }) + $s
                }
            }
        }
        if ($hits) { $out.Add(@{ id = $f.BaseName; hits = $hits; snippet = $snippet }) }
    }
    Write-Json $out.ToArray()
}

function Invoke-Rename([string]$path, [string]$sid, [string]$title) {
    # The same record /rename appends; the newest custom title wins.
    $record = ConvertTo-JsonText ([ordered]@{ type = 'custom-title'; customTitle = $title; sessionId = $sid })
    $bytes = $utf8.GetBytes($record + "`n")
    $stream = New-Object System.IO.FileStream($path, 'Append', 'Write', 'ReadWrite, Delete')
    try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
    Write-Json @{ ok = $true }
}

function Invoke-Trash([string]$path) {
    Add-Type -AssemblyName Microsoft.VisualBasic
    $sid = [System.IO.Path]::GetFileNameWithoutExtension($path)
    $targets = @($path, (Join-Path ([System.IO.Path]::GetDirectoryName($path)) $sid)) |
        Where-Object { Test-Path -LiteralPath $_ }
    foreach ($t in $targets) {
        try {
            if (Test-Path -LiteralPath $t -PathType Container) {
                [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($t, 'OnlyErrorDialogs', 'SendToRecycleBin')
            } else {
                [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($t, 'OnlyErrorDialogs', 'SendToRecycleBin')
            }
        } catch {
            return Write-Json @{ ok = $false; msg = $_.Exception.Message }
        }
    }
    $count = @($targets).Count
    Write-Json @{ ok = [bool]$count; msg = "moved $count item(s) to the trash" }
}

function Invoke-Open([string]$app, [string]$cwd, [string]$command) {
    $cwd = Expand-Home $cwd
    if (-not (Test-Path -LiteralPath $cwd -PathType Container)) {
        return Write-Json @{ ok = $false; msg = "no such folder: $cwd" }
    }
    # Windows PowerShell does not escape a quoted argument's trailing backslash.
    $cwd = $cwd.TrimEnd('\')
    if ($cwd -match '^[A-Za-z]:$') { $cwd += '\.' }
    $words = @($command -split '\s+' | Where-Object { $_ })
    try {
        # cmd /k resolves claude.cmd or claude.exe on PATH and keeps the tab open.
        if ($app -eq 'Windows Terminal' -and (Get-Command wt -ErrorAction SilentlyContinue)) {
            $err = & wt -w 0 new-tab -d $cwd cmd /k @words 2>&1 | Out-String
            Write-Json @{ ok = ($LASTEXITCODE -eq 0); msg = $err.Trim() }
        } else {
            Start-Process cmd -ArgumentList (@('/k') + $words) -WorkingDirectory $cwd
            Write-Json @{ ok = $true; msg = '' }
        }
    } catch {
        Write-Json @{ ok = $false; msg = $_.Exception.Message }
    }
}

function Invoke-PickDir {
    Add-Type -AssemblyName System.Windows.Forms
    # An unseen, topmost owner keeps the dialog in front of the terminal.
    $owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = 'Folder for the new session'
    try {
        $picked = $dialog.ShowDialog($owner) -eq 'OK' -and $dialog.SelectedPath
        Write-Json @{ ok = [bool]$picked; path = $(if ($picked) { $dialog.SelectedPath } else { '' }) }
    } finally {
        $owner.Dispose()
    }
}

$mode = $args[0]
$rest = @($args | Select-Object -Skip 1) + @('', '', '')
switch ($mode) {
    'index' { Invoke-Index (Expand-Home $rest[0]) (Expand-Home $rest[1]) }
    'search' { Invoke-Search (Expand-Home $rest[0]) $rest[1] }
    'rename' { Invoke-Rename $rest[0] $rest[1] $rest[2] }
    'trash' { Invoke-Trash $rest[0] }
    'open' { Invoke-Open $rest[0] $rest[1] $rest[2] }
    # Windows Terminal cannot be told which tab holds a process.
    'focus' { Write-Json @{ ok = $false; msg = 'app-only' } }
    'pickdir' { Invoke-PickDir }
    default { throw "unknown mode: $mode" }
}
