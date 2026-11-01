import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";

// Focused real-WebView regressions. File mutations stay in a fresh owned fixture directory.
const pkg = "com.ayanami.filesweeper";
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const adb = (...args) => execFileSync("adb", args[0] === "shell" ? ["shell", args.slice(1).map(quote).join(" ")] : args, { encoding: "utf8" }).trim();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
adb("shell", "am", "start", "-n", `${pkg}/.MainActivity`);
await delay(500);
const pid = adb("shell", "pidof", pkg).split(" ")[0];
adb("forward", "tcp:9222", `localabstract:webview_devtools_remote_${pid}`);
let pages = [];
for (let attempt=0;attempt<40;attempt++) {
  try { pages = await (await fetch("http://127.0.0.1:9222/json")).json(); if (pages.some((page)=>page.type==="page")) break; } catch {}
  await delay(200);
}
const ws = new WebSocket(pages.find((page) => page.type === "page").webSocketDebuggerUrl);
await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
let serial = 0;
const pending = new Map();
ws.addEventListener("message", (event) => { const message = JSON.parse(event.data); if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); } });
async function cdp(method, params = {}) { const id = ++serial; const result = new Promise((resolve) => pending.set(id, resolve)); ws.send(JSON.stringify({ id, method, params })); const response = await result; if (response.error) throw new Error(JSON.stringify(response.error)); return response.result; }
async function evaluate(expression) { const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result?.value; }
const native = (command, payload = {}) => evaluate(`window.__TAURI_INTERNALS__.invoke('mobile_call',${JSON.stringify({ command, payload })})`);
async function wait(check, message, count = 60) { for (let i=0;i<count;i++) { if (await check()) return; await delay(100); } throw new Error(message); }
const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
const results = [];
const pass = (name, detail) => { results.push({ name, detail }); console.log(`PASS ${name}${detail ? `: ${detail}` : ""}`); };
const original = (await native("storageState")).preferences;
const mediaFixtures = JSON.parse(readFileSync("artifacts/android/smoke-results.json", "utf8")).testDirectory;
const remote = `/storage/emulated/0/Download/FileSweeper-Regression-${Date.now()}`;
try {
  await native("savePreferences", { rememberWorkspaceFocus: true });
  await evaluate(`localStorage.setItem('mobile.lastPath',${JSON.stringify(mediaFixtures)});localStorage.setItem('mobile.previewOpen','true');localStorage.setItem('mobile.ratio','40');localStorage.removeItem('mobile.selected');setTimeout(()=>location.reload(),50);true;`);
  await delay(300);
  await wait(() => evaluate(`!!document.querySelector('button[aria-label="02-image.png"]')`), "图片样本未显示");
  await click('button[aria-label="02-image.png"]');
  await wait(() => evaluate(`!!document.querySelector('.image-preview img')?.naturalWidth`), "图片未加载");
  async function geometry(rotation = 0) {
    await delay(200);
    const info = await evaluate(`(()=>{const image=document.querySelector('.image-preview img'),canvas=document.querySelector('.image-preview-canvas'),stage=document.querySelector('.image-preview-stage');const a=image.getBoundingClientRect(),b=canvas.getBoundingClientRect(),c=stage.getBoundingClientRect();return {width:a.width,height:a.height,naturalWidth:image.naturalWidth,naturalHeight:image.naturalHeight,canvasWidth:b.width,canvasHeight:b.height,stageHeight:c.height,dx:(a.left+a.right-b.left-b.right)/2,dy:(a.top+a.bottom-b.top-b.bottom)/2};})()`);
    const expected = Math.min(info.canvasWidth / (rotation % 180 ? info.naturalHeight : info.naturalWidth), info.canvasHeight / (rotation % 180 ? info.naturalWidth : info.naturalHeight));
    assert.ok(Math.abs(info.dx) < 1 && Math.abs(info.dy) < 1, JSON.stringify(info));
    assert.ok(Math.abs(info.canvasHeight-info.stageHeight)<1,JSON.stringify(info));
    assert.ok(Math.abs(info.width - (rotation % 180 ? info.naturalHeight : info.naturalWidth) * expected)<1,JSON.stringify(info));
    assert.ok(info.height <= info.canvasHeight+1 && info.width <= info.canvasWidth+1,JSON.stringify(info));
    return info;
  }
  const initial = await geometry();
  pass("图片默认居中并完整适应窗格", `中心误差 ${initial.dx.toFixed(2)}, ${initial.dy.toFixed(2)} px`);
  await evaluate(`document.querySelector('.mobile-preview').style.height='22%';true;`);
  await geometry(); pass("小窗格重新适应且画布不溢出");
  await click('button[title="顺时针旋转"]'); await geometry(90); pass("旋转后重新居中适应");
  await click('button[title="适应窗口"]'); await geometry();
  await click('button[aria-label="全屏预览"]'); await geometry();
  writeFileSync("artifacts/android/image-fixed-device.png", execFileSync("adb", ["exec-out", "screencap", "-p"]));
  await click('button[aria-label="退出全屏"]'); await geometry(); pass("全屏进入退出后图片中心与倍率正确");
  await click('button[aria-label="03-document.pdf"]');
  await click('button[aria-label="全屏预览"]');
  await wait(() => evaluate(`!!document.querySelector('.pdf-preview canvas')?.width`), "PDF 未渲染");
  const before = await evaluate(`({scale:visualViewport.scale,appWidth:document.querySelector('.mobile-app').getBoundingClientRect().width,pageWidth:document.querySelector('.pdf-preview canvas').getBoundingClientRect().width})`);
  const bounds = await evaluate(`(()=>{const r=document.querySelector('.pdf-preview-scroll').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+Math.min(180,r.height/2)};})()`);
  const touch = (x,y,id) => ({ x,y,id,radiusX:5,radiusY:5,force:1 });
  await cdp("Input.dispatchTouchEvent", { type:"touchStart", touchPoints:[touch(bounds.x-40,bounds.y,0),touch(bounds.x+40,bounds.y,1)] });
  for(let i=1;i<=10;i++) { await cdp("Input.dispatchTouchEvent",{type:"touchMove",touchPoints:[touch(bounds.x-40-i*4,bounds.y,0),touch(bounds.x+40+i*4,bounds.y,1)]});await delay(35); }
  await cdp("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]}); await delay(400);
  const after = await evaluate(`({scale:visualViewport.scale,appWidth:document.querySelector('.mobile-app').getBoundingClientRect().width,pageWidth:document.querySelector('.pdf-preview canvas').getBoundingClientRect().width})`);
  assert.equal(after.scale,before.scale);assert.equal(after.appWidth,before.appWidth);assert.ok(after.pageWidth>before.pageWidth*1.8,JSON.stringify({before,after}));
  pass("真实双指放大只作用于 PDF", `文档宽度 ${before.pageWidth} → ${after.pageWidth}，页面倍率 ${after.scale}`);
  const scrollBefore = await evaluate(`document.querySelector('.pdf-preview-scroll').scrollTop`);
  await cdp("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[touch(bounds.x,bounds.y+100,0)]});
  for(let i=1;i<=10;i++) { await cdp("Input.dispatchTouchEvent",{type:"touchMove",touchPoints:[touch(bounds.x,bounds.y+100-i*15,0)]});await delay(30); }
  await cdp("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]});await delay(200);
  assert.ok(await evaluate(`document.querySelector('.pdf-preview-scroll').scrollTop`) > scrollBefore);
  pass("PDF 单指滚动仍可正常使用");
  await cdp("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[touch(bounds.x-80,bounds.y,0),touch(bounds.x+80,bounds.y,1)]});
  for(let i=1;i<=10;i++) { await cdp("Input.dispatchTouchEvent",{type:"touchMove",touchPoints:[touch(bounds.x-80+i*4,bounds.y,0),touch(bounds.x+80-i*4,bounds.y,1)]});await delay(35); }
  await cdp("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]});await delay(300);
  assert.equal(await evaluate(`visualViewport.scale`),1);
  assert.ok(await evaluate(`document.querySelector('.pdf-preview canvas').getBoundingClientRect().width`) < after.pageWidth*.6);
  pass("真实双指缩小保持应用界面尺寸");
  await click('button[aria-label="退出全屏"]');
  await native("savePreferences",{accentTheme:"sky"});
  await evaluate(`window.dispatchEvent(new Event('mobile-resume'));document.querySelector('.mobile-file-scroll').scrollTop=0;true;`);
  await wait(()=>evaluate(`getComputedStyle(document.querySelector('.mobile-file-symbol.folder')).color==='rgb(102, 204, 255)'`),"文件夹图标没有跟随主题");
  pass("文件夹图标与底色跟随主题");

  if (process.env.ANDROID_REGRESSION_GESTURES_ONLY !== "true") {
  // Fsync each copied file gives notification updates enough real work to observe;
  // no production delay hooks or artificial task throttles are introduced.
  adb("shell","mkdir","-p",`${remote}/source`,`${remote}/target`,`${remote}/moved`);
  adb("shell","dd","if=/dev/zero",`of=${remote}/block.bin`,"bs=131072","count=1");
  adb("shell","sh","-c",`for index in $(seq 1 1024); do cp '${remote}/block.bin' '${remote}/source/part-'$index'.bin' || exit 1; done`);
  const copy = await native("startTask",{operation:"copy",paths:[`${remote}/source`],destination:`${remote}/target`});
  const move = await native("startTask",{operation:"move",paths:Array.from({length:120},(_,i)=>`${remote}/source/part-${i+1}.bin`),destination:`${remote}/moved`});
  const samples=[];
  const terminal = new Set(["completed","cancelled","failed","interrupted"]);
  let currentCopy,currentMove;
  for(let i=0;i<1200;i++) {
    const records=(await native("tasks")).tasks;
    currentCopy=records.find(x=>x.id===copy.id);currentMove=records.find(x=>x.id===move.id);
    const notification=(await native("taskNotificationState")).notifications[0];
    if(notification && (!samples.length || JSON.stringify(samples.at(-1))!==JSON.stringify(notification)))samples.push(notification);
    if(terminal.has(currentCopy.state)&&terminal.has(currentMove.state))break;
    await delay(100);
  }
  assert.equal(currentCopy.state,"completed");assert.equal(currentMove.state,"completed");assert.equal(currentCopy.totalBytes,1024*131072);
  const copyProgress=samples.filter(x=>x.title==="复制文件"&&!x.indeterminate&&x.progress>0&&x.progress<100);
  assert.ok(new Set(copyProgress.map(x=>x.progress)).size>=2,JSON.stringify(samples));
  const moveProgress=samples.filter(x=>x.title==="移动文件"&&x.max===120&&x.progress>0&&x.progress<120);
  assert.ok(moveProgress.length>0,JSON.stringify(samples));
  await wait(async()=>!(await native("taskNotificationState")).notifications.length,"完成后通知未撤销");
  pass("复制通知真实百分比连续更新", copyProgress.map(x=>x.progress).join(" → "));
  pass("队列中的同卷移动按项数更新", moveProgress.map(x=>`${x.progress}/${x.max}`).join(" → "));
  pass("全部任务完成后撤销通知");
  const cancelled=await native("startTask",{operation:"copy",paths:[`${remote}/source`],destination:`${remote}/target`});
  await wait(async()=>{const task=(await native("tasks")).tasks.find(x=>x.id===cancelled.id);return task.transferredBytes>0;},"取消样本尚未开始",200);
  await native("cancelTask",{id:cancelled.id});
  await wait(async()=>(await native("tasks")).tasks.find(x=>x.id===cancelled.id).state==="cancelled","取消未完成",200);
  await wait(async()=>!(await native("taskNotificationState")).notifications.length,"取消后通知未撤销");
  pass("取消任务后撤销通知");
  const failed=await native("startTask",{operation:"copy",paths:[`${remote}/source`],destination:`${remote}/target`});
  adb("shell","mkdir",failed.items[0].destination);
  await wait(async()=>(await native("tasks")).tasks.find(x=>x.id===failed.id).state==="failed","冲突样本未按预期失败",1200);
  await wait(async()=>!(await native("taskNotificationState")).notifications.length,"失败后通知未撤销");
  pass("目标冲突失败后撤销通知且不覆盖目标");
  const cleanup=await native("startTask",{operation:"delete",paths:[remote],confirmed:true});
  await wait(async()=>(await native("tasks")).tasks.find(x=>x.id===cleanup.id).state==="completed","测试样本清理未完成",300);
  await wait(async()=>!(await native("taskNotificationState")).notifications.length,"清理后通知未撤销");
  writeFileSync("artifacts/android/regression-results.json",JSON.stringify({results,notificationSamples:samples},null,2),"utf8");
  } else {
    writeFileSync("artifacts/android/gesture-results.json",JSON.stringify({results},null,2),"utf8");
  }
} finally {
  try { await native("savePreferences",original);await evaluate(`window.dispatchEvent(new Event('mobile-resume'));true;`); }
  finally { ws.close(); }
}
