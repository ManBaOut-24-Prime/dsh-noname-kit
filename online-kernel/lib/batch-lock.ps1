param([Parameter(Mandatory=$true)][string]$RequestFile)
$ErrorActionPreference = 'Stop'
$request = Get-Content -LiteralPath $RequestFile -Raw -Encoding UTF8 | ConvertFrom-Json
$stream = $null
function PublishReply($value) {
    if ([IO.File]::Exists($request.ready)) { return }
    $temporary = $request.ready+'.tmp'
    [IO.File]::WriteAllText($temporary,(ConvertTo-Json -Compress -Depth 4 $value),[Text.UTF8Encoding]::new($false))
    [IO.File]::Move($temporary,$request.ready)
}
try {
    $drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($request.root))
    if ($drive.DriveFormat -ne 'NTFS') {
        if ($request.ordinary) { PublishReply @{ok=$true;unsupported=$true}; return }
        throw 'Only verified NTFS isolation is supported'
    }
    $parent = [Diagnostics.Process]::GetProcessById($request.pid)
    $started = $parent.StartTime.ToUniversalTime().Ticks
    $deadline = [DateTime]::UtcNow.AddMilliseconds(3000)
    do {
        try { $stream = [IO.File]::Open($request.lock,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None) }
        catch [IO.IOException] { if ([DateTime]::UtcNow -ge $deadline) { throw 'Batch filesystem lease is busy' }; Start-Sleep -Milliseconds 50 }
    } until ($null -ne $stream)
    # The lease spans receiving, publication and recovery. Kernel/process exit
    # releases it without a stale filesystem lock requiring unsafe deletion.
    $ownerAlive = $false
    $ownerId = $null
    if ([IO.File]::Exists($request.active)) {
        $owner = [IO.File]::ReadAllText($request.active,[Text.Encoding]::UTF8) | ConvertFrom-Json
        $ownerId = $owner.id
        try {
            $recorded = [Diagnostics.Process]::GetProcessById($owner.pid)
            $ownerAlive = -not $recorded.HasExited -and (-not $owner.born -or $recorded.StartTime.ToUniversalTime().Ticks.ToString() -eq $owner.born)
        } catch [ArgumentException] { $ownerAlive = $false }
          catch [InvalidOperationException] { $ownerAlive = $false }
          catch [ComponentModel.Win32Exception] { $ownerAlive = $true }
    }
    $reply = @{ok=$true;started=$started.ToString();ownerAlive=$ownerAlive;ownerId=$ownerId;ownerReleased=($null -ne $owner -and $owner.released -is [bool] -and $owner.released)}
    PublishReply $reply
    while ($true) {
        if ($request.control -and [IO.File]::ReadAllBytes($request.control)[0] -eq 1) { break }
        try {
            $parent.Refresh()
            if ($parent.HasExited -or $parent.StartTime.ToUniversalTime().Ticks -ne $started) { break }
        } catch [ArgumentException] { break } catch [InvalidOperationException] { break }
        Start-Sleep -Milliseconds 100
    }
} catch {
    PublishReply @{ok=$false;error=$_.Exception.Message}
} finally {
    if ($null -ne $stream) { $stream.Dispose() }
    if ($request.done) { [IO.File]::WriteAllText($request.done,'closed',[Text.UTF8Encoding]::new($false)) }
}
