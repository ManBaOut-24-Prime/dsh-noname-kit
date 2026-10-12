param([Parameter(Mandatory=$true)][string]$RequestFile)
$ErrorActionPreference='Stop'
$request=Get-Content -LiteralPath $RequestFile -Raw -Encoding UTF8 | ConvertFrom-Json
$root=[IO.Path]::GetFullPath($request.root).TrimEnd('\')
$section=[Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Group
$everyone=[Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$streams=[Collections.Generic.List[IO.FileStream]]::new()
$guarded=[Collections.Generic.List[object]]::new()
$acquired=$false;$failure=$null
function Reply($file,$value){$tmp=$file+'.tmp';[IO.File]::WriteAllText($tmp,(ConvertTo-Json -Compress $value),[Text.UTF8Encoding]::new($false));[IO.File]::Move($tmp,$file)}
function CheckedPath($value){$p=[IO.Path]::GetFullPath($value);if(-not $p.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Publication path escape'};return $p}
function Restore($entry,$file){
    $acl=if($entry.isDirectory){[IO.Directory]::GetAccessControl($file,$section)}else{[IO.File]::GetAccessControl($file,$section)}
    $desired=[Security.AccessControl.RawSecurityDescriptor]::new($entry.sddl)
    if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $desired.Owner.Value){$acl.SetOwner($desired.Owner)}
    if($acl.GetGroup([Security.Principal.SecurityIdentifier]).Value -ne $desired.Group.Value){$acl.SetGroup($desired.Group)}
    $acl.SetSecurityDescriptorSddlForm($entry.sddl,[Security.AccessControl.AccessControlSections]::Access)
    if($entry.isDirectory){[IO.Directory]::SetAccessControl($file,$acl)}else{[IO.File]::SetAccessControl($file,$acl)}
}
$hash=[Security.Cryptography.SHA256]::Create()
try{$name='Local\NNK-Batch-ACL-'+([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($root.ToLowerInvariant())))).Replace('-','')}finally{$hash.Dispose()}
$mutex=[Threading.Mutex]::new($false,$name)
try{
    try{$acquired=$mutex.WaitOne(120000)}catch [Threading.AbandonedMutexException]{$acquired=$true}
    if(-not $acquired){throw 'Previous ACL operation is busy'}
    $parent=[Diagnostics.Process]::GetProcessById($request.pid)
    if($parent.StartTime.ToUniversalTime().Ticks.ToString() -ne $request.born){throw 'Publication owner changed'}
    $expected=[Collections.Generic.Dictionary[string,object]]::new([StringComparer]::Ordinal)
    foreach($entry in $request.entries){
        $file=CheckedPath $entry.path;$item=Get-Item -LiteralPath $file -Force
        if($item.Attributes -band [IO.FileAttributes]::ReparsePoint -or [bool]$item.PSIsContainer -ne [bool]$entry.isDirectory){throw 'Publication file type changed'}
        if(-not $entry.rootOnly){$expected.Add($file,$entry)}
        if(-not $entry.isDirectory){
            # Reject existing writers before hashing; explicit ACLs below take
            # over write/path protection before these handles are released.
            $stream=[IO.File]::Open($file,[IO.FileMode]::Open,[IO.FileAccess]::Read,([IO.FileShare]::Read -bor [IO.FileShare]::Delete));$streams.Add($stream)
            if($stream.Length -ne $entry.size){throw 'Publication file size changed'}
            $h=[Security.Cryptography.SHA256]::Create()
            try{$digest=([BitConverter]::ToString($h.ComputeHash($stream))).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()}
            if($digest -ne $entry.sha256){throw 'Publication file SHA-256 changed'}
        }
    }
    foreach($entry in $request.entries){
        $file=CheckedPath $entry.path
        $acl=if($entry.isDirectory){[IO.Directory]::GetAccessControl($file,$section)}else{[IO.File]::GetAccessControl($file,$section)}
        $rights=[Security.AccessControl.FileSystemRights]::WriteData -bor [Security.AccessControl.FileSystemRights]::AppendData -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles
        if(-not $entry.isRoot){$rights=$rights -bor [Security.AccessControl.FileSystemRights]::Delete}
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($everyone,$rights,[Security.AccessControl.AccessControlType]::Deny))
        $guarded.Add($entry)
        if($entry.isDirectory){[IO.Directory]::SetAccessControl($file,$acl)}else{[IO.File]::SetAccessControl($file,$acl)}
    }
    # Enumerate after guards: no unchecked paths can be added or replaced before publication.
    $stack=[Collections.Generic.Stack[string]]::new();foreach($p in $request.roots){$stack.Push((CheckedPath $p))}
    while($stack.Count){$p=$stack.Pop();if(-not $expected.Remove($p)){throw 'Publication inventory changed'};foreach($child in [IO.Directory]::GetFileSystemEntries($p)){
        $item=Get-Item -LiteralPath $child -Force;if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Publication reparse point'}
        if($item.PSIsContainer){$stack.Push($child)}elseif(-not $expected.Remove($child)){throw 'Unexpected publication file'}
    }}
    if($expected.Count){throw 'Publication inventory is incomplete'}
    # Windows may reject an ancestor move while descendants have open handles,
    # even with Delete sharing. Guards now exclude new writers and path changes.
    foreach($stream in $streams){$stream.Dispose()};$streams.Clear()
    Reply $request.ready @{ok=$true}
    while([IO.File]::ReadAllBytes($request.control)[0] -ne 1){
        try{$parent.Refresh();if($parent.HasExited -or $parent.StartTime.ToUniversalTime().Ticks.ToString() -ne $request.born){break}}catch [ArgumentException]{break}catch [InvalidOperationException]{break}
        Start-Sleep -Milliseconds 50
    }
}catch{
    $failure=$_.Exception.Message
    if(-not [IO.File]::Exists($request.ready)){Reply $request.ready @{ok=$false;error=$failure}}
}finally{
    try{
        $base=if([IO.Directory]::Exists($request.from)){$request.from}else{$request.to}
        # Keep the outer directory guarded until all child permissions are restored.
        foreach($entry in ($guarded | Sort-Object {[int]$_.isRoot})){
            $file=$base+$entry.path.Substring($request.from.Length);Restore $entry (CheckedPath $file)
        }
    }catch{$failure=$_.Exception.Message}
    foreach($stream in $streams){$stream.Dispose()}
    if($acquired){$mutex.ReleaseMutex()};$mutex.Dispose()
    Reply $request.done @{ok=($null -eq $failure);error=$failure}
}
