import { dataset, observer, polarSites } from './data'
import { analyze, searchObserver } from './model'
import type { Limits, Power, Scenario } from './model'
export type Request = {id:number; days:number; power:Power; limits:Limits} &
  ({kind:'compare'; scenarios:[Scenario,Scenario]} | {kind:'search'; mast:number; version:string})
let activeSearch=0
const cache = new Map<string, ReturnType<typeof analyze>>()
self.onmessage = async ({data:request}: MessageEvent<Request | {kind:'cancel'}>) => {
  if (request.kind==='cancel') { activeSearch++; return }
  const ticket=++activeSearch
  try {
    const steps=request.days*24*12
    if (request.kind==='compare') {
      const items=await Promise.all(request.scenarios.map(async s=>{
        const bundle=await dataset(s.site)
        const pad=observer(bundle,s)
        const key=JSON.stringify([bundle.meta.vectorHash,bundle.meta.localHash,s,steps,request.power])
        let report=cache.get(key)
        if (!report) {
          report=analyze(pad,bundle.vectors,s.start*12,steps,bundle.meta,request.power)
          if (cache.size>=12) cache.delete(cache.keys().next().value!)
          cache.set(key,report)
        }
        const mastSensitivity=bundle.site ? [0,4].map(mast=>{
          const variant=observer(bundle,{...s,mast})
          const result=analyze(variant,bundle.vectors,s.start*12,steps,bundle.meta,request.power)
          return {height:variant.mast,lowLight:result.longestDark,earth:result.longestEarth,complete:result.complete}
        }) : []
        return {report,pad,meta:bundle.meta,terrain:bundle.site,mastSensitivity}
      }))
      self.postMessage({id:request.id,kind:'compare',items})
      return
    }
    let count=0
    const options: {scenario:Scenario; slope:number; starts:number}[]=[]
    for (const site of polarSites) {
      const bundle=await dataset(site)
      if (!bundle.meta.vectorHash.startsWith(request.version)) throw new Error('Search data version mismatch.')
      for (let node=0;node<961;node++) {
        if (node%24===0) {
          await new Promise(resolve=>setTimeout(resolve,0))
          if (ticket!==activeSearch) return
          self.postMessage({id:request.id,kind:'progress',site,node})
        }
        const scenario={site,node,mast:request.mast,start:0}
        const pad=observer(bundle,scenario)
        if (pad.slope==null || pad.slope>request.limits.slope || !bundle.meta.regional) continue
        const sigma=request.power.sigma??0
        const windows=searchObserver(pad,bundle.vectors,steps,bundle.meta,request.limits,sigma)
        const referenceWindows=new Set(searchObserver({...pad,horizon:pad.reference},bundle.vectors,steps,bundle.meta,request.limits,sigma))
        const stable=windows.filter(start=>referenceWindows.has(start))
        if (stable.length) {
          count+=stable.length
          options.push({scenario:{...scenario,start:stable[0]/12},slope:pad.slope,starts:stable.length})
        }
      }
    }
    options.sort((a,b)=>a.scenario.start-b.scenario.start || a.slope-b.slope)
    self.postMessage({id:request.id,kind:'search',count,options:options.slice(0,12)})
  } catch (e) {
    self.postMessage({id:request.id,kind:'error',message:e instanceof Error?e.message:String(e)})
  }
}
