# Read-only check: no journal creation/deletion, elevation, or volume writes.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class StartupUsnProbe {
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
 static extern SafeFileHandle CreateFile(string p,uint a,uint s,IntPtr x,uint c,uint f,IntPtr t);
 [DllImport("kernel32.dll", SetLastError=true)]
 static extern bool DeviceIoControl(SafeFileHandle h,uint c,byte[] i,uint n,byte[] o,uint z,out uint r,IntPtr x);
 public static string Check(string drive) {
  using(var h=CreateFile(@"\\.\"+drive,0,7,IntPtr.Zero,3,0,IntPtr.Zero)) {
   var output=new byte[65536];uint count;
   if(h.IsInvalid)return drive+" open_error="+Marshal.GetLastWin32Error();
   if(!DeviceIoControl(h,590068,null,0,output,65536,out count,IntPtr.Zero))return drive+" query_error="+Marshal.GetLastWin32Error();
   var id=BitConverter.ToUInt64(output,0);var next=BitConverter.ToInt64(output,16);
   var request=new byte[48];Array.Copy(BitConverter.GetBytes(next),0,request,0,8);
   Array.Copy(BitConverter.GetBytes(uint.MaxValue),0,request,8,4);
   Array.Copy(BitConverter.GetBytes(id),0,request,32,8);request[40]=2;request[42]=3;
   bool unpriv=DeviceIoControl(h,590763,request,48,output,65536,out count,IntPtr.Zero);
   int unprivError=unpriv?0:Marshal.GetLastWin32Error();
   bool normal=DeviceIoControl(h,590011,request,48,output,65536,out count,IntPtr.Zero);
   return drive+" journal="+id+" next="+next+" unpriv_error="+unprivError+" normal_error="+(normal?0:Marshal.GetLastWin32Error());
  }
 }
}
'@
[StartupUsnProbe]::Check('C:')
[StartupUsnProbe]::Check('D:')
