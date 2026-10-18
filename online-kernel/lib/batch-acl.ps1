param([Parameter(Mandatory=$true)][string]$RequestFile)
$ErrorActionPreference = 'Stop'
$request = Get-Content -LiteralPath $RequestFile -Raw -Encoding UTF8 | ConvertFrom-Json
$root = [IO.Path]::GetFullPath($request.root).TrimEnd('\')
if ($root.Length -lt 4 -or $root -eq [IO.Path]::GetPathRoot($root).TrimEnd('\')) { throw 'Unsafe transaction root' }
$everyone = [Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$section = [Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Group
$accessOnly = [Security.AccessControl.AccessControlSections]::Access
$result = @()
if ($request.mode -eq 'preflight') {
    # Request only access rights: opening a handle does not alter ACLs or ownership.
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Globalization;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class NNKBatchAclPreflight {
    [StructLayout(LayoutKind.Sequential)]
    private struct Information {
        public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh;
        public uint WriteLow, WriteHigh, Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle file, out Information information);
    public static void Check(string path, string expected, bool directory) {
        ulong identity;
        if (!UInt64.TryParse(expected, NumberStyles.None, CultureInfo.InvariantCulture, out identity)) throw new InvalidOperationException("Invalid preflight identity");
        // READ_CONTROL | WRITE_DAC, all sharing, OPEN_EXISTING,
        // FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT.
        using (SafeFileHandle file=CreateFile(path, 0x00060000, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {
            if (file.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), "Publication preflight requires READ_CONTROL | WRITE_DAC: "+path);
            Information actual;
            if (!GetFileInformationByHandle(file, out actual)) throw new Win32Exception(Marshal.GetLastWin32Error());
            ulong index=((ulong)actual.IndexHigh << 32) | actual.IndexLow;
            if ((actual.Attributes & 0x400)!=0 || ((actual.Attributes & 0x10)!=0)!=directory || index!=identity || (!directory && actual.Links!=1)) throw new InvalidOperationException("Publication preflight identity or file type changed: "+path);
        }
    }
}
'@
}
function InvokeOperations {
$result = @()
$completed = 0
foreach ($entry in $request.entries) {
    $file = [IO.Path]::GetFullPath($entry.path)
    if ($file -ne $root -and -not $file.StartsWith($root+'\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Path escape' }
    if ((Get-Item -LiteralPath $file -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse point' }
    if ($request.mode -eq 'preflight') {
        # OPEN_REPARSE_POINT checks the leaf; reject linked ancestors as well.
        $ancestor = $file
        while ($true) {
            if ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse ancestor' }
            if ($ancestor -eq $root) { break }
            $ancestor = [IO.Path]::GetDirectoryName($ancestor)
            if (-not $ancestor) { throw 'Path escape' }
        }
        [NNKBatchAclPreflight]::Check($file, [string]$entry.ino, [bool]$entry.isDirectory)
        continue
    }
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
        $desired = [Security.AccessControl.RawSecurityDescriptor]::new($entry.sddl)
        if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $desired.Owner.Value) { $acl.SetOwner($desired.Owner) }
        if ($acl.GetGroup([Security.Principal.SecurityIdentifier]).Value -ne $desired.Group.Value) { $acl.SetGroup($desired.Group) }
        $acl.SetSecurityDescriptorSddlForm($entry.sddl,$accessOnly)
        if ($entry.isDirectory) { [IO.Directory]::SetAccessControl($file,$acl) } else { [IO.File]::SetAccessControl($file,$acl) }
    } else { throw 'Invalid mode' }
    $completed++
    if ($request.failAfter -gt 0 -and $completed -eq $request.failAfter) { throw 'Injected ACL interruption' }
}
if ($request.mode -eq 'capture') { ConvertTo-Json -InputObject $result -Depth 8 -Compress }
}
$hashName = [Security.Cryptography.SHA256]::Create()
try { $lockName = 'Local\NNK-Batch-ACL-' + ([BitConverter]::ToString($hashName.ComputeHash([Text.Encoding]::UTF8.GetBytes($root.ToLowerInvariant())))).Replace('-','') } finally { $hashName.Dispose() }
$mutex = [Threading.Mutex]::new($false,$lockName)
$acquired = $false
try {
    # A parent can crash while this helper is still running. Recovery waits for
    # the previous ACL operation to stop before restoring any saved permissions.
    try { $acquired = $mutex.WaitOne(120000) } catch [Threading.AbandonedMutexException] { $acquired = $true }
    if (-not $acquired) { throw 'Previous filesystem isolation operation is busy' }
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
} finally { if ($acquired) { $mutex.ReleaseMutex() }; $mutex.Dispose() }
