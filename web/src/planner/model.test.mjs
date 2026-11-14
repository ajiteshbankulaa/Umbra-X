import test from 'node:test'
import assert from 'node:assert/strict'
import { analyze, arrayEfficiency, countdown, intervals, diskFraction, horizonAt, storage, defaultPower, costTradeoff, searchObserver } from './model.ts'

test('horizon interpolates across north and finite solar disk crosses smoothly',()=>{
  const h=new Float32Array(360)
  h[359]=2
  assert.equal(horizonAt(h,359.5),1)
  assert.equal(diskFraction(-1),0)
  assert.equal(diskFraction(0),.5)
  assert.equal(diskFraction(1),1)
})
test('events are half-open and identify clipped mission boundaries',()=>{
  assert.deepEqual(intervals([true,false,true,true],.5),[
    {start:0,end:1,hours:.5,atStart:true,atEnd:false},
    {start:2,end:4,hours:1,atStart:false,atEnd:true},
  ])
  assert.deepEqual(intervals([false],1),[])
})
test('storage can recharge and the discharge cap flags intrinsically unmet load',()=>{
  const simple={...defaultPower,loadW:95}
  assert.equal(storage([0,400,0],simple,1).usableWh,100)
  assert.equal(storage([0],{...simple,loadW:400},1).unmetWh,100)
  assert.equal(storage([0],{...simple,budgetKg:20},1).unmetWh,95)
})
test('cost deltas use supplied rates and identify a break-even point',()=>{
  assert.deepEqual(costTradeoff(10,100,5),{breakEven:10,avoided:-50})
  assert.deepEqual(costTradeoff(10,100,20),{breakEven:10,avoided:100})
  assert.equal(costTradeoff(10,100,null).avoided,null)
})
test('station elevation can fail while Earth center is clear; all-window search excludes missing coverage',()=>{
  const observer={coordinates:[0,0,0],mast:0,slope:1,horizon:new Float32Array(360),
    reference:new Float32Array(360),distance:new Float32Array(360),coverage:new Uint8Array(360).fill(1)}
  const vectors=new Float64Array(25*12)
  for(let i=0;i<25;i++) vectors.set([1e8,0,0,1e8,0,0,1e8,0,0,1,0,0],i*12)
  const m={count:25,stepMinutes:5,station:{maskDeg:10}}
  const r=analyze(observer,vectors,0,12,m,defaultPower)
  assert.equal(r.earthHours,1)
  assert.equal(r.stationHours,0)
  assert.deepEqual(searchObserver(observer,vectors,12,m,{dark:0,earth:0,slope:5}),[0,12])
  observer.coverage.fill(0)
  assert.deepEqual(searchObserver(observer,vectors,12,m,{dark:0,earth:0,slope:5}),[])
})

test('a second array reduces unmet load, but hardware and losses can undo the mass benefit',async()=>{
  const {complementaryPower}=await import('./model.ts')
  const p={...defaultPower,loadW:95,hardwareKg:0,budgetKg:0}
  const help=complementaryPower([0],[125],p,125,.8,0,1)
  assert.equal(help.avoidedUnmetWh,95)
  const penalty=complementaryPower([0],[125],p,125,.1,10,1)
  assert.ok(penalty.installedMassDeltaKg>0)
})

test('countdown reports exact hours to next sunset/Earthset or sunrise/Earthrise',()=>{
  const states=[false,false,true,true,true,false]
  assert.deepEqual(countdown(states,0,.5),{visible:true,hoursRemaining:1,nextIndex:2,persistsToEnd:false})
  assert.deepEqual(countdown(states,2,.5),{visible:false,hoursRemaining:1.5,nextIndex:5,persistsToEnd:false})
  assert.deepEqual(countdown(states,5,.5),{visible:true,hoursRemaining:.5,nextIndex:null,persistsToEnd:true})
})

test('array geometry models polar grazing cosine losses vs equatorial overhead Sun',()=>{
  assert.equal(arrayEfficiency(1.5,'tracked'),1)
  assert.ok(arrayEfficiency(1.5,'vertical')>0.999)
  assert.ok(arrayEfficiency(1.5,'horizontal')<0.03)
  assert.ok(arrayEfficiency(90,'horizontal')>0.999)

  const observer={coordinates:[0,0,0],mast:0,slope:1,horizon:new Float32Array(360),
    reference:new Float32Array(360),distance:new Float32Array(360),coverage:new Uint8Array(360).fill(1)}
  const vectors=new Float64Array(13*12)
  const r=1e8, el=1.5*Math.PI/180
  for(let i=0;i<13;i++) vectors.set([r*Math.sin(el),0,r*Math.cos(el),r,0,0,r,0,0,1,0,0],i*12)
  const m={count:13,stepMinutes:5,station:{maskDeg:10}}
  const vert=analyze(observer,vectors,0,12,m,{...defaultPower,arrayMode:'vertical'})
  const horiz=analyze(observer,vectors,0,12,m,{...defaultPower,arrayMode:'horizontal'})
  assert.ok(vert.generation[0]>395)
  assert.ok(horiz.generation[0]<15)
})

test('horizon uncertainty sigma reduces effective sky margin and increases dark/blackout hours',()=>{
  const observer={coordinates:[0,0,0],mast:0,slope:1,horizon:new Float32Array(360),
    reference:new Float32Array(360),horizonError:new Float32Array(360).fill(2),
    distance:new Float32Array(360),coverage:new Uint8Array(360).fill(1)}
  const vectors=new Float64Array(13*12)
  const r=1e8, el=1.0*Math.PI/180
  for(let i=0;i<13;i++) vectors.set([r*Math.sin(el),0,r*Math.cos(el),r*Math.sin(el),0,r*Math.cos(el),r,0,0,1,0,0],i*12)
  const m={count:13,stepMinutes:5,station:{maskDeg:10}}
  const nominal=analyze(observer,vectors,0,12,m,{...defaultPower,sigma:0})
  const conservative=analyze(observer,vectors,0,12,m,{...defaultPower,sigma:1})
  assert.equal(nominal.solarHours,1)
  assert.equal(nominal.earthHours,1)
  assert.equal(conservative.solarHours,0)
  assert.equal(conservative.earthHours,0)
})
