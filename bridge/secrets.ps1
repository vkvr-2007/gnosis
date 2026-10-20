# Gnosis's keys in Windows Credential Manager (secrets.mjs): read several, write one, delete one.
# Each is a generic credential named "Gnosis:<NAME>" for the signed-in user. A key to write arrives on
# standard input, never on the command line; what is read goes to standard output as one JSON line,
# for the bridge only.
param(
  [Parameter(Mandatory)][ValidateSet('read', 'write', 'delete')][string]$Op,
  [string]$Names = '',
  [string]$Name = ''
)
$ErrorActionPreference = 'Stop'
Add-Type -Namespace GnosisCred -Name Store -MemberDefinition @'
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct CREDENTIAL {
  public int Flags; public int Type; public string TargetName; public string Comment;
  public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
  public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
}
[DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredRead(string target, int type, int flags, out IntPtr cred);
[DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredWrite(ref CREDENTIAL cred, int flags);
[DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredDelete(string target, int type, int flags);
[DllImport("advapi32.dll")] static extern void CredFree(IntPtr p);

public static string Read(string target) {
  IntPtr p;
  if (!CredRead(target, 1, 0, out p)) return null;
  try {
    var c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
    return c.CredentialBlobSize > 0 ? Marshal.PtrToStringUni(c.CredentialBlob, c.CredentialBlobSize / 2) : "";
  } finally { CredFree(p); }
}

public static void Write(string target, string secret) {
  var c = new CREDENTIAL();
  c.Type = 1; // generic
  c.TargetName = target;
  c.UserName = "Gnosis";
  c.Persist = 2; // this user, on this computer
  c.CredentialBlobSize = secret.Length * 2;
  c.CredentialBlob = Marshal.StringToCoTaskMemUni(secret);
  try { if (!CredWrite(ref c, 0)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
  finally { Marshal.ZeroFreeCoTaskMemUnicode(c.CredentialBlob); }
}

public static bool Delete(string target) { return CredDelete(target, 1, 0); }
'@

try {
  if ($Op -eq 'read') {
    $out = @{}
    foreach ($n in ($Names -split ',' | Where-Object { $_ })) {
      $v = [GnosisCred.Store]::Read("Gnosis:$n")
      if ($null -ne $v) { $out[$n] = $v }
    }
    $out | ConvertTo-Json -Compress
  } elseif ($Op -eq 'write') {
    $secret = [Console]::In.ReadToEnd().Trim()
    if (-not $secret) { throw 'No key was given.' }
    [GnosisCred.Store]::Write("Gnosis:$Name", $secret)
    '{"ok":true}'
  } else {
    @{ ok = [GnosisCred.Store]::Delete("Gnosis:$Name") } | ConvertTo-Json -Compress
  }
} catch {
  @{ error = "$($_.Exception.Message)" } | ConvertTo-Json -Compress
}
