import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import assert from "node:assert/strict";

// Exercise actual selection/confirmation and native batch tasks using only owned fixtures.
const pkg = "com.ayanami.filesweeper";
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const adb = (...args) => execFileSync("adb", args[0] === "shell" ? ["shell", args.slice(1).map(quote).join(" ")] : args, { encoding: "utf8" }).trim();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
adb("shell", "am", "start", "-n", `${pkg}/.MainActivity`);
await delay(500);
adb("forward", "tcp:9222", `localabstract:webview_devtools_remote_${adb("shell", "pidof", pkg).split(" ")[0]}`);
let pages;
for (let i = 0; i < 40; i++) {
  try { pages = await (await fetch("http://127.0.0.1:9222/json")).json(); if (pages.some((page) => page.type === "page")) break; } catch {}
  await delay(200);
}
const ws = new WebSocket(pages.find((page) => page.type === "page").webSocketDebuggerUrl);
await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
let serial = 0;
const pending = new Map();
ws.addEventListener("message", (event) => { const message = JSON.parse(event.data); if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); } });
async function evaluate(expression) {
  const id = ++serial;
  const response = new Promise((resolve) => pending.set(id, resolve));
  ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
  const result = await response;
  if (result.error || result.result.exceptionDetails) throw new Error(JSON.stringify(result));
  return result.result.result?.value;
}
const native = (command, payload = {}) => evaluate(`window.__TAURI_INTERNALS__.invoke('mobile_call',${JSON.stringify({ command, payload })})`);
async function wait(check, message, count = 100) { for (let i = 0; i < count; i++) { if (await check()) return; await delay(100); } throw new Error(message); }
const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
const button = (name, scope = ".mobile-trash") => evaluate(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find(b=>b.innerText.trim()===${JSON.stringify(name)});if(!b)throw Error('Button missing');if(b.disabled)throw Error('Button disabled');b.click();return true;})()`);
const search = (text) => evaluate(`(()=>{const input=document.querySelector('[aria-label="搜索回收站"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(text)});input.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
const results = [];
const pass = (name) => { results.push(name); console.log(`PASS ${name}`); };
const stamp = Date.now();
const remote = `/storage/emulated/0/Download/FileSweeper-Trash-Test-${stamp}`;
const same = `same-${stamp}.txt`, keep = `keep-${stamp}.txt`, folder = `folder-${stamp}`;
await wait(() => evaluate(`!!window.__TAURI_INTERNALS__?.invoke && !!document.querySelector('[aria-label="打开位置"]')`), "应用未就绪");
const original = (await native("storageState")).preferences;
const baseline = new Set((await native("trash")).items.map((item) => item.id));
const localKeys = await evaluate(`Object.fromEntries(['mobile.lastPath','mobile.selected','mobile.grid'].map(k=>[k,localStorage.getItem(k)]))`);
let fixtureIds = [];
async function finished(id) {
  let record;
  await wait(async () => { record = (await native("tasks")).tasks.find((task) => task.id === id); return record && !["queued", "running"].includes(record.state); }, "任务未结束");
  assert.equal(record.state, "completed", JSON.stringify(record)); return record;
}
async function openTrash() {
  await click('[aria-label="打开位置"]');
  await button("回收站", ".mobile-sheet");
  await wait(() => evaluate(`!!document.querySelector('.mobile-trash') && !document.querySelector('[aria-label="刷新回收站"]').disabled`), "回收站未加载");
}
async function latestTask(operation, ids) {
  let task;
  await wait(async () => { task = (await native("tasks")).tasks.find((task) => task.operation === operation && task.items.length === ids.length && task.items.every((item) => ids.includes(item.trashId))); return !!task; }, "界面未创建批量任务");
  return finished(task.id);
}
try {
  adb("shell", "mkdir", "-p", `${remote}/a`, `${remote}/b`, `${remote}/out`, `${remote}/${folder}`);
  adb("shell", "sh", "-c", `printf one > '${remote}/a/${same}'; printf two > '${remote}/b/${same}'; printf keep > '${remote}/${keep}'; printf nested > '${remote}/${folder}/nested.txt'`);
  await native("savePreferences", { trashEnabled: true, rememberWorkspaceFocus: true });
  await evaluate(`localStorage.setItem('mobile.lastPath',${JSON.stringify(remote)});localStorage.removeItem('mobile.selected');localStorage.setItem('mobile.grid','false');setTimeout(()=>location.reload(),50);true;`);
  await delay(400);
  await wait(() => evaluate(`!!document.querySelector('button[aria-label="out"]')`), "样本目录未加载");
  const recycled = await native("startTask", { operation: "trash", paths: [`${remote}/a/${same}`, `${remote}/b/${same}`, `${remote}/${keep}`, `${remote}/${folder}`] });
  fixtureIds = recycled.items.map((item) => item.trashId);
  await finished(recycled.id);
  const recycledEntries = (await native("trash")).items.filter((item) => fixtureIds.includes(item.id));
  assert.equal(recycledEntries.length, 4); assert.equal(recycledEntries.find((item) => item.name === folder).directory, true);
  pass("批量回收按项执行且保留文件夹类型");
  await assert.rejects(() => native("startTask", { operation: "purge", trashIds: [fixtureIds[0]], confirmed: false }));
  await assert.rejects(() => native("startTask", { operation: "restore", trashIds: [fixtureIds[0], fixtureIds[0]] }));
  pass("原生层拒绝未确认删除和重复回收 ID");
  await openTrash(); await search(remote); await delay(100);
  await click('[aria-label="多选回收项目"]');
  await click(`.mobile-trash button[aria-label="${keep}"]`);
  await click(`.mobile-trash button[aria-label="${folder}"]`);
  await click('[aria-label="回收站网格视图"]'); await delay(150);
  writeFileSync("artifacts/android/trash-grid-device.png", execFileSync("adb", ["exec-out", "screencap", "-p"]));
  await click('[aria-label="回收站列表视图"]'); await delay(100);
  writeFileSync("artifacts/android/trash-list-device.png", execFileSync("adb", ["exec-out", "screencap", "-p"]));
  const bounds = await evaluate(`(()=>{const panel=document.querySelector('.mobile-trash-sheet').getBoundingClientRect(),actions=document.querySelector('.mobile-trash-actions').getBoundingClientRect();return{right:panel.right,bottom:panel.bottom,actionsRight:actions.right,actionsBottom:actions.bottom,width:innerWidth,height:innerHeight};})()`);
  assert.ok(bounds.actionsRight <= bounds.width + 1 && bounds.actionsBottom <= bounds.height + 1, JSON.stringify(bounds));
  pass("回收站列表网格共用勾选状态且底部操作栏不溢出");
  await button("彻底删除");
  assert.match(await evaluate(`document.querySelector('.mobile-trash-confirm').innerText`), /确认彻底删除 2 项/);
  await button("取消，返回回收站");
  assert.equal(await evaluate(`document.querySelectorAll('.mobile-trash button.mobile-file[aria-pressed="true"]').length`), 2);
  pass("取消彻底删除后保留多选且未变更文件");
  await button("彻底删除"); await button("彻底删除 2 项");
  await latestTask("purge", [fixtureIds[2], fixtureIds[3]]);
  await wait(async () => (await native("trash")).items.filter((item) => fixtureIds.includes(item.id)).length === 2, "批量彻底删除未完成");
  pass("界面一次提交两项彻底删除，其他回收项保留");
  await wait(() => evaluate(`document.querySelectorAll('.mobile-trash button.mobile-file').length===2`), "删除后列表未刷新");
  await button("全选搜索结果"); await button("恢复到…");
  await wait(() => evaluate(`!![...document.querySelectorAll('.mobile-picker-list button')].find(b=>b.innerText.trim()==='out')`), "恢复目录选择器未加载");
  await button("out", ".mobile-picker-list"); await delay(150); await button("选择此目录", ".mobile-sheet");
  const restored = await latestTask("restore", [fixtureIds[0], fixtureIds[1]]);
  assert.notEqual(restored.items[0].destination, restored.items[1].destination);
  assert.deepEqual(restored.items.map((item) => adb("shell", "cat", item.destination)).sort(), ["one", "two"]);
  pass("批量恢复到指定目录，同名文件自动避让且内容一致");
  const again = await native("startTask", { operation: "trash", paths: restored.items.map((item) => item.destination) });
  fixtureIds.push(...again.items.map((item) => item.trashId)); await finished(again.id);
  await wait(() => evaluate(`!!document.querySelector('.mobile-trash')`), "恢复后未返回回收站");
  await click('[aria-label="刷新回收站"]');
  await wait(() => evaluate(`!document.querySelector('[aria-label="刷新回收站"]').disabled`), "回收站未刷新");
  await search("no-match-for-clear-test"); await delay(100);
  await wait(() => evaluate(`!![...document.querySelectorAll('.mobile-trash button')].find(b=>b.innerText.trim()==='全部删除'&&!b.disabled)`), "等待回收任务结束后启用清空按钮");
  await button("全部删除");
  const confirmText = await evaluate(`document.querySelector('.mobile-trash-confirm').innerText`);
  assert.ok(confirmText.includes(`确认清空回收站 ${baseline.size + 2} 项`), confirmText);
  assert.match(confirmText, /包括未在当前搜索结果中显示的项目/);
  writeFileSync("artifacts/android/trash-clear-confirm-device.png", execFileSync("adb", ["exec-out", "screencap", "-p"]));
  pass("全部删除确认明确覆盖整个回收站，与搜索结果无关");
  if (!baseline.size) {
    await button("全部删除 2 项"); await latestTask("purge", again.items.map((item) => item.trashId));
    assert.equal((await native("trash")).items.length, 0);
    pass("全部删除按钮完成清空并自动刷新为空状态");
  } else {
    await button("取消，返回回收站");
    console.log("SKIP 执行清空：检测到既有回收项，仅验证确认与取消。");
  }
  writeFileSync("artifacts/android/trash-results.json", JSON.stringify({ results, baselineCount: baseline.size, testDirectory: remote }, null, 2), "utf8");
} finally {
  // Never execute clear-all if the device had unrelated recycled entries.
  try {
    const remaining = (await native("trash")).items.filter((item) => fixtureIds.includes(item.id));
    if (remaining.length) await finished((await native("startTask", { operation: "purge", trashIds: remaining.map((item) => item.id), confirmed: true })).id);
    const after = new Set((await native("trash")).items.map((item) => item.id));
    for (const id of baseline) assert.ok(after.has(id), "已有回收项目必须保持不变");
    await finished((await native("startTask", { operation: "delete", paths: [remote], confirmed: true })).id);
    await native("savePreferences", original);
    await evaluate(`for(const[k,v]of Object.entries(${JSON.stringify(localKeys)})){if(v===null)localStorage.removeItem(k);else localStorage.setItem(k,v);}setTimeout(()=>location.reload(),50);true;`);
  } finally { ws.close(); }
}
