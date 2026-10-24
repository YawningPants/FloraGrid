import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {resolve,join,extname} from 'node:path';
import {tmpdir} from 'node:os';
const root=process.cwd(),out=join(root,'src-tauri/target'),sleep=ms=>new Promise(done=>setTimeout(done,ms));
const only=process.argv[2]||'all';
await mkdir(out,{recursive:true});
const legacy=await readFile(join(out,'rizhi-growth-preview.html'),'utf8').catch(()=>null);
const field=await readFile(join(root,'tools/perf/flowers.html'));
const server=createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname==='/field'){res.setHeader('Content-Type','text/html;charset=utf-8');res.end(field);return}
 if(url.pathname==='/legacy'&&legacy){
  const count=Number(url.searchParams.get('n'))||100,oct=Math.max(47,Math.floor(count/10)),rest=count-oct;
  const counts=Array.from({length:12},(_,i)=>i<9?Math.floor(rest/9)+(i<rest%9?1:0):i===9?oct:0);
  res.setHeader('Content-Type','text/html;charset=utf-8');res.end(legacy.replace('const counts=[24,28,26,41,36,30,38,45,42,47,0,0];','const counts='+JSON.stringify(counts)+';'));return;
 }
 const path=resolve(root,'.'+decodeURIComponent(url.pathname));
 if(!path.startsWith(root)){res.writeHead(403).end();return}
 try{const data=await readFile(path);res.setHeader('Content-Type',({'.mjs':'text/javascript','.css':'text/css','.html':'text/html','.png':'image/png'})[extname(path)]||'application/octet-stream');res.end(data)}catch{res.writeHead(404).end()}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const origin='http://127.0.0.1:'+server.address().port,profile=await mkdtemp(join(tmpdir(),'rizhi-perf-'));
