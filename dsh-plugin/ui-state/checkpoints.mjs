// Coalesce input changes and bound complete draft captures. No DOM freeze,
// business writes, automatic restore, or terminal operations happen here.
export function createDraftCheckpoints({capture,save,blocked=()=>false,delay=2500,interval=30_000,maximum=60_000,
  captureTimeout=20_000,now=Date.now,schedule=setTimeout,cancel=clearTimeout,onStatus=()=>{}}) {
  let dirty=false,disposed=false,running=false,revision=0,first=0,last=0,timer,lastAttempt=null,controller
  const arm=()=>{
    cancel(timer);timer=undefined
    if(!dirty || disposed || running)return
    const at=Math.max(lastAttempt===null ? 0 : lastAttempt+interval,Math.min(last+delay,first+maximum))
    timer=schedule(run,Math.max(0,at-now()))
  }
  const run=async()=>{
    timer=undefined
    if(disposed || !dirty || running)return
    if(blocked()) {last=now();timer=schedule(run,delay);return}
    running=true;lastAttempt=now();controller=new AbortController();const active=controller,claimed=revision
    let deadline,aborted,timedOut=false
    try {
      const stopped=new Promise((_,reject)=>{
        aborted=()=>reject(Error(timedOut ? 'snapshot-capture-timeout' : 'snapshot-capture-cancelled'))
        active.signal.addEventListener('abort',aborted,{once:true})
        deadline=schedule(()=>{timedOut=true;active.abort()},captureTimeout)
      })
      // Blob readers and third-party interfaces may ignore AbortSignal. A
      // cancelled/expired capture must still release this scheduler's slot.
      const payload=await Promise.race([capture(active.signal),stopped])
      cancel(deadline);active.signal.removeEventListener('abort',aborted)
      if(disposed || active.signal.aborted || blocked() || claimed!==revision)return
      const result=await save(payload)
      // Count from acknowledgement: capture and IPC latency would otherwise
      // make the next attempt arrive just before the native 30-second bound.
      lastAttempt=now()
      if(disposed || active.signal.aborted)return
      if(claimed===revision)dirty=false
      onStatus({savedAt:result?.savedAt || now(),error:null})
    } catch(error) {
      if(!disposed && (!active.signal.aborted || timedOut)) {
        onStatus({savedAt:0,error:/^[a-z0-9-]{1,80}$/.test(String(error?.message ?? error)) ? String(error?.message ?? error) : 'recovery-save-failed'})
      }
    } finally {cancel(deadline);active.signal.removeEventListener('abort',aborted);running=false;if(controller===active)controller=undefined;arm()}
  }
  return {
    changed() {if(disposed)return;revision++;last=now();if(!dirty)first=last;dirty=true;arm()},
    suspend() {controller?.abort();if(dirty){last=now();arm()}},
    dispose() {disposed=true;cancel(timer);controller?.abort()},
  }
}
