param([Parameter(Mandatory=$true)][string]$RequestFile)
$ErrorActionPreference = 'Stop'
$request = Get-Content -LiteralPath $RequestFile -Raw -Encoding UTF8 | ConvertFrom-Json
$root = [IO.Path]::GetFullPath($request.root).TrimEnd('\')
$testBase = if ($env:NNK_TEST_ROOT) { [IO.Path]::GetFullPath($env:NNK_TEST_ROOT) } else { Join-Path ([IO.Path]::GetTempPath()) 'noname-kit-tests' }
if ($testBase.StartsWith('\\')) { throw 'Test root must use a local drive' }
if ([IO.Path]::GetFileName($testBase.TrimEnd('\')) -notmatch '^(noname-kit-tests?|nnk-tests?)([-_].*)?$') { throw 'Dedicated test root required' }
foreach ($marker in @('noname.js','game/game.js','resources/app/noname.js','resources/app/src/noname.js')) { if (Test-Path -LiteralPath (Join-Path $testBase $marker)) { throw 'Test base is a game installation' } }
$allowed = [IO.Path]::GetFullPath((Join-Path $testBase 'temp')).TrimEnd('\') + '\'
if (-not $root.StartsWith($allowed, [StringComparison]::OrdinalIgnoreCase)) { throw 'Probe outside test root' }
$cursor = $root
while ($cursor) {
  if (Test-Path -LiteralPath $cursor) { if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Test path traverses a reparse point' } }
  $parent = [IO.Path]::GetDirectoryName($cursor)
  if ($parent -eq $cursor) { break }; $cursor = $parent
}
$everyone = [Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$section = [Security.AccessControl.AccessControlSections]::Access
$result = @()
function InvokeOperations {
$result = @()
foreach ($entry in $request.entries) {
    $file = [IO.Path]::GetFullPath($entry.path)
    if ($file -ne $root -and -not $file.StartsWith($root+'\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Path escape' }
    if ((Get-Item -LiteralPath $file -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse point' }
    $acl = if ($entry.isDirectory) { [IO.Directory]::GetAccessControl($file,$section) } else { [IO.File]::GetAccessControl($file,$section) }
    if ($request.mode -eq 'capture') {
        $result += @{path=$file; isDirectory=[bool]$entry.isDirectory; isRoot=[bool]$entry.isRoot; sddl=$acl.GetSecurityDescriptorSddlForm($section)}
    } elseif ($request.mode -eq 'guard') {
        # Explicit rule on EVERY entry, including protected child DACLs. A parent
        # inheritance rule alone can be bypassed by protected child permissions.
        $rights = [Security.AccessControl.FileSystemRights]::WriteData -bor [Security.AccessControl.FileSystemRights]::AppendData -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles
        if (-not $entry.isDirectory) { $rights = $rights -bor [Security.AccessControl.FileSystemRights]::ReadData }
        if (-not $entry.isRoot) { $rights = $rights -bor [Security.AccessControl.FileSystemRights]::Delete }
        $rule = [Security.AccessControl.FileSystemAccessRule]::new($everyone,$rights,[Security.AccessControl.AccessControlType]::Deny)
        $acl.AddAccessRule($rule)
        if ($entry.isDirectory) { [IO.Directory]::SetAccessControl($file,$acl) } else { [IO.File]::SetAccessControl($file,$acl) }
    } elseif ($request.mode -eq 'restore') {
        $acl.SetSecurityDescriptorSddlForm($entry.sddl,$section)
        if ($entry.isDirectory) { [IO.Directory]::SetAccessControl($file,$acl) } else { [IO.File]::SetAccessControl($file,$acl) }
    } else { throw 'Invalid mode' }
}
if ($request.mode -eq 'capture') { ConvertTo-Json -InputObject $result -Depth 8 -Compress }
}
if ($request.mode -eq 'freeze') {
    $streams = [Collections.Generic.List[IO.FileStream]]::new()
    try {
        # Reject pre-existing writers, then hold read handles excluding Write until
        # all ACL guards are installed. Closing them then permits directory renames.
        foreach ($entry in $request.entries) {
            if (-not $entry.isDirectory) {
                $file = [IO.Path]::GetFullPath($entry.path)
                if (-not $file.StartsWith($root+'\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Path escape' }
                $stream = [IO.File]::Open($file,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
                $streams.Add($stream)
                $hash = [Security.Cryptography.SHA256]::Create()
                try { $actual = ([BitConverter]::ToString($hash.ComputeHash($stream))).Replace('-','').ToLowerInvariant() } finally { $hash.Dispose() }
                if ($actual -ne $entry.sha256) { throw 'Payload changed before freeze' }
            }
        }
        $request.mode = 'guard'
        InvokeOperations
    } finally { foreach ($stream in $streams) { $stream.Dispose() } }
} else { InvokeOperations }