const chrome=spawn(process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',['--headless=new','--no-first-run','--disable-extensions','--disable-sync','--disable-background-networking','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
let socket,id=0;const pending=new Map(),errors=[];
const report={timestamp:new Date().toISOString(),conditions:{viewport:[1180,820],deviceScaleFactor:2,samples:5,description:'Isolated headless Chromium frontend; native idle sampled separately. Build timings include synchronous DOM/style/layout submission, not full GPU completion. JS heap is not total application RAM.'},app:[],renderers:[],legacy:[]};
const median=a=>[...a].sort((a,b)=>a-b)[Math.floor(a.length/2)],p95=a=>[...a].sort((a,b)=>a-b)[Math.min(a.length-1,Math.floor(a.length*.95))];
try{
 const endpoint=await new Promise((done,reject)=>{let data='';const timeout=setTimeout(()=>reject(Error(data)),20000);chrome.once('error',reject);chrome.stderr.on('data',d=>{data+=d;const m=data.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(m){clearTimeout(timeout);done(m[1])}})});
 socket=new WebSocket(endpoint);await new Promise(done=>socket.addEventListener('open',done,{once:true}));
 socket.addEventListener('message',e=>{const r=JSON.parse(e.data);if(r.id&&pending.has(r.id)){const p=pending.get(r.id);pending.delete(r.id);r.error?p.reject(Error(JSON.stringify(r.error))):p.done(r.result)}if(r.method==='Runtime.exceptionThrown')errors.push(r.params.exceptionDetails)});
 const call=(method,params={},sessionId)=>new Promise((done,reject)=>{const requestId=++id;pending.set(requestId,{done,reject});socket.send(JSON.stringify({id:requestId,method,params,...(sessionId?{sessionId}:{})}))});
 report.browser=await call('Browser.getVersion');const system=await call('SystemInfo.getInfo');report.gpu=system.gpu;
 const {targetId}=await call('Target.createTarget',{url:'about:blank'}),{sessionId}=await call('Target.attachToTarget',{targetId,flatten:true});
 const command=(method,params={})=>call(method,params,sessionId);
 await command('Runtime.enable');await command('Page.enable');await command('Performance.enable');
 await command('Emulation.setDeviceMetricsOverride',{width:1180,height:820,deviceScaleFactor:2,mobile:false});
 const evaluateIn=async(expression,session=sessionId,contextId)=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,...(contextId?{contextId}:{})},session);if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value};
 const evaluate=expression=>evaluateIn(expression);
 const wait=async(expression,read=evaluate)=>{for(let i=0;i<500;i++){try{if(await read(expression))return}catch{}await sleep(50)}throw Error('Timed out '+expression)};
 const metrics=async(session=sessionId)=>{await call('HeapProfiler.collectGarbage',{},session);const r=await call('Performance.getMetrics',{},session);return Object.fromEntries(r.metrics.map(m=>[m.name,m.value]))};
 await command('Page.navigate',{url:origin+'/src/index.html?view=day&date=2026-10-24'});await wait("Boolean(document.querySelector('.day-window'))");
 if(only==='completion')for(const roots of [50,200,500]){
  await evaluate("(async()=>{const storage=await import('/src/storage/day-storage.mjs');await storage.flushDaySave()})()");
  await evaluate("(()=>{const roots="+roots+",task=(id,title)=>({id,title,status:'active',tags:[{id:id+'-tag',text:'工作',color:'#8fb6d3'}],children:[]}),tasks=Array.from({length:roots},(_,i)=>{const t=task('p'+i,'样本任务 '+i);if(roots>50&&i%4===0)t.children=[task('c'+i+'a','子任务 A'),task('c'+i+'b','子任务 B')];return t});localStorage.clear();localStorage.setItem('desktop-calendar-theme',JSON.stringify({presetId:'morning',opacity:.84,appearance:'botanical',completionMotion:true}));localStorage.setItem('desktop-calendar:day:2026-10-24',JSON.stringify({date:'2026-10-24',note:'性能测试样本',tasks}))})()");
  await command('Page.reload');await wait("document.querySelectorAll('.task-row').length>="+roots);await sleep(250);
  await evaluate("document.querySelector('.task-row.is-active:not(.has-children) .status-button.active').click()");await sleep(800);
  const samples=[],totalTaskMs=[],scriptMs=[],layoutMs=[];
  const snapshot=async()=>Object.fromEntries((await command('Performance.getMetrics')).metrics.map(m=>[m.name,m.value]));
  for(let i=0;i<5;i++){
   const before=await snapshot();
   samples.push(await evaluate("(()=>{const count=document.querySelectorAll('.status-button.completed').length,start=performance.now();document.querySelector('.task-row.is-active:not(.has-children) .status-button.active').click();document.body.getBoundingClientRect();const elapsed=performance.now()-start;if(document.querySelectorAll('.status-button.completed').length!==count+1)throw Error('Completion did not happen');return elapsed})()"));
   await sleep(800);const after=await snapshot();
   totalTaskMs.push((after.TaskDuration-before.TaskDuration)*1000);scriptMs.push((after.ScriptDuration-before.ScriptDuration)*1000);layoutMs.push(((after.LayoutDuration-before.LayoutDuration)+(after.RecalcStyleDuration-before.RecalcStyleDuration))*1000);
  }
  const m=await metrics(),data=await evaluate("({tasks:document.querySelectorAll('.task-row').length,nodes:document.querySelectorAll('*').length,blooming:document.querySelectorAll('.is-blooming').length})");
  const frameIntervals=await evaluate("new Promise(done=>{const frames=[],start=performance.now();let previous;function frame(time){if(previous)frames.push(time-previous);previous=time;if(time-start>=800)done(frames);else requestAnimationFrame(frame)}requestAnimationFrame(frame);document.querySelector('.task-row.is-active:not(.has-children) .status-button.active').click()})");
  const row={...data,roots,initialMedianMs:median(samples),initialP95Ms:p95(samples),wholeCycleTaskMedianMs:median(totalTaskMs),wholeCycleScriptMedianMs:median(scriptMs),wholeCycleStyleLayoutMedianMs:median(layoutMs),frameP95Ms:p95(frameIntervals),framesOver25ms:frameIntervals.filter(t=>t>25).length,frameIntervals,samples,totalTaskMs,scriptMs,layoutMs,jsHeapMiB:m.JSHeapUsedSize/1048576};
  report.app.push(row);console.log('COMPLETION',JSON.stringify(row));
 }
 if(only==='all'||only==='app')for(const roots of [50,200,500]){
  await evaluate("(async()=>{const storage=await import('/src/storage/day-storage.mjs');await storage.flushDaySave()})()");
  await evaluate("(()=>{const roots="+roots+",task=(id,title)=>({id,title,status:'active',tags:[{id:id+'-tag',text:'工作',color:'#8fb6d3'}],children:[]}),tasks=Array.from({length:roots},(_,i)=>{const t=task('p'+i,'样本任务 '+i);if(roots>50&&i%4===0)t.children=[task('c'+i+'a','子任务 A'),task('c'+i+'b','子任务 B')];return t});localStorage.clear();localStorage.setItem('desktop-calendar:day:2026-10-24',JSON.stringify({date:'2026-10-24',note:'性能测试样本',tasks}))})()");
  await command('Page.reload');await wait("document.querySelectorAll('.task-row').length>="+roots);await sleep(250);
  await evaluate("document.querySelector('.task-row.is-active:not(.has-children) .status-button.active').click()");await sleep(250);
  const times=[];
  for(let i=0;i<5;i++){times.push(await evaluate("(()=>{const before=document.querySelectorAll('.status-button.completed').length,start=performance.now();document.querySelector('.task-row.is-active:not(.has-children) .status-button.active').click();document.body.getBoundingClientRect();const elapsed=performance.now()-start;if(document.querySelectorAll('.status-button.completed').length!==before+1)throw Error('Completion did not happen');return elapsed})()"));await sleep(250)}
  const m=await metrics(),data=await evaluate("({tasks:document.querySelectorAll('.task-row').length,nodes:document.querySelectorAll('*').length})");
  const row={...data,roots,completionMedianMs:median(times),completionP95Ms:p95(times),samples:times,jsHeapMiB:m.JSHeapUsedSize/1048576};report.app.push(row);console.log('APP',JSON.stringify(row));
 }
 await command('Page.navigate',{url:origin+'/field'});await wait("Boolean(window.bench)");
 if(only==='all'||only==='field')for(const count of [100,1000,5000])for(const method of ['svg-expanded','svg-use','img-shared','canvas-vector','canvas-sprite']){
  await evaluate("bench.render('"+method+"',"+count+")");const samples=[];let value;
  for(let i=0;i<5;i++){value=await evaluate("bench.render('"+method+"',"+count+")");samples.push(value.buildMs);await evaluate('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')}
  const m=await metrics(),dom=await command('Memory.getDOMCounters'),row={...value,buildMedianMs:median(samples),buildP95Ms:p95(samples),samples,jsHeapMiB:m.JSHeapUsedSize/1048576,domCounters:dom};report.renderers.push(row);console.log('FIELD',JSON.stringify(row));
 }
 report.frameIntervals=await evaluate("bench.frames('canvas-sprite',5000)");
 report.frames={p50Ms:median(report.frameIntervals),p95Ms:p95(report.frameIntervals),over25ms:report.frameIntervals.filter(t=>t>25).length,count:report.frameIntervals.length,description:'Static garden after draw; not an animation throughput benchmark'};
 report.bloom=[];
 for(const concurrent of [1,3,12]){const frames=await evaluate('bench.bloom('+concurrent+')');report.bloom.push({concurrent,p50Ms:median(frames),p95Ms:p95(frames),over25ms:frames.filter(t=>t>25).length,frames:frames.length});}
 if(legacy&&(only==='all'||only==='legacy'))for(const count of [100,1000,5000]){
  await command('Page.navigate',{url:origin+'/legacy?n='+count});await sleep(1200);
  let iframeTarget,frame;
  for(let i=0;i<100;i++){iframeTarget=(await call('Target.getTargets')).targetInfos.find(t=>t.type==='iframe');frame=(await command('Page.getFrameTree')).frameTree.childFrames?.[0]?.frame.id;if(iframeTarget||frame)break;await sleep(50)}
  let frameSession=sessionId,context;
  if(iframeTarget){frameSession=(await call('Target.attachToTarget',{targetId:iframeTarget.targetId,flatten:true})).sessionId;await call('Runtime.enable',{},frameSession);await call('Performance.enable',{},frameSession)}
  else context=(await command('Page.createIsolatedWorld',{frameId:frame,worldName:'perf'})).executionContextId;
  const read=e=>evaluateIn(e,frameSession,context);
  await wait("document.querySelectorAll('.rb-status svg').length===6",read);
  await read("document.querySelector('[data-period=year]').click()");await sleep(700);
  const times=[];
  for(let i=0;i<5;i++){times.push(await read("(()=>{const start=performance.now();document.querySelector('[data-layout=cards] [data-task=new-plan]').click();document.body.getBoundingClientRect();return performance.now()-start})()"));await sleep(700)}
  const m=await metrics(frameSession),data=await read("({nodes:document.querySelectorAll('*').length,flowerMarks:document.querySelectorAll('.rb-mini-plant').length,svg:document.querySelectorAll('svg').length})");
  const row={requested:count,...data,clickMedianMs:median(times),clickP95Ms:p95(times),samples:times,jsHeapMiB:m.JSHeapUsedSize/1048576};report.legacy.push(row);console.log('LEGACY',JSON.stringify(row));
 }
 report.exceptions=errors;const file='perf-flowers-report'+(only==='all'?'':'-'+only)+'.json';await writeFile(join(out,file),JSON.stringify(report,null,2));
 console.log('REPORT src-tauri/target/'+file);await call('Browser.close');
 }finally{
 socket?.close();chrome.kill();server.close();
 if(resolve(profile).startsWith(join(resolve(tmpdir()),'rizhi-perf-')))await rm(profile,{recursive:true,force:true,maxRetries:6,retryDelay:100}).catch(()=>{});
}
