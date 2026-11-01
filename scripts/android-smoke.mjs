import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import assert from "node:assert/strict";

// Run against a debug APK and a connected authorized device. All file mutations stay
// inside a newly created test directory, plus the app's own managed trash/records.
const pkg = "com.ayanami.filesweeper";
// adb shell joins arguments again on the device: quote every remote argument,
// including conflict names such as "background (1).bin".
const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const adb = (...args) => execFileSync("adb", args[0] === "shell" ? ["shell", args.slice(1).map(shellQuote).join(" ")] : args, { encoding: "utf8" }).trim();
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const output = resolve("artifacts/android");
mkdirSync(output, { recursive: true });
const local = mkdtempSync(join(tmpdir(), "filesweeper-mvp-"));
const remote = `/storage/emulated/0/Download/FileSweeper-MVP-Test-${Date.now()}`;
mkdirSync(join(local, "target"));
mkdirSync(join(local, "nomedia", "child"), { recursive: true });
writeFileSync(join(local, "nomedia", ".nomedia"), "", "utf8");
writeFileSync(join(local, ".hidden.txt"), "hidden fixture", "utf8");
writeFileSync(join(local, "01-note.txt"), "FileSweeper Android MVP\n简体中文文件预览测试。\n只在独立测试目录中操作。\n", "utf8");
writeFileSync(join(local, "05-delete-me.txt"), "recover this file", "utf8");
writeFileSync(join(local, "06-move-me.txt"), "move this file", "utf8");
writeFileSync(join(local, "07-code.json"), JSON.stringify({ name: "FileSweeper", platform: "Android" }, null, 2), "utf8");
const wav = Buffer.alloc(44 + 16000);
wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(16000, 40);
writeFileSync(join(local, "04-audio.wav"), wav);
function crc32(buffer) { let crc = -1; for (const byte of buffer) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (crc ^ -1) >>> 0; }
function chunk(type, data) { const name = Buffer.from(type); const size = Buffer.alloc(4); size.writeUInt32BE(data.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([name,data]))); return Buffer.concat([size,name,data,crc]); }
const width = 480, height = 240, pixels = Buffer.alloc(height * (1 + width * 3));
for (let y=0;y<height;y++) for (let x=0;x<width;x++) { const offset = y*(1+width*3)+1+x*3; pixels[offset]=45+Math.floor(x/4); pixels[offset+1]=105+Math.floor(y/3); pixels[offset+2]=130; }
const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height,4); header[8]=8; header[9]=2;
writeFileSync(join(local, "02-image.png"), Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",header),chunk("IDAT",deflateSync(pixels)),chunk("IEND",Buffer.alloc(0))]));
writeFileSync(join(local, "nomedia", "child", "image.png"), Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",header),chunk("IDAT",deflateSync(pixels)),chunk("IEND",Buffer.alloc(0))]));
writeFileSync(join(local, "nomedia", "child", "note.txt"), "text stays visible", "utf8");
const stream = "BT /F1 24 Tf 40 740 Td (FileSweeper Android MVP) Tj 0 -45 Td /F1 14 Tf (PDF preview smoke test) Tj ET";
const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
let pdf = "%PDF-1.4\n", offsets = [0]; objects.forEach((object,index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index+1} 0 obj\n${object}\nendobj\n`; }); const xref = Buffer.byteLength(pdf); pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset)=>`${String(offset).padStart(10,"0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
writeFileSync(join(local, "03-document.pdf"), pdf);
let videoFixture = false;
try {
  execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=480x240:rate=24", "-t", "12", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", join(local,"08-video.mp4")]);
  videoFixture = true;
} catch { console.log("本机无可用 FFmpeg，跳过测试视频生成；应用本身不依赖 FFmpeg。"); }
adb("shell", "mkdir", "-p", remote);
execFileSync("adb", ["push", `${local}/.`, remote], { stdio: "inherit" });
// adb push does not preserve empty fixture directories.
adb("shell", "mkdir", "-p", `${remote}/target`);
adb("shell", "appops", "set", pkg, "MANAGE_EXTERNAL_STORAGE", "allow");
// OEMs may prohibit shell permission grants. Let the normal in-app notification
// request obtain user consent instead of trying to bypass those device settings.
adb("shell", "am", "start", "-n", `${pkg}/.MainActivity`);
await delay(1500);

let socket, serial = 0;
const pending = new Map();
async function connect() {
  const pid = adb("shell", "pidof", pkg).split(" ")[0];
  adb("forward", "tcp:9222", `localabstract:webview_devtools_remote_${pid}`);
  let pages = [];
  for (let attempt=0;attempt<30;attempt++) { try { pages = await (await fetch("http://127.0.0.1:9222/json")).json(); if (pages.some((page)=>page.type==="page")) break; } catch {} await delay(300); }
  const page = pages.find((target)=>target.type==="page");
  if (!page) throw new Error("未找到可调试的 WebView");
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((done,reject)=>{ socket.addEventListener("open",done,{once:true}); socket.addEventListener("error",reject,{once:true}); });
  socket.addEventListener("message",(event)=>{ const message=JSON.parse(event.data); if (pending.has(message.id)) { const {resolve,reject,timer}=pending.get(message.id); clearTimeout(timer); pending.delete(message.id); if(message.error)reject(new Error(JSON.stringify(message.error))); else resolve(message.result); } });
}
async function cdp(method, params) { const id=++serial; const result=new Promise((resolve,reject)=>{ const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`CDP timeout: ${method}`));},20000);pending.set(id,{resolve,reject,timer}); });socket.send(JSON.stringify({id,method,params}));return result; }
async function evaluate(expression) { const result=await cdp("Runtime.evaluate",{expression,awaitPromise:true,returnByValue:true}); if(result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result?.value; }
const native = (command,payload={}) => evaluate(`window.__TAURI_INTERNALS__.invoke("mobile_call",${JSON.stringify({command,payload})})`);
async function waitFor(expression) { for(let i=0;i<40;i++){ if(await evaluate(expression))return; await delay(200); } throw new Error(`UI did not settle: ${expression}`); }
const click = async (label) => {
  const selector = `button[aria-label=${JSON.stringify(label)}]`;
  if (!await evaluate(`!!document.querySelector(${JSON.stringify(selector)})`)) {
    await evaluate(`{ const list = document.querySelector('.mobile-file-scroll'); if(list) list.scrollTop = list.scrollHeight; }`);
    await delay(150);
  }
  if (!await evaluate(`!!document.querySelector(${JSON.stringify(selector)})`)) {
    await evaluate(`{ const list = document.querySelector('.mobile-file-scroll'); if(list) list.scrollTop = 0; }`);
  }
  await waitFor(`!!document.querySelector(${JSON.stringify(selector)})`);
  return evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
};
const results=[];
const pass=(name,detail)=>{results.push({name,detail});console.log(`PASS ${name}${detail?`: ${detail}`:""}`);};
async function task(request) { const started=await native("startTask",request); for(let i=0;i<80;i++){const {tasks}=await native("tasks");const current=tasks.find((entry)=>entry.id===started.id);if(current&&!['queued','running'].includes(current.state)){assert.equal(current.state,"completed",JSON.stringify(current));return current;}await delay(150);}throw new Error(`任务超时: ${started.id}`); }
await connect();
const originalPreferences = (await native("storageState")).preferences;
try {
await native("savePreferences", { rememberWorkspaceFocus: true, showHiddenItems: false, showNomediaMedia: false, autoplay: true, trashEnabled: true });
await evaluate(`localStorage.setItem("mobile.lastPath",${JSON.stringify(remote)}); localStorage.setItem("mobile.previewOpen","true"); localStorage.removeItem("mobile.selected"); setTimeout(() => location.reload(), 50); true;`);
await delay(400);
await waitFor(`!!document.querySelector('button[aria-label="01-note.txt"]')`);
pass("真实目录浏览与权限",remote);
await click("01-note.txt");
await waitFor(`document.querySelector('.text-preview')?.textContent.includes('简体中文文件预览测试')`);
pass("文本与中文预览");
await click("收起预览"); await click("02-image.png");
assert.equal(await evaluate(`!!document.querySelector('.mobile-preview.is-collapsed') && document.querySelector('.mobile-preview-body').hidden`),true);
pass("收起后选文件不自动展开");
await click("展开预览");
await waitFor(`!!document.querySelector('.image-preview img')?.naturalWidth`);
pass("图片与本地预览流");
await click("全屏预览");
await waitFor(`!!document.querySelector('.is-fullscreen')`);
await click("退出全屏");
pass("全屏进入与恢复");
await click("03-document.pdf");
await waitFor(`!!document.querySelector('.pdf-preview canvas')`);
pass("PDF Worker 与页面渲染");
await click("04-audio.wav"); await delay(600);
const log=adb("shell","run-as",pkg,"cat","files/logs/mobile.log");
assert.match(log,/Native media prepared/);
pass("原生音频播放器接入");
if (videoFixture) {
  await click("08-video.mp4");
  for (let attempt=0;attempt<30;attempt++) { const media=await native("mediaState"); if(media.error)throw new Error(media.error);if(media.state===3)break;await delay(200); }
  assert.equal((await native("mediaState")).state,3);
  assert.equal((await native("mediaState")).playing,true, "请解锁手机并将应用保持前台");
  assert.equal((await native("mediaState")).controlsEmbedded,false);
  assert.equal(await evaluate(`document.querySelector('.mobile-media-controls')?.parentElement === document.querySelector('.mobile-preview')`),true);
  writeFileSync(join(output,"player-device.png"),execFileSync("adb",["exec-out","screencap","-p"]));
  pass("视频自动播放与外置控制条");
  await click("暂停"); await delay(400);
  assert.equal((await native("mediaState")).playing,false);
  await click("播放"); await delay(400);
  assert.equal((await native("mediaState")).playing,true);
  pass("外置播放与暂停");
  await click("设置");
  await evaluate(`document.querySelectorAll('.mobile-settings details')[1].open = true; document.querySelector('input[aria-label="切换文件自动播放"]').click();`);
  await delay(500);
  assert.equal((await native("storageState")).preferences.autoplay,false);
  await click("关闭");
  await click("04-audio.wav"); await click("08-video.mp4"); await delay(500);
  assert.equal((await native("mediaState")).playing,false);
  pass("关闭自动播放后切换文件保持暂停");
}
await click("收起预览");
assert.equal((await native("mediaState")).playing,false);
await click("展开预览"); await delay(400);
assert.equal((await native("mediaState")).playing,false);
await click("收起预览");
pass("收起与展开不自动续播");

let filtered = await native("listDirectory", { path: `${remote}/nomedia/child` });
assert.equal(filtered.mediaSuppressed,true); assert.deepEqual(filtered.items.map((item)=>item.name),["note.txt"]);
await native("savePreferences", { showNomediaMedia: true });
filtered = await native("listDirectory", { path: `${remote}/nomedia/child` });
assert.equal(filtered.mediaSuppressed,false); assert.ok(filtered.items.some((item)=>item.name==="image.png"));
await native("savePreferences", { showHiddenItems: true });
assert.ok((await native("listDirectory",{path:remote})).items.some((item)=>item.name===".hidden.txt"));
pass("隐藏文件与祖先 .nomedia 过滤设置");
let rejected = false;
try { await native("savePreferences", { volume: 200 }); } catch { rejected = true; }
assert.equal(rejected,true);
await native("savePreferences", { appearance: "light", accentTheme: "amber", imageMaxMegapixels: 32 });
await evaluate(`window.dispatchEvent(new Event('mobile-resume')); true;`); await delay(400);
assert.equal(await evaluate(`getComputedStyle(document.querySelector('.mobile-app')).colorScheme`),"light");
pass("主题即时生效与设置边界校验");
const imported = await native("importBackground", { path: `${remote}/02-image.png` });
assert.equal(imported.preferences.backgroundImage,"wallpaper");
await evaluate(`window.dispatchEvent(new Event('mobile-resume')); true;`);
await waitFor(`!!document.querySelector('.mobile-wallpaper')`);
assert.equal(await evaluate(`fetch(getComputedStyle(document.querySelector('.mobile-wallpaper')).backgroundImage.slice(5,-2)).then(response => response.ok)`),true);
writeFileSync(join(output,"background-device.png"),execFileSync("adb",["exec-out","screencap","-p"]));
pass("背景导入、私有副本与本地背景加载");
const extensions = (await native("storageState")).preferences.textExtensions;
await native("savePreferences", { textExtensions: extensions.filter((value)=>value!=="txt") });
assert.equal((await native("listDirectory",{path:remote})).items.find((item)=>item.name==="01-note.txt").kind,"other");
await native("savePreferences", { textExtensions: extensions });
pass("扩展名设置参与真实文件分类");

const copy = await task({operation:"copy",paths:[`${remote}/01-note.txt`],destination:`${remote}/target`});
assert.equal(adb("shell","cat",`${remote}/target/01-note.txt`).includes("简体中文"),true);
pass("复制与持久化任务",copy.id);
const originalInode=adb("shell","stat","-c","%i",`${remote}/05-delete-me.txt`);
const recycled=await task({operation:"trash",paths:[`${remote}/05-delete-me.txt`]});
assert.equal(adb("shell","stat","-c","%i",recycled.items[0].destination),originalInode);
pass("回收站同卷移动", "inode 保持一致，无完整内容复制");
const entries=await native("trash"); const entry=entries.items.find((item)=>item.originalPath===`${remote}/05-delete-me.txt`);assert.ok(entry);
await task({operation:"restore",trashId:entry.id});
assert.equal(adb("shell","cat",`${remote}/05-delete-me.txt`),"recover this file");
pass("回收站恢复");
await task({operation:"move",paths:[`${remote}/06-move-me.txt`],destination:`${remote}/target`});
assert.equal(adb("shell","cat",`${remote}/target/06-move-me.txt`),"move this file");
pass("移动与目标提交");
await native("savePreferences",{trashEnabled:false});
assert.equal((await native("storageState")).preferences.trashEnabled,false);
await native("savePreferences",{trashEnabled:true});
pass("回收站设置持久化");
if (process.env.ANDROID_SMOKE_TASKS === "true") {
  const source = `${remote}/background.bin`;
  adb("shell", "dd", "if=/dev/zero", `of=${source}`, "bs=1048576", "count=96");
  const started = await native("startTask", { operation: "copy", paths: [source], destination: `${remote}/target` });
  assert.match(adb("shell", "dumpsys", "notification"), /channel=file-operations/);
  adb("shell", "am", "start", "-a", "android.intent.action.MAIN", "-c", "android.intent.category.HOME");
  await delay(300);
  const backgroundVisibility = await evaluate(`document.visibilityState`);
  assert.equal(backgroundVisibility,"hidden");
  let completed;
  for (let i=0;i<150;i++) { completed=(await native("tasks")).tasks.find((item)=>item.id===started.id);if(!["queued","running"].includes(completed.state))break;await delay(200); }
  assert.equal(completed.state,"completed",JSON.stringify(completed));
  assert.equal(completed.transferredBytes,96*1024*1024);
  pass("通知发布与应用后台复制", "96 MiB 复制在 Activity 隐藏期间完成");
  adb("shell", "am", "start", "-n", `${pkg}/.MainActivity`); await delay(500);
  const interrupted = await native("startTask", { operation: "copy", paths: [source], destination: `${remote}/target` });
  adb("shell", "am", "force-stop", pkg);
  socket.close();
  adb("shell", "am", "start", "-n", `${pkg}/.MainActivity`); await delay(1000);
  await connect();
  const record = (await native("tasks")).tasks.find((item)=>item.id===interrupted.id);
  assert.equal(record.state,"interrupted",JSON.stringify(record));
  await native("resumeTask",{id:record.id});
  let resumed;
  for(let i=0;i<150;i++) { resumed=(await native("tasks")).tasks.find((item)=>item.id===record.id);if(!["queued","running"].includes(resumed.state))break;await delay(200); }
  assert.equal(resumed.state,"completed",JSON.stringify(resumed));
  const persisted=JSON.parse(adb("shell","run-as",pkg,"cat",`files/tasks/${resumed.id}.json`));
  assert.equal(persisted.state,"completed");assert.equal(persisted.resumeCount,1);
  assert.equal(adb("shell","sha256sum",source).split(" ")[0],adb("shell","sha256sum",resumed.items[0].destination).split(" ")[0]);
  pass("强制停止后核对恢复", "任务记录恢复、目标 SHA-256 与源一致");
  await task({operation:"delete",paths:[source,completed.items[0].destination,resumed.items[0].destination],confirmed:true});
  pass("永久删除确认与测试大文件清理");
}
await native("savePreferences",originalPreferences);
await evaluate(`window.dispatchEvent(new Event('mobile-resume')); true;`); await delay(400);
await click("刷新目录");
await delay(500);
await click("02-image.png"); await click("展开预览");
await waitFor(`!!document.querySelector('.image-preview img')?.naturalWidth`);
writeFileSync(join(output,"mvp-device.png"),execFileSync("adb",["exec-out","screencap","-p"]));
writeFileSync(join(output,"smoke-results.json"),JSON.stringify({device:adb("shell","getprop","ro.product.model"),android:adb("shell","getprop","ro.build.version.release"),testDirectory:remote,results},null,2),"utf8");
console.log(`验证结果：${join(output,"smoke-results.json")}`);
} finally {
  // Leave the user's settings intact even if an assertion or OEM permission UI fails.
  try { await native("savePreferences", originalPreferences); await evaluate(`window.dispatchEvent(new Event('mobile-resume')); true;`); }
  finally { socket.close(); }
}
