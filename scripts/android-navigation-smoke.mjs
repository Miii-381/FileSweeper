import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const pkg = "com.ayanami.filesweeper";
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const adb = (...args) => execFileSync("adb", args[0] === "shell" ? ["shell", args.slice(1).map(quote).join(" ")] : args, { encoding: "utf8" }).trim();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let ws, serial = 0;
const pending = new Map();
async function connect() {
  adb("shell", "am", "start", "-n", `${pkg}/.MainActivity`);
  await delay(500);
  adb("forward", "tcp:9222", `localabstract:webview_devtools_remote_${adb("shell", "pidof", pkg).split(" ")[0]}`);
  let pages;
  for (let i = 0; i < 60; i++) { try { pages = await (await fetch("http://127.0.0.1:9222/json")).json(); if (pages.some((p) => p.type === "page")) break; } catch {} await delay(100); }
  ws = new WebSocket(pages.find((p) => p.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
  ws.addEventListener("message", (event) => { const message = JSON.parse(event.data); if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); } });
  await wait(() => evaluate(`!!window.__TAURI_INTERNALS__?.invoke && !!document.querySelector('[aria-label="打开位置"]')`), "应用未就绪");
}
async function evaluate(expression) {
  const id = ++serial;
  const response = new Promise((resolve) => pending.set(id, resolve));
  ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
  const result = await response;
  if (result.error || result.result.exceptionDetails) throw new Error(JSON.stringify(result));
  return result.result.result?.value;
}
const native = (command, payload = {}) => evaluate(`window.__TAURI_INTERNALS__.invoke('mobile_call',${JSON.stringify({ command, payload })})`);
async function wait(check, message, count = 100) {
  for (let i = 0; i < count; i++) {
    try { if (await check()) return; }
    catch (error) { if (!String(error).includes("Inspected target navigated or closed")) throw error; }
    await delay(100);
  }
  throw new Error(message);
}
const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
const button = (name, scope = "document") => evaluate(`(()=>{const root=${scope};const b=[...root.querySelectorAll('button')].find(b=>(b.innerText.trim()===${JSON.stringify(name)}||b.querySelector("strong")?.innerText===${JSON.stringify(name)}));if(!b||b.disabled)throw Error('Button unavailable');b.click();return true;})()`);
const input = (label, value) => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(`[aria-label="${label}"]`)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
async function selectFile(name) { await input("搜索当前目录", name); await wait(() => evaluate(`!!document.querySelector(${JSON.stringify(`.mobile-workspace button[aria-label="${name}"]`)})`), "文件未显示"); await click(`.mobile-workspace button[aria-label="${name}"]`); await delay(100); }
const results = [];
const pass = (name) => { results.push(name); console.log(`PASS ${name}`); };
const local = mkdtempSync(join(tmpdir(), "filesweeper-navigation-"));
const remote = `/storage/emulated/0/Download/FileSweeper-Navigation-Test-${Date.now()}`;
await connect();
const original = (await native("storageState")).preferences;
const oldState = await evaluate(`Object.fromEntries(Object.keys(localStorage).filter(k=>k.startsWith('mobile.')).map(k=>[k,localStorage.getItem(k)]))`);
async function finish(id) {
  let task;
  await wait(async () => { task = (await native("tasks")).tasks.find((t) => t.id === id); return task && !["queued", "running"].includes(task.state); }, "任务未结束");
  assert.equal(task.state, "completed", JSON.stringify(task));
}
async function favorite(name) {
  await click('[aria-label="打开位置"]');
  await button(name, "document.querySelector('.mobile-locations')");
  await delay(200);
}
try {
  mkdirSync(join(local, "A")); mkdirSync(join(local, "B"));
  for (const directory of ["A", "B"]) for (let i = 0; i < 70; i++) writeFileSync(join(local, directory, `${String(i).padStart(3, "0")}.txt`), "x".repeat(i + 1), "utf8");
  execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "color=c=teal:size=320x180:rate=10", "-t", "60", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(local, "A", "clip.mp4")]);
  execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=8000", "-t", "60", join(local, "A", "tone.wav")]);
  adb("shell", "mkdir", "-p", remote); execFileSync("adb", ["push", `${local}/.`, remote], { stdio: "ignore" });
  // Stop the current page's unload writer before supplying a fresh test workspace.
  await native("savePreferences", { rememberWorkspaceFocus: false });
  await evaluate(`window.dispatchEvent(new Event('mobile-resume'));true;`);
  await wait(() => evaluate(`localStorage.getItem('mobile.workspaces')===null`), "未暂停原页面的记忆写入");
  await native("savePreferences", { rememberWorkspaceFocus: true, autoplay: false, trashEnabled: true, holdPlaybackSpeed: 3 });
  await evaluate(`localStorage.setItem('mobile.lastPath',${JSON.stringify(`${remote}/A`)});localStorage.removeItem('mobile.selected');localStorage.setItem('mobile.workspaces','{}');localStorage.setItem('mobile.favorites','[]');localStorage.setItem('mobile.previewOpen','true');setTimeout(()=>location.reload(),50);true;`);
  await delay(300); await wait(() => evaluate(`localStorage.getItem('mobile.lastPath')===${JSON.stringify(`${remote}/A`)} && !!document.querySelector('[aria-label="搜索当前目录"]')`), "工作区未加载");
  await selectFile("050.txt"); await click('[aria-label="跳转到当前焦点"]');
  await wait(() => evaluate(`document.querySelector('[aria-label="搜索当前目录"]').value==='' && !!document.querySelector('.mobile-file[aria-pressed="true"]')`), "焦点跳转未完成");
  const visibleFocus = await evaluate(`(()=>{const a=document.querySelector('.mobile-file[aria-pressed="true"]').getBoundingClientRect(),b=document.querySelector('.mobile-file-scroll').getBoundingClientRect();return a.top>=b.top-1 && a.bottom<=b.bottom+1;})()`);
  assert.ok(visibleFocus); pass("顶栏焦点跳转清除搜索并把所选文件滚动到可见位置");
  await evaluate(`(()=>{const e=document.querySelector('[aria-label="排序"]');e.value='size';e.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
  await click('[aria-label="网格视图"]');
  await click('[aria-label="打开位置"]'); await click('[aria-label="添加喜好路径"]');
  await input("喜好路径名称", "测试 A"); await button("保存喜好路径");
  await wait(() => evaluate(`!!document.querySelector('[aria-label="编辑喜好路径 测试 A"]')`), "自定义喜好路径未保存");
  await click('[aria-label="添加喜好路径"]'); await input("喜好路径名称", "测试 B"); await button("浏览选择目录");
  await button("上一级", "document.querySelectorAll('.mobile-sheet')[1]");
  await wait(() => evaluate(`!![...document.querySelectorAll('.mobile-picker-list button')].find(b=>b.innerText.trim()==='B')`), "目录选择器未加载 B");
  await button("B", "document.querySelector('.mobile-picker-list')"); await delay(100); await button("选择此目录", "document.querySelectorAll('.mobile-sheet')[1]");
  assert.equal(await evaluate(`document.querySelector('[aria-label="喜好路径名称"]').value`), "测试 B");
  await button("保存喜好路径");
  await wait(() => evaluate(`!!document.querySelector('[aria-label="编辑喜好路径 测试 B"]')`), "浏览添加喜好路径未保存");
  pass("喜好路径支持自定义名称、浏览添加并保留编辑内容");
  await button("测试 B", "document.querySelector('.mobile-locations')");
  await wait(() => evaluate(`localStorage.getItem('mobile.lastPath')===${JSON.stringify(`${remote}/B`)}`), "B 目录未切换完成");
  await selectFile("010.txt"); await click('[aria-label="跳转到当前焦点"]');
  await favorite("测试 A");
  await wait(() => evaluate(`document.querySelector('.mobile-preview-heading').innerText.includes('050.txt')`), "切回 A 后未恢复焦点");
  assert.match(await evaluate(`document.querySelector('.mobile-preview-heading').innerText`), /050.txt/);
  assert.equal(await evaluate(`document.querySelector('[aria-label="排序"]').value`), "size");
  assert.ok(await evaluate(`!!document.querySelector('[aria-label="列表视图"]')`));
  pass("切换目录分别恢复焦点、排序及列表网格视图");
  await delay(300); ws.close(); adb("shell", "am", "force-stop", pkg); await connect();
  await wait(() => evaluate(`document.querySelector('.mobile-preview-heading')?.innerText.includes('050.txt')`), "强制停止后未恢复焦点");
  assert.equal(await evaluate(`document.querySelector('[aria-label="排序"]').value`), "size");
  pass("强制停止后重新启动恢复目录与文件焦点");
  await click('[aria-label="删除当前焦点文件"]');
  await wait(() => evaluate(`document.querySelector('.mobile-preview-heading').innerText.includes('049.txt')`), "焦点删除后未自动转到相邻文件");
  assert.equal(adb("shell", "test", "!", "-e", `${remote}/A/050.txt`), "");
  pass("顶栏删除遵循回收站设置并自动选择相邻文件");
  await click('[aria-label="设置"]');
  const settingsScroll = await evaluate(`(()=>{const groups=document.querySelectorAll('.mobile-settings details');groups[0].open=false;groups[1].open=true;const scroll=document.querySelector('.mobile-settings-scroll');scroll.scrollTop=80;return scroll.scrollTop;})()`);
  writeFileSync("artifacts/android/settings-groups.png", execFileSync("adb", ["exec-out", "screencap", "-p"]));
  await click('[aria-label="文件任务"]');
  assert.equal(await evaluate(`document.querySelector('.mobile-sheet h2').innerText`), "文件任务");
  await click('[aria-label="返回设置"]');
  assert.equal(await evaluate(`document.querySelector('.mobile-sheet h2').innerText`), "设置");
  assert.equal(await evaluate(`document.querySelectorAll('.mobile-settings details')[1].open`), true);
  assert.equal(await evaluate(`document.querySelector('.mobile-settings-scroll').scrollTop`), settingsScroll);
  await click('[aria-label="文件任务"]');
  await evaluate(`window.dispatchEvent(new Event('mobile-back'));true;`);
  assert.equal(await evaluate(`document.querySelector('.mobile-sheet h2').innerText`), "设置");
  await click('[aria-label="文件任务"]');
  await click('.mobile-sheet [aria-label="关闭"]');
  assert.equal(await evaluate(`document.querySelector('.mobile-sheet h2').innerText`), "设置");
  await click('.mobile-sheet [aria-label="关闭"]');
  assert.equal(await evaluate(`!!document.querySelector('.mobile-topbar [aria-label="文件任务"]')`), false);
  pass("文件任务作为设置二级页，按钮和系统返回保留设置分组及滚动位置");
  await native("closeMedia"); ws.close();
  const instrumentation = adb("shell", "am", "instrument", "-w", "-e", "class", "com.ayanami.filesweeper.mobile.MediaSeekGestureTest,com.ayanami.filesweeper.mobile.FileTaskRetryTest", "-e", "fixtureRoot", remote, `${pkg}.test/androidx.test.runner.AndroidJUnitRunner`);
  console.log(instrumentation);
  // Instrumentation starts its own target process; reconnect after the view tests.
  await connect();
  assert.match(instrumentation, /OK \(2 tests\)/);
  const retryId = instrumentation.match(/retryTaskId=([a-f0-9-]{36})/)?.[1];
  assert.ok(retryId, "未生成真实的部分失败任务");
  pass("视频和音频快进快退、取消拖动及设置指定的长按倍速通过设备内手势测试");
  await favorite("测试 A");
  await wait(() => evaluate(`localStorage.getItem('mobile.lastPath')===${JSON.stringify(`${remote}/A`)}`), "设备内测试后未回到样本目录");
  const mediaListing = await native("listDirectory", { path: `${remote}/A` });
  assert.ok(mediaListing.items.some((item) => item.name === "clip.mp4"), `样本视频被过滤，nomedia=${mediaListing.mediaSuppressed}`);
  await selectFile("clip.mp4");
  await wait(async () => { const state = await native("mediaState"); return state.path === `${remote}/A/clip.mp4` && state.surface?.visible; }, "视频预览未打开");
  await finish((await native("startTask", { operation: "rename", paths: [`${remote}/A/clip.mp4`], name: "renamed.mp4" })).id);
  await wait(() => evaluate(`document.querySelector('.mobile-preview-heading')?.innerText.includes('renamed.mp4')`), "脚本重命名后预览焦点未更新");
  await wait(async () => (await native("mediaState")).path === `${remote}/A/renamed.mp4`, "重命名后播放器未切换");
  await finish((await native("startTask", { operation: "trash", paths: [`${remote}/A/renamed.mp4`] })).id);
  await wait(() => evaluate(`!document.querySelector('.mobile-preview-heading')?.innerText.includes('renamed.mp4')`), "脚本删除后旧预览未清除");
  await native("setPlayerBounds", { path: `${remote}/A/renamed.mp4`, visible: true, x: 0, y: 0, width: 100, height: 100 });
  assert.equal((await native("mediaState")).surface?.visible, false, "旧尺寸回调重新显示了已清除的视频");
  pass("脚本原生任务重命名和删除同步更新焦点，旧布局回调不会恢复残留画面");
  await click('[aria-label="设置"]'); await click('[aria-label="文件任务"]');
  const retryCard = `[data-task-id="${retryId}"]`;
  await wait(() => evaluate(`!!document.querySelector(${JSON.stringify(retryCard)})`), "失败任务未显示");
  await click(`${retryCard} summary`);
  const detail = await evaluate(`document.querySelector(${JSON.stringify(retryCard)}).innerText`);
  assert.match(detail, /已完成的文件\.txt/); assert.match(detail, /需要重新执行的文件\.txt/);
  assert.match(detail, /重新执行/); assert.match(detail, /已完成 1 \/ 2 项/);
  await evaluate(`document.querySelector(${JSON.stringify(retryCard)}).scrollIntoView({block:'start'});true;`);
  writeFileSync("artifacts/android/task-retry.png", execFileSync("adb", ["exec-out", "screencap", "-p"]));
  const firstCopy = `${remote}/Retry/Target/已完成的文件.txt`;
  const inode = adb("shell", "stat", "-c", "%i", firstCopy);
  await finish((await native("startTask", { operation: "delete", paths: [`${remote}/Retry/Target/需要重新执行的文件.txt`], confirmed: true })).id);
  await click(`${retryCard} .mobile-task-retry`);
  await finish(retryId);
  await wait(() => evaluate(`document.querySelector(${JSON.stringify(`${retryCard} .mobile-task-state`)})?.innerText==='已完成'`), "重新执行后界面未更新");
  assert.equal(adb("shell", "stat", "-c", "%i", firstCopy), inode);
  const retried = (await native("tasks")).tasks.find((task) => task.id === retryId);
  assert.equal(retried.completedItems, 2); assert.equal(retried.resumeCount, 1); assert.equal(retried.error, undefined);
  assert.equal(adb("shell", "cat", `${remote}/Retry/Target/需要重新执行的文件.txt`), "retry this item");
  await click('[aria-label="返回设置"]'); await click('.mobile-sheet [aria-label="关闭"]');
  pass("任务显示真实中文文件名和失败原因，重新执行成功且不重复复制已完成文件");
  writeFileSync("artifacts/android/navigation-results.json", JSON.stringify({ results }, null, 2), "utf8");
} finally {
  try {
    await native("closeMedia");
    const recycled = (await native("trash")).items.filter((item) => item.originalPath.startsWith(`${remote}/`));
    if (recycled.length) await finish((await native("startTask", { operation: "purge", trashIds: recycled.map((item) => item.id), confirmed: true })).id);
    await finish((await native("startTask", { operation: "delete", paths: [remote], confirmed: true })).id);
    // Disable the live page's unload writer before restoring the user's snapshot.
    await native("savePreferences", { rememberWorkspaceFocus: false });
    await evaluate(`window.dispatchEvent(new Event('mobile-resume'));true;`);
    await wait(() => evaluate(`localStorage.getItem('mobile.workspaces')===null`), "未暂停测试页的记忆写入");
    if (oldState["mobile.workspaces"]) {
      const memories = JSON.parse(oldState["mobile.workspaces"]);
      for (const path of Object.keys(memories)) if (/\/FileSweeper-Navigation-Test-\d+(?:\/|$)/.test(path)) delete memories[path];
      oldState["mobile.workspaces"] = JSON.stringify(memories);
    }
    await native("savePreferences", original);
    await evaluate(`for(const k of Object.keys(localStorage))if(k.startsWith('mobile.'))localStorage.removeItem(k);for(const[k,v]of Object.entries(${JSON.stringify(oldState)}))localStorage.setItem(k,v);setTimeout(()=>location.reload(),0);true;`);
  } finally { ws.close(); rmSync(local, { recursive: true, force: true }); }
}
